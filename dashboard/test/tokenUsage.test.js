// Standalone test for public/tokenUsage.js - run directly with
// `node test/tokenUsage.test.js`, same convention as the other tests here
// (this project ships no test-runner dependency by deliberate v1 design).
//
// Requires the real browser-served file, not a reimplementation.
//
// What this covers, and why it is worth covering at all: the Usage panel is a
// TIME SERIES, and time series lie in two specific ways that both bit us while
// building this one.
//
//   1. A day with no data must not be drawn adjacent to its neighbours, or a
//      multi-day gap reads as consecutive activity.
//   2. "Turns ran but usage was never recorded" must not collapse into "no
//      activity". Before compat.supportsUsageInStreaming was enabled on the
//      gateway (2026-08-12) EVERY escalation and reviewer agent logged usage as
//      0 - measured live at 154 such turns on 2026-08-11 alone. Rendering that
//      as a zero bar would report the single busiest kind of day as idle.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  fmtTokens,
  classifyUsageDay,
  fillUsageGaps,
  contextUsedFromUsage,
} = require("../public/tokenUsage.js");

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

// --- fmtTokens -------------------------------------------------------------

test("fmtTokens keeps small counts exact and compacts large ones", () => {
  assert.strictEqual(fmtTokens(0), "0");
  assert.strictEqual(fmtTokens(28), "28");
  assert.strictEqual(fmtTokens(1200), "1.2k");
  // Five- and seven-figure values drop the decimal - at that magnitude the
  // tenth is noise in a 3.6rem column.
  assert.strictEqual(fmtTokens(101000), "101k");
  assert.strictEqual(fmtTokens(1506189), "1.5M");
  // Under 1e5 the tenth is still meaningful, so it is kept.
  assert.strictEqual(fmtTokens(16491), "16.5k");
});

test("fmtTokens treats a missing count as zero rather than NaN", () => {
  assert.strictEqual(fmtTokens(undefined), "0");
  assert.strictEqual(fmtTokens(null), "0");
});

// --- classifyUsageDay ------------------------------------------------------

test("classifyUsageDay separates measured, unmeasured and idle", () => {
  assert.strictEqual(classifyUsageDay({ turns: 18, unrecordedTurns: 51 }), "measured");
  // The 2026-08-11 case from the live data: 154 turns ran, none measured.
  assert.strictEqual(classifyUsageDay({ turns: 0, unrecordedTurns: 154 }), "unmeasured");
  assert.strictEqual(classifyUsageDay({ turns: 0, unrecordedTurns: 0 }), "idle");
});

// --- fillUsageGaps ---------------------------------------------------------

test("fillUsageGaps inserts idle days for dates with no entries", () => {
  const out = fillUsageGaps([
    { date: "2026-08-01", input: 10, output: 1, total: 11, turns: 1, unrecordedTurns: 0 },
    { date: "2026-08-05", input: 20, output: 2, total: 22, turns: 2, unrecordedTurns: 0 },
  ]);
  assert.deepStrictEqual(
    out.map((d) => d.date),
    ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"],
  );
  assert.deepStrictEqual(
    out.map((d) => d.state),
    ["measured", "idle", "idle", "idle", "measured"],
  );
  // Filled days must be numerically inert, not undefined - renderTokenUsage
  // divides by and sums these.
  assert.strictEqual(out[1].total, 0);
  assert.strictEqual(out[1].turns, 0);
  assert.strictEqual(out[1].unrecordedTurns, 0);
});

test("fillUsageGaps preserves an unmeasured day instead of flattening it to idle", () => {
  const out = fillUsageGaps([
    { date: "2026-08-10", input: 73579, output: 1469, total: 75048, turns: 9, unrecordedTurns: 79 },
    { date: "2026-08-11", input: 0, output: 0, total: 0, turns: 0, unrecordedTurns: 154 },
    { date: "2026-08-12", input: 1498740, output: 7449, total: 1506189, turns: 18, unrecordedTurns: 51 },
  ]);
  assert.deepStrictEqual(
    out.map((d) => d.state),
    ["measured", "unmeasured", "measured"],
  );
  // The count has to survive, since it is what the row actually says.
  assert.strictEqual(out[1].unrecordedTurns, 154);
});

