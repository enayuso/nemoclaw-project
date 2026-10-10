// app.js - vanilla JS, no build step. Login, repo list, starting a run,
// and rendering the live WS stream.

// setHidden() - use this instead of `el.hidden = bool` anywhere in this
// file. The recurring bug this prevents: an element's own CSS rule sets
// `display` unconditionally (e.g. `#foo { display: flex }`), which beats
// the browser's default `[hidden] { display: none }` on specificity, so
// `el.hidden = true` silently does nothing visually. This has been found
// and fixed at least 6 separate times across this file's history -
// #run-status (2026-07-27), #jump-latest-btn, #account-dropdown, and
// #agent-mismatch-banner/#stage-indicator/.badge (2026-08-04) - each time
// via a CSS-side `:not([hidden])` guard on that one selector, which only
// prevents THAT element from recurring, not the next new one someone adds
// without remembering this footgun. Setting `style.display` inline here
// instead makes hiding win regardless of any stylesheet rule, forever -
// inline styles beat any selector short of `!important`. The `hidden`
// attribute is still set/cleared too (not just the inline style), since
// several existing CSS rules key layout/position off `:not([hidden])`
// (e.g. #activity-dropdown) and would otherwise stop applying correctly
// when shown. Clearing style.display (rather than setting it to a guessed
// value) when un-hiding lets the stylesheet's own display value - flex,
// block, whatever - take over normally, so this helper never needs to
// know any element's "correct" shown display value.
function setHidden(el, hidden) {
  el.hidden = hidden;
  el.style.display = hidden ? "none" : "";
}

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");

