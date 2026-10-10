#!/usr/bin/env bash
# register-repo.sh - register a new repo into the monitoring/auto-fix system:
# creates a registry/repos.json entry, renders its watcher + pre-push-hook +
# agent/reviewer files from the shared templates, and deploys everything to
# the sandbox (registry copy, watcher cron, agent workspaces). Never touches
# real secrets - the actual authenticated `git clone` + pre-push-hook install
# are always printed as a manual next step for you to run yourself, same
# "you run it, not the agent" rule as bootstrap.sh's own clone step.
#
# Usage (k8s runtime - the default since Server 5's decommission, 2026-07-22):
#   register-repo.sh <key> --clone-url <url> \
#     --cluster server2 --namespace <ns> --workload-kind deployment \
#     --workload-name <name> --container <container-name-in-pod> \
#     [--label-selector 'app=<name>'] [--trunk-branch main] \
#     [--secondary-branch <branch>] [--correlate-with <repo1,repo2,...>] \
#     [--modifications on|off] [--monitoring on|off] [--pr-review on|off] \
#     [--cooldown 3600] [--error-pattern <regex>] \
#     [--domain-note <text>] [--model <model-ref>] [--dry-run]
#
# Usage (docker runtime - retired 2026-07-22 along with Server 5, the only
# host that ever used it; KNOWN_SSH_HOSTS below is deliberately empty, so
# --runtime docker will always refuse until a genuinely new Docker-hosted
# target is added there AND the forced-command wrapper machinery is revived
# from attic/ - see bootstrap.sh's own header comment):
#   register-repo.sh <key> --clone-url <url> --runtime docker --ssh-host <host> \
#     --container <container_dev> [<other shared options as above>]
#
#   Both runtimes get the full set: watcher + cron, escalation/reviewer agent
#   workspaces, and the pre-push-hook install step (Phase 4 of the k8s
#   migration plan - templates/agent-*/reviewer-* are runtime-aware via
#   sandbox-helpers.sh's compute_agent_doc_tokens, see registry/schema.md).
#
# --secondary-branch: for repos with a dev/main split (e.g. anything with its
# own .env.dev + pipeline.sh, deployed off a `dev` branch while `main` is the
# stable branch). When set, the write-capable agent checks trunk_branch vs.
# secondary_branch for divergence before preparing a fix, and stops to ask the
# human how to proceed if they've diverged (rather than silently fixing on top
# of a possibly-stale branch). Omit for repos with no such split. Applies
# equally to both runtime types - both get an escalation agent now.
#
# --correlate-with: comma-separated keys of OTHER registered repos this one
# is directly related to (e.g. a service it calls, or that calls it). Does
# NOT grant any write/push capability across repos - the escalation agent
# may only read a correlated repo's shared clone to check for a connection,
# and if it finds one, notifies that repo's own escalation agent directly
# rather than acting on it. See registry/schema.md's "Cross-repo awareness"
# section for the full design and why it's scoped this way. Populate
# symmetrically where a real relationship exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX="ops-nemoclaw"
REGISTRY_JSON="$REPO_ROOT/registry/repos.json"
# Empty since Server 5's decommission (2026-07-22) - no Docker-hosted
# target exists to register against today. See this file's header comment.
KNOWN_SSH_HOSTS=()
KNOWN_K8S_CLUSTERS=(server2)

# shellcheck source=lib/sandbox-helpers.sh
source "$SCRIPT_DIR/lib/sandbox-helpers.sh"
# shellcheck source=lib/gateway-config.sh
source "$SCRIPT_DIR/lib/gateway-config.sh"

