// routes/sessions.js - GET /api/sessions, thin wrapper around
// sessionIndex.js. Powers the sidebar's Recents list.
//
// GET /api/sessions/history?key=<sessionKey> proxies OpenClaw's chat.history
// RPC to replay a past conversation - confirmed via OpenClaw's own test
// suite (test/openclaw-tui-chat-correlation.test.ts): request(sessionKey,
// limit) -> { messages: [{role, content:[{type:"text"|"thinking",text}]}] },
// oldest-first, same scopes this dashboard's connection already uses.
// Truncation direction beyond `limit` IS confirmed (2026-07-31, reconfirmed
// live 2026-08-04 against the current gateway, both times via a real
// session with more messages than a small requested `limit`): tail-
// anchored, i.e. `limit:N` always returns the N MOST RECENT messages -
// the same last item comes back regardless of N, while the first item is
// whichever message is exactly N back from the end, not the conversation's
// true opening message unless N covers the whole session. For a session
// with more than HISTORY_LIMIT (200) real messages, this means the
// replay silently shows only the last 200 - the earliest messages (e.g.
// the original incident report on a long-lived escalation) are dropped
// from view with no indicator that anything was cut. Not yet worth a
// pagination UI given no real session has come close to 200 messages so
// far, but revisit if one ever does. Still NOT confirmed: whether tool-use
// content ever appears (treat as absent - see app.js).
// A known upstream bug (#2603) could duplicate adjacent turns under some
// conditions (reportedly fixed as of OpenClaw 2026.6.10, not independently
// verified against whatever build Server 6 runs) - deduped defensively on
// the frontend rather than trusted away.
//
// Confirmed live 2026-07-24, a SEPARATE gap from any of the above: the
// messages chat.history actually returns never include the operator's own
// dashboard-submitted text as a "user"-role entry at all - a real replay
// showed zero trace of it, not filtered out by a content-shape mismatch.
// This gateway apparently doesn't record a dashboard-triggered instruction
// as a literal chat turn the way it does the agent's own responses.
// mergeUserMessages() below fills the gap using sessionIndex's own
// recorded copy (the dashboard is the one party that DOES know this text
// for certain - it's exactly what this same route's sibling, POST
// /api/run, sent).

const express = require("express");
const { requireAuth } = require("../auth");
const sessionIndex = require("../sessionIndex");
const gatewayClient = require("../gatewayClient");
const remoteSessions = require("../remoteSessions");
const registry = require("../registry");

const router = express.Router();

// Only sessions this dashboard itself created and recorded (i.e. present
// in our own index) OR gateway-confirmed to belong to one of the
// REGISTERED repos' escalation OR reviewer agents are fetchable - never an
// arbitrary client-supplied sessionKey for some unregistered/unrelated
// agent. This is
// the same trust boundary routes/run.js's continuation check already
// enforces, just widened to a second, gateway-verified source of truth
// instead of narrowed to a client-supplied claim. Two entry points enforce
// this the same way but at different granularity: getMergedSessions()
// below enumerates every registered repo's sessions (for the full Recents
// list), while resolveSessionEntry() further below verifies just ONE
// sessionKey against only the one repo it claims to belong to (for
// GET /api/sessions/history, which doesn't need the other N-1 repos'
// session lists to answer "does this one exist").
const HISTORY_LIMIT = 200;

// Label fetched for a genuinely-new (gateway-only, not locally recorded)
// session - matches sessionIndex.js's own LABEL_MAX_LENGTH so a
// gateway-discovered entry reads the same length as a dashboard-recorded
// one in Recents.
const REMOTE_LABEL_MAX_LENGTH = 80;

