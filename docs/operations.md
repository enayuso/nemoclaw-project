# Operations reference

> Written for the original two-server deployment (Linux hosts). For a single Mac, start with
> [macos-setup.md](macos-setup.md) — the steps below still apply with "Server 6" = your Mac and
> "Server 2" = the Colima k3s VM.

Detailed operational notes for `ops-nemoclaw`, the NemoClaw
instance direct-installed on Server 6 (`ops-s006@203.0.113.10:19031`), plus
the registry-driven system for onboarding new monitored repos generally.


## Layout

- `bootstrap.sh` — run this after any fresh onboard/rebuild. Reads secrets
  from `.env` (copy `.env.example` first). Re-establishes the read-only
  SSH-tunnel + Kubernetes RBAC path to Server 2, network policies, this
  repo's own clone (so the registry scripts are available in-sandbox), the
  GitHub MCP server, and any repos registered via `register-repo.sh`.
- `k8s/` — `rbac-readonly.yaml` (ServiceAccount + ClusterRole + Binding +
  long-lived token Secret, read-only get/list/watch, no secrets/configmaps,
  no write verbs — this is the real authorization boundary for Server 2)
  and `k8s/README.md` (the human-run apply/token-extraction recipe). Never
  applied by an AI agent — same secrets discipline as everything else that
  touches real credentials here.
- `kube/config-server2.tmpl` — kubeconfig template, `{{K3S_CA_B64}}`/
  `{{K8S_SA_TOKEN}}` filled from `.env` by `bootstrap.sh` at deploy time.
  Always points at `https://127.0.0.1:16443` — the local end of
  `tunnel-keeper.sh`'s SSH forward — never Server 2's real address
  directly; the sandbox has no other path to the k3s API server.
- `dashboard/` — thin-slice web dashboard talking directly to the OpenClaw
  Gateway's own WebSocket API: list registered repos, send a task to an
  agent, watch it run live (streaming text + tool-call lifecycle). Built
  to fix two real gaps in the chat-based notification path it replaced —
  all 7 repos sharing one channel (a likely cause of a real cross-repo
  attribution mix-up) and no live view of a run while it's happening. The
  dashboard is the operator's sole real-time interface into these agents.
  See `dashboard/README.md` for setup, the Gateway-protocol details this
  depends on, and known v1 gaps.
