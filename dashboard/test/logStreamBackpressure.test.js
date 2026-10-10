// Backpressure and buffering test for src/logStream.js - run directly with
// `node test/logStreamBackpressure.test.js`. Hermetic. Takes ~3s of real
// time on purpose (see the ring-buffer section).
//
// A single chatty pod can emit far more per second than a browser can
// render, and four panes multiply that. Two independent caps handle it, and
// both have a precedent in this codebase for why they exist:
//
// - A per-stream line rate limit. Over it, lines are DROPPED and COUNTED,
//   and the count is reported. Dropping visibly is the whole point: a
//   silently truncated pane is the same class of failure as a silently dead
//   one, which is exactly what the watcher work keeps running into.
// - A ring buffer of recent lines, so a pane opening onto an already-running
//   stream gets context instead of a blank box. Capped in BOTH lines and
//   bytes, evicting oldest-first - the same policy and reasoning as
//   wsRelay.js's EVENT_BUFFER_MAX_BYTES, which was added after an unbounded,
//   purely time-gated buffer leak was found in production.
//
// Also covered here: partial-line reassembly. kubectl's stdout arrives in
// arbitrary chunks and a line routinely straddles a chunk boundary; emitting
// on chunk boundaries would split messages mid-word.

const assert = require("node:assert");
const path = require("node:path");
const { installFakeSpawn, makeCollector, k8sLine, criTs, tick, check, report } = require("./logStreamHarness");

const logStream = require(path.join(__dirname, "..", "src", "logStream.js"));
const { LINE_RATE_LIMIT, RING_MAX_LINES } = logStream._constants;

const target = {
  repoKey: "rag",
  namespace: "dev",
  labelSelector: "app=svc-rag-dev",
};

// Real CRI format (local offset, nanosecond precision) - see criTs. All
// within one second, which is what the flood and ring cases want.
const ts = (n) => criTs(55, n);

