# MK V2 codified steps

Deterministic pieces of the pipeline, pulled out of AI prompts and into scripts. The line:

> **mechanical → code · judgment → AI.**

Where the output should be identical every time (given the same input), a script owns it — so
the run is reproducible and the supervisor's context stays small (it *calls* these instead of
re-deriving them). Where the task is genuine judgment, the AI still owns it.

These ship inside the skill folder, so the installer's `cp -R` lands them at
`.claude/skills/magic-kingdom-v2/scripts/` in any target repo. The emitted supervisor prompt
calls them by that path. All are dependency-free Node (`node >= 18`), JSON in / JSON out,
clean exit codes.

## Codified (mechanical)

| Script | Owns | Input → Output | Exit |
|---|---|---|---|
| `wave-plan.mjs` | build waves + install order + **build bases** | `{phases:[{id,files,deps,migration,planIndex}]}` → `{collisions,collisionDeps,effectiveDeps,buildBases,waves,installOrder}` | 0 · 2 bad input · 3 cycle |
| `ledger.mjs` | the gate ledger + its ONE invariant | `init/set/get/done/validate/render` on a `ledger.json`; gates are gated, `--counters` (e.g. `refit`) are not | 0 · 1 invariant violated · 2 usage |
| `migration-safety.mjs` | static expand-only + version-prefix screen | `<file.sql…> [--registry prefixes.txt]` → `{violations, notes}` JSON | 0 clean · 1 violation · 2 usage |
| `jig-step.mjs` | git/gh jig mechanics | `rebase/push/ci-wait/migration-diff <branch>` → step JSON | 0 ok · 1 conflict/red/missing-required/head-moved · 2 usage/no-PR · 4 ci timeout |

Invariants these enforce so the AI can't drift off them:
- **wave-plan**: two phases share a file ⇒ that is a DEPENDENCY, not just a wave split. The
  collision becomes a real edge (oriented earlier-plan-phase-first, skipped when explicit deps
  already order the pair), so the later phase's `buildBase` is its sibling's branch rather than
  bare `origin/main`. Without that, the deferred phase builds without the shared file's edits: it
  may not compile, and it is guaranteed to conflict when the jig rebases it after the sibling
  merges — burning the ≤2 refit budget on the exact clash the wave split existed to prevent.
  Install order is a real topological sort over the effective deps, migrations pulled earliest,
  deterministic tiebreak on `planIndex`. `buildBases` is transitively reduced, so an integration
  branch appears only when the deps are genuinely independent. The AI supplies the per-phase file
  map (judgment); every ordering decision downstream of it is math.
- **ledger**: a phase is `done` **only** if every GATE cell begins with `PASS`. `done` refuses
  otherwise (exit 1); `validate` re-checks every done phase. "A blank cell = gate not run = not
  done" is now mechanical, not a promise. **Gates vs counters:** `refit` is the FIXER BUDGET
  ("1/2"), which never begins with `PASS` — as a gate it would make `done` permanently impossible,
  so it belongs in `--counters` and `init` refuses it in `--gates` with that explanation.
- **migration-safety**: a **necessary, not sufficient** screen. A FAIL blocks. A PASS still hands
  off to the full gate (staging dry-run + LIVE prod-schema check + expand/contract reasoning) — it
  only removes the unambiguously-destructive cases cheaply and up front. Because a FAIL *blocks*,
  precision beats recall: it screens statement-by-statement, masks `$$ … $$` bodies, skips
  GRANT/REVOKE, and treats `DROP … IF EXISTS` + re-create in the same file as a **note**. Notes
  (scoped `UPDATE`/`DELETE` backfills, idempotent recreates) are exit 0 but are NOT a pass of the
  gate — the gate still judges them. Measured on this repo's 76 migrations: 68 clean, 8 flagged,
  all 8 real (a `DROP TABLE`, a permanently-dropped function, a dropped pkey, a `SET NOT NULL`,
  and policies dropped without recreation).
- **jig-step**: `rebase` refuses a dirty tree and aborts cleanly on conflict; `push` is always
  `--force-with-lease`; `migration-diff` is the ground-truth "does this branch touch the migration
  path" the back-gate keys on. `ci-wait` is the **anti-stale-green** step: `gh pr checks` never says
  which COMMIT a check ran on, so the pre-rebase run reads as green right after a force-push.
  ci-wait instead asks the commit — `commits/<head>/check-runs` + legacy `/status` — refuses to call
  an EMPTY check set green, aborts if the head SHA moves mid-wait, and with `--require <names>`
  refuses green unless every required check is PRESENT and successful on that SHA (which also
  catches a renamed CI job detached from the branch ruleset).

## Still AI (judgment — do NOT script)

G0/G1/G2 adversarial review *content* · `/kevin-pr-review` scoring · functional-test *design*
(`/testing:general:test-review-general`) · fixer code edits · interpreting a **novel** CI failure ·
the expand/contract *reasoning* behind a migration · the STOP-AND-ASK decision.

Rule for the gray zone: **code decides the safe default; AI may only make it more conservative,
never less.** wave-plan can serialize two phases it's unsure about; the AI can't un-serialize them.
ci-wait reports "red on job X"; the AI interprets a novel red but can't call red green.

## Intentionally NOT yet codified

- **`gate-pane.mjs`** (herdr gate-pane lifecycle: spawn right-stacked pane → wait idle/done → dump
  verdict → close). It is the thinnest wrapper and the most entangled with **live** herdr state, so
  it is best validated during a live dry-run rather than written blind. Until it exists, the
  supervisor drives gate panes directly per the herdr conventions in SKILL.md. Tracked here so the
  gap is explicit, not silently assumed covered.
