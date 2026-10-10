# Monitoring: live K8s log streaming

The **Monitoring** section of the dashboard: real-time Kubernetes log viewing,
one to four workloads streamed side by side. Written as an implementation plan
and kept as the record of one — every decision below is still here, including
the ones that turned out wrong, because what this document is actually useful
for now is saying *why* the code looks the way it does.

Status: **all 7 phases built, 2026-08-12/13.** A Monitoring entry in the
sidebar opens a full-page view; a picker lists all 7 workloads and says why it
refuses any it refuses; one to four panes stream live logs side by side with
pause, clear, close and jump-to-latest; reattach, throttle and failure render
as dividers in the log flow, a dead stream offers a Retry, and each repo's own
`error_pattern` tints matching lines. `dashboard/test/` holds 24 files, all
exiting 0, of which 8 (129 checks) are this feature's.

Working on it? [`dashboard/README.md`](../dashboard/README.md)'s Monitoring
section is the shorter read — the protocol, the gotchas, and how to drive it
locally. This document is the reasoning behind them.

Not built, deliberately: everything in §11.

Every "confirmed" claim below was tested live against Server 6 and the
Server 2 cluster on 2026-08-12; assumptions that were *not* verified are
called out explicitly as such. Two findings in §2.7 came out of building
phase 1 rather than out of the original survey, and both contradicted an
assumption this plan had already baked in - so the same caution applies to
what is still unbuilt.

---

## 1. Scope

**In scope (v1)**

- A `Monitoring` sidebar entry opening a full-page view.
- A pane grid holding 1–4 live log streams, each targeting one workload
  from `registry/repos.json`.
- Per-pane: pause, clear, close, auto-scroll with jump-to-latest, and a
  visible marker whenever the stream reattaches.
- Read-only throughout. No new RBAC, no cluster writes, no new credential.

**Out of scope (deferred, see §11)**

Arbitrary namespace/pod picking, in-pane search, log download, cross-repo
correlated timelines, scrollback beyond the initial `--tail`.

---

## 2. Verified constraints

These four findings shaped the design and are the reason it doesn't look
like the rest of `routes/ops.js`. All tested live 2026-08-12.

### 2.1 `docker exec` cannot reach the cluster — only `nemoclaw exec` can

```
docker exec  <container> kubectl ... → dial tcp 127.0.0.1:16443: connect: connection refused
nemoclaw ops-nemoclaw exec -- kubectl ... → NAME  READY  STATUS ...
```

The tunnel was healthy in both cases; `docker exec` simply lands outside
the network context `tunnel-keeper.sh` maintains. `routes/ops.js` uses
`docker exec` for most of its sandbox work — copying that pattern here
would fail outright. This matches the existing operational rule (*use
`nemoclaw exec --`, not `docker exec`, for anything networked*), now with
a concrete cause attached.

**Consequence:** every cluster-touching call in this feature goes through
`NEMOCLAW_BIN` with `NEMOCLAW_ENV` (`NEMOCLAW_GATEWAY_PORT=8180`), exactly
as `routes/ops.js` already does for its gateway-CLI calls.

### 2.2 `nemoclaw exec` streams stdout incrementally

A command emitting a line every 3s delivered each line as it was produced,
not buffered until exit. Confirmed again with a real `kubectl logs -f`
against the rag pod: live production lines within seconds.

**Consequence:** the feature is viable at all, and the child must be
driven with `spawn` (streaming) rather than the `execFileAsync` (buffered,
awaits exit) that every existing sandbox call in the dashboard uses.
`logs -f` never exits on its own.

### 2.3 Killing the client orphans `kubectl` inside the sandbox

SIGKILL of the local `nemoclaw` client left `kubectl logs -f` running
indefinitely in the sandbox — still streaming, still holding an API-server
connection. One leak per closed browser tab, permanently.

This is the same shape as the device-pairing-spam incident: a process
outliving the thing that created it. It is the single largest risk in this
feature and the mitigation is not optional.

### 2.4 The mitigation, verified end to end

```sh
sh -c 'echo $$ > /tmp/dashlogs-<id>.pid; exec timeout <cap> kubectl logs -f ...'
```

Two independent guarantees, both tested:

| Mechanism | Test result |
|---|---|
| `kill $(cat /tmp/dashlogs-<id>.pid)` from the dashboard | Both processes gone. `exec` preserves the PID and `timeout` forwards the signal to `kubectl`. |
| `timeout` expiry with **no** cleanup at all | Self-expired, nothing left behind. Holds even if the dashboard process itself dies. |

An approach worth *not* retrying: tagging the process with an env-var
marker and reaping it with `pkill -f`. Tested and it does not work — an
env-var prefix never appears in `argv`, `pkill` matched nothing, and the
process survived. The pidfile is what makes teardown deterministic.

### 2.5 Two `kubectl` behaviours that need explicit flags

- `--max-log-requests` defaults to **5** when following by selector.
  Exceeding it is an error, not a truncation.
- `--tail` silently defaults to **10** when a selector is present (`-1`
  otherwise). Panes must set it explicitly or the default is a surprise.
- `-f` with a selector resolves its pod list **once, at stream start**.
  A rollout leaves the pane silently dead — the blind-monitoring failure
  mode. *(This is documented `kubectl` behaviour, not something reproduced
  here — the RBAC is read-only so no test pod could be created. §5.3
  handles it regardless of which way it falls.)*

### 2.6 Positional args through `nemoclaw exec` are shell-inert

```
nemoclaw ... exec -- sh -c 'echo arg1=$1 arg2=$2' _ "hello" 'wo rld;$(id)'
→ arg1=hello arg2=wo rld;$(id)
```

`$(id)` was passed through literally, unevaluated. This matters because
unlike every existing `execFile`-with-argv call in the dashboard, this
feature genuinely does invoke `sh -c`, so the "arguments never reach a
shell" invariant has to be re-established a different way. See §4.2.

### 2.7 Two timestamp findings from building phase 1

Both were found while driving `logStream.js` against the live rag pod, and
both broke an assumption this plan had already written down. They are the
reason §5.3 looks the way it does.

**The runtime writes a LOCAL OFFSET, not `Z`.** kubectl does not generate the
`--timestamps` value; it passes through whatever the container runtime wrote,
and this cluster's CRI writes:

```
2026-08-12T18:27:55.069321272+09:00 INFO:  10.42.0.166:39994 - "GET /rag/..."
```

Nanosecond precision, `+09:00`, never a `Z`. The first implementation
shape-checked for a trailing `Z` before trusting a timestamp, so it parsed a
timestamp off **zero real lines** — which silently disabled `--since-time`
continuity and reattach de-duplication together. Nothing failed loudly: lines
kept arriving, the pane looked healthy, and every reattach quietly fell back
to `--tail`. The four unit tests all passed, because their fixtures used `Z`.

