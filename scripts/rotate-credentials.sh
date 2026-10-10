#!/usr/bin/env bash
# rotate-credentials.sh - re-point every registered repo's sandbox clone at a
# new GitHub PAT, in one pass, verifying each one actually authenticates.
#
# UNLIKE every other script in this directory, this one is NOT agent-safe: it
# reads a real credential out of .env and puts it into git remote URLs. Run it
# yourself. Never ask an AI agent to run it, and never paste a token into a
# chat to get it run - same "you run it, not the agent" rule as bootstrap.sh's
# clone step and register-repo.sh's printed clone command, just stated louder
# because this script's whole job is credential handling.
#
# WHY THIS EXISTS: the PAT lives embedded in each /sandbox/repos/<name>/.git/
# config origin URL, once per registered repo - PLUS any clone outside that
# directory (see EXTRA_CLONES below). Rotating it by hand is one
# `git remote set-url` per repo, and missing one doesn't fail loudly - that
# repo's escalation agent just silently loses the ability to push, surfacing
# days or weeks later when it next tries to open a PR. Confirmed 2026-08-05:
# svc-docs-experimental had sat with a non-pushable remote since its
# repoint, and nothing detected it. Confirmed again 2026-08-06 from the other
# direction - this script itself stranded the one clone it didn't know about.
#
# WHY IT READS .env AND NOT THE SHELL ENVIRONMENT: also confirmed 2026-08-05,
# the GITHUB_PAT exported in Server 6's interactive shell was NOT the
# credential the clones actually used, and failed authentication outright. A
# script reading $GITHUB_PAT from whatever happens to be exported would
# cheerfully rotate all seven repos onto a dead token. Reading .env instead
# means the file that bootstrap.sh and every future rebuild will use is
# necessarily the same value that just got verified here - the rotation can't
# leave .env stale behind it, because .env is the input.
#
# So the intended order is: edit .env with the new token FIRST, then run this.
#
# SAFETY DESIGN - probe everything before writing anything. Phase 1 tests the
# new credential against every registered repo's remote using a throwaway URL
# that is never stored. Only if ALL of them pass does Phase 2 touch a single
# .git/config. This matters because a fine-grained PAT can legitimately have
# access to six repos and not the seventh (exactly the shape of the
# svc-docs-experimental failure), and finding that out after overwriting
# six working remotes would turn a rotation into an outage.
#
# Usage: rotate-credentials.sh [--dry-run] [--env-file PATH] [--repo KEY]
#   --dry-run     run Phase 1 (probe) only, write nothing. Safe to run anytime,
#                 and the right way to check whether a token covers every repo
#                 before committing to the rotation.
#   --env-file    read credentials from somewhere other than <repo-root>/.env
#   --repo KEY    limit to a single registered repo (probe + rotate just that
#                 one). Mainly for repairing one clone, as opposed to a real
#                 fleet-wide rotation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="ops-nemoclaw"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"
ENV_FILE="$REPO_ROOT/.env"

# shellcheck source=lib/sandbox-helpers.sh
source "$SCRIPT_DIR/lib/sandbox-helpers.sh"

DRY_RUN=0
ONLY_REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --repo) ONLY_REPO="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Credentials -------------------------------------------------------------
# Sourced in a subshell-free way but deliberately never echoed. Nothing below
# this point prints $PAT, and the two `set -x`-style debugging aids you might
# reach for (bash -x, printing the built URL) would both leak it - don't add
# them. If you need to debug a URL, print it through
# `sed -E 's#//[^@]*@#//***@#'` like the verify step does.

if [ ! -f "$ENV_FILE" ]; then
  echo "error: no credentials file at $ENV_FILE" >&2
  echo "Create it from .env.example and put the NEW token in it before rotating." >&2
  exit 1
fi

# `source` EXECUTES the file, so a malformed line doesn't just fail to
# assign - it runs. An unquoted value with a space in it (GITHUB_PAT=ghp_a b)
# makes bash try to run `b` as a command and abort at 127, with a raw
# "command not found" that says nothing about what's actually wrong. The
# guard below turns that into an actionable message. It does NOT make
# sourcing an untrusted file safe, and isn't meant to: .env is gitignored,
# should be chmod 600, and is trusted input by the same logic bootstrap.sh
# already relies on.
set -a
# shellcheck source=/dev/null
if ! source "$ENV_FILE"; then
  set +a
  echo "" >&2
  echo "error: ${ENV_FILE} failed to parse (see the error just above)." >&2
  echo "Usually an unquoted value containing a space or a shell metacharacter." >&2
  echo "Each line should be KEY=value with no spaces around '=', and the token" >&2
  echo "quoted if it contains anything unusual. Nothing was rotated." >&2
  exit 1
