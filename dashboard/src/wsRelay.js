// wsRelay.js - the dashboard's own WebSocket server, browser <-> backend.
// One gatewayClient.subscribe() per active sessionKey, fanned out to
// however many browser tabs are watching that same run - so multiple
// tabs can watch one run, and a page refresh mid-run can reconnect and
// replay what it missed instead of losing the view entirely.

const { WebSocketServer } = require("ws");
const url = require("node:url");

const gatewayClient = require("./gatewayClient");
const { sessionMiddleware } = require("./auth");
const { resolveSessionEntry } = require("./routes/sessions");

// The upgrade path this relay owns. Exported so server.js can build its
// "known paths" set from the relays themselves rather than repeating the
// literals - a path added here can't then be forgotten there.
const WS_PATH = "/ws";

const EVENT_BUFFER_TTL_MS = 15 * 60 * 1000; // sweep completed/failed runs after 15m
// A long-lived session (many turns, tool calls, or a session.message
// snapshot re-sent as it grows - see pushSnapshotDiff's own comments on
// how large a single cumulative snapshot frame can get) had no cap on how
// much this buffer could accumulate: getOrCreateRun only makes a FRESH run
// object for a sessionKey it hasn't seen before, so a session with many
// follow-up turns keeps growing the SAME eventBuffer across all of them
// until the 15m idle-sweep above finally deletes it - an unbounded, purely
// time-gated leak. 5MB is comfortably above what a real single run's
// replay-worth-catching-up-on content looks like (this buffer only exists
// so a tab reconnecting mid-run can catch up - chat.history covers
// anything older, see openHistoricalSession in app.js), while keeping
// several concurrent long runs' worth of buffers from adding up to a real
// memory problem.
const EVENT_BUFFER_MAX_BYTES = 5 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 1000;

// sessionKey -> { browserSockets: Set<ws>, eventBuffer: {payload,bytes}[], eventBufferBytes: number, terminal: boolean, lastActivity: number }
const runs = new Map();

function getOrCreateRun(sessionKey) {
  if (!runs.has(sessionKey)) {
    const run = {
      browserSockets: new Set(),
      eventBuffer: [],
      eventBufferBytes: 0,
      terminal: false,
      lastActivity: Date.now(),
    };
    // ONE stable callback per run, created once here and reused for every
    // browser tab that ever connects to this sessionKey - see the
    // connection handler below for why this replaced a fresh closure per
    // connection.
    run.onEvent = (frame) => onGatewayEvent(sessionKey, frame);
    runs.set(sessionKey, run);
  }
  return runs.get(sessionKey);
}

function isTerminalEvent(frame) {
  // Confirmed live 2026-07-24 (client-side fix, public/app.js, same
  // finding applies here identically): payload.status is a SEPARATE,
  // session-level field that only ever shows up as "running" against a
  // real gateway - never "completed"/"failed" - across many real runs, so
  // this always evaluated to false and no run was EVER marked terminal,
  // meaning the sweep below could never clean any of them up (an
  // unbounded eventBuffer leak for every run, for the process's entire
  // lifetime). The actual per-run completion signal is the "lifecycle"
  // stream's own phase:"end", also confirmed live and present on every
  // real run tested.
  return Boolean(
    frame.event === "agent" &&
      frame.payload &&
      frame.payload.stream === "lifecycle" &&
      frame.payload.data &&
      frame.payload.data.phase === "end",
  );
}

