// routes/modelInfo.js - GET /api/model-info -> {contextWindow}. Backs the
// dashboard's own "% of context used" indicator (public/app.js's
// updateRunStatusTokens) - added 2026-07-28 after a real run hit a
// context-overflow error with zero warning beforehand (see renderFrame's
// lifecycle phase:"error" handling in app.js).
//
// Deliberately returns ONLY contextWindow, never gatewayClient's own raw
// config payload it's derived from - that payload is the gateway's entire
// config file (see getContextWindow's own comment), which can contain
// real secrets. This route is the one place that boundary is enforced.

const express = require("express");
const { requireAuth } = require("../auth");
const gatewayClient = require("../gatewayClient");

const router = express.Router();

router.get("/api/model-info", requireAuth, async (req, res) => {
  try {
    const contextWindow = await gatewayClient.getContextWindow();
    res.json({ contextWindow });
  } catch (err) {
    console.error("routes/modelInfo: failed to fetch context window:", err.message);
    // Best-effort - the frontend just leaves the indicator hidden if this
    // comes back null, same as it does before this ever resolves.
    res.json({ contextWindow: null });
  }
});

// How long to wait on the model server before calling it down. Short on
// purpose: a healthy vLLM answers /models in ~25ms over the LAN, and the
// whole point of this probe is to notice a dead backend FAST. The gateway's
// own inference timeout is 600s (models.providers.inference.timeoutSeconds),
// which is right for a long generation and useless as a liveness signal -
// during the 2026-08-07 outage a run against the dead server would have sat
// there for ten minutes saying nothing.
const MODEL_PROBE_TIMEOUT_MS = 5_000;

// GET /api/model-health -> {ok, reason, endpoint, model}
//
// Added 2026-08-07 after Server 4 (the box serving the inference model) went
// down and the dashboard said nothing at all - there was no surface that
// ever looked at the model backend, only at the gateway in front of it, so a
// dead model was indistinguishable from an idle system.
//
// Probes the provider's own OpenAI-compatible /models listing rather than
// sending a real completion: it's the cheapest call that proves the server
// is up AND has the model loaded, it costs no tokens, and it can't disturb a
// real run. Deliberately sends NO credential - the endpoint answers this
// unauthenticated (confirmed live), so the dashboard never has to hold the
// provider's apiKey to run its own health check.
//
// `endpoint` is host:port only. It's genuinely useful in the banner ("which
// box do I go restart?") and an internal LAN address is not a secret, but
// the scheme/path/userinfo are dropped anyway - see getModelEndpoint().
router.get("/api/model-health", requireAuth, async (req, res) => {
  let baseUrl = null;
  let modelId = null;
  try {
    ({ baseUrl, modelId } = await gatewayClient.getModelEndpoint());
  } catch (err) {
    console.error("routes/modelInfo: could not read model endpoint:", err.message);
    // The gateway itself is unreachable/unparseable. Deliberately NOT
    // reported as a model outage - that's a different failure with a
    // different fix, and claiming "the model is down" here would send
    // someone to reboot the wrong machine.
    return res.json({ ok: null, reason: "gateway-unreachable", endpoint: null, model: null });
  }
  if (!baseUrl) {
    return res.json({ ok: null, reason: "no-endpoint-configured", endpoint: null, model: modelId });
  }

  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return null;
    }
  })();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_PROBE_TIMEOUT_MS);
  try {
    const probe = await fetch(`${baseUrl}/models`, { signal: controller.signal });
    if (!probe.ok) {
      // Reachable but unhealthy. 401/403 is its own case: something IS
      // listening and answering, so the box is up - that's a config problem,
      // not the outage this banner exists for.
      const reason = probe.status === 401 || probe.status === 403 ? "unauthorized" : "http-error";
      return res.json({ ok: false, reason, status: probe.status, endpoint: host, model: modelId });
    }
    const body = await probe.json().catch(() => null);
    const served = body && Array.isArray(body.data) ? body.data.map((m) => m && m.id) : [];
    // Up, but serving something other than what the gateway is configured to
    // call. Worth its own message: the symptom (every run fails) is the same
    // as a dead box, but the fix is completely different.
    if (modelId && served.length && !served.includes(modelId)) {
      return res.json({ ok: false, reason: "model-not-loaded", endpoint: host, model: modelId, served });
    }
    return res.json({ ok: true, reason: null, endpoint: host, model: modelId });
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : "unreachable";
    return res.json({ ok: false, reason, endpoint: host, model: modelId });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
module.exports.MODEL_PROBE_TIMEOUT_MS = MODEL_PROBE_TIMEOUT_MS;
