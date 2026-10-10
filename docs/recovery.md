# Recovery: rebuilding or upgrading ops-nemoclaw on Server 6

Written 2026-08-10, after a host reset wiped `/home/ops-s006` entirely.
Extended 2026-09-04 with the in-place upgrade path.

operations.md's "Setup" section is the authority for *what* each step does and why —
this file is the ordered checklist for actually doing it under recovery
conditions, plus the things that only matter when you're rebuilding rather than
installing fresh.

Two different jobs live here, so start in the right place:

- **Rebuilding from nothing** (host reset, `/home` wipe, no sandbox): Part 1
  onwards, in order.
- **Bumping the nemoclaw/OpenShell version on a working instance**: jump to
  [Upgrading in place](#upgrading-in-place-a-version-bump-not-a-rebuild). Do
  **not** treat that as a subset of a rebuild — it has its own pre-flight, and
  skipping it destroyed a working sandbox on 2026-09-04.

## What a `/home` wipe actually destroys

Verified on the 2026-08-10 reset:

| Gone | Survived |
|---|---|
| `ops-nemoclaw` container (no stopped copy, no volumes) | `/etc/systemd/system/nemoclaw-dashboard.service` |
| `~/.local/bin/nemoclaw` (the CLI) | docker, git, jq, curl, system node |
| `~/.nvm` — node 22, which the CLI ran on | `/etc/ssh` host keys (SSH fingerprint unchanged) |
| `~/nemoclaw-project` (the repo clone) | Server 2's k8s RBAC (cluster-side, not on this host) |
| `~/.ssh` — including the Server 2 tunnel keypair | Server 4's LLM (separate host) |
| `dashboard/.env` — **all dashboard secrets, unrecoverable** | GitHub remote (everything was pushed) |
| `.env` — GitHub PAT, k8s SA token | `~/.npm` cache |

**The dashboard service will report `active` and be lying.** Its process keeps
running out of the deleted directory and retries a dead gateway every 30s. Stop
it first so it isn't confusing you for the rest of the rebuild.

## Order matters

`dashboard/.env` needs a gateway token that doesn't exist until the sandbox is
built, and `.env` lives inside the clone. So the real order is: clone → sandbox
→ bootstrap → dashboard. (operations.md lists `.env` as step 1, which reads oddly for a
rebuild — you cannot create it before step 5 has cloned the repo it lives in.)

---

## Part 1 — yours

Every step here either handles a real secret or is interactive. Per this repo's
standing rule (see `bootstrap.sh`'s header and `.env.example`), these are run by
a human in their own terminal, not by an agent — that's what keeps raw
credentials out of a tool-call transcript.

### 1. Stop the zombie dashboard
```
sudo systemctl stop nemoclaw-dashboard
```

### 2. Reinstall the nemoclaw CLI

**This was undocumented until the 2026-08-10 rebuild** — operations.md opens at
`nemoclaw onboard` and assumes the CLI already exists. It's NVIDIA's own script:
```
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```
Installs to `~/.local/bin/nemoclaw`, and brings no node of its own — it uses
whatever is on PATH. Two things changed across this rebuild; suspect both first
if anything behaves oddly later:

- **version**: pre-reset v0.0.90, post-reset **v0.0.103**. A nemoclaw upgrade has
  already silently destroyed sandbox config once (the v0.0.81 → v0.0.90 jump is
  what ate the `sessions_send` settings), which is why the drift check in Part 2
  is doing real work rather than ceremony.
- **node**: it used to run on nvm's node v22.23.1, which died with `~/.nvm`; it
  now runs on the **system node v18**. Fine so far, but a real difference from
  the environment everything else here was verified against.

The installer appends `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc`,
which an already-open shell has not read — so `nemoclaw: command not found`
immediately after a successful install just means you need `source ~/.bashrc`
(or a new login). A fresh SSH session picks it up automatically, which is why
this can look fine to one person and broken to another at the same moment.

Confirm before continuing:
```
node --version && nemoclaw --version
```

Note for anything non-interactive: `.bashrc` is only read by interactive
shells, so systemd/cron callers get no `~/.local/bin`. Both places that matter
already hardcode the full path (`dashboard/src/routes/ops.js`'s `NEMOCLAW_BIN`
and `scripts/check-config-drift.sh`'s fallback) — keep it that way.

### 3. Kill orphaned processes from the old install

**Do this before onboarding, or it fails on a port conflict that looks like
someone else's fault.** A `/home` wipe does not reboot the box, so the previous
install's processes keep running with their files deleted. On 2026-08-10 two
survived a six-day-old boot:

- `openshell-gateway[nemoclaw=nemoclaw-8180;port=8180]` (PPID 1) — still holding
  **the exact port the new gateway needs**, days after its sandbox container
  stopped existing, while `nemoclaw list` reported "No sandboxes registered".
- a `bash -c until docker exec openshell-ops-nemoclaw-<uuid> ...` tunnel-wait
  loop, polling a container long gone.

Plus the dashboard node process from step 1. Find and clear them:
```
ps -eo pid,lstart,args | grep -iE "openshell|nemoclaw" | grep -v grep
kill <pids>
ss -ltn | grep -E ':(8180|18789) '     # expect no output before continuing
```
The trap is the error you get without this: with `NEMOCLAW_GATEWAY_PORT` unset,
onboard defaults to 8080 and reports the conflict against **Jenkins**, sending
you after a process that is not the problem. Jenkins is fine where it is.

### 4. Stand up the sandbox
```
NEMOCLAW_GATEWAY_PORT=8180 nemoclaw onboard --name ops-nemoclaw --yes-i-accept-third-party-software
```
`NEMOCLAW_GATEWAY_PORT=8180` is mandatory, not optional — Jenkins owns 8080.
Interactive answers are in operations.md Setup step 2 (OpenClaw / OpenAI-compatible
endpoint / no web search / no channels / no profile / Balanced tier + the six
listed presets — do **not** hand-pick `github`, `server2-k8s-tunnel`,
`git-remote-helper` or `mcp-bridge-github`; `bootstrap.sh` adds those).

**Inference endpoint — enter the PUBLIC address here, not the LAN one.**
The backend is Server 5's vLLM serving `nvidia/Qwen3.6-35B-A3B-NVFP4`, reachable
two ways, both live (verified 2026-09-04):

| address | use it for |
| --- | --- |
| `http://203.0.113.10:11511/v1` | **onboarding, and NemoClaw's recorded provider endpoint** |
| `http://192.168.0.30:11511/v1` | `gateway-config.sh`'s `baseUrl` and the network policy |

They are the same machine and both correct — the split is forced, not drift.
NemoClaw refuses a private address at this step (`endpoint-url is not allowed:
URL points to private/internal address`), so its own bookkeeping has to use the
public one; the LAN address is preferable everywhere it *is* accepted, because it
keeps inference traffic off the shared NAT that Servers 2/4/6 stall behind.

Any address that is dead here is not cosmetic: onboarding's step-7 smoke check
tests `https://inference.local/v1/models`, which the gateway forwards to the
recorded provider endpoint. On 2026-09-04 that endpoint still read
`203.0.113.10:11510` — right host, wrong port — so `inference.local` returned
503, and **every `nemoclaw rebuild` failed at step 7 and destroyed the sandbox**
before recreating it. Fix the provider without re-onboarding with:
```
openshell provider update compatible-endpoint \
  --config OPENAI_BASE_URL=http://203.0.113.10:11511/v1 --gateway nemoclaw-8180
```
(`--config` alone is a partial update and leaves `COMPATIBLE_API_KEY` intact;
`--from-existing` fails here, since there are no *local* credentials to re-discover.)

Previous values, all dead, listed so an old note is recognisable rather than
retried: `http://203.0.113.20:8093/v1` + `Qwen/Qwen3.6-35B-A3B-FP8` (original
July backend), `192.168.0.31:11510` (Server 6, pre-2026-08-04), and
`192.168.0.5:11510` (Server 4, pre-2026-09-01 — this one was still documented
here as "live" a month after the move).

Takes 3–8 minutes. Confirm with `nemoclaw ops-nemoclaw status`.

**`NEMOCLAW_GATEWAY_PORT=8180` is needed on EVERY nemoclaw command, not just
onboard.** Without it, `nemoclaw ops-nemoclaw status` reports
*"Sandbox 'ops-nemoclaw' does not exist. Run 'nemoclaw onboard'"* — on a
sandbox that is running perfectly — because it looked for a gateway on 8080 and
found Jenkins. This wasted time during the 2026-08-10 rebuild and reads as
catastrophic when it is nothing at all. Just export it for the session:
```
export NEMOCLAW_GATEWAY_PORT=8180
```
`bootstrap.sh` and `check-config-drift.sh` both set it internally, so this is
only for hand-run commands.

### 5. Re-establish Server 2 tunnel access

**Generate the keypair ON SERVER 6, not on Server 2.** Server 6 is the client
that opens the tunnel, so the private key lives there; only the `.pub` half goes
into `ops-s002`'s `authorized_keys` on Server 2. Doing it the other way round
(easy to slip into, since step 5.2 is performed while logged into Server 2)
leaves the private key on the destination and Server 6 with nothing.

The old private key died with `~/.ssh`, so this needs a **new keypair** — but
the cluster-side RBAC from `k8s/rbac-readonly.yaml` lives on Server 2 and
should have survived, so you likely only need operations.md Setup steps 3.1 and 3.2
(generate, then authorize on `ops-s002`), not the full RBAC re-apply. Re-extract
`K8S_SA_TOKEN` / `K3S_CA_B64` per `k8s/README.md` for the `.env` below —
the values may be unchanged, but your copy of them is gone.

Keep the forced-command prefix exactly as documented: the leading
`command="/bin/false"` is what actually blocks command execution, not `restrict`.

### 6. Re-download the two host binaries

`bootstrap.sh` copies both INTO the sandbox from the host rather than curling
them from inside it (avoids opening an egress policy just to fetch a release
binary). Both are skipped with a warning if absent, so their steps silently
do nothing:

```
mkdir -p ~/bin
# gh - latest linux_arm64
V=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name)
curl -fsSL "https://github.com/cli/cli/releases/download/${V}/gh_${V#v}_linux_arm64.tar.gz" | tar -xz -C /tmp
cp "/tmp/gh_${V#v}_linux_arm64/bin/gh" ~/bin/gh && chmod 755 ~/bin/gh
# kubectl - must match the cluster's v1.36.x
curl -fsSL -o ~/bin/kubectl https://dl.k8s.io/release/v1.36.0/bin/linux/arm64/kubectl && chmod 755 ~/bin/kubectl
```
Confirm with `~/bin/gh --version` and `~/bin/kubectl version --client`.
`~/bin` is deliberately NOT on PATH — bootstrap reads both by absolute path.

### 7. Re-clone the repo and rebuild `.env`
```
cd ~ && git clone https://github.com/enayuso/nemoclaw-project.git
```
The clone prompts for a password: **that prompt wants a PAT, not your GitHub
account password.** GitHub disabled password auth for git in 2021, and the
resulting error ("Invalid username or token") reads like a typo. Do NOT work
around it by putting the token in the URL — that writes it into shell history.

Then `cp .env.example .env` and fill in: `GITHUB_USERNAME`, `GITHUB_PAT`,
`GITHUB_MCP_PAT` (classic, not fine-grained — classic gets scope-based tool
filtering from the MCP server), `K8S_SA_TOKEN`, `K3S_CA_B64`.

**Use the same token you just cloned with.** On 2026-08-10 a different (stale)
token went into `.env` and cost a full bootstrap run; `bootstrap.sh`'s preflight
now catches this in seconds, but only if you let it. Self-check any time,
without echoing the secret:
```
T=$(grep -E '^GITHUB_PAT=' .env | cut -d= -f2- | tr -d ' \t\r\n')
echo "PAT -> http $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" https://api.github.com/user)"
```
`200` is what you want. `401` means wrong/expired/revoked, not under-scoped.

**Then give the host clone stored credentials, or every later `git pull` fails.**
Cloning interactively authenticates once and stores nothing, so the deploy loop
(`git pull --ff-only` on Server 6) dies with *"could not read Username"*. This
clone is NOT covered by `scripts/rotate-credentials.sh`, which handles the
sandbox clones only — the same "a clone outside the covered set gets silently
orphaned" trap that script's own header documents, hit for a third time:
```
U=$(grep -E '^GITHUB_USERNAME=' .env | cut -d= -f2- | tr -d ' \t\r\n')
P=$(grep -E '^GITHUB_PAT=' .env | cut -d= -f2- | tr -d ' \t\r\n')
git remote set-url origin "https://${U}:${P}@github.com/enayuso/nemoclaw-project.git"
git pull --ff-only
```
Reads the secret from `.env` into a variable so it never lands in shell history;
it does end up in `.git/config` in cleartext, same as every other clone here.

### 8. Run bootstrap yourself
```
cd ~/nemoclaw-project && bash bootstrap.sh
```
Reads real secrets from `.env`, so it's yours to run. It does policies, the
Server 2 tunnel + kubeconfig, repo clones, agent workspaces, watcher crons, and
all 16 gateway settings.

**Expect it to stop once on a device scope approval.** Registering the watcher
crons needs `operator.admin`, which a freshly-onboarded device does not have, so
the run dies with:
```
gateway connect failed: scope upgrade pending approval (requestId: <uuid>)
pairing required: device is asking for more scopes than currently approved
```
There is no way to pre-grant it — `openclaw devices` only has `approve` against
a *pending* request, and the request only appears once `cron add` attempts it.
So the sequence is genuinely: run → it stops → approve → run again.

```
NEMOCLAW_GATEWAY_PORT=8180 nemoclaw ops-nemoclaw exec -- openclaw devices approve <requestId>
```
The requestId changes on every attempt; the old one expires, so use the one from
the run you just did. Expect *"Direct scope access failed; using local
fallback"* — that is the normal path, not an error. Afterwards confirm exactly
ONE paired device now carrying `operator.admin`:
```
NEMOCLAW_GATEWAY_PORT=8180 nemoclaw ops-nemoclaw exec -- openclaw devices list
```
One device matters: this instance has previously accumulated 500+ auto-approved
operator devices from a stale tunnel.

### 9. Restart the gateway — mandatory, not optional
```
nemoclaw ops-nemoclaw gateway restart
```
Several settings `bootstrap.sh` writes (the `tools.sessions` /
`tools.agentToAgent` pair, the bootstrap char caps) write successfully but do
**not** take effect until this runs. Skipping it leaves a system that looks
configured and behaves as if it isn't.

### 10. Rebuild the dashboard
All of `dashboard/.env` is unrecoverable — regenerate, don't hunt for it.
```
cd ~/nemoclaw-project/dashboard && npm install
nemoclaw ops-nemoclaw gateway-token        # check --help first
openssl rand -hex 32                          # DASHBOARD_SESSION_SECRET
openssl req -x509 -newkey rsa:2048 -nodes -keyout tls/key.pem -out tls/cert.pem -days 825 -subj "/CN=nemoclaw-dashboard"
```
Fill `dashboard/.env` from `dashboard/.env.example`. `DASHBOARD_PORT` was 8443;
confirm it's still free with `ss -ltnp` and keep it distinct from 8080 and 8180.
Test with `node server.js` before handing back to systemd, then:
```
sudo systemctl start nemoclaw-dashboard
```

---

## Part 2 — verification

Run after step 9. This is what the 2026-08-10 rebuild actually produced, so
treat it as the expected result rather than a wishlist:

```
./scripts/check-config-drift.sh            # -> no drift: 37/37, exit 0
```
That one command covers all 16 gateway settings, 7 watcher crons and the
14-agent roster. Exit 2 = sandbox unreachable, exit 1 = came back wrong.

Then the things a config value cannot prove:

| Check | Command | Expected |
|---|---|---|
| LLM reachable *through the sandbox's policy* | `nemoclaw ops-nemoclaw exec -- curl -s -o /dev/null -w '%{http_code}' http://192.168.0.30:11511/v1/models` | `200` (it is `403` before bootstrap applies the policy — a useful before/after) |
| Gateway's own inference route | `nemoclaw ops-nemoclaw exec -- curl -s -o /dev/null -w '%{http_code}' https://inference.local/v1/models` | `200`. A `503` means the recorded provider endpoint is wrong — fix it before any `rebuild`, which smoke-checks this exact URL and destroys the sandbox when it fails |
| The model actually answers | a real `openclaw agent --agent api-rag-escalation` run | replies, and `exec`/file reads work |
| **The protocol actually runs** | `./scripts/prompt-agent.sh svc-core escalation -m "Run Stage 0 and Stage 1 only on this benign line, then stop. Create no branch, worktree or tracker entry. Quote your Stage 0 output verbatim, including whether the git fetch succeeded on its first attempt. [<paste any INFO line from the pod logs>]"` | Stage 0 quotes a **successful fetch**, Stage 1 gives a verdict, and no branch/worktree/tracker entry is left behind |
| k8s read access | `kubectl get pods -n dev` | real pods (14 on 08-10) |
| k8s write boundary | `kubectl get secrets -A` | `Forbidden` |
| k8s write boundary | `kubectl auth can-i create deployments -A` | `no` |
| Watchers | `tail /sandbox/pilot-state/*-watcher.log` | `clean check, nothing novel` every ~90s |
| AGENTS.md not truncated | `grep -c "truncating in injected context" /tmp/gateway.log` | `0` |
| Suppressions load | `grep -c "unusable as a regex" /sandbox/pilot-state/*-watcher.log` | `0` |

The agent run is the one that matters most — a `baseUrl` pointing at a live
endpoint is not evidence the model responds. Note that NemoClaw's own banner
prints `Endpoint: Managed Inference Route (inference.local)` regardless; that is
its internal bookkeeping, not the route completions take.

**And "the model replies" is not evidence the protocol works** — which is why
the second agent row exists. Added 2026-09-04 after a one-word probe run
(`-m "Reply with exactly: ALIVE"`) passed repeatedly over an afternoon during
which **all 7 escalation agents' Stage 0 was dead**: the agents' exec tool does
not inherit `GIT_SSL_CAINFO`, so every `git fetch` failed cert verification. A
reply-only probe never fetches, `nemoclaw exec` inherits the variable and so
every manual check passed too, and the watchers stayed green because a clean
check never fetches either. Nothing in the stack noticed. Only a run that
actually executes Stage 0 does, so make that the check rather than a greeting.

**2026-08-10 result: all of the above passed**, across a nemoclaw 0.0.90 →
0.0.103 AND an OpenClaw 2026.6.10 → 2026.7.1 jump. That is the first time the
drift checker has been run against a genuine from-nothing rebuild, and it is the
scenario it was written for — the last time a nemoclaw upgrade crossed this
path it silently destroyed the `sessions_send` config and nobody noticed for a
week.

## Upgrading in place (a version bump, not a rebuild)

Written 2026-09-04 after v0.0.109 -> v0.0.119 (OpenShell 0.0.101 -> 0.0.106).
Everything above assumes you are rebuilding from nothing; an upgrade is a
different job with its own failure modes, and this one cost a destroyed sandbox
before the cause was understood. Read the pre-flight section before you start —
three of the five blockers below are cheap to check in advance and expensive to
meet halfway through.

### Pre-flight — run the guard first

```
./scripts/check-rebuild-safe.sh -v
```
Exit 0 = safe, 1 = blocked, 2 = could not determine (which is **not** a pass —
same "unverifiable is its own alert" rule as `check-config-drift.sh`). It
mechanises the checks below, because "read the pre-flight section first" is a
prose-only rule and this project keeps relearning that those are not reliably
followed.

Two things it deliberately does **not** do: it cannot tell a legacy MCP
provider profile from a current one (the CLI exposes no profile field, so that
one is a WARN, not a BLOCK), and it does not decide for you whether discarding
in-flight work is acceptable. The manual detail for every check is below.

### The checks it runs, and why each one matters

**1. `inference.local` MUST return 200 from inside the sandbox.** This is the
gate that matters most, and it is not obvious why:
```
nemoclaw ops-nemoclaw exec -- curl -s -o /dev/null -w '%{http_code}' https://inference.local/v1/models
```
`rebuild` and `onboard` smoke-check that exact URL at step 7 of 8 — **after**
they have already deleted the old sandbox. A 503 there means every attempt
fails at the same place and you are left recreating from scratch. See the
inference-endpoint block under step 4 for the fix; it is a one-line
`openshell provider update`.

**2. No stale onboarding lock.**
```
cat ~/.nemoclaw/gateways/8180/onboard.lock 2>/dev/null    # expect: no such file
```
If it exists, check whether its recorded `pid` is actually alive (`ps -p <pid>`).
A dead one blocks v0.0.119's state migration, which makes the installer see **no
recorded sandboxes at all** and fall through to generic onboarding — which then
dies on the Jenkins/8080 port conflict and looks like an unrelated problem. A
day-old lock from an abandoned `nemoclaw onboard --non-interactive` did exactly
this on 2026-09-04. Back it up and delete it.

**3. No legacy MCP provider profile.** `mcp list` showing `github` is not
enough; the *provider profile* behind it is what matters. Since 0.0.106 cannot
bind the old generic profile, `rebuild` aborts:
```
Failed to preserve MCP bridges before rebuild: OpenShell provider
'ops-nemoclaw-mcp-github-<hash>' uses the legacy generic profile, which
OpenShell 0.0.106 cannot bind to an MCP endpoint.
```
Remove it first — `nemoclaw ops-nemoclaw mcp remove github`. `bootstrap.sh`
re-registers it afterwards (with the DNS patch, in the right order), so nothing
is lost and no manual `mcp add` is needed.

**4. Nothing in flight.** A rebuild wipes `/sandbox`, so any prepared fix dies
with it:
```
cat /sandbox/pilot-state/*-stages.json          # each must be {} (or no files at all)
ls -d /sandbox/repos/*-worktrees/*/ 2>/dev/null # expect nothing
```
Empty output from the first is fine — a tracker file only exists once that repo
has reached Stage 2 at least once since the last rebuild.
Resolve or deliberately discard anything at stage 2+. If discarding, save the
work first — `git format-patch main..fix/<slug> --stdout` off-box — because
close-out deletes both the branch and the worktree.

**5. Capture a drift baseline.** `./scripts/check-config-drift.sh > drift-before.txt`.
This is the only thing that will tell you afterwards whether the upgrade ate
config, which is not hypothetical: the v0.0.81 -> v0.0.90 bump silently
destroyed the `sessions_send` settings and nobody noticed for a week.

### The sequence

The installer handles the sandbox upgrade itself — it detects recorded
sandboxes, **skips generic onboarding**, backs each one up before any version
bump, then recovers them. There is no separate `rebuild` step in the happy path.

```
sudo systemctl stop nemoclaw-dashboard
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=v0.0.119 bash
hash -r && source ~/.bashrc
nemoclaw --version && ~/.local/bin/openshell --version
```
Pin the tag. Unpinned installs whatever is newest at that moment, which is not
what you reviewed.

**Verify BOTH versions moved.** If nemoclaw advanced but openshell did not, stop
— that mixed state is its own bug class (NemoClaw#10273: channel credentials
stop reaching the agent on 0.0.106 with an older CLI).

`hash -r` is not optional and not superstition: your shell caches resolved
command paths, so an already-open session reports `nemoclaw: command not found`
after a perfectly good install. `source ~/.bashrc` alone does not clear it.

Then check whether the workspace survived:
```
nemoclaw ops-nemoclaw exec -- bash -lc 'ls /sandbox/repos; ls /sandbox/pilot-state | head'
```
- **Populated** — skip bootstrap. An OpenShell-only bump preserves `/sandbox`.
- **Empty** — run `bash bootstrap.sh`. A full sandbox recreate does not: its
  backup covers the OpenClaw state tree (`agents, extensions, workspace,
  skills, hooks, canvas, cron, memory, telegram, wechat, credentials,
  workspace-attestations`) and **not** `/sandbox/repos` or
  `/sandbox/pilot-state`.

Expect bootstrap to stop once on a device scope approval — see step 8. Then
`nemoclaw ops-nemoclaw gateway restart` (step 9, mandatory).

### The dashboard's token goes stale on any sandbox recreate

Easy to miss, because the service starts fine and only the handshake fails.
Compare before starting it, by hash so neither value is echoed:
```
LIVE=$(nemoclaw ops-nemoclaw gateway-token --quiet)
ENVT=$(grep '^NEMOCLAW_GATEWAY_TOKEN=' dashboard/.env | cut -d= -f2-)
[ "$LIVE" = "$ENVT" ] && echo MATCH || echo MISMATCH
```
On mismatch, update it without putting the token in shell history:
```
TOKEN=$(nemoclaw ops-nemoclaw gateway-token --quiet) \
  && sed -i "s#^NEMOCLAW_GATEWAY_TOKEN=.*#NEMOCLAW_GATEWAY_TOKEN=${TOKEN}#" dashboard/.env \
  && unset TOKEN
sudo systemctl start nemoclaw-dashboard
```
Healthy startup ends in `gatewayClient: connected and authenticated`. The
`connect.session() MemoryStore` warning is normal.

### Other 0.0.119 / 0.0.106 behaviour changes

- **`--trusted-private-host` is now mandatory** for a custom policy preset
  naming an RFC1918 address, or it is rejected outright (`endpoint host
  '192.168.0.30' is rejected`). `bootstrap.sh` passes it for
  `trading-vllm-shared-inference`; any new preset with a private endpoint needs
  the same. The `|| true` on those lines means a failure here scrolls past
  rather than stopping the run — and the sandbox silently cannot reach the model.
- **Policy presets chosen at onboard time do not come back on `--resume`.**
  `brew`, `huggingface`, `npm`, `openclaw-pricing` and `pypi` were interactive
  answers on the original onboard; `bootstrap.sh` only adds `github`, `gh-cli`,
  `git-remote-helper`, `server2-k8s-tunnel` and `trading-vllm-shared-inference`.
  Re-add the five by hand (`nemoclaw ops-nemoclaw policy add <name> --yes`)
  and compare against the baseline — `policy list` should show ten.
- **`nemoclaw inference set` can no longer change the endpoint at all** on an
  already-configured sandbox, and refuses private addresses outright. Use
  `openshell provider update` for the recorded endpoint, and
  `gateway-config.sh`'s `baseUrl` for what agents actually use.
- **`nemoclaw exec` no longer allocates a pty by default.** An improvement:
  output is no longer mangled and `2>/dev/null` on the invocation works again.
  Pass `--tty` if you needed the old behaviour.
- **`openclaw` prints config warnings to stdout, ahead of `--json` payloads.**
  One unrelated warning is enough to make `cron list --json` unparseable. The
  drift checker now strips non-JSON preambles; anything else you write that
  parses openclaw output should too.

### If `rebuild` fails after deleting the sandbox

It journals a replacement transaction and preserves both the registry entry and
a backup, so it is recoverable — but the recovery path is `onboard`, not another
`rebuild`:
```
nemoclaw onboard --resume --name ops-nemoclaw --tool-disclosure progressive --recreate-sandbox
```
`--recreate-sandbox` is needed when it reports *"a previous onboarding attempt
recorded sandbox ... with different build or policy inputs than this run
requests"*. Fix the underlying cause (almost certainly `inference.local`) first,
or it fails at the same step. Then `bootstrap.sh`, then step 9's restart.

## Known gotchas that bite specifically on a rebuild

- **`nemoclaw exec -- openclaw config set` works; `sh -lc` wrapping it does
  not.** nemoclaw installs a shell function that refuses `config set` inside a
  login shell. `bootstrap.sh` uses the working form; only hand-debugging hits
  this.
- **Anything not in `scripts/lib/gateway-config.sh` will not come back.** A
  setting applied by hand once is a setting that dies at the next rebuild —
  that's how the `sessions_send` config vanished for a week in August.
- **`openclaw cron list`'s table rounds 90s to "every 2m".** Not drift. Compare
  `cron list --json`'s `everyMs`.
- **Re-running `bootstrap.sh` aborts in-flight agent runs.** It rewrites
  `models.providers.inference.*`, which hot-reloads the provider and kills
  active completions. Harmless on a fresh rebuild (nothing is running); worth
  knowing if you ever re-run it on a live instance.
