#!/usr/bin/env bash
# svc-converter-pr-watcher: polls OPEN pull requests on
# example-org/svc-converter and posts a svc-converter-pr-reviewer review as a PR
# comment, once per PR per head commit. Rendered from
# templates/pr-watcher.sh.tmpl by register-repo.sh/toggle-repo.sh/
# resync-repo.sh - edit the template and re-render, don't hand-edit this
# file, it gets overwritten on the next render.
#
# New 2026-08-12. Sibling to watcher-k8s.sh/watcher-docker.sh but a
# DIFFERENT KIND of thing, and the differences are deliberate:
#
#   - It watches GitHub, not a running workload. There is no incident, no
#     cooldown, no dedup-by-signature, no suppression list. "Have I already
#     reviewed this exact commit?" replaces all of that.
#   - It is strictly ONE-WAY: GitHub -> agent -> GitHub. It never messages
#     an escalation agent, never reads or writes the stage tracker, and
#     never touches the denials file. That is what makes it immune to the
#     stage-4 approve/deny race the incident watchers need a whole gate
#     for - it shares no state with them at all. Do not "helpfully" wire
#     these together later.
#   - The AGENT never touches GitHub. This script pre-fetches everything,
#     the agent returns review text on stdout, and this script posts it.
#     Keeps the agent read-only, keeps the comment format deterministic,
#     and turns the known "agent emits tool markup as plain text" failure
#     into an empty-output retry rather than an ambiguous did-it-post.
#
# Polling, not webhooks: Server 6 has no inbound reachability, so a GitHub
# webhook cannot reach this sandbox. Reviews therefore land minutes after a
# push, not seconds. That is an accepted property, not a bug to fix.
set -uo pipefail

STATE_DIR="/sandbox/pilot-state"
REGISTRY_FILE="$STATE_DIR/registry.json"
REPO_KEY="svc-converter"
REPO="example-org/svc-converter"
AGENT_ID="svc-converter-pr-reviewer"

LOG_FILE="$STATE_DIR/svc-converter-pr-watcher.log"
# One "<pr-number> <head-sha>" line per posted review. Appended ONLY after a
# comment has actually landed on GitHub - see the post step for why that
# ordering is load-bearing.
REVIEWED_FILE="$STATE_DIR/svc-converter-pr-watcher.reviewed"
LOCK_FILE="$STATE_DIR/svc-converter-pr-watcher.lock"
WORK_DIR="$STATE_DIR/svc-converter-pr-work"

# A review is one model turn of roughly 100-400s. 1200 leaves generous room
# for a large PR without approaching the point where the run is more likely
# hung than slow. The provider itself kills any SINGLE call at
# models.providers.inference.timeoutSeconds (600), so a run that reaches this
# outer limit means multiple turns happened - which the agent doc tells it not
# to do - and is worth seeing in the log as a real anomaly.
AGENT_TIMEOUT=1200

# Size tiers. Measured 2026-08-12 against real PRs in these repos: code runs
# ~3.5 chars/token, the model's context window is 262144 tokens, and input is
# cheap relative to turns. The binding limit is NOT the window - it is the
# 600s-per-call provider timeout, since a bigger prompt means more reasoning
# and ~25 tok/s decode. These caps keep a single call comfortably inside it.
#
# Real diffs seen at the time: 9.4KB (reviewed in 99s), 187KB, 660KB. So both
# degraded tiers below are reachable in practice, not theoretical.
# Three thresholds, applied in this order - they must stay ordered
# DIFF_ONLY_ABOVE < MAX_DIFF_BYTES < MAX_PROMPT_BYTES or the tiers overlap
# incoherently (a mid-size diff getting a worse tier than a bigger one):
MAX_DIFF_BYTES=250000     # diff bigger than this -> files-only, no review at all
DIFF_ONLY_ABOVE=150000    # diff bigger than this -> review the diff, skip file contents
MAX_PROMPT_BYTES=350000   # ceiling the file-contents loop stops growing the prompt at
MAX_FILE_BYTES=60000      # per-file cap within the full tier
MAX_FINDINGS=8

# Reviews are done sequentially inside one cycle while holding the lock, so a
# repo with a backlog of open PRs (the normal state the FIRST time the flag is
# turned on) would otherwise occupy the model for hours in a single run. Cap
# the batch and let the next cycle continue; anything deferred is logged by
# name, never silently dropped.
MAX_REVIEWS_PER_CYCLE=3

