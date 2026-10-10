// Standalone test for app.js's pruneResolvedPendingDecisions() - no framework,
// run directly with `node test/pendingDecisionPrune.test.js` (this project has
// no test runner dependency by deliberate v1 design, see README.md).
//
// app.js is a browser script with no module exports and it touches `document`
// on its first lines, so the function is read as TEXT and evaluated in
// isolation - same approach as test/opsDecisionSpecs.test.js.
//
// WHY THIS EXISTS. pendingDecisions entries were only ever deleted from inside
// pendingDecisionFor(fix), which runs while rendering an EXISTING fix. Remove
// the tracker entry outright - Close out, Stage 6 cleanup, a denied fix tidied
// up - and the entry became unreachable: no render, so no delete, and its
// 10-minute TTL never fired either because that check lived in the same
// unreachable place. pendingDecisions.size stayed >0 forever, so the 5-second
// pending-decision poll never cleared and refetched the Ops panel for the rest
// of the session. Reported as the Operations tab flickering indefinitely after
// Close out, surviving a tab switch, and only stopping on reload.
//
// The failure mode is a LEAK, so the test that matters is the one asserting an
// entry goes away. The others exist because the obvious fix - "prune anything
// not currently on screen" - re-opens the double-click hole that pendingDecisions
// was added to close.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function extract(re, label) {
  const m = appSrc.match(re);
  assert.ok(m, `could not find ${label} in app.js - did it get renamed?`);
  return m[0];
}

const ttlSrc = extract(/const PENDING_DECISION_TTL_MS = [^;]+;/, "PENDING_DECISION_TTL_MS");
const graceSrc = extract(/const PENDING_DECISION_ABSENT_GRACE_MS = [^;]+;/, "PENDING_DECISION_ABSENT_GRACE_MS");
const fnSrc = extract(/function pruneResolvedPendingDecisions\(\) \{[\s\S]*?\n\}/, "pruneResolvedPendingDecisions");

// Run the real function against a supplied map + loaded-key set.
const runPrune = new Function(
  "__pending",
  "__keys",
  `${ttlSrc}
   ${graceSrc}
   const pendingDecisions = __pending;
   const lastLoadedFixSessionKeys = __keys;
   ${fnSrc}
   pruneResolvedPendingDecisions();
   return pendingDecisions;`,
);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`NOT OK - ${name}\n    ${err.message}`);
  }
}

const KEY = "agent:api-rag-escalation:api-rag-watcher";
const MINUTE = 60 * 1000;
const entryAged = (ms) => new Map([[KEY, { decision: "close-out", stage: 4, sentAt: Date.now() - ms }]]);

// The regression.
test("a fix that disappeared is pruned, so the poll can stop", () => {
  const pending = runPrune(entryAged(MINUTE), new Set());
  assert.strictEqual(pending.size, 0, "vanished fix left a pending entry behind - the 5s poll would never clear");
});

test("a fix still present is left pending", () => {
  const pending = runPrune(entryAged(MINUTE), new Set([KEY]));
  assert.strictEqual(pending.size, 1, "still-live fix must keep suppressing its buttons");
});

// Guards the double-click hole: /api/ops/stages degrades an unparseable tracker
// to {}, so a brief blip must not be read as "resolved".
test("a just-sent decision survives a transient absence", () => {
  const pending = runPrune(entryAged(5 * 1000), new Set());
  assert.strictEqual(pending.size, 1, "pruned inside the grace window - a blip would restore the buttons");
});

test("never-loaded state is not treated as the fix being gone", () => {
  const pending = runPrune(entryAged(MINUTE), null);
  assert.strictEqual(pending.size, 1, "pruned before any successful load - absence was not yet knowable");
});

test("TTL still expires a stuck entry even while the fix is present", () => {
  const pending = runPrune(entryAged(11 * MINUTE), new Set([KEY]));
  assert.strictEqual(pending.size, 0, "an agent that never acts must give the buttons back");
});

test("only the resolved entry is pruned, others are untouched", () => {
  const other = "agent:svc-core-escalation:svc-core-watcher";
  const pending = new Map([
    [KEY, { decision: "close-out", stage: 4, sentAt: Date.now() - MINUTE }],
    [other, { decision: "approve", stage: 4, sentAt: Date.now() - MINUTE }],
  ]);
  runPrune(pending, new Set([other]));
  assert.deepStrictEqual([...pending.keys()], [other]);
});

console.log(failures === 0 ? "\nAll pending-decision prune tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