test("fillUsageGaps spans a month boundary", () => {
  const out = fillUsageGaps([
    { date: "2026-07-30", total: 1, turns: 1, unrecordedTurns: 0 },
    { date: "2026-08-02", total: 1, turns: 1, unrecordedTurns: 0 },
  ]);
  assert.deepStrictEqual(
    out.map((d) => d.date),
    ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"],
  );
});

test("fillUsageGaps handles empty and single-day input", () => {
  assert.deepStrictEqual(fillUsageGaps([]), []);
  const one = fillUsageGaps([{ date: "2026-08-12", total: 5, turns: 1, unrecordedTurns: 0 }]);
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].state, "measured");
});

test("fillUsageGaps tolerates a non-array payload", () => {
  // A failed fetch shaping through as undefined must not throw inside render.
  assert.deepStrictEqual(fillUsageGaps(undefined), []);
  assert.deepStrictEqual(fillUsageGaps(null), []);
});

test("fillUsageGaps does not hang on an unparseable date", () => {
  // The guard exists because the while loop is bounded by Date.parse: NaN would
  // spin forever and wedge the tab rather than fail visibly.
  const out = fillUsageGaps([
    { date: "not-a-date", total: 1, turns: 1, unrecordedTurns: 0 },
    { date: "2026-08-12", total: 1, turns: 1, unrecordedTurns: 0 },
  ]);
  assert.strictEqual(out.length, 2, "falls back to the ungapped rows");
  assert.strictEqual(out[0].state, "measured");
});

test("fillUsageGaps does not reorder or drop when dates run backwards", () => {
  // Defensive: the route sorts by date, but a reversed payload must degrade to
  // passthrough rather than produce an empty chart.
  const out = fillUsageGaps([
    { date: "2026-08-12", total: 1, turns: 1, unrecordedTurns: 0 },
    { date: "2026-08-10", total: 1, turns: 1, unrecordedTurns: 0 },
  ]);
  assert.deepStrictEqual(
    out.map((d) => d.date),
    ["2026-08-12", "2026-08-10"],
  );
});

test("fillUsageGaps buckets on UTC, not the viewer's local day", () => {
  // The route cuts YYYY-MM-DD out of a UTC ISO timestamp. If this parsed as
  // local time, a viewer in KST (UTC+9) would see every label shift by a day.
  const prev = process.env.TZ;
  process.env.TZ = "Asia/Seoul";
  try {
    const out = fillUsageGaps([
      { date: "2026-08-10", total: 1, turns: 1, unrecordedTurns: 0 },
      { date: "2026-08-12", total: 1, turns: 1, unrecordedTurns: 0 },
    ]);
    assert.deepStrictEqual(
      out.map((d) => d.date),
      ["2026-08-10", "2026-08-11", "2026-08-12"],
    );
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

// --- contextUsedFromUsage --------------------------------------------------
//
// Replays fixtures/reviewer-usage-series.json: the REAL per-turn usage of
// agent:api-rag-reviewer:review-image-reranker-400, captured 2026-08-12 off the
// live session transcript on Server 6, unedited.
//
// That session is the one that motivated this function. `openclaw sessions list`
// showed it as "666k/262k (254%)" and it was read as a context overflow. It was
// not: the fixture proves both numbers below off the same 20 turns.

const USAGE_SERIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "reviewer-usage-series.json"), "utf8"),
);
const CONTEXT_WINDOW = 262144;

test("the 254% figure is cumulative billing, and the fixture reproduces it exactly", () => {
  // Summing every turn's prompt gives the session-level counter the percentage
  // was (wrongly) computed from. Matching sessions.json's inputTokens to the
  // token is what proves it is a running sum and not an occupancy reading.
  const cumulative = USAGE_SERIES.reduce((sum, u) => sum + u.input, 0);
  assert.strictEqual(cumulative, 665679);
  assert.ok(cumulative / CONTEXT_WINDOW > 2.5, "cumulative exceeds the window 2.5x over");
});

