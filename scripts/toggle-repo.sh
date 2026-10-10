#!/usr/bin/env bash
# toggle-repo.sh - flip monitoring_enabled/modifications_enabled/
# pr_review_enabled for an already-registered repo. Fully agent-safe -
# touches no secrets, unlike register-repo.sh's manual clone step.
#
# --pr-review is deliberately independent of the other two (2026-08-12): the
# PR reviewer only ever posts a comment, so it is safe on a repo whose
# modifications are off, and useful on a repo whose incident monitoring is
# off. See registry/schema.md's "PR review" section.
#
# Usage: toggle-repo.sh <key> [--monitoring on|off] [--modifications on|off]
#                             [--pr-review on|off] [--dry-run]
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
  echo "Usage: toggle-repo.sh <key> [--monitoring on|off] [--modifications on|off] [--pr-review on|off] [--dry-run]" >&2
  exit 1
fi
KEY="$1"; shift

MONITORING=""
MODIFICATIONS=""
PR_REVIEW=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --monitoring) MONITORING="$2"; shift 2 ;;
    --modifications) MODIFICATIONS="$2"; shift 2 ;;
    --pr-review) PR_REVIEW="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$MONITORING" ] && [ -z "$MODIFICATIONS" ] && [ -z "$PR_REVIEW" ]; then
  echo "Nothing to do - pass --monitoring on|off, --modifications on|off and/or --pr-review on|off" >&2
  exit 1
fi

if ! jq -e --arg k "$KEY" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
  echo "error: '${KEY}' is not registered (check registry/repos.json)" >&2
  exit 1
fi

CURRENT_MODIFICATIONS=$(jq -r --arg k "$KEY" '.[$k].modifications_enabled' "$REGISTRY_JSON")
MODIFICATIONS_CHANGING=0
if [ -n "$MODIFICATIONS" ]; then
  NEW_MODIFICATIONS_BOOL=$([ "$MODIFICATIONS" = "on" ] && echo true || echo false)
  [ "$NEW_MODIFICATIONS_BOOL" != "$CURRENT_MODIFICATIONS" ] && MODIFICATIONS_CHANGING=1
fi

echo "=== Plan for '${KEY}' ==="
[ -n "$MONITORING" ] && echo "  monitoring_enabled -> $([ "$MONITORING" = "on" ] && echo true || echo false)"
[ -n "$MODIFICATIONS" ] && echo "  modifications_enabled -> $([ "$MODIFICATIONS" = "on" ] && echo true || echo false)"
[ -n "$PR_REVIEW" ] && echo "  pr_review_enabled -> $([ "$PR_REVIEW" = "on" ] && echo true || echo false)"
if [ "$MODIFICATIONS_CHANGING" -eq 1 ]; then
  echo "  (modifications is actually changing - escalation/reviewer agent docs will be re-rendered and redeployed)"
fi
if [ "$PR_REVIEW" = "on" ]; then
  echo "  (pr-review on - the ${KEY}-pr-reviewer agent, its docs, the pr-watcher script and its"
  echo "   cron will be created if missing. Idempotent: already-present pieces are left alone.)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: nothing was touched."
  exit 0
fi

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
JQ_FILTER='.[$k].updated_at = $now'
JQ_ARGS=(--arg k "$KEY" --arg now "$NOW_ISO")
if [ -n "$MONITORING" ]; then
  JQ_FILTER="$JQ_FILTER"' | .[$k].monitoring_enabled = $mon'
  JQ_ARGS+=(--argjson mon "$([ "$MONITORING" = "on" ] && echo true || echo false)")
fi
if [ -n "$MODIFICATIONS" ]; then
  JQ_FILTER="$JQ_FILTER"' | .[$k].modifications_enabled = $mod'
  JQ_ARGS+=(--argjson mod "$([ "$MODIFICATIONS" = "on" ] && echo true || echo false)")
fi
if [ -n "$PR_REVIEW" ]; then
  JQ_FILTER="$JQ_FILTER"' | .[$k].pr_review_enabled = $prr'
  JQ_ARGS+=(--argjson prr "$([ "$PR_REVIEW" = "on" ] && echo true || echo false)")
fi

jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$REGISTRY_JSON" > "${REGISTRY_JSON}.tmp" && mv "${REGISTRY_JSON}.tmp" "$REGISTRY_JSON"
echo "registry/repos.json updated (commit this yourself when ready)"

CONTAINER=$(container_name)
if [ -z "$CONTAINER" ]; then
  echo "warning: could not find a running $SANDBOX container - registry.json was updated" >&2
  echo "locally but not deployed. Re-run once the sandbox is up." >&2
  exit 0
fi

nemoclaw "$SANDBOX" exec -- mkdir -p /sandbox/pilot-state
docker cp "$REGISTRY_JSON" "$CONTAINER:/sandbox/pilot-state/registry.json"
echo "registry.json deployed to the sandbox"
echo ""
echo "monitoring_enabled takes effect on the watcher's very next cron cycle - no redeploy needed."
echo "modifications_enabled's mechanical push-blocking gate (the pre-push hook) takes effect on"
echo "the very next 'git push' immediately - it reads the registry live, no redeploy needed."
echo "pr_review_enabled is read live by the pr-watcher too, so turning it OFF takes effect on its"
echo "next cron cycle with no redeploy. Turning it ON needs the agent/script/cron to exist, which"
echo "is what the provisioning step below does."

if [ "$PR_REVIEW" = "on" ]; then
  echo ""
  echo "=== Provisioning PR review for '${KEY}' ==="
  # Same non-fatal discipline as render_and_redeploy_agent_docs below: the
  # registry write already succeeded and should stand even if the sandbox
  # is unreachable right now. A later resync-repo.sh picks it up.
  ensure_pr_review_deployed "$KEY" || true
fi

if [ "$MODIFICATIONS_CHANGING" -eq 1 ]; then
  echo ""
  echo "=== Re-rendering escalation/reviewer agent docs (protocol itself changed) ==="
  # render_and_redeploy_agent_docs returns nonzero (with a printed warning,
  # not a script-ending error) if it can't find a running sandbox container
  # - this must not let that abort the rest of toggle-repo.sh under set -e,
  # since the registry write above already succeeded and should stand.
  render_and_redeploy_agent_docs "$KEY" || true
  echo ""
  echo "NOTE: this only takes effect on ${KEY}-escalation's NEXT invocation, not a conversation"
  echo "already in flight - same as any other AGENTS.md update in this project."
fi
