# scripts/test

Three harnesses for the parts of the watcher path that have no other check.
They exist because this project's watcher bugs have all been *silent* ones — a
suppression that filtered nothing, a gate that failed open, a queue that would
happily retry an undeliverable incident forever. None of those show up as an
error; they show up as a repo nobody is watching.

**They need bash 5** (`local -n` namerefs). macOS ships bash 3.2 — install bash 5 with
`brew install bash` and run them with `/opt/homebrew/bin/bash`.

| file | what it covers | where to run |
| --- | --- | --- |
| `watcher-queue.test.sh` | `queue_*` and `stranded_fixes` in `lib/watcher-common.sh` — ordering, dedup by signature, the entry cap, text truncation, retry-then-give-up, corrupt-file degradation, and which tracker stages count as stranded | anywhere with bash 5 + jq |
| `ask-decision.test.sh` | `lib/ask-decision.sh` end to end against a throwaway git repo — the stage-4 write, refusal when no tracker entry exists, merge-base diff selection, uncommitted-change warning, and how a missing or unfinished review is reported | anywhere with bash 5 + git + jq |
| `watcher-gate.test.sh` | a **rendered** watcher, run against a scratch state dir with `openclaw` stubbed: that a stage-4 hold blocks delivery without blocking observation, that incidents found during a hold are queued and delivered afterwards with their delay stated, and that a stranded tracker entry produces one nag without the incident framing | inside the sandbox (real `kubectl`, read-only) |

```
# from the repo root, on Server 6
bash scripts/test/watcher-queue.test.sh scripts/lib/watcher-common.sh
bash scripts/test/ask-decision.test.sh  scripts/lib/ask-decision.sh

# the gate test needs a rendered watcher and the sandbox
python3 scripts/render-template.py templates/watcher-k8s.sh.tmpl /tmp/test-watcher.sh \
  REPO_KEY=testrag K8S_CLUSTER=server2 K8S_NAMESPACE=dev \
  K8S_LABEL_SELECTOR="app=svc-rag-dev" \
  K8S_WORKLOAD_NAME=svc-rag-dev K8S_WORKLOAD_KIND=deployment \
  COOLDOWN_SECONDS=3600 ESCALATION_AGENT=testrag-escalation \
  ERROR_PATTERN='ERROR|CRITICAL|Traceback|Exception' TRUNK_BRANCH=main \
  SECONDARY_BRANCH=dev REPO_NAME=svc-api-rag REVIEWER_AGENT=testrag-reviewer
# then upload /tmp/test-watcher.sh + lib/watcher-common.sh + the test into the
# sandbox and run: bash watcher-gate.test.sh test-watcher.sh watcher-common.sh
```

`testrag` is deliberately not a registered repo key: the harness writes its own
scratch `registry.json`, so a stray run can never touch a real repo's state,
cron, or agent. The only thing it reaches outside its temp directory is
read-only `kubectl` against the `dev` namespace.
