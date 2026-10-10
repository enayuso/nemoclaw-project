// Standalone test for public/monitoringPanes.js - run directly with
// `node test/monitoringPanes.test.js`, same convention as every other test
// here (this project ships no test-runner dependency by deliberate v1 design).
//
// Requires the real browser-served file, not a reimplementation.
//
// Phase 4 of docs/monitoring-live-logs.md. Three of these guards exist for
// specific failures this feature has already produced or narrowly avoided:
//
//   1. The §2.7 timestamp form. The runtime writes a LOCAL OFFSET with
//      nanosecond precision, never a "Z". A fixture that uses "Z" because it
//      is easier is exactly what let the backend ship a parse that matched
//      zero real lines, under four passing tests. The same shortcut is
//      available here, so the same guard is here.
//   2. Time is read from the STRING, never through Date. Rendering a log line
//      at a different wall-clock than `kubectl logs` shows for the same line
//      would make the dashboard and the terminal disagree about when
//      something happened, which is worse than showing no time at all.
//   3. No `{t:"error"}` frame exists (§4.5). A failure is a STATE, so a pane
//      joining after one is still told; a one-shot error event would be
//      invisible to exactly that pane. This pins the decision so it does not
//      get "restored" as a gap.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  PANE_LINE_LIMIT,
  MAX_PANES,
  gridClassFor,
  canAddPane,
  describePaused,
  compileErrorPattern,
  rowSeverityClass,
  formatLogTime,
  formatGap,
  podShortName,
  describeControlFrame,
  describeTargetOption,
  paneMetaText,
  describeLimits,
} = require("../public/monitoringPanes.js");

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

// --- formatLogTime ---------------------------------------------------------

test("formatLogTime reads the real CRI form: local offset, nanoseconds", () => {
  // Verbatim from the live rag pod, 2026-08-12.
  assert.strictEqual(formatLogTime("2026-08-12T18:27:55.069321272+09:00"), "18:27:55.069");
});

test("formatLogTime shows the log's own wall-clock, not the viewer's zone", () => {
  // The load-bearing assertion. These two timestamps name DIFFERENT instants
  // and identical clock faces; anything that routes through Date (parse then
  // toLocaleTimeString, getHours, an offset conversion) renders them
  // differently in every timezone on earth. Reading the string keeps the pane
  // agreeing with what `kubectl logs --timestamps` prints for the same line,
  // which is the only reference an operator can cross-check against.
  assert.strictEqual(
    formatLogTime("2026-08-12T18:27:55.069321272+09:00"),
    formatLogTime("2026-08-12T18:27:55.069Z"),
  );
});

test("formatLogTime handles a timestamp with no fractional part", () => {
  assert.strictEqual(formatLogTime("2026-08-12T18:27:55+09:00"), "18:27:55");
});

test("formatLogTime returns null rather than a placeholder for a missing one", () => {
  // logStream legitimately emits ts: null for a line the runtime wrote
  // without a timestamp - parseLine shape-checks before trusting one. A row
  // with an empty time cell reads far better than one claiming "Invalid Date".
  assert.strictEqual(formatLogTime(null), null);
  assert.strictEqual(formatLogTime(undefined), null);
  assert.strictEqual(formatLogTime(""), null);
  assert.strictEqual(formatLogTime("INFO: request served"), null);
  assert.strictEqual(formatLogTime("2026-08-12"), null);
});

// --- podShortName ----------------------------------------------------------

test("podShortName keeps the segment that changes when a pod is replaced", () => {
  assert.strictEqual(podShortName("api-rag-7d9f8b6c4-xyz12"), "xyz12");
  // A bare name with no dashes is already short enough to show whole.
  assert.strictEqual(podShortName("apirag"), "apirag");
  assert.strictEqual(podShortName(null), null);
  assert.strictEqual(podShortName(""), null);
});

// --- formatGap -------------------------------------------------------------

