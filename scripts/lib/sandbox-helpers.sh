# sandbox-helpers.sh - shared nemoclaw/docker helpers.
# Not a standalone script - source it, don't execute it. Requires $SANDBOX to
# already be set by the caller before sourcing.
#
# Extracted 2026-07-16 from bootstrap.sh (pure extraction, no behavior
# change) so new registry-driven scripts (register-repo.sh, toggle-repo.sh,
# deregister-repo.sh) don't need a third copy-paste of these - the exact
# duplication problem already flagged in the two watcher scripts before this
# extraction happened.

# Pin the OpenShell gateway port every nemoclaw call below needs (added
# 2026-09-04). Port 8080, NemoClaw's compiled-in default, is permanently
# occupied on this host by a long-lived Jenkins instance unrelated to
# NemoClaw (confirmed via its own HTTP response headers). NemoClaw refuses
# to start its managed gateway when it finds an unrecognized listener
# already on that port and does not fall back to discovering an
# already-running non-default-port gateway on its own - every nemoclaw
# call in this file failed closed with "Sandbox does not exist" even
# though ops-nemoclaw was completely healthy, and
# ops-nemoclaw-watchdog.sh's cron-triggered `recover` calls (which get
# no shell profile, unlike an interactive login) were silently no-op'ing
# every tick as a result - found live 2026-09-04 while investigating why
# `nemoclaw list` reported zero sandboxes despite a healthy, actively-
# cron-firing container.
#
# ops-nemoclaw's gateway has actually been running on port 8180 since
# 2026-07-23 (see dashboard/.env's own NEMOCLAW_GATEWAY_PORT comment) via
# NemoClaw's standalone-fallback path, which works once told the right
# port - NEMOCLAW_GATEWAY_PORT is NemoClaw's own first-class override for
# exactly this (see ~/.nemoclaw/source/src/lib/tunnel/
# gateway-port-resolution.ts on the sandbox host). If ops-nemoclaw is
# ever fully destroyed and recreated (nemoclaw onboard
# --recreate-sandbox), a fresh onboard may claim a different port -
# re-check via `nemoclaw list` with this unset before assuming 8180 still
# applies.
export NEMOCLAW_GATEWAY_PORT="${NEMOCLAW_GATEWAY_PORT:-8180}"

container_name() {
  # OpenShell 0.0.101 (post nemoclaw v0.0.109 upgrade, 2026-09-03) changed the
  # docker container naming scheme to insert a workload-group segment between
  # "openshell-" and the sandbox name (observed live: "openshell-default--
  # ops-nemoclaw-<uuid>" instead of the old "openshell-ops-nemoclaw-
  # <uuid>") - a bare "openshell-${SANDBOX}-" substring filter no longer
  # matches, breaking every call site in this repo that resolves the
  # container via this function (bootstrap.sh alone has 8). Loosened to
  # tolerate an arbitrary prefix segment between "openshell-" and the
  # sandbox name so this works under both the old and new naming schemes.
  docker ps --filter "name=openshell-.*${SANDBOX}-" --format '{{.Names}}' | head -1
}

# Structured --json + jq check, not a grep over the human-formatted table -
# a real-world bootstrap.sh rerun (2026-07-16) showed the grep version
# silently found nothing and let a duplicate cron job get created, for
# reasons that didn't reproduce on manual retesting (likely a transient
# gateway-restart race). This doesn't depend on CLI display formatting or
# timing in the same way.
cron_job_exists() {
  local name="$1"
  nemoclaw "$SANDBOX" exec -- openclaw cron list --json 2>/dev/null \
    | jq -e --arg name "$name" 'any(.jobs[]?; .name == $name)' >/dev/null 2>&1
}

# cron_job_id <name> - prints the job's id on stdout, or nothing if not
# found (check for an empty result, same "don't assume" discipline as
# cron_job_exists). Added 2026-07-16 for deregister-repo.sh, which needs the
# id to actually call `openclaw cron rm`.
cron_job_id() {
  local name="$1"
  nemoclaw "$SANDBOX" exec -- openclaw cron list --json 2>/dev/null \
    | jq -r --arg name "$name" '(.jobs[]? | select(.name == $name) | .id) // empty'
}

