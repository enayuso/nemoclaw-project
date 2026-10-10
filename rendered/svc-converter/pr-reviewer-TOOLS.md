# TOOLS.md - Local Notes

## You are fed, not tooled

Your `AGENTS.md` tells you not to use tools, and this file does not give you
any workflow that needs them. That is the whole design: the watcher does every
piece of I/O for you, before you are invoked.

You do have the same filesystem/exec access every agent in this sandbox has -
dedicated agents don't get a separate security boundary - and the shared clone
of this repo really is at `/sandbox/repos/svc-converter`. Neither fact is
permission to go and use them. The scoping is by instruction, and the reason
it's worth honouring is cost, not access control: each turn you take costs
about seven minutes, and a call that runs past 600s is killed with no output,
so a "quick look at one more file" can turn a finished review into nothing at
all.

## Who invokes you and how

`/sandbox/pilot-state/svc-converter-pr-watcher.sh`, from cron, once per PR per
head commit:

```
openclaw agent --agent svc-converter-pr-reviewer \
  --session-key "agent:svc-converter-pr-reviewer:pr-<number>-<head-sha-8>" \
  --timeout 1200 -m "<pre-fetched PR metadata + diff + full changed files>"
```

The session key includes the head SHA, so a PR that gets a new push reaches you
as a **fresh session with no history**. That is deliberate - it is a different
diff, and inheriting the previous review's conclusions is exactly the failure
mode to avoid. You will not see your own earlier reviews of the same PR.

Your stdout is the product. The watcher captures it and posts it verbatim as
the PR comment body (stderr is separate and goes to the log, so gateway banners
don't leak into GitHub). Anything you print that isn't the review is something
a human reads on the PR.

## What the message contains

In order: repository, PR number/title/author/base branch/head SHA, the PR
description, the unified diff, then `----- BEGIN <path> -----` /
`----- END <path> -----` blocks with the complete post-change contents of each
changed file.

Two things may be absent, and both are stated explicitly in the message when
they are:

- **A file's contents** - deleted, binary, or over the per-file cap. The diff
  still shows what changed.
- **All file contents (`diff-only` tier)** - the PR was too large to include
  them. Review the diff on its own and say in your report that you did.

Generated files (lockfiles, minified bundles, vendored trees) are deliberately
excluded from the full-contents section even when small. Their diffs are still
present; there is nothing to verify inside them.

## Reminders

- Return the review only - `AGENTS.md` has the exact shape. The watcher wraps
  it in a header/footer, so don't add your own.
- No findings is a good outcome and a normal one. Don't pad.
- You never post to GitHub yourself, and you never merge or approve. See
  `AGENTS.md`'s hard rules.