if [ $# -lt 1 ]; then
  echo "Usage: register-repo.sh <key> --clone-url <url> [--runtime docker|k8s] [...]" >&2
  echo "  k8s (default):    --cluster <name> --namespace <ns> --workload-kind deployment|statefulset \\" >&2
  echo "                    --workload-name <name> --container <container-name-in-pod> [--label-selector <sel>]" >&2
  echo "  docker (retired): --ssh-host <host> --container <container_dev>" >&2
  exit 1
fi
KEY="$1"; shift

CLONE_URL=""
RUNTIME_TYPE="k8s"
SSH_HOST=""
CONTAINER_DEV=""
K8S_CLUSTER="server2"
K8S_NAMESPACE=""
K8S_WORKLOAD_KIND="deployment"
K8S_WORKLOAD_NAME=""
K8S_CONTAINER=""
K8S_LABEL_SELECTOR=""
TRUNK_BRANCH="main"
SECONDARY_BRANCH=""
CORRELATE_WITH=""
MODIFICATIONS="off"
MONITORING="on"
# Off by default for the same reason modifications is: a newly registered repo
# should not start talking to GitHub (even read-only-plus-a-comment) until
# someone has looked at it. Turn on with --pr-review on, or later via
# toggle-repo.sh --pr-review on.
PR_REVIEW="off"
# Same off-by-default reasoning as PR_REVIEW. Additive, not a
# replacement: gh-issues only reviews PRs it created itself from an
# issue, so pr-review still covers general review on any other PR -
# see GH_ISSUES_CRON_EVERY's own comment in gateway-config.sh.
GH_ISSUES="off"
COOLDOWN_SECONDS=3600
ERROR_PATTERN='ERROR|CRITICAL|Traceback|Exception'
DOMAIN_NOTE=""
MODEL="inference/nvidia/Qwen3.6-35B-A3B-NVFP4"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --clone-url) CLONE_URL="$2"; shift 2 ;;
    --runtime) RUNTIME_TYPE="$2"; shift 2 ;;
    --ssh-host) SSH_HOST="$2"; shift 2 ;;
    # Shared across both runtimes - docker's "container_dev" and k8s's
    # "container name within the pod" are the same concept in different
    # clothes, and the two runtimes are mutually exclusive per registration.
    --container) CONTAINER_DEV="$2"; K8S_CONTAINER="$2"; shift 2 ;;
    --cluster) K8S_CLUSTER="$2"; shift 2 ;;
    --namespace) K8S_NAMESPACE="$2"; shift 2 ;;
    --workload-kind) K8S_WORKLOAD_KIND="$2"; shift 2 ;;
    --workload-name) K8S_WORKLOAD_NAME="$2"; shift 2 ;;
    --label-selector) K8S_LABEL_SELECTOR="$2"; shift 2 ;;
    --trunk-branch) TRUNK_BRANCH="$2"; shift 2 ;;
    --secondary-branch) SECONDARY_BRANCH="$2"; shift 2 ;;
    --correlate-with) CORRELATE_WITH="$2"; shift 2 ;;
    --modifications) MODIFICATIONS="$2"; shift 2 ;;
    --monitoring) MONITORING="$2"; shift 2 ;;
    --pr-review) PR_REVIEW="$2"; shift 2 ;;
    --gh-issues) GH_ISSUES="$2"; shift 2 ;;
    --cooldown) COOLDOWN_SECONDS="$2"; shift 2 ;;
    --error-pattern) ERROR_PATTERN="$2"; shift 2 ;;
    --domain-note) DOMAIN_NOTE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$RUNTIME_TYPE" != "docker" ] && [ "$RUNTIME_TYPE" != "k8s" ]; then
  echo "error: --runtime must be 'docker' or 'k8s' (got '${RUNTIME_TYPE}')" >&2
  exit 1
fi

if [ -z "$CLONE_URL" ]; then
  echo "Missing required: --clone-url" >&2
  exit 1
fi

if [ "$RUNTIME_TYPE" = "docker" ]; then
  if [ -z "$SSH_HOST" ] || [ -z "$CONTAINER_DEV" ]; then
    echo "Missing required for --runtime docker: --ssh-host, --container" >&2
    exit 1
  fi
  KNOWN=0
  # ${arr[@]} on a truly empty array is "unbound variable" under `set -u` on
  # older bash (fixed in 4.4+, but this repo shouldn't assume a bash
  # version) - check emptiness first instead of looping straight over it.
  if [ "${#KNOWN_SSH_HOSTS[@]}" -gt 0 ]; then
    for h in "${KNOWN_SSH_HOSTS[@]}"; do
      [ "$h" = "$SSH_HOST" ] && KNOWN=1
    done
  fi
  if [ "$KNOWN" -ne 1 ]; then
    if [ "${#KNOWN_SSH_HOSTS[@]}" -eq 0 ]; then
      echo "error: --runtime docker has no known configured SSH hosts - Server 5 was the only one" >&2
      echo "and it was decommissioned 2026-07-22 (Phase 7 of docs/k8s-migration-architecture.md)." >&2
      echo "Did you mean --runtime k8s (the default now)? If a genuinely new Docker-hosted target" >&2
      echo "is needed, see attic/generate-server5-wrapper.sh + attic/server5-readonly-wrapper.sh.tmpl" >&2
      echo "for the forced-command wrapper machinery this path needs revived first." >&2
    else
      echo "error: --ssh-host '${SSH_HOST}' is not one of the known configured aliases (${KNOWN_SSH_HOSTS[*]})." >&2
      echo "Registering a genuinely new SSH host is out of scope for this tool - it needs a new" >&2
      echo "ssh/config entry, a bootstrap.sh SSH-section rerun, and a new/extended network policy" >&2
      echo "YAML, none of which should happen unattended. Do those manually first, then re-run." >&2
    fi
    exit 1
  fi
