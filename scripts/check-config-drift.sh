#!/usr/bin/env bash
# check-config-drift.sh - report where the live sandbox has drifted from what
# this repo's tooling intends.
#
# Exists because drift here is silent by construction and has already bitten
# twice:
#   - The sessions_send agent-to-agent config was applied by hand in July,
#     never encoded anywhere, and vanished during a nemoclaw v0.0.81 -> v0.0.90
#     upgrade that rebuilds sandbox config from host-side settings. Nobody
#     noticed for about a week; cross-agent messaging was just quietly
#     returning "forbidden" the whole time.
#   - All 14 escalation/reviewer agents went missing on 2026-08-03 and it was
#     noticed only by a later unrelated failure.
#
# Neither failure announced itself, because in both cases the *live* system was
# internally consistent - it just no longer matched intent. That is exactly what
# this script compares.
#
# It also guards against false alarms in the other direction: `openclaw cron
# list`'s table rounds a 90s schedule to "every 2m", which was misread as drift
# once. The cron check here compares everyMs from --json instead.
#
# Usage:
#   ./scripts/check-config-drift.sh          # report, exit 1 if drift found
#   ./scripts/check-config-drift.sh -v       # also list settings that match
#   ./scripts/check-config-drift.sh --json   # machine-readable, for the dashboard
#
# Run it on the host that owns the sandbox (Server 6), same as bootstrap.sh -
# it shells out through `nemoclaw <sandbox> exec --`.
#
# Exit codes: 0 = no drift, 1 = drift found, 2 = could not check (no sandbox,
# gateway unreachable). 1 vs 2 matters if this is ever wired to a cron or the
# dashboard: "drifted" and "couldn't tell" are different alerts.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="ops-nemoclaw"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"

# Unlike every other script in this repo, this one also runs NON-interactively:
# the dashboard's /api/ops/config-drift route execs it from a systemd service.
# That environment has neither ~/.local/bin on PATH nor the gateway port set,
# and both failures look identical from the outside - the sandbox reports as
# unreachable and the whole check exits 2. Resolve both here rather than
# relying on a login shell having done it.
#
# $NEMOCLAW_BIN wins when set (the dashboard passes its own constant, so there
# is one authority when called that way); otherwise PATH; otherwise the known
# install location, which is what a systemd caller actually falls back to.
NEMOCLAW_BIN="${NEMOCLAW_BIN:-$(command -v nemoclaw || echo /home/ops-s006/.local/bin/nemoclaw)}"
# Without this, nemoclaw resolves a default gateway name implying port 8080,
# fails to find it, and reports the running sandbox as "does not exist" - the
# same gotcha documented in bootstrap.sh's header and dashboard/src/routes/ops.js.
export NEMOCLAW_GATEWAY_PORT="${NEMOCLAW_GATEWAY_PORT:-8180}"

VERBOSE=0
JSON_MODE=0
case "${1:-}" in
  -v) VERBOSE=1 ;;
  --json) JSON_MODE=1 ;;
esac

# In --json mode the human report is suppressed wholesale by pointing stdout at
# /dev/null and keeping the real one on fd 3, rather than by threading an
# if-json check through every echo in this file. The JSON is written to fd 3 at
# the end. Exit codes are identical in both modes.
RESULTS_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE"' EXIT
if [ "$JSON_MODE" -eq 1 ]; then
  exec 3>&1 1>/dev/null
fi

DRIFT=0
CHECKED=0
MATCHED=0

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

# `nemoclaw exec` interleaves gateway-selection and undici noise with real
# output; strip it so comparisons see only the value.
oc() {
  "$NEMOCLAW_BIN" "$SANDBOX" exec -- openclaw "$@" 2>&1 \
    | grep -vE "UNDICI|trace-warnings|Active gateway set to|^\(node:[0-9]+\)"
}

# Same noise-stripping, but for an arbitrary command inside the sandbox rather
# than an `openclaw` subcommand - used by the inference-route probe in section 4,
# which needs curl, not openclaw.
oc_raw() {
  "$NEMOCLAW_BIN" "$SANDBOX" exec --timeout 45 -- "$@" 2>&1 \
    | grep -vE "UNDICI|trace-warnings|Active gateway set to|^\(node:[0-9]+\)"
}

# Compare as JSON when both sides parse as JSON (so 600 == 600 and a
# pretty-printed array equals a compact one), otherwise as trimmed text (bare
# strings like `qwen` or a URL are not valid JSON and must not be forced
# through jq).
normalize() {
  local raw="$1" out
  if out=$(printf '%s' "$raw" | jq -S -c . 2>/dev/null); then
    printf '%s' "$out"
  else
    printf '%s' "$raw" | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  fi
}