**`--since-time` is whole-second on the wire.** kubectl *accepts* nanosecond
precision, but the value travels as a `metav1.Time`, which carries seconds
only, so the API server floors it:

| Request | Returned the line at `...55.069321272`? |
|---|---|
| `--since-time=...55.000000000+09:00` | yes (expected) |
| `--since-time=...55.999999999+09:00` | **yes** — strictly after the line |

So a reattach replays **the whole resume second**, not just the boundary
line. A de-dup keyed on the exact timestamp therefore suppressed only that
one line, and worse, the first non-matching replayed line looked like new
content and closed the de-dup window early — letting the rest of the second
through as phantom repeats after every cap expiry and every rollout.

The lesson worth carrying into phases 2-7: both bugs were in code that
*worked*, under tests that *passed*, and only showed up against real output.
A fixture that is more convenient than the real thing buys nothing — the
harness now builds timestamps through a single `criTs()` helper carrying the
real format, so no future test can quietly re-introduce the easy version.

---

## 3. Architecture

```
browser pane ──┐
browser pane ──┼── WS /ws/logs?repoKey=… ──► logStreamManager
browser pane ──┤        (cookie auth)          │  streams: Map<repoKey, Stream>
browser pane ──┘                               │  ref-counted, capped, swept
                                               ▼
                        spawn: nemoclaw ops-nemoclaw exec -- sh -c '…'
                                               ▼
                          sandbox: timeout N kubectl logs -f  ──► Server 2
                                   (pidfile at /tmp/dashlogs-<id>.pid)
```

One child process per **repoKey**, not per pane. Two operators watching the
same workload share one `kubectl`, mirroring how `wsRelay.js` fans one
`gatewayClient.subscribe()` out to many browser sockets. Targets come from
`registry/repos.json` (7 workloads, all `namespace=dev` on cluster
`server2`), so there is no new config file.

---

## 4. Backend

### 4.1 New module: `src/logStream.js`

