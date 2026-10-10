// Upgrade-gate test for src/logsRelay.js's /ws/logs channel - run directly
// with `node test/monitoringUpgradeAuth.test.js`. Hermetic: sessionMiddleware,
// registry and logStream are all stubbed, so no cookies, no gateway, no
// sandbox and no cluster.
//
// Two separate things are pinned here, and the second is the one that would
// otherwise be found the hard way.
//
// 1. THE AUTHORIZATION GATE. This dashboard's whole security model is one
//    shared password, so "authenticated" is not by itself authorisation to
//    stream an arbitrary workload. A stream's namespace and label selector
//    must be resolved server-side from the registry by repoKey - if they were
//    ever taken from the client, any logged-in user could point kubectl at
//    any workload in the cluster. wsRelay.js had precisely this gap for its
//    own channel until 2026-07-30; this covers the equivalent here from the
//    start rather than after.
//
// 2. CO-EXISTENCE OF THE TWO RELAYS. Node invokes EVERY "upgrade" listener,
//    and wsRelay.js used to `socket.destroy()` any path that wasn't /ws.
//    With both relays attached to one server that makes /ws/logs impossible -
//    whichever listener runs first kills the socket out from under the other,
//    and the symptom (a handshake that dies with no response) reads like an
//    auth or protocol fault rather than a routing one. The last three cases
//    below are what keep that fix honest, including the direction nobody
//    would think to check: that logsRelay does not break /ws either.
//
// The catch-all that refuses genuinely unknown paths lives in server.js, not
// in a relay, so it is deliberately NOT covered here - requiring server.js
// would pull in config.js, which exits the process on any machine that isn't
// Server 6. What IS covered is the property the catch-all depends on: a relay
// leaves a foreign path's socket untouched.

const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8789";

// Order matters: every stub is installed immediately after its module is
// required and BEFORE logsRelay.js is required for the first time, so
// logsRelay's own require() calls return the already-stubbed objects. A stub
// applied afterwards would not reach a value the module destructured at its
// own require time - the capture-timing gotcha wsRelayAuth.test.js documents.
const auth = require(path.join(__dirname, "..", "src", "auth.js"));
let authenticated = true;
auth.sessionMiddleware = (req, res, next) => {
  req.session = { authenticated };
  req.sessionID = "test-session-id";
  next();
};

const registry = require(path.join(__dirname, "..", "src", "registry.js"));
const REAL_TARGET = {
  repoKey: "api-rag",
  displayName: "Demo RAG",
  runtimeType: "k8s",
  namespace: "dev",
  labelSelector: "app=svc-rag-dev",
  streamable: true,
  unstreamableReason: null,
};
const RETIRED_DOCKER_TARGET = {
  repoKey: "legacy-docker",
  displayName: "Legacy",
  runtimeType: "docker",
  namespace: null,
  labelSelector: null,
  streamable: false,
  unstreamableReason: 'runtime type "docker" cannot be log-streamed (only k8s can)',
};
registry.getRuntimeTarget = (repoKey) => {
  if (repoKey === "api-rag") return REAL_TARGET;
  if (repoKey === "legacy-docker") return RETIRED_DOCKER_TARGET;
  return null;
};

const logStream = require(path.join(__dirname, "..", "src", "logStream.js"));
let subscribeCalls = [];
let subscribeThrows = null;
let unsubscribed = 0;
logStream.subscribe = (target, handlers) => {
  if (subscribeThrows) throw subscribeThrows;
  subscribeCalls.push({ target, handlers });
  return () => {
    unsubscribed += 1;
  };
};

const logsRelay = require(path.join(__dirname, "..", "src", "logsRelay.js"));
const wsRelay = require(path.join(__dirname, "..", "src", "wsRelay.js"));

function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.write = (data) => socket.written.push(data);
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.readyState = 1;
  ws.OPEN = 1;
  ws.bufferedAmount = 0;
  ws.closed = false;
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.close = () => {
    ws.closed = true;
    ws.emit("close");
  };
  return ws;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

