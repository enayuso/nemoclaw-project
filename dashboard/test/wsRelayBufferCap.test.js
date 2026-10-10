// Standalone test for wsRelay.js's per-run event buffer size cap - no
// framework, run directly with `node test/wsRelayBufferCap.test.js` (this
// project has no test runner dependency by deliberate v1 design, see
// README.md).
//
// Proves the fix for a real bug: onGatewayEvent() pushed every gateway
// event onto run.eventBuffer with no size limit at all. A run only gets a
// FRESH buffer when its sessionKey is first seen (getOrCreateRun), so a
// long-lived session (many follow-up turns, tool calls, or a growing
// session.message snapshot re-sent as it grows - see pushSnapshotDiff's
// own comments on how large a single cumulative frame can get) kept
// accumulating in the SAME buffer until the 15-minute idle sweep finally
// deleted it - a purely time-gated, otherwise unbounded memory leak.
//
// This drives the REAL exported attach() entry point and the REAL
// gatewayClient.subscribe() callback path (only the gateway connection
// itself is stubbed - the callback IS the real run.onEvent -> real
// onGatewayEvent, unmodified), rather than reaching into wsRelay.js's
// module-internal `runs` Map directly, so this observes the same behavior
// a real reconnecting browser tab would.
//
// To see this fail against the ORIGINAL (pre-fix) code: `git stash push
// -- src/wsRelay.js`, run this, then `git stash pop`. Expect the second
// tab's replay to include ALL 60 frames (no eviction) instead of a capped
// tail.

const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19997";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8787";

// Same stub-ordering requirement as wsRelayAuth.test.js: wsRelay.js
// destructures `const { sessionMiddleware } = require("./auth")` at ITS
// OWN require-time, so every stub below must be set immediately after its
// own module's require() and before wsRelay.js is required for the first
// time.
const auth = require(path.join(__dirname, "..", "src", "auth.js"));
auth.sessionMiddleware = (req, res, next) => {
  req.session = { authenticated: true };
  req.sessionID = "test-session-id";
  next();
};

let capturedOnEvent = null;
const gatewayClient = require(path.join(__dirname, "..", "src", "gatewayClient.js"));
gatewayClient.connected = true;
gatewayClient.listAgentSessions = async () => [];
gatewayClient.subscribe = async (sessionKey, onEvent) => {
  capturedOnEvent = onEvent; // the real run.onEvent -> real onGatewayEvent
};
gatewayClient.unsubscribe = () => {};

const registry = require(path.join(__dirname, "..", "src", "registry.js"));
registry.listRepos = () => [];

const remoteSessions = require(path.join(__dirname, "..", "src", "remoteSessions.js"));
remoteSessions.listForRegisteredRepos = async () => [];

const sessionIndex = require(path.join(__dirname, "..", "src", "sessionIndex.js"));
const wsRelay = require(path.join(__dirname, "..", "src", "wsRelay.js"));

const SESSION_KEY = "agent:api-rag-escalation:dashboard-buffer-cap-test";
sessionIndex.record({ sessionKey: SESSION_KEY, repoKey: "api-rag", message: "test" });

function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.write = (data) => socket.written.push(data);
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.readyState = 1;
  ws.OPEN = 1;
  return ws;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

async function connectTab(wss, fakeServer, skipReplay) {
  let upgraded = null;
  wss.handleUpgrade = (req, socket, head, cb) => {
    const ws = fakeWs();
    upgraded = ws;
    cb(ws);
  };
  const url = `/ws?sessionKey=${encodeURIComponent(SESSION_KEY)}${skipReplay ? "&skipReplay=1" : ""}`;
  const req = { url };
  const socket = fakeSocket();
  fakeServer.emit("upgrade", req, socket, Buffer.alloc(0));
  await flush();
  return upgraded;
}

// ~100KB per frame (padded text field) so a realistic frame count clearly
// crosses the 5MB cap without needing thousands of iterations.
function bigFrame(seq) {
  return {
    type: "event",
    event: "agent",
    payload: { stream: "text", data: { seq, text: "x".repeat(100_000) } },
  };
}

async function main() {
  const fakeServer = new EventEmitter();
  const wss = wsRelay.attach(fakeServer);

  // First tab connects BEFORE any events - establishes the subscription
  // (capturedOnEvent) and will observe every frame LIVE, regardless of
  // what the replay buffer later evicts.
  const tab1 = await connectTab(wss, fakeServer, false);
  assert.ok(capturedOnEvent, "subscribe should have captured the real onEvent callback");

  const FRAME_COUNT = 60; // ~6MB total, clearly over the 5MB cap
  for (let seq = 0; seq < FRAME_COUNT; seq++) {
    capturedOnEvent(bigFrame(seq));
  }

  assert.strictEqual(
    tab1.sent.length,
    FRAME_COUNT,
    `tab connected before the flood should receive every frame LIVE regardless of buffer eviction, got ${tab1.sent.length}`,
  );
  console.log("PASS: an already-connected tab receives every live event, unaffected by buffer eviction");

  // Second tab connects AFTER the flood - its replay comes entirely from
  // the (now-capped) eventBuffer.
  const tab2 = await connectTab(wss, fakeServer, false);

  assert.ok(
    tab2.sent.length > 0 && tab2.sent.length < FRAME_COUNT,
    `expected the capped buffer to replay SOME but not ALL ${FRAME_COUNT} frames to a late-joining tab, got ${tab2.sent.length}`,
  );
  console.log(`PASS: late-joining tab's replay was capped (${tab2.sent.length} of ${FRAME_COUNT} frames retained)`);

  const firstReplayedSeq = tab2.sent[0].payload.data.seq;
  const lastReplayedSeq = tab2.sent[tab2.sent.length - 1].payload.data.seq;
  assert.ok(
    firstReplayedSeq > 0,
    `the oldest frames should have been evicted (first replayed seq should be > 0), got seq ${firstReplayedSeq}`,
  );
  assert.strictEqual(
    lastReplayedSeq,
    FRAME_COUNT - 1,
    "the MOST RECENT frame must always survive eviction",
  );
  console.log(
    `PASS: eviction is oldest-first - replay starts at seq ${firstReplayedSeq}, ends at the most recent seq ${lastReplayedSeq}`,
  );

  const totalReplayedBytes = tab2.sent.reduce((sum, f) => sum + JSON.stringify(f).length, 0);
  assert.ok(
    totalReplayedBytes < 6 * 1024 * 1024,
    `replayed content should stay close to the 5MB cap, got ${totalReplayedBytes} bytes`,
  );
  console.log(`PASS: total replayed byte volume (${totalReplayedBytes} bytes) stays bounded near the 5MB cap`);

  sessionIndex.remove(SESSION_KEY);
  console.log("\nALL TESTS PASSED");
}

main().catch((err) => {
  sessionIndex.remove(SESSION_KEY);
  console.error("FAIL:", err.message);
  process.exit(1);
});
