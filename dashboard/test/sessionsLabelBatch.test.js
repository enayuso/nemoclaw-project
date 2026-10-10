// Standalone test for routes/sessions.js's getMergedSessions() batched
// remote-session labeling - no framework, run directly with
// `node test/sessionsLabelBatch.test.js` (this project has no test runner
// dependency by deliberate v1 design, see README.md).
//
// Proves the fix for a real bug found live 2026-07-31: the prior session's
// work-in-progress renamed the per-entry labelFromFirstMessage(sessionKey)
// helper to a batched labelsFromRecentMessages(sessionKeys) (one
// sessions.preview RPC call for up to 64 keys, instead of one chat.history
// call per entry), but getMergedSessions() itself was left mid-edit still
// calling the OLD name with the OLD (single-key) signature - a plain
// ReferenceError on every GET /api/sessions request that had at least one
// newly-discovered remote session to label, since labelFromFirstMessage no
// longer exists as a standalone function.
//
// This test exercises the REAL getMergedSessions() entry point (not the
// label helper in isolation) precisely because the bug was in how the two
// were wired together, not inside either function's own logic -
// gatewayClient.call, sessionIndex, and remoteSessions are stubbed; no
// real gateway or local session storage needed.
//
// To see this fail against the ORIGINAL (pre-fix) code:
// `git stash push -- src/routes/sessions.js src/remoteSessions.js`, run
// this, then `git stash pop`. Expect a thrown "labelFromFirstMessage is
// not defined" ReferenceError instead of the assertions below passing.

const assert = require("node:assert");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8790";

// Same require-then-stub-before-first-use ordering wsRelayAuth.test.js
// documents: routes/sessions.js does `const gatewayClient =
// require("../gatewayClient")` (a whole-module reference, never
// destructured), so stubbing the .call property on the already-required
// singleton is visible to sessions.js's own copy of the reference.
const gatewayClient = require(path.join(__dirname, "..", "src", "gatewayClient.js"));
const sessionIndex = require(path.join(__dirname, "..", "src", "sessionIndex.js"));
const remoteSessions = require(path.join(__dirname, "..", "src", "remoteSessions.js"));

const LOCAL_KEY = "agent:api-rag-escalation:local-session-1";
const REMOTE_KEY_A = "agent:api-rag-escalation:xref-from-svc-core";
const REMOTE_KEY_B = "agent:api-rag-reviewer:reviewer-session-b";

sessionIndex.list = () => [
  { sessionKey: LOCAL_KEY, repoKey: "api-rag", label: "a real dashboard-recorded label", updatedAt: 500 },
];
sessionIndex.isHidden = () => false;

remoteSessions.listForRegisteredRepos = async () => [
  // Collides with the local entry above - must NOT appear twice in the
  // merged result, and must never reach the labeling call at all.
  { sessionKey: LOCAL_KEY, repoKey: "api-rag", updatedAt: 500, agentRole: "escalation" },
  { sessionKey: REMOTE_KEY_A, repoKey: "api-rag", updatedAt: 300, agentRole: "escalation" },
  { sessionKey: REMOTE_KEY_B, repoKey: "api-rag", updatedAt: 200, agentRole: "reviewer" },
];

let callCount = 0;
let lastCallArgs = null;
gatewayClient.call = async (method, params) => {
  callCount += 1;
  lastCallArgs = { method, params };
  assert.strictEqual(method, "sessions.preview", "getMergedSessions must label via sessions.preview");
  return {
    ts: 1,
    previews: [
      {
        key: REMOTE_KEY_A,
        status: "ok",
        // Trailing tool-role item (raw JSON, not prose) must be skipped in
        // favor of the last real user/assistant message underneath it -
        // replicating chat.history's old content-type filtering, by role
        // instead since sessions.preview has no content-type field.
        items: [
          { role: "user", text: "the real conversation opener" },
          { role: "tool", text: '{"raw":"tool call json"}' },
        ],
      },
      // status "missing" (never actually reached the gateway, or genuinely
      // has no messages yet) - must fall back to the sessionKey suffix,
      // not throw or produce an empty label.
      { key: REMOTE_KEY_B, status: "missing", items: [] },
    ],
  };
};

const sessionsRouter = require(path.join(__dirname, "..", "src", "routes", "sessions.js"));
const { getMergedSessions } = sessionsRouter;

(async () => {
  const merged = await getMergedSessions();

  // --- Batching: exactly ONE sessions.preview call for the whole batch,
  // not one per newly-discovered remote session. ---
  assert.strictEqual(callCount, 1, `expected exactly 1 batched sessions.preview call, got ${callCount}`);
  assert.deepStrictEqual(
    lastCallArgs.params.keys,
    [REMOTE_KEY_A, REMOTE_KEY_B],
    "batch call must include only the genuinely-new remote keys, in filter order, excluding the local-collision key",
  );
  console.log("PASS: labeling happens via exactly one batched sessions.preview call, correct key set");

  // --- No duplication on sessionKey collision - local entry wins, appears
  // once. ---
  const localMatches = merged.filter((e) => e.sessionKey === LOCAL_KEY);
  assert.strictEqual(localMatches.length, 1, "the colliding sessionKey must appear exactly once");
  assert.strictEqual(localMatches[0].origin, "dashboard", "on collision, the local (dashboard-origin) entry wins");
  assert.strictEqual(localMatches[0].label, "a real dashboard-recorded label");
  console.log("PASS: local entry wins on sessionKey collision, no duplication");

  // --- Real label extraction: last non-"tool" item's text, not the
  // trailing tool-role JSON. ---
  const entryA = merged.find((e) => e.sessionKey === REMOTE_KEY_A);
  assert.ok(entryA, "remote entry A must be present in the merged list");
  assert.strictEqual(entryA.label, "the real conversation opener");
  assert.strictEqual(entryA.origin, "gateway");
  assert.strictEqual(entryA.agentRole, "escalation", "agentRole must be propagated from remoteSessions.js's tagging");
  console.log("PASS: label picks the last non-tool item's text, skipping trailing tool-role JSON");

  // --- Fallback: a "missing" status preview falls back to the sessionKey
  // suffix rather than crashing or leaving an empty label. ---
  const entryB = merged.find((e) => e.sessionKey === REMOTE_KEY_B);
  assert.ok(entryB, "remote entry B must be present in the merged list");
  assert.strictEqual(entryB.label, "reviewer-session-b", "a missing-status preview must fall back to the key suffix");
  assert.strictEqual(entryB.agentRole, "reviewer");
  console.log("PASS: a missing-status preview falls back to the sessionKey suffix, not a crash or empty label");

  console.log("\nALL TESTS PASSED");
})().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
