#!/usr/bin/env bash
# ops-nemoclaw-watchdog.sh - periodic health check for the ops-nemoclaw
# sandbox's gateway, backed by `nemoclaw doctor --json`, escalating to
# `nemoclaw recover` only when doctor reports something other than "ok".
#
# Runs on Server 6's HOST crontab (ops-s006), not inside the sandbox -
# unlike scripts/tunnel-keeper.sh (which deliberately runs INSIDE the
# sandbox so its own lifecycle handles cleanup), this watchdog's entire
# job is checking whether the sandbox's gateway itself is up, which is
# structurally impossible to do from inside the thing being checked. Each
# cron firing is a short-lived, self-terminating process (no persistent
# daemon/tunnel of its own), so this is not the failure shape documented
# in the device-pairing-spam incident (a long-running, auto-reconnecting
# host-side process spamming approvals after repeated `gateway restart`
# calls) - but as an extra guard against exactly that class of problem,
# this still throttles its OWN recover attempts (see RECOVER_COOLDOWN_SEC
# below) rather than firing recover on every single unhealthy tick.
#
# `recover`'s own --help text: "A healthy gateway is not restarted" -
# confirmed live 2026-07-31 by running it against an already-healthy
# ops-nemoclaw and observing a clean no-op probe, zero disruption.
#
# Usage: ops-nemoclaw-watchdog.sh (no args, meant for cron)
set -uo pipefail

SANDBOX="ops-nemoclaw"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sourced only for its NEMOCLAW_GATEWAY_PORT pin (see that file's own
# comment) - added 2026-09-04 after this cron-triggered script's doctor/
# recover calls were found silently failing every 5-minute tick, unlike
# an interactive login shell a human might run nemoclaw from, cron gives
# this process no shell profile to pick the pin up from otherwise.
source "$SCRIPT_DIR/lib/sandbox-helpers.sh"
LOG="$SCRIPT_DIR/ops-nemoclaw-watchdog.log"
LAST_RECOVER_FILE="$SCRIPT_DIR/ops-nemoclaw-watchdog.state"
# Floor between recover attempts - if doctor stays unhealthy across many
# consecutive ticks (a real, not-self-resolving problem), this stops the
# watchdog from hammering `recover` every single run and instead just
# keeps logging the unhealthy status until a human looks at it.
RECOVER_COOLDOWN_SEC=1800

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

DOCTOR_JSON="$(nemoclaw "$SANDBOX" doctor --json 2>>"$LOG")"
if [ -z "$DOCTOR_JSON" ]; then
  log "doctor --json produced no output - nemoclaw CLI itself may be broken, skipping this tick"
  exit 1
fi

STATUS="$(printf '%s' "$DOCTOR_JSON" | jq -r '.status // "unknown"')"
FAILED="$(printf '%s' "$DOCTOR_JSON" | jq -r '.failed // "?"')"
WARNINGS="$(printf '%s' "$DOCTOR_JSON" | jq -r '.warnings // "?"')"

if [ "$STATUS" = "ok" ]; then
  log "healthy (status=ok, failed=$FAILED, warnings=$WARNINGS)"
  exit 0
fi

log "unhealthy (status=$STATUS, failed=$FAILED, warnings=$WARNINGS)"

NOW="$(date +%s)"
LAST_RECOVER=0
[ -f "$LAST_RECOVER_FILE" ] && LAST_RECOVER="$(cat "$LAST_RECOVER_FILE" 2>/dev/null || echo 0)"
ELAPSED=$((NOW - LAST_RECOVER))

if [ "$ELAPSED" -lt "$RECOVER_COOLDOWN_SEC" ]; then
  log "still unhealthy but last recover attempt was ${ELAPSED}s ago (cooldown ${RECOVER_COOLDOWN_SEC}s) - not retrying yet"
  exit 1
fi

log "attempting recover"
echo "$NOW" >"$LAST_RECOVER_FILE"
RECOVER_OUTPUT="$(nemoclaw "$SANDBOX" recover 2>&1)"
log "recover output: $RECOVER_OUTPUT"
