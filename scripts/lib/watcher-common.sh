# watcher-common.sh - shared cheap-tier watcher logic (SSH-pull/kubectl-pull
# with explicit failure detection, dedup/cooldown). Not a standalone script -
# source it, don't execute it. Depends only on bash builtins + ssh/md5sum/
# awk/grep (+ the deployed kubectl binary for kubectl_pull), already
# available everywhere this project runs.
#
# Extracted 2026-07-16 from investment-watcher.sh/svc-monitor.sh, where
# this exact logic was duplicated verbatim in both files. Written for the
# new registry-driven watcher-docker.sh.tmpl (see register-repo.sh), which
# monitors exactly one container per registered repo - the two older
# hand-written scripts are untouched and keep their own inline copies of
# this logic rather than being retrofitted onto this lib.

# ssh_pull <output_var_name> <status_var_name> <ssh_host> <remote_command>
# Sets the CALLER's <output_var_name> to the remote command's stdout+stderr
# and <status_var_name> to its exit code, via bash namerefs (requires bash
# 4.3+ - confirmed the sandbox runs 5.2). Takes output/status variable NAMES
# rather than being called as `VAR=$(ssh_pull ...)` deliberately: command
# substitution forks a subshell, so a plain `SSH_PULL_STATUS=$?` assignment
# inside the function would be invisible to the caller once that subshell
# exits - confirmed this exact bug empirically before shipping the fix.
# Callers MUST check the status var explicitly rather than assume empty
# output means "nothing novel" - a past bug in this project silently treated
# an SSH failure as a clean check, which is worse than useless (a watcher
# that can't reach its target is itself an incident).
ssh_pull() {
  local -n _ssh_pull_output="$1"
  local -n _ssh_pull_status="$2"
  local host="$3" cmd="$4"
  _ssh_pull_output=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$cmd")
  _ssh_pull_status=$?
}

# kubectl_pull <output_var_name> <status_var_name> <kubectl-arg> [<kubectl-arg> ...]
# Same nameref/status contract as ssh_pull above (see its doc comment for
# why - the same subshell-visibility bug applies here). Added 2026-07-21
# for templates/watcher-k8s.sh.tmpl.
#
# Deliberately does NOT open or manage its own SSH tunnel to the cluster -
# it runs kubectl against the kubeconfig at /sandbox/.kube/config, which
# points at 127.0.0.1:16443, the local end of the tunnel
# scripts/tunnel-keeper.sh maintains on its own cron (every 1m, independent
# of any watcher's cadence). If that tunnel is down, this call fails with
# connection-refused - a real failure the caller MUST NOT treat as "no
# news", same discipline as ssh_pull's own doc comment. Diagnosing a down
# tunnel is tunnel-keeper.sh's job (`tunnel-keeper.sh status`), not this
# watcher's - it just needs to fail loudly and retry next cycle, exactly
# like an SSH failure does today.
kubectl_pull() {
  local -n _kubectl_pull_output="$1"
  local -n _kubectl_pull_status="$2"
  shift 2
  _kubectl_pull_output=$(/sandbox/.local/bin/kubectl --kubeconfig=/sandbox/.kube/config --request-timeout=15s "$@" 2>&1)
  _kubectl_pull_status=$?
}

