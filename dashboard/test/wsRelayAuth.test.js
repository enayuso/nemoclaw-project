// Standalone test for wsRelay.js's /ws upgrade auth gate - no framework,
// run directly with `node test/wsRelayAuth.test.js` (this project has no
// test runner dependency by deliberate v1 design, see README.md).
//
// Proves the fix for a real bug confirmed live 2026-07-30: the upgrade
// gate only ever checked sessionIndex.exists() (locally-recorded/
// dashboard-origin sessions). getMergedSessions() has surfaced gateway-
// discovered sessions (cross-repo xref, reviewer) in Recents since
// 2026-07-29, but the live-socket gate was never updated to match - opening
// a still-running one of those from Recents silently 403'd the /ws upgrade,
// showing only frozen chat.history replay with no error surfaced anywhere.
//
// Fix: wsRelay.js now calls routes/sessions.js's own resolveSessionEntry()
// (local index OR gateway-confirmed membership in a registered repo's own
// agent roster) instead of sessionIndex.exists() alone - the same check
// GET /api/sessions/history already used, so both call sites agree on what
// "this dashboard knows about this session" means.
//
// This test exercises the REAL upgrade handler wsRelay.attach() installs
// on the "upgrade" event (unlike wsRelay.test.js, which deliberately
// bypasses that layer and drives wss.emit("connection", ...) directly -
// this file exists specifically to cover the layer that one skips).
// sessionMiddleware, gatewayClient, and registry are stubbed - no real
// cookies or live gateway needed. wss.handleUpgrade is stubbed past the
// real WebSocket protocol handshake (needs real sec-websocket-key headers
// this test has no reason to fake) - this only cares whether the
// ownership gate lets a request through AT ALL, not the handshake itself.
//
// To see this fail against the ORIGINAL (pre-fix) code:
// `git stash push -- src/wsRelay.js src/routes/sessions.js`, run this,
// then `git stash pop`. Expect test 2 (gateway-origin session) to fail
// with a 403 instead of being accepted.

const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8789";

// Order matters here: wsRelay.js destructures `const { sessionMiddleware }
// = require("./auth")` at ITS OWN require-time, capturing whatever
// auth.sessionMiddleware IS at that exact moment - a later reassignment of
// the property wouldn't reach wsRelay's already-captured local const. Every
// stub below is set immediately after its module is required and BEFORE
// wsRelay.js is required for the first time, so wsRelay's own internal
// require("./auth")/require("./routes/sessions") calls return the
// already-stubbed objects.
const auth = require(path.join(__dirname, "..", "src", "auth.js"));
let authenticated = true;
auth.sessionMiddleware = (req, res, next) => {
  req.session = { authenticated };
  req.sessionID = "test-session-id";
  next();
};

const gatewayClient = require(path.join(__dirname, "..", "src", "gatewayClient.js"));
gatewayClient.connected = true;
// resolveSessionEntry() calls sessions.describe (a direct single-key
// lookup) rather than listAgentSessions (a full-list fetch + scan) as of
// 2026-07-31 - see routes/sessions.js's own comment on that change. Stub
// the shape sessions.describe actually returns: { session: null } for an
// unknown key, a truthy session object for a known one.
gatewayClient.call = async (method, params) => {
  assert.strictEqual(method, "sessions.describe", `resolveSessionEntry should call sessions.describe, got ${method}`);
  const known = params.key === "agent:svc-docs-escalation:xref-1";
  return { session: known ? { key: params.key } : null };
};

const registry = require(path.join(__dirname, "..", "src", "registry.js"));
registry.listRepos = () => [
  { repoKey: "svc-docs", escalationAgent: "svc-docs-escalation", reviewerAgent: "svc-docs-reviewer" },
];

// getMergedSessions() (used by DELETE /api/sessions/all, not exercised by
// this test) also calls this - stub it so requiring routes/sessions.js
// never touches a real gateway even indirectly.
const remoteSessions = require(path.join(__dirname, "..", "src", "remoteSessions.js"));
remoteSessions.listForRegisteredRepos = async () => [];

const sessionIndex = require(path.join(__dirname, "..", "src", "sessionIndex.js"));
const wsRelay = require(path.join(__dirname, "..", "src", "wsRelay.js"));

const LOCAL_KEY = "agent:api-rag-escalation:dashboard-wsrelay-auth-test";
sessionIndex.record({ sessionKey: LOCAL_KEY, repoKey: "api-rag", message: "test" });

function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.write = (data) => socket.written.push(data);
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

async function testUpgrade(sessionKey) {
  const fakeServer = new EventEmitter();
  const wss = wsRelay.attach(fakeServer);
  let upgraded = false;
  wss.handleUpgrade = (req, socket, head, cb) => {
    upgraded = true;
    const fakeWs = new EventEmitter();
    fakeWs.send = () => {};
    fakeWs.readyState = 1;
    fakeWs.OPEN = 1;
    cb(fakeWs);
  };
  const req = { url: `/ws?sessionKey=${encodeURIComponent(sessionKey)}` };
  const socket = fakeSocket();
  fakeServer.emit("upgrade", req, socket, Buffer.alloc(0));
  await flush();
  if (upgraded) return "accepted";
  return socket.written[0] ? socket.written[0].split(" ")[1] : "no-response";
}

async function main() {
  const local = await testUpgrade(LOCAL_KEY);
  assert.strictEqual(local, "accepted", `local (dashboard-origin) session should be accepted, got ${local}`);
  console.log("PASS: local (dashboard-origin) session accepted");

  const gatewayOrigin = await testUpgrade("agent:svc-docs-escalation:xref-1");
  assert.strictEqual(gatewayOrigin, "accepted", `gateway-origin session should be accepted (this is the fix), got ${gatewayOrigin}`);
  console.log("PASS: gateway-origin session accepted (previously always 403'd)");

  const unknown = await testUpgrade("agent:svc-docs-escalation:totally-made-up-key");
  assert.strictEqual(unknown, "403", `genuinely unknown session must still be rejected, got ${unknown}`);
  console.log("PASS: genuinely unknown session still rejected with 403 (security boundary intact)");

  authenticated = false;
  const unauth = await testUpgrade(LOCAL_KEY);
  assert.strictEqual(unauth, "401", `unauthenticated request must still be rejected regardless of sessionKey validity, got ${unauth}`);
  authenticated = true;
  console.log("PASS: unauthenticated request still rejected with 401 regardless of sessionKey validity");

  sessionIndex.remove(LOCAL_KEY);
  console.log("\nALL TESTS PASSED");
}

main().catch((err) => {
  sessionIndex.remove(LOCAL_KEY);
  console.error("FAIL:", err.message);
  process.exit(1);
});
