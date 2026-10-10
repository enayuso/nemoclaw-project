// Reattach test for src/logStream.js - run directly with
// `node test/logStreamReattach.test.js`. Hermetic.
//
// A `kubectl logs -f -l <selector>` stream ends for three different reasons
// and this module has to survive all three without the operator losing the
// pane or being lied to about a gap:
//
// 1. The `timeout` cap fires (exit 124). Expected, every 15 minutes. That
//    cap exists because a killed client orphans the sandbox-side kubectl
//    forever - confirmed live 2026-08-12 - so it is not negotiable.
// 2. The pods it was following went away (rollout, rescheduling). `-f` with
//    a selector resolves its pod list ONCE at start, so the stream can end
//    or go silent while the workload is perfectly healthy. This is the
//    blind-monitoring failure mode: a pane that looks fine and shows
//    nothing is worse than one that shows an error.
// 3. It never started - bad selector, tunnel down, RBAC expired.
//
// Cases 1 and 2 share a mechanism (re-arm from the last timestamp), which
// is deliberate: re-arming re-resolves the label selector, so the orphan
// guard IS the pod-restart recovery. Case 3 must NOT reconnect forever -
// it has to give up visibly and say why.
//
// The de-duplication tested below exists because --since-time is inclusive:
// without it, every reattach re-shows the last line the operator already
// read, which over a long session is a steady drip of phantom repeats.

const assert = require("node:assert");
const path = require("node:path");
const { installFakeSpawn, makeCollector, k8sLine, criTs, tick, check, report } = require("./logStreamHarness");

const logStream = require(path.join(__dirname, "..", "src", "logStream.js"));
const { MAX_START_FAILURES, BACKOFF_MS } = logStream._constants;

// Shorten the production backoff (2s/4s/8s/16s/30s) in place - onExit()
// indexes this same array object, so this exercises the real code path
// without spending 30 real seconds on it. Mutation, not replacement: a
// reassignment here would not reach the module's own reference.
BACKOFF_MS.fill(1);

const target = {
  repoKey: "rag",
  namespace: "dev",
  labelSelector: "app=svc-rag-dev",
  tail: 200,
};

// Real CRI format - local offset, nanosecond precision. See criTs's comment.
const TS1 = criTs(50, 100000000);
const TS2A = criTs(55, 11000000);
const TS2 = criTs(55, 69321272);