// Best-effort labels for a batch of gateway-only sessions, via ONE
// sessions.preview RPC call rather than one chat.history call per entry -
// confirmed as a real inefficiency in review 2026-07-31: getMergedSessions
// was paying for N separate gateway round-trips (still parallel via
// Promise.all, but N distinct requests) for N genuinely-new sessions on
// every single Recents-list load.
//
// sessions.preview's own params/response shape confirmed live 2026-07-31
// directly against the real gateway (OpenClaw 2026.6.10): { keys: string[]
// (max 64), limit?, maxChars? } -> { ts, previews: [{ key, status:
// "ok"|"missing"|"empty"|"error", items: [{role,text}] }] }. items are
// ordered oldest-to-newest WITHIN the returned window (confirmed via a
// live limit:1 vs limit:50 comparison against a real long-running
// session), i.e. the LAST item is the most recent message - same
// tail-anchored behavior chat.history(limit:1) already had (also confirmed
// live: chat.history(limit:50)'s own first item on a real long session was
// a mid-conversation "Compaction" marker, not the conversation's true
// opening message - it was never actually "the first message" for a
// long-lived session, only for a short/fresh one). Since this only ever
// labels genuinely-new (just-discovered) sessions, which are short at
// discovery time, swapping to sessions.preview preserves the exact same
// practical behavior - the only real change is batching the RPC calls.
//
// Requests limit:5 (not 1) so there's a little room to skip past a
// "tool"-role item (raw tool-call JSON, not prose - sessions.preview has
// no content-type filter like chat.history's content:[{type,text}] parts
// did, so this replicates that same "only real prose" filtering by role
// instead) and still find a readable user/assistant message underneath.
async function labelsFromRecentMessages(sessionKeys) {
  const fallbacks = new Map(sessionKeys.map((key) => [key, key.slice(key.lastIndexOf(":") + 1)]));
  if (sessionKeys.length === 0) return fallbacks;
  const labels = new Map(fallbacks);
  try {
    const result = await gatewayClient.call("sessions.preview", {
      keys: sessionKeys,
      limit: 5,
      maxChars: REMOTE_LABEL_MAX_LENGTH,
    });
    const previews = (result && Array.isArray(result.previews)) ? result.previews : [];
    for (const preview of previews) {
      if (preview.status !== "ok" || !Array.isArray(preview.items)) continue;
      for (let i = preview.items.length - 1; i >= 0; i--) {
        const item = preview.items[i];
        if (item && item.role !== "tool" && typeof item.text === "string" && item.text) {
          labels.set(preview.key, item.text.slice(0, REMOTE_LABEL_MAX_LENGTH));
          break;
        }
      }
    }
  } catch (err) {
    // Every entry already has its fallback pre-seeded above - a single
    // failed batch call degrades to sessionKey-suffix labels for all of
    // them rather than breaking the whole Recents list.
    console.warn(`routes/sessions: sessions.preview batch label fetch failed:`, err.message);
  }
  return labels;
}

