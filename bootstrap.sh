#!/usr/bin/env bash
# bootstrap.sh - re-establishes everything on the `ops-nemoclaw` NemoClaw
# sandbox (direct-installed on Server 6) that does
# NOT survive a destroy/rebuild: a read-only SSH tunnel + Kubernetes RBAC to
# Server 2 (k3s, where all monitored workloads now run),
# this repo's own clone, the GitHub CLI (gh) install + auth, the GitHub MCP
# server, and any repos registered via the registry-driven onboarding system
# (registry/repos.json).
#
# There is deliberately no chat/notification channel to set up here: the
# dashboard (dashboard/) is the operator's real-time interface into these
# agents - live streaming, tool cards, and multi-turn history all work
# there. The earlier notification path was removed 2026-07-24, not just
# disabled. See this file's git history if it ever needs resurrecting.
#
# Server 5 (Docker) decommissioned 2026-07-22 (Phase 7 of
# docs/k8s-migration-architecture.md) - every monitored workload had already
# moved to Server 2 k3s, so the hardened read-only SSH path this script used
# to re-establish here, the server5-readonly-monitoring.yaml network policy,
# and the forced-command wrapper generator are gone. See this file's git
# history (and attic/, where the wrapper generator/template moved) if any
# of that ever needs resurrecting for a genuinely new Docker-hosted target.
#
# This repo covers ops-nemoclaw only. The personal dev-nemoclaw instance
# (Mac mini) and its hand-built investment-watcher/svc-monitor pilots
# live in the separate local-nemoclaw repo instead - split 2026-07-20 once
# both instances existed.
#
# Deliberately does NOT run its own copies of investment-watcher/
# svc-monitor - those stay exclusive to dev-nemoclaw/local-nemoclaw, to
# avoid duplicate monitoring of the same targets.
#
# Run this AFTER a fresh onboard, following the "Server 6 instance" setup
# steps in docs/operations.md for the one-time, human-run pieces (SSH keypair
# generation + RBAC apply for Server 2) that don't belong in an idempotent
# bootstrap script.
#
# IMPORTANT: run this yourself, directly in your own terminal - do not ask an
# AI agent to run it on your behalf. It reads real secrets from .env, and
# keeping raw secrets out of any tool-call transcript is a deliberate,
# hard-learned practice from building this out.
#
# Usage: cp .env.example .env, fill in real values, then: bash bootstrap.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
SANDBOX="ops-nemoclaw"
# Required on every `nemoclaw`/`openshell` invocation this script makes, not
# just at onboard time - confirmed live 2026-07-22 on a from-scratch Server 6
# rebuild (NemoClaw v0.0.90): without this exported, `nemoclaw ops-nemoclaw
# ...` resolves to a hardcoded default gateway name "nemoclaw" (implying port
# 8080), fails to find it, then tries to auto-start a fallback gateway on
# 8080 - which collides with Jenkins (Server 6 always needs 8180, see
# docs/operations.md's Setup section) - and finally reports the sandbox itself as
# "does not exist" even though it's running fine. Exporting it here makes
# the script self-sufficient regardless of whether the invoking shell
# happens to have it set.
export NEMOCLAW_GATEWAY_PORT=8180

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE - copy .env.example to .env and fill in real values first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

REQUIRED_VARS=(GITHUB_USERNAME GITHUB_PAT GITHUB_MCP_PAT)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    MISSING+=("$v")
  fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "Missing required .env values: ${MISSING[*]}" >&2
  exit 1
fi

# --- Preflight ---------------------------------------------------------------
# Added 2026-08-10 after a from-nothing rebuild burned three full runs on
# problems that were all knowable in the first two seconds. A non-empty
# GITHUB_PAT is not the same as a WORKING one: an expired token got through the
# check above, then this script spent several minutes on policies, the SSH
# tunnel, the kubeconfig and a 38MB `gh` copy before dying at section 6 with
# "error validating token: HTTP 401" - an error that points at gh, not at
# .env, and leaves sections 7 and 8 (repos, agents, crons, all 16 gateway
# settings) silently undone.
#
# Everything here is cheap and read-only. Credential problems are FATAL,
# because nothing after section 4 works without them. Missing host binaries are
# warnings, matching what their own sections already do - you can bootstrap
# without them and add them later - but they are reported UP FRONT rather than
# 200 lines in, which is the whole point.
echo "=== Preflight ==="
PREFLIGHT_FATAL=0

check_pat() {
  local name="$1" raw="$2" trimmed code
  trimmed=$(printf '%s' "$raw" | tr -d ' \t\r\n')
  if [ "$trimmed" != "$raw" ]; then
    echo "  NOTE: $name has surrounding whitespace/newline in .env - tolerated here," \
         "but it has caused confusing auth failures elsewhere; worth cleaning up." >&2
  fi
  # --max-time so a DNS/network stall can't hang the whole bootstrap.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Authorization: Bearer $trimmed" https://api.github.com/user 2>/dev/null || echo "000")
  case "$code" in
    200) echo "  $name: valid" ;;
    401) echo "  $name: REJECTED by GitHub (401 Bad credentials) - the token is wrong," \
              "expired or revoked, not merely under-scoped. Fix it in .env before re-running;" \
              "everything from section 5 onward depends on it." >&2
         PREFLIGHT_FATAL=1 ;;
    403) echo "  $name: authenticated but 403 (scope or rate limit). Continuing - if the gh" \
              "auth or MCP steps fail later, this is why: a classic PAT with 'repo' scope is" \
              "what these need." >&2 ;;
    000) echo "  $name: could not reach api.github.com to validate (offline?). Continuing" \
              "unvalidated - a bad token will surface at section 5/6 as it always did." >&2 ;;
    *)   echo "  $name: unexpected HTTP $code from api.github.com. Continuing." >&2 ;;
  esac
}
check_pat GITHUB_PAT "$GITHUB_PAT"
# Checked separately and deliberately: it is frequently the SAME token, but when
# it is not, a bad one fails only at section 6's MCP registration.
[ "$GITHUB_MCP_PAT" = "$GITHUB_PAT" ] \
  && echo "  GITHUB_MCP_PAT: same token as GITHUB_PAT (fine, if its scope covers MCP)" \
  || check_pat GITHUB_MCP_PAT "$GITHUB_MCP_PAT"