(async () => {
  const spawns = installFakeSpawn();

  // === partial-line reassembly ============================================
  const p = makeCollector();
  const unsubP = logStream.subscribe(target, p.handlers);
  await tick();
  const pChild = spawns.lastChild();

  pChild.emitStdout(`[pod/rag-1/rag] ${ts(1)} split-me`);
  check("a line straddling a chunk boundary is not emitted early", () => {
    assert.strictEqual(p.lines.length, 0, "a partial line was emitted before its newline arrived");
  });

  pChild.emitStdout("-across-chunks\n");
  check("...and is emitted whole once the newline arrives", () => {
    assert.deepStrictEqual(p.texts(), ["split-me-across-chunks"]);
  });

  check("several lines in one chunk all arrive", () => {
    pChild.emitStdout(`${k8sLine(ts(2), "a")}\n${k8sLine(ts(3), "b")}\n${k8sLine(ts(4), "c")}\n`);
    assert.deepStrictEqual(p.texts().slice(-3), ["a", "b", "c"]);
  });

  check("the pod and container are parsed off the --prefix", () => {
    const last = p.lines[p.lines.length - 1];
    assert.strictEqual(last.pod, "rag-abc123");
    assert.strictEqual(last.container, "rag");
    assert.strictEqual(last.ts, ts(4));
  });

  check("a line that does not match the expected shape still reaches the pane", () => {
    // Defensive parsing: if --prefix/--timestamps are ever dropped, or a pod
    // writes something unusual, the operator must still see the text rather
    // than have it swallowed by a strict pattern.
    pChild.emitStdout("raw unprefixed output\n");
    const last = p.lines[p.lines.length - 1];
    assert.strictEqual(last.text, "raw unprefixed output");
    assert.strictEqual(last.ts, null);
  });

  unsubP();

  // === rate limiting ======================================================
  const c = makeCollector();
  const unsub = logStream.subscribe({ ...target, repoKey: "flood" }, c.handlers);
  await tick();
  const child = spawns.lastChild();

  const FLOOD = LINE_RATE_LIMIT + 100;
  let burst = "";
  for (let i = 0; i < FLOOD; i += 1) burst += `${k8sLine(ts(i + 10), `flood-${i}`)}\n`;
  child.emitStdout(burst);

  check(`a ${FLOOD}-line burst is capped at ${LINE_RATE_LIMIT} delivered lines`, () => {
    assert.strictEqual(
      c.lines.length,
      LINE_RATE_LIMIT,
      `expected ${LINE_RATE_LIMIT} delivered, got ${c.lines.length}`,
    );
  });

  check("the lines that survive are the EARLIEST of the burst, in order", () => {
    assert.strictEqual(c.lines[0].text, "flood-0");
    assert.strictEqual(c.lines[LINE_RATE_LIMIT - 1].text, `flood-${LINE_RATE_LIMIT - 1}`);
  });

  check("nothing is reported as dropped until the window closes", () => {
    assert.strictEqual(c.controlOfType("throttled").length, 0);
  });

  // Crossing into the next rate window is what flushes the drop count.
  await tick(1050);
  child.emitStdout(`${k8sLine(ts(999), "next-window")}\n`);

  check("the drop is reported, with an accurate count", () => {
    const th = c.controlOfType("throttled");
    assert.strictEqual(th.length, 1, `expected 1 throttled frame, got ${th.length}`);
    assert.strictEqual(th[0].dropped, 100, `expected 100 dropped, got ${th[0].dropped}`);
  });

  check("the stream keeps flowing in the next window", () => {
    assert.ok(c.texts().includes("next-window"), "stream did not recover after throttling");
  });

  unsub();

  // === ring buffer ========================================================
  // Filled across several rate windows rather than in one burst, because the
  // rate limiter would otherwise drop most of it - the two caps are
  // independent and this exercises the ring one specifically.
  const r = makeCollector();
  const unsubR = logStream.subscribe({ ...target, repoKey: "ring" }, r.handlers);
  await tick();
  const rChild = spawns.lastChild();

  const total = RING_MAX_LINES + 200;
  for (let w = 0; w * LINE_RATE_LIMIT < total; w += 1) {
    let chunk = "";
    const start = w * LINE_RATE_LIMIT;
    for (let i = start; i < Math.min(start + LINE_RATE_LIMIT, total); i += 1) {
      chunk += `${k8sLine(ts(i), `ring-${i}`)}\n`;
    }
    rChild.emitStdout(chunk);
    await tick(1050); // cross into the next rate window
  }

  check("no line was dropped while filling the ring", () => {
    assert.strictEqual(
      r.controlOfType("throttled").length,
      0,
      "the ring fill hit the rate limiter - the test is not measuring what it claims",
    );
    assert.strictEqual(r.lines.length, total);
  });

  // A second pane joining an already-running stream replays the ring.
  const late = makeCollector();
  const unsubLate = logStream.subscribe({ ...target, repoKey: "ring" }, late.handlers);

  check(`a pane joining mid-stream is replayed at most ${RING_MAX_LINES} lines`, () => {
    assert.ok(
      late.lines.length <= RING_MAX_LINES,
      `ring exceeded its line cap: ${late.lines.length} > ${RING_MAX_LINES}`,
    );
    assert.ok(late.lines.length > 0, "a pane joining a running stream got nothing at all");
  });

  check("the replay keeps the MOST RECENT lines, not the oldest", () => {
    // Whoever is catching up cares about what is happening now. Same
    // eviction policy as wsRelay's event buffer, for the same reason.
    const lastText = late.lines[late.lines.length - 1].text;
    assert.strictEqual(lastText, `ring-${total - 1}`, `replay ended at ${lastText}`);
  });

  check("a pane joining a running stream is told the stream's current state", () => {
    const status = late.controlOfType("status");
    assert.ok(status.length > 0, "no status frame on join - the pane cannot render live/retrying/failed");
    assert.strictEqual(status[0].state, "live");
  });

  unsubLate();
  unsubR();
  spawns.restore();
  report();
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