else
  if [ -z "$K8S_NAMESPACE" ] || [ -z "$K8S_WORKLOAD_NAME" ] || [ -z "$K8S_CONTAINER" ]; then
    echo "Missing required for --runtime k8s: --namespace, --workload-name, --container" >&2
    exit 1
  fi
  if [ "$K8S_WORKLOAD_KIND" != "deployment" ] && [ "$K8S_WORKLOAD_KIND" != "statefulset" ]; then
    echo "error: --workload-kind must be 'deployment' or 'statefulset' (got '${K8S_WORKLOAD_KIND}')" >&2
    exit 1
  fi
  KNOWN=0
  for c in "${KNOWN_K8S_CLUSTERS[@]}"; do
    [ "$c" = "$K8S_CLUSTER" ] && KNOWN=1
  done
  if [ "$KNOWN" -ne 1 ]; then
    echo "error: --cluster '${K8S_CLUSTER}' is not one of the known configured clusters (${KNOWN_K8S_CLUSTERS[*]})." >&2
    echo "Registering a genuinely new cluster is out of scope for this tool - see" >&2
    echo "docs/k8s-migration-architecture.md for what a new cluster needs (kubeconfig," >&2
    echo "tunnel-keeper.sh entry, RBAC, network policy). Do that manually first, then re-run." >&2
    exit 1
  fi
  if [ -z "$K8S_LABEL_SELECTOR" ]; then
    K8S_LABEL_SELECTOR="app=${K8S_WORKLOAD_NAME}"
    echo "note: --label-selector not given, defaulting to '${K8S_LABEL_SELECTOR}' - this is an" >&2
    echo "UNVERIFIED convention (see registry/schema.md's 'Known gaps'). Confirm it matches the" >&2
    echo "real workload's spec.selector.matchLabels before trusting this registration in" >&2
    echo "production, or pass --label-selector explicitly." >&2
  fi
fi

if jq -e --arg k "$KEY" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
  echo "error: '${KEY}' is already registered. Use toggle-repo.sh to change its settings, or" >&2
  echo "deregister-repo.sh first if you want to fully re-register it." >&2
  exit 1
fi

# Soft validation only, not a hard error - a repo can legitimately be
# registered with --correlate-with pointing at a sibling that's about to be
# registered next (order doesn't strictly matter), so this warns rather
# than blocks. The escalation agent's own cross-repo notify would just fail
# at runtime until the referenced key actually exists.
if [ -n "$CORRELATE_WITH" ]; then
  IFS=',' read -ra CORRELATE_WITH_KEYS <<< "$CORRELATE_WITH"
  for ck in "${CORRELATE_WITH_KEYS[@]}"; do
    if ! jq -e --arg k "$ck" 'has($k)' "$REGISTRY_JSON" >/dev/null 2>&1; then
      echo "warning: --correlate-with references '${ck}', which isn't registered yet - fine if" >&2
      echo "you're about to register it too, but cross-repo notification would fail until it exists." >&2
    fi
  done
fi

REPO_NAME=$(basename "$CLONE_URL" .git)
REPO_ORG_SLASH_NAME=$(echo "$CLONE_URL" | sed -E 's#^https://[^/]+/##; s#\.git$##')
ESCALATION_AGENT="${KEY}-escalation"
REVIEWER_AGENT="${KEY}-reviewer"
PR_REVIEWER_AGENT="${KEY}-pr-reviewer"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -z "$DOMAIN_NOTE" ]; then
  DOMAIN_NOTE="(No domain-specific risk note was given at registration time.)"