const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const passwordInput = document.getElementById("password");

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarOpenBtn = document.getElementById("sidebar-open-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const opsBtn = document.getElementById("ops-btn");
const opsApprovalsBadge = document.getElementById("ops-approvals-badge");

const agentMismatchBanner = document.getElementById("agent-mismatch-banner");
const agentMismatchText = document.getElementById("agent-mismatch-text");
const agentMismatchDismiss = document.getElementById("agent-mismatch-dismiss");
const configDriftBanner = document.getElementById("config-drift-banner");
const configDriftText = document.getElementById("config-drift-text");
const configDriftDismiss = document.getElementById("config-drift-dismiss");
const opsCapabilities = document.getElementById("ops-capabilities");
const modelHealthBanner = document.getElementById("model-health-banner");
const modelHealthText = document.getElementById("model-health-text");
const modelHealthDismiss = document.getElementById("model-health-dismiss");

const activityMenu = document.getElementById("activity-menu");
const activityBtn = document.getElementById("activity-btn");
const activityBadge = document.getElementById("activity-badge");
const activityDropdown = document.getElementById("activity-dropdown");
const activityList = document.getElementById("activity-list");

const accountMenu = document.getElementById("account-menu");
const accountBtn = document.getElementById("account-btn");
const accountDropdown = document.getElementById("account-dropdown");
const openSettingsBtn = document.getElementById("open-settings-btn");
const accountLogoutBtn = document.getElementById("account-logout-btn");

const settingsModal = document.getElementById("settings-modal");
const settingsModalPanel = document.getElementById("settings-modal-panel");
const settingsModalBackdrop = document.getElementById("settings-modal-backdrop");
const settingsModalClose = document.getElementById("settings-modal-close");
const settingsNavItems = document.querySelectorAll(".settings-nav-item");
const deleteAllChatsBtn = document.getElementById("delete-all-chats-btn");

const opsModal = document.getElementById("ops-modal");
const opsModalPanel = document.getElementById("ops-modal-panel");
const opsModalBackdrop = document.getElementById("ops-modal-backdrop");
const opsModalClose = document.getElementById("ops-modal-close");
const opsNavItems = document.querySelectorAll(".ops-nav-item");
const opsWatchersList = document.getElementById("ops-watchers-list");
const opsAgentsList = document.getElementById("ops-agents-list");
const opsApprovalsList = document.getElementById("ops-approvals-list");
const opsApprovalsTabBadge = document.getElementById("ops-approvals-tab-badge");
const opsFixesList = document.getElementById("ops-fixes-list");
const opsFixesSummary = document.getElementById("ops-fixes-summary");
const opsFixesTabBadge = document.getElementById("ops-fixes-tab-badge");

const watcherHistoryView = document.getElementById("watcher-history-view");
const watcherHistoryBack = document.getElementById("watcher-history-back");
const watcherHistoryTitle = document.getElementById("watcher-history-title");
const watcherHistoryStatus = document.getElementById("watcher-history-status");
const watcherHistoryHead = document.getElementById("watcher-history-head");
const watcherHistoryList = document.getElementById("watcher-history-list");
const watcherHistoryPager = document.getElementById("watcher-history-pager");
const watcherHistoryPrev = document.getElementById("watcher-history-prev");
const watcherHistoryNext = document.getElementById("watcher-history-next");
const watcherHistoryRange = document.getElementById("watcher-history-range");

const monitoringBtn = document.getElementById("monitoring-btn");
const monitoringView = document.getElementById("monitoring-view");
const monitoringBack = document.getElementById("monitoring-back");
// The FOUR top-level views are mutually exclusive, and this is the only place
// that decides which one is up. Each view used to be swapped in by hand at its
// own call site - `setHidden(appView, true); setHidden(thisOne, false)` - which
// works while there are two of them and silently rots as they are added: every
// close() has to know what to fall back to, and every new view has to be
// retro-fitted into every other view's transitions. It wasn't retro-fitted, and
// 8a23389 is what that cost - the run-history page left rendered full-page below
// the login form, because showLogin() knew about #app-view and not about the
// third view added after it. Monitoring was the fourth, added on a branch cut
// before that fix, so it arrived with the same shape.
//
// Showing one view by naming it, rather than hiding whatever you happen to
// remember, makes that class of bug unrepresentable: a view nobody named is
// hidden, including views added later that this call site has never heard of.
const topLevelViews = [loginView, appView, watcherHistoryView, monitoringView];
function showTopLevelView(target) {
  for (const view of topLevelViews) setHidden(view, view !== target);
}

const monitoringTargetSelect = document.getElementById("monitoring-target-select");
const monitoringLimitsLabel = document.getElementById("monitoring-limits");
const monitoringGrid = document.getElementById("monitoring-grid");
const monitoringStatus = document.getElementById("monitoring-status");

const confirmDialog = document.getElementById("confirm-dialog");
const confirmDialogPanel = document.getElementById("confirm-dialog-panel");
const confirmDialogBackdrop = document.getElementById("confirm-dialog-backdrop");
const confirmDialogTitle = document.getElementById("confirm-dialog-title");
const confirmDialogMessage = document.getElementById("confirm-dialog-message");
const confirmDialogCancelBtn = document.getElementById("confirm-dialog-cancel");
const confirmDialogConfirmBtn = document.getElementById("confirm-dialog-confirm");

const repoSelect = document.getElementById("repo-select");
const repoMeta = document.getElementById("repo-meta");
const repoTitle = document.getElementById("repo-title");
const recentsList = document.getElementById("recents-list");

const messageInput = document.getElementById("message-input");
// Captured once, at module load, before anything ever mutates
// messageInput.placeholder (see openHistoricalSession, further below,
// which overwrites it for a gateway-origin session) - reading the HTML's
// own default here means there's no second, hand-copied string of this
// text anywhere in this file to drift out of sync with index.html.
const DEFAULT_MESSAGE_PLACEHOLDER = messageInput.placeholder;
const composer = document.getElementById("composer");
const runBtn = document.getElementById("run-btn");
const runError = document.getElementById("run-error");

const sessionKeyLabel = document.getElementById("session-key-label");
const statusBanner = document.getElementById("status-banner");
const conversation = document.getElementById("conversation"); // the actual scrolling ancestor - #transcript itself has no overflow/height constraint
const transcript = document.getElementById("transcript");
// #transcript-history holds a one-shot static replay of a past
// conversation (see openHistoricalSession/renderHistoryReplay); the reveal
// queue targets #transcript-live specifically, not #transcript itself, so
// replayed history and newly-streaming live content can coexist - a
// follow-up sent after viewing history appends after it instead of the
// queue's next re-render clobbering the just-rendered replay.
const transcriptHistory = document.getElementById("transcript-history");
const transcriptLive = document.getElementById("transcript-live");
const conversationEmpty = document.getElementById("conversation-empty");
const jumpLatestBtn = document.getElementById("jump-latest-btn");
const sessionDecisionCard = document.getElementById("session-decision-card");
const sessionDecisionDescription = document.getElementById("session-decision-description");
const sessionDecisionActions = document.getElementById("session-decision-actions");
const sessionDecisionStatus = document.getElementById("session-decision-status");
const agentReplyActions = document.getElementById("agent-reply-actions");
const agentReplyNote = document.getElementById("agent-reply-note");
const agentReplyButtons = document.getElementById("agent-reply-buttons");
const agentReplyStatus = document.getElementById("agent-reply-status");
const runStatus = document.getElementById("run-status");
const runStatusLabel = document.getElementById("run-status-label");
const runStatusTimer = document.getElementById("run-status-timer");
const runStatusTokens = document.getElementById("run-status-tokens");
const runStatusContext = document.getElementById("run-status-context");

let repos = [];
// The configured model's context window (tokens), fetched once via
// loadModelInfo() below - null until known (or if genuinely unavailable),
// in which case updateRunContextUsage's own percentage/color just stays
// hidden, same as it already does before any usage has been seen.
let contextWindowTokens = null;
// How full the context window actually is, in tokens: the most recent
// assistant turn's usage (see updateRunContextUsage). Deliberately SEPARATE
// from the session's cumulative token count - see the comment on
// updateRunStatusTokens for why conflating the two produced a percentage
// that read 254% on a session that never exceeded 18% of its window.
let contextUsedTokens = null;
let sessions = []; // cached GET /api/sessions result, powers the Recents list
let activeSocket = null;
let toolCallSeq = 0;
const toolCallCards = new Map(); // toolCallId -> <details> element
// Wrapper-toolCall id -> that call's `arguments` object, harvested from
// session.message frames. Only used by the item-stream path (CLI/cron-
// triggered runs), which is the one place the tool's own events never
// carry their arguments - see renderItemToolCard for the full shape.
const itemToolArgs = new Map();
// The live-path <details class="tool-group"> currently accepting new tool
// cards, or null if the next tool call should start a fresh group - see
// closeToolGroup()'s own comment for exactly when/why this closes.
let currentToolGroup = null;
// Same idea as currentToolGroup, for the live path's currently-open
// "Thinking" block - see closeThinkingGroup()'s own comment.
let currentThinkingGroup = null;
// The most recently attached assistant turn's own outer element (set in
// startAssistantTurn's attach callback) - see the thinking-group creation
// block in renderFrame for why this is needed: confirmed live 2026-07-29
// (a plain "hello" query) that for a fast/simple reply the gateway's own
// first content-bearing frame is pure text via chat's deltaText, with
// "thinking" for that SAME turn only showing up ~100ms+ later bundled
// into a session.message snapshot - by which point this turn's own
// bubble is already attached. Lets a late-arriving thinking group insert
// itself BEFORE the bubble it belongs to instead of after it.
let currentAssistantTurnEl = null;

// Which repoKey the currently-displayed session (if any) belongs to. A
// follow-up message submitted for the SAME repoKey while a session is
// still active continues that session (reuses its sessionKey) instead of
// starting a brand-new one - matches actual chat behavior instead of
// wiping the transcript on every message. Cleared by "+ New task" or by
// switching to a different repo, either of which should start fresh.
let currentSessionRepoKey = null;

// Bumped by any action that switches which session is being viewed (new
// task, starting a fresh run, opening a historical session). An in-flight
// async operation (a chat.send POST awaiting its 90s server-side timeout,
// a chat.history fetch) captures the value at its own start and checks it
// again before applying results - if it's changed, a newer navigation has
// since superseded it, so it bails out rather than clobbering whatever
// the user is now looking at. Same guard family as openSocket's
// `ws !== activeSocket` check, extended to non-socket async paths -
// reviewed 2026-07-24: without this, two overlapping Recents clicks (or a
// slow-in-flight follow-up plus a navigation away) could leave
// sessionKeyLabel/repoSelect and the actually-open socket pointing at two
// different sessions.
let sessionGeneration = 0;

// Transcript/thinking text is Markdown (headings, bold/italic, tables,
// code) - confirmed from a real run showing it rendered as literal
// "**bold**"/"| table |" source text instead of formatted output. Parsed
// with marked, then sanitized with DOMPurify before hitting innerHTML -
// this text ultimately comes from an LLM agent that may have read
// untrusted external content (files, web pages) as part of its work, so
// treat it the same as any other untrusted HTML source rather than
// trusting it just because it's "our own" agent.
function renderMarkdownToSafeHtml(text) {
  if (!text) return "";
  const html = marked.parse(text, { gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

// Small slack (px) for "close enough to the bottom to still count as
// following the stream" - sub-pixel/zoom rounding means scrollTop rarely
// lands on the exact mathematical bottom even when a user hasn't
// deliberately scrolled at all.
const SCROLL_STICK_THRESHOLD_PX = 48;

// Whether el is currently scrolled close enough to its own bottom that
// auto-follow should keep tracking it. MUST be called BEFORE the DOM
// mutation that's about to grow el's content - scrollHeight grows the
// moment new content lands, so checking afterward would nearly always
// read as "not near the bottom" even when the user hadn't scrolled at
// all. See stickToBottom's own comment for the paired "after" half of
// this pattern.
function isScrolledNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_STICK_THRESHOLD_PX;
}

// Shows #jump-latest-btn whenever the conversation has actually scrolled
// away from the bottom AND there's something to scroll to in the first
// place (a short conversation with no overflow at all has nothing to
// "jump" to). Called both from the conversation's own "scroll" listener
// below (covers the user manually scrolling, and any programmatic
// scrollTop change - which fires a native scroll event same as a manual
// one) and from stickToBottom (covers the one case a scroll event can't:
// new content growing scrollHeight while the user stays scrolled away,
// where scrollTop itself never changes so no scroll event fires at all).
//
// 0730: also closes the last few pixels to the true bottom once the user's
// own manual scroll lands within SCROLL_STICK_THRESHOLD_PX of it, instead of
// only toggling the jump button. Reported: scrolling up during an active
// response, then trying to scroll back down manually, could never quite
// reach the actual bottom - "Jump to latest" fixed it, but the same thing
// recurred on scrolling up again. Root cause: while content is still
// streaming, scrollHeight keeps growing every ~16ms tick (createRevealQueue's
// render()), but a tick only auto-follows when wasNearBottom was ALREADY
// true going in - a manual scroll that lands merely close to the bottom
// (not exactly at it) leaves a small gap that the next tick's own
// isScrolledNearBottom check still reads as "not near enough", so nothing
// auto-follows and the gap never closes on its own; the user is chasing a
// target that keeps moving away by roughly the same amount each tick.
// Snapping the rest of the way here, the instant a manual scroll crosses the
// threshold, removes that gap immediately rather than waiting on (and losing
// to) the next content tick. Setting scrollTop does fire another "scroll"
// event, but re-running this against an unchanged scrollTop is a no-op, not
// a loop.
//
// 0731: gated on runIsActive - confirmed live as a real regression the
// ungated version introduced: on a STATIC view (a reloaded historical
// session, or simply an idle live one with nothing streaming), scrollHeight
// never grows on its own, so nothing ever pushes the gap measurement past
// the threshold FOR the user - unlike during active streaming, where it
// does. Every individual wheel-scroll tick landing within the threshold got
// reverted immediately, so small wheel deltas could never accumulate past
// it - the user was stuck unable to scroll up with the wheel at all (only
// escaping via a single continuous scrollbar-thumb drag, since browsers
// don't let a script-driven scrollTop write override an in-progress native
// drag the way they do a plain wheel-driven scroll). Restricting this to
// "a response is actually streaming" keeps the original fix (closing the
// gap while content keeps growing out from under a near-bottom scroll)
// without fighting normal scrolling the rest of the time.
// Opt-in scroll diagnostic, same convention as renderFrame's debugFrames
// flag further below (off by default, localStorage rather than a permanent
// console.log). Armed for the "can't scroll down after a few follow-ups,
// fixed by a refresh" report, which has two very different candidate
// causes that static reading can't separate:
//   1. a wheel trap - tool output <pre> is its own 320px scroller spanning
//      the full text column, so a wheel over one scrolls THAT box until
//      it's exhausted, never the conversation. Would show up as `wheel`
//      entries where trap is non-null and before === after.
//   2. something writing conversation.scrollTop back - would show up as
//      `stick`/`autoFollow` entries interleaved with the user's own
//      scrolling.
// If neither appears but scrollTop still moves on its own, that leaves the
// browser's scroll anchoring reacting to content being re-rendered above
// the viewport, which is a third fix entirely.
//
// Enable from devtools with localStorage.setItem("debugScroll", "1"),
// reproduce, then read back window.__scrollLog.
const debugScroll = localStorage.getItem("debugScroll") === "1";

function logScroll(what, extra) {
  if (!debugScroll) return;
  window.__scrollLog = window.__scrollLog || [];
  window.__scrollLog.push({
    t: Date.now(),
    what,
    top: Math.round(conversation.scrollTop),
    max: conversation.scrollHeight - conversation.clientHeight,
    runIsActive,
    ...extra,
  });
  // Bounded so leaving the flag on overnight can't grow without limit.
  if (window.__scrollLog.length > 1000) window.__scrollLog.shift();
}

function updateJumpLatestVisibility() {
  const hasOverflow = conversation.scrollHeight > conversation.clientHeight;
  const nearBottom = isScrolledNearBottom(conversation);
  setHidden(jumpLatestBtn, !hasOverflow || nearBottom);
  if (runIsActive && nearBottom) {
    logScroll("autoFollow");
    conversation.scrollTop = conversation.scrollHeight;
  }
}

// Re-applies scrollTop = scrollHeight ONLY if wasNearBottom (captured via
// isScrolledNearBottom BEFORE the content-growing mutation) was true -
// auto-follows the stream for a user who was already at the bottom,
// without fighting one who deliberately scrolled up to (re-)read
// something. Every one of this file's per-tick/per-event conversation
// scrolls used to force scrollTop = scrollHeight unconditionally,
// including on every single reveal-queue tick (~every 16ms) while a
// response is actively streaming - reported live 2026-07-27: this made
// it impossible to scroll up at all while output was streaming, since
// the very next tick snapped the view straight back to the bottom.
// Deliberately NOT applied to the few genuinely explicit-action scrolls
// (sending your own message, opening a past conversation) - those stay
// unconditional, matching Claude Code's own convention that an action
// you just took is allowed to move your view, but passive streaming
// isn't.
function stickToBottom(el, wasNearBottom) {
  if (wasNearBottom) {
    if (el === conversation) logScroll("stick");
    el.scrollTop = el.scrollHeight;
  }
  if (el === conversation) updateJumpLatestVisibility();
}

// Decouples "when text arrives over the network" from "when it's shown
// on screen" - the gateway's own chunking can be bursty, so appending
// deltaText directly on arrival looks rigid. This drains a buffer at a
// steady pace instead, producing a smooth typewriter effect regardless
// of network burstiness. charsPerTick/tickMs are a starting point
// (~125 chars/sec), not verified against a real run yet - easy to tune.
// Re-renders the full revealed-so-far text as Markdown on every tick
// rather than appending raw characters - re-parsing a few KB of text
// every 16ms is comfortably cheap, and appending raw HTML fragments
// char-by-char would both break mid-tag and bypass sanitization.
//
// targetEl is optional at construction and re-pointable via retarget() -
// transcriptQueue (below) needs this so each new assistant chat bubble
// (see startAssistantTurn) gets its own fresh target instead of every
// turn's text accumulating into one shared, undifferentiated element.
function createRevealQueue(targetEl) {
  const charsPerTick = 2;
  const tickMs = 16;
  let buffer = "";
  let revealed = "";
  let el = targetEl || null;
  let timer = null;
  // Set via retarget()'s second argument, consumed (and cleared) the first
  // time push() actually has real text to show - see startAssistantTurn's
  // use of this for why a target existing isn't the same as it being
  // worth showing yet.
  let pendingAttach = null;
  function render() {
    if (!el) return;
    // Captured BEFORE innerHTML grows el's (and #conversation's) content -
    // see isScrolledNearBottom's own comment for why the order matters.
    const elWasNearBottom = isScrolledNearBottom(el);
    const conversationWasNearBottom = isScrolledNearBottom(conversation);
    el.innerHTML = renderMarkdownToSafeHtml(revealed);
    stickToBottom(el, elWasNearBottom);
    // #conversation is the actual scrolling ancestor for the transcript
    // (see its own const comment below) - harmless no-op for thinkingQueue,
    // whose el (a .thinking-body) scrolls itself instead via the line above.
    stickToBottom(conversation, conversationWasNearBottom);
  }
  function tick() {
    if (!buffer) {
      timer = null;
      return;
    }
    const chunk = buffer.slice(0, charsPerTick);
    buffer = buffer.slice(charsPerTick);
    revealed += chunk;
    render();
    timer = setTimeout(tick, tickMs);
  }
  return {
    push(text) {
      if (!text) return;
      if (pendingAttach) {
        const attach = pendingAttach;
        pendingAttach = null;
        attach();
      }
      buffer += text;
      // Reported live 2026-07-28: streamed content appeared to freeze
      // while the dashboard tab wasn't focused (another tab/app active),
      // then jump forward all at once on returning to it. Root cause:
      // browsers throttle background-tab timers (this queue's own
      // setTimeout-driven tick() included), sometimes to roughly once a
      // second or slower - real content kept arriving over the WS and
      // landing in `buffer` just fine (WS message delivery isn't
      // throttled the same way), it just wasn't being drained/rendered at
      // anything close to the normal ~125 chars/sec pace. There's no
      // point animating a typewriter effect nobody can see anyway, so
      // skip the tick() queue entirely while hidden and render
      // immediately instead - by the time the tab is visible again
      // there's nothing left to "catch up" on. The visibilitychange
      // listener further below covers the other half of this: content
      // already fully buffered at the exact moment the tab BECOMES
      // hidden, with no further push() ever arriving afterward to trigger
      // this same check.
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        revealed += buffer;
        buffer = "";
        render();
        return;
      }
      if (!timer) tick();
    },
    reset() {
      buffer = "";
      revealed = "";
      timer = null;
      render();
    },
    // Used by pushSnapshotDiff to decide whether a break needs inserting
    // before appending unrelated new content - true if there's anything
    // already on screen OR still queued to be typed out.
    hasContent() {
      return Boolean(revealed || buffer);
    },
    hasTarget() {
      return el !== null;
    },
    // Instantly reveals whatever's still buffered (not yet typed out) and
    // stops the ticking timer, WITHOUT switching targets or losing
    // anything - unlike reset(), nothing already-shown or still-buffered
    // is discarded, just fast-forwarded onto the screen immediately.
    // Confirmed live 2026-07-27 as the fix for a real bug: aborting a run
    // (see chat.abort's own "lifecycle end, aborted:true" branch in
    // renderFrame) stops the actual generation server-side immediately,
    // but text already in flight over the WS before the abort landed had
    // already been pushed into this queue's buffer - with nothing calling
    // this, the slow ~125 chars/sec reveal just kept typing out that
    // backlog for several more seconds after the user clicked Stop,
    // making the button look broken even though generation had genuinely
    // already halted.
    flush() {
      if (buffer) {
        revealed += buffer;
        buffer = "";
        render();
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    // Starts a fresh bubble. Flushes whatever was still buffered but NOT
    // YET typed out for the bubble being left, instantly, into that
    // bubble, before switching - confirmed live 2026-07-24 as a severe
    // bug: internal agent turns can legitimately arrive faster than the
    // deliberately slow ~125 chars/sec typewriter reveal, and this used
    // to just wipe buffer/revealed unconditionally on retarget, silently
    // truncating - sometimes to nothing at all - every bubble except
    // whichever one happened to be "current" when the whole response
    // finished. A real fast multi-step response showed this as most
    // bubbles either completely empty or cut off after 1-6 characters
    // ("Th", "Let", "Worktr", "Good, or") - reproduced deterministically
    // with realistic timing (turns 60ms apart, reveal needing ~500ms+ to
    // finish a typical sentence) before this fix, confirmed gone after.
    retarget(newTargetEl, attachFn) {
      if (buffer) {
        revealed += buffer;
        buffer = "";
        render(); // one last render into the bubble being LEFT, now complete
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      el = newTargetEl;
      buffer = "";
      revealed = "";
      pendingAttach = attachFn || null;
    },
  };
}

// No initial target - starts null and gets pointed at each new assistant
// bubble's own body element via startAssistantTurn()/retarget(). thinkingQueue
// works the same way now (see buildThinkingGroup/closeThinkingGroup) - each
// reasoning segment gets its own inline block, same as the transcript.
const transcriptQueue = createRevealQueue();
const thinkingQueue = createRevealQueue();
// message.content is a cumulative snapshot (confirmed via NemoClaw's own
// test suite), not incremental like deltaText - these track what's
// already been revealed so only the new suffix gets pushed to the queue,
// turning a snapshot source into incremental pushes for the same smooth
// reveal mechanism. Shared by both the thinking and final-text paths via
// pushSnapshotDiff() (revealQueueDiff.js, loaded before this file).
let lastThinkingSnapshot = "";
let lastTranscriptSnapshot = "";
// Set when a chat event reports state:"final" - marks that this turn's
// content has ended so the *next* bit of content (a following turn, e.g.
// after a tool call) gets an explicit paragraph break inserted before it
// instead of being concatenated directly onto the previous turn with no
// separator at all. Confirmed live: a real run showed two turns' text
// glued together mid-sentence ("...app logs.Good news...") because
// nothing marked where one turn's stream ended and the next began.
let transcriptPendingBreak = false;

// findContentMatchEnd()/pushSnapshotDiff() now live in revealQueueDiff.js
// (loaded before this file, see index.html) - moved out so they can be
// require()'d directly by test/revealQueueDiff.test.js without needing to
// shim out this file's much larger top-level browser surface. Still plain
// globals here, same as before the split.

// Builds one chat turn - a role label plus a body element, NOT yet
// attached to any container - shared by both the live path (below) and
// the static history replay (renderHistoryReplay) so a turn looks
// identical whether it's currently streaming or being replayed from a
// past conversation. role is "user" or "assistant".
function buildChatTurn(role) {
  const turn = document.createElement("div");
  turn.className = `chat-turn chat-turn-${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "chat-turn-role";
  roleLabel.textContent = role === "user" ? "You" : "Agent";
  turn.appendChild(roleLabel);

  const body = document.createElement("div");
  body.className = "chat-turn-body";
  turn.appendChild(body);

  return { turn, body };
}

// Builds AND immediately attaches a turn - the common case (history
// replay, the user's own turn) where there's no ordering reason to
// delay attachment. startAssistantTurn below is the one exception - see
// its own comment for why it defers this.
function appendChatTurn(container, role) {
  const { turn, body } = buildChatTurn(role);
  container.appendChild(turn);
  return body;
}

// The user's own message is known in full the moment they submit it - no
// need to wait for the gateway to echo it back, so it renders immediately
// as a static bubble (not through the reveal queue, which is only for
// content genuinely arriving incrementally over the wire). Matches Claude
// Code's own convention of a distinct bubble per participant turn -
// confirmed as a real gap 2026-07-24: the live view never showed the
// user's own message at all, and every turn (user and assistant, and every
// internal agent step within one response) ran together in one continuous
// undifferentiated stream with no visual separation.
function appendUserTurn(text) {
  // A new user turn is an unambiguous tool-group/thinking-group boundary
  // even with no narration in between - without this, a follow-up whose
  // response starts with a tool call (no text first) would silently join
  // that call into whatever group the PREVIOUS turn's tool calls left
  // open.
  closeToolGroup();
  closeThinkingGroup();
  currentAssistantTurnEl = null;
  // A new user turn clears any leftover completion note from a previous
  // run - a fresh response is starting, so the prior "X mins ago" line no
  // longer applies.
  clearCompletionNote();
  const body = appendChatTurn(transcriptLive, "user");
  body.innerHTML = renderMarkdownToSafeHtml(text);
  // Deliberately unconditional (not stickToBottom) - sending your own
  // message is an explicit action, allowed to move your view regardless
  // of scroll position, same as every other passive-streaming scroll in
  // this file is deliberately NOT allowed to (see stickToBottom's comment).
  conversation.scrollTop = conversation.scrollHeight;
}

// Opens a fresh assistant bubble and points transcriptQueue at it.
// Called both when a user submits a message (a whole new response
// starting) AND for each internal agent step within that response
// (think/tool-call/think again/final answer) - confirmed live 2026-07-24
// this needs to be a NEW bubble per internal step, not one shared bubble
// with in-band paragraph breaks: chat.history's own static replay
// (renderHistoryReplay) already shows each distinct backend turn as its
// own separate "Agent" block interleaved with tool cards, and a real run
// showed the shared-bubble approach still duplicating/gluing text (a
// multi-step response's later steps don't reliably arrive in a form a
// single element's content-diffing can cleanly reconcile). A brand new
// DOM element per turn removes that risk entirely - there's no shared
// state within one turn's bubble for a later turn to corrupt.
//
// resetResponse distinguishes the two call sites: true (a genuinely new
// response, called from the composer submit handler or the lazy fallback
// below) resets lastTranscriptSnapshot, the tracker of everything shown
// across EVERY bubble in the CURRENT response - see
// reconcileTranscriptText's own comment for why this needs to stay
// cumulative (not per-bubble) even though bubbles themselves are now
// per-turn. false (an internal step boundary mid-response) leaves it
// alone, since reconcileTranscriptText/the deltaText path are still
// relying on it to detect a redundant re-delivery of a turn already
// shown earlier in this same response.
function startAssistantTurn(resetResponse) {
  const { turn, body } = buildChatTurn("assistant");
  // Deliberately NOT appended to transcriptLive here - confirmed live
  // 2026-07-27 that eagerly appending an (empty) bubble the moment a turn
  // STARTS, rather than when it actually has something to show, put that
  // bubble's DOM position ahead of anything else that happens in the
  // meantime. When the very first thing an agent does is call a tool
  // (narration only arriving afterward), the narration still landed in
  // this pre-placed bubble - which sat BEFORE the tool card in the DOM
  // regardless - so the tool call visually appeared to happen "after" text
  // that, chronologically, the gateway actually sent after it. Deferring
  // attachment until the reveal queue's first real push (see
  // createRevealQueue's pendingAttach) makes DOM order match arrival
  // order for text bubbles exactly the same way it already does for tool
  // cards (see renderToolCard).
  transcriptQueue.retarget(body, () => {
    const conversationWasNearBottom = isScrolledNearBottom(conversation);
    transcriptLive.appendChild(turn);
    currentAssistantTurnEl = turn;
    // Keep any in-flight completion note anchored as the last child in
    // case new content still needs to append after it (e.g. a reopened
    // run whose reveal queue is still draining).
    reanchorCompletionNote();
    // Narration just became visible - closes the currently-open tool
    // group and thinking group (if any) so a tool call or reasoning
    // segment that happens after this text starts its own fresh group
    // instead of joining whatever group preceded this text. See
    // closeToolGroup's/closeThinkingGroup's own comments.
    closeToolGroup();
    closeThinkingGroup();
    stickToBottom(conversation, conversationWasNearBottom);
  });
  if (resetResponse) lastTranscriptSnapshot = "";
  transcriptPendingBreak = false;
}

// Reconciles a full-text snapshot (from session.message, or a non-delta
// chat frame) against everything already shown so far in the CURRENT
// assistant response. lastTranscriptSnapshot is cumulative across every
// bubble in this response (deliberately NOT reset per-bubble - see
// startAssistantTurn's resetResponse param), so this can tell apart three
// real cases instead of just two:
//  1. fullText extends lastTranscriptSnapshot - a continuation of
//     whatever's already showing (the current bubble, or a snapshot
//     "catching up" to what deltaText already streamed into it) - push
//     just the new suffix, same bubble.
//  2. fullText doesn't extend it, but is already CONTAINED in it - a
//     REDUNDANT re-delivery of text already shown earlier in this same
//     response. Confirmed live and documented elsewhere in this file:
//     session.message can redundantly re-announce text chat's deltaText
//     stream already delivered, and can do so more than once, and can
//     do it for a full multi-turn recap (all prior turns concatenated in
//     one snapshot) as well as a single turn - a pure no-op either way,
//     nothing new to show.
//  3. Neither - genuinely new/unrelated content for a new internal turn.
//     Opens a BRAND NEW bubble for it (see startAssistantTurn) rather
//     than inserting an in-band paragraph break into a shared element.
// The "\n\n" joins mirrored into lastTranscriptSnapshot below matter for
// case 2: extractFinalText() joins multiple content parts with "\n\n",
// so a multi-turn recap snapshot needs the SAME separator convention in
// lastTranscriptSnapshot for .includes() to actually match it.
function reconcileTranscriptText(fullText) {
  if (!transcriptQueue.hasTarget()) startAssistantTurn(true);
  transcriptPendingBreak = false;

  // Both checks below are whitespace-tolerant rather than strict (0805).
  // They used to be a plain startsWith() and a plain includes(), which meant
  // a re-delivery whose only difference was reformatting counted as brand new
  // content and opened a duplicate bubble for text already on screen. The
  // real case: a reply streamed here as "Understood — ..." came back via
  // session.message as "Under\n\nstood — ...", because the gateway had split
  // that message into four content parts and extractFinalText joins parts
  // with "\n\n" - so the injected separator landed mid-word. Rather than
  // change that join (it's the right separator when the parts really are
  // separate turns, e.g. a multi-turn recap snapshot - see case 2 below),
  // the COMPARISON absorbs the difference, which is self-healing against any
  // reformatting the gateway does, not just this one shape.
  const matchEnd = findContentMatchEnd(fullText, lastTranscriptSnapshot);
  if (matchEnd !== -1) {
    const diff = fullText.slice(matchEnd);
    if (diff) transcriptQueue.push(diff);
    lastTranscriptSnapshot = fullText;
    return;
  }
  if (
    fullText.length === 0 ||
    stripWhitespace(lastTranscriptSnapshot).includes(stripWhitespace(fullText))
  ) {
    return; // redundant re-delivery - nothing new to show
  }
  startAssistantTurn(false);
  transcriptQueue.push(fullText);
  lastTranscriptSnapshot += (lastTranscriptSnapshot ? "\n\n" : "") + fullText;
}

// Shared by newChatBtn's handler, startStream(), and openHistoricalSession()
// - the real behavioral differences between those three (activeSocket
// handling, transcriptHistory content, conversationEmpty, sessionKeyLabel,
// messageInput, renderRecents()) all live outside this block, so this is
// safe to share without losing any of them.
function resetLiveState() {
  transcriptQueue.retarget(null);
  transcriptLive.innerHTML = "";
  thinkingQueue.retarget(null);
  lastThinkingSnapshot = "";
  lastTranscriptSnapshot = "";
  transcriptPendingBreak = false;
  currentAssistantTurnEl = null;
  // Tool cards now live inside transcriptLive itself (see renderToolCard),
  // so clearing transcriptLive above already removes them from the DOM -
  // this just drops the stale toolCallId -> element references. Same for
  // thinking groups (see buildThinkingGroup) - no separate DOM to clear.
  toolCallCards.clear();
  itemToolArgs.clear();
  closeToolGroup();
  closeThinkingGroup();
  clearCompletionNote();
  statusBanner.textContent = "";
  statusBanner.className = "";
  setHidden(statusBanner, true);
  // Defensive - the natural checks (no overflow once transcriptLive is
  // wiped above) already cover this in practice, but wiping content
  // doesn't necessarily change conversation.scrollTop itself, so no
  // native "scroll" event is guaranteed to fire and re-run the check.
  setHidden(jumpLatestBtn, true);
}

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle("collapsed", collapsed);
  setHidden(sidebarOpenBtn, !collapsed);
  localStorage.setItem("dashboard.sidebarCollapsed", collapsed ? "1" : "0");
}

sidebarToggle.addEventListener("click", () => setSidebarCollapsed(true));
sidebarOpenBtn.addEventListener("click", () => setSidebarCollapsed(false));
setSidebarCollapsed(localStorage.getItem("dashboard.sidebarCollapsed") === "1");

// passive: true - this listener only reads scroll position, never calls
// preventDefault, so the browser can keep scrolling on its own thread
// instead of waiting on this handler.
// Watcher run-history page wiring. Back goes through history.back() rather
// than closing the page directly, so the in-page button and the
// browser's own Back button take the identical path (popstate below)
// instead of drifting apart - clicking the in-page one and then browser
// Back would otherwise pop an entry that was never consumed.
watcherHistoryBack.addEventListener("click", () => history.back());
watcherHistoryPrev.addEventListener("click", () => {
  watcherHistoryPage -= 1;
  renderWatcherHistoryPage();
});
watcherHistoryNext.addEventListener("click", () => {
  watcherHistoryPage += 1;
  renderWatcherHistoryPage();
});

// Handles BOTH directions - Back (no state, leave the page) and Forward (state
// present, re-show it) - for every page-style view at once.
//
// Structured as "tear down what we are leaving, then move to ONE destination"
// rather than as one open/close pair per view, which is what it was when only
// the run-history page existed. With two such views that shape is a bug: each
// pair ran independently, and each close() ended by revealing #app-view as its
// assumed fallback, so a pop from Monitoring to the run-history page would show
// the history page (first pair) and then unhide the app underneath it (second
// pair) - the stacked-view bug of 8a23389 again, just assembled out of two
// correct-looking halves. Not reachable through today's UI, because pushState
// truncates forward history and neither page can be opened from the other, so
// the two states can never sit adjacent in the stack. That is a property of the
// current navigation, though, not of this handler: one link between the two
// pages would have made it reachable, and the failure is silent.
//
// So the destination is decided once, here, and applied once. Deciding it needs
// the whole state - which is why leaving a page and choosing where you land are
// split apart, and why the teardown helpers deliberately change nothing about
// what is visible.
window.addEventListener("popstate", (e) => {
  const entry = e.state && e.state.watcherHistory;
  const monitoring = e.state && e.state.monitoring;

  // Computed against the CURRENT view before anything moves, so these still
  // mean "we were on that page" once the destination is applied below.
  const leftWatcherHistory = !entry && !watcherHistoryView.hidden;
  const leftMonitoring = !monitoring && !monitoringView.hidden;
  if (leftWatcherHistory) resetWatcherHistoryState();
  if (leftMonitoring) stopMonitoringStreams();

  // Each guarded on its own view's visibility, so a popstate that doesn't
  // change which page we're on stays a no-op rather than a reopen - which for
  // Monitoring would mean tearing down four live streams and rebuilding them.
  if (entry && watcherHistoryView.hidden) showWatcherHistory(entry);
  else if (monitoring && monitoringView.hidden) showMonitoring();
  else if (leftWatcherHistory || leftMonitoring) {
    showTopLevelView(appView);
    // Reopened on the tab the user came from, so Back returns them where they
    // were rather than to a bare dashboard. Only when the app is where we
    // actually landed - reopening the Ops modal onto a different page was the
    // other half of the same assumption.
    if (leftWatcherHistory) {
      openOpsModal();
      openOpsCategory("watchers");
    }
  }
});

// A reload while the history page is open would land on #watcher/<id> with
// no way to rebuild it (the job list lives behind an authenticated fetch
// that hasn't run yet at this point), so the hash is dropped rather than
// restored - the dashboard opens normally instead of on a half-built page.
// replaceState, not a hash assignment, so this doesn't add its own entry.
if (location.hash.startsWith("#watcher/") || location.hash === "#monitoring") {
  history.replaceState(null, "", location.pathname + location.search);
}

conversation.addEventListener("scroll", updateJumpLatestVisibility, { passive: true });
jumpLatestBtn.addEventListener("click", () => {
  conversation.scrollTop = conversation.scrollHeight;
  setHidden(jumpLatestBtn, true);
});

// Part of the debugScroll diagnostic above - registered unconditionally
// (the flag is read inside logScroll) but it does nothing and allocates
// nothing while the flag is off. Records, per wheel, the innermost
// scrollable box under the pointer and whether #conversation actually
// moved: `trap` non-null with before === after is a nested box eating the
// wheel, which is the "can't scroll down" candidate that no amount of
// reading the scroll code would show.
conversation.addEventListener(
  "wheel",
  (e) => {
    if (!debugScroll) return;
    let el = e.target instanceof Element ? e.target : null;
    let trap = null;
    while (el && el !== conversation) {
      const canScroll = el.scrollHeight > el.clientHeight;
      if (canScroll && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
        trap = el;
        break;
      }
      el = el.parentElement;
    }
    const before = Math.round(conversation.scrollTop);
    // Deferred so `after` is read once the browser has applied the scroll
    // this wheel event actually caused. rAF is the accurate way to wait
    // for that, but it does not fire at all on a hidden tab - which is
    // exactly when someone might leave this armed - so fall back to a
    // timer there rather than silently recording nothing.
    const afterPaint =
      document.visibilityState === "visible"
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16);
    afterPaint(() =>
      logScroll("wheel", {
        dy: Math.round(e.deltaY),
        before,
        after: Math.round(conversation.scrollTop),
        trap: trap
          ? `${trap.tagName}.${(trap.className || "").toString().split(" ")[0]} ${Math.round(trap.scrollTop)}/${trap.scrollHeight - trap.clientHeight}`
          : null,
      }),
    );
  },
  { passive: true },
);

// Covers the one gap push()'s own document.hidden check (see
// createRevealQueue above) doesn't: content already sitting in a queue's
// buffer, mid-reveal, at the exact moment the tab becomes hidden - with
// no further push() ever arriving to trigger that check itself (e.g. the
// response already finished generating just before the user switched
// away). flush() is a no-op if there's nothing buffered, so this is safe
// to call unconditionally on every visibilitychange to hidden.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    transcriptQueue.flush();
    thinkingQueue.flush();
  }
});

function showApp() {
  showTopLevelView(appView);
  loadRepos();
  loadSessions();
  loadModelInfo();
  loadOpsAgents(); // populates the missing-agent banner proactively, not only when Ops is opened
// Same reasoning, and deliberately not on a timer: the check shells out to
// nemoclaw ~37 times and takes a few seconds, so it runs once per page load
// rather than polling like the model-backend probe does.
loadConfigDrift();
  loadActivity(); // populates the activity badge count proactively, same reasoning
  loadModelHealth(); // a dead inference backend should be visible before anyone tries to run anything
  // Interval rather than a one-shot: the outage this exists for started
  // while the dashboard was already open and sitting idle, so checking only
  // at load would have missed exactly the case that prompted it.
  //
  // Cleared first because showApp() runs again on every re-login (logout
  // hides the app, it doesn't reload the page), and without this each
  // login/logout cycle would leave another live poller behind.
  if (modelHealthPoll) clearInterval(modelHealthPoll);
  modelHealthPoll = setInterval(loadModelHealth, MODEL_HEALTH_POLL_MS);
}

// Fixed live 2026-07-30: the password field kept whatever was last typed
// into it - on logout, that meant the just-used password sat visible
// (masked, but still present as a real value in the DOM/autofill) in the
// input the next time this view showed. showLogin() is the one place
// every path back to the login screen already goes through (logout, and
// any fetch elsewhere in this file that gets a 401 and calls this
// directly - see loadRepos() for one example), so clearing it here covers
// all of them instead of only the logout button's own handler.
// Every background poller must handle a 401, not just the on-demand loads.
//
// The session cookie lives 12h (see src/auth.js). A dashboard left open
// longer than that keeps polling with a dead cookie, and each poller's own
// `if (!res.ok) return` swallowed the 401 silently - so the page went on
// looking live while showing frozen data. Confirmed live: during the
// 2026-08-11/12 inference outage the model-health banner was still up long
// after the model recovered, because every 30s poll had been 401ing since the
// 12h mark. It only cleared on re-login, which is what made the cause obvious.
//
// Stale-but-plausible is the worst failure mode for a monitoring surface, so a
// dead session now returns to the login screen (which hides the app view, and
// with it any frozen banner) instead of quietly freezing. loadRepos() has
// always done this; these just never adopted it.
function stopBackgroundPolls() {
  for (const handle of [modelHealthPoll, activityPollInterval, pendingDecisionPoll, runStatusInterval]) {
    if (handle) clearInterval(handle);
  }
  modelHealthPoll = null;
  activityPollInterval = null;
  pendingDecisionPoll = null;
  runStatusInterval = null;
}

// Returns true when the caller should stop what it was doing.
function sessionExpired(res) {
  if (!res || res.status !== 401) return false;
  stopBackgroundPolls();
  showLogin();
  return true;
}

function showLogin() {
  // Hiding the app alone used to leave the run-history page - a top-level view
  // of its own, with a :not([hidden]) rule setting display:flex/height:100vh -
  // rendered full-page directly below the login form, a 200vh document where
  // the login screen scrolled straight into a live-looking run list. Confirmed
  // live before 8a23389: with the history page open, killing the session and
  // letting the 30s model-health poll 401 (sessionExpired -> here) landed on
  // exactly that, the page's own Back and pager buttons still sitting there to
  // click. It needs no logout click at all, since every background poller's 401
  // funnels through this function. showTopLevelView is now what guarantees it,
  // for every view rather than for the two this function once knew about.
  showTopLevelView(loginView);

  // Session-scoped state has to go with the session, not just the view. A dead
  // session's run list would otherwise still be sitting in memory to reappear
  // on the next login instead of being re-fetched.
  resetWatcherHistoryState();

  // The log stream has to stop here, not just at the logout button. This is
  // the one funnel every path back to the login screen goes through -
  // including a background poller's 401 on an expired cookie - and a log pane
  // left open behind the login form would keep production logs rendering into
  // a page whose session is gone. logsRelay.js closes these sockets
  // server-side on an explicit logout too (§4.4); this covers the client half
  // and the expiry case, where no logout ever happens.
  //
  // The remembered pane set is DISCARDED rather than saved, which is the one
  // place this differs from leaving the page by Back. Reopening within a
  // session should resume where you were; a login boundary is not that. The
  // dashboard password is shared, so carrying it across would restore the
  // previous operator's chosen workloads for whoever logs in next - the same
  // reasoning that clears the run list above, and the same reasoning that
  // clears the password field below.
  closeAllMonitoringPanes();
  monitoringLastKeys = [];
  passwordInput.value = "";
}

async function loadRepos() {
  const res = await fetch("/api/repos");
  if (res.status === 401) return showLogin();
  const data = await res.json();
  repos = data.repos || [];
  repoSelect.innerHTML = "";
  for (const repo of repos) {
    const option = document.createElement("option");
    option.value = repo.repoKey;
    // Human-friendly label (registry's display_name) when present, else
    // the raw repoKey - the option's VALUE stays the load-bearing
    // repoKey (session-key prefixes, agent names, /api/run all key off
    // it), only the visible text changes.
    option.textContent = repo.displayName || repo.repoKey;
    repoSelect.appendChild(option);
  }
  renderRepoMeta();
  // Without this, the stage-4/5 decision prompt only ever appeared after
  // actually submitting a query (composer-submit's own
  // refreshSessionDecision call, further below) - opening the dashboard and
  // just looking at whatever repo loads first showed nothing, even with a
  // real in-flight fix, until the user did something. loadRepos() is what
  // runs once at startup (see showApp()) and is what actually knows the
  // first repo selection, so it's the right place for this, not showApp()
  // itself.
  refreshSessionDecision(repoSelect.value);
  // Cross-repo, and deliberately NOT gated on opening the Ops modal - it's
  // what puts a count on the sidebar's Ops button when some other repo's
  // fix is sitting at stage 4 with its watcher paused behind it.
  loadOpsFixes();
}

// Best-effort, fire-and-forget - called once at startup (see the bottom
// of this file). A failure (network hiccup, gateway not yet connected
// when this fires) just leaves contextWindowTokens null, same as if this
// were never called at all - updateRunContextUsage already treats "not
// yet known" as "don't show the percentage" rather than an error state.
async function loadModelInfo() {
  try {
    const res = await fetch("/api/model-info");
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.contextWindow === "number") {
      contextWindowTokens = data.contextWindow;
      // This resolves asynchronously and can land AFTER the first assistant
      // turn of an already-running session (reconnect, or resuming into a live
      // run), in which case that turn's usage was recorded with no window to
      // measure it against. Re-render it now rather than showing nothing until
      // the next turn arrives.
      if (contextUsedTokens !== null) updateRunContextUsage({ totalTokens: contextUsedTokens });
    }
  } catch {
    // swallow - see comment above
  }
}

function renderRepoMeta() {
  const repo = repos.find((r) => r.repoKey === repoSelect.value);
  // The detailed repo metadata (org/name, branches, modifications,
  // correlations) used to populate #repo-meta in the sidebar below the
  // Repo picker - removed since it cluttered the sidebar and wasn't found
  // useful. #repo-meta is kept as an element (still referenced above) but
  // left empty; only the main-pane header's repo title is set now.
  repoMeta.innerHTML = "";
  if (!repo) {
    repoTitle.textContent = "Pick a repo to get started";
    return;
  }
  repoTitle.textContent = repo.displayName || repo.repoKey;
}

// Picking a different repo while a conversation is on screen now opens a
// fresh "chatroom" scoped to the new repo, instead of silently leaving the
// OLD repo's transcript on screen under a now-mismatched repo selector
// (the dropdown said one repo, the transcript belonged to another) - the
// same reset "+ New task" already does, just triggered by the repo picker
// too. resetToNewTask() doesn't touch repoSelect.value itself, so the
// just-picked value survives the reset correctly.
function handleRepoChange() {
  renderRepoMeta();
  resetToNewTask();
  refreshSessionDecision(repoSelect.value);
}
repoSelect.addEventListener("change", handleRepoChange);

async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (res.status === 401) return;
    const data = await res.json();
    sessions = data.sessions || [];
    renderRecents();
  } catch {
    // Recents is a convenience list, not the critical path - fail
    // silently rather than surface an error banner over it.
  }
}

// Removes a conversation from Recents (see routes/sessions.js's DELETE
// /api/sessions, and sessionIndex.hide()'s own comment - this only
// affects what this dashboard chooses to show, never anything on the
// Gateway side). Works the same way regardless of entry.origin - see
// renderRecents() below, which used to skip rendering this button
// entirely for a gateway-origin entry (hide() fixed live 2026-07-30 is
// what made that restriction unnecessary). If the deleted conversation is
// the one currently on screen, resets to the empty "+ New task" state
// rather than leaving a now-orphaned conversation open (a follow-up sent
// into it would just silently re-create the Recents entry via
// sessionIndex.record() on the next /api/run - harmless, but confusing to
// leave visible mid-delete).
async function deleteSession(entry) {
  const confirmed = await showConfirmDialog({
    title: "Delete this conversation?",
    message: `"${entry.label || entry.repoKey}" will be removed from your Recents list. It does not affect anything on the Gateway. This cannot be undone.`,
    confirmLabel: "Delete",
  });
  if (!confirmed) return;
  // Captured after the (modal, navigation-blocking) confirm dialog rather
  // than before it - the race this guards against is the fetch below
  // still being in flight when the user navigates elsewhere, not anything
  // that could happen while the confirm dialog itself is open. Same
  // pattern as abortActiveRun()'s own guard, fixed the same pass
  // (2026-07-31) for the same reason.
  const myGeneration = sessionGeneration;
  try {
    const res = await fetch(`/api/sessions?key=${encodeURIComponent(entry.sessionKey)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "failed to delete conversation");
    }
  } catch (err) {
    if (myGeneration !== sessionGeneration) return;
    runError.textContent = err.message;
    setHidden(runError, false);
    return;
  }
  sessions = sessions.filter((s) => s.sessionKey !== entry.sessionKey);
  if (entry.sessionKey === sessionKeyLabel.textContent) {
    resetToNewTask(); // also re-renders Recents
  } else {
    renderRecents();
  }
}

// .recents-item used to BE the clickable <button> itself - now a plain
// <div> wrapping two separate buttons (open, delete), since a <button>
// can't nest another interactive element inside it (invalid HTML; browsers
// silently break click handling on the inner one).
function renderRecents() {
  recentsList.innerHTML = "";
  if (!sessions.length) {
    recentsList.innerHTML = '<p class="sidebar-empty">No conversations yet</p>';
    return;
  }
  for (const entry of sessions) {
    const item = document.createElement("div");
    item.className = "recents-item";
    if (entry.sessionKey === sessionKeyLabel.textContent) {
      item.classList.add("active");
    }

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "recents-item-open";
    const label = document.createElement("div");
    label.className = "recents-item-label";
    label.textContent = entry.label || "(no message)";
    openBtn.appendChild(label);
    const meta = document.createElement("div");
    meta.className = "recents-item-meta";
    // entry.origin === "gateway" means this session was never started
    // through this dashboard's own composer - it's a real session the
    // Gateway itself reported for a registered repo's escalation agent
    // (e.g. another repo's escalation agent cross-referencing this one via
    // registry/schema.md's correlate_with mechanism), discovered after the
    // fact rather than recorded locally when it began. Flagged with a
    // small text badge - same minimalist-glyph convention as the "×"
    // delete button below, no icon library in this project.
    if (entry.origin === "gateway") {
      meta.classList.add("recents-item-meta-gateway");
      // Reviewer-role entries get an explicit "· reviewer" suffix so they
      // read as distinct from the common case (watchers, xref handoffs,
      // manual-* sessions - all escalation-role) - those keep the plain
      // "⇄ <repoKey>" text unchanged, no "· escalation" noise added for
      // the common case.
      meta.textContent =
        entry.agentRole === "reviewer" ? `⇄ ${entry.repoKey} · reviewer` : `⇄ ${entry.repoKey}`;
      meta.title = "Discovered on the Gateway - not started from this dashboard";
    } else {
      meta.textContent = entry.repoKey;
    }
    openBtn.appendChild(meta);

    // Marks a Recents entry the operator has already sent a decision for
    // (approve/deny/close-out/approve-suppression/...), set server-side by
    // routes/ops.js's POST /api/ops/decision via sessionIndex.record()'s
    // lastDecision/lastDecisionAt fields - see that call's own comment for
    // the two real gaps this closes. Deliberately NOT "this is resolved" -
    // sending a decision is not the same as the agent having acted on it
    // yet (that still takes a real turn), just "you already looked at this
    // and responded" versus every other entry, which still might need a
    // first look. DECISIONS is the same button-label map used to build the
    // buttons themselves, so this reads as the exact same words the
    // operator clicked, not a second, possibly-drifting copy of them.
    if (entry.lastDecision) {
      const decisionNote = document.createElement("div");
      decisionNote.className = "recents-item-decision";
      const decisionLabel = (DECISIONS[entry.lastDecision] && DECISIONS[entry.lastDecision].label) || entry.lastDecision;
      decisionNote.textContent = `\u2713 ${decisionLabel} sent`;
      if (entry.lastDecisionAt) {
        decisionNote.title = `Sent ${new Date(entry.lastDecisionAt).toLocaleString()}`;
      }
      openBtn.appendChild(decisionNote);
    }

    openBtn.addEventListener("click", () => {
      if (entry.sessionKey === sessionKeyLabel.textContent) return; // already viewing this one
      openHistoricalSession(entry);
    });
    item.appendChild(openBtn);

    // Rendered for every entry regardless of origin - used to be skipped
    // for gateway-discovered ones (sessionIndex.remove() couldn't touch
    // them, so the button would have looked like it did something and
    // didn't - see git history for the original comment here). Fixed live
    // 2026-07-30: sessionIndex.hide() now works for either origin, so
    // deleteSession() below does too.
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "recents-item-delete";
    deleteBtn.setAttribute("aria-label", "Delete conversation");
    deleteBtn.title = "Delete conversation";
    deleteBtn.textContent = "×"; // × - no icon library in this project, a plain glyph matches its minimalism
    deleteBtn.addEventListener("click", () => deleteSession(entry));
    item.appendChild(deleteBtn);

    recentsList.appendChild(item);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setHidden(loginError, true);
  const password = passwordInput.value;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    showApp();
  } else {
    const data = await res.json().catch(() => ({}));
    loginError.textContent = data.error || "login failed";
    setHidden(loginError, false);
  }
});

async function doLogout() {
  await fetch("/api/logout", { method: "POST" });
  if (activeSocket) activeSocket.close();
  showLogin();
}

// Account menu (sidebar footer) - opens upward (see its own CSS comment),
// toggled on click, closed by an outside click or Escape. Kept as a single
// open/closed boolean via the [hidden] attribute rather than a class, same
// show/hide convention the rest of this file already uses throughout
// (#run-status, #jump-latest-btn, etc.).
function closeAccountDropdown() {
  setHidden(accountDropdown, true);
  accountBtn.setAttribute("aria-expanded", "false");
}

accountBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = accountDropdown.hidden;
  setHidden(accountDropdown, !willOpen);
  accountBtn.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (e) => {
  if (!accountDropdown.hidden && !accountMenu.contains(e.target)) closeAccountDropdown();
});

accountLogoutBtn.addEventListener("click", () => {
  closeAccountDropdown();
  doLogout();
});

// Focus management shared by all three dialogs (settings, ops, confirm).
// The markup already carried the right semantics - each panel has
// role="dialog"/aria-modal="true"/aria-labelledby - but nothing acted on
// them: opening a dialog left focus wherever it was (usually
// #message-input), and every control BEHIND the backdrop stayed tabbable,
// so Tab walked straight out of the dialog into a page the user can't see
// or click. This adds the three behaviours aria-modal promises: move focus
// in on open, keep it in while open, put it back on close.
//
// A stack rather than a single "current dialog" because they genuinely
// nest - Settings > Delete All opens the confirm dialog ON TOP of the
// still-open settings modal, and closing it has to return focus to the
// Delete All button, not to whatever was focused before Settings opened.
// The Escape handler's own close order (confirm, then settings, then ops)
// is the same top-of-stack order, so the two agree by construction.
const dialogFocusStack = [];

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Recomputed on every Tab rather than cached at open time: the ops modal
// fills all four of its tabs from async fetches AFTER opening (see
// openOpsModal), and each Watchers/Approvals row brings its own buttons
// with it, so a set captured at open time would be stale within a second.
function focusablesIn(panel) {
  return [...panel.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hidden && el.offsetParent !== null,
  );
}

function openDialog(panel) {
  dialogFocusStack.push({ panel, returnTo: document.activeElement });
  // The panel itself is the fallback target so focus still lands INSIDE
  // the dialog when it has no focusable content yet - true for the ops
  // modal for the moment between opening and its fetches resolving.
  const first = focusablesIn(panel)[0];
  if (first) first.focus();
  else {
    panel.setAttribute("tabindex", "-1");
    panel.focus();
  }
}

function closeDialog(panel) {
  const i = dialogFocusStack.findIndex((entry) => entry.panel === panel);
  if (i === -1) return; // already closed - closeX() runs on Escape AND on backdrop click
  const [entry] = dialogFocusStack.splice(i, 1);
  panel.removeAttribute("tabindex");
  // Only restore if the element is still in the document and still
  // focusable - "Delete All My Chats" closes the confirm dialog and then
  // re-renders the view out from under it, so the button we'd return to
  // can be gone by now. Focusing a detached node silently moves focus to
  // <body>, which is where it would have ended up anyway.
  if (entry.returnTo && entry.returnTo.isConnected) entry.returnTo.focus();
}

// Capture phase so this runs before anything else that might handle Tab,
// and keyed to the TOP of the stack only - with settings + confirm both
// open, Tab has to cycle within the confirm dialog alone.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Tab" || dialogFocusStack.length === 0) return;
    const { panel } = dialogFocusStack[dialogFocusStack.length - 1];
    const items = focusablesIn(panel);
    if (items.length === 0) {
      e.preventDefault(); // nothing to move to, but don't let focus escape either
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    // Also covers focus sitting on the panel itself (the no-content
    // fallback above) or having somehow landed outside: either way
    // document.activeElement isn't first/last, so only the wrap cases
    // below fire, and a normal Tab in the middle is left alone.
    if (!panel.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  },
  true,
);

// Settings modal - single Data Management category today; openSettingsCategory
// below is written to support more (each gets its own #settings-category-<id>
// section plus a matching .settings-nav-item[data-category]) without needing
// rework when the next one is added.
function openSettingsCategory(category) {
  for (const item of settingsNavItems) {
    item.setAttribute("aria-current", String(item.dataset.category === category));
  }
  for (const section of document.querySelectorAll(".settings-category")) {
    setHidden(section, section.id !== `settings-category-${category}`);
  }
}

function openSettingsModal() {
  closeAccountDropdown();
  openSettingsCategory(settingsNavItems[0]?.dataset.category);
  setHidden(settingsModal, false);
  openDialog(settingsModalPanel);
}

function closeSettingsModal() {
  setHidden(settingsModal, true);
  closeDialog(settingsModalPanel);
}

openSettingsBtn.addEventListener("click", openSettingsModal);
settingsModalClose.addEventListener("click", closeSettingsModal);
settingsModalBackdrop.addEventListener("click", closeSettingsModal);

for (const item of settingsNavItems) {
  item.addEventListener("click", () => openSettingsCategory(item.dataset.category));
}

// Ops modal - same pattern as the settings modal just above (see its own
// comment), deliberately NOT sharing openSettingsCategory/settingsNavItems -
// see the CSS comment on .ops-nav-item for why a shared selector would have
// the two modals interfere with each other's open/close state.
function openOpsCategory(category) {
  for (const item of opsNavItems) {
    item.setAttribute("aria-current", String(item.dataset.opsCategory === category));
  }
  for (const section of document.querySelectorAll(".ops-category")) {
    setHidden(section, section.id !== `ops-category-${category}`);
  }
  // The one tab that is not preloaded on open, because its aggregation reads
  // every agent transcript. Fetched the first time it is actually looked at.
  if (category === "usage") loadTokenUsage();
}

function openOpsModal() {
  closeAccountDropdown();
  // Must precede openOpsCategory: that call can itself trigger the usage load
  // if it ever becomes the default tab, and resetting afterwards would discard
  // the fetch it just started.
  tokenUsageLoaded = false;
  openOpsCategory(opsNavItems[0]?.dataset.opsCategory);
  setHidden(opsModal, false);
  // Marks the sidebar row as the surface you're currently in - the flat nav
  // rows (2026-08-06) have no border of their own to say "this one is
  // active", so the state has to be driven rather than implied by chrome.
  opsBtn.setAttribute("aria-current", "true");
  // These four are cheap, read-only fetches - loading them together on
  // open (rather than per-tab-click) means switching tabs inside the modal
  // never shows a loading flicker, and the approvals badge count. Errors
  // are swallowed by each loadX() itself (see their own comments) so one
  // failing RPC doesn't block the others from populating.
  // The fifth tab (Usage) is deliberately NOT here: it aggregates every agent
  // transcript with jq, so preloading it would make opening this modal at all
  // pay for a panel most opens never look at. openOpsCategory loads it on click.
  loadOpsFixes();
  loadCron();
  loadOpsAgents();
  loadApprovals();
  // Position relative to the loadX() calls above doesn't matter - they're
  // async, so whichever order these sit in, openDialog still runs against
  // the close button and four tab buttons that are static markup. The rows
  // those fetches add arrive later, and the Tab handler recomputes the
  // focusable set on every keypress precisely so they're picked up.
  openDialog(opsModalPanel);
}

function closeOpsModal() {
  setHidden(opsModal, true);
  opsBtn.removeAttribute("aria-current");
  closeDialog(opsModalPanel);
}

opsBtn.addEventListener("click", openOpsModal);
opsModalClose.addEventListener("click", closeOpsModal);
opsModalBackdrop.addEventListener("click", closeOpsModal);

for (const item of opsNavItems) {
  item.addEventListener("click", () => openOpsCategory(item.dataset.opsCategory));
}

// Shared by the Watchers and background-activity rows - ms can be a
// past (last-run) or future (next-run) timestamp.
function relativeTime(ms) {
  if (!ms) return "—";
  const diffSec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const unit = abs < 60 ? "sec" : abs < 3600 ? "min" : abs < 86400 ? "hour" : "day";
  const value =
    abs < 60 ? abs : abs < 3600 ? Math.round(abs / 60) : abs < 86400 ? Math.round(abs / 3600) : Math.round(abs / 86400);
  return diffSec < 0 ? `${value} ${unit}${value === 1 ? "" : "s"} ago` : `in ${value} ${unit}${value === 1 ? "" : "s"}`;
}

// --- Watchers tab ---
async function loadCron() {
  opsWatchersList.innerHTML = '<p class="ops-empty">Loading…</p>';
  try {
    const res = await fetch("/api/ops/cron");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load watchers");
    const data = await res.json();
    renderCron(data.jobs || []);
  } catch (err) {
    opsWatchersList.innerHTML = "";
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = err.message;
    opsWatchersList.appendChild(p);
  }
}

function renderCron(jobs) {
  opsWatchersList.innerHTML = "";
  if (!jobs.length) {
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = "No scheduled jobs";
    opsWatchersList.appendChild(p);
    return;
  }
  for (const job of jobs) {
    const lastStatus = job.state && job.state.lastRunStatus;
    // "ok" is the only confirmed-live success value; anything else present
    // is treated as an error rather than guessing at every possible string.
    const stateClass = !job.enabled ? "queued" : lastStatus === "ok" ? "completed" : lastStatus ? "error" : "queued";

    const row = document.createElement("div");
    row.className = "ops-row";

    const main = document.createElement("div");
    main.className = "ops-row-main";
    const title = document.createElement("div");
    title.className = "ops-row-title";
    title.textContent = job.name;
    const meta = document.createElement("div");
    meta.className = "ops-row-meta";
    meta.textContent = `last ${relativeTime(job.state && job.state.lastRunAtMs)} · next ${relativeTime(job.state && job.state.nextRunAtMs)}`;
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "ops-row-actions";
    const pill = document.createElement("span");
    pill.className = `pill state-${stateClass}`;
    pill.textContent = job.enabled ? lastStatus || "idle" : "disabled";
    const historyBtn = document.createElement("button");
    historyBtn.type = "button";
    historyBtn.textContent = "View History";
    historyBtn.addEventListener("click", () => openWatcherHistory(job));

    const runBtnEl = document.createElement("button");
    runBtnEl.type = "button";
    runBtnEl.textContent = "Run now";
    runBtnEl.addEventListener("click", () => runCronJob(job.id, runBtnEl));
    actions.appendChild(pill);
    actions.appendChild(historyBtn);
    actions.appendChild(runBtnEl);

    row.appendChild(main);
    row.appendChild(actions);
    opsWatchersList.appendChild(row);
  }
}

// Full-page run history for one watcher (see routes/ops.js's /runs
// endpoint). cron.list only carries each job's CURRENT state, so this is
// the only place an intermittent failure that has since recovered is
// visible at all.
//
// The gateway hard-caps cron.runs at limit<=200 (schema-level: asking for
// 500 comes back "at /limit: must be <= 200"), which at the watchers'
// 2-minute cadence is about five hours. So 200 IS the entire history
// available, and it's small enough to fetch once and page through in the
// client rather than round-tripping per page.
const WATCHER_HISTORY_PAGE_SIZE = 25;
const WATCHER_HISTORY_MAX = 200;

let watcherHistoryRuns = [];
let watcherHistoryPage = 0;

// Split from openWatcherHistory so popstate can re-show this view WITHOUT
// pushing another entry. Browser Forward restores the #watcher/<id> URL,
// and without a re-show the address bar and the visible view disagree -
// confirmed live before this split existed: Back then Forward left the
// hash set and the page closed. The state carries the name as well as the
// id because the header needs it and popstate has no job object to read.
function showWatcherHistory(entry) {
  closeOpsModal();
  showTopLevelView(watcherHistoryView);
  watcherHistoryTitle.textContent = entry.name;
  loadWatcherHistory(entry.id);
}

function openWatcherHistory(job) {
  const entry = { id: job.id, name: job.name };
  // pushState (rather than just swapping views) so the browser's own Back
  // button leaves this page instead of leaving the dashboard entirely -
  // it's presented as a page, so it has to behave like one. The hash is
  // cleared on load rather than restored (see the popstate wiring below).
  history.pushState({ watcherHistory: entry }, "", `#watcher/${encodeURIComponent(job.id)}`);
  showWatcherHistory(entry);
}

// Teardown ONLY - it does not decide what becomes visible next. Leaving a page
// and choosing where you land are two different questions, and the popstate
// handler is the one place that can answer the second, because it is the only
// caller that knows the whole destination state. See its own comment.
function resetWatcherHistoryState() {
  watcherHistoryRuns = [];
  watcherHistoryPage = 0;
}

async function loadWatcherHistory(id) {
  watcherHistoryRuns = [];
  watcherHistoryPage = 0;
  setHidden(watcherHistoryPager, true);
  // Header stays hidden until there is actually a list under it - column
  // labels floating over "Loading…" or an error read as a broken table.
  setHidden(watcherHistoryHead, true);
  watcherHistoryList.innerHTML = "";
  watcherHistoryStatus.textContent = "Loading…";
  setHidden(watcherHistoryStatus, false);
  try {
    const res = await fetch(
      `/api/ops/cron/${encodeURIComponent(id)}/runs?limit=${WATCHER_HISTORY_MAX}`,
    );
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || "failed to load run history");
    }
    const data = await res.json();
    watcherHistoryRuns = data.runs || [];
    if (!watcherHistoryRuns.length) {
      watcherHistoryStatus.textContent = "No runs recorded yet";
      return;
    }
    setHidden(watcherHistoryStatus, true);
    setHidden(watcherHistoryHead, false);
    renderWatcherHistoryPage();
  } catch (err) {
    watcherHistoryStatus.textContent = err.message;
  }
}