report() {
  local status="$1" name="$2" want="$3" got="$4"
  CHECKED=$((CHECKED + 1))
  jq -nc --arg s "$status" --arg n "$name" --arg w "$want" --arg g "$got" \
    '{status:$s, name:$n, intended:$w, live:$g}' >> "$RESULTS_FILE"
  case "$status" in
    ok)
      MATCHED=$((MATCHED + 1))
      [ "$VERBOSE" -eq 1 ] && green "  ok      $name = $want"
      ;;
    drift)
      DRIFT=$((DRIFT + 1))
      red   "  DRIFT   $name"
      echo  "            intended: $want"
      echo  "            live:     $got"
      ;;
    missing)
      DRIFT=$((DRIFT + 1))
      red   "  MISSING $name"
      echo  "            intended: $want"
      echo  "            live:     (key absent - this is the failure mode that hid the"
      echo  "                      sessions_send config for a week)"
      ;;
  esac
}

# --- 1. Gateway config -------------------------------------------------------
# `note` and `set_config` are the two hooks scripts/lib/gateway-config.sh
# expects its caller to provide. bootstrap.sh defines them to apply; here they
# compare. Sourcing the same file is the whole point: there is no second copy
# of the intended values to fall out of date.
note() { :; }

set_config() {
  local path="$1"; shift
  local want="$1"
  # A trailing --strict-json is an argument to `config set`, not part of the
  # value; ignore it for comparison purposes.
  local live rc
  live=$(oc config get "$path"); rc=$?
  if [ $rc -ne 0 ] || printf '%s' "$live" | grep -q "Config path not found"; then
    report missing "$path" "$want" ""
    return
  fi
  if [ "$(normalize "$live")" = "$(normalize "$want")" ]; then
    report ok "$path" "$want" "$live"
  else
    report drift "$path" "$(normalize "$want")" "$(normalize "$live")"
  fi
}

# Third hook, for keys whose intended state is ABSENCE - an onboard default we
# do not want back. bootstrap.sh's version removes the key; this one asserts it
# is gone, so a fresh onboard silently reintroducing it shows up here as drift
# rather than being noticed by accident later.
unset_config() {
  local path="$1"
  local live rc
  live=$(oc config get "$path" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ] || printf '%s' "$live" | grep -q "Config path not found"; then
    report ok "$path (absent)" "absent" "absent"
  else
    report drift "$path (absent)" "absent" "$(normalize "$live")"
  fi
}

echo "=== Gateway config (scripts/lib/gateway-config.sh) ==="
if ! "$NEMOCLAW_BIN" "$SANDBOX" exec -- true >/dev/null 2>&1; then
  red "cannot reach the '$SANDBOX' sandbox via $NEMOCLAW_BIN - nothing checked"
  exit 2
fi
# shellcheck source=lib/gateway-config.sh
. "$SCRIPT_DIR/lib/gateway-config.sh"
gateway_config_settings

# --- 2. Watcher crons --------------------------------------------------------
# Cadence comes from the same shared constant bootstrap.sh and register-repo.sh
# use, so "the script says X, the sandbox does Y" shows up here rather than
# being noticed by accident. Compares everyMs, not the rounded table output.
echo ""
echo "=== Watcher crons ==="
CRON_JSON=$(oc cron list --json 2>/dev/null)
# Strip any non-JSON preamble before parsing. `openclaw` prints config warnings
# to STDOUT, ahead of the JSON, so a single unrelated warning silently turned
# every cron check below into "could not read cron list as JSON" - which counts
# as one drift and hides seven real ones. Hit for real on 2026-09-04: a
# `plugins.entries.tavily` entry (disabled, never configured by this repo, an
# onboard default whose plugin isn't installed) emitted
#   "- plugins.entries.tavily: plugin not installed: tavily ..."
# on EVERY openclaw invocation, and the whole cron section stopped running.
# Cutting from the first line that begins a JSON object keeps this robust
# against any future warning rather than just that one.
CRON_JSON=$(printf '%s' "$CRON_JSON" | sed -n '/^[[:space:]]*[{[]/,$p')
if ! printf '%s' "$CRON_JSON" | jq -e . >/dev/null 2>&1; then
  red "  could not read cron list as JSON - skipping cron checks"
  DRIFT=$((DRIFT + 1))