Split into its own module rather than added to `routes/ops.js`, for the
reason `sandboxFile.js` gives for its own split: no dependency on
`config`/`auth`/`gatewayClient` means the tests can `require` it directly
without a populated `.env` (which fails on any machine that isn't Server 6).

Owns the `streams` map and nothing else. Exports, **as built** — the target
arrives as an object rather than a bare `repoKey` because the module resolves
nothing itself: the caller (phase 2) looks the workload up in the registry and
passes it in, which is what keeps this module free of a `registry` dependency
and therefore testable without `.env`.

```js
subscribe(target, handlers) → unsubscribe fn
  // target:   { repoKey, namespace, labelSelector, tail?, maxLogRequests? }
  // handlers: { onLine(frame), onControl(frame) }
  // throws err.code === "STREAM_LIMIT" when a NEW stream would exceed the cap
  //   (joining an existing one is always allowed - it costs nothing)
activeStreamCount()
shutdownAll()          // for clean process exit
_constants, _parseLine // tests and route-side limit reporting only
```

`unsubscribe` is idempotent: a double close must not tear down a stream other
panes still hold. On subscribe, the caller is immediately replayed the ring and
then handed a `status` frame, so a pane joining a running stream is never blank
and never guesses at the state.

Per-stream state, as built:

```js
{
  child,              // ChildProcess from spawn(), null between arms
  streamId,           // crypto.randomUUID(), also the pidfile name
  pidPath,            // /tmp/dashlogs-<streamId>.pid
  target,             // normalised copy: repoKey, namespace, labelSelector,
                      //   tail, maxLogRequests
  watchers: Set,      // { onLine, onControl } handler objects
  ring: [],           // last N lines, for a pane joining mid-stream
  ringBytes: 0,
  lastTimestamp,      // RFC3339 from --timestamps, for reattach continuity
  lastSecond,         // epoch seconds of lastTimestamp - the de-dup key (§5.3)
  seenInLastSecond,   // Set<hash> of lines seen in that second
  dedup,              // { second, hashes } snapshot while an overlap is open
  state,              // connecting | live | retrying | failed
  startFailures,      // reset once a stream actually runs
  rateWindowStart, rateCount, dropped,
  stdoutBuf,          // carries a line straddling a chunk boundary
  stderrTail, retryTimer, closing, armedAt,
}
```

Constants, with the reasoning that fixes each value:

| Constant | Value | Why |
|---|---|---|
| `STREAM_TIMEOUT_SECONDS` | 900 | The orphan backstop from §2.4, and the re-arm cadence from §5.3. Short enough that a leaked process is bounded at 15 min; long enough that reattach markers aren't visual noise. |
| `MAX_CONCURRENT_STREAMS` | 8 | 4 panes for one operator plus headroom for a second. Above `--max-log-requests`'s own 5-pods-per-stream ceiling this is the *stream* count, not the pod count. |
| `RING_MAX_LINES` / `RING_MAX_BYTES` | 500 / 256KB | A pane opening mid-stream gets immediate context instead of a blank box. Same evict-oldest-first policy and reasoning as `wsRelay`'s `EVENT_BUFFER_MAX_BYTES`. |
| `LINE_RATE_LIMIT` | 200 lines/s per stream | Above this, drop and count. See §5.2. |
| `DEDUP_MAX_HASHES` | 2000 | Bounds the reattach de-dup window (§5.3). It is filled *before* the rate limiter — deliberately, so a line dropped for rate reasons is still recognised if a reattach replays it — which is exactly why it needs a bound of its own. |
| `STARTUP_GRACE_MS` / `MAX_START_FAILURES` / `BACKOFF_MS` | 5000 / 5 / 2s…30s | A non-zero exit sooner than the grace window means the stream never started (bad selector, tunnel down, RBAC expired) rather than one that ran and ended. The two get different handling — see §5.1 and §5.3. |
| `IDLE_SWEEP_MS` | 60_000 | Matches `wsRelay`'s `SWEEP_INTERVAL_MS`. |

### 4.2 Spawning safely

As built. The script is a fixed string with the kubectl argv assembled in JS
and passed through `"$@"`, rather than the shell holding named positions for
each flag: the arity differs between a first arming (`--tail`) and a reattach
(`--since-time`), and this keeps that difference in JS instead of in shell
branching.

```js
const SCRIPT = 'echo $$ > "$1"; shift; exec timeout "$@"';

spawn(NEMOCLAW_BIN,
  [SANDBOX, "exec", "--", "sh", "-c", SCRIPT, "_",
   pidPath, String(STREAM_TIMEOUT_SECONDS),
   KUBECTL, `--kubeconfig=${KUBECONFIG}`, "logs", "-f",
   "-n", namespace, "-l", labelSelector,
   "--all-containers=true", "--prefix", "--timestamps",
   `--max-log-requests=${maxLogRequests}`, "--pod-running-timeout=20s",
   sinceTime ? `--since-time=${sinceTime}` : `--tail=${tail}`],
  { env: NEMOCLAW_ENV, stdio: ["ignore", "pipe", "pipe"] });
```

**No registry value is ever interpolated into the script string.** They
arrive as positional parameters, which §2.6 confirmed are passed through
unevaluated. This preserves the same property `execFile`-with-argv gives
the rest of the codebase, by a different route, and means a hostile or
merely malformed `label_selector` in `repos.json` cannot become shell
execution inside the sandbox.

`--timestamps` is required, not cosmetic: it is what makes `--since-time`
continuity and reattach de-duplication possible (§5.3).

Also required: `NEMOCLAW_BIN` by full path and `NEMOCLAW_ENV` with
`NEMOCLAW_GATEWAY_PORT=8180`. Both already documented in `routes/ops.js`'s
header — systemd's PATH lacks `~/.local/bin`, and without the port var
`nemoclaw` resolves to the wrong gateway and reports the sandbox as
nonexistent.

### 4.3 Teardown

On last unsubscribe, or idle sweep, or process shutdown:

1. `child.kill("SIGTERM")` — kills the local client.
2. `nemoclaw … exec -- sh -c 'kill $(cat "$1") 2>/dev/null; rm -f "$1"' _ <pidPath>`
   — the verified deterministic path from §2.4. Fire-and-forget with a
   logged failure; the `timeout` cap is the backstop if it fails.
3. Delete the map entry.

`shutdownAll()` on `SIGTERM`/`SIGINT` so a `systemctl restart
nemoclaw-dashboard` doesn't strand 4 streams for 15 minutes.

### 4.4 WS channel — and the one edit to shared code

`wsRelay.js`'s upgrade handler currently does:

```js
if (pathname !== "/ws") { socket.destroy(); return; }
```

It `destroy()`s any path it doesn't own, so simply registering a second
`server.on("upgrade")` listener for `/ws/logs` **will not work** — whichever
listener runs first kills the socket.

Minimal correct change: make each module's handler `return` without
destroying when the path isn't its own, and register one catch-all
**last** that destroys anything unclaimed. Without that catch-all, an
unknown upgrade path leaks a hanging socket instead.

**As built** (three files, phase 2 complete):

- `src/logsRelay.js` — the `/ws/logs` channel. Its own module rather than
  part of `wsRelay.js`: the two share no state and no upstream, one being
  keyed on a gateway sessionKey and the other on a registry repoKey.
- `src/wsRelay.js` — the guard change, plus an exported `WS_PATH`.
- `src/upgradeGuard.js` — the catch-all, as a shared function rather than
  inline in `server.js` as this section originally said. `server.js` can't
  be required from a test (`config.js` exits on any machine that isn't
  Server 6), so an inline handler could only be covered by a test that
  reimplemented it — which passes while the real one drifts. Both now call
  `attachCatchAll`. `server.js` builds its path set from the relays'
  exported `WS_PATH` constants, so adding a relay can't leave its own path
  silently refused.

Auth reuses `wsRelay`'s exact approach: run `sessionMiddleware` against the
raw upgrade request with a fake `res`, reject unauthenticated with a real
`401`. No token in the query string. Then, mirroring the ownership check
`wsRelay` added on 2026-07-30, resolve `repoKey` through
`registry.getRuntimeTarget()` and reject unknown keys with `403` — the
dashboard password is shared, so "authenticated" is not by itself
authorization to stream an arbitrary target.

**The namespace and selector are never taken from the client.** They come
from the registry entry the resolved `repoKey` names. A client-supplied
selector would be a way for any logged-in user to point kubectl at any
workload in the cluster, and `monitoringUpgradeAuth.test.js` pins this by
passing `namespace`/`labelSelector` query params and asserting they are
ignored.

**Two cases are accepted and then failed, rather than refused at handshake:**
a workload whose runtime isn't streamable, and hitting `MAX_CONCURRENT_STREAMS`.
Both send `status: "failed"` with the reason and close. A refused upgrade
gives the browser an opaque handshake error with no readable body, whereas
these carry something the pane can render — and for the stream cap, something
the operator can act on.

**Logout must close these sockets too.** Missing from the original plan and
easy to miss: auth is checked only at upgrade time and these sockets stay
open indefinitely, so without it a backgrounded tab keeps streaming
production logs after logout — on a dashboard whose whole security model is
one shared password. `wsRelay` needed the same fix for the same reason; this
feature would have reintroduced the hole on a new channel.
`auth.setLogoutHook` holds a *single* function, so `server.js` passes a
composite that closes both relays — two separate calls would silently leave
only the last one wired.

### 4.5 Protocol

Server → client, one JSON object per frame:

```js
{ t: "line",      ts, pod, container, text }
{ t: "reattach",  ts, reason: "timeout-cap" | "stream-ended" | "error", gapMs, detail }
{ t: "throttled", ts, dropped }
{ t: "status",    ts, state: "connecting"|"live"|"retrying"|"failed", detail }
```

**There is no separate `error` frame.** An earlier draft of this section
listed one; the implementation never emits it, and adding it back would be a
mistake rather than a gap. A failure is a *state* the stream is in, not an
event that passes by: `status: "failed"` carries kubectl's own stderr in
`detail`, and it is what a pane joining late is told on connect. A one-shot
error frame would be invisible to exactly the pane that most needs it — one
opened after the failure already happened. Transient, recoverable errors are
likewise already covered, by `reattach` with `reason: "error"` and the same
`detail`. Anything building a handler for `{t:"error"}` is handling a frame
that never arrives.

Client → server: `{ t: "pause" }` / `{ t: "resume" }` are **not** sent —
pause is client-side only (§6.3). The socket carries no client commands in
v1, which keeps the server side free of any client-driven state machine.

**A routine reattach does not emit a `status` frame.** Built and then
corrected in phase 1: the cap fires every 900s forever on a *healthy* stream,
so reporting `state: "retrying"` each time flicked the pane's health state
every 15 minutes for the life of the pane — visible on a 20s-cap live drive as
`retrying`→`live` on every cycle. An indicator that cries wolf on schedule is
one the operator stops reading, which is the exact erosion this feature exists
to prevent. So the arming reason is explicit (`initial` → `connecting`,
`retry` → `retrying`, `reattach` → state untouched), and a routine re-arm is
reported *only* by the `reattach` frame and its gap. Claiming `live` instead
would be a lie until lines actually flow; the stdout handler sets that itself
when they do.

Note that the arming reason is passed explicitly rather than inferred from
whether `--since-time` is present — a stream that fails before producing a
single line has no timestamp to resume from while very much being a retry.

### 4.6 New route: `src/routes/monitoring.js`

**Built 2026-08-12.** `GET /api/monitoring/targets`, `requireAuth`, read-only,
and it starts no stream — `kubectl logs -f` never exits, so there is nothing
an HTTP request/response pair can usefully do with one. Per target:

```jsonc
{ "repoKey", "displayName", "runtimeType",
  "monitoringEnabled", "errorPattern",           // errorPattern is for §6.4; unused by v1
  "cluster", "namespace", "workloadKind", "workloadName", "container",
  "labelSelector",
  "streamable": true, "unstreamableReason": null }
```

plus `limits: { maxConcurrentStreams, streamTimeoutSeconds }` and
`activeStreams`, read from `logStream._constants` rather than restated, so the
UI cannot end up describing a cap that has since changed. The limits are what
let a `STREAM_LIMIT` refusal be explained in the operator's own terms, and what
tell a pane why a healthy stream shows a periodic reattach divider.

As predicted, `listRepos()` was left alone and `listRuntimeTargets()` added
alongside it — `listRepos()` feeds the repo picker on every page load and has
no use for the runtime detail.

**The tagged union needed handling the plan hadn't accounted for.** `runtime`
is tagged on `type` (`registry/schema.md`), and only `k8s` can be streamed.
`docker` is retired and unused, but the schema still describes it and
`register-repo.sh --runtime docker` still parses one — and it carries
`ssh_host`/`container_dev` with *no namespace or selector at all*. An entry
predating `runtime` (added 2026-07-21) has no block whatsoever. Either would
have produced a `kubectl` invocation with an empty `-n`/`-l`, failing at the
cluster with nothing specific to report. So the mapping reports
`streamable` + `unstreamableReason` instead of assuming, and a k8s block
missing either field is caught the same way.

Unstreamable targets are still **listed and flagged, never filtered out** —
the same reasoning as `monitoring_enabled: false` below: a workload silently
absent from the picker is a confusing dead end, whereas one that says why is
self-explanatory.

Workloads with `monitoring_enabled: false` are still listed but flagged;
the watcher being off is not a reason you can't look at the logs by hand,
and hiding them would be confusing when all 7 are currently on.

`registry.getRuntimeTarget(repoKey)` was added at the same time, for phase 2
to resolve a stream's target **server-side** at upgrade time. The namespace
and selector a stream actually runs with must come from the registry, never
from the client: the fields this endpoint returns are for the picker's display
only. It returns `null` for an unknown key, which phase 2 turns into the §4.4
`403`.

`clone_url` is excluded, as `listRepos()` already excludes it — it may embed
credentials at clone time (`schema.md`'s own note). A second reader of that
file is exactly how such a leak gets reintroduced, so the test asserts the
absence rather than trusting it.

**Selector correctness, now verified.** `schema.md` carried this as an
explicit untested assumption: `label_selector` defaults to
`app=<workload_name>` at registration and had never been checked against the
real workloads. A wrong one means a pane that finds zero pods **silently** —
precisely the blind-monitoring failure this feature exists to prevent. Checked
live 2026-08-12 for all seven repos: every selector matches its Deployment's
`spec.selector.matchLabels` exactly, and each matches exactly one Running pod.
`schema.md`'s gap list is updated. The one-pod-per-workload result also means
`--max-log-requests`'s ceiling of 5 (§2.5) has ample headroom today — a
workload scaled past 5 replicas is what would first make that flag bite.

---

## 5. Failure modes

### 5.1 The stream never starts

Tunnel down, RBAC expired, workload scaled to zero. `kubectl` exits
non-zero with a message on stderr. Surface it verbatim in the pane as a
`status: failed` frame — the operator needs to distinguish "the workload
has no logs" from "monitoring itself is blind", the same distinction
`watcher-k8s.sh.tmpl` already makes for its own blind-streak escalation.

Retry with backoff (2s, 4s, 8s, capped at 30s), and stop after ~5 attempts
with a manual Retry button rather than reconnecting forever.

**The Retry button, as built (phase 6).** It sits on the failure note itself,
at the point in the log where the failure happened, rather than in the pane
header — a dead pane should say why *and* offer the one thing to do about it,
in the same place. Two details that are not obvious:

- **It closes the socket and waits for the close before reopening.**
  `logStream` keeps one stream per `repoKey` and hands a new subscriber the
  existing one, failed state and all, so re-subscribing while still attached
  would join the same dead stream. Dropping to zero subscribers tears it down
  and the next subscribe builds a fresh one. Firing both at once is a race the
  retry would usually lose in the way that is hardest to notice: it would
  report the same failure and look like a workload that is genuinely still
  broken.
- **If a second operator is watching the same workload, Retry rejoins theirs
  rather than restarting it.** The subscriber count never reaches zero, so the
  stream survives. That is the right outcome — their stream is the one that
  would have to be restarted, and this pane is not entitled to restart it out
  from under them — but it does mean a Retry can legitimately do nothing
  visible.

Only ever one live Retry per pane: a superseded one is disabled and relabelled
`Retried`, since a frozen `Retrying…` directly above a fresh failure note
reads as still in progress.

### 5.2 A chatty pod floods the pane

Above `LINE_RATE_LIMIT`, drop lines and count them; emit one `throttled`
frame per second carrying the drop count, rendered inline as
`… 1,432 lines dropped (rate limit)`. Dropping visibly is correct here;
silently dropping would be the same failure as a silently dead pane.

The server ring buffer evicts oldest-first (`wsRelay`'s policy — a pane
catching up cares about recent activity, not the start).

### 5.3 The stream ends on its own

Three causes, one mechanism:

- `timeout` cap fires at 900s (expected, every time).
- Pod rolled/rescheduled and `-f` was following a now-dead pod (§2.5).
- Tunnel blip.

In all three, the manager respawns with
`--since-time=<lastTimestamp>` instead of `--tail`, de-duplicates the
overlap, and emits a `reattach` frame the pane renders as a visible divider
carrying the gap duration.

The de-dup window is **keyed by whole second, not by exact timestamp**, for
the reason measured in §2.7: the API server floors `--since-time`, so the
overlap is every line in the resume second. Concretely, at re-arm the manager
snapshots the hashes of every line already seen in that second and suppresses
a replayed line only on a hash match — so genuinely new lines within the same
second still arrive, and are themselves tracked in case a further reattach
replays that second again. The window closes when a line from a later second
arrives, and is bounded (`DEDUP_MAX_HASHES`) so a pod flooding far above
`LINE_RATE_LIMIT` cannot grow it without limit; past the cap the cost is a few
phantom repeats rather than unbounded memory driven by pod chatter.

Verified live 2026-08-12 with the cap cut to 20s: three reattaches in 75s,
every timestamp parsed, zero duplicate lines delivered.

Note the synergy worth keeping deliberate: **the orphan cap and the
pod-restart fix are the same mechanism.** Re-arming every 15 minutes
re-resolves the label selector, so a pane picks up rescheduled pods as a
side effect of the leak guard. If `STREAM_TIMEOUT_SECONDS` is ever raised
for "efficiency", both properties degrade together — that tradeoff belongs
in a comment at the constant.

### 5.4 Browser disappears without closing cleanly

Laptop sleeps, wifi drops. `ws` `close` fires on the server eventually;
ref-count hits zero; teardown runs. If it doesn't fire (half-open socket),
the idle sweep catches it, and `timeout` catches that. Three layers,
because §2.3 is the failure this repo has already paid for once.

---

## 6. Frontend

### 6.1 Placement

**Built 2026-08-13 (phase 4).** A new sidebar nav item, then a **full-page
view** — not an Ops-modal tab.

`index.html` already records why: `#watcher-history-view` is a third
top-level view precisely because "the Ops modal is deliberately fixed-size,
and a paged run list needs the room". Four live log panes need considerably
more room than that list, so the same reasoning applies more strongly.

New `<section id="monitoring-view" hidden>` alongside `#watcher-history-view`,
with the same `pushState`/`popstate` handling `showWatcherHistory` /
`openWatcherHistory` / `closeWatcherHistory` use, hash `#monitoring`. Follow
the existing precedent of dropping the hash on load (`replaceState`) rather
than trying to rebuild panes from a URL before auth has run.

Sidebar icon: inline SVG inheriting `currentColor`, per the existing comment
— no emoji (renders differently per platform, can't inherit hover/active
colour), no icon font.

Use `setHidden()`, never `el.hidden = bool` — `app.js`'s first comment
explains that the CSS makes the bare property silently do nothing.

### 6.2 Pane grid

| Panes | Layout |
|---|---|
| 1 | full |
| 2 | side by side |
| 3 | 2×2, third spanning the bottom row |
| 4 | 2×2 |

CSS grid, `minmax(0, 1fr)` on both axes so a long unbroken log line can't
force the track wider than the viewport — the class of narrow-width defect
already fixed twice in this dashboard.

**Phase 4 built the one-pane case**, with the grid already declared this way
rather than left for phase 5 to widen. Verified with a 4000-character
unbroken token at a 520px viewport: `scrollWidth === clientWidth` on the
document, the grid and the pane body alike, so nothing overflows horizontally
at any level.

**Phase 5 built the rest**, as one CSS class per pane count written by the
single function that owns pane count. Two additions the table above doesn't
cover:

- **Below 860px the side-by-side layouts stack.** Two panes at ~380px wrap
  almost every line, which is not a smaller version of the feature so much as
  a different, worse one. Stacked with a 240px floor per pane and the grid
  itself scrolling.
- **The pane cap is 4, and it is a layout ceiling, not a resource one.** The
  server's own cap is `MAX_CONCURRENT_STREAMS` (8), which exists to leave room
  for a second operator. Both are reported to the operator, and the picker
  says which one it is refusing on.

**A second grid, one level down, needed the same care and did not get it
first time.** Each log row is its own three-column grid (time, pod, text), and
an `auto` track sizes to *that row's* content — so it collapses to zero when
the cell is empty. Measured live: three consecutive rows put their text column
at 176px, 88px and 147px, and a line the runtime wrote without a timestamp
shunted its text a full column left, reading as a different kind of record
entirely. Fixed with fixed `ch` widths (`12ch 6ch minmax(0, 1fr)`), which are
exact because the column is monospace. Worth stating because the reasoning
that got the outer grid right — "declare the constraint up front" — is the
same reasoning, and it was still only applied to the grid that was written
down here.

### 6.3 Pane internals

Phase 4 built the header, the body, the ring buffer and auto-scroll; phase 5
added pause, clear, close and jump-to-latest.

**A layout change un-pins a following pane, and that is not cosmetic.** Found
in the browser while building phase 5: adding a fourth pane narrows the
existing ones, which makes their content *taller* through wrapping and leaves
a pane that was pinned to its bottom several screens short of it. The next
line's own `wasNearBottom` check then reads false, so auto-follow never
resumes — the pane silently stops following a stream it is still receiving,
which is the same class of defect as the scroll-jump regression already fixed
on `#conversation`, arriving from the opposite direction. Every layout change
now re-pins the panes that were following.

The first version of that fix measured each pane just before the change, which
works for a layout change this code initiates and *not* for a window resize,
where the reflow happens before any handler runs — confirmed by dropping the
window from 1440px to 700px and finding both panes stranded mid-stream. It now
remembers pinned-ness as pane state instead. That looked risky (a resize
produces clamping scroll events, which could corrupt the flag) and isn't:
clamping only happens when content *shrinks*, which means the pane was at its
bottom and is clamped back to it, still pinned. The direction that actually
strands a pane leaves `scrollTop` untouched and fires no scroll event at all.

- Header: display name, namespace, live/retrying/failed dot, pause, clear, close.
- Body: monospace, `overflow-y: auto`, one row per line, `--prefix` pod name
  in a dimmed span.
- **Client ring buffer of 2000 lines**, dropping oldest DOM nodes. Without
  this an all-day pane is an unbounded DOM leak. Pulled forward into phase 4
  rather than left here: a workload at `LINE_RATE_LIMIT` fills it in ten
  seconds, so shipping a pane without it means shipping the leak. Verified by
  pushing 2100 lines through a live pane — the node count settles at exactly
  2000 and the oldest 100 are the ones gone.
- Auto-scroll when pinned to the bottom, plus jump-to-latest — reuse
  `#jump-latest-btn`'s logic. Heed the scroll-jump regression already fixed
  once here: don't scroll on every frame, only when already pinned.
- **Pause is client-side only.** It stops rendering; the stream and ring
  buffer keep running so resume shows the gap rather than a hole. Killing
  the child on pause would mean a reattach on every resume.

  As built, with one split the plan didn't call for: *state* is applied the
  moment a frame arrives, paused or not, while the *row* is what gets
  deferred. A pane that fails while paused shows its red dot immediately and
  its explanation in the right place in the log on resume. Deferring both
  would mean a pane sitting on a dead stream looking merely paused.

  A paused pane also shows what it is holding back (`Paused · 1,432 lines
  buffered`), because a paused pane and a dead one look identical otherwise,
  and that is the single most misleading thing this view could do. The buffer
  is bounded by the same 2000-line cap as the rendered rows — a pane paused
  overnight against a chatty workload must not grow without limit precisely
  because nobody is watching it — and the count says `2,000+` once it starts
  dropping rather than quietly under-reporting.

### 6.4 Severity tinting

Each registry entry already carries an `error_pattern`
(`ERROR|CRITICAL|Traceback|Exception`). Tinting matching lines is a cheap
win and reuses config that already exists per repo.

Worth being explicit about why this doesn't contradict the
no-keyword-matching rule: that rule is about **inferring intent or meaning**
in any language, where regex is the wrong tool. This is display
highlighting of an operator-configured, per-repo pattern — no behaviour
branches on it, nothing is filtered or hidden, and a non-match costs
nothing. If it ever gates behaviour, revisit.

**Built in phase 6** rather than deferred: it is about fifteen lines, and a
pane full of undifferentiated INFO is exactly where an operator misses the one
`Traceback` they opened the pane for. Three things worth knowing:

- The pattern is compiled **once per pane**, and a malformed one yields `null`
  rather than throwing. `error_pattern` is free text in `repos.json`, and a
  typo there must cost tinting, not the pane.
- **No `g` flag.** A global regex's `.test()` carries `lastIndex` between
  calls, so an identical line would match, then not match, then match — which
  reads as flaky highlighting rather than as a bug. Pinned by a test.
- **Case-sensitive, exactly as authored.** Adding `i` would silently widen a
  pattern someone wrote for their own logs; the registry entry is the
  authority on what counts as an error line for that workload.

Rendered as a left rule plus a light tint rather than a background wash, so a
burst of matching lines scans as a block instead of turning a third of the
pane into one colour.

---

## 7. Security

- **No new authority.** `pods/log` get/list/watch is already granted in
  `k8s/rbac-readonly.yaml`. Nothing in this feature needs an RBAC change,
  and it must not become the reason one is proposed.
- **Shell safety** — §4.2. The one place in the dashboard that genuinely
  runs `sh -c`, made safe by positional parameters rather than by trusting
  the registry's contents.
- **Log content is the real exposure.** The live test returned production
  traffic: client IPs, file UUIDs, request paths. Same data the agents
  already read, but this puts it in a browser behind only the shared
  dashboard password. Worth an explicit decision rather than discovering it
  later; note that `DASHBOARD_TLS_*` being unset means plaintext (see
  `config.js`'s own warning) and this feature makes that materially worse.
- Auth on the WS upgrade is the session cookie, same as `/ws`. Ownership is
  checked against the registry (§4.4).
- **Log text is rendered with `textContent`, never through
  `marked`/`DOMPurify`.** The transcript's own renderer exists because agent
  output is markdown; log output is not, and there is nothing to gain by
  interpreting it. Routing it through a markdown renderer would hand a
  workload's own log output a path into the dashboard's DOM, which is a
  strange way to lose to a log line.
- **Logout closes the client's panes as well as the server's sockets.**
  `showLogin()` tears the stream down, so an expiring session — where no
  logout ever happens and every poller simply starts 401ing — stops the
  stream too, not just an explicit logout. §4.4 covers the server half.

---

## 8. Tests

No test-runner dependency by deliberate v1 design — standalone files run
with `node test/<name>.test.js`, following `wsRelayAuth.test.js`'s pattern
of stubbing `sessionMiddleware`/`registry` so no `.env` or live gateway is
needed.

The four phase-1 files exist and pass (15 + 14 + 18 + 14 = 61 checks). They
share `test/logStreamHarness.js`, which holds the fake `spawn` and the
`criTs()` timestamp builder — not a test itself, hence no `.test.js` suffix.

| File | Proves |
|---|---|
| `logStreamLifecycle.test.js` | Ref-counting: 2 subscribers → 1 spawn; last unsubscribe tears down and reaps remotely; a late exit from a torn-down child does not re-arm; `MAX_CONCURRENT_STREAMS` rejects a new stream but still admits a join. |
| `logStreamSpawnArgs.test.js` | A `label_selector` containing `;`, `$(…)`, quotes lands as a positional arg, never inside the script string. Regression guard for §2.6. Also that no write verb, `exec`, or `port-forward` can appear in the kubectl portion of argv. |
| `logStreamReattach.test.js` | Child exit → respawn with `--since-time`; the offset-form timestamp parses (§2.7); the whole resume second is de-duplicated including a line *earlier* in it; a genuinely new line in that second still arrives; a routine cap emits no `status` frame while a real failure does; a failing stream stops instead of reconnecting forever. |
| `logStreamBackpressure.test.js` | Chunk-straddling lines reassemble; flood → lines dropped with an accurate `throttled` count; ring buffer honours both caps and replays the *most recent* lines. |
| `monitoringTargets.test.js` | **Phase 3, 15 checks.** Each tagged-union branch (k8s / retired docker / no runtime block / k8s missing its selector) is listed-and-flagged rather than dropped or silently half-populated; `monitoring_enabled: false` does not hide a workload; `clone_url` and any embedded credential stay out of the payload; `getRuntimeTarget` returns `null` for an unknown key; unauthenticated → 401 with no workload detail; the limits come from `logStream._constants`; listing starts no stream. Also asserts the contract *between* the two modules — that a target the registry calls streamable is one `logStream.subscribe` accepts. |
| `monitoringUpgradeAuth.test.js` | **Phase 2, 16 checks.** The gate: unauthenticated → 401, missing `repoKey` → 400, unregistered → 403. The authorization property: namespace/selector come from the registry, and client-supplied `namespace`/`labelSelector` query params are ignored outright. The accepted-then-failed cases (unstreamable runtime, `STREAM_LIMIT`) reach the pane as `status: "failed"` with a usable reason. Socket close unsubscribes. Socket-level backpressure drops *lines* but never `status`/`reattach`, and reports the drop. Co-existence with `wsRelay` in **both** directions — neither relay destroys the other's socket, and neither answers on the other's path. |
| `monitoringPanes.test.js` | **Phases 4-6, 29 checks.** The pure shaping layer behind the panes, required from the real browser-served file. Three guards carry the phase's own findings: the §2.7 timestamp form again (offset, nanoseconds, never `Z`); that the rendered time comes from the *string* and never through `Date`, so a pane and a terminal never disagree about when a line happened; and that `{t:"error"}` stays unhandled, pinning §4.5's decision so it isn't "restored" as a gap. Plus a contract check that reads `logStream.js` and fails if it ever emits a frame type no pane code handles. Phase 5 adds the grid-class mapping (clamped, so no pane count can name a class with no rule behind it) and `canAddPane`'s three refusals — unstreamable, already open, at the limit — which have three different remedies and so must be three different messages, checked in the order that tells an operator at the cap the *useful* one. Phase 6 adds §6.4's tinting: a malformed `error_pattern` costs tinting rather than the pane, the match is stateless across lines (no `g` flag, whose `lastIndex` would make an identical line match, then not match), and the pattern applies exactly as authored rather than silently case-widened. |
| `monitoringWsIntegration.test.js` | **Phase 2, 8 checks.** What the file above structurally cannot cover, because it stubs `wss.handleUpgrade`: a real `ws` client against a real `http.Server`, wired exactly as `server.js` wires it. Real handshake; a frame handed to the subscriber genuinely arrives; closing a real socket releases the stream; and `upgradeGuard`'s catch-all refuses an unclaimed path with a real **404 rather than hanging** — a distinction a stubbed handshake cannot make, since nothing in a stub ever times out. Calls the same `attachCatchAll` `server.js` does, not a copy. |

Two of these guards were confirmed to fail against the pre-fix code before
being kept — the §2.7 parse bug breaks 8 checks in the reattach file, and the
exact-timestamp de-dup breaks 2. A regression test that would also pass
against the bug it describes is worth nothing.

What the unit tests deliberately do **not** cover, because they stub `spawn`:
that the real API server accepts the `--since-time` value this module builds,
and what the resulting overlap actually contains. That gap is what hid both
§2.7 findings, and it is covered by driving the module on Server 6 instead —
see §9 phase 1.

---

## 9. Build order

Each phase leaves the dashboard working.

1. ~~**`src/logStream.js` + its four tests.**~~ **DONE 2026-08-12.** No UI,
   no WS. Driven from a scratch script on Server 6 against the live rag pod,
   which is what surfaced both §2.7 findings and the `status`-frame churn in
   §4.5 — none of which the unit tests could have caught. Two drives, both
   from `/tmp/logstream-drive` on Server 6 (scratch only; nothing was
   deployed and the live dashboard was never touched):
   - **Lifecycle drive.** Real lines arrive incrementally; two subscribers on
     one `repoKey` share one child; after last-unsubscribe the sandbox has
     **0** `kubectl logs` processes and **0** leftover pidfiles. That last
     figure is the orphan guard from §2.3/§2.4 holding end to end.
   - **Reattach drive**, with `STREAM_TIMEOUT_SECONDS` cut to 20 in a scratch
     copy so the cap fires repeatedly: 3 reattaches in 75s, all reported
     `timeout-cap`, every timestamp parsed, **0** duplicate lines across the
     run, and no `status` churn on a healthy stream.

   One caveat, stated rather than glossed: the rag pod is quiet (11-13 lines
   per 75s), so each live overlap contained a single line. The multi-line
   whole-second overlap of §2.7 is covered by unit test, not live — a busy
   workload would exercise it properly.
2. ~~**Upgrade routing + `/ws/logs` + auth test.**~~ **DONE 2026-08-13.**
   `logsRelay.js`, the `wsRelay.js` guard change, `upgradeGuard.js`, and the
   `server.js` wiring (§4.4). 24 checks across two files; all 23 test files
   in `dashboard/test/` exit 0, so the `wsRelay` change broke nothing.
   Three things this phase added that the plan had not anticipated: the
   logout hook (§4.4 — a real security hole, not a polish item), socket-level
   backpressure distinct from `logStream`'s own rate limit, and
   `upgradeGuard.js` existing at all.

   Not live-verified, deliberately: exercising this end to end means running
   a second dashboard instance on Server 6, which would open a second gateway
   connection against the live host. The integration test covers the real
   handshake and the real catch-all locally instead; the genuinely
   host-dependent half (spawn, orphan reaping) was already live-verified in
   phase 1.
3. ~~**`routes/monitoring.js`** and `registry.listRuntimeTargets()`.~~
   **DONE 2026-08-12**, out of order — phase 2 is blocked on coordination and
   this depends on nothing in it. Includes `registry.getRuntimeTarget()` for
   phase 2's server-side ownership check, and `monitoringTargets.test.js` (15
   checks). Verified through the real `server.js` as well as in isolation:
   unauthenticated → 401, authenticated → all 7 targets, `/api/repos`
   unaffected.

   Two items belong to **phase 2** and are called out here so they aren't
   lost, since both live in `server.js`:
   - The `SIGTERM`/`SIGINT` hook calling `logStream.shutdownAll()` (§4.3).
     Deliberately not added yet: nothing can open a stream until `/ws/logs`
     exists, and phase 2 is already editing this file for the catch-all
     upgrade handler. Without it, a `systemctl restart nemoclaw-dashboard`
     strands every open stream in the sandbox for up to 15 minutes.
   - The catch-all `upgrade` handler itself (§4.4).
4. ~~**Monitoring view shell, one pane.** Nav item, view switching, history
   handling, a single stream end to end.~~ **DONE 2026-08-13.**
   `public/monitoringPanes.js` (new — the pure shaping layer, split out for
   the reason `tokenUsage.js` is), the nav item and view markup in
   `index.html`, the pane styles in `style.css`, and the wiring in `app.js`.
   `monitoringPanes.test.js`, 21 checks; all 24 test files in
   `dashboard/test/` exit 0.

   Two things pulled forward from later phases, because a half-version of
   either is worse than none: the client ring buffer (§6.3), and routing
   *every* control frame into the pane through one `describeControlFrame`
   path. Phase 6 changes how those rows look; it is not what makes them
   exist. A pane that silently swallows a reattach is indistinguishable from
   a healthy one, which is the failure this feature exists to prevent.

   **Verified in a real browser**, against a local stub serving the real
   `public/` and the real `registry.listRuntimeTargets()`, with a `/ws/logs`
   replaying synthetic frames in logStream's exact protocol (CRI timestamps
   included). Confirmed: the picker lists all 7 workloads from `repos.json`;
   lines, reattach, throttle and failure rows render; auto-scroll follows the
   stream but does **not** fight a user scrolled up, and re-pins on return;
   2100 lines settle at exactly 2000 nodes; a 4000-character unbroken token
   causes no horizontal overflow at 520px; the accepted-then-failed path
   shows kubectl's own stderr and is *not* overwritten by a generic
   "connection closed"; Back and the browser's own Back both close the view
   and the socket; and logout closes an OPEN socket and hides the view.

   That stub is what found the row-alignment defect in §6.2 — three
   consecutive rows starting their text at three different offsets, which no
   unit test on the shaping helpers could have seen.

   Not covered by the live drive: the disabled-picker-entry path, since all 7
   registered workloads are currently streamable `k8s` entries. It is covered
   by unit test only.
5. ~~**Grid, 2–4 panes, per-pane controls, ring buffer.**~~ **DONE
   2026-08-13.** The ring buffer had already landed in phase 4. This is the
   1-4 pane grid (§6.2), per-pane pause/clear/close and jump-to-latest, the
   picker turning into an *add a pane* control that says why each workload it
   refuses is refused, and the sub-860px stacked layout. 4 more checks in
   `monitoringPanes.test.js`; all 24 test files exit 0.

   **Verified in the browser** against the same stub as phase 4, now logging
   socket open/close so the teardown claims are checked server-side rather
   than inferred: 3 panes lay out 2-over-1 with the third spanning; a 4th
   fills the 2×2 and disables the picker with `4-pane limit reached`; a 5th is
   refused; already-open workloads are listed and disabled with the reason;
   pause freezes the pane, counts the buffered lines and resumes with no gap;
   clear empties both the rows and the buffer; closing one pane closes exactly
   that socket (`WS CLOSE svc-core`) and re-enables its picker entry;
   leaving the view closes the rest; and reopening restores the same set.

   Not verified through the browser tool: the window-resize re-pin. The
   preview tool's `resize_window` changes `innerWidth` without dispatching a
   `resize` event, so the handler never runs under it. The repair itself was
   isolated and confirmed — pausing both panes to freeze their scroll, resizing
   across the breakpoint (both stranded 280px from the bottom), then
   dispatching one `resize`, which returned both to 0 with the jump buttons
   hidden. A real window drag fires that event; this harness does not.
6. ~~**Reattach/throttle/failure rendering.** The frames exist from phase 1;
   this is where they become visible.~~ **DONE 2026-08-13.** They were already
   visible — phase 4 routed every control frame into the pane precisely so
   nothing could be silently swallowed in the interim — so this phase is what
   the plan actually meant: making them *read* as events rather than as log
   lines that happen to be coloured. Each is now a centred label with a rule
   running out to both edges, which is the one shape that says "the stream did
   something here". Plus §5.1's Retry and §6.4's tinting, both of which the
   plan had left looser than they turned out to need.

   Verified in the browser on both failure shapes, which behave differently
   and would have hidden each other: an accepted-then-failed socket (already
   `CLOSED` by the time its Retry is visible) and a stream that exhausted
   `MAX_START_FAILURES` (socket still open). Retry recovered the second on its
   next attempt; a repeated failure produced a fresh note with a live Retry
   above a disabled `Retried`. Also confirmed the phase-5 pause split holds
   under a failure: paused, the dot went red immediately with zero rows
   rendered, and the note with its Retry appeared in its correct place in the
   log on resume.
7. ~~**Docs.** `dashboard/README.md` (protocol + known gaps, matching how the
   Gateway protocol is already documented there), and the `docs/` entry
   this file becomes.~~ **DONE 2026-08-13.** `dashboard/README.md` gains a
   Monitoring section (the pieces, the `/ws/logs` protocol, ten known gotchas,
   what is not built) alongside `Layout` entries for the five new modules, and
   its local-testing section now says how to drive this without Server 6 —
   including that synthetic timestamps must be built in the CRI form or you
   are testing a shape the cluster never sends.

   Two corrections rather than additions, which is most of the value here:
   the `Explicitly out of scope for v1` list still claimed "log/incident
   browsing" was out of scope, which is now half wrong — tailing exists,
   browsing does not — and this document still opened by calling itself a
   plan for something unbuilt.

Phases 1–3 are backend-only and conflict with almost nothing. Phases 4–6
touch `app.js`, `index.html`, `style.css` — the contended files.

---

## 10. Coordination

Files this feature edits that the other session may also be in:

- `dashboard/public/app.js` (5288 lines) — phases 4–6
- `dashboard/public/index.html` — nav item + view markup
- `dashboard/public/style.css` — grid + pane styles
- `dashboard/src/wsRelay.js` — the upgrade-guard change, phase 2
- `dashboard/server.js` — catch-all upgrade handler, phase 2

New files (no conflict): `src/logStream.js`, `src/logsRelay.js`,
`src/upgradeGuard.js`, `src/routes/monitoring.js`,
`public/monitoringPanes.js`, the six tests, this doc.

**State as of 2026-08-12.** Phase 1 added only new files — `src/logStream.js`,
`test/logStreamHarness.js`, and the four `logStream*.test.js` — so it touched
none of the contended files above.

Phase 3 added `src/routes/monitoring.js` and `test/monitoringTargets.test.js`
(new), and made two additive edits to files the other session may hold:

- `src/registry.js` — three new exports (`listRuntimeTargets`,
  `getRuntimeTarget`, `_toRuntimeTarget`). `listRepos()` and `repoExists()`
  are untouched, so nothing existing changes behaviour.
- `server.js` — two lines: the `require` and the `app.use`. Unavoidable for
  the route to exist at all, and additive, but note that phase 2 needs this
  same file for the catch-all upgrade handler and the shutdown hook.

The other session was concurrently modifying `dashboard/public/app.js`,
`public/tokenUsage.js`, `test/tokenUsage.test.js` and a new test fixture, so
§10's warning is live, not theoretical — none of those overlap with the above.

**State as of 2026-08-13.** Phase 2 landed the `wsRelay.js` guard change and
the `server.js` wiring — the two contended backend files — and nothing broke:
all 23 test files at the time exited 0. Phase 4 then took the frontend three:

- `public/index.html` — the nav item, the view markup, one `<script>` tag.
- `public/style.css` — appended as one contiguous block at the end of the
  file, which is the lowest-conflict shape available in a file two sessions
  may both be growing.
- `public/app.js` — element refs added to the existing refs block, and the
  feature's own logic appended as one contiguous region before the final
  `loadRepos()` call. Three edits touch existing code: the `popstate` handler,
  the load-time hash drop, and `showLogin()`.

The 5288-line `app.js` conflict this section warned about was smaller than
expected in the end, because the shaping logic went into a new
`monitoringPanes.js` (the `tokenUsage.js` precedent) rather than into `app.js`
— which is worth repeating for phase 6, where the temptation to grow `app.js`
instead is larger.

Phases 5 and 6 (2026-08-13) touched the same three files and no others, and
their `app.js` changes stayed inside the one contiguous region phase 4
created, plus one word in `showLogin()`. `style.css` was appended to rather
than edited, except once: phase 6 replaced its own phase-4 `.log-note` block.
A background session is separately fixing `showLogin()`'s failure to hide
`#watcher-history-view` — the same bug class the monitoring fix there
addresses — so that function is the one place these two threads meet.

Phase 7 additionally edits `dashboard/README.md`, which the other session has
no reason to be in.

The other session's own `app.js` work (the run-status token indicator) was
committed before this started, so this was written against a clean file rather
than alongside a live edit.

---

## 11. Deferred

- **Arbitrary pod/namespace picking.** RBAC permits cluster-wide list, so
  it's possible; it needs a pod browser and targets nobody has exercised.
- **In-pane search / filter.** Wanted quickly in practice; needs the ring
  buffer to be searchable rather than DOM-only.
- **Log download / copy window.**
- **Cross-repo correlated view.** The registry's `correlate_with` and the
  svc-monitor pilot's "one story" goal both point here, but the three
  repos share no trace ID today — the missing piece is upstream of the
  dashboard.
- **Scrollback before stream start.** Bounded by `--tail`; real history
  means a log backend, not `kubectl`.
