// routes/run.js - POST /api/run {repoKey, message, sessionKey?} -> {sessionKey}.
// Sends a message to a repo's escalation agent directly via the Gateway,
// with deliver:false - the dashboard is the operator's real-time interface
// into these agents, so a run's output is read here, not pushed anywhere
// else. Always targets the escalation agent - reviewer isn't
// user-selectable from this dashboard, it's an internal second opinion the
// escalation agent's own protocol calls on its own.
//
// Optional `sessionKey` continues an existing conversation instead of
// starting a new one - the agent's own conversational memory already
// lives on the Gateway side per session, so "continuing" is just reusing
// the same key on a later chat.send rather than anything the dashboard
// itself needs to persist. Must match this exact repoKey's session-key
// shape (see expectedPrefix below) - a client-supplied key isn't trusted
// blindly, since this endpoint is reachable from the open internet.

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("../auth");
const registry = require("../registry");
const gatewayClient = require("../gatewayClient");
const sessionIndex = require("../sessionIndex");

const router = express.Router();

// Every successful call now also does a synchronous read-modify-write of
// the session index file (sessionIndex.js) on top of the Gateway
// round-trip - reviewed 2026-07-24: cheap individually (a small capped
// JSON file) but genuinely new per-request disk I/O on a route that had
// none before, in the same process that also runs wsRelay.js's WS fan-out
// for every other browser tab watching a live run. Rate-limited the same
// way /api/login already is, rather than leaving it the one authenticated
// route with no bound at all.
const runLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, slow down" },
});

router.post(
  "/api/run",
  requireAuth,
  runLimiter,
  express.json({ limit: "256kb" }), // ordinary input hygiene - NOT prompt-agent.sh's
  // 32000-byte figure, which is about nemoclaw exec's argv and doesn't
  // apply here at all (this is a JSON payload over an existing WS
  // connection to the gateway, not a subprocess argument).
  async (req, res) => {
    const { repoKey, message, sessionKey: continueSessionKey } = req.body || {};

    // registry.repoExists() reads registry/repos.json synchronously off
    // disk - a file register-repo.sh/toggle-repo.sh/deregister-repo.sh
    // actively rewrite while this process runs. A read landing mid-write
    // throws (invalid JSON mid-write), and since this call used to sit
    // outside any try/catch, that throw became an unhandled rejection in
    // this async handler (Express 4 doesn't catch those itself, and this
    // process has no global unhandledRejection handler) - crashing the
    // entire dashboard process over one unluckily-timed request, taking
    // down every other active session with it. Every other registry.js
    // call site in this repo already wraps it in a try/catch; this was the
    // one exception.
    let repoIsKnown;
    try {
      repoIsKnown = Boolean(repoKey) && registry.repoExists(repoKey);
    } catch (err) {
      console.error("routes/run: failed to check repo registry:", err.message);
      return res.status(502).json({ error: "failed to verify repo registry, try again" });
    }
    if (!repoIsKnown) {
      return res.status(400).json({ error: `unknown repoKey '${repoKey}'` });
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const role = "escalation";
    const agent = `${repoKey}-${role}`;
    // 'dashboard-' prefix, distinct from prompt-agent.sh's 'manual-' -
    // so anyone reading session-key logs later can immediately tell a
    // run originated from the dashboard vs. a manual CLI invocation vs.
    // a watcher escalation. Directly serves this project's whole
    // motivation: fixing attribution confusion.
    const expectedPrefix = `agent:${agent}:dashboard-`;
    let sessionKey;
    let isNewSession;
    if (continueSessionKey) {
      if (
        typeof continueSessionKey !== "string" ||
        !continueSessionKey.startsWith(expectedPrefix)
      ) {
        return res.status(400).json({ error: "sessionKey does not match repoKey" });
      }
      sessionKey = continueSessionKey;
      isNewSession = false;
    } else {
      sessionKey = `${expectedPrefix}${Date.now()}`;
      isNewSession = true;
    }

    try {
      // Only meaningful for a brand-new session - see the comment above
      // chat.send below for why this stays best-effort regardless.
      if (isNewSession) {
        // Confirmed live 2026-07-23 that chat.send works fine even when
        // sessions.create fails/is skipped (the gateway creates the session
        // implicitly) - so this stays best-effort and non-blocking. Field
        // names updated to agentId/key based on the hello-ok snapshot's own
        // agent list (which uses "agentId", not "agent") and the same
        // key-not-sessionKey pattern confirmed on sessions.messages.subscribe -
        // still unconfirmed whether sessions.create itself accepts these
        // exact names, since it was never seen actually succeed.
        try {
          await gatewayClient.call("sessions.create", {
            agentId: agent,
            key: sessionKey,
          });
        } catch (err) {
          console.warn(
            `routes/run: sessions.create failed (continuing - may be ` +
              `expected if the gateway creates sessions implicitly): ${err.message}`,
          );
        }
      }

      // idempotencyKey is required (confirmed live 2026-07-23:
      // "must have required property 'idempotencyKey'"), and deliver:false
      // is explicit rather than assumed-default - matches NemoClaw's own
      // e2e test suite's exact chat.send shape, and reinforces that
      // dashboard-originated runs deliberately skip channel delivery.
      //
      // augmentedMessage (not the plain `message`) is what actually reaches
      // the agent - appends the same "your session_key is X" note every
      // watcher-triggered escalation's own prompt already carries (see
      // templates/watcher-{docker,k8s}.sh.tmpl), so a fix the agent starts
      // mid-conversation with a human can ALSO record a real session_key
      // in its Stage 2 tracker entry (see TOOLS.md.tmpl) - without this, a
      // dashboard-originated fix's stage-tracker widget would have no
      // working "Open conversation" link once the user navigates away and
      // comes back. Kept out of the plain `message` used below for
      // sessionIndex.record() deliberately - that's what actually renders
      // as the user's own chat bubble/Recents label, and this note isn't
      // something the user typed.
      const augmentedMessage = `${message}\n\nYour session_key for this incident, to record verbatim in the Stage 2 tracker entry (see TOOLS.md's Stage 2 jq write - there is no other way for you to know this value, nothing in your environment exposes it): ${sessionKey}`;
      await gatewayClient.call("chat.send", {
        sessionKey,
        message: augmentedMessage,
        deliver: false,
        timeoutMs: 90_000,
        idempotencyKey: crypto.randomUUID(),
      });

      // Best-effort, not blocking on the response - the Recents list is a
      // convenience index, not something a real run should ever fail on.
      try {
        sessionIndex.record({ sessionKey, repoKey, message });
      } catch (err) {
        console.warn("routes/run: sessionIndex.record failed:", err.message);
      }

      res.json({ sessionKey });
    } catch (err) {
      console.error("routes/run: failed to start run:", err.message);
      res.status(502).json({ error: `failed to start run: ${err.message}` });
    }
  },
);

module.exports = router;