(async () => {
  const spawns = installFakeSpawn();

  // === case 1: the timeout cap fires ======================================
  const c = makeCollector();
  const unsub = logStream.subscribe(target, c.handlers);
  await tick();

  // TS2A and TS2 share a second at different nanoseconds - the case the
  // whole-second de-dup window below turns on.
  spawns
    .lastChild()
    .emitStdout(`${k8sLine(TS1, "first")}\n${k8sLine(TS2A, "second-early")}\n${k8sLine(TS2, "second")}\n`);

  check("a timestamp in the real CRI format (local offset) is parsed", () => {
    // The regression this guards: requiring a trailing "Z" parsed a timestamp
    // off zero real lines, and everything downstream - --since-time,
    // de-duplication - quietly degraded to nothing while the pane still
    // looked healthy.
    assert.strictEqual(c.lines[0].ts, TS1, "the offset-form timestamp was not recognised");
    assert.strictEqual(c.lines[0].text, "first", "the timestamp was left in the message text");
  });

  check("first arming uses --tail, not --since-time", () => {
    const args = spawns.arms[0].args;
    assert.ok(args.includes("--tail=200"));
    assert.ok(!args.some((a) => String(a).startsWith("--since-time")));
  });

  const capChild = spawns.lastChild();
  capChild.exitWith(124); // timeout(1)'s own "command timed out" code
  await tick(20);

  check("cap expiry re-arms the stream", () => {
    assert.strictEqual(spawns.arms.length, 2, "stream did not re-arm after the timeout cap");
  });

  check("the reattach is reported as timeout-cap, not as an error", () => {
    const re = c.controlOfType("reattach");
    assert.strictEqual(re.length, 1, `expected 1 reattach frame, got ${re.length}`);
    assert.strictEqual(re[0].reason, "timeout-cap");
    assert.strictEqual(re[0].detail, null, "an expected cap expiry should carry no error detail");
  });

  check("a routine cap expiry does not flick the pane's health state", () => {
    // The cap fires every STREAM_TIMEOUT_SECONDS forever on a HEALTHY stream.
    // Reporting "retrying" each time would flick the pane indicator every 15
    // minutes for the life of the pane, and an indicator that cries wolf on
    // schedule is one the operator stops reading. The reattach frame above,
    // carrying the gap, is what reports a routine re-arm.
    assert.strictEqual(
      c.controlOfType("status").filter((s) => s.state === "retrying").length,
      0,
      "an expected re-arm reported 'retrying'",
    );
  });

  check("re-arming resumes from the last line seen, not from --tail", () => {
    // --tail on a reattach would re-show 200 old lines every 15 minutes; a
    // bare restart with no --since-time would silently lose the gap.
    const args = spawns.arms[1].args;
    assert.ok(args.includes(`--since-time=${TS2}`), `expected --since-time=${TS2} in: ${args.join(" ")}`);
    assert.ok(!args.some((a) => String(a).startsWith("--tail")), "--tail should not be sent on a reattach");
  });

  check("re-arming re-resolves the selector (this is the pod-restart fix)", () => {
    const selIdx = spawns.arms[1].args.indexOf("-l");
    assert.strictEqual(spawns.arms[1].args[selIdx + 1], target.labelSelector);
  });

  // --- the inclusive-overlap de-duplication ------------------------------
  //
  // The overlap is a WHOLE SECOND wide, not a single line. kubectl takes
  // --since-time to nanosecond precision but it travels as a metav1.Time,
  // which carries seconds only, so the API server floors it. Verified live
  // 2026-08-12: asking from ...55.999999999+09:00 - strictly after a line at
  // ...55.069321272 - still returned that line. So a reattach replays every
  // line from the resume second, at differing nanosecond timestamps.
  let linesBefore = c.lines.length;
  spawns.lastChild().emitStdout(`${k8sLine(TS2A, "second-early")}\n`);
  check("a replayed line EARLIER in the resume second is suppressed", () => {
    // Keyed on the exact timestamp instead, this line would not match, would
    // be delivered as new, AND would close the window early - letting the
    // rest of the replayed second through behind it.
    assert.strictEqual(c.lines.length, linesBefore, "a phantom repeat reached the pane");
  });

  spawns.lastChild().emitStdout(`${k8sLine(TS2, "second")}\n`);
  check("...and so is the boundary line --since-time necessarily re-sends", () => {
    assert.strictEqual(c.lines.length, linesBefore, "the window closed early and let the boundary line through");
  });

  check("a DIFFERENT line within the resume second is NOT suppressed", () => {
    // Two pods can log in the same nanosecond, and a second is a long time in
    // a busy pod; a window that ate everything in it would silently drop real
    // content on every reattach.
    spawns.lastChild().emitStdout(`${k8sLine(TS2, "second-but-different")}\n`);
    assert.ok(c.texts().includes("second-but-different"), "de-dup swallowed a genuinely new line");
  });

  check("normal lines flow again after the overlap window closes", () => {
    spawns.lastChild().emitStdout(`${k8sLine(criTs(56), "third")}\n`);
    assert.ok(c.texts().includes("third"));
  });

  // Reattaching twice must not re-show what the first reattach legitimately
  // delivered, so lines admitted while a window was open have to be tracked
  // into the next one rather than merely passed through.
  linesBefore = c.lines.length;
  spawns.lastChild().exitWith(124);
  await tick(20);

  check("the next reattach resumes from the newest line, not the previous resume point", () => {
    assert.ok(
      spawns.arms[2].args.includes(`--since-time=${criTs(56)}`),
      `expected --since-time=${criTs(56)} in: ${spawns.arms[2].args.join(" ")}`,
    );
  });

  check("a line delivered after the previous window closed is still de-duplicated", () => {
    spawns.lastChild().emitStdout(`${k8sLine(criTs(56), "third")}\n`);
    assert.strictEqual(c.lines.length, linesBefore, "the same line surfaced twice across two reattaches");
  });

  // === case 2: the stream just ends =======================================
  spawns.lastChild().exitWith(0);
  await tick(20);

  check("a clean exit is reported as stream-ended and still re-arms", () => {
    const re = c.controlOfType("reattach");
    assert.strictEqual(re[re.length - 1].reason, "stream-ended");
    assert.strictEqual(spawns.arms.length, 4, "a stream that ended on its own was not re-armed");
  });

  unsub();

  // === case 3: it never starts ============================================
  const f = makeCollector();
  const unsubF = logStream.subscribe({ ...target, repoKey: "broken" }, f.handlers);
  await tick();

  const armsAtStart = spawns.arms.length;
  // Fail immediately and repeatedly - a non-zero exit inside the startup
  // grace window is a start failure, not a stream that ran and ended.
  for (let i = 0; i < MAX_START_FAILURES; i += 1) {
    const child = spawns.lastChild();
    child.emitStderr('Error from server (Forbidden): pods is forbidden\n');
    child.exitWith(1);
    await tick(15);
  }

  check("a failing stream stops retrying instead of reconnecting forever", () => {
    const attempts = spawns.arms.length - armsAtStart;
    assert.ok(
      attempts < MAX_START_FAILURES + 1,
      `stream kept retrying past its budget (${attempts} extra attempts)`,
    );
  });

  check("a re-arm after an actual FAILURE does report retrying", () => {
    // The other half of the check above: suppressing the state change for a
    // routine cap must not suppress it for a stream that is genuinely
    // struggling, or the pane goes quietly amber-less while it burns its
    // retry budget.
    assert.ok(
      f.controlOfType("status").some((s) => s.state === "retrying"),
      "a failing stream never reported retrying",
    );
  });

  check("it ends in a failed state carrying kubectl's own message", () => {
    const status = f.controlOfType("status");
    const last = status[status.length - 1];
    assert.strictEqual(last.state, "failed", `expected state failed, got ${last.state}`);
    assert.match(
      last.detail || "",
      /Forbidden/,
      "the operator is told the stream failed but not why - the detail is what distinguishes 'no logs' from 'monitoring is blind'",
    );
  });

  check("stderr noise is only surfaced on an actual failure", () => {
    // nemoclaw writes "Active gateway set to ..." to stderr on EVERY
    // invocation, so anything treating non-empty stderr as an error would
    // report a failure on every healthy stream. Waiting for a non-zero exit
    // is what avoids having to classify that noise at all.
    assert.strictEqual(
      c.controlOfType("status").filter((s) => s.state === "failed").length,
      0,
      "the healthy stream was reported as failed",
    );
  });

  unsubF();
  spawns.restore();
  report();
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
