#!/usr/bin/env bash
# tunnel-keeper.sh - keeps a local SSH port-forward to Server 2's k3s API
# server alive, so kubectl (pointed at 127.0.0.1:16443 via
# kube/config-server2.tmpl) always has something to talk to. Run every
# minute by an openclaw cron (--no-deliver). Idempotent: no-op when the
# tunnel is already healthy, otherwise tears down any stale control socket
# and starts a fresh one.
#
# Runs INSIDE the sandbox specifically, not as a Server-6-host-level
# service - the sandbox's own lifecycle (destroy/rebuild) tears this down
# along with everything else, so there's no path to an orphaned tunnel
# outliving what created it. That's not a hypothetical: an orphaned
# HOST-side SSH tunnel (a stale nemoclaw-start supervisor connection) once
# caused a 500+ device-pairing-spam bug on this exact project. An
# in-sandbox, cron-supervised, ControlMaster-managed tunnel doesn't have
# that failure mode - use `tunnel-keeper.sh status` for a side-effect-free
# check rather than assuming.
#
# The SSH key this uses (/sandbox/.ssh/server2) can only forward to
# 127.0.0.1:6443 on the far end and can never run a command or get a PTY
# (authorized_keys `command="/bin/false",restrict,port-forwarding,
# permitopen=...` on Server 2 - the command="/bin/false" is what actually
# blocks exec, restrict alone does not - see README's Setup section) - so
# this script adds no authority beyond "a pipe." Kubernetes RBAC
# (k8s/rbac-readonly.yaml) is the real boundary.
set -uo pipefail

STATE_DIR="/sandbox/pilot-state"
LOG="$STATE_DIR/tunnel-keeper.log"
SOCK="$STATE_DIR/.server2-tunnel.sock"
LOCAL_PORT=16443
SSH_HOST="server2"

mkdir -p "$STATE_DIR"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

# ControlMaster check - asks the existing master (if any) whether it's
# still alive without touching the network itself.
tunnel_alive() {
  ssh -S "$SOCK" -O check "$SSH_HOST" >/dev/null 2>&1
}

port_listening() {
  timeout 2 bash -c "echo >/dev/tcp/127.0.0.1/${LOCAL_PORT}" 2>/dev/null
}

if [ "${1:-}" = "status" ]; then
  if tunnel_alive && port_listening; then
    echo "tunnel: up (control socket alive, 127.0.0.1:${LOCAL_PORT} listening)"
    exit 0
  fi
  echo "tunnel: down"
  exit 1
fi

if tunnel_alive && port_listening; then
  exit 0
fi

# Either genuinely down, or the control socket is stale (master process
# gone but the socket file left behind) - a clean `-O exit` attempt first
# means ssh won't refuse to reuse the path either way.
ssh -S "$SOCK" -O exit "$SSH_HOST" >/dev/null 2>&1 || true
rm -f "$SOCK"

log "tunnel down - starting a fresh one"
# -f -N -M -S: background after the forward is confirmed live, no remote
# command (the tunnel key's authorized_keys restriction would reject one
# anyway), ControlMaster mode so future checks/teardown go through the
# socket instead of PID-tracking (ssh -f's own PID is not reliably what
# $! captures once it backgrounds).
# -o ExitOnForwardFailure=yes: ssh -f BLOCKS until the forward is actually
# live, or fails loudly right here - this is what lets a nonzero exit below
# mean "the tunnel is genuinely not working," not "probably fine, unsure."
if ssh -f -N -M -S "$SOCK" \
     -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes \
     -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
     -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:6443" "$SSH_HOST" 2>>"$LOG"; then
  log "tunnel restarted successfully"
else
  log "WARNING: tunnel restart FAILED - kubectl calls will fail until this recovers"
  exit 1
fi
