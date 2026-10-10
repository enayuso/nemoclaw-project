#!/usr/bin/env bash
# generate-server5-wrapper.sh - regenerate scripts/dev-nemoclaw-server-readonly-wrapper.sh
# from registry/repos.json's current set of server5-hosted container_dev
# values. Run this whenever a repo with a new container is registered or
# deregistered (register-repo.sh/deregister-repo.sh already call this
# automatically), then redeploy the result to Server 5 yourself - the actual
# scp + authorized_keys-adjacent step stays human-run by design, same as
# every other credential/access-boundary change in this project.
#
# Usage: generate-server5-wrapper.sh [--quiet]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"
TEMPLATE="$REPO_ROOT/templates/server5-readonly-wrapper.sh.tmpl"
OUTPUT="$SCRIPT_DIR/dev-nemoclaw-server-readonly-wrapper.sh"

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

CONTAINERS=$(jq -r '[.[] | select(.runtime.type == "docker" and .runtime.ssh_host == "server5") | .runtime.container_dev] | unique | join("|")' "$REGISTRY_JSON")

# Zero server5-hosted entries is the expected end state of a completed
# Server 5 -> Server 2 k3s migration (see docs/k8s-migration-architecture.md
# Phase 7), not a config bug - Phase 5 changed this from a hard error to a
# graceful no-op that also cleans up the now-dead generated file, so
# register-repo.sh/deregister-repo.sh no longer need an `|| echo` fallback
# to tolerate a nonzero exit here.
if [ -z "$CONTAINERS" ]; then
  if [ -f "$OUTPUT" ]; then
    rm -f "$OUTPUT"
    if [ "$QUIET" -ne 1 ]; then
      echo "no server5-hosted repos left in the registry - removed the now-dead $OUTPUT"
      echo "(it was only ever allowing containers for repos that no longer exist)."
      echo ""
      echo "Server-side cleanup is still a manual step (same 'you run it, not the agent'"
      echo "rule as any other authorized_keys-adjacent change) - once you're sure no"
      echo "docker-runtime repo will be re-registered, remove the deployed copy yourself:"
      echo "  ssh -p 19030 ops-s005@203.0.113.10 rm -f dev-nemoclaw-server-readonly-wrapper.sh"
    fi
  else
    [ "$QUIET" -eq 1 ] || echo "no server5-hosted repos in the registry - nothing to generate (already clean)"
  fi
  exit 0
fi

BEFORE=""
[ -f "$OUTPUT" ] && BEFORE=$(cat "$OUTPUT")

python3 "$SCRIPT_DIR/render-template.py" "$TEMPLATE" "$OUTPUT" CONTAINERS="$CONTAINERS"
chmod +x "$OUTPUT"

AFTER=$(cat "$OUTPUT")

if [ "$BEFORE" = "$AFTER" ]; then
  [ "$QUIET" -eq 1 ] || echo "dev-nemoclaw-server-readonly-wrapper.sh unchanged (containers: $CONTAINERS)"
  exit 0
fi

echo "dev-nemoclaw-server-readonly-wrapper.sh regenerated - containers: $CONTAINERS"
echo ""
echo "This changed the allowlist - redeploy to Server 5 yourself (human-run,"
echo "same as any authorized_keys-adjacent step):"
echo "  scp -P 19030 scripts/dev-nemoclaw-server-readonly-wrapper.sh ops-s005@203.0.113.10:~/dev-nemoclaw-server-readonly-wrapper.sh"
echo "  ssh -p 19030 ops-s005@203.0.113.10 chmod 700 dev-nemoclaw-server-readonly-wrapper.sh"
