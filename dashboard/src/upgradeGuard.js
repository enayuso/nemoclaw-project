// upgradeGuard.js - refuse any WebSocket upgrade that no relay claimed.
//
// Six lines in its own module for one reason: server.js cannot be required
// from a test (config.js exits the process on any machine that isn't Server
// 6), so a catch-all written inline there could only ever be covered by a
// test that reimplemented it - and a test asserting against its own copy of
// the logic passes happily while the real thing drifts. This way both call
// the same function.
//
// Why a catch-all is needed at all: Node invokes EVERY "upgrade" listener,
// so no individual relay can destroy sockets for paths it doesn't own
// without killing the others' connections out from under them (see
// wsRelay.js's own comment on the bug that caused). Each relay therefore
// returns silently on a foreign path - which leaves nobody at all refusing a
// path that belongs to no relay. That is not harmless: the client gets no
// response and the socket sits open until some timeout elsewhere reaps it.

const url = require("node:url");

/**
 * Attach the catch-all. MUST be called AFTER every relay's own attach(), so
 * each has already had its chance to claim the upgrade.
 *
 * paths: the set of pathnames the relays own. Build it from the relays'
 * exported WS_PATH constants rather than string literals, so adding a relay
 * cannot leave its path silently refused here.
 */
function attachCatchAll(server, paths) {
  const known = paths instanceof Set ? paths : new Set(paths);
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    if (known.has(pathname)) return; // claimed by a relay attached earlier
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });
}

module.exports = { attachCatchAll };
