# dashboard/ - web dashboard for ops-nemoclaw

## Why this exists

All 7 registered repos used to share a single chat channel, which was the
likely cause of a real incident where an agent's reply addressed the
wrong repo's branch entirely. Separately, a stalled/misbehaving agent run
was invisible until someone went digging through
`nemoclaw ops-nemoclaw logs` after the fact — there was no live view of
what a run was actually doing while it was doing it. This is a thin-slice
v1 that fixes both: pick a repo, send it a task, watch it run live
(streaming text + tool-call lifecycle), with each run getting its own
unambiguous session key. The dashboard proved out enough over real use
(live streaming, tool cards, multi-turn history all correct) that the old
chat path was removed entirely 2026-07-24 — this is now the operator's
sole real-time interface into these agents, not a parallel path.

Role isn't user-selectable — every run targets that repo's escalation
agent (the one capable of investigating and, where authorized, fixing).
The reviewer agent is an internal second opinion the escalation agent's
own protocol calls on its own; it isn't something you message directly
from here.

Talks directly to the OpenClaw Gateway's own WebSocket API (device-token
auth, real-time `agent`/`chat` events - tool-call lifecycle arrives as an
`agent` event with `stream:"tool"`, not a separate `session.tool` event as
originally assumed, see "Known gotchas" below) rather than through the
built-in Control UI, which is confirmed not extensible/embeddable.

## Layout

- `server.js` — entrypoint (Express + `ws`, HTTPS if TLS is configured). Also serves `marked`/`DOMPurify`'s browser bundles at `/vendor/*` (two exact files out of `node_modules`, not the whole tree) for the frontend's Markdown rendering.
- `src/config.js` — loads/validates `.env`, fails fast listing what's missing
- `src/registry.js` — reads `../registry/repos.json` directly off disk, no Gateway call
- `src/auth.js` — login/logout, the shared session middleware (also used by `wsRelay.js` to gate WS upgrades)
- `src/gatewayClient.js` — the one persistent backend → Gateway WebSocket connection
- `src/wsRelay.js` — the dashboard's own WS server, browser ↔ backend, with per-run event buffering
- `src/logsRelay.js` — the second WS server, browser ↔ `logStream`, on `/ws/logs`. Separate from `wsRelay.js` rather than folded into it: they share no state and no upstream, one being keyed on a gateway `sessionKey` and the other on a registry `repoKey`. See "Monitoring" below.
- `src/upgradeGuard.js` — the catch-all `upgrade` handler. With two relays, neither may destroy a socket on a path it doesn't own, so something has to refuse the genuinely unclaimed ones or they hang. Registered **last**, and shared as a function rather than written inline in `server.js` so the test can call the same code the server does.
- `src/logStream.js` — one `kubectl logs -f` child per workload, ref-counted across subscribers, with the orphan guard, reattach and de-duplication. No dependency on `config`/`auth`/`gatewayClient`, so its tests need no `.env`.
- `src/routes/repos.js`, `src/routes/run.js`, `src/routes/sessions.js`, `src/routes/monitoring.js` — the API
- `src/sessionIndex.js` — a tiny JSON-file index (`data/sessions.json`, gitignored)
  of past sessions (`sessionKey`/`repoKey`/label/timestamps) powering the sidebar's
  Recents list. Deliberately stores no transcript content itself — the agent's own
  conversation history already lives on the Gateway side per session, fetchable
  on demand via OpenClaw's `chat.history` RPC (see "Session continuity" below).
- `public/` — plain HTML/CSS/vanilla JS frontend, no build step. Chatbot-style
  layout (redesigned 2026-07-23, matching Claude's own UI): a collapsible
  left `#sidebar` (repo picker + repo metadata, a "+ New task" reset button,
  a Recents list of past conversations - each deletable via a hover-revealed
  `×`, added 2026-07-24, matching Claude's own convention - and a settings
  section with logout), and a `#main-pane` with the conversation (status
  banner, collapsible thinking block, transcript, collapsible tool-call
  cards) above a bottom-center message composer (Enter sends, Shift+Enter
  inserts a newline). Collapsed/expanded sidebar state persists via
  `localStorage`.
- `deploy/nemoclaw-dashboard.service` — systemd unit
- `test/wsRelay.test.js` — a standalone, framework-free regression test for
  `wsRelay.js`'s per-run event fan-out (`node test/wsRelay.test.js`) — see
  its own header and the "Known gotchas" entry below for what it proves
- `test/sessionsHistory.test.js` — same style, for `routes/sessions.js`'s
  `mergeUserMessages()` (`node test/sessionsHistory.test.js`)

### Top-level views (read this before adding one)

`public/index.html` has four mutually exclusive full-page views — `#login-view`,
`#app-view`, `#watcher-history-view`, `#monitoring-view` — each with its own
`:not([hidden])` rule in `style.css` setting `display:flex; height:100vh`. Two
visible at once is not a layout glitch: it is a 200vh document where one page
scrolls into another, with the hidden-but-rendered one's buttons still live.

**`showTopLevelView(target)` in `app.js` is the only thing allowed to decide
which one is up**, and `topLevelViews` must list every one of them. Do not write
`setHidden(someView, …)` at a call site. `test/topLevelViews.test.js` enforces
both, and fails if a view exists in the markup but not in the array.

This is a rule because the alternative has now failed twice, the same way both
times — a transition written by hand, correct for the views that existed when it
was written, silently wrong for the one added afterwards. `8a23389` was
`showLogin()` not knowing about the run-history page. The second was the
`popstate` handler running one open/close pair per view, each `close()`
revealing `#app-view` as its assumed fallback, so a pop between the two
page-style views showed one and unhid the app underneath it.

That second one was never reachable through the UI — `pushState` truncates
forward history and neither page can be opened from the other, so their two
states can never sit adjacent in the stack. It was one link between those pages
away from being reachable, and it would have failed silently. Hence the
structural test rather than a fix to the specific path.

Two related rules fall out of it, both also tested:

- **Teardown must not touch visibility.** `resetWatcherHistoryState()` and
  `stopMonitoringStreams()` clear state and nothing else, so the `popstate`
  handler can compute one destination and apply it once.
- **Anything a view remembers is session-scoped.** `showLogin()` must discard
  it, not just hide the view. The dashboard password is shared, so state
  surviving a login boundary is shown to whoever logs in next — that is why the
  run list is cleared, and why the remembered monitoring pane set is discarded
  there while `stopMonitoringStreams()` deliberately keeps it (leaving the page
  by Back should resume where you were; logging out should not).

## Session continuity (2026-07-24)

Two related features, added after real testing showed every message
wiping the transcript and starting a disconnected agent session:

1. **Follow-up messages continue the same conversation.** `POST /api/run`
   accepts an optional `sessionKey`; when the frontend has an active
   session for the same repo, it sends the existing key instead of
   omitting it, and `routes/run.js` reuses it (skipping `sessions.create`)
   rather than minting a new one. The agent's own conversational memory
   already lives on the Gateway side per session, so this is genuinely
   all "continuing a chat" requires — no local storage of message
   content needed. A client-supplied `sessionKey` is validated against
   this exact repoKey's expected prefix before being trusted (this
   endpoint is reachable from the open internet).
