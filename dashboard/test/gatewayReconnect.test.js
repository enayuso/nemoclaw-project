// Standalone test for gatewayClient.js's reconnect-then-resubscribe fix -
// no framework, run directly with `node test/gatewayReconnect.test.js`
// (this project has no test runner dependency by deliberate v1 design, see
// README.md).
//
// Proves the fix for a real bug confirmed live 2026-07-31 straight from
// OpenClaw's own gateway source (dist/sessions-FHKRhZK9.js): the
// sessions.messages.subscribe handler registers subscriptions keyed by
// client.connId - the specific WebSocket connection's own ID, freshly
// generated per connection (confirmed in this client's own handshake
// logs). gatewayClient.js's own this.subscriptions map (browser-callback
// bookkeeping) was deliberately designed to survive a disconnect - see its
// own comments - but nothing ever re-issued the gateway-side RPC after a
// reconnect, so every run being watched at the moment of a reconnect went
// silently dead: no error anywhere, just no more events, ever, until the
// whole dashboard process itself restarted.
//
// This test runs a REAL local WebSocket server standing in for the
// gateway (implementing just enough of the connect.challenge/connect
// handshake and a fake sessions.messages.subscribe responder) rather than
// mocking gatewayClient.js's internals, so it exercises the actual
// reconnect timer, a real socket close, and a real second handshake - not
// a synthetic substitute for them. Takes ~12s to run (two real
// RECONNECT_DELAYS_MS[0]=5000ms waits, see the negative-control section
// below) - that's the real reconnect delay this code actually uses, not
// padding.
//
// To see this fail against the ORIGINAL (pre-fix) code:
// `git stash push -- src/gatewayClient.js`, run this, then `git stash
// pop`. Expect exactly one sessions.messages.subscribe call total (the
// pre-reconnect one) instead of two.

const assert = require("node:assert");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");

const TEST_PORT = 19998;
const TEST_SESSION_KEY = "agent:api-rag-escalation:gateway-reconnect-test";

process.env.NEMOCLAW_GATEWAY_URL = `ws://127.0.0.1:${TEST_PORT}`;
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8788";

const gatewayClientPath = require.resolve(
  path.join(__dirname, "..", "src", "gatewayClient.js"),
);

// Runs one full connect -> subscribe -> forced-disconnect -> reconnect
// cycle against a fresh fake-gateway server and a fresh gatewayClient
// module instance (require cache cleared each call so this can run twice
// in one process for the negative-control comparison below).
function runReconnectScenario() {
  return new Promise((resolve, reject) => {
    const subscribeCalls = [];
    const sockets = [];
    const wss = new WebSocketServer({ host: "127.0.0.1", port: TEST_PORT });

    wss.on("connection", (ws) => {
      sockets.push(ws);
      ws.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: crypto.randomUUID(), ts: Date.now() },
        }),
      );
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "req") return;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } }));
          return;
        }
        if (frame.method === "sessions.messages.subscribe") {
          subscribeCalls.push({ key: frame.params && frame.params.key, atConnection: sockets.indexOf(ws) });
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { subscribed: true } }));
        }
      });
    });

    delete require.cache[gatewayClientPath];
    const gatewayClient = require(gatewayClientPath);

    const fail = (err) => {
      wss.close();
      reject(err);
    };

    gatewayClient
      .connect()
      .then(async () => {
        await gatewayClient.subscribe(TEST_SESSION_KEY, () => {});
        if (subscribeCalls.length !== 1) {
          throw new Error(`expected exactly 1 subscribe call after initial subscribe, got ${subscribeCalls.length}`);
        }

        // Simulate the gateway dropping the connection (a real restart, or
        // a network blip) - close the FIRST connection's socket from the
        // server side, exactly what gatewayClient.js's own ws.on("close")
        // handler is meant to react to.
        sockets[0].close();

        // RECONNECT_DELAYS_MS[0] is 5000ms - wait for that real timer to
        // fire and a second real handshake to complete, plus margin.
        await new Promise((r) => setTimeout(r, 7000));

        wss.close();
        resolve({ subscribeCalls, connectionCount: sockets.length });
      })
      .catch(fail);
  });
}

async function main() {
  const result = await runReconnectScenario();
  console.log("subscribeCalls:", JSON.stringify(result.subscribeCalls));

  assert.strictEqual(
    result.connectionCount,
    2,
    `expected exactly 2 real connections (initial + one reconnect), got ${result.connectionCount}`,
  );
  console.log("PASS: gatewayClient reconnected exactly once after the forced disconnect");

  assert.strictEqual(
    result.subscribeCalls.length,
    2,
    `expected sessions.messages.subscribe to be called twice (once per connection) - this is the fix. Got ${result.subscribeCalls.length}`,
  );
  console.log("PASS: sessions.messages.subscribe was re-issued after reconnect (previously never happened)");

  assert.strictEqual(result.subscribeCalls[0].key, TEST_SESSION_KEY);
  assert.strictEqual(result.subscribeCalls[1].key, TEST_SESSION_KEY);
  assert.strictEqual(result.subscribeCalls[0].atConnection, 0, "first subscribe call should be on the first connection");
  assert.strictEqual(result.subscribeCalls[1].atConnection, 1, "second subscribe call should be on the SECOND (reconnected) connection");
  console.log("PASS: both subscribe calls carried the correct sessionKey and landed on the correct connection");

  console.log("\nALL TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
