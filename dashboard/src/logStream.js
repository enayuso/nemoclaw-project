// logStream.js - live `kubectl logs -f` streaming out of the sandbox, for
// the Monitoring view. See docs/monitoring-live-logs.md for the full plan;
// this file is phase 1 of it (no HTTP, no WebSocket, no UI).
//
// Split into its own module for the same reason sandboxFile.js was: it has
// no dependency on config/auth/gatewayClient, so the tests can require it
// directly without a populated .env - which requiring anything that pulls
// in config.js would demand (that exits the process on any machine that
// isn't Server 6).
//
// Four things were confirmed live on Server 6 (2026-08-12) that this
// module's whole shape follows from. Each is load-bearing:
//
// 1. `docker exec` CANNOT reach the k8s tunnel - it lands in a different
//    network context and gets "dial tcp 127.0.0.1:16443: connect:
//    connection refused" while watchers query the cluster fine seconds
//    either side. Only `nemoclaw <sandbox> exec --` works. routes/ops.js
//    uses docker exec for most of its sandbox work; copying that here
//    would fail outright. (Already documented behaviour, re-confirmed.)
//
// 2. `nemoclaw exec` DOES stream stdout incrementally - a line every 3s
//    arrived every 3s, not buffered until exit. That's what makes this
//    feature possible at all, and why this uses spawn() rather than the
//    execFileAsync() every other sandbox call in this dashboard uses:
//    `logs -f` never exits on its own, so awaiting it would hang forever.
//
// 3. Killing the local client ORPHANS the sandbox-side process. SIGKILL of
//    the nemoclaw client left `kubectl logs -f` running indefinitely inside
//    the sandbox - still streaming, still holding its API-server
//    connection. One permanent leak per closed browser tab. This is the
//    same shape as the device-pairing-spam incident (a process outliving
//    whatever created it) and is the single largest risk here.
//
// 4. The mitigation below is verified in BOTH halves: `kill $(cat pidfile)`
//    reaps both processes (exec preserves the PID, and timeout forwards the
//    signal to kubectl), AND with no cleanup at all the `timeout` expires
//    on its own leaving nothing behind. So orphans stay bounded even if
//    this process is SIGKILLed and never runs its own teardown.
//
// Worth recording what does NOT work, so it isn't retried: tagging the
// process with an env-var marker (`STREAM_ID=x exec timeout ...`) and
// reaping it with `pkill -f x`. An env-var prefix never reaches argv, so
// pkill matches nothing and the process survives. The pidfile is what makes
// teardown deterministic.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");

// Matches routes/ops.js's own constants - same reasoning, documented there
// in full. Briefly: nemoclaw by FULL path because the nemoclaw-dashboard
// systemd unit's PATH has no ~/.local/bin (unlike an interactive shell,
// which sources .bashrc), and NEMOCLAW_GATEWAY_PORT explicitly because
// without it nemoclaw resolves a hardcoded default gateway name, fails to
// find it, then reports this running sandbox as "does not exist".
const SANDBOX = "ops-nemoclaw";
const NEMOCLAW_BIN = "/home/ops-s006/.local/bin/nemoclaw";
const NEMOCLAW_ENV = { ...process.env, NEMOCLAW_GATEWAY_PORT: "8180" };

const KUBECTL = "/sandbox/.local/bin/kubectl";
const KUBECONFIG = "/sandbox/.kube/config";

// The orphan backstop from finding 3/4 above, AND the re-arm cadence.
// These are deliberately the same number and must not be separated:
// `kubectl logs -f -l <selector>` resolves its pod list ONCE at stream
// start, so a rollout leaves the stream following a dead pod and the pane
// goes silently blind. Re-arming re-resolves the selector, which is what
// picks rescheduled pods back up. Raising this for "fewer reconnects"
// therefore degrades BOTH the leak bound and the pod-restart recovery at
// once - it is not a free efficiency knob.
const STREAM_TIMEOUT_SECONDS = 900;

// Stream count, not pod count (kubectl's own --max-log-requests caps pods
// per stream separately). Four panes for one operator plus headroom for a
// second watching different workloads.
const MAX_CONCURRENT_STREAMS = 8;

// So a pane opening mid-stream gets immediate context instead of a blank
// box. Same evict-oldest-first policy as wsRelay.js's event buffer, for the
// same reason: whoever is catching up cares about recent activity, not the
// start of a long stream.
const RING_MAX_LINES = 500;
const RING_MAX_BYTES = 256 * 1024;

