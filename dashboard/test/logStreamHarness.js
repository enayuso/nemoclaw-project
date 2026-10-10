// logStreamHarness.js - shared fake-spawn rig for the four logStream tests.
// Not a test itself (no .test.js suffix, nothing runs it directly).
//
// Factored out rather than repeated four times: every logStream test needs
// the same fake child process, and a copy per file would drift the moment
// one of them is updated for a real behaviour change.
//
// The fake replaces childProcess.spawn AFTER logStream.js is required,
// which only works because logStream.js calls `childProcess.spawn(...)` as
// a property lookup at call time rather than destructuring `const { spawn }`
// at require time. That is deliberate on both sides - see logStream.js's own
// comment in arm(), and the capture-timing gotcha wsRelayAuth.test.js's
// header documents for the same class of stub.

const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

// The reap command logStream.js issues on teardown - used to tell a reap
// spawn apart from a stream-arming spawn, since both go through the same
// nemoclaw binary.
const REAP_MARKER = 'kill "$(cat "$1" 2>/dev/null)"';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.killSignal = null;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };
  child.unref = () => {};

  // Convenience helpers the tests drive the stream with.
  child.emitStdout = (text) => child.stdout.emit("data", text);
  child.emitStderr = (text) => child.stderr.emit("data", text);
  child.exitWith = (code, signal) => child.emit("exit", code, signal || null);
  return child;
}

function installFakeSpawn() {
  const real = childProcess.spawn;
  const arms = []; // stream-arming spawns: { args, child }
  const reaps = []; // teardown reap spawns: { args }

  childProcess.spawn = (bin, args, opts) => {
    const child = makeFakeChild();
    const isReap = args.some((a) => typeof a === "string" && a.includes(REAP_MARKER));
    if (isReap) reaps.push({ bin, args, opts, child });
    else arms.push({ bin, args, opts, child });
    return child;
  };

  return {
    arms,
    reaps,
    lastArm: () => arms[arms.length - 1],
    lastChild: () => arms[arms.length - 1].child,
    restore: () => {
      childProcess.spawn = real;
    },
  };
}

// Most assertions here are about what happens after an event loop turn or a
// 0ms timer, not about wall-clock duration.
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Collects everything a subscriber is handed, so a test can assert on the
// sequence rather than on one frame at a time.
function makeCollector() {
  const lines = [];
  const control = [];
  return {
    lines,
    control,
    handlers: {
      onLine: (f) => lines.push(f),
      onControl: (f) => control.push(f),
    },
    controlOfType: (t) => control.filter((f) => f.t === t),
    texts: () => lines.map((l) => l.text),
  };
}

// A kubectl line as it really arrives with --prefix --timestamps, so the
// tests exercise the actual parse path rather than a simplified one.
function k8sLine(ts, text, pod = "rag-abc123", container = "rag") {
  return `[pod/${pod}/${container}] ${ts} ${text}`;
}

// The timestamp format the cluster's container runtime ACTUALLY writes:
// RFC3339 with nanosecond precision and a LOCAL OFFSET - never a UTC "Z".
// Captured verbatim from the live rag pod 2026-08-12:
//   2026-08-12T18:27:55.069321272+09:00
//
// The tests build timestamps through here deliberately. An earlier round of
// them used "...Z" instead, which is what allowed a parse bug that dropped
// the timestamp off every single real line - disabling --since-time
// continuity and reattach de-duplication outright - to sit under all four
// files passing green. A fixture that is more convenient than the real thing
// buys nothing.
function criTs(second, nanos = 0) {
  const ss = String(second).padStart(2, "0");
  return `2026-08-12T18:27:${ss}.${String(nanos).padStart(9, "0")}+09:00`;
}

let checks = 0;
let failures = 0;

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`PASS: ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL: ${label}\n      ${err.message}`);
  }
}

function report() {
  console.log("");
  if (failures) {
    console.log(`${failures} of ${checks} FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} TESTS PASSED`);
}

module.exports = {
  installFakeSpawn,
  makeCollector,
  k8sLine,
  criTs,
  tick,
  check,
  report,
  REAP_MARKER,
};