- `scripts/`
  - `connect-proxy.py` — SSH `ProxyCommand` helper (the sandbox's only
    egress is an HTTP forward proxy; plain `ssh` can't speak that, so this
    does a manual HTTP CONNECT tunnel). Also present in `local-nemoclaw`,
    byte-identical, kept in sync manually.
  - `tunnel-keeper.sh` — idempotent watchdog (run every 1m by an
    `openclaw cron`, `--no-deliver`) that keeps a local port-forward to
    Server 2's k3s API server alive. No-op when already healthy. Runs
    *inside* the sandbox specifically so its lifecycle is tied to the
    sandbox's own (a destroy/rebuild kills it too, same as everything else
    under `/sandbox` outside `.openclaw`) — this avoids the orphaned-tunnel
    failure mode from the past device-pairing-spam incident, which was
    specifically a *host*-side tunnel outliving what created it. Supports
    a side-effect-free `tunnel-keeper.sh status` check.
  - `register-repo.sh` / `toggle-repo.sh` / `deregister-repo.sh` — the
    registry-driven repo onboarding system (see `registry/` and
    `templates/` below): register/toggle-monitoring/remove a new repo
    without hand-writing agent docs each time. `register-repo.sh` supports
    `--runtime docker|k8s` (default `k8s` since Server 5's decommission —
    see `registry/schema.md`'s "Runtime object" for the full field set each
    takes; `--runtime docker` is retired, see this script's own header
    comment) and `--secondary-branch <branch>` for repos with a dev/main
    split (own `.env.dev` + `pipeline.sh`, deployed off a branch distinct
    from the stable one) — wires up a divergence check the write-capable
    agent runs before preparing any fix, stopping to ask the human how to
    proceed (keep as-is / merge / custom) if the branches have actually
    diverged. Both runtimes deploy the full set — watcher + cron and
    escalation/reviewer agent workspaces — since the agent/reviewer
    templates became runtime-aware (Phase 4 of
    `docs/k8s-migration-architecture.md`, done 2026-07-21).
  - `resync-repo.sh <key>|--all` — pushes a template improvement (e.g. a
    new safety rule, or a watcher bugfix) out to an already-registered
    repo's live agent docs *and* its deployed `watcher.sh`, without needing
    to toggle anything. `toggle-repo.sh` only re-renders agent docs as a
    side effect of `modifications_enabled` actually changing; this is for
    when the templates themselves changed instead. Works the same for both
    `runtime.type` values — the agent-doc half is no longer skipped for
    `"k8s"` entries (Phase 4, done).
  - `check-rebuild-safe.sh [-v] [--json]` — run this **before** any
    `nemoclaw rebuild` or version upgrade. `rebuild`/`onboard` delete the
    sandbox early and only smoke-check inference at step 7 of 8, so a
    pre-existing fault becomes an outage plus a from-scratch `bootstrap.sh`
    instead of a one-line fix. Exit 0 safe, 1 blocked, 2 could-not-determine
    (not a pass). Built 2026-09-04 after exactly that cost a working sandbox —
    see `docs/recovery.md`'s "Upgrading in place".
  - `prompt-agent.sh <repo-key> <escalation|reviewer> -m "<message>"` (or
    `--message-file <path>`) — manually invoke a registered repo's agent
    without hand-crafting the underlying `openclaw agent` command each
    time: resolves the agent name from the registry, and generates a fresh
    session-key by default. Pass `--resume "<session-key>"` (printed on the
    original call) to continue that exact conversation with full context
    instead of starting cold - same split as an agent-SDK's
    fresh-call-vs-resume-by-ID distinction. `--timeout <seconds>` passes
    through to `openclaw agent`, `--dry-run` prints the resolved command
    without touching the sandbox at all. Built 2026-07-23 after a manual
    resume required hand-writing a session-key by convention.
  - `render-template.py` — `{{KEY}}`-token template renderer used by
    `register-repo.sh`/`toggle-repo.sh`/`resync-repo.sh` when deploying
    agent docs and watcher scripts.
  - `lib/sandbox-helpers.sh` — shared `nemoclaw`/`docker` helpers
    (`container_name`, `cron_job_exists`, `render_and_redeploy_agent_docs`,
    `render_and_redeploy_watcher`). `lib/watcher-common.sh` — shared
    watcher logic: `ssh_pull` (docker-runtime repos) and `kubectl_pull`
    (k8s-runtime repos, reads the kubeconfig `tunnel-keeper.sh` keeps
    reachable) plus the cooldown/escalation dedup mechanism both runtimes'
    watcher templates share. Also present in `local-nemoclaw`, kept in
    sync manually.