# Host binaries this script copies INTO the sandbox rather than fetching from
# inside it (see their own sections for why). Missing ones are skipped later
# with a warning that is easy to scroll past; say it here too.
for _bin in gh kubectl; do
  if [ -f "$HOME/bin/$_bin" ]; then
    echo "  ~/bin/$_bin: present"
  else
    echo "  ~/bin/$_bin: MISSING - its deployment step will be skipped." \
         "See docs/operations.md Setup (arm64 release binary -> ~/bin/$_bin)." >&2
  fi
done

if [ "$PREFLIGHT_FATAL" -ne 0 ]; then
  echo "" >&2
  echo "Preflight failed - stopping before any changes are made. Nothing above this" >&2
  echo "point has touched the sandbox." >&2
  exit 1
fi
echo "Preflight OK"

# shellcheck source=scripts/lib/sandbox-helpers.sh
source "$SCRIPT_DIR/scripts/lib/sandbox-helpers.sh"
# shellcheck source=scripts/lib/gateway-config.sh
source "$SCRIPT_DIR/scripts/lib/gateway-config.sh"

echo "=== 0. Sandbox timezone (KST) ==="
# The image ships as Etc/UTC with TZ unset while the Server 6 host itself is
# already Asia/Seoul, so every watcher log line came out nine hours off for
# everyone reading it. Reported 2026-08-07. rendered/*/watcher.sh's log()
# uses date '+%Y-%m-%dT%H:%M:%S%z', which already prints an explicit offset -
# it was just rendering +0000 - so this needs no change to the scripts
# themselves, only to what the container thinks local time is.
#
# Deliberately ONLY the container's local time. The `date -u ...Z` call sites
# that write tracker/registry data are unaffected precisely because -u is
# explicit, and they MUST stay UTC: the dashboard sorts updated_at by raw
# string compare and Date.parse()s it, and watcher.sh's SINCE_TIME feeds
# `git log --since`. Localizing those would silently misorder every entry
# written before this change against every one written after. `date +%s`
# (pause/resume arithmetic, session-key suffixes) is timezone-independent
# either way, so it's untouched too.
#
# Set via /etc/localtime rather than a TZ env var because the watchers run
# from openclaw cron inside the sandbox and never source an interactive
# shell's profile - /etc/localtime applies to every process regardless of
# how it was started. Runs before everything else so anything the rest of
# this script logs is already in KST.
TZ_CONTAINER=$(container_name)
if [ -z "$TZ_CONTAINER" ]; then
  echo "WARNING: $SANDBOX container not running - skipping timezone setup, re-run this script once it is up" >&2
else
  docker exec -u root "$TZ_CONTAINER" ln -snf /usr/share/zoneinfo/Asia/Seoul /etc/localtime
  docker exec -u root "$TZ_CONTAINER" sh -c 'echo Asia/Seoul > /etc/timezone'
  echo "sandbox local time is now $(docker exec "$TZ_CONTAINER" date '+%Y-%m-%dT%H:%M:%S%z')"
fi

echo "=== 1. Network policies ==="
# Deliberately runs FIRST, before anything that tries to actually USE these
# policies (the SSH-access steps below) - both those steps include their
# own inline verification (an SSH/kubectl round-trip), and on a genuinely
# fresh onboard those round-trips fail with a network-policy-denial error
# if the relevant policy hasn't been applied yet. Confirmed the hard way:
# this exact ordering bug caused the Server 2 tunnel step's own check to
# fail on this feature's first real bootstrap.sh run (2026-07-21) - the
# tunnel self-healed a minute later once tunnel-keeper.sh's cron retried
# after the policy went live, but the in-script verification had already
# reported a false failure by then. Policies first avoids that entirely.
# policy-add exits 1 (not 0) when a named preset is already fully applied -
# harmless on a rerun, but fatal here under `set -e` without `|| true`.
nemoclaw "$SANDBOX" policy-add --from-file "$SCRIPT_DIR/policies/server2-k8s-tunnel.yaml" --yes || true
nemoclaw "$SANDBOX" policy-add --from-file "$SCRIPT_DIR/policies/git-remote-helper.yaml" --yes || true
# --trusted-private-host is REQUIRED as of nemoclaw v0.0.119 / OpenShell 0.0.106
# and is the only preset here that needs it: the vLLM endpoint is an RFC1918
# address, and a custom preset naming a private host is now rejected outright
# unless that exact host is explicitly trusted at apply time -
#   "Preset 'trading-vllm-shared-inference' endpoint host '192.168.0.30' is
#    rejected. Add explicit trust only for RFC1918, CGNAT, or IPv6 unique local
#    destinations."
# Caught on the 2026-09-04 upgrade from v0.0.109, where this silently left the
# sandbox unable to reach the model at all (the failure prints mid-run and the
# `|| true` below would otherwise swallow it). Keep this host in sync with
# scripts/lib/gateway-config.sh's baseUrl and the preset file itself - see that
# file's "update ALL THREE" note. The other three presets need no such flag;
# their endpoints are public.
nemoclaw "$SANDBOX" policy-add --from-file "$SCRIPT_DIR/policies/trading-vllm-shared-inference.yaml" \
  --trusted-private-host 192.168.0.30 --yes || true
