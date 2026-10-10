// Standalone test for routes/ops.js's applyDenials() - no framework, run
// directly with `node test/opsDenials.test.js` (this project has no test
// runner dependency by deliberate v1 design, see README.md).
//
// Why this is worth a test of its own: `fix.denied` is not a label, it is a
// capability gate. app.js hides every decision button behind !fix.denied and
// leaves denied fixes out of the "waiting on you" count, so getting this
// wrong in either direction produces a fix that NOBODY CAN DECIDE ON, and
// does it silently - the row just sits there looking like it is mid-cleanup.
//
// Both directions have to hold, and they pull against each other:
//   - too sticky  -> a new incident that reuses a branch name inherits the
//                    old denial and can never be approved (the api-rag
//                    fix/image-reranker-400 case this was written for)
//   - too loose   -> a genuinely denied fix gets its buttons back and a
//                    second click can contradict the first
// That is why "signature unknown" resolves to still-denied rather than to
// not-denied: of the two failure modes it is the recoverable one.

// Placeholder config so requiring routes/ops.js doesn't trip the real .env
// check - same bootstrap as test/opsDecisionSpecs.test.js. Nothing here
// connects to anything; applyDenials is pure.
const assert = require("node:assert");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8793";

const { applyDenials } = require(path.join(__dirname, "..", "src", "routes", "ops.js"));

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

const BRANCH = "fix/image-reranker-400";
const SIG_OLD = "90135be7bc5cbae591deeeafa5308426";
const SIG_NEW = "76a12eb6844f944f6de4dab487a1ec82";

function fixture(fixSig, denialSig, denialExtras = {}) {
  const fixes = { [BRANCH]: { stage: 4, incident_signature: fixSig } };
  const denials =
    denialSig === undefined
      ? {}
      : { [BRANCH]: { incident_signature: denialSig, denied_at: "2026-08-12T01:22:44.388Z", ...denialExtras } };
  applyDenials(fixes, denials);
  return fixes[BRANCH];
}

test("no denial record at all leaves the fix undenied", () => {
  const fix = fixture(SIG_NEW, undefined);
  assert.strictEqual(fix.denied, false);
  assert.strictEqual(fix.deniedAt, null);
});

test("denial applies when the signature still matches the tracked incident", () => {
  const fix = fixture(SIG_OLD, SIG_OLD);
  assert.strictEqual(fix.denied, true);
  assert.strictEqual(fix.deniedAt, "2026-08-12T01:22:44.388Z");
});

// The regression this was written for.
test("a NEW incident reusing the denied branch name is not denied", () => {
  const fix = fixture(SIG_NEW, SIG_OLD);
  assert.strictEqual(fix.denied, false, "new incident inherited the old branch's denial");
  assert.strictEqual(fix.deniedAt, null, "deniedAt must not survive a superseded denial");
});

// Backward compatibility: pre-2026-08-05 denials carry no signature, and
// "unknown" must not be read as "different".
test("denial without a signature still applies (pre-2026-08-05 records)", () => {
  assert.strictEqual(fixture(SIG_NEW, null).denied, true);
  assert.strictEqual(fixture(SIG_NEW, "").denied, true);
  const noField = { [BRANCH]: { denied_at: "2026-08-12T01:22:44.388Z" } };
  const fixes = { [BRANCH]: { stage: 4, incident_signature: SIG_NEW } };
  applyDenials(fixes, noField);
  assert.strictEqual(fixes[BRANCH].denied, true);
});

test("fix without a signature stays denied rather than regaining buttons", () => {
  assert.strictEqual(fixture(null, SIG_OLD).denied, true);
  assert.strictEqual(fixture("", SIG_OLD).denied, true);
  assert.strictEqual(fixture(undefined, SIG_OLD).denied, true);
});

// Denials are per-branch on this surface by design: the same incident
// re-proposed on a DIFFERENT branch is a proposal the human has not ruled on.
// Marking it denied would recreate the same un-actionable dead end elsewhere.
test("a denial on one branch never leaks onto another branch", () => {
  const fixes = { "fix/other-branch": { stage: 4, incident_signature: SIG_OLD } };
  applyDenials(fixes, { [BRANCH]: { incident_signature: SIG_OLD, denied_at: "2026-08-12T01:22:44.388Z" } });
  assert.strictEqual(fixes["fix/other-branch"].denied, false);
});

test("every fix is stamped, including ones with no denial in a mixed set", () => {
  const fixes = {
    [BRANCH]: { stage: 4, incident_signature: SIG_NEW },
    "fix/unrelated": { stage: 2, incident_signature: "deadbeef" },
  };
  applyDenials(fixes, { [BRANCH]: { incident_signature: SIG_OLD, denied_at: "x" } });
  for (const [key, fix] of Object.entries(fixes)) {
    assert.strictEqual(fix.denied, false, `${key} should be undenied`);
    assert.strictEqual(fix.deniedAt, null, `${key} should have no deniedAt`);
  }
});

console.log(failures === 0 ? "\nAll denial tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
