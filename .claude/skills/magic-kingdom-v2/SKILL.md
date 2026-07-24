---
name: magic-kingdom-v2
description: >-
  Generate a tailored SUPERVISOR/orchestrator prompt from a planf3 spec HTML so a
  herdr supervisor can drive the plan as a PARALLEL fleet that lands to prod
  autonomously: fan phases out in dependency-ordered waves (squadron-v2 mechanics,
  ported to herdr), then feed the landed branches through a NEW re-fit jig
  (rebase-onto-current-main → re-verify → re-review → re-migration-gate →
  switch-on test) into MK V1's full-auto merge + migration + prod-test gates, one
  branch at a time. Meta skill — it EMITS a prompt; it does NOT itself build,
  test, merge, or apply migrations. Project-agnostic: all repo specifics are
  detected at generation time. Invoke with a spec path, e.g.
  "/magic-kingdom-v2 specs/my-feature.html".
argument-hint: "[path-to-planf3-plan.html]"
---

# Magic Kingdom V2 — parallel-build → re-fit jig → full-auto deploy (meta skill)

Given a planf3 spec/plan HTML, produce a ready-to-paste, **self-contained** supervisor
prompt that drives the plan as a **parallel fleet** and lands it **all the way to
production autonomously**, through a fixed, safety-gated pipeline — and write it to a
file.

MK V2 is the fusion the two existing skills each do half of:

- **Front (from `/squadron-v2`):** fan phases out in dependency-ordered **waves**, each
  in an isolated worktree + throwaway DB, adversarially Codex-reviewed, landed as a
  verified PR. squadron-v2 **stops there** and hands PRs to a human.
- **Middle (NEW — the re-fit jig):** rebase each landed branch onto the *current* main,
  re-verify from scratch, re-review the combined diff, re-run the migration gate against
  the now-live schema, switch-on test — then hand off. No prior skill does this.
- **Back (from `/magic-kingdom` v1):** the **full-auto** merge gate → migration safety
  gate (applies expand SQL to prod) → post-deploy prod test → mark `[x]`. MK V1 does this
  sequentially, one phase at a time; MK V2 does it as a serial *merge-train* fed by the
  jig.

**You are generating a prompt.** Do NOT execute the plan, open panes, run tests, merge,
or apply migrations. Your only outputs are the written prompt file and a short summary.

> **⚠️ This emits a FULL-AUTO-TO-PROD orchestration.** The prompt it produces will
> auto-merge to `main` and auto-apply migrations to production without a human in the
> loop, gate-by-gate. Only generate it for a repo where that is sanctioned (a solo/owned
> deploy target, or one where the user has explicitly authorized unattended deploys). If
> Step 2 finds a live-customer prod with no staging gate, SAY SO in the summary and make
> the merge/migration gates' "stop-and-ask" conditions prominent — full-auto is a loaded
> gun pointed at that customer, and the gates are the only safety.

## How the emitted prompt is RUN — DELEGATE it; never hand-drive it

The prompt this skill emits is meant to be **executed by a dedicated supervisor agent**, not
performed by hand by whoever generated it. The correct run is: open a fresh herdr pane (or an
Agent), launch `claude --dangerously-skip-permissions`, paste the emitted prompt, and let
**that** agent be the supervisor — it opens the worker panes, delegates each phase, and runs
every gate by following the written prompt literally. The person who ran `/magic-kingdom-v2`
only launches the supervisor and observes.

**Put the whole run in its OWN, correctly-named workspace.** `herdr tab create` /
`herdr workspace create` WITHOUT `--workspace` default to the launcher's *current* workspace —
so if you don't target one, the supervisor and all its worker panes land in whatever workspace
you happen to be in (e.g. `~bbtt`), NOT where the run belongs. Before launching: pick/create
the run's workspace explicitly (e.g. a workspace named for the project/run), capture its opaque
id from JSON, and create the supervisor tab with `--workspace <that-id>`. The supervisor then
spawns EVERY worker/gate pane in that SAME workspace (splits inherit it; `workspace create`/`tab
create` it does itself must also pass the id). Never rely on the ambient workspace.

**Why this is not optional:** hand-driving the pipeline is exactly how gates get silently
dropped. A human improvising from memory keeps the fast/mechanical gates (CI, migration
hygiene) top-of-mind and lets the slow judgment gates (Codex G1/G2, `/kevin-pr-review`,
`test-review-general`, the real-browser switch-on) quietly fall off — without noticing. An
agent executing the written prompt with an on-disk gate ledger cannot "decide it looks fine
and skip." So: **the orchestration itself is delegated.** Do not collapse the supervisor role
into yourself.

### Scaling the orchestration — thin top orchestrator + fresh sub-supervisors

One supervisor across all waves + the jig accumulates an unbounded context (every build wave,
every Codex gate, every fixer round). It works for a small run but does not scale — and a huge
context is a liability across a long autonomous run (drift, stalls, cost). For any non-trivial
run (**> ~3 phases or > 2 waves**), split the single supervisor into a **thin top orchestrator
that spawns a FRESH sub-supervisor per stage**. A tiny run (a chain, one wide wave) may stay a
single supervisor — this is the same pattern the front→jig `/clear` already proved out (context
353k→71k, the jig ran the whole merge-train cold from ~10% context).

- **TOP ORCHESTRATOR** — persistent, near-idle, deliberately kept small (holds only: the plan
  pointer, the derived wave/install order, pointers to the on-disk ledgers, and a registry of
  which sub-supervisor ran which stage). It **never reads feature code, never watches a build,
  never runs a gate.** Each stage it: writes/points the sub-supervisor at its brief + ledger →
  spawns ONE fresh sub-supervisor pane → **blocks on it** with `herdr agent wait <pane> --until
  done` → reads its ~10-line structured report → records it → tears the pane down → spawns the
  next. Between stages it is idle. It wakes only at stage boundaries.
- **SUB-SUPERVISORS** — ephemeral, fresh context each, one per stage:
    · one per **front wave** (build the wave's phases in worker panes, run G1/G2 per phase, open
      PRs, fill the front ledger, report `{phase → PR#, gate cells}`), then
    · one for the **jig+install** merge-train (rebase→back-gates→merge→prod-test per branch;
      split further **per-phase** only if even the jig context grows large).
  Each boots ENTIRELY from durable on-disk artifacts (its brief + the ledger) — it needs nothing
  from the parent's or a sibling's conversation — does its stage, reports up, and dies.
- **The ledger is the real supervisor; the agent is a cursor over it.** The handoff artifact is
  the on-disk ledger + a per-stage brief (this skill already emits `JIG-BRIEF.md` for the jig;
  generalize it: emit a short brief per sub-supervisor — install/wave scope, the PR↔branch↔phase
  map, DB facts, and pointers to the emitted prompt + ledger + CLAUDE.md). A fresh sub-supervisor
  re-derives its whole world from those files, which is exactly why the reset loses nothing.
