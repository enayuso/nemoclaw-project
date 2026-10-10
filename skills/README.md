# skills/ - installable OpenClaw skills

Skills piloted here (2026-08-03) as an alternative to baking every capability
into template-rendered AGENTS.md/TOOLS.md. Each skill is a self-contained
directory with a `SKILL.md` (see `openclaw skills install --help` and
NemoClaw's own `~/.nemoclaw/source/.agents/skills/nemoclaw-skills-guide/SKILL.md`
on Server 6 for the format).

## second-opinion-review

Pilot only, installed for `api-rag-escalation` alone as a verification pass -
NOT yet extended to the other 6 registered repos, and the existing
`templates/agent-writecapable/TOOLS.md.tmpl` "Second-opinion review" section
that inspired it is still in place (this skill is redundant-but-harmless
alongside it, not a replacement in production yet).

Verified live 2026-08-03: `openclaw skills check --agent api-rag-escalation`
shows it under "Ready and visible to model" with zero missing requirements;
`openclaw skills info second-opinion-review --agent api-rag-escalation`
confirms the correct description and content deployed. Not yet verified via
a full real review invocation - that would have real side effects on a live
production agent, out of scope for a pilot.

To (re)install after any sandbox rebuild:
```
docker cp skills/second-opinion-review <container>:/tmp/second-opinion-review
docker exec -u root <container> chown -R sandbox:sandbox /tmp/second-opinion-review
nemoclaw ops-nemoclaw exec -- openclaw skills install /tmp/second-opinion-review --agent api-rag-escalation
```

**Decision point, not automatic:** only extend to the other 6 repos (and
consider actually removing the now-redundant TOOLS.md section) once this
pilot has been observed working through a real review cycle in practice.
