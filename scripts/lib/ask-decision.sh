#!/usr/bin/env bash
# ask-decision.sh <escalation-agent> <trunk-branch> <fix-branch> <report-file>
#
# The only way an escalation agent can ask a human for permission to push.
#
# WHY THIS EXISTS. Asking used to be two separate acts: write a report and
# stop, then separately update the stage tracker to 4. The second one is what
# actually delivers the question - the dashboard shows Approve/Deny only at
# stage 4, and the composer is disabled for gateway-origin sessions, so an
# entry below 4 has no button and no way to type at it. On 2026-08-13 an
# api-rag fix with a clean APPROVED review posted a correct Stage 4 report
# ending in "Can I push and open a PR to main?" and left its tracker at stage
# 2. The question was unanswerable. The agent had done the hard 95% and lost
# it on the bookkeeping.
#
# So the bookkeeping stops being a separate step the agent has to remember.
# Asking IS the tracker write: one call, and the report cannot exist without
# the stage move that makes it actionable. This is the ExitPlanMode shape -
# the tool call is the question, not a note attached to one - and the same
# reasoning as review-call.sh: make the thing that must not be forgotten
# impossible to forget rather than more firmly requested.
#
# It also fixes what the report CONTAINS. A Stage 4 report carried whatever
# diff the agent chose to paste, and one on 2026-08-13 pasted an abridged one
# with `...` placeholders - the human was approving a summary. This appends
# the real `git diff` from the worktree, plus whether anything is still
# uncommitted (an uncommitted change is in neither the diff nor the push),
# plus the tail of the independent review's own output file. None of those
# are things the agent narrates; they are read off disk.
set -uo pipefail

# Overridable only so this can be exercised against a throwaway state
# directory outside the sandbox; nothing in the agents' environment sets it.
STATE_DIR="${PILOT_STATE_DIR:-/sandbox/pilot-state}"
REVIEWS_DIR="$STATE_DIR/reviews"
REPORTS_DIR="$STATE_DIR/reports"
LOCK_DIR="$STATE_DIR/locks"
# Generous, but not unbounded: the point is that the human sees the real
# change, and a diff past this size is one they need to open the branch for
# anyway. Truncation is always stated in the report, never silent.
DIFF_MAX_LINES="${ASK_DIFF_MAX_LINES:-800}"
REVIEW_TAIL_LINES="${ASK_REVIEW_TAIL_LINES:-25}"

usage() {
  cat >&2 <<'EOF'
Usage: ask-decision.sh <escalation-agent> <trunk-branch> <fix-branch> <report-file>
  e.g. ask-decision.sh api-rag-escalation main fix/reranker-fallback /tmp/report.md

Write your Stage 4 report to a file first (what the incident was, what you
changed and why, how you verified it, what the reviewer said), then pass its
path. This appends the real diff and review status itself - do not paste
those into the report file.
EOF
  exit 64
}