fi

echo "=== Plan for '${KEY}' ==="
echo "  clone_url:            $CLONE_URL"
echo "  repo_name:            $REPO_NAME"
echo "  repo_org_slash_name:  $REPO_ORG_SLASH_NAME"
echo "  runtime_type:         $RUNTIME_TYPE"
if [ "$RUNTIME_TYPE" = "docker" ]; then
  echo "  ssh_host:             $SSH_HOST"
  echo "  container_dev:        $CONTAINER_DEV"
else
  echo "  cluster:              $K8S_CLUSTER"
  echo "  namespace:            $K8S_NAMESPACE"
  echo "  workload_kind:        $K8S_WORKLOAD_KIND"
  echo "  workload_name:        $K8S_WORKLOAD_NAME"
  echo "  container:            $K8S_CONTAINER"
  echo "  label_selector:       $K8S_LABEL_SELECTOR"
fi
echo "  trunk_branch:         $TRUNK_BRANCH"
echo "  secondary_branch:     ${SECONDARY_BRANCH:-(none)}"
echo "  correlate_with:       ${CORRELATE_WITH:-(none)}"
echo "  monitoring_enabled:   $([ "$MONITORING" = "on" ] && echo true || echo false)"
echo "  modifications_enabled: $([ "$MODIFICATIONS" = "on" ] && echo true || echo false)"
echo "  pr_review_enabled:    $([ "$PR_REVIEW" = "on" ] && echo true || echo false)"
echo "  gh_issues_enabled:    $([ "$GH_ISSUES" = "on" ] && echo true || echo false)"
echo "  escalation_agent:     $ESCALATION_AGENT"
echo "  reviewer_agent:       $REVIEWER_AGENT"
[ "$PR_REVIEW" = "on" ] && echo "  pr_reviewer_agent:    $PR_REVIEWER_AGENT"
echo "  cooldown_seconds:     $COOLDOWN_SECONDS"
echo "  error_pattern:        $ERROR_PATTERN"
echo "  model:                $MODEL"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: would render templates into rendered/${KEY}/, write a registry/repos.json"
  echo "entry, deploy the registry + watcher script + cron job + agent workspaces to the"
  echo "sandbox, and print manual clone/hook-install instructions. Nothing was touched."
  exit 0
fi

MONITORING_BOOL=$([ "$MONITORING" = "on" ] && echo true || echo false)
MODIFICATIONS_BOOL=$([ "$MODIFICATIONS" = "on" ] && echo true || echo false)
PR_REVIEW_BOOL=$([ "$PR_REVIEW" = "on" ] && echo true || echo false)
GH_ISSUES_BOOL=$([ "$GH_ISSUES" = "on" ] && echo true || echo false)
# Template placeholders can't be left unfilled (render-template.py errors
# loudly on that), so use the literal string "none" as the sentinel the
# agent-writecapable template checks for - distinct from the actual JSON
# null stored in the registry for "no secondary branch configured".
SECONDARY_BRANCH_FOR_TEMPLATE="${SECONDARY_BRANCH:-none}"

if [ "$RUNTIME_TYPE" = "docker" ]; then
  RUNTIME_JSON=$(jq -n --arg ssh_host "$SSH_HOST" --arg container "$CONTAINER_DEV" \
    '{type:"docker", ssh_host:$ssh_host, container_dev:$container}')
else
  RUNTIME_JSON=$(jq -n --arg cluster "$K8S_CLUSTER" --arg namespace "$K8S_NAMESPACE" \
    --arg kind "$K8S_WORKLOAD_KIND" --arg name "$K8S_WORKLOAD_NAME" \
    --arg container "$K8S_CONTAINER" --arg selector "$K8S_LABEL_SELECTOR" \
    '{type:"k8s", cluster:$cluster, namespace:$namespace, workload_kind:$kind,
      workload_name:$name, container:$container, label_selector:$selector}')
fi

# JSON array of repo keys, or null if none given - matches
# registry/schema.md's widened correlate_with shape.
CORRELATE_WITH_JSON=$(jq -n --arg csv "$CORRELATE_WITH" \
  '(if $csv == "" then null else ($csv | split(",")) end)')