nemoclaw "$SANDBOX" policy-add github --yes || true
# The built-in 'github' preset just above already allows github.com/
# api.github.com, but only for /usr/bin/git (binary-aware enforcement) - gh
# itself needs its own grant for the same hosts. Confirmed live 2026-08-03:
# without this, 'gh auth login --with-token' in Step 5 below fails with a
# 403 network-policy denial against api.github.com.
nemoclaw "$SANDBOX" policy-add --from-file "$SCRIPT_DIR/policies/gh-cli.yaml" --yes || true

echo "=== 2. SSH tunnel + kubeconfig access to Server 2 (k3s, read-only) ==="
# The tunnel-only keypair, the Server-2-side authorized_keys restriction,
# and the RBAC ServiceAccount/token are one-time, human-run setup - see
# docs/operations.md's "Server 2 (k3s) access" section and k8s/README.md. This
# section only redeploys what lives inside the sandbox itself (private key,
# kubeconfig, kubectl binary, ssh config, the tunnel watchdog + its cron),
# none of which survives a rebuild. Optional/skips gracefully if
# K8S_SA_TOKEN/K3S_CA_B64 aren't in .env yet - once they are, re-run this
# script to pick them up; nothing else in bootstrap.sh depends on this step.
if [ -z "${K8S_SA_TOKEN:-}" ] || [ -z "${K3S_CA_B64:-}" ]; then
  echo "K8S_SA_TOKEN/K3S_CA_B64 not set in .env - skipping Server 2 setup (see k8s/README.md to provision them, then re-run this script)"
else
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "Could not find the running $SANDBOX container - is the sandbox up?" >&2
    exit 1
  fi
  nemoclaw "$SANDBOX" exec -- mkdir -p /sandbox/.ssh /sandbox/.kube /sandbox/.local/bin

  if [ ! -f ~/.ssh/ops-nemoclaw-to-server2 ]; then
    echo "WARNING: ~/.ssh/ops-nemoclaw-to-server2 not found on this host - generate it first (see docs/operations.md Setup), skipping Server 2 key deployment" >&2
  else
    docker cp ~/.ssh/ops-nemoclaw-to-server2 "$CONTAINER:/sandbox/.ssh/server2"
    docker exec -u root "$CONTAINER" chown sandbox:sandbox /sandbox/.ssh/server2
    docker exec -u root "$CONTAINER" chmod 600 /sandbox/.ssh/server2
  fi
  docker cp "$SCRIPT_DIR/scripts/connect-proxy.py" "$CONTAINER:/sandbox/.ssh/connect-proxy.py"
  docker cp "$SCRIPT_DIR/ssh/config-ops-nemoclaw" "$CONTAINER:/sandbox/.ssh/config"
  docker exec -u root "$CONTAINER" chown -R sandbox:sandbox /sandbox/.ssh
  docker exec -u root "$CONTAINER" chmod 700 /sandbox/.ssh
  docker exec -u root "$CONTAINER" chmod 600 /sandbox/.ssh/config
  docker exec -u root "$CONTAINER" chmod 644 /sandbox/.ssh/connect-proxy.py

  echo "--- kubectl binary (arm64 static, pre-downloaded onto this host - see docs/operations.md Setup) ---"
  if [ ! -f ~/bin/kubectl ]; then
    echo "WARNING: ~/bin/kubectl not found on this host - download the arm64 kubectl matching the cluster's v1.36.x first, skipping kubectl deployment" >&2
  else
    docker cp ~/bin/kubectl "$CONTAINER:/sandbox/.local/bin/kubectl"
    docker exec -u root "$CONTAINER" chown sandbox:sandbox /sandbox/.local/bin/kubectl
    docker exec -u root "$CONTAINER" chmod 755 /sandbox/.local/bin/kubectl
  fi

  echo "--- kubeconfig (rendered from .env values - never committed rendered) ---"
  RENDERED_KUBECONFIG=$(mktemp)
  python3 "$SCRIPT_DIR/scripts/render-template.py" "$SCRIPT_DIR/kube/config-server2.tmpl" "$RENDERED_KUBECONFIG" \
    "K3S_CA_B64=$K3S_CA_B64" "K8S_SA_TOKEN=$K8S_SA_TOKEN"
  docker cp "$RENDERED_KUBECONFIG" "$CONTAINER:/sandbox/.kube/config"
  rm -f "$RENDERED_KUBECONFIG"
  docker exec -u root "$CONTAINER" chown sandbox:sandbox /sandbox/.kube/config
  docker exec -u root "$CONTAINER" chmod 600 /sandbox/.kube/config

  echo "--- tunnel-keeper.sh + its cron (every 1m, --no-deliver) ---"
  nemoclaw "$SANDBOX" exec -- mkdir -p /sandbox/pilot-state
  docker cp "$SCRIPT_DIR/scripts/tunnel-keeper.sh" "$CONTAINER:/sandbox/pilot-state/tunnel-keeper.sh"
  docker exec -u root "$CONTAINER" chown sandbox:sandbox /sandbox/pilot-state/tunnel-keeper.sh
  docker exec -u root "$CONTAINER" chmod 700 /sandbox/pilot-state/tunnel-keeper.sh
  if cron_job_exists "server2-tunnel-keeper"; then
    echo "server2-tunnel-keeper cron already present, skipping add"
  else
    nemoclaw "$SANDBOX" exec -- openclaw cron add --name "server2-tunnel-keeper" --every 1m \
      --command "bash /sandbox/pilot-state/tunnel-keeper.sh" --no-deliver
  fi

  echo "Verifying the tunnel-only key rejects command execution (expected)..."
  nemoclaw "$SANDBOX" exec -- ssh -o BatchMode=yes -o ConnectTimeout=15 server2 "whoami" >/dev/null 2>&1 \
    && echo "WARNING: server2 key accepted a command - the authorized_keys restriction needs attention" \
    || echo "server2 command-exec correctly rejected (expected)"

  echo "Triggering the tunnel once and verifying kubectl reaches the cluster read-only..."
  nemoclaw "$SANDBOX" exec -- bash /sandbox/pilot-state/tunnel-keeper.sh || true
  nemoclaw "$SANDBOX" exec -- /sandbox/.local/bin/kubectl --kubeconfig=/sandbox/.kube/config get pods -n dev \
    && echo "server2 k8s tunnel check OK" \
    || echo "WARNING: server2 k8s tunnel/kubectl check failed - key, RBAC, kubeconfig, tunnel, or firewall may need attention"
