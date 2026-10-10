// Standalone test for GET /api/monitoring/targets and the registry helpers
// behind it - run directly with `node test/monitoringTargets.test.js`.
// Hermetic: no .env, no gateway, no cluster.
//
// Phase 3 of docs/monitoring-live-logs.md. Two things are being pinned here.
//
// The tagged union. `runtime` is tagged on `type` (registry/schema.md), and
// only "k8s" can be log-streamed. "docker" is retired and unused today, but
// the schema still describes it and `register-repo.sh --runtime docker` still
// parses one, so it can come back - and it carries ssh_host/container_dev with
// no namespace or selector at all. An entry predating `runtime` (added
// 2026-07-21) has no block whatsoever. Neither may be handed to logStream as
// if it were streamable, and neither may be silently dropped from the list.
//
// The credential exclusion. listRepos() deliberately omits clone_url because
// it may embed credentials at clone time (schema.md's own note). This endpoint
// reads the same file, so the same exclusion is asserted here rather than
// assumed - a second reader of a file with a credential in it is exactly how
// that kind of leak gets reintroduced.

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

// Must be set before anything pulls in config.js, which exits the process on
// an incomplete environment. Same approach as modelHealth.test.js.
process.env.NEMOCLAW_GATEWAY_URL = "ws://127.0.0.1:19998";
process.env.NEMOCLAW_GATEWAY_TOKEN = "test-token";
process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "0".repeat(64);
process.env.DASHBOARD_PORT = "8795";

const registry = require(path.join(__dirname, "..", "src", "registry.js"));
const logStream = require(path.join(__dirname, "..", "src", "logStream.js"));
const monitoringRouter = require(path.join(__dirname, "..", "src", "routes", "monitoring.js"));

let checks = 0;
let failures = 0;
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`PASS: ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL: ${label}\n      ${err.message}`);
  }
}

// A real k8s entry, copied from registry/repos.json's api-rag.
const K8S_ENTRY = {
  display_name: "Demo RAG",
  runtime: {
    type: "k8s",
    cluster: "server2",
    namespace: "dev",
    workload_kind: "deployment",
    workload_name: "svc-rag-dev",
    container: "svc-rag-dev",
    label_selector: "app=svc-rag-dev",
  },
  monitoring_enabled: true,
  error_pattern: "ERROR|CRITICAL|Traceback|Exception",
  clone_url: "https://user:token@github.com/example-org/svc-api-rag.git",
};