echo "=== 1. Registry entry ==="
jq --arg k "$KEY" \
   --arg clone_url "$CLONE_URL" \
   --arg repo_org "$REPO_ORG_SLASH_NAME" \
   --argjson runtime "$RUNTIME_JSON" \
   --arg trunk "$TRUNK_BRANCH" \
   --arg secondary "$SECONDARY_BRANCH" \
   --argjson correlate_with "$CORRELATE_WITH_JSON" \
   --arg cooldown "$COOLDOWN_SECONDS" \
   --arg error_pattern "$ERROR_PATTERN" \
   --arg model "$MODEL" \
   --arg now "$NOW_ISO" \
   --argjson monitoring "$MONITORING_BOOL" \
   --argjson modifications "$MODIFICATIONS_BOOL" \
   --argjson pr_review "$PR_REVIEW_BOOL" \
   --argjson gh_issues "$GH_ISSUES_BOOL" \
   '.[$k] = {
      clone_url: $clone_url, repo_org_slash_name: $repo_org, runtime: $runtime,
      trunk_branch: $trunk,
      secondary_branch: (if $secondary == "" then null else $secondary end),
      cooldown_seconds: ($cooldown | tonumber), error_pattern: $error_pattern,
      suppress_regex: null,
      monitoring_enabled: $monitoring, modifications_enabled: $modifications,
      model: $model, correlate_with: $correlate_with,
      pr_review_enabled: $pr_review, gh_issues_enabled: $gh_issues,
      created_at: $now, updated_at: $now
    }' "$REGISTRY_JSON" > "${REGISTRY_JSON}.tmp" && mv "${REGISTRY_JSON}.tmp" "$REGISTRY_JSON"
echo "registry/repos.json updated (commit this yourself when ready)"

if [ "$RUNTIME_TYPE" = "k8s" ]; then
  echo ""
  echo "note: no server-side change is needed for '${KEY}' - namespace"
  echo "'${K8S_NAMESPACE}' is already covered by the existing cluster-scoped"
  echo "read-only ClusterRole (k8s/rbac-readonly.yaml's ops-nemoclaw-readonly),"
  echo "which applies to every namespace on the cluster, not just the ones"
  echo "registered today. If the org later narrows this to per-namespace"
  echo "Roles/RoleBindings instead of a cluster-wide ClusterRole, this script"
  echo "will need to print (and a human will need to apply) a new RoleBinding"
  echo "for '${K8S_NAMESPACE}' at that point - not needed today."
fi

echo "=== 2. Render templates ==="
RENDER_DIR="$REPO_ROOT/rendered/$KEY"
mkdir -p "$RENDER_DIR"

AGENT_TMPL_DIR="agent-readonly"; REVIEWER_TMPL_DIR="reviewer-readonly"; FLAVOR="readonly"
if [ "$MODIFICATIONS" = "on" ]; then
  AGENT_TMPL_DIR="agent-writecapable"; REVIEWER_TMPL_DIR="reviewer-writecapable"; FLAVOR="writecapable"
fi

if [ "$RUNTIME_TYPE" = "docker" ]; then
  RUNTIME_FIELDS=("$SSH_HOST" "$CONTAINER_DEV")
else
  RUNTIME_FIELDS=("$K8S_CLUSTER" "$K8S_NAMESPACE" "$K8S_WORKLOAD_KIND" "$K8S_WORKLOAD_NAME" "$K8S_LABEL_SELECTOR")
fi
AGENT_DOC_TOKENS=()
compute_agent_doc_tokens AGENT_DOC_TOKENS "$RUNTIME_TYPE" "$FLAVOR" "${RUNTIME_FIELDS[@]}"

RENDER_ARGS=(
  ESCALATION_AGENT="$ESCALATION_AGENT" REVIEWER_AGENT="$REVIEWER_AGENT"
  REPO_KEY="$KEY" REPO_NAME="$REPO_NAME" REPO_ORG_SLASH_NAME="$REPO_ORG_SLASH_NAME"
  TRUNK_BRANCH="$TRUNK_BRANCH" SECONDARY_BRANCH="$SECONDARY_BRANCH_FOR_TEMPLATE"
  DOMAIN_NOTE="$DOMAIN_NOTE" COOLDOWN_SECONDS="$COOLDOWN_SECONDS" ERROR_PATTERN="$ERROR_PATTERN"
  CORRELATED_REPOS="$(correlated_repos_note "$CORRELATE_WITH")"
  "${AGENT_DOC_TOKENS[@]}"
)
if [ "$RUNTIME_TYPE" = "docker" ]; then
  RENDER_ARGS+=(SSH_HOST="$SSH_HOST" CONTAINER_DEV="$CONTAINER_DEV")
