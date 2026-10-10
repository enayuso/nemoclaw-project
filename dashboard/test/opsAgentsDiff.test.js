// Standalone test for routes/ops.js's computeMissingAgents() - no framework,
// run directly with `node test/opsAgentsDiff.test.js` (this project has no
// test runner dependency by deliberate v1 design, see README.md).
//
// This is the diff that would have caught 2026-08-03's real incident (all
// 14 escalation/reviewer agents silently missing from the live gateway
// after a host reboot recreated the sandbox container) automatically,
// instead of on the next failed dashboard run - see routes/ops.js's own
// comment on GET /api/ops/agents.

const assert = require("node:assert");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8791";

const { computeMissingAgents } = require(path.join(__dirname, "..", "src", "routes", "ops.js"));

const REPOS = [
  { repoKey: "api-rag", escalationAgent: "api-rag-escalation", reviewerAgent: "api-rag-reviewer" },
  { repoKey: "svc-core", escalationAgent: "svc-core-escalation", reviewerAgent: "svc-core-reviewer" },
];

// --- Fully healthy roster: nothing missing. ---
{
  const liveAgents = [
    { id: "main" },
    { id: "api-rag-escalation" },
    { id: "api-rag-reviewer" },
    { id: "svc-core-escalation" },
    { id: "svc-core-reviewer" },
  ];
  const missing = computeMissingAgents(liveAgents, REPOS);
  assert.deepStrictEqual(missing, [], "a fully healthy roster must report nothing missing");
  console.log("PASS: healthy roster reports no missing agents");
}

// --- Reproduces 2026-08-03's real incident: only the built-in default
// agent survives a container recreation, every registered repo's pair is
// gone. ---
{
  const liveAgents = [{ id: "main" }];
  const missing = computeMissingAgents(liveAgents, REPOS);
  assert.deepStrictEqual(
    missing,
    ["api-rag-escalation", "api-rag-reviewer", "svc-core-escalation", "svc-core-reviewer"],
    "a roster reduced to just the default agent must report every registered repo's pair as missing",
  );
  console.log("PASS: reproduces the real 2026-08-03 incident - only 'main' surviving flags every repo's agents");
}

// --- Partial gap: only one repo's reviewer is missing, everything else
// intact - must not over-report the other three agents as missing too. ---
{
  const liveAgents = [
    { id: "main" },
    { id: "api-rag-escalation" },
    { id: "api-rag-reviewer" },
    { id: "svc-core-escalation" },
    // svc-core-reviewer deliberately absent
  ];
  const missing = computeMissingAgents(liveAgents, REPOS);
  assert.deepStrictEqual(missing, ["svc-core-reviewer"], "only the one genuinely-missing agent must be reported");
  console.log("PASS: a partial gap (one agent) doesn't over-report the rest as missing");
}

// --- No registered repos at all: must degrade to an empty result, not
// throw - matches routes/ops.js's own registry.listRepos() failure
// fallback (repos = []). ---
{
  const missing = computeMissingAgents([{ id: "main" }], []);
  assert.deepStrictEqual(missing, [], "no registered repos means nothing to check, not an error");
  console.log("PASS: no registered repos degrades to an empty missing list, not a crash");
}

console.log("\nALL TESTS PASSED");
