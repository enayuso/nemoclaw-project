#!/usr/bin/env python3
"""render-template.py - fill {{KEY}} placeholders in a template file.

Usage: render-template.py <input.tmpl> <output-file> KEY=VALUE [KEY2=VALUE2 ...]

Uses {{KEY}} tokens rather than bash's own $VAR/${VAR} syntax, specifically
so templated .sh files can contain real bash variable references (${STATE_DIR},
$(date +%s), etc.) without the templater touching them. Errors loudly (nonzero
exit, no output file written) if any {{...}}-shaped placeholder remains
unfilled after substitution - a silently-incomplete render is worse than a
loud failure.

Applies the same "loud beats silent" rule to workspace bootstrap docs
(AGENTS.md / TOOLS.md): OpenClaw truncates any of them that exceed its
configured per-file cap, and does it destructively - see the long comment in
bootstrap.sh section 8. Limits come from registry/bootstrap-limits.json,
the same file bootstrap.sh feeds into the gateway config, so the guard and
the runtime can't drift apart.
"""
import json
import os
import re
import sys

LIMITS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "registry", "bootstrap-limits.json",
)

# Rendered bootstrap docs are named "<role>-AGENTS.md" / "<role>-TOOLS.md".
BOOTSTRAP_DOC = re.compile(r"^(?P<role>.+)-(?:AGENTS|TOOLS)\.md$")


def load_limits():
    with open(LIMITS_PATH) as f:
        limits = json.load(f)
    return limits["bootstrapMaxChars"], limits["bootstrapTotalMaxChars"]


def check_bootstrap_size(output_path, content):
    """Refuse to write a bootstrap doc OpenClaw would silently truncate."""
    match = BOOTSTRAP_DOC.match(os.path.basename(output_path))
    if not match:
        return

    max_chars, total_max_chars = load_limits()
    size = len(content.rstrip())
    if size > max_chars:
        print(
            f"error: {output_path} is {size} chars, over the {max_chars}-char "
            f"per-file bootstrap cap in {LIMITS_PATH}.\n"
            f"       OpenClaw would inject only the first 45% and last 15% "
            f"verbatim, replacing the middle with a lossy line digest that "
            f"drops ~80% of wrapped prose. Shorten the template, move content "
            f"into TOOLS.md, or raise the cap in that file (which also needs "
            f"bootstrap.sh re-run to push it to the gateway).",
            file=sys.stderr,
        )
        sys.exit(1)

    # The per-agent TOTAL across AGENTS.md + TOOLS.md has its own cap. Check it
    # once the sibling exists, so raising the per-file cap can't quietly push a
    # pair over the total one.
    role = match.group("role")
    sibling_name = (
        f"{role}-TOOLS.md" if output_path.endswith("-AGENTS.md")
        else f"{role}-AGENTS.md"
    )
    sibling = os.path.join(os.path.dirname(output_path), sibling_name)
    if not os.path.exists(sibling):
        return
    with open(sibling) as f:
        combined = size + len(f.read().rstrip())
    if combined > total_max_chars:
        print(
            f"error: {role} bootstrap docs total {combined} chars, over the "
            f"{total_max_chars}-char per-agent cap in {LIMITS_PATH}.\n"
            f"       OpenClaw drops whole files once the shared budget runs "
            f"out, so one of this pair would go missing entirely.",
            file=sys.stderr,
        )
        sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    input_path, output_path = sys.argv[1], sys.argv[2]
    values = {}
    for arg in sys.argv[3:]:
        if "=" not in arg:
            print(f"error: argument '{arg}' is not KEY=VALUE", file=sys.stderr)
            sys.exit(1)
        key, _, value = arg.partition("=")
        values[key] = value

    with open(input_path) as f:
        content = f.read()

    for key, value in values.items():
        content = content.replace("{{" + key + "}}", value)

    leftover = re.findall(r"\{\{[A-Za-z0-9_]+\}\}", content)
    if leftover:
        print(
            f"error: unfilled placeholder(s) in {input_path}: {sorted(set(leftover))}",
            file=sys.stderr,
        )
        sys.exit(1)

    check_bootstrap_size(output_path, content)

    with open(output_path, "w") as f:
        f.write(content)


if __name__ == "__main__":
    main()