else
  RENDER_ARGS+=(
    K8S_CLUSTER="$K8S_CLUSTER" K8S_NAMESPACE="$K8S_NAMESPACE"
    K8S_WORKLOAD_KIND="$K8S_WORKLOAD_KIND" K8S_WORKLOAD_NAME="$K8S_WORKLOAD_NAME"
    K8S_LABEL_SELECTOR="$K8S_LABEL_SELECTOR"
  )
fi

python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$AGENT_TMPL_DIR/AGENTS.md.tmpl" "$RENDER_DIR/escalation-AGENTS.md" "${RENDER_ARGS[@]}"
python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$AGENT_TMPL_DIR/TOOLS.md.tmpl" "$RENDER_DIR/escalation-TOOLS.md" "${RENDER_ARGS[@]}"
python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$REVIEWER_TMPL_DIR/AGENTS.md.tmpl" "$RENDER_DIR/reviewer-AGENTS.md" "${RENDER_ARGS[@]}"
python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/$REVIEWER_TMPL_DIR/TOOLS.md.tmpl" "$RENDER_DIR/reviewer-TOOLS.md" "${RENDER_ARGS[@]}"
if [ "$RUNTIME_TYPE" = "docker" ]; then
  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/watcher-docker.sh.tmpl" "$RENDER_DIR/watcher.sh" "${RENDER_ARGS[@]}"
else
  python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/watcher-k8s.sh.tmpl" "$RENDER_DIR/watcher.sh" "${RENDER_ARGS[@]}"
fi
python3 "$SCRIPT_DIR/render-template.py" "$REPO_ROOT/templates/pre-push-hook.sh.tmpl" "$RENDER_DIR/pre-push-hook.sh" "${RENDER_ARGS[@]}"
echo "rendered into $RENDER_DIR/ (commit these yourself when ready, they're git-tracked output)"

echo "=== 3. Deploy to sandbox ==="
CONTAINER=$(container_name)
if [ -z "$CONTAINER" ]; then
  echo "warning: could not find a running $SANDBOX container - registry entry and rendered" >&2
  echo "files are ready, but nothing was deployed. Re-run once the sandbox is up, or deploy" >&2
  echo "manually: docker cp registry/repos.json + rendered/$KEY/* into place." >&2
  exit 0
fi

# Must exist (owned by the sandbox user) before any docker cp into it - if
# this is the first repo ever registered against this sandbox,
# /sandbox/pilot-state won't exist yet, and a docker cp into a missing path
# auto-creates it owned by root, which then breaks the next docker exec (as
# the unprivileged sandbox user) with a confusing permission error.
nemoclaw "$SANDBOX" exec -- mkdir -p /sandbox/pilot-state
docker cp "$REGISTRY_JSON" "$CONTAINER:/sandbox/pilot-state/registry.json"
deploy_shared_libs "$CONTAINER"
docker cp "$RENDER_DIR/watcher.sh" "$CONTAINER:/sandbox/pilot-state/${KEY}-watcher.sh"
docker exec -u root "$CONTAINER" chown sandbox:sandbox "/sandbox/pilot-state/${KEY}-watcher.sh"
docker exec -u root "$CONTAINER" chmod 700 "/sandbox/pilot-state/${KEY}-watcher.sh"

if cron_job_exists "${KEY}-watcher"; then
  echo "${KEY}-watcher cron already present, skipping add"
else
  # --no-deliver: the watcher script does its own escalation (calling the
  # escalation agent directly) - cron's own fallback-delivery of the job's
  # raw output is redundant and, on a sandbox with no prior conversation,
  # fails outright ("last" channel has nothing to resolve to).
  nemoclaw "$SANDBOX" exec -- openclaw cron add --name "${KEY}-watcher" --every "$WATCHER_CRON_EVERY" \
    --command "bash /sandbox/pilot-state/${KEY}-watcher.sh" --no-deliver
fi