test("formatGap keeps sub-second gaps distinguishable from a real outage", () => {
  // The cap re-arms immediately, so routine reattach gaps are milliseconds. If
  // those rendered as "0s" alongside a genuine multi-minute outage, the
  // divider would stop carrying the one thing it exists to carry.
  assert.strictEqual(formatGap(0), "0ms");
  assert.strictEqual(formatGap(412), "412ms");
  assert.strictEqual(formatGap(2000), "2.0s");
  assert.strictEqual(formatGap(30000), "30.0s");
  assert.strictEqual(formatGap(184000), "3m 04s");
  assert.strictEqual(formatGap(null), null);
  assert.strictEqual(formatGap(-1), null);
});

// --- describeControlFrame --------------------------------------------------

test("a routine cap reattach renders as a plain divider, not an alarm", () => {
  const note = describeControlFrame({ t: "reattach", reason: "timeout-cap", gapMs: 0 });
  assert.strictEqual(note.tone, "muted");
  assert.strictEqual(note.text, "stream reattached");
});

test("a reattach after a real gap says how long it was", () => {
  const note = describeControlFrame({ t: "reattach", reason: "stream-ended", gapMs: 184000 });
  assert.match(note.text, /3m 04s/);
});

test("an error reattach is toned up and carries kubectl's own message", () => {
  const note = describeControlFrame({
    t: "reattach",
    reason: "error",
    gapMs: 2000,
    detail: 'error: no matching resources found',
  });
  assert.strictEqual(note.tone, "warn");
  assert.match(note.text, /no matching resources found/);
});

test("throttling is reported, never silent", () => {
  // §5.2: dropping visibly is the point. A silently thinned pane is the same
  // class of lie as a silently dead one.
  const note = describeControlFrame({ t: "throttled", dropped: 1432 });
  assert.strictEqual(note.tone, "warn");
  assert.match(note.text, /1,432 lines dropped/);
});

test("a failed status carries the stderr that says WHY", () => {
  const note = describeControlFrame({
    t: "status",
    state: "failed",
    detail: 'Error from server (Forbidden): pods is forbidden',
  });
  assert.strictEqual(note.tone, "fail");
  assert.match(note.text, /Forbidden/);
});

test("a failed status with no detail still renders something readable", () => {
  const note = describeControlFrame({ t: "status", state: "failed", detail: null });
  assert.strictEqual(note.tone, "fail");
  assert.match(note.text, /no detail reported/);
});

test("connecting/live add no row, so a healthy stream cannot spam the pane", () => {
  // The client-side half of the §4.5 correction: the cap fires every 900s
  // forever on a HEALTHY stream. A row per state change would put a divider in
  // the log every 15 minutes for the life of the pane, and an indicator that
  // cries wolf on schedule is one the operator stops reading.
  assert.strictEqual(describeControlFrame({ t: "status", state: "connecting" }), null);
  assert.strictEqual(describeControlFrame({ t: "status", state: "live" }), null);
});

test("there is no error frame to render (§4.5)", () => {
  // Not an oversight - logStream never emits {t:"error"}. Handling one here
  // would be handling a frame that never arrives, and would suggest the
  // failure path is covered by something other than status/failed, which is
  // what a late-joining pane actually receives.
  assert.strictEqual(describeControlFrame({ t: "error", detail: "boom" }), null);
  assert.strictEqual(describeControlFrame(null), null);
  assert.strictEqual(describeControlFrame({}), null);
});

test("every frame type logStream emits is one the pane knows about", () => {
  // Contract check against the real module's source rather than a restated
  // list, so adding a frame type in a later phase without teaching the pane
  // about it fails here instead of being silently swallowed in the browser.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "logStream.js"), "utf8");
  const emitted = new Set([...src.matchAll(/\bt:\s*"([a-z]+)"/g)].map((m) => m[1]));
  assert.ok(emitted.size >= 4, `expected to find logStream's frame types, found ${[...emitted]}`);
  const known = new Set(["line", "reattach", "throttled", "status"]);
  for (const type of emitted) {
    assert.ok(known.has(type), `logStream emits {t:"${type}"} which no pane code handles`);
  }
});

