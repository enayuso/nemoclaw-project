#!/usr/bin/env bash
# pre-push hook: mechanical safety net independent of agent behavior -
# blocks a push if py_compile fails on changed .py files, if the pushed
# commits contain an obvious secret pattern, if this repo's
# modifications_enabled flag in the registry is false, or (for a non-trunk
# branch) if the branch doesn't already contain the current tip of
# main. Lives in the shared .git/hooks dir, so it applies to
# every worktree automatically (git worktrees share the common git dir, not
# a separate one per worktree). Rendered from templates/pre-push-hook.sh.tmpl
# by register-repo.sh - edit the template and re-render, don't hand-edit
# this file directly.
#
# Freshness gate added 2026-07-23 after a real incident: a write-capable
# agent committed and pushed a fix without ever running the documented
# Stage 2 "fetch origin/main and rebase if it moved" check -
# AGENTS.md said to do it, the agent didn't, and only self-caught after
# being asked directly, by which point the branch was already pushed. No
# actual conflict happened that time (pure luck - the commit that had
# landed touched a different file), but the near-miss showed the same
# lesson this project already learned from the SSH-boundary incident:
# prose-only "always do X first" rules are not reliably followed, even
# when explicit. Encoding the fetch-and-rebase-if-needed requirement as a
# push-time ancestor check makes it mechanical instead of trusting the
# agent remembered.
set -uo pipefail

REPO_KEY="svc-sandbox-mcp"
TRUNK_BRANCH="main"
REGISTRY_FILE="/sandbox/pilot-state/registry.json"

# Mechanical gate on the modifications toggle - checked once, up front,
# before any py_compile/secret-scan work. Unconditional: if this repo is
# toggled read-only, EVERY push is blocked regardless of what it contains.
# A missing registry file or entry fails CLOSED (blocks the push) rather
# than open - an absent/malformed registry should never silently grant
# write access it didn't explicitly confirm.
if [ ! -f "$REGISTRY_FILE" ]; then
  echo "pre-push: registry file ${REGISTRY_FILE} not found - failing closed, push blocked" >&2
  exit 1
fi
# NOT `.modifications_enabled // false` - jq's `//` treats an explicit
# `false` as "absent" too, not just null/missing. This particular default
# (false) happens to coincide with the disabled value, which would mask
# the bug here - but a different registry field with a real true-shaped
# default hit this for real (see watcher.sh.tmpl's monitoring check, fixed
# after catching it empirically). Fixed the same way here for real
# correctness, not by accident.
MODIFICATIONS_ENABLED=$(jq -r --arg k "$REPO_KEY" '.[$k].modifications_enabled' "$REGISTRY_FILE" 2>/dev/null || echo null)
if [ "$MODIFICATIONS_ENABLED" = "null" ]; then
  MODIFICATIONS_ENABLED="false"
fi
if [ "$MODIFICATIONS_ENABLED" != "true" ]; then
  echo "pre-push: modifications_enabled is false for '${REPO_KEY}' in the registry - push blocked" >&2
  echo "pre-push: a human must flip this via toggle-repo.sh before this repo can be pushed to" >&2
  exit 1
fi

FAIL=0
ZERO_SHA="0000000000000000000000000000000000000000"
SECRET_PATTERNS='ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----|xox[baprs]-[0-9A-Za-z-]{10,}'

# Fetched once, up front, rather than trusting whatever local
# origin/$TRUNK_BRANCH ref already happens to exist - the whole point of
# this check is to catch a push based on a clone nobody refreshed, so
# reading a possibly-equally-stale local ref would be circular. A fetch
# failure fails CLOSED (same discipline as the registry check above) - an
# unverifiable freshness check is not the same as a passed one.
#
# Retried 3x with backoff (2026-09-04). OpenShell's CONNECT proxy occasionally
# cannot identify the calling process and denies the request outright:
# "failed to resolve peer binary: No ESTABLISHED TCP connection found ... in
# /proc/<pid>/net/tcp{,6}". Rare and transient - 9 denials in one 6-minute
# window, then 15/15 success on immediate retest - but there is no upstream fix
# at any version (OpenShell main still scans only that one path; the three PRs
# proposing a fallback, NVIDIA/OpenShell#684, #956 and #1302, were all closed
# unmerged). Single-shot, that ~1% transient blocks a legitimate push with a
# misleading "network issue" message. Still fails CLOSED after the last attempt:
# retrying widens the window for a real fetch, it does not weaken the gate.
FETCH_OK=""
for attempt in 1 2 3; do
  if git fetch origin "$TRUNK_BRANCH" >/dev/null 2>&1; then
    FETCH_OK=1
    break
  fi
  [ "$attempt" = 3 ] || sleep $((attempt * 3))
