// registry.js - reads registry/repos.json directly off disk. No Gateway
// call involved: repo registration state lives in this file, not in the
// Gateway, so there's nothing to ask the Gateway for here. Same file
// register-repo.sh/toggle-repo.sh/deregister-repo.sh already treat as
// source of truth (see registry/schema.md).

const fs = require("node:fs");
const path = require("node:path");

const REGISTRY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "registry",
  "repos.json",
);

// Deliberately excludes clone_url (may embed credentials at clone time,
// per registry/schema.md's own note).
function listRepos() {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const registry = JSON.parse(raw);

  return Object.entries(registry).map(([repoKey, entry]) => ({
    repoKey,
    // Optional human-friendly label for the dashboard's repo picker (see
    // registry/repos.json's display_name). Falls back to the raw repoKey
    // when absent, so an entry registered before this field existed still
    // renders something sensible.
    displayName: entry.display_name || repoKey,
    repoOrgSlashName: entry.repo_org_slash_name,
    trunkBranch: entry.trunk_branch,
    secondaryBranch: entry.secondary_branch ?? null,
    monitoringEnabled: Boolean(entry.monitoring_enabled),
    modificationsEnabled: Boolean(entry.modifications_enabled),
    model: entry.model,
    correlateWith: entry.correlate_with ?? [],
    escalationAgent: `${repoKey}-escalation`,
    reviewerAgent: `${repoKey}-reviewer`,
  }));
}

// Used by routes/run.js to validate a repoKey exists before attempting to
// talk to the Gateway - same check prompt-agent.sh already does.
function repoExists(repoKey) {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const registry = JSON.parse(raw);
  return Object.prototype.hasOwnProperty.call(registry, repoKey);
}

// Normalises one registry entry's `runtime` block into a log-streaming target.
//
// Kept separate from listRepos() rather than folded into it: listRepos() feeds
// the repo picker on every page load and has no use for the runtime detail, and
// it deliberately excludes clone_url because that may embed credentials at
// clone time (registry/schema.md's own note). Nothing here reintroduces it.
//
// `runtime` is a TAGGED UNION on `type` (schema.md, "Runtime object"), which is
// why this reports streamability rather than assuming it:
//
//   - "k8s"    - the only streamable form. All 7 registered repos are this
//                today, all namespace=dev on cluster=server2.
//   - "docker" - retired 2026-07-22 and no entry uses it, but the schema still
//                describes it and `register-repo.sh --runtime docker` still
//                parses one, so it can reappear. It carries ssh_host/
//                container_dev and no namespace or selector at all, so a
//                kubectl stream cannot be built for it.
//   - missing  - an entry registered before `runtime` existed (2026-07-21).
//
// Unstreamable targets are still RETURNED, flagged with a reason, rather than
// filtered out. Same reasoning the plan gives for monitoring_enabled: false -
// a workload silently absent from the picker is a confusing dead end, whereas
// one that says why it can't be streamed is self-explanatory.
function toRuntimeTarget(repoKey, entry) {
  const runtime = entry.runtime || null;
  const type = runtime ? runtime.type || null : null;

  const target = {
    repoKey,
    displayName: entry.display_name || repoKey,
    runtimeType: type,
    // Checked by the watcher every cycle. Surfaced but NOT used to hide
    // anything: the watcher being off is no reason an operator can't look at
    // the logs by hand, which is arguably when they most want to.
    monitoringEnabled: Boolean(entry.monitoring_enabled),
    // For the optional severity tinting (§6.4 of docs/monitoring-live-logs.md).
    // Display-only, operator-configured, per repo; unused by v1.
    errorPattern: entry.error_pattern || null,
    cluster: null,
    namespace: null,
    workloadKind: null,
    workloadName: null,
    container: null,
    labelSelector: null,
    streamable: false,
    unstreamableReason: null,
  };

  if (!runtime) {
    target.unstreamableReason = "no runtime block registered for this repo";
    return target;
  }
  if (type !== "k8s") {
    target.unstreamableReason = `runtime type "${type || "unknown"}" cannot be log-streamed (only k8s can)`;
    return target;
  }

  target.cluster = runtime.cluster || null;
  target.namespace = runtime.namespace || null;
  target.workloadKind = runtime.workload_kind || null;
  target.workloadName = runtime.workload_name || null;
  target.container = runtime.container || null;
  target.labelSelector = runtime.label_selector || null;

  // A k8s entry missing either of these would produce a kubectl invocation
  // with an empty -n or -l, which fails at the cluster rather than here. Catch
  // it while there is still a specific thing to say about it.
  if (!target.namespace || !target.labelSelector) {
    target.unstreamableReason = "k8s runtime is missing namespace or label_selector";
    return target;
  }

  target.streamable = true;
  return target;
}

// Every registered repo as a log-streaming target. Ordered as the registry
// file is, so the picker matches what an operator sees in repos.json.
function listRuntimeTargets() {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const registry = JSON.parse(raw);
  return Object.entries(registry).map(([repoKey, entry]) => toRuntimeTarget(repoKey, entry));
}

// Single-target lookup, for resolving a repoKey SERVER-SIDE at WS upgrade time
// (phase 2). The namespace and selector a stream runs with must come from the
// registry, never from the client - the dashboard password is shared, so an
// authenticated socket is not by itself authorised to stream an arbitrary
// target. Returns null for an unknown key, which the caller turns into a 403.
function getRuntimeTarget(repoKey) {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const registry = JSON.parse(raw);
  if (!Object.prototype.hasOwnProperty.call(registry, repoKey)) return null;
  return toRuntimeTarget(repoKey, registry[repoKey]);
}

module.exports = {
  listRepos,
  repoExists,
  listRuntimeTargets,
  getRuntimeTarget,
  // Exported for the tests, so the tagged-union branches can be exercised
  // without a registry fixture on disk - the retired "docker" form and the
  // no-runtime form have no entry in repos.json to read. Same underscore
  // convention as logStream's _constants.
  _toRuntimeTarget: toRuntimeTarget,
};