- `registry/repos.json` — git-tracked source of truth for repos onboarded
  via `register-repo.sh` (see `registry/schema.md` for the field
  reference, including the `runtime` tagged union — `docker` for a plain
  SSH-reached container [retired, see below], `k8s` for a Kubernetes
  workload on Server 2). Deployed as a runtime copy to
  `/sandbox/pilot-state/registry.json` inside `ops-nemoclaw`. First real
  entry: `api-rag` (`svc-api-rag`, `dev` branch, `main` as
  secondary, write-capable), registered 2026-07-20 as `runtime.type:
  "docker"` and cut over to `runtime.type: "k8s"` 2026-07-22 (Phase 7,
  alongside Server 5's decommission) — the reference example for how a
  real (non-test) registration looks.
- `templates/` — `.tmpl` files (`agent-{readonly,writecapable}`,
  `reviewer-{readonly,writecapable}`, `watcher-docker.sh.tmpl`,
  `watcher-k8s.sh.tmpl`, `pre-push-hook.sh.tmpl`) that
  `register-repo.sh`/`toggle-repo.sh`/`resync-repo.sh` render per-repo.
  `watcher-docker.sh.tmpl` (renamed from `watcher.sh.tmpl` 2026-07-21) and
  `watcher-k8s.sh.tmpl` (new 2026-07-21) are siblings dispatched by a
  registry entry's `runtime.type` — see `registry/schema.md`. The
  agent/reviewer templates are runtime-aware (Phase 4, done 2026-07-21) via
  a shared set of composite tokens (`{{TARGET_DESC}}`,
  `{{ACCESS_METHOD_NOTE}}`, etc.) computed by `sandbox-helpers.sh`'s
  `compute_agent_doc_tokens`. Generalized from `dev-nemoclaw`'s hand-written
  `investment-pilot`/`svc-monitor` originals (in `local-nemoclaw`),
  which remain untouched as the reference implementations.
- `attic/` — retired code kept for reference, not wired into any active
  script: `generate-server5-wrapper.sh` and
  `server5-readonly-wrapper.sh.tmpl`, the forced-command wrapper machinery
  Server 5's Docker-runtime path used (moved here, not deleted, 2026-07-22 —
  see this repo's git history for the deployed generated file it used to
  produce). Only relevant again if a genuinely new Docker-hosted monitoring
  target is ever added — see `register-repo.sh`'s header comment.
- `workspace/` — `IDENTITY.md`/`USER.md` for the **main** agent (not any
  per-repo escalation/reviewer agent). Hand-written for this instance
  specifically: a team-facing ops bot with no single "the user", not
  OpenClaw's default single-person profile. Deployed by `bootstrap.sh` step
  5 via `docker cp` — without this step, a fresh onboard falls back to
  OpenClaw's generic blank templates (`agents.defaults.skipBootstrap=true`
  suppresses the interactive identity-setup turn that would otherwise fill
  them in, a NemoClaw-wide default, not specific to this instance). Edit the
  files here and re-run bootstrap's step 5, don't hand-edit the deployed
  copies directly — they'll just be overwritten next time.
- `ssh/config-ops-nemoclaw` — the SSH client config deployed to
  `/sandbox/.ssh/config`. One host alias, `server2` (dedicated identity
  file at `/sandbox/.ssh/server2` — tunnel-only, can never run a command or
  get a PTY, see Setup below). Had a second alias, `server5`, until its
  decommission 2026-07-22.
- `policies/` — custom NemoClaw network policy presets:
  `server2-k8s-tunnel.yaml` (SSH-only, port 19012 — carries the k3s API
  tunnel; RBAC and the tunnel-only key are the real gates, this is
  defense-in-depth) and `git-remote-helper.yaml` (lets git's internal
  transport helper reach `github.com`; also present in `local-nemoclaw`,
  kept in sync manually). Had a third preset,
  `server5-readonly-monitoring.yaml`, until Server 5's decommission
  2026-07-22.

## Setup

1. `cp .env.example .env` and fill in real values (GitHub PAT(s)). **Never
   commit `.env`** — it's gitignored, keep it that way.

