// Standalone test for revealQueueDiff.js's findContentMatchEnd()/
// pushSnapshotDiff() - no framework, run directly with
// `node test/revealQueueDiff.test.js` (this project has no test runner
// dependency by deliberate v1 design, see README.md).
//
// Requires public/revealQueueDiff.js directly (the real browser-served
// file, not a reimplementation) - safe to require in plain Node because
// that file was deliberately split out of app.js for having no DOM
// dependency of its own, see that file's own header comment.
//
// Covers the four real, live-confirmed bug scenarios documented in
// revealQueueDiff.js's own comments:
//  1. Plain incremental growth (the common case: fullText simply extends
//     previousSnapshot) - must push only the new suffix, not the whole text.
//  2. Whitespace-substitution reformatting (confirmed live 0730: the
//     gateway re-delivered "Let me" as "Let\nme" mid-snapshot, nowhere near
//     where new content was actually added) - must NOT treat this as a
//     turn boundary; must still isolate exactly the genuinely new suffix.
//  3. A genuine turn boundary (fullText does NOT extend previousSnapshot at
//     all, even whitespace-tolerantly) - must append with a "\n\n" break
//     when the queue already has content, and WITHOUT wiping what's
//     already there (this is the fix for "thinking text appears/
//     disappears randomly" - the old behavior called queue.reset()).
//  4. Whitespace-INSERTION reformatting (confirmed live 0805 from a captured
//     chat.history message): the same reply re-delivered as "Under\n\nstood"
//     after the gateway split it across four content parts. Distinct from (2)
//     because the whitespace exists on only one side, which the original
//     both-sides tolerance read as genuinely new content - duplicating the
//     whole reply on screen. Also covers extractSnapshotText, which
//     reassembles those parts (app.js used to read only content[0]).

const assert = require("node:assert");
const path = require("node:path");

const {
  findContentMatchEnd,
  pushSnapshotDiff,
  stripWhitespace,
  extractSnapshotText,
} = require(
  path.join(__dirname, "..", "public", "revealQueueDiff.js"),
);

// --- findContentMatchEnd ---

// Case 1: exact prefix match - the common case.
assert.strictEqual(
  findContentMatchEnd("Hello world", "Hello"),
  5,
  "should return the index right after the matched prefix",
);
console.log("PASS: findContentMatchEnd - exact prefix match");

// Case 2: identical strings - fully matched, no new content.
assert.strictEqual(
  findContentMatchEnd("Hello", "Hello"),
  5,
  "identical strings should match fully, index at end",
);
console.log("PASS: findContentMatchEnd - identical strings");

// Case 3: the exact live-confirmed whitespace-substitution bug - "Let me"
// resent as "Let\nme", with genuinely new text " errors." appended after.
assert.strictEqual(
  findContentMatchEnd("Let\nme check the errors.", "Let me check the"),
  16,
  "a whitespace substitution mid-snapshot should still match through to the real new content",
);
console.log("PASS: findContentMatchEnd - whitespace-substitution reformatting (the live 0730 bug)");

// Case 4: a real, non-whitespace difference - must return -1 (not a
// reformatting artifact, genuinely different content).
assert.strictEqual(
  findContentMatchEnd("Goodbye world", "Hello"),
  -1,
  "a genuine content mismatch must return -1",
);
console.log("PASS: findContentMatchEnd - genuine mismatch returns -1");

// Case 5: fullText is SHORTER than previousSnapshot (can't have fully
// matched it) - must return -1, not a partial/truncated index.
assert.strictEqual(
  findContentMatchEnd("Hel", "Hello"),
  -1,
  "fullText shorter than previousSnapshot must return -1",
);
console.log("PASS: findContentMatchEnd - fullText shorter than previousSnapshot returns -1");

// Case 6: empty previousSnapshot - everything in fullText is new.
assert.strictEqual(
  findContentMatchEnd("Hello", ""),
  0,
  "empty previousSnapshot should match at index 0 (everything is new)",
);
console.log("PASS: findContentMatchEnd - empty previousSnapshot");

// --- pushSnapshotDiff ---

