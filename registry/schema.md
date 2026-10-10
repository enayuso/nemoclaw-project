# `registry/repos.json` schema

Git-tracked source of truth for every repo registered into the monitoring/
auto-fix system. Not secrets, not ephemeral state — this is configuration,
same category as `policies/*.yaml`. Deployed into the sandbox at
`/sandbox/pilot-state/registry.json` by `register-repo.sh`/`toggle-repo.sh`/
`deregister-repo.sh`/`bootstrap.sh` (every write to the git-tracked copy
gets `docker cp`'d in, since nothing under `/sandbox` outside `.openclaw`
survives a rebuild).

One object, keyed by a short repo key (the same string used to name its
generated agents/scripts — `<key>-escalation`, `<key>-reviewer`,
`<key>-watcher.sh`). Each entry:

| Field | Type | Meaning |
|---|---|---|
| `clone_url` | string | Full `https://` clone URL (may embed credentials at clone time — see `register-repo.sh`'s secret-handling note, never committed with a real token in it) |
| `repo_org_slash_name` | string | `ORG/repo-name`, used in generated PR-URL examples and `gh` invocations |
| `runtime` | object | **Tagged union, added 2026-07-21** — see "Runtime object" below. Replaces the old flat `ssh_host`/`container_dev` pair |
| `trunk_branch` | string | e.g. `"main"` — the only PR target in V1 (no multi-branch promotion dance; see `investment-pilot`'s hand-built `main`→`dev` flow, in the separate `local-nemoclaw` repo, as the reference pattern if a repo genuinely needs that later) |
| `secondary_branch` | string \| null | **Implemented** (added 2026-07-20, `--secondary-branch` on `register-repo.sh`): for repos with a dev/main split, the write-capable agent checks this against `trunk_branch` for divergence before preparing any fix, stopping to ask the human how to proceed if they've diverged. Set to `null`/omit for repos with no such split. Distinct from a promotion-dance feature (auto-promoting a fix from one branch to another) — that's still unimplemented; this is a divergence *check*, not an auto-merge |
| `cooldown_seconds` | number | Dedup/escalation-cooldown window, same mechanism as `investment-watcher.sh`/`svc-monitor.sh` (in `local-nemoclaw`) |
| `error_pattern` | string | grep -E alternation for "novel" log lines (e.g. `"ERROR\|CRITICAL\|Traceback\|Exception"`) |
| `suppress_regex` | string \| null | Reserved; the actual suppression mechanism is the separate `<key>-watcher-suppressions.txt` file, not this field |
| `monitoring_enabled` | bool | Cheap runtime toggle, checked by the watcher script every cycle |
| `modifications_enabled` | bool | **Mechanically enforced** by the rendered pre-push hook, not just agent-instructed — see `templates/pre-push-hook.sh.tmpl`. Safe default for a newly registered repo: `false` |
| `pr_review_enabled` | bool | **Added 2026-08-12.** Independent of the two toggles above: when true, `<key>-pr-watcher.sh` polls this repo's OPEN PRs and posts a `<key>-pr-reviewer` review as a PR comment. Entirely read-only against the repo (it comments, never pushes/merges), so it is *not* gated on `modifications_enabled` — a repo can be review-only, fix-only, both, or neither. Safe default for a newly registered repo: `false`. See "PR review" below |
| `model` | string | OpenClaw model ref for the generated agents |
| `correlate_with` | string[] \| null | **Implemented 2026-07-22** (widened from the reserved single-string/null shape) — repo keys of *other registered repos* this one is directly related to (e.g. a service that calls it, or that it calls). See "Cross-repo awareness" below for exactly what this does and doesn't grant. `null`/omit for a repo with no known relations. |
| `created_at` / `updated_at` | ISO 8601 string | Set/updated by `register-repo.sh`/`toggle-repo.sh` |

## Runtime object

Tagged by `type`. **`docker` is retired as of 2026-07-22** (Phase 7 of
`docs/k8s-migration-architecture.md`, alongside Server 5's decommission —
every workload had already moved to Server 2 k3s). The schema keeps the
`docker` form for historical/documentation purposes (it's not
deprecated-and-broken code, `register-repo.sh --runtime docker` still
parses and validates it correctly), but `register-repo.sh`'s
`KNOWN_SSH_HOSTS` is now empty, so no new `docker`-type entry can actually
be registered until a genuinely new Docker-hosted target is added there
*and* the forced-command wrapper machinery is revived from `attic/` (see
`register-repo.sh`'s header comment). No `docker`-type entry exists in
`registry/repos.json` today.

**`type: "docker"`** — a plain Docker container reachable over an SSH
alias (the original, pre-2026-07-21 shape, just nested now; illustrative
only today — `server5` is no longer a valid `ssh/config-ops-nemoclaw`
alias):
```jsonc
"runtime": {
  "type": "docker",
  "ssh_host": "server5",              // must be an alias in ssh/config-ops-nemoclaw
  "container_dev": "svc-rag-dev"
}
```
Renders from `templates/watcher-docker.sh.tmpl` (formerly `watcher.sh.tmpl`
— renamed 2026-07-21 to make room for the k8s sibling, content unchanged).

**`type: "k8s"`** — a Kubernetes Deployment/StatefulSet, reached via the
read-only RBAC ServiceAccount + tunnel-only SSH key described in
`docs/k8s-migration-architecture.md`:
```jsonc
"runtime": {
  "type": "k8s",
  "cluster": "server2",                          // must match a configured kubeconfig/tunnel - only "server2" exists today
  "namespace": "dev",                             // the real namespace the dev workloads run in
  "workload_kind": "deployment",                  // deployment | statefulset
  "workload_name": "svc-rag-dev",
  "container": "svc-rag-dev",      // container name within the pod, for future -c use (exec/attach) - not used by the read-only watcher today
  "label_selector": "app=svc-rag-dev"  // passed verbatim to `kubectl -l` - defaults to `app=<workload_name>` at registration if not given explicitly. VERIFIED 2026-08-12 against the real `spec.selector.matchLabels` for all 7 registered repos (see "Known gaps"); still verify it for any NEWLY registered repo, since a wrong selector means zero matching pods silently rather than an error
}
```
Renders from `templates/watcher-k8s.sh.tmpl` (new 2026-07-21).

## Cross-repo awareness (`correlate_with`)

Added 2026-07-22, motivated directly by a real incident: a fix prepared for
one service turned out to need verification against a related one, and the
existing per-repo isolation had no way to express "these repos are part of
the same system" at all. The design deliberately does **not** relax the
existing hard boundary — *"this fix-and-PR capability applies only to
`{{REPO_NAME}}`... touching any repo other than it is Prohibited"* — every
write-capable/read-only escalation agent still only ever prepares, pushes,
or PRs changes for its own registered repo, full stop.

What `correlate_with` actually enables: an escalation agent (write-capable
or read-only) may **read** (never write) a correlated repo's shared clone
at `/sandbox/repos/<other-repo-name>` to check whether an incident's real
root cause, or a fix's full correctness, depends on something there. If it
finds a genuine connection, it **notifies that other repo's own escalation
agent directly** — same mechanism already used for the mandatory reviewer
second-opinion call (`openclaw agent --agent <other-repo>-escalation`),
handing off a lead, not a directive. The other agent decides independently whether
and how to act, through its own complete staged protocol (own
investigation, own reviewer, own human permission gate). This mirrors how
a well-scoped assistant should behave when a fix crosses a boundary it
doesn't own: read broadly to understand, but hand off anything outside its
own scope to whatever/whoever actually owns it, rather than quietly
expanding its own mandate.

Populate it symmetrically where a real relationship exists (e.g. if `A`
calls `B`, both `A.correlate_with` and `B.correlate_with` should list the
other, not just one direction) — `register-repo.sh --correlate-with
<repo1,repo2,...>` takes a comma-separated list and stores it as a JSON
array.

## PR review (`pr_review_enabled`)

Added 2026-08-12. A third agent per repo, `<key>-pr-reviewer`, rendered from
`templates/pr-reviewer/` and driven by `<key>-pr-watcher.sh` on its own cron
(`PR_WATCHER_CRON_EVERY`, separate from the incident watcher's cadence). It
reviews **every** open PR — agent-authored and human-authored alike — because
the pre-push `{{REVIEWER_AGENT}}` second opinion only covers the former, only
runs if that call succeeds, and lands nowhere a human merger looks.

The loop is deliberately **one-way**: GitHub → agent → GitHub. The PR watcher
never messages an escalation agent, never reads or writes the stage tracker,
and never touches the denials file. A PR review colliding with a stage-4
approve/deny decision is precisely the race the incident watcher's own stage-4
gate exists to prevent, and the cheapest way to be immune to it is to share no
state with it at all.

**The reviewer is fed, not given tools.** Everything it needs — PR metadata,
the unified diff, and the complete post-change contents of each changed file —
is pre-fetched into a single message by the watcher, and the agent is told not
to use tools. This is a measured decision, not a stylistic one (2026-08-12):

| Shape | Result |
|---|---|
| Tool-calling (agent reads files itself) | ~7 min **per model turn**, 3 turns, killed at the 900s timeout with **zero output** |
| Pre-fetched, single turn | **99s**, exit 0, a complete well-formed review |

Tool *results* return in milliseconds; it is the turns that cost minutes
(~25 tok/s decode, ~10k output tokens/turn). Input is nearly free by
comparison — the model's context window is 262144 — so trading a much larger
prompt for one fewer round trip is close to a pure win. The binding constraint
is **not** the context window but `models.providers.inference.timeoutSeconds`
(600), which at that decode rate caps a single call at roughly 15k output
tokens. That is what the size tiers below protect.

Oversized PRs degrade in stated tiers rather than silently truncating — the
comment always says which tier it ran at:

1. **full** — diff + complete contents of every changed file
2. **diff-only** — the diff alone (files were too large to include)
3. **files-only** — no review, just a note naming the PR as too large

## Known gaps as of 2026-07-22

- ~~**`api-rag`'s `label_selector` (`app=svc-rag-dev`) is
  still the unverified `app=<workload_name>` default**, not confirmed
  against the real Deployment's actual pod labels.~~ **Verified 2026-08-12
  and correct** — for `api-rag` and for all seven registered repos, not just
  the one this gap named. Every `label_selector` matches its Deployment's
  real `spec.selector.matchLabels` exactly, and each matches exactly one
  Running pod. Checked with the very command this gap asked for
  (`kubectl get deployment <name> -n dev -o
  jsonpath='{.spec.selector.matchLabels}'`), run through
  `nemoclaw ops-nemoclaw exec --` from Server 6 while building the
  Monitoring log-streaming feature (`docs/monitoring-live-logs.md` §4.6).
  Note for anyone re-running it: `docker exec` cannot reach the cluster at
  all, and the sandbox has its own `/tmp`, so a file staged on the host is
  not visible to the command.
- ~~The k8s watcher template has not yet been exercised against a live
  k8s-type registry entry~~ — **cut over 2026-07-22 (Phase 7).** `api-rag`
  is now `type: "k8s"` (`cluster: server2`, `namespace: dev`,
  `workload_kind: deployment`, `workload_name:
  svc-rag-dev`) — the only registry entry today, and the
  reference example for a real (non-test) `k8s`-type registration.
  Rendered output verified template-side (zero leftover placeholders,
  correct composite tokens); NOT yet verified against the live sandbox
  (this repo's tooling has no reachable `ops-nemoclaw` container from
  where this cutover was made — deploy for real from Server 6, then run
  the "Verification checklist" in `docs/k8s-migration-architecture.md`).
- ~~Agent/reviewer doc templates are NOT yet runtime-aware~~ — **done,
  2026-07-21 (Phase 4).** `templates/agent-*/` and `templates/reviewer-*/`
  now dispatch on `runtime.type` via a shared set of composite tokens
  (`{{TARGET_DESC}}`, `{{ACCESS_METHOD_NOTE}}`, `{{ACCESS_TARGET_LINE}}`,
  `{{ACCESS_BOUNDARY}}`, etc.) computed by `sandbox-helpers.sh`'s
  `compute_agent_doc_tokens`, called from both `register-repo.sh` (fresh
  registration) and `render_and_redeploy_agent_docs` (resync). A
  `type: "k8s"` registration now gets escalation/reviewer agent workspaces
  exactly like `type: "docker"` — no more refusal.

## What's NOT in this schema (by design)

- GitHub PAT/username — those stay in `.env`, never here.
- `investment-pilot`/`svc-monitor` themselves are not registry entries —
  they're the hand-built reference implementations this generalization was
  built from, left untouched for now (see the plan this feature shipped
  from for why). They live in the separate `local-nemoclaw` repo, not here.
