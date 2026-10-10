// Standalone test for the decision catalogue - no framework, run directly
// with `node test/opsDecisionSpecs.test.js` (this project has no test runner
// dependency by deliberate v1 design, see README.md).
//
// Every decision the dashboard can send is declared TWICE: routes/ops.js's
// DECISION_MESSAGES holds the stage rule and the message text, public/app.js's
// DECISIONS holds the button label. Nothing enforces that the two lists agree,
// and the failure is silent in the worst direction - a name in app.js but not
// ops.js renders a live-looking button that 400s ("unknown decision") the
// moment it's clicked, which is exactly the dead-end this whole feature was
// added to remove. Two names were added on 2026-08-06 (close-out,
// approve-suppression), so this is now a real drift surface rather than a
// theoretical one.
//
// app.js is a browser script with no module exports, so its object is read the
// only way available from Node: as text. Deliberately not `require`d or
// eval'd - it touches `document` on its very first lines.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8793";

const { DECISION_MESSAGES } = require(path.join(__dirname, "..", "src", "routes", "ops.js"));

// --- Backend specs are internally consistent ---
{
  const EXPECTED_STAGES = {
    approve: 4,
    deny: 4,
    "confirm-merged": 5,
    // null = "any stage this fix happens to be at". Only close-out, because
    // reaching the stages the other three can't is its entire purpose.
    "close-out": null,
    "approve-suppression": null,
    // Read-only re-check: applies to a fix at whatever stage it is sitting at,
    // because evidence goes stale at every stage (and at stage 4 the repo's
    // watcher is holding escalation delivery, so nothing new is reaching the
    // agent even though the workload itself is still being checked).
    verify: null,
  };

  const names = Object.keys(DECISION_MESSAGES).sort();
  assert.deepStrictEqual(
    names,
    Object.keys(EXPECTED_STAGES).sort(),
    "DECISION_MESSAGES gained or lost a decision - update this test and app.js's DECISIONS together",
  );

  for (const [name, spec] of Object.entries(DECISION_MESSAGES)) {
    assert.strictEqual(spec.stage, EXPECTED_STAGES[name], `${name} has the wrong stage rule`);
    assert.ok(
      typeof spec.text === "string" && spec.text.trim().length > 0,
      `${name} has no message text - the route would send an empty message to a live agent`,
    );
    // The endpoint branches on `!== false`, so an accidental `requiresFix: 0`
    // or `"false"` would silently still hit the tracker lookup.
    if ("requiresFix" in spec) {
      assert.strictEqual(spec.requiresFix, false, `${name}: requiresFix must be literal false when present`);
    }
  }

  // Only approve-suppression skips the tracker-entry match, and it must - a
  // benign-but-recurring verdict leaves no entry behind by design (AGENTS.md
  // Stage 1), which is precisely when a suppression is wanted.
  const noFixNeeded = names.filter((n) => DECISION_MESSAGES[n].requiresFix === false);
  assert.deepStrictEqual(noFixNeeded, ["approve-suppression"]);
  console.log("PASS: backend decision specs are internally consistent");
}

