// server.js - entrypoint. Wires up Express (static frontend + API
// routes), the session middleware, the WS relay, and the one persistent
// Gateway connection.

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const express = require("express");

const config = require("./src/config"); // validates .env and exits early if incomplete
const auth = require("./src/auth");
const reposRouter = require("./src/routes/repos");
const runRouter = require("./src/routes/run");
const sessionsRouter = require("./src/routes/sessions");
const modelInfoRouter = require("./src/routes/modelInfo");
const opsRouter = require("./src/routes/ops");
const monitoringRouter = require("./src/routes/monitoring");
const wsRelay = require("./src/wsRelay");
const logsRelay = require("./src/logsRelay");
const upgradeGuard = require("./src/upgradeGuard");
const gatewayClient = require("./src/gatewayClient");

const app = express();

app.use(auth.sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

// Vendored client-side markdown rendering (transcript/thinking text arrives
// as Markdown - see public/app.js's renderMarkdownToSafeHtml()). Served as
// two exact files rather than mounting the whole node_modules tree, and
// unauthenticated like the rest of public/ - these are just open-source
// library code, nothing sensitive.
app.get("/vendor/marked.umd.js", (req, res) => {
  res.sendFile(path.join(__dirname, "node_modules/marked/lib/marked.umd.js"));
});
app.get("/vendor/purify.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "node_modules/dompurify/dist/purify.min.js"));
});

app.use(auth.router);
app.use(reposRouter);
app.use(runRouter);
app.use(sessionsRouter);
app.use(modelInfoRouter);
app.use(opsRouter);
app.use(monitoringRouter);

// Catch-all error handler - MUST be registered last (Express only invokes
// a 4-arg middleware for errors, and only ones registered after the route
// that threw). Confirmed live 2026-07-30: with none of this and NODE_ENV
// never set anywhere in this deploy (checked .env.example, this systemd
// unit, every src/*.js), Express defaulted to development mode and
// returned a full stack trace with real filesystem paths on ANY error -
// including a malformed-JSON or oversized POST to /api/login, reachable
// by anyone on the open internet with zero credentials, since the body
// parser runs before the auth check. Beyond the disclosure, every
// frontend fetch() expects {error:"..."} JSON back (see app.js's own
// res.json() calls) and got an HTML stack-trace page instead - a user
// pasting a log over the 256KB composer limit saw a cryptic
// "Unexpected token '&lt;'" instead of a real "message too long" error.
//
// Preserves whatever status code the error already carries (e.g.
// express.json()'s own 400 for bad JSON, 413 for over the size limit)
// rather than flattening everything to 500, and passes the real message
// through for those - it's the client's own malformed request, safe and
// useful to explain. A genuine 500 gets a generic message instead; the
// real error still goes to the server's own log via console.error.
app.use((err, req, res, next) => {
  console.error(`server: unhandled error on ${req.method} ${req.path}:`, err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? "internal error" : err.message });
});

const server = config.useTls
  ? https.createServer(
      {
        key: fs.readFileSync(config.tlsKeyPath),
        cert: fs.readFileSync(config.tlsCertPath),
      },
      app,
    )
  : http.createServer(app);

wsRelay.attach(server);
logsRelay.attach(server);

// Refuse any upgrade no relay claimed - MUST stay after every attach()
// above, so each relay has already had its chance to take the socket. The
// path set is built FROM the relays rather than written out here, so adding
// a relay cannot leave its own path silently refused. See upgradeGuard.js
// for why this is a shared function rather than an inline handler.
upgradeGuard.attachCatchAll(server, new Set([wsRelay.WS_PATH, logsRelay.WS_PATH]));

// Both relays hold sockets authenticated at upgrade time only, and both are
// designed to stay open indefinitely - so both have to be closed on logout,
// or a backgrounded tab keeps streaming past it. setLogoutHook holds a
// single function, hence the composite rather than two calls (the second
// would silently replace the first).
auth.setLogoutHook((sessionID) => {
  wsRelay.closeSocketsForSession(sessionID);
  logsRelay.closeSocketsForSession(sessionID);
});

gatewayClient.connect().catch((err) => {
  console.error(
    "server: initial gateway connection failed - will keep retrying in " +
      "the background. /api/run will fail until this succeeds:",
    err.message,
  );
});

server.listen(config.port, () => {
  console.log(
    `ops-nemoclaw dashboard listening on ${config.useTls ? "https" : "http"}://0.0.0.0:${config.port}`,
  );
});