done
if [ -z "$FETCH_OK" ]; then
  echo "pre-push: could not fetch origin/${TRUNK_BRANCH} to verify freshness after 3 attempts - push blocked" >&2
  echo "pre-push: check /var/log/openshell.*.log for 'failed to resolve peer binary' (transient proxy denial - just retry) before assuming a network or credential problem" >&2
  exit 1
fi
TRUNK_TIP=$(git rev-parse "origin/${TRUNK_BRANCH}" 2>/dev/null || echo "")

# remote_ref (unused) is read to match git's standard pre-push stdin format
# (local_ref local_sha remote_ref remote_sha) - all four fields must be read
# even though this hook only needs three of them.
# shellcheck disable=SC2034
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO_SHA" ] && continue  # deleting a ref, nothing to check

  if [ "$remote_sha" = "$ZERO_SHA" ]; then
    MERGE_BASE=$(git merge-base "$TRUNK_BRANCH" "$local_sha" 2>/dev/null || echo "$local_sha")
    RANGE="${MERGE_BASE}..${local_sha}"
  else
    RANGE="${remote_sha}..${local_sha}"
  fi

  # Freshness gate: a non-trunk branch must already contain the current tip
  # of origin/$TRUNK_BRANCH, proving a fetch-and-rebase-if-needed happened
  # before this push (see AGENTS.md's "Freshness re-check" note - this
  # makes that mandatory instead of just documented). If trunk hasn't moved
  # since the branch was created, this is trivially true; if it has and the
  # agent properly rebased, it's also true (the rebased branch's own
  # history now contains the new trunk tip). It only fails in exactly the
  # case this exists to catch: trunk moved and nobody rebased onto it.
  if [ "$local_ref" != "refs/heads/${TRUNK_BRANCH}" ] && [ -n "$TRUNK_TIP" ]; then
    if ! git merge-base --is-ancestor "$TRUNK_TIP" "$local_sha" 2>/dev/null; then
      echo "pre-push: ${local_ref} does not contain the current tip of origin/${TRUNK_BRANCH} (${TRUNK_TIP}) - fetch and rebase onto origin/${TRUNK_BRANCH} before pushing (see AGENTS.md's Freshness re-check) - push blocked" >&2
      FAIL=1
    fi
  fi

  # Array, not a plain string, so filenames survive intact even with spaces -
  # a plain unquoted $CHANGED_PY would word-split on whitespace, silently
  # breaking on any path containing one. Python-only check - on a non-Python
  # repo this simply finds zero changed .py files and no-ops (see the
  # write-capable agent template's own note on why its Stage 3 matters more
  # there, since this hook provides no equivalent check for other languages).
  mapfile -t CHANGED_PY < <(git diff --name-only --diff-filter=ACM "$RANGE" -- '*.py' 2>/dev/null || true)
  if [ "${#CHANGED_PY[@]}" -gt 0 ]; then
    if ! python3 -m py_compile "${CHANGED_PY[@]}" 2>&1; then
      echo "pre-push: py_compile FAILED on changed files in ${local_ref} - push blocked" >&2
      FAIL=1
    fi
  fi

  SECRET_HITS=$(git diff "$RANGE" 2>/dev/null | grep -nE "$SECRET_PATTERNS" || true)
  if [ -n "$SECRET_HITS" ]; then
    echo "pre-push: possible secret pattern detected in ${local_ref}'s pushed diff - push blocked" >&2
    echo "$SECRET_HITS" >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "pre-push: one or more checks failed, push aborted (see above)" >&2
fi
exit "$FAIL"
