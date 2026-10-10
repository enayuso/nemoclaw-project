// routes/ops.js - operator-visibility routes: watcher/cron status, the live
// agent roster (cross-referenced against the registry to catch a repo whose
// agents silently vanished - exactly what happened 2026-08-03 after a host
// reboot recreated the sandbox container and wiped /sandbox/.openclaw/agents
// entirely, surfaced only by a failed dashboard run), pending device-pairing
// approvals, and one repo's escalation stage-tracker.
//
// Two different access paths, deliberately:
// - cron.list/agents.list/tasks.list go through gatewayClient.call() (the
//   dashboard's own persistent WS connection) - confirmed live 2026-08-03
//   these three work fine with the dashboard's existing operator.read/
//   operator.write scopes.
// - cron.run, approvals, and the stage-tracker file do NOT: cron.run and
//   device.pair.list both require a scope (operator.admin, operator.pairing
//   respectively) the dashboard's connection was never granted, deliberately
//   - see scripts/lib/set-agent-file.js's own header comment for why
//   operator.admin specifically was never made a standing grant on this
//   connection. The stage-tracker is a raw file inside the sandbox, not a
//   gateway RPC at all. All three instead shell out via the `nemoclaw`
//   CLI/`docker exec` - confirmed live that a raw `docker exec openclaw ...`
//   fails with a device-credentials error the nemoclaw wrapper's own auth
//   context avoids; nemoclaw's own "Active gateway set"/UNDICI noise goes to
//   stderr only, confirmed live, so reading stdout alone is clean JSON.
//
// nemoclaw is invoked by its FULL path, not looked up on PATH - confirmed
// live 2026-08-03 that the nemoclaw-dashboard systemd service's default PATH
// doesn't include ~/.local/bin (unlike an interactive SSH shell, which
// sources .bashrc/.profile), so a bare "nemoclaw" execFile call failed with
// ENOENT the first time this route was actually exercised in production.

const express = require("express");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const path = require("node:path");
const { requireAuth } = require("../auth");
const gatewayClient = require("../gatewayClient");
const registry = require("../registry");
const { resolveSessionEntry, labelsFromRecentMessages } = require("./sessions");
const sessionIndex = require("../sessionIndex");
const { writeSandboxFile } = require("../sandboxFile");

const execFileAsync = promisify(execFile);
const router = express.Router();

// Matches scripts/lib/sandbox-helpers.sh's own container_name() - same
// `docker ps --filter name=openshell-<sandbox>-` convention, ported to
// Node rather than shelling out to the bash function itself. NOTE
// 2026-09-03 (nemoclaw v0.0.103->v0.0.109 / OpenShell 0.0.85->0.0.101
// upgrade): the container naming scheme changed to insert a workload-group
// segment before the sandbox name (observed live: "openshell-default--
// ops-nemoclaw-<uuid>" instead of "openshell-ops-nemoclaw-<uuid>"),
// so the exact-prefix filter below stopped matching anything and every
// route in this file started throwing "sandbox container not found" -
// confirmed live via nemoclaw-dashboard.service's own journal, hours after
// the bash-side twin of this same bug (sandbox-helpers.sh's
// container_name()) had already been fixed the same way. Loosened
// identically here.
const SANDBOX = "ops-nemoclaw";
const NEMOCLAW_BIN = "/home/ops-s006/.local/bin/nemoclaw";
// Required on every nemoclaw invocation, not just interactively - confirmed
// live 2026-08-04 that without it, `nemoclaw ops-nemoclaw exec ...`
// resolves to a hardcoded default gateway name "nemoclaw" (implying port
// 8080) instead of the real "nemoclaw-8180" gateway this instance actually
// runs on, fails to find it, then reports the sandbox itself as "does not
// exist" even though it's running fine - same gotcha bootstrap.sh's own
// header comment documents, but that script sources it into its own shell;
// this process needs it passed explicitly since systemd doesn't set it.
const NEMOCLAW_ENV = { ...process.env, NEMOCLAW_GATEWAY_PORT: "8180" };
async function containerName() {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "--filter",
    `name=openshell-.*${SANDBOX}-`,
    "--format",
    "{{.Names}}",
  ]);
  return stdout.trim().split("\n")[0] || null;
}

router.get("/api/ops/cron", requireAuth, async (req, res) => {
  try {
    const payload = await gatewayClient.call("cron.list", {});
    res.json({ jobs: (payload && payload.jobs) || [] });
  } catch (err) {
    console.error("routes/ops: cron.list failed:", err.message);
    res.status(502).json({ error: `failed to list watchers: ${err.message}` });
  }
});

router.post("/api/ops/cron/:id/run", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "id is required" });
  try {
    // Not gatewayClient.call("cron.run", ...) - confirmed live 2026-08-03
    // that fails with "missing scope: operator.admin" on the dashboard's
    // own connection (same reason approvals below shell out instead of
    // using device.pair RPCs directly - see this file's header comment).
    await execFileAsync(NEMOCLAW_BIN, [SANDBOX, "exec", "--", "openclaw", "cron", "run", id], { env: NEMOCLAW_ENV });
    res.json({ ok: true });
  } catch (err) {
    console.error("routes/ops: cron.run failed:", err.message);
    res.status(502).json({ error: `failed to run job: ${err.message}` });
  }
});

// Per-run history for one watcher. cron.list (above) only carries each
// job's CURRENT state - last status, next run - so a watcher that failed
// intermittently and has since recovered looks identical to one that has
// never failed at all. This is the view that makes those readable without
// an SSH round trip: the gateway keeps exit code, duration and the exec
// diagnostics per run.
//
// Uses gatewayClient.call rather than shelling out the way cron/:id/run
// just above has to - that one needs operator.admin, but this is a read
// and works on the dashboard's own operator.read connection (verified
// live 2026-08-07 before this route was written).
router.get("/api/ops/cron/:id/runs", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "id is required" });
  // Capped rather than passed straight through, since this is a URL
  // parameter. 200 because that's the depth confirmed live to come back
  // intact (a 200-entry page spans ~5 hours at the watchers' 2-minute
  // cadence, against ~74 minutes for 50) - worth having available, because
  // "did it fail overnight" is exactly the question a shallower window
  // cannot answer. The 50 default keeps the panel a readable length for
  // the common "what just happened" case.
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    const payload = await gatewayClient.call("cron.runs", { id, limit });
    // Projected down deliberately: each raw entry carries a `delivery`
    // block (intended channel, routing metadata) that this view never
    // shows and that dwarfs the handful of fields it does.
    const runs = ((payload && payload.entries) || []).map((entry) => {
      const diagnostics = (entry.diagnostics && entry.diagnostics.entries) || [];
      // Prefer whichever diagnostic actually explains a failure; fall back
      // to the first one, which on a healthy run is the "command ok" line.
      const detail = diagnostics.find((d) => d.severity === "error") || diagnostics[0] || {};
      return {
        runAtMs: entry.runAtMs || entry.ts,
        action: entry.action,
        status: entry.status,
        durationMs: entry.durationMs,
        exitCode: detail.exitCode,
        message: detail.message || null,
        // Top-level and distinct from the diagnostic message: on a real
        // failure this is the readable summary ("command exited with code
        // 1") while the diagnostic carries the command that produced it.
        // Was dropped in the first cut, which left the detail view with
        // nothing but an exit code.
        error: entry.error || null,
      };
    });
    res.json({ runs });
  } catch (err) {
    console.error("routes/ops: cron.runs failed:", err.message);
    res.status(502).json({ error: `failed to load run history: ${err.message}` });
  }
});

