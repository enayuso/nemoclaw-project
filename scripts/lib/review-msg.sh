#!/usr/bin/env bash
# review-msg.sh <base-ref> <branch> <incident-file>
#
# Assembles the message for a second-opinion review on stdout: the incident
# description the agent wrote, the unified diff, and THE FULL CONTENTS OF THE
# CHANGED FILES. Pipe it into a file and hand that file to review-call.sh.
#
# WHY THIS EXISTS. Until 2026-08-13 the docs told the escalation agent to paste
# `git diff` into the message by hand, so the reviewer saw hunks and nothing
# else. On 2026-08-13 (svc-sandbox-mcp, fix/readiness-image-check) that cost
# a review twice over, in both directions at once:
#
#   - FALSE POSITIVE. The reviewer reported `ImageNotFound` as un-imported and
#     labelled it CONFIRMED. It is imported, on line 20 - outside the hunk. It
#     had no way to look and no instruction to, so a hunk boundary became a
#     "confirmed" bug. That is the single most expensive kind of wrong answer
#     here: it spends the agent's attention and its own credibility on nothing.
#   - MISS. Three lines below that hunk sat `JSONResponse(..., detail=...)`.
#     Starlette's Response takes no `detail` kwarg, so every call to that
#     endpoint raised TypeError - in a READINESS probe, so the pod could never
#     become ready. The reviewer wrote that "response structure ... checks out
#     as correct". Verifying it needed the constructor's real signature, which a
#     diff cannot show either.
#
# Both failures are the same missing input, not a weak model. The PR reviewer
# already learned this and pre-fetches full file contents; this brings the
# pre-push reviewer to the same tier.
#
# PRE-FETCH, don't make the reviewer go and read. Measured on the PR reviewer:
# a tool-calling review took 900s and produced NOTHING, against 99s for the
# single-turn pre-fetched version. Handing the reviewer the bytes is not a
# convenience, it is the difference between a review and a timeout.
set -uo pipefail

# Caps mirror templates/pr-watcher.sh.tmpl, and for the same reason: the
# binding limit is the 600s-per-call provider timeout, not the 262144-token
# window - a bigger prompt means more reasoning at ~25 tok/s decode. Keep them
# ordered DIFF_ONLY_ABOVE < MAX_PROMPT_BYTES or the tiers overlap incoherently.
DIFF_ONLY_ABOVE="${DIFF_ONLY_ABOVE:-150000}"   # diff over this -> skip file contents
MAX_PROMPT_BYTES="${MAX_PROMPT_BYTES:-350000}" # stop growing the message here
MAX_FILE_BYTES="${MAX_FILE_BYTES:-60000}"      # per-file cap within the full tier

# Generated/vendored/binary paths: their diff still shows, but there is nothing
# to verify by reading them and they crowd out real code. Same list as
# pr-watcher.sh.tmpl - keep the two in step.
GENERATED_PATHS='(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|composer\.lock)$|(^|/)(node_modules|vendor|dist|build)/|\.min\.(js|css)$|\.(png|jpe?g|gif|ico|pdf|zip|tar|gz|woff2?|ttf|eot|so|dylib|dll|jar|class|pyc)$'

usage() {
  echo "Usage: review-msg.sh <base-ref> <branch> <incident-file> > /tmp/review-msg.txt" >&2
  echo "  e.g. review-msg.sh main fix/readiness-image-check /tmp/incident.txt" >&2
  echo "Run it from inside the repo (the worktree or the shared clone)." >&2
  exit 64
}