# render_and_redeploy_agent_docs <key> - re-renders and redeploys a
# registered repo's escalation/reviewer AGENTS.md/TOOLS.md from the current
# templates, using its existing registry entry's values. Extracted
# 2026-07-20 from toggle-repo.sh (which only called this when
# modifications_enabled was actually changing) so resync-repo.sh can call
# the exact same logic to push a template improvement to an
# already-registered repo without needing to toggle anything. Requires
# $SCRIPT_DIR, $REPO_ROOT, $REGISTRY_JSON, and a reachable sandbox container
# already set up by the caller, same convention as the rest of this file.
#
# NOTE: takes effect only on that agent's NEXT invocation, not a
# conversation already in flight - same as any other AGENTS.md update in
# this project.
render_and_redeploy_agent_docs() {
  local KEY="$1"
  local CONTAINER
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "warning: could not find a running $SANDBOX container - cannot redeploy agent docs for '$KEY'" >&2
    return 1
  fi

  local ENTRY REPO_NAME REPO_ORG_SLASH_NAME RUNTIME_TYPE TRUNK_BRANCH
  local SECONDARY_BRANCH COOLDOWN_SECONDS ERROR_PATTERN MODIFICATIONS FLAVOR
  local ESCALATION_AGENT REVIEWER_AGENT RENDER_DIR AGENT_TMPL_DIR REVIEWER_TMPL_DIR
  local RUNTIME_FIELDS AGENT_DOC_TOKENS CORRELATE_WITH_CSV

  ENTRY=$(jq --arg k "$KEY" '.[$k]' "$REGISTRY_JSON")
  RUNTIME_TYPE=$(echo "$ENTRY" | jq -r '.runtime.type')
  REPO_NAME=$(echo "$ENTRY" | jq -r '.clone_url' | xargs basename | sed 's/\.git$//')
  REPO_ORG_SLASH_NAME=$(echo "$ENTRY" | jq -r '.repo_org_slash_name')
  TRUNK_BRANCH=$(echo "$ENTRY" | jq -r '.trunk_branch')
  # secondary_branch is a real JSON null (not the boolean false), so the //
  # fallback is safe here - not the false-coercion bug this project hit
  # elsewhere with jq's // operator on boolean fields.
  SECONDARY_BRANCH=$(echo "$ENTRY" | jq -r '.secondary_branch // "none"')
  COOLDOWN_SECONDS=$(echo "$ENTRY" | jq -r '.cooldown_seconds')
  ERROR_PATTERN=$(echo "$ENTRY" | jq -r '.error_pattern')
  MODIFICATIONS=$(echo "$ENTRY" | jq -r '.modifications_enabled')
  # correlate_with is a JSON array (or null) - join back to the same
  # comma-separated shape correlated_repos_note expects.
  CORRELATE_WITH_CSV=$(echo "$ENTRY" | jq -r '(.correlate_with // []) | join(",")')
  ESCALATION_AGENT="${KEY}-escalation"
  REVIEWER_AGENT="${KEY}-reviewer"

  if [ "$RUNTIME_TYPE" = "docker" ]; then
    RUNTIME_FIELDS=("$(echo "$ENTRY" | jq -r '.runtime.ssh_host')" "$(echo "$ENTRY" | jq -r '.runtime.container_dev')")
  else
    RUNTIME_FIELDS=(
      "$(echo "$ENTRY" | jq -r '.runtime.cluster')" "$(echo "$ENTRY" | jq -r '.runtime.namespace')"
      "$(echo "$ENTRY" | jq -r '.runtime.workload_kind')" "$(echo "$ENTRY" | jq -r '.runtime.workload_name')"
      "$(echo "$ENTRY" | jq -r '.runtime.label_selector')"
    )
  fi

  RENDER_DIR="$REPO_ROOT/rendered/$KEY"
  AGENT_TMPL_DIR="agent-readonly"; REVIEWER_TMPL_DIR="reviewer-readonly"; FLAVOR="readonly"
  if [ "$MODIFICATIONS" = "true" ]; then
    AGENT_TMPL_DIR="agent-writecapable"; REVIEWER_TMPL_DIR="reviewer-writecapable"; FLAVOR="writecapable"
  fi

  AGENT_DOC_TOKENS=()
  compute_agent_doc_tokens AGENT_DOC_TOKENS "$RUNTIME_TYPE" "$FLAVOR" "${RUNTIME_FIELDS[@]}"

  local RENDER_ARGS=(
    ESCALATION_AGENT="$ESCALATION_AGENT" REVIEWER_AGENT="$REVIEWER_AGENT"
    REPO_KEY="$KEY" REPO_NAME="$REPO_NAME" REPO_ORG_SLASH_NAME="$REPO_ORG_SLASH_NAME"
    TRUNK_BRANCH="$TRUNK_BRANCH"
    SECONDARY_BRANCH="$SECONDARY_BRANCH"
    DOMAIN_NOTE="(unchanged from registration)" COOLDOWN_SECONDS="$COOLDOWN_SECONDS" ERROR_PATTERN="$ERROR_PATTERN"
    CORRELATED_REPOS="$(correlated_repos_note "$CORRELATE_WITH_CSV")"
    "${AGENT_DOC_TOKENS[@]}"
  )

  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$AGENT_TMPL_DIR/AGENTS.md.tmpl" "$RENDER_DIR/escalation-AGENTS.md" "${RENDER_ARGS[@]}"
  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$AGENT_TMPL_DIR/TOOLS.md.tmpl" "$RENDER_DIR/escalation-TOOLS.md" "${RENDER_ARGS[@]}"
  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$REVIEWER_TMPL_DIR/AGENTS.md.tmpl" "$RENDER_DIR/reviewer-AGENTS.md" "${RENDER_ARGS[@]}"
  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$REVIEWER_TMPL_DIR/TOOLS.md.tmpl" "$RENDER_DIR/reviewer-TOOLS.md" "${RENDER_ARGS[@]}"

  # Config-over-RPC pilot (2026-08-03), api-rag ONLY - verified live that
  # agents.files.set redeploys byte-identical content to docker cp (md5sum
  # + diff match), so this repo alone uses the gateway RPC path instead.
  # The other 6 repos keep docker cp unchanged below - this is a pilot, not
  # a rollout, per that verification's own "decision point, not automatic"
  # note. set-agent-file.js needs its own operator.admin-scoped connection
  # (agents.files.set requires it; the dashboard's own persistent
  # connection deliberately never holds that scope) - see the script's own
  # header comment for why it isn't just gatewayClient.js reused.
  if [ "$KEY" = "api-rag" ]; then
    node "$SCRIPT_DIR/lib/set-agent-file.js" "$ESCALATION_AGENT" AGENTS.md "$RENDER_DIR/escalation-AGENTS.md"
    node "$SCRIPT_DIR/lib/set-agent-file.js" "$ESCALATION_AGENT" TOOLS.md "$RENDER_DIR/escalation-TOOLS.md"
    node "$SCRIPT_DIR/lib/set-agent-file.js" "$REVIEWER_AGENT" AGENTS.md "$RENDER_DIR/reviewer-AGENTS.md"
    node "$SCRIPT_DIR/lib/set-agent-file.js" "$REVIEWER_AGENT" TOOLS.md "$RENDER_DIR/reviewer-TOOLS.md"
    echo "re-rendered and redeployed for '$KEY' via agents.files.set RPC (config-over-RPC pilot - commit rendered/$KEY/*.md yourself when ready)"
  else
    docker cp "$RENDER_DIR/escalation-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace/AGENTS.md"
    docker cp "$RENDER_DIR/escalation-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace/TOOLS.md"
    docker cp "$RENDER_DIR/reviewer-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace/AGENTS.md"
    docker cp "$RENDER_DIR/reviewer-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace/TOOLS.md"
    docker exec -u root "$CONTAINER" chown -R sandbox:sandbox "/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace" "/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace"
    echo "re-rendered and redeployed for '$KEY' (commit rendered/$KEY/*.md yourself when ready)"
  fi
}

