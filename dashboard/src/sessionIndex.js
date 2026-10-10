// sessionIndex.js - a tiny JSON-file index of past dashboard sessions
// (sessionKey, repoKey, a short label, timestamps) so the sidebar's
// Recents list survives a dashboard restart.
//
// Originally deliberately stored no transcript/message content at all -
// the agent's own conversation history already lives on the Gateway side
// per session, fetchable on demand via OpenClaw's chat.history RPC (see
// README). That held until a real run confirmed 2026-07-24 that
// chat.history's own messages array never includes the operator's own
// dashboard-submitted text as a distinct entry at all (not filtered out
// by a content-shape mismatch - genuinely absent from what the endpoint
// returns) - this gateway apparently doesn't record a dashboard-triggered
// instruction as a literal chat turn the way it does the agent's own
// responses. Since the dashboard is the one party that DOES know this
// text for certain (it's exactly what /api/run itself sent), every user
// message is now recorded here too (`userMessages`, not just the first
// used as the Recents label) and merged back into chat.history's replay
// server-side - see routes/sessions.js's GET /api/sessions/history.
//
// Single JSON file, not a database - at dashboard scale (one team, a
// handful of repos, no intended long-term audit log per README's
// "explicitly out of scope" list) a database would be infrastructure
// with nothing to justify it. Not concurrency-safe against truly
// simultaneous writes (last write wins on a read-modify-write race) -
// acceptable for this traffic level, revisit only if it ever actually
// bites.
//
// A second tiny file, hidden-sessions.json, tracks "this dashboard was
// asked to hide this sessionKey from Recents" separately from this one's
// own entries - see hide()/hideAll()'s own comments for why a Recents
// item's ORIGIN (recorded here locally vs. discovered live from the
// Gateway) means a single entries-array delete can't be the whole story.

const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const INDEX_PATH = path.join(DATA_DIR, "sessions.json");
const HIDDEN_PATH = path.join(DATA_DIR, "hidden-sessions.json");
const MAX_ENTRIES = 200; // simple cap, not an audit log - oldest-by-activity drop off past this
const MAX_HIDDEN = 500; // same "simple cap, not an audit log" reasoning as MAX_ENTRIES - see hide()'s own comment
const LABEL_MAX_LENGTH = 80;
const MAX_MESSAGES_PER_SESSION = 200; // matches MAX_ENTRIES's own "simple cap, not an audit log" reasoning

function load() {
  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.warn(`sessionIndex: failed to read ${INDEX_PATH}, starting fresh:`, err.message);
    return [];
  }
}

function save(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2));
}

// Separate tiny JSON file (not folded into sessions.json's own entries
// array) so this dashboard's own "I asked to hide this" bookkeeping stays
// distinct from "this dashboard recorded this session" bookkeeping - a
// gateway-origin sessionKey that gets hidden was never in sessions.json's
// entries to begin with (see hide()'s own comment), so it needs somewhere
// to live regardless of local-entry state.
function loadHidden() {
  try {
    const raw = fs.readFileSync(HIDDEN_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.warn(`sessionIndex: failed to read ${HIDDEN_PATH}, starting fresh:`, err.message);
    return [];
  }
}

function saveHidden(keys) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HIDDEN_PATH, JSON.stringify(keys, null, 2));
}

