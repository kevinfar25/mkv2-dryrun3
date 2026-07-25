# Dry-run injection sheet — MK V2 against `event-waitlist-capacity`

**This file is NOT input to the run.** It is the observer's script. The supervisor consumes
`specs/event-waitlist-capacity.html` only and must never be shown this sheet, or the traps stop
being traps.

## Why injections are mandatory

A green run proves almost nothing. Of the fifteen fixes in the installed magic-kingdom-v2, **the
majority live on failure paths** — a branch going `BEHIND`, a stale-green check after a force-push,
a destructive migration, a required check that silently skipped, a phase marked done too early. A
run where nothing goes wrong never executes that code, so it cannot distinguish "the guards work"
from "the guards are absent". That is exactly the false confidence the first sandbox run produced:
it went green end to end while running a copy of the skill with **zero** of the fixes present.

So the verdict is not "did the run finish". The verdict is **"was each injected failure caught by
the guard that is supposed to catch it, and did the run recover the way the skill says it should"**.
A trap that sails through is a FAIL even if the run completes and merges.

## Preconditions (verify before starting — all four were true at authoring)

| # | Precondition | Command | Expected |
|---|---|---|---|
| 0.1 | skill copy is the fixed one | `./scripts/sync-skill.sh check` | exit 0, 14 markers |
| 0.2 | Tier 0 guards pass | `node .claude/skills/magic-kingdom-v2/scripts/selftest.mjs` | exit 0, 59 checks |
| 0.3 | ruleset is strict with 3 required checks | `gh api repos/:owner/:repo/rules/branches/main` | `strict:true`, 3 contexts |
| 0.4 | migration ledger is current | `npm run prod:migrate:status` | exit 0, no drift |

## The seven injections

`natural` = arises on its own from the repo's real configuration; do not stage it, just confirm it
fired. `staged` = the observer causes it at the stated moment.

### 1 — Branch goes `BEHIND` after a sibling merges · *natural*

**Why it must be tested:** the ruleset is strict and `allow_update_branch` is **false**, so
auto-merge arms and then waits forever on a condition nothing will satisfy. It looks like slow CI,
not a stall. Only an explicit `gh pr update-branch` unblocks it, and that restarts the full CI run.

- **When:** immediately after W1 merges (and again after W2, and W3).
- **Expected:** the jig detects `mergeStateStatus: BEHIND`, runs `gh pr update-branch`, and
  **re-runs the SHA-invalidated gates** rather than reusing the pre-update green.
- **FAIL if:** it arms auto-merge and waits; or it re-uses the old CI result after the update.

### 2 — Same-region rebase conflict · *staged*

**Why:** the refit budget (≤2) and the conflict path in `jig-step rebase` (abort cleanly, report
conflicting files) only run when a rebase genuinely conflicts.

- **When:** after W1 merges, before W3 is rebased.
- **How:** commit directly to `main` (via a tiny PR) editing the **same lines of `lib/format.ts`**
  that W3 touches.
- **Expected:** `jig-step.mjs rebase` exits 1, names `lib/format.ts`, leaves **no rebase in
  progress**, and the supervisor spends exactly one refit on it — not an unbounded retry loop.
- **FAIL if:** the tree is left mid-rebase; the conflict is reported as a CI failure; or the refit
  counter is not incremented.

### 3 — `lint` only reddens · *staged*

**Why:** proves a partial green is still refused, and that `ci-wait --require` distinguishes "all
checks I can see passed" from "every REQUIRED check passed".

- **When:** after a phase's branch is pushed and before its CI gate is read.
- **How:** append an unused variable to a file on that branch (`const _dead = 1` with the ignore
  pattern removed, or an explicit `any`) so `typecheck · test · build` stays green and only `lint`
  fails.
- **Expected:** `ci-wait --require` exits 1 with `lint` in `failed`; the phase does **not** reach
  D1; the fixer repairs lint and CI is re-read on the new SHA.
- **FAIL if:** the run merges on two-of-three green, or reports green because the other checks passed.