# deploy_shared_libs <container> - copies every placeholder-free shared script
# into /sandbox/pilot-state/lib/. These are shared across all repos (the
# reviewer agent, slug, base ref and branch are all arguments), so one copy
# serves every one of them and repeating the copy is harmless.
#
# It exists as a function because it has TWO callers that must not drift:
# register-repo.sh at initial registration, and render_and_redeploy_watcher on
# every resync. Before 2026-08-13 they had drifted - registration deployed
# watcher-common.sh only, so a repo registered into a fresh sandbox got agent
# docs referencing /sandbox/pilot-state/lib/review-call.sh and no such file,
# until some unrelated resync happened to fix it. That is the same class of
# silent half-state the 2026-07-31 comment inside the resync path records, and
# adding review-msg.sh as a second file would have doubled it.
#
# watcher-common.sh is SOURCED; the rest are EXECUTED and so also need the
# executable bit. Add new shared scripts to the list below, not to a caller.
deploy_shared_libs() {
  local CONTAINER="$1"

  docker exec "$CONTAINER" mkdir -p /sandbox/pilot-state/lib
  docker cp "$SCRIPT_DIR/lib/watcher-common.sh" "$CONTAINER:/sandbox/pilot-state/lib/watcher-common.sh"
  docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/lib/watcher-common.sh"

  local LIBSH
  for LIBSH in review-call.sh review-msg.sh ask-decision.sh; do
    docker cp "$SCRIPT_DIR/lib/$LIBSH" "$CONTAINER:/sandbox/pilot-state/lib/$LIBSH"
    docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/lib/$LIBSH"
    docker exec -u root "$CONTAINER" chmod 700 "/sandbox/pilot-state/lib/$LIBSH"
  done
}

# render_and_redeploy_watcher <key> - re-renders and redeploys a registered
# repo's watcher.sh from the current templates, using its existing registry
# entry's values. Picks templates/watcher-docker.sh.tmpl or
# templates/watcher-k8s.sh.tmpl by the entry's runtime.type, same tagged-
# union dispatch register-repo.sh itself does at registration time. Added
# 2026-07-21 to close a real gap: resync-repo.sh previously only re-rendered
# agent/reviewer docs, never the watcher script itself, so a template fix to
# watcher-docker.sh.tmpl/watcher-k8s.sh.tmpl/watcher-common.sh never reached
# an already-registered repo without a full deregister/re-register cycle.
# Requires $SCRIPT_DIR, $REPO_ROOT, $REGISTRY_JSON, and a reachable sandbox
# container already set up by the caller, same convention as
# render_and_redeploy_agent_docs above.
render_and_redeploy_watcher() {
  local KEY="$1"
  local CONTAINER
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "warning: could not find a running $SANDBOX container - cannot redeploy watcher for '$KEY'" >&2
    return 1
  fi

  local ENTRY RUNTIME_TYPE COOLDOWN_SECONDS ERROR_PATTERN ESCALATION_AGENT
  local RENDER_DIR RENDER_ARGS SSH_HOST CONTAINER_DEV
  local K8S_CLUSTER K8S_NAMESPACE K8S_WORKLOAD_KIND K8S_WORKLOAD_NAME K8S_LABEL_SELECTOR

  ENTRY=$(jq --arg k "$KEY" '.[$k]' "$REGISTRY_JSON")
  RUNTIME_TYPE=$(echo "$ENTRY" | jq -r '.runtime.type')
  COOLDOWN_SECONDS=$(echo "$ENTRY" | jq -r '.cooldown_seconds')
  ERROR_PATTERN=$(echo "$ENTRY" | jq -r '.error_pattern')
  ESCALATION_AGENT="${KEY}-escalation"
  RENDER_DIR="$REPO_ROOT/rendered/$KEY"
  mkdir -p "$RENDER_DIR"

  if [ "$RUNTIME_TYPE" = "docker" ]; then
    SSH_HOST=$(echo "$ENTRY" | jq -r '.runtime.ssh_host')
    CONTAINER_DEV=$(echo "$ENTRY" | jq -r '.runtime.container_dev')
    RENDER_ARGS=(
      REPO_KEY="$KEY" SSH_HOST="$SSH_HOST" CONTAINER_DEV="$CONTAINER_DEV"
      COOLDOWN_SECONDS="$COOLDOWN_SECONDS" ERROR_PATTERN="$ERROR_PATTERN"
      ESCALATION_AGENT="$ESCALATION_AGENT"
    )
    python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/watcher-docker.sh.tmpl" "$RENDER_DIR/watcher.sh" "${RENDER_ARGS[@]}"
  elif [ "$RUNTIME_TYPE" = "k8s" ]; then
    K8S_CLUSTER=$(echo "$ENTRY" | jq -r '.runtime.cluster')
    K8S_NAMESPACE=$(echo "$ENTRY" | jq -r '.runtime.namespace')
    K8S_WORKLOAD_KIND=$(echo "$ENTRY" | jq -r '.runtime.workload_kind')
    K8S_WORKLOAD_NAME=$(echo "$ENTRY" | jq -r '.runtime.workload_name')
    K8S_LABEL_SELECTOR=$(echo "$ENTRY" | jq -r '.runtime.label_selector')
    RENDER_ARGS=(
      REPO_KEY="$KEY" K8S_CLUSTER="$K8S_CLUSTER" K8S_NAMESPACE="$K8S_NAMESPACE"
      K8S_WORKLOAD_KIND="$K8S_WORKLOAD_KIND" K8S_WORKLOAD_NAME="$K8S_WORKLOAD_NAME"
      K8S_LABEL_SELECTOR="$K8S_LABEL_SELECTOR" COOLDOWN_SECONDS="$COOLDOWN_SECONDS"
      ERROR_PATTERN="$ERROR_PATTERN" ESCALATION_AGENT="$ESCALATION_AGENT"
    )
    python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/watcher-k8s.sh.tmpl" "$RENDER_DIR/watcher.sh" "${RENDER_ARGS[@]}"
  else
    echo "error: '$KEY' has unrecognized runtime.type '$RUNTIME_TYPE' - cannot render a watcher" >&2
    return 1
  fi

  docker cp "$RENDER_DIR/watcher.sh" "$CONTAINER:/sandbox/pilot-state/${KEY}-watcher.sh"
  docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/${KEY}-watcher.sh"
  docker exec -u root "$CONTAINER" chmod 700 "/sandbox/pilot-state/${KEY}-watcher.sh"

  # Fixed 2026-07-31: this function's own doc comment above claims it
  # closes the gap of "a template fix to watcher-docker.sh.tmpl/
  # watcher-k8s.sh.tmpl/watcher-common.sh never reaching an already-
  # registered repo" - but it only ever re-rendered/redeployed the
  # per-repo watcher.sh, never the shared lib/watcher-common.sh itself
  # (only register-repo.sh's own one-time initial deploy did, at
  # registration time). A real watcher-common.sh fix (e.g. the incident-
  # signature dedup fix, same day) would have silently never reached any
  # already-registered repo's sandbox otherwise, with no error or warning
  # to indicate the gap. Plain file copy, not a template render - this
  # file has no placeholders - and shared across every repo's watcher, so
  # this is harmless to repeat once per resync call even though the
  # destination is identical every time.
  deploy_shared_libs "$CONTAINER"

  echo "watcher (+ shared watcher-common.sh, review-call.sh, review-msg.sh, ask-decision.sh) re-rendered and redeployed for '$KEY' (commit rendered/$KEY/watcher.sh yourself when ready)"
}