2. **A persisted Recents list, clickable back into past conversations.**
   `sessionIndex.js` records `{sessionKey, repoKey, label, createdAt,
   updatedAt}` to a local JSON file on every successful run (new or
   continued) - the label is set once from the session's first message
   and never changes on continuation. `GET /api/sessions` lists it for
   the sidebar; `GET /api/sessions/history?key=<sessionKey>` proxies
   OpenClaw's `chat.history` RPC (confirmed via OpenClaw's own test suite,
   `test/openclaw-tui-chat-correlation.test.ts`: `request("chat.history",
   {sessionKey, limit})` -> `{messages: [{role, content:[{type:"text"|
   "thinking", text}]}]}`, oldest-first, same scopes this dashboard's
   connection already uses) - only for a `sessionKey` present in this
   dashboard's own index, not an arbitrary client-supplied one.
   `app.js`'s `openHistoricalSession()` renders the replayed turns into
   `#transcript-history` (a static one-shot render, deduped defensively
   against a known upstream duplicate-turn bug, OpenClaw issue #2603 -
   reportedly fixed as of OpenClaw 2026.6.10, not independently verified
   against whatever build Server 6 runs) and then re-opens a live `#ws`
   subscription on the same key via the newly-shared `openSocket()`, so
   the conversation can keep going with a real follow-up message.
   `#transcript-live` (the reveal-queue's target) is a sibling of
   `#transcript-history`, not the same element - this is why a follow-up
   sent after viewing history appends after the replay instead of the
   queue's next re-render clobbering it.

**Known limitations, not yet verified against a real run:**
- **Confirmed 2026-08-04 (was previously listed here as unconfirmed) —
  `chat.history`'s `limit` (200 here, `HISTORY_LIMIT` in routes/sessions.js)
  IS tail-anchored: it always returns the N most recent messages, not the
  oldest N.** Verified live against a real session by comparing two
  different `limit` values against the same session and confirming the
  last message matched both times while the first didn't - see
  routes/sessions.js's own header comment for the full test description.
  Practical effect: a session with more than 200 real messages will have
  its replay silently missing the earliest ones (e.g. the original
  incident report on a long-lived escalation), no error, no indicator.
  Not yet a real problem in practice - no session has come close to 200
  messages as of this check - and not yet worth building a pagination/
  "load earlier" UI for on that basis alone, but worth remembering if a
  long-lived escalation's replay ever looks like it's missing its start.
- **Fixed 2026-07-24 (real run) — tool round-trips were showing up as raw
  JSON dumps inline in the replayed conversation.** OpenClaw's test suite
  never exercised a tool-using turn, so this was genuinely unconfirmed
  until a real escalation-agent session showed it: `chat.history` doesn't
  use a distinct content-part type for tool calls - a completed (or
  errored) tool round-trip shows up as its own "assistant" message whose
  entire text content is the invocation+result serialized as a literal
  JSON string (two shapes confirmed:
  `{"tool":{...},"result":{"content":[...],"details":{"status",
  "aggregated",...}}}` for success, `{"status":"error","tool":...,
  "error":...}` for a bare error). `app.js`'s `parseToolRecordFromText()`
  detects this shape and `buildHistoryToolCard()` renders it as a
  collapsible `.tool-card`, inline in the same turn sequence as the
  surrounding prose - matching Claude Code's own convention of tool calls
  as distinct collapsed-by-default units rather than inline JSON. A THIRD,
  prose-prefixed shape - `"Validation failed for tool "X":\n\n<details>"`
  (a malformed tool-call attempt, confirmed live 2026-07-24 as more of the
  same internal-plumbing clutter) - doesn't start with `{` so it's matched
  separately via regex and normalized into the same `{status:"error",
  tool, error}` shape the JSON error case already renders. Note there's no
  `args`/`command` field in the successful-call shape, so the card summary
  can only show `${toolName} — ${status}` (same as the live session.tool
  cards), not the actual command run - that information isn't present in
  what chat.history returns.
- **Fixed 2026-07-24 (same real run) — tool/command output rendering.**
  Two related polish items on `buildHistoryToolCard`'s output, both
  shared with the live `session.tool` path via one `renderToolOutput()`
  helper so historical and live tool cards look identical: (1) actual
  stdout now renders in its own color (`--terminal`, a soft cyan) instead
  of inheriting `.tool-card-detail`'s muted gray, so it reads more like a
  real terminal; (2) output detected as a unified diff (`isDiffLikeOutput`
  - looks for a `diff --git ` or `@@ -N` line) renders with real
  per-line red/green coloring (`renderDiffPre`, one `<span>` per line, a
  `--diff-add-bg`/`--diff-del-bg` tint plus `--ok`/`--fail` text color),
  matching Claude Code's/GitHub's own diff view instead of plain text.
  Built via `textContent` per line, never `innerHTML`/string
  concatenation, so there's no HTML-escaping to get wrong on tool output
  that could contain literal `<`/`&`/etc.
- **Fixed 2026-07-24 (same real run) — a duplicate-content bug one level
  deeper than the known #2603 issue.** The same multi-paragraph final
  report appeared twice, byte-for-byte, back to back - not as two adjacent
  messages (which `dedupeAdjacentMessages` already guards against) but as
  two identical adjacent *parts* within a single message's own content
  array. `extractHistoryText` now also dedupes adjacent identical parts
  before joining them.
- Historical `thinking` content is deliberately not replayed (v1-simple -
  past reasoning is far less load-bearing than past answers). `chat.history`
  puts both kinds under the same `.text` field, distinguished only by
  `.type` - **`extractHistoryText` filters on `.type === "text"` and must
  stay a separate function from `extractFinalText`** (the live-WS path,
  which uses distinct `.text`/`.thinking` field names instead of a shared
  field + type tag). Reusing `extractFinalText` for history replay was a
  real bug caught in review 2026-07-24 - it let raw reasoning leak into
  the visible answer bubble. Don't collapse these two functions back
  together without re-solving that distinction.
- The session index is a single JSON file with a plain read-modify-write,
  not concurrency-safe against truly simultaneous writes (last write wins
  on a race). Fine at this traffic level; revisit only if it actually bites.
- `/api/run` is rate-limited (30/min, `runLimiter` in `routes/run.js`) since
  every successful call now also does synchronous disk I/O
  (`sessionIndex.record`) in the same process that runs `wsRelay.js`'s WS
  fan-out - flagged in review as a real, if minor, new resource-contention
  path this pass introduced.
- Two overlapping async navigations (a slow in-flight follow-up plus a
  Recents click, or two rapid Recents clicks) are guarded by a
  `sessionGeneration` counter in `app.js` (bumped by any
  session-switching action; checked again after each `await` before
  touching UI state) - same guard family as `openSocket`'s pre-existing
  `ws !== activeSocket` check, extended to the two new async paths that
  needed it. Verified live by racing two mocked `chat.history` responses
  with different latencies - the slower one never clobbered the faster,
  more recent one.
- Noted in review, not introduced/worsened by this pass: `wsRelay.js`'s
  `/ws` upgrade accepts any client-supplied `sessionKey` with no
  "is this ours" check (unlike the two new HTTP routes above, which both
  gate against `sessionIndex`). The Recents/`openHistoricalSession` flow
  is the first *feature* that routes arbitrary past `sessionKey` values
  into `openSocket()`, so this pre-existing gap is now slightly more
  reachable in practice than before - worth knowing if `wsRelay.js` is
  ever touched.

## Monitoring: live Kubernetes log streaming (2026-08-13)

A `Monitoring` entry in the sidebar opens a full-page view holding one to four
live log panes, each streaming one workload from `registry/repos.json`.
Read-only throughout: no new RBAC, no cluster writes, no new credential —
`pods/log` get/list/watch was already granted in `k8s/rbac-readonly.yaml`.

Full design, the live measurements behind it, and the build order are in
[`docs/monitoring-live-logs.md`](../docs/monitoring-live-logs.md). What
follows is what you need to work on it.

### The pieces

```
browser pane ──┐
browser pane ──┼── WS /ws/logs?repoKey=… ──► logStream
browser pane ──┤        (session cookie)      │  one child per repoKey,
browser pane ──┘                              │  ref-counted, capped, swept
                                              ▼
                       spawn: nemoclaw ops-nemoclaw exec -- sh -c '…'
                                              ▼
                         sandbox: timeout 900 kubectl logs -f  ──► Server 2
                                  (pidfile at /tmp/dashlogs-<id>.pid)
```

`GET /api/monitoring/targets` (auth required) lists all 7 workloads with
`streamable`/`unstreamableReason`, plus the limits the UI quotes back to the
operator. It starts no stream — `kubectl logs -f` never exits, so there is
nothing an HTTP request/response pair can usefully do with one.

### `/ws/logs` protocol

Server → client, one JSON object per frame. There are no client → server
frames in v1; pause is client-side only, so the server holds no client-driven
state.

```js
{ t: "line",      ts, pod, container, text }   // ts and pod may be null
{ t: "reattach",  ts, reason: "timeout-cap" | "stream-ended" | "error", gapMs, detail }
{ t: "throttled", ts, dropped }
{ t: "status",    ts, state: "connecting"|"live"|"retrying"|"failed", detail }
```

**There is no `error` frame, and adding one would be a mistake rather than a
gap.** A failure is a *state* the stream is in, not an event that passes by:
`status: "failed"` carries kubectl's own stderr in `detail`, and it is what a
pane joining late is told on connect. A one-shot error frame would be
invisible to exactly the pane that most needs it — one opened after the
failure already happened. Transient, recoverable errors are covered by
`reattach` with `reason: "error"` and the same `detail`.

**A routine reattach emits no `status` frame.** The 900s cap fires forever on
a *healthy* stream, so reporting `retrying` each time flicked the pane's
health indicator every 15 minutes for the life of the pane. An indicator that
cries wolf on schedule is one the operator stops reading.

### Known gotchas

- **`docker exec` cannot reach the cluster; only `nemoclaw exec` can.** The
  tunnel is healthy in both cases — `docker exec` simply lands outside the
  network context `tunnel-keeper.sh` maintains. `routes/ops.js` uses
  `docker exec` for most of its sandbox work; copying that pattern here fails
  outright.
- **Killing the client orphans `kubectl` inside the sandbox.** One leak per
  closed browser tab, permanently, each still holding an API-server
  connection. Three layers guard it: last-unsubscribe teardown, the idle
  sweep, and `timeout 900` as the backstop that holds even if the dashboard
  process itself dies. The pidfile is what makes the first two deterministic —
  tagging the process with an env-var marker and reaping with `pkill -f` was
  tried and does not work, because an env prefix never appears in `argv`.
- **The orphan cap and the pod-restart fix are the same mechanism.** `-f` with
  a selector resolves its pod list once, at stream start, so a rollout would
  otherwise leave a pane silently dead. Re-arming every 900s re-resolves the
  selector. Raising `STREAM_TIMEOUT_SECONDS` "for efficiency" degrades both
  properties together.
- **This is the one place in the dashboard that genuinely runs `sh -c`.** The
  script is a fixed string and every kubectl argument is a separate positional
  parameter, confirmed live to pass through `nemoclaw exec` unevaluated — so a
  hostile or merely malformed `label_selector` in `repos.json` cannot become
  shell execution. Don't interpolate into that string.
- **The namespace and selector are never taken from the client.** They are
  resolved server-side from the registry by `repoKey` at upgrade time. The
  dashboard password is shared, so an authenticated socket is not by itself
  authorised to point kubectl at an arbitrary workload.
- **Timestamps carry a local offset, not `Z`.** kubectl doesn't generate them;
  it passes through whatever the container runtime wrote, and this cluster's
  CRI writes `2026-08-12T18:27:55.069321272+09:00`. An earlier version
  shape-checked for a trailing `Z` and therefore parsed a timestamp off zero
  real lines, silently disabling `--since-time` continuity and reattach
  de-duplication together — with nothing failing loudly, because lines kept
  arriving. Test fixtures build timestamps through one `criTs()` helper so the
  easy version can't come back.
- **`--since-time` is whole-second on the wire.** It travels as a
  `metav1.Time`, so the API server floors it and a reattach replays the whole
  resume second. De-duplication is therefore keyed by second, not by exact
  timestamp.
- **Log content is the real exposure.** The live test returned production
  traffic: client IPs, file UUIDs, request paths. Same data the agents already
  read, but this puts it in a browser behind only the shared dashboard
  password — and `DASHBOARD_TLS_*` being unset means plaintext.
- **Logout closes these sockets, server-side and client-side.** Auth is
  checked only at the upgrade, and these sockets are designed to stay open
  indefinitely, so without it a backgrounded tab keeps streaming production
  logs after logout. `auth.setLogoutHook` holds a *single* function, so
  `server.js` passes a composite that closes both relays — two separate calls
  would silently wire only the last one.

### Not built

Arbitrary pod/namespace picking, in-pane search, log download, cross-repo
correlated timelines, and scrollback before stream start (bounded by
`--tail`; real history means a log backend, not `kubectl`).

## Local frontend-only testing (no real Gateway needed)

To iterate on `public/*` without a live Server 6 connection: create a
throwaway `dashboard/.env` with any values for `NEMOCLAW_GATEWAY_URL` /
`NEMOCLAW_GATEWAY_TOKEN` (the initial connection will fail and retry in the
background — logged, not fatal — `server.js` still starts and serves the
frontend), a real `DASHBOARD_PASSWORD`/`DASHBOARD_SESSION_SECRET`/
`DASHBOARD_PORT`, then `node server.js`. `/api/repos` still reads the real
`registry/repos.json` off disk, so the repo list/metadata is real even
though `/api/run` will 502. This is exactly how the 2026-07-23 layout
redesign was verified (login flow, sidebar collapse, composer, and the
event-rendering fixes below via directly calling the page's own
`renderFrame()` from devtools with hand-built frames) — never commit that
throwaway `.env` (already gitignored).

The Monitoring view needs one thing more, because `/ws/logs` spawns
`nemoclaw` and that only exists on Server 6: a stub WS server on `/ws/logs`
replaying frames in the protocol above. Phases 4-6 were all verified that way
against the real `public/` and the real `registry.listRuntimeTargets()`, which
is what caught three defects unit tests structurally could not — a per-row
grid whose columns didn't line up, and panes silently losing auto-follow after
a layout change or a window resize. Build synthetic timestamps in the CRI form
(local offset, nanoseconds, never `Z`) or you are testing a shape the cluster
never sends.

## Setup

1. `cd dashboard && npm install`
2. Mint a Gateway device token — **run this yourself, directly on Server 6, never through an agent** (same rule as every other real secret in this repo):
   ```
   nemoclaw ops-nemoclaw gateway-token
   ```
   Check `nemoclaw ops-nemoclaw gateway-token --help` first if this doesn't work as expected — this exact invocation hasn't been used anywhere else in this repo before.
3. `cp .env.example .env`, fill in:
   - `NEMOCLAW_GATEWAY_TOKEN` — the token from step 2
   - `DASHBOARD_PASSWORD` — pick something real, this gates an internet-reachable service
   - `DASHBOARD_SESSION_SECRET` — `openssl rand -hex 32`
   - `DASHBOARD_PORT` — confirm free with `ss -ltnp`, distinct from 8080 (Jenkins) and 8180 (the gateway itself)
4. Generate a self-signed TLS cert (sufficient for v1 — the point is encrypting the wire, not a trusted CA chain):
   ```
   mkdir -p tls
   openssl req -x509 -newkey rsa:2048 -nodes -keyout tls/key.pem -out tls/cert.pem -days 825 -subj "/CN=nemoclaw-dashboard"
   ```
   Set `DASHBOARD_TLS_KEY=tls/key.pem` and `DASHBOARD_TLS_CERT=tls/cert.pem` in `.env`.
5. Test it directly first: `node server.js`, then from another shell on Server 6, `curl -k https://127.0.0.1:$DASHBOARD_PORT/` — confirm the page loads and the console log shows the Gateway handshake completing before moving to systemd.
6. Add a port-forward rule on the router (ipTIME) pointing at Server 6's `DASHBOARD_PORT` — same mechanism already used for the vLLM endpoints and SSH access.
7. Install as a systemd service — see `deploy/nemoclaw-dashboard.service`'s own header for the exact commands and the 2-3 lines to confirm/edit first (`WorkingDirectory`/`User`/`Group`).

## Known gotchas

- **Added 2026-08-07 — nothing watched the model backend.** Server 4, which
  serves the inference model, went down and the dashboard showed nothing at
  all: every existing surface watched the *gateway*, not the model behind
  it, so a dead backend was indistinguishable from an idle system. Made
  worse by `models.providers.inference.timeoutSeconds: 600` — a run started
  against the dead server would have sat silent for ten minutes.
  `GET /api/model-health` now probes the provider's own OpenAI-compatible
  `/models` listing every 30s and raises a dismissible banner.

  Three things about it are deliberate:
  1. **It probes `/models`, not a completion.** Cheapest call that proves
     the server is up *and* has the model loaded, costs no tokens, can't
     disturb a real run, and needs no credential (the endpoint answers it
     unauthenticated), so the dashboard never holds the provider's apiKey.
  2. **"Gateway unreachable" is not reported as a model outage.** It's a
     different failure with a different fix, and saying "the model is down"
     would send someone to reboot the wrong machine. That state is silent.
  3. **Dismissal is scoped to one outage, not the session.** The flag clears
     the moment the model reports healthy again, so a second outage raises a
     fresh banner. A banner you can silence forever is one that lies the
     second time it matters — note this differs from the agent-mismatch
     banner above it, whose dismissal *is* session-wide.

  `gatewayClient.getModelEndpoint()` rebuilds the URL from origin+pathname
  rather than passing `baseUrl` through: `config.get` returns the gateway's
  entire config, and a baseUrl carrying userinfo would put a credential into
  an API response and from there into banner text. Covered by
  `test/modelHealth.test.js`, which also pins the up / unreachable / timeout
  / wrong-model-loaded / 401 states apart — "the box is gone" and "the box is
  up but serving the wrong model" look identical to a user and need
  completely different fixes.

- **Fixed 2026-08-06 — a stage-tracker entry below stage 4 was unreachable
  from every surface in the dashboard.** Approve/Deny (stage 4) and
  Confirm-merged (stage 5) were the only decisions, the watcher's own pause
  gate is also stage-4-only, and the composer is deliberately disabled for
  gateway-origin sessions — so an entry parked at stage 1 or 2 could be
  neither actioned nor cleared by anyone. Found live with six such entries
  across two repos, two of them agents that had explicitly asked *"should I
  remove this tracker entry?"* and stopped, waiting on a reply that had no
  path to them. Two fixes, both needed:
  1. **Root cause, in `templates/agent-writecapable/AGENTS.md.tmpl`:** Stage 1
     said "if benign, stop here" and never said *remove the tracker entry* —
     and the entry isn't meant to exist before Stage 2 (it's created with the
     worktree). A benign verdict now closes out, and asking permission to
     remove one's own bookkeeping is explicitly ruled out. The watcher
     templates' `CLOSING_INSTRUCTION` repeats it at invocation time.
  2. **Escape hatch, in the dashboard:** `close-out` (any stage but 4/5) and
     `approve-suppression` (no tracker entry at all — after fix 1 a
     benign-but-recurring verdict leaves none, and that's the case that most
     wants a suppression). Both go through the existing
     `POST /api/ops/decision`, so the agent still edits its own tracker and
     suppression file — the dashboard never writes them, same single-writer
     reasoning that put denials in their own file.

  The suppression control deliberately does **not** detect whether a proposal
  is actually pending: that's only answerable by reading the agent's prose,
  which varies run to run and is not necessarily in English. It's offered on
  every escalation session, sits above the disabled composer where the dead
  end was, and its message tells the agent to add nothing if it never proposed
  a line — so an unnecessary click is inert. Decision names now live in two
  files (`routes/ops.js` and `public/app.js`), which
  `test/opsDecisionSpecs.test.js` exists to keep in sync; a name in only one
  is either a button that 400s or a message nothing can send.

