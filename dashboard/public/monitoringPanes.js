// monitoringPanes.js - pure shaping helpers for the Monitoring view's log
// panes (phase 4 of docs/monitoring-live-logs.md). Split out of app.js for
// exactly the reason itemToolEvents.js and tokenUsage.js are: so
// test/monitoringPanes.test.js can require() the real browser-served file
// rather than a reimplementation of it. Everything here is pure - no DOM, no
// WebSocket - and the wiring that uses it lives in app.js.

// Client-side ring buffer, per pane. §6.3: without a cap, a pane left open all
// day is an unbounded DOM leak, and a workload at logStream's own 200 lines/s
// ceiling reaches this in ten seconds of noise.
const PANE_LINE_LIMIT = 2000;

// §6.2. Four is a layout ceiling, not a resource one - the server's own cap is
// MAX_CONCURRENT_STREAMS (8), which exists to leave room for a second
// operator. A fifth pane on one screen would be too small to read before it
// was too expensive to run.
const MAX_PANES = 4;

// Which grid shape the pane count needs. A class rather than inline styles so
// the layout lives in style.css with the rest of it, and so the 3-pane case -
// where the third pane spans the bottom row - is expressible at all.
function gridClassFor(count) {
  const n = Math.min(Math.max(count, 0), MAX_PANES);
  return `panes-${n}`;
}

// Whether a workload can be opened in a new pane, and if not, what to tell the
// operator. Three refusals with three different remedies, so they are three
// different messages rather than one disabled control that says nothing.
function canAddPane(openKeys, target, max = MAX_PANES) {
  if (!target) return { ok: false, reason: "unknown workload" };
  if (!target.streamable) {
    return { ok: false, reason: target.unstreamableReason || "this workload cannot be log-streamed" };
  }
  if (openKeys.includes(target.repoKey)) {
    // Not a resource problem - logStream shares one child between subscribers
    // on the same repoKey, so a duplicate pane costs nothing. It is a display
    // problem: two panes showing identical output waste half the grid.
    return { ok: false, reason: "already open in another pane" };
  }
  if (openKeys.length >= max) {
    return { ok: false, reason: `at the ${max}-pane limit — close one first` };
  }
  return { ok: true, reason: null };
}

// A paused pane must say how much it is holding back. §6.3 keeps the stream
// and the buffer running through a pause precisely so resume shows the gap
// rather than a hole, and the count is what tells the operator the gap is
// there before they resume into it.
function describePaused(buffered) {
  const n = typeof buffered === "number" && buffered > 0 ? buffered : 0;
  if (!n) return "Paused";
  if (n >= PANE_LINE_LIMIT) return `Paused · ${n.toLocaleString()}+ lines buffered`;
  return `Paused · ${n.toLocaleString()} line${n === 1 ? "" : "s"} buffered`;
}

// Wall-clock time for one log line, taken from the timestamp STRING rather
// than through Date.
//
// This is deliberate, and it is the §2.7 lesson applied at the other end of
// the pipe. The value is written by the container runtime, not by kubectl, and
// this cluster's CRI writes a local offset with nanosecond precision
// (2026-08-12T18:27:55.069321272+09:00) - never a "Z". Slicing the string
// shows the operator the same wall-clock the raw `kubectl logs` output shows
// them, whatever zone their browser happens to be in, and it cannot
// misrender a form Date.parse handles differently than expected.
//
// Returns null rather than a placeholder when there is no usable timestamp:
// logStream's parse legitimately yields ts: null for a line the runtime wrote
// without one, and a row with no time cell reads better than one claiming
// "Invalid Date".
const LOG_TS = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(\.\d+)?/;

function formatLogTime(ts) {
  if (typeof ts !== "string") return null;
  const m = LOG_TS.exec(ts);
  if (!m) return null;
  // Milliseconds are the useful precision for reading a log by eye; the rest
  // of the nanoseconds are noise in a narrow column.
  const frac = m[2] ? m[2].slice(0, 4) : "";
  return `${m[1]}${frac}`;
}

