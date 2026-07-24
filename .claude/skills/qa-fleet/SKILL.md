---
name: qa-fleet
description: >-
  Parallel QA-fix orchestrator that sits ON TOP of qa-pipeline. Takes a batch of
  issues (e.g. GS-02 GS-32 GS-58 …), grounds each against the REAL rendered
  component, groups them by code-area + risk, stands up ONE Docker container
  hosting N isolated per-group prod-copy DBs, then fans out one cmux pane +
  `claude --dangerously-skip-permissions -w` worktree per group — each wired to
  its own DB + port and running the qa-pipeline stages. The orchestrator
  supervises in waves with ACTIVE liveness/stuck-detection (not just a filesystem
  watchdog), collects an acceptance report per group, opens a PR per group, and
  consolidates. NEVER merges, NEVER moves cards. Invoke with the issue
  identifiers, e.g. "/qa-fleet GS-02 GS-32 GS-58 GS-79".
---

# QA Fleet — parallel QA-fix orchestrator

Runs many `qa-pipeline` groups **concurrently**, each in a fully isolated git
worktree + Docker database, with the main conversation acting as the **conductor**:
grounding centrally, fanning out child Claude instances, supervising their
liveness, and consolidating at the end. This is the parallel evolution of
`qa-pipeline` (which runs groups sequentially in one checkout). Use it when a batch
is large enough that sequential would be slow and the groups touch independent
code-areas/data.

**Layering:** `qa-fleet` (this skill) = the orchestrator. Each child pane runs the
existing `qa-pipeline` mechanics (`.claude/pipeline/run.sh`: Stage 0 implement → 1
→ 2 → optional 3). Don't reimplement the per-group pipeline here — drive it.

## Authorization this skill carries
Invoking this skill is the user's explicit, durable authorization, for this run
only, to: create Docker containers/DBs from a prod dump (read-only `pg_dump`);
create git worktrees; spawn `claude --dangerously-skip-permissions` child
instances; and have each child `git add`/`commit`/`push` its **branch** + `gh pr
create`. It does NOT authorize: `gh pr merge`, pushing to `main`, force ops, or
moving Kanban cards. The user reviews/merges PRs and moves cards.

## Input
Issue identifiers as arguments (GS numbers, bare issue numbers, or a mix). With no
args, ask which issues to run (the one allowed pause). Inputs are generic — any
defect list works, GitHub issues are just the common case.

---

## Procedure

### Phase 0 — Resolve & read
Resolve GS→issue numbers (`gh issue list --state open --limit 300 --json
number,title`). Fetch each body + comments (`gh issue view <n> --json
title,body,comments`) — comments explain WHY a ticket was reopened.