# render_and_redeploy_pre_push_hook <key> - re-renders and redeploys a
# registered repo's pre-push hook from the current template, using its
# existing registry entry's values. Unlike the two functions above, this
# writes into the repo's OWN git clone at
# /sandbox/repos/<repo_name>/.git/hooks/pre-push (not /sandbox/.openclaw or
# /sandbox/pilot-state), matching exactly how register-repo.sh installs it
# at initial registration - skips (with a warning, not an error) if that
# clone doesn't exist yet, same "don't abort the whole --all resync over
# one repo" discipline as the other two functions. Added 2026-07-23
# alongside the pre-push hook's new freshness gate, to close the same kind
# of gap the watcher redeploy closed on 2026-07-21: without this, a
# pre-push-hook.sh.tmpl fix would never reach an already-registered repo
# without a full deregister/re-register cycle. Requires $SCRIPT_DIR,
# $REPO_ROOT, $REGISTRY_JSON, and a reachable sandbox container already set
# up by the caller, same convention as the other two functions.
render_and_redeploy_pre_push_hook() {
  local KEY="$1"
  local CONTAINER
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "warning: could not find a running $SANDBOX container - cannot redeploy pre-push hook for '$KEY'" >&2
    return 1
  fi

  local ENTRY REPO_NAME TRUNK_BRANCH RENDER_DIR
  ENTRY=$(jq --arg k "$KEY" '.[$k]' "$REGISTRY_JSON")
  REPO_NAME=$(echo "$ENTRY" | jq -r '.clone_url' | xargs basename | sed 's/\.git$//')
  TRUNK_BRANCH=$(echo "$ENTRY" | jq -r '.trunk_branch')
  RENDER_DIR="$REPO_ROOT/rendered/$KEY"
  mkdir -p "$RENDER_DIR"

  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/pre-push-hook.sh.tmpl" "$RENDER_DIR/pre-push-hook.sh" \
    REPO_KEY="$KEY" TRUNK_BRANCH="$TRUNK_BRANCH"

  if ! docker exec "$CONTAINER" test -d "/sandbox/repos/${REPO_NAME}/.git"; then
    echo "warning: /sandbox/repos/${REPO_NAME} has no git clone yet - cannot redeploy pre-push hook for '$KEY' (rendered locally to $RENDER_DIR/pre-push-hook.sh anyway)" >&2
    return 1
  fi

  docker cp "$RENDER_DIR/pre-push-hook.sh" "$CONTAINER:/sandbox/repos/${REPO_NAME}/.git/hooks/pre-push"
  docker exec "$CONTAINER" chmod +x "/sandbox/repos/${REPO_NAME}/.git/hooks/pre-push"
  echo "pre-push hook re-rendered and redeployed for '$KEY' (commit rendered/$KEY/pre-push-hook.sh yourself when ready)"
}

# render_and_redeploy_pr_reviewer <key> - re-renders and redeploys a
# registered repo's PR-reviewer agent docs from templates/pr-reviewer/.
# Unlike render_and_redeploy_agent_docs, there is no readonly/writecapable
# flavor split and no runtime dispatch: this agent never touches the
# workload, the cluster, or a git clone, so none of the runtime tokens mean
# anything to it. Added 2026-08-12. Non-fatal (returns 1 with a warning) if
# the sandbox is unreachable, same discipline as its siblings.
render_and_redeploy_pr_reviewer() {
  local KEY="$1"
  local CONTAINER
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "warning: could not find a running $SANDBOX container - cannot redeploy PR-reviewer docs for '$KEY'" >&2
    return 1
  fi

  local ENTRY REPO_NAME REPO_ORG_SLASH_NAME TRUNK_BRANCH RENDER_DIR RENDER_ARGS
  local PR_REVIEWER_AGENT ESCALATION_AGENT REVIEWER_AGENT

  ENTRY=$(jq --arg k "$KEY" '.[$k]' "$REGISTRY_JSON")
  REPO_NAME=$(echo "$ENTRY" | jq -r '.clone_url' | xargs basename | sed 's/\.git$//')
  REPO_ORG_SLASH_NAME=$(echo "$ENTRY" | jq -r '.repo_org_slash_name')
  TRUNK_BRANCH=$(echo "$ENTRY" | jq -r '.trunk_branch')
  PR_REVIEWER_AGENT="${KEY}-pr-reviewer"
  ESCALATION_AGENT="${KEY}-escalation"
  REVIEWER_AGENT="${KEY}-reviewer"
  RENDER_DIR="$REPO_ROOT/rendered/$KEY"
  mkdir -p "$RENDER_DIR"

  RENDER_ARGS=(
    PR_REVIEWER_AGENT="$PR_REVIEWER_AGENT" ESCALATION_AGENT="$ESCALATION_AGENT"
    REVIEWER_AGENT="$REVIEWER_AGENT" REPO_KEY="$KEY" REPO_NAME="$REPO_NAME"
    REPO_ORG_SLASH_NAME="$REPO_ORG_SLASH_NAME" TRUNK_BRANCH="$TRUNK_BRANCH"
    DOMAIN_NOTE="(unchanged from registration)"
    MAX_FINDINGS="${PR_REVIEW_MAX_FINDINGS:-8}"
  )

  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/pr-reviewer/AGENTS.md.tmpl" "$RENDER_DIR/pr-reviewer-AGENTS.md" "${RENDER_ARGS[@]}"
  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/pr-reviewer/TOOLS.md.tmpl" "$RENDER_DIR/pr-reviewer-TOOLS.md" "${RENDER_ARGS[@]}"

  docker cp "$RENDER_DIR/pr-reviewer-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace/AGENTS.md"
  docker cp "$RENDER_DIR/pr-reviewer-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace/TOOLS.md"
  docker exec -u root "$CONTAINER" chown -R sandbox:sandbox "/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace"
  echo "PR-reviewer docs re-rendered and redeployed for '$KEY' (commit rendered/$KEY/pr-reviewer-*.md yourself when ready)"
}

