#!/usr/bin/env bash
# patch-nemoclaw-dns.sh - re-apply the local NemoClaw DNS patch that makes the
# GitHub MCP endpoint reachable. Idempotent; safe to run any time.
#
# WHY THIS EXISTS. api.githubcopilot.com's authoritative DNS returns a single
# ROTATING A record per query, cycling through 140.82.{112,113,114}.{21,22}.
# NemoClaw pins the add-time answer into the generated MCP policy's
# allowed_ips via dns.lookup(host, {all:true}) - which yields exactly one
# address - while OpenShell re-resolves on EVERY connection and usually lands
# on a different member of the pool. The result is a permanent
#   NET:OPEN DENIED [engine:ssrf] [reason:... which is not in allowed_ips]
# and `mcp restart` does not fix it: it re-resolves and re-pins, but only ever
# to one member, so it just re-rolls which ~1-in-6 connections would have been
# allowed. (The "restart 2-3 times until it works" advice this project carried
# for weeks was dice-rolling, not a remedy.)
#
# Diagnosed and fixed 2026-08-05, after GitHub MCP had been hard-down for
# hours. Two approaches were tried and rejected first, both recorded here so
# nobody burns the time again:
#
#   1. A user-supplied policy preset allowing the host by name. Rejected by
#      NemoClaw outright if it carries allowed_ips ("not permitted in
#      user-supplied presets"), and when applied WITHOUT allowed_ips it made
#      no difference - the generated preset's pin still governs, so OpenShell
#      takes most-restrictive-wins across presets. Verified live, then rolled
#      back.
#   2. Sampling DNS repeatedly at registration time to discover the pool.
#      Does not work from this host: the local resolver serves a cached answer
#      for far longer than the rotation interval, so 14 samples spread over
#      15s still returned a single address. The sandbox sees fast rotation
#      only because it resolves through a different, uncached path.
#
# What actually works is patching resolveHostAddresses to union the stock
# lookup with an explicit operator-supplied pool. This KEEPS IP pinning rather
# than disabling it - allowed_ips still lists a closed set of known addresses,
# it is simply the complete set instead of one arbitrary member.
#
# This patches a VENDORED dependency and a NemoClaw upgrade will overwrite it.
# Symptom of that happening: MCP starts failing with the ssrf denial signature
# again. Re-run this script.
#
# Usage: patch-nemoclaw-dns.sh [--check]
#   --check   report whether the patch and config are in place; change nothing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_DIR="${HOME}/.nemoclaw/source/dist/lib/adapters/dns"
TARGET="${TARGET_DIR}/resolve.js"
BACKUP="${TARGET_DIR}/resolve.js.orig"
PATCH_SRC="${REPO_ROOT}/patches/nemoclaw-dns-resolve.js"
CONFIG_SRC="${REPO_ROOT}/patches/extra-allowed-ips.json"
CONFIG_DST="${HOME}/.nemoclaw/extra-allowed-ips.json"
MARKER="LOCAL PATCH (2026-08-05, nemoclaw-project)"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -f "$TARGET" ]; then
  echo "error: ${TARGET} not found - is NemoClaw installed at ~/.nemoclaw/source?" >&2
  exit 1
fi

patched=0
grep -q "$MARKER" "$TARGET" && patched=1
config_ok=0
[ -f "$CONFIG_DST" ] && config_ok=1

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "resolve.js patched:      $([ "$patched" -eq 1 ] && echo yes || echo "NO - run without --check")"
  echo "extra-allowed-ips.json:  $([ "$config_ok" -eq 1 ] && echo present || echo "MISSING")"
  if [ "$config_ok" -eq 1 ]; then
    echo "pinned pool:             $(python3 -c "import json;d=json.load(open('${CONFIG_DST}'));print(', '.join(d.get('api.githubcopilot.com',[])))" 2>/dev/null || echo "unreadable")"
  fi
  exit 0
fi

# Only ever back up the STOCK file. Without the -f guard a second run would
# overwrite the pristine backup with an already-patched copy, quietly
# destroying the only way back to upstream behaviour.
if [ ! -f "$BACKUP" ]; then
  cp "$TARGET" "$BACKUP"
  echo "backed up stock resolve.js -> ${BACKUP}"
else
  echo "stock backup already present at ${BACKUP}, leaving it alone"
fi

cp "$PATCH_SRC" "$TARGET"
node --check "$TARGET"
echo "patched ${TARGET}"

if [ ! -f "$CONFIG_DST" ]; then
  cp "$CONFIG_SRC" "$CONFIG_DST"
  echo "installed ${CONFIG_DST}"
else
  echo "${CONFIG_DST} already exists, left as-is (edit it by hand to add IPs)"
fi

echo ""
echo "Patch applied. It takes effect on the next registration, so finish with:"
echo "  nemoclaw ops-nemoclaw mcp restart github"
echo "then confirm the pin lists the whole pool:"
echo "  nemoclaw ops-nemoclaw policy-get --raw | grep -A8 allowed_ips"
