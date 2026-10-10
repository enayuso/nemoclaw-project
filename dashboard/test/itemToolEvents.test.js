// Standalone test for public/itemToolEvents.js - no framework, run
// directly with `node test/itemToolEvents.test.js` (this project has no
// test runner dependency by deliberate v1 design, see README.md).
//
// Requires public/itemToolEvents.js directly (the real browser-served
// file, not a reimplementation) and replays test/fixtures/cli-run-frames.json,
// which is a REAL capture taken 2026-08-06 off the live gateway: two
// one-shot `openclaw agent --agent main --session-key ... --message ...`
// runs, the same invocation the watcher crons use
// (templates/watcher-k8s.sh.tmpl). Trimmed to the tool-relevant frames
// only; nothing about their shape was edited.
//
// The bug this covers: a CLI/cron-triggered run emits NO stream:"tool"
// events at all, so renderToolCard - which only ever listened for that
// stream - drew no tool card whatsoever for a live-viewed cron
// escalation. Not a malformed card, none. These runs are exactly the
// autonomous ones worth watching, so the whole point of live-viewing one
// was missing.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  recordItemToolArgs,
  lookupItemToolArgs,
  normalizeItemToolEvent,
  normalizeCommandOutput,
} = require("../public/itemToolEvents.js");

const frames = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "cli-run-frames.json"), "utf8"),
);

// Mirrors exactly what app.js's renderFrame does with these frames, minus
// the DOM: harvest args off session.message, normalise item events, and
// fold command_output in afterwards.
function replay(capture) {
  const store = new Map();
  const cards = new Map(); // toolCallId -> latest normalised card payload
  const order = [];
  for (const frame of frames) {
    if (frame.capture !== capture) continue;
    const payload = frame.payload;
    if (frame.event === "session.message") {
      recordItemToolArgs(store, payload.message);
      continue;
    }
    let normalized = null;
    if (payload.stream === "item") normalized = normalizeItemToolEvent(store, payload.data);
    else if (payload.stream === "command_output") normalized = normalizeCommandOutput(payload.data);
    if (!normalized) continue;
    if (!cards.has(normalized.toolCallId)) order.push(normalized.toolCallId);
    // renderToolCard rebuilds a card in place on each event for the same
    // toolCallId, so last-write-wins is the right model here too.
    const prev = cards.get(normalized.toolCallId) || {};
    cards.set(normalized.toolCallId, {
      ...normalized,
      // The command is cached on the card itself in the real renderer
      // (card.dataset.command) precisely because later events drop it.
      args: normalized.args || prev.args,
      itemLabel: normalized.itemLabel || prev.itemLabel,
    });
  }
  return { cards, order };
}

// --- 1. Three tool calls in, three cards out ---------------------------
// The capture is 2 exec + 1 read. Getting this wrong in either direction
// is the whole bug class: 0 cards was the reported symptom, and 6 would
// mean the kind:"command" duplicates leaked through.
{
  const { cards, order } = replay("multi");
  assert.strictEqual(order.length, 3, `expected 3 cards, got ${order.length}`);
  const names = order.map((id) => cards.get(id).name);
  assert.deepStrictEqual(names, ["exec", "read", "exec"], `unexpected tools: ${names}`);
  // No card may ever be the generic wrapper.
  for (const id of order) {
    assert.notStrictEqual(cards.get(id).name, "tool_call", "wrapper leaked into a card");
  }
  console.log("ok  1 - 2 exec + 1 read produce exactly 3 cards, wrapper and duplicates skipped");
}

// --- 2. Commands correlate from session.message ------------------------
// The tools' own events never carry arguments; they arrive on a separate
// session.message frame keyed by the WRAPPER's id, which appears as a
// colon segment inside the real tool's id.
{
  const { cards, order } = replay("multi");
  const execCards = order.map((id) => cards.get(id)).filter((c) => c.name === "exec");
  const commands = execCards.map((c) => c.args && c.args.command);
  assert.deepStrictEqual(
    commands,
    ["echo FIRST_MARKER", "ls /sandbox | head -3"],
    `commands not correlated: ${JSON.stringify(commands)}`,
  );
  console.log("ok  2 - exec commands correlate from session.message via the wrapper id");
}

// --- 3. A non-command tool still gets a usable card --------------------
// `read` carries no command anywhere and its end event has no output
// field of any kind, so the card falls back to the gateway's own title.
{
  const { cards, order } = replay("multi");
  const readCard = order.map((id) => cards.get(id)).find((c) => c.name === "read");
  assert.ok(readCard, "no card for the read tool");
  assert.ok(
    !readCard.args || readCard.args.command === undefined,
    "read should have no command",
  );
  assert.strictEqual(readCard.args && readCard.args.path, "/etc/hostname");
  assert.strictEqual(readCard.itemLabel, "read from /etc/hostname");
  console.log("ok  3 - read falls back to its title and exposes its path, not a fake command");
}

// --- 4. Output from command_output lands on the card -------------------
// command_output arrives AFTER the tool item's own "end" (seq 12 vs 10),
// so it necessarily updates an already-completed card.
{
  const { cards, order } = replay("multi");
  const first = cards.get(order[0]);
  assert.strictEqual(first.phase, "result");
  assert.strictEqual(first.isError, false);
  assert.strictEqual(first.result.details.aggregated, "FIRST_MARKER");
  console.log("ok  4 - exec output attaches to the card after completion");
}

// --- 5. Failure: status, message and exit code -------------------------
// Captured from a deliberately failing command. "failed" is the real
// status string the gateway emits - the only one of the three observed
// live that could not be inferred from a successful run.
{
  const { cards, order } = replay("fail");
  assert.strictEqual(order.length, 1, `expected 1 card, got ${order.length}`);
  const card = cards.get(order[0]);
  assert.strictEqual(card.isError, true, "failed command should mark the card errored");
  assert.match(card.result.details.aggregated, /not found/);
  assert.match(
    card.result.details.aggregated,
    /\(exit code 127\)/,
    "a failure should surface its exit code",
  );
  assert.strictEqual(card.args.command, "definitely-not-a-real-command-xyz123");
  console.log("ok  5 - a failed command reports error text, exit code and its command");
}

// --- 6. Unknown ids degrade instead of throwing ------------------------
// A card whose session.message was missed (reconnect mid-run, buffer
// eviction) must still render from the tool's own event rather than
// blowing up the whole frame handler.
{
  const store = new Map();
  const normalized = normalizeItemToolEvent(store, {
    kind: "tool",
    name: "exec",
    phase: "start",
    status: "running",
    title: "exec something",
    toolCallId: "tool_search_code:never-seen-wrapper:exec:1",
  });
  assert.ok(normalized, "should still produce a card with no args available");
  assert.strictEqual(normalized.args, undefined);
  assert.strictEqual(normalized.itemLabel, "exec something");
  assert.strictEqual(lookupItemToolArgs(store, "no:colons:here"), null);
  assert.strictEqual(normalizeItemToolEvent(store, null), null);
  assert.strictEqual(normalizeCommandOutput(null), null);
  console.log("ok  6 - missing args and null input degrade gracefully");
}

console.log("\nall itemToolEvents tests passed");