test("real occupancy never approached the window, and stays below the warn threshold", () => {
  const occupancy = USAGE_SERIES.map(contextUsedFromUsage).filter((n) => n !== null);
  const peak = Math.max(...occupancy);
  assert.strictEqual(peak, 45951);
  const peakPct = Math.round((peak / CONTEXT_WINDOW) * 100);
  assert.strictEqual(peakPct, 18);
  // The whole point: this session must not trip the 70% warn threshold that the
  // cumulative reading tripped on turn three and never came back under.
  assert.ok(peakPct < 70, "a healthy session must not read as near-overflow");
});

test("cumulative billing diverges from the window while occupancy stays bounded", () => {
  // The two series pulling apart IS the bug, expressed as data. Walk the turns
  // and watch the running sum cross the window and keep going while the same
  // turns' occupancy stays flat in the 30-40k band.
  let cumulative = 0;
  let crossedAt = null;
  USAGE_SERIES.forEach((u, i) => {
    cumulative += u.input;
    if (crossedAt === null && cumulative > CONTEXT_WINDOW) crossedAt = i;
    const used = contextUsedFromUsage(u);
    if (used !== null) assert.ok(used < CONTEXT_WINDOW, `turn ${i} occupancy exceeded the window`);
  });
  // Cumulative passes the window less than halfway through a routine review, so
  // any threshold hung off it fires on essentially every real session.
  assert.strictEqual(crossedAt, 8);
  assert.ok(cumulative > CONTEXT_WINDOW * 2.5);
});

test("occupancy is not monotonic, so a max() reading would be wrong", () => {
  // Turn 4 dips (34,887 -> 34,654) with no compaction involved: context does
  // shrink turn to turn as prior thinking blocks and oversized tool results drop
  // out of the next prompt. Pinned because it is the counter-example to the
  // tempting "just track the high-water mark" implementation, which would latch
  // at a peak the run has already recovered from.
  const occupancy = USAGE_SERIES.map(contextUsedFromUsage).filter((n) => n !== null);
  const dips = occupancy.filter((n, i) => i > 0 && n < occupancy[i - 1]);
  assert.ok(dips.length > 0, "expected at least one turn-to-turn dip in the real series");
  assert.strictEqual(occupancy[4], 34654);
  assert.strictEqual(occupancy[3], 34887);
});

test("aborted turns read as unknown, not as an empty context", () => {
  // The last two turns of the fixture are the aborted ones: a full set of zeros.
  // Returning 0 here would paint the indicator green at the exact moment a run
  // died, which is backwards.
  const tail = USAGE_SERIES.slice(-2);
  assert.deepStrictEqual(
    tail.map((u) => u.totalTokens),
    [0, 0],
  );
  for (const u of tail) assert.strictEqual(contextUsedFromUsage(u), null);
});

test("a CLI/cron run's real frames degrade to no reading rather than a wrong one", () => {
  // fixtures/cli-run-frames.json is a real 2026-08-06 capture of the exact
  // invocation the watcher crons use. It predates the gateway recording usage in
  // streaming (2026-08-12), so its assistant messages carry no usage at all.
  //
  // Pinned deliberately: the indicator must show nothing for these, not 0%. If a
  // future capture DOES carry usage, this test starts failing and should be
  // updated to assert the positive path - that is the intended signal, not noise.
  const frames = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "cli-run-frames.json"), "utf8"),
  );
  const assistants = frames
    .map((f) => (f.payload || {}).message)
    .filter((m) => m && m.role === "assistant");
  assert.ok(assistants.length > 0, "fixture should contain assistant messages");
  for (const m of assistants) assert.strictEqual(contextUsedFromUsage(m.usage), null);
});

test("contextUsedFromUsage prefers totalTokens, then falls back through aliases", () => {
  assert.strictEqual(contextUsedFromUsage({ totalTokens: 500, input: 400 }), 500);
  assert.strictEqual(contextUsedFromUsage({ input: 400 }), 400);
  assert.strictEqual(contextUsedFromUsage({ prompt_tokens: 300 }), 300);
  // Turns predating the gateway's usage-in-streaming support carry no usage at
  // all; so does any non-assistant message, which the gateway strips it from.
  assert.strictEqual(contextUsedFromUsage(undefined), null);
  assert.strictEqual(contextUsedFromUsage({}), null);
  assert.strictEqual(contextUsedFromUsage({ totalTokens: "45951" }), null);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tokenUsage tests passed");