2. **Stand up the sandbox itself** via `nemoclaw onboard` — this step isn't
   scripted or wrapped by anything in this repo (a first-time interactive
   setup, same "a human runs it" rule as everything else touching real
   secrets), and its exact prompts aren't obvious from the CLI alone. This
   was previously undocumented anywhere in the repo — recorded here after
   confirming it live on Server 6 during a full destroy/rebuild,
   2026-07-22:
   ```
   NEMOCLAW_GATEWAY_PORT=8180 nemoclaw onboard --name ops-nemoclaw --yes-i-accept-third-party-software
   ```
   (`NEMOCLAW_GATEWAY_PORT=8180` because Jenkins already owns port 8080 on
   Server 6 — always needed, not optional.) Answer the interactive prompts:
   - Agent: **OpenClaw**
   - Inference provider: **Other OpenAI-compatible endpoint** — base URL
     `http://203.0.113.10:11511/v1`, model `nvidia/Qwen3.6-35B-A3B-NVFP4`
     (Server 5, verified live 2026-09-04). Use the **public** address here:
     NemoClaw rejects a private one at this prompt, and this value becomes the
     recorded provider endpoint that `rebuild`'s smoke check later depends on.
     See `docs/recovery.md` for why that matters and for the LAN address
     (`192.168.0.30:11511`) used everywhere else. This previously read
     `http://203.0.113.20:8093/v1` + `Qwen/Qwen3.6-35B-A3B-FP8`, dead since
     the backend move on 2026-07-27 — `bootstrap.sh` overwrites these keys
     afterwards either way, but entering the live values avoids a failed
     handshake mid-onboard. The
     API key here is a separate credential from anything in this repo's
     `.env.example` (which only covers what `bootstrap.sh` itself needs
     post-onboard) — it's entered interactively and staged directly into
     the OpenShell gateway by the onboard flow.
   - Web search: **No web search** (this instance doesn't use it — see
     `workspace/IDENTITY.md`)
   - Messaging channels: **none** — this instance doesn't use any
     messaging channel; the dashboard (`dashboard/`) is the operator
     interface
   - Resource profile: **No profile** (OpenShell defaults)
   - Policy tier: **Balanced**; presets: **npm, pypi, huggingface, brew,
     brave, openclaw-pricing** (all read-write) — `bootstrap.sh` adds every
     other preset this instance actually needs (`github`,
     `server2-k8s-tunnel`, `git-remote-helper`, `mcp-bridge-github`) itself
     later, don't hand-pick those here

   Onboarding takes 3-8 minutes (image build + sandbox creation). Confirm
   with `nemoclaw ops-nemoclaw status` before continuing below.

3. **One-time, human-run steps for Server 2 (k3s) access** — this is the
   only monitoring-target access this instance has, since Server 5's
   decommission 2026-07-22:
   1. Generate a dedicated keypair, **not reused** from anything
      `dev-nemoclaw` uses:
      `ssh-keygen -t ed25519 -f ~/.ssh/ops-nemoclaw-to-server2 -C ops-nemoclaw-tunnel@server6 -N ""`
   2. Append to `ops-s002`'s `~/.ssh/authorized_keys` on Server 2
      (`203.0.113.10:19012`):
      `command="/bin/false",restrict,port-forwarding,permitopen="127.0.0.1:6443" ssh-ed25519 AAAA...<pubkey>... ops-nemoclaw-tunnel@server6`
      — **the leading `command="/bin/false"` is the part that actually
      blocks command execution, not `restrict`.** `restrict` alone only
      disables PTY/agent-forwarding/X11/user-rc/port-forwarding as a
      bundle — it does *not* stop the client from running an arbitrary
      command; that's a separate, unrelated restriction that only a
      forced `command=` directive provides (confirmed live 2026-07-22: a
      verbose `ssh -v ... whoami` through this key showed the server's
      parsed key options as `command permitopen port-forwarding`, then
      substituted `/bin/false` for the requested `whoami`, returning exit
      1 with no output — that substitution *is* `command=` doing its job).
      `port-forwarding` re-enables *only* forwarding (`restrict` disables
      it by default too), `permitopen` pins the one allowed destination.
      Together these mean this key can never run any command — including
      the one it's nominally configured to run — it is pure transport,
      not an authorization grant. Reusing the existing `ops-s002` account
      (rather than a fresh dedicated one) is safe specifically because of
      this restriction — the account's own broader kubectl access is
      never reachable through a session that can't execute anything.
   3. With cluster-admin on Server 2: `kubectl apply -f k8s/rbac-readonly.yaml`
      (see `k8s/README.md` for the exact recipe and token/CA extraction
      one-liners), then put the extracted values into Server 6's `.env` as
      `K8S_SA_TOKEN` / `K3S_CA_B64` — transfer directly in your own shell
      session, never through chat, a ticket, or an agent transcript.
   4. Download an `arm64` static `kubectl` binary matching the cluster's
      `v1.36.x` (Server 6 is arm64 — confirm, don't assume, if this ever
      changes) to `~/bin/kubectl` on Server 6's host filesystem;
      `bootstrap.sh` copies it into the sandbox from there rather than
      curling it from inside the sandbox, avoiding a new egress policy
      just to fetch a release binary (same reasoning as `connect-proxy.py`).
   5. Sanity-check the boundary from Server 6's own host shell *before*
      wiring the sandbox: open the tunnel manually
      (`ssh -N -L 16443:127.0.0.1:6443 -p 19012 ops-s002@203.0.113.10`),
      then with the rendered kubeconfig confirm `kubectl auth can-i --list`
      shows only get/list/watch, `kubectl get secrets -A` → `Forbidden`,
      `kubectl delete pod xyz -n dev` → `Forbidden`.