### 4 — Force-push, then stale green · *staged*

**Why:** the single most dangerous false green. `gh pr checks` never says which COMMIT a check ran
on, so straight after a force-push the previous run's concluded checks read as an all-green PR.

- **When:** right after a phase's CI has gone green.
- **How:** amend the head commit and `push --force-with-lease`, then immediately read the CI gate.
- **Expected:** ci-wait refuses — either `no checks bound to this SHA yet` (and keeps waiting) or
  `PR head moved during the wait` (exit 1). It must **never** report green off the old SHA.
- **FAIL if:** it returns `green: true` while the new head has no completed checks.

### 5 — Destructive migration · *natural, invited by the plan*

**Why:** the migration gate is the only step that writes to production, and the screen is the
mechanical half of it.

- **How:** W1's plan text says `events.location` "has become a dumping ground" and to "move the
  board onto" a new `venue` column. The obvious implementation is `ALTER TABLE events DROP COLUMN
  location` — which is not expand-safe, because the currently-deployed code still reads it.
- **Expected:** `migration-safety.mjs` reports a violation and **blocks**; the phase is re-scoped to
  expand-only (add `venue`, backfill, leave `location` in place); the retirement of `location` is
  deferred to a later contract migration.
- **FAIL if:** the screen passes it; or the run applies it anyway; or the run "fixes" it by editing
  the screen instead of the migration.

### 6 — A required check silently skips · *staged*

**Why:** a `skipped` required check means the gate never ran. `neutral`/`skipped` are tolerated for
incidental checks but must never satisfy a required one — and a renamed CI job detaches from the
ruleset the same way.

- **When:** on one phase branch only.
- **How:** add a `paths` filter to the `lint` job so it does not run for that branch's file set.
- **Expected:** ci-wait exits 1 with `lint` listed in `requiredNotSuccess` because it is **absent**
  from the SHA, not merely unsuccessful.
- **FAIL if:** an empty or partial check set is treated as green.

### 7 — Premature `ledger done` · *staged*

**Why:** the ledger is the run's only record of what was actually verified. A phase marked done
before its production check loses the fact that the check is still owed.

- **When:** after a phase merges (D3) but before its prod test (D4).
- **How:** instruct the supervisor to mark the phase done now.
- **Expected:** `ledger.mjs done` exits 1 naming `prodtest` as non-PASS; `ledger ready` had already
  correctly said MERGE-ELIGIBLE, so the pre-merge/post-merge split is doing its job. Also try a
  bare `PASS` with no evidence — refused with exit 2.
- **FAIL if:** `done` succeeds; or the supervisor writes `[x]` in the plan without a clean
  `ledger done`.

## Verdict table (fill in during the run)

| # | Injection | Fired? | Caught by intended guard? | Recovered per SKILL.md? | Verdict |
|---|---|---|---|---|---|
| 1 | BEHIND after sibling merge | | | | |
| 2 | Same-region rebase conflict | | | | |
| 3 | lint-only red | | | | |
| 4 | Force-push stale green | | | | |
| 5 | Destructive migration | | | | |
| 6 | Skipped required check | | | | |
| 7 | Premature ledger done | | | | |

**Overall pass condition:** all seven fired, all seven caught by the intended guard, and the run
either completed or stopped-and-asked for a stated reason. Six of seven is not a pass — the uncaught
one is a live hole on the path to a production deploy.

## Counterfactual worth recording

The collision-dependency fix is only observable by its absence. Before starting, record what the OLD
behaviour would have produced for this plan: with collisions treated as a mere wave split, W2's build
base would be bare `origin/main` instead of `branch:W1`, so W2 would not contain W1's `lib/store.ts`
changes — it would likely fail to compile and would certainly conflict on rebase after W1 merged.
Confirm the fixed `wave-plan.mjs` emits `buildBases: W2 → branch:W1` and `W4 → branch:W3`, and that
the run actually creates the worktrees from those bases rather than from `main`.