[ $# -eq 4 ] || usage
AGENT="$1"; TRUNK="$2"; BRANCH="$3"; REPORT_FILE="$4"
[ -n "$AGENT" ] && [ -n "$TRUNK" ] && [ -n "$BRANCH" ] || usage

if [ ! -s "$REPORT_FILE" ]; then
  echo "ask-decision: report file '$REPORT_FILE' is missing or empty." >&2
  echo "The human reads this text to decide. Write it first, then call again." >&2
  exit 66
fi

STAGES_FILE="$STATE_DIR/${AGENT}-stages.json"
if [ ! -s "$STAGES_FILE" ]; then
  echo "ask-decision: no stage tracker at $STAGES_FILE." >&2
  echo "There is nothing to move to stage 4. Create the Stage 2 entry for this" >&2
  echo "fix first (see TOOLS.md), then ask." >&2
  exit 66
fi

# The entry must already exist. Creating one here would let a fix reach stage
# 4 without ever having had a worktree recorded, and the Stage 2 write is
# where session_key and incident_signature are captured verbatim from the
# invoking message - neither of which this script can know or invent. A later
# Deny needs the signature to recognise the incident if it comes back.
ENTRY=$(jq -c --arg b "$BRANCH" '.[$b] // empty' "$STAGES_FILE" 2>/dev/null || true)
if [ -z "$ENTRY" ]; then
  echo "ask-decision: no tracker entry for '$BRANCH' in $STAGES_FILE." >&2
  echo "Entries are keyed by the exact fix branch name. Either you are asking" >&2
  echo "about a branch you never recorded at Stage 2, or the name differs." >&2
  echo "Present keys:" >&2
  jq -r 'keys[]' "$STAGES_FILE" 2>/dev/null | sed 's/^/  /' >&2
  exit 66
fi

WORKTREE=$(printf '%s' "$ENTRY" | jq -r '.worktree // ""')
SLUG="${BRANCH#fix/}"
SAFE_SLUG=$(printf '%s' "$SLUG" | tr -c 'A-Za-z0-9._-' '-')
SAFE_AGENT=$(printf '%s' "$AGENT" | tr -c 'A-Za-z0-9._-' '-')

mkdir -p "$REPORTS_DIR" "$LOCK_DIR" 2>/dev/null || {
  echo "ask-decision: could not create $REPORTS_DIR / $LOCK_DIR" >&2
  exit 73
}
REPORT_OUT="$REPORTS_DIR/${SAFE_AGENT}--${SAFE_SLUG}.md"

# --- Ground truth from the worktree ---------------------------------------
# Everything below is read off disk rather than taken from the report text.
DIFF_SECTION=""
UNCOMMITTED_NOTE=""
if [ -z "$WORKTREE" ] || [ ! -d "$WORKTREE" ]; then
  DIFF_SECTION="(No worktree recorded on the tracker entry, or it no longer exists at
'${WORKTREE:-<empty>}'. The diff below could not be read from disk, so what
you are approving is only what the agent wrote above.)"
else
  # Three-dot semantics via an explicit merge-base: what this branch ADDS to
  # trunk, not the difference between two tips. Without it, commits that
  # landed on trunk after the branch was cut show up inverted in the diff and
  # read like the fix is reverting other people's work.
  BASE=$(git -C "$WORKTREE" merge-base "$TRUNK" HEAD 2>/dev/null || true)
  [ -n "$BASE" ] || BASE="$TRUNK"
  DIFF_STAT=$(git -C "$WORKTREE" diff --stat "$BASE" HEAD 2>&1)
  DIFF_FULL=$(git -C "$WORKTREE" diff "$BASE" HEAD 2>&1)
  DIFF_LINES=$(printf '%s\n' "$DIFF_FULL" | wc -l | tr -d ' ')
  if [ "$DIFF_LINES" -gt "$DIFF_MAX_LINES" ]; then
    DIFF_FULL="$(printf '%s\n' "$DIFF_FULL" | head -n "$DIFF_MAX_LINES")

[TRUNCATED - ${DIFF_LINES} lines total, first ${DIFF_MAX_LINES} shown.
 Full diff: git -C ${WORKTREE} diff ${BASE} HEAD]"
  fi
  DIFF_SECTION="${DIFF_STAT}

${DIFF_FULL}"

  # An uncommitted change is in neither this diff nor the push that would
  # follow an approval, so approving would land something different from what
  # was shown. Worth its own line rather than a footnote.
  DIRTY=$(git -C "$WORKTREE" status --porcelain 2>/dev/null || true)
  if [ -n "$DIRTY" ]; then
    UNCOMMITTED_NOTE="
WARNING - THE WORKTREE HAS UNCOMMITTED CHANGES. They are NOT in the diff
below and would NOT be pushed if this is approved:
${DIRTY}
"
  fi
fi