function onGatewayEvent(sessionKey, frame) {
  const run = runs.get(sessionKey);
  if (!run) return;
  const entry = { ...frame, receivedAt: Date.now() };
  // Stringified once here and reused both for the live send below and for
  // replay (see the connection handler further down) - previously replay
  // re-stringified every buffered entry on every single new tab
  // connection; storing the payload directly avoids that repeated work too.
  const payload = JSON.stringify(entry);
  const bytes = Buffer.byteLength(payload);
  run.eventBuffer.push({ payload, bytes });
  run.eventBufferBytes += bytes;
  // Evict oldest-first once over the cap - a reconnecting tab catching up
  // cares about the MOST RECENT activity, not the start of a long run (see
  // EVENT_BUFFER_MAX_BYTES's own comment). Keeps at least one entry even
  // if it alone exceeds the cap, rather than leaving replay with nothing.
  while (run.eventBufferBytes > EVENT_BUFFER_MAX_BYTES && run.eventBuffer.length > 1) {
    const evicted = run.eventBuffer.shift();
    run.eventBufferBytes -= evicted.bytes;
  }
  run.lastActivity = Date.now();
  if (isTerminalEvent(frame)) run.terminal = true;
  for (const ws of run.browserSockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionKey, run] of runs) {
    if (
      run.terminal &&
      run.browserSockets.size === 0 &&
      now - run.lastActivity > EVENT_BUFFER_TTL_MS
    ) {
      runs.delete(sessionKey);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    // Return, do NOT destroy, on a path this relay doesn't own.
    //
    // Node invokes EVERY "upgrade" listener, and this used to destroy the
    // socket for any path but /ws - which made a second listener
    // impossible: whichever handler ran first killed the socket out from
    // under the other, so /ws/logs (logsRelay.js) could never have worked
    // no matter what order they were attached in.
    //
    // Refusing an unrecognised path is now server.js's job, done once
    // after every relay has had its chance to claim one. That has to stay
    // true - if this ever goes back to destroying, logsRelay breaks in a
    // way that looks like an auth or handshake fault rather than a
    // routing one.
    if (pathname !== WS_PATH) return;
    const sessionKey = query.sessionKey;
    if (!sessionKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    // Set by app.js's openSocket() when the caller (openHistoricalSession)
    // has ALREADY rendered this session's complete past content via a
    // static chat.history-based replay - see the connection handler below.
    const skipEventReplay = query.skipReplay === "1";

    // Run the same session middleware used for HTTP routes directly
    // against the raw upgrade request - no separate WS auth mechanism,
    // no token in the query string. A fake `res` object is enough since
    // express-session only needs to read/write cookies via req/res, not
    // send a real HTTP response here.
    const fakeRes = { getHeader: () => undefined, setHeader: () => {}, end: () => {} };
    sessionMiddleware(req, fakeRes, async () => {
      if (!req.session || !req.session.authenticated) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      // Confirmed in backend review 2026-07-24: this upgrade used to
      // accept ANY client-supplied sessionKey with no check against what
      // the dashboard itself actually knows about, unlike routes/run.js
      // and routes/sessions.js which both already gate on ownership.
      // Made practically reachable by two other confirmed facts together:
      // sessionKey's format is low-entropy/guessable
      // (agent:<repoKey>-escalation:dashboard-<epoch-ms>), and repoKey
      // values are themselves exposed via GET /api/repos - so anyone
      // holding the one shared dashboard password could enumerate/guess
      // another repo's sessionKey and pull its buffered history plus live
      // stream, independent of the Recents-list feature.
      //
      // Uses routes/sessions.js's own resolveSessionEntry() (local index
      // OR gateway-confirmed membership in a registered repo's own agent
      // roster) rather than the sessionIndex.exists()-only check this used
      // to be - fixed live 2026-07-30: that older check only recognized
      // locally-recorded (dashboard-origin) sessions, so opening a still-
      // running gateway-origin one (a cross-repo xref, or a reviewer
      // session - both surfaced in Recents since 2026-07-29) always 403'd
      // here even though the SAME sessionKey was already legitimately
      // visible and openable for its static history. Same ownership check
      // both call sites now share, instead of two independently-drifting
      // ones. A brand-new dashboard-origin session is still indexed
      // synchronously before /api/run's own response resolves, so this
      // isn't a race against a legitimate caller for that path either.
      let entry;
      try {
        entry = await resolveSessionEntry(sessionKey);
      } catch (err) {
        console.error(`wsRelay: failed to resolve session ownership for ${sessionKey}:`, err.message);
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!entry) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, sessionKey, skipEventReplay);
      });
    });
  });

  wss.on("connection", async (ws, req, sessionKey, skipEventReplay) => {
    const run = getOrCreateRun(sessionKey);
    run.browserSockets.add(ws);
    run.lastActivity = Date.now();
    // Powers closeSocketsForSession() below (called on logout) - express-
    // session always sets this once sessionMiddleware has run, regardless
    // of auth state.
    ws.__sessionID = req.sessionID;

    let closed = false;
    ws.on("close", () => {
      closed = true;
      run.browserSockets.delete(ws);
      // Only actually unsubscribe once NO tab is watching this run
      // anymore - same run.onEvent reference regardless of how many tabs
      // were ever connected, so this is safe to call even while other
      // tabs remain (their registration is the same single Set entry,
      // untouched by another tab's unsubscribe).
      if (run.browserSockets.size === 0) {
        gatewayClient.unsubscribe(sessionKey, run.onEvent);
      }
    });
    // Registered immediately, before the replay/subscribe below - confirmed
    // in backend review 2026-07-24 that this browser-facing socket had NO
    // 'error' listener anywhere. Node's EventEmitter throws when 'error'
    // has no listener, and `ws` emits it for a malformed/oversized/invalid-
    // UTF8 frame - an ordinary flaky connection from ANY one browser tab,
    // no malicious intent required, could crash the entire dashboard
    // process, taking down every tab and every in-flight run with it.
    // Mirrors gatewayClient.js's own ws.on("error", ...) for the upstream
    // Gateway connection, which already had this.
    ws.on("error", (err) => {
      console.error(`wsRelay: browser socket error (session ${sessionKey}):`, err.message);
    });

    // Replay whatever already happened before this socket connected - was
    // meant to cover a tab joining an already-active run mid-stream (a
    // page refresh, or a second tab), but replayed UNCONDITIONALLY to
    // every new connection regardless of whether the caller had any need
    // for it. app.js's openHistoricalSession() ALWAYS does its own
    // chat.history-based static replay of a session's complete past
    // content before reopening a live socket on it - so replaying the
    // buffer here too meant that already-finished, already-fully-shown
    // content got re-sent as if newly live, and re-animated itself
    // through the client's reveal-queue typewriter effect on every single
    // revisit. Confirmed live 2026-07-24 ("the final responses is being
    // streamed again when it shouldn't"). skipEventReplay (set by
    // openSocket's caller - see app.js) opts out of exactly that
    // already-covered case, while leaving the original "catch up a
    // genuinely still-active run" behavior intact for a caller that
    // hasn't already replayed the history itself (startStream's brand-new
    // sessions have an empty buffer anyway, so this is a no-op for them
    // either way).
    if (!skipEventReplay) {
      for (const buffered of run.eventBuffer) {
        if (closed) break;
        ws.send(buffered.payload);
      }
    }

    // ONE stable callback per run (run.onEvent, created once in
    // getOrCreateRun), reused across however many browser tabs connect to
    // it. gatewayClient.subscribe() already no-ops the underlying RPC call
    // past the first subscriber (see its own internal has() guard), and
    // Set#add() of an already-present reference is likewise a harmless
    // no-op - so calling this on every connection is safe, and simpler
    // than separately tracking "is this the first tab for this run".
    // This replaces a PREVIOUS design that created a brand-new closure on
    // every single connection: each one was added to gatewayClient's
    // subscriptions Set as a genuinely distinct entry (Sets only dedupe by
    // reference, and every closure is a new reference), so a run watched
    // across N connections (N tabs, or N reconnects of the same tab, e.g.
    // navigating to another conversation and back) had every real gateway
    // event fanned out N times over - each of those N onEvent calls
    // separately re-iterating the FULL browserSockets set and re-sending
    // to every one of them. True duplicated delivery, not just a display
    // glitch - confirmed as a real contributor to "replied 3 times",
    // 2026-07-24.
    //
    // Skipped entirely if the socket already closed during the replay
    // above - confirmed in backend review 2026-07-24 that ws.on("close")
    // used to be registered only AFTER this await resolved, so a browser
    // disconnecting (impatient navigation, tab close, network drop) while
    // this was pending left its `ws` permanently stuck in
    // run.browserSockets with no listener ever cleaning it up - the
    // periodic sweep above requires browserSockets.size === 0, which
    // could then never be reached, leaking the run's Map entry and its
    // full eventBuffer for the process's lifetime, and never calling
    // gatewayClient.unsubscribe either.
    if (!closed) {
      try {
        await gatewayClient.subscribe(sessionKey, run.onEvent);
      } catch (err) {
        if (!closed) {
          ws.send(
            JSON.stringify({
              type: "event",
              event: "dashboard.error",
              payload: { message: `failed to subscribe: ${err.message}` },
            }),
          );
        }
      }
    }
  });

  return wss;
}

// Closes every currently-open browser socket belonging to a given
// express-session ID - wired up to auth.js's logout hook (see server.js)
// rather than required directly here, to avoid a circular require
// (auth.js already required above). Confirmed in backend review
// 2026-07-24: /ws auth is checked ONLY at upgrade time, and the socket is
// designed to stay open indefinitely (per this file's own event-buffer
// comments) - neither POST /api/logout nor the 12h cookie maxAge
// expiring affected any already-open /ws connection, so a background tab
// left open on a live run kept receiving events indefinitely past
// logout, on a dashboard whose whole security model is the one shared
// password.
function closeSocketsForSession(sessionID) {
  for (const run of runs.values()) {
    for (const ws of run.browserSockets) {
      if (ws.__sessionID === sessionID) ws.close();
    }
  }
}

module.exports = { attach, closeSocketsForSession, WS_PATH };