function renderWatcherHistoryPage() {
  const total = watcherHistoryRuns.length;
  const pages = Math.max(1, Math.ceil(total / WATCHER_HISTORY_PAGE_SIZE));
  // Clamped rather than trusted: the page index is also moved by the
  // prev/next handlers, and a stale value must never render an empty page.
  watcherHistoryPage = Math.min(Math.max(watcherHistoryPage, 0), pages - 1);
  const start = watcherHistoryPage * WATCHER_HISTORY_PAGE_SIZE;
  const slice = watcherHistoryRuns.slice(start, start + WATCHER_HISTORY_PAGE_SIZE);

  renderRunHistory(watcherHistoryList, slice);

  setHidden(watcherHistoryPager, total <= WATCHER_HISTORY_PAGE_SIZE);
  watcherHistoryRange.textContent = `${start + 1}–${start + slice.length} of ${total}`;
  // Disabled at the ends rather than wrapping around - a pager that loops
  // gives no signal that you've reached the oldest run the gateway kept.
  watcherHistoryPrev.disabled = watcherHistoryPage === 0;
  watcherHistoryNext.disabled = watcherHistoryPage >= pages - 1;
}

function renderRunHistory(panelEl, runs) {
  panelEl.innerHTML = "";
  if (!runs.length) {
    panelEl.textContent = "No runs recorded yet";
    return;
  }
  for (const run of runs) {
    const item = document.createElement("div");
    item.className = "ops-run";

    const when = document.createElement("span");
    when.className = "ops-run-when";
    when.textContent = relativeTime(run.runAtMs);

    // Same "ok is the only confirmed success value" rule renderCron uses
    // above, rather than guessing at every string the gateway might send.
    const ok = run.status === "ok";
    const pill = document.createElement("span");
    pill.className = `pill state-${ok ? "completed" : "error"}`;
    pill.textContent = run.status || run.action || "unknown";

    // The pill and its disclosure caret share the status track, so the
    // caret reads as belonging to the ERROR badge rather than sitting off
    // on its own. A passing run has nothing to disclose and gets no caret.
    const status = document.createElement("span");
    status.className = "ops-run-status";
    status.appendChild(pill);

    const duration = document.createElement("span");
    duration.className = "ops-run-duration";
    duration.textContent =
      typeof run.durationMs === "number" ? `${(run.durationMs / 1000).toFixed(1)}s` : "—";

    item.appendChild(when);
    item.appendChild(status);
    item.appendChild(duration);

    // Only built for a run that actually failed - a passing run has
    // nothing to disclose but the gateway's own "command ok with no
    // output" line, identical on every row.
    if (!ok) {
      const { toggle, panel } = buildRunFailureDetail(run);
      status.appendChild(toggle);
      item.appendChild(panel);
    }
    panelEl.appendChild(item);
  }
}

// Was a native <details> until 2026-08-07. Swapped for an explicit
// button + panel because the caret has to sit beside the ERROR badge in
// the status column while the panel it opens spans the full row width
// underneath - a <summary> can't do that, since a <details>' content is
// confined to wherever the element itself sits in the grid. The
// aria-expanded/aria-controls pair is the standard disclosure contract,
// so this keeps the semantics the native element was providing.
let runDetailSeq = 0;

function buildRunFailureDetail(run) {
  const panelId = `run-detail-${(runDetailSeq += 1)}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ops-run-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", panelId);
  // Named for what it reveals - a caret alone announces as "button" and
  // says nothing about which row it belongs to or what it does. run.error
  // is the gateway's readable one-liner ("command exited with code 1"),
  // which is exactly the label this needs.
  toggle.setAttribute("aria-label", run.error || "Show failure details");
  toggle.textContent = "▾";

  const panel = document.createElement("div");
  panel.className = "ops-run-detail";
  panel.id = panelId;
  setHidden(panel, true);

  toggle.addEventListener("click", () => {
    const opening = panel.hidden;
    setHidden(panel, !opening);
    toggle.setAttribute("aria-expanded", String(opening));
    toggle.classList.toggle("open", opening);
  });

  const list = document.createElement("dl");
  const addField = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  };
  addField("Exit code", run.exitCode);
  addField("Command", run.message);
  // Deliberately no "Ran for" - the RUNTIME column on the row itself
  // already shows exactly that, and repeating it here just pads the panel.
  panel.appendChild(list);

  return { toggle, panel };
}

async function runCronJob(id, btnEl) {
  btnEl.disabled = true;
  const original = btnEl.textContent;
  btnEl.textContent = "Running…";
  try {
    const res = await fetch(`/api/ops/cron/${encodeURIComponent(id)}/run`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to run job");
    // Gives the job a moment to actually update its own cron.list state
    // before refreshing - an immediate reload would just show the same
    // pre-run state back.
    setTimeout(loadCron, 1500);
  } catch {
    btnEl.textContent = "Failed";
    setTimeout(() => {
      btnEl.textContent = original;
      btnEl.disabled = false;
    }, 2000);
    return;
  }
  btnEl.textContent = original;
  btnEl.disabled = false;
}

// --- Agents tab + missing-agent banner ---
// Dismissal is session-only (a plain in-memory flag, not persisted) -
// deliberately not silenced across a reload, since a genuinely missing
// agent is exactly the kind of thing that should still be visible next
// time the dashboard is opened, not just the one time someone noticed it.
let mismatchDismissed = false;


// --- Agent capabilities & boundaries ---------------------------------
//
// "What can this agent actually do" used to be answerable only by breaking
// something. Three things decide it, and only the first is visible in a tool
// catalogue:
//   1. the effective tool set (tools.effective, after policy resolution)
//   2. whether it may message other agents (a CALL-TIME gate - an agent holds
//      sessions_send in its catalogue whether or not the allow list lets it
//      reach anyone, so the catalogue alone is misleading here)
//   3. what it may read in the cluster (RBAC, entirely outside OpenClaw - and
//      invisible above because kubectl runs THROUGH `exec`, which every agent
//      has)
//
// Measured live: all agents that have run resolve to a byte-identical tool set.
// So this leads with the shared picture rather than printing the same list once
// per agent, and treats a DEVIATION as the thing worth shouting about - that is
// the shape that would actually surface a problem.
function renderCapabilities(data) {
  opsCapabilities.innerHTML = "";
  const ran = (data.agents || []).filter((a) => a.sessionKey && a.groups);
  const neverRan = (data.agents || []).filter((a) => !a.sessionKey);
  const signatures = new Set(ran.map((a) => a.groups.flatMap((g) => g.tools).sort().join(",")));

  const h = document.createElement("h4");
  h.className = "ops-capabilities-title";
  h.textContent = "Capabilities & boundaries";
  opsCapabilities.appendChild(h);

  const addRow = (label, valueNode) => {
    const row = document.createElement("div");
    row.className = "ops-cap-row";
    const k = document.createElement("div");
    k.className = "ops-cap-key";
    k.textContent = label;
    row.appendChild(k);
    const v = document.createElement("div");
    v.className = "ops-cap-value";
    if (typeof valueNode === "string") v.textContent = valueNode;
    else v.appendChild(valueNode);
    row.appendChild(v);
    opsCapabilities.appendChild(row);
    return v;
  };

  // --- tools
  if (!ran.length) {
    addRow("Tools", "No agent has run yet, so no effective tool set can be resolved.");
  } else if (signatures.size === 1) {
    const toolCount = ran[0].toolCount;
    const wrap = document.createElement("div");
    const summary = document.createElement("div");
    summary.textContent = `All ${ran.length} agents that have run resolve to the same ${toolCount} tools (profile: ${ran[0].profile || "?"}).`;
    wrap.appendChild(summary);
    const details = document.createElement("details");
    details.className = "ops-cap-details";
    const dsum = document.createElement("summary");
    dsum.textContent = "show the tool list";
    details.appendChild(dsum);
    for (const g of ran[0].groups) {
      const line = document.createElement("div");
      line.className = "ops-cap-toolgroup";
      line.textContent = `${g.label}: ${g.tools.join(", ")}`;
      details.appendChild(line);
    }
    wrap.appendChild(details);
    addRow("Tools", wrap);
  } else {
    // The alarm case: agents that should be interchangeable are not.
    const wrap = document.createElement("div");
    wrap.className = "ops-cap-deviation";
    wrap.textContent = `${signatures.size} DIFFERENT tool sets across ${ran.length} agents — they should be identical. Per-agent counts: ${ran
      .map((a) => `${a.agentId}=${a.toolCount}`)
      .join(", ")}`;
    addRow("Tools", wrap);
  }

  if (neverRan.length) {
    addRow(
      "Not yet resolvable",
      `${neverRan.length} agents have never run, so their effective tools cannot be resolved: ${neverRan
        .map((a) => a.agentId)
        .join(", ")}. This is not a fault — it resolves the first time each one is invoked.`,
    );
  }

  // --- agent-to-agent
  if (data.a2aAllow) {
    addRow(
      "Agent-to-agent",
      `${data.a2aAllow.enabled ? "enabled" : "DISABLED"} · ${data.a2aAllow.allow.length} agents on the allow list. This gate applies when a message is SENT, so holding sessions_send does not by itself mean an agent can reach anyone.`,
    );
  } else {
    addRow("Agent-to-agent", "Could not read tools.agentToAgent — unknown, not necessarily disabled.");
  }

  // --- cluster
  if (data.clusterRead) {
    const c = data.clusterRead;
    addRow(
      "Cluster (read-only)",
      `${c.verbs.join("/")} on: ${c.readable.join(", ")}. DENIED: ${c.denied.join(", ")} — deliberately, they may hold credentials. Enforced by the cluster, not by OpenClaw, and invisible in the tool list above because kubectl runs through \`exec\`.`,
    );
  } else {
    addRow("Cluster (read-only)", "Could not read k8s/rbac-readonly.yaml — unknown, not unrestricted.");
  }
}

async function loadCapabilities() {
  if (!opsCapabilities) return;
  opsCapabilities.innerHTML = '<p class="ops-empty">Loading capabilities…</p>';
  try {
    const res = await fetch("/api/ops/agent-capabilities");
    if (sessionExpired(res)) return;
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load capabilities");
    renderCapabilities(await res.json());
  } catch (err) {
    opsCapabilities.innerHTML = "";
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = err.message;
    opsCapabilities.appendChild(p);
  }
}

// fmtTokens/fillUsageGaps/classifyUsageDay come from tokenUsage.js (loaded
// before this file), so test/tokenUsage.test.js can exercise them directly.
function renderTokenUsage(data) {
  const chart = document.getElementById("ops-usage-chart");
  const agents = document.getElementById("ops-usage-agents");
  const summary = document.getElementById("ops-usage-summary");
  chart.innerHTML = "";
  agents.innerHTML = "";

  const days = fillUsageGaps(data.byDay || []);
  if (!days.length) {
    chart.innerHTML = '<p class="ops-empty">No agent turns recorded yet.</p>';
    setHidden(summary, true);
    return;
  }

  // The ratio is the actual finding this panel exists to surface: input runs
  // ~200x output because every invocation re-sends the bootstrap docs
  // (AGENTS.md + TOOLS.md) in full. Stated up front rather than left for the
  // reader to divide two numbers.
  const ratio = data.output > 0 ? Math.round(data.input / data.output) : null;
  const perTurn = data.turns > 0 ? Math.round(data.input / data.turns) : 0;
  summary.textContent =
    `${fmtTokens(data.total)} tokens over ${data.turns} measured turns · ` +
    `${fmtTokens(data.input)} in / ${fmtTokens(data.output)} out` +
    (ratio ? ` (${ratio}:1)` : "") +
    ` · ~${fmtTokens(perTurn)} input per turn. ` +
    `Usage is only recorded from ${data.recordingSince}; ${data.unrecordedTurns} earlier turns logged none.`;
  setHidden(summary, false);

  const max = Math.max(...days.map((d) => d.total), 1);
  for (const d of days) {
    const row = document.createElement("div");
    row.className = "ops-usage-row";

    const label = document.createElement("div");
    label.className = "ops-usage-date";
    label.textContent = d.date.slice(5); // MM-DD; the year is in the summary
    row.appendChild(label);

    const track = document.createElement("div");
    track.className = "ops-usage-track";
    if (d.state === "measured") {
      // Stacked, but output is routinely under 1% of the bar, so it may render
      // as a sliver or not at all. That is the honest picture; the numbers
      // beside it carry the detail the pixels cannot.
      const bin = document.createElement("div");
      bin.className = "ops-usage-bar ops-usage-bar-in";
      bin.style.width = `${(d.input / max) * 100}%`;
      track.appendChild(bin);
      const bout = document.createElement("div");
      bout.className = "ops-usage-bar ops-usage-bar-out";
      bout.style.width = `${(d.output / max) * 100}%`;
      track.appendChild(bout);
    } else {
      const note = document.createElement("div");
      note.className = `ops-usage-nodata ops-usage-nodata-${d.state}`;
      // Kept short because this is the one row whose entire meaning is its
      // text - there is no bar and the value column reads "—", so an
      // ellipsised label loses the point outright. The full explanation goes
      // in the title for the narrow-width case.
      note.textContent =
        d.state === "unmeasured" ? `${d.unrecordedTurns} turns, not measured` : "no agent activity";
      note.title =
        d.state === "unmeasured"
          ? `${d.unrecordedTurns} turns ran on this day, but every one recorded usage as 0, ` +
            `so the volume is unknown rather than zero. Usage is only recorded from ${data.recordingSince}.`
          : "No agent turns at all on this day.";
      track.appendChild(note);
    }
    row.appendChild(track);

    const value = document.createElement("div");
    value.className = "ops-usage-value";
    value.textContent = d.state === "measured" ? fmtTokens(d.total) : "—";
    value.title =
      d.state === "measured"
        ? `${d.input.toLocaleString()} in / ${d.output.toLocaleString()} out over ${d.turns} turns` +
          (d.unrecordedTurns ? ` · ${d.unrecordedTurns} further turns recorded no usage` : "")
        : "";
    row.appendChild(value);
    chart.appendChild(row);
  }

  // Per-agent. Agents with nothing measured are kept rather than filtered:
  // "this watcher has run 29 times and we have never measured any of it" is
  // information, not an empty row.
  for (const a of data.byAgent || []) {
    const row = document.createElement("div");
    row.className = "ops-usage-agent-row";
    const name = document.createElement("div");
    name.className = "ops-usage-agent-name";
    name.textContent = a.agent;
    row.appendChild(name);
    const detail = document.createElement("div");
    detail.className = "ops-usage-agent-detail";
    if (a.turns > 0) {
      detail.textContent =
        `${fmtTokens(a.total)} over ${a.turns} turns · ~${fmtTokens(Math.round(a.input / a.turns))} in/turn` +
        (a.unrecordedTurns ? ` · ${a.unrecordedTurns} unmeasured` : "");
    } else {
      detail.className += " ops-usage-agent-unmeasured";
      detail.textContent = `${a.unrecordedTurns} turns, none measured`;
    }
    row.appendChild(detail);
    agents.appendChild(row);
  }
}

// Loaded on first tab click, not with the modal: this one shells out to jq
// across every transcript, so it is the one ops fetch that is not cheap.
let tokenUsageLoaded = false;
async function loadTokenUsage(force) {
  const chart = document.getElementById("ops-usage-chart");
  if (!chart || (tokenUsageLoaded && !force)) return;
  tokenUsageLoaded = true;
  chart.innerHTML = '<p class="ops-empty">Aggregating token usage…</p>';
  try {
    const res = await fetch("/api/ops/token-usage");
    if (sessionExpired(res)) return;
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load token usage");
    renderTokenUsage(await res.json());
  } catch (err) {
    chart.innerHTML = "";
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = err.message;
    chart.appendChild(p);
    // Let a click retry after a failure instead of pinning the error until the
    // modal is reopened.
    tokenUsageLoaded = false;
  }
}

async function loadOpsAgents() {
  opsAgentsList.innerHTML = '<p class="ops-empty">Loading…</p>';
  try {
    const res = await fetch("/api/ops/agents");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load agents");
    const data = await res.json();
    renderOpsAgents(data.agents || []);
    updateAgentMismatchBanner(data.missing || []);
    // Separate call on purpose: this one probes tools.effective per agent and
    // is slower, so a slow capability probe must not delay the missing-agent
    // banner, which is the urgent half.
    loadCapabilities();
  } catch (err) {
    opsAgentsList.innerHTML = "";
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = err.message;
    opsAgentsList.appendChild(p);
  }
}

function renderOpsAgents(agents) {
  opsAgentsList.innerHTML = "";
  if (!agents.length) {
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = "No agents configured";
    opsAgentsList.appendChild(p);
    return;
  }
  for (const agent of agents) {
    const row = document.createElement("div");
    row.className = "ops-row";
    const main = document.createElement("div");
    main.className = "ops-row-main";
    const title = document.createElement("div");
    title.className = "ops-row-title";
    title.textContent = agent.name || agent.id;
    const meta = document.createElement("div");
    meta.className = "ops-row-meta";
    meta.textContent = (agent.model && agent.model.primary) || "";
    main.appendChild(title);
    main.appendChild(meta);
    row.appendChild(main);
    opsAgentsList.appendChild(row);
  }
}

// This is the check that would have caught 2026-08-03's incident (all 14
// escalation/reviewer agents silently missing after a host reboot
// recreated the sandbox) automatically, instead of on the next failed run -
// see routes/ops.js's own comment on the diff this is rendering.
function updateAgentMismatchBanner(missing) {
  if (!missing.length || mismatchDismissed) {
    setHidden(agentMismatchBanner, true);
    return;
  }
  agentMismatchText.textContent =
    missing.length === 1
      ? `Agent "${missing[0]}" is missing from the live gateway config.`
      : `${missing.length} agents are missing from the live gateway config: ${missing.join(", ")}.`;
  setHidden(agentMismatchBanner, false);
}

agentMismatchDismiss.addEventListener("click", () => {
  mismatchDismissed = true;
  setHidden(agentMismatchBanner, true);
});

// --- Config drift banner ----------------------------------------------
//
// The sessions_send agent-to-agent config was applied by hand, never encoded,
// and silently vanished in a nemoclaw upgrade - cross-agent messaging returned
// "forbidden" for about a week before anyone looked. Nothing in this dashboard
// would have shown that, because the live system was perfectly healthy; it just
// no longer matched intent. This banner is the surface for that difference.
//
// Same session-only dismissal rule as the missing-agent banner above, for the
// same reason: drift that's still there next time you open the dashboard should
// still be saying so.
let configDriftDismissed = false;

async function loadConfigDrift() {
  try {
    const res = await fetch("/api/ops/config-drift");
    if (sessionExpired(res)) return;
    if (!res.ok) return; // 502 here means "couldn't check", not "drifted" -
                         // don't cry drift on a transient sandbox hiccup
    const data = await res.json();
    updateConfigDriftBanner(data);
  } catch {
    /* network blip - same reasoning as above, stay quiet */
  }
}

function updateConfigDriftBanner(data) {
  const items = (data && data.items) || [];
  if (!items.length || configDriftDismissed) {
    setHidden(configDriftBanner, true);
    return;
  }
  const names = items.map((i) => i.name).join(", ");
  configDriftText.textContent =
    items.length === 1
      ? `Live config has drifted from what bootstrap.sh intends: ${names}.`
      : `${items.length} settings have drifted from what bootstrap.sh intends: ${names}.`;
  setHidden(configDriftBanner, false);
}

configDriftDismiss.addEventListener("click", () => {
  configDriftDismissed = true;
  setHidden(configDriftBanner, true);
});

// --- Model-backend health ---------------------------------------------
//
// Added 2026-08-07: Server 4, which serves the inference model, went down
// and this dashboard showed nothing at all. Every existing surface watched
// the gateway, not the model behind it, so a dead backend looked exactly
// like an idle system - and because the gateway's own inference timeout is
// 600s, a run started against it would simply have sat there for ten
// minutes before saying anything.
//
// 30s cadence: the probe is a single unauthenticated GET that a healthy
// server answers in ~25ms, and an outage that nobody has noticed for half a
// minute is still an outage worth interrupting someone about.
const MODEL_HEALTH_POLL_MS = 30_000;

// Dismissal is scoped to ONE outage, not to the session. A banner you can
// silence forever is a banner that lies the second time it matters, and
// this is exactly the kind of thing that recurs - so the flag is armed on
// dismissal and cleared again the moment the model comes back healthy,
// which means a second outage raises a fresh banner.
let modelHealthDismissed = false;
// What the last poll saw, so the re-arm above can tell "still the same
// outage I already dismissed" from "recovered, then broke again".
let modelHealthLastOk = null;
// Handle for the poll started in showApp() - see its own comment for why
// this has to be clearable rather than fire-and-forget.
let modelHealthPoll = null;

function describeModelHealth(health) {
  const where = health.endpoint ? ` (${health.endpoint})` : "";
  switch (health.reason) {
    case "unreachable":
      return `The inference server${where} is not responding. Agents can't run until it's back.`;
    case "timeout":
      return `The inference server${where} timed out. It may be overloaded or mid-restart.`;
    case "model-not-loaded":
      return `The inference server${where} is up but isn't serving ${health.model || "the configured model"}${
        health.served && health.served.length ? ` - it has ${health.served.join(", ")} loaded instead.` : "."
      }`;
    case "unauthorized":
      return `The inference server${where} rejected the health check (HTTP ${health.status}). Its credentials likely changed.`;
    case "http-error":
      return `The inference server${where} returned HTTP ${health.status}.`;
    default:
      return `The inference server${where} is unhealthy.`;
  }
}

function updateModelHealthBanner(health) {
  // ok:null is "couldn't determine" (the gateway itself is unreachable, or
  // no provider is configured) - deliberately silent. Reporting a model
  // outage on the strength of a failed gateway call would point whoever
  // reads it at the wrong machine, and the gateway being down has its own
  // loud symptoms already.
  if (health.ok === null) return;

  if (health.ok) {
    if (modelHealthLastOk === false) modelHealthDismissed = false; // recovered - re-arm
    modelHealthLastOk = true;
    setHidden(modelHealthBanner, true);
    return;
  }

  modelHealthLastOk = false;
  if (modelHealthDismissed) {
    setHidden(modelHealthBanner, true);
    return;
  }
  modelHealthText.textContent = describeModelHealth(health);
  setHidden(modelHealthBanner, false);
}

async function loadModelHealth() {
  try {
    const res = await fetch("/api/model-health");
    // A dead session is NOT an indeterminate health result - swallowing it here
    // is what left the banner frozen through a recovery.
    if (sessionExpired(res)) return;
    if (!res.ok) return; // treated as indeterminate, same as ok:null above
    updateModelHealthBanner(await res.json());
  } catch {
    // The dashboard's own backend is unreachable - that's not a model
    // outage, and the existing connection handling already covers it.
  }
}

modelHealthDismiss.addEventListener("click", () => {
  modelHealthDismissed = true;
  setHidden(modelHealthBanner, true);
});

// --- Approvals tab ---
async function loadApprovals() {
  opsApprovalsList.innerHTML = '<p class="ops-empty">Loading…</p>';
  try {
    const res = await fetch("/api/ops/approvals");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load approvals");
    const data = await res.json();
    renderApprovals(data.pending || []);
  } catch (err) {
    opsApprovalsList.innerHTML = "";
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = err.message;
    opsApprovalsList.appendChild(p);
  }
}

// The sidebar's single Ops badge sums two independent sources (pending
// device approvals, and fixes stopped at a stage that needs a human), each
// of which loads on its own schedule - so each writes only its own slot
// here and the button re-renders from the total. A tab's own badge still
// shows just that tab's count, so the sidebar number stays decomposable
// once the modal is open.
const opsBadgeCounts = { approvals: 0, fixes: 0 };

function renderOpsButtonBadge() {
  const total = opsBadgeCounts.approvals + opsBadgeCounts.fixes;
  opsApprovalsBadge.textContent = String(total);
  setHidden(opsApprovalsBadge, total === 0);
  const parts = [];
  if (opsBadgeCounts.fixes) parts.push(`${opsBadgeCounts.fixes} fix(es) waiting on you`);
  if (opsBadgeCounts.approvals) parts.push(`${opsBadgeCounts.approvals} pending device approval(s)`);
  opsBtn.title = parts.join(" · ");
}