# Generated/vendored paths are excluded from the full-contents section: their
# diffs are still shown, but there is nothing to verify by reading them and
# they crowd out real code. Matched against the file path with grep -E.
GENERATED_PATHS='(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|composer\.lock)$|(^|/)(node_modules|vendor|dist|build)/|\.min\.(js|css)$|\.(png|jpe?g|gif|ico|pdf|zip|tar|gz|woff2?|ttf|eot|so|dylib|dll|jar|class|pyc)$'

# shellcheck source=lib/watcher-common.sh
source "$STATE_DIR/lib/watcher-common.sh"

mkdir -p "$STATE_DIR" "$WORK_DIR"
touch "$REVIEWED_FILE"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

# --- Single-instance lock -------------------------------------------------
#
# A review takes minutes and the cron cadence is smaller than that, so
# overlapping runs are the NORMAL case, not an edge case. Without this, the
# same PR would be reviewed by several concurrent runs (the reviewed-file
# entry is only written at the very end) and each would post its own comment.
# Non-blocking: a cycle that can't get the lock just exits and lets the
# running one finish.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  # Deliberately not logged every cycle - with a 5m cadence and a 400s review
  # this fires routinely and would be pure noise. The running instance's own
  # lines already show what is happening.
  exit 0
fi

# --- Toggle gate ----------------------------------------------------------
#
# NOT `.pr_review_enabled // false`: jq's `//` treats an explicit `false` the
# same as absent, so a genuinely-false value would be coerced back to the
# default. Read the raw value, then bash-side default only a missing/null one.
# Same bug this project has hit before on monitoring_enabled - see
# watcher-k8s.sh.tmpl's own comment.
PR_REVIEW_ENABLED="false"
if [ -f "$REGISTRY_FILE" ]; then
  PR_REVIEW_ENABLED=$(jq -r --arg k "$REPO_KEY" '.[$k].pr_review_enabled' "$REGISTRY_FILE" 2>/dev/null || echo null)
  if [ "$PR_REVIEW_ENABLED" = "null" ]; then
    PR_REVIEW_ENABLED="false"
  fi
fi
if [ "$PR_REVIEW_ENABLED" != "true" ]; then
  exit 0
fi

# --- Inference gate -------------------------------------------------------
#
# Same defer-don't-drop contract as the incident watchers: exit BEFORE
# recording anything, so nothing is marked reviewed and the whole set is
# re-examined once the model is back. Cheaper here than there - a PR is a
# durable object that will still be open later, so a deferred review costs
# only latency.
if ! inference_backend_healthy; then
  log "inference backend not serving - deferring this cycle, nothing marked reviewed"
  exit 0
fi

# --- Which PRs need a review ---------------------------------------------
PR_JSON=$(gh pr list --repo "$REPO" --state open \
  --json number,headRefOid,isDraft,title,author,baseRefName,url 2>&1)
if [ $? -ne 0 ]; then
  log "gh pr list FAILED for ${REPO}, nothing marked reviewed, retrying next cycle: ${PR_JSON}"
  exit 1
fi

TOTAL=$(echo "$PR_JSON" | jq 'length' 2>/dev/null || echo 0)
if [ "$TOTAL" = "0" ]; then
  # Unlike the lock-contention exit above, this IS logged every cycle,
  # matching watcher-docker.sh/watcher-k8s.sh's own "clean check, nothing
  # novel" convention (see TOOLS.md's description of this file). Found live
  # 2026-09-07: an operator watching this log during testing could not tell
  # a healthy, actively-ticking watcher with nothing to review apart from a
  # stalled one - both looked like total silence. A cycle that found zero
  # open PRs is different from a cycle that never ran at all, and only this
  # line lets the log tell them apart.
  log "clean check, 0 open PRs on ${REPO}"
  exit 0
fi