// A minimal fake queue matching the real interface (push/hasContent) that
// createRevealQueue() returns - see that function in app.js.
function fakeQueue(initialHasContent) {
  const pushed = [];
  return {
    pushed,
    hasContent: () => initialHasContent || pushed.length > 0,
    push(text) {
      // Mirrors the real reveal queue's own `if (!text) return;` (app.js) -
      // added 0805, previously this recorded an empty push as a real one.
      // pushSnapshotDiff legitimately diffs to "" whenever a snapshot turns
      // out to be a pure re-delivery, and production treats that as the
      // no-op it is, so a harness that records it would report "pushed
      // something" for the exact case the diffing exists to suppress.
      if (!text) return;
      pushed.push(text);
    },
  };
}

// Case 1: plain incremental growth - only the new suffix should be pushed.
{
  const queue = fakeQueue(false);
  pushSnapshotDiff(queue, "Hello world", "Hello");
  assert.deepStrictEqual(queue.pushed, [" world"], "should push only the new suffix on plain growth");
  console.log("PASS: pushSnapshotDiff - plain incremental growth pushes only the new suffix");
}

// Case 2: no change at all - nothing new to push.
{
  const queue = fakeQueue(true);
  pushSnapshotDiff(queue, "Hello", "Hello");
  // Was [""] until 0805 - pushSnapshotDiff does still call push(""), but
  // fakeQueue now mirrors the real queue's own no-op on empty text, so what
  // this asserts is what production actually does with it: nothing.
  assert.deepStrictEqual(queue.pushed, [], "identical snapshots should push nothing, not the whole text again");
  console.log("PASS: pushSnapshotDiff - no change pushes nothing new");
}

// Case 3: the whitespace-substitution bug - must isolate just the new tail,
// not re-push (or lose) the reformatted middle section.
{
  const queue = fakeQueue(true);
  pushSnapshotDiff(queue, "Let\nme check the errors.", "Let me check the");
  assert.deepStrictEqual(queue.pushed, [" errors."], "a whitespace-only reformat must not be treated as new content");
  console.log("PASS: pushSnapshotDiff - whitespace-substitution reformatting isolates only genuinely new text");
}

// Case 4: a genuine turn boundary, queue already has content - must insert
// a "\n\n" break and push the WHOLE new text (not a diff against the old
// snapshot, since they're unrelated turns).
{
  const queue = fakeQueue(true);
  pushSnapshotDiff(queue, "A completely different turn.", "Previous unrelated turn.");
  assert.deepStrictEqual(
    queue.pushed,
    ["\n\nA completely different turn."],
    "a genuine mismatch with existing content should insert a break before the full new text",
  );
  console.log("PASS: pushSnapshotDiff - turn boundary with existing content inserts a break, doesn't wipe");
}

// Case 5: a genuine turn boundary, but the queue is currently EMPTY - no
// break should be inserted (nothing to separate from), even though this
// still goes through the mismatch branch (previousSnapshot is non-empty
// and doesn't match at all).
{
  const queue = fakeQueue(false);
  pushSnapshotDiff(queue, "First real turn.", "Unrelated stale snapshot");
  assert.deepStrictEqual(
    queue.pushed,
    ["First real turn."],
    "a mismatch against an empty queue should not get a leading break",
  );
  console.log("PASS: pushSnapshotDiff - turn boundary with an empty queue gets no leading break");
}

// Case 6: the very first turn ever (previousSnapshot === "", the real
// starting value of lastTranscriptSnapshot/lastThinkingSnapshot in app.js).
// This actually goes through the FIRST branch (fullText always
// startsWith("")), not the mismatch branch - confirming the natural
// real-world first-turn path still pushes the whole text with no break.
{
  const queue = fakeQueue(false);
  pushSnapshotDiff(queue, "First turn ever.", "");
  assert.deepStrictEqual(
    queue.pushed,
    ["First turn ever."],
    "the very first turn (empty previousSnapshot) should push the whole text via the plain-growth branch",
  );
  console.log("PASS: pushSnapshotDiff - very first turn (empty previousSnapshot) via plain-growth branch");
}


// --- 0805 regression: the duplicated Deny reply -------------------------
//
// All three cases below replay the SAME real captured message, taken
// verbatim from chat.history for the svc-core escalation session right
// after a dashboard Deny click. The gateway stored one assistant message
// whose `content` was four parts, splitting the word "Understood" in half:
const CAPTURED_0805_PARTS = [
  { type: "text", text: "" },
  { type: "text", text: "\n\nUnder" },
  { type: "text", text: "" },
  {
    type: "text",
    text:
      "stood — the `fix/stream-chunk-timeout` fix (currently at stage 4, not yet " +
      "pushed) is on hold. I won't push the branch or open a PR until you give the " +
      "go-ahead.",
  },
];
const CAPTURED_0805_TEXT =
  "\n\nUnderstood — the `fix/stream-chunk-timeout` fix (currently at stage 4, not yet " +
  "pushed) is on hold. I won't push the branch or open a PR until you give the " +
  "go-ahead.";

