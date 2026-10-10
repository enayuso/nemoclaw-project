# TOOLS.md - Local Notes

## Observability access

kubectl IS available inside this sandbox at `/sandbox/.local/bin/kubectl` — **always use that full path, bare `kubectl` fails with "not found"** since that directory isn't on `PATH`. Pointed at a read-only kubeconfig (`/sandbox/.kube/config`) reached through an SSH tunnel `tunnel-keeper.sh` keeps alive — you do not SSH anywhere yourself, it talks to `127.0.0.1:16443` directly.

- namespace `dev` on cluster `server2` — label selector `app=svc-core-dev` matches **`svc-core-dev`**'s pod(s). Other unrelated workloads may run in the same namespace — leave those alone unless explicitly asked.

Example, to check the actual app's own logs (not the watcher's):
```
/sandbox/.local/bin/kubectl -n dev logs -l 'app=svc-core-dev' --all-containers=true --tail=20
```

## svc-core-watcher pilot

`/sandbox/pilot-state/svc-core-watcher.sh` is a cron job that watches
`svc-core-dev` (deployment) in namespace `dev` on cluster `server2` and escalates only novel errors.
`/sandbox/pilot-state/svc-core-watcher.log` is the **watcher's own
operational log** (kubectl/tunnel failures, "clean check" lines, escalation
decisions) — NOT the app's logs. If asked about "the app's logs" or "errors in
the pod," run `kubectl logs` against the workload (see the example above) — don't read the watcher's own log
and assume that answers the question.

It keeps checking every cycle even while it is holding delivery to you (a fix at
stage 4, or the inference backend down). What it finds meanwhile is queued and
handed over one incident per cycle once the hold lifts, so a report can arrive
long after the thing it describes — when that happens the message says so in its
own first lines. Check whether the symptom is still live before treating it as
current.

## What you can see, and what to do when you can't