// Pure diff logic, exported separately for direct testing (same rationale
// as sessions.js's own mergeUserMessages export) - this is the one piece
// of genuinely interesting logic in this file; everything else here is
// thin RPC/exec pass-through matching every other route in this project,
// none of which is separately unit-tested either.
function computeMissingAgents(liveAgents, repos) {
  const liveIds = new Set(liveAgents.map((a) => a.id));
  const missing = [];
  for (const repo of repos) {
    if (!liveIds.has(repo.escalationAgent)) missing.push(repo.escalationAgent);
    if (!liveIds.has(repo.reviewerAgent)) missing.push(repo.reviewerAgent);
  }
  return missing;
}

// Cross-references the live agent roster (gatewayClient.call("agents.list"))
// against every registered repo's expected <key>-escalation/<key>-reviewer
// pair (registry.listRepos()) - this exact diff, run automatically, would
// have caught 2026-08-03's incident (all 14 agents silently missing) the
// moment it happened instead of on the next failed dashboard run.
router.get("/api/ops/agents", requireAuth, async (req, res) => {
  try {
    const payload = await gatewayClient.call("agents.list", {});
    const liveAgents = (payload && payload.agents) || [];

    let repos;
    try {
      repos = registry.listRepos();
    } catch (err) {
      console.error("routes/ops: registry.listRepos failed:", err.message);
      repos = [];
    }

    res.json({ agents: liveAgents, missing: computeMissingAgents(liveAgents, repos) });
  } catch (err) {
    console.error("routes/ops: agents.list failed:", err.message);
    res.status(502).json({ error: `failed to list agents: ${err.message}` });
  }
});

// Config drift: what the live sandbox has vs what this repo's tooling intends.
//
// Delegates wholesale to scripts/check-config-drift.sh --json rather than
// re-implementing the comparison in Node. That script sources the same
// scripts/lib/gateway-config.sh that bootstrap.sh applies from, so there is
// exactly one definition of "intended" in the project. A JS reimplementation
// here would be a second one, which is the failure this whole feature exists
// to prevent.
//
// The script exits 1 when it finds drift - that's a successful check with a
// non-clean result, not an error, so execFile's rejection has to be unpacked
// rather than propagated. Only exit 2 (couldn't reach the sandbox) and a
// missing/unparseable payload are real failures.
const DRIFT_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "check-config-drift.sh");

// The check takes ~24s: it asks the gateway for each setting individually via
// `openclaw config get`, which is ~37 nemoclaw subprocess spawns. That's
// deliberate - resolving dotted paths like
// `tools.byProvider["..."].deny` and `models.0.maxTokens` against one big
// fetched blob would mean reimplementing OpenClaw's own path resolution and
// risking a mismatch between what the checker reads and what `config set`
// writes. Correctness over speed here; the front end loads it asynchronously
// so nothing blocks on it.
//
// Cached because the front end calls this on every page load, and a reload
// loop would otherwise mean a continuous stream of subprocess spawns against
// the gateway for a value that changes rarely.
const DRIFT_CACHE_MS = 60000;
let driftCache = null; // { at: epochMs, payload }