else
  WANT_MS=$(cadence_to_ms "$WATCHER_CRON_EVERY")
  for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
    MONITORING=$(jq -r --arg k "$KEY" '.[$k].monitoring_enabled' "$REGISTRY_JSON")
    NAME="${KEY}-watcher"
    LIVE_MS=$(printf '%s' "$CRON_JSON" | jq -r --arg n "$NAME" \
      '(.jobs // .crons // .)[]? | select(.name==$n) | .schedule.everyMs // empty' | head -1)
    if [ "$MONITORING" != "true" ]; then
      [ -n "$LIVE_MS" ] && report drift "cron $NAME" "absent (monitoring_enabled=false)" "every ${LIVE_MS}ms" \
                        || report ok "cron $NAME" "absent (monitoring_enabled=false)" "absent"
      continue
    fi
    if [ -z "$LIVE_MS" ]; then
      report missing "cron $NAME" "every $WATCHER_CRON_EVERY" ""
    elif [ "$LIVE_MS" != "$WANT_MS" ]; then
      report drift "cron $NAME schedule" "every $WATCHER_CRON_EVERY (${WANT_MS}ms)" "${LIVE_MS}ms"
    else
      report ok "cron $NAME schedule" "every $WATCHER_CRON_EVERY" "${LIVE_MS}ms"
    fi
  done

  # PR-review crons (2026-08-12). Its own cadence constant and its own
  # per-repo flag, otherwise identical logic - including the both-directions
  # check: a cron still running for a repo whose flag was turned OFF is drift
  # too, not just a missing one.
  PR_WANT_MS=$(cadence_to_ms "$PR_WATCHER_CRON_EVERY")
  for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
    PR_REVIEW=$(jq -r --arg k "$KEY" '.[$k].pr_review_enabled' "$REGISTRY_JSON")
    [ "$PR_REVIEW" = "null" ] && PR_REVIEW="false"
    NAME="${KEY}-pr-watcher"
    LIVE_MS=$(printf '%s' "$CRON_JSON" | jq -r --arg n "$NAME" \
      '(.jobs // .crons // .)[]? | select(.name==$n) | .schedule.everyMs // empty' | head -1)
    if [ "$PR_REVIEW" != "true" ]; then
      [ -n "$LIVE_MS" ] && report drift "cron $NAME" "absent (pr_review_enabled=false)" "every ${LIVE_MS}ms" \
                        || report ok "cron $NAME" "absent (pr_review_enabled=false)" "absent"
      continue
    fi
    if [ -z "$LIVE_MS" ]; then
      report missing "cron $NAME" "every $PR_WATCHER_CRON_EVERY" ""
    elif [ "$LIVE_MS" != "$PR_WANT_MS" ]; then
      report drift "cron $NAME schedule" "every $PR_WATCHER_CRON_EVERY (${PR_WANT_MS}ms)" "${LIVE_MS}ms"
    else
      report ok "cron $NAME schedule" "every $PR_WATCHER_CRON_EVERY" "${LIVE_MS}ms"
    fi
  done

  # gh-issues crons (2026-09-03). Same both-directions shape as pr-watcher
  # above, its own flag and cadence constant. Added 2026-09-07 after all 7
  # of these jobs silently didn't survive a sandbox rebuild - registry
  # intent (gh_issues_enabled) was untouched, only the actual cron
  # registration was lost, and nothing here checked for that until now.
  GH_ISSUES_WANT_MS=$(cadence_to_ms "$GH_ISSUES_CRON_EVERY")
  for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
    GH_ISSUES=$(jq -r --arg k "$KEY" '.[$k].gh_issues_enabled' "$REGISTRY_JSON")
    [ "$GH_ISSUES" = "null" ] && GH_ISSUES="false"
    NAME="${KEY}-gh-issues"
    LIVE_MS=$(printf '%s' "$CRON_JSON" | jq -r --arg n "$NAME" \
      '(.jobs // .crons // .)[]? | select(.name==$n) | .schedule.everyMs // empty' | head -1)
    if [ "$GH_ISSUES" != "true" ]; then
      [ -n "$LIVE_MS" ] && report drift "cron $NAME" "absent (gh_issues_enabled=false)" "every ${LIVE_MS}ms" \
                        || report ok "cron $NAME" "absent (gh_issues_enabled=false)" "absent"
      continue
    fi
    if [ -z "$LIVE_MS" ]; then
      report missing "cron $NAME" "every $GH_ISSUES_CRON_EVERY" ""
    elif [ "$LIVE_MS" != "$GH_ISSUES_WANT_MS" ]; then
      report drift "cron $NAME schedule" "every $GH_ISSUES_CRON_EVERY (${GH_ISSUES_WANT_MS}ms)" "${LIVE_MS}ms"
    else
      report ok "cron $NAME schedule" "every $GH_ISSUES_CRON_EVERY" "${LIVE_MS}ms"
    fi
  done