// Gap durations on a reattach divider. Sub-second gaps are the normal case
// (the cap re-arms immediately), so they must not all render as "0s" - that
// would make a genuine multi-minute outage indistinguishable from routine
// re-arming at a glance.
function formatGap(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

const REATTACH_REASONS = {
  "timeout-cap": "stream reattached",
  "stream-ended": "stream ended, reattached",
  error: "stream error, retrying",
};

// One control frame -> the inline row a pane should render for it, or null
// when the frame is carried by the pane's state dot alone.
//
// Every non-line frame goes through here rather than being handled at the
// call site, so nothing can be silently dropped: a pane that quietly swallows
// a reattach or a throttle is the blind-monitoring failure this whole feature
// exists to prevent, and it looks identical to a healthy pane.
//
// Note there is no "error" frame to handle - logStream does not emit one, by
// design. A failure is a STATE (status/failed, carrying kubectl's own stderr),
// so a pane joining after the failure is still told about it; a one-shot error
// event would be invisible to exactly that pane. See §4.5.
function describeControlFrame(frame) {
  if (!frame || typeof frame !== "object") return null;

  if (frame.t === "reattach") {
    const label = REATTACH_REASONS[frame.reason] || "stream reattached";
    const gap = formatGap(frame.gapMs);
    const parts = [label];
    if (gap && frame.gapMs > 0) parts.push(`after ${gap}`);
    if (frame.detail) parts.push(frame.detail);
    return { tone: frame.reason === "error" ? "warn" : "muted", text: parts.join(" · ") };
  }

  if (frame.t === "throttled") {
    const n = typeof frame.dropped === "number" ? frame.dropped : 0;
    // Dropping visibly is the point (§5.2) - a silently thinned pane is the
    // same class of lie as a silently dead one.
    return { tone: "warn", text: `${n.toLocaleString()} lines dropped (rate limit)` };
  }

  if (frame.t === "status") {
    // connecting/live are the dot's job. Rendering a row for them would put a
    // line in the log flow every time a healthy stream re-armed.
    if (frame.state === "failed") {
      return { tone: "fail", text: `stream failed · ${frame.detail || "no detail reported"}` };
    }
    if (frame.state === "retrying") {
      return { tone: "warn", text: `reconnecting${frame.detail ? ` · ${frame.detail}` : ""}` };
    }
    return null;
  }

  return null;
}

// The per-row pod marker. Full pod names (api-rag-7d9f8b6c4-xyz12) are most of
// a narrow column and repeat identically on every line, but the trailing
// segment is exactly what changes when a pod is replaced - which is the
// rollout case §2.5 warns about, where the pane can otherwise go quiet with no
// visible cause. The full pod/container pair stays on the row's title.
function podShortName(pod) {
  if (typeof pod !== "string" || !pod) return null;
  const parts = pod.split("-");
  return parts[parts.length - 1] || pod;
}

// §6.4 severity tinting. Each registry entry carries an operator-authored
// `error_pattern` (`ERROR|CRITICAL|Traceback|Exception` for all 7 today), and
// this is the only thing done with it: matching lines are tinted.
//
// Why this doesn't contradict the no-keyword-matching rule, stated once here
// rather than argued again each time someone reads it: that rule is about
// INFERRING INTENT OR MEANING from text in any language, where a regex is the
// wrong instrument. This branches no behaviour, filters nothing, hides
// nothing, and a non-match costs nothing - the pattern is a display
// preference the operator wrote in their own repo's registry entry. If it ever
// gates behaviour, that reasoning expires.
//
// Compiled once per pane rather than per line, and returns null rather than
// throwing on a malformed pattern: `error_pattern` is free text in
// repos.json, and a typo there must cost tinting, not the pane.
//
// No `g` flag, deliberately. A global regex's `.test()` carries `lastIndex`
// between calls, so it would match every OTHER line - a bug that looks like
// flaky highlighting rather than like a bug.
function compileErrorPattern(pattern) {
  if (typeof pattern !== "string" || !pattern.trim()) return null;
  try {
    // Case-sensitive, exactly as authored. Adding `i` would silently widen a
    // pattern the operator wrote for their own logs.
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

// The class a rendered line gets, or null. Kept out of app.js so the "tint is
// display-only" property is testable: this returns a class name and can do
// nothing else.
function rowSeverityClass(re, text) {
  if (!re || typeof text !== "string" || !text) return null;
  return re.test(text) ? "log-row-alert" : null;
}

// The picker entry for one target from GET /api/monitoring/targets.
//
// Unstreamable workloads are listed and disabled, never filtered out - the
// same reasoning §4.6 gives for the endpoint itself. A workload that is simply
// absent from the picker is a dead end an operator cannot debug; one that says
// why it can't be streamed explains itself.
function describeTargetOption(target) {
  if (!target || !target.repoKey) return null;
  const name = target.displayName || target.repoKey;
  const streamable = Boolean(target.streamable);
  return {
    value: target.repoKey,
    label: streamable ? name : `${name} — unavailable`,
    disabled: !streamable,
    title: streamable
      ? `${target.namespace} · ${target.labelSelector}`
      : target.unstreamableReason || "this workload cannot be log-streamed",
  };
}

// The pane header's subtitle: what this stream is actually pointed at.
// Namespace and selector are shown because a pane finding zero pods is the
// failure mode with no other symptom, and the selector is the first thing to
// check when it happens.
function paneMetaText(target) {
  if (!target) return "";
  const parts = [];
  if (target.namespace) parts.push(target.namespace);
  if (target.labelSelector) parts.push(target.labelSelector);
  // Surfaced, not hidden: the watcher being off is no reason an operator
  // can't read the logs by hand, but it does explain why nothing escalated.
  if (target.monitoringEnabled === false) parts.push("watcher off");
  return parts.join(" · ");
}

// How the operator-facing limits from the endpoint read in a sentence. The
// reattach cadence is here because a healthy pane showing a periodic divider
// is otherwise indistinguishable from one that keeps breaking.
function describeLimits(limits) {
  if (!limits) return "";
  const mins = Math.round((limits.streamTimeoutSeconds || 0) / 60);
  return `up to ${limits.maxConcurrentStreams} streams · reattaches every ${mins} min`;
}

// No effect in the browser (no `module` global there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PANE_LINE_LIMIT,
    MAX_PANES,
    gridClassFor,
    canAddPane,
    describePaused,
    formatLogTime,
    formatGap,
    podShortName,
    compileErrorPattern,
    rowSeverityClass,
    describeControlFrame,
    describeTargetOption,
    paneMetaText,
    describeLimits,
  };
}