fi
set +a

MISSING=()
[ -z "${GITHUB_USERNAME:-}" ] && MISSING+=("GITHUB_USERNAME")
[ -z "${GITHUB_PAT:-}" ] && MISSING+=("GITHUB_PAT")
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "error: ${ENV_FILE} is missing or has empty: ${MISSING[*]}" >&2
  exit 1
fi

# A token containing /, @, : or ? would silently corrupt the URL it gets
# embedded in rather than failing cleanly - and the resulting remote would
# look plausible in every redacted printout. GitHub's own formats (ghp_*,
# github_pat_*) are [A-Za-z0-9_] only, so anything outside that is far more
# likely a copy-paste accident (a trailing newline, a quoted string, a whole
# `export FOO=` line pasted in) than a real token.
if ! printf '%s' "$GITHUB_PAT" | grep -qE '^[A-Za-z0-9_]+$'; then
  echo "error: GITHUB_PAT contains characters outside [A-Za-z0-9_]." >&2
  echo "That's almost certainly a copy-paste artifact (stray quotes, whitespace," >&2
  echo "or a full 'export X=...' line). Fix ${ENV_FILE} and re-run. Not printing it." >&2
  exit 1
fi
if ! printf '%s' "$GITHUB_USERNAME" | grep -qE '^[A-Za-z0-9_-]+$'; then
  echo "error: GITHUB_USERNAME contains unexpected characters - check ${ENV_FILE}." >&2
  exit 1
fi

CREDS="${GITHUB_USERNAME}:${GITHUB_PAT}"
# Fingerprint, not the value - safe to print, and lets you tell at a glance
# whether .env actually differs from what the clones already hold (i.e.
# whether this rotation is a no-op). Same trick used to diagnose the
# 2026-08-05 mismatch; see project_server6_github_credential_state.
CREDS_FP=$(printf '%s' "$CREDS" | sha256sum | cut -c1-12)

# --- Enumerate targets -------------------------------------------------------
# Clones that live in the sandbox but are NOT registered repos, so the KEYS
# loop below never sees them. Format: <clone path>|<org/name>
#
# Added 2026-08-06 after exactly the failure this script exists to prevent,
# just outside its own coverage: the 2026-08-05 rotation moved all seven
# registered repos onto the new PAT and silently orphaned the agent's own
# reference clone of THIS repo, because it sits at /sandbox/<name> rather than
# /sandbox/repos/<name> and isn't in registry/repos.json. Its
# nemoclaw-project-repo-sync cron (every 10m, bootstrap.sh step 4) began
# failing on the very next cycle - 09:00 success, 09:10 "Invalid username or
# token" - and kept failing for 25 hours. Nothing surfaced it except the Ops
# modal's own watcher list eventually showing ERROR, which is precisely the
# "missing one doesn't fail loudly" problem in this script's header.
#
# If you add another clone outside /sandbox/repos, add it here in the same
# breath or the next rotation will strand it the same way.
EXTRA_CLONES=(
  "/sandbox/nemoclaw-project|enayuso/nemoclaw-project"
)
# STILL OUT OF SCOPE, deliberately: the HOST clone at
# ~/nemoclaw-project. Every path this script rotates lives inside the
# sandbox and is reached through `nemoclaw exec`; the host clone needs a plain
# local `git remote set-url` instead, so it is handled as a one-off step in
# docs/recovery.md rather than bolted on here. It bit for a third time on
# 2026-08-10: a fresh interactive `git clone` stores no credentials at all, so
# the deploy loop's `git pull --ff-only` failed with "could not read Username"
# on the very first pull after the rebuild. If you ever teach this script to
# rotate host-side clones, that is the path to add.

if [ -n "$ONLY_REPO" ]; then
  if ! jq -e --arg k "$ONLY_REPO" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
    echo "error: '${ONLY_REPO}' is not a registered repo key." >&2
    exit 1
  fi
  KEYS=("$ONLY_REPO")
  # --repo is for repairing one named registered clone, so a fleet-wide extra
  # isn't in scope for it - rotating it as a side effect of "fix just this one
  # repo" would be a surprise.
  EXTRA_CLONES=()
