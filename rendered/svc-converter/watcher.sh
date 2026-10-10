#!/usr/bin/env bash
# svc-converter-watcher: cheap-tier cron watcher for svc-converter-dev
# (deployment) in namespace dev on k3s cluster
# server2. Rendered from templates/watcher-k8s.sh.tmpl by
# register-repo.sh - edit the template and re-render
# (register-repo.sh/toggle-repo.sh/resync-repo.sh), don't hand-edit this
# file directly, it gets overwritten on the next render.
#
# New 2026-07-21, sibling to templates/watcher-docker.sh.tmpl for
# runtime.type=="k8s" registry entries - see registry/schema.md for the
# runtime tagged union both templates render from, and
# docs/k8s-migration-architecture.md for the full access-design rationale.
#
# This is the live template: all 7 registered repos are runtime.type=="k8s"
# (`--runtime docker` is retired - see register-repo.sh's header). The
# docker sibling is kept because the two share every piece of reasoning in
# the gate/queue/delivery sections and drift between them is the thing to
# guard against, not because anything currently renders from it.
set -uo pipefail

STATE_DIR="/sandbox/pilot-state"
REGISTRY_FILE="$STATE_DIR/registry.json"
REPO_KEY="svc-converter"

STATE_FILE="$STATE_DIR/svc-converter-watcher.state"
PODSTATE_FILE="$STATE_DIR/svc-converter-watcher.podstate"
DEDUP_FILE="$STATE_DIR/svc-converter-watcher.dedup"
LOG_FILE="$STATE_DIR/svc-converter-watcher.log"
SUPPRESSIONS_FILE="$STATE_DIR/svc-converter-watcher-suppressions.txt"
FAILSTREAK_FILE="$STATE_DIR/svc-converter-watcher.failstreak"
STAGES_FILE="$STATE_DIR/svc-converter-escalation-stages.json"
# Written ONLY by the dashboard (routes/ops.js on a Deny click), read-only
# here - deliberately a separate file from the tracker so there is exactly
# one writer each and no read-modify-write race between the dashboard and
# the agent. See the stage-4 gate below and the prior-denial memo further
# down for the two things this watcher uses it for. Same as
# watcher-docker.sh.tmpl, keep both in sync.
DENIALS_FILE="$STATE_DIR/svc-converter-escalation-denials.json"
PAUSED_FILE="$STATE_DIR/svc-converter-watcher.pausedsince"
# Separate from PAUSED_FILE on purpose: the two pauses have different causes
# and different exits, and collapsing them would make "why is nothing being
# checked" ambiguous in exactly the situation you need it to be clear.
MODEL_PAUSED_FILE="$STATE_DIR/svc-converter-watcher.modelpausedsince"
# Incidents observed while delivery was blocked - see the queue section in
# watcher-common.sh for the whole rationale. Same as watcher-docker.sh.tmpl.
QUEUE_FILE="$STATE_DIR/svc-converter-watcher.queue"
# Last stranded-tracker-entry nag. Its own file: a stranded entry is not an
# incident and must not consume the incident dedup cooldown for a real one.
STRANDED_NAG_FILE="$STATE_DIR/svc-converter-watcher.strandednag"
# 45 minutes is far longer than a real run of the protocol (the reviewer
# call, the slowest step, takes ~7 minutes) and short enough that a human
# notices the same working day.
STRANDED_AFTER_SECONDS=2700
STRANDED_NAG_COOLDOWN=21600

K8S_CLUSTER="server2"
K8S_NAMESPACE="dev"
K8S_LABEL_SELECTOR="app=svc-converter-dev"
K8S_WORKLOAD_NAME="svc-converter-dev"
COOLDOWN_SECONDS=3600
# After this many consecutive kubectl failures, escalate once (its own
# cooldown, same dedup mechanism as a real incident) so a dead tunnel/API
# becomes a reported incident instead of silent, indefinite blindness. Not
# configurable per-repo today - a fixed default is fine, this is about
# noticing the monitoring path itself is broken, not tuning sensitivity.
BLIND_MONITORING_THRESHOLD=5

AGENT_ID="svc-converter-escalation"
SESSION_KEY="agent:svc-converter-escalation:svc-converter-watcher"

# shellcheck source=lib/watcher-common.sh
source "$STATE_DIR/lib/watcher-common.sh"

mkdir -p "$STATE_DIR"
touch "$DEDUP_FILE"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

