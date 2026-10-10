# ops-nemoclaw: Server 5 (Docker) → Server 2 (k3s) architecture migration

**Audience:** an LLM (or human) implementing this migration end-to-end.
This document is the authoritative spec: current-state inventory, target
architecture, non-negotiable invariants, a phased work plan with
file-level detail, the human-only steps, and a verification checklist.

**Context in one paragraph:** `ops-nemoclaw` is a NemoClaw AI-workspace
sandbox direct-installed on Server 6 (`ops-s006@203.0.113.10:19031`). It
monitors a set of backend services, escalates incidents to per-repo AI agents that
investigate and (where enabled) prepare fixes as GitHub PRs, surfaced to
the team through a web dashboard (which replaced an earlier chat-based
notification path, removed 2026-07-24). Today it monitors Docker containers
on Server 5 (`ops-s005@203.0.113.10:19030`) through a hardened SSH path.
The monitored services are moving from Docker on Server 5 to a k3s
(Kubernetes) cluster on Server 2. The monitoring/access layer must be
rebuilt for Kubernetes; most of the rest of the system carries over.

---

## 1. Facts to gather before starting (placeholders used throughout)

Do not guess these. Ask the operator or check the infrastructure first:

| Placeholder | Meaning |
|---|---|
| `SERVER2_IP` | Server 2's reachable IP from Server 6 |
| `SERVER2_SSH_PORT` | Server 2's SSH port (assume, like Server 5/6, it is NOT 22) |
| `SERVER2_SSH_USER` | Dedicated low-privilege SSH account on Server 2 for the tunnel (create if absent, e.g. `svc-monitor`) |
| `K3S_API_PORT` | k3s API server port on Server 2 (default `6443`) |
| Per-service: namespace, workload kind (`deployment`/`statefulset`), workload name, container name | How each migrated service (e.g. `api-rag`) is actually deployed in k3s |
| Deploy pipeline | How a merged PR becomes a running pod on Server 2 (CI/CD? manual `kubectl apply`? Argo?) — determines what "deploy-and-observe" means post-migration |
| Server 6 CPU arch | For fetching the right `kubectl` binary (project requirement: everything must support both x86_64 and ARM64 — verify, don't assume) |

Also confirm whether **any** monitored service remains on Server 5 Docker
during/after the migration. The plan below keeps the Docker path alive as a
second runtime type until Server 5 is fully decommissioned; if Server 5 is
already empty, Phase 7 (decommission) can follow immediately after cutover.

---

## 2. Current-state inventory of `nemoclaw-project`

### 2.1 What exists

- **`bootstrap.sh`** — idempotent re-establishment of everything inside the
  sandbox that does not survive a destroy/rebuild (only `/sandbox/.openclaw`
  survives): SSH key/config/proxy-helper deployment, network policies,
  main-agent identity files,
  this repo's own in-sandbox clone (+ 10-min hard-reset sync cron), GitHub
  MCP registration (dual: `nemoclaw mcp add` AND `openclaw mcp add`),
  per-registered-repo deployment (clone, watcher script, watcher cron,
  escalation/reviewer agent workspaces), and a security-hardening pass
  (LLM timeout 600s, maxTokens 32000, web-tool deny for the small model,
  plugin allowlist, final chmod pass that must run last).
- **`registry/repos.json` + `registry/schema.md`** — git-tracked source of
  truth for monitored repos; deployed as a runtime copy to
  `/sandbox/pilot-state/registry.json`. One real entry today: `api-rag`
  (`ssh_host: server5`, `container_dev: svc-rag-dev`,
  trunk `dev`, secondary `main`, write-capable).
- **`scripts/register-repo.sh` / `toggle-repo.sh` / `deregister-repo.sh` /
  `resync-repo.sh`** — registry-driven onboarding: write the registry entry,
  render per-repo files from templates, deploy to the sandbox, create the
  watcher cron. Must run on Server 6's host shell (they call
  `docker`/`nemoclaw` against the real container).
