#!/usr/bin/env bash
# watcher-queue.test.sh <path-to-watcher-common.sh>
# Unit checks for the deferred-delivery queue and the stranded-entry detector.
# Needs bash 5 (namerefs) - run it on Server 6 or in the sandbox, not on macOS.
set -uo pipefail
LIB="$1"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
log() { printf 'LOG: %s\n' "$*"; }   # watcher-common's load_suppressions calls log()
# shellcheck source=/dev/null
source "$LIB"

Q="$TMP/q.json"
FAIL=0
check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; FAIL=1; fi
}

check "empty depth" 0 "$(queue_depth "$Q")"

queue_incident "$Q" sigA "line one
line two" 1000 "gate held"; check "queue A rc" 0 "$?"
check "depth after A" 1 "$(queue_depth "$Q")"

queue_incident "$Q" sigA "different text" 1100 ""; check "duplicate sig rc" 1 "$?"
check "depth unchanged" 1 "$(queue_depth "$Q")"

queue_incident "$Q" sigB "second incident" 1200 "model down" >/dev/null
check "depth after B" 2 "$(queue_depth "$Q")"

queue_peek T S A R K "$Q"; check "peek rc" 0 "$?"
check "peek is oldest" "sigA" "$S"
check "peek text multiline" "line one
line two" "$T"
check "peek queued_at" 1000 "$A"
check "peek reason" "gate held" "$R"
check "peek kind defaults to incident" "incident" "$K"

queue_incident "$Q" sigS "stranded nag" 1300 "" stranded >/dev/null
queue_drop "$Q" sigA; queue_drop "$Q" sigB
queue_peek T S A R K "$Q"
check "peek kind stranded" "stranded" "$K"
queue_incident "$Q" sigA "line one\nline two" 1000 "gate held" >/dev/null
queue_incident "$Q" sigB "second incident" 1200 "model down" >/dev/null
queue_drop "$Q" sigS

queue_drop "$Q" sigA
queue_peek T S A R K "$Q"
check "after drop, B is head" "sigB" "$S"
check "depth after drop" 1 "$(queue_depth "$Q")"

# Attempts: 1st and 2nd keep it, 3rd gives up and drops it.
queue_record_attempt "$Q" sigB; check "attempt 1 keeps" 0 "$?"
queue_record_attempt "$Q" sigB; check "attempt 2 keeps" 0 "$?"
queue_record_attempt "$Q" sigB; check "attempt 3 gives up" 1 "$?"
check "dropped after max attempts" 0 "$(queue_depth "$Q")"

# Cap.
for i in $(seq 1 25); do queue_incident "$Q" "sig$i" "text $i" "$((2000 + i))" "" >/dev/null; done
check "cap enforced" "$QUEUE_MAX_ENTRIES" "$(queue_depth "$Q")"
queue_incident "$Q" sigOverflow "text" 9999 ""; check "full rc" 2 "$?"

# Corrupt file degrades to empty rather than exploding.
echo 'not json at all' >"$Q"
check "corrupt depth" 0 "$(queue_depth "$Q")"
queue_peek T S A R K "$Q"; check "corrupt peek rc" 1 "$?"

# Text truncation.
rm -f "$Q"
LONG=$(head -c 20000 /dev/zero | tr '\0' 'x')
queue_incident "$Q" sigLong "$LONG" 3000 "" >/dev/null
queue_peek T S A R K "$Q"
check "text truncated to cap" "$QUEUE_MAX_TEXT_CHARS" "${#T}"

# --- stranded_fixes -------------------------------------------------------
ST="$TMP/stages.json"
NOW=$(date -u +%s)
OLD=$(date -u -r $((NOW - 4000)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$((NOW - 4000))" +%Y-%m-%dT%H:%M:%SZ)
NEW=$(date -u -r $((NOW - 60)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$((NOW - 60))" +%Y-%m-%dT%H:%M:%SZ)
cat >"$ST" <<EOF
{
  "fix/stale-two":  {"stage": 2, "updated_at": "$OLD"},
  "fix/fresh-two":  {"stage": 2, "updated_at": "$NEW"},
  "fix/at-four":    {"stage": 4, "updated_at": "$OLD"},
  "fix/at-five":    {"stage": 5, "updated_at": "$OLD"},
  "fix/no-ts":      {"stage": 3}
}
EOF
OUT=$(stranded_fixes "$ST" 2700 "$NOW")
check "stranded finds stale stage 2" 1 "$(echo "$OUT" | grep -c 'fix/stale-two')"
check "stranded skips fresh stage 2" 0 "$(echo "$OUT" | grep -c 'fix/fresh-two')"
check "stranded skips stage 4" 0 "$(echo "$OUT" | grep -c 'fix/at-four')"
check "stranded skips stage 5" 0 "$(echo "$OUT" | grep -c 'fix/at-five')"
check "stranded flags missing updated_at" 1 "$(echo "$OUT" | grep -c 'fix/no-ts')"
check "stranded line count" 2 "$(echo "$OUT" | grep -c .)"
check "empty stages file" "" "$(stranded_fixes "$TMP/nonexistent.json" 2700 "$NOW")"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