# Monitoring toggle - identical pattern to watcher-docker.sh.tmpl. NOT
# `.monitoring_enabled // true` - jq's `//` treats an explicit `false` as
# absent too, not just null/missing, silently coercing a real false back to
# true (confirmed empirically elsewhere in this project - see
# watcher-docker.sh.tmpl's own comment on this exact bug). Read the raw
# value, then only bash-side default a genuinely missing/null field.
if [ -f "$REGISTRY_FILE" ]; then
  MONITORING_ENABLED=$(jq -r --arg k "$REPO_KEY" '.[$k].monitoring_enabled' "$REGISTRY_FILE" 2>/dev/null || echo null)
  if [ "$MONITORING_ENABLED" = "null" ]; then
    MONITORING_ENABLED="true"
  fi
  if [ "$MONITORING_ENABLED" = "false" ]; then
    log "monitoring disabled for ${REPO_KEY} in registry, skipping this cycle"
    exit 0
  fi
fi

# Stage-4 gate - if any tracker entry is currently at stage 4, the
# escalation agent already explicitly said "STOP, wait for a reply" (see
# templates/agent-writecapable/AGENTS.md.tmpl's own Stage 4 text) and is
# sitting in $SESSION_KEY waiting on a human's approve/deny decision from
# the dashboard. Sending it a new automated message here - even about a
# genuinely different incident, and even the blind-monitoring escalation
# further below - would land in the middle of that pause and race
# whatever the human is about to click. Added 2026-08-05 after exactly
# this collision risk was flagged during a live incident review. Same fix
# as watcher-docker.sh.tmpl, keep both in sync.
#
# It gates DELIVERY ONLY, as of 2026-08-13. It used to exit the whole cycle
# here, before the kubectl pull, so a repo awaiting a decision was not
# checked at all: a real 51-minute pause was 51 minutes in which these pods
# could have crash-looped unnoticed, and a weekend-long pause would be a
# weekend of it - a strictly larger hole than the collision this gate
# closes. Everything below still runs; the only thing $DELIVERY_BLOCKED
# stops is the `openclaw agent` call, and anything found meanwhile goes
# into $QUEUE_FILE for delivery when the gate opens.
#
# The state file therefore DOES advance during a pause now, replacing the
# old "don't optimise this away" warning: the incident text is preserved in
# the queue rather than re-derived by re-reading an ever-growing log window.
# Still deferred, not dropped - deferred as recorded objects instead of as
# an un-read time range.
#
# A DENIED fix no longer holds the gate (2026-08-05). Deny used to leave its
# entry sitting at stage 4 forever - the agent is told to discard and does,
# but nothing guaranteed the tracker entry was actually gone, and until it
# was, this gate paused the repo indefinitely. Releasing on the dashboard's
# own denial record instead of on the agent having tidied up makes the
# unfreeze deterministic: the one thing that must happen for monitoring to
# resume no longer depends on an agent turn succeeding.
#
# Read once here, reused by the prior-denial memo further down. A missing,
# empty or corrupt denials file degrades to "{}" (no denials) rather than
# failing the cycle - the dashboard is the only writer, but a half-written
# file caught mid-save shouldn't take monitoring down with it.
DENIALS_JSON='{}'
if [ -s "$DENIALS_FILE" ]; then
  DENIALS_JSON=$(cat "$DENIALS_FILE" 2>/dev/null || echo '{}')
  echo "$DENIALS_JSON" | jq -e . >/dev/null 2>&1 || DENIALS_JSON='{}'
fi