// --- describeTargetOption / paneMetaText -----------------------------------

test("an unstreamable workload is listed and disabled, never filtered out", () => {
  // Same reasoning §4.6 gives for the endpoint: a workload simply absent from
  // the picker is a dead end nobody can debug; one that says why explains
  // itself.
  const opt = describeTargetOption({
    repoKey: "legacy-thing",
    displayName: "Legacy Thing",
    streamable: false,
    unstreamableReason: 'runtime type "docker" cannot be log-streamed (only k8s can)',
  });
  assert.ok(opt, "unstreamable target must still produce a picker entry");
  assert.strictEqual(opt.disabled, true);
  assert.match(opt.label, /Legacy Thing/);
  assert.match(opt.title, /docker/);
});

test("a streamable workload shows its namespace and selector on hover", () => {
  const opt = describeTargetOption({
    repoKey: "api-rag",
    displayName: "api-rag",
    streamable: true,
    namespace: "dev",
    labelSelector: "app=api-rag",
  });
  assert.strictEqual(opt.disabled, false);
  assert.strictEqual(opt.value, "api-rag");
  assert.strictEqual(opt.title, "dev · app=api-rag");
});

test("paneMetaText surfaces a disabled watcher without hiding the workload", () => {
  const meta = paneMetaText({
    namespace: "dev",
    labelSelector: "app=api-rag",
    monitoringEnabled: false,
  });
  assert.strictEqual(meta, "dev · app=api-rag · watcher off");
});

test("paneMetaText never renders undefined for a half-populated target", () => {
  assert.strictEqual(paneMetaText({ namespace: "dev", monitoringEnabled: true }), "dev");
  assert.strictEqual(paneMetaText(null), "");
});

// --- describeLimits --------------------------------------------------------

test("the limits line explains the periodic divider before it appears", () => {
  // A healthy pane showing a reattach every 15 minutes is otherwise
  // indistinguishable from one that keeps breaking.
  const text = describeLimits({ maxConcurrentStreams: 8, streamTimeoutSeconds: 900 });
  assert.match(text, /8 streams/);
  assert.match(text, /every 15 min/);
  assert.strictEqual(describeLimits(null), "");
});

test("the client ring buffer is bounded", () => {
  // §6.3. Without a cap a pane left open all day is an unbounded DOM leak, and
  // a workload at logStream's own 200 lines/s ceiling reaches this in ten
  // seconds.
  assert.strictEqual(typeof PANE_LINE_LIMIT, "number");
  assert.ok(PANE_LINE_LIMIT > 0 && PANE_LINE_LIMIT <= 5000);
});

// --- the pane grid (phase 5) -----------------------------------------------

test("gridClassFor names one layout per pane count and clamps past the cap", () => {
  assert.strictEqual(gridClassFor(0), "panes-0");
  assert.strictEqual(gridClassFor(1), "panes-1");
  assert.strictEqual(gridClassFor(3), "panes-3");
  assert.strictEqual(gridClassFor(4), "panes-4");
  // Clamped rather than allowed to name a class that has no rule: a
  // "panes-5" would silently fall back to the base grid, which is a
  // one-column layout for five panes.
  assert.strictEqual(gridClassFor(9), `panes-${MAX_PANES}`);
  assert.strictEqual(gridClassFor(-1), "panes-0");
});