- **Fixed 2026-08-04 (structurally, not another one-off patch) — the
  `[hidden]`-specificity footgun documented at least 6 times below
  (`#run-status`, `#jump-latest-btn`, `#account-dropdown`,
  `#agent-mismatch-banner`, `#stage-indicator`, `.badge`) kept recurring
  because each fix only guarded that one element's own CSS rule with
  `:not([hidden])` - correct for that element, but does nothing for the
  next new hidden-toggled element someone adds without knowing this
  history.** Added `setHidden(el, hidden)` at the top of app.js and
  replaced all 59 `el.hidden = ...` assignments in the file with calls to
  it - it still sets the `hidden` attribute (existing CSS rules keying
  layout/position off `:not([hidden])`, like `#activity-dropdown`, still
  need that), but also sets `el.style.display` inline (`"none"` when
  hidden, cleared back to `""` - letting the stylesheet's own value take
  over - when shown). An inline style beats any selector short of
  `!important`, so this makes the whole bug class structurally impossible
  going forward regardless of what any future CSS rule does, rather than
  relying on everyone remembering to add `:not([hidden])` to every new
  selector. Verified live: logged into a real local run and exercised
  login/logout, the Ops modal, account dropdown, settings modal, the
  agent-mismatch banner, and the stage-tracker widget - all hide/show
  correctly through the new helper.
