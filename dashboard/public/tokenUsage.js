// Pure shaping helpers for the Ops > Usage panel. Split out of app.js purely so
// test/tokenUsage.test.js can require() the real browser-served file rather than
// a reimplementation - same pattern as itemToolEvents.js.

// Compact token counts. Volume here runs to seven figures, and raw digits in a
// narrow column are unreadable at a glance while the whole point of the panel is
// comparing days to each other.
function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(n);
}

// Classify a day into one of THREE states, which is the correctness crux of this
// panel:
//
//   measured   - turns were recorded with real usage numbers
//   unmeasured - turns definitely ran, but every one logged usage 0. True for
//                all escalation/reviewer agents before 2026-08-12, when
//                compat.supportsUsageInStreaming was enabled: OpenClaw streams,
//                and vLLM omits usage from streamed responses unless the client
//                asks for it.
//   idle       - no agent turns at all
//
// Collapsing "unmeasured" into "idle" would draw a floor of zeros that reads as
// a quiet day, when in fact it was a busy day we simply failed to measure. Those
// lead to opposite conclusions, so they are never rendered the same way.
function classifyUsageDay(d) {
  if (d.turns > 0) return "measured";
  if (d.unrecordedTurns > 0) return "unmeasured";
  return "idle";
}

// Fill days that have no transcript entries at all. Without this the bars sit
// side-by-side and a week-long gap looks like consecutive activity - for a trend
// view, the one thing the chart must not do.
function fillUsageGaps(byDay) {
  const list = Array.isArray(byDay) ? byDay : [];
  if (list.length < 2) return list.map((d) => ({ ...d, state: classifyUsageDay(d) }));

  const DAY_MS = 86400000;
  // Parsed as UTC midnight: the dates are already date-only strings cut from UTC
  // ISO timestamps, so going through local time would shift buckets for anyone
  // east or west of UTC.
  let cursor = Date.parse(`${list[0].date}T00:00:00Z`);
  const last = Date.parse(`${list[list.length - 1].date}T00:00:00Z`);
  // Guard rather than trust the input: an unparseable date would make the while
  // loop below spin forever and hang the tab, so fall back to ungapped output.
  if (!Number.isFinite(cursor) || !Number.isFinite(last) || last < cursor) {
    return list.map((d) => ({ ...d, state: classifyUsageDay(d) }));
  }

  const seen = new Map(list.map((d) => [d.date, d]));
  const out = [];
  while (cursor <= last) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    const hit = seen.get(key);
    out.push(
      hit
        ? { ...hit, state: classifyUsageDay(hit) }
        : { date: key, input: 0, output: 0, total: 0, turns: 0, unrecordedTurns: 0, state: "idle" },
    );
    cursor += DAY_MS;
  }
  return out;
}

// How full the context window is, read off ONE assistant turn's usage record.
//
// The distinction this exists to enforce: a session's cumulative token count
// (the sum of every turn's prompt, which is what the Usage panel above totals,
// and what the gateway reports as sessionRow.totalTokens) is not occupancy and
// grows without bound. Occupancy is per-turn and is what can overflow. Dividing
// the former by the context window is the bug this function was extracted to
// prevent recurring - it displayed "254% of context" for a session whose real
// peak was 17.5%.
//
// Returns null when the turn carries no usable number, which callers must treat
// as "unknown", NOT as zero:
//   - aborted turns record a complete set of zeros, and an abort is the moment
//     you least want the indicator to drop to "context empty"
//   - turns before the gateway's usage-in-streaming support (2026-08-12) have
//     no usage at all, same as classifyUsageDay's "unmeasured" state
//
// Field preference: totalTokens (prompt + completion) leads the next turn's
// prompt size by one turn, so it warns one turn earlier than input alone. The
// aliases after it cover provider naming variants the gateway's sanitizeUsage
// passes through untouched.
function contextUsedFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const candidates = [
    usage.totalTokens,
    usage.total,
    usage.total_tokens,
    usage.input,
    usage.inputTokens,
    usage.promptTokens,
    usage.input_tokens,
    usage.prompt_tokens,
  ];
  const used = candidates.find((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  return used === undefined ? null : used;
}

// No effect in the browser (no `module` global there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { fmtTokens, classifyUsageDay, fillUsageGaps, contextUsedFromUsage };
}
