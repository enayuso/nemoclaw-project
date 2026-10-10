#!/usr/bin/env bash
# review-call.sh <reviewer-agent> <slug> <message-file>
#
# Wraps the escalation agents' second-opinion call to `openclaw agent` so the
# one thing that must not happen, cannot.
#
# WHY THIS EXISTS. OpenClaw does not refuse a second run on a session key that
# is already live. It silently reroutes the new run into a `gateway-fallback-*`
# session AND aborts the original. On 2026-08-12 that destroyed a review seven
# minutes in and one step from its verdict: the agent's `exec` had returned
# early (the command outlives the tool call), the agent read the empty result as
# failure, re-invoked the same --session-key to "retry", and killed the very run
# it was trying to rescue. ~940k input tokens across the two attempts, no
# verdict, and the fix parked at stage 2 marked "NOT independently reviewed".
#
# The docs now tell the agent to wait and poll instead. This makes that an
# invariant rather than a request: while a review for this slug is running, a
# second call CANNOT start one. It also removes three other things the agent has
# to remember each time - the `env -u` prefix, the timeout, and capturing output
# somewhere it survives the exec returning early.
#
# flock, not a pidfile: the lock lives on an open descriptor, so it is released
# by the kernel when this process exits for ANY reason - normal exit, timeout,
# OOM, the container stopping. A crashed review therefore cannot leave a stale
# lock that blocks every future review of that slug, which is the failure mode
# that would make this cure worse than the disease.
set -uo pipefail

STATE_DIR="/sandbox/pilot-state"
LOCK_DIR="$STATE_DIR/locks"
OUT_DIR="$STATE_DIR/reviews"
TIMEOUT="${REVIEW_TIMEOUT:-900}"

usage() {
  echo "Usage: review-call.sh <reviewer-agent> <slug> <message-file>" >&2
  echo "  e.g. review-call.sh api-rag-reviewer image-reranker-400 /tmp/review-msg.txt" >&2
  exit 64
}

[ $# -eq 3 ] || usage
AGENT="$1"; SLUG="$2"; MSG_FILE="$3"

[ -n "$AGENT" ] && [ -n "$SLUG" ] || usage
if [ ! -f "$MSG_FILE" ]; then
  echo "review-call: message file '$MSG_FILE' does not exist." >&2
  echo "Write the incident + diff to a file first, then pass its path." >&2
  exit 66
fi
if [ ! -s "$MSG_FILE" ]; then
  echo "review-call: message file '$MSG_FILE' is empty - a reviewer with no diff" >&2
  echo "cannot review anything. Write the incident and diff into it first." >&2
  exit 66
fi

# Slugs are agent-authored. Anything that is not [A-Za-z0-9._-] is collapsed so
# a slug can never escape these directories or invent a nested path.
SAFE_SLUG=$(printf '%s' "$SLUG" | tr -c 'A-Za-z0-9._-' '-')
SAFE_AGENT=$(printf '%s' "$AGENT" | tr -c 'A-Za-z0-9._-' '-')
BASE="${SAFE_AGENT}--${SAFE_SLUG}"

# The session key deliberately keeps the RAW slug: it has to match what
# TOOLS.md documents and what any earlier round of this review already used, or
# reusing it would silently start a new thread instead of continuing one.
SESSION_KEY="agent:${AGENT}:review-${SLUG}"

mkdir -p "$LOCK_DIR" "$OUT_DIR" || {
  echo "review-call: could not create $LOCK_DIR / $OUT_DIR" >&2
  exit 73
}

LOCK_FILE="$LOCK_DIR/${BASE}.lock"
OUT_FILE="$OUT_DIR/${BASE}.out"

exec 9>>"$LOCK_FILE" || {
  echo "review-call: could not open lock file $LOCK_FILE" >&2
  exit 73
}

if ! flock -n 9; then
  # Held: a review for this slug is ALREADY RUNNING. Refusing is the whole
  # point - starting a second one is what aborts the first.
  STARTED=$(head -1 "$LOCK_FILE" 2>/dev/null || echo "")
  ELAPSED="unknown"
  case "$STARTED" in
    ''|*[!0-9]*) ;;
    *) ELAPSED="$(( $(date +%s) - STARTED ))s" ;;
  esac
  cat >&2 <<EOF
review-call: a review of '${SLUG}' by ${AGENT} is ALREADY RUNNING (started ${ELAPSED} ago).

NOT started a second one, deliberately. Re-invoking the same session key does
not retry a review - it aborts the running one and reroutes the new run into a
throwaway session, so both are lost. That has happened; it cost a completed
review.

A review normally takes several minutes. Do this instead:
  1. Wait. Poll the output with the process tool, or re-read:
       ${OUT_FILE}
  2. It is finished when that file's last line reads:
       === REVIEW COMPLETE (exit N) ===
     Until that line exists, it is still working - an empty or partial file
     means "not done", never "failed".
EOF
  exit 75
fi

# Lock is ours. Record the start time for the message above.
date +%s >"$LOCK_FILE"

echo "review-call: reviewing '${SLUG}' via ${AGENT} (timeout ${TIMEOUT}s)" >&2
echo "review-call: output also being written to ${OUT_FILE}" >&2

# Truncate any previous round's output, so a stale COMPLETE marker from an
# earlier review of this same slug can never be mistaken for this one finishing.
: >"$OUT_FILE"

# env -u is required, not optional: this process runs with
# OPENCLAW_GATEWAY_URL/_PORT/_TOKEN set, a nested `openclaw agent` reads them as
# an explicit gateway-URL override, and the call fails with
# GatewayExplicitAuthRequiredError - even though the identical command works
# from a plain shell such as cron.
env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_PORT -u OPENCLAW_GATEWAY_TOKEN \
  openclaw agent --agent "$AGENT" --session-key "$SESSION_KEY" \
  --timeout "$TIMEOUT" -m "$(cat "$MSG_FILE")" 2>&1 | tee -a "$OUT_FILE"
RC=${PIPESTATUS[0]}

# The completion marker is what makes "poll the file" a decidable test rather
# than a guess. Written LAST and to both streams, so whichever the caller is
# reading tells the same story.
echo "=== REVIEW COMPLETE (exit ${RC}) ===" | tee -a "$OUT_FILE"

if [ "$RC" -ne 0 ]; then
  echo "review-call: the reviewer call FAILED (exit ${RC}) - report this explicitly" >&2
  echo "in your Stage 4 report and in reviewer_status. Do not self-assess in its place." >&2
fi
exit "$RC"