fi

echo "=== 3. Main agent identity/user workspace files ==="
# Without this, a fresh onboard leaves IDENTITY.md/USER.md as OpenClaw's
# generic blank templates (agents.defaults.skipBootstrap=true suppresses the
# interactive identity-setup turn that would otherwise fill these in - see
# NemoClaw's own seed_default_workspace_templates() for why they exist at
# all but stay unfilled). These two are hand-written for this instance
# specifically (team-facing bot, not a single-user profile) - see workspace/
# in this repo for the source of truth; don't hand-edit the deployed copies
# directly, re-run this step instead.
CONTAINER=$(container_name)
docker cp "$SCRIPT_DIR/workspace/IDENTITY.md" "$CONTAINER:/sandbox/.openclaw/workspace/IDENTITY.md"
docker cp "$SCRIPT_DIR/workspace/USER.md" "$CONTAINER:/sandbox/.openclaw/workspace/USER.md"
docker exec -u root "$CONTAINER" chown sandbox:sandbox /sandbox/.openclaw/workspace/IDENTITY.md /sandbox/.openclaw/workspace/USER.md
docker exec -u root "$CONTAINER" chmod 660 /sandbox/.openclaw/workspace/IDENTITY.md /sandbox/.openclaw/workspace/USER.md

echo "=== 4. This repo's own clone (so the registry-driven scripts are available in-sandbox) ==="
nemoclaw "$SANDBOX" exec -- mkdir -p /sandbox/repos
nemoclaw "$SANDBOX" exec -- git config --global credential.helper store
nemoclaw "$SANDBOX" exec -- git config --global user.name "NemoClaw Agent"
nemoclaw "$SANDBOX" exec -- git config --global user.email "ops-nemoclaw-agent@server6.local"
nemoclaw "$SANDBOX" exec -- bash -c "cd /sandbox && git clone https://${GITHUB_USERNAME}:${GITHUB_PAT}@github.com/enayuso/nemoclaw-project.git" \
  || echo "WARNING: git clone failed, or the repo directory already exists (fine if this is a re-run)"

echo "--- Keep that clone synced automatically (every merge to main here should reach the" \
     "sandbox without a human remembering to git pull it - this clone is a read-only" \
     "reference copy for the agent, never a place real work gets committed, so a hard reset" \
     "to origin/main on every cycle is safe) ---"
if cron_job_exists "nemoclaw-project-repo-sync"; then
  echo "nemoclaw-project-repo-sync cron already present, skipping add"
else
  nemoclaw "$SANDBOX" exec -- openclaw cron add --name "nemoclaw-project-repo-sync" --every 10m \
    --command "cd /sandbox/nemoclaw-project && git fetch origin && git reset --hard origin/main" --no-deliver
fi

echo "=== 5. GitHub CLI (gh) ==="
# gh itself, plus its authenticated login, both worked before (see
# TOOLS.md's own "gh needs to be authenticated" reminder, written when this
# was already working) but were never codified anywhere - a real, confirmed
# gap discovered 2026-07-23 when a write-capable agent tried to open a PR
# and found gh simply absent, with `apt install` correctly denied to the
# unprivileged sandbox user (that denial is correct/intentional - it
# should not have root). The actual gap was that nobody had ever scripted
# the *human-run, root-level* reinstall this needs, so it silently didn't
# survive whatever full container rebuild also took out kubectl/tunnel/
# kubeconfig around 2026-07-22 (Server 5 decommission - see this file's own
# header). Same "pre-download onto this host first, avoid a new egress
# policy just to curl a release binary from inside the sandbox" reasoning
# already used for kubectl (below) and connect-proxy.py.
#
# Installed to /usr/local/bin (already on the sandbox's PATH, confirmed
# 2026-07-23) rather than /sandbox/.local/bin the way kubectl is - kubectl
# already had that placement from an earlier, separate decision and fixing
# every agent-facing doc to always use its full path was cheaper than
# moving it; no reason to repeat that same PATH gotcha here when this is
# being set up fresh.
if [ ! -f ~/bin/gh ]; then
  echo "WARNING: ~/bin/gh not found on this host - download the linux_arm64 gh release tarball" >&2
  echo "  from https://github.com/cli/cli/releases, extract it, and cp its bin/gh to ~/bin/gh" >&2
  echo "  first - skipping gh install/auth" >&2
