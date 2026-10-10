// remoteSessions.js - discovers sessions the Gateway itself knows about
// for each REGISTERED repo's escalation AND reviewer agents, independent
// of whether the dashboard's own sessionIndex.js ever recorded them.
//
// Closes a real gap: registry/schema.md's "correlate_with" mechanism has
// one repo's escalation agent call ANOTHER repo's escalation agent
// directly via `openclaw agent --agent <other-repo>-escalation
// --session-key "agent:<other-repo>-escalation:xref...-<timestamp>"` when
// it finds a genuine cross-repo connection. That creates a real session
// straight on the Gateway - sessionIndex.js never sees it, since nothing
// went through this dashboard's own composer (see routes/run.js's
// sessionIndex.record() call), so it was invisible in Recents even when
// viewing the RECEIVING repo. This module asks the Gateway itself,
// per-repo, what sessions actually exist for each repo's escalation
// agent, so routes/sessions.js can merge that in.
//
// Both escalationAgent and reviewerAgent are queried here, per repo. The
// documented correlate_with mechanism is escalation-agent-to-escalation-
// agent only, but a reviewer session is a real Gateway-side session too -
// the escalation agent's own protocol calls its repo's reviewer agent
// directly (see routes/run.js's top comment: "reviewer isn't user-
// selectable from this dashboard, it's an internal second opinion the
// escalation agent's own protocol calls on its own") - so it's just as
// invisible to sessionIndex.js as a cross-repo escalation handoff is, for
// exactly the same reason (nothing about it went through this dashboard's
// own composer). Each entry is tagged with agentRole so callers (and
// app.js, further downstream) can tell the two apart without re-parsing
// the sessionKey string.

const registry = require("./registry");
const gatewayClient = require("./gatewayClient");

const AGENT_ROLES = [
  { field: "escalationAgent", role: "escalation" },
  { field: "reviewerAgent", role: "reviewer" },
];

// Returns a flat array of { sessionKey, repoKey, agentRole, updatedAt }
// across every registered repo's escalation AND reviewer agents - no
// label yet, since only the caller (routes/sessions.js's
// getMergedSessions()) knows which of these are actually new/unlabeled
// after deduping against the local index.
async function listForRegisteredRepos() {
  const repos = registry.listRepos();

  // One gatewayClient.listAgentSessions() call per repo per role (2 per
  // repo now, still the same Promise.all fan-out pattern) - still bounded
  // and cheap, same defensive key-filtering and per-call error isolation
  // as before this change.
  const perRepoRoleResults = await Promise.all(
    repos.flatMap((repo) =>
      AGENT_ROLES.map(async ({ field, role }) => {
        const agentId = repo[field];
        try {
          const sessions = await gatewayClient.listAgentSessions(agentId);
          // Filters out any entry missing a usable string key BEFORE it ever
          // reaches routes/sessions.js - a malformed record (future API
          // change, or a transient gateway glitch) must not throw downstream
          // in labelsFromRecentMessages()'s sessionKey.slice() fallback
          // construction, which would otherwise surface as an unhandled
          // rejection in an async route handler with no surrounding
          // try/catch (confirmed a real risk in review 2026-07-29).
          return sessions
            .filter((entry) => entry && typeof entry.key === "string" && entry.key)
            .map((entry) => ({
              sessionKey: entry.key,
              repoKey: repo.repoKey,
              agentRole: role,
              updatedAt: entry.updatedAt,
            }));
        } catch (err) {
          // Defensive even though gatewayClient.listAgentSessions itself
          // already catches and returns [] on failure - a single repo's
          // gateway hiccup (or an agent that doesn't exist) must never take
          // down the whole /api/sessions merge for every other repo/role.
          console.warn(
            `remoteSessions: failed to list sessions for repo '${repo.repoKey}' (agent '${agentId}'):`,
            err.message,
          );
          return [];
        }
      }),
    ),
  );

  return perRepoRoleResults.flat();
}

module.exports = { listForRegisteredRepos };
