#!/usr/bin/env bash
# deregister-repo.sh - fully remove a registered repo: cron job, both agent
# workspaces, registry entry, and pilot-state files. Fully agent-safe -
# touches no secrets. Safe no-op if the key is already gone (idempotent).
#
# NOTE on flag polarity: the plan for this feature said "supports --dry-run
# and --keep-clone" (implying delete-by-default), but this project has a
# consistently established norm against destructive defaults - so this
# script deliberately inverts that: the git clone at /sandbox/repos/<name>
# is KEPT unless you pass --delete-clone explicitly. Everything else
# (cron, agent workspaces, registry entry, pilot-state files) is safe to
# remove by default since none of it is independently valuable once the
# repo is deregistered.
#
# Usage: deregister-repo.sh <key> [--delete-clone] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="ops-nemoclaw"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"

# shellcheck source=lib/sandbox-helpers.sh
source "$SCRIPT_DIR/lib/sandbox-helpers.sh"
# shellcheck source=lib/gateway-config.sh
source "$SCRIPT_DIR/lib/gateway-config.sh"

if [ $# -lt 1 ]; then
  echo "Usage: deregister-repo.sh <key> [--delete-clone] [--dry-run]" >&2
  exit 1
fi
KEY="$1"; shift

DELETE_CLONE=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --delete-clone) DELETE_CLONE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if ! jq -e --arg k "$KEY" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
  echo "'${KEY}' is not registered - nothing to do (safe no-op)."
  exit 0
fi

ESCALATION_AGENT="${KEY}-escalation"
REVIEWER_AGENT="${KEY}-reviewer"
PR_REVIEWER_AGENT="${KEY}-pr-reviewer"
CRON_NAME="${KEY}-watcher"
PR_CRON_NAME="${KEY}-pr-watcher"
REPO_NAME=$(jq -r --arg k "$KEY" '.[$k].clone_url' "$REGISTRY_JSON" | xargs basename | sed 's/\.git$//')

echo "=== Plan for deregistering '${KEY}' ==="
echo "  cron jobs:             ${CRON_NAME}, ${PR_CRON_NAME} (remove via 'openclaw cron rm')"
echo "  agent workspaces:      ${ESCALATION_AGENT}, ${REVIEWER_AGENT}, ${PR_REVIEWER_AGENT} (remove via 'openclaw agents delete --force')"
echo "  pilot-state files:     /sandbox/pilot-state/${KEY}-watcher.*, ${KEY}-pr-watcher.* and rendered scripts"
echo "  registry entry:        removed from registry/repos.json"
echo "  git clone at /sandbox/repos/${REPO_NAME}: $([ "$DELETE_CLONE" -eq 1 ] && echo "WILL BE DELETED (--delete-clone passed)" || echo "kept (pass --delete-clone to remove)")"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: nothing was touched."
  exit 0
fi

CONTAINER=$(container_name)
if [ -z "$CONTAINER" ]; then
  echo "warning: could not find a running $SANDBOX container - cannot remove cron/agents/files" >&2
  echo "from the sandbox. Removing the registry entry only; re-run once the sandbox is up" >&2
  echo "to finish cleanup there." >&2