function renderApprovals(pending) {
  const count = pending.length;
  opsApprovalsTabBadge.textContent = String(count);
  setHidden(opsApprovalsTabBadge, count === 0);
  opsBadgeCounts.approvals = count;
  renderOpsButtonBadge();
  opsApprovalsList.innerHTML = "";
  if (!count) {
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = "No pending approvals";
    opsApprovalsList.appendChild(p);
    return;
  }
  // Field names for a PENDING entry specifically aren't independently
  // confirmed live (every capture so far found an empty pending list) -
  // reading a couple of reasonable variants defensively rather than
  // guessing a single one and breaking silently the first time this
  // actually renders something.
  for (const req of pending) {
    const row = document.createElement("div");
    row.className = "ops-row";
    const main = document.createElement("div");
    main.className = "ops-row-main";
    const title = document.createElement("div");
    title.className = "ops-row-title";
    const deviceId = req.deviceId || req.device || "";
    title.textContent = deviceId ? `Device ${deviceId.slice(0, 12)}…` : "Unknown device";
    const meta = document.createElement("div");
    meta.className = "ops-row-meta";
    const scopes = req.requestedScopes || req.scopes || req.requested || [];
    meta.textContent = (Array.isArray(scopes) ? scopes.join(", ") : String(scopes)) || "scope upgrade requested";
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "ops-row-actions";
    const approveBtnEl = document.createElement("button");
    approveBtnEl.type = "button";
    approveBtnEl.textContent = "Approve";
    const requestId = req.requestId || req.id || req.request;
    approveBtnEl.addEventListener("click", () => approveDevice(requestId, approveBtnEl));
    actions.appendChild(approveBtnEl);

    row.appendChild(main);
    row.appendChild(actions);
    opsApprovalsList.appendChild(row);
  }
}

async function approveDevice(requestId, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "Approving…";
  try {
    const res = await fetch(`/api/ops/approvals/${encodeURIComponent(requestId)}/approve`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to approve");
    loadApprovals();
  } catch {
    btnEl.textContent = "Failed";
    setTimeout(() => {
      btnEl.textContent = "Approve";
      btnEl.disabled = false;
    }, 2000);
  }
}

// --- Fixes tab (every repo at once) ---
// The sidebar stage widget this replaced only ever described the repo the
// picker happened to be pointing at, so finding out whether anything was in
// flight anywhere meant switching repo by repo. This tab is the same rows,
// grouped under their repo, for all of them - and it's the FIRST tab in the
// modal (openOpsModal opens opsNavItems[0]) because it's the one thing here
// that can be actively waiting on a human. The sidebar copy was removed
// outright on 2026-08-06 once this tab covered it.
//
// Also called once at startup from loadRepos(), not only on modal open, so
// the sidebar Ops badge is honest before anyone has opened the modal - that
// invisibility is the actual complaint this fixes.
// `quiet` suppresses the Loading… placeholder for background refreshes. Wiping
// the rendered list and repainting it every 5 seconds is what made the pending-
// decision poll visible as the whole panel blinking; a refresh nobody asked for
// should replace the content in place, not clear the panel first. The
// placeholder still shows for a user-initiated load, where an empty panel is
// the honest answer to "I just opened this and it hasn't arrived yet".
async function loadOpsFixes({ quiet = false } = {}) {
  if (!quiet) opsFixesList.innerHTML = '<p class="ops-empty">Loading…</p>';
  try {
    const res = await fetch("/api/ops/stages");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load in-progress fixes");
    renderOpsFixes(await res.json());
  } catch (err) {
    // The badge is cleared rather than left at its last value: a stale
    // "1 waiting" nobody can click through to is worse than no badge.
    opsBadgeCounts.fixes = 0;
    renderOpsButtonBadge();
    setHidden(opsFixesTabBadge, true);
    setHidden(opsFixesSummary, true);
    opsFixesList.innerHTML = "";
    const p = document.createElement("p");
    p.className = "ops-empty";
    p.textContent = err.message;
    opsFixesList.appendChild(p);
  }
}

function renderOpsFixes(data) {
  // Recorded from EVERY repo in the payload, not just the groups kept below:
  // this is the "does this fix still exist" authority for
  // pruneResolvedPendingDecisions, and filtering first would make a fix look
  // deleted merely because its repo rendered nothing.
  lastLoadedFixSessionKeys = new Set();
  for (const group of data.repos || []) {
    for (const fix of Object.values(group.fixes || {})) {
      if (fix && typeof fix.sessionKey === "string") lastLoadedFixSessionKeys.add(fix.sessionKey);
    }
  }

  // Filtered BEFORE the empty check, not skipped inside the loop below:
  // the route already omits fixless repos, but if one ever did arrive the
  // "is there anything to show" test would pass on a group that renders
  // nothing, leaving a blank panel with no empty-state message at all.
  const groups = (data.repos || []).filter((g) => Object.keys(g.fixes || {}).length);
  const awaiting = data.awaitingDecisionCount || 0;

  opsFixesTabBadge.textContent = String(awaiting);
  setHidden(opsFixesTabBadge, awaiting === 0);
  opsBadgeCounts.fixes = awaiting;
  renderOpsButtonBadge();

  opsFixesList.innerHTML = "";
  if (!groups.length) {
    setHidden(opsFixesSummary, true);
    const p = document.createElement("p");
    p.className = "ops-empty";
    // Says what was actually checked - "nothing here" is ambiguous between
    // "all quiet" and "this never loaded".
    p.textContent = data.repoCount
      ? `No in-progress fixes across ${data.repoCount} registered repos`
      : "No in-progress fixes";
    opsFixesList.appendChild(p);
    return;
  }

  const fixCount = data.fixCount || 0;
  opsFixesSummary.textContent =
    `${fixCount} fix${fixCount === 1 ? "" : "es"} across ${groups.length} repo${groups.length === 1 ? "" : "s"}` +
    (awaiting ? ` · ${awaiting} waiting on you` : "");
  setHidden(opsFixesSummary, false);

  for (const group of groups) {
    const fixes = group.fixes || {};
    // Most-recently-updated first within a repo, same ordering the sidebar
    // widget uses.
    const branches = Object.keys(fixes).sort((a, b) =>
      (fixes[b].updated_at || "").localeCompare(fixes[a].updated_at || ""),
    );

    const section = document.createElement("div");
    section.className = "ops-fix-group";

    const header = document.createElement("div");
    header.className = "ops-fix-group-header";
    const name = document.createElement("h4");
    name.textContent = group.displayName || group.repoKey;
    header.appendChild(name);
    // The repoKey is what every session key, agent name and API path is
    // actually built from, so it's worth showing whenever the friendly
    // label isn't already it.
    if (group.displayName && group.displayName !== group.repoKey) {
      const key = document.createElement("span");
      key.className = "ops-fix-group-key";
      key.textContent = group.repoKey;
      header.appendChild(key);
    }
    if (!group.monitoringEnabled) {
      const pill = document.createElement("span");
      pill.className = "pill state-queued";
      pill.textContent = "monitoring off";
      header.appendChild(pill);
    }
    section.appendChild(header);

    for (const branch of branches) {
      section.appendChild(
        buildStageFixRow(branch, fixes[branch], group.repoKey, {
          beforeOpen: closeOpsModal,
          // Refreshes this list AND the main pane's inline decision card -
          // if the decision was made on the fix whose conversation is
          // currently on screen, that card is offering the same choice and
          // would otherwise stay stale.
          onDecisionSent: () => {
            loadOpsFixes();
            refreshSessionDecision(repoSelect.value);
          },
        }),
      );
    }
    opsFixesList.appendChild(section);
  }
}

// --- Stage tracker (fix rows + decision prompts) ---
// Fixed 0-7 to match the write-capable escalation agent's own staged
// protocol (AGENTS.md's "Staged protocol" section) - not derived from the
// tracker data itself, since the label set is the same for every repo.
// Was off by one against the real protocol until 2026-08-05 (index 0 read
// "Investigate" instead of the actual Stage 0 setup step, and index 7 read
// a phantom "Done" that doesn't exist - stage 7 is really "merge
// conflicts", an edge case, not a terminal state; completion is the
// tracker entry being REMOVED, not a stage 7/8 value). Matches
// templates/agent-writecapable/AGENTS.md.tmpl's own "**Stage N —**"
// headings exactly - that file is the source of truth, keep these in sync
// if it's ever renumbered.
const STAGE_LABELS = [
  "Refresh trunk", // Stage 0 - always first, no exceptions
  "Investigate", // Stage 1
  "Prepare fix", // Stage 2
  "Verify", // Stage 3
  "Report & ask permission", // Stage 4 - STOP, wait for a reply
  "Push & PR", // Stage 5
  "Merged, cleanup", // Stage 6
  "Merge conflict", // Stage 7
];

// One entry per decision the backend's own DECISION_MESSAGES
// (routes/ops.js) understands - label is what the button says, stage is
// which tracker stage this decision applies to (only used here to decide
// WHICH buttons to offer for a given fix; the backend independently
// re-verifies the same stage match before actually sending anything, not
// trusted from this list alone).
const DECISIONS = {
  approve: { label: "Approve", stage: 4 },
  deny: { label: "Deny", stage: 4 },
  "confirm-merged": { label: "Confirm merged", stage: 5 },
  // stage:null - offered for any fix NOT at 4 or 5, which is the one case the
  // other three leave unreachable (see routes/ops.js's own close-out comment
  // for the six stranded entries that prompted this).
  "close-out": { label: "Close out", stage: null },
  // Not a fix action at all - it answers a suppression proposal, which after
  // Stage 1's close-out rule usually has no tracker entry behind it. Lives on
  // the conversation's decision card, not on a fix row.
  "approve-suppression": { label: "Approve suppression", stage: null },
  // Read-only: asks the agent to re-check whether the fix is still needed and
  // report back. readOnly is load-bearing, not decoration - see sendDecision.
  verify: { label: "Re-check", stage: null, readOnly: true },
};

// Both new actions ask the agent to change something on disk (a tracker
// entry, a suppression file) on the strength of one click, and neither is a
// reply to a question the row itself states - so both confirm on a second
// click, the same inline re-arm Deny uses rather than a modal.
const CONFIRMING_DECISIONS = {
  deny: { armedLabel: "Discard fix?", title: "Removes the worktree and deletes the branch. The diff is saved first." },
  "close-out": {
    armedLabel: "Close it out?",
    title: "Tells the agent this needs no fix and to remove its tracker entry.",
  },
  "approve-suppression": {
    armedLabel: "Approve it?",
    title: "Approves the exact suppression line the agent proposed in its report, and nothing wider.",
  },
};

// Decisions the user has sent that the agent hasn't visibly acted on yet.
//
// A decision is a MESSAGE to an agent, not a state change - the tracker only
// moves once the agent wakes, does the work, and rewrites it, which takes
// seconds to minutes. But onSuccess refreshed the card immediately, and the
// refresh found the fix still at the same stage, so it wiped the "Sent"
// confirmation and rebuilt the buttons ENABLED. The click looked like it had
// done nothing, so people clicked again - reported as "I need to click Approve
// 2-3 times", "the prompt is still there after approving", and a second click
// erroring with "no fix on this session is currently at stage 5" (that error
// was the truthful one: the FIRST click had worked and the fix had moved on).
//
// Keyed by sessionKey, and remembers the stage it was sent at, so the entry
// self-clears the moment the tracker actually moves - which is the real signal
// that the agent acted, rather than a guess about how long it should take.
const pendingDecisions = new Map();

// If an agent never acts (crashed run, aborted mid-turn), the buttons must come
// back rather than leaving the fix permanently unactionable - the exact dead end
// the every-stage Close out button was added to remove. 10 minutes matches the
// agent timeout (agents.defaults.timeoutSeconds = 600).
const PENDING_DECISION_TTL_MS = 10 * 60 * 1000;

function pendingDecisionFor(fix) {
  const entry = pendingDecisions.get(fix.sessionKey);
  if (!entry) return null;
  if (Date.now() - entry.sentAt > PENDING_DECISION_TTL_MS) {
    pendingDecisions.delete(fix.sessionKey);
    return null;
  }
  // Stage moved => the agent acted. Anything else the tracker now says is the
  // truth, so stop suppressing.
  if (entry.stage !== fix.stage) {
    pendingDecisions.delete(fix.sessionKey);
    return null;
  }
  return entry;
}

function buildPendingDecisionNote(entry) {
  const note = document.createElement("div");
  note.className = "stage-decision-pending";
  note.textContent = `${DECISIONS[entry.decision]?.label || entry.decision} sent — waiting for the agent to act on it.`;
  note.title =
    "The agent has been messaged. This clears itself as soon as the stage tracker moves, " +
    "and the buttons return automatically if nothing happens within 10 minutes.";
  return note;
}

// Session keys present in the most recent SUCCESSFUL /api/ops/stages render.
// null means "never loaded successfully", which must not be read as "the fix is
// gone" - see pruneResolvedPendingDecisions.
let lastLoadedFixSessionKeys = null;

// A fix that DISAPPEARS is a resolved decision, and nothing else was noticing.
// Both pendingDecisions deletions live inside pendingDecisionFor(fix), which
// only runs while rendering an existing fix - so when the tracker entry is
// removed outright (Close out, Stage 6 cleanup, a denied fix tidied up) the
// entry was never reachable again. Its 10-minute TTL never fired either, being
// checked in the same unreachable place. pendingDecisions.size therefore stayed
// >0 forever, the poll below never cleared, and it re-fetched the Ops panel
// every 5 seconds for the rest of the session - reported as the Operations tab
// flickering indefinitely after Close out, surviving a tab switch (this timer
// is global, not tab-scoped) and only stopping on reload.
//
// So resolution is decided here, from the load, rather than from a render that
// may never happen again.
//
// The grace period guards the one way this could misfire: /api/ops/stages
// degrades an unparseable tracker to {}, so a transient blip could briefly
// report a live fix as absent. Pruning on that would restore the buttons and
// re-open the double-click hole the pendingDecisions map exists to close.
// 30s of absence is far longer than any such blip and still kills the leak
// within one or two polls.
const PENDING_DECISION_ABSENT_GRACE_MS = 30 * 1000;

function pruneResolvedPendingDecisions() {
  const now = Date.now();
  for (const [sessionKey, entry] of pendingDecisions) {
    const age = now - entry.sentAt;
    if (age > PENDING_DECISION_TTL_MS) {
      pendingDecisions.delete(sessionKey);
      continue;
    }
    if (lastLoadedFixSessionKeys && !lastLoadedFixSessionKeys.has(sessionKey) && age > PENDING_DECISION_ABSENT_GRACE_MS) {
      pendingDecisions.delete(sessionKey);
    }
  }
}

// While anything is pending, poll so the card clears itself when the agent
// finishes. Without this, a completed merge left its prompt on screen
// indefinitely - the conversation card only refreshed on an explicit user
// action, so it stayed stale while the Ops tab (reloaded separately) was right.
let pendingDecisionPoll = null;
let pendingDecisionPollInFlight = false;
function stopPendingDecisionPoll() {
  clearInterval(pendingDecisionPoll);
  pendingDecisionPoll = null;
}
function ensurePendingDecisionPoll() {
  if (pendingDecisionPoll || !pendingDecisions.size) return;
  pendingDecisionPoll = setInterval(async () => {
    if (!pendingDecisions.size) {
      stopPendingDecisionPoll();
      return;
    }
    // A slow load must not let ticks pile up on top of each other - that
    // multiplies the refetch this poll already costs, and each overlapping
    // load is another chance to repaint the panel.
    if (pendingDecisionPollInFlight) return;
    pendingDecisionPollInFlight = true;
    try {
      // quiet: this is a background refresh, not a user asking for the panel.
      await Promise.all([refreshSessionDecision(currentSessionRepoKey), loadOpsFixes({ quiet: true })]);
    } finally {
      pendingDecisionPollInFlight = false;
    }
    // After the load, so a fix that vanished in THIS tick stops the poll now
    // rather than one tick later.
    pruneResolvedPendingDecisions();
    if (!pendingDecisions.size) stopPendingDecisionPoll();
  }, 5000);
}

// Shared by the stage-tracker dropdown's own row buttons and the main
// session-decision-card - both send the exact same fixed message via the
// exact same endpoint, just from two different places in the UI (Claude
// Code's own permission prompt is reachable inline in the transcript same
// as this is meant to be, not confined to one single surface either).
async function sendDecision(sessionKey, decision, buttons, statusEl, onSuccess, stageWhenSent) {
  // Disabled during the request either way (double-send guard), but a
  // read-only action re-enables on success - it answers a question rather
  // than resolving the fix, so the real decision must stay reachable.
  for (const b of buttons) b.disabled = true;
  if (statusEl) {
    statusEl.textContent = "Sending…";
    setHidden(statusEl, false);
  }
  try {
    const res = await fetch("/api/ops/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey, decision }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "failed to send decision");
    if (statusEl) {
      statusEl.textContent = DECISIONS[decision]?.readOnly
        ? "Re-check requested — the agent will report back in this conversation."
        : "Sent — the agent is working on it now.";
    }
    if (DECISIONS[decision]?.readOnly) for (const b of buttons) b.disabled = false;
    // Recorded BEFORE onSuccess, because onSuccess re-renders and the render
    // needs to see this to avoid handing the buttons straight back.
    // A read-only action must NOT arm the pending state. Pending clears itself
    // when the stage moves, and a re-check deliberately never moves the stage -
    // so recording one would hide Approve/Deny for the full 10-minute TTL,
    // right when the human is waiting to read the answer and act on it.
    if (!DECISIONS[decision]?.readOnly && stageWhenSent !== null && stageWhenSent !== undefined) {
      pendingDecisions.set(sessionKey, { decision, stage: stageWhenSent, sentAt: Date.now() });
      ensurePendingDecisionPoll();
    }

    // Fixes the gap found live 2026-09-03: the server-side record of this
    // decision (sessionIndex.record(), see routes/ops.js's POST
    // /api/ops/decision) was always correct and immediate, but nothing
    // client-side ever refreshed to show it - the Recents checkmark and
    // this-session's "already sent" note (renderRecents()/
    // renderAgentReplyActions(), see their own comments) only ever picked
    // it up on the NEXT full page load, because loadSessions() is only
    // ever called then. A decision this same tab just sent is known with
    // certainty (no read-your-own-write race to worry about, unlike a
    // concurrent second operator's click, which still needs a real
    // refresh to see), so patch the cached `sessions` entry locally and
    // re-render immediately rather than waiting on one. Every caller of
    // sendDecision benefits, not just approve-suppression's (which never
    // passed an onSuccess reaching Recents at all) - a general fix at the
    // one place ALL decisions actually go through, not one per call site.
    const cachedEntry = sessions.find((s) => s.sessionKey === sessionKey);
    if (cachedEntry) {
      const now = Date.now();
      cachedEntry.lastDecision = decision;
      cachedEntry.lastDecisionLabel = (DECISIONS[decision] && DECISIONS[decision].label) || decision;
      cachedEntry.lastDecisionAt = now;
      cachedEntry.updatedAt = now;
      sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      renderRecents();
      if (currentReplyEntry && currentReplyEntry.sessionKey === sessionKey) {
        renderAgentReplyActions();
      }
    }

    if (onSuccess) onSuccess();
  } catch (err) {
    for (const b of buttons) b.disabled = false;
    if (statusEl) {
      statusEl.textContent = err.message;
      setHidden(statusEl, false);
    }
  }
}

// Builds the button set for one fix: Approve/Deny at stage 4, Confirm-merged
// at stage 5, and Close out at any OTHER stage - a fix below 4 has nothing to
// approve or merge, and leaving it with no buttons at all is exactly the dead
// end this used to be. Shared by the fix rows and the main
// session-decision-card, so the two surfaces can never drift in which buttons
// they offer for the same stage. `names` may be passed explicitly by a caller
// that isn't acting on a tracker stage at all (the suppression approval).
function buildDecisionButtons(sessionKey, stage, statusEl, onSuccess, explicitNames) {
  // stage is also what a sent decision is remembered against (see pendingDecisions).
  const wrap = document.createElement("div");
  wrap.className = "stage-decision-actions";
  // Re-check rides along with whatever the real decision is. The evidence
  // behind a fix goes stale while it waits - and at stage 4 the repo's watcher
  // is fully paused, so nothing is being checked at all - which makes "is this
  // still needed?" a question every one of these stages can raise.
  const names =
    explicitNames ||
    (stage === 4
      ? ["approve", "deny", "verify"]
      : stage === 5
        ? ["confirm-merged", "verify"]
        : ["close-out", "verify"]);
  const buttons = [];
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `stage-decision-btn stage-decision-${name}`;
    btn.textContent = DECISIONS[name].label;
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  for (const btn of buttons) {
    const name = names[buttons.indexOf(btn)];
    // Deny confirms on a second click (2026-08-05). It used to be a plain
    // "hold this fix" message, which was harmless to click by accident;
    // it now discards the work - worktree removed, branch deleted, tracker
    // entry closed out - and sits immediately next to Approve. A one-click
    // irreversible action adjacent to its opposite is a misclick waiting to
    // happen. Inline re-arm rather than a modal, matching how the rest of
    // this UI handles confirmation, and it auto-disarms so a Deny left
    // half-clicked doesn't stay primed behind a tab switch. Close-out and
    // the suppression approval re-arm the same way (see CONFIRMING_DECISIONS)
    // - both act on disk off a single click.
    const confirming = CONFIRMING_DECISIONS[name];
    if (!confirming) {
      btn.addEventListener("click", () => sendDecision(sessionKey, name, buttons, statusEl, onSuccess, stage));
      continue;
    }
    let armed = false;
    let disarmTimer = null;
    const disarm = () => {
      armed = false;
      if (disarmTimer) clearTimeout(disarmTimer);
      disarmTimer = null;
      btn.textContent = DECISIONS[name].label;
      btn.classList.remove("armed");
    };
    btn.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirming.armedLabel;
        btn.classList.add("armed");
        btn.title = confirming.title;
        disarmTimer = setTimeout(disarm, 5000);
        return;
      }
      disarm();
      sendDecision(sessionKey, name, buttons, statusEl, onSuccess, stage);
    });
  }
  return wrap;
}

// A fix at stage 4 holds the whole repo's watcher (see the stage-4 gate in
// templates/watcher-*.sh.tmpl): incidents keep being detected but nothing
// escalates until a human decides. That's correct behaviour - it's what
// stops an automated message racing the click - but it's invisible, and an
// unattended fix quietly turns monitoring off for as long as it sits there.
// Surfacing the elapsed time is the cheap half of the fix; the deterministic
// half is Deny releasing the gate via the denials file.
const STAGE4_PAUSE_WARN_MS = 6 * 60 * 60 * 1000;

function pausedForLabel(fix) {
  if (fix.stage !== 4 || fix.denied || typeof fix.updated_at !== "string") return null;
  const since = Date.parse(fix.updated_at);
  if (!Number.isFinite(since)) return null;
  const elapsed = Date.now() - since;
  if (elapsed < STAGE4_PAUSE_WARN_MS) return null;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  return hours >= 48
    ? `monitoring paused ${Math.floor(hours / 24)}d`
    : `monitoring paused ${hours}h`;
}

// Fetches one repo's in-flight fixes purely to decide whether the main
// pane's inline decision card belongs on screen (see
// updateSessionDecisionCard) - the sidebar stage widget this used to also
// feed was removed 2026-08-06 in favour of the Ops modal's cross-repo
// Fixes tab, which is why this no longer renders anything itself.
// Called on repo switch, initial load, opening a historical session, and
// after a run completes, so a fix reaching stage 4 while the user is
// mid-conversation with it surfaces without them reopening anything.
async function refreshSessionDecision(repoKey) {
  if (!repoKey) {
    // Nothing selected - clear a card left over from a previous repo
    // rather than leaving it stranded (the fetch below is what normally
    // does this, via the "no match" path).
    updateSessionDecisionCard({});
    return;
  }
  try {
    const res = await fetch(`/api/ops/stages/${encodeURIComponent(repoKey)}`);
    if (sessionExpired(res)) return;
    if (!res.ok) return; // silent - this is a nice-to-have prompt, not core functionality
    const data = await res.json();
    updateSessionDecisionCard(data.fixes || {});
  } catch {
    // silent, same reasoning
  }
}

// Turns a tracker `updated_at` into a "how long has this been sitting" chip,
// and flags the two ways a fix stops being what the stage bar implies.
//
// The stage bar shows the furthest stage REACHED, never whether anything is
// still driving it - so a fix abandoned mid-protocol renders identically to one
// actively working. On 2026-08-07 a run was aborted mid-stage-2 (its fix
// already committed) and nothing on this screen said so; it was noticed only
// because someone happened to look.
//
// Two distinct signals, deliberately not merged:
//   - lastRunAborted: the run driving it actually died. Definite, so it's an
//     error, not a warning.
//   - age with no movement: circumstantial, so it's only a warning, and only
//     for stages the agent is supposed to be actively working (0-3). Stages 4
//     and 5 are WAITING FOR A HUMAN by design - flagging those as stalled would
//     nag about the dashboard's own unanswered question and train people to
//     ignore the indicator.
const STALL_WARN_MS = 60 * 60 * 1000; // one full watcher cooldown: a re-escalation should have moved it by now

function formatAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function buildStageActivityChips(fix, stage) {
  const chips = [];
  const updatedMs = fix.updated_at ? Date.parse(fix.updated_at) : NaN;
  const age = Number.isFinite(updatedMs) ? Date.now() - updatedMs : null;

  // Always shown when known: "how long since this moved" is the single fact
  // that made every row look alike, and it costs nothing to state.
  if (age !== null) {
    const ageChip = document.createElement("span");
    ageChip.className = "stage-activity-age";
    ageChip.textContent = formatAge(age);
    ageChip.title = `Stage tracker last updated ${new Date(updatedMs).toLocaleString()}`;
    chips.push(ageChip);
  }

  if (fix.lastRunAborted === true) {
    const chip = document.createElement("span");
    chip.className = "stage-activity-chip aborted";
    chip.textContent = "last run aborted";
    chip.title =
      "The agent run driving this fix ended abnormally (sessions.list reports abortedLastRun). " +
      "Work already committed is still on its branch, but nothing is advancing it. " +
      "A config change that hot-reloads the model provider will do this to an in-flight run.";
    chips.push(chip);
  } else if (age !== null && age > STALL_WARN_MS && stage <= 3) {
    const chip = document.createElement("span");
    chip.className = "stage-activity-chip stalled";
    chip.textContent = "no movement";
    chip.title =
      "No stage change for over an hour while still mid-protocol. The watcher re-escalates on its " +
      "own cooldown, so a fix this stale usually means the run stopped rather than that it is slow.";
    chips.push(chip);
  }
  return chips;
}

// One fix's row: title, PR link, step dots, "Open conversation", and the
// stage-4/5 decision buttons. Built by the Ops modal's Fixes tab, which is
// the single surface for these since the sidebar's duplicate stage widget
// was removed (2026-08-06). Kept as its own function rather than inlined
// into renderOpsFixes(): the row is also the natural building block for any
// future surface, and the sidebar copy existing separately is precisely how
// the duplication happened.
//
// There's deliberately no per-row dismiss: the Fixes tab exists to be the
// complete cross-repo list, so hiding rows from it (the old sidebar
// widget's "get this off my sidebar" gesture) would defeat its purpose.
function buildStageFixRow(branch, fix, repoKey, { beforeOpen, onDecisionSent } = {}) {
  const stage = Math.min(Math.max(fix.stage || 0, 0), 7);

  const row = document.createElement("div");
  row.className = fix.denied ? "stage-fix-row denied" : "stage-fix-row";

  const rowHeader = document.createElement("div");
  rowHeader.className = "stage-fix-row-header";

  const title = document.createElement("div");
  title.className = "stage-indicator-title";
  const strong = document.createElement("strong");
  // fix.incident is agent-authored free text from the tracker file - same
  // untrusted-content discipline as renderMarkdownToSafeHtml's own comment
  // (an LLM agent may have read external content), so textContent only,
  // never innerHTML.
  strong.textContent = fix.incident || branch;
  title.appendChild(strong);
  title.appendChild(
    document.createTextNode(
      fix.denied
        ? " — denied, discarding"
        : ` — stage ${stage} of 7 (${STAGE_LABELS[stage] || "in progress"})`,
    ),
  );
  const pausedLabel = pausedForLabel(fix);
  if (pausedLabel) {
    const warn = document.createElement("span");
    warn.className = "stage-pause-warning";
    warn.textContent = ` · ${pausedLabel}`;
    warn.title =
      "This repo's watcher is paused while a fix waits at stage 4. Incidents are still detected and are re-read once you decide, but nothing escalates until then.";
    title.appendChild(warn);
  }
  if (typeof fix.pr_url === "string" && fix.pr_url.startsWith("https://")) {
    title.appendChild(document.createTextNode(" · "));
    const link = document.createElement("a");
    link.href = fix.pr_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "PR";
    title.appendChild(link);
  }
  rowHeader.appendChild(title);

  const activity = document.createElement("div");
  activity.className = "stage-activity";
  for (const chip of buildStageActivityChips(fix, stage)) activity.appendChild(chip);
  if (activity.childElementCount) rowHeader.appendChild(activity);

  row.appendChild(rowHeader);

  const steps = document.createElement("div");
  steps.className = "stage-steps";
  for (let i = 0; i <= 7; i++) {
    const step = document.createElement("span");
    step.className = `stage-step${i < stage ? " done" : i === stage ? " current" : ""}`;
    steps.appendChild(step);
  }
  row.appendChild(steps);

  // Claude Code's own pattern for a running task indicator: it's a link
  // into that task's real transcript, not just a static progress readout -
  // reuses openHistoricalSession() (the same function every Recents click
  // already goes through) rather than a new navigation path.
  // fix.sessionKey (not watcherSessionKey - see readStagesFile() in
  // routes/ops.js) is the REAL session driving this specific fix, which
  // isn't always the watcher: a fix started mid-conversation with a
  // human runs under that conversation's own key instead. Only absent
  // if an old cached response predates this field - guard rather than
  // assume.
  if (fix.sessionKey) {
    const openLink = document.createElement("button");
    openLink.type = "button";
    openLink.className = "stage-open-conversation";
    openLink.textContent = "Open conversation →";
    openLink.addEventListener("click", () => {
      // Gets the container out of the way first (the Ops modal) -
      // openHistoricalSession navigates the main pane, which is behind it.
      if (beforeOpen) beforeOpen();
      openHistoricalSession({ repoKey, sessionKey: fix.sessionKey, origin: "gateway" });
    });
    row.appendChild(openLink);

    // Approve/Deny (stage 4), Confirm-merged (stage 5), or Close out
    // (anything else) - reachable right here, without needing to open the
    // conversation at all, per the user's own "when clicked" requirement.
    // The composer stays disabled for gateway-origin sessions (unrelated
    // free-form chat could confuse a live cron-driven protocol mid-turn),
    // but a structured decision always stays reachable, same principle as
    // Claude Code's own Allow/Deny prompt never being blocked by "you
    // can't type in this box right now".
    //
    // EVERY stage gets a button now (2026-08-06). It used to be 4 and 5
    // only, on the reasoning that a fix mid-investigation needs nothing
    // from anyone - true right up until the agent stops without finishing,
    // at which point the row was permanently unactionable: no button, and
    // no composer to ask about it either. Close out is the answer to
    // "this one is never going anywhere", and it's the only decision that
    // isn't stage-pinned.
    //
    // Not for an already-denied fix: the decision it's asking for has
    // been made. Offering Approve again there would let a second click
    // contradict the first, and the backend would reject it anyway (its
    // own stage re-check still sees stage 4 until the agent tidies up),
    // so the buttons would be live-looking and non-functional. A denied
    // fix that the agent never actually cleaned up is the one case where
    // Close out would help - but that's what Deny's own message already
    // instructs, so a second nag button is the wrong fix for it.
    if (!fix.denied) {
      const rowStatus = document.createElement("p");
      rowStatus.className = "stage-decision-status";
      rowStatus.hidden = true;
      // Same rule as the conversation card: a decision already sent and not yet
      // acted on must not be offered again from the other surface either - the
      // multi-click problem was reported on BOTH.
      const pending = pendingDecisionFor(fix);
      if (pending) {
        row.appendChild(buildPendingDecisionNote(pending));
      } else {
        row.appendChild(buildDecisionButtons(fix.sessionKey, stage, rowStatus, onDecisionSent));
      }
      row.appendChild(rowStatus);
    }
  }

  return row;
}