fi

# --- 3. Agent roster ---------------------------------------------------------
# The 2026-08-03 incident was all 14 agents silently missing. The dashboard
# checks this too (/api/ops/agents); duplicated here on purpose so the check
# doesn't depend on the dashboard being up.
echo ""
echo "=== Agent roster ==="
AGENTS_JSON=$(oc agents list --json 2>/dev/null)
# Same non-JSON-preamble strip as the cron section above, for the same reason:
# openclaw prints config warnings to STDOUT ahead of the payload, and without
# this one unrelated warning silently skips every agent check while counting as
# a single drift. The cron section hit this for real on 2026-09-04; this call
# had the identical exposure and was fixed pre-emptively rather than waiting for
# the next warning to blind the check that exists to catch 14 agents going
# missing.
AGENTS_JSON=$(printf '%s' "$AGENTS_JSON" | sed -n '/^[[:space:]]*[{[]/,$p')
if ! printf '%s' "$AGENTS_JSON" | jq -e . >/dev/null 2>&1; then
  red "  could not read agent list as JSON - skipping agent checks"
  DRIFT=$((DRIFT + 1))
else
  # `agents list --json` returns a BARE ARRAY (unlike `cron list --json`,
  # which wraps its rows in {jobs:[...]}) - indexing an array with a string
  # key is a hard jq error, not an empty result, so branch on the type.
  LIVE_IDS=$(printf '%s' "$AGENTS_JSON" \
    | jq -r 'if type=="array" then .[] else (.agents // [])[] end | .id // empty')
  for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
    for ROLE in escalation reviewer; do
      AGENT="${KEY}-${ROLE}"
      if printf '%s\n' "$LIVE_IDS" | grep -qx "$AGENT"; then
        report ok "agent $AGENT" "registered" "registered"
      else
        report missing "agent $AGENT" "registered" ""
      fi
    done
    # The PR reviewer is conditional on the flag, unlike the pair above which
    # exist for every registered repo. Only its absence-when-wanted is drift:
    # a leftover agent for a repo whose flag is off costs nothing and is never
    # invoked (the cron is what drives it, and that IS checked both ways
    # above), so flagging it here would be noise.
    PR_REVIEW=$(jq -r --arg k "$KEY" '.[$k].pr_review_enabled' "$REGISTRY_JSON")
    if [ "$PR_REVIEW" = "true" ]; then
      AGENT="${KEY}-pr-reviewer"
      if printf '%s\n' "$LIVE_IDS" | grep -qx "$AGENT"; then
        report ok "agent $AGENT" "registered" "registered"
      else
        report missing "agent $AGENT" "registered" ""
      fi
    fi
  done
fi