else
  CONTAINER=$(container_name)
  docker cp ~/bin/gh "$CONTAINER:/usr/local/bin/gh"
  docker exec -u root "$CONTAINER" chown root:root /usr/local/bin/gh
  docker exec -u root "$CONTAINER" chmod 755 /usr/local/bin/gh

  # gh stores its credential under $XDG_CONFIG_HOME, and this sandbox sets that
  # to /tmp/.config - so by default the login lands on ephemeral storage and is
  # lost whenever /tmp is cleared, with no signal until something tries to open
  # a PR and fails. Symlink the ephemeral path at the persistent one so gh finds
  # it by its OWN default lookup: the agent never sets GH_CONFIG_DIR and
  # shouldn't have to know about any of this. Confirmed live 2026-08-12 that a
  # plain `gh auth status`, a real `gh api` call, and the agent's own login-shell
  # context all resolve through the link.
  nemoclaw "$SANDBOX" exec -- sh -c 'mkdir -p /sandbox/.config/gh /tmp/.config
    if [ ! -L /tmp/.config/gh ]; then
      [ -d /tmp/.config/gh ] && cp -a /tmp/.config/gh/. /sandbox/.config/gh/ 2>/dev/null || true
      rm -rf /tmp/.config/gh
      ln -s /sandbox/.config/gh /tmp/.config/gh
    fi' || echo "WARNING: could not persist gh config dir - a /tmp clear will silently drop the gh login"

  if nemoclaw "$SANDBOX" exec -- gh auth status >/dev/null 2>&1; then
    echo "gh already authenticated, skipping login"
  else
    nemoclaw "$SANDBOX" exec -- bash -c "gh auth login --with-token <<< '$GITHUB_PAT'"
    # Verify rather than assume. A failed login here is otherwise invisible:
    # it is not fatal to this script, and the next thing to notice is an agent
    # unable to open a PR at Stage 5 - which is exactly how this broke once
    # already (the login ran against a PAT that was still wrong at the time,
    # printed its own 401, and nothing downstream checked).
    if nemoclaw "$SANDBOX" exec -- gh auth status >/dev/null 2>&1; then
      echo "gh authenticated"
    else
      echo "WARNING: gh auth login did NOT take - agents will be unable to open PRs (Stage 5)." >&2
      echo "  Check GITHUB_PAT in .env has 'repo' scope, then re-run this script." >&2
    fi
  fi
fi

echo "=== 6. GitHub MCP server ==="
# The DNS patch has to be in place BEFORE `mcp add` below, because the pin
# is generated at registration time from whatever resolveHostAddresses
# returns. Register without it and you get a single-IP allowed_ips that
# denies ~5 of every 6 connections - see scripts/patch-nemoclaw-dns.sh for
# the full diagnosis. This patches the HOST's NemoClaw install rather than
# anything in the sandbox, so a sandbox rebuild does NOT disturb it and
# this is usually a no-op; it matters on the path where someone upgrades
# NemoClaw (which overwrites the patch) and later rebuilds, which would
# otherwise silently re-register MCP broken. Idempotent and cheap.
"$SCRIPT_DIR/scripts/patch-nemoclaw-dns.sh" || {
  echo "WARNING: could not apply the NemoClaw DNS patch - MCP will register with a" >&2
  echo "  single-IP pin and fail with ssrf denials. See scripts/patch-nemoclaw-dns.sh." >&2
}

# nemoclaw mcp add reads the credential from THIS shell's live environment -
# it's already exported via `set -a` + sourcing .env above.
if nemoclaw "$SANDBOX" mcp add github --url https://api.githubcopilot.com/mcp/ --env GITHUB_MCP_PAT; then
  : # ok
else
  echo "mcp add failed - if this is a re-run, a stale credential provider may already exist:"
  echo "  nemoclaw credentials reset github-mcp --yes"
  echo "then re-run this script."
fi
nemoclaw "$SANDBOX" exec -- openclaw mcp add github --url https://api.githubcopilot.com/mcp/ \
  --transport streamable-http --header "Authorization=Bearer openshell:resolve:env:GITHUB_MCP_PAT" --no-probe
# Deliberately NO explicit restart here - an explicit restart issued
# immediately after this MCP registration raced whatever in-flight setup it
# triggers and killed the gateway outright (reproduced 2026-07-21). This
# hot-reloads on its own, same as the config-touching steps in Step 8
# (Security hardening, below).
# The advice here used to be "fix with: mcp restart github". That was wrong,
# and cost real downtime on 2026-08-05: restart re-resolves and re-pins, but
# api.githubcopilot.com hands back ONE rotating A record per query out of
# 140.82.{112,113,114}.{21,22}, so restarting only re-rolls which ~1-in-6
# connections would have been allowed. It can appear to "work" once and then
# fail again minutes later, which is exactly what made it look like a
# transient for weeks.
echo "If the MCP connection later shows an SSRF/403 denial in logs, the pinned allowlist has"
echo "gone stale against GitHub's rotating IPs. Do NOT just 'mcp restart' - that re-rolls the"
echo "pin without widening it. Run: ./scripts/patch-nemoclaw-dns.sh --check"
echo "then, if it reports the patch missing, ./scripts/patch-nemoclaw-dns.sh and re-register."

