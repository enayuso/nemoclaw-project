# TOOLS.md - Local Notes

## Repo access

The shared clone lives at `/sandbox/repos/svc-docs-experimental` (always on
`main`). `svc-docs-experimental-escalation` does its actual fix work in an
isolated worktree instead, under
`/sandbox/repos/svc-docs-experimental-worktrees/fix-<slug>/` - normally you don't
need to touch either yourself, since `svc-docs-experimental-escalation` passes you the
diff **and the full contents of every changed file** directly as text
(assembled by `review-msg.sh`, so it is the committed state the diff
describes, not whatever happens to be in the worktree right now).

That pre-fetch is deliberate: it is measurably faster to be handed the bytes
than to go and read them. The PR reviewer's tool-calling version took 900s and
returned nothing, against 99s once its files were pre-fetched. So reach for the
commands below only when what you were given is genuinely insufficient - a
DEGRADED TIER note, or a file you need that was omitted - not as a routine
double-check. You have the same filesystem/exec access everyone in
this sandbox does (dedicated agents don't get a separate security boundary),
but your own `AGENTS.md` scopes you to review-only by instruction, not by an
actual permission restriction. Take that scoping seriously anyway - don't
`git commit`/`git push`/edit files just because you technically can.

If you ever need to check the diff yourself rather than trust what you were
given, `git diff main...fix/<slug>` works from any worktree or
the shared clone - it resolves branch refs directly and doesn't depend on
what's currently checked out where:
```
cd /sandbox/repos/svc-docs-experimental
git diff main...fix/<slug>
```

## Who invokes you and how

`svc-docs-experimental-escalation` calls you directly via shell (it has no special
permission to do this - any agent in this sandbox can invoke any other via
`openclaw agent`):
```
env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_PORT -u OPENCLAW_GATEWAY_TOKEN \
  openclaw agent --agent svc-docs-experimental-reviewer --session-key "agent:svc-docs-experimental-reviewer:review-<slug>" \
  --timeout 300 -m "<incident description + the diff + which files it touches>"
```
The `env -u ...` prefix is required - a nested `openclaw agent` call from
inside another agent's own running turn otherwise fails with
`GatewayExplicitAuthRequiredError`. If you ever see `svc-docs-experimental-escalation`
invoke you without it and it fails, that's the cause.

The session key is stable per fix (same `<slug>` every round for the same
incident, not a fresh timestamp each time) - fixed 2026-07-31: a
fresh-session-per-call design meant a still-open incident re-escalated
across many watcher cycles minted a brand-new, permanently-visible session
every single time, flooding the dashboard's Recents list. If you're seeing
prior review rounds already in this same thread, that's expected, not a
bug - it means `svc-docs-experimental-escalation` is following up on an issue you've
already looked at before, most likely a revision addressing your own
earlier feedback, or the same still-unresolved incident recurring. Assess
whatever diff is in front of you fresh, on its own merits, regardless of
what you concluded in an earlier round of this same thread - a past
verdict here isn't pre-approval for what's changed since. Only a
genuinely different fix gets a different `<slug>` and therefore a
different session.

## Reminders

- This scope (independent second-opinion review) is unique to you - don't
  assume any other agent has it, and don't assume `svc-docs-experimental-escalation`
  will always call you (if a report reaches you as already-pushed or
  already-merged, that's `svc-docs-experimental-escalation` skipping a step it
  shouldn't have - say so).
