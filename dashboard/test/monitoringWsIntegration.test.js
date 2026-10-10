// End-to-end WebSocket test for the /ws/logs channel - run directly with
// `node test/monitoringWsIntegration.test.js`. Hermetic: a real http.Server
// on loopback, a real `ws` client, but auth/registry/logStream stubbed, so
// no cookies, no gateway, no sandbox, no cluster.
//
// This exists because monitoringUpgradeAuth.test.js deliberately stubs
// wss.handleUpgrade - it tests whether the GATE lets a request through, and
// faking real sec-websocket-key headers would tell it nothing. That leaves
// two things it structurally cannot cover, both of which are new code:
//
//   1. The actual WebSocket protocol handshake, and whether a frame handed
//      to logStream's subscriber genuinely arrives at a browser.
//   2. upgradeGuard's catch-all. An unclaimed upgrade path has to be
//      REFUSED, not left hanging - and "left hanging" is exactly the failure
//      a stubbed handshake cannot distinguish from success, because nothing
//      ever times out in a stub.
//
// Both relays are attached to one server here, in the same order and with
// the same catch-all call as server.js, because the interaction between them
// is the thing most likely to break: Node runs every "upgrade" listener, and
// wsRelay used to destroy any socket whose path wasn't /ws.
//
// The catch-all is invoked through upgradeGuard.attachCatchAll - the SAME
// function server.js calls, not a copy of it. server.js itself can't be
// required (config.js exits on any machine that isn't Server 6), and an
// earlier draft of this file reimplemented the handler inline, which would
// have passed happily while the real one drifted.

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8791";

const src = (f) => path.join(__dirname, "..", "src", f);

const auth = require(src("auth.js"));
let authenticated = true;
auth.sessionMiddleware = (req, res, next) => {
  req.session = { authenticated };
  req.sessionID = "integration-session";
  next();
};

const registry = require(src("registry.js"));
registry.getRuntimeTarget = (repoKey) =>
  repoKey === "api-rag"
    ? {
        repoKey: "api-rag",
        namespace: "dev",
        labelSelector: "app=svc-rag-dev",
        streamable: true,
        unstreamableReason: null,
      }
    : null;

const logStream = require(src("logStream.js"));
let handlers = null;
let unsubscribed = 0;
logStream.subscribe = (target, h) => {
  handlers = h;
  return () => {
    unsubscribed += 1;
  };
};

const wsRelay = require(src("wsRelay.js"));
const logsRelay = require(src("logsRelay.js"));
const upgradeGuard = require(src("upgradeGuard.js"));
const WebSocket = require(path.join(__dirname, "..", "node_modules", "ws"));

const PORT = 8791;
const base = `ws://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, ok, extra = "") {
  if (ok) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}${extra ? `\n      ${extra}` : ""}`);
  }
}

// Connect and settle into one of three outcomes, rather than assuming
// success. A refused upgrade surfaces through `ws` as an error carrying the
// HTTP status; a hang - the bug the catch-all exists to prevent - surfaces
// as neither, which is why the timeout is a real outcome and not a failure
// of the harness.
function connect(pathAndQuery, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base + pathAndQuery);
    const frames = [];
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      resolve({ outcome, frames, ws });
    };
    ws.on("open", () => done("open"));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.on("error", (err) => done(`error:${err.message}`));
    setTimeout(() => done("hang"), timeoutMs);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = http.createServer((req, res) => res.end("ok"));

  // Exactly server.js's wiring, in exactly its order.
  wsRelay.attach(server);
  logsRelay.attach(server);
  upgradeGuard.attachCatchAll(server, new Set([wsRelay.WS_PATH, logsRelay.WS_PATH]));

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  // === a real client, a real handshake, a real frame =====================
  const live = await connect("/ws/logs?repoKey=api-rag");
  check(
    "a real WebSocket handshake completes on /ws/logs",
    live.outcome === "open",
    `outcome: ${live.outcome}`,
  );

  await sleep(30);
  if (handlers) {
    handlers.onLine({
      t: "line",
      ts: "2026-08-12T18:27:55.069321272+09:00",
      pod: "svc-rag-dev-1",
      container: "rag",
      text: "hello from the cluster",
    });
    handlers.onControl({ t: "reattach", ts: "x", reason: "timeout-cap", gapMs: 0, detail: null });
  }
  await sleep(60);

  check(
    "a line handed to the subscriber reaches the browser socket",
    live.frames.some((f) => f.t === "line" && f.text === "hello from the cluster"),
    JSON.stringify(live.frames),
  );
  check(
    "a control frame reaches it too, unchanged",
    live.frames.some((f) => f.t === "reattach" && f.reason === "timeout-cap"),
    JSON.stringify(live.frames.map((f) => f.t)),
  );

  unsubscribed = 0;
  live.ws.close();
  await sleep(80);
  check("closing the real socket releases the stream", unsubscribed === 1, `unsubscribed=${unsubscribed}`);

  // === the catch-all =====================================================
  const unknown = await connect("/ws/not-a-real-channel");
  check(
    "an unclaimed upgrade path is REFUSED with 404, not left hanging",
    unknown.outcome.startsWith("error:") && /404/.test(unknown.outcome),
    `outcome: ${unknown.outcome} (a "hang" here means the catch-all never ran)`,
  );

  // === the gate, over a real connection ==================================
  const forbidden = await connect("/ws/logs?repoKey=not-registered");
  check(
    "an unregistered repoKey is refused with 403 over a real connection",
    forbidden.outcome.startsWith("error:") && /403/.test(forbidden.outcome),
    `outcome: ${forbidden.outcome}`,
  );

  authenticated = false;
  const unauth = await connect("/ws/logs?repoKey=api-rag");
  authenticated = true;
  check(
    "an unauthenticated client is refused with 401",
    unauth.outcome.startsWith("error:") && /401/.test(unauth.outcome),
    `outcome: ${unauth.outcome}`,
  );

  // === co-existence, with both relays really listening ===================
  const otherChannel = await connect("/ws?sessionKey=agent:api-rag-escalation:nope");
  check(
    "/ws is still handled by wsRelay, not hijacked or destroyed by logsRelay",
    // wsRelay's own ownership gate refuses this made-up key - the point is
    // that IT answered, rather than the socket dying or hanging.
    otherChannel.outcome.startsWith("error:") && !/404/.test(otherChannel.outcome),
    `outcome: ${otherChannel.outcome} (404 would mean the catch-all answered, i.e. wsRelay never claimed its own path)`,
  );

  server.close();
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