// Shows the SAME Approve/Deny/Confirm-merged prompt inline in the main
// conversation area whenever the session the user is actually looking at
// right now matches a fix currently at stage 4 or 5 - the Ops modal's
// Fixes tab covers "go looking for it", this covers "it popped up in the
// conversation I'm already in". Called unconditionally by
// refreshSessionDecision(), including when there are no fixes at all, so a
// repo/session switch correctly clears a card left over from before.
function updateSessionDecisionCard(fixes) {
  const viewedKey = sessionKeyLabel.textContent;
  let match = null;
  if (viewedKey) {
    for (const fix of Object.values(fixes)) {
      if (fix.sessionKey === viewedKey && !fix.denied && (fix.stage === 4 || fix.stage === 5)) {
        match = fix;
        break;
      }
    }
  }

  if (!match) {
    setHidden(sessionDecisionCard, true);
    renderAgentReplyActions();
    return;
  }

  sessionDecisionDescription.textContent =
    match.stage === 4
      ? `${match.incident || "This fix"} — the agent has stopped and is waiting for your permission to push the branch and open a PR.`
      : `${match.incident || "This fix"} — the agent is waiting to hear that the PR has been merged.`;
  sessionDecisionActions.innerHTML = "";
  setHidden(sessionDecisionStatus, true);
  const pending = pendingDecisionFor(match);
  if (pending) {
    // Already answered; don't offer the same choice again while the agent is
    // still working through it.
    sessionDecisionActions.appendChild(buildPendingDecisionNote(pending));
  } else {
    const onSent = () => {
      refreshSessionDecision(currentSessionRepoKey);
      loadOpsFixes();
    };
    sessionDecisionActions.appendChild(
      buildDecisionButtons(match.sessionKey, match.stage, sessionDecisionStatus, onSent),
    );
  }
  setHidden(sessionDecisionCard, false);
  renderAgentReplyActions();
}

// The composer is disabled for a watcher-started escalation session (see
// openHistoricalSession), which is correct - free-form chat mid-protocol is
// how you confuse a live cron-driven agent - but it left one legitimate reply
// with nowhere to go: an agent that proposed a watcher suppression and stopped
// for permission. That's a fixed, structured yes with no free text in it, so
// it goes here, immediately above the composer that just told the user they
// can't type.
//
// Offered on every escalation session rather than only when a proposal is
// actually pending, because "is one pending?" is only answerable by reading
// the agent's prose - which varies run to run and is not necessarily in
// English. Guessing at that with pattern-matching would be wrong in both
// directions: a missed proposal is a dead end again, and a false positive
// invites an approval for something nobody proposed. The message the button
// sends handles the false-positive case explicitly ("if you did not actually
// propose a suppression line, add nothing at all and say so"), so an
// unnecessary click is inert rather than harmful.
let currentReplyEntry = null;

function updateAgentReplyActions(entry) {
  currentReplyEntry = entry;
  renderAgentReplyActions();
}

function renderAgentReplyActions() {
  const entry = currentReplyEntry;
  agentReplyButtons.innerHTML = "";
  setHidden(agentReplyStatus, true);

  // Reviewer sessions are excluded (the backend rejects them too): a reviewer
  // owns no watcher and no suppression file, so there is nothing there to
  // approve.
  if (!entry || entry.origin !== "gateway" || entry.agentRole === "reviewer") {
    setHidden(agentReplyActions, true);
    return;
  }

  // Not while a stage-4/5 fix decision is on screen. The two are mutually
  // exclusive in the protocol, not merely redundant: per Stage 1's close-out
  // rule a benign-but-recurring verdict (the case a suppression answers) leaves
  // NO tracker entry behind, so a fix sitting at stage 4 or 5 means the agent
  // stopped for a fix decision, not for a suppression. Showing both put two
  // different "approve" buttons a few pixels apart, answering different
  // questions - the same misclick risk that made Deny confirm on a second
  // click. The suppression prompt returns the moment the fix decision clears.
  if (!sessionDecisionCard.hidden) {
    setHidden(agentReplyActions, true);
    return;
  }

  agentReplyNote.textContent =
    "You can't type into a session the watcher started. If this agent proposed adding a suppression line to its watcher and stopped for permission, approve it here:";

  // Same lastDecision/lastDecisionAt data renderRecents() already shows in
  // the sidebar (see sessionIndex.record()'s own comment for the full
  // reasoning) - surfaced HERE too because this button, unlike a stage-4/5
  // fix's, is unconditional: it is offered on every viewing of an
  // escalation session's latest reply regardless of whether anything is
  // actually pending (see this function's own comment above), so nothing
  // about the button itself ever changes once you've already sent a
  // decision here. Without this note a session you'd already answered -
  // correctly, agent already replied and declined since nothing was really
  // proposed - looked, on a return visit, indistinguishable from one you'd
  // never touched: same note, same button, no sign anything happened.
  // Deliberately doesn't hide or disable the button - a genuinely later
  // turn on the same session can propose a real suppression needing its own
  // fresh answer, and this reads from the SAME sessions array renderRecents()
  // does, so the two never show conflicting information.
  const recentsEntry = sessions.find((s) => s.sessionKey === entry.sessionKey);
  if (recentsEntry && recentsEntry.lastDecision) {
    const decisionNote = document.createElement("p");
    decisionNote.className = "agent-reply-last-decision";
    const decisionLabel =
      (DECISIONS[recentsEntry.lastDecision] && DECISIONS[recentsEntry.lastDecision].label) || recentsEntry.lastDecision;
    decisionNote.textContent = `\u2713 You already sent "${decisionLabel}" on this session`;
    if (recentsEntry.lastDecisionAt) {
      decisionNote.title = `Sent ${new Date(recentsEntry.lastDecisionAt).toLocaleString()}`;
    }
    agentReplyButtons.appendChild(decisionNote);
  }

  agentReplyButtons.appendChild(
    buildDecisionButtons(entry.sessionKey, null, agentReplyStatus, null, ["approve-suppression"]),
  );
  setHidden(agentReplyActions, false);
}

// --- Background-task activity strip ---
function relativeTimeShort(ms) {
  if (!ms) return "";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

async function loadActivity() {
  try {
    const res = await fetch("/api/ops/tasks?limit=30");
    if (sessionExpired(res)) return;
    if (!res.ok) return;
    const data = await res.json();
    renderActivity(data.tasks || []);
  } catch {
    // silent - notification surface, not core functionality
  }
}

function renderActivity(tasks) {
  // "completed" is the raw RPC's own status term (confirmed live
  // 2026-08-03) - NOT "succeeded", which is only what openclaw's own
  // `tasks list` CLI table displays. Don't assume the CLI's display terms
  // match the RPC's own.
  const notable = tasks.filter((t) => t.status !== "completed").slice(0, 15);
  activityBadge.textContent = String(notable.length);
  setHidden(activityBadge, notable.length === 0);

  activityList.innerHTML = "";
  if (!notable.length) {
    const p = document.createElement("p");
    p.className = "sidebar-empty";
    p.textContent = "Nothing recent";
    activityList.appendChild(p);
    return;
  }
  for (const task of notable) {
    const row = document.createElement("div");
    row.className = "activity-row";
    const label = document.createElement("span");
    label.className = "activity-row-label";
    label.textContent = task.title || task.taskId;
    const pill = document.createElement("span");
    pill.className = `pill state-${task.status === "failed" ? "error" : task.status}`;
    pill.textContent = `${task.status} · ${relativeTimeShort(task.updatedAt)}`;
    row.appendChild(label);
    row.appendChild(pill);
    activityList.appendChild(row);
  }
}

let activityPollInterval = null;
function toggleActivityDropdown() {
  const willOpen = activityDropdown.hidden;
  setHidden(activityDropdown, !willOpen);
  // The markup has carried aria-expanded="false" since this button was
  // added, but nothing ever updated it - so it told assistive tech the menu
  // was shut the whole time it was open. Fixed 2026-08-06 when the row lost
  // its border and started reading its open state from this same attribute
  // (see .sidebar-nav-item[aria-expanded="true"]), which is what surfaced
  // it: the highlight simply never appeared.
  activityBtn.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    loadActivity();
    activityPollInterval = setInterval(loadActivity, 15000);
  } else if (activityPollInterval) {
    clearInterval(activityPollInterval);
    activityPollInterval = null;
  }
}

activityBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleActivityDropdown();
});

document.addEventListener("click", (e) => {
  if (!activityDropdown.hidden && !activityMenu.contains(e.target)) {
    setHidden(activityDropdown, true);
    // Same attribute the toggle above maintains - a click-outside close has
    // to clear it too, or the row stays highlighted over a shut menu.
    activityBtn.setAttribute("aria-expanded", "false");
    if (activityPollInterval) {
      clearInterval(activityPollInterval);
      activityPollInterval = null;
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!confirmDialog.hidden) closeConfirmDialog(false);
  else if (!settingsModal.hidden) closeSettingsModal();
  else if (!opsModal.hidden) closeOpsModal();
  else if (!accountDropdown.hidden) closeAccountDropdown();
  // Escape-to-stop for an active run, falling through only when nothing
  // above was open to close - merged into this single listener rather than
  // living in a second, separate one (see abortActiveRun's own comment,
  // further below, for why). Fixed 2026-07-31: a second listener checking
  // "is anything open" independently doesn't work here even with the exact
  // same conditions - both listeners fire on the SAME keydown, in
  // registration order, so by the time a second listener's own check ran,
  // THIS listener had already closed whatever was open a moment earlier on
  // the very same event, making its "is anything still open" check always
  // read false. Only a single if/else-if chain sharing one pass over the
  // event guarantees "close a dialog" and "abort the run" stay mutually
  // exclusive on one Escape press.
  else if (runIsActive) {
    e.preventDefault();
    abortActiveRun();
  }
});

// Generic confirm dialog - resolves true/false, reused by any destructive
// settings action rather than one dialog per action. showConfirmDialog's
// caller owns deciding what "confirmed" actually does; this component only
// owns asking and reporting the answer.
let confirmDialogResolve = null;

function showConfirmDialog({ title, message, confirmLabel = "Delete" }) {
  confirmDialogTitle.textContent = title;
  confirmDialogMessage.textContent = message;
  confirmDialogConfirmBtn.textContent = confirmLabel;
  setHidden(confirmDialog, false);
  openDialog(confirmDialogPanel);
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
  });
}

function closeConfirmDialog(result) {
  setHidden(confirmDialog, true);
  closeDialog(confirmDialogPanel);
  if (confirmDialogResolve) {
    const resolve = confirmDialogResolve;
    confirmDialogResolve = null;
    resolve(result);
  }
}

confirmDialogCancelBtn.addEventListener("click", () => closeConfirmDialog(false));
confirmDialogBackdrop.addEventListener("click", () => closeConfirmDialog(false));
confirmDialogConfirmBtn.addEventListener("click", () => closeConfirmDialog(true));

// Data Management > Delete All My Chats - see routes/sessions.js's DELETE
// /api/sessions/all and sessionIndex.clear()'s own comment for the exact
// scope (this dashboard's own Recents index only, nothing on the Gateway
// side). Reuses resetToNewTask() for the post-delete view reset - same
// path deleteSession() already relies on when the currently-open
// conversation is the one removed, which after a full clear is always
// true if anything was open at all.
deleteAllChatsBtn.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog({
    title: "Are you sure you want to delete all chats?",
    message:
      "This removes every conversation from this dashboard's Recents list. It does not affect anything on the Gateway. This cannot be undone.",
    confirmLabel: "Delete All",
  });
  if (!confirmed) return;
  try {
    const res = await fetch("/api/sessions/all", { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "failed to delete all chats");
    }
  } catch (err) {
    closeSettingsModal();
    runError.textContent = err.message;
    setHidden(runError, false);
    return;
  }
  sessions = [];
  resetToNewTask(); // also re-renders Recents (now empty)
  closeSettingsModal();
});

// Chatbot convention: Enter sends, Shift+Enter inserts a newline. Also
// auto-grows the textarea instead of a fixed 6-row block.
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 200)}px`;
});

// Shared by newChatBtn's own click handler and deleteSession() (see
// renderRecents below) - deleting the conversation currently on screen
// needs this exact same reset, not just a variant of it.
function resetToNewTask() {
  sessionGeneration++; // invalidates any in-flight continuation/history-load from before this
  if (activeSocket) activeSocket.close();
  activeSocket = null;
  currentSessionRepoKey = null;
  setHidden(sessionDecisionCard, true);
  updateAgentReplyActions(null);
  transcriptHistory.innerHTML = "";
  resetLiveState();
  sessionKeyLabel.textContent = "";
  setHidden(runError, true);
  messageInput.value = "";
  messageInput.style.height = "auto";
  setHidden(conversationEmpty, false);
  currentSessionContinuable = true;
  setComposerEnabled(true);
  // Un-sticks a placeholder left over from viewing a gateway-origin
  // session (see openHistoricalSession) - this function is shared by both
  // the "+ New task" button and deleteSession(), so both paths need this,
  // not just the composer-enabled state.
  messageInput.placeholder = DEFAULT_MESSAGE_PLACEHOLDER;
  stopRunStatus(); // in case "+ New task" was clicked while a run was still in flight
  renderRecents(); // un-highlight whatever was previously active
}

newChatBtn.addEventListener("click", resetToNewTask);

// Only messageInput - runBtn's enabled/disabled state and appearance are
// now owned entirely by startRunStatus()/stopRunStatus() below, since it
// doubles as the Stop control while a run is active (see runIsActive) and
// so needs to stay clickable at exactly the times messageInput does not.
function setComposerEnabled(enabled) {
  messageInput.disabled = !enabled;
}

let runStatusInterval = null;
let runStatusStartedAt = null;
// Mirrors run-status's own visible/hidden state, but exposed as a plain
// flag for runBtn's click handler and the Escape-key handler below to
// check synchronously - matching Claude Code's own convention of the
// send button becoming a Stop button (with an Esc shortcut) while a
// response is generating, rather than a separate always-visible button.
let runIsActive = false;

// Whether the CURRENTLY-viewed session can accept a follow-up message at
// all - false only for a gateway-origin session (see
// openHistoricalSession), true everywhere else. Confirmed live 2026-07-29:
// without this, openSocket's own close handler below unconditionally
// re-enabled the composer the moment a gateway-origin session's WS
// upgrade was rejected (wsRelay.js 403s it - sessionIndex.exists()
// doesn't know about a session that was never started through this
// dashboard's own composer) - that rejection fires its own "close" event
// almost immediately, silently undoing the deliberate disable+explanatory-
// placeholder set moments earlier in openHistoricalSession. The composer
// LOOKED disabled (placeholder text was correct) but messageInput.disabled
// was actually false again by the time the page settled.
let currentSessionContinuable = true;

// Shown for the FULL duration of a run, not just the initial POST - see
// the composer submit handler, which now leaves the composer disabled
// until one of the real completion signals fires (agent status
// completed/failed, lifecycle phase:"end", dashboard.error, or the socket
// closing), matching Claude Code's behavior of blocking new input while
// still working. Pairs with stopRunStatus() at every one of those signals.
function startRunStatus() {
  runIsActive = true;
  runStatusStartedAt = Date.now();
  runStatusLabel.textContent = "Working";
  runStatusTimer.textContent = "0:00";
  setHidden(runStatusTokens, true);
  runStatusTokens.textContent = "";
  runStatusTokens.title = "";
  setHidden(runStatusContext, true);
  runStatusContext.textContent = "";
  runStatusContext.title = "";
  runStatusContext.className = "";
  // Occupancy is per-turn, not per-run: a resumed session picks up where the
  // last one left off, so this stays null only until the first assistant turn
  // of THIS run reports its usage rather than being carried across runs.
  contextUsedTokens = null;
  setHidden(runStatus, false);
  runBtn.disabled = false; // stays clickable - see runIsActive above
  runBtn.classList.add("running");
  runBtn.textContent = "■ Stop";
  runBtn.title = "Stop (Esc)";
  if (runStatusInterval) clearInterval(runStatusInterval);
  runStatusInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - runStatusStartedAt) / 1000);
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    runStatusTimer.textContent = `${mins}:${String(secs).padStart(2, "0")}`;
  }, 1000);
}

function stopRunStatus() {
  runIsActive = false;
  if (runStatusInterval) {
    clearInterval(runStatusInterval);
    runStatusInterval = null;
  }
  runStatusStartedAt = null;
  setHidden(runStatus, true);
  runBtn.disabled = false;
  runBtn.classList.remove("running");
  runBtn.textContent = "Run";
  runBtn.title = "";
}

// Best-effort only - payload.totalTokens (the session's cumulative token
// count) shows up on session.message frames specifically, not every
// frame (see renderFrame's check near the top), so this just
// opportunistically updates whenever it's present rather than trying to
// track token usage precisely turn-by-turn.
//
// This number is CUMULATIVE BILLING: the running sum of every turn's prompt
// tokens. Because each turn re-sends the whole conversation, it grows roughly
// quadratically and routinely exceeds the context window many times over on a
// perfectly healthy session. It is NOT how full the window is, and must never
// be divided by contextWindowTokens - see updateRunContextUsage.
function updateRunStatusTokens(totalTokens) {
  if (typeof totalTokens !== "number" || runStatus.hidden) return;
  setHidden(runStatusTokens, false);
  runStatusTokens.textContent = `${totalTokens.toLocaleString()} tokens used`;
  runStatusTokens.title =
    "Cumulative tokens billed across every turn of this session. Not a measure of how full the context window is.";
}

// Real context occupancy, from the most recent assistant turn's own usage.
//
// Added 2026-07-28 to warn before a context-overflow error (renderFrame's
// lifecycle phase:"error" handling) instead of hitting one with no warning.
// It did not do that job until 2026-08-12: it was fed the session's CUMULATIVE
// token count, so it crossed 70% and then 90% purely by running many turns and
// sat red on healthy sessions. The api-rag reviewer session that exposed this
// displayed "254% of context" while its real peak occupancy was 45,951 of
// 262,144 tokens - 17.5%. Upstream has the same conflation (OpenClaw's TUI
// formatTokens() clamps the ratio at 999% rather than treating >100% as
// impossible), which is why `openclaw sessions list` shows it too.
//
// `usage` survives onto the projected chat message for assistant turns
// specifically - sanitizeChatHistoryMessage in gateway
// dist/session-transcript-path-*.js deletes it for every other role but
// sanitizes-and-keeps it here (re-read 2026-08-12; an earlier note in
// renderFrame claiming the field does not exist at all was checked against a
// non-assistant message and is wrong).
//
// Takes the LAST reading rather than the max on purpose: compaction genuinely
// shrinks the live context, and a max would stay stuck red through a recovery
// that actually worked.
function updateRunContextUsage(usage) {
  // contextUsedFromUsage comes from tokenUsage.js (loaded before this file in
  // index.html) - it holds the field-selection rules, and test/tokenUsage.test.js
  // pins them against a real captured usage series.
  const used = contextUsedFromUsage(usage);
  if (used === null) return;
  contextUsedTokens = used;
  if (runStatus.hidden || !contextWindowTokens) return;
  const pct = Math.round((used / contextWindowTokens) * 100);
  setHidden(runStatusContext, false);
  runStatusContext.textContent = `(${pct}% of context)`;
  runStatusContext.title = `${used.toLocaleString()} of ${contextWindowTokens.toLocaleString()} tokens in the context window on the last turn.`;
  // 70%/90% are a starting point, not tuned against a real near-overflow run.
  // They are at least measuring the right quantity now.
  runStatusContext.className = pct >= 90 ? "context-fail" : pct >= 70 ? "context-warn" : "";
}

// Proxies OpenClaw's own chat.abort RPC (see routes/sessions.js) - no
// runId is tracked/sent client-side, so this stops whatever run is
// currently active for this sessionKey. Deliberately does NOT itself call
// stopRunStatus()/setComposerEnabled(true) on success: chat.abort's own
// completion arrives back over the WS as a normal "lifecycle" event with
// phase:"end"/aborted:true, already handled by renderFrame() exactly like
// any other run ending (see the "agent" branch below) - reusing that path
// keeps there being exactly one place that tears down run-status UI state.
async function abortActiveRun() {
  const sessionKey = sessionKeyLabel.textContent;
  if (!sessionKey) return;
  // Same staleness guard the composer's own submit handler uses (see its
  // comment) - fixed 2026-07-31: without it, clicking Stop then navigating
  // to a different session before this fetch resolves could show a failed
  // abort's error banner against whatever session is now on screen instead
  // of the one actually being stopped.
  const myGeneration = sessionGeneration;
  runBtn.disabled = true; // prevents a double-click firing a second abort while this one is in flight
  runStatusLabel.textContent = "Stopping…";
  try {
    const res = await fetch("/api/sessions/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed to stop run");
  } catch (err) {
    if (myGeneration !== sessionGeneration) return;
    runBtn.disabled = false;
    runStatusLabel.textContent = "Working";
    runError.textContent = err.message;
    setHidden(runError, false);
  }
}

// Intercepted BEFORE the form's own submit handler runs - a submit-type
// button fires "click" first, then "submit" - so this only needs to stop
// propagation via preventDefault() when the button is currently acting as
// Stop; the idle (not running) case falls through untouched and the form
// submits exactly as it always did.
runBtn.addEventListener("click", (e) => {
  if (!runIsActive) return;
  e.preventDefault();
  abortActiveRun();
});

// Escape-to-stop itself lives in the dialog-closing keydown listener
// further up this file (not a second listener here) - textarea being
// disabled for the run's duration means a scoped messageInput handler
// couldn't reach it regardless of focus, but a second document-level
// listener created a real bug once one existed (see that listener's own
// comment for why).

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  setHidden(runError, true);
  const repoKey = repoSelect.value;
  const message = messageInput.value.trim();
  if (!repoKey || !message) {
    runError.textContent = "pick a repo and enter a message";
    setHidden(runError, false);
    return;
  }

  // Continue the active session (same repo, socket still open) instead of
  // starting a brand-new one - the agent's own conversational memory
  // already lives on the Gateway side per session, so reusing the key is
  // all "continuing a chat" actually requires client-side.
  const continuingSameSession = Boolean(
    activeSocket && currentSessionRepoKey === repoKey && sessionKeyLabel.textContent,
  );
  // Snapshot before the await - chat.send has a 90s server-side timeout
  // (routes/run.js), so plenty of time for the user to navigate elsewhere
  // (New task, a different Recents entry) before this resolves. Checked
  // again below before touching any UI state.
  const myGeneration = sessionGeneration;

  setComposerEnabled(false);
  startRunStatus();

  // Optimistic: the user's own message is known in full right now, no need
  // to wait for the gateway to echo it back - shown immediately as its own
  // bubble (see appendUserTurn), matching Claude Code. Only for the
  // continuing-session case here; a brand-new session gets its bubbles
  // further down, right after startStream() resets the view, so they land
  // on the freshly-cleared canvas instead of being wiped by it.
  if (continuingSameSession) {
    setHidden(conversationEmpty, true);
    appendUserTurn(message);
    startAssistantTurn(true); // a new response starting - reset the cross-bubble redundancy tracker
  }

  try {
    const body = { repoKey, message };
    if (continuingSameSession) body.sessionKey = sessionKeyLabel.textContent;
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed to start run");
    messageInput.value = "";
    messageInput.style.height = "auto";
    loadSessions(); // refresh Recents regardless of staleness below - the index itself was genuinely updated server-side

    if (myGeneration !== sessionGeneration) {
      // Superseded by a newer navigation while this was in flight - don't
      // clobber whatever the user is looking at now.
      return;
    }

    if (continuingSameSession && data.sessionKey === sessionKeyLabel.textContent) {
      // Bubbles for this turn were already appended above, before the
      // fetch. The sessionKey equality check is redundant given the
      // generation guard above (nothing can have changed sessionKeyLabel
      // without also bumping the generation) but kept as cheap, harmless
      // defense in depth.
    } else {
      // Either a fresh session, or continuation was rejected server-side
      // (400 on a mismatched sessionKey) - either way `throw` above would
      // have already fired for the latter, so reaching here means a new
      // session was actually minted; open a stream for it, THEN append
      // this turn's bubbles so they land on the freshly-cleared view
      // (startStream()/resetLiveState() wipe #transcript-live).
      currentSessionRepoKey = repoKey;
      refreshSessionDecision(repoKey);
      startStream(repoKey, data.sessionKey);
      appendUserTurn(message);
      startAssistantTurn(true);
    }
  } catch (err) {
    // The POST itself failed (network error, non-2xx, timeout) - no run
    // was ever started, so nothing else will ever fire a completion
    // signal for it. Re-enable here; a successful POST deliberately does
    // NOT re-enable here (see below) - it stays disabled until the run
    // itself actually finishes.
    if (myGeneration === sessionGeneration) {
      runError.textContent = err.message;
      setHidden(runError, false);
      setComposerEnabled(true);
      stopRunStatus();
    }
  }
  // No unconditional re-enable here on success (previously there was one,
  // right after the POST resolved) - confirmed live 2026-07-23 that
  // gating on the run's own completion left the composer stuck disabled
  // forever because neither completion signal reliably fired, which was
  // true at the time. As of 2026-07-27 those signals (agent status
  // completed/failed, lifecycle phase:"end", dashboard.error, WS close -
  // see renderFrame and openSocket's close handler) are confirmed to
  // reliably fire on every real run, and the user explicitly wants the
  // composer locked for the run's full duration (matching Claude Code),
  // so re-enabling is now owned entirely by those signals instead.
});

// Opens the live WS subscription for a sessionKey - shared by starting a
// brand-new run and by re-watching a historical session (see
// openHistoricalSession below). Deliberately does no UI resetting itself;
// callers own their own transcript/thinking/tool-call state before
// calling this.
//
// skipEventReplay tells the server (see wsRelay.js) not to replay this
// run's buffered event history to this new connection. openHistoricalSession
// passes this - it's ALREADY just rendered this session's complete past
// content via a static chat.history-based replay (renderHistoryReplay), so
// wsRelay.js re-sending the same content again as "live" events made it
// visibly re-stream/retype itself through the reveal queue on every
// revisit, confirmed live 2026-07-24. startStream() (a genuinely brand-new
// session, nothing to replay yet) omits it.
function openSocket(sessionKey, { skipEventReplay = false } = {}) {
  if (activeSocket) activeSocket.close();

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ sessionKey });
  if (skipEventReplay) params.set("skipReplay", "1");
  const ws = new WebSocket(`${scheme}//${location.host}/ws?${params}`);
  activeSocket = ws;

  ws.addEventListener("message", (ev) => {
    // Guard against a stale socket: closing a WebSocket isn't instant, so a
    // just-superseded socket (from submitting a new message before the
    // previous run's socket finished closing) can still deliver a few
    // trailing "message" events. renderFrame()'s state (transcriptQueue,
    // lastTranscriptSnapshot, toolCallCards, etc.) is shared/global, not
    // scoped per-socket, so without this check those stale old-session
    // events would render into the freshly-reset UI for the NEW session -
    // this is what made the new response look like it was "disappearing
    // and reappearing" (old and new session content briefly interleaving).
    if (ws !== activeSocket) return;
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    renderFrame(frame);
  });

  // A "close" event always follows an "error" one for a WebSocket (per
  // spec) - the actual user-facing signal + cleanup happens there (see
  // wasClean below). Logged here only for debugging, matching
  // gatewayClient.js's own ws.on("error", ...) convention for the
  // upstream connection - fixed 2026-07-31 alongside the wasClean check
  // below (there was previously no listener of any kind for this event).
  ws.addEventListener("error", () => {
    console.error(`WS error for session ${sessionKey}`);
  });

  ws.addEventListener("close", (event) => {
    if (activeSocket === ws) {
      activeSocket = null;
      // Gated on currentSessionContinuable (see its own comment) - a
      // gateway-origin session's socket never actually opens (wsRelay.js
      // rejects the upgrade with 403), so this close fires almost
      // immediately and must NOT re-enable the composer the deliberate
      // disable in openHistoricalSession just set. For every other case
      // (a normal run's socket closing after it finishes) this stays a
      // harmless, idempotent re-enable alongside renderFrame's own
      // lifecycle-signal handling above.
      if (currentSessionContinuable) setComposerEnabled(true);
      // Fixed 2026-07-31: an unexpected drop (network blip, gateway
      // restart, dashboard process crash) while a run was still active
      // used to be indistinguishable from a normal end-of-run close - the
      // composer silently re-enabled with no indication anything went
      // wrong, and the run may still genuinely be in progress server-side.
      // event.wasClean is false for a connection that didn't go through a
      // normal closing handshake (per the WebSocket spec) - true for
      // openSocket()'s own explicit ws.close() when switching sessions, or
      // a normal tab/logout close, neither of which should show this.
      if (runIsActive && !event.wasClean) {
        runError.textContent =
          "Connection to the agent was lost. The run may still be in progress - reopen this conversation to check.";
        setHidden(runError, false);
      }
      stopRunStatus();
    }
  });
}

function startStream(repoKey, sessionKey) {
  sessionGeneration++; // invalidates any other in-flight continuation/history-load
  setHidden(conversationEmpty, true);
  transcriptHistory.innerHTML = "";
  resetLiveState();
  sessionKeyLabel.textContent = sessionKey;
  // Defensive, not load-bearing given today's callers - a brand-new run is
  // always continuable, and every path that reaches here already left
  // currentSessionContinuable true. Set explicitly anyway so this function
  // doesn't depend on caller ordering to stay correct.
  currentSessionContinuable = true;
  openSocket(sessionKey);
}

// Dedupes adjacent identical messages defensively - a known upstream bug
// (OpenClaw issue #2603) could duplicate a turn in chat.history's response
// under some conditions; reportedly fixed as of OpenClaw 2026.6.10, but
// that's this project's own test-suite comment, not independently
// verified against whatever build Server 6 actually runs. Cheap insurance
// either way.
function dedupeAdjacentMessages(messages) {
  const result = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.role === message.role &&
      JSON.stringify(prev.content) === JSON.stringify(message.content)
    ) {
      continue;
    }
    result.push(message);
  }
  return result;
}

