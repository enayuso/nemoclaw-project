#!/usr/bin/env bash
# check-rebuild-safe.sh - refuse a rebuild/upgrade that is going to fail after
# it has already destroyed the sandbox.
#
# WHY THIS EXISTS. `nemoclaw <name> rebuild` and `nemoclaw onboard` delete the
# existing sandbox EARLY and smoke-check inference at step 7 of 8, so a fault
# that is trivially fixable beforehand becomes an outage plus a from-scratch
# bootstrap.sh once the delete has happened. That is not hypothetical: on
# 2026-09-04 the recorded provider endpoint had the wrong port (11510 vs 11511
# after the vLLM moved to Server 5), inference.local returned 503, and three
# consecutive rebuilds failed at the same step - the third one after destroying
# a working sandbox. The whole outage was a one-line `openshell provider update`
# away, and every signal needed to predict it was available beforehand.
#
# So: everything this script checks is cheap to check now and expensive to
# discover halfway through. Same discipline as the pre-push hook - a mechanical
# gate, because "read the pre-flight section in docs/recovery.md first" is a
# prose-only rule and this project has repeatedly learned those are not
# reliably followed.
#
# Exit codes:
#   0  safe to proceed
#   1  BLOCKED - at least one hard blocker; fix it before rebuilding
#   2  could not determine (sandbox unreachable, missing tooling) - NOT a pass.
#      Deliberately distinct from 1: "unverifiable" and "verified bad" are
#      different alerts, same reasoning as check-config-drift.sh.
#
# Usage: check-rebuild-safe.sh [-v] [--json]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="ops-nemoclaw"

# Same resolution as check-config-drift.sh, and for the same reason: this may
# run from a non-interactive context with neither ~/.local/bin on PATH nor the
# gateway port set, and both failures masquerade as "sandbox does not exist".
NEMOCLAW_BIN="${NEMOCLAW_BIN:-$(command -v nemoclaw || echo /home/ops-s006/.local/bin/nemoclaw)}"
OPENSHELL_BIN="${OPENSHELL_BIN:-$(command -v openshell || echo /home/ops-s006/.local/bin/openshell)}"
export NEMOCLAW_GATEWAY_PORT="${NEMOCLAW_GATEWAY_PORT:-8180}"
GATEWAY_NAME="${GATEWAY_NAME:-nemoclaw-${NEMOCLAW_GATEWAY_PORT}}"

VERBOSE=0
JSON_MODE=0
case "${1:-}" in
  -v) VERBOSE=1 ;;
  --json) JSON_MODE=1 ;;
esac

RESULTS_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE"' EXIT
if [ "$JSON_MODE" -eq 1 ]; then
  exec 3>&1 1>/dev/null
fi

BLOCKERS=0
WARNINGS=0
UNKNOWN=0
CHECKED=0

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }
amber(){ printf '\033[33m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

# `nemoclaw exec` interleaves gateway-selection and undici noise with real
# output. Strip it, and strip any non-JSON preamble at the call site where JSON
# is expected - openclaw prints config warnings to STDOUT ahead of --json
# payloads, which is what blinded the cron section of check-config-drift.sh.
nc_exec() {
  "$NEMOCLAW_BIN" "$SANDBOX" exec --timeout 60 -- "$@" 2>&1 \
    | grep -vE "UNDICI|trace-warnings|Active gateway set to|^\(node:[0-9]+\)"
}

report() {
  local status="$1" name="$2" detail="$3" fix="${4:-}"
  CHECKED=$((CHECKED + 1))
  jq -nc --arg s "$status" --arg n "$name" --arg d "$detail" --arg f "$fix" \
    '{status:$s, check:$n, detail:$d, fix:$f}' >> "$RESULTS_FILE"
  case "$status" in
    ok)
      [ "$VERBOSE" -eq 1 ] && green "  ok       $name"
      ;;
    block)
      BLOCKERS=$((BLOCKERS + 1))
      red   "  BLOCK    $name"
      echo  "             $detail"
      [ -n "$fix" ] && echo "             fix: $fix"
      ;;
    warn)
      WARNINGS=$((WARNINGS + 1))
      amber "  WARN     $name"
      echo  "             $detail"
      [ -n "$fix" ] && echo "             fix: $fix"
      ;;
    unknown)
      UNKNOWN=$((UNKNOWN + 1))
      red   "  UNKNOWN  $name"
      echo  "             $detail"
      ;;
  esac
}