test("canAddPane refuses the three cases with three different remedies", () => {
  const target = {
    repoKey: "api-rag",
    displayName: "Demo RAG",
    streamable: true,
    namespace: "dev",
    labelSelector: "app=api-rag",
  };

  assert.deepStrictEqual(canAddPane([], target), { ok: true, reason: null });

  // Already open. Not a resource problem - logStream shares one child between
  // subscribers on the same repoKey - but two panes showing identical output
  // waste half the grid.
  const dupe = canAddPane(["api-rag"], target);
  assert.strictEqual(dupe.ok, false);
  assert.match(dupe.reason, /already open/);

  // At the limit. The remedy is closing a pane, and the message has to say so
  // or a disabled option is just an unexplained dead control.
  const full = canAddPane(["a", "b", "c", "d"], target);
  assert.strictEqual(full.ok, false);
  assert.match(full.reason, /close one first/);

  // Unstreamable. The remedy is neither of the above, which is why this is a
  // third message rather than one generic refusal.
  const bad = canAddPane([], {
    repoKey: "legacy",
    streamable: false,
    unstreamableReason: 'runtime type "docker" cannot be log-streamed (only k8s can)',
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /docker/);

  assert.strictEqual(canAddPane([], null).ok, false);
});

test("canAddPane checks the duplicate before the limit", () => {
  // Ordering matters for what the operator is told: at four panes, asking for
  // one that is ALREADY one of those four should say it is already open, not
  // tell them to close something to make room for a pane they have.
  const target = { repoKey: "api-rag", streamable: true };
  const verdict = canAddPane(["api-rag", "b", "c", "d"], target);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /already open/);
});

test("a paused pane says how much it is holding back", () => {
  // §6.3 keeps the stream and the buffer running through a pause precisely so
  // resuming shows the gap rather than a hole. The count is what warns the
  // operator the gap is there before they resume into it - and a paused pane
  // with no count looks exactly like a dead one.
  assert.strictEqual(describePaused(0), "Paused");
  assert.strictEqual(describePaused(1), "Paused · 1 line buffered");
  assert.strictEqual(describePaused(1432), "Paused · 1,432 lines buffered");
  // At the cap the buffer is dropping its own oldest, so the count stops being
  // exact and says so rather than quietly under-reporting.
  assert.match(describePaused(PANE_LINE_LIMIT), /\+ lines buffered/);
});

// --- severity tinting (phase 6, §6.4) --------------------------------------

test("the registry's own error_pattern tints matching lines", () => {
  // The pattern all 7 registered repos carry today.
  const re = compileErrorPattern("ERROR|CRITICAL|Traceback|Exception");
  assert.strictEqual(rowSeverityClass(re, "ERROR:    embed failed"), "log-row-alert");
  assert.strictEqual(rowSeverityClass(re, "Traceback (most recent call last):"), "log-row-alert");
  assert.strictEqual(rowSeverityClass(re, 'INFO:  "GET /rag/health HTTP/1.1" 200 OK'), null);
});

test("a malformed error_pattern costs tinting, not the pane", () => {
  // `error_pattern` is free text in repos.json. A typo there must not be able
  // to throw on every rendered line of a workload's logs.
  assert.strictEqual(compileErrorPattern("ERROR|["), null);
  assert.strictEqual(compileErrorPattern(""), null);
  assert.strictEqual(compileErrorPattern("   "), null);
  assert.strictEqual(compileErrorPattern(null), null);
  assert.strictEqual(compileErrorPattern(undefined), null);
  // ...and a pane with no usable pattern simply never tints.
  assert.strictEqual(rowSeverityClass(null, "ERROR: boom"), null);
});

test("tinting is stateless across lines", () => {
  // The bug this pins: a `g`-flagged regex carries lastIndex between .test()
  // calls, so an identical line would match, then not match, then match. That
  // reads as flaky highlighting rather than as a bug, which is why it is
  // worth a test rather than a comment alone.
  const re = compileErrorPattern("ERROR");
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(rowSeverityClass(re, "ERROR: same line every time"), "log-row-alert");
  }
});

test("the pattern is applied exactly as the operator authored it", () => {
  // Case-sensitive. Adding an `i` flag would silently widen a pattern someone
  // wrote for their own logs, and the registry entry is the authority on what
  // counts as an error line for that workload.
  const re = compileErrorPattern("ERROR");
  assert.strictEqual(rowSeverityClass(re, "ERROR: real"), "log-row-alert");
  assert.strictEqual(rowSeverityClass(re, "error: lowercase"), null);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall monitoringPanes tests passed");