[ $# -eq 3 ] || usage
BASE="$1"; BRANCH="$2"; INCIDENT_FILE="$3"

[ -n "$BASE" ] && [ -n "$BRANCH" ] || usage

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "review-msg: not inside a git repository - cd to the worktree first." >&2
  exit 69
fi

for REF in "$BASE" "$BRANCH"; do
  if ! git rev-parse --verify --quiet "$REF" >/dev/null; then
    echo "review-msg: '$REF' does not resolve to a ref in this repo." >&2
    echo "Check the branch name, and that Stage 0 refreshed the base branch." >&2
    exit 65
  fi
done

if [ ! -s "$INCIDENT_FILE" ]; then
  echo "review-msg: incident file '$INCIDENT_FILE' is missing or empty." >&2
  echo "Write what you were fixing and why into it first - the diff alone does" >&2
  echo "not tell the reviewer what the change is supposed to achieve." >&2
  exit 66
fi

DIFF=$(git diff "${BASE}...${BRANCH}")
if [ -z "$DIFF" ]; then
  echo "review-msg: '${BASE}...${BRANCH}' is an EMPTY diff - there is nothing to" >&2
  echo "review. Did you commit the fix? Is the branch name right?" >&2
  exit 65
fi
DIFF_BYTES=${#DIFF}

# mktemp + trap, not fixed /tmp paths: this runs in a sandbox shared with every
# other agent, and an error exit must not leave a half-built message behind for
# a later run to pick up.
BODY=$(mktemp) || { echo "review-msg: mktemp failed" >&2; exit 73; }
FILEBUF=$(mktemp) || { echo "review-msg: mktemp failed" >&2; exit 73; }
trap 'rm -f "$BODY" "$FILEBUF"' EXIT

TIER="full"
[ "$DIFF_BYTES" -gt "$DIFF_ONLY_ABOVE" ] && TIER="diff-only"

{
  cat "$INCIDENT_FILE"
  printf '\n'
  printf 'This may be a revised diff for an incident already reviewed earlier in\n'
  printf 'this same session (the watcher re-escalating a still-open issue, or the\n'
  printf 'fix addressing your prior feedback) - assess what follows fresh, on its\n'
  printf 'own merits. A past round of this thread is not pre-approval for what has\n'
  printf 'changed since; say so explicitly if a revision does not actually address\n'
  printf 'earlier feedback.\n\n'
  if [ "$TIER" = "diff-only" ]; then
    printf 'DEGRADED TIER (diff-only): this change is too large to include the full\n'
    printf 'contents of the changed files (diff is %s bytes). Review the diff alone,\n' "$DIFF_BYTES"
    printf 'and say plainly in your report that you reviewed without full file\n'
    printf 'context - in particular, do not assert that anything is missing (an\n'
    printf 'import, a definition, a guard) when you could only be seeing a hunk.\n\n'
  fi
  printf '===== UNIFIED DIFF (%s...%s) =====\n' "$BASE" "$BRANCH"
  printf '%s\n' "$DIFF"
} >"$BODY"

INCLUDED=0
SKIPPED_GENERATED=0
SKIPPED_LARGE=0

if [ "$TIER" = "full" ]; then
  {
    printf '\n===== FULL CONTENTS OF CHANGED FILES (at %s) =====\n' "$BRANCH"
    printf 'These are the whole files, not hunks. Anything you claim is absent -\n'
    printf 'an import, a definition, a guard - must be checked against these before\n'
    printf 'you report it.\n\n'
  } >>"$BODY"

  while IFS= read -r F; do
    [ -z "$F" ] && continue
    if printf '%s' "$F" | grep -qE "$GENERATED_PATHS"; then
      SKIPPED_GENERATED=$((SKIPPED_GENERATED + 1))
      continue
    fi
    # Stop growing the message once the ceiling is reached rather than letting
    # one huge fix push the call past the provider timeout. Whatever is dropped
    # is counted and reported on stderr, never silently.
    CURRENT=$(wc -c <"$BODY" | tr -d " ")
    if [ "$CURRENT" -ge "$MAX_PROMPT_BYTES" ]; then
      SKIPPED_LARGE=$((SKIPPED_LARGE + 1))
      continue
    fi
    # git show, not cat: the diff describes the COMMITTED state, so the file
    # contents have to come from the same revision or the two disagree
    # whenever the worktree has uncommitted drift.
    if ! git show "${BRANCH}:${F}" >"$FILEBUF" 2>/dev/null; then
      printf -- '----- %s: contents unavailable (deleted in this change) -----\n' "$F" \
        >>"$BODY"
      continue
    fi
    # grep -I reports binary files as non-matching, so this is false for any
    # file git would call binary - whose bytes would only corrupt the prompt.
    if ! LC_ALL=C grep -qI . "$FILEBUF"; then
      printf -- '----- %s: contents omitted, binary -----\n' "$F" >>"$BODY"
      continue
    fi
    FBYTES=$(wc -c <"$FILEBUF" | tr -d " ")
    if [ "$FBYTES" -gt "$MAX_FILE_BYTES" ]; then
      SKIPPED_LARGE=$((SKIPPED_LARGE + 1))
      printf -- '----- %s: contents omitted, file is %s bytes -----\n' "$F" "$FBYTES" \
        >>"$BODY"
      continue
    fi
    {
      printf -- '----- BEGIN %s -----\n' "$F"
      cat "$FILEBUF"
      printf -- '\n----- END %s -----\n' "$F"
    } >>"$BODY"
    INCLUDED=$((INCLUDED + 1))
  done <<<"$(git diff --name-only "${BASE}...${BRANCH}")"
fi

MSG_BYTES=$(wc -c <"$BODY" | tr -d " ")
cat "$BODY"

# Report the tier on stderr so it lands in the agent's exec output and can be
# quoted in the Stage 4 report - a degraded review is a fact about the review,
# not an implementation detail.
echo "review-msg: tier=${TIER} diff=${DIFF_BYTES}B message=${MSG_BYTES}B files_included=${INCLUDED} skipped_generated=${SKIPPED_GENERATED} skipped_large=${SKIPPED_LARGE}" >&2
if [ "$TIER" != "full" ] || [ "$SKIPPED_LARGE" -gt 0 ]; then
  echo "review-msg: this review is DEGRADED - say so in your Stage 4 report." >&2
fi