// chat.history's response shape (see routes/sessions.js) is
// content:[{type:"text", text}|{type:"thinking", thinking}] - each type
// carries its string under a DIFFERENT field name, matching the live WS
// path's own `.text`/`.thinking` split (see extractFinalText/
// extractThinkingText below), not a shared `.text` field as this comment
// claimed until 2026-09-01. That original claim was reviewed/confirmed
// true on 2026-07-24 but had silently drifted false by the time of a
// live re-probe on 2026-09-01 (raw chat.history capture showed
// {"type":"thinking","thinking":"..."} not `.text`) - almost certainly
// during the 2026-08-10 OpenClaw 2026.6.10->2026.7.1 upgrade, though the
// exact version boundary wasn't pinned down. extractHistoryThinking
// below was reading `.text` on thinking parts this whole time and always
// got undefined, which is exactly why reasoning kept disappearing on
// refresh/session-switch even after the 2026-07-27 fix below shipped -
// reusing extractFinalText's field name is still wrong for a different
// reason now (it would work for thinking too, coincidentally, but the
// two extractors should stay separate since the fields could drift
// independently again).
function extractHistoryText(content) {
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((part) => part && part.type === "text" && typeof part.text === "string" && part.text)
    .map((part) => part.text);
  // Defends against a duplicate-content bug confirmed live 2026-07-24: a
  // single message's own content array can contain the exact same text
  // twice as separate adjacent parts (same root-cause class as the
  // adjacent-MESSAGE duplication OpenClaw issue #2603 already guards
  // against below in dedupeAdjacentMessages, just one level deeper) -
  // a real run showed a full multi-paragraph final report duplicated
  // back-to-back this way.
  const deduped = texts.filter((text, i) => text !== texts[i - 1]);
  // Joined with "" (not "\n\n") - confirmed live 2026-07-28 that a single
  // continuous final answer can arrive as several "text" parts with a
  // "thinking" part interleaved between them (the model briefly reasoning
  // again mid-response, not a real paragraph break): a real message split
  // "\n\n**" and "1. `pwd`**\n..." across two parts that concatenate
  // directly into correct markdown ("**1. `pwd`**") but rendered as
  // "**" on its own line followed by a stray, unpaired "**1. `pwd`**"
  // once "\n\n" was forced between them. Any real paragraph break the
  // model actually wrote is already present as literal "\n\n" characters
  // inside one of the parts themselves, so plain concatenation preserves
  // it without needing to inject one here - same as how the live path
  // already accumulates deltaText chunks with no separator of its own.
  return deduped.join("");
}

// Same chat.history shape as extractHistoryText (content:[{type,text}]),
// filtered for the other type instead - "thinking" was previously never
// replayed at all (kept v1-simple, per this function's old comment on
// renderHistoryReplay). Request 2026-07-27: replay it too, as its own
// inline block, same as live. NOTE 2026-09-01: that 2026-07-27 fix never
// actually worked - it read `.text` on thinking-type parts (per this
// file's now-corrected comment above extractHistoryText), which chat.
// history has apparently never actually used for thinking content; fixed
// to read `.thinking` instead, confirmed against a live raw capture.
function extractHistoryThinking(content) {
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((part) => part && part.type === "thinking" && typeof part.thinking === "string" && part.thinking)
    .map((part) => part.thinking);
  const deduped = texts.filter((text, i) => text !== texts[i - 1]);
  // See extractHistoryText's own comment just above - same fragment-
  // continuation risk applies here, same fix.
  return deduped.join("");
}

// Some tool round-trips show up in chat.history as their own separate
// "assistant" message whose entire text content is the tool invocation +
// result serialized as JSON (confirmed live 2026-07-24 from a real
// escalation-agent session) - not a distinct content-part type, just a
// literal JSON string masquerading as prose. Rendering that inline as a
// paragraph is exactly the "actual JSON content" clutter reported live;
// detected here and rendered as a collapsible tool-card instead (see
// buildHistoryToolCard), matching how the live session.tool path already
// renders real-time tool calls, and matching Claude Code's own convention
// of keeping tool invocations as distinct collapsed-by-default units
// rather than inline text.
//
// Two shapes confirmed so far - a successful call:
//   {"tool":{"id","name","label","description",...},
//    "result":{"content":[...], "details":{"status","exitCode",
//    "durationMs","aggregated","cwd",...}}}
// and a bare error:
//   {"status":"error","tool":"tool_call","error":"..."}
// A THIRD shape is prose-prefixed rather than pure JSON - "Validation
// failed for tool "X":\n\n<details>" - confirmed live 2026-07-24 as the
// same class of internal tool-call-plumbing noise as the two JSON shapes
// (the user specifically flagged this as remaining clutter), so it's
// matched separately (a regex, since it doesn't start with "{") and
// normalized into the same {status:"error", tool, error} shape the error
// card already knows how to render.
// Confirmed live 2026-07-28 against real chat.history data (session
// agent:svc-core-escalation:dashboard-1785216728847, message index 54):
// when a tool result's real output is large, the gateway/session store
// appends a truncation notice DIRECTLY onto the JSON's closing brace, with
// NO separator - e.g. `{"tool":{...},"result":{...}}[... 12020 more
// characters truncated; rerun with narrower args if needed]`. The JSON
// itself is still perfectly valid; only this suffix breaks the
// endsWith("}") check below. Stripped BEFORE that check (role-agnostic,
// same as the rest of this function) so the underlying record still
// parses; the matched notice is carried on the returned record as
// `truncationNote` so buildHistoryToolCard can surface it instead of
// silently swallowing the fact that output was cut off.
const TRUNCATION_NOTICE_RE = /\[\.\.\. \d+ more characters truncated; rerun with narrower args if needed\]\s*$/;

// Confirmed live 2026-07-28 (same message index 54 as TRUNCATION_NOTICE_RE
// above, separately from the truncation suffix): the stored JSON can ALSO
// contain a raw, unescaped control character (a literal newline/tab byte
// rather than the required "\n"/"\t" escape sequence) inside one of its
// string values - presumably from command output that wasn't escaped
// correctly wherever this record was originally serialized. JSON.parse
// rejects that outright ("Bad control character in string literal").
// Escapes only WITHIN quoted string literals (tracking string/escape state
// char-by-char) so pretty-printed structural whitespace (the real
// newlines between "tool": {\n  ...) is left alone - a blanket regex
// replace would corrupt that formatting and break parsing worse than it
// already is. This recovers the JSON shape when a stray control character
// is the ONLY defect; a message with additional, unrelated corruption can
// still fail JSON.parse afterward and falls through to the existing
// role==="toolResult" fallback in renderHistoryReplay same as before.
function sanitizeJsonControlChars(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = text.charCodeAt(i);
    if (code <= 0x1f) {
      switch (ch) {
        case "\n": out += "\\n"; break;
        case "\r": out += "\\r"; break;
        case "\t": out += "\\t"; break;
        case "\b": out += "\\b"; break;
        case "\f": out += "\\f"; break;
        default: out += "\\u" + code.toString(16).padStart(4, "0");
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function parseToolRecordFromText(text) {
  let trimmed = text.trim();

  // Stripped before EITHER shape below is matched (not just the JSON one) -
  // a truncated validation error is just as real as a truncated {tool,result}
  // dump, and without this the bracket suffix would land verbatim inside
  // validationMatch's own captured error text instead of becoming a clean
  // truncationNote.
  let truncationNote = null;
  const truncationMatch = trimmed.match(TRUNCATION_NOTICE_RE);
  if (truncationMatch) {
    truncationNote = truncationMatch[0];
    trimmed = trimmed.slice(0, truncationMatch.index).trim();
  }

  const validationMatch = trimmed.match(/^Validation failed for tool "([^"]+)":\s*([\s\S]*)$/);
  if (validationMatch) {
    const record = { status: "error", tool: validationMatch[1], error: validationMatch[2].trim() };
    return truncationNote ? { ...record, truncationNote } : record;
  }

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      parsed = JSON.parse(sanitizeJsonControlChars(trimmed));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.tool && parsed.result) return truncationNote ? { ...parsed, truncationNote } : parsed;
  if (parsed.status === "error") return truncationNote ? { ...parsed, truncationNote } : parsed;
  return null;
}

// Detects unified-diff-shaped output (git diff, `diff -u`, etc.) so it can
// be rendered with real red/green line coloring instead of plain text -
// matches Claude Code's/GitHub's own diff view, per request 2026-07-24.
function isDiffLikeOutput(text) {
  return /(^|\n)diff --git /.test(text) || /(^|\n)@@ -\d/.test(text);
}

// Builds a <pre> with one <span> per line, classed by the line's diff
// role - built via textContent per line (never innerHTML/string
// concatenation) so there's no HTML-escaping to get wrong on
// tool-output text that could contain literal "<"/"&"/etc.
function renderDiffPre(text) {
  const pre = document.createElement("pre");
  pre.className = "diff-output";
  for (const line of text.split("\n")) {
    const span = document.createElement("span");
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) {
      span.className = "diff-line diff-line-header";
    } else if (line.startsWith("@@")) {
      span.className = "diff-line diff-line-hunk";
    } else if (line.startsWith("+")) {
      span.className = "diff-line diff-line-add";
    } else if (line.startsWith("-")) {
      span.className = "diff-line diff-line-del";
    } else {
      span.className = "diff-line";
    }
    span.textContent = line;
    pre.appendChild(span);
  }
  return pre;
}

// Plain (non-diff) tool/command output - given its own color (distinct
// from the muted gray the rest of .tool-card-detail uses) so actual
// stdout reads more like a terminal, per request 2026-07-24 ("bash
// content should have a different color").
function renderPlainOutputPre(text) {
  const pre = document.createElement("pre");
  pre.className = "tool-output";
  pre.textContent = text;
  return pre;
}

function renderToolOutput(text) {
  return isDiffLikeOutput(text) ? renderDiffPre(text) : renderPlainOutputPre(text);
}