- **`templates/`** —
  - `watcher.sh.tmpl`: cheap-tier cron watcher (every 90s). Pulls
    `docker logs --since` + `docker inspect` over SSH, greps an error
    pattern, applies a suppressions file and a cooldown/dedup mechanism,
    then escalates by invoking the per-repo escalation agent with a prompt
    whose closing instruction reflects the `modifications_enabled` toggle
    (read at prompt time, not deploy time). SSH failure ≠ "no logs": it
    exits without advancing state so the next cycle retries.
  - `agent-{readonly,writecapable}/AGENTS.md.tmpl` + `TOOLS.md.tmpl`,
    `reviewer-{readonly,writecapable}/...`: the per-repo escalation agent's
    staged fix protocol (Stage 0 refresh clone → investigate → divergence
    check → worktree fix → verify + independent reviewer-agent second
    opinion → ask permission → push + PR → human merges → cleanup) and its
    action-category boundaries (never merge, never touch other
    hosts/repos, never `--no-verify`, ask before push/PR/suppression).
  - `pre-push-hook.sh.tmpl`: mechanical (non-agent-dependent) push gate —
    fails closed if the registry is missing, blocks push when
    `modifications_enabled` is false, `py_compile`s changed `.py` files,
    scans the pushed diff for secret patterns.
  - `server5-readonly-wrapper.sh.tmpl` + `scripts/generate-server5-wrapper.sh`:
    the Server 5 forced-command SSH wrapper — a regex allowlist of exact
    `docker logs/inspect/stats`, `nvidia-smi`, `free -m`, `df -h` command
    shapes for currently-registered containers. Regenerated on every
    registry change; redeployed to Server 5 by a human.
- **`policies/`** — NemoClaw network-policy presets:
  `server5-readonly-monitoring.yaml` (ssh binary → 203.0.113.10:19030 only)
  and `git-remote-helper.yaml` (git + its remote-http(s) helper →
  github.com:443).
- **`ssh/config-ops-nemoclaw`** — sandbox SSH client config: alias
  `server5`, dedicated key `/sandbox/.ssh/server5`, and
  `ProxyCommand python3 /sandbox/.ssh/connect-proxy.py <ip> <port>`
  (the sandbox's only egress is an HTTP forward proxy; `connect-proxy.py`
  does a manual HTTP CONNECT so ssh can traverse it).
- **`workspace/IDENTITY.md` / `USER.md`** — main-agent identity (team-facing
  ops bot "NemoClaw Ops"), deployed by bootstrap step 5.

### 2.2 What is coupled to Server 5 / Docker (must change)

| Component | Coupling |
|---|---|
| `ssh/config-ops-nemoclaw` | only host alias is `server5` |
| `policies/server5-readonly-monitoring.yaml` | hardcodes 203.0.113.10:19030 |
| `templates/server5-readonly-wrapper.sh.tmpl`, `scripts/generate-server5-wrapper.sh`, `scripts/dev-nemoclaw-server-readonly-wrapper.sh` | the whole allowlist-wrapper mechanism is Docker-CLI-shaped |
| `registry/schema.md` / `repos.json` | `ssh_host` + `container_dev` assume "a Docker container reachable over an SSH alias" |
| `templates/watcher.sh.tmpl` | `docker logs --since` / `docker inspect` command forms; single-container model (one container, one RestartCount) |
| `scripts/register-repo.sh` | `KNOWN_SSH_HOSTS=(server5)`; `--container` flag; calls `generate-server5-wrapper.sh`; validation text |
| `bootstrap.sh` step 1 + verification lines | deploys the server5 key; verifies with `ssh server5 nvidia-smi` / expects `docker kill` rejection |
| Agent/reviewer templates + `IDENTITY.md` | wording: "container `{{CONTAINER_DEV}}` on `{{SSH_HOST}}`", "forced-command wrapper", deploy-and-observe via SSH-to-docker |

### 2.3 What is runtime-agnostic (carries over unchanged or nearly so)

GitHub MCP (both registration steps +
the rotating-IP `mcp restart` gotcha); the in-sandbox git clones and the
whole fix-branch → worktree → PR → human-merge protocol; the pre-push hook;
the cooldown/dedup/suppressions mechanism in `lib/watcher-common.sh`; the
registry-driven register/toggle/deregister/resync tooling shape; the
secrets discipline (`.env`, human-run bootstrap); the "run on Server 6 host
only" constraint; identity/user workspace deployment; the security
hardening pass.

---

## 3. Target architecture

### 3.1 Access design decision (already made — do not re-litigate)

**Kubernetes RBAC is the authorization boundary; a restricted SSH tunnel is
the transport.** Rationale:

- NemoClaw has **no command-level exec gating** (confirmed: its policy
  schema does network + MCP matching only), so the enforcement must live on
  the remote side regardless.
- A forced-command wrapper parsing `kubectl` arg strings would be far
  weaker than the Server 5 Docker wrapper was: kubectl's surface is huge
  (plugins, `--kubeconfig` overrides, `exec`, quoting tricks). Kubernetes
  RBAC is a real permission model — a ServiceAccount bound to
  `get/list/watch` on explicit resources cannot be talked into writing, no
  matter how the command line is phrased.
- Server 2's k3s API port (`K3S_API_PORT`) is assumed firewalled from
  Server 6 (same pattern as Server 5: app ports blocked, SSH open), and
  firewall changes are outside our control. So the kubeconfig points at
  `https://127.0.0.1:<local port>` through an SSH `-L` tunnel.
- The tunnel's SSH key is locked to tunnel-only duty in
  `authorized_keys` — it can never run a command or get a PTY, so SSH adds
  no authority beyond "a pipe to the API server." Defense in depth: network
  policy (ssh binary → SERVER2_IP:SERVER2_SSH_PORT only) → tunnel-only SSH
  key → RBAC read-only ServiceAccount.

**Hotfixes stay in git.** The agent never writes to the cluster. Fix flow is
unchanged: clone → worktree → branch → PR → human merges → the existing
deploy pipeline rolls it out → the watcher observes the rollout through its
read-only credentials. If auto-remediation (e.g. `rollout restart`) is ever
wanted, it gets a **separate, explicitly-granted second Role** later
(see §9) — never a loosening of the monitoring credential.

### 3.2 Component layout (target)

```
Server 6 host (ops-s006)
└── ops-nemoclaw sandbox (NemoClaw/OpenClaw, egress via HTTP CONNECT proxy)
    ├── main agent "NemoClaw Ops"  ── dashboard (web UI, Gateway WebSocket API)
    ├── per-repo escalation + reviewer agents (unchanged pattern)
    ├── /sandbox/repos/<repo> git clones + worktrees (unchanged)
    ├── kubectl (static binary, correct arch)
    ├── /sandbox/.kube/config  → https://127.0.0.1:16443  (read-only SA token)
    ├── tunnel-keeper (openclaw cron, ~every 1m):
    │     ensures `ssh -N -L 16443:127.0.0.1:K3S_API_PORT server2` is alive
    │     (ProxyCommand connect-proxy.py, BatchMode, ExitOnForwardFailure)
    └── per-repo watcher crons (every 90s): kubectl logs/get → grep → escalate

Server 2 (k3s)
├── sshd: SERVER2_SSH_USER with authorized_keys line:
│     command="/bin/false",restrict,port-forwarding,permitopen="127.0.0.1:K3S_API_PORT" <key>
│     (no shell, no exec, no PTY — transport only; the command="/bin/false"
│     is what actually blocks exec, restrict alone does not)
└── k3s API server
      └── ServiceAccount ops-nemoclaw-monitor (ns: ops-monitoring)
          bound to ClusterRole ops-nemoclaw-readonly:
          get/list/watch on pods, pods/log, events, services, endpoints,
          deployments, replicasets, statefulsets, daemonsets, jobs,
          cronjobs, nodes, namespaces — EXPLICITLY NOT secrets, and no
          create/update/patch/delete/exec/portforward on anything

Server 5 (legacy, until decommission)
└── existing forced-command wrapper path, unchanged while any
    runtime.type == "docker" entry remains registered
```

Tunnel placement decision: the tunnel runs **inside the sandbox**,
supervised by a cron watchdog — not on the Server 6 host. Reasons: the
sandbox's proxy-only egress means an in-sandbox `ssh` (with the existing
`connect-proxy.py` ProxyCommand pattern) is the path of least resistance; a
host-side tunnel would need loopback-vs-bridge network gymnastics for the
sandbox to reach it; the sandbox is destroyed/rebuilt regularly, so an
in-sandbox tunnel dies and is recreated with it (no orphan-tunnel risk on
the host — a real past incident: orphaned host-side `nemoclaw-start` SSH
tunnels once caused a 500+ device-pairing spam bug).

### 3.3 Registry schema: generalized runtime

Replace the flat `ssh_host` + `container_dev` pair with a tagged `runtime`
object. Both types remain valid until Server 5 is decommissioned:

```jsonc
// Docker (legacy, unchanged semantics):
"runtime": {
  "type": "docker",
  "ssh_host": "server5",
  "container_dev": "svc-rag-dev"
}

// Kubernetes (new):
"runtime": {
  "type": "k8s",
  "cluster": "server2",            // must match a configured kubeconfig/tunnel
  "namespace": "platform",           // per-service, from §1 fact-gathering
  "workload_kind": "deployment",   // deployment | statefulset
  "workload_name": "api-rag",
  "container": "api-rag"           // container name within the pod, for -c
}
```

All other fields (`clone_url`, `trunk_branch`, `secondary_branch`,
`cooldown_seconds`, `error_pattern`, `suppress_regex`,
`monitoring_enabled`, `modifications_enabled`, `model`,
`correlate_with`, timestamps) are unchanged. Migration of the existing
`api-rag` entry = rewrite its `ssh_host`/`container_dev` into a `runtime`
object (type `docker` first, flipped to `k8s` at cutover — see Phase 7).

### 3.4 The k8s watcher (replaces docker-command pulls, keeps everything else)

Same skeleton as `watcher.sh.tmpl` (state file, dedup/cooldown,
suppressions, monitoring toggle with the jq-`//` guard, escalation prompt
construction, `openclaw agent ... --deliver`). The data-collection section
changes to, per cycle:

1. `kubectl get pods -n <ns> -l <selector-of-workload> -o json`
   — derive per-pod: phase, container `restartCount`, waiting reason
   (`CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled` in
   lastState.terminated), readiness. The label selector should be read from
   the workload (`kubectl get deployment <name> -o jsonpath=
   '{.spec.selector.matchLabels}'`) at render/deploy time, or simply use
   `-l app=<workload_name>` if that's the convention — confirm per §1.
2. `kubectl logs --since-time=<RFC3339-of-last-check> -n <ns> --prefix
   --all-containers <pod>` for each pod (or
   `kubectl logs -n <ns> <kind>/<name>` accepting kubectl's single-pod
   pick, but per-pod iteration is more faithful for multi-replica) — grep
   `error_pattern`, apply suppressions.
3. `kubectl get events -n <ns> --field-selector
   involvedObject.name=<pod>,type=Warning -o json` since last check —
   Kubernetes-native signal Docker never had (probe failures, scheduling
   problems, image pulls); treat novel Warning events as incident input.