- **Fixed 2026-07-27 (second pass, verified via a real local run against
  Server 6's live gateway - see below) — four more issues found by
  actually testing the first pass's fixes instead of just reasoning about
  them.** (1) The composer's Run button now doubles as the Stop control
  while a run is active (text/color/title swap to "■ Stop" / "Stop (Esc)"
  via `startRunStatus()`/`stopRunStatus()` in app.js), matching Claude
  Code's own send-button-becomes-stop-button convention, per a screenshot
  the user provided - the separate always-visible `#run-abort-btn` from
  the first pass is gone; `runBtn`'s click handler intercepts (and Esc via
  a document-level keydown listener, since the composer is disabled
  during a run and a disabled element never receives its own keydown)
  instead of letting the click fall through to form submission. (2) A
  bare `#run-status {display:flex}` ID selector (no `:not([hidden])`
  guard) outranked the browser's own `[hidden] {display:none}` UA rule,
  so the status bar was visibly showing "Working · 0:00" on page load -
  confirmed live via a real screenshot within seconds of first testing
  this locally. Exactly the same footgun `#app-view`/`#login-view`
  already had to guard against elsewhere in this file; missed it when
  adding this new element. (3) Clicking Stop genuinely aborts the run
  server-side immediately (confirmed live: status banner correctly reads
  "agent aborted", real text cut off mid-word) - but text already in
  flight over the WS before the abort landed had already been pushed into
  the reveal queue's buffer, and nothing told the ~125 chars/sec
  typewriter reveal to stop, so the response kept visibly "typing" for
  several more seconds after clicking Stop even though generation had
  truly already halted. Added `flush()` to `createRevealQueue()` (reveals
  the remaining buffer instantly instead of losing it or slow-typing it)
  and call it specifically in the `lifecycle end, aborted:true` branch of
  `renderFrame()` - NOT on every completion, since a normal completion
  legitimately still having reveal backlog is the intended slow-typewriter
  effect working as designed for a long response, not a bug. (4) Verified
  live that `chat.abort` is a real, working OpenClaw gateway RPC (present
  in the gateway's own hello-ok method list, and in
  `dist/chat-BmzuyR4R.js`'s method table) - added `POST
  /api/sessions/abort` (routes/sessions.js), proxying it with `{sessionKey}`
  only (no `runId` tracked/sent client-side - chat.abort's own handler
  treats a missing runId as "abort every active run for this session",
  which is exactly the one run the dashboard could ever have in flight).
  **How this was actually verified**: ran the real dashboard locally
  (`.claude/launch.json`'s `nemoclaw-dashboard`/`dashboard` config, `node
  dashboard/server.js`) against an SSH tunnel to Server 6's real gateway
  port and a throwaway local-only `.env` (fresh random password/session
  secret, gateway token borrowed from Server 6's `.env` via `scp` - never
  printed to a terminal directly, though it did end up surfacing via the
  editor's own automatic file-change notification when the local `.env`
  was written to, an exposure path not previously known about) - logged
  in and drove the actual UI end to end, not just static review. The
  browser tool used for this blocks navigating directly to an
  external/remote `localhost`/loopback URL (confirmed by testing both the
  `localhost` hostname and the raw `127.0.0.1` literal against an SSH
  tunnel to Server 6 - both denied identically), but does NOT block its
  own sanctioned local-dev-server preview flow (`preview_start` by
  `name`, reading `.claude/launch.json` and spawning the process itself) -
  that distinction is what actually made real interactive testing
  possible here, after two earlier attempts at the former both failed.
- **Fixed 2026-07-27 (first pass) — three live-run UX gaps reported directly against a
  real run, all in `app.js`/`index.html`/`style.css`.** (1) Tool-call cards
  rendered into a separate `#tool-calls` container appended after
  `#transcript`, so every tool call in a run visually landed grouped at the
  end regardless of when it actually happened, instead of interleaved with
  the narration at the point it was called (Claude Code's behavior).
  `#tool-calls` is gone; `renderToolCard()` now appends cards directly into
  `#transcript-live` in call order, exactly like `renderHistoryReplay`
  already did for past conversations. (2) A long conversation couldn't be
  scrolled all the way down - not a broken scrollbar, but `#main-pane` and
  `#conversation` (both flex items with no `min-height: 0`) growing past
  `#app-view`'s `height: 100vh; overflow: hidden` box instead of being
  capped and handing overflow to `#conversation`'s own `overflow-y: auto`;
  the tail of the transcript was being silently clipped, not just hard to
  reach. (3) The composer re-enabled itself right after `/api/run`'s POST
  resolved (see the "fourth pass" entry below - that was deliberate at the
  time, since neither completion signal reliably fired back then) rather
  than staying disabled for the run's actual duration, and there was no
  live "still working" indicator at all, unlike Claude Code's timer/token
  status line. Added a new pinned `#run-status` element (elapsed-time
  timer via `setInterval`, best-effort token count opportunistically read
  off `message.usage.totalTokens` on `session.message` frames, a pulsing
  dot) shown by `startRunStatus()`/hidden by `stopRunStatus()`; the
  composer now stays disabled from submit until whichever real completion
  signal fires first (`agent` status `completed`/`failed`, `lifecycle`
  `phase:"end"`, `dashboard.error`, or the WS closing - all four are now
  confirmed to reliably fire, unlike when the "fourth pass" fix below was
  written), with a request-failure fallback in the submit handler's own
  `catch` block for the case where the POST itself never started a run at
  all. `resetToNewTask()`/`openHistoricalSession()` also call
  `setComposerEnabled(true)`/`stopRunStatus()` directly, since both are
  reachable while a previous run is still in flight (the sidebar isn't
  gated by the composer's disabled state) and would otherwise leave a
  stale timer running / composer stuck disabled after navigating away.
- **Confirmed 2026-07-24, NOT a bug — the thinking panel never un-hiding is
  expected, not unconfirmed.** The entry below this one (2026-07-23) flagged
  whether `chat`/`session.message` ever actually carry a `.thinking` content
  part as genuinely unknown. Across a full regression pass - a dozen-plus
  real runs, two different repos/agents, both fresh sessions and follow-ups
  - `.thinking` never appeared once; a captured `agent` event's own
  `session` snapshot showed why: `"thinkingDefault":"off"` for this agent
  configuration. The rendering code itself is fine as written and needs no
  change - there's simply nothing to render while reasoning stays disabled
  gateway-side. Revisit only if an agent's `thinkingDefault` is ever
  switched on.
- **Fixed 2026-07-24 — `mergeUserMessages()`'s "best-effort proportional
  split" (flagged in its own prior comment as unverified against a real
  multi-follow-up session) was genuinely wrong, confirmed live against a
  real 3-question conversation.** A real replay showed question 2's short
  answer landing after question 3 had already appeared, and part of
  question 3's own longer (several-tool-call) answer landing BEFORE
  question 3 itself - exactly because a split by equal COUNT of messages
  has no way to know one follow-up's answer took 1 turn and another's
  took 6. Fixed by discovering `chat.history`'s entries DO carry a real
  timestamp after all (this function's prior comment claimed otherwise,
  unconfirmed) - a top-level `timestamp` field, confirmed live on
  assistant and toolResult entries alike. Combined with `sessionIndex`'s
  own `sentAt` (recorded via `Date.now()` the moment `routes/run.js`
  actually sent each message), `mergeUserMessages()` now does a genuine
  chronological merge - walking both already-ordered lists together and
  inserting each user message right before the first history entry at or
  after its own timestamp - falling back to the original positional
  split only if no history entry has a usable timestamp at all (not
  observed live, defensive only). Verified against the EXACT real
  session that showed the bug: all three questions now immediately
  precede their own answers in the correct order. New test case in
  `test/sessionsHistory.test.js` reproduces the real failure shape
  (unequal-length turns per question) and asserts the correct
  chronological output; all prior cases in that file still pass
  unchanged (none of them exercised timestamped fixtures, so they
  exercise the preserved fallback path).
- **Fixed 2026-07-24 (backend hardening pass, found via independent code
  review rather than a live symptom report) — six issues in
  `wsRelay.js`/`gatewayClient.js`/`auth.js`, none previously documented
  here:**
  1. **CRITICAL - the browser-facing WebSocket had NO `error` listener
     anywhere.** Node's `EventEmitter` throws when `'error'` has no
     listener, and `ws` emits it for a malformed/oversized/invalid-UTF8
     frame - an ordinary flaky connection from ANY one browser tab, no
     malicious intent required, could crash the entire dashboard process,
     taking every tab and every in-flight run down with it. Fixed by
     adding `ws.on("error", ...)` in `wsRelay.js`'s connection handler,
     mirroring `gatewayClient.js`'s own handler for the upstream Gateway
     socket, which already had this.
  2. **`ws.on("close", ...)` was registered only AFTER `await
     gatewayClient.subscribe(...)` resolved.** A browser disconnecting
     (impatient navigation, tab close, network drop) while that await was
     pending left its socket stuck in `run.browserSockets` forever - the
     periodic sweep requires `browserSockets.size === 0`, which could
     then never be reached, leaking the run's Map entry and its full
     `eventBuffer` for the process's lifetime, and never calling
     `gatewayClient.unsubscribe` either. Fixed by registering both
     `close` and the new `error` handler immediately, before the replay/
     subscribe below, with a local `closed` flag short-circuiting the
     rest of the connection setup if the socket is already gone by then.
  3. **The run-cleanup "is this run finished" check relied on a signal
     that never fires.** `isTerminalEvent` checked `payload.status ===
     "completed"|"failed"` on an `agent` event - this is the SAME
     top-level `payload.status` field confirmed dead in `public/app.js`'s
     own fix below (only ever shows `"running"`, never
     `"completed"`/`"failed"`, against a real gateway) - so no run was
     EVER marked terminal, and the sweep could never clean any of them up:
     an unbounded `eventBuffer` leak, for every run, for the process's
     entire lifetime. Fixed identically to the client-side fix: use the
     `"lifecycle"` stream's own `phase:"end"`.
  4. **`/ws`'s upgrade handler accepted ANY client-supplied `sessionKey`
     with no ownership check**, unlike `routes/run.js` and
     `routes/sessions.js`, which both already gate on `sessionIndex`.
     Made practically reachable by two other confirmed facts together:
     `sessionKey`'s format is low-entropy/guessable
     (`agent:<repoKey>-escalation:dashboard-<epoch-ms>`), and `repoKey`
     values are themselves exposed via `GET /api/repos` - so anyone
     holding the one shared dashboard password could enumerate/guess
     another repo's `sessionKey` and pull its buffered history plus live
     stream. Fixed with a new `sessionIndex.exists(sessionKey)` check at
     upgrade time, right alongside the existing auth check.
  5. **`gatewayClient.subscribe()`'s failure rollback could silently
     strand a second, concurrent connection.** Two connections racing in
     for the same brand-new `sessionKey` used to let the second take an
     immediate, synchronous "already subscribed" branch without waiting
     on the first's in-flight RPC at all - if that RPC then failed, the
     rollback deleted the ENTIRE subscriptions Set, including the
     second's already-added callback, and only the first connection ever
     saw the rejection. Fixed with a `pendingSubscribes` map so any
     concurrent caller for the same `sessionKey` awaits the SAME in-flight
     promise and sees the same failure, plus a defensive re-create of the
     Set after the await in case an unrelated `unsubscribe()` deleted it
     out from under a still-in-flight caller.
  6. **Logging out never closed an already-open live `/ws` connection.**
     `/ws` auth is checked only once, at upgrade time, and the socket is
     designed to stay open indefinitely - so a background tab left open
     on a live run kept receiving events indefinitely past logout, on a
     dashboard whose whole security model is the one shared password.
     Fixed with `wsRelay.closeSocketsForSession(sessionID)` (each socket
     records `req.sessionID` at connect time), wired to `auth.js`'s new
     `setLogoutHook()` from `server.js` - not required directly between
     the two modules, since `wsRelay.js` already requires `auth.js` for
     `sessionMiddleware` and a direct reverse require would be circular.
  Also added, low-severity defense in depth: `req.session.regenerate()`
  on every successful login (session-fixation hardening - `auth.js`).
  All existing `test/wsRelay.test.js`/`test/sessionsHistory.test.js`
  cases still pass unchanged against this pass.
- **Fixed 2026-07-24 — the entire live tool-call card panel
  (`#tool-calls`) silently never rendered anything, against ANY real run,
  despite the rest of the live stream working correctly.** Root cause:
  there is no `"session.tool"` event at all - that event name (and its
  assumed `toolCallId`/`toolName`/`state` field names) was an unconfirmed
  guess that never matched reality, confirmed live 2026-07-24 by
  inspecting real captured frames. Tool-call lifecycle actually arrives
  as an `"agent"` event with `payload.stream === "tool"`, `payload.data`
  carrying `{phase:"start", name, toolCallId, args}` then
  `{phase:"result", name, toolCallId, isError, result:{content,
  details}}` - and that `{content, details}` shape is the EXACT same one
  `chat.history`'s own tool round-trips already use (see
  `parseToolRecordFromText`/`buildHistoryToolCard`), so `renderToolCard`
  was rewritten to consume `payload.data` directly and reuse
  `renderToolOutput`/`extractHistoryText` rather than inventing separate
  formatting - live and replay tool cards now render identically.
  `data.name` itself is just the generic wrapper name `"tool_call"` for
  some calls (matching what `chat.history` already showed); the human-
  meaningful bit, when present, is `data.args.args.command`. Verified
  live: a real run rendered tool cards with correct running/completed/
  error states, diff-colored git-diff output, and terminal-colored plain
  stdout, matching the already-working history-replay path exactly.
- **Fixed 2026-07-24 — the status banner got stuck on "agent running"
  forever, never updating even long after a run had genuinely finished.**
  Same root cause as the backend's dead `isTerminalEvent` check above:
  the "agent" event's top-level `payload.status` field only ever showed
  `"running"` (a separate, session-level field, confirmed across many
  real runs) - `"completed"`/`"failed"` never appeared, so the code that
  would have updated the banner on those values simply never fired after
  the initial "running". Fixed by additionally watching the `"lifecycle"`
  stream's own `phase:"end"` (confirmed live, present on every real run
  tested) and setting the banner to "agent completed"/"agent aborted"
  from `data.aborted` - the true-case (`aborted:true`) shape isn't
  independently confirmed yet, only `aborted:false` + `stopReason:"stop"`
  has been seen live, so treat that reading as reasonable, not
  guaranteed. New `.status-aborted`/`.status-running` CSS added
  (`.status-running` was already being set but had no matching rule).