// Confirmed live 2026-07-28 (screenshot from the SAME session as the
// TRUNCATION_NOTICE_RE fix above): for heavily session-compacted messages,
// the entire output can BE this notice with no real content in front of
// it - the fallback path in renderHistoryReplay still surfaces it (better
// than a raw-text bubble), but showing the gateway's own internal wording
// ("rerun with narrower args if needed") verbatim inside a plain terminal-
// styled <pre>, as if it were real command output, reads as confusing
// clutter - not how Claude Code presents a truncated/unavailable tool
// result. Detected separately from TRUNCATION_NOTICE_RE (anchored at the
// START, not the end, and tolerant of the notice itself being cut off
// mid-sentence with no closing "]" - both shapes confirmed live) so it can
// be swapped for a short, human-readable placeholder instead.
const STUB_NOTICE_RE = /^\[\.\.\.\s*(\d+)\s*more characters?\s*truncated\b/i;

function buildHistoryToolCard(record, callInfo) {
  const card = document.createElement("details");
  card.className = "tool-card history-tool-card";

  const toolMeta = record.tool;
  const toolName =
    (toolMeta && typeof toolMeta === "object" && (toolMeta.name || toolMeta.label || toolMeta.id)) ||
    (typeof toolMeta === "string" ? toolMeta : null) ||
    "tool";
  const status =
    (record.result &&
      record.result.details &&
      typeof record.result.details.status === "string" &&
      record.result.details.status) ||
    (typeof record.status === "string" && record.status) ||
    "unknown";
  card.classList.add(`state-${status}`);

  const summary = document.createElement("summary");
  summary.textContent = "Ran a command";
  card.appendChild(summary);

  const detail = document.createElement("div");
  detail.className = "tool-card-detail";
  // Prefer the real command, recovered from the calling assistant message via
  // buildToolCallIndex - the toolResult itself genuinely has no command field,
  // which is why this used to render a bare "$ exec" while the live view
  // showed the actual command line for the very same call.
  //
  // callInfo.tool is also better than toolName here: the toolResult names the
  // generic "tool_call" wrapper, while the call site records the tool that
  // really ran ("exec"). Falls back to the old behaviour for anything with no
  // command (tool_search and friends) rather than inventing one.
  const commandEl = document.createElement("div");
  commandEl.className = "tool-command";
  // Precedence matters: the record's own tool name beats the call site's,
  // because the call site records the generic "tool_call" wrapper while the
  // record names what really ran. Getting this backwards rendered "$ tool_call"
  // where the old code had correctly said "$ exec".
  const commandLabel =
    (callInfo && callInfo.command) ||
    (toolName !== "tool" && toolName) ||
    (callInfo && callInfo.tool) ||
    toolName;
  commandEl.textContent = `$ ${commandLabel}`;
  detail.appendChild(commandEl);
  const output =
    (record.result && record.result.details && record.result.details.aggregated) ||
    (record.result && Array.isArray(record.result.content) && extractHistoryText(record.result.content)) ||
    (typeof record.error === "string" && record.error) ||
    "";
  const stubMatch = output && output.trim().match(STUB_NOTICE_RE);
  if (stubMatch) {
    const stub = document.createElement("div");
    stub.className = "tool-output-waiting";
    stub.textContent = `(output no longer available - ${stubMatch[1]} characters were truncated)`;
    detail.appendChild(stub);
  } else if (output) {
    detail.appendChild(renderToolOutput(output));
  } else {
    const noOutput = document.createElement("div");
    noOutput.className = "tool-output-waiting";
    noOutput.textContent = "(no output)";
    detail.appendChild(noOutput);
  }
  // Confirmed live 2026-07-28: record.truncationNote (see
  // parseToolRecordFromText's TRUNCATION_NOTICE_RE strip) means the
  // output above, however much of it there is, isn't the FULL story -
  // the gateway itself cut it off. Derived from the notice's own wording
  // rather than hardcoded, since only the character count varies.
  if (record.truncationNote) {
    const countMatch = record.truncationNote.match(/\[\.\.\. (\d+) more characters/);
    const truncated = document.createElement("div");
    truncated.className = "tool-output-waiting";
    truncated.textContent = countMatch
      ? `(output truncated - ${countMatch[1]} more characters not shown)`
      : "(output truncated)";
    detail.appendChild(truncated);
  }
  card.appendChild(detail);

  return card;
}

// One-shot static render of a past conversation's full history (as opposed
// to the live reveal-queue path, which animates incremental deltas) - the
// full text is already known upfront, so there's nothing to trickle in.
// Tool round-trips serialized as JSON text (see parseToolRecordFromText)
// render as collapsible cards, and thinking content as collapsible
// "Thinking" blocks (see buildThinkingGroup), both inline in the same
// chronological order as the surrounding prose turns - matching Claude
// Code's own convention of tool calls/reasoning appearing as distinct
// collapsed-by-default units within the conversation flow, not a wall of
// JSON or one block pinned to the top. Request 2026-07-27: previously
// thinking was "kept v1-simple" and never replayed here at all, which is
// why it disappeared entirely on refresh/session-switch.
// --- Compaction notes -------------------------------------------------
//
// chat.history represents a context compaction as a message with
// role:"system" and the literal text "Compaction", discriminated by
// __openclaw.kind === "compaction" (confirmed live 2026-08-10). It is NOT
// something the agent said, but the generic role fallback at the bottom of
// renderHistoryReplay maps every non-user role to "assistant" - so it used to
// render as an Agent bubble containing the single word "Compaction", which
// read as the agent having stopped and said something cryptic. That is exactly
// how it was first reported.
//
// Rendered instead as a system note that says what happened in plain words,
// expandable to the summary the agent actually carried forward (fetched from
// /api/sessions/compaction, which is why the sessionKey is threaded in here).
function isCompactionMessage(message) {
  return Boolean(message && message.__openclaw && message.__openclaw.kind === "compaction");
}

function buildCompactionNote(index, sessionKey) {
  const note = document.createElement("div");
  note.className = "compaction-note";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "compaction-note-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML =
    '<span class="compaction-note-caret" aria-hidden="true"></span>' +
    '<span class="compaction-note-label">Context compacted</span>' +
    '<span class="compaction-note-hint">earlier turns replaced by a summary \u00b7 not an agent message</span>';
  note.appendChild(toggle);

  const body = document.createElement("div");
  body.className = "compaction-note-body";
  setHidden(body, true);
  note.appendChild(body);

  let loaded = false;
  toggle.addEventListener("click", async () => {
    const nowOpen = body.hidden;
    setHidden(body, !nowOpen);
    toggle.setAttribute("aria-expanded", String(nowOpen));
    note.classList.toggle("open", nowOpen);
    if (!nowOpen || loaded) return;
    loaded = true;
    body.textContent = "Loading\u2026";
    try {
      const res = await fetch(`/api/sessions/compaction?key=${encodeURIComponent(sessionKey)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed to load compaction detail");
      // Paired by chronological order, NOT by id - the message's
      // __openclaw.id and the checkpoint's checkpointId are different
      // namespaces and never match. See routes/sessions.js.
      const checkpoint = (data.checkpoints || [])[index];
      if (!checkpoint) {
        body.textContent = "No summary recorded for this compaction.";
        return;
      }
      body.innerHTML = "";
      const meta = document.createElement("div");
      meta.className = "compaction-note-meta";
      const when = checkpoint.createdAt ? new Date(checkpoint.createdAt).toLocaleString() : "unknown time";
      meta.textContent = `${when} \u00b7 ${checkpoint.reason || "automatic"}`;
      body.appendChild(meta);
      const pre = document.createElement("pre");
      pre.className = "compaction-note-summary";
      pre.textContent = checkpoint.summary || "(empty summary)";
      body.appendChild(pre);
    } catch (err) {
      body.textContent = err.message;
    }
  });

  return note;
}

// Builds toolCallId -> { tool, command } from a chat.history payload.
//
// The command a history tool card should show is NOT on the toolResult message
// (its details carry only cwd/exitCode/duration/tail - verified across 34 real
// records). It lives on the ASSISTANT message that made the call, as a
// content part of type "toolCall", and the toolResult's own toolCallId is the
// join key. Before this, history cards fell back to the tool name and every
// exec rendered as a bare "$ exec" while the live view showed the real command
// for the same call.
//
// Two arg shapes, same as the live path (see renderToolCard): the generic
// "tool_call" wrapper nests as arguments.args.command and names the real tool
// in arguments.id, while a direct call puts it at arguments.command. Tools
// with no command at all (tool_search and friends) resolve to just a name.
//
// user-role messages arrive with content as a plain STRING rather than an
// array, so the type guard is load-bearing, not defensive noise.
// Greedy to the last quote before the trailing sibling key or the closing
// brace, because the unescaped quotes are always inside the command VALUE.
const MALFORMED_COMMAND_RE = /"command"\s*:\s*"([\s\S]*)"\s*(?:,\s*"[a-zA-Z_]+"\s*:|\}\s*$)/;

function buildToolCallIndex(messages) {
  const index = new Map();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || part.type !== "toolCall" || !part.id) continue;
      // Either level can arrive JSON-ENCODED rather than as an object -
      // measured against a real session: .arguments was an object 29/29 times
      // but .arguments.args was a string in 2 of 29. Reading .command off a
      // string yields undefined rather than throwing, so the miss is silent:
      // those cards just quietly fell back to the tool name. Decode both
      // levels defensively rather than trusting either shape.
      const asObject = (v) => {
        if (v && typeof v === "object") return v;
        if (typeof v === "string") {
          try {
            const parsed = JSON.parse(v);
            return parsed && typeof parsed === "object" ? parsed : {};
          } catch {
            return {};
          }
        }
        return {};
      };
      const args = asObject(part.arguments);
      const inner = asObject(args.args);
      let command =
        (typeof args.command === "string" && args.command) ||
        (typeof inner.command === "string" && inner.command) ||
        "";
      // Last resort: the model sometimes emits args as a JSON string whose
      // inner quotes it failed to escape, e.g. a `gh pr create --title "..."`
      // ending `...no issues found."", "timeout": 30000}`. That is genuinely
      // invalid JSON, so JSON.parse above is right to reject it - but the
      // command itself is perfectly readable, and falling back to "$ exec"
      // for exactly the long interesting commands is the worst outcome.
      // Recovers 2 of 29 calls in the session this was measured against.
      if (!command && typeof args.args === "string") {
        const salvaged = args.args.match(MALFORMED_COMMAND_RE);
        if (salvaged) command = salvaged[1];
      }
      index.set(part.id, {
        tool: (typeof args.id === "string" && args.id) || part.name || "tool",
        command,
      });
    }
  }
  return index;
}

// A run that ended without the agent ever replying.
//
// chat.history marks these with stopReason:"error" and substitutes OpenClaw's
// own fallback sentence for the (empty) content. Rendered as an ordinary Agent
// bubble it reads as the agent having said something cryptic, when in fact no
// model turn happened at all - the same category of confusion as the bare
// "Compaction" marker.
//
// Detected on stopReason rather than by matching that sentence: the text is
// display copy that can change or be localised, while stopReason is structural.
// Verified against a real failed run - the transcript's own assistant entry has
// stopReason=error with zero-length content and no error field, so there is
// genuinely no cause recorded to show. Hence "most likely" rather than a claim.
function isFailedRunMessage(message) {
  return Boolean(message && message.role === "assistant" && message.stopReason === "error");
}

function buildFailedRunNote(message) {
  const note = document.createElement("div");
  note.className = "run-failed-note";

  const title = document.createElement("div");
  title.className = "run-failed-title";
  title.textContent = "Run failed — no reply produced";
  note.appendChild(title);

  const body = document.createElement("div");
  body.className = "run-failed-body";
  // No cause is recorded on the message, so this says what it can defend and
  // points at the surface that does know: the model-backend banner.
  body.textContent =
    "The agent was given this work but the run ended before any model turn completed. " +
    "The usual cause is the inference backend being unreachable — check the model-backend " +
    "banner at the top of the dashboard, and the watcher log for a deferral notice.";
  note.appendChild(body);

  if (message.timestamp) {
    const when = document.createElement("div");
    when.className = "run-failed-when";
    when.textContent = new Date(message.timestamp).toLocaleString();
    when.title = "Compare against when the backend was down to confirm the cause.";
    note.appendChild(when);
  }
  return note;
}

function renderHistoryReplay(messages, sessionKey) {
  transcriptHistory.innerHTML = "";
  const deduped = dedupeAdjacentMessages(messages);
  // Built from the FULL message list, not the deduped one - a dropped
  // duplicate could be the very assistant message carrying the call args.
  const toolCallIndex = buildToolCallIndex(messages);
  // Local to this one replay pass (not the live path's module-level
  // currentToolGroup/currentThinkingGroup) - groups consecutive tool
  // records/thinking segments the same way the live path does, so a
  // replayed conversation reads identically to watching it live.
  let historyToolGroup = null;
  let compactionIndex = 0;
  for (const message of deduped) {
    // Before every other branch: a compaction is not a turn, not a tool
    // record, and must never fall through to the assistant fallback.
    if (isCompactionMessage(message)) {
      historyToolGroup = null;
      transcriptHistory.appendChild(buildCompactionNote(compactionIndex, sessionKey));
      compactionIndex += 1;
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];

    const thinking = extractHistoryThinking(content);
    if (thinking) {
      // A reasoning segment starting is as much a tool-group boundary
      // here as it is live (see renderToolCard's closeThinkingGroup call)
      // - whatever tool calls preceded it are done.
      historyToolGroup = null;
      const thinkingGroup = buildThinkingGroup();
      thinkingGroup.querySelector(".thinking-body").innerHTML = renderMarkdownToSafeHtml(thinking);
      transcriptHistory.appendChild(thinkingGroup);
    }

    const text = extractHistoryText(content);

    // Confirmed live 2026-07-28: chat.history messages with role:"toolResult"
    // must ALWAYS become a tool card, never a raw-text chat bubble -
    // handled explicitly (before the generic parse-arbitrary-text branch
    // below and the assistant/user fallback) rather than relying entirely
    // on the text happening to parse as {tool,result} JSON. Two confirmed
    // failure shapes for that text: (1) valid JSON with a truncation-notice
    // suffix appended directly onto the closing brace (now stripped and
    // recovered by parseToolRecordFromText itself, see its own comment), and
    // (2) for heavily session-compacted older messages, the text is shrunk
    // to just a short truncation-notice STUB with no JSON at all (sometimes
    // cut off mid-sentence, e.g. a lone 69-char fragment) - unparseable by
    // design, no amount of stripping recovers a record from it. Rather than
    // chase every possible unparseable shape, this falls back to the
    // message's own reliable sibling fields (toolName/toolCallId/isError -
    // present on every toolResult message regardless of what its text
    // payload looks like) so the card still renders, with the raw text (if
    // any) shown as its output.
    if (message.role === "toolResult") {
      if (!historyToolGroup) {
        historyToolGroup = buildToolGroup();
        transcriptHistory.appendChild(historyToolGroup);
      }
      const parsedRecord = text ? parseToolRecordFromText(text) : null;
      const record = parsedRecord || {
        tool: message.toolName || "tool",
        status: message.isError ? "error" : "unknown",
        error: text || "",
      };
      appendCardToGroup(
        historyToolGroup,
        buildHistoryToolCard(record, toolCallIndex.get(message.toolCallId)),
      );
      continue;
    }

    // Before the generic text branch: this message DOES carry text (OpenClaw
    // substitutes its own fallback sentence), so left alone it renders as the
    // agent speaking.
    if (isFailedRunMessage(message)) {
      historyToolGroup = null;
      transcriptHistory.appendChild(buildFailedRunNote(message));
      continue;
    }

    if (!text) continue;

    const toolRecord = parseToolRecordFromText(text);
    if (toolRecord) {
      if (!historyToolGroup) {
        historyToolGroup = buildToolGroup();
        transcriptHistory.appendChild(historyToolGroup);
      }
      appendCardToGroup(historyToolGroup, buildHistoryToolCard(toolRecord));
      continue;
    }
    historyToolGroup = null;

    const role = message.role === "user" ? "user" : "assistant";
    const body = appendChatTurn(transcriptHistory, role);
    body.innerHTML = renderMarkdownToSafeHtml(text);
  }
  // #transcript itself has no overflow/height constraint - #conversation
  // is the actual scrolling ancestor (style.css). Reviewed 2026-07-24:
  // scrolling #transcript here was a silent no-op. Deliberately
  // unconditional (not stickToBottom) - opening a past conversation is a
  // one-time explicit action (like sending a message), not passive
  // streaming, so landing on its latest content is expected here.
  conversation.scrollTop = conversation.scrollHeight;
}

// Clicking a Recents entry: replay its full past history (fetched fresh
// from the Gateway via chat.history - nothing about it is cached locally,
// see routes/sessions.js), then re-open a live subscription on the same
// sessionKey so anything still active keeps streaming in, and so a
// follow-up message (see the composer submit handler's
// continuingSameSession check) correctly continues THIS conversation
// rather than starting a new one.
async function openHistoricalSession(entry) {
  // This click is now the authoritative navigation - bump first so any
  // OTHER in-flight async work (a previous click here, or a follow-up
  // POST from composer submit) detects it's been superseded.
  const myGeneration = ++sessionGeneration;

  if (activeSocket) activeSocket.close();
  activeSocket = null;
  currentSessionRepoKey = entry.repoKey;
  refreshSessionDecision(entry.repoKey);

  repoSelect.value = entry.repoKey;
  renderRepoMeta();

  resetLiveState();
  sessionKeyLabel.textContent = entry.sessionKey;
  setHidden(runError, true);
  setHidden(conversationEmpty, true);
  transcriptHistory.innerHTML = '<p class="history-loading">Loading history…</p>';
  // Clicking a Recents entry is reachable even while a previous run is
  // still in flight (unlike the composer's own inputs, the sidebar isn't
  // gated by setComposerEnabled) - without this, navigating away mid-run
  // would leave the composer stuck disabled and the timer stuck running
  // for a run this view no longer has any connection to.
  setComposerEnabled(true);
  // A gateway-origin session (watcher, xref handoff, manual-* invocation,
  // or a reviewer second-opinion - see remoteSessions.js) was never
  // started through this dashboard's own composer, and routes/run.js's
  // POST /api/run hardcodes escalation-only + a `dashboard-<epoch>`
  // sessionKey suffix for any continuation - so a follow-up sent into one
  // of these would just 400 with a raw "sessionKey does not match
  // repoKey" error. entry.origin is already known synchronously here (no
  // need to wait on the async history fetch below) so the composer can be
  // disabled with a clear explanation up front instead of letting the
  // user discover this the hard way after typing a message. Normal
  // dashboard-origin sessions (the `else` branch) restore the captured
  // default placeholder, in case a PREVIOUS gateway-origin view left it
  // changed.
  if (entry.origin === "gateway") {
    currentSessionContinuable = false;
    setComposerEnabled(false);
    messageInput.placeholder = "This session started outside the dashboard and can't be continued here";
  } else {
    currentSessionContinuable = true;
    messageInput.placeholder = DEFAULT_MESSAGE_PLACEHOLDER;
  }
  // Paired with the branch above, not with the history load below - it keys
  // off the same synchronously-known entry.origin, so the one reply that IS
  // sendable here appears at the same moment the composer says it isn't.
  updateAgentReplyActions(entry);
  stopRunStatus();
  renderRecents();

  try {
    const res = await fetch(`/api/sessions/history?key=${encodeURIComponent(entry.sessionKey)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed to load history");
    // A second, later click (or a "+ New task") superseded this one while
    // the fetch was in flight - don't render a stale replay over it.
    if (myGeneration !== sessionGeneration) return;
    renderHistoryReplay(data.messages || [], entry.sessionKey);
  } catch (err) {
    if (myGeneration !== sessionGeneration) return;
    transcriptHistory.innerHTML = "";
    runError.textContent = err.message;
    setHidden(runError, false);
  }

  if (myGeneration !== sessionGeneration) return;
  openSocket(entry.sessionKey, { skipEventReplay: true });
}

// Mirrors NemoClaw's own textFromContent() test helper - content is an
// array of parts, each with either a .thinking field (reasoning) or a
// .text field (final response), same shape as Anthropic's Messages API
// content blocks. Joined with a blank line between parts - a bare ""
// join was the cause of sentences/paragraphs visibly running together
// with no space, since each array entry is its own paragraph-ish chunk,
// not a pre-joined string.
function extractThinkingText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part.thinking === "string" && part.thinking)
    .map((part) => part.thinking)
    .join("\n\n");
}

function extractFinalText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part.text === "string" && part.text)
    .map((part) => part.text)
    .join("\n\n");
}

// Confirmed live 2026-07-24 against a real gateway run: there is no
// distinct "session.tool" event at all - it was an unconfirmed guess that
// never matched reality, so this card silently never rendered anything
// for any real run despite the rest of the live stream working
// correctly. Tool-call lifecycle actually arrives as an "agent" event
// with payload.stream === "tool" (see renderFrame's "agent" branch),
// payload.data carrying {phase:"start", name, toolCallId, args} then
// {phase:"result", name, toolCallId, isError, result:{content, details}}
// - that {content, details} shape is the exact same one chat.history's
// own tool round-trips use (see parseToolRecordFromText/
// buildHistoryToolCard below), so renderToolOutput/extractHistoryText are
// reused here too rather than re-inventing formatting - live and replay
// tool cards render identically.
// Wraps consecutive tool cards (no narration text between them) in one
// collapsible "Ran N commands" group, matching Claude Code's own
// transcript convention (screenshot provided 2026-07-27) - individual
// commands stay individually expandable inside it, revealing the actual
// command (colored) and its output (muted) only once opened. Shared by
// the live path (renderToolCard) and history replay (renderHistoryReplay)
// so a past conversation groups its tool calls exactly the same way a
// live one does.
function buildToolGroup() {
  const group = document.createElement("details");
  group.className = "tool-group";
  group.appendChild(document.createElement("summary"));
  const body = document.createElement("div");
  body.className = "tool-group-body";
  group.appendChild(body);
  group.dataset.count = "0";
  updateToolGroupSummary(group);
  return group;
}

function updateToolGroupSummary(group) {
  const count = Number(group.dataset.count || "0");
  group.querySelector(":scope > summary").textContent =
    count === 1 ? "Ran a command" : `Ran ${count} commands`;
}

function appendCardToGroup(group, card) {
  group.querySelector(".tool-group-body").appendChild(card);
  group.dataset.count = String(Number(group.dataset.count) + 1);
  updateToolGroupSummary(group);
  updateSoleCardExpand(group);
}

// A group holding exactly one command has nothing left for its own
// nested <details> to usefully toggle independently of the outer
// group's - requested 2026-07-28: clicking "Ran a command" once should
// show the command directly, not require a second click on a redundant
// inner "Ran a command" summary that only ever holds the one thing the
// outer summary already just revealed. Force-opens the sole card and
// hides its own (now purely redundant) summary; reverts BOTH the instant
// a second command joins the SAME still-open group (a run can grow from
// 1 command to several while still streaming), restoring the normal
// individually-collapsible behavior for every card in the group,
// including the first - matching the request's own "when 2 or more...
// that's fine as how it is right now".
function updateSoleCardExpand(group) {
  const cards = group.querySelectorAll(":scope > .tool-group-body > .tool-card");
  const solo = cards.length === 1;
  for (const card of cards) {
    card.open = solo;
    card.classList.toggle("tool-card-solo", solo);
    const summary = card.querySelector(":scope > summary");
    if (summary) setHidden(summary, solo);
  }
}

// Closes the live path's currently-open tool group - called the moment
// real narration text becomes visible (see startAssistantTurn's
// pendingAttach) or a new user turn starts (appendUserTurn). Either one
// is an unambiguous signal that whatever tool calls come next are not
// part of the same uninterrupted run of commands as whatever came
// before, so they need their own fresh group instead of silently joining
// the old one - directly what was requested 2026-07-27: "ensure they're
// joined together strictly only when several calls are done in order -
// if normal text is outputted and another call is done, that gets its
// own separate block."
function closeToolGroup() {
  currentToolGroup = null;
}

// Inline collapsible "Thinking" block - the same .tool-group convention
// as "Ran N commands" (per request 2026-07-27: "it can be the same as
// 'Ran N commands', but 'Thinking...' instead"), so a run's reasoning
// interleaves with its narration and tool calls in actual chronological
// order instead of accumulating forever in one block pinned to the top
// of the conversation. Reuses .tool-group/.tool-group-body for the box/
// indentation, plus .thinking-group/.thinking-body for the muted,
// markdown-typed content (see style.css). No count in the summary (unlike
// tool groups) - reasoning isn't a discrete, countable list of items the
// way commands are.
function buildThinkingGroup() {
  const group = document.createElement("details");
  group.className = "tool-group thinking-group";
  const summary = document.createElement("summary");
  summary.textContent = "Thinking";
  group.appendChild(summary);
  const body = document.createElement("div");
  body.className = "tool-group-body thinking-body";
  group.appendChild(body);
  return group;
}

// Closes the live path's currently-open thinking group - called at
// exactly the same boundaries as closeToolGroup (narration becoming
// visible, a new user turn, a new tool call starting - see renderToolCard
// below) since a reasoning segment always precedes exactly one of those,
// never spans across one.
function closeThinkingGroup() {
  currentThinkingGroup = null;
}

// 0731: skips the generic "tool_call" wrapper entirely - confirmed live
// against a real gateway run that EVERY real tool invocation actually
// arrives as TWO separate "tool" stream events sharing no toolCallId:
// the wrapper itself (name:"tool_call", args:{id:"exec", args:{command,
// ...}}) AND a second, specifically-named one for the real underlying
// tool (name:"exec", args:{command, ...} - one level shallower, no
// wrapper's own args.id/args.args nesting). Both get their own separate
// card under the current toolCallId-keyed lookup below, since their
// toolCallIds differ - but the wrapper's own "result" phase re-echoes the
// REAL tool's full {tool, result} payload as a JSON-stringified TEXT
// blob in result.content[0].text (there is no result.details.aggregated
// on the wrapper's own result, so the output-extraction below falls
// through to that raw JSON text) - reported live: this showed up as a
// second, redundant card whose only visible content was a garbled JSON
// dump starting with the tool's own internal id ("openclaw:core:exec"),
// alongside the real card's clean output. Skipping the wrapper
// altogether removes the duplicate AND the garbled dump in one step,
// leaving exactly one card per real tool call - matching what
// buildHistoryToolCard already shows for the exact same interaction from
// chat.history (which never surfaces this wrapper artifact at all).
function renderToolCard(data) {
  if (data.name === "tool_call") return;
  // Captured before any of this function's DOM mutations - see
  // isScrolledNearBottom's own comment for why the order matters.
  const conversationWasNearBottom = isScrolledNearBottom(conversation);
  const id = data.toolCallId || `unknown-${toolCallSeq++}`;
  let card = toolCallCards.get(id);
  if (!card) {
    // Appended directly into the live transcript flow, at whatever point
    // in time this tool call actually started - NOT a separate
    // end-of-conversation list (that was the bug: every tool call across
    // the whole run ended up visually grouped at the bottom regardless of
    // when it happened, reported live 2026-07-27 against a real run with
    // many interleaved tool calls). Mirrors exactly how renderHistoryReplay
    // already does this correctly for past conversations (buildHistoryToolCard
    // appended inline into transcriptHistory in call order) - the live path
    // just never got the same treatment. Plain appendChild here means DOM
    // order = arrival order = chronological order, same guarantee
    // appendChatTurn already relies on for chat bubbles.
    if (!currentToolGroup) {
      currentToolGroup = buildToolGroup();
      transcriptLive.appendChild(currentToolGroup);
    }
    // A tool call starting is as unambiguous a thinking-group boundary as
    // narration becoming visible is - the reasoning that led to THIS call
    // is done; any later reasoning (before the next narration/tool call)
    // is a new segment and gets its own fresh block.
    closeThinkingGroup();
    card = document.createElement("details");
    card.className = "tool-card";
    const summary = document.createElement("summary");
    summary.textContent = "Ran a command";
    card.appendChild(summary);
    const detail = document.createElement("div");
    detail.className = "tool-card-detail";
    card.appendChild(detail);
    appendCardToGroup(currentToolGroup, card);
    toolCallCards.set(id, card);
  }

  // Real underlying tool calls (e.g. name:"exec", now that the generic
  // "tool_call" wrapper is skipped above) carry their command one level
  // shallower - args.command - than the wrapper's own args.args.command
  // nesting the original version of this check was written against.
  // Trying the shallow shape first, with the deeper one kept as a
  // fallback in case some other real tool still nests this way, covers
  // both without needing to special-case by tool name.
  //
  // Cached on the card itself (card.dataset.command) rather than only
  // ever read fresh from this call's own data - confirmed live against a
  // real run that the "result" phase event carries no args field at all
  // (only "start"/"update" do), and this function rebuilds the whole
  // detail pane from scratch (detail.innerHTML = "" below) on every
  // phase update to the SAME card. Without caching, a card's command
  // line - correctly shown while "start"/"update" was the most recent
  // phase - silently vanished the instant its own "result" arrived,
  // since that update had nothing to re-derive it from.
  const command =
    (data.args && typeof data.args.command === "string" && data.args.command) ||
    (data.args && data.args.args && typeof data.args.args.command === "string" && data.args.args.command) ||
    card.dataset.command ||
    null;
  if (command) card.dataset.command = command;
  const state = data.phase === "result" ? (data.isError ? "error" : "completed") : "running";
  card.className = `tool-card state-${state}`;
  // The line above replaces the WHOLE class string, including whatever
  // updateSoleCardExpand set earlier (appendCardToGroup only runs once,
  // when this card is first created on its "start" phase - this same
  // card's LATER "result" phase update, and every "running" state change
  // in between, both reach this exact line too) - confirmed live
  // 2026-07-28: a solo card's own tool-card-solo class was silently wiped
  // the moment its "result" phase arrived. Re-deriving from the group's
  // actual current card count is idempotent and cheap, so just re-run it
  // rather than trying to preserve one specific class through a full
  // className replace.
  updateSoleCardExpand(card.closest(".tool-group"));

  const detail = card.querySelector(".tool-card-detail");
  detail.innerHTML = "";
  // The command itself, shown distinctly colored ($ prefix, terminal-like
  // color) ABOVE the muted output - per request 2026-07-27, both should
  // be visible once expanded, not one-or-the-other like before.
  if (command) {
    const commandEl = document.createElement("div");
    commandEl.className = "tool-command";
    commandEl.textContent = `$ ${command}`;
    detail.appendChild(commandEl);
  } else if (data.itemLabel) {
    // Not every tool IS a shell command. Confirmed live 2026-08-06 by
    // capturing a real CLI run: a `read` call carries no command anywhere,
    // only the gateway's own human-readable title ("read from
    // /etc/hostname"). Rendering that through the `$ `-prefixed
    // .tool-command path above would claim a shell command was run that
    // never was, so it gets the neutral .tool-card-field treatment
    // buildHistoryToolCard already uses for non-command metadata.
    const labelEl = document.createElement("div");
    labelEl.className = "tool-card-field";
    labelEl.textContent = data.itemLabel;
    detail.appendChild(labelEl);
  }
  const output =
    (data.result && data.result.details && data.result.details.aggregated) ||
    (data.result && Array.isArray(data.result.content) && extractHistoryText(data.result.content)) ||
    (data.result && data.result.details && typeof data.result.details.error === "string" && data.result.details.error) ||
    "";
  if (output) {
    detail.appendChild(renderToolOutput(output));
  } else {
    const waiting = document.createElement("div");
    waiting.className = "tool-output-waiting";
    // "waiting" is only true while the call is actually still running.
    // A finished call with no output is a different, permanent state, and
    // saying "waiting" there left a completed card looking hung forever -
    // visible on any tool that genuinely produces no output (confirmed
    // 2026-08-06: a `read` call's end event carries no output field at
    // all). Applies to both event paths, not just the item-stream one.
    waiting.textContent = state === "running" ? "(waiting for output…)" : "(no output captured)";
    detail.appendChild(waiting);
  }

  // Every other content-adding path (createRevealQueue's render(),
  // appendChatTurn, renderHistoryReplay) keeps the view pinned to the
  // bottom as new content arrives - this one never did, which is why a
  // tool call landing mid-run could leave the view scrolled up with new
  // content arriving out of sight below the fold. Sticky (not
  // unconditional) since 2026-07-27 - see stickToBottom's own comment.
  stickToBottom(conversation, conversationWasNearBottom);
}

// --- Item-stream tool cards (CLI/cron-triggered runs) ------------------
//
// A run started from the dashboard goes through chat.send and emits
// stream:"tool" events, which renderToolCard above handles. A run started
// by a watcher cron does NOT: it's a one-shot
// `openclaw agent --agent X --session-key Y --message Z` (see
// templates/watcher-k8s.sh.tmpl), and that path emits a completely
// different event set. Live capture 2026-08-06 of a real CLI run, three
// tool calls, confirmed ZERO stream:"tool" events - so live-viewing a
// still-running cron escalation from Recents showed no tool cards at all,
// not even wrong ones. Everything below is written against that capture
// rather than inferred; the exact shapes are:
//
//   stream:"item", kind:"tool", name:"tool_call"   generic wrapper, skip
//   stream:"item", kind:"tool", name:"exec"|"read" the REAL tool call
//   stream:"item", kind:"command", name:"exec"     exec-only DUPLICATE of
//                                                  the above, same
//                                                  toolCallId - skip, or
//                                                  every exec renders twice
//   stream:"command_output"                        exec-only, carries the
//                                                  actual output/exitCode
//
// phase is "start"|"update"|"end" (not the "result" the stream:"tool"
// path uses) and status is "running"|"completed"|"failed" - all three
// observed live, "failed" via a deliberately failing command, which also
// puts the message in data.error.
//
// The arguments are the awkward part: the real tool's own events never
// carry them. They arrive separately on a session.message frame as a
// content part {type:"toolCall", id, arguments:{id, args:{...}}}, where
// that `id` is the WRAPPER's toolCallId and appears as a colon-delimited
// segment inside the real tool's id
// (tool_search_code:<wrapper-id>:exec:1). Verified 4/4 across two
// captures and two different tools. That frame always arrives BEFORE the
// tool's own start event, so a plain lookup is enough - no back-patching.
// The decision logic itself lives in public/itemToolEvents.js (loaded by
// index.html before this file) - it is entirely DOM-free, and keeping it
// separate lets test/itemToolEvents.test.js replay real captured gateway
// frames through the exact code the browser runs. These two wrappers are
// only the DOM half: normalise, then hand off to renderToolCard so
// grouping, sole-card expansion, scroll-stickiness and thinking-group
// boundaries all stay in one implementation rather than drifting across
// two.
function renderItemToolCard(data) {
  const normalized = normalizeItemToolEvent(itemToolArgs, data);
  if (normalized) renderToolCard(normalized);
}

function applyItemCommandOutput(data) {
  const normalized = normalizeCommandOutput(data);
  if (normalized) renderToolCard(normalized);
}

// --- Inline completion note (replaces the top-of-chatroom banner) ---
// When a run reaches a terminal state (completed/failed/aborted), instead
// of stamping "agent <status>" onto #status-banner, we append a single
// <p> directly after the agent's final output inside #transcript-live,
// reading a live-updating relative time ("5 mins ago" -> "1 hour ago" ->
// "yesterday" -> "Aug 2" -> "Aug 2 2025"). The kind (completed/failed/
// aborted) is conveyed by the note's color (state-* class), not its
// text, which is deliberately just the relative time per the request.
// Errored runs (lifecycle phase:"error" / dashboard.error) stay on the
// banner instead - they're urgent and may have no final output to anchor
// the inline note after.
let completionNoteEl = null;
let completionNoteTimer = null;
let completionNoteTime = 0;

// Progressive-granularity formatter for the completion note: "just now"
// -> "X mins ago" -> "X hours ago" -> "yesterday" -> "Aug 2" (same year)
// -> "Aug 2 2025" (prior year). Refreshes on a 60s interval so it ticks
// over correctly at each boundary.
function formatRelativeTime(timestamp) {
  const then = new Date(timestamp);
  const now = new Date();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    return `${m} ${m === 1 ? "min" : "mins"} ago`;
  }
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  }
  const prevDay = new Date(now);
  prevDay.setDate(now.getDate() - 1);
  if (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === prevDay.getMonth() &&
    then.getDate() === prevDay.getDate()
  ) {
    return "yesterday";
  }
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString(navigator.language || "en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return then.toLocaleDateString(navigator.language || "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Where the note belongs: inside the final assistant TURN, immediately
// after its body, so it reads as the next line after the agent's last line
// rather than as a separate block below the turn (2026-08-06). It used to
// be appended to #transcript-live as a sibling of the turn, which had a
// side effect that looked deliberate but wasn't: `.chat-turn:last-child`
// is what strips a turn's bottom border, so a note appended after the
// final turn stopped that rule from matching and drew a full-width
// divider between the output and its own timestamp.
//
// Inside the turn but NOT inside `.chat-turn-body`, which is the one
// placement that looks more natural and cannot work: createRevealQueue's
// render() does `el.innerHTML = ...` on that body on every tick, so
// anything parented to it is destroyed by the next chunk of streamed text.
// Caught live - a follow-on turn after completion left the body correctly
// marked and the note itself silently gone. As a sibling of the body it is
// outside that innerHTML rewrite, still a descendant of `.chat-turn` (so
// the CSS hover-reveal keys off the turn as intended), and the body's own
// `> :last-child { margin-bottom: 0 }` rule keeps the last paragraph tight
// against it without any margin fixup.
//
// Falls back to #transcript-live when there's no assistant turn to sit in
// - a run can finish having produced no text at all (an abort before any
// narration), and a note with nowhere to anchor is still better than no
// completion signal. The CSS keys hover-reveal off an ancestor .chat-turn,
// so a fallback note outside one stays permanently visible instead.
function completionNoteHost() {
  if (currentAssistantTurnEl && currentAssistantTurnEl.isConnected) {
    return currentAssistantTurnEl;
  }
  return transcriptLive;
}

// The hosting TURN carries a marker class while the note is in it, so the
// stylesheet can close the gap the note has to sit tight against: the last
// paragraph of the body above it keeps a 0.9em bottom margin from
// `#transcript p`, and the existing `.chat-turn-body > :last-child` rule
// meant to zero that is outweighed 101-to-20 by that ID selector, so it has
// never actually applied to a paragraph. Rather than change spacing for
// every turn in the app by fixing that rule globally, the class scopes the
// override to turns that genuinely have a note under them.
//
// On the turn and not the body deliberately - the body's innerHTML is
// rewritten on every reveal tick, which would drop a class set on it (the
// same rewrite that made an in-body note vanish; see completionNoteHost).
// Tracked in a variable rather than re-queried so clearing can only ever
// unmark the element it actually marked.
let completionNoteTurnEl = null;

function unmarkCompletionNoteTurn() {
  if (completionNoteTurnEl) {
    completionNoteTurnEl.classList.remove("has-completion-note");
    completionNoteTurnEl = null;
  }
}

function clearCompletionNote() {
  if (completionNoteTimer) {
    clearInterval(completionNoteTimer);
    completionNoteTimer = null;
  }
  if (completionNoteEl && completionNoteEl.parentNode) {
    completionNoteEl.parentNode.removeChild(completionNoteEl);
  }
  unmarkCompletionNoteTurn();
  completionNoteEl = null;
}

// Moves the note into `host` and keeps the marker class on exactly one
// turn. Shared by the initial render and every reanchor so the two paths
// can't drift on the bookkeeping.
function placeCompletionNote(host) {
  if (completionNoteTurnEl && completionNoteTurnEl !== host) unmarkCompletionNoteTurn();
  host.appendChild(completionNoteEl);
  if (host.classList.contains("chat-turn")) {
    completionNoteTurnEl = host;
    host.classList.add("has-completion-note");
  }
}

function renderCompletionNote(timestamp, status) {
  clearCompletionNote();
  completionNoteTime = timestamp;
  completionNoteEl = document.createElement("p");
  completionNoteEl.className = `completion-note state-${status}`;
  completionNoteEl.textContent = formatRelativeTime(timestamp);
  placeCompletionNote(completionNoteHost());
  completionNoteTimer = setInterval(() => {
    if (!completionNoteEl) return;
    completionNoteEl.textContent = formatRelativeTime(completionNoteTime);
  }, 60000); // minute-level refresh is enough granularity for the mins/hours band
}

// Keeps the note last inside whichever turn is currently the final one, so
// late-buffered transcript chunks (the reveal queue still draining on a
// normal completion) never strand it above newer content. Re-resolves the
// host every time rather than re-appending to the old one: a whole new turn
// attaching after completion needs the note moved into that turn, since
// that turn is now the end of the final output.
function reanchorCompletionNote() {
  if (!completionNoteEl) return;
  placeCompletionNote(completionNoteHost());
}

function renderFrame(frame) {
  // 0730: opt-in raw-frame capture for chasing the glue/duplicate-text bug class
  // (see the cumulativeText/pushSnapshotDiff comments below) - every prior instance
  // of this class was only root-caused with frame-level logging armed to catch it
  // live, not from static reading. Off by default (localStorage flag, not a
  // permanent console.log) so normal use stays quiet. Enable from devtools with
  // localStorage.setItem("debugFrames", "1") before reproducing, then read back
  // the captured frames from window.__frameLog.
  if (localStorage.getItem("debugFrames") === "1") {
    window.__frameLog = window.__frameLog || [];
    window.__frameLog.push({ t: Date.now(), frame });
    console.log("[frame]", frame);
  }

  const payload = frame.payload || {};
  const message = payload.message;
  const content = message && Array.isArray(message.content) ? message.content : null;

  // Two different numbers, one per line below, and they are easy to mix up
  // (this code did, until 2026-08-12 - see updateRunContextUsage):
  //
  //   payload.totalTokens   - session CUMULATIVE billing. Lives on the FRAME,
  //     as a sibling of `message`: handleTranscriptUpdateBroadcast in gateway
  //     dist/server-session-events-*.js spreads a session snapshot (including
  //     `totalTokens: sessionRow.totalTokens`) onto the frame itself.
  //   message.usage         - THIS turn's own usage, i.e. real context
  //     occupancy. Nested inside the message, assistant turns only.
  //
  // A 2026-07-27 note here claimed message.usage did not exist on the
  // projected message at all. It does; that check was made against a
  // non-assistant message, which is the one case the gateway strips it from.
  // Re-confirmed 2026-08-12 against sanitizeChatHistoryMessage in gateway
  // dist/session-transcript-path-*.js, which keeps a sanitized `usage` for
  // role === "assistant" and deletes it for every other role.
  //
  // Both checked defensively on every frame (same as `content` above) since
  // only session.message frames are confirmed to carry them, and the guards
  // make this a safe no-op for every other event.
  if (typeof payload.totalTokens === "number") {
    updateRunStatusTokens(payload.totalTokens);
  }
  if (message && message.role === "assistant" && message.usage) {
    updateRunContextUsage(message.usage);
  }

  // NOT independently confirmed which event actually carries message.content
  // in practice (chat, session.message, or both) - checked defensively on
  // every frame regardless of frame.event. Confirmed live 2026-07-23: BOTH
  // do, and session.message-delivered turns need the exact same paragraph-
  // break treatment as chat's - see the session.message branch below.
  //
  // transcriptHandledAsNew records whether THIS frame actually pushed
  // something new into the transcript, for the session.message branch
  // below to decide whether a turn boundary genuinely happened - see the
  // redundancy check just below for why it's gated so narrowly. Thinking
  // has no equivalent need for this anymore - closeThinkingGroup() (called
  // from narration/tool-call/new-user-turn boundaries) already decides
  // when a reasoning segment ends, independent of session.message noise.
  let transcriptHandledAsNew = false;

  if (content) {
    const fullThinking = extractThinkingText(content);
    if (fullThinking) {
      // Lazily opens a fresh "Thinking" block the first time this segment
      // has anything to show - exactly the deferred-attach pattern
      // startAssistantTurn uses for chat bubbles (see createRevealQueue's
      // pendingAttach), so DOM order matches arrival order here too.
      // currentThinkingGroup stays set (and this stays a no-op) across
      // multiple pushes within the SAME segment; it's nulled by
      // closeThinkingGroup at the next real boundary.
      if (!currentThinkingGroup) {
        // A new reasoning segment starting is as unambiguous a tool-group
        // boundary as a tool call starting is a thinking-group one (see
        // renderToolCard's own closeThinkingGroup call) - confirmed live
        // 2026-07-28 this was missing: a real run with 3 separate think-
        // then-call steps rendered as ONE "Ran N commands" bucket (every
        // call across all 3 steps silently rejoining whatever tool group
        // the FIRST step left open) followed by 3 stacked "Thinking"
        // blocks with nothing visibly separating them, instead of
        // interleaving think/call/think/call/think/call in actual
        // chronological order - exactly what request 2026-07-27 ("ensure
        // they're joined together strictly only when several calls are
        // done in order") asked for, just missing this one direction.
        closeToolGroup();
        const group = buildThinkingGroup();
        currentThinkingGroup = group;
        thinkingQueue.retarget(group.querySelector(".thinking-body"), () => {
          const conversationWasNearBottom = isScrolledNearBottom(conversation);
          // Late-arriving thinking (see currentAssistantTurnEl's own
          // comment) - if this turn's own bubble is already attached,
          // insert this group right before it instead of appending to
          // the end, so reasoning always renders before the answer it
          // led to regardless of which arrived over the wire first.
          if (currentAssistantTurnEl && currentAssistantTurnEl.isConnected) {
            transcriptLive.insertBefore(group, currentAssistantTurnEl);
          } else {
            transcriptLive.appendChild(group);
          }
          stickToBottom(conversation, conversationWasNearBottom);
        });
      }
      pushSnapshotDiff(thinkingQueue, fullThinking, lastThinkingSnapshot);
      lastThinkingSnapshot = fullThinking;
    }

    // Only for snapshot-shaped content (no deltaText alongside it) AND
    // only before this bubble has shown anything at all yet
    // (!transcriptQueue.hasContent()). Confirmed live 2026-07-24 across
    // THREE separate real gateway runs: session.message (and the final
    // chat frame's own state:"final" content) redundantly re-announces
    // text this bubble's own deltaText is already/about to stream, and it
    // does this repeatedly throughout one continuous narration - a single
    // text-bearing assistant turn confirmed via chat.history (one
    // unsplit message) can legitimately arrive as several deltaText
    // "chunks" back to back (a sentence, then another, then a full
    // recap...), each preceded or followed by its own redundant
    // session.message snapshot of just that chunk. A first attempt at
    // this fix tried to compare the snapshot against the bubble's own
    // accumulated text (prefix/suffix, whitespace-trimmed) to tell a
    // redundant chunk-recap apart from genuinely new content - broke
    // exactly on this multi-chunk case: a later chunk's session.message
    // recap doesn't share a prefix relationship with the WHOLE bubble
    // text so far (only with its own chunk), so the comparison
    // misclassified it as "genuinely new" and opened a spurious duplicate
    // bubble. The bubble-has-any-content-yet check here is coarser but
    // correct for what's actually been observed: once deltaText starts
    // narrating a bubble, EVERY session.message for it, chunk after
    // chunk, is pure noise - there is no confirmed real case yet of a
    // genuinely separate text-bearing turn arriving without its own
    // deltaText mid-response (tool-call-only turns carry no text at all,
    // so they never reach this branch either way). This only matters for
    // the cold-start fallback - a bubble that has shown NOTHING yet
    // (reopening a still-live run from Recents, before its first
    // deltaText has arrived) - where reconcileTranscriptText's own
    // startsWith/includes logic still applies normally.
    if (typeof payload.deltaText !== "string" && !transcriptQueue.hasContent()) {
      // Trimmed: a real run showed this snapshot arrive wrapped in an
      // extra leading (and trailing) "\n\n" that deltaText's own
      // character-by-character delivery never has.
      const fullFinalText = extractFinalText(content).trim();
      if (fullFinalText) {
        setHidden(conversationEmpty, true);
        reconcileTranscriptText(fullFinalText);
        transcriptHandledAsNew = true;
      }
    }
  }

  if (frame.event === "chat") {
    setHidden(conversationEmpty, true);
    if (typeof payload.deltaText === "string") {
      if (!transcriptQueue.hasTarget()) {
        // Normally a bubble already exists (startAssistantTurn(), called
        // from the composer submit handler for every user-initiated
        // message) - this is a fallback for the one case that isn't
        // user-initiated in THIS view: reopening a still-actively-
        // streaming run from Recents. openHistoricalSession() doesn't
        // itself open a bubble (it doesn't know if/when more content is
        // still coming), so the first live content to arrive opens one
        // lazily on demand instead of being silently dropped.
        startAssistantTurn(true);
      } else if (transcriptPendingBreak) {
        // A turn boundary was flagged since this bubble was last written
        // to - opens its own bubble (see startAssistantTurn's own comment
        // for why a shared bubble with an in-band break isn't used
        // anymore). No lastTranscriptSnapshot adjustment needed here
        // anymore (see the cumulativeText comment just below) - confirmed
        // live the gateway's own content string flows as ONE continuous
        // stream with no break inserted at this boundary either, so the
        // new bubble's own DOM boundary is the only separation needed.
        startAssistantTurn(false);
      }
      // Confirmed live 2026-07-27 (against nvidia/Qwen3.6-35B-A3B-NVFP4):
      // deltaText is NOT always a genuine increment - occasionally a
      // "delta" event's deltaText arrives as a byte-identical FULL copy
      // of payload.message.content[0].text (the cumulative snapshot every
      // chat event reliably carries - confirmed against many real samples
      // that content always exactly equals lastTranscriptSnapshot +
      // deltaText when deltaText IS genuinely incremental) instead of
      // just the new tail. One captured real frame had deltaText ===
      // message.content[0].text, both 5158 chars, with no distinguishing
      // marker (same event type, its own legitimately-incrementing seq -
      // not a literal wire-level re-delivery of a prior frame, an exact-
      // duplicate-seq check doesn't catch this) - naively concatenating it
      // glued the whole response onto itself a second time with zero
      // separator, cut mid-word wherever the reveal animation happened to
      // be (the exact bug reported live twice, only the second time with
      // frame-level logging armed to catch it). Deriving the real
      // increment from the cumulative snapshot via pushSnapshotDiff - the
      // same helper already trusted for the thinking/session.message
      // paths - instead of trusting deltaText at face value is self-
      // healing against this regardless of root cause; it also already
      // covers a literal exact re-delivery for free (identical cumulative
      // text against an unchanged lastTranscriptSnapshot diffs to "",
      // which push() already no-ops on).
      //
      // 0805: this read `payload.message.content[0].text` - only the FIRST
      // part - which silently assumed a message is always one content part.
      // A real capture that day (the reply to a dashboard Deny click, taken
      // straight from chat.history) had FOUR:
      //   ["", "\n\nUnder", "", "stood — the `fix/...` fix ..."]
      // content[0].text was "", which passed the `typeof === "string"` guard
      // as a perfectly valid snapshot, so lastTranscriptSnapshot was RESET to
      // "" mid-response. Every frame after that diffed the full text against
      // nothing and pushed all of it again - the response duplicated on
      // screen, cut mid-word at the part boundary. extractSnapshotText joins
      // every part (with "", since parts are fragments not paragraphs - see
      // its own comment) and returns null rather than "" when there's nothing
      // usable, so an empty or text-free frame now leaves the accumulated
      // snapshot alone instead of wiping it.
      const cumulativeText = payload.message
        ? extractSnapshotText(payload.message.content)
        : null;
      if (cumulativeText !== null) {
        pushSnapshotDiff(transcriptQueue, cumulativeText, lastTranscriptSnapshot);
        lastTranscriptSnapshot = cumulativeText;
      } else if (lastTranscriptSnapshot && payload.deltaText.startsWith(lastTranscriptSnapshot)) {
        // 0730: this fallback (no message.content on the frame) was previously a raw
        // append, on the assumption deltaText here is always a genuine increment -
        // "not yet observed live" otherwise, per the comment this replaced. That
        // assumption is what glued a response onto itself elsewhere (see the
        // cumulativeText comment above) whenever deltaText arrived as a full
        // snapshot copy instead of a true increment. Same signature check as that
        // fix: only route through pushSnapshotDiff when deltaText actually LOOKS
        // like a full-snapshot copy (as long as, and prefixed by, everything already
        // accumulated) - a genuine short increment never satisfies startsWith
        // against the whole prior snapshot, so the normal case still falls through
        // to the plain append below unchanged.
        pushSnapshotDiff(transcriptQueue, payload.deltaText, lastTranscriptSnapshot);
        lastTranscriptSnapshot = payload.deltaText;
      } else {
        transcriptQueue.push(payload.deltaText);
        lastTranscriptSnapshot += payload.deltaText;
      }
    }
    if (payload.state === "final") {
      // Marks a turn boundary, not necessarily the whole run's end - a
      // multi-turn agent loop (think, call tools, think again) sends one
      // of these per turn. Whatever real run-level status this deserves
      // comes from the "agent" event below instead; this used to also set
      // statusBanner to "done" here, which was actively misleading mid-run
      // (showed "done" while the agent kept working through more turns).
      transcriptPendingBreak = true;
    }
    return;
  }

  if (frame.event === "session.message") {
    // Harvest any tool-call arguments this frame carries BEFORE the
    // early-returns below - on a CLI/cron run this is the only place the
    // command/path a tool was invoked with ever appears, and the tool's
    // own start event (which needs it) is the very next frame. Purely
    // additive bookkeeping: it reads the message and changes nothing
    // about how the text below is handled.
    recordItemToolArgs(itemToolArgs, payload.message);
    // Thinking/final text (if this particular frame carries any) is
    // already extracted generically above. Confirmed live 2026-07-23:
    // session.message-delivered turns were showing up glued directly onto
    // whatever came before with zero separator (no chat state:"final" in
    // between) - each session.message is its own discrete turn, so
    // receiving one marks a boundary the same way chat's state:"final"
    // does.
    //
    // BUT only when it actually delivered something new - confirmed live
    // 2026-07-24 against a real gateway run that most session.message
    // frames arrive either with completely empty content (pure
    // checkpointing noise) or with a redundant re-announcement of text
    // this bubble's own deltaText is already streaming (see the
    // !transcriptQueue.hasContent() check above). Marking a boundary
    // unconditionally on every session.message - as this used to - split
    // one genuinely continuous response into several bubbles at each of
    // these no-op points, with no actual turn change behind any of the
    // splits.
    if (transcriptHandledAsNew) transcriptPendingBreak = true;
    return;
  }

  if (frame.event === "agent") {
    if (payload.stream === "tool" && payload.data) {
      setHidden(conversationEmpty, true);
      renderToolCard(payload.data);
      // Confirmed live 2026-07-24 via chat.history ground truth: a single
      // response can genuinely contain SEVERAL separate text-bearing
      // assistant turns, not just one, with a real tool-call round-trip
      // between each (narrate, call tools, narrate again, call more
      // tools, final narrate) - neither chat's own state:"final" nor
      // session.message reliably fires at these specific boundaries (see
      // the !transcriptQueue.hasContent() gate above/below), so without
      // this they all glued into one bubble with zero separator. A tool
      // call actually STARTING is an unambiguous, always-real signal that
      // whatever bubble was narrating before is done - flag it here so
      // the next narration (whether after this one tool call or several
      // in a row) opens its own fresh bubble instead of continuing the
      // previous one. Harmless to set repeatedly for several tool calls
      // in a row before the next narration ever arrives to consume it.
      if (payload.data.phase === "start" && transcriptQueue.hasContent()) {
        transcriptPendingBreak = true;
      }
      return;
    }
    // The CLI/cron-triggered equivalent of the stream:"tool" branch above -
    // see renderItemToolCard's own comment for why these are two entirely
    // different event shapes for the same thing.
    if (payload.stream === "item" && payload.data) {
      setHidden(conversationEmpty, true);
      renderItemToolCard(payload.data);
      // Same turn-boundary signal the stream:"tool" branch sets, for the
      // same reason - but only for the REAL tool's start, not the
      // wrapper's and not the kind:"command" duplicate, or a single exec
      // would punctuate the narration three times over.
      if (
        payload.data.phase === "start" &&
        payload.data.kind === "tool" &&
        payload.data.name !== "tool_call" &&
        transcriptQueue.hasContent()
      ) {
        transcriptPendingBreak = true;
      }
      return;
    }
    if (payload.stream === "command_output" && payload.data) {
      setHidden(conversationEmpty, true);
      applyItemCommandOutput(payload.data);
      return;
    }
    const status = payload.status;
    if (status) {
      if (status === "completed" || status === "failed") {
        // Terminal - show the inline completion note (relative time,
        // live-updating) right after the agent's final output instead of
        // the old top-of-chatroom "agent completed/failed" banner, and
        // hide the banner so it doesn't linger showing a stale status.
        statusBanner.textContent = "";
        setHidden(statusBanner, true);
        renderCompletionNote(Date.now(), status);
        // Gated on currentSessionContinuable (see its own comment, and the
        // identical gate on the ws "close" listener above) - found live
        // 2026-09-03: a decision (e.g. approve-suppression) sent on a
        // gateway-origin session can trigger a fresh run whose own
        // completion/error signal arrives through this same renderFrame
        // path. This and the three other terminal-signal branches below
        // (lifecycle "end", lifecycle "error", dashboard.error) used to
        // re-enable the composer unconditionally, wrongly making a
        // non-continuable session's prompt bar typable again - typing
        // into it does nothing (the gateway rejects sends on a session it
        // didn't open), so this was a real, reachable UI lie, not a
        // theoretical one.
        if (currentSessionContinuable) setComposerEnabled(true);
        stopRunStatus();
      } else {
        // Still in flight ("running", "stopping", etc.) - the banner is
        // the right home for a transient status, make sure it's visible.
        setHidden(statusBanner, false);
        statusBanner.textContent = `agent ${status}`;
        statusBanner.className = `status-${status}`;
      }
    }
    // Confirmed live 2026-07-24 against a real run: `payload.status` (above)
    // is a separate, session-level field that only ever showed up as
    // "running" - never "completed"/"failed" - across many "agent" events
    // in a full real run, so the banner got set to "agent running" once,
    // early, and never updated again even long after the run had
    // genuinely finished. The actual run-completion signal for a real
    // run is this "lifecycle" stream's own `data.phase === "end"` (also
    // confirmed live, present on every real run tested). `aborted`
    // distinguishes a clean stop from an interrupted one - `aborted:
    // false` + `stopReason: "stop"` is the only case confirmed live so
    // far; the true-case shape isn't independently confirmed, so this is
    // a reasonable, not guaranteed, reading of it.
    if (payload.stream === "lifecycle" && payload.data && payload.data.phase === "end") {
      const finished = payload.data.aborted ? "aborted" : "completed";
      // Terminal - inline completion note after the final output instead
      // of the banner. For an abort, flush the still-buffered reveal
      // queue FIRST so the note anchors after whatever partial output
      // exists (renderCompletionNote appends to transcriptLive, which the
      // reveal queue's render() also targets). A normal completion
      // legitimately keeps its reveal backlog (the slow-typewriter effect
      // working as intended), so only aborts flush - see flush()'s own
      // comment; the note is anchored to the end of transcriptLive by
      // reanchorCompletionNote() on any further appends regardless.
      if (payload.data.aborted) {
        transcriptQueue.flush();
        thinkingQueue.flush();
      }
      statusBanner.textContent = "";
      setHidden(statusBanner, true);
      renderCompletionNote(Date.now(), finished);
      if (currentSessionContinuable) setComposerEnabled(true);
      stopRunStatus();
    }
    // Confirmed live 2026-07-27 against a real run that hit a context-
    // overflow: a run can ALSO terminate via lifecycle phase:"error"
    // instead of phase:"end" - no "end" event ever arrives in this case,
    // carries its own data.error message (e.g. "Context overflow: prompt
    // too large for the model..."). Previously entirely unhandled: the
    // composer stayed disabled, the "Working" timer kept running, and the
    // status banner stayed blank forever, with no indication to the user
    // that anything had gone wrong or that the run was over.
    if (payload.stream === "lifecycle" && payload.data && payload.data.phase === "error") {
      // Errors stay on the prominent banner (urgent, no final output to
      // anchor an inline note after) - make sure the banner is visible in
      // case a prior completion just hid it.
      setHidden(statusBanner, false);
      statusBanner.textContent = payload.data.error ? `agent error: ${payload.data.error}` : "agent error";
      statusBanner.className = "status-failed";
      if (currentSessionContinuable) setComposerEnabled(true);
      stopRunStatus();
      // Unlike a normal completion (where a large reveal backlog is the
      // deliberate slow-typewriter effect working as intended, see the
      // comment above), the run is definitively over with nothing more
      // ever coming - flush unconditionally, same as an abort.
      transcriptQueue.flush();
      thinkingQueue.flush();
    }
    return;
  }

  if (frame.event === "dashboard.error") {
    // See the phase:"error" branch just above - keep the banner visible
    // for an urgent dashboard-level error.
    setHidden(statusBanner, false);
    statusBanner.textContent = payload.message || "error";
    statusBanner.className = "status-failed";
    if (currentSessionContinuable) setComposerEnabled(true);
    stopRunStatus();
    return;
  }

  // Anything else is intentionally swallowed rather than rendered - raw
  // gateway event JSON showing up in the UI was the #1 reported issue.
  // Still logged to the console so an unhandled-but-real event is
  // debuggable without polluting the page.
  console.debug("[dashboard] unhandled event:", frame.event, payload);
}

// ---------------------------------------------------------------------------
// Monitoring - live Kubernetes log panes (#monitoring-view).
//
// Phases 4 and 5 of docs/monitoring-live-logs.md: the view, the 1-4 pane grid,
// and the per-pane controls. Phase 6 is the styled rendering of the reattach /
// throttle / failure rows - those rows already exist and already land in the
// pane; what is left is how they look.
//
// Every pane owns its own socket. logStream does the sharing underneath (two
// panes on one repoKey would share one kubectl child), but nothing here relies
// on that - the UI refuses a duplicate pane for a display reason, not a
// resource one, so the two concerns stay separate.
//
// Two rules that hold throughout, both of them the difference between a pane
// that is wrong and a pane that is visibly wrong:
//
//   - Every non-line frame goes through describeControlFrame (monitoringPanes.js)
//     and lands in the pane. A pane that silently swallows a reattach or a
//     throttle looks exactly like a healthy one, which is the blind-monitoring
//     failure this feature exists to prevent.
//   - Nothing is dropped on the floor while paused. §6.3 keeps the stream and
//     the buffer running through a pause so that resuming shows the gap rather
//     than a hole.
// ---------------------------------------------------------------------------

let monitoringTargets = [];
// Insertion-ordered, which is also grid order: Map iteration order is the
// order keys were added, so a pane's position never shuffles when an earlier
// one is closed.
const monitoringPanes = new Map();
let monitoringPaneSeq = 0;
// What was open when the view was last closed, so reopening resumes the same
// set instead of dropping the operator back onto an empty grid. Keys only -
// the targets are re-resolved against a freshly loaded list, since a repo can
// be deregistered or its runtime block changed while the view was closed.
let monitoringLastKeys = [];

// Back goes through history.back() so the in-page button and the browser's
// own Back button take the identical path (the popstate handler above),
// instead of the in-page one popping an entry that was never consumed - the
// same reasoning watcherHistoryBack is wired this way for.
monitoringBtn.addEventListener("click", () => openMonitoring());
monitoringBack.addEventListener("click", () => history.back());

function openMonitoring() {
  // pushState rather than a bare view swap: this is presented as a page, so
  // Back has to leave the page rather than the dashboard. The hash is dropped
  // on load rather than restored (see the replaceState above) - rebuilding a
  // set of streams from a URL before auth has even run is not something to
  // attempt.
  history.pushState({ monitoring: true }, "", "#monitoring");
  showMonitoring();
}

// Split from openMonitoring so popstate can re-show this view WITHOUT pushing
// another entry, exactly as showWatcherHistory is split from
// openWatcherHistory.
function showMonitoring() {
  closeOpsModal();
  showTopLevelView(monitoringView);
  loadMonitoringTargets();
}

// Teardown ONLY, for the same reason resetWatcherHistoryState() is.
function stopMonitoringStreams() {
  // The streams stop with the page. A `kubectl logs -f` runs in the sandbox
  // for as long as a socket holds it, so panes nobody is looking at are all of
  // §2.3's cost with none of its benefit - and with four of them that is four
  // idle API-server connections, not one.
  monitoringLastKeys = [...monitoringPanes.values()].map((p) => p.repoKey);
  closeAllMonitoringPanes();
}

function setMonitoringStatus(text) {
  monitoringStatus.textContent = text;
  setHidden(monitoringStatus, false);
}

// The one place pane count turns into layout, so the grid class and the
// picker's own availability can never disagree about how many are open.
function syncMonitoringLayout() {
  const count = monitoringPanes.size;
  // Re-pinned after the class change. Confirmed live: re-shaping the grid
  // (adding a fourth pane, or crossing the 860px breakpoint) narrows the
  // existing panes, which makes their content taller through wrapping, and
  // leaves a pane that was pinned to its bottom several screens short of it.
  // That is not cosmetic - the next line's own wasNearBottom check then reads
  // false, so auto-follow never resumes and the pane silently stops following
  // a stream it is still receiving. Same class of defect as the scroll-jump
  // regression already fixed on #conversation, arriving from the opposite
  // direction.
  monitoringGrid.className = gridClassFor(count);
  repinMonitoringPanes();
  renderMonitoringPicker();
  if (count === 0) {
    setMonitoringStatus(
      monitoringTargets.length
        ? "Pick a workload to start streaming."
        : "No workloads available to stream.",
    );
  } else {
    setHidden(monitoringStatus, true);
  }
}

// Re-pins every pane that was following its stream, and leaves alone every
// pane the operator deliberately scrolled up in.
//
// It reads pane.pinned - remembered state - rather than measuring the pane
// now, which is the whole point: by the time this runs the layout has already
// changed, so a measurement would report the very displacement it is meant to
// undo. Measuring beforehand works for a layout change this code initiates,
// but not for a window resize, where the reflow happens before any handler
// sees it. That version shipped first and was caught in the browser: dropping
// from 1440px to 700px left both panes stranded mid-stream with a jump button
// showing.
//
// Remembering it is safe in the one way that looked risky. A flag could be
// corrupted by the clamping scroll events a resize produces - but clamping
// only happens when the content SHRINKS, which means the pane was at its
// bottom and is clamped back to its bottom, i.e. still pinned. The direction
// that actually strands a pane (narrower, so taller through wrapping) leaves
// scrollTop untouched and therefore fires no scroll event at all.
function repinMonitoringPanes() {
  for (const pane of monitoringPanes.values()) {
    if (!pane.pinned || !pane.root.isConnected) continue;
    pane.body.scrollTop = pane.body.scrollHeight;
    updatePaneJumpVisibility(pane);
  }
}

window.addEventListener("resize", () => {
  if (monitoringView.hidden || !monitoringPanes.size) return;
  repinMonitoringPanes();
});

async function loadMonitoringTargets() {
  try {
    const res = await fetch("/api/monitoring/targets");
    if (sessionExpired(res)) return;
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || "failed to load workloads");
    }
    const data = await res.json();
    monitoringTargets = data.targets || [];
    monitoringLimitsLabel.textContent = describeLimits(data.limits);
    restoreMonitoringPanes();
    syncMonitoringLayout();
  } catch (err) {
    monitoringTargetSelect.innerHTML = "";
    setMonitoringStatus(`Could not load workloads: ${err.message}`);
  }
}