Your kubeconfig authenticates as a read-only ServiceAccount. You can `get`/`list`/`watch` exactly these: cronjobs, daemonsets, deployments, endpoints, events, jobs, namespaces, nodes, pods, pods/log, replicasets, services, statefulsets. Every write, `exec` and `port-forward` verb is denied, and so are `secrets` and `configmaps` - the latter two deliberately, because they may hold credentials (see k8s/rbac-readonly.yaml's own comment). This is enforced by the cluster, not by this file, so no amount of retrying or rephrasing changes it.

**A refusal is not a finding.** `Forbidden`, `denied`, `not permitted`, and a
command that simply produces nothing all mean *you could not determine this* -
never *this does not exist*. Do not let them collapse into the same branch of a
shell one-liner, and never write a conclusion that treats one as the other. Say
"I could not check X because it is outside my access" and carry on with what you
CAN establish.

This has cost a real fix: an agent ran `kubectl get configmap ...` with
`|| echo "Not found in ConfigMap (or Forbidden)"`, got Forbidden, treated the
repo's config file as authoritative, and prepared a fix that could never reach
the running service — which read its config from the ConfigMap the agent was
not allowed to open. The content was right; it was aimed at the wrong place.

**Before fixing anything config-shaped, establish where the running config comes
from.** You cannot read a ConfigMap or Secret, but you CAN read the Deployment
that mounts them:

```
/sandbox/.local/bin/kubectl -n dev get deployment svc-core-dev -o json | jq '.spec.template.spec | {volumes, containers: [.containers[] | {image, volumeMounts, envFrom, env}]}'
```

Read three things out of it:
- **`volumes[].configMap` / `envFrom[].configMapRef` / `env[].valueFrom`** — if
  what you were about to change is supplied by one of these, editing it in the
  repo changes nothing until that object is updated too.
- **`volumeMounts[].mountPath`** — the exact path the workload reads, so you can
  tell whether it's the same file you found in the repo.
- **`image`** — an upstream image (not built from this repo) means the repo
  cannot be the source of the running config at all.

**A ConfigMap does NOT mean the fix is impossible — find out what generates
it.** This is the trap on the other side, and just as costly: ConfigMap content
is very often built by CI from a file in this very repo, in which case editing
that file IS the correct fix and the only real question is which branch CI builds
from. Seen live here: a Jenkins job runs `kubectl create configmap
... --from-file=<repo path> | kubectl apply -f -` then `kubectl rollout restart`,
checked out from `dev`. The repo file was authoritative all
along; an earlier fix failed only because it was merged to `main`
while CI builds from `dev`.

So look for the deploy job (Jenkinsfile, CI workflow, deploy script) and
establish **which branch it builds from**. If that is not `main`,
merging to `main` alone will never reach the running workload — see
AGENTS.md's Stage 6. Report the branch you found rather than assuming.

**If your fix cannot reach the deployment, say so instead of proposing it.**
Report what the running config is sourced from, what you would have changed, why
it wouldn't take effect, and what would actually need to happen — then stop. A
correct diff aimed where nothing reads it is worse than no diff, because it looks
like the problem was handled. Flag it as an infrastructure finding; do not try to
route around the boundary.

## Suppression list

`svc-core-watcher.sh` reads
`/sandbox/pilot-state/svc-core-watcher-suppressions.txt` in addition to its
hardcoded base patterns — one regex fragment per line, `#`-prefixed and blank
lines ignored. To propose an addition, state the exact line in your report and
wait for permission (same bar as pushing code). On approval:
```
echo '<narrow regex matching the specific benign message>' >> /sandbox/pilot-state/svc-core-watcher-suppressions.txt
```
Confirm what you added. Never edit or remove existing lines unless asked — this
file is also a plain-text audit trail of what's been suppressed and why.

## Stage tracker

`/sandbox/pilot-state/svc-core-escalation-stages.json` is a JSON object keyed by
branch name. `jq` is installed — use it, don't hand-roll JSON with sed. Ensure
the file exists before the first write:
```
[ -f /sandbox/pilot-state/svc-core-escalation-stages.json ] || echo '{}' > /sandbox/pilot-state/svc-core-escalation-stages.json
```

**Check on any invocation:**
```
cat /sandbox/pilot-state/svc-core-escalation-stages.json
```

**Stage 1 has no write.** There is deliberately no "create the entry at stage 1"
command: until Stage 2 there is no worktree and no branch, so there is nothing to
record and nothing for a human to act on. If a benign (or not-my-repo, or
already-fixed-upstream) verdict finds an entry from an earlier invocation, delete
it with the Stage 6 command below — see AGENTS.md's Stage 1 for why an entry
stranded below stage 4 is worse than no entry.

**Stage 2, create the entry.** Two fields are copied **verbatim from the message
that invoked you**, never derived: `session_key` and `incident_signature`.
Nothing in your environment exposes either (there is no `SESSION`-named env var,
and the signature is a hash the watcher computed before calling you). Every
invoking message — watcher report or human message — ends with labelled lines
giving these values. Copy them exactly.

- `session_key` — the dashboard's Approve/Deny buttons and "Open conversation"
  link both target that exact value, so a wrong one silently sends a future
  approve/deny to the wrong place.
- `incident_signature` — how a denial is remembered. It lets the watcher
  recognise the SAME incident later and warn you a fix for it was already
  rejected, instead of you re-proposing it as a fresh idea. A human message
  carries none; omit the field.

If a value's line is genuinely absent, omit that `--arg` and its field entirely
rather than guessing — absent is a handled case, wrong is not.
```
jq --arg b "fix/<slug>" --arg incident "<one-line incident summary>" \
   --arg worktree "/sandbox/repos/svc-core-worktrees/fix-<slug>" \
   --arg session_key "<the value from above>" \
   --arg incident_signature "<the value from above>" \
   --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.[$b] = {incident: $incident, stage: 2, worktree: $worktree, pr_url: null, session_key: $session_key, incident_signature: $incident_signature, updated_at: $ts}' \
   /sandbox/pilot-state/svc-core-escalation-stages.json > /tmp/stages.json.tmp \
   && mv /tmp/stages.json.tmp /sandbox/pilot-state/svc-core-escalation-stages.json
```

**Stage 4 has no jq command of its own** — `ask-decision.sh` below does that
write. Asking and moving the entry to stage 4 are one act, deliberately: the
entry is what makes the question answerable, so a question that skipped it was
never asked.

**Stage 5, record the PR:**
```
jq --arg b "fix/<slug>" --argjson stage 5 --arg url "https://github.com/example-org/svc-core/pull/N" \
   --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.[$b].stage = $stage | .[$b].pr_url = $url | .[$b].updated_at = $ts' \
   /sandbox/pilot-state/svc-core-escalation-stages.json > /tmp/stages.json.tmp \
   && mv /tmp/stages.json.tmp /sandbox/pilot-state/svc-core-escalation-stages.json
```

**Stage 6, or a denied fix — remove the entry:**
```
jq --arg b "fix/<slug>" 'del(.[$b])' /sandbox/pilot-state/svc-core-escalation-stages.json \
   > /tmp/stages.json.tmp && mv /tmp/stages.json.tmp /sandbox/pilot-state/svc-core-escalation-stages.json
```
A denied fix is closed out the same way a merged one is — in both cases there is
nothing left to resume. Only the git cleanup differs: a denied fix was never
pushed, so there is no remote branch and `git push origin --delete` would just
error. See AGENTS.md's "Stage 4, denied".

## Asking for a decision (Stage 4)

One call. Write the report to a file, then:

```
cat > /tmp/stage4-report.md <<'REPORT_EOF'
<what was wrong, what you changed and why, how you verified it, what
svc-core-reviewer said, and the explicit request to push and open a PR>
REPORT_EOF

/sandbox/pilot-state/lib/ask-decision.sh svc-core-escalation main fix/<slug> /tmp/stage4-report.md
```

It moves the tracker entry to stage 4 (there is no separate jq for that), keeps
a copy of what the human sees at
`/sandbox/pilot-state/reports/svc-core-escalation--<slug>.md`, and prints the
assembled report on stdout.

**Do not paste the diff into your report file.** The script reads the real one
out of your worktree — `git diff` from the merge-base, so trunk moving on since
you branched doesn't show up as your change. It also appends anything still
uncommitted there (which would be in neither the diff nor the push) and the tail
of `svc-core-reviewer`'s own output file. A Stage 4 report on 2026-08-13 pasted
an abridged diff with `...` placeholders; the human was approving a summary of a
change rather than the change. Describe what you did — it supplies the evidence.

It refuses (exit 66) if there is no tracker entry for that branch. That is not
an obstacle to work around: it means Stage 2's entry was never written, or the
branch name differs from the key, and until that's fixed a human still could not
act on your question. It prints the keys it does have.

**Your turn ends with this call.** Not with a push, not with a second ask, not
with "let me know". Nothing is pushed until a human clicks Approve, and this
repo's watcher holds escalation delivery until they do — while still checking
the pod every cycle, so the pause costs a delay, not visibility.

## Pre-push hook

`.git/hooks/pre-push` in the shared repo (it applies to every worktree
automatically, since worktrees share the common git dir) runs on every push and:

- re-checks `python3 -m py_compile` on changed `.py` files — a no-op if this repo
  isn't Python, which is why your own Stage 3 check matters more here
- scans the pushed diff for obvious secret patterns (GitHub tokens, AWS keys,
  private-key headers)
- blocks the push outright if this repo's `modifications_enabled` flag in
  `/sandbox/pilot-state/registry.json` (key `svc-core`) is false
- for any branch other than `main`, fetches `origin/main`
  fresh and blocks if your branch doesn't contain its current tip — the
  mechanical version of the freshness check below

Any failure exits nonzero with a `pre-push: ...` message and the push never
reaches origin. It's a backstop independent of what you remembered to run or of
what this file says — not a replacement for Stage 3. Never use `--no-verify`:
read the actual error and fix the real problem (for the freshness case, fetch and
rebase onto `origin/main`).

## Second-opinion review

Two steps. You write the incident description; `review-msg.sh` assembles the
message around it, adding the diff **and the full contents of every changed
file**. Everything mechanical is its job, so the only part you author is the
part that needs you — what the change is for:

```
cat > /tmp/incident.txt <<'INCIDENT_EOF'
Incident: <what you were fixing and why>
Intent: <what this change is supposed to achieve, in one or two lines>
INCIDENT_EOF

cd /sandbox/repos/svc-core-worktrees/fix-<slug>
/sandbox/pilot-state/lib/review-msg.sh main fix/<slug> /tmp/incident.txt > /tmp/review-msg.txt
/sandbox/pilot-state/lib/review-call.sh svc-core-reviewer <slug> /tmp/review-msg.txt
```
Run the review call with a generous `yieldMs` (900000) so `exec` waits for it
rather than handing you back an empty result while it is still working.

The message goes via a file because building the command with the diff inline
has failed outright — the tool call came back `Validation failed for tool
"tool_call": args must be object`, because a large embedded payload pushed the
arguments out as a string.

**Why the reviewer gets whole files and not just your diff.** On 2026-08-13 a
diff-only review of `fix/readiness-image-check` failed in both directions at
once. It reported `ImageNotFound` as un-imported and labelled it **CONFIRMED** —
the import was there, on line 20, just outside the hunk. And three lines below
that same hunk it cleared `JSONResponse(..., detail=...)` as "response structure
... checks out as correct"; that kwarg does not exist, so the endpoint raised
`TypeError` on every call — in a readiness probe. A hunk cannot show you an
import that is already there, or the real signature of something it calls. Both
failures were one missing input, so don't hand-assemble the message to "save
tokens": a confident wrong verdict costs far more than the bytes.

`review-msg.sh` prints a `tier=...` summary to stderr. Anything other than
`tier=full` with `skipped_large=0` means the reviewer did **not** see everything,
which makes the review DEGRADED — report that in Stage 4 rather than presenting
it as a full review.

Use the wrapper, not a raw `openclaw agent` call. It sets the session key, the
`env -u` prefix and the timeout for you, keeps a copy of the verdict at
`/sandbox/pilot-state/reviews/svc-core-reviewer--<slug>.out`, and — the part
that matters — refuses to start a second review of the same slug while one is
already running.

**The `env -u ...` prefix is required, not optional**, and the wrapper exists
partly to stop you having to remember it. Your process runs with
`OPENCLAW_GATEWAY_URL`/`_PORT`/`_TOKEN` set, a nested shell command inherits
them, and the nested `openclaw agent` then reads them as an explicit gateway-URL
override and fails with `GatewayExplicitAuthRequiredError: gateway url override
requires explicit credentials` — even though the same command works from a plain
shell such as cron. If you ever invoke `openclaw agent` directly for something
the wrapper does not cover, you must supply that prefix yourself.

`<slug>` is the same identifier the stage tracker keys this fix by, not a new
piece of state. Reuse it for every review round of one incident so the review
stays a single thread; only a genuinely different fix gets a different slug.

**A review takes several minutes — 7 is normal, and it is doing real work in
that time.**

### If `exec` comes back with no verdict

An empty or banner-only result means **still running**, NOT failed. The gateway
startup banner appears immediately; the verdict comes minutes later.

- **Wait, then poll** with the `process` tool or by re-reading the output file
  above. It is finished when the file's last line reads
  `=== REVIEW COMPLETE (exit N) ===`. Until that line exists it is still
  working, so an empty or partial file means "not done", never "failed".
- **Never re-run the call while the first one may still be live.** Re-invoking
  the same session key does not retry it — the key is busy, so the new run is
  shunted into a separate `gateway-fallback-*` session AND the original is
  aborted. On 2026-08-12 that destroyed a review seven minutes in and one step
  from its verdict, burned ~940k input tokens across the two runs, and produced
  nothing. The wrapper now refuses this outright: if it exits 75 saying a review
  is already running, that is not an error to work around — it means waiting is
  the correct move, so wait.

If it genuinely failed (a non-zero exit other than 75, or a real error in the
output), say so explicitly in your Stage 4 report and record it in
`reviewer_status` — never silently self-assess in place of the review.

## Cross-repo notification

This is a **tool call, not a shell command** — it doesn't go through
`openclaw agent`, so the `env -u` business above doesn't apply. Call
`sessions_send` with:

- `sessionKey`: `agent:<other-repo>-escalation:xref-svc-core-<slug>`
- `timeoutSeconds`: `0`
- `message`:
  > Heads-up from svc-core-escalation (svc-core): while investigating
  > \<your incident summary\>, I found what looks like a related issue in this
  > repo - \<the specific finding, with evidence\>. Flagging for your own
  > investigation, not asking you to act on this without checking it yourself.

`<other-repo>` must be one of your correlated repos (see AGENTS.md's cross-repo
note, or `correlate_with` for `svc-core` in
`/sandbox/pilot-state/registry.json`). `<slug>` is the same incident identifier
the tracker uses, not a fresh timestamp.

`timeoutSeconds: 0` is what makes this a one-way heads-up rather than a request:
you hand the finding over and move on in the same turn without blocking on the
other agent's investigation. You get no reply and no visibility into what it
decides — that's the intent, so don't retry or follow up waiting for one.

Expect the receiving side to be asked one follow-up question by the framework
after your message lands (an "announce step" turn) — that's OpenClaw's own
plumbing, not something you triggered or need to respond to.

This path is policy-gated: `sessions_send` only reaches agents on the configured
allow list. A `"status": "forbidden"` result means the gate, not a mistake on
your part — most likely the other repo was registered without the gateway being
restarted afterward. Report it as a failed notification; don't fall back to
`openclaw agent` to route around it.

## Git cheat-sheets

**Fetches are retried** because the egress proxy occasionally fails to identify
the calling process and denies the request outright — rare, transient, no fix
upstream. Two consequences:

- **One failed fetch diagnoses nothing.** Not the network, the credential, the
  repo, or a policy. Quote the raw error, then retry before concluding anything.
- **Three in a row is a real stop.** Report it, quote the errors. Never work from
  a clone you could not verify, and never substitute `gh api` for the refresh —
  it reads the remote tip but fetches no objects, so everything after it would
  run on stale ones.

**Checking whether this repo is actually behind GitHub** (ad hoc, not tied to
any stage — this is what a human asking "are you up to date" actually
needs):
```
git fetch origin 2>&1
echo "fetch exit code: $?"
```
Never redirect stderr away here — you are explicitly trying to find out
whether this command works, so its own error output IS the answer if it
fails. If it fails, quote the exit code and that literal text verbatim in
your report; never infer a cause it didn't state (see AGENTS.md's
"Diagnostic honesty"). Deliberately not retried — its job is to show you the raw
failure. Still run it twice by hand before calling fetch broken: "failed once
then worked" is itself the finding.