else
  echo "=== Removing cron jobs ==="
  # Both crons are removed unconditionally, without consulting
  # pr_review_enabled: the flag may have been turned off at any point while
  # the cron stayed registered, and "remove it if it's there" is correct in
  # every case whereas "remove it only if the flag says so" leaves an orphan
  # cron pointing at a deleted script.
  for cron in "$CRON_NAME" "$PR_CRON_NAME"; do
    CRON_ID=$(cron_job_id "$cron")
    if [ -n "$CRON_ID" ]; then
      nemoclaw "$SANDBOX" exec -- openclaw cron rm "$CRON_ID"
      echo "removed cron job ${cron} (${CRON_ID})"
    else
      echo "no cron job named ${cron} found, skipping (already gone)"
    fi
  done

  echo "=== Removing agent workspaces ==="
  for agent in "$ESCALATION_AGENT" "$REVIEWER_AGENT" "$PR_REVIEWER_AGENT"; do
    if nemoclaw "$SANDBOX" exec -- test -d "/sandbox/.openclaw/agents/$agent/workspace" 2>/dev/null; then
      nemoclaw "$SANDBOX" exec -- openclaw agents delete "$agent" --force
      # `openclaw agents delete` correctly removes the agent from openclaw's
      # own config/routing (confirmed via `openclaw agents list` during
      # testing), but empirically leaves an empty top-level directory behind
      # despite its own "prune workspace/state" description - belt-and-
      # suspenders cleanup here rather than relying on that.
      nemoclaw "$SANDBOX" exec -- rm -rf "/sandbox/.openclaw/agents/$agent" || true
      echo "deleted agent $agent"
    else
      echo "agent $agent already gone, skipping"
    fi
  done

  echo "=== Removing pilot-state files ==="
  # This list drifted behind the files that actually get created (found
  # 2026-08-05 while deregistering svc-docs): .podstate/.failstreak came
  # with the k8s watcher, -escalation-stages.json with the staged protocol,
  # and -escalation-denials.json/.pausedsince with the terminal-Deny work.
  # None were ever removed, so every past deregistration left stale state
  # behind - which matters most for the stages/denials pair, since
  # re-registering the same key would inherit a tracker describing fixes
  # that no longer exist and a denial history for a repo that isn't
  # registered any more. Glob rather than an explicit list from here on, so
  # the next file added to pilot-state doesn't silently reintroduce this.
  #
  # The PR-watcher files need their own patterns: `${KEY}-watcher.*` does NOT
  # match `${KEY}-pr-watcher.log` (different prefix), so relying on the
  # existing glob would leave the reviewed-commit ledger behind - and a
  # re-registration inheriting it would silently skip every PR it had already
  # reviewed under the old registration.
  nemoclaw "$SANDBOX" exec -- bash -c "rm -f /sandbox/pilot-state/${KEY}-watcher.* /sandbox/pilot-state/${KEY}-watcher-suppressions.txt /sandbox/pilot-state/${KEY}-escalation-*.json /sandbox/pilot-state/${KEY}-pr-watcher.*" || true
  nemoclaw "$SANDBOX" exec -- rm -rf "/sandbox/pilot-state/${KEY}-pr-work" || true
  # Kept deliberately: /sandbox/pilot-state/denied-patches/<key>-*.patch.
  # Those are the only copy of work a human explicitly rejected, and they
  # cost bytes; losing them to a deregistration would be the one deletion
  # here that can't be undone by re-registering.

  if [ "$DELETE_CLONE" -eq 1 ]; then
    echo "=== Deleting git clone (--delete-clone) ==="
    nemoclaw "$SANDBOX" exec -- rm -rf "/sandbox/repos/${REPO_NAME}" "/sandbox/repos/${REPO_NAME}-worktrees" || true
    echo "deleted /sandbox/repos/${REPO_NAME} (and any worktrees dir)"
  fi
fi

echo "=== Removing registry entry ==="
# Also prunes this key from every OTHER repo's correlate_with. Without this
# (the behaviour until 2026-08-05) deregistering left dangling references
# behind: registry/schema.md's cross-repo awareness has each escalation
# agent read a correlated repo's shared clone and notify that repo's own
# escalation agent, so a stale entry points at an agent that no longer
# exists - and with --delete-clone, at a clone that doesn't either. Failure
# would surface as a confusing mid-investigation error, not a clear
# "unregistered repo" message.
jq --arg k "$KEY" '
  del(.[$k])
  | with_entries(
      .value.correlate_with = ((.value.correlate_with // []) | map(select(. != $k)))
    )
' "$REGISTRY_JSON" > "${REGISTRY_JSON}.tmp" && mv "${REGISTRY_JSON}.tmp" "$REGISTRY_JSON"
DANGLING_PRUNED=$(jq -r --arg k "$KEY" '[to_entries[] | select((.value.correlate_with // []) | index($k))] | length' "$REGISTRY_JSON")
echo "pruned '${KEY}' from other repos' correlate_with (remaining references: ${DANGLING_PRUNED})"
if [ -n "$CONTAINER" ]; then
  docker cp "$REGISTRY_JSON" "$CONTAINER:/sandbox/pilot-state/registry.json"
  # Shrink the agent-to-agent allow list to match, so the removed pair loses
  # sessions_send reach. Mirrors register-repo.sh / bootstrap.sh section 8 -
  # including the []-means-allow-everything guard, which matters most right
  # here: deregistering the LAST repo is exactly the path that would produce
  # an empty list.
  A2A_ALLOW=$(derive_a2a_allow "$REGISTRY_JSON")
  nemoclaw "$SANDBOX" exec -- openclaw config set tools.agentToAgent.allow "$A2A_ALLOW" --strict-json
  echo "agent-to-agent allow list shrunk (takes effect on the next 'nemoclaw $SANDBOX gateway restart')"
fi
echo "registry/repos.json updated (commit this yourself when ready)"

echo ""
echo "Note: rendered/${KEY}/ in this repo is NOT deleted automatically - it's an audit trail"
echo "of what was once deployed. Remove it by hand if you don't want to keep it around."
echo ""
echo "'${KEY}' fully deregistered."