4. **Download the `gh` CLI binary onto Server 6's own host filesystem** —
   `bootstrap.sh` copies it into the sandbox from there rather than curling
   it from inside the sandbox, same "avoid a new egress policy just to
   fetch a release binary" reasoning as `kubectl` above. Download the
   `linux_arm64` release tarball from
   [github.com/cli/cli/releases](https://github.com/cli/cli/releases),
   extract it, and copy its `bin/gh` to `~/bin/gh`. Added 2026-07-23 after
   a real gap: `gh` had worked before but was never scripted anywhere, so
   it silently didn't survive a rebuild and a write-capable agent couldn't
   open a PR (it also can't install this itself — `apt install` is
   correctly denied to the unprivileged sandbox user, by design).

5. **Clone this repo onto Server 6's own host filesystem** (`ops-s006`'s
   home directory — separate from the sandbox's own internal clone at
   `/sandbox/nemoclaw-project`, which `bootstrap.sh` sets up
   separately). `bootstrap.sh`, `register-repo.sh`, `toggle-repo.sh`, and
   `deregister-repo.sh` all call `docker`/`nemoclaw` directly against the
   real running container, so they only work when run from here — not from
   the sandbox, not from any other machine:
   ```
   ssh -p 19031 ops-s006@203.0.113.10
   git clone https://github.com/enayuso/nemoclaw-project.git
   cd nemoclaw-project
   git config --global user.name "..." && git config --global user.email "..."   # once per host account, local metadata only
   ```

6. Run `bash bootstrap.sh` **yourself**, directly in your own terminal —
   not via an AI agent. It reads real secrets from `.env`; keeping those
   out of any tool-call transcript is a deliberate practice from this
   project's history.

7. Verify:
   - `nemoclaw ops-nemoclaw doctor`
   - `nemoclaw ops-nemoclaw mcp status github`
   - `nemoclaw ops-nemoclaw exec -- ssh server2 "whoami"` must be
     rejected (tunnel key has no exec capability).
   - `nemoclaw ops-nemoclaw exec -- /sandbox/.local/bin/kubectl --kubeconfig=/sandbox/.kube/config get pods -n dev`
     should return real pods; `... get secrets -A` and
     `... delete pod xyz -n dev --dry-run=server` must both be `Forbidden`.
   - `nemoclaw ops-nemoclaw exec -- bash /sandbox/pilot-state/tunnel-keeper.sh status`
     should report the tunnel up.
   - `nemoclaw ops-nemoclaw exec -- gh auth status` should show as
     logged in.

## Known gotchas

