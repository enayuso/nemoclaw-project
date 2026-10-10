#!/usr/bin/env bash
# gateway-config.sh - the single source of truth for every `openclaw config
# set` this project applies to the sandbox gateway.
#
# This file is SOURCED, never run directly. Two callers use it, and the whole
# point is that they see byte-identical intent:
#
#   bootstrap.sh              - defines set_config to APPLY each setting
#   scripts/check-config-drift.sh - defines set_config to COMPARE each setting
#                               against the live gateway and report differences
#
# Why a sourced bash function instead of a JSON/YAML manifest: several values
# are derived at runtime (the agent-to-agent allow list is computed from
# registry/repos.json, the bootstrap caps are read out of
# registry/bootstrap-limits.json). Letting bash resolve those the same way for
# both callers means the drift checker can never disagree with the applier
# about what the intended value actually is - which is the exact failure this
# whole mechanism exists to catch. A manifest would have to re-implement the
# derivations, i.e. reintroduce the drift one level up.
#
# The caller MUST define these two functions before calling
# gateway_config_settings, and MUST set SANDBOX:
#
#   note <words...>                      - narration; apply-mode prints,
#                                          check-mode swallows
#   set_config <path> <value> [--strict-json]
#                                        - apply or compare one setting
#
# Everything below this line is the intent itself. When adding a setting,
# add it HERE - a raw `openclaw config set` written anywhere else is invisible
# to drift detection, which is how the sessions_send config went missing for
# a week (see the a2a block's own comment).

# Paths are resolved relative to THIS file, never to the caller's $SCRIPT_DIR -
# that variable means the repo root in bootstrap.sh but the scripts/ directory
# in scripts/*.sh, and quietly resolving to a non-existent registry path is
# precisely the kind of silent difference this library exists to eliminate.
GATEWAY_CONFIG_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATEWAY_CONFIG_REGISTRY_JSON="$GATEWAY_CONFIG_REPO_ROOT/registry/repos.json"
GATEWAY_CONFIG_LIMITS_JSON="$GATEWAY_CONFIG_REPO_ROOT/registry/bootstrap-limits.json"

# Cadence every watcher cron is registered at. Shared by bootstrap.sh section 7,
# register-repo.sh and check-config-drift.sh so "what the scripts say" and "what
# the checker expects" cannot disagree - previously the literal was written into
# two scripts and compared against nothing.
#
# Beware `openclaw cron list`'s TABLE output when eyeballing this: it renders
# 90s as "every 2m", which reads like drift and is not. Trust
# `cron list --json`'s everyMs (90000), which is what the checker compares.
WATCHER_CRON_EVERY="90s"

# Cadence for the PR-review watchers (2026-08-12). Deliberately far slower
# than the incident watchers: a PR is a durable object that sits for hours or
# days, so latency costs nothing, while each cycle that finds work spends
# minutes of GPU on a shared inference host. The script takes a non-blocking
# lock, so a review running longer than this interval simply causes the next
# cycle to exit immediately rather than stacking up.
PR_WATCHER_CRON_EVERY="5m"

# Cadence for the gh-issues skill cron (2026-09-03). Runs through each
# repo's own <repo>-escalation agent (the write-capable one, since this
# spawns workers that create branches/push/open PRs), NOT a wrapper script
# like watcher/pr-watcher use - gh-issues is an OpenClaw skill, meant to be
# followed by the agent's own tool calls, not pre-fetched by bash. Starts
# conservative on purpose (issues arrive far less often than incidents or
# pushes) and is meant to be tightened once real cadence is observed, not
# copied from PR_WATCHER_CRON_EVERY - the two aren't doing comparable
# amounts of work per cycle. Additive alongside pr_review_enabled, not a
# replacement: gh-issues only ever reviews PRs it created itself from an
# issue (see its own skill's "Only process fix/issue-* PRs" line), so
# general review coverage on ANY open PR still needs pr-watcher regardless
# of whether gh-issues is also enabled for a repo.
GH_ISSUES_CRON_EVERY="1h"

# Cap on findings per posted review. Bounds the output tokens of a single
# model call, which is what the 600s provider timeout actually limits (a
# review measured ~10k output tokens at ~25 tok/s). The reviewer is told to
# report the excess count rather than silently drop it.
PR_REVIEW_MAX_FINDINGS=8