// Above this, drop lines and count them. A chatty pod can otherwise push
// more than a browser can render. Dropping VISIBLY is the point - see
// emitThrottled; a silently truncated pane is the same failure as a
// silently dead one.
const LINE_RATE_LIMIT = 200; // lines per second, per stream
const RATE_WINDOW_MS = 1000;

// A non-zero exit sooner than this means the stream never really started
// (bad selector, tunnel down, RBAC expired) rather than a stream that ran
// and ended. The two get different handling: backoff + a failure count for
// the former, immediate re-arm for the latter.
const STARTUP_GRACE_MS = 5000;
const MAX_START_FAILURES = 5;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

// Cap on the reattach de-dup window (see handleLine). The window holds one
// hash per line seen in the current second, and it is populated BEFORE the
// rate limiter - deliberately, so that a line dropped for rate reasons is
// still recognised as a duplicate if a reattach replays it. That means a pod
// emitting far above LINE_RATE_LIMIT would otherwise grow this set to a full
// unthrottled second of output. Past the cap, tracking simply stops: the cost
// is a few phantom repeats on the next reattach, which is a much better
// failure than unbounded memory driven by pod chatter.
const DEDUP_MAX_HASHES = 2000;

const IDLE_SWEEP_MS = 60 * 1000;

// Only the tail of stderr is kept, and only reported if the child actually
// exits non-zero. nemoclaw writes its own "Active gateway set to ..." noise
// to stderr on every single invocation, so treating stderr-is-non-empty as
// an error would report a failure on every healthy stream. Waiting for the
// exit code avoids having to classify that noise at all.
const STDERR_TAIL_BYTES = 4096;

// repoKey -> stream. One child per workload, NOT per pane: two operators
// watching the same workload share one kubectl, mirroring how wsRelay.js
// fans a single gatewayClient.subscribe() out to many browser sockets.
const streams = new Map();

function nowMs() {
  return Date.now();
}

// RFC3339 as the container runtime actually writes it: either a UTC "Z" or a
// numeric offset, with any number of fractional digits. Matched on shape only
// and then handed to Date.parse for the real validation.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

// kubectl --prefix --timestamps emits, per line:
//   [pod/<pod>/<container>] <RFC3339Nano> <message>
// Parsed defensively rather than with a strict anchored pattern: if either
// flag is ever dropped, or a pod writes something that doesn't match, the
// line must still reach the operator verbatim instead of being swallowed.
// An unparsed line keeps its full text and simply carries no timestamp,
// which only costs the reattach continuity for that one line.
function parseLine(raw) {
  let rest = raw;
  let pod = null;
  let container = null;

  if (rest.startsWith("[")) {
    const close = rest.indexOf("] ");
    if (close > 0) {
      const parts = rest.slice(1, close).split("/");
      // "pod/<pod>/<container>" with --all-containers, "pod/<pod>" without.
      if (parts.length >= 2) {
        pod = parts[1] || null;
        container = parts[2] || null;
        rest = rest.slice(close + 2);
      }
    }
  }

  let ts = null;
  const sp = rest.indexOf(" ");
  if (sp > 0) {
    const candidate = rest.slice(0, sp);
    // Shape-check before trusting it as a timestamp, so a message beginning
    // with a bare word is not mistaken for one.
    //
    // The offset alternative is load-bearing, not defensive breadth. kubectl
    // does not generate this timestamp - it passes through whatever the
    // container runtime wrote - and this cluster's CRI writes a LOCAL offset
    // with nanosecond precision:
    //   2026-08-12T18:27:55.069321272+09:00
    // never a UTC "Z". An earlier version of this check required a trailing
    // "Z" and therefore parsed a timestamp off exactly zero real lines, which
    // silently disabled both --since-time continuity and the reattach
    // de-duplication below - the pane kept working, so nothing failed loudly.
    // Confirmed against the live rag pod 2026-08-12. Accept both forms.
    if (RFC3339.test(candidate) && !Number.isNaN(Date.parse(candidate))) {
      ts = candidate;
      rest = rest.slice(sp + 1);
    }
  }

  return { ts, pod, container, text: rest };
}