Incident triggers (analogous to today's three): novel error-pattern log
lines; any pod's restartCount increased; any pod not Running/Ready (or
workload's `readyReplicas` < `spec.replicas`); novel Warning events.

State tracking must become **per-pod aware**: pods are cattle — a pod name
disappearing because of a normal rollout is not an incident (detect
rollouts via `kubectl rollout status --watch=false` or generation/
observedGeneration; a fresh ReplicaSet + old pods terminating during a
deploy window is expected). Keep it simple: track
`<pod-uid>:<restartCount>` pairs; ignore disappeared pods unless the
workload's ready count is short.

Failure semantics carry over exactly: **a kubectl/tunnel failure is NEVER
"no news"** — do not advance the since-time state, log loudly, exit
nonzero, retry next cycle (mirror today's `ssh_pull` nameref pattern; add
a `kubectl_pull` helper to `lib/watcher-common.sh` with the same contract).
Additionally: if the tunnel is down, the watcher's kubectl calls fail with
connection-refused — that is the tunnel-keeper's problem to fix; the
watcher just refuses to advance state (and, if failures persist past N
cycles, escalates a "monitoring itself is blind" incident — absence of
telemetry must be loud, matching the existing fail-safe philosophy).

---

## 4. Non-negotiable invariants (hard-learned; violating these repeats past incidents)

1. **Secrets never pass through an AI agent.** `.env` stays gitignored;
   `bootstrap.sh` and any step touching real tokens/keys is run by a human
   in their own terminal. SA tokens and SSH private keys are secrets. Never
   print a kubeconfig containing its token into a transcript.
2. **Never embed credentials in git URLs** you might echo
   (`https://user:pat@...` persists in `.git/config`; two real PATs were
   leaked and revoked this way). `credential.helper store` + plain URLs.
3. **jq's `//` operator treats explicit `false` as absent.** Every boolean
   registry read must use the raw-read-then-string-compare pattern already
   used in `watcher.sh.tmpl` and `pre-push-hook.sh.tmpl`. Copy it.
4. **NemoClaw network policies are binary-aware.** A policy allows
   host+port **per binary path**. The kubectl→127.0.0.1 loopback traffic is
   in-sandbox and unproxied, but the tunnel's `ssh` to Server 2 needs
   `/usr/bin/ssh` listed for SERVER2_IP:SERVER2_SSH_PORT. When testing a
   policy, test with the real binary — `curl` probes will show
   `policy_denied` even when the policy is correct.
5. **Restart the gateway with `nemoclaw <name> gateway restart`, never
   `docker restart`** (PID-1 gate: a raw container restart is not
   auto-recoverable).
6. **First `openclaw cron add` on a fresh sandbox/device needs an
   `operator.admin` approval dance** performed inside ONE continuous
   `nemoclaw <name> connect` session (trigger → `openclaw devices list` →
   `openclaw devices approve <id>` → retry, without exiting). Expect this
   when re-creating crons after any rebuild.
7. **Config file permissions don't stick while the gateway runs** — the
   chmod pass is always the last step of any config-touching session.
8. **Registry/host scripts run on Server 6's host shell only** — anywhere
   else they silently half-work (registry written, deployment no-op'd).
9. **AGENTS.md prohibitions are instructions, not enforcement.** Anything
   that must hold against a confused/compromised agent needs a mechanical
   gate: network policy, authorized_keys restrictions, RBAC, the pre-push
   hook. Design every new capability with this split in mind.
10. **All tooling must support x86_64 AND ARM64** (project requirement) —
    applies to the kubectl binary fetch and anything else added.

---

## 5. Phased work plan

Ordering principle: build the Server 2 path **alongside** the Server 5 path
(parallel-run), cut over per-repo, then decommission. No big-bang.

### Phase 0 — fact gathering
Fill in every placeholder in §1. Record answers at the top of a new
`docs/server2-facts.md` (non-secret facts only). Blockers for later phases
if skipped.

### Phase 1 — Server 2 access foundation

New git-tracked files:

- **`k8s/rbac-readonly.yaml`** — namespace `ops-monitoring`;
  ServiceAccount `ops-nemoclaw-monitor`; ClusterRole
  `ops-nemoclaw-readonly` with rules exactly:
  ```yaml
  - apiGroups: [""]
    resources: [pods, pods/log, events, services, endpoints, nodes, namespaces]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, replicasets, statefulsets, daemonsets]
    verbs: [get, list, watch]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
  ```
  ClusterRoleBinding; plus a `kubernetes.io/service-account-token` Secret
  (k8s ≥1.24 no longer auto-creates one) for a long-lived token, with a
  comment noting it's rotatable by deleting/recreating that Secret.
  **Deliberately absent:** `secrets`, `configmaps` (may hold credentials),
  any write verb, `pods/exec`, `pods/portforward`.
- **`k8s/README.md`** — the human-run application recipe (§6 step 2) and
  the token-extraction one-liner
  (`kubectl -n ops-monitoring get secret ... -o jsonpath='{.data.token}' | base64 -d`).
- **`kube/config-server2.tmpl`** — kubeconfig template: cluster
  `server2` → `server: https://127.0.0.1:16443`,
  `certificate-authority-data: {{K3S_CA_B64}}` (from Server 2's
  `/etc/rancher/k3s/k3s.yaml`; k3s API certs include 127.0.0.1 in their
  SANs by default, so TLS verifies cleanly through the tunnel —
  if it doesn't, set `tls-server-name`, never `insecure-skip-tls-verify`),
  user token `{{K8S_SA_TOKEN}}`. Rendered and deployed **by bootstrap.sh
  from `.env` values**, never committed rendered.
- **`policies/server2-k8s-tunnel.yaml`** — ssh binary →
  SERVER2_IP:SERVER2_SSH_PORT, access full, mirroring the server5 preset's
  shape (keep its "defense-in-depth, not the only gate" description
  style — here the real gate is RBAC + the tunnel-only key).
- **`ssh/config-ops-nemoclaw`** — add:
  ```
  Host server2
      HostName SERVER2_IP
      Port SERVER2_SSH_PORT
      User SERVER2_SSH_USER
      IdentityFile /sandbox/.ssh/server2
      ProxyCommand python3 /sandbox/.ssh/connect-proxy.py SERVER2_IP SERVER2_SSH_PORT
      StrictHostKeyChecking accept-new
      BatchMode yes
      ServerAliveInterval 30
      ServerAliveCountMax 3
      ExitOnForwardFailure yes
  ```
- **`scripts/tunnel-keeper.sh`** — idempotent watchdog run by an openclaw
  cron every minute: if nothing is listening on 127.0.0.1:16443 (check
  cheaply, e.g. bash `/dev/tcp` probe or `kubectl version --request-timeout=2s`
  against it), kill any stale `ssh -N -L 16443` process it owns and start
  `ssh -N -f -L 16443:127.0.0.1:K3S_API_PORT server2`, logging to
  `/sandbox/pilot-state/tunnel-keeper.log`. Must be a no-op when healthy
  (runs every minute forever). Also expose
  `tunnel-keeper.sh status` for agents/humans.
- **`.env.example`** — add `K8S_SA_TOKEN=` and `K3S_CA_B64=` (with the
  same "never commit / never paste into an AI session" warnings).

`bootstrap.sh` additions (new step alongside step 1, same idempotent
style): deploy `/sandbox/.ssh/server2` key (`docker cp` from
`~/.ssh/ops-nemoclaw-to-server2`), updated ssh config, chmod/chown pass;
install kubectl if missing (static binary for the verified arch, pinned
version, into `/sandbox/bin/`); render + deploy the kubeconfig to
`/sandbox/.kube/config` (mode 600, owned by sandbox); apply
`server2-k8s-tunnel.yaml` policy; deploy `tunnel-keeper.sh` and add its
cron (`--no-deliver`, guard with `cron_job_exists`); then verify:
`kubectl get pods -A` (or scoped) succeeds AND
`kubectl auth can-i delete pods -A` returns "no" AND
`kubectl get secrets -A` is Forbidden AND `ssh server2 "whoami"` is
rejected (forced-command/restrict means no exec).

### Phase 2 — registry schema generalization

- Update `registry/schema.md` per §3.3 (document both runtime types; mark
  `docker` as legacy-until-decommission).
- Migrate `registry/repos.json`'s `api-rag` entry to the nested `runtime`
  form (still `type: docker` at this point — behavior-preserving).
- Update every consumer of `.ssh_host` / `.container_dev`:
  `register-repo.sh` (new flags: `--runtime docker|k8s`, then either
  `--ssh-host/--container` or `--namespace/--workload-kind/--workload-name/
  --k8s-container`, with validation per type; `KNOWN_SSH_HOSTS` becomes
  per-docker-runtime validation and a `KNOWN_K8S_CLUSTERS=(server2)`
  check), `toggle-repo.sh`, `deregister-repo.sh`, `resync-repo.sh`,
  `generate-server5-wrapper.sh` (now selects only
  `runtime.type=="docker" and runtime.ssh_host=="server5"` entries),
  `bootstrap.sh` step 8, and the render-args plumbing.

### Phase 3 — k8s watcher template

- New `templates/watcher-k8s.sh.tmpl` implementing §3.4. Keep
  `templates/watcher.sh.tmpl` (rename to `watcher-docker.sh.tmpl`) for
  legacy entries; `register-repo.sh`/`toggle-repo.sh`/`resync-repo.sh`/
  `bootstrap.sh` pick the template by `runtime.type`.
- Add `kubectl_pull` (same nameref/status contract as `ssh_pull`) and any
  shared JSON-parsing helpers to `scripts/lib/watcher-common.sh`. The
  sandbox has `jq` — use it for pod-state extraction rather than fragile
  jsonpath chains.
- New template tokens: `{{NAMESPACE}}`, `{{WORKLOAD_KIND}}`,
  `{{WORKLOAD_NAME}}`, `{{K8S_CONTAINER}}`, `{{CLUSTER}}` (and drop
  `{{SSH_HOST}}`/`{{CONTAINER_DEV}}` from the k8s render path).
- Blind-monitoring escalation: after N (suggest 5) consecutive
  kubectl-failure cycles, escalate once (with its own cooldown) so a dead
  tunnel/API becomes a reported incident rather than silence.

### Phase 4 — agent/reviewer template generalization

- Parameterize the runtime-specific wording in all four
  `AGENTS.md.tmpl`/`TOOLS.md.tmpl` pairs. Options: a `{{RUNTIME_BLURB}}` /
  `{{OBSERVE_COMMANDS}}` token rendered per type, or split template dirs
  per runtime (mirroring the watcher split). Prefer tokens — the staged
  protocol text (95% of the file) is identical and must not fork.
- k8s TOOLS.md content: the exact read-only observation commands
  (`kubectl get pods/-o json`, `kubectl logs --since-time`,
  `kubectl get events`, `kubectl rollout status`, `kubectl describe pod`),
  a plain statement that credentials are read-only ServiceAccount-scoped
  (RBAC will Forbid anything else — that's the boundary working, not an
  obstacle; same framing as the existing SSH-boundary prohibition), and
  tunnel awareness ("connection refused to 127.0.0.1:16443 means the
  tunnel is down — report it, check `tunnel-keeper.sh status`, do not try
  alternative routes to the cluster").
- "Deploy-and-observe" (Stage 3 optional check) changes meaning: on k8s
  the agent cannot deploy at all. Replace with: after a human merges and
  the pipeline deploys, the agent may (on request) observe
  `kubectl rollout status` + fresh logs/events and report whether the fix
  landed cleanly. The **prohibited** list gains: any `kubectl` write verb,
  `exec`, `port-forward`, `--kubeconfig` overrides, or attempting to reach
  the API server other than via the provided kubeconfig.
- Update `workspace/IDENTITY.md`'s reach paragraph: "read-only Kubernetes
  ServiceAccount (RBAC-enforced server-side) for Server 2 workloads;
  forced-command SSH wrapper for remaining Server 5 containers."

### Phase 5 — onboarding-tool polish

- `register-repo.sh` prints, for k8s registrations, the (unchanged-shape)
  manual clone + pre-push-hook steps, and — replacing the wrapper-redeploy
  prompt — a note that no server-side change is needed for a new k8s repo
  **as long as** its namespace is covered by the ClusterRole (it is, since
  the role is cluster-scoped read-only; if the org later narrows to
  per-namespace Roles, `register-repo.sh` should print the new
  RoleBinding to apply).
- `generate-server5-wrapper.sh`: unchanged behavior, but now no-ops
  gracefully (and removes stale allowlist entries) as docker entries
  drain away.

### Phase 6 — bootstrap.sh consolidation

Fold Phases 1–4's deployment steps into `bootstrap.sh` so a fresh
destroy/rebuild restores the entire k8s path with zero memory: ssh
key/config, kubectl, kubeconfig render, tunnel policy, tunnel-keeper +
cron, per-repo watcher (type-selected), agent workspaces. Update the
final verification block (§7 checklist below is the source). Remember
invariant 6 (cron approval dance) and 7 (chmod last).

### Phase 7 — cutover and decommission

1. When `api-rag` (and each subsequent service) is live on Server 2 k3s:
   flip its registry `runtime` to the `k8s` form via `toggle-repo.sh` (add
   a `--set-runtime` capability or re-register), redeploy its watcher,
   `resync-repo.sh` its agent docs. Run both old and new watchers in
   parallel for a burn-in window ONLY if the Docker container still runs;
   otherwise the docker watcher is already dead weight — remove it.
2. When the last `runtime.type=="docker"` entry is gone: remove the
   server5 SSH alias/key deployment from `bootstrap.sh`, remove
   `policies/server5-readonly-monitoring.yaml` from the policy-add list,
   ask a human to delete the wrapper + authorized_keys line on Server 5,
   and move the wrapper template/generator to an `attic/` dir (or delete —
   git history keeps them).
3. Update `README.md` throughout (it is heavily Server-5-flavored today):
   layout section, setup section (§6 below becomes its content), gotchas
   (keep every gotcha that isn't Server-5-specific — most aren't).

---

## 6. One-time human-run steps (NEVER performed by an AI agent — they touch real secrets/authorized_keys)

1. **Keypair:** `ssh-keygen -t ed25519 -f ~/.ssh/ops-nemoclaw-to-server2
   -C ops-nemoclaw-tunnel@server6 -N ""` on Server 6. Do not reuse the
   server5 key.
2. **Server 2 SSH account:** ensure `SERVER2_SSH_USER` exists (no sudo, no
   group memberships beyond its own); append to its
   `~/.ssh/authorized_keys`:
   ```
   command="/bin/false",restrict,port-forwarding,permitopen="127.0.0.1:K3S_API_PORT" ssh-ed25519 AAAA... ops-nemoclaw-tunnel@server6
   ```
   (**`command="/bin/false"` is what actually blocks command execution —
   `restrict` alone does NOT do this**, it only bundles no-pty/no-agent-
   forwarding/no-X11/no-user-rc/no-port-forwarding; confirmed live
   2026-07-22 via `ssh -v`, which showed the server's parsed key options as
   `command permitopen port-forwarding` and substituted `/bin/false` for
   the requested command. `port-forwarding` re-enables only forwarding;
   `permitopen` pins the one destination.)
3. **RBAC:** with cluster-admin on Server 2:
   `kubectl apply -f k8s/rbac-readonly.yaml`, then extract the SA token and
   the cluster CA (`base64 -w0` both) into Server 6's `.env` as
   `K8S_SA_TOKEN` / `K3S_CA_B64`. Transfer via a direct shell session —
   not chat, not a ticket, not an agent transcript.
4. **Sanity-check the boundary from Server 6 host** before wiring the
   sandbox: tunnel up manually, then with the rendered kubeconfig confirm
   `kubectl auth can-i --list` shows only get/list/watch, and
   `kubectl get secrets -A` → Forbidden, `kubectl delete pod xyz` →
   Forbidden, `ssh server2 whoami` → rejected.
5. Run `bash bootstrap.sh` yourself (per its own header rule).

---

## 7. Verification checklist (end state)

Access boundary:
- [ ] `nemoclaw ops-nemoclaw exec -- kubectl get pods -n <ns>` returns real pods
- [ ] `... kubectl get secrets -A` → `Forbidden`
- [ ] `... kubectl delete pod <any> -n <ns>` → `Forbidden`
- [ ] `... kubectl exec <pod> -n <ns> -- true` → `Forbidden`
- [ ] `... kubectl auth can-i create deployments -A` → `no`
- [ ] `... ssh server2 "whoami"` → rejected (no exec via tunnel key)
- [ ] From the sandbox, direct `https://SERVER2_IP:K3S_API_PORT` is unreachable (network policy: only ssh binary to the SSH port is allowed)

Pipeline:
- [ ] Kill the tunnel process → tunnel-keeper restores it within ~1 min; watcher cycles during the gap logged as failures WITHOUT advancing since-time state
- [ ] Inject a fake error line into the monitored workload's logs (or temporarily narrow `error_pattern`) → escalation arrives with correct pod context; repeat within cooldown → suppressed
- [ ] `kubectl rollout restart` performed by a human → watcher does NOT fire an incident for the normal pod replacement (but would for a CrashLoopBackOff)
- [ ] `modifications_enabled: false` → escalation prompt carries the read-only closing instruction AND a test push from the repo clone is blocked by the pre-push hook
- [ ] Full staged-protocol dry run on a trivial fix: worktree → reviewer second opinion → Stage 4 permission ask reported to the human → push + PR on approval → human merge → Stage 6 cleanup
- [ ] Destroy/rebuild the sandbox, re-run `bootstrap.sh` → everything above still true (the real test of Phase 6)

Regression (while any docker entry remains):
- [ ] `ssh server5 "nvidia-smi"` still works; `ssh server5 "whoami"` still rejected; docker-type watcher unaffected

---

## 8. Explicitly out of scope for this migration

- Any write access to the cluster (see §9).
- Multi-cluster support beyond `server2` (schema allows it via
  `runtime.cluster`; tooling validates against a known list).
- The `correlate_with` multi-repo correlation feature (still reserved).
- Porting `local-nemoclaw`'s personal pilots (separate repo, separate
  instance, stays that way).
- Prometheus/metrics-based monitoring — log/state/event polling is the
  established pattern; metrics can layer on later without changing the
  access design.

## 9. Future (design for, don't build): scoped remediation role

If the team later wants bounded auto-remediation (e.g. the agent may
`rollout restart` a specific deployment after approval), implement as:
separate ServiceAccount + Role granting exactly
`deployments/{get}` + the `patch` verb on named resources in one
namespace, a separate kubeconfig deployed only when a registry-level
`remediation_enabled` flag is true, and the same ask-every-time permission
bar as `git push`. RBAC makes this an additive grant; nothing in the
monitoring path loosens. The registry schema should gain the flag then,
not now.