// --- Frontend and backend agree on the set of names ---
{
  const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  const block = /const DECISIONS = \{([\s\S]*?)\n\};/.exec(appJs);
  assert.ok(block, "could not find app.js's DECISIONS object - was it renamed?");
  // Keys only, from the start of each entry line: bare or quoted, up to the
  // colon. Comment lines inside the object are skipped by requiring a `{`
  // (the label/stage literal) after the colon.
  const frontendNames = [...block[1].matchAll(/^\s*"?([a-z-]+)"?:\s*\{/gm)].map((m) => m[1]).sort();

  assert.deepStrictEqual(
    frontendNames,
    Object.keys(DECISION_MESSAGES).sort(),
    "app.js's DECISIONS and routes/ops.js's DECISION_MESSAGES disagree - a name in only one of them is either a button that 400s or a message no button can send",
  );

  // Every confirming decision must be a real decision, or the second click
  // never fires (buildDecisionButtons looks the name up in CONFIRMING_DECISIONS
  // and falls through to the plain one-click path when it's absent - so a typo
  // here silently REMOVES a confirmation step rather than erroring).
  const confirmBlock = /const CONFIRMING_DECISIONS = \{([\s\S]*?)\n\};/.exec(appJs);
  assert.ok(confirmBlock, "could not find app.js's CONFIRMING_DECISIONS object");
  const confirmingNames = [...confirmBlock[1].matchAll(/^\s*"?([a-z-]+)"?:\s*\{/gm)].map((m) => m[1]).sort();
  for (const name of confirmingNames) {
    assert.ok(
      frontendNames.includes(name),
      `CONFIRMING_DECISIONS has '${name}', which is not a decision - its confirm step would silently never arm`,
    );
  }
  // The three that change something on disk off one click. Approve and
  // confirm-merged are deliberately NOT here: they're the expected "yes" to a
  // question the agent just asked, and an extra click on those is friction for
  // no safety.
  assert.deepStrictEqual(confirmingNames, ["approve-suppression", "close-out", "deny"]);

  // A read-only decision must never be a confirming one: it changes nothing,
  // so a second click would be friction with no safety behind it.
  const readOnlyNames = [...block[1].matchAll(/^\s*"?([a-z-]+)"?:\s*\{[^}]*readOnly:\s*true/gm)]
    .map((m) => m[1])
    .sort();
  assert.deepStrictEqual(
    readOnlyNames,
    ["verify"],
    "the set of readOnly decisions changed - check sendDecision's pending-state exclusion still covers all of them",
  );
  for (const name of readOnlyNames) {
    assert.ok(
      !confirmingNames.includes(name),
      `${name} is readOnly but also confirming - a second click for an action that changes nothing`,
    );
  }

  // The reason readOnly exists at all: pendingDecisions clears itself when the
  // stage MOVES, and a read-only action deliberately never moves it - so
  // recording one would hide the real decision buttons for the full TTL, right
  // when the human is waiting to read the answer and act on it.
  assert.ok(
    /if \(!DECISIONS\[decision\]\?\.readOnly && stageWhenSent !== null/.test(appJs),
    "sendDecision no longer excludes readOnly decisions from pendingDecisions - a re-check would suppress Approve/Deny for the whole TTL",
  );
  console.log("PASS: app.js and routes/ops.js declare the same decisions");
}

// Every decision that tells an agent to delete UNMERGED work must save the
// diff off first. Deny has done that since 2026-08-05; close-out was added on
// 2026-08-06 without it, and on 2026-08-13 that cost a real reviewed fix
// (api-rag, commit 6c96f25, APPROVED) - closed out to unstick a question the
// dashboard couldn't show, branch deleted, nothing written anywhere. The work
// survived only because git had not yet gc'd the unreachable commit.
//
// confirm-merged also says "delete the fix branch" and deliberately is NOT
// here: by then the commits are on trunk, so the branch is a pointer to work
// that is already safe. That distinction is the whole rule - "discards work"
// means "the only copy is about to go away", not "mentions a branch".
{
  const discarding = Object.entries(DECISION_MESSAGES)
    .filter(([, spec]) => spec.discardsWork)
    .map(([name]) => name)
    .sort();
  assert.deepStrictEqual(
    discarding,
    ["close-out", "deny"],
    "the set of work-discarding decisions changed - a new one needs a patch directory, " +
      "and an removed one needs its savePatchBeforeDiscard call checked",
  );

  const opsJs = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "ops.js"), "utf8");
  // Driven off the flag, not off decision names: a name list in the handler is
  // how close-out came to be missing from it in the first place.
  assert.ok(
    /if \(spec\.discardsWork\) \{[\s\S]{0,400}?savePatchBeforeDiscard\(/.test(opsJs),
    "the decision handler no longer saves the patch for every discardsWork decision",
  );
  // Two directories, because they answer different questions later: "what did
  // we turn down?" vs "what did we decide needed no fix?".
  for (const dir of ["denied-patches", "closed-out-patches"]) {
    assert.ok(opsJs.includes(dir), `${dir} is no longer referenced in routes/ops.js`);
  }
  // The agent is told where its diff went - in the same message that tells it
  // to delete the branch, which is the only moment it would think to save it.
  assert.ok(
    /closed-out-patches/.test(DECISION_MESSAGES["close-out"].text),
    "the close-out message no longer tells the agent its diff was saved",
  );
  assert.ok(
    /denied-patches/.test(DECISION_MESSAGES.deny.text),
    "the deny message no longer tells the agent its diff was saved",
  );
  console.log("PASS: work-discarding decisions save the patch first");
}

console.log("# ALL TESTS PASSED");