(async () => {
  // === the tagged union ===================================================
  const k8s = registry._toRuntimeTarget("api-rag", K8S_ENTRY);

  check("a k8s entry is streamable, with the fields a stream needs", () => {
    assert.strictEqual(k8s.streamable, true);
    assert.strictEqual(k8s.unstreamableReason, null);
    assert.strictEqual(k8s.namespace, "dev");
    assert.strictEqual(k8s.labelSelector, "app=svc-rag-dev");
    assert.strictEqual(k8s.workloadName, "svc-rag-dev");
    assert.strictEqual(k8s.displayName, "Demo RAG");
  });

  check("a streamable target is accepted by logStream.subscribe's own validation", () => {
    // The contract between these two modules, asserted rather than assumed:
    // subscribe() throws unless repoKey, namespace and labelSelector are all
    // present, so this proves the mapping produces what it demands. Checked by
    // calling the real validation with a spawn that never runs.
    const realSpawn = require("node:child_process").spawn;
    require("node:child_process").spawn = () => {
      const { EventEmitter } = require("node:events");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      child.kill = () => true;
      child.unref = () => {};
      return child;
    };
    try {
      const off = logStream.subscribe(k8s, { onLine: () => {}, onControl: () => {} });
      off();
    } finally {
      require("node:child_process").spawn = realSpawn;
    }
  });

  check("a retired docker entry is listed but flagged, not streamable", () => {
    const d = registry._toRuntimeTarget("legacy", {
      runtime: { type: "docker", ssh_host: "server5", container_dev: "x-dev" },
    });
    assert.strictEqual(d.streamable, false);
    assert.strictEqual(d.repoKey, "legacy", "the entry was dropped instead of flagged");
    assert.match(d.unstreamableReason, /docker/);
    assert.strictEqual(d.namespace, null, "a docker entry has no namespace to report");
    assert.strictEqual(d.labelSelector, null);
  });

  check("an entry with no runtime block at all is listed but flagged", () => {
    const n = registry._toRuntimeTarget("ancient", { display_name: "Old Repo" });
    assert.strictEqual(n.streamable, false);
    assert.strictEqual(n.runtimeType, null);
    assert.match(n.unstreamableReason, /no runtime block/);
    assert.strictEqual(n.displayName, "Old Repo");
  });

  check("a k8s entry missing its selector is caught here, not at the cluster", () => {
    // An empty -l would fail inside kubectl, where the only thing to report is
    // a generic non-zero exit. Catching it while there is still something
    // specific to say is the difference between a useful pane and a shrug.
    const broken = registry._toRuntimeTarget("half", {
      runtime: { type: "k8s", cluster: "server2", namespace: "dev", workload_name: "w" },
    });
    assert.strictEqual(broken.streamable, false);
    assert.match(broken.unstreamableReason, /namespace or label_selector/);
  });

  check("monitoring_enabled: false is reported, NOT used to hide the workload", () => {
    // The watcher being off is no reason an operator can't read the logs by
    // hand - arguably it is when they most want to.
    const off = registry._toRuntimeTarget("api-rag", { ...K8S_ENTRY, monitoring_enabled: false });
    assert.strictEqual(off.monitoringEnabled, false);
    assert.strictEqual(off.streamable, true, "a disabled watcher made the workload unstreamable");
  });

  check("clone_url is never exposed - it may embed a credential", () => {
    const serialised = JSON.stringify(k8s);
    assert.ok(!("cloneUrl" in k8s) && !("clone_url" in k8s), "clone_url reached the target object");
    assert.ok(!serialised.includes("token"), `a credential survived into the payload: ${serialised}`);
    assert.ok(!serialised.includes("github.com"));
  });

  // === against the real registry ==========================================
  const all = registry.listRuntimeTargets();

  check("every registered repo is present", () => {
    assert.ok(all.length >= 7, `expected at least 7 targets, got ${all.length}`);
    assert.ok(all.every((t) => typeof t.repoKey === "string" && t.repoKey.length > 0));
  });

  check("all 7 live workloads are k8s and streamable", () => {
    const bad = all.filter((t) => !t.streamable);
    assert.strictEqual(bad.length, 0, `unstreamable: ${bad.map((t) => `${t.repoKey} (${t.unstreamableReason})`).join(", ")}`);
    assert.ok(all.every((t) => t.runtimeType === "k8s"));
  });

  check("no clone_url leaks through the real listing either", () => {
    assert.ok(!JSON.stringify(all).includes("clone_url"));
    assert.ok(!JSON.stringify(all).includes("github.com"));
  });

  check("getRuntimeTarget resolves a known key and rejects an unknown one", () => {
    // This is the server-side ownership check phase 2 depends on: a repoKey it
    // cannot resolve must come back null so the upgrade can be refused, rather
    // than a half-populated target being streamed.
    const one = registry.getRuntimeTarget(all[0].repoKey);
    assert.strictEqual(one.repoKey, all[0].repoKey);
    assert.strictEqual(registry.getRuntimeTarget("no-such-repo"), null);
    assert.strictEqual(registry.getRuntimeTarget("../../etc/passwd"), null);
  });

  // === the route ==========================================================
  // Mounted on a real server with a stand-in session, so requireAuth runs for
  // real rather than being stubbed out.
  let authenticated = false;
  const app = express();
  app.use((req, res, next) => {
    req.session = authenticated ? { authenticated: true } : {};
    next();
  });
  app.use(monitoringRouter);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anon = await fetch(`${base}/api/monitoring/targets`);
  const anonBody = await anon.json().catch(() => null);

  check("unauthenticated is refused with 401 and leaks no workload names", () => {
    assert.strictEqual(anon.status, 401);
    assert.ok(!JSON.stringify(anonBody).includes("svc"), "an unauthenticated caller saw workload detail");
  });

  authenticated = true;
  const res = await fetch(`${base}/api/monitoring/targets`);
  const body = await res.json();

  check("authenticated gets the target list", () => {
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body.targets));
    assert.strictEqual(body.targets.length, all.length);
  });

  check("the response reports the limits the UI needs to explain a refusal", () => {
    // Read from logStream rather than restated in the route, so a change to
    // the cap cannot leave the UI describing the old one.
    assert.strictEqual(body.limits.maxConcurrentStreams, logStream._constants.MAX_CONCURRENT_STREAMS);
    assert.strictEqual(body.limits.streamTimeoutSeconds, logStream._constants.STREAM_TIMEOUT_SECONDS);
    assert.strictEqual(typeof body.activeStreams, "number");
  });

  check("the endpoint starts no stream - it only describes them", () => {
    assert.strictEqual(logStream.activeStreamCount(), 0, "listing targets opened a kubectl");
  });

  await new Promise((r) => server.close(r));

  console.log("");
  if (failures) {
    console.log(`${failures} of ${checks} FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} TESTS PASSED`);
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
