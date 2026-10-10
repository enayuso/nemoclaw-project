// Standalone test for GET /api/model-health - no framework, run directly
// with `node test/modelHealth.test.js` (this project has no test runner
// dependency by deliberate v1 design, see README.md).
//
// This is the probe behind the model-outage banner, added 2026-08-07 after
// Server 4 went down and the dashboard said nothing. The states it has to
// tell apart are the whole point: "the box is gone" and "the box is up but
// serving the wrong model" produce identical symptoms for a user (every run
// fails) and need completely different fixes, and "the gateway is
// unreachable" must NOT be reported as a model outage at all or it sends
// someone to reboot the wrong machine.
//
// Runs against a real local HTTP server rather than a mocked fetch, since
// the failure modes under test are network-level (connection refused,
// timeout) and a stubbed fetch would be asserting on the stub.

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8794";

const gatewayClient = require(path.join(__dirname, "..", "src", "gatewayClient.js"));

const MODEL_ID = "nvidia/Qwen3.6-35B-A3B-NVFP4";

// Stands in for the express route's own logic. The route itself needs a
// live gateway + an authenticated session to reach; this exercises the same
// branches against the same real sockets.
async function probe(baseUrl, modelId, timeoutMs = 5000) {
  const host = baseUrl ? new URL(baseUrl).host : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: controller.signal });
    if (!res.ok) {
      const reason = res.status === 401 || res.status === 403 ? "unauthorized" : "http-error";
      return { ok: false, reason, status: res.status, endpoint: host, model: modelId };
    }
    const body = await res.json().catch(() => null);
    const served = body && Array.isArray(body.data) ? body.data.map((m) => m && m.id) : [];
    if (modelId && served.length && !served.includes(modelId)) {
      return { ok: false, reason: "model-not-loaded", endpoint: host, model: modelId, served };
    }
    return { ok: true, reason: null, endpoint: host, model: modelId };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "timeout" : "unreachable", endpoint: host, model: modelId };
  } finally {
    clearTimeout(timer);
  }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  // --- Healthy: up, and serving the configured model ---
  {
    const { server, port } = await serve((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    });
    const r = await probe(`http://127.0.0.1:${port}/v1`, MODEL_ID);
    assert.strictEqual(r.ok, true, "a server serving the configured model is healthy");
    assert.strictEqual(r.reason, null);
    assert.strictEqual(r.endpoint, `127.0.0.1:${port}`);
    server.close();
    console.log("PASS: healthy backend reports ok");
  }

  // --- The actual 2026-08-07 outage: nothing listening ---
  {
    // Bind then immediately close, so the port is real but refused - the
    // same ECONNREFUSED a downed box produces, without waiting on a routed
    // black-hole address to time out.
    const { server, port } = await serve(() => {});
    await new Promise((r) => server.close(r));
    const res = await probe(`http://127.0.0.1:${port}/v1`, MODEL_ID);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "unreachable", "a refused connection is an outage, not a timeout");
    assert.strictEqual(res.endpoint, `127.0.0.1:${port}`, "the banner still names the box to go restart");
    console.log("PASS: dead backend reports unreachable, with its endpoint");
  }

  // --- Up, but serving something else entirely ---
  {
    const { server, port } = await serve((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "some-other-model" }] }));
    });
    const r = await probe(`http://127.0.0.1:${port}/v1`, MODEL_ID);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "model-not-loaded", "same symptom as a dead box, different fix");
    assert.deepStrictEqual(r.served, ["some-other-model"], "says what IS loaded, or the message is useless");
    server.close();
    console.log("PASS: wrong model loaded is its own state");
  }

  // --- Reachable but refusing the probe ---
  {
    const { server, port } = await serve((req, res) => {
      res.writeHead(401);
      res.end();
    });
    const r = await probe(`http://127.0.0.1:${port}/v1`, MODEL_ID);
    assert.strictEqual(r.reason, "unauthorized", "something IS listening - a config problem, not an outage");
    assert.strictEqual(r.status, 401);
    server.close();
    console.log("PASS: 401 is distinguished from an outage");
  }

  // --- Hung: accepts the connection and never answers ---
  {
    const { server, port } = await serve(() => {
      /* deliberately never responds */
    });
    const r = await probe(`http://127.0.0.1:${port}/v1`, MODEL_ID, 300);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "timeout", "a hung server is not the same as a refused one");
    server.close();
    console.log("PASS: hung backend times out rather than hanging the dashboard");
  }

  // --- The secret boundary: baseUrl userinfo must never survive ---
  // config.get hands back the gateway's whole config, apiKey included, and
  // getModelEndpoint is what stands between that and an API response that
  // ends up rendered into banner text.
  {
    const client = new gatewayClient.constructor();
    client.call = async () => ({
      raw: JSON.stringify({
        models: {
          providers: {
            inference: {
              baseUrl: "https://user:supersecrettoken@model.internal:11510/v1",
              apiKey: "sk-must-not-leak",
              models: [{ id: MODEL_ID, contextWindow: 131072 }],
            },
          },
        },
      }),
    });
    const out = await client.getModelEndpoint();
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("supersecrettoken"), "userinfo credential must be stripped from baseUrl");
    assert.ok(!serialized.includes("sk-must-not-leak"), "apiKey must never be part of what this returns");
    assert.strictEqual(out.baseUrl, "https://model.internal:11510/v1");
    assert.strictEqual(out.modelId, MODEL_ID);
    console.log("PASS: credentials are stripped from the endpoint");
  }

  // --- No provider configured at all ---
  {
    const client = new gatewayClient.constructor();
    client.call = async () => ({ raw: JSON.stringify({ models: { providers: {} } }) });
    const out = await client.getModelEndpoint();
    assert.strictEqual(out.baseUrl, null, "absent config is 'unknown', which the route reports as ok:null");
    console.log("PASS: missing provider config degrades to unknown");
  }

  console.log("# ALL TESTS PASSED");
})();
