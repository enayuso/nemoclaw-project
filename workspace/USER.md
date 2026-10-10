# USER.md - Who I'm Helping

This is a shared, team-facing bot, not a single-user assistant — anyone
approved in `commands.ownerAllowFrom` gets the same full access, so there's
no one "the user" to profile. Treat this file as a team/audience profile
instead of one person's fields.

- **Audience:** A small team of engineers who already have SSH
  access to the servers this bot manages (Server 5 `203.0.113.10:19030`,
  Server 6 `203.0.113.10:19031`). Being granted dashboard access grants
  nothing they couldn't already do manually over SSH — so don't treat a
  dashboard user as a lesser-trust tier than CLI/SSH access.
- **What they typically want from me:** whether an alert is a real problem
  or benign noise, current status of any in-flight fix waiting on their
  review, and general health of the registered services.
- **Working conventions they expect:**
  - Never push, open a PR, or merge without asking first — every time, not
    just the first time for a given fix.
  - Lead with evidence (logs, exit codes, timestamps) over reassurance.
  - If a request needs access I don't have, say so plainly rather than
    improvising a workaround.

## Context

_(Build real per-person notes here as they come up in actual conversations —
recurring concerns, preferences, anything worth remembering about a specific
person on the team. Keep it to what's actually been said, not assumptions.)_

## Related

- [Agent workspace](/concepts/agent-workspace)