To check GitHub's real state independent of whether your local clone can
fetch at all:
```
git ls-remote origin refs/heads/main refs/heads/dev
```
Compare the hash it returns against `git rev-parse origin/main`
(your clone's last successful fetch) to see exactly how far behind, if at
all — and `git log -1 --format=%ci -g refs/remotes/origin/main`
shows when that last successful fetch actually happened.

**Freshness re-check before relying on a resumed fix** (see AGENTS.md's
"Resuming work" for when this applies):
```
ok=; for i in 1 2 3; do git fetch origin main && ok=1 && break || sleep $((i * 3)); done
[ "$ok" ] || echo "FETCH FAILED 3x - STOP, do not work from this clone"
git log origin/main --oneline -20
```
Skim for anything that already addresses the same incident — a human or coworker
may have beaten you to it. If nothing does but `origin/main` has
moved past where your worktree branched from, rebase from inside the worktree:
```
cd /sandbox/repos/svc-core-worktrees/fix-<slug>
git rebase main
```

**Stage 2, trunk/secondary divergence check** (only if `dev`
isn't `none`):
```
ok=; for i in 1 2 3; do git fetch origin main dev && ok=1 && break || sleep $((i * 3)); done
[ "$ok" ] || echo "FETCH FAILED 3x - STOP, do not work from this clone"
git log --oneline "origin/main..origin/dev"
git log --oneline "origin/dev..origin/main"
```
First = commits on `dev` not yet on `main`; second =
the reverse. Either non-empty means diverged — see AGENTS.md's Stage 2 (stop,
report, wait). Both empty means in sync.

**Stage 6, secondary-branch propagation check** (only if `dev`
isn't `none`):
```
ok=; for i in 1 2 3; do git fetch origin main dev && ok=1 && break || sleep $((i * 3)); done
[ "$ok" ] || echo "FETCH FAILED 3x - STOP, do not work from this clone"
git branch -r --contains <the merge commit on main>
git log --oneline "origin/dev..origin/main"
git log --oneline "origin/main..origin/dev"
```
`git branch -r --contains` listing `origin/dev` means the fix is
already there (case 1). Otherwise: the FOURTH command coming back EMPTY means
`dev` hasn't diverged and a fast-forward is safe (case 2);
non-empty on both means real divergence (case 3). See AGENTS.md's Stage 6.

If — and only if — the human approves propagating a clean fast-forward, this
updates the branch without needing a local checkout of it:
```
git push origin origin/main:dev
```
That updates the branch only. The deployment still has to be redeployed through
the normal pipeline — say so rather than implying the push fixed the live
service.

## Reminders

- `gh` needs to be authenticated (done once per sandbox) — check
  `gh auth status` if anything gh-related fails unexpectedly.
- Don't assume a local test suite exists unless you've found one.
- Never merge a PR yourself. Never push without a fresh, explicit "yes" for that
  specific fix.