# render_and_redeploy_pr_watcher <key> - re-renders and redeploys a
# registered repo's pr-watcher.sh. Added 2026-08-12, same gap-closing role
# for the PR watcher that render_and_redeploy_watcher has for the incident
# watcher: without it a pr-watcher.sh.tmpl fix would never reach an
# already-registered repo.
render_and_redeploy_pr_watcher() {
  local KEY="$1"
  local CONTAINER
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "warning: could not find a running $SANDBOX container - cannot redeploy PR watcher for '$KEY'" >&2
    return 1
  fi

  local ENTRY REPO_ORG_SLASH_NAME RENDER_DIR
  ENTRY=$(jq --arg k "$KEY" '.[$k]' "$REGISTRY_JSON")
  REPO_ORG_SLASH_NAME=$(echo "$ENTRY" | jq -r '.repo_org_slash_name')
  RENDER_DIR="$REPO_ROOT/rendered/$KEY"
  mkdir -p "$RENDER_DIR"

  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/pr-watcher.sh.tmpl" "$RENDER_DIR/pr-watcher.sh" \
    REPO_KEY="$KEY" REPO_ORG_SLASH_NAME="$REPO_ORG_SLASH_NAME" \
    PR_REVIEWER_AGENT="${KEY}-pr-reviewer" MAX_FINDINGS="${PR_REVIEW_MAX_FINDINGS:-8}"

  docker cp "$RENDER_DIR/pr-watcher.sh" "$CONTAINER:/sandbox/pilot-state/${KEY}-pr-watcher.sh"
  docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/${KEY}-pr-watcher.sh"
  docker exec -u root "$CONTAINER" chmod 700 "/sandbox/pilot-state/${KEY}-pr-watcher.sh"
  echo "PR watcher re-rendered and redeployed for '$KEY' (commit rendered/$KEY/pr-watcher.sh yourself when ready)"
}

# ensure_pr_review_deployed <key> - idempotently bring up everything
# pr_review_enabled needs: the agent, its docs, the watcher script and its
# cron. Safe to call on a repo that already has all of it (that is the normal
# case on a resync), and called by both register-repo.sh and toggle-repo.sh
# so turning the flag on never depends on which script did it.
#
# Requires $SCRIPT_DIR, $REPO_ROOT, $REGISTRY_JSON, $SANDBOX, and
# gateway-config.sh already sourced (for PR_WATCHER_CRON_EVERY).
ensure_pr_review_deployed() {
  local KEY="$1"
  local CONTAINER PR_REVIEWER_AGENT MODEL
  CONTAINER=$(container_name)
  if [ -z "$CONTAINER" ]; then
    echo "warning: could not find a running $SANDBOX container - PR review for '$KEY' is recorded in" >&2
    echo "the registry but nothing was deployed. Re-run resync-repo.sh once the sandbox is up." >&2
    return 1
  fi

  PR_REVIEWER_AGENT="${KEY}-pr-reviewer"
  MODEL=$(jq -r --arg k "$KEY" '.[$k].model' "$REGISTRY_JSON")

  if nemoclaw "$SANDBOX" exec -- test -d "/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace" 2>/dev/null; then
    echo "$PR_REVIEWER_AGENT workspace already exists, skipping 'agents add'"
  else
    nemoclaw "$SANDBOX" exec -- openclaw agents add "$PR_REVIEWER_AGENT" \
      --workspace "/sandbox/.openclaw/agents/$PR_REVIEWER_AGENT/workspace" \
      --model "$MODEL" --non-interactive
  fi

  render_and_redeploy_pr_reviewer "$KEY" || true
  render_and_redeploy_pr_watcher "$KEY" || true

  if cron_job_exists "${KEY}-pr-watcher"; then
    echo "${KEY}-pr-watcher cron already present, skipping add"
  else
    # --no-deliver for the same reason the incident watchers use it: this
    # script posts its own output to GitHub, so cron's fallback delivery of
    # raw job output is redundant and fails outright on a sandbox with no
    # bound channel.
    nemoclaw "$SANDBOX" exec -- openclaw cron add --name "${KEY}-pr-watcher" \
      --every "${PR_WATCHER_CRON_EVERY:-5m}" \
      --command "bash /sandbox/pilot-state/${KEY}-pr-watcher.sh" --no-deliver
  fi

  echo "PR review is live for '${KEY}' - first cycle within ${PR_WATCHER_CRON_EVERY:-5m}."
}