### Phase 1 — GROUND centrally (do NOT delegate this)
Grounding stays in the orchestrator so children never fix the wrong twin screen.
Fan out read-only Explore/general agents (one per rough cluster) to, per ticket:
follow the repro path to the **actually-rendered** component, confirm the exact
`file:line`, identify root cause, and state whether it's **already fixed in the
tree** (very common for reopened tickets — check for the GS-id marker / prior
commit) vs a **genuine gap**. For data/calc bugs, compute the expected value from
real rows by hand (Supabase MCP read-only, or the Docker copy once it's up).
Record per ticket: confirmed component, root cause, already-fixed?, DB-dependent?,
acceptance criteria, must-NOT-regress.

### Phase 2 — GROUP
Group grounded tickets by shared file/code-area + risk into small batches (~2–4).
Order: low-risk first; **auth / email / AI / destructive last**. Name each group
`g1…gN`. Be honest about scope: already-fixed groups become **verify + regression
test** (maybe NO PR), not forced no-op diffs.

### Phase 3 — Stand up shared infra (one container, N DBs)
Start Docker (ask the user to launch Docker Desktop if the daemon is down — you
can't). Run the bundled script from the repo root:
`./.claude/skills/qa-fleet/setup-docker-dbs.sh <N>`
It dumps prod (session pooler :5432, PG17), restores into `goose_base`, and clones
`goose_g1..gN` via `CREATE DATABASE … TEMPLATE`. Each group's DSN:
`postgresql://postgres:localqa@127.0.0.1:55432/goose_g<i>`. This also neutralizes
the real hazard that **`.env.local` points at PROD** — children point at Docker
instead. (Docker shows ONE container; the N DBs live inside it — expected.)

### Phase 4 — Write one spec brief per group
Write `reports/g<i>-<area>-spec.md` (reports/ is gitignored — local only) from the
grounding: per ticket the defect, repro, confirmed `file:line`, root cause,
acceptance criteria (real expected numbers for calc bugs), a Playwright spec
requirement, and an explicit must-NOT-regress list. Assign each group its
worktree name (`reopen-g<i>`), DB (`goose_g<i>`), PORT (3025+i), branch
(`fix/reopen-g<i>-<area>`), and SKIP_BUILD (0 for gap/relabel groups, 1 or 0 for
verify groups). Manager screens need the manager dev cookie `…0002`; rep screens
`…0001`.

### Phase 5 — Fan out (one pane + worktree + child instance per group)
For each group, in waves (see Phase 6):
1. `cmux new-pane --type terminal --direction down --id-format both` → capture `surface:N`.
2. In the pane: `claude --dangerously-skip-permissions -w reopen-g<i>` (creates the
   worktree at `.claude/worktrees/reopen-g<i>` — inside the repo, so node_modules
   resolves upward). Wait ~12s for the instance, then `cmux send` the task prompt +
   a separate `send-key enter`.
3. The task prompt is SHORT and points the child at two abs-path files —
   `.claude/skills/qa-fleet/CHILD-RUNBOOK.md` and the group's
   `reports/g<i>-*-spec.md` — plus its PARAMS (MAINREPO, GROUP, WORKTREE, DBNAME,
   PORT, BRANCH, SPEC, SKIP_BUILD). The child does ALL its own setup (env wired to
   its Docker DB, playwright PORT patch), runs the pipeline, verifies on the real
   screen, writes the acceptance report to `MAINREPO/reports/acceptance_g<i>_*.md`,
   and opens a PR (never merges).

### Phase 6 — Supervise in WAVES + ACTIVE liveness (the part that matters)
Run **~3 groups concurrently**, not all at once — contention on one machine causes
flaky tests = false reopens. Roll the next group in as one finishes (its
acceptance report lands / PR opens).

Two complementary monitors:
- **Filesystem milestone monitor** (persistent `Monitor`): emits env-ready, run-dir,
  Stage 0/1/2/3 verdicts, and acceptance-report-landed across all `reopen-g*`
  worktrees; de-dupe via a seen-file; SKIP the staleness watchdog for groups that
  already have an acceptance report (else completed groups false-alarm at 40min).
- **ACTIVE pane liveness check** (REQUIRED — a filesystem watchdog is NOT enough).
  A child can sit *actively retrying a doomed operation* (e.g. a dev-server boot
  looping on `EADDRINUSE` / a crashed `tsx server.ts` / waiting on a port that will
  never come up) — the run dir isn't even being written during manual-verify, and
  "spinning on an unsatisfiable condition" looks identical to "working." A child
  blocked at an interactive prompt also never trips a run-dir watchdog. So
  periodically `cmux read-screen` each ACTIVE pane and flag stuck signatures:
  `EADDRINUSE` / `ECONNREFUSED` / "waiting for … to be ready" / "failed with exit
  code" / repeated identical retries / an idle empty prompt with NO forward
  progress across N checks / a flat token count. **On a hit, INTERVENE** — nudge the
  pane with guidance, or kill+relaunch the doomed step — rather than waiting for the
  coarse watchdog or for the USER to notice. A nudge that works: remind the child
  the pipeline ALREADY verified the feature (Stage 1/2 + N tests green) so a
  redundant manual dev-server boot must not block it — try ONE clean boot then
  proceed to report + PR, citing the pipeline pass + noting local-boot flakiness.
  Run this as a periodic poll (every few minutes per active pane), not a one-shot.
  Kill cwd-scoped only (never bare `pkill -f run.sh` — it would kill sibling groups).

### Phase 7 — Collect & confirm
As each group finishes: read its `reports/acceptance_g<i>_*.md`, confirm the PR
exists (`gh pr list --head fix/reopen-g<i>-*`), and sanity-check the committed diff
(only intended files — NOT reports/, .env*, or the playwright PORT patch). Note any
**out-of-scope fixes** the adversarial stage made (e.g. auth guards, input
validation) — these are valuable but need extra review.

### Phase 8 — Consolidate
Produce the final report: the PR table (one per group); per-ticket Open→Fixed
recommendations WITH verification boundaries (real-device-only and
serverless-only tickets can't be confirmed locally — say so); out-of-scope
security fixes flagged for careful review; new bugs surfaced as candidate tickets;
and any latent test-hygiene issues (e.g. specs hardcoded to a fixed port that fail
under the per-group ports). The user merges PRs and moves cards.

### Phase 9 — Teardown (on request only)
Leave infra UP while the user reviews PRs. On request: `docker rm -f goose-qa-pg`;
`git worktree remove .claude/worktrees/reopen-g<i>` (branches are pushed, so safe);
`git worktree prune`. Don't auto-teardown — the user may want to re-verify/rework.

## Guardrails
- Never `gh pr merge`, never push to `main`, never move cards.
- Neutralize external side-effects in every child `.env.local`: blank
  `SERVICETITAN_APP_KEY` (live Door Serv Pro write-back) and `RESEND_API_KEY`
  (real email); never trigger live paid Claude calls in tests (use idempotency
  early-returns / mocks). ServiceTitan write-back is the one genuine external risk
  and only the call-analysis flow hits it.
- **`.env.local` neutralization is VOID under a doppler-wrapped dev command.** `npm run dev`
  (and any doppler-wrapped `run.sh`) inject the prod `DATABASE_URL` + real `RESEND`/
  `SERVICETITAN` keys, overriding the child's `.env.local` — so "isolated" children silently
  read/write PROD. Children MUST boot with `npm run dev:nodoppler` (or `next dev` directly)
  and **prove the live DB is their Docker DB before any write** (see CHILD-RUNBOOK §1 & §4).
  A real run leaked writes to prod test accounts this way.
- Waves of ~3; full isolation per group (own worktree + own DB + own PORT + own
  playwright.config PORT patch reverted before commit).
- Honest scoping: already-fixed groups get verify + acceptance (maybe no PR).

## Lessons baked in (from the 23-reopened run, 2026-06-16)
- Most "reopened" tickets were already fixed on `main` with no reopen comment —
  grounding revealed this, saving wasted implement runs. Always ground first.
- One container / many DBs (TEMPLATE clone) = isolation without thrash.
- The active liveness check (Phase 6) exists because G7 hung on a dead dev-server
  port and the USER caught it before the coarse watchdog did. Don't repeat that.
- Adversarial stages found real out-of-scope issues (malformed-UUID 500s, missing
  auth guards) — surface them prominently; they need careful review.

## Related
`qa-pipeline` (the per-group engine this drives), and memory:
`project_qa_orchestrator_skill_idea`, `reference_local_docker_qa_env`,
`reference_cmux_cli`, `reference_qa_verification_harness`, `feedback_board_cards`.
