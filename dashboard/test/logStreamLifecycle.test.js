// Lifecycle test for src/logStream.js - run directly with
// `node test/logStreamLifecycle.test.js`. Hermetic: childProcess.spawn is
// faked, so this needs no sandbox, no cluster and no .env.
//
// This is the test that matters most in this feature. Confirmed live on
// Server 6 (2026-08-12): SIGKILLing the local `nemoclaw exec` client leaves
// `kubectl logs -f` running inside the sandbox indefinitely - still
// streaming, still holding its API-server connection. That is one permanent
// orphan per closed browser tab, and it is the same shape as the
// device-pairing-spam incident (a process outliving whatever created it).
//
// So what's covered here is specifically: does exactly one child exist per
// workload regardless of how many panes are watching, and does the LAST
// unsubscribe reliably both kill the local child and issue the remote reap.
// A regression in either direction is a leak (torn down too late) or a
// broken pane for another operator (torn down too early).

const assert = require("node:assert");
const path = require("node:path");
const { installFakeSpawn, makeCollector, criTs, tick, check, report } = require("./logStreamHarness");

const logStream = require(path.join(__dirname, "..", "src", "logStream.js"));
const { MAX_CONCURRENT_STREAMS } = logStream._constants;

const target = (repoKey) => ({
  repoKey,
  namespace: "dev",
  labelSelector: `app=svc-${repoKey}-dev`,
});

(async () => {
  const spawns = installFakeSpawn();

  // --- one child per workload, however many panes ------------------------
  const a = makeCollector();
  const b = makeCollector();
  const unsubA = logStream.subscribe(target("rag"), a.handlers);
  const unsubB = logStream.subscribe(target("rag"), b.handlers);
  await tick();

  check("two panes on one workload spawn ONE kubectl", () => {
    assert.strictEqual(spawns.arms.length, 1, `expected 1 arm spawn, got ${spawns.arms.length}`);
    assert.strictEqual(logStream.activeStreamCount(), 1);
  });

  check("both panes receive the same line", () => {
    spawns.lastChild().emitStdout(`[pod/rag-1/rag] ${criTs(50)} hello\n`);
    assert.deepStrictEqual(a.texts(), ["hello"]);
    assert.deepStrictEqual(b.texts(), ["hello"]);
  });

  // --- the first unsubscribe must NOT tear down --------------------------
  const child = spawns.lastChild();
  unsubA();
  check("first unsubscribe leaves the stream running for the other pane", () => {
    assert.strictEqual(child.killed, false, "child was killed while a pane still held it");
    assert.strictEqual(spawns.reaps.length, 0, "remote reap issued while a pane still held the stream");
    assert.strictEqual(logStream.activeStreamCount(), 1);
  });

  check("a released subscription stops receiving lines", () => {
    const before = a.lines.length;
    child.emitStdout(`[pod/rag-1/rag] ${criTs(51)} after-release\n`);
    assert.strictEqual(a.lines.length, before, "unsubscribed pane still received a line");
    assert.ok(b.texts().includes("after-release"), "remaining pane stopped receiving");
  });

  check("double-unsubscribe is idempotent, not a teardown of someone else's stream", () => {
    unsubA();
    assert.strictEqual(child.killed, false, "a repeated close tore down a stream another pane still holds");
    assert.strictEqual(logStream.activeStreamCount(), 1);
  });

  // --- the last unsubscribe must tear down BOTH ends ---------------------
  unsubB();
  check("last unsubscribe kills the local child", () => {
    assert.strictEqual(child.killed, true, "local child survived the last unsubscribe");
    assert.strictEqual(child.killSignal, "SIGTERM");
  });

  check("last unsubscribe issues the remote reap (the orphan guard)", () => {
    assert.strictEqual(spawns.reaps.length, 1, `expected 1 reap, got ${spawns.reaps.length}`);
    const args = spawns.reaps[0].args;
    // The pidfile must be passed as its own argv element, never interpolated
    // into the reap script - same discipline as the arming path.
    const pidPath = args[args.length - 1];
    assert.match(pidPath, /^\/tmp\/dashlogs-[0-9a-f-]+\.pid$/, `unexpected pidfile arg: ${pidPath}`);
    assert.ok(
      args.some((x) => typeof x === "string" && x.includes('rm -f "$1"')),
      "reap does not remove the pidfile",
    );
  });

  check("stream is removed from the registry after teardown", () => {
    assert.strictEqual(logStream.activeStreamCount(), 0);
  });

  // --- a torn-down stream's late exit must not resurrect it --------------
  check("a late exit from a torn-down child does not re-arm", () => {
    const armsBefore = spawns.arms.length;
    child.exitWith(124);
    assert.strictEqual(spawns.arms.length, armsBefore, "a closed stream re-armed itself");
  });
  await tick(20);
  check("...and still has not re-armed after the timer would have fired", () => {
    assert.strictEqual(logStream.activeStreamCount(), 0);
  });

  // --- the global cap ----------------------------------------------------
  const held = [];
  for (let i = 0; i < MAX_CONCURRENT_STREAMS; i += 1) {
    held.push(logStream.subscribe(target(`repo${i}`), makeCollector().handlers));
  }
  check(`${MAX_CONCURRENT_STREAMS} concurrent streams are allowed`, () => {
    assert.strictEqual(logStream.activeStreamCount(), MAX_CONCURRENT_STREAMS);
  });

  check("one more NEW stream is rejected with a typed, actionable error", () => {
    assert.throws(
      () => logStream.subscribe(target("one-too-many"), makeCollector().handlers),
      (err) => {
        assert.strictEqual(err.code, "STREAM_LIMIT", `expected code STREAM_LIMIT, got ${err.code}`);
        assert.match(err.message, /close a pane/, "error message gives the operator no way forward");
        return true;
      },
    );
  });

  check("joining an EXISTING stream is still allowed at the cap", () => {
    // Joining costs no new child, so the cap must not block it - otherwise
    // a second operator is locked out of a workload already being watched.
    const extra = logStream.subscribe(target("repo0"), makeCollector().handlers);
    assert.strictEqual(logStream.activeStreamCount(), MAX_CONCURRENT_STREAMS);
    extra();
  });

  // --- shutdownAll -------------------------------------------------------
  const reapsBefore = spawns.reaps.length;
  logStream.shutdownAll();
  check("shutdownAll tears down every stream and reaps each one remotely", () => {
    assert.strictEqual(logStream.activeStreamCount(), 0);
    assert.strictEqual(
      spawns.reaps.length - reapsBefore,
      MAX_CONCURRENT_STREAMS,
      "not every stream was reaped on shutdown",
    );
  });

  held.forEach((fn) => fn()); // must not throw or double-reap
  check("unsubscribing after shutdownAll is harmless", () => {
    assert.strictEqual(logStream.activeStreamCount(), 0);
  });

  spawns.restore();
  report();
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