# ensure_gh_issues_deployed <key> - idempotently create the gh-issues cron
# job for a repo. Added 2026-09-03, mirrors ensure_pr_review_deployed's
# shape (idempotent via cron_job_exists, safe to call on a repo that
# already has it), but is otherwise simpler: gh-issues is a bundled
# OpenClaw skill, not a per-repo rendered script, so there is no template
# to render/redeploy and no separate agent to create - it runs through the
# SAME <key>-escalation agent register-repo.sh already creates for every
# repo (needs its push/PR capability), not a new gh-issues-specific
# identity.
#
# Deliberately additive to, never a replacement for, ensure_pr_review_deployed
# - see GH_ISSUES_CRON_EVERY's own comment in gateway-config.sh for why the
# two aren't redundant. Call both when a repo wants full coverage.
#
# Requires $REGISTRY_JSON and $SANDBOX, and gateway-config.sh already
# sourced (for GH_ISSUES_CRON_EVERY).
ensure_gh_issues_deployed() {
  local KEY="$1"
  local REPO_SLASH_NAME ESCALATION_AGENT

  REPO_SLASH_NAME=$(jq -r --arg k "$KEY" ".[\$k].repo_org_slash_name" "$REGISTRY_JSON")
  ESCALATION_AGENT="${KEY}-escalation"

  if cron_job_exists "${KEY}-gh-issues"; then
    echo "${KEY}-gh-issues cron already present, skipping add"
    return 0
  fi

  # --no-deliver: same reasoning as every other watcher/cron in this repo -
  # this is a scheduled/unattended run with no bound chat channel, so
  # cron's own fallback delivery of raw job output would just fail.
  nemoclaw "$SANDBOX" exec -- openclaw cron add --name "${KEY}-gh-issues" \
    --agent "$ESCALATION_AGENT" \
    --message "Use the gh-issues skill. Target repo: ${REPO_SLASH_NAME}. Arguments: --limit 5 --cron. Follow the skill's phases exactly - this is a scheduled/unattended run, spawn workers for any genuinely eligible candidates found, or report cleanly if there are none." \
    --every "${GH_ISSUES_CRON_EVERY:-1h}" \
    --session isolated --no-deliver --timeout-seconds 600 \
    --description "gh-issues skill: issue-to-PR automation for ${KEY}, added alongside pr-watcher (which stays for general PR review)"

  echo "gh-issues automation is live for '${KEY}' - first cycle within ${GH_ISSUES_CRON_EVERY:-1h}."
}

# --- Runtime-dependent agent/reviewer template tokens (Phase 4, 2026-07-21) ---
#
# The eight functions below each compute ONE token's value for the
# agent-{readonly,writecapable}/reviewer-{readonly,writecapable} templates,
# dispatching on runtime type (docker|k8s). Split into small single-purpose
# functions rather than one giant one so each stays readable and so the
# *flavor* axis (readonly vs writecapable vs reviewer wording, which is
# unrelated to runtime type and predates this split) can be passed as its
# own small parameter instead of multiplying out every combination by hand.
#
# Calling convention: every function takes <runtime_type> first, then:
#   docker fields (2): <ssh_host> <container_dev>
#   k8s fields (5):    <cluster> <namespace> <workload_kind> <workload_name> <label_selector>
# - the same order the registry's runtime object and register-repo.sh's own
# --cluster/--namespace/--workload-kind/--workload-name/--label-selector
# flags use, so callers can pass their existing variables straight through
# without reshuffling.
#
# Used by both register-repo.sh (fresh registration) and
# render_and_redeploy_agent_docs above (re-render from an existing registry
# entry) - kept here specifically so this fairly large block of prose has
# exactly one copy, not two slowly-diverging ones.

target_desc() {
  local runtime_type="$1"; shift
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1" container_dev="$2"
    echo "\`${container_dev}\` on \`${ssh_host}\`"
  else
    local cluster="$1" namespace="$2" workload_kind="$3" workload_name="$4"
    echo "\`${workload_name}\` (${workload_kind}) in namespace \`${namespace}\` on cluster \`${cluster}\`"
  fi
}

# access_method_note <runtime_type> - no per-repo fields needed, the k8s
# path names are fixed sandbox conventions (kubeconfig path, tunnel port),
# not per-registration values.
access_method_note() {
  local runtime_type="$1"
  if [ "$runtime_type" = "docker" ]; then
    echo "Docker is NOT installed inside this sandbox — SSH to the relevant host first, then run \`docker\` commands *there*."
  else
    echo "kubectl IS available inside this sandbox at \`/sandbox/.local/bin/kubectl\` — **always use that full path, bare \`kubectl\` fails with \"not found\"** since that directory isn't on \`PATH\`. Pointed at a read-only kubeconfig (\`/sandbox/.kube/config\`) reached through an SSH tunnel \`tunnel-keeper.sh\` keeps alive — you do not SSH anywhere yourself, it talks to \`127.0.0.1:16443\` directly."
  fi
}

# access_target_line <runtime_type> <caveat_style: readonly|writecapable|none> <fields...>
access_target_line() {
  local runtime_type="$1" caveat_style="$2"; shift 2
  local fact
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1" container_dev="$2"
    fact="\`${ssh_host}\` — hosts **\`${container_dev}\`**"
    case "$caveat_style" in
      readonly) echo "${fact}. Other unrelated containers may run on the same box — leave those alone, you have no reason to touch them for this job." ;;
      writecapable) echo "${fact}. Other unrelated containers may run on the same box — leave those alone unless explicitly asked." ;;
      *) echo "${fact}." ;;
    esac
  else
    local cluster="$1" namespace="$2" workload_kind="$3" workload_name="$4" label_selector="$5"
    fact="namespace \`${namespace}\` on cluster \`${cluster}\` — label selector \`${label_selector}\` matches **\`${workload_name}\`**'s pod(s)"
    case "$caveat_style" in
      readonly) echo "${fact}. Other unrelated workloads may run in the same namespace — leave those alone, you have no reason to touch them for this job." ;;
      writecapable) echo "${fact}. Other unrelated workloads may run in the same namespace — leave those alone unless explicitly asked." ;;
      *) echo "${fact}." ;;
    esac
  fi
}