- **One level of nesting only.** The parent waits on sub-supervisors (via herdr *status*, never
  by tailing); a sub-supervisor watches its own workers/gates. Do NOT stack three live tiers of
  agents each tailing the one below — that multiplies stall surface. The parent blocks on a
  `--until done` transition and does nothing else; it is not a live watcher of a live watcher.
- **#2 makes this cheap.** Because the codified scripts (`wave-plan`/`ledger`/`jig-step`/
  `migration-safety`) own the mechanical steps, each sub-supervisor *calls* them instead of
  re-deriving — so every sub-context stays small and the parent stays near-empty. Codifying (#2)
  and this topology (#1) reinforce each other.

**NEVER SKIP A GATE TO SAVE TIME OR TOKENS.** Every gate runs on every phase, in order. A
gate is PER-PHASE: a pass on P1 says nothing about P2..Pn. Running a gate's mechanism once
does not discharge it for the others. If a gate seems redundant or too costly, **STOP and
ask the human** — never skip silently, and never substitute a deterministic gate (CI/lint)
for a judgment gate (adversarial review, PR review, functional browser test). This is baked
into the template as a hard on-disk gate ledger below; keep it there.

## Relationship to its siblings (all live in the same skills dir, ported per project)

MK V2 **reuses, does not re-invent.** The emitted prompt *references* the installed
sibling skills for their mechanical procedures rather than re-inlining hundreds of lines:

- **`/squadron-v2`** — the wave/isolation/Codex-gate/round-budget machinery. The emitted
  prompt says "run each wave per squadron-v2" plus a small **substrate-substitution block**
  (cmux → herdr) and the **Codex-from-main-checkout fix** (below). Everything
  substrate-independent in squadron-v2 (the round budget, the on-disk gate ledger,
  verify-don't-trust, the DB-sentinel) carries over unchanged.
- **`/kevin-pr-review`**, **`/github`**, **`/merge-into-main`**, **`codex:codex-rescue`** —
  invoked as-is.
- **The jig and the full-auto back-gates are INLINED verbatim** in the template — the jig
  because it has no home skill, the back-gates because they are the safety-critical core
  and must not drift behind a reference.

## Requires — the bundle (port together, do NOT nest)

MK V2 invokes its dependencies **by registered name** (`/squadron-v2`, `/kevin-pr-review`,
`/github`, `/merge-into-main`, `codex:codex-rescue`). A name only resolves when that skill
is a **top-level** folder under `.claude/skills/` (or the command a file under
`.claude/commands/`). **Nesting a dependency inside this folder de-registers it** — it
becomes ordinary files, the name stops resolving, and the reference breaks. So the port
unit is the *set*, kept as siblings — not one folder.

| Dependency | Kind | Used for |
|---|---|---|
| `squadron-v2` | skill | Front-half: waves, isolation, Codex gates, round budget (ported cmux→herdr) |
| `magic-kingdom` | skill | Back-half reference: the full-auto merge/migration/prod-test gates |
| `planf3` | skill | Produces the input plan; agents follow its build conventions |
| `qa-fleet` | skill | Isolation recipe (per-group Docker DBs) the fleet uses |
| `kevin-pr-review` | skill | PR review invoked in jig B2 and merge gate D1 |
| `debrief` | skill | Sibling handoff squadron-v2 offers at the end |
| `github` | command | commit + push |
| `merge-into-main` | command | merge the PR |
| `testing/general/test-review-general` | command (nested) | Browser-driven functional test+review+fix loop — run on the PREVIEW build in jig B5, re-run on the PROD version in back-gate D4 |
| `subagents` | command | Fixer-fanout note `test-review-general` reads |
| `openai-codex` | **plugin** | `codex:codex-rescue` + `/codex:review` + `/codex:adversarial-review` — install via marketplace; NOT copyable |

**To port MK V2 into a new project:** run `install.sh` (in this folder) with the target
path — it copies every skill + command in the bundle into the target's `.claude/`, and
tells you if the codex plugin needs installing:

```bash
.claude/skills/magic-kingdom-v2/install.sh /path/to/target-project
```

(herdr is the runtime substrate, assumed present in the environment; not part of the copy.)

## Inputs

- `args` = path to the spec/plan HTML. If missing, ask for it. Resolve to an **absolute
  path** (panes rooted elsewhere won't find a relative one).

---

## Step 1 — Read the plan and extract (be exhaustive — this drives self-containment)

Read the WHOLE spec. This is the union of MK V1 Step 1 and squadron-v2 Step 1. Capture,
per phase, verbatim:

1. **Absolute plan path** and the plan **slug** (basename without extension).
2. **Every phase** — id + title + milestone tag + full task bullets + its "🔁 Do not exit
   until…" exit condition + any Testing-Strategy commands. Preserve order.
3. **Per-phase Relevant Files** — walk "Relevant Files" / "New Files" / "Existing —
   remove/consolidate" and attribute each file to the phase(s) that reference it (phases
   are usually tagged `(P4)`, `P2`, …). **This attribution is load-bearing** — it is what
   Step 3 uses to compute wave collisions. If a plan's file list is untagged/global with
   no per-phase attribution, FLAG IT: the waves cannot be derived safely and the run
   should fall back to smaller waves (or MK V1 sequential). Say so in the summary.
4. **Milestones** + per-phase due dates — convert relative dates to absolute.
5. **Migration-touching phases** — any phase adding/editing the project's migration path
   (Step 2 detects that path). Flag ⚠migration. Latent-schema phases (persist
   config/state but list no migration file) → ⚠migration-if-schema with MK V1's verbatim
   "confirm against the LIVE schema; route through the gate only if the diff adds SQL" note.
6. **Destructive/removal phases** — delete files/routes, drop tables, revoke grants →
   ⚠destructive.
7. **Unresolved decisions** — planf3's `<section id="decisions">`: any `[open]` decision
   blocks the phases in its `data-blocks`. Those phases do NOT launch. List them. If ALL
   resolved, say so explicitly so the supervisor never re-asks.
8. **Phase-specific control-flow nuances** stated in the spec → a PHASE-SPECIFIC NOTES
   block that overrides the generic loop.
9. **Where the plan lives** — a `.claude/worktrees/<name>/…` path ⇒ worktree-rooted.
10. **Status marker convention** (usually `[] [wip] [x] [f]`).

## Step 2 — Detect repo-specific safety facts (project-agnostic — DETECT, never hardcode)

MK V2 is portable **because it detects these per project** and fills them into the prompt.
Read the target repo's `CLAUDE.md`, `package.json` scripts, migration dir, and project
memory. Fold in whatever applies; use CONCRETE values, not placeholders. **Never bake one
project's answer into this skill.**

- Does merging the deploy branch ship to prod, and is there a staging gate? (No gate +
  live customer ⇒ raise the full-auto warning above.)
- Do migrations deploy **separately** from code? (⇒ expand/contract required.) What is the
  **migration path** (`supabase/migrations/**`, `prisma/migrations/**`, `db/migrate/**`, …)
  and the **applied-versions registry** (`schema_migrations`, `_prisma_migrations`, …)?
  A repo with no separate-deploy migrations ⇒ the jig's migration re-check (B3) and MK V1's
  migration gate are **no-ops**; say so and the prompt simply never triggers them.
- **Staging target** to dry-run migrations against, and **how the supervisor reaches prod**
  to apply them (secret-manager config + psql path, or equivalent).
- **Exact required CI check names** (so the supervisor verifies the right ones).
- **Secret-manager wrapping** — grep `package.json` scripts for `doppler run` / `infisical
  run` / `direnv` / `vault` / `dotenv-vault`. If wrapped, find the **non-injecting dev
  command** (e.g. `dev:nodoppler`, or `PORT=<p> next dev` directly). This is the sandbox-
  proof half of the front-half; a wrapped `dev` writes "local" verification to PROD.
- **External-write env keys to neutralize** in each group's env (payment/CRM write-back,
  email send, SMS, push — e.g. a ServiceTitan/Stripe/Resend/Twilio key). Detect from the
  repo; do not assume a fixed set.
- **Functional-test surface** (drives `/testing:general:test-review-general` in jig B5 and
  back-gate D4): how a preview/build is served for browser-driving (the non-injecting dev
  command + PORT, or a `vercel`/`next start` preview), whether **Playwright** is available
  (MCP wired, else `npx playwright`), and — for a **headless/API-only** project with no UI —
  note that "browser-driving" degrades to driving the HTTP surface **through a real client
  with assertions on end-to-end behaviour** (NOT a single curl: still exercise full flows,
  create→read→verify, error paths). Also detect whether prod is a **live customer** (⇒ D4's
  `test-review-general` re-run is READ-ONLY smoke; the full write-bearing functional pass runs
  on preview/staging) or an **owned/sandbox** target (⇒ D4 may run the full functional pass).
- **Hosted-preview reachability (Vercel/Netlify/etc.)** — when the deploy target hosts a
  per-branch **preview URL**, detect whether Playwright can actually REACH it. Preview
  deployment protection (Vercel "Deployment Protection" / SSO) blocks a naked driver, and how
  you get past it is plan-tier-dependent:
    • **Paid tier** — protection is bypassable with a **Protection Bypass for Automation**
      token (send header `x-vercel-protection-bypass: <token>`, or
      `?x-vercel-set-bypass-cookie=true`). ⇒ jig B4/B5 drive the hosted **PREVIEW** URL
      (closest-to-prod artifact, per rebased branch) and D4 drives the hosted **PROD** URL.
    • **Free tier** — preview protection **cannot be lifted or bypassed**, so there is NO
      drivable hosted preview. ⇒ run the write-bearing B4/B5 pass on the **locally-served**
      preview (the non-injecting dev command + PORT) — or, ONLY if prod is an owned/sandbox
      target, directly on the hosted **PROD** URL — and use the hosted PROD URL for D4.
  Record which surface each gate drove in the ledger. A hosted preview being unreachable is
  NEVER license to skip B4/B5 — it selects a different surface, it does not remove the gate.
- **Codex-companion-in-worktree constraint** — the codex companion (`review` /
  `adversarial-review` / `task`) **dies with a worktree as cwd** (`failed to load
  configuration`). This is a property of the tool, not any repo. The emitted prompt MUST
  dispatch every Codex job **from the main checkout** targeting `main...<branch>`. (Prefer
  `task` without `--write` — tool-enforced read-only, accepts focus text.)
- **Grant/RLS conventions** for new tables (RLS ≠ table grants), and any **already-collided
  migration version prefixes** to avoid reusing.
- Any spec-stated migration discipline (e.g. "every DROP is a later contract migration") —
  quote it into the gate.
- **The repo's recurring failure modes** for the adversarial-review focus text — derive
  from CLAUDE.md + memory (multi-tenant scoping, authz, timezone, N+1, external writes,
  etc.). **Do NOT reuse another project's failure-mode list.** If none are documented, use
  a generic secure-review focus and note the gap.

## Step 3 — Derive the dependency waves + the install order

From the per-phase Relevant Files (Step 1.3), following squadron-v2 step 2:

- **Collision graph:** two phases collide iff their Relevant-Files sets intersect (or an
  explicit `data-deps` / "Depends on: Phase N" / prose hint says so). A phase depends on
  every phase that creates or heavily modifies a file it also touches.
- **Waves:** topologically sort; a wave = phases whose dependencies have all **been built**
  (have a branch), NOT merged. Run a wave in parallel; start the next only when the current
  wave's groups have an open, green PR.
- **Build base (the load-bearing fix — the front does NOT merge between waves):** a phase's
  worktree branches off **`origin/main` + every dependency branch merged in**, NOT bare
  `origin/main`. For an independent phase that's just `origin/main`; for a phase with one
  dependency it's that dependency's branch tip; for several, create an ephemeral integration
  base (`git checkout -b <int> origin/main && git merge <depA> <depB> …`) and branch off it.
  Otherwise a dependent phase builds against a main that lacks its dependency's code and
  cannot even compile. The inflated PR diff (it carries the dep's commits too) is expected —
  when the dependency merges first, the jig's rebase-onto-main drops those commits and the PR
  shrinks to just this phase (standard stacked-PR behaviour). Emit each phase's base explicitly.
- **When ambiguous, prefer a SMALLER wave** (more sequential) over risking a collision, and
  present the proposed grouping for the user to correct before launch. A pure chain
  collapses to one-at-a-time (= MK V1 sequential, no waste); all-independent → one wide wave.
- **Install order** (for the jig's merge-train): foundational phases first; among the rest,
  **migration-carrying branches one at a time**; ties broken by fewest-files-touched first
  (minimises downstream rebase pain). Dependencies are hard edges; this only sequences
  within what they allow.

Emit both the wave list and the install order into the prompt.

**Codify the derivation (do NOT compute waves by hand).** Reading the plan to decide which
files each phase touches is judgment — you do that. Turning that file map into waves + install
order is a pure graph problem with one right answer, so hand it to the script and paste its
output. Write the map you extracted to a manifest and run:

```
node .claude/skills/magic-kingdom-v2/scripts/wave-plan.mjs <manifest.json>
#   manifest: { "phases":[ {"id":"P1","files":[…],"deps":[…],"migration":true,"planIndex":0}, … ] }
#   → { collisions, waves, installOrder }   (exit 3 = dependency cycle → fix the manifest)
```

Its `waves`/`installOrder` are authoritative; if they surprise you, the manifest's file map is
wrong (fix the judgment input), not the algorithm. The script enforces the invariants above:
shared file ⇒ never same wave; deps ⇒ never same/earlier wave; migrations pulled earliest in
the install order. Keep the "when ambiguous, prefer a smaller wave" rule by being conservative
in the *manifest* (over-list a phase's files) — code can only make the grouping more serial.

## Step 4 — Emit the prompt (and WRITE IT TO A FILE)

Fill the TEMPLATE. Replace every `«…»` with concrete detected values — **leave no
placeholder in the output.** Keep the jig and the two back-gates **exactly** as written.
Append one DELEGATION BLOCK per phase so the prompt is self-contained.

**Write to `specs/<slug>-mkv2-supervisor-prompt.md`** (Markdown: a short header noting
source + generation date + "FULL-AUTO-TO-PROD", then the prompt in one fenced block). Then
print the Step 5 check + a 3–5 line summary.

## Step 5 — Completeness self-check (aim for 100%) — verify BEFORE finishing

Re-read the emitted prompt against the plan; fix and re-write if any fails:

- [ ] Every phase appears, in order, with a delegation block (tasks, Relevant Files, exit
      condition, test commands).
- [ ] Waves + install order are present and derived from Relevant Files (not guessed); the
      untagged-files fallback is noted if it applied.
- [ ] Every migration/destructive phase is flagged; nothing mis-flagged.
- [ ] All decisions accounted for (resolved → "do not re-ask"; open → blocked phases listed).
- [ ] Every phase-specific nuance is in PHASE-SPECIFIC NOTES.
- [ ] No `«placeholder»` remains; CI names, staging + prod access, non-injecting dev
      command, migration path/registry, external-write keys, main-checkout path, and the
      repo's review focus text are all concrete.
- [ ] The jig section and BOTH back-gates are present verbatim.
- [ ] Per-phase gate coverage is unmissable: the FRONT ledger (G1+G2 per phase) and the jig
      ledger (rebase·ci·codexreview·prreview·migration·switchon·functest·merge·prodtest) are
      both present, and the "no [x] with any blank cell / never skip a gate" rule is intact.
- [ ] `/testing:general:test-review-general` appears BOTH at jig B5 (preview) and back-gate D4
      (prod, with the live-customer read-only vs sandbox-full mode), and `/kevin-pr-review`
      ≥4/5 is at B2 + D1.
- [ ] The full-auto warning is present, and prominent if it's a live-customer / no-staging repo.
- [ ] Waves + install order were produced by `scripts/wave-plan.mjs` (from an extracted file
      manifest), not derived by hand; the jig ledger is driven by `scripts/ledger.mjs` and the
      CODIFIED HELPERS block (ledger/jig-step/migration-safety) is present in the jig template.
- [ ] For a run > ~3 phases or > 2 waves, the thin-top-orchestrator + fresh-sub-supervisor
      topology is called out (a per-stage brief per sub-supervisor; parent waits via herdr
      `--until done`, one level of nesting). A tiny run may stay single-supervisor — say which.

---

### TEMPLATE

```
ROLE: You are the SUPERVISOR of a PARALLEL fleet that lands to PRODUCTION autonomously.
You do NOT write code, run tests, or edit files yourself. You open herdr panes, run
phases in dependency-ordered WAVES, drive the re-fit jig and the deploy gates, actively
VERIFY every gate (never trust a pane's self-report), and are the SOLE writer of the
plan's status markers. SUBSTRATE: herdr (not cmux). Launch every pane with
`claude --dangerously-skip-permissions`.

⛔ NEVER SKIP A GATE TO SAVE TIME OR TOKENS. Every gate below (G0; per-phase G1 + G2;
CI; /kevin-pr-review ≥4/5; jig B1–B5 incl. /testing:general:test-review-general on the
preview; the MIGRATION SAFETY GATE; and the POST-DEPLOY PROD TEST) runs on EVERY phase,
in order. Gates are PER-PHASE — a pass on one phase discharges nothing for the others.
You mark a phase [x] ONLY when its ENTIRE gate-ledger row is PASS-with-evidence; any blank
cell means the gate has not run → it is NOT optional → run it, or STOP and ask the human.
"It looks fine / to move faster" is never a reason to skip. A deterministic gate (CI/lint)
never substitutes for a judgment gate (Codex review, PR review, functional browser test).

⚠ FULL-AUTO TO PROD: this run auto-merges to main and auto-applies migrations to
production. «IF live-customer/no-staging: the prod DB serves a LIVE CUSTOMER with no
staging gate — the merge gate and MIGRATION SAFETY GATE are the only thing between this
fleet and that customer. When any gate cannot be satisfied with certainty, STOP and ping
the human. Do not "self-resolve" a prod-facing doubt.»

PLAN: «absolute plan path»   SLUG: «slug»
PHASES (with milestone + ⚠migration/⚠destructive flags): «P1..Pn»
WAVES: «Wave1=[…]  Wave2=[…]  …»
INSTALL ORDER (the merge-train sequence): «P… → P… → …»
MILESTONES: «M1 … due <abs> · …»
DECISIONS: «all resolved — do not re-ask» | «OPEN: <d> blocks P<n> — those phases do NOT launch»
REPO FACTS: deploy=«…» · migrations=«path/registry or NONE» · staging=«…» · prod-access=«…» ·
  CI checks=«…» · non-injecting dev cmd=«…» · neutralize keys=«…» · main-checkout=«…» ·
  collided prefixes=«…» · grant/RLS rule=«…»
You are the SOLE writer of «[] [wip] [x] [f]»: [wip] at launch, [x] ONLY after the phase
is merged, deployed, and passes its POST-DEPLOY PROD TEST, [f] + one-line reason on failure.

CODEX GATES — RUN THEM IN HERDR PANES, NOT AS BACKGROUND CLI JOBS (applies to G0/G1/G2 and
jig B2). Two hard facts learned the hard way:
  (a) The codex companion dies with a WORKTREE as cwd (`failed to load configuration`) → every
      Codex job runs from «main-checkout», targeting `main...<branch>`.
  (b) The companion's `task --background` jobs are NOT herdr-trackable and, in direct-startup
      mode, its job registry does NOT persist across CLI invocations — so a `run_in_background`
      dispatch + hand-polling `status/result <job-id>` STALLS: the poller can't see the job,
      the jobs run SERIALLY, and the supervisor spins for minutes while the real workers sit
      done. DO NOT dispatch Codex gates that way.
  ⇒ Instead, run each Codex gate in its OWN herdr pane so herdr tracks it natively and gates
    run CONCURRENTLY (this is the `/herdr` "check for readiness with native status" answer
    applied to gates, not just builds):
        p=$(herdr pane split <anchor> --direction down --no-focus --cwd «main-checkout» ...)  # opaque id from JSON
        herdr pane rename <p> "P<N>-G2"; herdr pane set-bg <p> "#1b1822"
        herdr pane run <p> "node \"$CODEX\" task --model spark --effort high 'main...<branch> — <focus>'"
        herdr pane wait-output <p> --regex '<a codex completion marker>' --timeout <ms>   # OR:
        herdr agent wait <p> --until idle --timeout <ms>     # codex pane goes idle when the task returns
        herdr pane read <p> --source recent-unwrapped --lines <N>   # read the raw verdict YOURSELF
        herdr pane close <p>                                        # DONE with it → close immediately
    Spawn all of a wave's G1/G2 panes at once (right-stack, distinct bg) → they run in
    parallel → wait on each pane → read each verdict → CLOSE each gate pane the moment its
    verdict is recorded (per PANE LIFECYCLE — don't let gate panes pile up). Never leave a
    gate on an un-watched background job. (If you ever must use `task --background`, you own
    the job-registry fragility — prefer the pane approach.)

═══════════════════════════════════════════════════════════════════════════
PHASE 0 — G0: challenge the plan (once, before wave 1)
Run squadron-v2's G0 exactly (Codex read-only attack on phasing/waves/assumptions via
codex:codex-rescue, ONE job, no re-review loop, revert any edits it made). If it lands a
real objection, DEFAULT TO FIXING IT AUTONOMOUSLY, not asking:
  • IN-SCOPE fix (the gap is implied by the plan's own phases/goals — a missing store
    method a phase needs, a wrong file-attribution/collision-edge, a missing enabling
    route/seed the plan's tests require, a mis-derived wave): AMEND the plan spec + re-derive
    the affected waves/collision-graph yourself, RE-RUN G0 to confirm clean, then proceed to
    Wave 1. Record what you changed. Do NOT stop for this — this is the autonomous fix loop.
  • Only STOP-AND-ASK if the objection is genuinely OUT OF SCOPE (a new feature/product or
    business/UX decision the plan doesn't imply and you can't resolve from the plan's intent),
    or an OPEN planf3 decision, or it reveals the whole approach is wrong. Record the outcome.
Autonomy rule (applies to EVERY gate, not just G0): running the gate is mandatory (never
skip it), but a gate FINDING is something you FIX in-scope + re-verify and continue — not a
reason to stop. Stop only for a true blocker per STOP-AND-ASK below.

═══════════════════════════════════════════════════════════════════════════
FRONT — build each WAVE as a parallel fleet  (run per /squadron-v2, with substitutions)
For each wave, execute squadron-v2's procedure (steps 3–9: isolation, briefs, supervise,
G1 defect sweep + G2 adversarial review, the HARD on-disk round budget, the DB-sentinel,
verify-don't-trust, one PR per group) — with these substitutions ONLY:

  SUBSTRATE (cmux → herdr — AUTHORITATIVE per the /herdr skill; verify with `herdr pane`,
    `herdr agent`, `herdr --help` at author time; assert `HERDR_ENV=1` first). IDs are OPAQUE
    strings parsed from JSON (e.g. `w1:p3`) — NEVER construct one from a workspace/display
    number. Supervisor context: $HERDR_PANE_ID / $HERDR_WORKSPACE_ID; target the calling pane
    with `--current`. ⚠ THE TWO COMMANDS THAT ARE EASY TO GET WRONG (verified against the live
    binary): there is NO `herdr wait` — status waits are `herdr agent wait <pane> --until
    <status>` and output waits are `herdr pane wait-output <pane> --match|--regex`. And
    `herdr pane run` runs a SHELL command in the pane (use it only to LAUNCH the TUI); to talk
    to the running agent you use `herdr agent prompt <pane> "<text>"` (it submits on Enter).
    LAYOUT CONVENTION: YOU (the supervisor) stay in the LEFT pane; every worker you spin up
    goes to the RIGHT, stacked vertically. Split the FIRST worker off your pane with
    `--direction right`; stack each SUBSEQUENT worker with `--direction down` targeting the
    first worker. Give each worker a distinct dark background shade (`herdr pane set-bg`) so
    the workers read apart from you and from each other at a glance.
    create a group pane (split to the RIGHT of the supervisor, keep the human's focus, launch):
        # BUILD BASE (Step 3): independent phase → origin/main; dependent phase → its
        # dependency branch(es), NOT bare origin/main, or it can't compile against the dep's code.
        git worktree add <wt> <build-base>            # origin/main | <dep-branch> | <integration-branch>
        herdr pane split --current --direction right --no-focus --cwd <wt> --env PORT=<port>
        # ↑ first worker; STACK later workers on the right instead:
        #   herdr pane split <first-worker-pane> --direction down --no-focus --cwd <wt> --env PORT=<port>
        # read result.pane.pane_id from the JSON response — opaque; do not build it
        herdr pane rename <pane_id> "P<N>-build"
        herdr pane set-bg <pane_id> "#191b26"         # a dark shade distinct from yours; vary per worker
        herdr pane run <pane_id> "claude --dangerously-skip-permissions"     # launch the TUI (a shell cmd)
        herdr agent wait <pane_id> --until idle --timeout 30000             # TUI ready (NOT `herdr wait`)
        herdr agent prompt <pane_id> "<brief>"        # brief the AGENT (NOT `pane run` — that's a shell cmd)
    delegate / follow-up: herdr agent prompt <pane_id> "<message>"
    LIVENESS / supervision — NATIVE agent status (a straight upgrade over cmux read-screen
      polling; this is what squadron/MK V1 approximate by hand):
        herdr agent wait <pane_id> --until working --timeout <ms>    # confirm it started
        herdr agent wait <pane_id> --until done    --timeout <ms>    # completion (bg); or --until idle if foreground
        # status semantics: idle=ready/seen · working · blocked=NEEDS INPUT (the stuck state →
        # intervene) · done=finished-unseen · unknown=no agent yet. Treat idle OR done as
        # "completed" when inspecting `herdr pane get`.
    await a marker:  herdr pane wait-output <pane_id> --regex 'SQ-(DONE|BLOCKED) P<N>' --timeout <ms>
    read a transcript: herdr pane read <pane_id> --source recent-unwrapped --lines <N>
    label per stage: herdr pane rename <pane_id> "P<N>-<stage>"
    PANE LIFECYCLE — CLOSE FINISHED PANES (mandatory hygiene): a pane exists only while it
      has live work. The MOMENT you have consumed its output, CLOSE it with
      `herdr pane close <pane_id>` (only panes YOU opened) — do NOT let finished panes
      accumulate:
        · Codex GATE pane (G0/G1/G2/B2): close it as soon as you've READ its raw verdict and
          recorded it in the ledger.
        · BUILD worker pane: close it once its PR is open AND its front-ledger row is complete
          (ci/G1/G2 recorded). If a FIXER is needed later, open a FRESH pane — don't keep the
          build pane alive "just in case."
        · FIXER pane: close it once the fix is committed and re-verified.
        · The ONLY pane that persists for the whole run is YOU (the supervisor).
      Close each pane as it finishes (not in a batch at the end) so the workspace never fills
      with dead panes. Before opening a new wave's panes, `herdr pane list` and close any of
      yours still lingering from the previous stage.
    enumerate:       herdr pane list --workspace $HERDR_WORKSPACE_ID · herdr pane current --current
    (herdr also has `herdr worktree <sub>` helpers; plain `git worktree add` is fine and
     substrate-independent — use it, then split a pane with --cwd into it.)
  CODEX: dispatch G0/G1/G2 per CODEX-FROM-MAIN-CHECKOUT above (NOT with the worktree as
    cwd — squadron-v2's worktree-cwd dispatch is the one thing that does not work).
  REVIEW FOCUS (G2): use «the repo's recurring failure modes» detected for THIS repo.
  ISOLATION FACTS: branch off the phase's BUILD BASE (Step 3: origin/main for an independent
    phase, else its dependency branch / integration branch — never bare origin/main for a
    dependent phase); per-group Docker DB + PORT; per-worktree .env.local replacing the data
    vars; start dev with «non-injecting dev cmd»; neutralize «keys»; DB-sentinel before any
    write. (Verbatim squadron-v2 except the build base, which is dependency-aware.)

FRONT GATE LEDGER (on-disk, «scratchpad»/mkv2-front-ledger.md — one row PER PHASE, not per
wave): `P<N> — ci:· G1:· G2:· pr:pending status:building`. G1 (defect sweep) and G2
(adversarial review) are run for EVERY phase, every wave — never "once on the first phase."
Fill each cell only from the raw Codex `result <job-id>` you read yourself; a blank G1/G2
cell means that phase was NOT reviewed → it cannot leave the front. Re-read this file before
declaring a wave done.

A wave is DONE when every group has an open PR, CI green, and BOTH Codex gates (G1 and G2)
read clean BY YOU from the raw result FOR EACH PHASE in the wave (its ledger row complete).
Only then start the next wave. A group that fails/caps/times out does not block the wave;
its dependents are marked blocked (squadron-v2 rule).

DO NOT merge in the front. squadron-v2 stops at the PR; so does the front. Merging happens
only in the jig+install loop below.

═══════════════════════════════════════════════════════════════════════════
MIDDLE + BACK — THE RE-FIT JIG + SERIAL INSTALL (interleaved; ONE loop)
Runs after ALL waves have produced verified PRs. The jig and the install are one serial
loop — every install moves main, so each remaining branch is re-fit at ITS turn.

═══ STAGE HANDOFF — RESET CONTEXT AT THE FRONT→JIG BOUNDARY (do this here) ═══
The front (parallel, throwaway, no prod writes) and the jig (serial, prod-writing, re-verifies
from scratch) are different MODES, and by now the front supervisor's context is huge (all the
build waves + every Codex gate + fixer round). This boundary is the natural place to RESET
context so the jig runs with a small, clean one. The jig deliberately re-verifies everything
and NEVER trusts the front's stamps, so it needs only DURABLE ON-DISK artifacts — not the
front's conversation. Therefore:
  1. Before resetting, the front supervisor WRITES a jig-bootstrap handoff doc (e.g.
     `JIG-BRIEF.md` at repo root) capturing: install order, the PR↔branch↔phase map, the
     migration phases, the deferred-to-B2 notes (each phase's accepted/non-blocking items from
     the front ledger), the prod/staging DB facts, and POINTERS to the emitted supervisor
     prompt (the full jig+back-gate spec) + the front ledger + CLAUDE.md. Confirm the front
     ledger + emitted prompt are on disk (they are the source of truth).
  2. RESET the supervisor context — `/clear` the supervisor pane (keeps its workspace/bg), or
     close it and launch a FRESH supervisor pane in the same workspace.
  3. Re-brief the (now cold-start) jig supervisor: "read the handoff doc + emitted prompt, run
     the jig+install merge-train autonomously (full-auto sanctioned), start with the first
     branch in install order." It rebuilds the jig ledger and proceeds — losing nothing,
     because everything it needs is on disk.
This is the bounded-context / stage-handoff pattern (a big context is a liability across a long
autonomous run). Under the **thin-top-orchestrator topology** (see "Scaling the orchestration"),
this reset is automatic and happens at EVERY stage boundary — the jig is simply a fresh
sub-supervisor the parent spawns from this brief, and so is each front wave; the `/clear` here is
the minimal single-supervisor version of the same move. Skip it only if the whole run's context
is still small (a tiny chain / one wide wave).

PRECONDITIONS: install order computed (above) → «scratchpad»/mkv2-install-order.md.
On-disk ledger «scratchpad»/mkv2-jig-ledger.md, one row per branch — one cell PER GATE:
`P<N> — rebase:· ci:· codexreview:· prreview:· migration:· switchon:· functest:· merge:· prodtest:· refit:0/2 status:pending`.
Cells map to: rebase=A, ci=B1, codexreview=B2 Codex, prreview=B2 /kevin-pr-review ≥4/5,
migration=B3, switchon=B4, functest=B5 /testing:general:test-review-general (preview),
merge=D3, prodtest=D4. Fill each ONLY from evidence you verified yourself (job-id / score /
live query / merge SHA). Write before each step, RE-READ before each step (survives
compaction). The file is the truth. ⛔ A branch may NOT be marked [x] while ANY gate cell in
its row is blank — an empty cell = the gate did not run = STOP (run it or escalate); never
skip it "to save time."

CODIFIED HELPERS (mechanical steps are SCRIPTS — call them, don't hand-drive; judgment stays
yours). All under `.claude/skills/magic-kingdom-v2/scripts/`, JSON in/out, clean exit codes:
  · LEDGER — back the ledger with `ledger.mjs` (JSON source of truth; `render` prints the table):
      `node …/ledger.mjs init  <jig.json> --phases P1,P4,… --gates rebase,ci,codexreview,prreview,migration,switchon,functest,merge,prodtest,refit`
      `node …/ledger.mjs set   <jig.json> P1 ci "PASS gh@<sha>"`   (a cell counts as pass ONLY if it begins with PASS)
      `node …/ledger.mjs done  <jig.json> P1`     → REFUSES (exit 1) unless every gate cell is PASS — the never-skip rule, mechanically enforced
      `node …/ledger.mjs validate <jig.json>`     → exit 1 if ANY done phase has a non-PASS cell. Run before declaring the train complete.
  · JIG MECHANICS — `jig-step.mjs` owns the one-right-way git/gh steps (below): `rebase` (STEP A),
    `push` --force-with-lease, `ci-wait` (B1, resolves + reports the PR HEAD SHA so CI is verified on
    the REBASED commit), `migration-diff` (B3/D1 universal SQL check). Interpreting a NOVEL red is
    still yours; the script only reports ground truth.
  · MIGRATION STATIC SCREEN — `migration-safety.mjs <file.sql…> --registry <prefixes>` is the
    mechanical HALF of BACK-GATE 2: a FAIL blocks; a PASS still hands off to the full gate (staging
    dry-run + LIVE prod-schema check + expand/contract reasoning). Necessary, not sufficient.

FOR EACH BRANCH in install order, one at a time:

 STEP A — RE-FIT (rebase onto the current house)
   A1. git -C <worktree> fetch -q origin
   A2. git -C <worktree> rebase origin/main
       (first branch: usually a no-op; later branches are behind by what already installed
        — that gap is exactly what the jig closes.)
   A3. CONFLICT (rebase stops) → git rebase --abort; ledger rebase:conflict. This is the
       OBVIOUS clash (two phases edited the same lines) → FIXER (below). Never resolve by guessing.
   A4. CLEAN → history was rewritten → git -C <worktree> push --force-with-lease origin <branch>.
       --force-with-lease is REQUIRED and SAFE here (own feature branch, never main/shared);
       plain --force is BANNED. If it refuses, STOP and inspect — something touched the branch.

 STEP B — RE-INSPECT the re-fitted branch (NEVER reuse the fleet's stamp)
   B1. CI: `gh pr checks <PR#>` green ON THE REBASED head SHA (the force-push retriggers;
       confirm head SHA == rebased HEAD, not a stale pass).
   B2. RE-REVIEW the COMBINED diff — from «main-checkout» (CODEX-FROM-MAIN-CHECKOUT),
       range main...<branch>, focus = «repo failure modes». Read result yourself. Confirmed
       findings → FIXER. This is the catch for the SILENT clash a clean rebase merged
       without a conflict (a sibling renamed a symbol this branch still calls). Also re-run
       `/kevin-pr-review <PR#>` from «main-checkout» to its 4/5 bar if fixes were driven.
   B3. MIGRATION re-check (skip entirely if migrations=NONE): 
       git -C <worktree> diff --name-only origin/main...HEAD -- '«migration path»'
       If ANY file → run the MIGRATION SAFETY GATE (BACK-GATE 2 below) AGAINST THE
       NOW-CURRENT LIVE SCHEMA — a sibling migration may have landed: re-confirm no
       version-prefix collision in «registry», re-confirm expand/contract still holds
       against the updated schema, DRY-RUN on «staging» again. A pass from before a sibling
       merged is VOID.
   B4. SWITCH-ON test — drive the feature on the functional-test surface for the REBASED
       branch (hosted preview URL if reachable per the hosted-preview-reachability rule, else
       the locally-served preview), in a herdr pane, with Playwright (browser-driving rule
       below). Only reliable catch for a silent clash B2 missed. Failure BLOCKS → FIXER.
   B5. FUNCTIONAL TEST+REVIEW on the SURFACE — run `/testing:general:test-review-general`
       against that same surface for the REBASED branch (delegate it to a herdr pane; it
       plans tests, drives REAL browser/HTTP flows end-to-end per the browser-driving rule,
       reviews the built code against THIS phase's plan tasks, and fans out subagents to fix
       — see the command). This is broader than B4's single switch-on: it exercises the
       phase's full flows (create→read→verify, forms, error paths), not just that the feature
       turns on. Iterate to green, but BOUNDED by the FIXER refit budget (≤2) — do not loop
       forever; a residual after the budget → held + escalate. Record functest:pass only when
       its own report is clean. (Writes are allowed here — the preview is throwaway.)

 STEP C — VERDICT
   All of B green → STEP D. Any B failed + FIXER budget spent → status:held, escalate with
   specifics, SKIP this branch AND its dependents (mark blocked), continue with the next
   independent branch. A held branch never blocks the whole train.

 STEP D — INSTALL (full-auto — BACK-GATES, verbatim)
   D1. BACK-GATE 1 — MERGE GATE: all CI green (verified), /kevin-pr-review ≥ 4/5, switch-on
       (B4) passed AND functest (B5 /testing:general:test-review-general) clean on the final
       commit, every task satisfied (you checked), no open decision for this phase — i.e.
       EVERY jig ledger cell for this branch is PASS (no blanks). UNIVERSAL SQL CHECK: `git diff --name-only origin/main...HEAD --
       '«migration path»'` — if it lists ANY file, BACK-GATE 2 MUST pass first (even absent
       a ⚠ flag; the diff is ground truth). All true → proceed.
   D2. BACK-GATE 2 — MIGRATION SAFETY GATE (skip if migrations=NONE or diff has no SQL).
       Apply the expand SQL to prod ONLY if ALL true; if uncertain on ANY point, do NOT
       apply, do NOT merge, ping the human:
         • Expand-only: CREATE {TABLE,COLUMN,FUNCTION,INDEX CONCURRENTLY,POLICY} or ADD
           COLUMN with safe default. NO DROP/RENAME/type-narrow/destructive-DML/TRUNCATE on
           live objects. «spec migration-discipline quote, if any»
         • Expand/contract holds: new code runs on OLD schema AND old code on NEW schema.
         • Dry-run applied + verified green on «staging» FIRST.
         • Prod objects the migration assumes exist actually exist — checked LIVE via
           «prod-access». (Prod schema drifts; never infer from migration history.)
         • New tables: REVOKE ALL from anon/authenticated, then GRANT minimal; RLS TO
           authenticated + tenant-scoped («grant/RLS rule»). RLS ≠ table grants.
         • Unique version prefix (no collision with «collided prefixes»).
         • APPLY ORDER: expand migrations to prod BEFORE the code merge; contract/cleanup deferred.
       All true → apply via «prod-access», verify with a LIVE query, then merge.
   D3. Merge the PR to main (/merge-into-main). Confirm the merge commit landed (git log).
   D4. BACK-GATE 3 — POST-DEPLOY PROD TEST: a merge IS a prod deploy — exercise THIS phase
       LIVE on prod by RE-RUNNING `/testing:general:test-review-general` against the PROD
       version — the hosted **PROD** URL where the deploy target hosts one (Vercel/Netlify),
       else the deployed prod app (the same functional gate as B5, now on what shipped). MODE by «prod live-
       customer?»: on a LIVE-CUSTOMER prod it is READ-ONLY smoke — drive the read/verify half
       of each flow, no writes/admin (those were proven on «staging»/preview in B5); on an
       OWNED/SANDBOX prod, run the full functional pass. Regression → hotfix through this same
       loop on a new branch before continuing; never leave prod red. Record prodtest:pass.
   D5. Mark the phase [x] in the plan (you are the sole writer). THE HOUSE JUST CHANGED —
       origin/main now includes this branch. Loop back to STEP A for the next branch; it
       must be re-fit against this new main. This per-install re-fit is why jig+install are
       one loop.

 THE FIXER — bounded drift resolution
   When A3/B2/B3/B4/B5 needs a code change: open a FRESH herdr pane in the branch's worktree
   (SUBSTRATE block: split to the right of the supervisor --cwd <wt> → rename → set-bg →
   `herdr pane run <pane> "claude --dangerously-skip-permissions"` → `herdr agent wait <pane>
   --until idle` → `herdr agent prompt <pane> "<the SPECIFIC fix>"` — the conflict, or the
   single finding, NOT "clean up the branch"), have it re-verify locally, CLOSE the fixer pane
   once the fix is committed + re-verified (PANE LIFECYCLE — don't leave it open), then
   RE-ENTER the jig at STEP A (the fix may itself need re-fitting).
   BUDGET: refit ≤ 2 per branch, on-disk, MONOTONIC (never resets on a "different" cause or
   a near-miss). At the budget, DON'T reflexively ask the human — decide by the residual:
     • CONVERGING + minor + in-scope + not prod-facing-uncertain (the findings are shrinking
       round-over-round, no new issue class, e.g. a limit-cap tweak / immutable-copy / a
       test-strengthening): grant YOURSELF ONE scoped extension, fix exactly those items,
       re-run G1+G2, and proceed. This is autonomy, not thrashing — no human needed.
     • THRASHING or an over-reaching fix that regressed a front-accepted design → STOP
       patching and take the clear move YOURSELF: revert to the known-good (front-accepted)
       behaviour, keep any clean in-scope sub-fix, and defer the genuinely out-of-scope
       findings (DoS/hardening/idempotency the plan didn't ask for) as follow-ups. If the
       branch is truly hopeless → HELD, skip-with-dependents. Escalate to the human ONLY if
       the decision itself is genuinely unclear (no obvious right move) — not just because a
       trip-wire fired. A fired trip-wire means DECIDE, not necessarily ASK.
   TRIP-WIRES (hard stop regardless of budget count): a fix that opens a NEW issue class, or
   "fix caused the next failure" → hold + escalate immediately; no patch-on-patch. The fixer
   never touches main and never force-pushes anything but its own branch (--force-with-lease).

 VERIFY, DON'T TRUST (throughout): rebase-clean = git status porcelain empty + no rebase in
   progress; CI = gh pr checks on the rebased head SHA; review = raw result <job-id> read by
   YOU; migration applied = a LIVE prod query (never the file); merged = git log. A pane
   saying "rebased/green/merged" is worth what "I pushed" is worth: nothing until checked.

 TERMINATION: per-branch deadline (default 90 min through jig+install) → held,
   skip-with-dependents. The train ends when every branch is installed/held/skipped. Report
   the three sets (installed + merge SHA + prod-test; held + reason; skipped-blocked + which
   held branch blocked them). A partial train is a DESIGNED outcome — never idle on a held branch.

═══════════════════════════════════════════════════════════════════════════
BROWSER-DRIVING RULE (front switch-on tests, jig B4, jig B5 functional test, back-gate D4):
drive a REAL browser via Playwright (MCP if wired, else `npx playwright` — `npx playwright
install` first). A code-only / HTTP-only / "reasoning through the UI" pass is a FAILED step,
not a pass. For a headless/API-only project with no UI, "browser-driving" means driving the
HTTP surface through a real client with end-to-end assertions on full flows (create→read→
verify, error paths) — still NOT a single curl smoke. Log
in at the privilege the surface needs (on «staging» you MAY use a platform-admin; PROD
step D4 stays READ-ONLY, non-admin, no writes). Never change gating/roles to make a test pass.

WATCHER HYGIENE: check-before-wait; poll-first not sleep-first; a watcher firing is a
prompt to ACT, never a reason to idle. Bound all waiting (per squadron-v2 deadlines).
⛔ NEVER detach a long wait and END YOUR TURN. Do NOT background a `herdr agent wait …
--timeout <huge>` (or an equivalent bash `until` loop) and then stop — that drops YOU to
idle and the whole run stalls while a watched pane sits finished (this is the #1 stall).
YOU are the active driver: wait IN-TURN in short BOUNDED polls (e.g. `herdr agent wait
<pane> --until idle --timeout 30000` in a loop, checking status each pass), and the instant
a pane goes idle/done, ACT on it — read its result, record the ledger, CLOSE the pane, move
on. If you ever find yourself idle with a background watcher still running, that is a BUG:
resume and drive. And to hand text to any agent pane, ALWAYS use `herdr agent prompt <pane>
"<text>"` (it submits) — never leave text via `send-text` without submitting, or it sits
staged in the input and the agent does nothing.

STOP-AND-ASK — THE TEST IS "DO I HAVE A CLEAR RECOMMENDATION?", not "is it prod-facing?".
If you can articulate a clear, defensible next action — a root-cause fix, a revert-to-known-
good (e.g. back to a front-accepted design your jig fix over-reached and broke), deferring
genuinely out-of-scope findings as follow-ups, or holding a hopeless branch — then TAKE IT
autonomously and record it. Do NOT stop to have the human rubber-stamp an obvious call. Even
at a spent FIXER budget or a trip-wire, if the right move is clear (usually: stop patching →
revert to known-good + defer out-of-scope), just do it.
ESCALATE TO THE HUMAN ONLY WHEN you genuinely LACK a clear best answer — a real tradeoff with
no obvious right call, where reasonable options diverge on something you can't resolve from
the plan's intent — OR: a merge/migration gate you cannot satisfy with certainty (a real prod-
safety doubt), an OPEN planf3 decision, or a PHASE-SPECIFIC NOTE that says stop. That's the
whole list. EVERYTHING ELSE — a gate finding a defect, a missing method/route/seed, a wrong
collision edge, drift, a conflict, a budget hit with an obvious resolution — you decide and
KEEP GOING. Never confuse "run every gate" (mandatory) with "stop on every finding" (wrong),
and never confuse "a legitimate trip-wire fired" with "I must ask" (wrong — a trip-wire means
DECIDE, and only escalate if the decision itself is genuinely unclear). The fleet lands the
plan with as little human input as possible.

PHASE-SPECIFIC NOTES (override the generic loop): «per Step 1.8, or 'none'.»

────────────────────────────────────────────────────────────────────────────
DELEGATION BLOCKS (each group agent gets its phase's block; see squadron-v2 step 4 brief)
── P1 · «title» · «milestone» «flags» ──
  Tasks: «every bullet verbatim»
  Relevant files: «files attributed to P1»
  Exit when: «🔁 condition»
  Must pass: «test commands»
── P2 · … ── «repeat for every phase» ──
────────────────────────────────────────────────────────────────────────────
```

## Notes

- Keep the jig and both back-gates verbatim across every prompt. A plan with `migrations=NONE`
  simply never triggers the migration steps; a pure-chain plan collapses the waves to
  sequential (= MK V1) with no wasted isolation.
- **Portability is the whole point:** every repo-specific value comes from Step 2 detection.
  If you ever find yourself typing a value you know only because of *this* conversation's
  repo (a DB id, a dev-command name, a failure-mode list), it belongs in Step 2's detection,
  not in this skill.
- The emitted prompt is FULL-AUTO. Before a first real run on any repo, the honest
  validation is a **dry-run on staging** proving the jig catches drift — do not point a
  never-validated jig at a live customer.
- Convert relative dates to absolute before embedding them.

## Related
- Front-half: `/squadron-v2` (waves, isolation, Codex gates, round budget — ported cmux→herdr).
- Back-half + generator scaffolding: `/magic-kingdom` (v1) — sequential full-auto-to-prod.
- Consumes: `planf3` output. Reviews: `/kevin-pr-review`, `codex:codex-rescue`.
- Isolation recipe: `qa-fleet`. The jig has no sibling — it is inlined here.