// Drives the REAL upgrade handler logsRelay.attach() installs. handleUpgrade
// is stubbed past the actual WebSocket protocol handshake (which would need
// genuine sec-websocket-key headers this test has no reason to fake) - what
// matters is whether the gate lets the request through at all, and what the
// accepted socket is then told.
async function upgrade(url, { alsoAttachWsRelay = false } = {}) {
  const fakeServer = new EventEmitter();
  const wss = logsRelay.attach(fakeServer);
  // Attaching wsRelay TOO reproduces production, where both listeners are on
  // the same server and each sees every upgrade.
  if (alsoAttachWsRelay) wsRelay.attach(fakeServer);

  let ws = null;
  wss.handleUpgrade = (req, socket, head, cb) => {
    ws = fakeWs();
    cb(ws);
  };
  const socket = fakeSocket();
  fakeServer.emit("upgrade", { url }, socket, Buffer.alloc(0));
  await flush();
  return {
    ws,
    socket,
    status: socket.written[0] ? socket.written[0].split(" ")[1] : null,
    accepted: Boolean(ws),
  };
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS: ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL: ${label}\n      ${err.message}`);
  }
}

(async () => {
  // === the authorization gate ============================================
  subscribeCalls = [];
  const ok = await upgrade("/ws/logs?repoKey=api-rag");
  check("a registered, streamable workload is accepted", () => {
    assert.ok(ok.accepted, `expected acceptance, got status ${ok.status}`);
    assert.strictEqual(subscribeCalls.length, 1, "no stream was started for an accepted socket");
  });

  check("the namespace and selector come from the REGISTRY, not the client", () => {
    // The load-bearing assertion of this file. If these ever start echoing
    // client input, any logged-in user can stream any workload in the cluster.
    const t = subscribeCalls[0].target;
    assert.strictEqual(t.namespace, "dev");
    assert.strictEqual(t.labelSelector, "app=svc-rag-dev");
  });

  subscribeCalls = [];
  const injected = await upgrade(
    "/ws/logs?repoKey=api-rag&namespace=kube-system&labelSelector=" +
      encodeURIComponent("app=anything-else"),
  );
  check("client-supplied namespace/selector query params are ignored outright", () => {
    assert.ok(injected.accepted);
    const t = subscribeCalls[0].target;
    assert.strictEqual(t.namespace, "dev", "a client-supplied namespace reached kubectl");
    assert.strictEqual(
      t.labelSelector,
      "app=svc-rag-dev",
      "a client-supplied selector reached kubectl",
    );
  });

  const unknown = await upgrade("/ws/logs?repoKey=not-registered");
  check("an unregistered repoKey is rejected with 403", () => {
    assert.strictEqual(unknown.accepted, false, "an unregistered target was accepted");
    assert.strictEqual(unknown.status, "403", `expected 403, got ${unknown.status}`);
  });

  const noKey = await upgrade("/ws/logs");
  check("a missing repoKey is rejected with 400", () => {
    assert.strictEqual(noKey.status, "400", `expected 400, got ${noKey.status}`);
  });

  authenticated = false;
  const unauth = await upgrade("/ws/logs?repoKey=api-rag");
  authenticated = true;
  check("an unauthenticated upgrade is rejected with 401, valid repoKey or not", () => {
    assert.strictEqual(unauth.accepted, false, "an unauthenticated socket was accepted");
    assert.strictEqual(unauth.status, "401", `expected 401, got ${unauth.status}`);
  });

  // === accepted-then-failed cases ========================================
  subscribeCalls = [];
  const retired = await upgrade("/ws/logs?repoKey=legacy-docker");
  check("a non-streamable runtime is accepted, told why, then closed", () => {
    // Accepted rather than refused on purpose: a refused upgrade gives the
    // browser an opaque handshake error with no readable body, while this
    // reaches the pane as a rendarable reason.
    assert.ok(retired.accepted, "a known-but-unstreamable target was refused at handshake");
    assert.strictEqual(subscribeCalls.length, 0, "a stream was started for an unstreamable target");
    const frame = retired.ws.sent[0];
    assert.strictEqual(frame.t, "status");
    assert.strictEqual(frame.state, "failed");
    assert.match(frame.detail, /docker/, "the reason from the registry was not passed through");
    assert.ok(retired.ws.closed, "the socket was left open after failing");
  });

  const limitErr = new Error("too many concurrent log streams (8/8) - close a pane and retry");
  limitErr.code = "STREAM_LIMIT";
  subscribeThrows = limitErr;
  const limited = await upgrade("/ws/logs?repoKey=api-rag");
  subscribeThrows = null;
  check("hitting the stream cap is reported to the pane, not thrown away", () => {
    assert.ok(limited.accepted);
    const frame = limited.ws.sent[0];
    assert.strictEqual(frame.state, "failed");
    assert.match(frame.detail, /close a pane/, "the operator is given no way forward");
    assert.ok(limited.ws.closed);
  });

  // === teardown ===========================================================
  subscribeCalls = [];
  unsubscribed = 0;
  const live = await upgrade("/ws/logs?repoKey=api-rag");
  live.ws.emit("close");
  check("closing the browser socket unsubscribes (the orphan guard)", () => {
    // logStream tears the child down and issues the remote reap on its LAST
    // unsubscribe, so this close handler is the entire browser-side half of
    // the orphan guard. If it stops firing, sandbox-side kubectl processes
    // accumulate, bounded only by logStream's timeout cap.
    assert.strictEqual(unsubscribed, 1, "the stream was not released when the socket closed");
  });

  // === frame forwarding and socket-level backpressure =====================
  subscribeCalls = [];
  const fwd = await upgrade("/ws/logs?repoKey=api-rag");
  const handlers = subscribeCalls[0].handlers;

  check("line and control frames are forwarded to the socket verbatim", () => {
    handlers.onLine({ t: "line", ts: "2026-08-12T18:27:55.000000000+09:00", text: "hello" });
    handlers.onControl({ t: "reattach", ts: "x", reason: "timeout-cap", gapMs: 0 });
    assert.deepStrictEqual(
      fwd.ws.sent.map((f) => f.t),
      ["line", "reattach"],
      "frames did not reach the socket in order",
    );
    assert.strictEqual(fwd.ws.sent[0].text, "hello");
  });

  check("lines are DROPPED, not queued, behind a client that stopped reading", () => {
    // logStream's rate limit bounds lines per second but not this socket's
    // backlog, so a chatty workload plus one stalled tab is otherwise an
    // unbounded server-side buffer.
    fwd.ws.bufferedAmount = logsRelay.MAX_BUFFERED_BYTES + 1;
    const before = fwd.ws.sent.length;
    for (let i = 0; i < 50; i += 1) handlers.onLine({ t: "line", ts: "x", text: `flood-${i}` });
    const newFrames = fwd.ws.sent.slice(before);
    assert.strictEqual(
      newFrames.filter((f) => f.t === "line").length,
      0,
      "lines were queued behind a backed-up socket instead of dropped",
    );
    assert.strictEqual(
      newFrames.filter((f) => f.t === "throttled").length,
      1,
      "the drop was silent - a pane falling behind must say so",
    );
    assert.ok(newFrames[0].dropped > 0, "throttled frame carried no count");
  });

  check("status and reattach still get through while backpressured", () => {
    // These are rare and are exactly what tells a pane it is dead or
    // recovering. Dropping one is how a pane ends up silently wrong - the
    // failure this whole feature is built to avoid.
    const before = fwd.ws.sent.length;
    handlers.onControl({ t: "status", ts: "x", state: "failed", detail: "tunnel down" });
    const sent = fwd.ws.sent.slice(before);
    assert.strictEqual(sent.length, 1, "a status frame was dropped by the backpressure guard");
    assert.strictEqual(sent[0].state, "failed");
  });

  check("nothing is sent after the socket closes", () => {
    fwd.ws.readyState = 3; // CLOSED
    const before = fwd.ws.sent.length;
    handlers.onLine({ t: "line", ts: "x", text: "after-close" });
    handlers.onControl({ t: "status", ts: "x", state: "live", detail: null });
    assert.strictEqual(fwd.ws.sent.length, before, "wrote to a closed socket");
  });

  // === co-existence with wsRelay =========================================
  const bothAttached = await upgrade("/ws/logs?repoKey=api-rag", { alsoAttachWsRelay: true });
  check("/ws/logs still works with wsRelay attached to the same server", () => {
    // The regression: wsRelay used to destroy every non-/ws socket, so this
    // exact configuration - the production one - could never connect.
    assert.ok(
      bothAttached.accepted,
      "wsRelay destroyed the /ws/logs socket - its foreign-path guard is destroying again instead of returning",
    );
    assert.strictEqual(bothAttached.socket.destroyed, false, "the socket was destroyed by the other relay");
  });

  const foreign = await upgrade("/ws?sessionKey=agent:api-rag-escalation:x");
  check("logsRelay leaves a /ws socket alone rather than destroying it", () => {
    // The reverse direction. If logsRelay ever copies the old destroy-on-
    // foreign-path shape, it breaks the ORIGINAL channel - the live agent
    // transcript - which is a far worse failure than this feature not working.
    assert.strictEqual(foreign.accepted, false, "logsRelay accepted a /ws upgrade that isn't its own");
    assert.strictEqual(foreign.socket.destroyed, false, "logsRelay destroyed another relay's socket");
    assert.strictEqual(foreign.socket.written.length, 0, "logsRelay answered on another relay's path");
  });

  const unclaimed = await upgrade("/ws/something-else");
  check("an unclaimed path is left untouched for server.js's catch-all", () => {
    assert.strictEqual(unclaimed.accepted, false);
    assert.strictEqual(unclaimed.socket.destroyed, false, "a relay refused a path it does not own");
    assert.strictEqual(unclaimed.socket.written.length, 0);
  });

  console.log("");
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("ALL TESTS PASSED");
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