router.get("/api/ops/config-drift", requireAuth, async (req, res) => {
  if (driftCache && Date.now() - driftCache.at < DRIFT_CACHE_MS) {
    return res.json(driftCache.payload);
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(DRIFT_SCRIPT, ["--json"], {
      // NEMOCLAW_BIN as well as the port: systemd gives this process a PATH
      // without ~/.local/bin, so the script cannot find a bare `nemoclaw` and
      // would report the sandbox unreachable (exit 2).
      env: { ...NEMOCLAW_ENV, NEMOCLAW_BIN },
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    if (err.code === 1 && err.stdout) {
      stdout = err.stdout; // drift found - the expected non-zero path
    } else {
      console.error("routes/ops: config-drift check failed:", err.message);
      return res.status(502).json({
        error:
          err.code === 2
            ? "drift check could not reach the sandbox"
            : `drift check failed: ${err.message}`,
      });
    }
  }
  try {
    const payload = JSON.parse(stdout);
    driftCache = { at: Date.now(), payload };
    res.json(payload);
  } catch {
    console.error("routes/ops: config-drift returned unparseable output");
    res.status(502).json({ error: "drift check returned unparseable output" });
  }
});

// Per-agent capability + boundary view.
//
// "What can this agent actually do" was previously answerable only by breaking
// something. tools.effective answers it after policy resolution — but ONLY that
// half, and presenting it alone would mislead: the constraints that actually
// bit this project were never the tool catalogue. They were the agent-to-agent
// allow list (a call-time gate, invisible in the catalogue) and the cluster's
// read-only RBAC (outside OpenClaw entirely). So this returns all three.
//
// tools.effective requires a REAL sessionKey — a synthetic one errors with
// "unknown session key" — and only about half the registered agents have ever
// run. Agents with no session report sessionKey:null rather than a fabricated
// or empty tool list, because "we could not determine this" and "it has no
// tools" are opposite facts and today's whole lesson was not to conflate them.
const RBAC_PATH = path.join(__dirname, "..", "..", "..", "k8s", "rbac-readonly.yaml");

function readClusterReadBoundary() {
  try {
    const yaml = require("node:fs").readFileSync(RBAC_PATH, "utf8");
    const readable = [
      ...new Set(
        [...yaml.matchAll(/^\s*resources:\s*\[([^\]]*)\]/gm)]
          .flatMap((m) => m[1].split(","))
          .map((r) => r.replace(/["']/g, "").trim())
          .filter(Boolean),
      ),
    ].sort();
    return { readable, denied: ["secrets", "configmaps"], verbs: ["get", "list", "watch"] };
  } catch (err) {
    // Same rule as everywhere else today: unknown is not empty.
    console.error("routes/ops: could not read RBAC file:", err.message);
    return null;
  }
}

router.get("/api/ops/agent-capabilities", requireAuth, async (req, res) => {
  let repos = [];
  try {
    repos = registry.listRepos();
  } catch (err) {
    console.error("routes/ops: registry.listRepos failed:", err.message);
  }
  const agentIds = repos.flatMap((r) => [r.escalationAgent, r.reviewerAgent]).filter(Boolean);

  let a2aAllow = null;
  try {
    // config.get takes NO params and returns the whole config - there is no
    // path selector (confirmed live: passing one errors with "unexpected
    // property 'path'"). Secrets come back as __OPENCLAW_REDACTED__, so this is
    // safe to call from here, and the payload is a few KB rather than anything
    // that needs streaming.
    const cfg = await gatewayClient.call("config.get", {});
    const val = cfg && cfg.config && cfg.config.tools && cfg.config.tools.agentToAgent;
    if (val && Array.isArray(val.allow)) a2aAllow = { enabled: val.enabled === true, allow: val.allow };
  } catch (err) {
    console.warn("routes/ops: could not read tools.agentToAgent:", err.message);
  }

  const agents = await Promise.all(
    agentIds.map(async (agentId) => {
      const sessions = await gatewayClient.listAgentSessions(agentId);
      const newest = sessions
        .filter((x) => x && x.key)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (!newest) {
        return { agentId, sessionKey: null, reason: "no session yet - it has not run" };
      }
      try {
        const eff = await gatewayClient.call("tools.effective", { sessionKey: newest.key });
        const groups = ((eff && eff.groups) || []).map((g) => ({
          id: g.id,
          label: g.label,
          tools: (g.tools || []).map((t) => t.id).sort(),
        }));
        return {
          agentId,
          sessionKey: newest.key,
          profile: eff && eff.profile,
          toolCount: groups.reduce((n, g) => n + g.tools.length, 0),
          groups,
        };
      } catch (err) {
        return { agentId, sessionKey: newest.key, reason: `could not resolve tools: ${err.message}` };
      }
    }),
  );

  res.json({ agents, a2aAllow, clusterRead: readClusterReadBoundary() });
});

// Token volume over time, per day and per agent.
//
// NOT built on usage.cost. That RPC keeps a tidy 31-day daily series, but its
// cache lives at agents/main/sessions/.usage-cost-cache.json and only ever
// aggregates the DEFAULT agent - so it reported 0 tokens for 2026-08-11 and
// 08-12, two days on which the escalation agents did substantial work. A chart
// built on that source would have been confidently wrong.
//
// Nor is cost reported. The model's cost block is all zeros (correct for
// self-hosted vLLM), so any currency figure would be structurally 0 forever.
// This is deliberately a VOLUME view - the useful signal is the trend, e.g. an
// agent whose per-invocation input is quietly growing.
//
// Ground truth is each assistant message's own `usage`, summed by day from the
// transcripts. Aggregated inside the sandbox with jq rather than shipped out and
// reduced here: the transcripts total tens of MB, the answer is a few hundred
// bytes.
//
// Usage is only recorded reliably for runs made AFTER
// compat.supportsUsageInStreaming was enabled (2026-08-12). Before that,
// OpenClaw streamed and vLLM omitted usage from streamed responses unless the
// client asked, so every escalation and reviewer agent logged input/output/total
// as literally 0. Measured across the transcripts at the time of writing: all 8
// escalation and both reviewer agents had 0 turns with usage and 154 without.
//
// So a turn with no usage is NOT a turn that used no tokens, and dropping such
// turns silently would draw a floor of zeros that reads as "quiet" when it
// actually means "not measured". Hence `unrecordedTurns`, carried per day and in
// the totals: the frontend can distinguish the two instead of guessing.
//
// Timestamp precedence matters and is easy to get backwards. `.message.timestamp`
// is ALWAYS epoch milliseconds and the envelope `.timestamp` is ALWAYS an ISO
// string, so a `.message.timestamp // .timestamp` preference plus a naive
// `tostring | .[0:10]` yields bucket keys like "1786499751" - the first 10 digits
// of the epoch, silently, with no parse error. Prefer the ISO string; convert the
// number only as a fallback.
// The day compat.supportsUsageInStreaming went live on this gateway. Kept next
// to the query it annotates so it does not drift out of sync with reality.
const TOKEN_USAGE_RECORDING_SINCE = "2026-08-12";

const TOKEN_USAGE_SCRIPT = `
for d in /sandbox/.openclaw/agents/*/sessions; do
  a=$(basename $(dirname "$d"))
  for f in "$d"/*.jsonl; do
    case "$f" in *trajectory*) continue;; esac
    [ -s "$f" ] || continue
    jq -c --arg agent "$a" 'select(.type=="message" and .message.role=="assistant")
      | {d: (if (.timestamp | type) == "string" then .timestamp
             else ((.message.timestamp // 0) / 1000 | todate) end | .[0:10]),
         i: (.message.usage.input // 0),
         o: (.message.usage.output // 0),
         t: (.message.usage.totalTokens // 0),
         a: $agent}' "$f" 2>/dev/null
  done
done | jq -s '
  def agg: {
    input: (map(.i) | add // 0), output: (map(.o) | add // 0),
    total: (map(.t) | add // 0),
    turns: (map(select(.t > 0)) | length),
    unrecordedTurns: (map(select(.t == 0)) | length),
  };
  {
    byDay: (group_by(.d) | map(agg + {date: .[0].d}) | sort_by(.date)),
    byAgent: (group_by(.a) | map(agg + {agent: .[0].a}) | sort_by(-.total)),
  } + agg'
`;

router.get("/api/ops/token-usage", requireAuth, async (req, res) => {
  try {
    const container = await containerName();
    if (!container) throw new Error("sandbox container not found");
    const { stdout } = await execFileAsync("docker", ["exec", container, "sh", "-c", TOKEN_USAGE_SCRIPT], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    });
    res.json({
      ...JSON.parse(stdout),
      recordingSince: TOKEN_USAGE_RECORDING_SINCE,
      note:
        "Volume only - this model reports zero cost, so no currency figure would ever be non-zero. " +
        "Turns before recordingSince mostly recorded no usage at all; see unrecordedTurns.",
    });
  } catch (err) {
    console.error("routes/ops: token-usage aggregation failed:", err.message);
    res.status(502).json({ error: `failed to aggregate token usage: ${err.message}` });
  }
});

router.get("/api/ops/approvals", requireAuth, async (req, res) => {
  try {
    const { stdout } = await execFileAsync(
      NEMOCLAW_BIN,
      [SANDBOX, "exec", "--", "openclaw", "devices", "list", "--json"],
      { env: NEMOCLAW_ENV },
    );
    const parsed = JSON.parse(stdout);
    res.json({ pending: parsed.pending || [], paired: parsed.paired || [] });
  } catch (err) {
    console.error("routes/ops: devices list failed:", err.message);
    res.status(502).json({ error: `failed to list device approvals: ${err.message}` });
  }
});

router.post("/api/ops/approvals/:requestId/approve", requireAuth, async (req, res) => {
  const { requestId } = req.params;
  if (!requestId) return res.status(400).json({ error: "requestId is required" });
  try {
    await execFileAsync(NEMOCLAW_BIN, [SANDBOX, "exec", "--", "openclaw", "devices", "approve", requestId], {
      env: NEMOCLAW_ENV,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("routes/ops: devices approve failed:", err.message);
    res.status(502).json({ error: `failed to approve request: ${err.message}` });
  }
});

// Stamps each fix with the REAL session driving it, which as of 2026-08-05
// is NOT always the deterministic watcher session: a fix started
// mid-conversation with a human runs under that conversation's own
// `dashboard-<epoch>` key instead. Not stored under this name in the
// tracker file itself - the agent writes `session_key`, snake_case, per
// TOOLS.md.tmpl's Stage 2 instructions - and the agent records whichever
// key it was actually invoked under (see templates/watcher-{docker,k8s}
// .sh.tmpl and routes/run.js, both of which now tell the agent its own
// session_key in its very first prompt - there's no other way for it to
// know this, confirmed live: no SESSION-named env var exists in its
// environment).
//
// Falls back to the deterministic watcher key for any OLDER entry that
// predates this field (session_key absent/empty) - not a guess, an actual
// fact about how every fix used to be created before this change, so it's
// correct for exactly the entries it applies to, not just a plausible
// default. Same trust boundary either way: resolveSessionEntry() in
// routes/sessions.js already accepts both key shapes (gateway-confirmed,
// belongs to a registered repo's escalation agent).
function stampSessionKeys(fixes, repoKey) {
  const watcherSessionKey = `agent:${repoKey}-escalation:${repoKey}-watcher`;
  for (const fix of Object.values(fixes)) {
    fix.sessionKey = (typeof fix.session_key === "string" && fix.session_key) || watcherSessionKey;
  }
  return watcherSessionKey;
}

// Marks each fix with whether a human has already Denied it. Split out of
// the single-repo route so the all-repos route below applies the identical
// rule rather than a second copy that can drift.
//
// The branch name alone is NOT sufficient identity, which is what this used
// to assume. Branch names come from the incident's topic, so a recurrence
// months later - or a genuinely different bug in the same area - lands on
// the same `fix/<slug>` again. Observed live on api-rag: sig 90135be7 was
// denied on 2026-08-12, a different incident (sig 76a12eb6) escalated 35
// minutes later onto the same `fix/image-reranker-400`, and the branch-keyed
// lookup marked the NEW fix denied. That is not cosmetic - app.js gates every
// decision button behind !fix.denied, so the new fix could never be approved
// or denied from the dashboard, would never reach the "waiting on you" count,
// and would have sat at stage 4 indefinitely with nothing nagging about it.
//
// So the signature disambiguates: a denial applies only while the entry on
// that branch is still the same incident that was actually denied.
//
// Deliberately NOT the watcher's rule, even though both now consult the
// signature - the two are asking different questions and the asymmetry is the
// point. The watcher scans ALL denials for a matching signature, because it
// asks "has this incident been rejected before?" and wants the memo to fire
// wherever the fix lands. This asks "has THIS PROPOSAL been rejected?", which
// is per-branch: the same incident re-proposed on a new branch is a new
// proposal the human has not ruled on, and hiding its buttons would be the
// same un-actionable dead end in a new place.
//
// Falls back to the branch-only rule whenever either side lacks a signature.
// Denials written before 2026-08-05 have none (nothing told the agent its
// signature back then), and a fix entry can lack one if the agent omitted it.
// Treating "unknown" as a mismatch would resurrect Approve/Deny on a fix that
// really was denied and let a second click contradict the first - strictly
// worse than the stale label this fixes, so unknown means "still denied".
function applyDenials(fixes, denials) {
  for (const [key, fix] of Object.entries(fixes)) {
    const denial = denials[key];
    const deniedSig = denial && denial.incident_signature;
    const fixSig = fix && fix.incident_signature;
    const supersededByNewIncident =
      Boolean(denial) &&
      typeof deniedSig === "string" &&
      deniedSig !== "" &&
      typeof fixSig === "string" &&
      fixSig !== "" &&
      deniedSig !== fixSig;
    fix.denied = Boolean(denial) && !supersededByNewIncident;
    fix.deniedAt = fix.denied ? denial.denied_at : null;
  }
}

// The stage tracker is a plain JSON object keyed by fix branch name (NOT an
// array) - confirmed live 2026-08-03 against api-rag's real file:
// {"fix/<slug>": {incident, stage, worktree, pr_url, updated_at}, ...}.
// repoKey is validated against the registry before being interpolated into
// a container path - execFile with an argv array never invokes a shell (no
// injection risk either way), but an unregistered key has no matching file
// and should 400, not silently 404 as if the repo were just quiet.
//
// Each fix's own sessionKey is added to the response here, per-fix - see
// stampSessionKeys above for what it is and why it isn't always the
// deterministic watcher key.
//
// Shared by the single-repo GET route below and the decision route further
// down - both need the same "read the tracker, stamp each fix with its real
// sessionKey" logic, and drift between two separate copies of that is
// exactly the kind of thing that quietly breaks one path while the other
// still looks fine. Throws on a genuine read/parse failure; a missing file
// (no in-flight fix yet) is the caller's call on how to degrade, not this
// function's.
async function readStagesFile(repoKey) {
  const container = await containerName();
  if (!container) {
    throw new Error("sandbox container not found");
  }
  const { stdout } = await execFileAsync("docker", [
    "exec",
    container,
    "cat",
    `/sandbox/pilot-state/${repoKey}-escalation-stages.json`,
  ]);
  const fixes = JSON.parse(stdout);
  const watcherSessionKey = stampSessionKeys(fixes, repoKey);
  return { fixes, watcherSessionKey, container };
}

// One exec for EVERY repo's tracker + denials, instead of the 2 `docker exec
// cat` calls per repo the single-repo route makes - at 14 registered repos
// that would be 28 container round-trips on a single page load of the Ops
// "Fixes" tab, which is what pushed this into a bulk read.
//
// Nothing is interpolated into this script: it globs the two filename
// patterns in the state directory and reports which file each blob came
// from, so the shell never sees a repo key. (The single-repo route can
// interpolate safely because execFile's argv never reaches a shell at all -
// that stops being true the moment `sh -c` is involved, hence the glob.)
// A missing directory exits 0 with no output, same "no in-flight fix yet is
// not an error" degradation the single-repo route already applies.
const PILOT_STATE_DUMP = [
  "cd /sandbox/pilot-state 2>/dev/null || exit 0",
  "for f in *-escalation-stages.json *-escalation-denials.json; do",
  '  [ -f "$f" ] || continue',
  '  printf "===FILE:%s===\\n" "$f"',
  '  cat "$f"',
  '  printf "\\n"',
  "done",
].join("\n");

// The marker can't collide with file content: these files are written by
// JSON.stringify, which escapes every newline inside a string, so no line of
// a value can begin at column 0 with anything but JSON structure.
function parsePilotStateDump(stdout) {
  const files = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) files.set(current, buf.join("\n"));
    buf = [];
  };
  for (const line of stdout.split("\n")) {
    const marker = /^===FILE:(.+)===$/.exec(line);
    if (marker) {
      flush();
      current = marker[1];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return files;
}

// A tracker file that's mid-write or hand-edited into invalid JSON must not
// take down the whole cross-repo view - that repo is skipped and logged,
// every other repo still renders.
function parseJsonObject(raw, what) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error(`routes/ops: ${what} is not valid JSON, skipping:`, err.message);
    return null;
  }
}

// The denials file: every fix a human has explicitly Denied. Written ONLY
// here (the dashboard), read by the watcher templates - deliberately its own
// file rather than a field on the tracker, because the tracker is the
// AGENT's file. Two writers on one JSON blob edited by read-modify-write is
// a race with no locking anywhere in this system to arbitrate it; one writer
// each and nobody has to care about ordering.
//
// It's what makes Deny deterministic. Deny asks the agent to discard the fix
// and remove its own tracker entry, but "the repo starts being monitored
// again" must NOT be contingent on an agent turn succeeding - that's how a
// denied fix silently froze svc-core's watcher for ~2h on 2026-08-05.
// The watcher's stage-4 gate therefore releases on THIS file, which the
// dashboard has already written before the instruction is even sent.
function denialsPath(repoKey) {
  return `/sandbox/pilot-state/${repoKey}-escalation-denials.json`;
}

async function readDenials(repoKey, knownContainer) {
  // Callers that already resolved the container pass it in - `docker ps` on
  // every read adds up when the stage route makes two of these per poll.
  const container = knownContainer || (await containerName());
  if (!container) throw new Error("sandbox container not found");
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      container,
      "cat",
      denialsPath(repoKey),
    ]);
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    // No denials yet is the overwhelmingly common case, not an error. A
    // corrupt file degrades the same way rather than blocking a Deny - the
    // watcher applies the identical "unparseable means no denials" rule, so
    // both sides fail in the same conservative direction (gate stays held).
    if (!/No such file or directory/.test(err.message)) {
      console.error(`routes/ops: denials file for ${repoKey} unreadable, treating as empty:`, err.message);
    }
    return {};
  }
}

