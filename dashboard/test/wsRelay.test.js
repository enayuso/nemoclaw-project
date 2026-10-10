// Standalone integration test for wsRelay.js/gatewayClient.js's per-run
// event fan-out - no framework, run directly with `node test/wsRelay.test.js`
// (this project has no test runner dependency by deliberate v1 design, see
// README.md).
//
// Proves the fix for two real bugs confirmed live 2026-07-24 ("why did it
// replied 3 times?" / "the final responses is being streamed again when it
// shouldn't"):
//   1. A run watched across multiple connections (multiple tabs, or one tab
//      reconnecting) no longer fans out duplicated events. Before the fix,
//      wsRelay.js created a brand-new onEvent closure per connection and
//      added each one to gatewayClient's subscriptions Set as a genuinely
//      distinct entry - a run watched across N connections had every real
//      gateway event delivered N times over.
//   2. skipEventReplay actually suppresses the buffered-history replay -
//      before the fix, every new connection to an existing sessionKey got
//      the FULL event buffer blasted at it unconditionally, re-animating
//      already-finished content through the client's reveal-queue
//      typewriter effect on every revisit.
//
// Bypasses the real HTTP upgrade/auth layer by driving
// wss.emit("connection", ...) directly - that's the exact point
// wsRelay.js's own upgrade handler calls it from, so this exercises the
// real connection-handling logic, just without a real HTTP round-trip. No
// live gateway needed: gatewayClient.call/.connected are stubbed.
//
// To see this fail against the ORIGINAL (pre-fix) code: `git stash push --
// src/wsRelay.js src/gatewayClient.js`, run this, then `git stash pop`.
// Confirmed 2026-07-24: test 1 fails with "wsA1 should receive the chat
// event exactly once, got 2" against the unfixed code.

const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// config.js fails fast if these are missing - not reading a real .env file
// for this standalone test, just satisfying the required-vars check.
process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8788";

const gatewayClient = require(path.join(__dirname, "..", "src", "gatewayClient.js"));
const wsRelay = require(path.join(__dirname, "..", "src", "wsRelay.js"));

gatewayClient.connected = true;
let rpcCallCount = 0;
gatewayClient.call = async () => {
  rpcCallCount++;
  return {};
};

function makeFakeWs() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.readyState = 1;
  ws.OPEN = 1;
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  return ws;
}

const fakeServer = new EventEmitter();
const wss = wsRelay.attach(fakeServer);

const flush = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  // --- Test 1: two tabs on the SAME session must not duplicate events ---
  const wsA1 = makeFakeWs();
  const wsA2 = makeFakeWs();
  wss.emit("connection", wsA1, {}, "session-A", false);
  await flush();
  wss.emit("connection", wsA2, {}, "session-A", false);
  await flush();

  assert.strictEqual(rpcCallCount, 1, `expected exactly 1 sessions.messages.subscribe RPC call for session-A, got ${rpcCallCount}`);

  // Simulate ONE real gateway event arriving for session-A.
  gatewayClient._dispatch({
    type: "event",
    event: "chat",
    payload: { sessionKey: "session-A", deltaText: "hello" },
  });

  const chatFramesA1 = wsA1.sent.filter((f) => f.event === "chat");
  const chatFramesA2 = wsA2.sent.filter((f) => f.event === "chat");
  assert.strictEqual(chatFramesA1.length, 1, `wsA1 should receive the chat event exactly once, got ${chatFramesA1.length}`);
  assert.strictEqual(chatFramesA2.length, 1, `wsA2 should receive the chat event exactly once, got ${chatFramesA2.length}`);
  console.log("PASS: two tabs on the same session each receive one gateway event exactly once (no fan-out duplication)");

  // --- Test 2: a THIRD tab joining the SAME still-open session (no
  // skipEventReplay) should catch up via the buffered history - the
  // original, still-desired "mid-run page refresh / late tab" behavior. ---
  const wsA3 = makeFakeWs();
  wss.emit("connection", wsA3, {}, "session-A", false);
  await flush();
  const replayedToA3 = wsA3.sent.filter((f) => f.event === "chat");
  assert.strictEqual(replayedToA3.length, 1, `late-joining tab (no skipEventReplay) should be caught up with the 1 buffered event, got ${replayedToA3.length}`);
  console.log("PASS: a late-joining tab without skipEventReplay is caught up via the event buffer (still-active-run behavior preserved)");

  assert.strictEqual(rpcCallCount, 1, `subscribing a 3rd tab to the SAME session must not re-call the RPC, got ${rpcCallCount} total calls`);
  console.log("PASS: a 3rd tab on the same session does not re-trigger the gateway subscribe RPC");

  // --- Test 3: closing tabs one at a time must not unsubscribe until the
  // LAST one disconnects. ---
  wsA1.emit("close");
  await flush();
  gatewayClient._dispatch({
    type: "event",
    event: "chat",
    payload: { sessionKey: "session-A", deltaText: " world" },
  });
  const stillGetsEventsA2 = wsA2.sent.filter((f) => f.event === "chat" && f.payload.deltaText === " world");
  assert.strictEqual(stillGetsEventsA2.length, 1, "remaining tab (wsA2) should still receive events after a DIFFERENT tab (wsA1) closes");
  console.log("PASS: closing one tab does not cut off other tabs still watching the same run");

  // --- Test 4: skipEventReplay=true must suppress the buffer replay for a
  // DIFFERENT session that already has buffered content (simulating
  // openHistoricalSession reopening a live socket after already doing its
  // own chat.history-based static replay). ---
  const wsB1 = makeFakeWs();
  wss.emit("connection", wsB1, {}, "session-B", false);
  await flush();
  gatewayClient._dispatch({
    type: "event",
    event: "chat",
    payload: { sessionKey: "session-B", deltaText: "first turn, already finished" },
  });
  wsB1.emit("close");
  await flush();

  // A revisit: skipEventReplay=true this time.
  const wsB2 = makeFakeWs();
  wss.emit("connection", wsB2, {}, "session-B", true);
  await flush();
  const replayedToB2 = wsB2.sent.filter((f) => f.event === "chat");
  assert.strictEqual(replayedToB2.length, 0, `skipEventReplay=true must suppress the buffer replay, but wsB2 received ${replayedToB2.length} replayed chat frame(s)`);
  console.log("PASS: skipEventReplay=true suppresses replay of already-finished content (fixes 're-streams on revisit')");

  console.log("\nALL TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("TEST FAILED:", err.message);
  process.exit(1);
});