// Whole-second bucket for a parsed timestamp, via Date.parse rather than a
// string slice so that two lines an hour apart in different offsets still
// compare correctly. Date.parse tolerates the 9 fractional digits the CRI
// emits (truncating to ms, which is well below the granularity that matters
// here - see the dedup window in handleLine).
function secondOf(ts) {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function hashLine(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function pushRing(stream, frame) {
  const bytes = Buffer.byteLength(frame.text || "");
  stream.ring.push({ frame, bytes });
  stream.ringBytes += bytes;
  while (
    (stream.ring.length > RING_MAX_LINES || stream.ringBytes > RING_MAX_BYTES) &&
    stream.ring.length > 1
  ) {
    stream.ringBytes -= stream.ring.shift().bytes;
  }
}

function emit(stream, frame) {
  for (const w of stream.watchers) {
    try {
      if (frame.t === "line") w.onLine(frame);
      else w.onControl(frame);
    } catch (err) {
      // One misbehaving subscriber must never take down the stream for the
      // others, nor kill the process. Same defensive reasoning as
      // wsRelay.js's per-socket error listener.
      console.error(`logStream: subscriber threw on ${frame.t}:`, err.message);
    }
  }
}

function setState(stream, state, detail) {
  if (stream.state === state && !detail) return;
  stream.state = state;
  emit(stream, { t: "status", ts: new Date().toISOString(), state, detail: detail || null });
}

function emitThrottled(stream) {
  if (!stream.dropped) return;
  emit(stream, { t: "throttled", ts: new Date().toISOString(), dropped: stream.dropped });
  stream.dropped = 0;
}

// Returns false when the line should be dropped for rate reasons.
function admitByRate(stream) {
  const t = nowMs();
  if (t - stream.rateWindowStart >= RATE_WINDOW_MS) {
    emitThrottled(stream);
    stream.rateWindowStart = t;
    stream.rateCount = 0;
  }
  stream.rateCount += 1;
  if (stream.rateCount > LINE_RATE_LIMIT) {
    stream.dropped += 1;
    return false;
  }
  return true;
}

function handleLine(stream, raw) {
  if (!raw) return;
  const parsed = parseLine(raw);
  const hash = hashLine(raw);
  const sec = parsed.ts ? secondOf(parsed.ts) : null;

  // De-duplicate the overlap a --since-time reattach necessarily produces.
  //
  // The width of that overlap is a WHOLE SECOND, not one line, and that is
  // the entire reason this is keyed by second rather than by exact
  // timestamp. kubectl accepts --since-time to nanosecond precision, but the
  // value crosses the wire as a metav1.Time, which carries seconds only - so
  // the API server floors it. Verified live 2026-08-12: asking from
  // ...T18:27:55.999999999+09:00, strictly AFTER a line at ...55.069321272,
  // still returned that line.
  //
  // So a reattach re-sends every line from the resume second, at differing
  // nanosecond timestamps. An exact-timestamp check would suppress only the
  // one boundary line and - worse - the first non-matching re-sent line
  // would look like new content and close the window early, letting the rest
  // through as phantom repeats after every cap expiry and every rollout.
  //
  // The hash set is snapshotted at re-arm (see scheduleArm) so that lines
  // genuinely new within the resume second are still delivered, and are then
  // themselves tracked in case a second reattach replays the same second.
  if (stream.dedup) {
    if (sec === null) {
      // An unparsed line can't be placed in the window; deliver it rather
      // than guess, on the same principle parseLine follows.
    } else if (sec > stream.dedup.second) {
      stream.dedup = null; // past the replayed second - stop paying for this
    } else if (sec === stream.dedup.second && stream.dedup.hashes.has(hash)) {
      return;
    }
  }

  if (sec !== null) {
    if (sec !== stream.lastSecond) {
      stream.lastSecond = sec;
      stream.seenInLastSecond = new Set();
    }
    if (stream.seenInLastSecond.size < DEDUP_MAX_HASHES) stream.seenInLastSecond.add(hash);
    // Full precision is kept for --since-time even though the server floors
    // it: it costs nothing and it is what the operator's own log line said.
    stream.lastTimestamp = parsed.ts;
  }

  if (!admitByRate(stream)) return;

  const frame = {
    t: "line",
    ts: parsed.ts,
    pod: parsed.pod,
    container: parsed.container,
    text: parsed.text,
  };
  pushRing(stream, frame);
  emit(stream, frame);
}

// Builds the argv for one arming of the stream.
//
// The script itself contains NO interpolated value - it is a fixed string,
// and every kubectl argument is a separate argv element built here in JS.
// This matters more than it looks: this is the one place in the dashboard
// that genuinely invokes `sh -c`, so the "untrusted values never reach a
// shell" property the rest of the codebase gets for free from execFile's
// argv has to be re-established deliberately. Confirmed live 2026-08-12
// that positional parameters survive nemoclaw exec unevaluated - a
// selector of `wo rld;$(id)` arrives as that literal text, not as a
// command substitution.
//
// `exec timeout "$@"` after the shift keeps the script generic: the arity
// varies between the first arming (--tail) and a reattach (--since-time),
// and this way that difference lives in JS rather than in shell branching.
const SCRIPT = 'echo $$ > "$1"; shift; exec timeout "$@"';

function buildArgs(stream, sinceTime) {
  const kubectlArgs = [
    KUBECTL,
    `--kubeconfig=${KUBECONFIG}`,
    "logs",
    "-f",
    "-n",
    stream.target.namespace,
    "-l",
    stream.target.labelSelector,
    "--all-containers=true",
    "--prefix",
    // Required, not cosmetic: --timestamps is what makes --since-time
    // continuity and the de-duplication above possible at all.
    "--timestamps",
    `--max-log-requests=${stream.target.maxLogRequests}`,
    "--pod-running-timeout=20s",
  ];

  // --tail defaults to 10 whenever a selector is present (-1 otherwise), so
  // it is always set explicitly rather than inherited.
  if (sinceTime) kubectlArgs.push(`--since-time=${sinceTime}`);
  else kubectlArgs.push(`--tail=${stream.target.tail}`);

  return [
    SANDBOX,
    "exec",
    "--",
    "sh",
    "-c",
    SCRIPT,
    "_", // $0
    stream.pidPath,
    String(STREAM_TIMEOUT_SECONDS),
    ...kubectlArgs,
  ];
}

// `mode` is why this arming is happening, and it drives the state the pane
// shows. It is passed explicitly rather than inferred from sinceTime, because
// those two answer different questions and a stream that fails before
// producing a single line has no sinceTime while very much being a retry.
//
//   "initial"  - first arming for this stream        -> connecting
//   "retry"    - the previous attempt FAILED         -> retrying
//   "reattach" - routine: cap expiry or clean end    -> state untouched
//
// The last one matters more than it looks. The cap fires every
// STREAM_TIMEOUT_SECONDS forever, on a perfectly healthy stream, so reporting
// "retrying" there would flick the pane's health indicator every 15 minutes
// for the life of the pane - and an indicator that cries wolf on schedule is
// one the operator stops reading, which is exactly the erosion of a signal
// this feature exists to provide. Observed on the live 20s-cap drive
// 2026-08-12 before this was separated out.
//
// A routine re-arm is instead reported by the `reattach` frame and its gap
// duration. Claiming "live" would be a lie until lines actually flow, and the
// stdout handler sets that on its own when they do.
function arm(stream, sinceTime, mode) {
  stream.armedAt = nowMs();
  stream.stdoutBuf = "";
  stream.stderrTail = "";
  if (mode === "initial") setState(stream, "connecting");
  else if (mode === "retry") setState(stream, "retrying");

  // childProcess.spawn(...) rather than a destructured `const { spawn }`:
  // the tests monkey-patch the module's export before requiring this file,
  // and a destructured const would capture the real function at require
  // time and ignore the patch. Same capture-timing gotcha wsRelayAuth's
  // test header documents for auth.sessionMiddleware.
  const child = childProcess.spawn(NEMOCLAW_BIN, buildArgs(stream, sinceTime), {
    env: NEMOCLAW_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  stream.child = child;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    // kubectl's output arrives in arbitrary chunks, not whole lines - a
    // line can and does straddle a chunk boundary. The remainder is carried
    // forward rather than emitted, or long lines would be split mid-message.
    stream.stdoutBuf += chunk;
    const parts = stream.stdoutBuf.split("\n");
    stream.stdoutBuf = parts.pop();
    if (parts.length && stream.state !== "live") setState(stream, "live");
    for (const line of parts) handleLine(stream, line);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stream.stderrTail = (stream.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  child.on("error", (err) => {
    stream.stderrTail = `${stream.stderrTail}\nspawn error: ${err.message}`.slice(-STDERR_TAIL_BYTES);
  });

  child.on("exit", (code, signal) => {
    if (stream.child === child) stream.child = null;
    onExit(stream, code, signal);
  });
}

function onExit(stream, code, signal) {
  if (stream.closing) return;
  if (stream.watchers.size === 0) return;

  const ranFor = nowMs() - stream.armedAt;
  // 124 is timeout(1)'s own "the command timed out" code - the expected
  // path every STREAM_TIMEOUT_SECONDS, not a fault.
  const hitCap = code === 124;
  const startFailure = !hitCap && ranFor < STARTUP_GRACE_MS && code !== 0;

  if (startFailure) {
    stream.startFailures += 1;
    if (stream.startFailures >= MAX_START_FAILURES) {
      // Stop rather than reconnect forever. The operator needs to see a
      // dead pane that says why - the distinction between "this workload
      // has no logs" and "monitoring itself is blind" is exactly the one
      // watcher-k8s.sh.tmpl already escalates on, and it is lost if the
      // pane just spins.
      setState(
        stream,
        "failed",
        stream.stderrTail.trim() || `stream exited with code ${code}${signal ? ` (${signal})` : ""}`,
      );
      return;
    }
    const delay = BACKOFF_MS[Math.min(stream.startFailures - 1, BACKOFF_MS.length - 1)];
    emit(stream, {
      t: "reattach",
      ts: new Date().toISOString(),
      reason: "error",
      gapMs: delay,
      detail: stream.stderrTail.trim() || null,
    });
    scheduleArm(stream, delay, "retry");
    return;
  }

  // A stream that actually ran resets the failure budget - an hour-long
  // stream that finally hiccups shouldn't inherit failures from startup
  // trouble an hour earlier.
  stream.startFailures = 0;
  emit(stream, {
    t: "reattach",
    ts: new Date().toISOString(),
    reason: hitCap ? "timeout-cap" : "stream-ended",
    gapMs: 0,
    detail: hitCap ? null : stream.stderrTail.trim() || null,
  });
  // Re-arm immediately: the cap firing is expected and the gap should be as
  // close to zero as possible.
  scheduleArm(stream, 0, "reattach");
}

function scheduleArm(stream, delay, mode) {
  clearTimeout(stream.retryTimer);
  stream.retryTimer = setTimeout(() => {
    if (stream.closing || stream.watchers.size === 0) return;
    // Snapshot the dedup window BEFORE arming, so the copy can't pick up
    // lines the new child is already delivering. Copied rather than aliased
    // for the same reason: handleLine keeps adding to seenInLastSecond as
    // replayed-but-new lines arrive, and testing against a set that is
    // growing from its own input would suppress those.
    stream.dedup = stream.lastTimestamp
      ? { second: stream.lastSecond, hashes: new Set(stream.seenInLastSecond) }
      : null;
    // Resume from the last line actually seen so the gap is bounded by what
    // happened, not by --tail. Falls back to --tail when nothing has been
    // seen yet (a stream that failed before producing a single line).
    arm(stream, stream.lastTimestamp || null, mode);
  }, delay);
  if (stream.retryTimer.unref) stream.retryTimer.unref();
}

// Fire-and-forget reap of the sandbox-side process. The `timeout` cap is
// the backstop if this fails for any reason, which is why a failure here is
// logged rather than retried or surfaced.
function reapRemote(pidPath) {
  try {
    const child = childProcess.spawn(
      NEMOCLAW_BIN,
      [
        SANDBOX,
        "exec",
        "--",
        "sh",
        "-c",
        'kill "$(cat "$1" 2>/dev/null)" 2>/dev/null; rm -f "$1"',
        "_",
        pidPath,
      ],
      { env: NEMOCLAW_ENV, stdio: "ignore" },
    );
    child.on("error", (err) => {
      console.error(`logStream: remote reap of ${pidPath} failed to spawn:`, err.message);
    });
    if (child.unref) child.unref();
  } catch (err) {
    console.error(`logStream: remote reap of ${pidPath} threw:`, err.message);
  }
}

function teardown(stream) {
  stream.closing = true;
  clearTimeout(stream.retryTimer);
  if (stream.child) {
    stream.child.kill("SIGTERM");
    stream.child = null;
  }
  reapRemote(stream.pidPath);
  streams.delete(stream.target.repoKey);
}

/**
 * Subscribe to a workload's live logs. Returns an unsubscribe function.
 *
 * target: { repoKey, namespace, labelSelector, tail?, maxLogRequests? }
 * handlers: { onLine(frame), onControl(frame) }
 *
 * Throws when the global stream cap would be exceeded by a NEW stream -
 * joining an already-running one is always allowed, since it costs nothing.
 */
function subscribe(target, handlers) {
  if (!target || !target.repoKey || !target.namespace || !target.labelSelector) {
    throw new Error("logStream.subscribe: repoKey, namespace and labelSelector are required");
  }
  if (!handlers || typeof handlers.onLine !== "function" || typeof handlers.onControl !== "function") {
    throw new Error("logStream.subscribe: onLine and onControl handlers are required");
  }

  let stream = streams.get(target.repoKey);

  if (!stream) {
    if (streams.size >= MAX_CONCURRENT_STREAMS) {
      const err = new Error(
        `too many concurrent log streams (${streams.size}/${MAX_CONCURRENT_STREAMS}) - close a pane and retry`,
      );
      err.code = "STREAM_LIMIT";
      throw err;
    }
    const streamId = crypto.randomUUID();
    stream = {
      streamId,
      pidPath: `/tmp/dashlogs-${streamId}.pid`,
      target: {
        repoKey: target.repoKey,
        namespace: target.namespace,
        labelSelector: target.labelSelector,
        // kubectl's own default here is 5; exceeding it is an error rather
        // than a truncation, so it is passed explicitly and kept visible.
        maxLogRequests: target.maxLogRequests || 5,
        tail: target.tail || 200,
      },
      watchers: new Set(),
      ring: [],
      ringBytes: 0,
      lastTimestamp: null,
      lastSecond: null,
      seenInLastSecond: new Set(),
      dedup: null,
      state: "connecting",
      startFailures: 0,
      rateWindowStart: nowMs(),
      rateCount: 0,
      dropped: 0,
      stdoutBuf: "",
      stderrTail: "",
      retryTimer: null,
      closing: false,
      child: null,
      armedAt: 0,
    };
    streams.set(target.repoKey, stream);
    arm(stream, null, "initial");
  }

  stream.watchers.add(handlers);

  // Replay what this stream already has, so a pane opening onto a running
  // stream isn't blank until the workload happens to log something next.
  for (const entry of stream.ring) {
    try {
      handlers.onLine(entry.frame);
    } catch (err) {
      console.error("logStream: subscriber threw during ring replay:", err.message);
    }
  }
  try {
    handlers.onControl({ t: "status", ts: new Date().toISOString(), state: stream.state, detail: null });
  } catch (err) {
    console.error("logStream: subscriber threw during status replay:", err.message);
  }

  let released = false;
  return function unsubscribe() {
    if (released) return; // idempotent - a double close must not tear down a stream others still hold
    released = true;
    stream.watchers.delete(handlers);
    if (stream.watchers.size === 0) teardown(stream);
  };
}

function activeStreamCount() {
  return streams.size;
}

// Safety net only. Teardown on last-unsubscribe should mean no stream ever
// sits here with zero watchers; this catches the case where that path was
// missed (a half-open socket whose close never fired, say). The `timeout`
// cap catches whatever this misses in turn - three layers, because the
// orphan in finding 3 is a failure this repo has already paid for once.
const sweeper = setInterval(() => {
  for (const stream of [...streams.values()]) {
    if (stream.watchers.size === 0) {
      console.error(`logStream: sweeping ownerless stream for ${stream.target.repoKey}`);
      teardown(stream);
    }
  }
}, IDLE_SWEEP_MS);
if (sweeper.unref) sweeper.unref();

// Called on process shutdown so a `systemctl restart nemoclaw-dashboard`
// doesn't strand every open stream in the sandbox for up to
// STREAM_TIMEOUT_SECONDS.
function shutdownAll() {
  for (const stream of [...streams.values()]) teardown(stream);
}

module.exports = {
  subscribe,
  activeStreamCount,
  shutdownAll,
  // Exported for the tests and for routes/monitoring.js's own limit
  // reporting - not part of the runtime contract otherwise.
  _constants: {
    STREAM_TIMEOUT_SECONDS,
    MAX_CONCURRENT_STREAMS,
    RING_MAX_LINES,
    RING_MAX_BYTES,
    LINE_RATE_LIMIT,
    STARTUP_GRACE_MS,
    MAX_START_FAILURES,
    // The ARRAY itself, not a copy - onExit() indexes this same object, so
    // a test can shorten the delays in place (fill(1)) and exercise the
    // full failure budget without spending 30 real seconds waiting out the
    // production backoff.
    BACKOFF_MS,
  },
};

// parseLine() is deliberately NOT exported. It was, briefly, "for the tests" -
// but no test used it, because every parsing case is better exercised by
// pushing real kubectl-shaped bytes through the child's stdout and asserting
// on what the subscriber receives. That path covers chunk-boundary
// reassembly and the emit contract as well as the parse itself, and it is
// the path that would actually have caught the offset-timestamp bug. An
// exported seam nothing uses is just a wider surface to keep honest.