else
  mapfile -t KEYS < <(jq -r 'keys[]' "$REGISTRY_JSON")
fi

CONTAINER=$(container_name)
if [ -z "$CONTAINER" ]; then
  echo "error: no running $SANDBOX container - nothing to rotate against." >&2
  exit 1
fi

# sandbox_sh <command> - run a shell command in the sandbox and echo only the
# lines we asked for. Goes through `nemoclaw exec` rather than `docker exec`
# because everything here is networked (git ls-remote) and docker exec has no
# route out - see reference_sandbox_exec_context.
#
# The `|| true` matters under `set -e`: if nemoclaw itself hiccups and emits
# no RESULT line, grep exits 1 and the command substitution's status would
# kill the whole script mid-rotation. Swallowing it yields an empty string
# instead, which every caller below treats as failure - the safe direction,
# since an empty Phase 1 result aborts before anything is written.
sandbox_sh() {
  nemoclaw "$SANDBOX" exec -- bash -c "$1" 2>/dev/null | grep -E '^RESULT:' | sed 's/^RESULT://' || true
}

EXTRA_COUNT=${#EXTRA_CLONES[@]}
echo "=== Rotating GitHub credentials across ${#KEYS[@]} registered repo(s)$([ "$EXTRA_COUNT" -gt 0 ] && echo " + ${EXTRA_COUNT} non-registry clone(s)") ==="
echo "  credentials source:   ${ENV_FILE}"
echo "  new credential:       fingerprint ${CREDS_FP} (value never printed)"
echo "  mode:                 $([ "$DRY_RUN" -eq 1 ] && echo "--dry-run (probe only, writes nothing)" || echo "probe, then rotate")"
echo ""

# --- Phase 1: probe every repo BEFORE writing anything -----------------------
echo "=== Phase 1: probing the new credential against every repo ==="
FAILED=()
declare -A REPO_NAME_OF
declare -A CLONE_PRESENT
for key in "${KEYS[@]}"; do
  org_name=$(jq -r --arg k "$key" '.[$k].repo_org_slash_name' "$REGISTRY_JSON")
  repo_name=$(jq -r --arg k "$key" '.[$k].clone_url' "$REGISTRY_JSON" | xargs basename | sed 's/\.git$//')
  REPO_NAME_OF["$key"]="$repo_name"

  # Throwaway URL - built here, used once, never written to any config.
  probe=$(sandbox_sh "git ls-remote --heads 'https://${CREDS}@github.com/${org_name}.git' >/dev/null 2>&1 && echo RESULT:OK || echo RESULT:FAIL")
  present=$(sandbox_sh "test -d /sandbox/repos/${repo_name}/.git && echo RESULT:yes || echo RESULT:no")
  CLONE_PRESENT["$key"]="$present"

  if [ "$probe" = "OK" ]; then
    if [ "$present" = "yes" ]; then
      echo "  ✓ ${key} (${org_name})"
    else
      echo "  ✓ ${key} (${org_name}) - token works, but no clone at /sandbox/repos/${repo_name}, will skip"
    fi
  else
    echo "  ✗ ${key} (${org_name}) - NEW TOKEN CANNOT ACCESS THIS REPO"
    FAILED+=("$key")
  fi
done

# Same probe for the non-registry clones. A missing one is NOT a failure (the
# clone is optional and a fresh sandbox may not have it yet), but a token that
# can't reach its repo is - it aborts the whole rotation exactly like a
# registered repo would, since writing six good remotes and one dead one is
# the outage this script's phase split exists to avoid.
declare -A EXTRA_PRESENT
for spec in ${EXTRA_CLONES[@]+"${EXTRA_CLONES[@]}"}; do
  clone_path="${spec%%|*}"
  org_name="${spec##*|}"
  probe=$(sandbox_sh "git ls-remote --heads 'https://${CREDS}@github.com/${org_name}.git' >/dev/null 2>&1 && echo RESULT:OK || echo RESULT:FAIL")
  present=$(sandbox_sh "test -d ${clone_path}/.git && echo RESULT:yes || echo RESULT:no")
  EXTRA_PRESENT["$clone_path"]="$present"
  if [ "$probe" != "OK" ]; then
    echo "  ✗ ${clone_path} (${org_name}) - NEW TOKEN CANNOT ACCESS THIS REPO"
    FAILED+=("$clone_path")
  elif [ "$present" = "yes" ]; then
    echo "  ✓ ${clone_path} (${org_name}) - non-registry clone"
  else
    echo "  ✓ ${clone_path} (${org_name}) - token works, no clone there, will skip"
  fi
done
echo ""

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "=== Aborting - nothing was written ===" >&2
  echo "The new credential failed on: ${FAILED[*]}" >&2
  echo "" >&2
  echo "Every existing remote is untouched, so the fleet is exactly as it was." >&2
  echo "Most likely the token's repo scope doesn't cover those - a fine-grained" >&2
  echo "PAT has to list each repo explicitly, and newly-created repos are never" >&2
  echo "added retroactively. Grant it access on GitHub, then re-run." >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: the new credential authenticates against all ${#KEYS[@]} repo(s)."
  echo "Nothing was written. Re-run without --dry-run to rotate."
  exit 0
fi

# --- Phase 2: rotate ---------------------------------------------------------
echo "=== Phase 2: re-pointing remotes ==="
ROTATED=0
SKIPPED=()
for key in "${KEYS[@]}"; do
  repo_name="${REPO_NAME_OF[$key]}"
  org_name=$(jq -r --arg k "$key" '.[$k].repo_org_slash_name' "$REGISTRY_JSON")
  if [ "${CLONE_PRESENT[$key]}" != "yes" ]; then
    SKIPPED+=("$key")
    echo "  - ${key}: no clone in the sandbox, skipped"
    continue
  fi
  sandbox_sh "git -C /sandbox/repos/${repo_name} remote set-url origin 'https://${CREDS}@github.com/${org_name}.git' && echo RESULT:done" >/dev/null
  echo "  ✓ ${key}"
  ROTATED=$((ROTATED + 1))
done

for spec in ${EXTRA_CLONES[@]+"${EXTRA_CLONES[@]}"}; do
  clone_path="${spec%%|*}"
  org_name="${spec##*|}"
  if [ "${EXTRA_PRESENT[$clone_path]}" != "yes" ]; then
    SKIPPED+=("$clone_path")
    echo "  - ${clone_path}: not present in the sandbox, skipped"
    continue
  fi
  sandbox_sh "git -C ${clone_path} remote set-url origin 'https://${CREDS}@github.com/${org_name}.git' && echo RESULT:done" >/dev/null
  echo "  ✓ ${clone_path} (non-registry clone)"
  ROTATED=$((ROTATED + 1))
done
echo ""

# --- Phase 3: verify what's actually stored ----------------------------------
# Deliberately re-tests through the STORED remote rather than trusting Phase
# 1's probe: Phase 1 proved the credential works, this proves the credential
# that landed in .git/config is that same one and got there intact.
echo "=== Phase 3: verifying stored remotes ==="
VERIFY_FAILED=()
for key in "${KEYS[@]}"; do
  [ "${CLONE_PRESENT[$key]}" = "yes" ] || continue
  repo_name="${REPO_NAME_OF[$key]}"
  auth=$(sandbox_sh "git -C /sandbox/repos/${repo_name} ls-remote --heads origin >/dev/null 2>&1 && echo RESULT:OK || echo RESULT:FAIL")
  # `tr -d '\n'` is load-bearing: git remote get-url emits a trailing newline,
  # and CREDS_FP above is computed with `printf '%s'` which does not. Without
  # this, every repo reports a fingerprint mismatch against a rotation that
  # actually succeeded - a false "Rotation INCOMPLETE" that reads exactly like
  # a real failure (observed live 2026-08-05, all seven repos, auth=OK but
  # every fingerprint "wrong"). Both sides must hash the same bytes.
  fp=$(sandbox_sh "git -C /sandbox/repos/${repo_name} remote get-url origin | sed -E 's#^https://([^@]*)@.*#\\1#' | tr -d '\n' | sha256sum | cut -c1-12 | sed 's/^/RESULT:/'")
  if [ "$auth" = "OK" ] && [ "$fp" = "$CREDS_FP" ]; then
    echo "  ✓ ${key} - authenticates, fingerprint ${fp}"
  else
    echo "  ✗ ${key} - auth=${auth} fingerprint=${fp} (expected ${CREDS_FP})"
    VERIFY_FAILED+=("$key")
  fi
done

for spec in ${EXTRA_CLONES[@]+"${EXTRA_CLONES[@]}"}; do
  clone_path="${spec%%|*}"
  [ "${EXTRA_PRESENT[$clone_path]}" = "yes" ] || continue
  auth=$(sandbox_sh "git -C ${clone_path} ls-remote --heads origin >/dev/null 2>&1 && echo RESULT:OK || echo RESULT:FAIL")
  fp=$(sandbox_sh "git -C ${clone_path} remote get-url origin | sed -E 's#^https://([^@]*)@.*#\\1#' | tr -d '\n' | sha256sum | cut -c1-12 | sed 's/^/RESULT:/'")
  if [ "$auth" = "OK" ] && [ "$fp" = "$CREDS_FP" ]; then
    echo "  ✓ ${clone_path} - authenticates, fingerprint ${fp}"
  else
    echo "  ✗ ${clone_path} - auth=${auth} fingerprint=${fp} (expected ${CREDS_FP})"
    VERIFY_FAILED+=("$clone_path")
  fi
done
echo ""

if [ "${#VERIFY_FAILED[@]}" -gt 0 ]; then
  echo "=== Rotation INCOMPLETE ===" >&2
  echo "These repos did not verify: ${VERIFY_FAILED[*]}" >&2
  echo "Their escalation agents cannot push until this is fixed. Re-run with" >&2
  echo "--repo <key> to retry one, and check the clone exists and isn't" >&2
  echo "read-only before assuming the token is at fault." >&2
  exit 1
fi

# --- Phase 4: the gh CLI's own credential store --------------------------
# gh keeps its token in its own config (XDG_CONFIG_HOME/gh/hosts.yml), which
# has nothing to do with the git remotes rotated above. Added 2026-08-06
# after exactly this bit me: the remotes rotated cleanly, the old PAT was
# revoked, and gh silently kept a dead token - discovered only because
# someone went looking. An agent would have found out when a PR failed.
#
# Skipped rather than fatal if gh isn't installed or isn't logged in: a
# sandbox with no gh is a valid state (bootstrap.sh Step 5 installs it), and
# failing the whole rotation over it would be wrong.
echo "=== Phase 4: gh CLI credential ==="
if ! nemoclaw "$SANDBOX" exec -- test -x /usr/local/bin/gh >/dev/null 2>&1; then
  echo "  - gh not installed in the sandbox, skipping (bootstrap.sh Step 5 installs it)"
else
  # `gh auth login --with-token` is happy to replace an existing login, so
  # this needs no logout first and is safe to re-run.
  if sandbox_sh "printf '%s' '${GITHUB_PAT}' | gh auth login --with-token >/dev/null 2>&1 && echo RESULT:ok" | grep -q ok; then
    GH_USER=$(sandbox_sh "gh api /user --jq .login 2>/dev/null | sed 's/^/RESULT:/'")
    if [ -n "$GH_USER" ]; then
      echo "  ✓ gh re-authenticated and verified as '${GH_USER}'"
    else
      echo "  ✗ gh accepted the token but /user failed - check 'gh auth status' by hand" >&2
    fi
  else
    echo "  ✗ gh auth login failed - re-run by hand, see 'gh auth status'" >&2
  fi
fi
echo ""

echo "=== Rotation complete: ${ROTATED} repo(s) now on fingerprint ${CREDS_FP} ==="
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "Skipped (no clone in the sandbox): ${SKIPPED[*]}"
fi
echo ""
echo "Git remotes and the gh CLI are both rotated. The same token may also live in:"
echo "  - ${ENV_FILE}'s GITHUB_MCP_PAT - the GitHub MCP server reads this"
echo "    separately from GITHUB_PAT. If they're the same value, update both and"
echo "    run 'nemoclaw $SANDBOX mcp restart github', or the MCP server keeps"
echo "    using the old one until the next restart."
echo "  - any host-side shell that still has the OLD token exported. A stale"
echo "    export is what caused the 2026-08-05 mismatch in the first place."
echo "  - GitHub itself: the old token is still valid until you revoke it."
echo "    Revoke it now, otherwise this rotation has changed what's used but"
echo "    not what works."