- **Do not set `plugins.allow` on this instance at all - not via
  `bootstrap.sh`, not manually, not "once the sandbox has settled."**
  `/tmp/gateway.log` confirms this specific key cannot hot-reload ("config
  reload requires gateway restart; hot mode ignoring (plugins.allow)"), and
  the restart it requires has killed the gateway outright on **every**
  attempt tried (2026-07-21): immediately after a fresh onboard, after
  sleeps/retry-with-backoff/spaced-out config calls, and again after
  waiting several real minutes with the sandbox otherwise idle and stable.
  Time was not the variable - this specific config change reliably kills
  this gateway version's restart path, full stop. `bootstrap.sh`
  deliberately sets only the other security-hardening settings (all
  confirmed hot-reload cleanly, no restart needed) and leaves this one
  alone. Accepted as a standing limitation of this NemoClaw/OpenClaw
  version (`v0.0.81` / `2026.6.10`) - revisit only after an upstream
  version bump, and even then verify on a disposable sandbox first, not
  this one. The practical exposure is low: the only plugin actually
  present is `nemoclaw`, legitimate and expected: this
  setting exists to guard against some *future* unexpected plugin
  auto-loading, not something currently true. If this is ever revisited,
  do it on a fresh onboard from the very start (as `openclaw plugins.allow`
  set during onboarding itself, before any other config activity), not as
  a config-set-then-restart against an already-running gateway - that
  combination is what's been shown to fail, not the setting itself.

  **RETESTED 2026-09-04 on `v0.0.119` / `2026.7.1` - it did not reproduce.**
  The revisit invited above was done, and deliberately by the path recorded
  here as fatal: `config set plugins.allow` against an already-running
  gateway, then `gateway restart`. Result: *"Gateway restarted; health
  passed"*, then health 200 at every 45s checkpoint through t+360s (the
  delayed death this note warns about was specifically watched for), a real
  agent turn replying normally, drift clean, dashboard reconnected, watchers
  uninterrupted. Config was backed up first
  (`upgrade-baseline-20260904/openclaw.json.pre-pluginsallow-retest`).

  **What that does NOT establish:** the value written was byte-identical to
  the existing one, so only the write-and-restart *path* is cleared. A
  semantically CHANGED allow list - which would load or unload a plugin on
  restart - remains untested, and is the more plausible trigger of the two.
  So this is no longer "never touch it", but it is not yet "safe to change".
  Treat the prohibition as narrowed to changed values, and if that is ever
  needed, test it on a disposable sandbox as this note already advises.

  Keeping the original text above rather than rewriting it, on purpose: the
  reasoning was sound for the version it was measured on, and the lesson is
  that a prohibition needs its version recorded and its evidence re-checked
  after a bump - not that the earlier finding was wrong. The
  `inference.local` note that said "always fails, ignore it" was true when
  written too, and believing it past its expiry cost a sandbox on
  2026-09-04.
- **A workspace `AGENTS.md`/`TOOLS.md` over the bootstrap cap is silently
  mangled, not cleanly cut.** OpenClaw keeps the first 45% and last 15%
  verbatim and replaces the middle with a "policy digest" — a flat list of
  lines that match a heading/bullet/keyword test, each capped at 240 chars.
  Because it selects line-by-line, it keeps the *first* line of a wrapped
  paragraph and drops the continuations, so rules arrive as severed
  sentence fragments rather than as obviously-missing sections. Found
  2026-08-07 affecting all 7 escalation agents (22084–22378 chars against
  the then-default 20000 cap); 80% of the non-empty lines in the dropped
  middle were going missing. It had been running unnoticed because the
  only signal is one line in `/tmp/gateway.log`. Caps now live in
  `registry/bootstrap-limits.json`, `bootstrap.sh` pushes them to the
  gateway, and `scripts/render-template.py` refuses to render a doc that
  would breach them — so a regression fails the render instead of quietly
  degrading a prompt. If you raise the per-file cap, mind the per-agent
  total cap too; that file explains the arithmetic. Not a NemoClaw
  concern — it has no bootstrap/prompt-injection handling at all.