// Captures the rejected work before anything deletes it. Runs BEFORE the
// discard instruction is sent, and from the dashboard rather than the agent,
// for the same reason the denial record itself is written here: the agent is
// about to be told to delete this branch, and if it deletes before it saves,
// the diff is gone for good. Best-effort by design - a fix with no worktree
// recorded, or a git failure, must not block the Deny itself (the unfreeze
// matters more than the souvenir), so this returns null and the caller
// carries on.
// `patchDir` separates the two reasons work gets discarded. A denial is a
// verdict on a proposed fix; a close-out says the incident needed no fix at
// all. Filing both under denied-patches/ would make the directory lie, and
// that directory is what a human reads months later to ask "what did we turn
// down?".
async function savePatchBeforeDiscard(repoKey, fixKey, fix, patchDir = "denied-patches") {
  if (!fix || typeof fix.worktree !== "string" || !fix.worktree) return null;
  const repo = registry.listRepos().find((r) => r.repoKey === repoKey);
  const trunk = (repo && repo.trunkBranch) || "main";
  const container = await containerName();
  if (!container) return null;
  // Slug matches the branch with "/" flattened - fix/foo-bar -> fix-foo-bar.
  const slug = fixKey.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const outPath = `/sandbox/pilot-state/${patchDir}/${repoKey}-${slug}.patch`;
  try {
    // No `sh -c` on this one: fix.worktree and the trunk name are
    // agent-/registry-authored, and as execFile ARGS they are never parsed
    // by a shell at all, so there's nothing to quote and nothing to get
    // wrong. Capturing stdout here rather than redirecting inside the
    // container is what lets that stay true.
    //
    // format-patch (not `diff`) so the commit messages and authorship come
    // along too - if this fix is ever revisited, the reasoning recorded in
    // those messages is most of its value.
    const { stdout } = await execFileAsync(
      "docker",
      [
        "exec",
        // As the sandbox user, NOT root. `docker exec` defaults to uid 0 here,
        // every repo under /sandbox/repos is owned by `sandbox`, and modern git
        // refuses outright in a directory whose owner doesn't match the caller:
        // "fatal: detected dubious ownership in repository". That is why this
        // had never once produced a file - /sandbox/pilot-state/denied-patches/
        // did not exist at all after three separate denials (2026-08-12), each
        // logged only as "Command failed", with git's actual complaint dropped.
        //
        // Deliberately not the other fix. Adding the path to git's
        // safe.directory would silence the same error by letting ROOT run git
        // inside a tree an agent controls - and git config/hooks in that tree
        // execute. Matching the owner is both the smaller change and the safer
        // one; everything else in this project chowns to sandbox:sandbox for
        // the same reason.
        "-u",
        "sandbox",
        // HOME has to follow the user or git warns it cannot read
        // /root/.config/git/* on every call.
        "-e",
        "HOME=/sandbox",
        container,
        "git",
        "-C",
        fix.worktree,
        "format-patch",
        `${trunk}..HEAD`,
        "--stdout",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    if (!stdout.trim()) return null; // nothing committed on the branch
    await writeSandboxFile(container, outPath, stdout);
    return outPath;
  } catch (err) {
    // stderr, not just err.message. execFile's message is only "Command
    // failed: <the whole command line>" - it names what ran and says nothing
    // about why it broke. Three denials logged that and nothing else, so the
    // real cause (git refusing on ownership) stayed invisible until someone
    // re-ran the command by hand. The reason the save failed is the only part
    // of this worth logging.
    const stderr = (err.stderr || "").trim();
    console.error(
      `routes/ops: could not save rejected patch for ${repoKey}/${fixKey}: ${stderr || err.message}`,
    );
    return null;
  }
}

// Writes a file inside the sandbox without ever putting its CONTENT on a
// command line: base64 in an argument, decoded in the container. The content
// here is agent-authored (incident text, patch bodies) and can contain
// quotes, newlines, backticks, "$(...)" - anything. base64's alphabet is
// shell-inert, so the only interpolated values are ones this file built.
// execFile's own `input` option doesn't exist (that's execFileSync), which
// is the other reason not to reach for stdin here.
async function recordDenial(repoKey, fixKey, fix, sessionKey, patchPath) {
  const container = await containerName();
  if (!container) throw new Error("sandbox container not found");
  const denials = await readDenials(repoKey, container);
  denials[fixKey] = {
    incident: (fix && fix.incident) || null,
    // The join key for the watcher's prior-denial memo. Absent on entries
    // created before 2026-08-05 (nothing told the agent its signature back
    // then) - the denial still records and still releases the gate, the
    // memo just can't fire for that one incident. Recorded, not guessed:
    // there's no way to recompute it from the agent's own free-text
    // `incident` summary, which isn't what the watcher hashed.
    incident_signature: (fix && fix.incident_signature) || null,
    denied_at: new Date().toISOString(),
    session_key: sessionKey,
    worktree: (fix && fix.worktree) || null,
    patch_path: patchPath,
  };
  await writeSandboxFile(container, denialsPath(repoKey), JSON.stringify(denials, null, 2));
  return denials[fixKey];
}

// Every repo's in-flight fixes in one response, grouped and labelled by
// repo. The per-repo route below only ever describes whichever repo the
// sidebar picker happens to be pointing at, so a fix sitting at stage 4 on
// some OTHER repo - the case that actually pauses that repo's monitoring -
// was invisible unless you went looking for it repo by repo. This is what
// the Ops modal's Fixes tab reads.
//
// Repos with no tracker file, an empty tracker, or an unreadable one are
// omitted from `repos` entirely rather than rendered as empty groups;
// repoCount is returned so the UI can still say what "nothing in progress"
// was measured across.
// Marks each fix with whether the run that was driving it actually died.
//
// A tracker entry records the stage an agent REACHED, never that it stopped -
// so a fix abandoned mid-protocol is byte-identical to one still working, and
// the UI showed both as the same hopeful progress bar. That is not
// hypothetical: on 2026-08-07 a config hot-reload aborted an in-flight run and
// left a fix parked at stage 2 of 7 with its branch already committed; nothing
// anywhere said so, and it was found by chance.
//
// sessions.list carries `abortedLastRun` per session, which is precisely that
// missing bit. Fixes are matched by the `session_key` stampSessionKeys() has
// already put on them.
//
// Defensive throughout: a gateway hiccup here must degrade to "no run state"
// rather than 502 the whole stages view, which is the one surface a human uses
// to answer "what is waiting on me".
async function annotateRunState(groups) {
  const wanted = new Set();
  for (const group of groups) {
    for (const fix of Object.values(group.fixes || {})) {
      if (fix.session_key) wanted.add(fix.session_key);
    }
  }
  if (!wanted.size) return;

  const state = new Map();
  // One call per escalation agent rather than a global list: sessions.list is
  // agentId-scoped (see gatewayClient.listAgentSessions).
  await Promise.all(
    groups.map(async (group) => {
      const sessions = await gatewayClient.listAgentSessions(`${group.repoKey}-escalation`);
      for (const s of sessions) {
        if (s && s.key && wanted.has(s.key)) {
          state.set(s.key, {
            lastRunAborted: s.abortedLastRun === true,
            sessionUpdatedAt: s.updatedAt || null,
          });
        }
      }
    }),
  );

  for (const group of groups) {
    for (const fix of Object.values(group.fixes || {})) {
      const found = fix.session_key ? state.get(fix.session_key) : null;
      // null (not false) when unknown, so the frontend can tell "we checked and
      // it's fine" apart from "we couldn't find out".
      fix.lastRunAborted = found ? found.lastRunAborted : null;
      fix.sessionUpdatedAt = found ? found.sessionUpdatedAt : null;
    }
  }
}

router.get("/api/ops/stages", requireAuth, async (req, res) => {
  let repos = [];
  try {
    repos = registry.listRepos();
  } catch (err) {
    console.error("routes/ops: registry.listRepos failed:", err.message);
  }
  try {
    const container = await containerName();
    if (!container) throw new Error("sandbox container not found");
    const { stdout } = await execFileAsync("docker", ["exec", container, "sh", "-c", PILOT_STATE_DUMP], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const files = parsePilotStateDump(stdout);

    const groups = [];
    let fixCount = 0;
    let awaitingDecisionCount = 0;
    for (const repo of repos) {
      const fixes = parseJsonObject(
        files.get(`${repo.repoKey}-escalation-stages.json`),
        `stage tracker for ${repo.repoKey}`,
      );
      if (!fixes || !Object.keys(fixes).length) continue;
      const denials =
        parseJsonObject(files.get(`${repo.repoKey}-escalation-denials.json`), `denials for ${repo.repoKey}`) || {};
      const watcherSessionKey = stampSessionKeys(fixes, repo.repoKey);
      applyDenials(fixes, denials);

      fixCount += Object.keys(fixes).length;
      // What the badge counts: a fix the protocol has actually STOPPED on
      // and is waiting for a human at (stages 4 and 5 - the same two the
      // decision buttons appear for). A fix quietly working through stage 1
      // needs nothing from anyone and shouldn't nag.
      for (const fix of Object.values(fixes)) {
        if (!fix.denied && (fix.stage === 4 || fix.stage === 5)) awaitingDecisionCount += 1;
      }

      groups.push({
        repoKey: repo.repoKey,
        displayName: repo.displayName,
        monitoringEnabled: repo.monitoringEnabled,
        watcherSessionKey,
        fixes,
      });
    }

    await annotateRunState(groups);

    res.json({ repos: groups, repoCount: repos.length, fixCount, awaitingDecisionCount });
  } catch (err) {
    console.error("routes/ops: cross-repo stage read failed:", err.message);
    res.status(502).json({ error: `failed to read stage trackers: ${err.message}` });
  }
});

router.get("/api/ops/stages/:repoKey", requireAuth, async (req, res) => {
  const { repoKey } = req.params;
  if (!repoKey || !registry.repoExists(repoKey)) {
    return res.status(400).json({ error: `unknown repoKey '${repoKey}'` });
  }
  try {
    const { fixes, watcherSessionKey, container } = await readStagesFile(repoKey);
    // Denials ride along so the UI can stop showing a rejected fix as
    // "in progress". The agent normally deletes the tracker entry itself
    // when it processes the discard, but there's a real window between the
    // click and that happening (and a real possibility it never does), and
    // during it the entry is still sitting there at stage 4 looking exactly
    // like something awaiting a decision that was in fact already made.
    const denials = await readDenials(repoKey, container);
    applyDenials(fixes, denials);
    res.json({ fixes, watcherSessionKey, denials });
  } catch (err) {
    // No in-flight fix yet is the common case, not an error - the tracker
    // file only exists once Stage 2 has actually created one - so a
    // missing-file failure degrades to an empty object rather than 502.
    if (/No such file or directory/.test(err.message)) {
      return res.json({ fixes: {} });
    }
    console.error("routes/ops: stage-tracker read failed:", err.message);
    res.status(502).json({ error: `failed to read stage tracker: ${err.message}` });
  }
});

// Sends exactly one of three FIXED messages into a specific escalation
// session - never arbitrary text - matching the protocol's own explicit
// "Do not proceed until you get an explicit yes" (Stage 4) language. Two
// checks before anything gets sent: (1) resolveSessionEntry() (the exact
// same trust boundary /api/sessions/history already enforces) confirms
// sessionKey genuinely belongs to a registered repo's escalation agent,
// not an arbitrary client-supplied string; (2) the tracker is re-read
// fresh (not trusted from whatever the client had cached) and some fix
// must currently be at the stage this decision actually applies to -
// approve/deny only make sense at stage 4 ("STOP, wait for a reply"),
// confirm-merged only at stage 5 (PR open, waiting on merge) - otherwise
// a stale page left open across a stage change could send an approval
// that no longer means what the button said it meant.
const DECISION_MESSAGES = {
  approve: {
    stage: 4,
    text: "Yes, proceed — push the branch and open the PR, per your Stage 4 report.",
  },
  // Deny is TERMINAL as of 2026-08-05, and used to say "Hold this fix and
  // await further instructions." Two things were wrong with that. It left
  // the entry at stage 4 forever, which the watcher's own stage-4 gate reads
  // as "a human is mid-decision" - so a single Deny click paused that repo's
  // monitoring indefinitely (observed live: ~2h on svc-core before it
  // was caught). And the "further instructions" it told the agent to wait
  // for had no way of arriving: the composer is deliberately disabled for
  // gateway-origin sessions, so the only inputs that session can ever
  // receive are these three fixed messages. It was an instruction to wait
  // for something that could not happen.
  //
  // Discarding is also just what a denial means here. The branch was never
  // pushed (Stage 5 is what pushes, and it never ran), so there is nothing
  // to preserve remotely and nobody else can be depending on it. The
  // rejected diff is saved to patch_path first regardless, so "discard"
  // costs the work only from the working tree, not from the record.
  deny: {
    stage: 4,
    // See discardsWork's own note above DECISION_MESSAGES.
    discardsWork: true,
    text:
      "No — this fix is rejected. Discard it and close the incident out:\n" +
      "\n" +
      "1. Remove the worktree, running the command from the shared clone and NOT " +
      "from inside the worktree you are removing.\n" +
      "2. Delete the local fix branch.\n" +
      "3. Do NOT run `git push origin --delete` for it. This branch was never " +
      "pushed (you stopped at Stage 4, before Stage 5's push), so there is no " +
      "remote branch to delete and that command will simply error.\n" +
      "4. Remove this fix's entry from your stage tracker entirely, the same way " +
      "Stage 6 does — there is nothing left to resume.\n" +
      "\n" +
      "Your diff has already been saved off to /sandbox/pilot-state/denied-patches/ " +
      "before this message was sent, so removing the branch does not lose the work. " +
      "This denial has also been recorded, and if this same incident recurs you will " +
      "be told that a fix for it was denied before — do not silently re-propose the " +
      "same change then.\n" +
      "\n" +
      "Confirm what you removed when you are done.",
  },
  "confirm-merged": {
    stage: 5,
    text: "The PR has been merged. Please proceed with Stage 6 cleanup (remove the worktree and delete the fix branch).",
  },
  // Added 2026-08-06 for the dead-end case the other three can't reach: a
  // tracker entry BELOW stage 4. Approve/Deny/Confirm-merged all match on a
  // specific stage, and the watcher's own gate only ever pauses at stage 4,
  // so an entry parked at stage 1 or 2 - benign verdict, not-this-repo,
  // already-fixed-upstream, or a run that simply died mid-investigation -
  // was unreachable from every surface: no decision buttons on the row, and
  // the composer is deliberately disabled for gateway-origin sessions, so
  // there was no way to answer the agents that had literally asked "should I
  // remove this tracker entry?". Six such entries had accumulated across two
  // repos when this was found.
  //
  // `stage: null` means "whatever stage it's at" - the only decision that
  // deliberately doesn't pin one, because the whole point is to reach the
  // stages nothing else can. Still requires a real matching tracker entry on
  // a real escalation session (see the endpoint below), so it can't be used
  // to poke an arbitrary session.
  //
  // Worth noting what this does NOT do: it doesn't delete the tracker entry
  // itself. The tracker is the agent's file and this system has no locking
  // anywhere to arbitrate two writers on one read-modify-write JSON blob -
  // the same reasoning that put denials in their own dashboard-owned file
  // rather than as a field on the tracker. So this asks the agent to close
  // its own entry out, exactly as Deny already does.
  "close-out": {
    stage: null,
    // Added 2026-08-13, and it is not a formality. This decision is offered at
    // every stage below 4, which since the Stage 4 protocol change is exactly
    // where a fix that FAILED to ask properly comes to rest - branch committed,
    // review passed, question never delivered. On 2026-08-13 an api-rag fix in
    // that state (commit 6c96f25, reviewed APPROVED) was closed out to unstick
    // it and its branch was deleted with nothing saved: the only reason the
    // work survived at all is that git had not yet gc'd the unreachable commit.
    // Deny had saved its diff since 2026-08-05; close-out is the same
    // irreversible instruction and had no such step.
    discardsWork: true,
    text:
      "Close this incident out - there is no fix to land here.\n" +
      "\n" +
      "This is not a denial of a proposed fix (nothing was proposed to deny); it's a " +
      "confirmation that this incident needs no change to this repo - benign, not this " +
      "repo's problem, already resolved upstream, or no longer reproducing. Whichever " +
      "of those it is, say so plainly, then:\n" +
      "\n" +
      "1. If you created a worktree for it, remove it - running the command from the " +
      "shared clone, NOT from inside the worktree you are removing.\n" +
      "2. If you created a local fix branch, delete it. Do NOT run " +
      "`git push origin --delete`; nothing was ever pushed for this incident, so that " +
      "command will only error.\n" +
      "3. Remove this fix's entry from your stage tracker entirely, the same way Stage 6 " +
      "does. This step is the one that matters and it is not optional - an entry left " +
      "behind cannot be actioned or cleared by anyone.\n" +
      "\n" +
      "Steps 1 and 2 may well be no-ops (an entry below stage 2 usually has no worktree " +
      "and no branch); that's expected, don't invent work to do. Do not open a branch, " +
      "prepare a fix, or re-investigate in response to this message. Confirm what you " +
      "removed - including \"nothing to remove\" where that's the honest answer.\n" +
      "\n" +
      "If you HAD committed anything on a branch for this, its diff has already been " +
      "saved off to /sandbox/pilot-state/closed-out-patches/ before this message was " +
      "sent, so deleting the branch does not lose it. Don't preserve it some other way.",
  },
  // The second thing an agent can block on that the dashboard had no way to
  // answer. The proposed regex lives in the agent's own report as free text,
  // and this route deliberately does NOT try to find it there: pattern-
  // matching a transcript for "the suppression line" would be guesswork
  // against text that varies run to run and language to language. The agent
  // knows what it proposed, so it's asked to append exactly that and echo it
  // back - which also puts the line that actually landed in the transcript,
  // where a human can check it against what they approved.
  //
  // Deliberately not stage-bound and, unlike close-out, not tied to a
  // tracker entry at all (see the endpoint) - after Stage 1's close-out rule
  // a benign-but-recurring verdict leaves no entry behind by design, which is
  // precisely the case that most needs a suppression.
  // Read-only re-check, added 2026-08-11. A fix waiting at stage 4 pauses that
  // repo's watcher entirely (the gate exits BEFORE the log pull, so nothing is
  // checked at all while it waits), which means the longer a decision sits the
  // more stale the evidence behind it becomes - and there was no way to
  // refresh it. Found with two repos simultaneously paused 15h, each waiting on
  // an approval whose incident nobody could confirm was still happening.
  //
  // Deliberately asks for a report and nothing else: no push, no tracker
  // change, no stage move. The human still decides - this only replaces a
  // 15-hour-old sentence with a current one.
  verify: {
    stage: null,
    text:
      "Before I decide on this fix, re-check whether it is still needed. This is a " +
      "READ-ONLY check: do not push anything, do not open a PR, do not modify the " +
      "stage tracker, and do not change the stage. Report back and stop.\n" +
      "\n" +
      "Cover all four of these explicitly, and say plainly when you cannot " +
      "determine one rather than guessing:\n" +
      "\n" +
      "1. Is the incident still occurring? Distinguish 'not happening any more' " +
      "from 'nothing exercised this code path recently' - if the workload has " +
      "been idle, an absence of errors is not evidence the problem is gone, and " +
      "reporting it as resolved would be wrong. State which of the two you are " +
      "looking at, and over what window.\n" +
      "2. Has the trunk branch moved since your fix branch was created? Does your " +
      "fix still apply cleanly on top of current trunk, or does it now need a " +
      "rebase?\n" +
      "3. Has this already been fixed - upstream, by someone else, or by a change " +
      "that landed while you were waiting? If so the fix may be redundant.\n" +
      "4. Is the deployment you monitor still running the unfixed code? A merge " +
      "or a fix elsewhere means nothing until it is actually deployed, so check " +
      "what is running rather than what the source says.\n" +
      "\n" +
      "End with your own recommendation - still needed, no longer needed, or " +
      "needs rework - and why. Do not act on that recommendation; wait.",
  },
  "approve-suppression": {
    stage: null,
    requiresFix: false,
    text:
      "Approved - add the suppression line you proposed, and only that line.\n" +
      "\n" +
      "Append it to your watcher's suppression file exactly as you stated it in your " +
      "report (see TOOLS.md for the path and the append mechanism), then reply with the " +
      "exact line you added, verbatim.\n" +
      "\n" +
      "This approval covers the specific pattern you proposed and nothing wider. Do not " +
      "broaden it, generalise it, or add extra lines while you are in there - if you now " +
      "think a different or broader pattern is the right one, do not add it: say what " +
      "you would change and why, and wait for a fresh approval. If you did not actually " +
      "propose a suppression line, add nothing at all and say so.\n" +
      "\n" +
      "Include a brief comment line above it noting what it suppresses and that it was " +
      "human-approved, matching the style of any lines already in the file.",
  },
};

// express.json() is route-level, not global (this codebase has no
// app.use(express.json()) anywhere - see routes/run.js's own POST /api/run
// for the same pattern) - without it req.body is always undefined, which
// is exactly what happened here the first time this route was tested:
// every request failed with "sessionKey is required" regardless of what
// was actually sent, since nothing had parsed the JSON body yet.
router.post("/api/ops/decision", requireAuth, express.json({ limit: "1kb" }), async (req, res) => {
  const { sessionKey, decision } = req.body || {};
  if (!sessionKey || typeof sessionKey !== "string") {
    return res.status(400).json({ error: "sessionKey is required" });
  }
  const spec = DECISION_MESSAGES[decision];
  if (!spec) {
    return res.status(400).json({ error: `unknown decision '${decision}'` });
  }
  try {
    const entry = await resolveSessionEntry(sessionKey);
    if (!entry) {
      return res.status(403).json({ error: "sessionKey is not a known escalation-agent session" });
    }
    // A reviewer session is a real gateway-origin session resolveSessionEntry
    // will happily confirm, but none of these messages make any sense sent to
    // one - they all instruct the recipient to edit a stage tracker or a
    // suppression file that only the escalation agent owns.
    if (entry.agentRole !== "escalation") {
      return res.status(403).json({ error: "decisions can only be sent to an escalation-agent session" });
    }

    let matchedKey = null;
    let matchedFix = null;
    // requiresFix:false is only approve-suppression, which by design has no
    // tracker entry to match against - a benign-but-recurring verdict is
    // exactly the case that leaves the tracker clean (Stage 1) and still
    // needs an answer. The escalation-session check above is the whole of the
    // authorization for it.
    if (spec.requiresFix !== false) {
      const { fixes } = await readStagesFile(entry.repoKey);
      matchedKey = Object.keys(fixes).find(
        (key) =>
          fixes[key].sessionKey === sessionKey &&
          // stage:null means "any stage" - see close-out's own comment.
          (spec.stage === null || fixes[key].stage === spec.stage),
      );
      matchedFix = matchedKey ? fixes[matchedKey] : null;
      if (!matchedKey) {
        return res.status(409).json({
          error:
            spec.stage === null
              ? "no fix on this session is in the tracker any more - it looks already closed out; refresh and try again"
              : `no fix on this session is currently at stage ${spec.stage} - it may have already moved on; refresh and try again`,
        });
      }
    }

    // Order matters, and it is the whole point of doing this here rather
    // than leaving it to the agent: save the diff, then record the denial,
    // and only THEN send the instruction that asks for the branch to be
    // deleted. Every step that must survive an agent that misbehaves,
    // crashes, or is simply slow has already happened by the time the agent
    // hears about it - including the one that releases the watcher's
    // stage-4 gate and gets the repo monitored again.
    //
    // Driven off spec.discardsWork rather than a decision name, so a future
    // decision that also tells an agent to delete a branch cannot be added
    // without answering the question "and where does the diff go?" - the way
    // close-out was added in 2026-08-06 without one.
    if (spec.discardsWork) {
      const patchPath = await savePatchBeforeDiscard(
        entry.repoKey,
        matchedKey,
        matchedFix,
        decision === "deny" ? "denied-patches" : "closed-out-patches",
      );
      // Only a denial is a verdict worth remembering. A close-out says this
      // incident needed no change, which is not something the prior-denial
      // memo should ever fire on - it would tell the agent a fix was
      // "rejected" when none was ever proposed.
      if (decision === "deny") {
        await recordDenial(entry.repoKey, matchedKey, matchedFix, sessionKey, patchPath);
      }
    }

    await gatewayClient.call("chat.send", {
      sessionKey,
      message: spec.text,
      deliver: false,
      timeoutMs: 90_000,
      idempotencyKey: crypto.randomUUID(),
    });

    // Fixes the two real Recents gaps found 2026-09-03 (see
    // sessionIndex.record()'s own comment on the decision/decisionLabel
    // params for the full reasoning): persist this sessionKey into the
    // local index so it survives regardless of the Gateway's own bounded
    // per-agent session history, and mark it with the decision just sent
    // so app.js's renderRecents() can show "you already responded here"
    // instead of leaving every touched entry looking identical to one
    // that still needs a look. A gateway-origin session not yet in the
    // index needs a real label first (the fixed DECISION_MESSAGES text
    // above makes a useless one) - fetched the same way getMergedSessions()
    // already labels every gateway-origin Recents entry, so this reads no
    // different from one discovered the normal way. Best-effort: a failure
    // here must never undo the chat.send that already succeeded above, so
    // it's logged and swallowed, not surfaced as a 502 for something that
    // actually worked.
    try {
      const isNewLocally = !sessionIndex.exists(sessionKey);
      const label = isNewLocally
        ? (await labelsFromRecentMessages([sessionKey])).get(sessionKey)
        : undefined;
      sessionIndex.record({ sessionKey, repoKey: entry.repoKey, message: spec.text, decision, label });
    } catch (recordErr) {
      console.error("routes/ops: decision sent but sessionIndex.record failed:", recordErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("routes/ops: decision send failed:", err.message);
    res.status(502).json({ error: `failed to send decision: ${err.message}` });
  }
});

// Raw tasks.list response uses status:"completed" (confirmed live
// 2026-08-03), not "succeeded" as openclaw's own `tasks list` CLI table
// displays it - don't assume the CLI's display terms match the RPC's own.
router.get("/api/ops/tasks", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  try {
    const payload = await gatewayClient.call("tasks.list", { limit });
    res.json({ tasks: (payload && payload.tasks) || [] });
  } catch (err) {
    console.error("routes/ops: tasks.list failed:", err.message);
    res.status(502).json({ error: `failed to list background tasks: ${err.message}` });
  }
});

module.exports = router;
module.exports.computeMissingAgents = computeMissingAgents;
module.exports.parsePilotStateDump = parsePilotStateDump;
// Exported for test/opsDecisionSpecs.test.js only - the decision names live in
// two files (here, and app.js's own DECISIONS for the button labels) and a
// name present in one but not the other is a button that 400s or a message
// nothing can ever send.
module.exports.DECISION_MESSAGES = DECISION_MESSAGES;
// Exported for test/opsDenials.test.js only - a denial that stops applying,
// or one that keeps applying to the wrong incident, both end as a fix nobody
// can decide on, and neither is visible without reading the tracker by hand.
module.exports.applyDenials = applyDenials;