echo "=== Pre-rebuild safety check for '$SANDBOX' ==="
echo ""

# --- 0. Stale onboarding lock -----------------------------------------------
# FIRST deliberately, before anything that talks to the gateway. A lock whose
# owner is dead blocks state migration, and the CLI then fails outright
# ("Cannot safely migrate legacy NemoClaw state for this gateway port"), so the
# reachability check below would report a bare "unknown" and bury the actual
# cause. Verified by injecting a fake stale lock on 2026-09-04: with the checks
# in the other order, the run ends in `unknown` with no fix named. This one
# needs no gateway - it is a local file - so it costs nothing to do first.
#
# Downstream, the lock is what makes the installer see NO recorded sandboxes and
# fall through to generic onboarding, which then dies on the Jenkins/8080
# conflict and reads as an unrelated port problem.
LOCK="$HOME/.nemoclaw/gateways/${NEMOCLAW_GATEWAY_PORT}/onboard.lock"
if [ ! -f "$LOCK" ]; then
  report ok "no onboarding lock" "no $LOCK"
else
  LOCK_PID=$(jq -r '.pid // empty' "$LOCK" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    report block "no onboarding lock" \
      "an onboarding run is genuinely ACTIVE (pid $LOCK_PID). Do not rebuild underneath it." \
      "wait for it to finish, or stop it deliberately"
  else
    report block "no onboarding lock" \
      "stale lock at $LOCK (recorded pid ${LOCK_PID:-unknown} is not running). It blocks state migration, so the CLI cannot list sandboxes and the installer falls through to generic onboarding." \
      "back it up and delete it: cp '$LOCK' /tmp/ && rm '$LOCK'"
  fi
fi

# --- 1. Can we even see the sandbox? ----------------------------------------
if ! "$NEMOCLAW_BIN" list >/dev/null 2>&1; then
  report unknown "sandbox reachable" \
    "'$NEMOCLAW_BIN list' failed - wrong gateway port, a stale onboard.lock, or no gateway running."
  echo ""
  red "cannot determine rebuild safety - resolve the above first"
  [ "$JSON_MODE" -eq 1 ] && jq -sc '{verdict:"unknown", checks:.}' "$RESULTS_FILE" >&3
  exit 2
fi
report ok "sandbox reachable" "nemoclaw list responds"

# --- 2. inference.local (THE blocker) ---------------------------------------
# The one that turns a routine upgrade into an outage. Both rebuild and onboard
# smoke-check this exact URL at step 7/8, after the delete.
INF_CODE=$(nc_exec curl -s -o /dev/null -w '%{http_code}' https://inference.local/v1/models | tail -1 | tr -dc '0-9')
if [ "$INF_CODE" = "200" ]; then
  report ok "inference.local reachable" "http 200"
elif [ -z "$INF_CODE" ]; then
  report unknown "inference.local reachable" \
    "could not run curl inside the sandbox - cannot confirm the route works"
else
  report block "inference.local reachable" \
    "returned http $INF_CODE, not 200. rebuild/onboard smoke-check this URL at step 7 of 8 - AFTER deleting the sandbox." \
    "check the recorded endpoint: $OPENSHELL_BIN provider get compatible-endpoint --gateway $GATEWAY_NAME; then $OPENSHELL_BIN provider update compatible-endpoint --config OPENAI_BASE_URL=<live-url> --gateway $GATEWAY_NAME"
fi

# --- 3. MCP provider that rebuild may refuse to preserve --------------------
# 0.0.106 cannot bind the old generic profile, and rebuild treats that as fatal
# at its "preserve MCP bridges" step. `mcp list` naming the server is not the
# check; the provider behind it is.
#
# This is a WARN and not a BLOCK on purpose. The profile vintage is NOT
# observable from the CLI - `provider get` reports only `Type: openai`, with no
# profile field, and the "legacy generic profile" wording exists only inside
# rebuild's own failure message. So a provider created BEFORE the 0.0.106
# upgrade is fatal while one created after is fine, and this script cannot tell
# them apart. Blocking on mere existence would refuse perfectly good rebuilds
# once MCP is re-registered, which is worse than warning: a guard that cries
# wolf gets ignored, and then check 1 gets ignored with it.
MCP_PROVIDERS=$("$OPENSHELL_BIN" provider list --gateway "$GATEWAY_NAME" 2>/dev/null | awk 'NR>1 {print $1}' | grep -E "^${SANDBOX}-mcp-" || true)
if [ -z "$MCP_PROVIDERS" ]; then
  report ok "MCP provider state" "no ${SANDBOX}-mcp-* provider registered - nothing for rebuild to refuse"
else
  report warn "MCP provider state" \
    "found: $(printf '%s' "$MCP_PROVIDERS" | tr '\n' ' ')- if this predates the 0.0.106 upgrade, rebuild aborts with 'uses the legacy generic profile, which OpenShell 0.0.106 cannot bind to an MCP endpoint'. Not determinable from here." \
    "cheapest safe action is to remove it either way - $NEMOCLAW_BIN $SANDBOX mcp remove github - since bootstrap.sh re-registers it afterwards, with the DNS patch, in the right order"
fi

# --- 4. Work that a rebuild would destroy -----------------------------------
# A warning, not a blocker: discarding a prepared fix is a legitimate choice,
# but it must be a choice rather than a surprise. /sandbox/repos and
# /sandbox/pilot-state are NOT in the rebuild backup - it covers the OpenClaw
# state tree only.
TRACKED=$(nc_exec bash -lc 'cat /sandbox/pilot-state/*-stages.json 2>/dev/null | jq -s "[.[] | to_entries[]] | length" 2>/dev/null || echo 0' | tail -1 | tr -dc '0-9')
WORKTREES=$(nc_exec bash -lc 'ls -d /sandbox/repos/*-worktrees/*/ 2>/dev/null | wc -l' | tail -1 | tr -dc '0-9')
if [ "${TRACKED:-0}" = "0" ] && [ "${WORKTREES:-0}" = "0" ]; then
  report ok "nothing in flight" "no tracker entries, no worktrees"
else
  report warn "nothing in flight" \
    "${TRACKED:-0} tracker entr(ies) and ${WORKTREES:-0} worktree(s) exist. A rebuild wipes /sandbox - neither is in its backup." \
    "resolve them, or save first: git format-patch main..fix/<slug> --stdout > /tmp/fix.patch"
fi

# --- 5. Drift baseline ------------------------------------------------------
# Not a blocker, but the only thing that will later tell you whether the
# upgrade ate config - which is exactly how the sessions_send settings vanished
# for a week across the v0.0.81 -> v0.0.90 bump.
if "$SCRIPT_DIR/check-config-drift.sh" >/dev/null 2>&1; then
  report ok "config drift baseline" "drift check currently passes - capture it before upgrading"
else
  report warn "config drift baseline" \
    "the drift check does NOT currently pass, so post-upgrade comparison cannot distinguish new damage from pre-existing drift." \
    "./scripts/check-config-drift.sh   (fix or record the drift first)"
fi

echo ""
if [ "$UNKNOWN" -gt 0 ]; then
  red "cannot determine rebuild safety: $UNKNOWN check(s) unverifiable, $BLOCKERS blocker(s)"
  VERDICT=unknown; CODE=2
elif [ "$BLOCKERS" -gt 0 ]; then
  red "NOT safe to rebuild: $BLOCKERS blocker(s), $WARNINGS warning(s) of $CHECKED checks"
  dim "Fix the blockers first. A rebuild started now deletes the sandbox before it discovers them."
  VERDICT=blocked; CODE=1
elif [ "$WARNINGS" -gt 0 ]; then
  green "safe to rebuild: 0 blockers of $CHECKED checks"
  amber "$WARNINGS warning(s) above - review before proceeding, then see docs/recovery.md's 'Upgrading in place'"
  VERDICT=safe_with_warnings; CODE=0
else
  green "safe to rebuild: all $CHECKED checks pass"
  dim "Next: docs/recovery.md's 'Upgrading in place'"
  VERDICT=safe; CODE=0
fi

if [ "$JSON_MODE" -eq 1 ]; then
  jq -sc --arg v "$VERDICT" --argjson b "$BLOCKERS" --argjson w "$WARNINGS" --argjson u "$UNKNOWN" \
    '{verdict:$v, blockers:$b, warnings:$w, unknown:$u, checks:.}' "$RESULTS_FILE" >&3
fi
exit "$CODE"