for agent in "$ESCALATION_AGENT" "$REVIEWER_AGENT"; do
  if nemoclaw "$SANDBOX" exec -- test -d "/sandbox/.openclaw/agents/$agent/workspace" 2>/dev/null; then
    echo "$agent workspace already exists, skipping 'agents add'"
  else
    nemoclaw "$SANDBOX" exec -- openclaw agents add "$agent" \
      --workspace "/sandbox/.openclaw/agents/$agent/workspace" \
      --model "$MODEL" --non-interactive
  fi
done

# Re-emit the agent-to-agent allow list so this newly registered pair can
# actually use sessions_send (the cross-repo heads-up in its TOOLS.md needs
# it). Same jq derivation as bootstrap.sh section 8 - see the long comment
# there for why the list must never be left empty, and why this needs a
# gateway restart to take effect rather than hot-reloading.
A2A_ALLOW=$(derive_a2a_allow "$REGISTRY_JSON")
nemoclaw "$SANDBOX" exec -- openclaw config set tools.agentToAgent.allow "$A2A_ALLOW" --strict-json

# The PR reviewer is deliberately NOT in that allow list: it is a one-way
# GitHub -> agent -> GitHub loop and has no reason to message any other agent.
# See registry/schema.md's "PR review" section for why sharing no state with
# the escalation side is the point, not an oversight.
if [ "$PR_REVIEW" = "on" ]; then
  echo ""
  echo "=== 4. PR review ==="
  ensure_pr_review_deployed "$KEY" || true
fi

if [ "$GH_ISSUES" = "on" ]; then
  echo ""
  echo "=== 5. gh-issues (issue-to-PR automation) ==="
  ensure_gh_issues_deployed "$KEY" || true
fi

CONTAINER=$(container_name)
docker cp "$RENDER_DIR/escalation-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace/AGENTS.md"
docker cp "$RENDER_DIR/escalation-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace/TOOLS.md"
docker cp "$RENDER_DIR/reviewer-AGENTS.md" "$CONTAINER:/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace/AGENTS.md"
docker cp "$RENDER_DIR/reviewer-TOOLS.md" "$CONTAINER:/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace/TOOLS.md"
docker exec -u root "$CONTAINER" chown -R sandbox:sandbox "/sandbox/.openclaw/agents/$ESCALATION_AGENT/workspace" "/sandbox/.openclaw/agents/$REVIEWER_AGENT/workspace"

echo ""
echo "=== Registered '${KEY}' ==="
echo ""
echo "The agent-to-agent allow list was widened to include ${ESCALATION_AGENT}/${REVIEWER_AGENT},"
echo "but tools.agentToAgent does NOT hot-reload - until the gateway is restarted, this pair's"
echo "cross-repo heads-up (sessions_send) will return 'forbidden'. Everything else about the"
echo "registration works without it, so this is a should-do, not a must-do-now:"
echo "  nemoclaw $SANDBOX gateway restart"
echo ""
echo "One manual step left (needs real GitHub credentials, not scriptable here -"
echo "same rule as bootstrap.sh's own clone step: run this yourself, not via an AI agent):"
CLONE_URL_NO_SCHEME="${CLONE_URL#https://}"
if nemoclaw "$SANDBOX" exec -- test -d "/sandbox/repos/${REPO_NAME}" 2>/dev/null; then
  echo "  (repo clone already exists at /sandbox/repos/${REPO_NAME}, skipping clone instructions)"
else
  echo "  export GITHUB_USERNAME='...' GITHUB_PAT='...'   # or source your .env"
  echo "  nemoclaw $SANDBOX exec -- bash -c \"cd /sandbox/repos && git clone https://\${GITHUB_USERNAME}:\${GITHUB_PAT}@${CLONE_URL_NO_SCHEME}\""
fi
echo "Then install the pre-push hook (only possible once the clone exists):"
echo "  docker cp \"$RENDER_DIR/pre-push-hook.sh\" \$(docker ps --filter name=openshell-.*$SANDBOX- --format '{{.Names}}' | head -1):/sandbox/repos/${REPO_NAME}/.git/hooks/pre-push"
echo "  docker exec \$(docker ps --filter name=openshell-.*$SANDBOX- --format '{{.Names}}' | head -1) chmod +x /sandbox/repos/${REPO_NAME}/.git/hooks/pre-push"