# A denial only releases the gate for the incident it was actually given
# for. Denials are keyed by BRANCH, and branch names come from the incident
# topic, so a later unrelated bug in the same area reuses the same
# fix/<slug> and used to inherit the old verdict - the gate then stayed
# open for a fix nobody had ruled on. Observed on api-rag 2026-08-12 (sig
# 90135be7 denied, sig 76a12eb6 escalated onto the same branch 35 minutes
# later). The signature is what distinguishes them, and it is the same
# normalized hash used everywhere else in this script.
#
# Unknown signature on either side falls back to the old branch-only rule:
# denials written before 2026-08-05 carry none, and treating unknown as
# "different" would re-freeze monitoring on a fix that really was denied -
# the exact indefinite pause this gate's denial-release exists to prevent.
# Keep this predicate identical to applyDenials() in the dashboard's
# routes/ops.js; the two answer the same question about the same files.
GATE_HELD=0
if [ -f "$STAGES_FILE" ] && jq -e --argjson d "$DENIALS_JSON" \
    'to_entries | any(
       .value.stage == 4
       and (
         ($d[.key]) as $den
         | ($den | not)
           or ( (($den.incident_signature // "") != "")
                and (((.value.incident_signature) // "") != "")
                and ($den.incident_signature != (.value.incident_signature)) )
       )
     )' \
    "$STAGES_FILE" >/dev/null 2>&1; then
  GATE_HELD=1
fi

# $DELIVERY_BLOCKED gates ONLY the `openclaw agent` calls in this script
# (both the incident delivery at the bottom and the blind-monitoring
# escalation). $DELIVERY_BLOCK_REASON is recorded on each queued incident so
# the agent is later told why its report is arriving late.
DELIVERY_BLOCKED=0
DELIVERY_BLOCK_REASON=""

if [ "$GATE_HELD" -eq 1 ]; then
  DELIVERY_BLOCKED=1
  DELIVERY_BLOCK_REASON="a fix was at stage 4 awaiting a human approve/deny"
  # Rate-limited so a long pause doesn't bury the log in one line per cycle
  # (a real 2h pause produced ~80 identical lines before this was added, and
  # a weekend-long one would produce thousands): log on the transition into
  # the pause, then at most hourly, with the elapsed time spelled out so its
  # cost is visible rather than implied.
  PAUSED_SINCE=$(cut -d' ' -f1 "$PAUSED_FILE" 2>/dev/null || echo "")
  LAST_PAUSE_LOG=$(cut -d' ' -f2 "$PAUSED_FILE" 2>/dev/null || echo "")
  PAUSE_NOW=$(date +%s)
  if [ -z "$PAUSED_SINCE" ]; then
    PAUSED_SINCE="$PAUSE_NOW"
    log "escalation delivery PAUSED - a fix is at stage 4 awaiting a human approve/deny; not touching ${SESSION_KEY}. Health checking CONTINUES every cycle; anything found is queued and delivered when this clears."
    echo "$PAUSED_SINCE $PAUSE_NOW" >"$PAUSED_FILE"
  elif [ -z "$LAST_PAUSE_LOG" ] || [ $((PAUSE_NOW - LAST_PAUSE_LOG)) -ge 3600 ]; then
    log "escalation delivery still paused after $(( (PAUSE_NOW - PAUSED_SINCE) / 60 ))m - ${REPO_KEY} is still being checked every cycle, $(queue_depth "$QUEUE_FILE") incident(s) queued for delivery"
    echo "$PAUSED_SINCE $PAUSE_NOW" >"$PAUSED_FILE"
  fi
elif [ -f "$PAUSED_FILE" ]; then
  RESUMED_AFTER=$(( $(date +%s) - $(cut -d' ' -f1 "$PAUSED_FILE" 2>/dev/null || date +%s) ))
  log "escalation delivery RESUMED after $(( RESUMED_AFTER / 60 ))m paused - $(queue_depth "$QUEUE_FILE") queued incident(s) to deliver, oldest first, one per cycle"
  rm -f "$PAUSED_FILE"
fi

# Inference-backend gate - same defer-don't-drop contract as the stage-4 gate
# above, and placed here for the same load-bearing reason: it exits BEFORE the
# kubectl pull, so $STATE_FILE is left un-advanced and the whole window is
# re-read on the first cycle after the model comes back. That is what makes
# recovery automatic - nothing has to remember to replay anything.
#
# Without this, an outage burns incidents rather than deferring them: the
# escalation is recorded in the dedup file, `openclaw agent` then fails against
# the dead endpoint, and the 1h cooldown suppresses the retry. Verified live
# against the 2026-08-11/12 Server 4 outage - four repos recorded an escalation
# at 01:43 whose agent run produced nothing, and nothing retried them.
#
# Deliberately NOT a reason to escalate on its own. A dead shared inference host
# is not this repo's incident, every watcher would report the same thing at
# once, and the escalation could not be delivered anyway - the agent needs the
# very model that is down. The dashboard's own model-health banner is the right
# surface for it, and it already works.
#
# Blocks delivery only, as of 2026-08-13, for the same reason as the gate
# above: a 15-hour model outage (Server 4, 2026-08-11) is not a period in
# which the workload is any less likely to break.
if ! inference_backend_healthy; then
  DELIVERY_BLOCKED=1
  DELIVERY_BLOCK_REASON="the inference backend was not serving, so nothing could be delivered to the agent"
  MODEL_PAUSE_NOW=$(date +%s)
  MODEL_PAUSED_SINCE=$(cut -d' ' -f1 "$MODEL_PAUSED_FILE" 2>/dev/null || echo "")
  MODEL_LAST_LOG=$(cut -d' ' -f2 "$MODEL_PAUSED_FILE" 2>/dev/null || echo "")
  if [ -z "$MODEL_PAUSED_SINCE" ]; then
    log "escalation delivery DEFERRED - the inference backend is not serving. Health checking CONTINUES every cycle; anything found is queued and delivered when the model returns."
    echo "$MODEL_PAUSE_NOW $MODEL_PAUSE_NOW" >"$MODEL_PAUSED_FILE"
  elif [ -z "$MODEL_LAST_LOG" ] || [ $((MODEL_PAUSE_NOW - MODEL_LAST_LOG)) -ge 3600 ]; then
    log "inference backend still down after $(( (MODEL_PAUSE_NOW - MODEL_PAUSED_SINCE) / 60 ))m - ${REPO_KEY} is still being checked every cycle, $(queue_depth "$QUEUE_FILE") incident(s) queued for delivery"
    echo "$MODEL_PAUSED_SINCE $MODEL_PAUSE_NOW" >"$MODEL_PAUSED_FILE"
  fi
elif [ -f "$MODEL_PAUSED_FILE" ]; then
  MODEL_DOWN_FOR=$(( $(date +%s) - $(cut -d' ' -f1 "$MODEL_PAUSED_FILE" 2>/dev/null || date +%s) ))
  log "inference backend RECOVERED after $(( MODEL_DOWN_FOR / 60 ))m - $(queue_depth "$QUEUE_FILE") queued incident(s) to deliver, oldest first, one per cycle"
  rm -f "$MODEL_PAUSED_FILE"
fi

ERROR_PATTERN='ERROR|CRITICAL|Traceback|Exception'
# Validated, and fails CLOSED on a bad file - see load_suppressions in
# watcher-common.sh for what the unvalidated version did.
EXTRA_SUPPRESS=$(load_suppressions "$SUPPRESSIONS_FILE")

NOW=$(date +%s)
LAST_CHECK=$(cat "$STATE_FILE" 2>/dev/null || echo "$((NOW - 60))")
SINCE_TIME=$(date -u -d "@${LAST_CHECK}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$LAST_CHECK" +%Y-%m-%dT%H:%M:%SZ)

# Everything that turns a successful pod pull into $INCIDENT text, in a
# function purely so the pull-failure branch above can skip it without the
# whole body needing to be re-indented into an `else`. Assigns the same
# globals it always did - nothing here is `local`, deliberately.
detect_incident() {
  # jq does all pod-state extraction (project convention: prefer jq over
  # fragile jsonpath chains, the sandbox always has it available). One line
  # per pod: "<uid> <phase> <restartCount-summed-across-containers>".
  POD_LINES=$(echo "$PODS_JSON" | jq -r '.items[] | [.metadata.uid, .status.phase, ([.status.containerStatuses[]?.restartCount] | add // 0)] | @tsv')

  INCIDENT=""
  if [ -z "$POD_LINES" ]; then
    INCIDENT="No pods currently match selector '${K8S_LABEL_SELECTOR}' in namespace '${K8S_NAMESPACE}' - ${K8S_WORKLOAD_NAME} may be scaled to zero, deleted, or its label_selector may no longer match (see registry/schema.md's note on this being an unverified default)"
  fi

  NOT_RUNNING=$(echo "$PODS_JSON" | jq -r '.items[] | select(.status.phase != "Running") | "\(.metadata.name): \(.status.phase)"')
  if [ -n "$NOT_RUNNING" ]; then
    INCIDENT="${INCIDENT}
Pod(s) not in Running phase:
${NOT_RUNNING}"
  fi

  # Waiting-state reasons (CrashLoopBackOff, ImagePullBackOff) - real,
  # Kubernetes-native signal Docker's plain `inspect` never had.
  BAD_WAITING=$(echo "$PODS_JSON" | jq -r '.items[] as $p | $p.status.containerStatuses[]? | select(.state.waiting.reason != null and (.state.waiting.reason | test("CrashLoopBackOff|ImagePullBackOff|ErrImagePull"))) | "\($p.metadata.name): \(.state.waiting.reason)"')
  if [ -n "$BAD_WAITING" ]; then
    INCIDENT="${INCIDENT}
Container(s) in a bad waiting state:
${BAD_WAITING}"
  fi

  # Last-termination OOMKilled - another signal Docker's plain `inspect`
  # never surfaced directly.
  OOM=$(echo "$PODS_JSON" | jq -r '.items[] as $p | $p.status.containerStatuses[]? | select(.lastState.terminated.reason == "OOMKilled") | $p.metadata.name' | sort -u)
  if [ -n "$OOM" ]; then
    INCIDENT="${INCIDENT}
Pod(s) with a container OOMKilled at last termination: $(echo "$OOM" | tr '\n' ' ')"
  fi

  # Restart-count tracking, per-pod-UID. Pods are cattle: a pod disappearing
  # because of a normal rollout is NOT itself an incident (its UID just stops
  # appearing in POD_LINES and silently drops out of the state file over
  # time - no explicit pruning needed). Only a restart *within* a
  # still-existing pod's lifetime is real signal.
  LAST_PODSTATE=$(cat "$PODSTATE_FILE" 2>/dev/null || echo "")
  RESTART_INCIDENT=""
  while IFS=$'\t' read -r uid phase restarts; do
    [ -z "$uid" ] && continue
    last_restarts=$(echo "$LAST_PODSTATE" | awk -v u="$uid" '$1==u {print $2}')
    if [ -n "$last_restarts" ] && [ "$restarts" != "$last_restarts" ]; then
      RESTART_INCIDENT="${RESTART_INCIDENT}
pod ${uid}: restartCount ${last_restarts} -> ${restarts}"
    fi
  done <<<"$POD_LINES"
  if [ -n "$RESTART_INCIDENT" ]; then
    INCIDENT="${INCIDENT}
Container restart count(s) changed:${RESTART_INCIDENT}"
  fi
  echo "$POD_LINES" | awk '{print $1, $3}' >"$PODSTATE_FILE"

  # Logs + events only fetched when there are actually pods to check - skips
  # both cleanly when the "no pods" incident above already fired, same as
  # how watcher-docker.sh.tmpl never bothers pulling logs from a container
  # that doesn't exist.
  [ -n "$POD_LINES" ] || return 0

  kubectl_pull LOG_TEXT LOG_STATUS logs -n "$K8S_NAMESPACE" -l "$K8S_LABEL_SELECTOR" --all-containers=true --prefix --since-time="$SINCE_TIME"
  if [ "$LOG_STATUS" -eq 0 ]; then
    NOVEL=$(echo "$LOG_TEXT" | grep -E "$ERROR_PATTERN" | apply_suppressions "$EXTRA_SUPPRESS")
    if [ -n "$NOVEL" ]; then
      INCIDENT="${INCIDENT}
Novel error-level lines in ${K8S_WORKLOAD_NAME}:
${NOVEL}"
    fi
  else
    # Not fatal on its own (pod-state checks above already ran and already
    # advanced state) - but worth logging loudly, missing logs for a
    # window is a real gap even if it doesn't block the rest of this cycle.
    log "kubectl logs FAILED (exit=${LOG_STATUS}) this cycle - logs are missing for this window, but pod-state checks above still ran: ${LOG_TEXT}"
  fi

  kubectl_pull EVENTS_JSON EVENTS_STATUS get events -n "$K8S_NAMESPACE" --field-selector type=Warning -o json
  if [ "$EVENTS_STATUS" -eq 0 ]; then
    # apply_suppressions here is NOT redundant with the log branch above.
    # This query is namespace-wide with no label selector, so it picks up other
    # teams' pods, which is the main thing suppressions get approved for - and
    # until 2026-08-07 this branch never filtered at all, leaving two
    # human-approved suppressions completely inert. Both were written in this
    # branch's own "<name>: <reason> - <message>" format, which is how the gap
    # was spotted.
    #
    # The pod-state incidents above are deliberately NOT filtered: those are
    # label-selected to this repo's own workload, so another team's noise can
    # never reach them, and silencing our own pod's restarts is not something
    # a suppression line should be able to do.
    NOVEL_EVENTS=$(echo "$EVENTS_JSON" | jq -r --arg since "$SINCE_TIME" '.items[] | select((.lastTimestamp // .eventTime // "") >= $since) | "\(.involvedObject.name): \(.reason) - \(.message)"' 2>/dev/null | apply_suppressions "$EXTRA_SUPPRESS")
    if [ -n "$NOVEL_EVENTS" ]; then
      INCIDENT="${INCIDENT}
Novel Warning event(s):
${NOVEL_EVENTS}"
    fi
  fi
}

# Pod list + phase + per-container restart counts, one JSON call. Checked
# BEFORE logs deliberately: zero matching pods produces empty-but-
# successful JSON here (a real, meaningful incident - workload scaled to
# zero, deleted, or the label changed), vs. `kubectl logs -l <selector>`
# on zero matches, which errors outright - this ordering makes "no pods"
# its own clear incident rather than a confusing logs-command failure.
kubectl_pull PODS_JSON PODS_STATUS get pods -n "$K8S_NAMESPACE" -l "$K8S_LABEL_SELECTOR" -o json

# A failed pull no longer exits the script - it skips detection and leaves
# the state file un-advanced (so the next run retries from the same point),
# but falls through to the queue and delivery below. Whether kubectl can
# reach the cluster has nothing to do with whether the agent can be reached,
# and exiting here would have made a dead tunnel a second, silent reason for
# already-queued incidents never to arrive.
PULL_FAILED=0
INCIDENT=""
if [ "$PODS_STATUS" -ne 0 ]; then
  PULL_FAILED=1
  STREAK=$(( $(cat "$FAILSTREAK_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$STREAK" >"$FAILSTREAK_FILE"
  log "kubectl get pods FAILED (exit=${PODS_STATUS}, streak=${STREAK}) - cannot verify ${K8S_WORKLOAD_NAME} health this cycle, NOT advancing state so next run retries from the same point: ${PODS_JSON}"
  if [ "$STREAK" -ge "$BLIND_MONITORING_THRESHOLD" ]; then
    # The live streak count is deliberately NOT in this text. It is hashed
    # for dedup, so a number that grows every cycle would give every cycle a
    # fresh signature and re-escalate blindness every 90s forever - the same
    # normalization trap incident_in_cooldown documents for embedded log
    # timestamps. The threshold is a constant; the real count is in the log
    # line above.
    #
    # The session_key trailer that used to be pasted in here is gone: this
    # now goes through the same PROMPT construction as any other incident,
    # which appends the session_key and incident_signature itself.
    INCIDENT="Monitoring itself is blind: kubectl has failed at least ${BLIND_MONITORING_THRESHOLD} consecutive cycles for ${K8S_WORKLOAD_NAME} in namespace ${K8S_NAMESPACE} (cluster ${K8S_CLUSTER}). This does NOT necessarily mean the workload itself is down - check the SSH tunnel first (tunnel-keeper.sh status) and the RBAC credential before assuming a workload-side problem. This is a monitoring-path failure: do not prepare a fix in this repo for it unless you establish that the repo is genuinely the cause."
  fi
else
  echo 0 >"$FAILSTREAK_FILE"

  # Only advance state once kubectl actually reached the cluster successfully.
  echo "$NOW" >"$STATE_FILE"

  detect_incident
fi

if [ "$PULL_FAILED" -eq 1 ]; then
  : # already logged; fall through to the queue and delivery below
elif [ -z "$INCIDENT" ]; then
  log "clean check, nothing novel"
elif incident_in_cooldown "$INCIDENT" "$DEDUP_FILE" "$COOLDOWN_SECONDS" "$NOW"; then
  log "novel incident found but in cooldown (sig ${INCIDENT_SIGNATURE}), suppressing: ${INCIDENT}"
else
  # Accepted for escalation. Recorded in the dedup file HERE, at acceptance,
  # so a still-queued incident isn't re-accepted every 90s - and queued
  # rather than sent, so acceptance no longer means "delivered or lost".
  record_escalation "$INCIDENT_SIGNATURE" "$DEDUP_FILE" "$NOW"
  queue_incident "$QUEUE_FILE" "$INCIDENT_SIGNATURE" "$INCIDENT" "$NOW" "$DELIVERY_BLOCK_REASON"
  case $? in
    0) log "ESCALATING (sig ${INCIDENT_SIGNATURE}): ${INCIDENT}" ;;
    1) log "incident already queued for delivery (sig ${INCIDENT_SIGNATURE}), not queued twice" ;;
    2) log "WARNING: DROPPED an incident (sig ${INCIDENT_SIGNATURE}) - the delivery queue is full at ${QUEUE_MAX_ENTRIES} entries. Delivery has been blocked long enough to overflow it; the underlying reason needs attention, not this watcher. Dropped: ${INCIDENT}" ;;
    *) log "WARNING: could not queue incident (sig ${INCIDENT_SIGNATURE}) - the queue file could not be written. Incident text: ${INCIDENT}" ;;
  esac
fi

# Stranded-tracker-entry backstop. An entry resting below stage 4 has no
# button in the dashboard and no composer to type at, so whatever it is
# waiting for can never arrive - see stranded_fixes() in watcher-common.sh
# for the live case this was built from. Treated as a deliverable incident
# rather than a log line so it reaches the one party that can fix it, and
# routed through the same queue so it obeys the same collision gate. Same
# as watcher-docker.sh.tmpl, keep both in sync.
if [ -f "$STAGES_FILE" ]; then
  STRANDED=$(stranded_fixes "$STAGES_FILE" "$STRANDED_AFTER_SECONDS" "$NOW")
  LAST_NAG=$(cat "$STRANDED_NAG_FILE" 2>/dev/null || echo 0)
  case "$LAST_NAG" in ''|*[!0-9]*) LAST_NAG=0 ;; esac
  if [ -n "$STRANDED" ] && [ $((NOW - LAST_NAG)) -ge "$STRANDED_NAG_COOLDOWN" ]; then
    # No elapsed time in this text: it is hashed for dedup, and a value that
    # changes every cycle would defeat that (the same normalization lesson
    # incident_in_cooldown records for embedded log timestamps).
    STRANDED_INCIDENT="Your stage tracker has an entry that has come to rest below stage 4:

${STRANDED}

(branch, stage, last updated - one line each)

Nobody can act on it there. The dashboard shows Approve/Deny only at stage 4
and Confirm-merged only at stage 5, and the composer is disabled for this
session, so an entry below stage 4 has no button and no way for a human to
reply to it. If you stopped to ask a question with the entry at this stage,
your question was never received.

Re-read the entry and take exactly one of these:
- The fix is prepared, verified and reviewed, and you are waiting for
  permission to push: ask through /sandbox/pilot-state/lib/ask-decision.sh,
  which is what moves the entry to stage 4 and puts it in front of a human.
- There is nothing to land (benign, not this repo's problem, already fixed
  upstream, no longer reproduces): say so and remove the entry, per Stage 1.
- You stopped mid-protocol and the work is still valid: resume it.
Do not leave it where it is."
    if ! incident_in_cooldown "$STRANDED_INCIDENT" "$DEDUP_FILE" "$COOLDOWN_SECONDS" "$NOW"; then
      record_escalation "$INCIDENT_SIGNATURE" "$DEDUP_FILE" "$NOW"
      if queue_incident "$QUEUE_FILE" "$INCIDENT_SIGNATURE" "$STRANDED_INCIDENT" "$NOW" "$DELIVERY_BLOCK_REASON" stranded; then
        echo "$NOW" >"$STRANDED_NAG_FILE"
        log "STRANDED tracker entry (sig ${INCIDENT_SIGNATURE}) - queued a self-repair nag: $(echo "$STRANDED" | tr '\n' ';')"
      fi
    fi
  fi
fi

# --- Delivery ------------------------------------------------------------
# Everything above this line runs on every cycle regardless of the gates.
if [ "$DELIVERY_BLOCKED" -eq 1 ]; then
  exit "$PULL_FAILED"
fi

# One per cycle, oldest first. Each keeps its OWN signature and text, so the
# prior-denial memo below and the tracker's incident_signature mean exactly
# what they meant when delivery was immediate. Delivering the whole queue in
# one message would merge distinct incidents into one hash and break both.
if ! queue_peek INCIDENT INCIDENT_SIGNATURE QUEUED_AT HELD_REASON QUEUE_KIND "$QUEUE_FILE"; then
  exit "$PULL_FAILED"
fi

# Modifications toggle affects only the escalation prompt's closing
# instruction, read at prompt-construction time (not deploy time) so
# flipping the toggle changes the very next escalation's framing without
# needing to redeploy this script at all. Same pattern as
# watcher-docker.sh.tmpl.
MODIFICATIONS_ENABLED="false"
if [ -f "$REGISTRY_FILE" ]; then
  MODIFICATIONS_ENABLED=$(jq -r --arg k "$REPO_KEY" '.[$k].modifications_enabled' "$REGISTRY_FILE" 2>/dev/null || echo null)
  if [ "$MODIFICATIONS_ENABLED" = "null" ]; then
    MODIFICATIONS_ENABLED="false"
  fi
fi
if [ "$MODIFICATIONS_ENABLED" = "true" ]; then
  CLOSING_INSTRUCTION="Investigate and report if this is benign. If it's a real bug, prepare a fix on a branch and commit it, but stop and ask permission before pushing - ask by running /sandbox/pilot-state/lib/ask-decision.sh as your TOOLS.md describes, which is the only way the question reaches a human. If benign and a stable recurring pattern, you may propose a suppression addition per your AGENTS.md. If there is nothing to fix - benign, not this repo's problem, or already resolved upstream - leave no stage-tracker entry behind: do not create one, and delete any that already exists, per Stage 1 of your AGENTS.md. Do not ask permission to remove your own tracker entry. You are read-only against the cluster itself, regardless of this toggle - hotfixes are always git branch -> PR -> human merge -> the existing deploy pipeline, never a direct kubectl write."
else
  CLOSING_INSTRUCTION="Investigate and report whether this is benign or a real issue. REMINDER: you are read-only - do not modify, commit, or push anything, and you have no write access to the cluster itself under any circumstance."
fi

# Prior-denial memo (2026-08-05). A denied fix gets discarded and its
# tracker entry removed, so nothing else would remember the decision - the
# same incident recurring after the cooldown would come back as if it were
# brand new, and the agent would cheerfully re-propose the fix that was just
# rejected. Matching on the incident SIGNATURE (not the branch name, and not
# the agent's own human-readable summary of the incident, which is free text
# that varies run to run) is what makes this hold: it's the same normalized
# hash incident_in_cooldown already computes, so "the same incident" means
# exactly what it means everywhere else in this script.
#
# Deliberately a memo, not a suppression: the human denied ONE PROPOSED FIX,
# which is not the same as saying the underlying error is uninteresting.
# Silently muting an error class on a single Deny click would be a much
# bigger hammer than the click implies. Same as watcher-docker.sh.tmpl, keep
# both in sync.
DENIAL_NOTE=""
PRIOR_DENIAL=$(echo "$DENIALS_JSON" | jq -r --arg sig "$INCIDENT_SIGNATURE" \
  'to_entries | map(select(.value.incident_signature == $sig)) | .[0] // empty
   | "\(.key)\t\(.value.denied_at)\t\(.value.patch_path // "")"' 2>/dev/null || true)
if [ -n "$PRIOR_DENIAL" ]; then
  DENIED_BRANCH=$(printf '%s' "$PRIOR_DENIAL" | cut -f1)
  DENIED_AT=$(printf '%s' "$PRIOR_DENIAL" | cut -f2)
  DENIED_PATCH=$(printf '%s' "$PRIOR_DENIAL" | cut -f3)
  DENIAL_NOTE="
IMPORTANT - THIS INCIDENT HAS COME BACK AFTER A DENIED FIX.
On ${DENIED_AT} you proposed a fix for this same incident on branch
${DENIED_BRANCH}, and the human explicitly DENIED it. That branch and its
worktree were discarded."
  if [ -n "$DENIED_PATCH" ]; then
    DENIAL_NOTE="${DENIAL_NOTE}
The rejected diff was kept at ${DENIED_PATCH} - read it before doing
anything else, so you know exactly what was already turned down."
  fi
  DENIAL_NOTE="${DENIAL_NOTE}
Do NOT simply re-propose that same fix. Either investigate a genuinely
different approach and explain how it differs, or make the case that this
is benign and should go on the suppression list. Whichever you choose, say
explicitly in your Stage 4 report that this is a repeat of a denied fix and
what you did differently - the human needs to see that you know.
"
fi

# Held-in-queue note. An incident delivered minutes or hours after it was
# observed is a different thing from one delivered as it happens, and the
# agent has no other way to know which it is holding - it would otherwise
# investigate a stale symptom as if it were live. Same as
# watcher-docker.sh.tmpl, keep both in sync.
DELAY_NOTE=""
QUEUE_AGE=$(( NOW - QUEUED_AT ))
if [ "$QUEUE_AGE" -ge 300 ]; then
  DELAY_NOTE="
NOTE - THIS IS A DELAYED REPORT. This incident was observed $(( QUEUE_AGE / 60 ))
minutes ago and held until now because ${HELD_REASON:-delivery was blocked}.
Check whether it is still happening before treating it as live - it may have
recovered on its own, or been fixed, in the meantime.
"
fi
QUEUE_REMAINING=$(( $(queue_depth "$QUEUE_FILE") - 1 ))
if [ "$QUEUE_REMAINING" -gt 0 ]; then
  DELAY_NOTE="${DELAY_NOTE}
${QUEUE_REMAINING} further incident(s) observed during that time are still
queued behind this one and will arrive on later cycles, one at a time. Finish
this one; do not try to pre-empt them.
"
fi

if [ "$QUEUE_KIND" = "stranded" ]; then
  # A stranded-entry nag is about the agent's own bookkeeping, not the
  # workload. It deliberately gets none of the incident framing: no "incident
  # detected on <workload>" header (nothing was detected on it), no
  # prior-denial memo, and above all not the closing instruction, which would
  # tell the agent to go prepare a fix on a branch for what is a tracker
  # problem. No session_key/signature trailer either - the entry it is about
  # already carries both. Same as watcher-docker.sh.tmpl.
  PROMPT="${INCIDENT}
${DELAY_NOTE}"
else
  PROMPT="Incident detected on ${K8S_WORKLOAD_NAME} (namespace ${K8S_NAMESPACE}, cluster ${K8S_CLUSTER}):

${INCIDENT}
${DELAY_NOTE}${DENIAL_NOTE}
${CLOSING_INSTRUCTION}

Your session_key for this incident, to record verbatim in the Stage 2
tracker entry (see TOOLS.md's Stage 2 jq write - there is no other way
for you to know this value, nothing in your environment exposes it):
${SESSION_KEY}

The incident_signature for this incident, to record verbatim in that same
Stage 2 tracker entry (same reason - it isn't derivable from anything you
can see, and a later Deny needs it to recognise this incident if it ever
comes back):
${INCIDENT_SIGNATURE}"
fi

log "DELIVERING (sig ${INCIDENT_SIGNATURE}, queued $(( QUEUE_AGE / 60 ))m ago, ${QUEUE_REMAINING} behind it)"
openclaw agent --agent "$AGENT_ID" --session-key "$SESSION_KEY" --message "$PROMPT" >>"$LOG_FILE" 2>&1
DELIVER_RC=$?

# Dropped from the queue only once it actually reached the agent. A failed
# call leaves it queued to retry on the next cycle - which is the whole
# reason this is a queue and not a fire-and-forget send. Retries are capped:
# an incident that cannot be delivered at all must not be re-sent forever.
if [ "$DELIVER_RC" -eq 0 ]; then
  queue_drop "$QUEUE_FILE" "$INCIDENT_SIGNATURE"
else
  if queue_record_attempt "$QUEUE_FILE" "$INCIDENT_SIGNATURE"; then
    log "delivery FAILED (exit ${DELIVER_RC}) for sig ${INCIDENT_SIGNATURE} - left queued, retrying next cycle"
  else
    log "WARNING: GIVING UP on sig ${INCIDENT_SIGNATURE} after ${QUEUE_MAX_ATTEMPTS} failed delivery attempts (last exit ${DELIVER_RC}) - dropped from the queue. This incident was never seen by the agent: ${INCIDENT}"
  fi
fi
[ "$DELIVER_RC" -ne 0 ] && exit "$DELIVER_RC"
exit "$PULL_FAILED"