# Drafts are skipped: an explicit "not ready for review" signal from the
# author, and reviewing one burns a full model run on a diff that is expected
# to change. They are picked up automatically once marked ready, because that
# does not change the head SHA and the PR simply becomes eligible.
#
# The already-reviewed check is a plain fixed-string line match in the loop
# below rather than a jq join against the reviewed file. Same result, and it
# keeps the "have I seen this exact commit?" test in one obvious place
# instead of splitting it across a jq expression and the loop.
CANDIDATES=$(echo "$PR_JSON" | jq -r '
  .[] | select(.isDraft | not)
      | [.number, .headRefOid, .baseRefName, .author.login, .title] | @tsv' 2>/dev/null)

if [ -z "$CANDIDATES" ]; then
  exit 0
fi

PENDING=""
while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue
  L_NUM=$(printf '%s' "$LINE" | cut -f1)
  L_SHA=$(printf '%s' "$LINE" | cut -f2)
  if grep -qxF "${L_NUM} ${L_SHA}" "$REVIEWED_FILE"; then
    continue
  fi
  PENDING="${PENDING}${LINE}"$'\n'
done <<<"$CANDIDATES"
PENDING=$(printf '%s' "$PENDING")

if [ -z "$PENDING" ]; then
  exit 0
fi

log "$(printf '%s\n' "$PENDING" | grep -c .) of ${TOTAL} open PR(s) need a review on ${REPO}"

# --- Review each pending PR ----------------------------------------------
REVIEWS_DONE=0
while IFS=$'\t' read -r PR_NUM HEAD_SHA BASE_REF PR_AUTHOR PR_TITLE; do
  [ -z "$PR_NUM" ] && continue
  if [ "$REVIEWS_DONE" -ge "$MAX_REVIEWS_PER_CYCLE" ]; then
    log "PR #${PR_NUM} (${HEAD_SHA:0:8}): deferred to a later cycle, already did ${REVIEWS_DONE} review(s) this cycle (MAX_REVIEWS_PER_CYCLE=${MAX_REVIEWS_PER_CYCLE})"
    continue
  fi
  SHORT_SHA="${HEAD_SHA:0:8}"
  MSG_FILE="$WORK_DIR/pr-${PR_NUM}-${SHORT_SHA}.msg"
  OUT_FILE="$WORK_DIR/pr-${PR_NUM}-${SHORT_SHA}.out"
  ERR_FILE="$WORK_DIR/pr-${PR_NUM}-${SHORT_SHA}.err"
  BODY_FILE="$WORK_DIR/pr-${PR_NUM}-${SHORT_SHA}.body"

  DIFF_FILE="$WORK_DIR/pr-${PR_NUM}-${SHORT_SHA}.diff"
  if ! gh pr diff "$PR_NUM" --repo "$REPO" >"$DIFF_FILE" 2>"$ERR_FILE"; then
    log "PR #${PR_NUM}: gh pr diff failed, skipping this cycle: $(head -c 300 "$ERR_FILE")"
    continue
  fi
  DIFF_BYTES=$(wc -c <"$DIFF_FILE")

  # Tier selection. Whichever tier is chosen is stated in the posted comment -
  # a silently truncated review reads as "we looked at everything" when we
  # did not, which is exactly the impression not to give a human deciding
  # whether to merge.
  TIER="full"
  if [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ]; then
    TIER="files-only"
  elif [ "$DIFF_BYTES" -gt "$DIFF_ONLY_ABOVE" ]; then
    TIER="diff-only"
  fi

  if [ "$TIER" = "files-only" ]; then
    log "PR #${PR_NUM} (${SHORT_SHA}): diff is ${DIFF_BYTES}B, over MAX_DIFF_BYTES=${MAX_DIFF_BYTES} - posting a too-large note instead of a review"
    {
      printf '## 🤖 Automated review — skipped\n\n'
      printf 'This PR'"'"'s diff is %s bytes, above the %s-byte limit for automated review, so no review was run.\n\n' "$DIFF_BYTES" "$MAX_DIFF_BYTES"
      printf 'Changed files:\n\n'
      gh pr view "$PR_NUM" --repo "$REPO" --json files --jq '.files[] | "- `\(.path)` (+\(.additions)/-\(.deletions))"' 2>/dev/null
      printf '\n<sub>%s · commit `%s` · no model run</sub>\n' "$AGENT_ID" "$SHORT_SHA"
    } >"$BODY_FILE"
    if gh pr comment "$PR_NUM" --repo "$REPO" --body-file "$BODY_FILE" >>"$LOG_FILE" 2>&1; then
      printf '%s %s\n' "$PR_NUM" "$HEAD_SHA" >>"$REVIEWED_FILE"
      log "PR #${PR_NUM} (${SHORT_SHA}): too-large note posted"
    else
      log "PR #${PR_NUM} (${SHORT_SHA}): failed to post the too-large note, NOT marking reviewed"
    fi
    continue
  fi

  # --- Build the pre-fetched message -------------------------------------
  #
  # Everything the agent needs, in one message, because turns cost minutes
  # and input does not. See templates/pr-reviewer/AGENTS.md.tmpl and
  # registry/schema.md's "PR review" section for the measurement behind this.
  PR_BODY=$(gh pr view "$PR_NUM" --repo "$REPO" --json body --jq '.body' 2>/dev/null)
  {
    printf 'Repository: %s\n' "$REPO"
    printf 'PR #%s: %s\n' "$PR_NUM" "$PR_TITLE"
    printf 'Author: %s\n' "$PR_AUTHOR"
    printf 'Base branch: %s\n' "$BASE_REF"
    printf 'Head SHA: %s\n\n' "$HEAD_SHA"
    printf 'PR description:\n%s\n\n' "${PR_BODY:-(none given)}"
    printf 'Report at most %s findings.\n\n' "$MAX_FINDINGS"
    if [ "$TIER" = "diff-only" ]; then
      printf 'DEGRADED TIER (diff-only): this PR is too large to include the full\n'
      printf 'contents of the changed files. Review the diff alone, and say plainly in\n'
      printf 'your report that you reviewed without full file context.\n\n'
    fi
    printf '===== UNIFIED DIFF =====\n'
    cat "$DIFF_FILE"
  } >"$MSG_FILE"

  INCLUDED=0
  SKIPPED_GENERATED=0
  SKIPPED_LARGE=0
  if [ "$TIER" = "full" ]; then
    printf '\n===== FULL CONTENTS OF CHANGED FILES (at head %s) =====\n' "$HEAD_SHA" >>"$MSG_FILE"
    CHANGED_FILES=$(gh pr view "$PR_NUM" --repo "$REPO" --json files --jq '.files[].path' 2>/dev/null)
    while IFS= read -r F; do
      [ -z "$F" ] && continue
      if printf '%s' "$F" | grep -qE "$GENERATED_PATHS"; then
        SKIPPED_GENERATED=$((SKIPPED_GENERATED + 1))
        continue
      fi
      # Stop growing the prompt once the ceiling is reached rather than
      # letting one huge PR push a single call past the 600s provider
      # timeout. Whatever is dropped is counted and reported below, never
      # silently.
      CURRENT=$(wc -c <"$MSG_FILE")
      if [ "$CURRENT" -ge "$MAX_PROMPT_BYTES" ]; then
        SKIPPED_LARGE=$((SKIPPED_LARGE + 1))
        continue
      fi
      CONTENT=$(gh api "repos/${REPO}/contents/${F}?ref=${HEAD_SHA}" --jq .content 2>/dev/null | base64 -d 2>/dev/null)
      if [ -z "$CONTENT" ]; then
        # Deleted, binary, or over GitHub's own contents-API size limit.
        printf -- '----- %s: contents unavailable (deleted, binary, or too large) -----\n' "$F" >>"$MSG_FILE"
        continue
      fi
      if [ "${#CONTENT}" -gt "$MAX_FILE_BYTES" ]; then
        SKIPPED_LARGE=$((SKIPPED_LARGE + 1))
        printf -- '----- %s: contents omitted, file is %s bytes -----\n' "$F" "${#CONTENT}" >>"$MSG_FILE"
        continue
      fi
      printf -- '----- BEGIN %s -----\n%s\n----- END %s -----\n' "$F" "$CONTENT" "$F" >>"$MSG_FILE"
      INCLUDED=$((INCLUDED + 1))
    done <<<"$CHANGED_FILES"
  fi

  MSG_BYTES=$(wc -c <"$MSG_FILE")
  log "PR #${PR_NUM} (${SHORT_SHA}) by ${PR_AUTHOR}: tier=${TIER} diff=${DIFF_BYTES}B prompt=${MSG_BYTES}B files_included=${INCLUDED} skipped_generated=${SKIPPED_GENERATED} skipped_large=${SKIPPED_LARGE} - invoking ${AGENT_ID}"

  # --- Run the reviewer ---------------------------------------------------
  #
  # Session key carries the head SHA, so a new push is a FRESH session: it is
  # a different diff, and inheriting the previous review's conclusions is the
  # failure mode to avoid.
  #
  # stdout is the review; stderr is gateway/plugin banner noise. Verified
  # 2026-08-12 that openclaw agent puts ONLY the agent's final text on stdout,
  # which is what makes posting it verbatim safe. Do NOT merge them with 2>&1
  # here - the existing escalation-side docs do, which is why they warn about
  # "banner-only" output.
  SESSION_KEY="agent:${AGENT_ID}:pr-${PR_NUM}-${SHORT_SHA}"
  ATTEMPT=1
  REVIEW=""
  while [ "$ATTEMPT" -le 2 ]; do
    STARTED=$(date +%s)
    # --message-file, not -m "$(cat ...)": the full tier can build a prompt of
    # a few hundred KB, and passing that through argv puts it against ARG_MAX
    # (2097152 here) for no reason. The file path also keeps the command line
    # readable in the process list and in this log.
    timeout $((AGENT_TIMEOUT + 120)) openclaw agent --agent "$AGENT_ID" \
      --session-key "${SESSION_KEY}-a${ATTEMPT}" --timeout "$AGENT_TIMEOUT" \
      --message-file "$MSG_FILE" >"$OUT_FILE" 2>"$ERR_FILE"
    RC=$?
    ELAPSED=$(( $(date +%s) - STARTED ))
    REVIEW=$(cat "$OUT_FILE" 2>/dev/null)
    if [ -n "$REVIEW" ]; then
      log "PR #${PR_NUM} (${SHORT_SHA}): review returned in ${ELAPSED}s (attempt ${ATTEMPT}, rc=${RC}, ${#REVIEW} chars)"
      break
    fi
    # Empty stdout is the known "agent wrote tool markup as plain text" /
    # timed-out-turn failure. It self-recovers on a resend often enough to be
    # worth exactly one retry - under a DIFFERENT session key, because
    # re-invoking a busy key aborts the original run rather than retrying it.
    log "PR #${PR_NUM} (${SHORT_SHA}): attempt ${ATTEMPT} produced NO output after ${ELAPSED}s (rc=${RC}): $(tail -c 300 "$ERR_FILE" | tr '\n' ' ')"
    ATTEMPT=$((ATTEMPT + 1))
  done

  # Counted against the per-cycle cap whether or not the review can be
  # posted: the cap exists to bound model time, and a failed attempt spent
  # that time just the same.
  REVIEWS_DONE=$((REVIEWS_DONE + 1))

  if [ -z "$REVIEW" ]; then
    # Nothing recorded, so the next cycle tries this same commit again. That
    # is the intended direction to fail in: a repeated attempt costs tokens,
    # a skipped one silently loses the review entirely.
    log "PR #${PR_NUM} (${SHORT_SHA}): NO review after 2 attempts, nothing posted, NOT marking reviewed - will retry next cycle"
    continue
  fi

  # --- Post it ------------------------------------------------------------
  {
    printf '## 🤖 Automated review\n\n'
    if [ "$TIER" = "diff-only" ]; then
      printf '> Reviewed from the diff only — this PR was too large to include full file contents.\n\n'
    fi
    printf '%s\n' "$REVIEW"
    printf '\n---\n'
    printf '<sub>%s · commit `%s` · correctness-only, findings are labelled CONFIRMED or PLAUSIBLE and may be wrong · a human decides what to do with them</sub>\n' \
      "$AGENT_ID" "$SHORT_SHA"
  } >"$BODY_FILE"

  if gh pr comment "$PR_NUM" --repo "$REPO" --body-file "$BODY_FILE" >>"$LOG_FILE" 2>&1; then
    # ONLY now. Recording before posting would mean a crash between the two
    # loses the review permanently and silently; recording after means the
    # worst case is a duplicate comment, which is visible and cheap to
    # delete. Deliberately asymmetric.
    printf '%s %s\n' "$PR_NUM" "$HEAD_SHA" >>"$REVIEWED_FILE"
    log "PR #${PR_NUM} (${SHORT_SHA}): review posted"
  else
    log "PR #${PR_NUM} (${SHORT_SHA}): gh pr comment FAILED, NOT marking reviewed - will retry next cycle"
  fi
done <<<"$PENDING"

# Keep the work dir from growing without bound. Prompts/outputs are kept for
# a week purely for debugging a bad review after the fact.
find "$WORK_DIR" -type f -mtime +7 -delete 2>/dev/null || true