echo "=== 7. Registered repos (data-driven) ==="
# Same idempotent shape as the agent-workspace loops elsewhere in this
# project, just driven by registry/repos.json instead of a literal bash
# array. Empty registry ({}) means this is a no-op today.
REGISTRY_JSON="$SCRIPT_DIR/registry/repos.json"
CONTAINER=$(container_name)
nemoclaw "$SANDBOX" exec -- mkdir -p /sandbox/pilot-state
docker cp "$REGISTRY_JSON" "$CONTAINER:/sandbox/pilot-state/registry.json"
docker exec "$CONTAINER" mkdir -p /sandbox/pilot-state/lib
docker cp "$SCRIPT_DIR/scripts/lib/watcher-common.sh" "$CONTAINER:/sandbox/pilot-state/lib/watcher-common.sh"

for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
  echo "--- registered repo: $KEY ---"
  CLONE_URL=$(jq -r --arg k "$KEY" '.[$k].clone_url' "$REGISTRY_JSON")
  REPO_NAME=$(basename "$CLONE_URL" .git)
  CLONE_URL_NO_SCHEME="${CLONE_URL#https://}"
  ESCALATION_AGENT="${KEY}-escalation"
  REVIEWER_AGENT="${KEY}-reviewer"

  nemoclaw "$SANDBOX" exec -- bash -c "cd /sandbox/repos && git clone https://${GITHUB_USERNAME}:${GITHUB_PAT}@${CLONE_URL_NO_SCHEME}" \
    || echo "WARNING: git clone for $KEY failed, or the repo directory already exists (fine if this is a re-run)"

  # Pin OpenShell's CA bundle in the clone's OWN git config, not just via the
  # GIT_SSL_CAINFO env var the container already exports. Egress goes through
  # OpenShell's TLS-intercepting proxy, so git must trust that CA - and the env
  # var does NOT reach the agents. Confirmed empirically 2026-09-04: `nemoclaw
  # exec` inherits it and fetches fine, but the OpenClaw agents' own exec tool
  # does not, so every escalation agent's Stage 0 died with
  #   "server verification failed: certificate signer not trusted.
  #    (CAfile: /etc/ssl/certs/ca-certificates.crt)"
  # - the system bundle, i.e. git never saw GIT_SSL_CAINFO at all. Found by a
  # post-upgrade smoke test, after the retry loop correctly reported
  # "FETCH FAILED 3x" three times in a row for a reason that was not transient.
  # Reproduced exactly with `env -u GIT_SSL_CAINFO git fetch`, and fixed by this
  # line: with the CA in git config, the same stripped-env fetch succeeds.
  # Per-clone rather than --global because the agent's exec and `nemoclaw exec`
  # do not necessarily run as the same user, and a repo-local setting cannot be
  # missed by whichever one does.
  nemoclaw "$SANDBOX" exec -- bash -c "git -C /sandbox/repos/${REPO_NAME} config http.sslCAInfo /etc/openshell-tls/ca-bundle.pem" \
    || echo "WARNING: could not pin http.sslCAInfo for $KEY - its agent's Stage 0 git fetch will fail with a cert error"

  CONTAINER=$(container_name)
  # Guard against a cascading crash when the clone above failed (bad/expired
  # credential, etc.) - .git/hooks won't exist in that case, and docker cp
  # into a missing directory is a hard, unforgiving error under `set -e`
  # that would kill the rest of this script for every other step below it,
  # not just this one repo. The clone failure itself is already tolerated
  # and warned about above; this should degrade the same way, not escalate.
  if [ -f "$SCRIPT_DIR/rendered/$KEY/pre-push-hook.sh" ]; then
    if docker exec "$CONTAINER" test -d "/sandbox/repos/${REPO_NAME}/.git/hooks" 2>/dev/null; then
      docker cp "$SCRIPT_DIR/rendered/$KEY/pre-push-hook.sh" "$CONTAINER:/sandbox/repos/${REPO_NAME}/.git/hooks/pre-push"
      docker exec "$CONTAINER" chmod +x "/sandbox/repos/${REPO_NAME}/.git/hooks/pre-push"
    else
      echo "WARNING: /sandbox/repos/${REPO_NAME}/.git/hooks missing (clone above likely failed) - skipping pre-push hook install for $KEY, fix the credential and re-run"
    fi
  fi

  if [ -f "$SCRIPT_DIR/rendered/$KEY/watcher.sh" ]; then
    docker cp "$SCRIPT_DIR/rendered/$KEY/watcher.sh" "$CONTAINER:/sandbox/pilot-state/${KEY}-watcher.sh"
    docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/${KEY}-watcher.sh"
    docker exec -u root "$CONTAINER" chmod 700 "/sandbox/pilot-state/${KEY}-watcher.sh"
  fi

  if cron_job_exists "${KEY}-watcher"; then
    echo "${KEY}-watcher cron already present, skipping add"
  else
    # --no-deliver: see the matching comment in register-repo.sh
    nemoclaw "$SANDBOX" exec -- openclaw cron add --name "${KEY}-watcher" --every "$WATCHER_CRON_EVERY" \
      --command "bash /sandbox/pilot-state/${KEY}-watcher.sh" --no-deliver
  fi

  for agent in "$ESCALATION_AGENT" "$REVIEWER_AGENT"; do
    if nemoclaw "$SANDBOX" exec -- test -d "/sandbox/.openclaw/agents/$agent/workspace" 2>/dev/null; then
      echo "$agent workspace already exists, skipping 'agents add'"
    else
      MODEL=$(jq -r --arg k "$KEY" '.[$k].model' "$REGISTRY_JSON")
      nemoclaw "$SANDBOX" exec -- openclaw agents add "$agent" \
        --workspace "/sandbox/.openclaw/agents/$agent/workspace" \
        --model "$MODEL" --non-interactive
    fi
  done
  CONTAINER=$(container_name)
  if [ -f "$SCRIPT_DIR/rendered/$KEY/escalation-AGENTS.md" ]; then
    docker cp "$SCRIPT_DIR/rendered/$KEY/escalation-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace/AGENTS.md"
    docker cp "$SCRIPT_DIR/rendered/$KEY/escalation-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace/TOOLS.md"
    docker cp "$SCRIPT_DIR/rendered/$KEY/reviewer-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace/AGENTS.md"
    docker cp "$SCRIPT_DIR/rendered/$KEY/reviewer-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace/TOOLS.md"
    docker exec -u root "$CONTAINER" chown -R sandbox:sandbox "/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace" "/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace"
  fi

  # --- PR review (2026-08-12) ---------------------------------------------
  #
  # Only for repos with the flag on. Raw jq read + bash-side default, never
  # `// false`, for the same reason every other boolean here does it that
  # way - see templates/pr-watcher.sh.tmpl's own comment.
  #
  # This block is the whole reason PR review survives a rebuild. Everything
  # it sets up (the agent, its docs, the script, the cron) lives under
  # /sandbox, and nothing under /sandbox outside .openclaw survives one -
  # a hand-applied setup would silently vanish, which is exactly how the
  # sessions_send config was lost for a week.
  PR_REVIEW_ENABLED=$(jq -r --arg k "$KEY" '.[$k].pr_review_enabled' "$REGISTRY_JSON" 2>/dev/null || echo null)
  [ "$PR_REVIEW_ENABLED" = "null" ] && PR_REVIEW_ENABLED="false"
  if [ "$PR_REVIEW_ENABLED" = "true" ]; then
    PR_REVIEWER_AGENT="${KEY}-pr-reviewer"
    if nemoclaw "$SANDBOX" exec -- test -d "/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace" 2>/dev/null; then
      echo "$PR_REVIEWER_AGENT workspace already exists, skipping 'agents add'"
    else
      MODEL=$(jq -r --arg k "$KEY" '.[$k].model' "$REGISTRY_JSON")
      nemoclaw "$SANDBOX" exec -- openclaw agents add "$PR_REVIEWER_AGENT" \
        --workspace "/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace" \
        --model "$MODEL" --non-interactive
    fi

    CONTAINER=$(container_name)
    if [ -f "$SCRIPT_DIR/rendered/$KEY/pr-watcher.sh" ]; then
      docker cp "$SCRIPT_DIR/rendered/$KEY/pr-watcher.sh" "$CONTAINER:/sandbox/pilot-state/${KEY}-pr-watcher.sh"
      docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/${KEY}-pr-watcher.sh"
      docker exec -u root "$CONTAINER" chmod 700 "/sandbox/pilot-state/${KEY}-pr-watcher.sh"
    fi
    if [ -f "$SCRIPT_DIR/rendered/$KEY/pr-reviewer-AGENTS.md" ]; then
      docker cp "$SCRIPT_DIR/rendered/$KEY/pr-reviewer-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace/AGENTS.md"
      docker cp "$SCRIPT_DIR/rendered/$KEY/pr-reviewer-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace/TOOLS.md"
      docker exec -u root "$CONTAINER" chown -R sandbox:sandbox "/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace"
    fi

    if cron_job_exists "${KEY}-pr-watcher"; then
      echo "${KEY}-pr-watcher cron already present, skipping add"
    else
      nemoclaw "$SANDBOX" exec -- openclaw cron add --name "${KEY}-pr-watcher" --every "$PR_WATCHER_CRON_EVERY" \
        --command "bash /sandbox/pilot-state/${KEY}-pr-watcher.sh" --no-deliver
    fi
  fi