// Reopens whatever was open when the view was last closed. Each key goes
// through addMonitoringPane, so a workload that has since been deregistered or
// made unstreamable is simply not restored rather than restored broken.
function restoreMonitoringPanes() {
  if (monitoringPanes.size || !monitoringLastKeys.length) return;
  const keys = monitoringLastKeys;
  monitoringLastKeys = [];
  for (const repoKey of keys) addMonitoringPane(repoKey);
}

// The picker adds a pane rather than switching one, so it is rebuilt on every
// change: an option's availability depends on what is already open.
function renderMonitoringPicker() {
  const openKeys = [...monitoringPanes.values()].map((p) => p.repoKey);
  const atLimit = openKeys.length >= MAX_PANES;

  monitoringTargetSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = atLimit ? `${MAX_PANES}-pane limit reached` : "Add a workload…";
  monitoringTargetSelect.appendChild(placeholder);

  for (const target of monitoringTargets) {
    const opt = describeTargetOption(target);
    if (!opt) continue;
    const verdict = canAddPane(openKeys, target);
    const el = document.createElement("option");
    el.value = opt.value;
    // Listed and disabled, never filtered out (§4.6): a workload missing from
    // the picker is a dead end nobody can debug, one that says why explains
    // itself. That reasoning covers "already open" and "at the pane limit"
    // just as well as an unstreamable runtime, so all three say so rather
    // than vanishing.
    el.textContent = verdict.ok ? opt.label : `${opt.label} — ${verdict.reason}`;
    el.disabled = !verdict.ok;
    el.title = verdict.ok ? opt.title : verdict.reason;
    monitoringTargetSelect.appendChild(el);
  }

  monitoringTargetSelect.value = "";
  monitoringTargetSelect.disabled = atLimit;
}

monitoringTargetSelect.addEventListener("change", () => {
  const repoKey = monitoringTargetSelect.value;
  if (!repoKey) return;
  addMonitoringPane(repoKey);
});

function addMonitoringPane(repoKey) {
  const target = monitoringTargets.find((t) => t.repoKey === repoKey);
  const openKeys = [...monitoringPanes.values()].map((p) => p.repoKey);
  const verdict = canAddPane(openKeys, target);
  // Re-checked here and not only in the picker. The picker's disabled options
  // are the affordance; this is the rule. They are rebuilt from the same
  // canAddPane, so they cannot disagree, but a stale DOM (a select that was
  // rendered before the last pane opened) must not be able to force a fifth
  // pane.
  if (!verdict.ok) {
    renderMonitoringPicker();
    return;
  }

  monitoringPaneSeq += 1;
  const pane = createLogPane(target, monitoringPaneSeq);
  monitoringPanes.set(pane.id, pane);
  syncMonitoringLayout();
  openMonitoringSocket(pane);
}

// Tears one pane down: its socket, then its DOM. Clearing pane.socket BEFORE
// calling close() is what marks this as a deliberate teardown - the close
// handler checks identity and stays quiet, so closing a pane doesn't leave a
// "connection closed" note on a pane that is being removed on purpose.
function closeMonitoringPane(pane) {
  if (pane.socket) {
    const ws = pane.socket;
    pane.socket = null;
    ws.close();
  }
  pane.root.remove();
  monitoringPanes.delete(pane.id);
  syncMonitoringLayout();
}

function closeAllMonitoringPanes() {
  for (const pane of [...monitoringPanes.values()]) closeMonitoringPane(pane);
}

function createLogPane(target, id) {
  const root = document.createElement("section");
  root.className = "log-pane";

  const header = document.createElement("header");
  header.className = "log-pane-header";

  const dot = document.createElement("span");
  dot.className = "log-pane-dot";
  dot.dataset.state = "connecting";

  const name = document.createElement("span");
  name.className = "log-pane-name";
  name.textContent = target.displayName || target.repoKey;

  const meta = document.createElement("span");
  meta.className = "log-pane-meta";
  meta.textContent = paneMetaText(target);

  const controls = document.createElement("div");
  controls.className = "log-pane-controls";

  const pauseBtn = document.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.className = "log-pane-btn";
  pauseBtn.textContent = "Pause";
  pauseBtn.title = "Stop rendering; the stream keeps running";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "log-pane-btn";
  clearBtn.textContent = "Clear";
  clearBtn.title = "Empty this pane";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "log-pane-btn log-pane-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", `Close ${target.displayName || target.repoKey} pane`);
  closeBtn.title = "Close this pane and stop its stream";

  controls.append(pauseBtn, clearBtn, closeBtn);
  header.append(dot, name, meta, controls);

  const body = document.createElement("div");
  body.className = "log-pane-body";
  const rows = document.createElement("div");
  rows.className = "log-pane-rows";
  body.appendChild(rows);

  // Per-pane rather than one shared button: with four panes, "jump to latest"
  // has to name which pane it means, and the only unambiguous way to do that
  // is to put it inside the one it scrolls.
  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.className = "log-pane-jump";
  jumpBtn.textContent = "↓ Jump to latest";
  setHidden(jumpBtn, true);

  const pausedLabel = document.createElement("div");
  pausedLabel.className = "log-pane-paused";
  setHidden(pausedLabel, true);

  root.append(header, body, jumpBtn, pausedLabel);
  monitoringGrid.appendChild(root);

  const pane = {
    id,
    repoKey: target.repoKey,
    target,
    root,
    body,
    rows,
    dot,
    jumpBtn,
    pausedLabel,
    pauseBtn,
    socket: null,
    state: "connecting",
    paused: false,
    // §6.4. Compiled once here rather than per line, and null when the
    // registry's pattern is absent or malformed - a typo in repos.json costs
    // tinting, not the pane.
    errorRe: compileErrorPattern(target.errorPattern),
    // The Retry offered on the most recent failure note, so an earlier one
    // left in the scrollback can be disabled rather than left live.
    retryBtn: null,
    // Following its own bottom. Owned by updatePaneJumpVisibility; read by
    // repinMonitoringPanes across a layout change.
    pinned: true,
    // Frames that arrived while paused, replayed in order on resume. Bounded
    // by the same cap as the rendered rows: a pane paused overnight against a
    // chatty workload must not grow without limit just because nobody is
    // looking at it.
    pending: [],
  };

  pauseBtn.addEventListener("click", () => setPanePaused(pane, !pane.paused));
  clearBtn.addEventListener("click", () => clearPane(pane));
  closeBtn.addEventListener("click", () => closeMonitoringPane(pane));
  jumpBtn.addEventListener("click", () => {
    pane.body.scrollTop = pane.body.scrollHeight;
    updatePaneJumpVisibility(pane);
  });
  // passive: this listener only reads scroll position and never calls
  // preventDefault, so the browser can keep scrolling on its own thread.
  pane.body.addEventListener("scroll", () => updatePaneJumpVisibility(pane), { passive: true });

  setPaneState(pane, "connecting", null);
  return pane;
}

// Pause is CLIENT-SIDE ONLY (§6.3). Killing the child would mean a reattach -
// and a --since-time replay - on every resume, which is a lot of machinery to
// buy nothing: the stream costs the same whether or not the browser is
// drawing it.
function setPanePaused(pane, paused) {
  pane.paused = paused;
  pane.pauseBtn.textContent = paused ? "Resume" : "Pause";
  pane.root.classList.toggle("paused", paused);
  if (paused) {
    pane.pausedLabel.textContent = describePaused(0);
    setHidden(pane.pausedLabel, false);
    return;
  }
  setHidden(pane.pausedLabel, true);
  const buffered = pane.pending;
  pane.pending = [];
  for (const frame of buffered) paintLogFrame(pane, frame);
}

function clearPane(pane) {
  pane.rows.innerHTML = "";
  // The buffer goes too. "Clear" that leaves a hidden backlog to flood back in
  // on resume is not a clear.
  pane.pending = [];
  if (pane.paused) pane.pausedLabel.textContent = describePaused(0);
  updatePaneJumpVisibility(pane);
}

function setPaneState(pane, state, detail) {
  pane.state = state;
  pane.dot.dataset.state = state;
  pane.dot.title = detail ? `${state} · ${detail}` : state;
  pane.dot.setAttribute("aria-label", `stream ${state}`);
}

// Shows the jump button whenever the pane has scrolled away from its own
// bottom AND has something to scroll to. Same two-part condition
// updateJumpLatestVisibility uses for #conversation, and for the same reason:
// a short pane with no overflow has no "latest" to jump to.
// Also the one place pane.pinned is written. Every path that can change a
// pane's scroll relationship to its own bottom - a user scroll, an appended
// row, a clear, a re-pin - ends here, so the flag cannot drift from what the
// pane is actually doing. See repinMonitoringPanes for why it is remembered
// rather than measured on demand.
function updatePaneJumpVisibility(pane) {
  const hasOverflow = pane.body.scrollHeight > pane.body.clientHeight;
  pane.pinned = isScrolledNearBottom(pane.body);
  setHidden(pane.jumpBtn, !hasOverflow || pane.pinned);
}

// The split between renderLogFrame and paintLogFrame is what makes pause
// honest. State is applied the moment a frame arrives, paused or not - a pane
// that failed while paused must show a red dot immediately, not on resume -
// while the visible row is what gets deferred.
function renderLogFrame(pane, frame) {
  if (frame.t === "status") setPaneState(pane, frame.state, frame.detail);

  if (pane.paused) {
    pane.pending.push(frame);
    if (pane.pending.length > PANE_LINE_LIMIT) pane.pending.shift();
    pane.pausedLabel.textContent = describePaused(pane.pending.length);
    return;
  }
  paintLogFrame(pane, frame);
}

function paintLogFrame(pane, frame) {
  if (frame.t === "line") {
    appendLogLine(pane, frame);
    return;
  }
  const note = describeControlFrame(frame);
  if (note) appendLogNote(pane, note);
}

function appendLogLine(pane, frame) {
  // Read BEFORE the append, for the reason isScrolledNearBottom documents:
  // scrollHeight grows the instant the row lands, so checking afterwards
  // reads as "scrolled away" even for a user sitting at the bottom.
  const wasNearBottom = isScrolledNearBottom(pane.body);

  const row = document.createElement("div");
  // §6.4: display only. The class tints the row and does nothing else - no
  // line is filtered, hidden, reordered or counted differently for matching.
  const severity = rowSeverityClass(pane.errorRe, frame.text);
  row.className = severity ? `log-row ${severity}` : "log-row";

  // The three cells are always present, even when empty. That is necessary
  // but NOT sufficient for the columns to line up - the fixed track widths in
  // style.css are the other half, and without them an empty cell collapses
  // and shunts a timestamp-less line's text a full column to the left. See
  // .log-row's comment for the measurement.
  const timeEl = document.createElement("span");
  timeEl.className = "log-row-time";
  timeEl.textContent = formatLogTime(frame.ts) || "";

  const podEl = document.createElement("span");
  podEl.className = "log-row-pod";
  podEl.textContent = podShortName(frame.pod) || "";
  if (frame.pod) podEl.title = frame.container ? `${frame.pod}/${frame.container}` : frame.pod;

  const textEl = document.createElement("span");
  textEl.className = "log-row-text";
  // textContent, and deliberately NOT through marked/DOMPurify the way
  // transcript content is. This is untrusted production output - the live
  // test returned client IPs, request paths and file UUIDs - and there is no
  // markdown in it to render. Interpreting it as anything but text would be
  // handing a workload's own log output a way to write into the dashboard.
  textEl.textContent = frame.text;

  row.append(timeEl, podEl, textEl);
  pane.rows.appendChild(row);
  trimPaneRows(pane);
  stickToBottom(pane.body, wasNearBottom);
  updatePaneJumpVisibility(pane);
}

// Control frames render as a DIVIDER in the log flow rather than a badge in
// the header, and phase 6 is where that becomes literal: a centred label with
// a rule running out to both edges. These are things that happened at a point
// in the stream, and their whole value is knowing where in the output they
// happened - a header badge would say a reattach occurred while discarding
// the only part that matters.
function appendLogNote(pane, note) {
  const wasNearBottom = isScrolledNearBottom(pane.body);

  const el = document.createElement("div");
  el.className = `log-note log-note-${note.tone}`;

  const label = document.createElement("span");
  label.className = "log-note-label";
  label.textContent = note.text;
  el.appendChild(label);

  // §5.1: a stream that has given up gets a manual Retry rather than
  // reconnecting forever. Attached to the failure itself, at the point in the
  // log where it happened, so a dead pane both says why and offers the one
  // thing to do about it.
  if (note.tone === "fail") {
    // A retry that has since failed again gets a terminal label. Left as
    // "Retrying…" it would read as still in progress, directly above the note
    // saying it isn't.
    if (pane.retryBtn) {
      pane.retryBtn.disabled = true;
      pane.retryBtn.textContent = "Retried";
    }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "log-note-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => retryPane(pane, retry));
    label.appendChild(retry);
    pane.retryBtn = retry;
  }

  pane.rows.appendChild(el);
  trimPaneRows(pane);
  stickToBottom(pane.body, wasNearBottom);
  updatePaneJumpVisibility(pane);
}

// Reconnects a failed pane. Closing first is what makes this a real retry
// rather than a no-op: logStream keeps one stream per repoKey and hands a new
// subscriber the existing one, failed state and all, so re-subscribing while
// still attached would join the same dead stream. Dropping to zero subscribers
// tears it down, and the next subscribe builds a fresh one.
//
// The exception, stated because it is invisible from here: if a second
// operator is watching the same workload, the stream does not reach zero
// subscribers and this rejoins theirs. That is the correct outcome anyway -
// their stream is the one that would have to be restarted, and this pane is
// not entitled to restart it out from under them.
function retryPane(pane, button) {
  button.disabled = true;
  button.textContent = "Retrying…";
  const ws = pane.socket;
  // Cleared first, so the old socket's close handler recognises this as a
  // deliberate teardown and stays quiet.
  pane.socket = null;
  setPaneState(pane, "connecting", null);

  // Waits for the old socket to actually close before opening the new one.
  // Firing both at once is a race the retry would usually lose in the way
  // that is hardest to notice: the new upgrade arriving before the server has
  // processed the old close means the subscriber count never reaches zero,
  // the stream is never torn down, and the "retry" silently rejoins the same
  // failed stream and reports the same failure. The two cases are both real -
  // an accepted-then-failed socket is already CLOSED by the time its Retry is
  // visible, while a stream that exhausted MAX_START_FAILURES leaves the
  // socket open.
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.addEventListener("close", () => openMonitoringSocket(pane), { once: true });
    ws.close();
    return;
  }
  openMonitoringSocket(pane);
}

function trimPaneRows(pane) {
  while (pane.rows.childElementCount > PANE_LINE_LIMIT) {
    pane.rows.removeChild(pane.rows.firstElementChild);
  }
}

function openMonitoringSocket(pane) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ repoKey: pane.repoKey });
  const ws = new WebSocket(`${scheme}//${location.host}/ws/logs?${params}`);
  pane.socket = ws;

  ws.addEventListener("message", (ev) => {
    // Identity check, not a null check: a socket replaced or torn down can
    // still deliver a few trailing events, and they must not render into the
    // pane that replaced it.
    if (ws !== pane.socket) return;
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    renderLogFrame(pane, frame);
  });

  // A "close" always follows an "error" per spec, so the user-facing handling
  // lives below; this exists so the failure is at least debuggable, matching
  // openSocket's own convention.
  ws.addEventListener("error", () => {
    console.error(`WS error for log stream ${pane.repoKey}`);
  });

  ws.addEventListener("close", () => {
    if (pane.socket !== ws) return;
    pane.socket = null;
    // Never overwrite a failure the server already explained. logsRelay
    // accepts the upgrade and THEN sends status:"failed" carrying the real
    // reason - an unstreamable runtime, or MAX_CONCURRENT_STREAMS - before
    // closing, precisely so the pane has something actionable to show.
    // Replacing that with a generic "connection closed" would discard the
    // only useful thing on the pane.
    if (pane.state !== "failed") {
      // Routed through renderLogFrame rather than setPaneState + appendLogNote
      // directly, so it obeys pause like every other frame: a pane that loses
      // its socket while paused shows the red dot at once (state is applied
      // eagerly) and the row in its correct place in the log on resume.
      renderLogFrame(pane, { t: "status", state: "failed", detail: "connection closed" });
    }
  });
}

// Initial load - if unauthenticated, /api/repos 401s and we show login.
loadRepos().catch(() => showLogin());
