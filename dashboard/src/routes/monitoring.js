// routes/monitoring.js - GET /api/monitoring/targets, the workload list
// behind the Monitoring view's pane picker. Phase 3 of
// docs/monitoring-live-logs.md.
//
// Read-only and deliberately thin: it reports what the registry says and what
// limits logStream enforces, and it starts no stream. Streams are opened over
// the WS channel (phase 2, /ws/logs), not here - `kubectl logs -f` never
// exits, so there is nothing an HTTP request/response pair can usefully do
// with one.
//
// The one thing worth stating plainly, since this endpoint hands the browser
// a namespace and a label selector: those values are informational for the
// picker only. The stream's own namespace and selector must be resolved
// server-side from the registry by repoKey at upgrade time (see
// registry.getRuntimeTarget's comment). The dashboard password is shared, so
// an authenticated client is not by itself authorised to name an arbitrary
// target - if phase 2 ever builds a kubectl invocation out of what a client
// posted, that ownership check is what was lost.

const express = require("express");
const { requireAuth } = require("../auth");
const registry = require("../registry");
const logStream = require("../logStream");

const router = express.Router();

router.get("/api/monitoring/targets", requireAuth, (req, res) => {
  try {
    const targets = registry.listRuntimeTargets();
    res.json({
      targets,
      // So the UI can explain a refusal in the operator's own terms rather
      // than surfacing a bare error: maxConcurrentStreams is what a
      // STREAM_LIMIT rejection means, and streamTimeoutSeconds is the
      // reattach cadence, which is why a healthy pane shows a periodic
      // reattach divider. Read from logStream rather than restated here, so
      // the two cannot drift.
      limits: {
        maxConcurrentStreams: logStream._constants.MAX_CONCURRENT_STREAMS,
        streamTimeoutSeconds: logStream._constants.STREAM_TIMEOUT_SECONDS,
      },
      activeStreams: logStream.activeStreamCount(),
    });
  } catch (err) {
    // Matches routes/repos.js: the registry is a file on disk, and a parse
    // error or a bad path is a server fault, not a client one.
    console.error("routes/monitoring: failed to read registry:", err.message);
    res.status(500).json({ error: "failed to read registry" });
  }
});

module.exports = router;