// Case 7: extractSnapshotText must reassemble the split word, not read only
// content[0] (which is "" here - the exact value that reset
// lastTranscriptSnapshot and caused the whole reply to be pushed twice).
assert.strictEqual(
  extractSnapshotText(CAPTURED_0805_PARTS),
  CAPTURED_0805_TEXT,
  "should join every content part with no separator, reassembling 'Understood'",
);
console.log("PASS: extractSnapshotText - reassembles a word split across content parts");

// Case 8: no usable text must be null, NOT "" - app.js assigns this straight
// to lastTranscriptSnapshot, and "" silently wipes the accumulated snapshot.
for (const [label, input] of [
  ["all parts empty", [{ type: "text", text: "" }]],
  ["thinking-only", [{ type: "thinking", text: "hmm" }]],
  ["empty array", []],
  ["not an array", undefined],
]) {
  assert.strictEqual(
    extractSnapshotText(input),
    null,
    `should return null (not "") for ${label}, so the caller can leave the snapshot alone`,
  );
}
console.log("PASS: extractSnapshotText - returns null rather than \"\" when there is no text");

// Case 9: the injected part-boundary "\n\n" is one-sided whitespace - the
// tolerance used to require whitespace on BOTH sides, so this returned -1
// ("genuinely new content") and the reply was rendered a second time.
// extractFinalText joins the parts above with "\n\n", producing this:
const REANNOUNCED_0805 = CAPTURED_0805_PARTS.filter((p) => p.text)
  .map((p) => p.text)
  .join("\n\n");
assert.strictEqual(
  findContentMatchEnd(REANNOUNCED_0805, CAPTURED_0805_TEXT),
  REANNOUNCED_0805.length,
  "a re-announcement differing only by an injected \\n\\n must fully match, not read as new content",
);
console.log("PASS: findContentMatchEnd - tolerates one-sided injected whitespace");

// Case 10: pushSnapshotDiff over that same pair must push NOTHING - the text
// is already on screen. This is the end-to-end shape of the reported bug.
{
  const queue = fakeQueue(true);
  pushSnapshotDiff(queue, REANNOUNCED_0805, CAPTURED_0805_TEXT);
  assert.deepStrictEqual(
    queue.pushed,
    [],
    "re-announced identical-but-reformatted text must not be pushed again",
  );
  console.log("PASS: pushSnapshotDiff - reformatted re-delivery pushes nothing (0805 duplication)");
}

// Case 11: the tolerance must not swallow genuinely new content that happens
// to follow reformatted text - the suffix still has to come through exactly.
{
  const queue = fakeQueue(true);
  pushSnapshotDiff(queue, REANNOUNCED_0805 + " And one more thing.", CAPTURED_0805_TEXT);
  assert.deepStrictEqual(
    queue.pushed,
    [" And one more thing."],
    "genuinely new text after a reformatted prefix must still be isolated exactly",
  );
  console.log("PASS: pushSnapshotDiff - new suffix after reformatted prefix still isolated");
}

// Case 12: a real, non-whitespace content difference must STILL be treated as
// a turn boundary - the looser tolerance must not make everything match.
assert.strictEqual(
  findContentMatchEnd("Something completely different.", CAPTURED_0805_TEXT),
  -1,
  "genuinely different content must still report -1, tolerance notwithstanding",
);
console.log("PASS: findContentMatchEnd - genuinely different content still reports a boundary");

// Case 13: normalizeWhitespace-based containment - reconcileTranscriptText's
// case-2 "redundant re-delivery" check. The strict includes() it replaced
// missed exactly this.
assert.ok(
  stripWhitespace(CAPTURED_0805_TEXT).includes(stripWhitespace(REANNOUNCED_0805)),
  "a reformatted re-delivery must be recognised as already-contained",
);
assert.ok(
  !stripWhitespace(CAPTURED_0805_TEXT).includes(stripWhitespace("unrelated new text")),
  "unrelated text must not be recognised as already-contained",
);
console.log("PASS: stripWhitespace - containment ignores reformatting but not real differences");

console.log("\nALL TESTS PASSED");
