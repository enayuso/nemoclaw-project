#!/usr/bin/env bash
# prompt-agent.sh - manually invoke a registered repo's escalation or
# reviewer agent without hand-crafting the underlying `openclaw agent`
# command each time. Resolves the registry lookup (agent name) and
# generates a fresh session-key by default - same split as Claude Code's
# own Agent-tool-vs-SendMessage distinction: a fresh call starts cold with
# no memory, --resume continues a specific prior invocation with full
# context by reusing its exact session-key.
#
# Built 2026-07-23 after a manual resume prompt required hand-writing a
# session-key by convention - exactly the kind of low-level plumbing
# Claude Code's own Agent tool abstracts away from the orchestrator
# instead of leaving it to be redone by hand every time.
#
# Usage:
#   prompt-agent.sh <repo-key> <escalation|reviewer> -m "<message>" [--resume <session-key>] [--timeout <seconds>] [--dry-run]
#   prompt-agent.sh <repo-key> <escalation|reviewer> --message-file <path> [same flags]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="ops-nemoclaw"
# Sourced only for its NEMOCLAW_GATEWAY_PORT pin (see that file's own
# comment, added 2026-09-04) - a manual interactive run inherits an SSH
# session's shell profile and would likely be fine either way, but this
# keeps every nemoclaw call site in the repo consistent rather than
# relying on that.
source "$SCRIPT_DIR/lib/sandbox-helpers.sh"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"

usage() {
  echo "Usage: prompt-agent.sh <repo-key> <escalation|reviewer> -m \"<message>\" [--resume <session-key>] [--timeout <seconds>] [--dry-run]" >&2
  echo "       prompt-agent.sh <repo-key> <escalation|reviewer> --message-file <path> [same flags]" >&2
  exit 1
}

[ $# -lt 2 ] && usage

REPO_KEY="$1"; ROLE="$2"; shift 2

if [ "$ROLE" != "escalation" ] && [ "$ROLE" != "reviewer" ]; then
  echo "error: role must be 'escalation' or 'reviewer', got '${ROLE}'" >&2
  exit 1
fi

if ! jq -e --arg k "$REPO_KEY" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
  echo "error: '${REPO_KEY}' is not registered (check registry/repos.json)" >&2
  exit 1
fi

MESSAGE=""
RESUME_KEY=""
TIMEOUT=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m) MESSAGE="$2"; shift 2 ;;
    --message-file)
      [ -f "$2" ] || { echo "error: --message-file '$2' not found" >&2; exit 1; }
      MESSAGE="$(cat "$2")"; shift 2 ;;
    --resume) RESUME_KEY="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -z "$MESSAGE" ] && { echo "error: message is required, via -m \"<text>\" or --message-file <path>" >&2; exit 1; }

# nemoclaw exec's underlying argv has a hard ~32768-byte cap per argument -
# confirmed live 2026-07-23 when a review request with a full diff embedded
# in -m failed with a low-level "command argument N exceeds 32768 byte
# limit" error from well below this script. Checked here so that fails
# fast with an actionable message instead. Don't inline large content
# (diffs, logs) in the message - point the agent at the file/path/command
# to read it itself, it has its own shell access for exactly this.
MESSAGE_BYTES=$(printf '%s' "$MESSAGE" | wc -c)
if [ "$MESSAGE_BYTES" -gt 32000 ]; then
  echo "error: message is ${MESSAGE_BYTES} bytes, exceeds nemoclaw exec's ~32768-byte argv limit." >&2
  echo "Don't embed large content (diffs, logs) directly - tell the agent where to read it itself" >&2
  echo "(e.g. 'run git diff origin/main yourself in <worktree path>') instead of pasting it in." >&2
  exit 1
fi

AGENT="${REPO_KEY}-${ROLE}"

if [ -n "$RESUME_KEY" ]; then
  SESSION_KEY="$RESUME_KEY"
  echo "Resuming session: $SESSION_KEY"
else
  SESSION_KEY="agent:${AGENT}:manual-$(date +%s)"
  echo "Starting fresh session: $SESSION_KEY"
  echo "(pass --resume \"$SESSION_KEY\" later to continue this exact conversation with full context)"
fi

CMD=(nemoclaw "$SANDBOX" exec -- openclaw agent --agent "$AGENT" --session-key "$SESSION_KEY")
[ -n "$TIMEOUT" ] && CMD+=(--timeout "$TIMEOUT")

CMD+=(-m "$MESSAGE")

echo "=== Prompting ${AGENT} ==="
if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: would run (skipping the live sandbox check too):"
  printf '%q ' "${CMD[@]}"
  echo ""
  exit 0
fi

if ! nemoclaw "$SANDBOX" exec -- test -d "/sandbox/.openclaw/agents/${AGENT}/workspace" 2>/dev/null; then
  echo "error: agent '${AGENT}' has no workspace in the sandbox - is '${REPO_KEY}' actually registered and deployed?" >&2
  exit 1
fi

"${CMD[@]}"
