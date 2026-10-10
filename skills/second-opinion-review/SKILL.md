---
name: "second-opinion-review"
description: "How to get an independent second-opinion review from this repo's own <repo>-reviewer agent before pushing a fix or reporting a diagnostic conclusion. Applies to every registered repo's escalation/reviewer/pr-reviewer agents, not just one. Use before Stage 4 of the staged fix protocol, every time, no exceptions - this is mandatory, not optional. Trigger keywords - second opinion, reviewer, review, independent check, before pushing, before reporting."
license: "Apache-2.0"
---

<!-- Pilot skill, 2026-08-03 - converted from templates/agent-writecapable/TOOLS.md.tmpl's
     "Second-opinion review" section (nemoclaw-project), scoped to api-rag only as a
     verification pilot before deciding whether to convert the other 6 repos' templates too.

     UPDATE 2026-09-03: actually installed via `nemoclaw ops-nemoclaw skill install` for
     the first time (it had sat here, never deployed, since the pilot - `openclaw skills
     list` confirmed it wasn't among the sandbox's registered skills until this). Because a
     skill installs sandbox-wide, not per-agent, every one of the 7 registered repos'
     escalation/reviewer/pr-reviewer agents now sees this skill, not just api-rag's - so the
     REVIEWER_AGENT value below could no longer stay hardcoded to "api-rag-reviewer" without
     silently telling the other 6 repos' agents to review through the wrong repo's reviewer.
     Generalized instead: every registered repo follows the exact same
     <repo>-escalation / <repo>-reviewer / <repo>-pr-reviewer naming convention (confirmed
     live across all 7), so the agent derives REVIEWER_AGENT from its OWN agent id - which it
     already knows from its own AGENTS.md/system context - rather than this file hardcoding
     one repo's name. There is no config-based per-agent skill scoping that would have solved
     this more simply: agents.list[].skills is an explicit allowlist that fully replaces
     inherited defaults rather than merging with them, so scoping this one skill that way
     would have meant hand-enumerating every other skill each of the 7 repos' 21 agents
     should keep seeing, and manually keeping that list in sync forever. Fixing the skill's
     own content once is the durable fix; per-agent config scoping is not. -->

# Second-opinion review

**First, determine REVIEWER_AGENT for this call**: take your own agent id
(you already know this from your own AGENTS.md/system context) and replace
its trailing `-escalation` or `-pr-reviewer` suffix with `-reviewer`. For
example, if you are `api-rag-escalation` or `api-rag-pr-reviewer`,
REVIEWER_AGENT is `api-rag-reviewer`; if you are `svc-core-escalation`,
REVIEWER_AGENT is `svc-core-reviewer`. Every registered repo follows
this same convention - never hardcode a specific repo's reviewer name here,
and never ask a different repo's reviewer to review your work.

```
env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_PORT -u OPENCLAW_GATEWAY_TOKEN \
  openclaw agent --agent <REVIEWER_AGENT> --session-key "agent:<REVIEWER_AGENT>:review-<slug>" \
  --timeout 300 -m "Incident: <what you were fixing and why>

Diff:
$(git diff main...fix/<slug>)

This may be a revised diff for an incident already reviewed earlier in this
same session (the watcher re-escalating a still-open issue, or you
addressing prior feedback) - assess what's ABOVE fresh, on its own merits.
A past round's verdict in this thread isn't pre-approval for what's changed
since; say so explicitly if this revision doesn't actually address earlier
feedback."
```

Reuse the SAME session key across every review round for this one incident
(the `<slug>` is the exact same identifier the stage tracker already keys
this fix by - not a new piece of state) - only a genuinely different fix
gets a different slug and therefore a different session. A still-open
incident re-escalated across many watcher cycles must NOT mint a fresh
session each time - that floods the dashboard's Recents list with dozens
of entries for what is, from a human's perspective, one ongoing issue.
Independence from the prior round is asked for directly in the prompt
above, not enforced by starting a new session.

**Important — the `env -u ...` prefix above is required, not optional.**
Your own agent process runs with `OPENCLAW_GATEWAY_URL`/`_PORT`/`_TOKEN` set
(it needs those for its own gateway connection), and a nested shell command
inherits them by default. When it does, the nested `openclaw agent` call
sees those as an explicit gateway-URL override and fails with
`GatewayExplicitAuthRequiredError: gateway url override requires explicit
credentials` — even though invoking the exact same command from a plain
shell (e.g. a cron job, which doesn't have these vars set) works fine. If
this ever fails anyway, don't silently skip the review and self-assess
instead — say so explicitly in your report, the way you'd report any other
tool failure.

## When this applies

Every time, before Stage 4 (report and ask permission) of the staged fix
protocol, and before reporting any diagnostic conclusion to a human -
mandatory, never skippable to save time, even under time pressure. Applies
identically regardless of which registered repo you are working in - only
REVIEWER_AGENT changes, never the requirement itself.