done

echo "=== 8. Security hardening (from the original security-audit pass, 2026-07-20) ==="
# The settings themselves live in scripts/lib/gateway-config.sh, NOT here.
# That file is shared verbatim with scripts/check-config-drift.sh, so the
# drift checker compares against exactly what this script applies rather than
# against a hand-maintained second copy. Add new settings there, not here.
#
# Applying is deliberately tolerant: a single failed `config set` should not
# abort the rest of bootstrap under `set -e`, the same way section 7's
# per-repo clone failure is warned about rather than escalated. Anything that
# fails to apply gets reported by the drift checker afterwards, which is a
# better place to notice it than a half-finished bootstrap.
note() { echo "$@"; }
set_config() {
  local path="$1"; shift
  nemoclaw "$SANDBOX" exec -- openclaw config set "$path" "$@" \
    || echo "WARNING: could not set $path - run ./scripts/check-config-drift.sh afterwards to see what is missing"
}
# Counterpart for keys whose ABSENCE is the intended state - an onboard default
# we do not want. `openclaw config unset` exits nonzero with "Config path not
# found" once the key is already gone, which is the normal case on every re-run,
# so that specific outcome is success here rather than a warning.
unset_config() {
  local path="$1"
  local out
  if out=$(nemoclaw "$SANDBOX" exec -- openclaw config unset "$path" 2>&1); then
    echo "  unset $path"
  elif printf '%s' "$out" | grep -q "Config path not found"; then
    echo "  unset $path (already absent)"
  else
    echo "WARNING: could not unset $path - run ./scripts/check-config-drift.sh afterwards"
  fi
}
gateway_config_settings

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "plugins.allow deliberately NOT set - see docs/operations.md's 'Known gotchas'. The config-set-then-restart"
echo "path that killed the gateway on v0.0.81/2026.6.10 was retested 2026-09-04 on v0.0.119/2026.7.1"
echo "and did NOT reproduce (health held for 6 min after restart). But that retest wrote an IDENTICAL"
echo "value, so a semantically changed allow list - which would load/unload a plugin - is still"
echo "untested and is the likelier trigger. Narrowed, not lifted; bootstrap still leaves it alone."
echo "Verify config matches intent (should be clean immediately after this script"
echo "plus a gateway restart - anything it reports is either a setting that failed"
echo "to apply above, or live state someone changed by hand):"
echo "                        ./scripts/check-config-drift.sh"
echo "Verify: nemoclaw $SANDBOX doctor"
echo "Verify MCP:             nemoclaw $SANDBOX mcp status github"
echo ""
echo "Verify the k8s access boundary (full checklist, see docs/k8s-migration-architecture.md"
echo "section 7 - that's the source of truth, keep these two in sync):"
KCTL="nemoclaw $SANDBOX exec -- /sandbox/.local/bin/kubectl --kubeconfig=/sandbox/.kube/config"
echo "  must return real pods:  $KCTL get pods -n dev"
echo "  must be Forbidden:      $KCTL get secrets -A"
echo "  must be Forbidden:      $KCTL exec <any-pod-from-above> -n dev -- true"
echo "  must be 'no':           $KCTL auth can-i create deployments -A"
echo "  must be Forbidden:      $KCTL delete pod xyz -n dev --dry-run=server"
echo "  must be rejected (key is transport-only):"
echo "                          nemoclaw $SANDBOX exec -- ssh server2 whoami"
echo "  must fail/hang (only the ssh tunnel path is allowed, direct HTTPS to the k3s API is"
echo "  network-policy-denied):"
echo "                          nemoclaw $SANDBOX exec -- curl -sk --connect-timeout 5 https://203.0.113.10:6443/"
echo ""
echo "Verify security:        nemoclaw $SANDBOX exec -- openclaw security audit  (expect 0 critical; the file-permission"
echo "                        findings below are expected to still show up until the chmod pass just below runs, and"
echo "                        will resurface again the next time ANY config gets touched after this script finishes -"
echo "                        that's a known, accepted limitation, not a bug in this script)"
echo ""
echo "The actual proof of Phase 6 (docs/k8s-migration-architecture.md) is destroying and rebuilding this sandbox,"
echo "then re-running this script and confirming every check above still passes with zero manual memory beyond the"
echo "one-time human-run steps in docs/operations.md's Setup section. That destroy/rebuild is real, disruptive, and has to be"
echo "run by you, live - not something this repo's tooling (or an AI agent) can do or has done on your behalf."
echo ""
echo "File-permission hardening - MUST be the LAST step, after all config-touching work above (the running gateway"
echo "resets these to the platform default on every config write, so doing this earlier wouldn't stick):"
nemoclaw "$SANDBOX" exec -- chmod 600 /sandbox/.openclaw/openclaw.json
nemoclaw "$SANDBOX" exec -- chmod 700 /sandbox/.openclaw/credentials
nemoclaw "$SANDBOX" exec -- chmod 700 /sandbox/.openclaw
nemoclaw "$SANDBOX" exec -- chmod 600 /sandbox/.openclaw/agents/main/sessions/sessions.json
# Every registered repo's escalation/reviewer agents get their own
# sessions.json too - missing here until 2026-07-22 (this loop only covered
# the main agent), which is exactly why `openclaw security audit` kept
# flagging api-rag-escalation's sessions.json as group/other-readable even
# right after a "clean" hardening pass: it was never touched at all, not a
# permissions-reset race like the other findings this section's intro
# comment already explains. $REGISTRY_JSON is still in scope from section 8
# above (same flat script, no subshell). Silently no-ops on repos that
# haven't produced a sessions.json yet (chmod on a nonexistent path just
# fails harmlessly here, same tolerance as the rest of this pass).
for KEY in $(jq -r 'keys[]' "$REGISTRY_JSON"); do
  nemoclaw "$SANDBOX" exec -- chmod 600 "/sandbox/.openclaw/agents/${KEY}-escalation/sessions/sessions.json" || true
  nemoclaw "$SANDBOX" exec -- chmod 600 "/sandbox/.openclaw/agents/${KEY}-reviewer/sessions/sessions.json" || true
done
echo "Done. If you (or an agent) touch any config after this point in the same session, re-run this hardening pass"
echo "again afterward - see docs/operations.md's 'Known gotchas' for why this doesn't stay durable on its own."
