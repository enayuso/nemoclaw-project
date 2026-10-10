// auth.js - login/logout, the shared session middleware instance (used by
// both Express routes and wsRelay.js's manual upgrade-time check), and the
// requireAuth guard for everything else.

const crypto = require("node:crypto");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const express = require("express");

const config = require("./config");

// One shared instance - wsRelay.js runs this same middleware directly
// against the raw WS upgrade request before accepting it, so a WS
// connection is gated by the exact same session as the HTTP API. No
// separate WS auth mechanism, no token in the URL/query string.
const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.useTls,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000, // 12h - restart also logs everyone out (in-memory store, known v1 limitation)
  },
});

// Hash both sides to a fixed-length digest before comparing - avoids
// crypto.timingSafeEqual's own footgun (it throws on mismatched buffer
// lengths, which a naive direct comparison of the raw password strings
// would hit constantly since submitted passwords vary in length).
function passwordMatches(submitted) {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const submittedHash = crypto.createHash("sha256").update(submitted).digest();
  const realHash = crypto
    .createHash("sha256")
    .update(config.dashboardPassword)
    .digest();
  return crypto.timingSafeEqual(submittedHash, realHash);
}

// Rate-limited specifically on the login route - non-optional given this
// dashboard is reachable from the open internet behind a single shared
// password (see README.md's Known gotchas).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many login attempts, try again later" },
});

const router = express.Router();

router.post("/api/login", loginLimiter, express.json(), (req, res) => {
  if (passwordMatches(req.body && req.body.password)) {
    // Regenerate the session ID on every successful login (defense in
    // depth against session fixation) - assigns a fresh session ID before
    // marking it authenticated, rather than authenticating whatever ID
    // the request happened to arrive with. Low practical exploitability
    // today (saveUninitialized: false means no pre-auth route currently
    // issues a session cookie, so there's no observed way to plant a
    // fixed ID ahead of time), but cheap to do regardless and it's the
    // standard mitigation for the classic shape of this bug.
    req.session.regenerate((err) => {
      if (err) {
        console.error("auth: session regenerate failed:", err.message);
        return res.status(500).json({ error: "login failed" });
      }
      req.session.authenticated = true;
      res.json({ ok: true });
    });
  } else {
    res.status(401).json({ error: "wrong password" });
  }
});

// Set by server.js once wsRelay.js is attached - not required directly
// here to avoid a circular require (wsRelay.js already requires this
// module for sessionMiddleware). See wsRelay.js's closeSocketsForSession
// for why this exists: /ws auth is only ever checked at upgrade time, so
// without this, logging out never affected an already-open live socket.
let onLogout = () => {};
function setLogoutHook(fn) {
  onLogout = fn;
}

router.post("/api/logout", (req, res) => {
  const sessionID = req.sessionID;
  req.session.destroy(() => {
    onLogout(sessionID);
    res.json({ ok: true });
  });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: "not authenticated" });
}

module.exports = { sessionMiddleware, router, requireAuth, setLogoutHook };
