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
| `wave-plan.mjs` | build waves + install order | `{phases:[{id,files,deps,migration,planIndex}]}` → `{collisions,waves,installOrder}` | 0 · 2 bad input · 3 cycle |
| `ledger.mjs` | the gate ledger + its ONE invariant | `init/set/get/done/validate/render` on a `ledger.json` | 0 · 1 invariant violated · 2 usage |
| `migration-safety.mjs` | static expand-only + version-prefix screen | `<file.sql…> [--registry prefixes.txt]` → violations JSON | 0 clean · 1 violation · 2 usage |
| `jig-step.mjs` | git/gh jig mechanics | `rebase/push/ci-wait/migration-diff <branch>` → step JSON | 0 ok · 1 conflict/red · 2 usage · 4 ci timeout |

Invariants these enforce so the AI can't drift off them:
- **wave-plan**: two phases share a file ⇒ never the same build wave; deps ⇒ never same/earlier
  wave; install order is a real topological sort, migrations pulled earliest, deterministic
  tiebreak on `planIndex`. The AI supplies the per-phase file map (judgment); the grouping is math.
- **ledger**: a phase is `done` **only** if every gate cell begins with `PASS`. `done` refuses
  otherwise (exit 1); `validate` re-checks every done phase. "A blank cell = gate not run = not
  done" is now mechanical, not a promise.
- **migration-safety**: a **necessary, not sufficient** screen. A FAIL blocks. A PASS still hands
  off to the full gate (staging dry-run + LIVE prod-schema check + expand/contract reasoning) — it
  only removes the unambiguously-destructive cases cheaply and up front.
- **jig-step**: `rebase` refuses a dirty tree and aborts cleanly on conflict; `push` is always
  `--force-with-lease`; `ci-wait` resolves the PR **head SHA** and reports it, so CI is verified on
  the *rebased* commit, not a stale run; `migration-diff` is the ground-truth "does this branch
  touch the migration path" the back-gate keys on.

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
