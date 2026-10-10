#!/usr/bin/env bash
# resync-repo.sh - push a template improvement to an already-registered
# repo's escalation/reviewer agent docs, its watcher.sh, AND its pre-push
# hook, without needing to toggle modifications_enabled (unlike
# toggle-repo.sh, which only re-renders agent docs as a side effect of an
# actual flag change). Use this whenever
# templates/agent-{readonly,writecapable}/*,
# templates/reviewer-{readonly,writecapable}/*, templates/watcher-*.sh.tmpl,
# templates/pre-push-hook.sh.tmpl, or scripts/lib/watcher-common.sh changes
# and existing registered repos need the update too - e.g. a new safety
# rule added to the Prohibited/Hard-rule section, a watcher bugfix, or a
# new pre-push mechanical gate.
#
# Watcher redeploy added 2026-07-21 - previously this only touched agent
# docs, so a watcher template/lib fix never reached an already-registered
# repo without a full deregister/re-register cycle. Works the same for
# both runtime types (Phase 4, done) - agent-doc resync only skips (with a
# warning, not an error) if it can't find a running sandbox container.
#
# Pre-push hook redeploy added 2026-07-23, same reasoning, same gap: a
# pre-push-hook.sh.tmpl fix (e.g. the freshness/trunk-ancestor gate added
# that day) previously never reached an already-registered repo's actual
# .git/hooks/pre-push either. Skips (with a warning) if that repo's clone
# doesn't exist in the sandbox yet - same non-fatal-to-the-rest-of-the-loop
# discipline as the watcher redeploy.
#
# registry.json redeploy also added 2026-07-23, closing a different gap:
# this script re-renders agent docs/watcher/pre-push-hook FROM the
# registry, but never pushed an edited registry/repos.json itself (a plain
# field edit like trunk_branch, as opposed to toggling
# modifications_enabled) to /sandbox/pilot-state/registry.json - only
# register-repo.sh/toggle-repo.sh/deregister-repo.sh did that. Found while
# fixing svc-core's trunk_branch/secondary_branch, which had been
# swapped (dev/main reversed) across all 7 repos since registration.
#
# Fully agent-safe - touches no secrets, same as toggle-repo.sh.
#
# Usage: resync-repo.sh <key> [--all] [--dry-run]
#   <key>    resync just this one repo
#   --all    resync every repo currently in the registry
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="ops-nemoclaw"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"

# shellcheck source=lib/sandbox-helpers.sh
source "$SCRIPT_DIR/lib/sandbox-helpers.sh"
# shellcheck source=lib/gateway-config.sh
source "$SCRIPT_DIR/lib/gateway-config.sh"  # PR_WATCHER_CRON_EVERY, PR_REVIEW_MAX_FINDINGS

if [ $# -lt 1 ]; then
  echo "Usage: resync-repo.sh <key> [--dry-run]" >&2
  echo "       resync-repo.sh --all [--dry-run]" >&2
  exit 1
fi

TARGET="$1"; shift
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$TARGET" = "--all" ]; then
  KEYS=$(jq -r 'keys[]' "$REGISTRY_JSON")
else
  if ! jq -e --arg k "$TARGET" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
    echo "error: '${TARGET}' is not registered (check registry/repos.json)" >&2
    exit 1
  fi
  KEYS="$TARGET"
fi

if [ -z "$KEYS" ]; then
  echo "Nothing to resync - registry is empty." >&2
  exit 0
fi

echo "=== Plan: redeploy registry.json, then resync agent docs + watcher + pre-push hook from" \
     "current templates for: $(echo "$KEYS" | tr '\n' ' ') ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: nothing was touched."
  exit 0
fi

CONTAINER=$(container_name)
if [ -z "$CONTAINER" ]; then
  echo "warning: could not find a running $SANDBOX container - cannot redeploy registry.json" >&2
else
  docker cp "$REGISTRY_JSON" "$CONTAINER:/sandbox/pilot-state/registry.json"
  echo "registry.json redeployed to the sandbox"
fi

for KEY in $KEYS; do
  # Each of these returns nonzero (with a printed warning, not a
  # script-ending error) if it can't find what it needs - a running sandbox
  # container, or (pre-push hook only) an existing git clone for that repo.
  # None of that should abort the whole --all resync under set -e; the
  # remaining steps for that same key, and every other key, still need to
  # run.
  render_and_redeploy_agent_docs "$KEY" || true
  render_and_redeploy_watcher "$KEY" || true
  render_and_redeploy_pre_push_hook "$KEY" || true

  # PR-review pieces only exist for repos that have the flag on. Reading the
  # raw value and defaulting bash-side, never `// false` - see the watcher
  # template's own comment on jq's `//` swallowing an explicit false.
  PR_REVIEW=$(jq -r --arg k "$KEY" '.[$k].pr_review_enabled' "$REGISTRY_JSON" 2>/dev/null || echo null)
  [ "$PR_REVIEW" = "null" ] && PR_REVIEW="false"
  if [ "$PR_REVIEW" = "true" ]; then
    render_and_redeploy_pr_reviewer "$KEY" || true
    render_and_redeploy_pr_watcher "$KEY" || true
  fi
done

echo ""
echo "NOTE: registry.json changes take effect immediately (read fresh by the watcher and"
echo "pre-push hook on every run). Agent-doc changes only take effect on each agent's NEXT"
echo "invocation, not a conversation already in flight - same as any other AGENTS.md update"
echo "in this project. Watcher changes take effect on that repo's NEXT cron cycle. Pre-push"
echo "hook changes take effect on that repo's NEXT push. Commit rendered/*/* yourself when ready."
