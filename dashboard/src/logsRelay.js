// logsRelay.js - the browser <-> logStream WebSocket channel for the
// Monitoring view. Phase 2 of docs/monitoring-live-logs.md.
//
// Separate from wsRelay.js rather than folded into it. They look similar
// from a distance (both fan a backend subscription out to browser sockets)
// but share no state and no upstream: wsRelay is keyed on a gateway
// sessionKey and speaks the Gateway's frame protocol, while this is keyed on
// a registry repoKey and speaks logStream's much smaller line/status/
// reattach/throttled protocol. Merging them would mean one module with two
// unrelated lifecycles and two unrelated auth checks.
//
// What IS shared, deliberately, is the auth approach: the same
// sessionMiddleware run against the raw upgrade request, so a log socket is
// gated by exactly the same session as the HTTP API. No second auth
// mechanism, no token in the query string.

const { WebSocketServer } = require("ws");
const url = require("node:url");

const { sessionMiddleware } = require("./auth");
const registry = require("./registry");
const logStream = require("./logStream");

// Owned upgrade path. Exported so server.js can build its known-paths set
// from the relays themselves - see wsRelay.js's WS_PATH for the same note.
const WS_PATH = "/ws/logs";

// Every socket currently streaming, so logout can close them (see
// closeSocketsForSession). A Set, not a Map keyed by repoKey: two sockets on
// one workload are independent subscribers, and logStream already handles
// the sharing underneath.
const sockets = new Set();

// If a browser stops reading (a backgrounded tab, a slow link), `ws.send`
// keeps queueing in memory. logStream's own rate limit bounds lines per
// second but not this socket's backlog, so a chatty workload plus one stalled
// client is still an unbounded buffer on the server.
//
// Over this, frames are DROPPED rather than queued, and the drop is reported
// through the same `throttled` frame the rate limiter uses - so a pane that
// falls behind says so in the one place the operator is already reading, and
// converges once the client catches up. 1MB is well above a normal burst and
// well below anything that matters against the dashboard's footprint.
const MAX_BUFFERED_BYTES = 1024 * 1024;

function refuse(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

// Send a single frame and close cleanly. Used for the two cases that are
// worth ACCEPTING the upgrade for and then failing: they carry a reason the
// pane should render, and a refused upgrade gives the browser nothing but an
// opaque handshake error with no body it can read.
function failAndClose(ws, detail) {
  try {
    ws.send(JSON.stringify({ t: "status", ts: new Date().toISOString(), state: "failed", detail }));
  } catch {
    // Socket already gone - nothing to report to.
  }
  ws.close();
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    // Not ours - leave the socket alone for another relay, or for
    // server.js's catch-all to refuse. Never destroy here: see wsRelay.js's
    // matching comment for the bug that causes.
    if (pathname !== WS_PATH) return;

    const repoKey = query.repoKey;
    if (!repoKey) {
      refuse(socket, 400, "Bad Request");
      return;
    }

    const fakeRes = { getHeader: () => undefined, setHeader: () => {}, end: () => {} };
    sessionMiddleware(req, fakeRes, () => {
      if (!req.session || !req.session.authenticated) {
        refuse(socket, 401, "Unauthorized");
        return;
      }

      // Ownership, resolved SERVER-SIDE from the registry. The namespace and
      // selector a stream runs with are never taken from the client: the
      // dashboard password is shared, so an authenticated socket is not by
      // itself authorised to name an arbitrary target, and a client-supplied
      // selector would be a way to point kubectl at any workload in the
      // cluster. Same reasoning wsRelay's own ownership gate was added for
      // on 2026-07-30, applied before the mistake rather than after.
      let target;
      try {
        target = registry.getRuntimeTarget(repoKey);
      } catch (err) {
        console.error(`logsRelay: failed to read registry for ${repoKey}:`, err.message);
        refuse(socket, 502, "Bad Gateway");
        return;
      }
      if (!target) {
        refuse(socket, 403, "Forbidden");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, target);
      });
    });
  });

  wss.on("connection", (ws, req, target) => {
    // Registered FIRST, before anything that can throw or send. `ws` emits
    // "error" for an ordinary malformed or oversized frame from any flaky
    // client, and Node's EventEmitter THROWS when "error" has no listener -
    // which would take down the whole dashboard process, every open pane and
    // every in-flight agent run with it. wsRelay.js was found missing exactly
    // this in review on 2026-07-24; not repeating it here.
    ws.on("error", (err) => {
      console.error(`logsRelay: browser socket error (${target.repoKey}):`, err.message);
    });

    // Set by express-session once sessionMiddleware has run, regardless of
    // auth state. Powers closeSocketsForSession below.
    ws.__sessionID = req.sessionID;
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));

    if (!target.streamable) {
      failAndClose(ws, target.unstreamableReason || "this workload cannot be log-streamed");
      return;
    }

    let dropped = 0;
    let lastDropReport = 0;

    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      // Backpressure: drop rather than queue behind a client that isn't
      // reading. Status and reattach frames are exempt - they are rare, they
      // are what tells the pane it is dead or recovering, and dropping one
      // is how a pane ends up silently wrong.
      if (frame.t === "line" && ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        dropped += 1;
        const now = Date.now();
        if (now - lastDropReport >= 1000) {
          lastDropReport = now;
          const n = dropped;
          dropped = 0;
          try {
            ws.send(JSON.stringify({ t: "throttled", ts: new Date().toISOString(), dropped: n }));
          } catch {
            // Nothing useful to do - the close handler will clean up.
          }
        }
        return;
      }
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        console.error(`logsRelay: send failed (${target.repoKey}):`, err.message);
      }
    };

    let unsubscribe;
    try {
      unsubscribe = logStream.subscribe(
        {
          repoKey: target.repoKey,
          namespace: target.namespace,
          labelSelector: target.labelSelector,
        },
        { onLine: send, onControl: send },
      );
    } catch (err) {
      // STREAM_LIMIT is the expected one: every other pane is already
      // streaming. Accepted-then-failed rather than refused at handshake so
      // the pane can render the actual limit message instead of a bare
      // connection error - GET /api/monitoring/targets reports the same
      // ceiling, so the UI can explain it in the operator's own terms.
      failAndClose(ws, err.message);
      return;
    }

    // The stream outlives no socket: last unsubscribe tears the child down
    // AND issues the remote reap. This close handler is therefore the entire
    // orphan guard on the browser side - if it stops firing, sandbox-side
    // kubectl processes accumulate (bounded only by logStream's timeout cap).
    ws.on("close", () => {
      unsubscribe();
    });
  });

  return wss;
}

// Closes every open log socket belonging to an express-session ID, wired to
// auth.js's logout hook by server.js.
//
// Not optional: auth here is checked ONLY at upgrade time and these sockets
// are designed to stay open indefinitely, so without this a backgrounded tab
// keeps streaming production logs long after logout - on a dashboard whose
// entire security model is one shared password. wsRelay.js needed the same
// fix for the same reason; this feature would have reintroduced the hole on
// a new channel.
//
// Closing the socket is enough to stop the stream: the close handler above
// unsubscribes, and logStream tears the child down on the last unsubscribe.
function closeSocketsForSession(sessionID) {
  for (const ws of sockets) {
    if (ws.__sessionID === sessionID) ws.close();
  }
}

module.exports = { attach, closeSocketsForSession, WS_PATH, MAX_BUFFERED_BYTES };