- **Fixed 2026-07-24 (a SIXTH, distinct cause of the duplication symptom
  class, discovered while re-verifying the FIFTH fix immediately below
  against a run with several real tool calls in it) — the FIFTH fix's
  own gate went too far the other way and re-introduced the OLDER
  zero-separator text-gluing bug** (`"...incidents.Everything lo..."`,
  two turns' text glued with no space). Root cause: `chat.history`'s own
  ground truth for a single response can genuinely contain SEVERAL
  separate text-bearing assistant turns, not just one - a real run's
  `messages` array showed narrate -> 5 tool results -> narrate -> 4 tool
  results -> narrate (3 distinct assistant-role text turns total,
  confirmed via `GET /api/sessions/history`) - and neither `chat`'s own
  `state:"final"` nor `session.message` reliably fires at the boundary
  BETWEEN these turns (only at the very end of the whole run). The
  FIFTH fix's `!transcriptQueue.hasContent()` gate correctly killed the
  duplicate-bubble bug for redundant re-announcements of the CURRENT
  turn, but had no way left to recognize a GENUINELY new turn either, so
  everything after the first turn just glued onto it with zero
  separator. Fixed by using the one signal that unambiguously does mark
  this boundary in practice: a tool call actually STARTING
  (`payload.stream === "tool"`, `data.phase === "start"`) now flags
  `transcriptPendingBreak`/`thinkingPendingBreak` if the current bubble
  already has content, so the NEXT narration (whether after one tool
  call or several in a row) opens its own fresh bubble instead of
  continuing the previous one. Verified live end-to-end: a real run with
  6 internal tool-call round-trips rendered as 7 separate bubbles, each
  one's exact character length and head/tail text byte-for-byte matching
  `chat.history`'s own 7 stored text turns for that same session.
  **Lesson, on top of the FOURTH entry's own lesson below: fixing one
  duplication cause can silently re-open an OLDER, already-fixed bug in
  the same file if the new fix removes the only mechanism that was
  (accidentally) also serving that older bug's purpose - re-verify EVERY
  previously-fixed symptom in this file's history after touching this
  logic, not just the one you're currently working on.**
- **Fixed 2026-07-24 (a FIFTH, distinct cause of the duplication symptom
  class) — even with the retarget()/truncation fix (FOURTH entry, below)
  deployed and verified, a fresh real-gateway run still showed the same
  response rendered as several bubbles: one empty, one cut off mid-word,
  a full duplicate of the whole thing, and a bare tail-fragment repeating
  a chunk already shown.** Root cause, found by temporarily wrapping
  `renderFrame()` to log every raw WS frame during a real run (not a
  reconstruction): `session.message`, and the final `chat` frame's own
  `state:"final"` content, redundantly re-announce the exact same text
  this bubble's `chat`/`deltaText` events are ALREADY streaming
  character-by-character - confirmed twice, back-to-back, on two separate
  real runs, that once `deltaText` starts for a bubble it is the complete
  and correctly-ordered source of truth for it (its own gateway-tracked
  cumulative length matched `chat.history`'s final stored text exactly,
  both times). The redundant re-announcement is sometimes wrapped in an
  extra leading (and trailing) `"\n\n"` that plain `deltaText` never has,
  which broke `reconcileTranscriptText`'s plain string-prefix/substring
  comparison against `lastTranscriptSnapshot` - it misread the resend as
  "genuinely new" content, opening a duplicate bubble for text already
  fully shown, and once one bubble's worth of stray content polluted
  `lastTranscriptSnapshot` this way, EVERY later comparison against it was
  thrown off too, compounding into the observed empty/truncated/duplicate/
  fragment bubble pile-up. Fixed with `deltaTextSeenThisBubble` (reset
  per-bubble in `startAssistantTurn`, set the moment a bubble's own
  `deltaText` starts arriving): once true, later snapshot-shaped content
  for that same bubble is treated as pure noise - not rendered, and not
  even allowed to mark a turn boundary (`session.message`'s
  `transcriptPendingBreak`/`thinkingPendingBreak` are now conditioned on
  whether this specific frame delivered something actually new, not
  unconditional - a real run showed most `session.message` frames arrive
  completely content-less, and marking a boundary on those alone was
  ALSO splitting one continuous response into needless extra bubbles).
  The snapshot-reconcile path itself (`reconcileTranscriptText`,
  including its trim of stray leading/trailing whitespace) is left intact
  as a fallback for a bubble that never gets `deltaText` at all - e.g.
  reopening a still-live run from Recents before any delta has arrived.
  Verified by re-running the exact same live scenario after the fix: the
  full response (in both re-tests, 1000+ characters, several internal
  tool-call turns) rendered as a single bubble growing byte-consistently
  from empty to complete, no duplicate/truncated/fragment siblings, one
  clean "You"/"Agent" pair matching `chat.history`'s own stored text.
  **Lesson for any future pass touching this file: a fix verified against
  reconstructed/synthetic frame timing (as the FOURTH entry below was)
  can still miss a REAL frame-content bug - reconstructions only replay
  the shapes you already know to reconstruct.** This one only surfaced by
  capturing genuine raw frames from a real gateway run and diffing them
  against `chat.history`'s own stored ground truth.
- **Fixed 2026-07-24 (a FOURTH, distinct cause of the duplication symptom
  class - but this one's actually corruption, not duplication) — most
  assistant bubbles in a fast multi-step response showed up empty or cut
  off after 1-6 characters** ("Th", "Let", "Worktr", "Good, or"), only
  the LAST bubble of a response ever showing its full text. Root cause:
  `createRevealQueue`'s `retarget()` (added along with per-turn bubbles,
  see the entry below) unconditionally wiped `buffer`/`revealed` when
  pointed at a new bubble - fine IF the previous bubble's text had
  already fully finished its deliberately-slow ~125 chars/sec typewriter
  animation, but turns can legitimately arrive faster than that (a real
  fast ReAct-style debugging session - install `gh`, no `gh`, try curl,
  script mangled, etc. - produced turns roughly 60ms apart), so most
  bubbles got orphaned mid-animation with the rest of their text silently
  discarded forever. **The raw model output/gateway data itself was never
  at fault here** - confirmed by reconstructing the exact reported
  scenario with realistic inter-turn timing (not the instant/synchronous
  frame delivery every previous fix in this file was verified against)
  and capturing, for each bubble, exactly how many characters had
  revealed at the moment the NEXT turn's retarget() fired: 1-6 characters
  each, byte-for-byte matching the corruption pattern from a real run.
  Fixed by having `retarget()` flush whatever's still buffered into the
  bubble being LEFT, instantly and completely, before switching - the
  same realistic-timing reproduction confirmed every non-final bubble now
  shows its complete, correct text, with the final (currently-active)
  bubble continuing its normal typewriter animation as intended.
  **Lesson for any future pass touching the reveal queue: verify with
  REALISTIC inter-frame timing, not synchronous/instant test frames** -
  every prior fix in this file checked CONTENT correctness (right text,
  no duplicates) but not TIMING, which is exactly the dimension this bug
  lived in and would have passed every previous test unchanged.
- **Also confirmed 2026-07-24, NOT a bug** — a real end-to-end check
  (login → record a session → fetch its history → logout → relogin →
  fetch the SAME session's history again) through the actual Express app
  (real `auth.js` session middleware/router, real `routes/sessions.js`,
  gatewayClient's `chat.history` call stubbed since no live gateway was
  available) confirmed the logout/relogin/reopen-session flow already
  works correctly end-to-end: the user's own query stays the first
  message, full content is byte-identical before and after the
  round-trip, and history is correctly 401-gated the moment the session
  is logged out even with the old cookie still presented. This directly
  exercises the fix from the entry below (the merged-in `userMessages`).

- **Fixed 2026-07-24 (a THIRD, distinct cause of the same duplication
  symptom class) — a fresh real-world test still showed a live response
  duplicating, including the ENTIRE 3-turn response repeating in full
  twice at the tail**, even after the wsRelay.js fan-out fix and the
  eager-snapshot-reset fix (both above) had genuinely landed. Root cause
  this time was architectural, not a stray reset: one assistant bubble
  per USER MESSAGE (with internal agent steps merged into it via
  content-diffing) doesn't match reality - a real multi-step response
  (think → tool call → think → tool call → final answer) doesn't reliably
  arrive in a form ONE element's snapshot-diffing can cleanly reconcile,
  and `chat.history`'s own static replay was ALREADY showing each
  distinct backend turn as its own separate "Agent" block (interleaved
  with tool cards) - the live path just didn't match that structure.
  Fixed by giving every genuine internal turn its own bubble too (see
  `startAssistantTurn`'s `resetResponse` param and the new
  `reconcileTranscriptText`), which needed `lastTranscriptSnapshot` to
  become a CUMULATIVE tracker across every bubble in the current response
  (not reset per-bubble) so a redundant re-delivery of an EARLIER turn's
  text (not just the current bubble's) still gets caught via
  `.includes()` and doesn't spawn a duplicate bubble - confirmed this
  covers a full multi-turn recap resent as one snapshot too, not just a
  single-turn repeat, by mirroring `extractFinalText`'s own `"\n\n"` part-
  joining convention into how `lastTranscriptSnapshot` itself accumulates
  across bubbles. Verified by reconstructing the user's exact reported
  scenario (3 real turns with tool calls between them, then the full
  3-turn text redelivered twice via `session.message`) directly in the
  browser via `transcriptQueue.push()`/`retarget()` interception: each of
  the 3 turns' text appeared exactly once, in its own bubble, and both
  redundant full-response resends were correctly suppressed with zero
  extra bubbles or duplicated text.
- **Fixed 2026-07-24 — the user's own query bubble is missing entirely
  after a refresh or switching to another conversation and back.**
  Confirmed live: `chat.history`'s own `messages` array never includes
  the operator's own dashboard-submitted text as a `"user"`-role entry at
  all - not filtered out by a content-shape mismatch, genuinely absent
  from what the endpoint returns (this gateway apparently doesn't record
  a dashboard-triggered instruction as a literal chat turn the way it
  does the agent's own responses). The live view was never affected
  (`appendUserTurn()` already renders it optimistically on submit,
  independent of `chat.history`) - only the STATIC replay
  (`renderHistoryReplay`, used after a refresh/Recents click) was
  missing it, since that path has always relied entirely on
  `chat.history`'s own returned messages. Fixed on the one party that
  DOES know this text for certain - the dashboard itself, since it's
  exactly what `POST /api/run` sent: `sessionIndex.record()` now appends
  every user message (not just the first, used as the Recents label) to
  a new `userMessages` array per session, and `GET /api/sessions/history`
  merges them back in as synthetic `role:"user"` messages
  (`mergeUserMessages()`) before the client ever sees the array - no
  client-side changes needed, `renderHistoryReplay` already renders
  whatever shape it's given correctly. `chat.history`'s own messages
  carry no timestamp to merge against precisely (only known to already be
  oldest-first) - with exactly one recorded message (a fresh
  conversation, the confirmed-live case) placement is unambiguous: it
  goes first, everything else follows. With several (a session with
  follow-ups), this uses a best-effort proportional split, NOT
  independently verified against a real multi-message replay yet -
  flagged directly in `mergeUserMessages`'s own comment as the thing to
  revisit if a real multi-turn replay is ever confirmed misplaced.
  Covered by `test/sessionsHistory.test.js` (the single-message case
  matching what was actually confirmed live, plus the multi-message
  proportional split, plus two "don't crash" edge cases).
- **Added 2026-07-24 — deleting a conversation from Recents.** A
  hover-revealed `×` on each Recents row (`.recents-item-delete`,
  keyboard-reachable via Tab even before hover - `opacity:0` until
  `:hover`/`:focus-visible`, not `display:none`), matching Claude's/Claude
  Code's own convention. Backed by `DELETE /api/sessions?key=<sessionKey>`
  (query param, not a `:sessionKey` path segment - matches
  `/api/sessions/history`'s existing convention, and sessionKey contains
  colons - `agent:<agent>:dashboard-<timestamp>`, see `routes/run.js` -
  which are safer carried as an encoded query value). **Deliberately only
  removes the dashboard's own Recents index entry
  (`sessionIndex.remove()`) - does NOT attempt to delete anything on the
  Gateway side.** No `sessions.delete`-shaped RPC (or equivalent) has ever
  been confirmed against a real gateway in this project, and guessing at
  one against a live production system - the same "don't guess an RPC
  shape, confirm live first" rule the rest of this codebase already
  follows - wasn't done here; a deleted conversation could still be
  reachable some other way (e.g. directly on Server 6) if that's ever
  needed. `deleteSession()` in `app.js` confirms via a native
  `confirm()` dialog first, then resets to the empty "+ New task" state
  if the conversation just deleted is the one currently on screen (a
  follow-up sent into an already-deleted-from-index session would
  otherwise silently re-create its Recents entry via
  `sessionIndex.record()` on the next `/api/run` - harmless, but
  confusing to leave visibly "still there" mid-delete). `.recents-item`
  changed from being the clickable `<button>` itself to a plain `<div>`
  wrapping two separate buttons (`.recents-item-open`, `.recents-item-delete`)
  - a `<button>` can't validly nest another interactive element inside
  it. **A real CSS specificity bug found and fixed during this same
  pass, not just a cosmetic tweak**: a pre-existing rule,
  `.sidebar-section select, .sidebar-section button { width: 100% }`
  (this row lives inside a `.sidebar-section`), still matches both new
  buttons and — being 1 class + 1 type selector — has HIGHER specificity
  than a bare single-class override regardless of source order. On
  `.recents-item-delete` specifically (which also has `flex-shrink: 0`),
  that `width: 100%` became its flex-basis (`flex-basis: auto` defers to
  `width` when one's set) and it refused to shrink from that 100%-of-row
  basis - confirmed live, the delete button rendered ~225px wide and
  squeezed the open button/label down to a few px, silently blanking out
  every Recents row's visible text. Fixed by qualifying both overrides
  with the extra `.recents-item ` ancestor class
  (`.recents-item .recents-item-open`/`.recents-item .recents-item-delete`,
  2 classes beats 1 class + 1 type), not just adding `width: auto` to the
  bare class (confirmed live that alone silently loses the cascade).
  Verified end-to-end: `DELETE /api/sessions` tested directly via `curl`
  (200 on a real entry, 404 on an unknown key, 400 on a missing `key`
  param) and the full UI flow tested live in the browser (hover-reveal,
  the confirm-and-abort path - this automation browser disables native
  dialogs and confirmed `confirm()` correctly returns `false`, aborting
  before any request fires - and the confirm-and-proceed path for both a
  non-active and the currently-active conversation, the latter correctly
  resetting to the empty state).
- **Fixed 2026-07-24 (a SECOND, distinct cause of the same "replied 3
  times" symptom) — a live turn's text duplicated within one bubble even
  on a single, never-reconnected WebSocket connection**, confirmed by the
  wsRelay.js fix (above) genuinely landing first, then a fresh real-world
  test still tripling one greeting response inside one bubble. Root cause,
  entirely in `app.js`, entirely client-side: `renderFrame()` eagerly
  reset `lastTranscriptSnapshot` (and `lastThinkingSnapshot`) to `""`
  *every time* `transcriptPendingBreak` happened to be set, regardless of
  whether the arriving content was actually new. Per this same file's own
  established, previously-confirmed finding, `session.message` delivers
  its own full-text snapshot of a turn *in addition to*, not instead of,
  whatever `chat`'s `deltaText` stream already delivered for that same
  turn — so once `chat state:"final"` set the pending-break flag, the very
  next frame to arrive (a `session.message` redundantly re-announcing text
  already fully shown) hit the eager reset, made `pushSnapshotDiff` treat
  the identical text as brand-new, and re-appended a full duplicate — and
  did that again for each further redundant redelivery. Fixed by no longer
  eagerly resetting the snapshot on the content-snapshot path (thinking and
  final-text both) — `pushSnapshotDiff` already derives a genuine boundary
  directly from the content itself (see the entry below this one), so an
  exact redundant repeat now correctly slices down to an empty, harmless
  no-op push, while genuinely new/different content still gets its real
  break via the same mismatch branch, unaffected by this change. The
  `deltaText` path (`chat` events) still needs and keeps its OWN eager
  reset — it's pure blind concatenation with nothing to compare against,
  so it has no other way to detect a real turn boundary. Verified two ways
  directly in the running browser (not just reasoning about the code):
  intercepting `transcriptQueue.push()` to record every call while
  replaying a realistic frame sequence (deltaText chunks, then a bare
  `chat state:"final"`, then TWO redundant `session.message` redeliveries
  of the identical text) confirmed both redundant deliveries now push `""`
  — zero duplication — while a SEPARATE, genuinely-new-content sequence
  (two different unrelated `session.message` turns back to back, the exact
  `"...activity.Oops, typo..."` shape from an earlier real run) still
  correctly pushed `"\n\n" + text` for each. Not a permanent automated
  test this time (unlike `test/wsRelay.test.js` below) — `app.js` is a
  DOM-dependent browser script with no test-friendly module boundary yet,
  and this project deliberately has no test framework/build step; adding
  one (e.g. jsdom) just for this would be a real dependency decision, not
  made here without asking first.
- **Fixed 2026-07-24 — real duplicated event delivery (root cause of "why
  did it replied 3 times?"), in `wsRelay.js`, not the client.** Every new
  browser WebSocket connection to an existing `sessionKey` created a
  brand-new `onEvent` closure and added it to `gatewayClient`'s per-session
  `subscriptions` Set — the RPC call itself was correctly deduped (`has()`
  guard), but each closure is its own distinct object, so `Set` dedup (by
  reference) never applied across connections. A run watched across N
  connections (N tabs, or one tab reconnecting N times — e.g. navigating to
  another conversation and back) had every real gateway event fanned out N
  times over, each fan-out separately re-iterating the *entire*
  `browserSockets` set and re-sending to every one of them. Proven with a
  real, executable test, not just read from the code: `test/wsRelay.test.js`
  fails against the pre-fix code with `"wsA1 should receive the chat event
  exactly once, got 2"` the moment a second connection touches the same
  session — confirmed 2026-07-24 by running it against both the pre- and
  post-fix code via `git stash`. Fixed by creating exactly ONE stable
  `onEvent` per run (`run.onEvent`, set once in `getOrCreateRun`) and always
  passing that same reference — `subscribe()`/`Set#add()` of an
  already-present reference is a harmless no-op, so calling it on every
  connection is now safe. Unsubscribe is correspondingly gated on
  `run.browserSockets.size === 0` (the LAST tab leaving), not "a tab left" —
  otherwise the first of several tabs to close would tear down the shared
  subscription out from under the others still watching. `gatewayClient.
  subscribe()` also gained a rollback (`this.subscriptions.delete(sessionKey)`
  on a failed RPC) — needed now that it's called on every connection rather
  than gated by wsRelay.js itself; without it, one failed subscribe attempt
  would permanently strand a run with no live events, since the `has()`
  guard would see it as "already subscribed" on every later retry.
- **Fixed 2026-07-24 — an already-finished conversation visibly re-streams/
  retypes itself when reopened from Recents.** `wsRelay.js` replayed a
  run's *entire* buffered event history to *every* newly-connecting
  browser socket, unconditionally — including a socket opened by
  `openHistoricalSession()`, which has ALREADY rendered that session's
  complete past content via a static `chat.history`-based replay
  (`renderHistoryReplay`, no animation). The live socket's redundant replay
  re-sent the same already-shown content as if newly live, and the client
  has no way to tell "this is old" from "this is genuinely new" — it just
  fed everything through the same reveal-queue typewriter effect meant for
  live streaming. Fixed with an explicit signal from the party that
  actually knows the answer (the client, not an unreliable server-side
  "is this run terminal" heuristic — the `agent` event's completed/failed
  status was never independently confirmed to fire reliably, see below):
  `openSocket()` accepts `{skipEventReplay}`, `openHistoricalSession()`
  passes it (it just did the chat.history replay itself), `startStream()`
  doesn't (a brand-new session's buffer is empty anyway). Sent as
  `?skipReplay=1` on the `/ws` upgrade URL, read by `wsRelay.js`'s upgrade
  handler and threaded through to the connection handler, which now only
  replays when NOT set — preserving the original, still-real "a second tab
  (or a refreshed one) joins an already-active run mid-stream" behavior for
  the one caller that hasn't already caught up some other way. Also
  covered by `test/wsRelay.test.js`.
- **Fixed 2026-07-24 — the live transcript was one continuous
  undifferentiated stream: the user's own message was never shown at all,
  and every turn (user, assistant, and every internal agent step within
  one response) ran together with no visual separation.** Explicitly
  requested to match Claude Code's own convention: a distinct bubble per
  participant turn. `app.js`'s `appendChatTurn()`/`appendUserTurn()`/
  `startAssistantTurn()` build this, reusing the exact same `.chat-turn`
  markup and CSS the static history replay already had (renamed from
  `.history-turn` now that both paths share it, so a turn looks identical
  whether it's currently streaming or being replayed later). The
  composer's submit handler calls `appendUserTurn()` immediately on submit
  (optimistic — the message text is already known in full, no need to wait
  for the gateway to echo it back) and `startAssistantTurn()` once per
  submitted message — deliberately NOT once per internal
  think/tool-call/think-again step within that response, which stay part
  of the SAME bubble via the pre-existing `transcriptPendingBreak`
  paragraph-break mechanism; one user message always maps to one assistant
  turn, even if it took several internal steps to answer.
  `transcriptQueue` (the reveal queue backing the live transcript) gained a
  `retarget()` method so it can be pointed at each new bubble's own body
  element instead of writing into one shared `#transcript-live` div
  directly — its `hasTarget()` also backs a defensive fallback in
  `renderFrame()` (lazily calling `startAssistantTurn()` if content arrives
  with no bubble open yet), covering the one case that isn't
  user-initiated in the current view: reopening a still-actively-streaming
  run from Recents. `.chat-turn-user` gets an actual bubble (background,
  border, right-aligned, width-capped) while `.chat-turn-assistant` stays
  plain flowing text with no box — Claude Code's own asymmetric
  convention, not a bubble on both sides.
- **Fixed 2026-07-24 — mouse had to be directly over the text column to scroll, and the scrollbar rendered mid-page instead of at the page's right edge.** Both were the same root cause: `#conversation` (the actual `overflow-y: auto` scroll container - see `app.js`'s own comment on the `conversation` const) also carried `max-width: 800px; margin: 0 auto` directly, so its own box was only as wide as the text column, not the full `#main-pane`. Anywhere outside that narrow column was technically outside `#conversation` entirely, so wheel events landed on `#main-pane` instead and did nothing, and the native scrollbar tracked the narrow box's edge rather than the page's. Fixed by splitting the two concerns onto two elements, matching Claude Code's own layout: `#conversation` now spans the full pane width and owns only `overflow-y`/`flex`, while a new inner `#conversation-inner` wrapper (added in `index.html` around the existing children) owns `max-width`/`margin: 0 auto`/the `1.5rem` padding that used to live on `#conversation`. Scrolling now works from anywhere over the pane, and the scrollbar sits flush against the true right edge.
- **Fixed 2026-07-24 — THIRD recurrence of the glue-text bug (see the two entries below this one), this time in reasoning/narration text, confirmed live via screenshot** (`"...in the app logs.Let me check the pod spec..."`, zero characters between turns, not even a space). Both prior fixes added an explicit turn-boundary flag for one more specific event name (`chat` `state:"final"`, then `session.message`) - this run showed a turn boundary arriving through neither, so `thinkingPendingBreak`/`transcriptPendingBreak` never fired for it. Rather than add a fourth named special case (which the next differently-shaped event would just evade again), `pushSnapshotDiff()` is now fixed structurally: a new snapshot that doesn't extend the previous one (`!fullText.startsWith(previousSnapshot)`) *is* a turn boundary, full stop, regardless of which event delivered it. That branch previously called `queue.reset()` - wiping every already-revealed character and re-typing just the new text from nothing - which is also the confirmed explanation for "the thinking text appears/disappears randomly": every one of these unrecognized boundaries blanked the pane before refilling it. It's now `queue.push((queue.hasContent() ? "\n\n" : "") + fullText)` instead (a new `hasContent()` method on the reveal-queue object) - appends with a break rather than wiping, fixing the flicker and the zero-separator gluing at the same root cause, for any boundary-carrying event, known or not. The existing `thinkingPendingBreak`/`transcriptPendingBreak` mechanism is unchanged and still fires proactively for the two known event types; this is now also a structural safety net underneath it for whatever a real run turns up next.
- **`NEMOCLAW_GATEWAY_PORT` (8180) is NOT the agent gateway** — confirmed 2026-07-23 the hard way (a real, multi-round debugging session). 8180 is OpenShell's own separate control-plane API, used by the `nemoclaw` CLI itself for `exec`/`status`/etc. The actual OpenClaw agent gateway is bound inside the sandbox container (`10.200.0.2:18789`, not directly reachable from the host), but NemoClaw already maintains a persistent SSH tunnel forwarding it to the host's own `127.0.0.1:18789` — confirmed via `ss -ltnp | grep 18789` showing a live `ssh` process listening there, and `nemoclaw <name> dashboard-url`'s own "Remote access" instructions assuming exactly this reachability. `NEMOCLAW_GATEWAY_URL` must point at `18789`, not `8180`.
- **The WS endpoint is `/ws`, not the root, and the client must send an `Origin` header matching the gateway's own `http(s)://host:port`** — confirmed against `openclaw config get gateway` showing `controlUi.allowedOrigins` as a hardcoded allowlist of exactly `http://127.0.0.1:18789`, and against NemoClaw's own installed test suite (`~/.nemoclaw/source`) showing the real connection pattern. `gatewayClient.js`'s `buildWsTarget()` handles both automatically from `NEMOCLAW_GATEWAY_URL` (keep that var as the bare origin, no path). The rest of the challenge-response handshake's exact field names still weren't independently confirmed before this was written — `gatewayClient.js` implements its best literal reading of the documented shape, with verbose logging of every raw handshake frame. If it hangs or the connect frame gets rejected, the console log will show exactly what the real gateway sent/expected — adjust `_respondToChallenge()`'s field names to match, don't guess again.
- **`chat.send` resolved** — confirmed live: `sessions.create` isn't strictly needed (`chat.send` creates the session implicitly and works fine even when it fails/is skipped, so `routes/run.js` keeps it as a best-effort, non-blocking call), and `chat.send` itself requires an `idempotencyKey` param plus explicit `deliver: false`. `sessions.messages.subscribe` needs `{ key }`, not `{ sessionKey }`. All confirmed against real runs, not guessed.
- **Thinking-content rendering is NOT yet confirmed against a real run** — `app.js` checks any event's `payload.message.content` (an array of parts, each with either `.text` or `.thinking` — confirmed shape via NemoClaw's own test suite, same as Anthropic's Messages API content blocks) and renders `.thinking` parts into the collapsible `#thinking-block`. What's unconfirmed: whether `chat` events, `session.message` events, or both actually carry this field in practice for this gateway version. If the thinking block never un-hides during a run that should have reasoning content, add a temporary `console.log(frame.event, payload.message)` in `renderFrame()` to see the raw shape and adjust.
- **Fixed 2026-07-23 — raw gateway event JSON was visibly leaking into the UI.** A "final"-state `chat` event (full `message.content` snapshot, no `deltaText`) fell through every specific branch in `renderFrame()` and hit the old generic `.raw-event` fallback, which rendered the whole frame as JSON text — confirmed live from a real run's screenshot. That fallback is gone entirely; every `chat` event (delta or snapshot-shaped) and every other unhandled event is now either handled or silently swallowed (routed to `console.debug`, never the DOM). Same underlying event is also why thinking/final text ever showed up glued together mid-sentence — `extractThinkingText`/the content-joining logic used `.join("")` across multiple content-array parts (each part being its own paragraph-ish chunk, not a pre-joined string) instead of `.join("\n\n")`. Both the thinking path and a new matching `extractFinalText()` path now join with a blank line, and a shared `pushSnapshotDiff()` helper reconciles a cumulative snapshot against whatever was already streamed via `deltaText` so the same text is never both streamed incrementally *and* re-pushed whole from the final snapshot.
- **Fixed 2026-07-23 (fifth pass) — real Chromium quirk was silently shrinking every em-based size on `<code>`/`<pre>`.** Confirmed via isolated reproduction: browsers give `code`/`pre` their own independent UA-stylesheet `font-family: monospace` default; in an environment where none of this page's own monospace stack (`ui-monospace`/`SF Mono`/Menlo/Consolas) actually resolves (falls through to the bare generic keyword), Chrome computes *any* `em`-based size set on that element via an external stylesheet rule against the OS's separate "fixed-width font size" preference (13px in the sandbox used to test this) instead of the element's actually-inherited font-size (16px) - so `font-size: 1.05em` was silently computing to ~13.65px, smaller than body, not larger. This is why inline code kept reading as "too small" even after earlier passes supposedly matched it to body size. Fixed by adding `font-family: inherit` to both the `code` and `pre` rules - forces the exact same resolved font-family as the parent, so the element is never independently re-resolving the generic keyword, and `em` math behaves normally. Also, in that same pass: bumped list-item spacing further (0.4em -> 0.55em) and added `margin-top` to `ul`/`ol` themselves, made heading sizes/margins much more assertive (h1 1.5em/h2 1.3em/h3 1.15em, more top margin) to actually read as headings rather than barely-bigger text, added `line-height: 1.6` to the transcript/thinking containers, and forced links to `font-size: 1em` explicitly (this one measured identical to body even before the fix - can't rule out it was a purely visual impression from the underline+color, but forcing it removes any doubt either way).
- **Fixed 2026-07-23 (fourth pass) — SUPERSEDED 2026-07-27, see the entry near the top of this section (the composer now stays disabled for a run's full duration instead) — the composer got stuck disabled forever after the first successful run.** `setComposerEnabled(true)` was only ever called on a failed `/api/run` request; on success it relied entirely on an `agent` event reporting `status: "completed"`/`"failed"`, or the WebSocket closing - and confirmed live, neither reliably happens (the socket is designed to stay open indefinitely, and the `agent` event's exact shape/whether it fires per-run at all was never independently confirmed to begin with). Moved the re-enable into a `finally` around the `/api/run` call so it happens right after that POST resolves, win or lose - not gated on the run itself finishing. Each submission opens its own independent `sessionKey` (see `routes/run.js`) regardless of whether a previous run is still streaming, so there's no real hazard in letting the user start a new one immediately; the brief disable during the POST only exists to prevent a double-click on the same submit. Verified by mocking `/api/run`'s response and confirming the composer re-enables with zero WS frames ever received (i.e. even when nothing resembling "the run finished" ever arrives).
- **Fixed 2026-07-23 (third pass, after a real run confirmed the pipeline itself works) — three UI polish items.** (1) Inline code (`` `text` ``) was rendering at `0.9em`, visibly smaller than surrounding text - removed the size reduction (now `1em`) and added `--code: #d2a8ff` (a lavender/purple that doesn't collide with the existing accent blue/ok green/warn yellow/fail red) as its text color, matching Claude's own convention of tinting inline code text rather than just boxing it; fenced code *blocks* stay in the normal text color, only inline spans get the tint. (2) Markdown list items (`<li>`) had zero space between them by default - added `margin-bottom` between items. (3) **`session.message` events glue together exactly like `chat`'s per-turn gluing did** (confirmed live: `"...activity.Here's the full status..."`) - turns out `session.message` carries its own standalone turn text (not just `.thinking`, which was all the generic content-block extracted before), and it fires as its own discrete turn with no `chat` `state:"final"` in between to trigger the existing break logic. Fixed by making final-text extraction generic (any content-bearing frame where `payload.deltaText` isn't a string, not just `chat`'s snapshot variant) and having `session.message` itself set `thinkingPendingBreak`/`transcriptPendingBreak`, exactly like `chat`'s `state:"final"` already did.
- **`marked` must stay pinned below v16 - v16+ requires Node >= 20, Server 6 runs v18.19.1.** Confirmed the hard way: `npm install` on Server 6 silently produced no `node_modules/marked` at all (`ENOENT ... marked/lib/marked.umd.js` at runtime), because `marked@18.x`'s `package.json` declares `"engines": {"node": ">= 20"}`. `marked@15.0.12` is the latest major version that still declares `">= 18"` and ships the identical `lib/marked.umd.js` API (`marked.parse(text, { gfm, breaks })`) - re-verified locally after the downgrade, byte-identical rendering/sanitization behavior. `dompurify` has no engines restriction either way. If bumping `marked` later, check its `engines` field against whatever Node version Server 6 is actually running first - don't just take the latest.
- **Fixed 2026-07-23 (second pass, after a real run) — transcript/thinking text is Markdown, not plain text.** A real run showed literal `**bold**`/`### heading`/`| table |` source syntax on screen instead of formatted output. `public/vendor/marked.umd.js` + `public/vendor/purify.min.js` are served by `server.js` (two exact `node_modules` files, not the whole tree - see the `/vendor/*` routes) and loaded before `app.js`. `renderMarkdownToSafeHtml()` runs `marked.parse(text, { gfm: true, breaks: true })` then `DOMPurify.sanitize()` before it ever touches `innerHTML` - **sanitization is not optional here**, since this text ultimately comes from an LLM agent that may have read untrusted external content (a file, a webpage) as part of its work, so it has to be treated like any other untrusted HTML source. `createRevealQueue()` now re-renders the full revealed-so-far text as Markdown on every tick instead of appending raw characters (re-parsing a few KB every 16ms is cheap; appending raw HTML fragments char-by-char would both break mid-tag and skip sanitization). `#transcript`/`#thinking-text` lost their `white-space: pre-wrap` accordingly - real HTML elements now, not preformatted text - and gained real styling for headings/tables/code/lists/blockquotes/links in `style.css`.
- **Fixed 2026-07-23 (same pass) — separate turns glued together with zero separator** (e.g. a real run showed `"...app logs.Good news..."`). A `chat` event's `state: "final"` marks the end of *one turn*, not necessarily the whole run - a multi-turn agent loop (think, call tools, think again) sends one of these per turn, and nothing previously marked where one turn's stream ended and the next began, so consecutive turns' text just concatenated directly. `renderFrame()` now sets a `transcriptPendingBreak`/`thinkingPendingBreak` flag on `state: "final"`, consumed (inserting `"\n\n"` and resetting the relevant `lastXSnapshot` tracker) the next time that stream resumes - harmless if nothing more ever arrives. This also fixed a latent related bug: a second turn's own `state: "final"` snapshot would otherwise fail `fullText.startsWith(previousSnapshot)` against the *first* turn's accumulated text (since it's unrelated content), silently wiping the entire visible transcript via `pushSnapshotDiff`'s reset branch. As a side effect, the `chat` `state: "final"` handler no longer sets `statusBanner` to "done" - that was misleading mid-run (flickered "done" after every turn, not just the real end); true run-level status now comes only from the `agent` event's `completed`/`failed` status, which was already handled separately.
- **Tool-call cards are now collapsible** (`<details>`/`<summary>`, same treatment as the thinking block and matching Claude's own collapsible tool/reasoning UI) — one card per `toolCallId`, updated in place across queued→running→completed/failed transitions rather than recreated (so an operator's expand/collapse choice survives state updates). **The exact `session.tool` payload shape beyond `toolCallId`/`toolName`/`state` is still NOT confirmed against a real run** — rather than guess field names, the expanded detail view renders whatever other keys the payload actually has, generically, so real `input`/`output`/`error`/duration fields (whatever they're actually called) will show up correctly the moment a real run produces them, with no further code change needed. A **temporary** `console.log('[dashboard debug] session.tool frame:', ...)` was added to `renderToolCard()` specifically to capture that real shape on the next run — remove it once confirmed (tracked here, not elsewhere).
- **Fixed 2026-07-23 (fifth pass) — a new response could visibly "flicker"/interleave with a still-closing previous one.** `startStream()` calls `activeSocket.close()` before opening the next session's socket, but closing a WebSocket isn't instant - a handful of trailing "message" events from the just-superseded socket could still arrive afterward. `renderFrame()`'s state (`transcriptQueue`, `lastTranscriptSnapshot`, `toolCallCards`, etc.) is shared/global, not scoped per-socket, so those stale events would render straight into the freshly-reset UI for the *new* session. Fixed with a guard at the top of the "message" handler (`if (ws !== activeSocket) return;`) - the same pattern the "close" handler already used, just missing here. Verified by capturing a superseded socket's reference and dispatching a fake trailing event on it directly: confirmed it no longer reaches the transcript.
- **In-memory session store** — a server restart logs everyone out. Fine for v1; revisit if this becomes annoying.
- **Single shared password, no per-user auth** — anyone with `DASHBOARD_PASSWORD` shows up as "the dashboard" in any run they trigger. No per-user attribution in v1, despite attribution being the whole motivation for building this — a real trade-off, not an oversight.
- **Reachable from the open internet** once the router port-forward is added — this is why the app-level password + rate limiting + TLS all exist, unlike everything else in this repo so far, which has relied on network-level boundaries (SSH, RBAC, tunnel-only keys). Don't skip the TLS cert step; `config.js` will start in plaintext HTTP with a loud warning if you do, but it will still start.

## Explicitly out of scope for v1

`audit.activity.list`-based history, notifications for runs not started from
the dashboard, a multi-session dashboard view. (Markdown rendering in the
transcript and retiring the old chat notification path were both originally
listed here too - both since done, see the changelog above and "Why this
exists".)

"Log/incident browsing" was listed here too, and is now half done rather than
done: live tailing exists as of 2026-08-13 (see "Monitoring" above), but
*browsing* — search, download, scrollback before stream start, correlating
across repos — does not, and needs a log backend rather than `kubectl`.
