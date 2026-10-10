# nemoclaw-project

> 한국어: [README.md](README.md)

An AI-operations ("AIOps") setup built on **[NVIDIA NemoClaw](https://www.nvidia.com/)** — the sandboxed
runtime for [OpenClaw](https://github.com/openclaw/openclaw) agents. One NemoClaw sandbox watches a set of
backend services running on Kubernetes, and when something breaks it hands the incident to an AI agent that
investigates, explains what happened and — only where explicitly allowed — prepares a fix as a GitHub pull
request that a human must approve.

I built this to understand, hands-on, how far an autonomous agent can be trusted in real operations work
and what has to be enforced *outside* the model (network policy, RBAC, SSH key restrictions, git hooks)
rather than merely asked for in a prompt. Most of the code and documentation in this repo was written in
pair-programming sessions with **Claude Code**.

## What it does

```
 k3s cluster (Server 2)                     NemoClaw sandbox (Server 6)
 ┌──────────────────────┐   SSH tunnel   ┌─────────────────────────────────────────────┐
 │ svc-core, svc-rag,   │◄───(forward────│ tunnel-keeper.sh  (cron, every 1 min)       │
 │ svc-search, …        │    only)       │ watcher.sh per repo (cron) ─► kubectl logs  │
 │ read-only RBAC SA    │                │        │ new error signature?               │
 └──────────────────────┘                │        ▼                                    │
                                         │ <repo>-escalation agent  ─► investigate     │
                                         │        │ (write-capable repos only)         │
                                         │        ▼                                    │
                                         │ prepare fix ─► <repo>-reviewer (2nd opinion)│
                                         │        ▼                                    │
                                         │ ask human ─► push branch / open PR          │
                                         └───────────────┬─────────────────────────────┘
                                                         │ Gateway WebSocket API
                                                ┌────────▼────────┐
                                                │ dashboard/ (web)│  live runs, logs, decisions
                                                └─────────────────┘
```

- **Registry-driven onboarding** — a repo is added with one command (`scripts/register-repo.sh`). The
  registry (`registry/repos.json`) is the single source of truth; per-repo agent docs (`AGENTS.md`,
  `TOOLS.md`), watcher scripts and git hooks are rendered from `templates/`.
- **Watchers** — cron-driven shell scripts pull pod logs over a read-only Kubernetes ServiceAccount,
  de-duplicate error signatures with a cooldown, and escalate only novel incidents.
- **Escalation agents** — read-only by default. A repo flagged `modifications_enabled` gets an agent that
  can reproduce, fix and open a PR, but must stop and ask a human at every irreversible step.
- **Reviewer agents** — a separate "second opinion" agent reviews every proposed fix (and, optionally,
  incoming PRs) before a human sees it.
- **Defense in depth** — tunnel-only SSH key (`command="/bin/false"`, `permitopen`), read-only RBAC with no
  access to secrets, binary-aware NemoClaw network policies, and a pre-push hook that blocks secrets and
  pushes to protected branches.
- **Dashboard** — a Node.js web UI that talks to the OpenClaw Gateway's WebSocket API: send a task to an
  agent, watch it stream (text + tool calls) live, tail pod logs, answer pending decisions.
- **Operational tooling** — rebuild-safety preflight (`check-rebuild-safe.sh`), config-drift detection,
  credential rotation, and a recovery runbook for full sandbox rebuilds.

## Repository layout

| Path | Contents |
|---|---|
| `bootstrap.sh` | Re-establishes everything inside a freshly onboarded sandbox (policies, tunnel, kubeconfig, MCP, registered repos) |
| `scripts/` | `register-repo.sh`, `toggle-repo.sh`, `resync-repo.sh`, `deregister-repo.sh`, `prompt-agent.sh`, `check-rebuild-safe.sh`, `check-config-drift.sh`, `rotate-credentials.sh`, `tunnel-keeper.sh`, shared libs in `scripts/lib/`, bash test harnesses in `scripts/test/` |
| `registry/` | `repos.json` (monitored repos) + `schema.md` (field reference) + bootstrap size limits |
| `templates/` | `.tmpl` sources for agent docs, watchers and the pre-push hook |
| `rendered/` | Rendered output per registered repo (kept in git so template changes are reviewable as diffs) |
| `dashboard/` | Express + `ws` backend and a vanilla-JS frontend; see [`dashboard/README.md`](dashboard/README.md) |
| `k8s/`, `kube/`, `policies/`, `ssh/` | Read-only RBAC manifest, kubeconfig template, NemoClaw network policy presets, SSH client config |
| `skills/` | Installable OpenClaw skills (e.g. `second-opinion-review`) |
| `workspace/` | Identity/user profile for the sandbox's main agent |
| `docs/` | [`operations.md`](docs/operations.md) (full setup + known gotchas), [`recovery.md`](docs/recovery.md), [`k8s-migration-architecture.md`](docs/k8s-migration-architecture.md), [`monitoring-live-logs.md`](docs/monitoring-live-logs.md) |
| `attic/` | Retired code from the earlier Docker/SSH monitoring path, kept for reference |

## Getting started

### Prerequisites

- A Linux host with Docker and [NemoClaw](https://www.nvidia.com/) installed (arm64 or x86_64)
- An OpenAI-compatible inference endpoint (I used a self-hosted vLLM serving a Qwen model)
- A Kubernetes (k3s) cluster to monitor, and cluster-admin once to apply the read-only RBAC
- A GitHub account/PAT for the repos being monitored
- Node.js ≥ 18 for the dashboard; `bash` 5 + `jq` for the shell test harnesses

### Setup (summary — full details in [`docs/operations.md`](docs/operations.md#setup))

```bash
# 1. secrets (never commit .env)
cp .env.example .env            # fill in GITHUB_PAT, K8S_SA_TOKEN, K3S_CA_B64, ...

# 2. create the sandbox (interactive)
NEMOCLAW_GATEWAY_PORT=8180 nemoclaw onboard --name ops-nemoclaw

# 3. one-time cluster access (run as cluster-admin, see k8s/README.md)
kubectl apply -f k8s/rbac-readonly.yaml

# 4. wire everything into the sandbox — run it yourself, not through an agent
bash bootstrap.sh

# 5. verify
nemoclaw ops-nemoclaw doctor
bash scripts/check-rebuild-safe.sh -v
```

### Onboarding a service

```bash
# see the header comment of scripts/register-repo.sh for every option
scripts/register-repo.sh <key> --clone-url https://github.com/<org>/<repo>.git \
  --runtime k8s --namespace dev --workload-kind deployment --workload-name <name> \
  --label-selector app=<name> --modifications off --dry-run
scripts/toggle-repo.sh <key> --modifications on|off    # grant / revoke fix-and-PR capability
scripts/resync-repo.sh --all                           # push template changes to every repo
scripts/prompt-agent.sh <key> escalation -m "Why did the last deploy restart?"
```

### Dashboard

```bash
cd dashboard
cp .env.example .env     # gateway URL/token, login password, session secret
npm ci
npm start                # https://localhost:8443 (if TLS configured)
npm test                 # node --test test/*.test.js
```

## Testing

```bash
cd dashboard && npm test                                         # dashboard unit/integration tests
python3 scripts/check-agent-doc-rules.py                          # rendered agent docs still contain every safety rule
bash scripts/test/watcher-queue.test.sh scripts/lib/watcher-common.sh   # needs bash 5
bash scripts/test/ask-decision.test.sh  scripts/lib/ask-decision.sh
```

## Notes

- Hostnames, IPs (`203.0.113.x` documentation range), accounts and service names in this repo are
  placeholders — replace them with your own.
- `docs/` intentionally keeps the dated engineering notes (incidents, retests after version upgrades) because
  the *why* behind each guardrail is the most useful part of the project.
