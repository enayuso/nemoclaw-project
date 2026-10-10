#!/usr/bin/env bash
# ask-decision.test.sh <path-to-ask-decision.sh>
# End-to-end checks against a throwaway state dir and a real git worktree.
# Needs bash 5, git and jq - run it on Server 6 or in the sandbox.
set -uo pipefail
SCRIPT="$1"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export PILOT_STATE_DIR="$TMP/pilot-state"
mkdir -p "$PILOT_STATE_DIR/reviews"
FAIL=0
check() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; FAIL=1; fi; }
contains() { if grep -qF -- "$2" "$3"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: %s not found in %s\n' "$1" "$2" "$3"; FAIL=1; fi; }

# --- a real git worktree with a real committed change ---
REPO="$TMP/repo"
git init -q "$REPO"
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
printf 'def f():\n    return 1\n' >"$REPO/app.py"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" branch -M main
WT="$TMP/wt"
git -C "$REPO" worktree add -q -b fix/demo "$WT" main
printf 'def f():\n    return 2  # the actual fix\n' >"$WT/app.py"
git -C "$WT" add -A && git -C "$WT" commit -qm "fix: return 2"
# trunk moves on after the branch is cut - the merge-base case
printf 'unrelated\n' >"$REPO/other.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "unrelated trunk commit"

REPORT="$TMP/report.md"
cat >"$REPORT" <<'EOF'
The reranker 400s on multi-modal batches. Falls back to one doc per request.
Verified by importing the module and calling the changed function.
EOF

STAGES="$PILOT_STATE_DIR/demo-escalation-stages.json"

echo "--- 1. no tracker file at all"
OUT=$(bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" 2>&1); RC=$?
check "rc when no tracker" 66 "$RC"

echo "--- 2. tracker exists but no entry for the branch"
echo '{"fix/other": {"stage": 2}}' >"$STAGES"
OUT=$(bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" 2>&1); RC=$?
check "rc when entry missing" 66 "$RC"
check "lists present keys" 1 "$(printf '%s' "$OUT" | grep -c 'fix/other')"
check "tracker untouched" 1 "$(jq 'keys | length' "$STAGES")"

echo "--- 3. empty report file"
: >"$TMP/empty.md"
OUT=$(bash "$SCRIPT" demo-escalation main fix/demo "$TMP/empty.md" 2>&1); RC=$?
check "rc when report empty" 66 "$RC"

echo "--- 4. the happy path"
jq --arg wt "$WT" '. + {"fix/demo": {incident: "x", stage: 2, worktree: $wt, pr_url: null,
   session_key: "agent:demo-escalation:demo-watcher", incident_signature: "abc123",
   updated_at: "2026-08-13T00:00:00Z"}}' "$STAGES" >"$STAGES.t" && mv "$STAGES.t" "$STAGES"
OUT_FILE="$TMP/stdout.txt"
bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" >"$OUT_FILE" 2>"$TMP/stderr.txt"; RC=$?
check "rc happy path" 0 "$RC"
check "stage moved to 4" 4 "$(jq -r '.["fix/demo"].stage' "$STAGES")"
check "session_key preserved" "agent:demo-escalation:demo-watcher" "$(jq -r '.["fix/demo"].session_key' "$STAGES")"
check "signature preserved" "abc123" "$(jq -r '.["fix/demo"].incident_signature' "$STAGES")"
check "other entry untouched" 2 "$(jq -r '.["fix/other"].stage' "$STAGES")"
check "updated_at moved" 0 "$(jq -r '.["fix/demo"].updated_at == "2026-08-13T00:00:00Z"' "$STAGES" | grep -c true)"
contains "report text included" "one doc per request" "$OUT_FILE"
contains "real diff included" "return 2  # the actual fix" "$OUT_FILE"
contains "diffstat included" "app.py" "$OUT_FILE"
check "merge-base used: unrelated trunk commit NOT in diff" 0 "$(grep -c 'unrelated' "$OUT_FILE")"
contains "missing review reported" "NO REVIEW OUTPUT FOUND" "$OUT_FILE"
contains "stage-4 banner" "AWAITING A HUMAN DECISION" "$OUT_FILE"
REPORT_COPY="$PILOT_STATE_DIR/reports/demo-escalation--demo.md"
check "report copy written" 0 "$([ -s "$REPORT_COPY" ]; echo $?)"
contains "stderr tells it to stop" "End your turn now" "$TMP/stderr.txt"

echo "--- 5. uncommitted changes are called out"
printf 'stray\n' >"$WT/uncommitted.txt"
bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" >"$OUT_FILE" 2>/dev/null
contains "uncommitted warning" "UNCOMMITTED CHANGES" "$OUT_FILE"
contains "names the file" "uncommitted.txt" "$OUT_FILE"
rm -f "$WT/uncommitted.txt"

echo "--- 6. a completed review is quoted from disk"
cat >"$PILOT_STATE_DIR/reviews/demo-reviewer--demo.out" <<'EOF'
lots of review reasoning here
**Status: APPROVED**
=== REVIEW COMPLETE (exit 0) ===
EOF
bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" >"$OUT_FILE" 2>/dev/null
contains "review verdict quoted" "Status: APPROVED" "$OUT_FILE"
contains "completion marker quoted" "REVIEW COMPLETE (exit 0)" "$OUT_FILE"

echo "--- 7. an unfinished review is reported as unreviewed"
printf 'still working...\n' >"$PILOT_STATE_DIR/reviews/demo-reviewer--demo.out"
bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" >"$OUT_FILE" 2>/dev/null
contains "incomplete review flagged" "REVIEW INCOMPLETE" "$OUT_FILE"

echo "--- 8. missing worktree degrades honestly"
jq '.["fix/demo"].worktree = "/nope/gone"' "$STAGES" >"$STAGES.t" && mv "$STAGES.t" "$STAGES"
bash "$SCRIPT" demo-escalation main fix/demo "$REPORT" >"$OUT_FILE" 2>/dev/null; RC=$?
check "rc with dead worktree" 0 "$RC"
contains "says the diff is missing" "could not be read from disk" "$OUT_FILE"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