# Converts an openclaw cadence string (`90s`, `2m`, `10m`, `1h`) to the
# milliseconds the gateway reports back in `cron list --json`.
cadence_to_ms() {
  local v="$1" n="${1%[smh]}" unit="${1: -1}"
  case "$unit" in
    s) echo $((n * 1000)) ;;
    m) echo $((n * 60000)) ;;
    h) echo $((n * 3600000)) ;;
    *) echo "cadence_to_ms: unrecognised cadence '$v'" >&2; return 1 ;;
  esac
}

# Prints the tools.agentToAgent.allow value for a given registry file.
#
# Shared by gateway_config_settings below, register-repo.sh and
# deregister-repo.sh - all three must produce the identical list or a
# registration/deregistration would quietly disagree with what the next
# bootstrap re-applies, and the drift checker would flag a difference that is
# really just three copies of the same jq expression falling out of sync.
#
# The empty case is the dangerous one: an empty registry yields [], and in
# OpenClaw [] means ALLOW EVERY AGENT rather than deny-all
# (`if (allowPatterns.length === 0) return true`). Doing nothing here would be
# wide open, so substitute a sentinel that matches no real agent id.
derive_a2a_allow() {
  local registry_json="$1" allow
  allow=$(jq -c '[keys[] | ("\(.)-escalation", "\(.)-reviewer")]' "$registry_json")
  [ "$allow" = "[]" ] && allow='["__no-registered-pairs__"]'
  printf '%s' "$allow"
}

