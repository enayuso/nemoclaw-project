#!/usr/bin/env bash
# watcher-gate.test.sh <rendered-watcher.sh> <watcher-common.sh>
# Runs a rendered watcher inside the sandbox against a scratch state dir with
# `openclaw` stubbed - see scripts/test/README.md for how to render one.
set -uo pipefail
SRC_WATCHER="$1"
LIB="$2"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"
mkdir -p "$STATE/lib" "$TMP/bin"
cp "$LIB" "$STATE/lib/watcher-common.sh"

# Stub openclaw: records the delivered message, succeeds. `config get` has to
# answer too - inference_backend_healthy shells out to it.
cat >"$TMP/bin/openclaw" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "config" ]; then
  # real value, so the health probe hits the real endpoint
  exec /usr/local/bin/openclaw "\$@" 2>/dev/null || echo "\$OPENCLAW_BASE_URL"
fi
{ echo "=== DELIVERY ==="; printf '%s\n' "\$@"; } >>"$TMP/delivered.txt"
exit \${STUB_EXIT:-0}
STUB
chmod +x "$TMP/bin/openclaw"
REAL_OPENCLAW=$(command -v openclaw)
OPENCLAW_BASE_URL=$("$REAL_OPENCLAW" config get models.providers.inference.baseUrl 2>/dev/null | grep -oE 'https?://[^"[:space:]]+' | head -1)
export OPENCLAW_BASE_URL
sed -i "s#exec /usr/local/bin/openclaw#exec $REAL_OPENCLAW#" "$TMP/bin/openclaw"

W="$TMP/watcher.sh"
sed "s#^STATE_DIR=\"/sandbox/pilot-state\"#STATE_DIR=\"$STATE\"#" "$SRC_WATCHER" >"$W"
grep -q "STATE_DIR=\"$STATE\"" "$W" || { echo "FAIL: could not repoint STATE_DIR"; exit 1; }
# The registry lives in the real state dir; point the copy's registry at a
# scratch one so the monitoring/modifications toggles are under test control.
cat >"$STATE/registry.json" <<'EOF'
{"testrag": {"monitoring_enabled": true, "modifications_enabled": true}}
EOF

export PATH="$TMP/bin:$PATH"
FAIL=0
check() { if [ "$2" = "$3" ]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; FAIL=1; fi; }
LOG="$STATE/testrag-watcher.log"
Q="$STATE/testrag-watcher.queue"
ST="$STATE/testrag-escalation-stages.json"
run() { bash "$W"; printf 'exit=%s\n' "$?"; }
lastlog() { tail -5 "$LOG" 2>/dev/null; }

echo "=== 1. normal cycle, nothing blocked ==="
run
check "log written" 0 "$([ -s "$LOG" ]; echo $?)"
check "state advanced" 0 "$([ -s "$STATE/testrag-watcher.state" ]; echo $?)"
echo "  last log: $(tail -1 "$LOG")"

echo "=== 2. a stage-4 entry holds delivery but NOT observation ==="
cat >"$ST" <<'EOF'
{"fix/held": {"stage": 4, "incident": "x", "worktree": "/tmp/x",
  "session_key": "agent:testrag-escalation:testrag-watcher",
  "incident_signature": "sig-held", "updated_at": "2026-08-13T00:00:00Z"}}
EOF
BEFORE_STATE=$(cat "$STATE/testrag-watcher.state")
sleep 1
run
AFTER_STATE=$(cat "$STATE/testrag-watcher.state")
check "pause announced" 1 "$(grep -c 'escalation delivery PAUSED' "$LOG")"
check "says checking continues" 1 "$(grep -c 'Health checking CONTINUES' "$LOG")"
check "still pulled and advanced state" 0 "$([ "$BEFORE_STATE" != "$AFTER_STATE" ]; echo $?; )"
check "a check still ran this cycle" 1 "$(tail -2 "$LOG" | grep -c 'clean check\|ESCALATING\|cooldown\|kubectl')"
check "nothing delivered" 0 "$([ -f "$TMP/delivered.txt" ] && grep -c 'DELIVERY' "$TMP/delivered.txt" || echo 0)"