- **NemoClaw's network policy enforcement is binary-aware, not just
  host/port-aware.** A policy's `binaries:` list isn't documentation — the
  proxy genuinely denies a CONNECT from a binary not on that list, even
  with the correct host/port allowlisted. Reachability tests using
  `curl`/raw `/dev/tcp` will fail with `policy_denied` against a policy
  that's actually correctly applied — only testing with the real intended
  binary (e.g. `ssh`) will succeed. If a policy addition seems to not be
  taking effect, check what binary you're testing with before assuming the
  policy itself is broken.
- The GitHub MCP server can intermittently 403 due to GitHub's rotating
  CDN IPs outrunning NemoClaw's pinned-IP SSRF protection. Fix:
  `nemoclaw ops-nemoclaw mcp restart github`.
- `openclaw.json`'s file permissions can't be durably `chmod`'d while the
  gateway is running — the daemon itself periodically rewrites the file
  (config hot-reloads, heartbeat activity) and each rewrite resets
  permissions to the platform default. No umask/file-mode setting exists
  anywhere in `openclaw config schema` to fix this from outside. Accepted
  as a known limitation rather than chased further, since this instance's
  gateway is confirmed reachable only from loopback and from a Docker
  bridge network whose sole member is its own sandbox container — reapply
  the chmod as the *last* step of any session that touched config (see the
  end of `bootstrap.sh`'s output), not something to verify mid-session.
- Nothing under `/sandbox` outside `/sandbox/.openclaw` survives a
  destroy/rebuild — that's exactly why `bootstrap.sh` exists.
- `register-repo.sh`/`bootstrap.sh` must run on **Server 6 itself**
  (`ops-s006`'s own shell), not from any other machine — they call
  `docker`/`nemoclaw` directly against the real running container, which
  only that host can see. Running them elsewhere (e.g. from a laptop) writes
  the registry entry/rendered files locally but silently no-ops the actual
  sandbox deployment.
- **`openclaw cron add` needs `operator.admin` scope, which NemoClaw never
  auto-approves** (unlike `operator.read`/`operator.write`, which auto-pair
  cleanly) — this is deliberate, fail-closed upstream behavior (issue
  #4462), not a bug to work around. Every separate `exec`/`connect`
  invocation opens a new device session, so approving a pending request
  from a *different* invocation than the one that created it just spawns
  another pending request instead of resolving anything — the fix is to do
  trigger → `openclaw devices list` → `openclaw devices approve
  <requestId>` → retry **all inside one continuous `nemoclaw <name>
  connect` session**, never exiting in between. Once approved, the scope
  upgrade is permanent for that device — confirmed via a fresh `exec` call
  afterward. First hit when creating `api-rag-watcher`'s cron job; will
  recur for the first cron job on any brand-new sandbox/device, not just
  this one.
- **Never clone with a credential embedded directly in the URL
  (`https://user:pat@host/...`) if you'll ever need to share `git remote
  -v`'s output or a copy-pasted command line with anyone/anything else** —
  the credential is stored as-is in `.git/config` and gets echoed back
  verbatim. `credential.helper store` (already configured by
  `bootstrap.sh`'s clone step) exists specifically so a **plain**
  `https://github.com/...` URL can be used everywhere else instead —
  nothing to leak because nothing's embedded. Two real GitHub PATs got
  exposed and had to be revoked this way during `api-rag`'s registration
  before this was caught; use `git remote set-url origin
  https://github.com/<org>/<repo>.git` to strip a credential back out if
  one's already embedded.
- A fresh Server 6 host account needs `git config --global user.name`/
  `user.email` set once before its first local commit (unrelated to GitHub
  auth — this is local commit-metadata only, doesn't touch any account).