# access_boundary <runtime_type> <shape: paragraph|bullet> <fields...>
# The full "never route around your documented access boundary" rule -
# entirely different wording per runtime (SSH-alias boundary vs
# kubectl/RBAC boundary), so this composes the whole thing including its
# own bold lead-in, rather than trying to share a lead-in sentence that
# would have to name the mechanism anyway.
access_boundary() {
  local runtime_type="$1" shape="$2"; shift 2
  local lead body
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1"
    body="including a raw IP, \`root@...\`, other ports/credentials, or disabling host-key checking to work around a failed or blocked attempt. If your permitted access can't answer a question, say so plainly in your report rather than improvising a different target to try to find out anyway. A denial or SSH failure is the boundary working as intended, not an obstacle to route around."
    if [ "$shape" = "bullet" ]; then
      echo "- **Attempting SSH, HTTP, or any other access to a host/IP/user other than the documented \`ssh ${ssh_host}\` alias** — ${body}"
    else
      echo "**Also never attempt SSH, HTTP, or any other access to a host/IP/user other than the documented \`ssh ${ssh_host}\` alias** — ${body}"
    fi
  else
    body="including trying to reach the API server directly, a different context, or elevated credentials to work around a \`Forbidden\` response. If your permitted access can't answer a question, say so plainly in your report rather than improvising a different route to find out anyway. A \`Forbidden\` response or connection failure is the RBAC/tunnel boundary working as intended, not an obstacle to route around."
    if [ "$shape" = "bullet" ]; then
      echo "- **Attempting any \`kubectl\` write verb (create/delete/patch/apply/scale/rollout restart/etc.), \`exec\`, \`port-forward\`, a \`--kubeconfig\` override, or any other route to the cluster besides the provided read-only kubeconfig** — ${body}"
    else
      echo "**Also never attempt any \`kubectl\` write verb (create/delete/patch/apply/scale/rollout restart/etc.), \`exec\`, \`port-forward\`, a \`--kubeconfig\` override, or any other route to the cluster besides the provided read-only kubeconfig** — ${body}"
    fi
  fi
}

# deploy_observe_step <runtime_type> <fields...> - Stage 3's optional
# deploy-and-observe bullet genuinely changes MEANING for k8s, not just
# wording: the write-capable agent can trigger a real deploy on docker
# (SSH in, run this repo's own deploy tooling), but cannot on k8s at all -
# there's no agent-triggerable deploy path there, only a post-merge
# observe of whatever the existing pipeline already deployed.
deploy_observe_step() {
  local runtime_type="$1"; shift
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1" container_dev="$2"
    echo "- *Offer* (never auto-run) a live deploy-and-observe check if this repo has its own deploy mechanism: SSH to \`${ssh_host}\`, deploy the fix branch via whatever this repo's real deploy tooling is, then tail \`${container_dev}\`'s logs for a bit to see the fix behave for real. This touches the actual shared dev container, so only do it with explicit permission for that specific fix — never assume it's wanted."
  else
    local cluster="$1" namespace="$2" workload_kind="$3" workload_name="$4"
    echo "- You cannot deploy on k8s — there is no agent-triggerable deploy path here, on request or otherwise. *After* a human merges the PR and the existing pipeline deploys it, you may (on request) run \`/sandbox/.local/bin/kubectl rollout status ${workload_kind}/${workload_name} -n ${namespace}\` plus a fresh logs/events pull and report whether the fix landed cleanly. This is observation only, never a deploy trigger — cluster ${cluster}."
  fi
}

# self_access_verb_phrase <runtime_type> <fields...> - for the reviewer's
# "you may ___ to pull logs yourself" sentence.
self_access_verb_phrase() {
  local runtime_type="$1"; shift
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1"
    echo "SSH to \`${ssh_host}\`"
  else
    echo "query the cluster yourself via \`/sandbox/.local/bin/kubectl\` (read-only, RBAC-enforced — not on PATH, always use the full path)"
  fi
}

# log_pull_cmd <runtime_type> <tail_n> <fields...> - the one example
# command shown in each TOOLS.md file. A separate small function (not
# folded into access_target_line) because the desired --tail count is a
# second, independent axis of variation (100/20/200 across the three
# TOOLS.md files) that has nothing to do with runtime type.
log_pull_cmd() {
  local runtime_type="$1" tail_n="$2"; shift 2
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1" container_dev="$2"
    echo "ssh ${ssh_host} \"docker logs ${container_dev} --tail ${tail_n}\""
  else
    local cluster="$1" namespace="$2" workload_kind="$3" workload_name="$4" label_selector="$5"
    echo "/sandbox/.local/bin/kubectl -n ${namespace} logs -l '${label_selector}' --all-containers=true --tail=${tail_n}"
  fi
}

# watcher_failure_note <runtime_type> - for agent-writecapable/TOOLS.md's
# "watcher's own operational log" parenthetical, which names the kind of
# transport failure the watcher itself logs.
watcher_failure_note() {
  [ "$1" = "docker" ] && echo "SSH failures" || echo "kubectl/tunnel failures"
}

# workload_noun <runtime_type> - "container" vs "pod", for the couple of
# generic-noun spots that aren't worth a full sentence-level token.
workload_noun() {
  [ "$1" = "docker" ] && echo "container" || echo "pod"
}