gateway_config_settings() {
  # All config-touching. Deliberately does NOT include plugins.allow - see
  # README's "Known gotchas" for why this isn't a "run it later" deferral,
  # it's a standing accepted limitation: /tmp/gateway.log confirms
  # plugins.allow cannot hot-reload ("config reload requires gateway
  # restart; hot mode ignoring (plugins.allow)"), and that restart has
  # killed the gateway on every single attempt tried (2026-07-21), including
  # after waiting several real minutes with the sandbox idle and stable -
  # time was not the variable, this specific config change reliably kills
  # this gateway version's restart path. Do not attempt it against an
  # already-running gateway. The settings below are all confirmed safe to
  # hot-write (no crash, gateway stays healthy) - most log an explicit
  # "config hot reload applied" line, thinkingDefault doesn't but still
  # hot-writes fine (see its own comment below). Safe to WRITE is not the
  # same as TAKES EFFECT immediately: the tools.sessions/tools.agentToAgent
  # pair at the end of this section writes safely but genuinely does not
  # apply until a gateway restart (confirmed live 2026-08-07, see its own
  # comment) - unlike plugins.allow, that restart is ordinary and safe.
  note "--- LLM timeout (implicit ~120s default is too short for this model under contention) ---"
  set_config models.providers.inference.timeoutSeconds 600 --strict-json

  note "--- maxTokens (default 4096 is far too small vs this model's 524288 context - causes silent" \
       "mid-turn cutoffs on any request needing multiple tool calls or large output) ---"
  set_config models.providers.inference.models.0.maxTokens 32000 --strict-json

  note "--- Deny web/browser tools for the small (<=300B param) default model (openclaw security audit CRITICAL finding)." \
       "Keyed by the model's .name field (provider/id), NOT its bare .id - confirmed the hard way 2026-07-27:" \
       "changing .id without ALSO updating .name (see the models.0.name set below) left THIS deny rule silently" \
       "orphaned/non-matching, and 'openclaw security audit' still reported the CRITICAL finding as unaddressed" \
       "even though a deny rule existed, just keyed to the stale pre-rename name. Not in active use today -" \
       "revisit and adjust if a web-research feature is ever built on this instance. ---"
  set_config 'tools.byProvider["inference/nvidia/Qwen3.6-35B-A3B-NVFP4"].deny' '["group:web","browser"]' --strict-json

  note "--- Agent reasoning (turned on 2026-07-24 - escalation/reviewer agents were running with reasoning" \
       "disabled, and the dashboard's thinking panel had nothing to render). Confirmed live: reasoning +" \
       "compat.thinkingFormat hot-reload cleanly (gateway log: 'config hot reload applied'). thinkingDefault" \
       "hot-writes too (value persists, gateway stays healthy) but doesn't log an explicit 'applied' line the" \
       "way the model-config keys do - actual effect is confirmed via a real run showing .thinking content, not" \
       "the log alone. 'low' chosen over high/max for the cost/latency tradeoff; easy to bump later. ---"
  set_config models.providers.inference.models.0.reasoning true --strict-json

  note "--- Usage accounting. Without this, EVERY agent run records input/output/totalTokens as 0 and there is" \
       "no way to see token volume at all. Root cause proven live 2026-08-12 against this vLLM endpoint: a" \
       "non-streaming request returns usage normally, a STREAMED one omits it entirely unless the client asks" \
       "via stream_options.include_usage - and OpenClaw streams every agent run. This compat flag is what makes" \
       "it ask. Verified the fix on a real turn: usage went from all-zeros to input=16491 output=28." \
       "That 16491 for a one-word reply is the bootstrap docs (AGENTS.md + TOOLS.md) being re-sent on every" \
       "single invocation - worth remembering before growing them further. Trimming those docs the same day" \
       "took the identical probe to input=14223, so ~2.3k tokens of that floor was removable prose; see" \
       "scripts/check-agent-doc-rules.py for the measurement method and for what must NOT be trimmed away." \
       "This flag is also what makes that measurable at all - without it a probe reports null, not a number," \
       "so re-check it before concluding a doc change had no effect. NOTE it reports 'applies without" \
       "restarting the gateway', unlike most keys here. ---"
  set_config models.providers.inference.models.0.compat.supportsUsageInStreaming true --strict-json
  set_config models.providers.inference.models.0.compat.thinkingFormat qwen
  set_config agents.defaults.thinkingDefault low

  note "--- Agent-to-agent messaging (sessions_send) for the escalation/reviewer pairs. Piloted and proven" \
       "live 2026-07-31, then SILENTLY LOST - the pilot applied it by hand with 'openclaw config patch' and" \
       "never encoded it anywhere, so it vanished (confirmed gone from openclaw.json AND from every .bak" \
       "file) somewhere around the 2026-08-05/06 nemoclaw v0.0.81 -> v0.0.90 upgrade, which rebuilds the" \
       "sandbox config from host-side settings. That is exactly why it lives in this script now: any" \
       "sandbox-side config that isn't in here is a config that does not survive the next rebuild." \
       "IMPORTANT #1: all three keys are required together, and they do NOT hot-reload - 'config set' prints" \
       "'Restart the gateway to apply' and means it (confirmed live 2026-08-07: a real cross-agent send still" \
       "returned 'forbidden' with the config already written, and succeeded immediately after" \
       "'nemoclaw $SANDBOX gateway restart'). That restart is the ordinary safe one, NOT the plugins.allow" \
       "restart this section's header warns about." \
       "IMPORTANT #2: tools.sessions.visibility is a GLOBAL switch with no per-agent override, and 'all' is" \
       "the only value that permits cross-agent sends (valid values are self|tree|agent|all, default tree)." \
       "Setting it also drops the same-agent 'tree' restriction for EVERY agent, so each agent can reach its" \
       "own other sessions too - a real, accepted widening, not just a flag for the pair below." \
       "IMPORTANT #3: the 'allow' list is the ONLY real scoping lever, and an EMPTY OR ABSENT list means" \
       "ALLOW EVERY AGENT, not deny-all (confirmed in OpenClaw's own session-visibility source:" \
       "'if (allowPatterns.length === 0) return true'). Entries are exact agent-id matches or '*' wildcards," \
       "and BOTH the requester's and the target's agent id must independently match some entry. Never" \
       "'clean up' this list to [] thinking it's a no-op - that opens every pair in the sandbox." \
       "IMPORTANT #4: 'openclaw config set' is BLOCKED by nemoclaw's own shell-function wrapper when it runs" \
       "inside a login shell (it prints 'cannot modify config inside the sandbox' and points at" \
       "'nemoclaw onboard --resume'). The 'nemoclaw exec -- openclaw ...' form used throughout this script" \
       "does not go through that wrapper and works fine - so if you are debugging these by hand, do NOT" \
       "wrap them in 'sh -lc' or you will get a confusing refusal from a guard that this script never hits. ---"
  # Derived from the registry rather than hardcoded, for the same reason
  # section 7 is: a repo registered later must not silently end up outside
  # the allow list (which, per IMPORTANT #3 above, fails OPEN for the list
  # as a whole but would fail CLOSED for that one repo's pair - its agents
  # would just get 'forbidden' with nothing explaining why). register-repo.sh
  # re-emits this too, so a mid-life registration doesn't have to wait for
  # the next full bootstrap.
  A2A_ALLOW=$(derive_a2a_allow "$GATEWAY_CONFIG_REGISTRY_JSON")
  set_config tools.sessions.visibility all
  set_config tools.agentToAgent.enabled true --strict-json
  set_config tools.agentToAgent.allow "$A2A_ALLOW" --strict-json

  note "--- Ping-pong turn limit for the above. NOTE the key lives under 'session.' (singular), NOT under" \
       "'tools.agentToAgent' where you'd expect it - that's OpenClaw's own layout" \
       "(cfg?.session?.agentToAgent?.maxPingPongTurns), and it is the ONLY agent-to-agent knob that exists" \
       "besides enabled/allow (verified by enumerating the key reads in openclaw's dist). Default is 5 and" \
       "that default is actively wrong for our only use of sessions_send, the one-way cross-repo heads-up:" \
       "measured live 2026-08-07, a single heads-up under the default cost the RECEIVING agent 5 separate" \
       "model runs (it replies, we reply, it replies...) for a message that explicitly wants no reply." \
       "Setting 0 brings that to 2 and delivery still works (verified: real runId, target session created," \
       "message present in its transcript - 0 does NOT mean 'do not deliver')." \
       "Why 2 and not 1: the trailing 'announce step' turn is unconditional and not separately" \
       "configurable - after the message lands, the target gets one more turn deciding whether to post" \
       "something back to the requester's channel. With a cron/CLI-invoked requester there is no bound" \
       "channel and nothing is posted (confirmed: zero slack lines in the gateway log across every test)," \
       "but an escalation agent driven from a Slack conversation DOES have one, so that reply could reach" \
       "Slack. That's the behaviour to re-check first if cross-repo notifications ever start showing up" \
       "somewhere unexpected." \
       "If the second-opinion review is ever migrated off the CLI form onto sessions_send, re-test this" \
       "value first - every measurement above used timeoutSeconds:0 (fire-and-forget), and 0 ping-pong" \
       "turns has NOT been tested against a call that actually waits for a reply. ---"
  set_config session.agentToAgent.maxPingPongTurns 0 --strict-json

  note "--- Workspace bootstrap file size caps. OpenClaw silently truncates any AGENTS.md/TOOLS.md over its" \
       "per-file cap (default 20000) and the truncation is FAR more destructive than its one-line log warning" \
       "suggests. Measured against the real rendered docs 2026-08-07, before this was raised: every one of the" \
       "7 escalation agents was over (22084-22378 chars), and OpenClaw's trimAgentsBootstrapContent keeps only" \
       "the first 45% and last 15% verbatim, replacing the middle 45% (~10000 chars - essentially the whole" \
       "body of the staged protocol) with a 'policy digest'. That digest is NOT a summary: it is a flat list" \
       "of individual lines that match a heading/bullet/keyword test, each capped at 240 chars and stripped of" \
       "structure. 80% of the non-empty lines in that middle region (114 of 143) were dropped outright, and" \
       "because it selects line-by-line it keeps the FIRST line of a wrapped paragraph and drops its" \
       "continuations - so rules arrived as severed sentence fragments rather than as missing sections, which" \
       "is worse. Both numbers come from registry/bootstrap-limits.json so this and" \
       "scripts/render-template.py's pre-render guard can never disagree; see that file for the sizing" \
       "arithmetic and why the total had to move too." \
       "NOTE this is NOT a nemoclaw concern - checked, nemoclaw has no bootstrap/prompt-injection handling at" \
       "all (it only seeds default workspace files and secret-scans them), so there is no build-time knob on" \
       "that side. It is purely OpenClaw config, and like the a2a keys above it needs a gateway restart." \
       "The warning itself is on by default (agents.defaults.bootstrapPromptTruncationWarning='always') but" \
       "only ever reaches /tmp/gateway.log, which is why this ran unnoticed - the render-time guard is the" \
       "part that actually makes a regression impossible to miss. ---"
  set_config agents.defaults.bootstrapMaxChars \
    "$(jq -r '.bootstrapMaxChars' "$GATEWAY_CONFIG_LIMITS_JSON")" --strict-json
  set_config agents.defaults.bootstrapTotalMaxChars \
    "$(jq -r '.bootstrapTotalMaxChars' "$GATEWAY_CONFIG_LIMITS_JSON")" --strict-json

  note "--- Inference endpoint (this instance's original standalone backend was taken down 2026-07-27;" \
       "reassigned to the trading project's shared vLLM container - see" \
       "policies/trading-vllm-shared-inference.yaml for the full rationale/caveats, including the" \
       "deliberate exception to that project's standalone-from-the-services mandate). The vLLM container (and" \
       "svc-investment-dev) migrated off Server 6 onto Server 4 on 2026-08-04, then onto" \
       "Server 5 on 2026-09-01 (port changed 11510 -> 11511 the same day) - ops-nemoclaw itself stays" \
       "on Server 6, so baseUrl has moved 192.168.0.31:11510 -> 192.168.0.5:11510 -> today's" \
       "192.168.0.30:11511 (Server 5's LAN address, confirmed live 2026-09-04)." \
       "NOTE the deliberate two-address split, which is NOT drift: this baseUrl and" \
       "policies/trading-vllm-shared-inference.yaml use the LAN address, keeping inference off the shared" \
       "NAT that Servers 2/4/6 stall behind, while NemoClaw's OWN recorded provider endpoint has to be the" \
       "PUBLIC 203.0.113.10:11511 because onboarding refuses a private address ('endpoint-url is not" \
       "allowed: URL points to private/internal address'). Same machine, both live. That recorded endpoint" \
       "is not cosmetic bookkeeping: 'rebuild' smoke-checks inference.local through it, and on 2026-09-04 it" \
       "still read port 11510, so every rebuild failed at step 7 AFTER destroying the sandbox. See" \
       "docs/recovery.md for the one-line 'openshell provider update' that fixes it without re-onboarding." \
       "This drifted out of sync for a full day after the 2026-08-04 migration (the policy AND this" \
       "baseUrl both still pointed at the dead old address, silently failing every agent run with a proxy" \
       "connection-refused/timeout) before being caught and fixed - if vLLM ever moves hosts again, update" \
       "ALL THREE together, not just one: this baseUrl, the network policy's endpoint, and NemoClaw's own" \
       "recorded provider endpoint ('openshell provider get compatible-endpoint' -> OPENAI_BASE_URL). The" \
       "third was missed on the 2026-09-01 move and stayed wrong until 2026-09-04. Only the model actually" \
       "loaded behind that endpoint has changed over time before this move (confirmed each time live" \
       "against the server's own /v1/models before touching" \
       "config, not assumed): 'Qwen/Qwen3.6-35B-A3B' as of 2026-07-27, then 'nvidia/Qwen3.6-35B-A3B-NVFP4'" \
       "(an NVIDIA NVFP4-quantized build of the same model family) as of this same day's second change." \
       "IMPORTANT: 'nemoclaw <name> inference set' (even called WITHOUT --endpoint-url, just to change" \
       "the model) silently reverts baseUrl back to the onboard-recorded 'https://inference.local/v1'" \
       "endpoint (which is the OLD dead backend, not this one) and wipes compat.thinkingFormat - confirmed" \
       "the hard way 2026-07-27. Never run 'nemoclaw inference set' against this sandbox again without" \
       "immediately re-running this baseUrl/thinkingFormat pair afterward. (As of 0.0.119 'inference set'" \
       "also refuses --endpoint-url outright for a private address, and refuses to change the endpoint at" \
       "all on an already-configured sandbox - use 'openshell provider update' for that, see below.)" \
       "CORRECTED 2026-09-04 - this block used to claim doctor's 'Inference route (gateway)' check will" \
       "ALWAYS show [fail] against 'inference.local' and can be ignored as dead bookkeeping. That was" \
       "true only while the recorded provider endpoint was stale, and it cost us a sandbox: a real 503" \
       "here was waved away as the known-cosmetic failure, then 'rebuild' - which smoke-checks this exact" \
       "URL at step 7, after it has already destroyed the old sandbox - failed three times. When the" \
       "recorded endpoint is right, 'inference.local' returns 200 and status reads 'Inference: healthy'." \
       "Treat a 503 as a REAL fault: fix it with 'openshell provider update compatible-endpoint --config" \
       "OPENAI_BASE_URL=http://203.0.113.10:11511/v1 --gateway nemoclaw-8180' BEFORE any rebuild. A live" \
       "agent run is still the best end-to-end check, but doctor's inference line is no longer noise." \
       "IMPORTANT #2: models.0.id is NOT the only place the model is referenced - models.0.name" \
       "('provider/id', matched by the tools.byProvider deny key above), agents.defaults.model.primary, AND" \
       "each individually-registered agent's OWN agents.list.N.model (set at registration time by" \
       "register-repo.sh's 'openclaw agents add --model', NOT inherited from agents.defaults) all store the" \
       "model reference as their own separate copy of the string. Confirmed the hard way 2026-07-27: changing" \
       "only models.0.id left .name/agents.defaults.model.primary/every agents.list entry stale, silently" \
       "un-mitigating the security-audit CRITICAL finding and (per audit's own report) leaving every escalation/" \
       "reviewer agent still configured against the OLD model name. Changing the model again means updating" \
       "ALL of these together, not just this one line - see registry/repos.json's own per-repo 'model' field" \
       "and scripts/register-repo.sh's MODEL default too, for the same reason." \
       "IMPORTANT #3: none of the 4 'config set' lines just below take --strict-json - confirmed live" \
       "2026-07-27 that this CLI version rejects a bare (non-JSON) string with --strict-json attached" \
       "('Could not parse ... as JSON ... For plain strings, omit --strict-json') - the ORIGINAL versions of" \
       "the baseUrl/models.0.id lines below had --strict-json on them anyway (inconsistent with the" \
       "compat.thinkingFormat line just above, which never had it) and would have failed the exact same way" \
       "had they ever actually been re-run from this script rather than pasted/run manually - fixed here too" \
       "while touching this block. ---"
  set_config models.providers.inference.baseUrl "http://192.168.0.30:11511/v1"
  set_config models.providers.inference.models.0.id 'nvidia/Qwen3.6-35B-A3B-NVFP4'
  set_config models.providers.inference.models.0.name 'inference/nvidia/Qwen3.6-35B-A3B-NVFP4'
  set_config agents.defaults.model.primary 'inference/nvidia/Qwen3.6-35B-A3B-NVFP4'

  note "--- Keys whose intended state is ABSENCE (unset_config, not set_config). Onboarding writes" \
       "plugins.entries.tavily as a disabled default, but the tavily plugin is not installed, so OpenClaw" \
       "printed 'plugins.entries.tavily: plugin not installed' on EVERY invocation - to STDOUT, ahead of" \
       "any --json payload. That broke 'cron list --json' parsing in check-config-drift.sh, which skipped" \
       "all seven cron checks and reported it as a single drift (38 checks instead of 52) on 2026-09-04." \
       "The checker now strips non-JSON preambles so the warning can no longer blind it, and the entry" \
       "itself is removed here so it does not come back on the next onboard. This repo has NEVER" \
       "configured tavily; nothing uses it." \
       "SAFE, unlike plugins.allow: removing a plugins.ENTRIES key and restarting the gateway was" \
       "confirmed clean live on 2026-09-04 (v0.0.119 / OpenClaw 2026.7.1) - 'Gateway restarted; health" \
       "passed', dashboard reconnected and re-authenticated, watchers uninterrupted, drift still clean." \
       "That is NOT a licence to touch plugins.allow, whose restart still kills this gateway - see" \
       "bootstrap.sh's closing note. Different key, different outcome. ---"
  unset_config plugins.entries.tavily

}