# incident_in_cooldown <incident_text> <dedup_file> <cooldown_seconds> <now>
# Returns 0 (true - suppress, already escalated recently) or 1 (false -
# escalate). Sets INCIDENT_SIGNATURE as a side effect for the caller to pass
# to record_escalation. Does NOT record anything itself, so a caller can
# check without committing to escalating (e.g. a dry-run).
incident_in_cooldown() {
  local incident="$1" dedup_file="$2" cooldown_seconds="$3" now="$4"
  local last_escalated normalized
  # Strip embedded timestamps before hashing - confirmed live 2026-07-31
  # against api-rag-watcher.log: the exact same rid/error/start_index
  # recurred within 91 seconds (e.g. rid=be1a7b9b... at 01:38:00 and again
  # at 01:39:00, otherwise byte-identical) but still escalated twice,
  # because the raw incident text - which embeds this timestamp - hashed
  # differently each time. The cooldown never actually engaged for this or
  # many other real recurring incidents seen in that log, despite
  # COOLDOWN_SECONDS being configured, since almost no real log-derived
  # incident text is ever byte-identical across occurrences. Matches
  # YYYY-MM-DD HH:MM:SS(,mmm|.mmm)? anywhere in the text (the app's own
  # embedded log timestamp; the watcher's own log-line timestamp is never
  # part of $incident to begin with). Verified this doesn't over-merge:
  # two genuinely different occurrences (different pod, rid, start_index)
  # still hash differently after this same normalization.
  normalized=$(echo "$incident" | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?//g')
  INCIDENT_SIGNATURE=$(echo "$normalized" | tr -s '[:space:]' ' ' | md5sum | awk '{print $1}')
  last_escalated=$(grep "^${INCIDENT_SIGNATURE} " "$dedup_file" 2>/dev/null | tail -1 | awk '{print $2}')
  if [ -n "$last_escalated" ] && [ $((now - last_escalated)) -lt "$cooldown_seconds" ]; then
    return 0
  fi
  return 1
}

# record_escalation <signature> <dedup_file> <now>
#
# Called when an incident is ACCEPTED for escalation, which since 2026-08-13 is
# when it enters the delivery queue below - not when it reaches the agent. The
# two used to be the same moment. Recording at acceptance is what stops the same
# incident being re-queued every 90s while delivery is held; the queue is what
# stops acceptance from meaning "delivered or lost", which is what it used to.
record_escalation() {
  echo "$1 $3" >>"$2"
}

# ---------------------------------------------------------------------------
# Deferred-delivery queue
# ---------------------------------------------------------------------------
#
# WHY THIS EXISTS. Two conditions stop a watcher from delivering an escalation:
# a fix sitting at stage 4 waiting on a human (sending anything would race the
# decision) and the inference backend being down (the agent has no model to run
# on). Both used to `exit 0` at the very top of the cycle, BEFORE the log pull.
# That kept incidents from being dropped - state stayed un-advanced, so the
# window was re-read later - but it also meant the repo was not checked at all.
# A 51-minute decision pause was 51 minutes of no health checking, and a
# weekend-long one would be a weekend. Nothing would have noticed the container
# dying in the meantime.
#
# The fix is to separate observing from delivering. Observation runs every cycle
# no matter what; only the `openclaw agent` call is gated. An incident found
# while delivery is blocked goes in here and is delivered when it opens. This is
# how Claude Code behaves when it is blocked on a permission prompt: background
# work keeps running and messages typed during the pause are queued for the next
# turn boundary - the pause blocks the actor, never the sensor.
#
# Consequence worth stating, since it inverts an older invariant: the watcher
# now DOES advance its state file while delivery is blocked, because the
# incident text itself is preserved here rather than being re-derived from a
# re-read of the log window. That also makes the cost bounded - the old design
# re-read one ever-growing window each time it woke up.
#
# The file is a JSON array, oldest first: [{sig, text, queued_at, reason, kind,
# attempts}, ...]. Delivery is ONE entry per cycle, oldest first, each keeping
# its own signature so the denial memo and the tracker's incident_signature mean
# exactly what they meant before this existed.
#
# `kind` is "incident" (the default) or "stranded". It exists so the delivering
# watcher can pick the right framing: wrapping a stranded-tracker-entry nag in
# "Incident detected on <container>" and the usual "if it's a real bug, prepare
# a fix on a branch" closing line would invite the agent to go fix the workload
# over a bookkeeping problem.
QUEUE_MAX_ENTRIES="${QUEUE_MAX_ENTRIES:-20}"
QUEUE_MAX_TEXT_CHARS="${QUEUE_MAX_TEXT_CHARS:-8000}"
# A delivery that keeps failing must not be retried forever. Three attempts,
# then the entry is dropped with a loud log line - a queue that silently retries
# the same undeliverable incident every 90s for a week is its own outage.
QUEUE_MAX_ATTEMPTS="${QUEUE_MAX_ATTEMPTS:-3}"

# Any unreadable/corrupt/non-array file degrades to an empty queue rather than
# failing the cycle, same discipline as the denials read in the watchers: a
# half-written file caught mid-save must not take monitoring down. Losing a
# queued incident is bad; going blind is worse.
_queue_read() {
  local f="$1" json
  [ -s "$f" ] || { printf '[]'; return 0; }
  json=$(cat "$f" 2>/dev/null)
  if printf '%s' "$json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf '%s' "$json"
  else
    printf '[]'
  fi
}

# Temp-then-rename in the same directory, so a cycle killed mid-write leaves the
# previous queue intact instead of a truncated file.
_queue_write() {
  local f="$1" json="$2" tmp
  tmp="${f}.tmp.$$"
  printf '%s\n' "$json" >"$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$f" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

# queue_depth <queue_file>
queue_depth() {
  _queue_read "$1" | jq 'length' 2>/dev/null || echo 0
}

# queue_incident <queue_file> <signature> <text> <now> [reason] [kind]
# 0 = queued, 1 = this signature is already queued, 2 = queue full, 3 = failed.
queue_incident() {
  local f="$1" sig="$2" text="$3" now="$4" reason="${5:-}" kind="${6:-incident}" json out
  json=$(_queue_read "$f")
  if printf '%s' "$json" | jq -e --arg s "$sig" 'any(.[]; .sig == $s)' >/dev/null 2>&1; then
    return 1
  fi
  if [ "$(printf '%s' "$json" | jq 'length' 2>/dev/null || echo 0)" -ge "$QUEUE_MAX_ENTRIES" ]; then
    return 2
  fi
  # Truncated, because a queued incident can carry a large block of log lines
  # and this file is read and rewritten every cycle. The head of an error burst
  # is what identifies it; the tail rarely adds anything the agent can't get
  # from the live logs itself.
  out=$(printf '%s' "$json" | jq \
    --arg s "$sig" --arg t "${text:0:$QUEUE_MAX_TEXT_CHARS}" \
    --arg r "$reason" --arg k "$kind" --argjson at "$now" \
    '. + [{sig: $s, text: $t, queued_at: $at, reason: $r, kind: $k, attempts: 0}]' 2>/dev/null) || return 3
  _queue_write "$f" "$out" || return 3
}

# queue_peek <text_var> <sig_var> <queued_at_var> <reason_var> <kind_var> <queue_file>
# Sets the CALLER's variables to the oldest entry (same nameref contract as
# ssh_pull - see its comment for why these are variable NAMES). 1 = empty queue.
queue_peek() {
  local -n _q_text="$1"
  local -n _q_sig="$2"
  local -n _q_at="$3"
  local -n _q_reason="$4"
  local -n _q_kind="$5"
  local f="$6" json
  json=$(_queue_read "$f")
  [ "$(printf '%s' "$json" | jq 'length' 2>/dev/null || echo 0)" -gt 0 ] || return 1
  _q_text=$(printf '%s' "$json" | jq -r '.[0].text // ""')
  _q_sig=$(printf '%s' "$json" | jq -r '.[0].sig // ""')
  _q_at=$(printf '%s' "$json" | jq -r '.[0].queued_at // 0')
  _q_reason=$(printf '%s' "$json" | jq -r '.[0].reason // ""')
  _q_kind=$(printf '%s' "$json" | jq -r '.[0].kind // "incident"')
}

# queue_drop <queue_file> <signature> - after a delivery that succeeded.
queue_drop() {
  local f="$1" sig="$2" json out
  json=$(_queue_read "$f")
  out=$(printf '%s' "$json" | jq --arg s "$sig" 'map(select(.sig != $s))' 2>/dev/null) || return 1
  _queue_write "$f" "$out"
}

# queue_record_attempt <queue_file> <signature>
# After a FAILED delivery. Returns 0 while retries remain, 1 once the entry has
# been given up on and dropped (the caller logs that; it is not a normal event).
queue_record_attempt() {
  local f="$1" sig="$2" json n out
  json=$(_queue_read "$f")
  n=$(printf '%s' "$json" | jq -r --arg s "$sig" \
    '((map(select(.sig == $s)) | .[0].attempts) // 0) + 1' 2>/dev/null || echo 1)
  if [ "$n" -ge "$QUEUE_MAX_ATTEMPTS" ]; then
    queue_drop "$f" "$sig"
    return 1
  fi
  out=$(printf '%s' "$json" | jq --arg s "$sig" \
    'map(if .sig == $s then .attempts = ((.attempts // 0) + 1) else . end)' 2>/dev/null) || return 0
  _queue_write "$f" "$out"
  return 0
}

# stranded_fixes <stages_file> <max_age_seconds> <now>
#
# Prints "<branch>\t<stage>\t<updated_at>" for every tracker entry that is stuck
# somewhere a human cannot act on it.
#
# WHY. The dashboard only offers Approve/Deny at stage 4 and Confirm-merged at
# stage 5, and the composer is disabled for gateway-origin sessions, so an entry
# below stage 4 has no button and no way to type at it. The protocol tells the
# agent to move the entry to stage 4 before it stops - but that is instruction,
# and on 2026-08-13 an api-rag fix with a clean APPROVED review posted a correct
# Stage 4 report, asked "Can I push and open a PR?", and left its tracker at
# stage 2. It had asked a question nobody could answer. ask-decision.sh makes
# the write happen as a side effect of asking; this is the backstop for every
# other way an entry can come to rest below 4 - a run aborted mid-protocol, a
# blocked reviewer the agent stopped on, a divergence question.
#
# An entry with no parseable updated_at counts as stranded: the documented Stage
# 2 write always sets one, so its absence means something already went wrong,
# and an entry with no timestamp can otherwise never age into view at all.
#
# Age is measured from updated_at, so an agent working normally through stages
# 2->3->4 keeps resetting the clock and is never reported. Callers should use a
# threshold far longer than a real run (a review alone takes ~7 minutes).
stranded_fixes() {
  local f="$1" max_age="$2" now="$3"
  [ -s "$f" ] || return 0
  jq -r --argjson max "$max_age" --argjson now "$now" '
    to_entries[]
    | select((.value.stage // 0) < 4)
    | . as $e
    | (($e.value.updated_at // "") | if . == "" then null
       else (try fromdateiso8601 catch null) end) as $ts
    | select($ts == null or ($now - $ts) >= $max)
    | [$e.key, (($e.value.stage // "?") | tostring), ($e.value.updated_at // "unknown")]
    | @tsv
  ' "$f" 2>/dev/null
}

# load_suppressions <suppressions_file>
#
# Assembles the operator-approved suppression patterns into one alternation
# regex, printed on stdout (empty when there is nothing usable to apply).
#
# Validates before returning, because the naive version of this FAILED OPEN in
# the worst possible way for a monitoring system. `grep -vE "$re"` is used to
# drop suppressed lines, and the call site swallows failure with `|| true`, so:
#   - a malformed pattern (say an unclosed paren) makes grep exit 2, `|| true`
#     hides it, and the filtered output is EMPTY - every real error discarded;
#   - a stray trailing `|` on any line creates an empty alternative, which
#     matches every line - again every real error discarded.
# Either way the watcher then logs "clean check, nothing novel" and the repo is
# silently unmonitored. Both confirmed by direct test 2026-08-07.
#
# So: if the assembled regex is unusable, drop it entirely and escalate
# UNFILTERED. A burst of noise someone has to re-suppress is a self-announcing
# failure; a blind watcher is not.
load_suppressions() {
  local file="$1" re rc
  [ -s "$file" ] || return 0
  re=$(grep -vE '^[[:space:]]*(#|$)' "$file" | paste -sd '|' -)
  [ -n "$re" ] || return 0
  # rc 1 = valid and does not match the empty string (the only good outcome).
  # rc 0 = matches empty, i.e. an empty alternative that would suppress all.
  # rc 2 = grep rejected the pattern.
  printf '' | grep -qE "$re" 2>/dev/null
  rc=$?
  if [ "$rc" -ne 1 ]; then
    log "WARNING: $file is unusable as a regex (grep rc=$rc$([ "$rc" -eq 0 ] && echo ' - an empty alternative, probably a trailing | on some line'));" \
        "ignoring ALL suppressions this cycle and escalating unfiltered rather than going blind. Fix the file."
    return 0
  fi
  printf '%s' "$re"
}

# apply_suppressions <regex> - filters stdin, dropping suppressed lines.
# A no-op passthrough when the regex is empty, so callers don't each need
# their own `[ -n "$re" ]` guard (one of which was missing entirely - see
# the events branch in watcher-k8s.sh.tmpl).
apply_suppressions() {
  local re="$1"
  if [ -z "$re" ]; then cat; else grep -vE "$re" || true; fi
}

# inference_backend_healthy - true when the model this repo's escalation agent
# would run on is actually serving.
#
# Exists because an escalation is a ONE-SHOT delivery. The watcher records the
# incident signature in its dedup file BEFORE invoking the agent (so a slow
# agent can't be re-escalated by the next 90s cycle), then calls
# `openclaw agent`. If that call fails because the model is unreachable, the
# signature is already recorded, the 1h cooldown suppresses the retry, and the
# incident report is simply gone - the agent session ends up holding the
# incident with an assistant message carrying stopReason=error and empty
# content, which is where the dashboard's "The agent run failed before
# producing a reply." comes from.
#
# Confirmed live: Server 4 (the inference host) was down ~15h on 2026-08-11/12
# and four repos recorded an escalation at 01:43 mid-outage whose agent run
# produced nothing. Nothing retried them when the model came back.
#
# Checked against the gateway's OWN configured endpoint rather than a value
# duplicated here, so this can never disagree with what the agent will
# actually dial (see gateway-config.sh's baseUrl, and the comment there about
# the policy and baseUrl drifting apart for a full day once).
#
# Fails CLOSED deliberately: if the endpoint can't be determined, treat the
# backend as unhealthy and defer. Deferring costs a delayed escalation;
# proceeding costs a silently discarded one.
inference_backend_healthy() {
  local base_url models_url code
  base_url=$(openclaw config get models.providers.inference.baseUrl 2>/dev/null \
    | grep -oE 'https?://[^"[:space:]]+' | head -1)
  [ -n "$base_url" ] || return 1
  models_url="${base_url%/}/models"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$models_url" 2>/dev/null || echo 000)
  [ "$code" = "200" ]
}