# --- 4. Inference route ------------------------------------------------------
# The inference endpoint lives in THREE places that drift independently:
#   1. models.providers.inference.baseUrl  - section 1 above (LAN address)
#   2. policies/trading-vllm-shared-inference.yaml - the network policy (LAN)
#   3. OpenShell's own recorded provider endpoint  - PUBLIC address, because
#      onboarding refuses a private one
# Only the first was covered here, and the third is the one that bit: after the
# vLLM moved to Server 5 on 2026-09-01 it kept the old port (11510 vs 11511) for
# three days. Nothing noticed, because agents route through baseUrl and never
# touch it - until `rebuild` smoke-checks inference.local at step 7 of 8, AFTER
# deleting the sandbox. Three rebuilds failed and one working sandbox was lost.
#
# This is a FUNCTIONAL check, not a string comparison, and deliberately so: the
# provider's OPENAI_BASE_URL value is NOT readable from the CLI (`provider get`
# reports only "Config keys: OPENAI_BASE_URL", and there is no --json), so there
# is nothing to compare a wanted string against. Probing the route is better
# anyway - a string match would pass while the service behind it was down.
#
# Fixing a failure here does NOT belong in gateway-config.sh, because this is
# not an openclaw config key:
#   openshell provider update compatible-endpoint \
#     --config OPENAI_BASE_URL=<live-url> --gateway nemoclaw-$NEMOCLAW_GATEWAY_PORT
echo ""
echo "=== Inference route (gateway -> recorded provider endpoint) ==="
INF_CODE=$(oc_raw curl -s -o /dev/null -w '%{http_code}' https://inference.local/v1/models | tail -1 | tr -dc '0-9')
if [ "$INF_CODE" = "200" ]; then
  report ok "inference.local (via recorded provider endpoint)" "http 200" "http 200"
elif [ -z "$INF_CODE" ]; then
  report drift "inference.local (via recorded provider endpoint)" "http 200" \
    "could not probe from inside the sandbox"
else
  report drift "inference.local (via recorded provider endpoint)" "http 200" \
    "http $INF_CODE - the recorded provider endpoint is wrong or its upstream is down. FIX BEFORE ANY REBUILD."
fi

# --- 5. Per-clone CA pin -----------------------------------------------------
# Egress goes through OpenShell's TLS-intercepting proxy, so git has to trust
# that CA or every fetch fails cert verification. The container exports
# GIT_SSL_CAINFO and `nemoclaw exec` inherits it - but the AGENTS' own exec tool
# does not, so on 2026-09-04 all 7 escalation agents' Stage 0 died with
#   "server verification failed: certificate signer not trusted.
#    (CAfile: /etc/ssl/certs/ca-certificates.crt)"
# while every manual test kept passing. bootstrap.sh now pins the CA in each
# clone's own git config; this asserts it stayed pinned.
#
# Checked here rather than left to the retry loop to surface: the loop does stop
# the agent safely, but only once an escalation actually fires, which can be days
# after the clone was made. Watchers stay green throughout - a clean check never
# fetches - so nothing else in the stack notices.
#
# One exec for all repos rather than one per repo: seven round trips through
# `nemoclaw exec` costs ~15s and this script runs from the dashboard.
WANT_CA="/etc/openshell-tls/ca-bundle.pem"
echo ""
echo "=== Per-clone CA pin (http.sslCAInfo) ==="
CA_REPORT=$(oc_raw bash -lc 'for r in /sandbox/repos/*/; do [ -d "$r.git" ] || continue; printf "%s %s\n" "$(basename "$r")" "$(git -C "$r" config --get http.sslCAInfo 2>/dev/null || echo MISSING)"; done')
for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
  REPO_NAME=$(jq -r --arg k "$KEY" '.[$k].clone_url' "$REGISTRY_JSON" | xargs basename | sed 's/\.git$//')
  LIVE_CA=$(printf '%s\n' "$CA_REPORT" | awk -v n="$REPO_NAME" '$1==n {print $2; exit}')
  if [ -z "$LIVE_CA" ]; then
    report drift "clone CA pin $REPO_NAME" "$WANT_CA" \
      "clone not found in /sandbox/repos - bootstrap.sh has not run, or the directory name does not match clone_url"
  elif [ "$LIVE_CA" = "$WANT_CA" ]; then
    report ok "clone CA pin $REPO_NAME" "$WANT_CA" "$LIVE_CA"
  else
    report drift "clone CA pin $REPO_NAME" "$WANT_CA" \
      "$LIVE_CA - this repo's agent Stage 0 git fetch will fail cert verification"
  fi
done

# --- summary -----------------------------------------------------------------
if [ "$JSON_MODE" -eq 1 ]; then
  jq -s --argjson drift "$DRIFT" --argjson checked "$CHECKED" --argjson matched "$MATCHED" \
    '{drift:$drift, checked:$checked, matched:$matched, items:[.[] | select(.status!="ok")]}' \
    "$RESULTS_FILE" >&3
  [ "$DRIFT" -eq 0 ] && exit 0 || exit 1
fi

echo ""
if [ "$DRIFT" -eq 0 ]; then
  green "no drift: $MATCHED/$CHECKED checks match intent"
  exit 0
fi
red "$DRIFT of $CHECKED checks drifted from intent"
echo ""
echo "For gateway-config drift, re-applying is ./bootstrap.sh (safe to re-run;"
echo "section 8 is idempotent) followed by 'nemoclaw $SANDBOX gateway restart'"
echo "- several keys write fine but do not take effect until that restart."
echo "Before re-applying, check the drift isn't intentional: if someone changed"
echo "the live value on purpose, the fix belongs in scripts/lib/gateway-config.sh,"
echo "not in overwriting their change."
echo ""
echo "EXCEPT the inference-route check - bootstrap.sh cannot fix that one, and"
echo "gateway-config.sh is the wrong place for it: the recorded endpoint is an"
echo "OpenShell provider config key, not an openclaw one. Fix it with:"
echo "  openshell provider update compatible-endpoint \\"
echo "    --config OPENAI_BASE_URL=<live-url> --gateway nemoclaw-${NEMOCLAW_GATEWAY_PORT}"
echo "(--config alone is a partial update and preserves COMPATIBLE_API_KEY.)"
echo "Do this BEFORE any rebuild - rebuild smoke-checks that route at step 7 of"
echo "8, after it has already deleted the sandbox."
exit 1