echo "=== 3. an incident found while blocked is queued, not dropped ==="
# Force one: inject a synthetic incident by making the pod selector match
# nothing, which is a real incident branch ("No pods currently match").
sed -i 's#^K8S_LABEL_SELECTOR=.*#K8S_LABEL_SELECTOR="app=definitely-no-such-workload"#' "$W"
run
check "queued one incident" 1 "$(jq 'length' "$Q" 2>/dev/null || echo 0)"
check "queue reason recorded" "a fix was at stage 4 awaiting a human approve/deny" "$(jq -r '.[0].reason' "$Q")"
check "kind is incident" "incident" "$(jq -r '.[0].kind' "$Q")"
check "still nothing delivered" 0 "$([ -f "$TMP/delivered.txt" ] && grep -c 'DELIVERY' "$TMP/delivered.txt" || echo 0)"
run
check "not re-queued while in cooldown" 1 "$(jq 'length' "$Q")"

echo "=== 4. releasing the gate delivers the queued incident ==="
# Age the queued entry so the delayed-report note is exercised (it is only
# added past 5 minutes, so a same-second test queue would never see it).
jq --argjson t "$(( $(date +%s) - 3600 ))" '.[0].queued_at = $t' "$Q" >"$Q.t" && mv "$Q.t" "$Q"
echo '{}' >"$ST"
run
check "resume announced" 1 "$(grep -c 'escalation delivery RESUMED' "$LOG")"
check "delivered exactly one" 1 "$([ -f "$TMP/delivered.txt" ] && grep -c '=== DELIVERY ===' "$TMP/delivered.txt" || echo 0)"
check "queue drained" 0 "$(jq 'length' "$Q")"
check "delivery names the delay" 1 "$(grep -c 'DELAYED REPORT' "$TMP/delivered.txt")"
check "delay is stated in minutes" 1 "$(grep -c 'observed 60' "$TMP/delivered.txt")"
check "delivery says why it was held" 1 "$(grep -c 'awaiting a human approve/deny' "$TMP/delivered.txt")"
check "delivery carries the incident" 1 "$(grep -c 'No pods currently match' "$TMP/delivered.txt")"

echo "=== 5. a failed delivery keeps the entry queued ==="
sed -i 's#^K8S_LABEL_SELECTOR=.*#K8S_LABEL_SELECTOR="app=another-missing-workload"#' "$W"
rm -f "$STATE/testrag-watcher.dedup"; touch "$STATE/testrag-watcher.dedup"
STUB_EXIT=9 bash "$W" >/dev/null 2>&1
check "kept queued after failure" 1 "$(jq 'length' "$Q")"
check "attempt recorded" 1 "$(jq -r '.[0].attempts' "$Q")"
check "failure logged" 1 "$(grep -c 'delivery FAILED' "$LOG")"
run
check "retried and drained" 0 "$(jq 'length' "$Q")"

echo "=== 6. a stranded tracker entry is detected and nagged ==="
: >"$TMP/delivered.txt"
OLD=$(date -u -d "@$(( $(date +%s) - 4000 ))" +%Y-%m-%dT%H:%M:%SZ)
cat >"$ST" <<EOF
{"fix/forgotten": {"stage": 2, "incident": "y", "worktree": "/tmp/y",
  "session_key": "agent:testrag-escalation:testrag-watcher",
  "incident_signature": "sig-forgotten", "updated_at": "$OLD"}}
EOF
run
check "stranded logged" 1 "$(grep -c 'STRANDED tracker entry' "$LOG")"
check "stranded delivered" 1 "$(grep -c '=== DELIVERY ===' "$TMP/delivered.txt")"
check "names the branch" 1 "$(grep -c 'fix/forgotten' "$TMP/delivered.txt")"
check "points at ask-decision.sh" 1 "$(grep -c 'ask-decision.sh' "$TMP/delivered.txt")"
check "no incident framing" 0 "$(grep -c 'Incident detected on' "$TMP/delivered.txt")"
check "no fix-a-bug closing line" 0 "$(grep -c 'prepare a fix on a branch' "$TMP/delivered.txt")"
run
check "nag not repeated within cooldown" 1 "$(grep -c 'STRANDED tracker entry' "$LOG")"

echo "=== 7. a fresh stage-2 entry is not called stranded ==="
NEWTS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg t "$NEWTS" '.["fix/forgotten"].updated_at = $t' "$ST" >"$ST.t" && mv "$ST.t" "$ST"
rm -f "$STATE/testrag-watcher.strandednag"
run
check "still just the one nag" 1 "$(grep -c 'STRANDED tracker entry' "$LOG")"

echo
echo "--- watcher log ---"
cat "$LOG"
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