// Merges sessionIndex's own locally-recorded sessions with whatever the
// Gateway itself reports for each registered repo's escalation agent (see
// remoteSessions.js) - this is what actually closes the gap described at
// the top of this file: a session created by one repo's escalation agent
// calling another's directly (registry/schema.md's correlate_with
// mechanism) never went through this dashboard's own composer, so
// sessionIndex.js alone would never know it exists.
//
// Local entries always win on a sessionKey collision (they carry a real
// user-authored label from routes/run.js's own recorded first message,
// which is strictly better than anything recoverable after the fact from
// chat.history) - only genuinely new, remote-only entries get a label
// fetched here.
async function getMergedSessions() {
  const local = sessionIndex.list();
  const localKeys = new Set(local.map((e) => e.sessionKey));

  const remote = await remoteSessions.listForRegisteredRepos();
  // Filtered here, before the batched labelsFromRecentMessages() call below
  // - no point spending sessions.preview's key budget (max 64 per call) on
  // labels for entries about to be dropped anyway. See sessionIndex.hide()'s
  // own comment for why gateway-origin entries need this filter at all
  // (they were never in sessionIndex's own entries to begin with, so
  // "deleted" for one of these can only ever mean "excluded here", not
  // "removed from local storage").
  const newRemote = remote.filter((e) => !localKeys.has(e.sessionKey) && !sessionIndex.isHidden(e.sessionKey));

  const labels = await labelsFromRecentMessages(newRemote.map((e) => e.sessionKey));
  const labeled = newRemote.map((entry) => ({
    sessionKey: entry.sessionKey,
    repoKey: entry.repoKey,
    label: labels.get(entry.sessionKey),
    updatedAt: entry.updatedAt,
    userMessages: [],
    origin: "gateway",
    // Propagated from remoteSessions.js's own per-query tagging (see its
    // comment) - "escalation" or "reviewer", whichever agent query this
    // entry actually came from.
    agentRole: entry.agentRole,
  }));

  // POST /api/run only ever creates escalation-agent sessions (see
  // routes/run.js's own hardcoded `const role = "escalation"`) - so every
  // local (dashboard-origin) entry is unambiguously an escalation session,
  // explicitly tagged here rather than left undefined, for app.js to rely
  // on consistently across BOTH origins.
  const localWithOrigin = local.map((e) => ({ ...e, origin: e.origin || "dashboard", agentRole: "escalation" }));

  return [...localWithOrigin, ...labeled].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Resolves ONE specific sessionKey for GET /api/sessions/history, without
// getMergedSessions()'s full N-repo fan-out + per-entry label fetch -
// wasteful for this route, which only ever needs to verify a single key
// (confirmed as a real inefficiency in review 2026-07-29: opening one past
// conversation was paying for a full Recents-list-sized merge every time).
// A sessionKey encodes its own owning agent (agent:<agentId>:<rest>), so
// the owning repo can be found via a single cheap registry.listRepos()
// lookup (no gateway round-trip at all) - only when that lookup succeeds
// does this reach the gateway, and then via sessions.describe's own direct
// single-key lookup rather than gatewayClient.listAgentSessions(agentId)'s
// full-list fetch + .some() scan this replaced 2026-07-31 (a second
// confirmed inefficiency in the same review that flagged getMergedSessions'
// per-entry chat.history calls) - every single-session open was paying for
// an entire agent's session list just to confirm one key's existence.
// sessions.describe's own params/gate confirmed live against OpenClaw's
// source (dist/sessions-FHKRhZK9.js + session-utils-B4hOl7Zv.js): it parses
// the owning agentId straight out of the given key itself (no separate
// agentId param needed) and does an exact-key lookup into that agent's own
// on-disk session store - the same ownership boundary the old list+scan
// enforced, just without transferring the whole list to do it.
async function resolveSessionEntry(sessionKey) {
  const local = sessionIndex.list().find((e) => e.sessionKey === sessionKey);
  // Every locally-recorded entry is a dashboard-originated, escalation-only
  // session (see getMergedSessions' own comment on this same point) - tag
  // it explicitly here too, so this single-session path reports the same
  // agentRole app.js would have seen for the exact same entry via the full
  // list.
  if (local) return { ...local, agentRole: "escalation" };

  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return null;
  const agentId = parts[1];
  // Matches EITHER agent role, not just escalation - a reviewer session
  // can be a genuine gateway-origin entry too (see remoteSessions.js), and
  // without this a reviewer session that made it into the merged Recents
  // list would 404 the instant it was actually opened, since this lookup
  // would never find its owning repo. Whichever field matches also tells
  // us which single agent to verify the sessionKey against below - no
  // hardcoded escalationAgent, and no need to query both.
  const repo = registry.listRepos().find(
    (r) => r.escalationAgent === agentId || r.reviewerAgent === agentId,
  );
  if (!repo) return null;
  const agentRole = repo.escalationAgent === agentId ? "escalation" : "reviewer";

  const result = await gatewayClient.call("sessions.describe", { key: sessionKey });
  if (!result || !result.session) return null;

  return { sessionKey, repoKey: repo.repoKey, userMessages: [], agentRole };
}

// Fixed 2026-07-24 - confirmed live against a real 3-follow-up session
// that the ORIGINAL "best-effort proportional split" (each user message
// gets an equal-sized following slice of chat.history's messages, by
// COUNT) was genuinely wrong the moment a real conversation's turns
// stopped being equal-sized: a real replay showed question 2's own short
// answer landing AFTER question 3 had already appeared, and parts of
// question 3's own (much longer, several-tool-call) answer landing
// BEFORE question 3 itself - exactly the failure mode this function's
// own prior comment predicted and flagged as unverified. Root cause: a
// proportional split by count has no way to know that one follow-up's
// answer took 1 turn and another's took 6.
//
// chat.history's own entries DO carry a real timestamp after all (this
// function's prior comment claimed otherwise, unconfirmed) - confirmed
// live: a top-level `timestamp` field (`__openclaw.recordTimestampMs` as
// a fallback on some shapes), present on assistant and toolResult
// entries alike. Combined with sessionIndex's own `sentAt` (recorded via
// Date.now() the moment routes/run.js actually sent it), a genuine
// chronological merge is now possible instead of a positional guess:
// walk both lists (each already in send/oldest-first order) together,
// inserting each user message right before the first history entry
// whose OWN timestamp is at or after it.
//
// Falls back to the ORIGINAL positional-split behavior only if NO
// history entry has a usable timestamp at all (not observed live, but
// chat.history's exact shape isn't independently guaranteed stable) -
// this keeps the fallback for a degenerate case instead of silently
// misplacing everything at position 0.
function historyTimestamp(message) {
  if (typeof message.timestamp === "number") return message.timestamp;
  if (message.__openclaw && typeof message.__openclaw.recordTimestampMs === "number") {
    return message.__openclaw.recordTimestampMs;
  }
  return null;
}

function mergeUserMessages(historyMessages, userMessages) {
  if (!userMessages || !userMessages.length) return historyMessages;

  const hasTimestamps = historyMessages.some((m) => historyTimestamp(m) !== null);
  if (!hasTimestamps) {
    const n = userMessages.length;
    const total = historyMessages.length;
    const merged = [];
    for (let i = 0; i < n; i++) {
      merged.push({ role: "user", content: [{ type: "text", text: userMessages[i].text }] });
      const sliceStart = Math.round((i / n) * total);
      const sliceEnd = Math.round(((i + 1) / n) * total);
      merged.push(...historyMessages.slice(sliceStart, sliceEnd));
    }
    return merged;
  }

  const merged = [];
  let nextUserIndex = 0;
  for (const message of historyMessages) {
    const ts = historyTimestamp(message);
    if (ts !== null) {
      while (nextUserIndex < userMessages.length && userMessages[nextUserIndex].sentAt <= ts) {
        merged.push({ role: "user", content: [{ type: "text", text: userMessages[nextUserIndex].text }] });
        nextUserIndex++;
      }
    }
    merged.push(message);
  }
  // Any user messages sent after every history entry's own last
  // timestamp (shouldn't normally happen - a user message always
  // precedes the response it triggered - but defensive) go at the end.
  while (nextUserIndex < userMessages.length) {
    merged.push({ role: "user", content: [{ type: "text", text: userMessages[nextUserIndex].text }] });
    nextUserIndex++;
  }
  return merged;
}

router.get("/api/sessions/history", requireAuth, async (req, res) => {
  const sessionKey = req.query.key;
  if (!sessionKey || typeof sessionKey !== "string") {
    return res.status(400).json({ error: "key is required" });
  }
  let entry;
  try {
    entry = await resolveSessionEntry(sessionKey);
  } catch (err) {
    console.error("routes/sessions: failed to resolve session:", err.message);
    return res.status(502).json({ error: "failed to verify session" });
  }
  if (!entry) {
    return res.status(404).json({ error: "unknown session" });
  }
  try {
    const result = await gatewayClient.call("chat.history", {
      sessionKey,
      limit: HISTORY_LIMIT,
    });
    const historyMessages = (result && result.messages) || [];
    const messages = mergeUserMessages(historyMessages, entry.userMessages);
    res.json({ repoKey: entry.repoKey, messages });
  } catch (err) {
    console.error("routes/sessions: chat.history failed:", err.message);
    res.status(502).json({ error: `failed to fetch history: ${err.message}` });
  }
});

// Compaction checkpoints for one session, so the transcript can show what a
// compaction actually kept rather than the bare marker.
//
// chat.history renders a compaction as a message with role "system" and the
// literal text "Compaction" - discriminated by __openclaw.kind === "compaction"
// (confirmed live 2026-08-10 against a forced sessions.compact). That marker
// carries no summary, and until this route existed the frontend rendered it as
// an ordinary assistant bubble, i.e. the agent appearing to say the single word
// "Compaction". That is exactly how it was first reported: "the agent's last
// message was Compaction, idk what this means".
//
// NOTE the ids do NOT match: the message's __openclaw.id ("f23e61d5") and the
// checkpoint's checkpointId ("13e51d2d-...") are different namespaces, so the
// frontend pairs them by chronological order, not by id. Don't "fix" that into
// an id lookup - it will silently match nothing.
router.get("/api/sessions/compaction", requireAuth, async (req, res) => {
  const sessionKey = req.query.key;
  if (!sessionKey || typeof sessionKey !== "string") {
    return res.status(400).json({ error: "key is required" });
  }
  try {
    const payload = await gatewayClient.call("sessions.compaction.list", { key: sessionKey });
    const checkpoints = ((payload && payload.checkpoints) || [])
      .map((c) => ({
        createdAt: c.createdAt,
        reason: c.reason,
        tokensBefore: c.tokensBefore,
        summary: c.summary || "",
      }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    res.json({ checkpoints });
  } catch (err) {
    console.error("routes/sessions: sessions.compaction.list failed:", err.message);
    res.status(502).json({ error: `failed to fetch compaction detail: ${err.message}` });
  }
});

router.get("/api/sessions", requireAuth, async (req, res) => {
  try {
    res.json({ sessions: await getMergedSessions() });
  } catch (err) {
    console.error("routes/sessions: failed to read session index:", err.message);
    res.status(500).json({ error: "failed to read session index" });
  }
});

// Query param (?key=), not a :sessionKey path segment, matching the same
// convention /api/sessions/history already uses above - sessionKey
// contains colons (agent:<agent>:dashboard-<timestamp>, see routes/run.js),
// which is safer to carry as an encoded query value than to rely on
// correct path-segment handling for. Only removes this dashboard's own
// Recents index entry - see sessionIndex.remove()'s own comment for why
// this deliberately doesn't attempt to delete anything on the Gateway
// side.
// POST /api/sessions/abort {sessionKey} -> {ok, aborted, runIds}. Proxies
// OpenClaw's own chat.abort RPC (confirmed to exist by reading the gateway
// source directly on Server 6 - dist/chat-BmzuyR4R.js's method table -
// since it's undocumented anywhere else reachable from here). runId is
// deliberately omitted: the dashboard never tracked one client-side to
// begin with, and chat.abort's own handler treats a missing runId as
// "abort every active run for this sessionKey", which is exactly the one
// run this session could ever have in flight from this UI. Uses
// resolveSessionEntry() - the SAME trust boundary /api/sessions/history
// enforces (local dashboard-recorded sessions, OR gateway-confirmed
// membership in a registered repo's escalation/reviewer agent), not a
// narrower local-only check. Fixed 2026-07-31: this used to check
// sessionIndex.list() directly, a stale narrower check left behind when
// resolveSessionEntry() was widened for gateway-origin sessions - a
// gateway-origin session (cross-repo xref, reviewer), visible and
// watchable live in Recents, couldn't actually be aborted through this
// route, 404ing instead.
router.post("/api/sessions/abort", requireAuth, express.json({ limit: "4kb" }), async (req, res) => {
  const { sessionKey } = req.body || {};
  if (!sessionKey || typeof sessionKey !== "string") {
    return res.status(400).json({ error: "sessionKey is required" });
  }
  let entry;
  try {
    entry = await resolveSessionEntry(sessionKey);
  } catch (err) {
    console.error("routes/sessions: failed to resolve session:", err.message);
    return res.status(502).json({ error: "failed to verify session" });
  }
  if (!entry) {
    return res.status(404).json({ error: "unknown session" });
  }
  try {
    const result = await gatewayClient.call("chat.abort", { sessionKey });
    res.json({ ok: true, aborted: Boolean(result && result.aborted) });
  } catch (err) {
    console.error("routes/sessions: chat.abort failed:", err.message);
    res.status(502).json({ error: `failed to abort run: ${err.message}` });
  }
});

// Uses sessionIndex.hide() (not remove()) - fixed live 2026-07-30: the
// original remove()-only version 404'd for a gateway-origin sessionKey
// (never in sessionIndex's own entries to begin with), which is exactly
// why app.js used to skip rendering a delete button for one of those at
// all. hide() works for either origin and always succeeds - no more
// "unknown session" 404 branch, since "hide this key" is well-defined
// (and idempotent) regardless of whether it was ever recorded locally.
router.delete("/api/sessions", requireAuth, (req, res) => {
  const sessionKey = req.query.key;
  if (!sessionKey || typeof sessionKey !== "string") {
    return res.status(400).json({ error: "key is required" });
  }
  try {
    sessionIndex.hide(sessionKey);
    res.json({ ok: true });
  } catch (err) {
    console.error("routes/sessions: failed to hide session:", err.message);
    res.status(500).json({ error: "failed to delete session" });
  }
});

// DELETE /api/sessions/all -> {ok}. Powers the Settings modal's Data
// Management > "Delete All My Chats" action. A distinct literal path
// rather than a query-param variant of the single-delete route above
// (e.g. `?all=1`) - keeps the "which session" vs "every session"
// distinction explicit in the URL rather than in an easy-to-miss query
// flag on a destructive endpoint.
//
// Fixed live 2026-07-30: the original sessionIndex.clear()-only version
// only ever wiped LOCAL entries - confirmed live that every gateway-
// origin conversation in Recents (the majority of a real operator's
// list, in practice) was back after the next refresh/relogin, since
// clear() never touched them and getMergedSessions() re-discovers them
// from the Gateway on every fetch regardless. Fetches the FULL current
// merged list (local + gateway-origin) first, then hides every one of
// those exact keys in one batch via hideAll() - see its own comment for
// why that combination is what actually keeps Recents empty afterward.
router.delete("/api/sessions/all", requireAuth, async (req, res) => {
  try {
    const currentSessions = await getMergedSessions();
    sessionIndex.hideAll(currentSessions.map((s) => s.sessionKey));
    res.json({ ok: true });
  } catch (err) {
    console.error("routes/sessions: failed to delete all sessions:", err.message);
    res.status(500).json({ error: "failed to delete all sessions" });
  }
});

module.exports = router;
// Attached for direct testing (see test/sessionsHistory.test.js) - pure,
// stateless logic, easiest verified in isolation rather than only through
// a full HTTP round-trip.
module.exports.mergeUserMessages = mergeUserMessages;
// Attached for wsRelay.js's own /ws upgrade auth check (see its own
// comment on the ownership guard) - fixed live 2026-07-30: that check
// only ever verified sessionIndex.exists() (local/dashboard-origin
// entries), which never recognized a gateway-origin session (cross-repo
// xref, reviewer) even though getMergedSessions() has surfaced those in
// Recents since 2026-07-29. Opening a still-running one of those from
// Recents 403'd the live-socket upgrade silently - the client fell back
// to showing only its static chat.history replay with no error surfaced.
// Reusing the exact same local+gateway lookup here (rather than a
// separate, potentially-drifting check in wsRelay.js) keeps both
// call sites agreeing on what "this dashboard knows about this session"
// means. No circular require risk: nothing this file (or its own
// requires) pulls in ever requires wsRelay.js.
module.exports.resolveSessionEntry = resolveSessionEntry;
// Attached for direct testing (see test/sessionsLabelBatch.test.js) - the
// call site that actually wires labelsFromRecentMessages() into the merged
// list is the layer a unit test of that function alone would miss (the
// real bug fixed 2026-07-31 was exactly a call-site/signature mismatch
// after a rename, not a defect inside the label function itself).
module.exports.getMergedSessions = getMergedSessions;
// Exported for routes/ops.js's POST /api/ops/decision - needs a real
// label (not the fixed DECISION_MESSAGES text) when it first persists a
// gateway-origin session into sessionIndex, see sessionIndex.record()'s
// own comment on the label param for why.
module.exports.labelsFromRecentMessages = labelsFromRecentMessages;