# compute_agent_doc_tokens <out_array_name> <runtime_type> <flavor: readonly|writecapable> <fields...>
#
# Calls all ten functions above with the right per-file style parameter and
# appends every resulting KEY=value pair onto the caller's array (nameref,
# same convention as ssh_pull/kubectl_pull in watcher-common.sh) - one place
# both register-repo.sh (fresh registration) and render_and_redeploy_agent_docs
# (resync) call, so they can't compute these two different ways.
#
# Agent (readonly/writecapable) and reviewer (always read-only) need
# DIFFERENT ACCESS_TARGET_LINE caveat wording and DIFFERENT example --tail
# counts (100/20/200 across the three TOOLS.md files), but register-repo.sh
# renders agent-* and reviewer-* templates from the same shared RENDER_ARGS
# array in one call - so the reviewer's versions get their own token names
# (REVIEWER_TARGET_LINE, REVIEWER_EXAMPLE_LOG_CMD) rather than colliding
# with the agent's (ACCESS_TARGET_LINE, AGENT_EXAMPLE_LOG_CMD) under the
# same key. Every other token here is flavor-invariant (same value either
# way), so it's harmless that both flavors get all twelve keys computed
# unconditionally - render-template.py silently ignores whichever ones a
# given template doesn't actually reference.
compute_agent_doc_tokens() {
  local -n _agent_doc_tokens_out="$1"
  local runtime_type="$2" flavor="$3"
  shift 3
  local agent_tail=100
  [ "$flavor" = "writecapable" ] && agent_tail=20
  local boundary_shape="paragraph"
  [ "$flavor" = "writecapable" ] && boundary_shape="bullet"

  _agent_doc_tokens_out+=(
    "TARGET_DESC=$(target_desc "$runtime_type" "$@")"
    "ACCESS_METHOD_NOTE=$(access_method_note "$runtime_type")"
    "ACCESS_TARGET_LINE=$(access_target_line "$runtime_type" "$flavor" "$@")"
    "REVIEWER_TARGET_LINE=$(access_target_line "$runtime_type" none "$@")"
    "ACCESS_BOUNDARY=$(access_boundary "$runtime_type" "$boundary_shape" "$@")"
    "AGENT_EXAMPLE_LOG_CMD=$(log_pull_cmd "$runtime_type" "$agent_tail" "$@")"
    "REVIEWER_EXAMPLE_LOG_CMD=$(log_pull_cmd "$runtime_type" 200 "$@")"
    "DEPLOY_OBSERVE_STEP=$(deploy_observe_step "$runtime_type" "$@")"
    "SELF_ACCESS_VERB_PHRASE=$(self_access_verb_phrase "$runtime_type" "$@")"
    "WATCHER_FAILURE_NOTE=$(watcher_failure_note "$runtime_type")"
    "WORKLOAD_NOUN=$(workload_noun "$runtime_type")"
    "APP_LOGS_HOWTO=$(app_logs_howto "$runtime_type" "$@")"
    "CLUSTER_ACCESS_BOUNDARY=$(cluster_access_boundary "$runtime_type")"
    "DEPLOY_SPEC_INSPECT_CMD=$(deploy_spec_inspect_cmd "$runtime_type" "$@")"
  )
}

# deploy_spec_inspect_cmd <runtime_type> <fields...> - the one command that
# answers "where does this workload's config actually come from", using only
# resources the read-only RBAC actually grants (deployments are readable;
# configmaps are not - see cluster_access_boundary).
deploy_spec_inspect_cmd() {
  local runtime_type="$1"; shift
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1" container="$2"
    echo "ssh ${ssh_host} \"docker inspect ${container} --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{\\\"\\\\n\\\"}}{{end}}'\""
    return
  fi
  local cluster="$1" namespace="$2" kind="$3" name="$4"
  echo "/sandbox/.local/bin/kubectl -n ${namespace} get ${kind} ${name} -o json | jq '.spec.template.spec | {volumes, containers: [.containers[] | {image, volumeMounts, envFrom, env}]}'"
}

# cluster_access_boundary <runtime_type> - the "what can I actually see, and
# what do I do when the answer is no" section for an escalation agent's
# TOOLS.md.
#
# The readable list is PARSED OUT OF k8s/rbac-readonly.yaml rather than written
# here, so the docs can never promise access the cluster doesn't grant. That
# matters more than it sounds: on 2026-08-12 an agent ran `kubectl get
# configmap` (a read), got Forbidden, and its own fallback collapsed the result
# into "Not found in ConfigMap (or Forbidden)" - so it carried on as though the
# repo file were authoritative when in fact the running config came from a
# ConfigMap it is not allowed to read. The fix it then merged never reached the
# deployment.
cluster_access_boundary() {
  local runtime_type="$1"
  if [ "$runtime_type" = "docker" ]; then
    echo "You reach this workload over SSH with a forced-command wrapper. Anything the wrapper does not expose is unavailable to you - treat a refusal as \"I cannot determine this\", never as evidence about the workload."
    return
  fi
  local rbac="${REPO_ROOT:-.}/k8s/rbac-readonly.yaml" readable
  readable=$(grep -oE '^[[:space:]]*resources:[[:space:]]*\[[^]]*\]' "$rbac" 2>/dev/null \
    | sed -E 's/.*\[//; s/\]//; s/"//g' | tr ',' '\n' \
    | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort -u | paste -sd, - | sed 's/,/, /g')
  [ -n "$readable" ] || readable="(could not read k8s/rbac-readonly.yaml - assume less, not more)"
  echo "Your kubeconfig authenticates as a read-only ServiceAccount. You can \`get\`/\`list\`/\`watch\` exactly these: ${readable}. Every write, \`exec\` and \`port-forward\` verb is denied, and so are \`secrets\` and \`configmaps\` - the latter two deliberately, because they may hold credentials (see k8s/rbac-readonly.yaml's own comment). This is enforced by the cluster, not by this file, so no amount of retrying or rephrasing changes it."
}

# app_logs_howto <runtime_type> <fields...> - "how do I actually go check"
# imperative clause, for agent-writecapable/TOOLS.md's watcher-vs-app-logs
# distinction paragraph.
app_logs_howto() {
  local runtime_type="$1"; shift
  if [ "$runtime_type" = "docker" ]; then
    local ssh_host="$1"
    echo "SSH to \`${ssh_host}\` and run \`docker logs\` there"
  else
    echo "run \`kubectl logs\` against the workload (see the example above)"
  fi
}

# correlated_repos_note <comma-separated-repo-keys-or-empty> - added
# 2026-07-22 for cross-repo awareness (registry/schema.md's
# "Cross-repo awareness" section). Deliberately NOT runtime/flavor-
# dependent like the functions above - the wording is identical whether
# the repo is docker/k8s or readonly/writecapable, since what varies is the
# surrounding static protocol text in AGENTS.md, not this token's own
# content. Takes a comma-separated string (not a bash array) because
# that's the shape both --correlate-with on the CLI and RENDER_ARGS'
# plain-string values already use - render-template.py has no concept of
# array values.
correlated_repos_note() {
  local csv="$1"
  if [ -z "$csv" ]; then
    echo "No related repos are registered for this one yet."
    return
  fi
  local IFS=','
  local -a repos=($csv)
  local joined="" r
  for r in "${repos[@]}"; do
    if [ -z "$joined" ]; then
      joined="\`${r}\` (escalation agent: \`${r}-escalation\`)"
    else
      joined="${joined}, \`${r}\` (escalation agent: \`${r}-escalation\`)"
    fi
  done
  echo "This repo is related to: ${joined}."
}
