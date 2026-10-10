#!/usr/bin/env python3
"""check-agent-doc-rules.py - assert the agent bootstrap docs still contain
every behavioural rule they are supposed to.

WHY THIS EXISTS. The templates in templates/agent-*/ and templates/reviewer-*/
are re-sent to the model in full on EVERY agent invocation, so their size is a
per-turn token tax and there is standing pressure to shorten them. Measured
2026-08-12: the escalation pair was ~44k chars (~11k tokens) against a
16,491-token floor for a one-word reply - about 67% of every run's baseline.

The trim that followed took the pair to ~34.5k chars, and the saving was then
confirmed end-to-end rather than inferred from character counts. Same agent
(api-rag-escalation), same one-word-reply probe, real inputTokens off the
model rather than the client-side estimate: 16,491 -> 14,223, i.e. 2,268
tokens off every invocation (-13.8%). The char-count prediction had been
2,398, so estimating a trim's value by chars/4 runs ~5% optimistic - close
enough to plan with, not close enough to report as measured.

Two traps in reproducing that number, both of which produce a wrong answer
that looks plausible:
  - contextBudgetStatus.estimatedPromptTokens is a CLIENT-SIDE estimate and
    runs ~1.5k high (18,617 vs 16,491 on the same turn). Use inputTokens.
  - the floor is per-agent, because each repo renders its own docs. Compare a
    repo against itself. (In practice they land within ~10 tokens of each
    other - svc-core measured 14,213 against api-rag's 14,223 - but that
    is an observation, not something to rely on.)
Real inputTokens only exist at all because compat.supportsUsageInStreaming is
set; before it was enabled every agent turn recorded usage as 0. If a probe
comes back with inputTokens null, check that flag before trusting anything.

That pressure is fine. The danger is that a trim quietly removes a rule that
was put there because something actually went wrong once. Prose has no
compiler, so a deleted permission bar or a dropped "this is a blocking
failure" reads as a smaller diff, not as a regression - and the failure only
shows up later as an agent doing something it was told not to do.

So: each entry below pins one BEHAVIOURAL rule to a regex anchored on the
content rather than the wording, and the docs must keep matching. Rewording is
free; removing a rule is not.

Matching is done against the raw text AND a whitespace-collapsed copy, because
prose wraps at arbitrary points and a rule phrased across a line break is still
present. (Two rules were falsely reported missing before that was added.)

Usage:  python3 scripts/check-agent-doc-rules.py       # exit 0 = all present
Run it from the repo root, after any edit to those templates.

If you deliberately retire a rule, delete its entry here in the same commit and
say why in the commit message - that is the audit trail.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(rel):
    return (ROOT / rel).read_text()


A = read("templates/agent-writecapable/AGENTS.md.tmpl")
T = read("templates/agent-writecapable/TOOLS.md.tmpl")
RO = read("templates/agent-readonly/TOOLS.md.tmpl")
BOTH = A + "\n" + T

# PR reviewer (2026-08-12). Same pressure applies - these docs are re-sent on
# every PR review - and the no-tools rule in particular is load-bearing in a
# way that reads like mere style advice: a tool-calling review measured 900s
# and produced NOTHING, against 99s for the pre-fetched single-turn version.
# Anyone trimming "don't use tools" as redundant prose would silently turn
# every review back into a timeout.
PR_A = read("templates/pr-reviewer/AGENTS.md.tmpl")
PR_T = read("templates/pr-reviewer/TOOLS.md.tmpl")
PR_BOTH = PR_A + "\n" + PR_T

# Pre-push reviewer (2026-08-13). These were unpinned until a diff-only review
# failed in both directions on one fix: it labelled a present import
# CONFIRMED-missing, and in the same reply cleared a kwarg the framework does
# not accept. Both rules below are the fix, and both read like ordinary review
# advice - exactly the shape of thing a trim deletes without noticing.
RV_A = read("templates/reviewer-writecapable/AGENTS.md.tmpl")
RV_T = read("templates/reviewer-writecapable/TOOLS.md.tmpl")
RV_BOTH = RV_A + "\n" + RV_T

# Each rule: (label, corpus, regex that must match). Anchors are chosen to be
# the *behavioural* content, not the prose that happened to carry it.
RULES = [
 ("never merge a PR",              BOTH, r"[Nn]ever merge (a |any )?PR|Merging any PR.*never|- Merging any PR"),
 ("no direct commit/force to trunk", A,   r"Committing directly to `\{\{TRUNK_BRANCH\}\}`, or force-pushing"),
 ("only this repo; correlated read-only", A, r"only \*read\* those|You may only \*read\*"),
 ("never skip reviewer",           A,    r"Skipping the `\{\{REVIEWER_AGENT\}\}` second opinion"),
 ("no edit/remove suppression unasked", BOTH, r"[Nn]ever edit or remove existing|Removing or editing an existing suppression"),
 ("no --no-verify",                BOTH, r"--no-verify"),
 ("modifications_enabled gate",    BOTH, r"modifications_enabled"),
 ("push needs permission",         A,    r"`git push` of a fix branch"),
 ("gh pr create needs permission", A,    r"`gh pr create`"),
 ("divergence merge needs permission", A, r"Merging `\{\{TRUNK_BRANCH\}\}`/`\{\{SECONDARY_BRANCH\}\}` together"),
 ("deploy-observe needs permission", A,  r"live deploy-and-observe"),
 ("suppression add needs permission", A, r"Adding a new pattern to the watcher's suppression"),
 # Loosened 2026-09-04 to allow the retry wrapper between the fetch and the
 # checkout - the rule is "Stage 0 still fetches, checks out trunk, and pulls",
 # not "those three commands are literally adjacent lines".
 ("stage 0 refresh cmds",          A,    r"git fetch origin.*\n(.*\n)?git checkout \{\{TRUNK_BRANCH\}\}\ngit pull origin"),
 ("stage1 no tracker entry",       A,    r"Do not write a tracker entry at this stage"),
 ("stage1 remove stranded entry",  A,    r"remove it before you stop"),
 ("don't ask to remove tracker entry", A, r"[Dd]o not ask (the human )?(for )?permission to remove your own tracker"),
 ("stranded-below-4 rationale",    A,    r"stages 4 and 5"),
 ("cross-repo notify not fix",     A,    r"notify that repo's own escalation agent"),
 ("cross-repo lead not directive", A,    r"a lead, not a directive"),
 ("suppression narrowest regex",   A,    r"narrowest regex"),
 ("divergence: 3 options + stop",  A,    r"STOP, report, wait for a\nreply|Proceed targeting"),
 ("worktree add cmd",              A,    r"git worktree add /sandbox/repos/\{\{REPO_NAME\}\}-worktrees"),
 ("worktree list collision check", A,    r"git\nworktree list|git worktree list"),
 ("record tracker at stage 2",     A,    r"record it in the tracker"),
 ("stage3 syntax check",           A,    r"py_compile|tsc --noEmit"),
 ("hook python-only caveat",       BOTH, r"no-op if this repo\s*\n?isn't Python|only mechanically\n?  re-checks Python"),
 ("no assumed test suite",         BOTH, r"assume a local test suite exists"),
 ("reviewer session reuse",        BOTH, r"[Rr]euse the SAME session key|reusing this incident's existing review session|reusing this incident"),
 ("reviewer failure blocking",     A,    r"blocking failure, not a skippable step"),
 ("reviewer failure: tracker stays 2", A, r"[Ll]eave the tracker at stage 2"),
 ("stage4 stop and ask",           A,    r"ask permission to\npush the branch|Explicitly ask permission"),
 ("denial is final",               A,    r"denial is final"),
 ("denied: branch -D",             A,    r"git branch -D fix/<slug>"),
 ("denied: no push --delete",      A,    r"not\* run\n`git push origin --delete`|Do \*\*not\*\* run"),
 ("denied-patches saved",          A,    r"denied-patches"),
 ("no re-propose rejected unchanged", A, r"not to re-propose the rejected change unchanged"),
 ("stage5 push+pr cmds",           A,    r"git push -u origin fix/<slug>\ngh pr create --base"),
 ("pre-push failure handling",     A,    r"starting `pre-push:`"),
 ("stage6 cleanup incl remote del", A,   r"git push origin --delete fix/<slug>"),
 ("stage6 propagation is normal",  A,    r"NORMAL, EXPECTED step"),
 ("propagation 3 cases",           A,    r"Already contains the fix.*\n.*\n?.*Behind by exactly the merge|Genuinely diverged"),
 ("propagation needs permission",  A,    r"ASK whether\nto propagate|wait for a clear yes"),
 ("redeploy still needed",         BOTH, r"redeployed through the normal pipeline"),
 ("stage7 conflict stop",          A,    r"merge conflicts"),
 ("freshness: trunk moved check",  A,    r"has it moved since"),
 ("freshness: already fixed -> STOP", A, r"already\n   resolved upstream|If so: STOP"),
 ("freshness: rebase before 3/4/5", A,   r"git rebase \{\{TRUNK_BRANCH\}\}"),
 # --- TOOLS.md
 ("watcher log != app log",        T,    r"watcher's own\noperational log"),
 ("refusal is not a finding",      T,    r"A refusal is not a finding"),
 ("deploy spec: configMap/mountPath/image", T, r"volumes\[\]\.configMap.*\n?.*envFrom|volumeMounts\[\]\.mountPath"),
 ("ConfigMap may be CI-generated", T,    r"does NOT mean the fix is impossible"),
 ("which branch CI builds from",   T,    r"which branch it builds\nfrom|which branch CI builds"),
 ("fix can't reach deploy -> report", T, r"cannot reach the deployment"),
 ("suppression append cmd",        T,    r"watcher-suppressions.txt"),
 ("tracker file init",             T,    r"\|\| echo '\{\}' >"),
 ("tracker create jq",             T,    r"\.\[\$b\] = \{incident: \$incident, stage: 2"),
 ("tracker update jq",             T,    r"\.\[\$b\]\.stage = \$stage"),
 ("tracker del jq",                T,    r"del\(\.\[\$b\]\)"),
 ("session_key verbatim",          T,    r"verbatim from the message"),
 ("incident_signature purpose",    T,    r"incident_signature"),
 ("omit absent arg not guess",     T,    r"omit that `--arg`"),
 ("pre-push 4 checks",             T,    r"secret patterns.*\n?.*AWS keys|GitHub tokens"),
 ("env -u required",               T,    r"`env -u \.\.\.` prefix is required"),
 ("GatewayExplicitAuthRequiredError", T, r"GatewayExplicitAuthRequiredError"),
 ("sessions_send sessionKey fmt",  T,    r"agent:<other-repo>-escalation:xref-"),
 ("timeoutSeconds 0 rationale",    T,    r"timeoutSeconds: 0"),
 ("forbidden = policy gate",       T,    r'"status": "forbidden"'),
 ("freshness cheat-sheet",         T,    r"git log origin/\{\{TRUNK_BRANCH\}\} --oneline -20"),
 ("divergence cheat-sheet",        T,    r'git log --oneline "origin/\{\{TRUNK_BRANCH\}\}\.\.origin/\{\{SECONDARY_BRANCH\}\}"'),
 ("propagation branch --contains", T,    r"git branch -r --contains"),
 ("ff push cmd",                   T,    r"git push origin origin/\{\{TRUNK_BRANCH\}\}:\{\{SECONDARY_BRANCH\}\}"),
 ("gh auth status",                T,    r"gh auth status"),
 # --- readonly TOOLS.md
 ("RO refusal not a finding",      RO,   r"A refusal is not a finding"),
 ("RO env -u required",            RO,   r"env -u"),
 ("RO slug stable, self-derived",  RO,   r"stable label YOU derive"),
 ("RO report failed review call",  RO,   r"say so explicitly in your report"),
 ("RO configmap CI-generated",     RO,   r"does NOT mean the fix is impossible"),
 ("RO deploy spec inspect",        RO,   r"DEPLOY_SPEC_INSPECT_CMD"),
 ("RO benign noise flagging",      RO,   r"Known benign noise"),
 # --- PR reviewer (2026-08-12)
 ("PR no tools, single turn",      PR_A, r"[Dd]o not read files, run commands, fetch URLs, or call any tool"),
 ("PR no-tools is measured, not style", PR_A, r"measured constraint, not a style preference"),
 ("PR never posts to GitHub itself", PR_BOTH, r"never post, comment, push, merge, approve|never post to GitHub yourself"),
 ("PR never messages another agent", PR_A, r"never message another agent"),
 ("PR correctness only",           PR_A, r"\*\*Correctness only\.\*\*"),
 ("PR three-pass propose/verify/report", PR_A, r"Pass 1 - propose.*\n?[\s\S]*Pass 2 - verify[\s\S]*Pass 3 - report"),
 ("PR CONFIRMED/PLAUSIBLE labels", PR_A, r"\*\*CONFIRMED\*\*[\s\S]*\*\*PLAUSIBLE\*\*"),
 ("PR don't downgrade PLAUSIBLE",  PR_A, r"don't downgrade it to\n\"not real\"|don't downgrade"),
 ("PR empty report is good",       PR_A, r"empty report is a common and GOOD outcome"),
 ("PR output posted verbatim",     PR_A, r"posted verbatim|entire reply becomes the body"),
 ("PR failure-scenario required",  PR_A, r"Every\nfinding needs the `\*\*Failure scenario:\*\*` line|finding needs the"),
 ("PR no-findings exact line",     PR_A, r"No correctness findings\."),
 ("PR findings cap",               PR_A, r"capped at \{\{MAX_FINDINGS\}\}"),
 ("PR unchanged code out of scope", PR_A, r"neither introduces nor touches is out of scope"),
 ("PR degraded tier must be stated", PR_A, r"degraded tier|reviewed without full file context"),
 ("PR fresh session per head SHA", PR_BOTH, r"fresh session"),
 ("PR is not the pre-push reviewer", PR_A, r"You are NOT `\{\{REVIEWER_AGENT\}\}`"),
 ("PR stdout is the product",      PR_T, r"stdout is the product"),
 # --- Stage 3 depth + reviewer full-file context (2026-08-13)
 ("stage3 syntax check is not verification", A, r"syntax check is not verification"),
 ("stage3 execute unowned calls once", A, r"execute that line at\s*\n?\s*least once|see it not raise"),
 ("stage3 missing dep is not an exemption", A, r"not an exemption"),
 ("stage3 throwaway venv recipe",    A,    r"python3 -m venv /tmp/verify"),
 ("stage3 report UNVERIFIED not reasoning", A, r"UNVERIFIED"),
 ("review-msg.sh builds the message", T, r"review-msg\.sh"),
 ("reviewer gets full file contents", T, r"full contents of every changed\s*\n?file"),
 ("degraded tier must be reported",  T, r"tier=full"),
 ("RV reviewer is given full files", RV_BOTH, r"full contents of every changed file|full contents of every\s*\n?changed file"),
 ("RV no absence claim without looking", RV_A, r"[Nn]ever report anything as missing without looking"),
 ("RV check real signature of calls", RV_A, r"real signature of anything the change calls"),
 ("RV degraded tier: no absence claims", RV_A, r"no absence claims at all"),
 ("RV pre-fetch beats tool-calling",  RV_T, r"900s and\s*\n?returned nothing|pre-fetch is deliberate"),
 # --- Stage 4 asking is a tool call, not prose (2026-08-13). Every rule here
 # exists because a fix with a clean APPROVED review asked "Can I push?" in
 # plain text, left its tracker at stage 2, and became unanswerable. The
 # turn-ending framing is the load-bearing part: "prefer the script" would
 # leave plain text available as a fallback, which is the failure itself.
 ("stage4 asks via ask-decision.sh", BOTH, r"ask-decision\.sh"),
 ("stage4 turn must end with the call", A, r"turn must end with that call"),
 ("stage4 plain-text question reaches nobody", A, r"asked into an empty room|not received by anyone"),
 ("stage4 don't paste the diff",     BOTH, r"[Dd]o not paste the diff"),
 ("ask-decision refuses without a tracker entry", T, r"exit 66"),
 ("stage2 dead end: only re-check or close out", A, r"Re-check\*\* \(which asks you to try again\)|only two things a human can do"),
 ("watcher keeps checking while delivery is held", T, r"keeps checking every cycle even while it is holding delivery"),
 ("delayed reports may be stale",     T, r"still live before treating it as\s*\n?current|Check whether the symptom is still live"),
 # --- git fetch retry (2026-09-04). OpenShell's CONNECT proxy sometimes fails
 # to identify the calling process and denies the request; there is no fix in
 # any version (the three upstream PRs proposing a /proc fallback were closed
 # unmerged), so retrying IS the mitigation. Both halves are load-bearing: the
 # loop itself, and the two conclusions an agent must NOT draw - that one
 # failure diagnoses something, or that three failures can be worked around
 # with gh api. The last one matters most: gh api reads the remote tip but
 # fetches no objects, so "verified with gh api" would silently mean the whole
 # protocol ran against a stale clone.
 ("stage0 fetch is retried",         A, r"for i in 1 2 3; do git fetch"),
 ("stage0 3x failure is a stop",     A, r"FETCH FAILED 3x"),
 ("staged fetches are retried",      T, r"for i in 1 2 3; do git fetch"),
 ("one failed fetch diagnoses nothing", T, r"[Oo]ne failed fetch diagnoses nothing|retry before you draw any conclusion"),
 ("gh api is not a fetch substitute", T, r"fetches\s*\n?no objects|never substitute `gh api` for the refresh"),
]

# Match against the raw text AND a whitespace-collapsed copy: prose wraps at
# arbitrary points, so a rule phrased across a line break is still present.
def present(rx, corpus):
    return re.search(rx, corpus) or re.search(rx, re.sub(r"\s+", " ", corpus))

missing = [lbl for lbl, corpus, rx in RULES if not present(rx, corpus)]
print(f"checked {len(RULES)} behavioural rules")
if missing:
    print(f"\nMISSING ({len(missing)}):")
    for m in missing: print("  -", m)
    sys.exit(1)
print("all present")
