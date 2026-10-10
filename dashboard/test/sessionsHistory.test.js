// Standalone test for routes/sessions.js's mergeUserMessages() - no
// framework, run directly with `node test/sessionsHistory.test.js` (see
// test/wsRelay.test.js for why this project uses this style).
//
// Confirms the fix for a real gap found live 2026-07-24: chat.history's
// own messages never include the operator's own dashboard-submitted text
// as a "user"-role entry - a real replay showed zero trace of the user's
// query after a refresh/session-switch. mergeUserMessages() fills that
// gap using sessionIndex's own recorded copy of every message sent.

const assert = require("node:assert");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8788";

const sessionsRouter = require(path.join(__dirname, "..", "src", "routes", "sessions.js"));
const { mergeUserMessages } = sessionsRouter;

function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function timedMsg(text, timestamp) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

// --- Test 1: no recorded user messages (old entries predating this fix,
// or genuinely none) - must return history untouched, not crash. ---
{
  const history = [assistantMsg("a"), assistantMsg("b")];
  const result = mergeUserMessages(history, []);
  assert.strictEqual(result, history, "with no userMessages, the exact same array should be returned untouched");
  const result2 = mergeUserMessages(history, undefined);
  assert.strictEqual(result2, history, "undefined userMessages should also be handled without crashing");
}
console.log("PASS: no recorded user messages leaves history untouched");

// --- Test 2: the confirmed-live, common case - exactly ONE user message
// (a fresh conversation) - unambiguous placement: first, then everything
// else. ---
{
  const history = [assistantMsg("Let me check..."), assistantMsg("No issues found.")];
  const result = mergeUserMessages(history, [{ text: "hey whats up?", sentAt: 1 }]);
  assert.strictEqual(result.length, 3, `expected 3 messages (1 user + 2 assistant), got ${result.length}`);
  assert.strictEqual(result[0].role, "user", "the recorded message should come first");
  assert.strictEqual(result[0].content[0].text, "hey whats up?");
  assert.strictEqual(result[1], history[0], "assistant messages should follow, in original order");
  assert.strictEqual(result[2], history[1]);
}
console.log("PASS: single user message (the confirmed-live case) is placed first, unambiguously");

// --- Test 3: single user message with ZERO history messages yet (e.g. a
// session that errored before the agent said anything) - must not crash,
// should just be the user message alone. ---
{
  const result = mergeUserMessages([], [{ text: "hello?", sentAt: 1 }]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].role, "user");
}
console.log("PASS: a user message with no history yet doesn't crash, returns just the user turn");

// --- Test 4: multiple user messages (a session with follow-ups) - a
// best-effort proportional split, not independently verified live yet
// (see this function's own comment in routes/sessions.js) but should at
// minimum preserve every message exactly once, in a sane order (all user
// messages present, all history messages present, nothing duplicated). ---
{
  const history = [assistantMsg("a1"), assistantMsg("a2"), assistantMsg("a3"), assistantMsg("a4")];
  const result = mergeUserMessages(history, [
    { text: "first question", sentAt: 1 },
    { text: "second question", sentAt: 2 },
  ]);
  assert.strictEqual(result.length, 6, `expected 6 messages (2 user + 4 assistant), got ${result.length}`);
  const userEntries = result.filter((m) => m.role === "user");
  assert.strictEqual(userEntries.length, 2);
  assert.strictEqual(userEntries[0].content[0].text, "first question");
  assert.strictEqual(userEntries[1].content[0].text, "second question");
  // Every original history message present exactly once, order preserved.
  const assistantEntries = result.filter((m) => m.role === "assistant");
  assert.deepStrictEqual(assistantEntries, history);
  // The first user message comes before the second.
  assert.ok(result.indexOf(userEntries[0]) < result.indexOf(userEntries[1]));
}
console.log("PASS: multiple user messages - all entries preserved exactly once, correct relative order");

// --- Test 5: Fixed 2026-07-24 - the ORIGINAL proportional-split bug,
// confirmed live against a real 3-follow-up session and reproduced here
// with realistic (unequal-length) turns and real timestamps. Question 1's
// answer is 1 turn, question 2's is 1 turn, question 3's is 4 turns (a
// real multi-tool-call response) - a COUNT-based proportional split
// would land question 2 and 3 in the wrong place the moment turns per
// question aren't equal, which is exactly what a real run showed. ---
{
  const history = [
    timedMsg("answer to q1", 100),
    timedMsg("answer to q2", 200),
    timedMsg("q3 answer part 1", 310),
    timedMsg("q3 answer part 2", 320),
    timedMsg("q3 answer part 3", 330),
    timedMsg("q3 answer part 4", 340),
  ];
  const userMessages = [
    { text: "question 1", sentAt: 50 },
    { text: "question 2", sentAt: 150 },
    { text: "question 3", sentAt: 250 },
  ];
  const result = mergeUserMessages(history, userMessages);
  assert.strictEqual(result.length, 9, `expected 9 messages (3 user + 6 assistant), got ${result.length}`);
  const texts = result.map((m) => m.content[0].text);
  assert.deepStrictEqual(texts, [
    "question 1",
    "answer to q1",
    "question 2",
    "answer to q2",
    "question 3",
    "q3 answer part 1",
    "q3 answer part 2",
    "q3 answer part 3",
    "q3 answer part 4",
  ], `expected each question immediately before its own answer's turns, got: ${JSON.stringify(texts)}`);
}
console.log("PASS: unequal-length turns (the real bug - question 2/3 misplaced by the old proportional split) now merge in correct chronological order");

console.log("\nALL TESTS PASSED");
