// Standalone test for routes/ops.js's parsePilotStateDump() - no framework,
// run directly with `node test/opsPilotStateDump.test.js` (this project has
// no test runner dependency by deliberate v1 design, see README.md).
//
// This is the parser behind GET /api/ops/stages, the cross-repo view the
// Ops modal's Fixes tab reads. It exists because reading 14 repos' trackers
// as 28 separate `docker exec cat` calls was not worth it: one exec dumps
// every file with a marker line in front of each, and this splits it back
// apart. The marker convention is the whole risk surface, so it's what's
// tested here.

const assert = require("node:assert");
const path = require("node:path");

process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8792";

const { parsePilotStateDump } = require(path.join(__dirname, "..", "src", "routes", "ops.js"));

// --- The real shape: two repos, each with a tracker, one of them with a
// denials file too. ---
{
  const stdout = [
    "===FILE:api-rag-escalation-stages.json===",
    "{",
    '  "fix/slow-rerank": {',
    '    "incident": "rerank batch timeout",',
    '    "stage": 4',
    "  }",
    "}",
    "",
    "===FILE:api-rag-escalation-denials.json===",
    '{"fix/old-thing": {"denied_at": "2026-08-05T00:00:00Z"}}',
    "",
    "===FILE:svc-core-escalation-stages.json===",
    '{"fix/npe": {"stage": 1}}',
    "",
  ].join("\n");

  const files = parsePilotStateDump(stdout);
  assert.strictEqual(files.size, 3, "every dumped file must come back out");

  const fixes = JSON.parse(files.get("api-rag-escalation-stages.json"));
  assert.strictEqual(fixes["fix/slow-rerank"].stage, 4, "a pretty-printed multi-line tracker must survive the split");

  const denials = JSON.parse(files.get("api-rag-escalation-denials.json"));
  assert.ok(denials["fix/old-thing"], "denials file must be parsed independently of its repo's tracker");

  const core = JSON.parse(files.get("svc-core-escalation-stages.json"));
  assert.strictEqual(core["fix/npe"].stage, 1, "a second repo's tracker must not bleed into the first's");

  console.log("PASS: a realistic multi-repo dump splits back into per-file JSON");
}

// --- Empty state directory: `for` over globs that match nothing emits no
// output at all. Must be an empty map, not a throw - "no repo has an
// in-flight fix" is the normal quiet case, not an error. ---
{
  assert.strictEqual(parsePilotStateDump("").size, 0, "no output means no files, not a crash");
  assert.strictEqual(parsePilotStateDump("\n").size, 0, "a lone newline means no files either");
  console.log("PASS: an empty dump degrades to an empty map");
}

// --- Content that LOOKS like a marker. The files are written by
// JSON.stringify, which escapes newlines inside strings, so a value can
// never start a line - this asserts that property holds rather than
// assuming it: the marker-looking text stays inside the value it belongs
// to and does not open a phantom file.
{
  const incident = "===FILE:evil.json=== injected";
  const stdout = [
    "===FILE:api-rag-escalation-stages.json===",
    JSON.stringify({ "fix/x": { incident, stage: 2 } }, null, 2),
    "",
  ].join("\n");

  const files = parsePilotStateDump(stdout);
  assert.strictEqual(files.size, 1, "marker-looking text inside a JSON value must not open a second file");
  assert.strictEqual(
    JSON.parse(files.get("api-rag-escalation-stages.json"))["fix/x"].incident,
    incident,
    "the value must come back through intact",
  );
  console.log("PASS: agent-authored text resembling a marker cannot forge a file boundary");
}

// --- Leading noise before the first marker is dropped rather than
// misattributed. Nothing should print it today, but silently prepending
// stray container output to whichever repo happens to be first is exactly
// the failure that would be hardest to notice. ---
{
  const stdout = ["some unexpected stderr-ish line", "===FILE:api-rag-escalation-stages.json===", "{}", ""].join("\n");
  const files = parsePilotStateDump(stdout);
  assert.deepStrictEqual([...files.keys()], ["api-rag-escalation-stages.json"], "only real files are keyed");
  assert.deepStrictEqual(
    JSON.parse(files.get("api-rag-escalation-stages.json")),
    {},
    "pre-marker noise must not be prepended to the first file",
  );
  console.log("PASS: output before the first marker is discarded, not misattributed");
}

console.log("\nALL TESTS PASSED");