# --- Independent review, as it actually landed on disk ---------------------
# Derived from the agent id by the same <repo>-escalation / <repo>-reviewer
# convention register-repo.sh creates both agents under. Reported, never
# enforced: a genuinely failed reviewer call is something to stop and report,
# and refusing to let the agent ask in that case would strand it exactly the
# way this script exists to prevent.
REVIEWER="${AGENT%-escalation}-reviewer"
REVIEW_FILE="$REVIEWS_DIR/${REVIEWER}--${SAFE_SLUG}.out"
if [ ! -f "$REVIEW_FILE" ]; then
  REVIEW_SECTION="NO REVIEW OUTPUT FOUND at ${REVIEW_FILE}.
Either the second opinion was never run for this slug, or it was run under a
different one. Treat this fix as UNREVIEWED unless the report above explains
otherwise."
elif ! grep -q '^=== REVIEW COMPLETE' "$REVIEW_FILE" 2>/dev/null; then
  REVIEW_SECTION="REVIEW INCOMPLETE - ${REVIEW_FILE} exists but has no
'=== REVIEW COMPLETE (exit N) ===' marker, which means the reviewer was still
running (or died) when this was written. Treat this fix as UNREVIEWED."
else
  REVIEW_SECTION="Review output: ${REVIEW_FILE}
$(grep '^=== REVIEW COMPLETE' "$REVIEW_FILE" | tail -1)

Last ${REVIEW_TAIL_LINES} lines of the reviewer's own words:
$(tail -n "$REVIEW_TAIL_LINES" "$REVIEW_FILE")"
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  echo "=== STAGE 4 - AWAITING A HUMAN DECISION ==="
  echo "agent:    ${AGENT}"
  echo "branch:   ${BRANCH}"
  echo "trunk:    ${TRUNK}"
  echo "worktree: ${WORKTREE:-<none recorded>}"
  echo "asked at: ${TS}"
  echo
  cat "$REPORT_FILE"
  echo
  [ -n "$UNCOMMITTED_NOTE" ] && echo "$UNCOMMITTED_NOTE"
  echo "--- Independent review (read from disk, not summarised) ---"
  echo "$REVIEW_SECTION"
  echo
  echo "--- Actual diff (read from the worktree, not pasted) ---"
  echo "$DIFF_SECTION"
  echo
  echo "=== Approve or Deny in the dashboard. Nothing is pushed until then. ==="
} >"$REPORT_OUT" 2>/dev/null || {
  echo "ask-decision: could not write $REPORT_OUT" >&2
  exit 73
}

# --- The tracker write this call exists to make unforgettable --------------
# Serialized with flock: this is a read-modify-write of a file the agent also
# edits by hand at other stages, and two of them interleaving would lose one.
# Temp-then-rename so a kill mid-write leaves the previous tracker intact
# rather than a truncated one, same as everywhere else that writes this file.
exec 9>>"$LOCK_DIR/${SAFE_AGENT}-stages.lock" || {
  echo "ask-decision: could not open the tracker lock" >&2
  exit 73
}
flock 9

TMP="${STAGES_FILE}.tmp.$$"
if ! jq --arg b "$BRANCH" --arg ts "$TS" --arg rp "$REPORT_OUT" \
     '.[$b].stage = 4 | .[$b].updated_at = $ts | .[$b].report_path = $rp' \
     "$STAGES_FILE" >"$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "ask-decision: failed to update $STAGES_FILE - the entry was NOT moved" >&2
  echo "to stage 4, so nobody can see your question yet. Do not stop here." >&2
  exit 73
fi
mv -f "$TMP" "$STAGES_FILE" || {
  rm -f "$TMP"
  echo "ask-decision: failed to replace $STAGES_FILE - the entry was NOT moved" >&2
  echo "to stage 4. Do not stop here." >&2
  exit 73
}

cat "$REPORT_OUT"

cat >&2 <<EOF

ask-decision: ${BRANCH} is now at stage 4. Approve/Deny is live in the
dashboard and this repo's watcher will hold escalation delivery until it is
answered (it keeps checking the workload meanwhile).
A copy of what the human sees: ${REPORT_OUT}

End your turn now. Do not push, do not open a PR, do not ask again.
EOF
