#!/usr/bin/env bash
# Magic Kingdom V2 — bundle installer.
#
# MK V2 is not a lone skill; it orchestrates a bundle of sibling skills + commands by
# NAME. Those names only resolve when each one is a REGISTERED skill/command in the
# target project (a top-level folder under .claude/skills, or a file under
# .claude/commands) — NOT nested inside MK V2's folder. So porting MK V2 = copying the
# whole registered set. This script does that in one command.
#
# Usage:   ./install.sh /path/to/target-project
# Result:  target/.claude/skills/<each skill>/  +  target/.claude/commands/<each cmd>.md
#
# The codex plugin (codex:codex-rescue, /codex:review, /codex:adversarial-review) is a
# PLUGIN, not a copyable skill — install it via the Claude Code plugin marketplace.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then echo "usage: $0 /path/to/target-project" >&2; exit 2; fi
if [ ! -d "$TARGET" ]; then echo "error: target not found: $TARGET" >&2; exit 2; fi

# This script lives at <central>/.claude/skills/magic-kingdom-v2/install.sh
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"          # -> <central>/.claude
SRC_SKILLS="$SRC/skills"
SRC_CMDS="$SRC/commands"

DST_SKILLS="$TARGET/.claude/skills"
DST_CMDS="$TARGET/.claude/commands"
mkdir -p "$DST_SKILLS" "$DST_CMDS"

# --- the bundle -------------------------------------------------------------
#  magic-kingdom-v2 : this skill (the generator)
#  squadron-v2      : front-half — parallel fleet, waves, Codex gates, round budget
#  magic-kingdom    : back-half reference (full-auto merge/migration/prod-test gates)
#  planf3           : produces the input plan; agents follow its build conventions
#  qa-fleet         : isolation recipe (per-group Docker DBs) the fleet uses
#  kevin-pr-review  : PR review invoked in the jig + merge gate
#  debrief          : sibling handoff squadron-v2 offers at the end
SKILLS=(magic-kingdom-v2 squadron-v2 magic-kingdom planf3 qa-fleet kevin-pr-review debrief)
#  github           : commit + push (/github)
#  merge-into-main  : merge the PR (/merge-into-main)
COMMANDS=(github merge-into-main)
# Nested commands — copied preserving their subdirectory (a flat name would lose the path
# and de-register them). These are functional-test gates the jig + back-gates invoke:
#  testing/general/test-review-general : browser-driven functional test+review+fix loop,
#      run on the PREVIEW build (jig) and re-run on the PROD version (back-gate D4).
#  subagents                           : the fixer-fanout note test-review-general reads.
NESTED_COMMANDS=(testing/general/test-review-general.md subagents.md)
# Optional (not copied by default): squadron (v1 fallback), qa-pipeline (qa-fleet's base).

echo "Installing Magic Kingdom V2 bundle"
echo "  from: $SRC"
echo "  into: $TARGET/.claude"
echo
miss=0

for s in "${SKILLS[@]}"; do
  if [ -d "$SRC_SKILLS/$s" ]; then
    rm -rf "$DST_SKILLS/$s"
    cp -R "$SRC_SKILLS/$s" "$DST_SKILLS/$s"
    echo "  ✓ skill  $s"
  else
    echo "  ✗ skill  $s  — MISSING from source; add it to $SRC_SKILLS first" >&2
    miss=1
  fi
done

for c in "${COMMANDS[@]}"; do
  if [ -f "$SRC_CMDS/$c.md" ]; then
    cp "$SRC_CMDS/$c.md" "$DST_CMDS/$c.md"
    echo "  ✓ cmd    $c.md"
  else
    echo "  ✗ cmd    $c.md — MISSING from source; add it to $SRC_CMDS first" >&2
    miss=1
  fi
done

for nc in "${NESTED_COMMANDS[@]}"; do
  if [ -f "$SRC_CMDS/$nc" ]; then
    mkdir -p "$DST_CMDS/$(dirname "$nc")"
    cp "$SRC_CMDS/$nc" "$DST_CMDS/$nc"
    echo "  ✓ cmd    $nc"
  else
    echo "  ✗ cmd    $nc — MISSING from source; add it to $SRC_CMDS first" >&2
    miss=1
  fi
done

echo
echo "Plugin (install separately — NOT copyable):"
if [ -d "$HOME/.claude/plugins/cache/openai-codex" ]; then
  echo "  ✓ openai-codex present in this environment's plugin cache"
else
  echo "  • openai-codex NOT found — install via the Claude Code plugin marketplace."
fi
echo "    Provides: codex:codex-rescue, /codex:review, /codex:adversarial-review"
echo

echo "Post-install checks (run against the target):"
echo "  ls \"$DST_SKILLS\" | grep -E 'magic-kingdom-v2|squadron-v2|kevin-pr-review'"
echo "  ls \"$DST_CMDS\"   | grep -E 'github|merge-into-main'"
echo "  ls \"$DST_CMDS/testing/general\" | grep test-review-general   # nested gate installed"
echo "  ls \"$DST_SKILLS/magic-kingdom-v2/scripts\"   # codified steps: wave-plan/ledger/migration-safety/jig-step (+README)"
echo "  # then in the target project, confirm they register:  /magic-kingdom-v2  and  /squadron-v2"
echo

if [ "$miss" -eq 0 ]; then
  echo "Bundle installed."
else
  echo "Bundle installed WITH WARNINGS (see ✗ above)."; exit 1
fi
