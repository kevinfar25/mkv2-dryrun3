#!/usr/bin/env bash
# sync-skill.sh — keep this sandbox's magic-kingdom-v2 copy byte-identical to the CANONICAL
# copy in tradegamesfinal, and REFUSE to let a dry run proceed against a stale copy.
#
# Why this exists: the whole point of the dry run is to exercise the FIXED skill. The first
# run of this sandbox silently used an older copy — zero of the seven fixes were present —
# so a green result would have proved nothing about the code we actually ship. A dry run that
# validates the wrong artifact is worse than no dry run, because it manufactures confidence.
#
#   ./scripts/sync-skill.sh check   # exit 0 identical, 1 drifted (use this as a run precondition)
#   ./scripts/sync-skill.sh sync    # copy canonical -> sandbox, then re-check
#
# CANONICAL is tradegamesfinal's installed copy — the one that will run the real buildout.
# Override with MKV2_CANONICAL=/some/path for a different source of truth.
set -euo pipefail

CANONICAL="${MKV2_CANONICAL:-/Users/kevinfarrugia/Documents/Github/tradegamesfinal/.claude/skills/magic-kingdom-v2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$HERE/.claude/skills/magic-kingdom-v2"
MODE="${1:-check}"

if [[ ! -d "$CANONICAL" ]]; then
  echo "FAIL: canonical copy not found at $CANONICAL" >&2
  exit 2
fi

# Markers for the fixes this dry run exists to exercise. A copy missing any of them is
# definitionally the wrong artifact, independent of whether diff happens to be clean.
#
# Each marker is bound to the ONE FILE that must contain it, as `<path>:<marker>`. A folder-wide
# grep is not good enough and was actively misleading: `collisionDeps` also appears in SKILL.md
# and scripts/README.md, so a wave-plan.mjs that had LOST the collision-dependency code still
# scored "present" off the prose describing it. Documentation mentioning a fix is not the fix.
MARKERS=(
  "scripts/wave-plan.mjs:collisionDeps"          # collision => dependency edge
  "scripts/wave-plan.mjs:buildBases"             # per-phase worktree base
  "scripts/ledger.mjs:cmdReady"                  # BACK-GATE 1 / D1 readiness
  "scripts/ledger.mjs:POST_MERGE"                # pre-merge vs post-merge gate split
  "scripts/ledger.mjs:KNOWN_COUNTERS"            # counters are not gates
  "scripts/jig-step.mjs:check-runs"              # checks bound to the head SHA
  "scripts/jig-step.mjs:requiredNotSuccess"      # --require enforcement
  "scripts/jig-step.mjs:assertOnBranch"          # right-worktree assertion
  "scripts/migration-safety.mjs:doBodies"        # DO blocks are scanned
  "scripts/migration-safety.mjs:fnBodies"        # function bodies are masked
  "scripts/migration-safety.mjs:callableWith"    # overload/default-arg identity
  "install.sh:abspath"                           # self-install guard
  "SKILL.md:ATOMIC MIGRATION RUNNER"             # D2 must use the atomic runner
  "SKILL.md:VALIDATE ONLY"                       # B3 never applies
)

check() {
  local bad=0
  if ! diff -r "$CANONICAL" "$SANDBOX" >/tmp/mkv2-skill-drift.txt 2>&1; then
    echo "DRIFT: sandbox skill differs from canonical" >&2
    sed 's/^/  /' /tmp/mkv2-skill-drift.txt >&2
    bad=1
  fi
  for pair in "${MARKERS[@]}"; do
    local f="${pair%%:*}" m="${pair#*:}" n
    if [[ ! -f "$SANDBOX/$f" ]]; then
      echo "FAIL: $f missing from the sandbox copy entirely" >&2
      bad=1
      continue
    fi
    n="$(grep -c -F -- "$m" "$SANDBOX/$f" 2>/dev/null || true)"
    if [[ -z "$n" || "$n" == "0" ]]; then
      echo "FAIL: fix marker '$m' absent from $f — that file is the OLD version" >&2
      bad=1
    fi
  done
  if [[ "$bad" != "0" ]]; then
    echo "" >&2
    echo "Run ./scripts/sync-skill.sh sync before starting a dry run." >&2
    return 1
  fi
  echo "OK: sandbox skill is byte-identical to canonical, all ${#MARKERS[@]} fix markers present"
  echo "    canonical: $CANONICAL"
  return 0
}

case "$MODE" in
  check) check ;;
  sync)
    rm -rf "$SANDBOX"
    mkdir -p "$(dirname "$SANDBOX")"
    cp -R "$CANONICAL" "$SANDBOX"
    echo "synced $CANONICAL -> $SANDBOX"
    check
    ;;
  *) echo "usage: $0 <check|sync>" >&2; exit 2 ;;
esac