// Records a new session, or bumps an existing one's updatedAt (a
// follow-up message continuing the same session). The label is only set
// once, from the session's first message - later continuations keep the
// original label so a Recents entry still reads as "what this
// conversation started as" rather than drifting to whatever was said
// most recently. Every message is ALSO appended to userMessages
// (chronological order, exactly as sent) regardless of whether this is
// the first or a later continuation - see routes/sessions.js's history
// merge for why.
// decision/decisionLabel (both optional): set together by routes/ops.js's
// POST /api/ops/decision, right after the decision message this same call's
// `message` param actually sent via chat.send succeeds - NOT a guess at
// whether the agent acted on it (that still requires the agent to wake and
// rewrite the tracker/suppression file, same as ever), only a record that
// the operator sent SOMETHING for this sessionKey. Exists to fix two real
// gaps found 2026-09-03: (1) a gateway-origin session (never in this index
// to begin with) has no persistence beyond whatever bounded "recent
// sessions" history the Gateway itself keeps per agent - once enough newer
// activity pushes it out, an unresolved decision on it goes from "sitting
// in Recents" to "invisible", not "resolved"; calling record() here (which
// already unconditionally persists into sessions.json regardless of
// origin) fixes that the same way a dashboard-typed message always has.
// (2) Recents had no way to show "you already responded here" versus
// "still needs a look" - lastDecision/lastDecisionAt is that marker, read
// by app.js's renderRecents(). A later decision on the same sessionKey
// (e.g. approve-suppression sent again, or a stage-4 decision after an
// earlier one) simply overwrites these two fields - there is only ever
// "the most recent decision sent", never a history of them, matching this
// whole file's "not an audit log" stance elsewhere.
//
// label (optional): overrides the default "derive the label from message"
// behavior for a brand-new entry. Needed specifically for case (1) above -
// message here is the fixed DECISION_MESSAGES text (e.g. deny's multi-step
// instruction), which makes a useless Recents label on its own. routes/ops.js
// fetches a real label the normal Recents-list way (labelsFromRecentMessages,
// the same helper getMergedSessions() already uses) before calling record()
// on a session not yet in this index, and passes it through here. Ignored
// on the existing-entry branch, matching how a first message's label
// already "sticks" for every later continuation regardless of what a
// continuation's own text looks like.
function record({ sessionKey, repoKey, message, decision, decisionLabel, label }) {
  const entries = load();
  const now = Date.now();
  const existing = entries.find((e) => e.sessionKey === sessionKey);
  if (existing) {
    existing.updatedAt = now;
    existing.userMessages = existing.userMessages || []; // older entries recorded before this field existed
    existing.userMessages.push({ text: message, sentAt: now });
    if (existing.userMessages.length > MAX_MESSAGES_PER_SESSION) {
      existing.userMessages = existing.userMessages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    if (decision) {
      existing.lastDecision = decision;
      existing.lastDecisionLabel = decisionLabel || decision;
      existing.lastDecisionAt = now;
    }
  } else {
    entries.push({
      sessionKey,
      repoKey,
      label: (label || message).slice(0, LABEL_MAX_LENGTH),
      createdAt: now,
      updatedAt: now,
      userMessages: [{ text: message, sentAt: now }],
      ...(decision ? { lastDecision: decision, lastDecisionLabel: decisionLabel || decision, lastDecisionAt: now } : {}),
    });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  save(entries);

  // A message actually being sent into this exact sessionKey is the
  // dashboard genuinely being used for it right now - overrides any
  // earlier hide()/hideAll() for this key rather than leaving a session
  // the operator is actively continuing invisible in its own Recents
  // list. Cheap no-op when the key was never hidden.
  unhide(sessionKey);
}

// Already sorted most-recently-active first by record() above.
function list() {
  return load();
}

// Powers wsRelay.js's /ws upgrade ownership check - confirmed live
// 2026-07-24 (backend review) that the upgrade handler accepted ANY
// client-supplied sessionKey with no check against this index at all,
// unlike routes/run.js and routes/sessions.js which both already gate on
// it. Made practically reachable by two other confirmed facts together:
// sessionKey's format is low-entropy and guessable
// (agent:<repoKey>-escalation:dashboard-<epoch-ms>, see routes/run.js),
// and repoKey values are themselves exposed via GET /api/repos - so
// anyone holding the one shared dashboard password could enumerate/guess
// another repo's sessionKey and pull its buffered history plus live
// stream over /ws, entirely independent of the Recents-list feature.
function exists(sessionKey) {
  return load().some((e) => e.sessionKey === sessionKey);
}

// Removes a session from the index - powers the Recents list's delete
// affordance (see routes/sessions.js's DELETE /api/sessions). This ONLY
// forgets the dashboard's own bookkeeping entry (what makes the session
// show up in Recents) - it does NOT delete anything on the Gateway side.
// Whether/how to delete the agent's own conversational memory there is a
// separate, unconfirmed question (no sessions.delete-shaped RPC has ever
// been confirmed against a real gateway in this project, matching the
// "don't guess an RPC shape" rule the rest of this codebase follows) -
// explicitly out of scope here, consistent with this file's own "no
// transcript content stored here" boundary. Returns true if an entry was
// actually found and removed, false if sessionKey wasn't in the index
// (already gone, or never existed).
function remove(sessionKey) {
  const entries = load();
  const next = entries.filter((e) => e.sessionKey !== sessionKey);
  const removed = next.length !== entries.length;
  if (removed) save(next);
  return removed;
}

// Wipes every LOCALLY-recorded entry at once. Kept as its own primitive
// (used by hideAll() below, not exposed as the Delete All action itself
// anymore) because it's genuinely a different operation from hiding -
// this only ever touches sessions.json's own entries, never the hidden
// set. See hideAll()'s own comment for why Delete All needs more than
// this alone.
function clear() {
  save([]);
}

// Confirmed live 2026-07-30: a real Recents list is a MIX of locally-
// recorded (dashboard-origin) and gateway-discovered (remote-origin,
// see getMergedSessions() in routes/sessions.js) entries, and remove()/
// clear() above only ever touch the local half - a gateway-origin entry
// was never in sessions.json's entries to begin with, so removing/
// clearing there is a no-op for it and it reappears on the very next
// fetch. Two real bugs traced to this: (1) no delete button rendered at
// all for a gateway-origin Recents item (app.js explicitly skipped it,
// "would just be a no-op button that looks like it does something"), and
// (2) "Delete All My Chats" appeared to work, then every gateway-origin
// conversation was back after a refresh/relogin.
//
// hide() fixes both by tracking dismissal SEPARATELY from where a
// session's data actually lives - removes the local entry if present
// (tidiness, not required for correctness) AND records the key in its
// own hidden-sessions.json regardless of origin. getMergedSessions()
// filters both local and gateway-origin entries against this same set,
// so a hidden gateway-origin session simply never reappears - not
// because it stopped existing on the Gateway (it didn't, and can't be
// deleted there - see remove()'s original comment on why this project
// never guesses at an unconfirmed sessions.delete-shaped RPC), but
// because it's now excluded from what this dashboard chooses to show.
function hide(sessionKey) {
  remove(sessionKey);
  const hidden = loadHidden();
  if (!hidden.includes(sessionKey)) {
    hidden.push(sessionKey);
    if (hidden.length > MAX_HIDDEN) hidden.splice(0, hidden.length - MAX_HIDDEN); // oldest-hidden drop off past this - see MAX_ENTRIES' own "simple cap" reasoning
    saveHidden(hidden);
  }
}

// See record()'s own call to this - actively sending a message into a
// previously-hidden sessionKey means the operator is using it again now,
// which should win over an earlier hide.
function unhide(sessionKey) {
  const hidden = loadHidden();
  const next = hidden.filter((k) => k !== sessionKey);
  if (next.length !== hidden.length) saveHidden(next);
}

function isHidden(sessionKey) {
  return loadHidden().includes(sessionKey);
}

// Powers the Settings modal's Data Management > "Delete All My Chats"
// action (see routes/sessions.js's DELETE /api/sessions/all). Takes the
// FULL current Recents list (local + gateway-origin - the caller passes
// getMergedSessions()'s own output) and hides every one of those keys in
// one batched write, then wipes the local entries too - the combination
// that actually keeps Recents empty after a refresh, unlike clear()
// alone (see hide()'s own comment for why clear() alone isn't enough).
// Still never touches anything on the Gateway side.
function hideAll(sessionKeys) {
  const hidden = new Set(loadHidden());
  for (const key of sessionKeys) hidden.add(key);
  let next = [...hidden];
  if (next.length > MAX_HIDDEN) next = next.slice(next.length - MAX_HIDDEN);
  saveHidden(next);
  clear();
}

module.exports = { record, list, remove, clear, exists, hide, unhide, isHidden, hideAll };
