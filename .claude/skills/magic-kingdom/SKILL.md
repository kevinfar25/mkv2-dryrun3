---
name: magic-kingdom
description: Generate a tailored SUPERVISOR/orchestrator prompt from a planf3 spec HTML file, so a herdr supervisor pane can drive the plan phase-by-phase (build → test → review → PR → CI → PR-review-to-4/5 → safe auto-merge → safe migration apply) without you re-authoring the orchestration each time. Invoke with a spec path, e.g. "/magic-kingdom specs/my-feature.html". This is a META skill — it EMITS a prompt for a future orchestrator; it does NOT itself build, test, merge, or open panes.
---

# Magic Kingdom — orchestrator-prompt generator (meta skill)

Given a planf3-style spec/plan HTML, produce a ready-to-paste, **self-contained**
supervisor prompt that drives the plan one phase at a time through a fixed,
safety-gated pipeline — and write it to a file.

You are generating a prompt. **Do NOT execute the plan, open panes, run tests,
merge, or apply migrations.** Your only outputs are the written prompt file and a
short extraction summary.

## Inputs

- `args` = path to the spec/plan HTML. If missing, ask for it. Resolve it to an
  **absolute path** (panes rooted elsewhere won't find a relative one).

## Step 1 — Read the plan and extract (be exhaustive — this drives self-containment)

Read the WHOLE spec file. Do not skim. For each phase, capture verbatim:

1. **Absolute plan path**, and the plan **slug** (basename without extension).
2. **Every phase** — id + title + milestone tag + its **full task bullets**, its
   **"🔁 Do not exit until…" exit condition**, and any **Testing-Strategy commands**
   (e.g. `npx tsc --noEmit`, `npm run lint`, `npm run build`). Preserve order.
3. **Per-phase Relevant Files** — walk the "Relevant Files" / "New Files" / "Existing
   — remove/consolidate" sections and attribute each file to the phase(s) that
   reference it (phases are usually tagged like `(P4)`, `P2`, etc.). These get
   inlined into that phase's delegation block so the build pane starts grounded.
4. **Milestones** (M1/M2/M3) and per-phase due dates — convert relative dates to
   absolute.
5. **Migration-touching phases** — any phase that adds/edits `supabase/migrations/**`
   (look for `<ts>_*.sql` in New Files, or "migration", scorer/engine/RLS/grants/
   schema wording). Flag ⚠migration → migration gate.
   - **Latent-schema phases** — if a phase persists config/settings/thresholds/state
     (e.g. "store as season settings", "save the numbers", a new toggle/field) but
     lists NO new `.sql` file, flag it `⚠migration-if-schema` (NOT ⚠migration). Add
     this delegation note verbatim: "Confirm against the LIVE schema whether a new
     column/table is needed. If the branch diff adds anything under
     `supabase/migrations/**`, route this phase through the Migration Safety Gate;
     if it adds no SQL, merge as a normal code phase." This arms the gate on the
     actual diff instead of guessing, and stops an undeclared column from reaching
     prod ungated.
6. **Destructive/removal phases** — phases that delete files/routes, drop tables, or
   revoke grants. Flag ⚠destructive → higher-risk merge gate.
7. **Unresolved decisions** — anything in "Decisions Required" / "Questionables" NOT
   marked `[resolved…]`. List them; the supervisor stops rather than guess. If ALL
   are resolved, say so explicitly in the prompt so the supervisor never re-asks.
8. **Phase-specific control-flow nuances** stated in the spec — e.g. "mark [f] and
   continue if X unconfirmed", or a phase gated to a later milestone / human sign-off.
   Capture these into a PHASE-SPECIFIC NOTES block; they override the generic loop.
9. **Where the plan lives** — a `.claude/worktrees/<name>/…` path ⇒ worktree-rooted
   (triggers the Codex caveat).
10. **Status marker convention** (usually `[] [wip] [x] [f]`).

## Step 2 — Detect repo-specific safety facts (read CLAUDE.md + project memory)

These make the "safe to do so" judgment real instead of vibes. Fold in whatever
applies (skip silently if absent), and use the CONCRETE values, not placeholders:

- Does merging `main` deploy to prod with no staging gate?
- Do migrations deploy **separately** from code? (→ expand/contract required.)
- Staging DB id to dry-run migrations against, and how the supervisor reaches prod
  to apply them (e.g. Doppler config + psql path).
- **Exact required CI check names** (so the supervisor verifies the right ones).
- Any "Codex can't run in a git worktree" constraint (→ Codex steps from main checkout).
- Grant/RLS conventions for new tables (RLS ≠ table grants).
- Known already-collided migration prefixes to avoid reusing.
- Any spec-stated migration discipline (e.g. "every DROP is staged as a later
  contract migration") — quote it into the migration gate.

## Step 3 — Emit the prompt (and WRITE IT TO A FILE)

Fill the TEMPLATE. Replace every `«…»` with concrete values — **leave no placeholder
in the output.** Keep the safety gates **exactly** as written. Append one DELEGATION
BLOCK per phase (Step 1.2/1.3) so the prompt is self-contained — the supervisor
pastes a phase's block into `/goal` without re-reading the plan.

**Write the finished prompt to `specs/<slug>-supervisor-prompt.md`** (Markdown: a
short header noting source + generation date, then the prompt in one fenced block).
Then print the Step 4 completeness check + a 3–5 line summary to the user.

## Step 4 — Completeness self-check (aim for 100%) — verify BEFORE finishing

Re-read your emitted prompt against the plan and confirm every item; fix and
re-write the file if any fails. Report the checklist with pass/fail:

- [ ] Every phase in the plan appears, in order, with a delegation block.
- [ ] Each delegation block has: title, ALL task bullets, Relevant Files, the exit
      condition, and the phase's test commands.
- [ ] Every migration-touching phase is ⚠migration-flagged; every destructive phase
      ⚠destructive-flagged. Nothing mis- or un-flagged.
- [ ] All spec decisions accounted for (resolved → "do not re-ask"; unresolved →
      listed as STOP triggers).
- [ ] Every phase-specific nuance (Step 1.8) is in PHASE-SPECIFIC NOTES.
- [ ] No `«placeholder»` remains; CI check names, staging id, prod-access method,
      worktree path, and main-checkout path are all concrete.
- [ ] The two safety gates are present verbatim.

---

### TEMPLATE

```
ROLE: You are the SUPERVISOR. You do NOT write code, run tests, edit files, or
open PRs yourself. You open herdr panes, delegate ONE phase at a time via /goal,
actively VERIFY each gate (never trust a pane's self-report), update the plan's
status markers, and only then move to the next phase.

PLAN: «absolute plan path»
PHASES (execute strictly in order, top to bottom): «P1..Pn titles, each with its
milestone tag and any ⚠migration / ⚠destructive flag»
MILESTONES: «M1 … due <abs date> · M2 … due <abs date> · M3 …»
You are the SOLE writer of the plan's «[] [wip] [x] [f]» markers: [wip] on start,
[x] only after the phase passes its pre-merge PREVIEW test (step 7), is merged +
deployed, AND passes its POST-DEPLOY PRODUCTION TEST (step 10), [f] with a one-line
reason on hard failure.

«IF worktree-rooted:»
ROOTING: The plan lives in worktree «path». Build/test panes run there on a
per-phase branch. But /kevin-pr-review and codex:rescue drive Codex, which FAILS
inside a git worktree — launch those two steps from the MAIN checkout
(«main checkout path») against the PR number, not from the worktree.

PER-PHASE LOOP — one NEW herdr pane to the right per phase, launched with
--dangerously-skip-permissions:

PANE HYGIENE (applies throughout the loop):
- ALWAYS LAUNCH CLAUDE WITH `--dangerously-skip-permissions`. EVERY pane you spawn —
  the per-phase build/test pane AND any main-checkout review pane (kevin-review,
  codex:rescue, etc.) — must start Claude as `claude --dangerously-skip-permissions`,
  never bare `claude`. A pane launched in default (manual) permission mode will stall
  the moment the agent hits its first tool call, silently blocking autonomous
  progress. If you catch a pane sitting in "manual mode on" / prompting for approval,
  it was mis-launched: `/quit` it, relaunch with `--dangerously-skip-permissions`, and
  re-send the delegation (re-prefixing `/goal` on build panes). Verify the status line
  reads `⏵⏵ bypass permissions on` before delegating.
- RENAME THE PANE AT EVERY STAGE TRANSITION so its label always reflects the
  current phase + stage, not a stale one. Use `herdr pane rename <pane_id>
  "P<N>-<stage>"` as you move through: `P<N>-build` → `P<N>-test` →
  `P<N>-diff-review` → `P<N>-pr` → `P<N>-ci` → `P<N>-kevin-review` →
  `P<N>-preview-test` → `P<N>-prod-test`. A pane still labelled `-build` while it's
  testing is a bug in your bookkeeping — fix it as you go.
- GHOST TEXT IS NOT INPUT. Unsent text shown in a pane's input line (e.g. a greyed
  `open a PR for phase 1`) is Claude Code's AUTOSUGGEST, not queued input — it is
  NEVER submitted unless someone presses Tab to accept it. Do not treat it as a
  real pending instruction, do not try to "clear" it, and do not let it change your
  step order. `/clear` and `herdr pane run` submit their own text cleanly
  regardless of any ghost suggestion in the box.
- PANE LIFECYCLE — CLOSE ON [x]. The moment you mark a phase [x] (step 11: merged +
  prod-verified), CLOSE that phase's panes (its `P<N>-*` worktree build pane AND its
  main-checkout review/test pane) with `herdr pane close <pane_id>`, THEN open the
  next phase's fresh pane. Steady state = the supervisor pane + only the ACTIVE
  phase's pane(s); panes must not accumulate across phases. EXCEPTION: on a phase
  [f] or any stop-and-ask, LEAVE the panes open so the failure can be inspected —
  never destroy evidence of a failure. Only ever close panes YOU created; never the
  supervisor pane and never a pane you didn't open.
- BROWSER-DRIVING STEPS MUST ACTUALLY DRIVE A BROWSER WITH PLAYWRIGHT. Every step
  that verifies behaviour ON A REAL SCREEN — the on-screen half of step 2, the
  step-7 preview test, and the step-10 production test — MUST be performed by
  driving the running app in a real browser via Playwright. Use the Playwright MCP
  server if it is wired; if it is NOT available, FALL BACK TO THE PLAYWRIGHT CLI
  (`npx playwright`, running `npx playwright install` first if the browsers aren't
  present) — the absence of the MCP is NOT an excuse to skip browser driving. These
  steps CANNOT be satisfied by a static code review, a diff read, a `curl`/HTTP
  status check, or "reasoning through" the UI — a code-only or HTTP-only pass is a
  FAILED step, not a pass. Actually log in, navigate, click, and observe the
  rendered result + console/network. Put this requirement VERBATIM in every
  browser-driving delegation prompt. If Playwright genuinely cannot be made to run
  at all, STOP and ping the human — never mark a screen-verification step passed
  without a real browser run.
- FUNCTIONAL TESTS MUST LOG IN AT THE RIGHT PRIVILEGE, ADD THE DATA, AND SEE IT
  RENDER. The step-7 functional test is not a read-only glance — it must actually
  exercise the feature: log in as an account that CAN REACH the surface under test
  (create the competition / enter the data / trigger the flow through the real UI),
  then confirm the result actually shows up (leaderboard, list row, badge, payout,
  etc.). This runs on STAGING, where there is NO live customer, so you may and SHOULD
  use whatever privilege the surface demands — INCLUDING a staging platform-admin
  (e.g. `superadmin@staging-seed…`, pw `StagingSeed1!`) for platform-admin-gated
  routes like `/admin/contests`. Do NOT work around a gate with raw SQL when the
  point is to prove the UI flow — drive the actual form as the account that can open
  it. Never change gating, roles, or the account model to make a test pass — pick the
  right existing account instead. PROD (step 10) stays STRICTLY READ-ONLY on the
  live-customer DB (TEST-tenant QA `company_admin` only, never platform-admin,
  never writes) — so any write/admin flow a company_admin cannot safely reach on prod
  is verified on staging and only smoke-checked (renders / endpoint healthy) on prod.
- WATCHER HYGIENE — CHECK BEFORE YOU WAIT. When you background a poll-loop to wait
  on a pane going idle or a CI run settling, it is a fallback, NOT the step itself.
  Three rules so you never idle on an already-finished condition: (1) CHECK-BEFORE-
  WAIT — the instant you arm a watcher, do ONE immediate inline check of the same
  condition (`herdr pane get <id>` / `gh pr checks <PR>`); if it is already
  satisfied, proceed NOW and don't wait for the watcher to fire. (2) POLL-FIRST, not
  sleep-first — a watcher's loop must test the condition on its FIRST iteration
  before any `sleep`, so it returns instantly when the condition is already true at
  arm-time. (3) CI is usually already moving — the PR-opening agent typically drove
  the checks partway (Vercel/preview) before handing back, so read `gh pr checks`
  once inline and SKIP the watcher entirely when it already shows all-green. A
  watcher firing is a prompt to ACT, never a reason to sit idle while the real state
  has already moved on — if you catch yourself "standing by" on something a one-line
  check would resolve, run the check. (4) WATCH THE COMPLETE EXIT SET, not just
  "done". herdr agent_status has FIVE states — `working`, `idle`, `done`, `blocked`,
  `unknown` — and `herdr wait agent-status` only waits for ONE `--status`, so a loop
  hard-coded to idle/done will silently ignore a pane that goes `blocked` (agent is
  waiting on YOUR input) or `unknown` (pane died/crashed) and you will "sleep" on it
  forever. Only `working` means keep waiting; your poll-loop MUST exit on ANY of
  `idle|done|blocked|unknown` and REPORT WHICH, so you route right: `blocked` → read
  the pane and answer its prompt; `unknown` → inspect/relaunch the pane; `idle|done`
  → read the result. (5) STALL DETECTION — capture the pane's token count each poll;
  if it is flat for a long stretch while still `working`, the agent may be hung —
  read its screen to judge progress vs. hang rather than trusting "working"
  indefinitely. (herdr has NO native "wait for any of these statuses" or event-
  subscribe — `herdr notification` is outbound toast-only — so the poll-loop is the
  right tool; it just has to test the full exit set.)

1. DELEGATE BUILD: /goal with this phase's DELEGATION BLOCK (below). The prompt
   string you send into the build pane MUST begin with the literal token `/goal `
   as its very first characters, immediately followed by the delegation block —
   `/goal` is the internal Claude Code command that makes the spun-up agent keep
   working until the task is truly done, so a delegation sent WITHOUT the `/goal`
   prefix is a mis-delegation and must be re-sent. Branch: phase-<N>-<slug>. Give
   the pane the absolute plan path.
2. When the pane goes IDLE (idle is the signal — not a "done" message), /clear.
   Re-seed: "You built <PhaseN> on branch phase-<N>-<slug>. Test it." Test =
   /qa-pipeline against this branch. qa-pipeline is the SINGLE test authority
   (do not also hand-test). qa-pipeline must NOT open a PR — /github owns that.
3. /clear, re-seed branch+phase, then: review the branch diff against <PhaseN> —
   confirm every task bullet, the exit condition, and the phase's test commands
   pass. Note gaps; unsatisfied tasks block the phase.
   IN-SCOPE COMPLETION CALL: when the review surfaces a NON-BLOCKING observation
   (e.g. dead/orphaned code left behind, a half-updated reference, a residual the
   phase's own change created), FOLD THE FIX INTO THIS SAME PHASE before the PR —
   do NOT ship it as a known-leftover and do NOT escalate — but ONLY when all three
   hold: (a) it is squarely within THIS phase's stated intent/theme (finishing the
   job the phase set out to do, not new feature work), (b) it is low-risk and
   mechanically verifiable — tsc/lint/tests would catch a mistake (dead-code
   removal, a rename's stragglers, a copy tweak), and (c) it makes the phase's
   exit condition MORE fully met. If it fails any of the three — cross-cutting,
   risky, genuinely another phase's work, or needs a decision — DEFER it: note it
   for the owning phase / a follow-up and leave it, don't absorb it. Delegate the
   fold-in to the same pane (a small /goal cleanup), re-run the phase's gates, then
   continue. Bias: complete the phase cleanly; resist scope creep.
4. /clear, then /github to push the branch and open exactly ONE PR. Record PR#.
5. VERIFY CI YOURSELF: `gh pr checks <PR#>` until all required checks
   («check names») are green. Do not proceed on the pane's word.
6. /kevin-pr-review <PR#> --fix (from the main checkout if worktree-rooted). It
   caps at 3 iterations. If it reaches 4/5 or 5/5 → proceed. If still <4/5 after
   3 iterations → hand the residual findings to codex:rescue for ONE more fix
   attempt, then re-run /kevin-pr-review. If STILL <4/5 → STOP and ping the human
   with the residual findings. Never loop past this.

7. PREVIEW PRODUCTION TEST — before merging, exercise the phase on its REAL Vercel
   preview deployment, not just locally. After /kevin-pr-review has settled any
   fixes and CI is green on the FINAL commit, get the PR's Vercel preview URL
   (`gh pr view <PR#>` / the deployment status check) and run
   /testing:general:test-review-general against that PREVIEW URL. This closes the
   gap where a non-risky phase otherwise first runs on a real deploy only in
   production: step 2's /qa-pipeline is local, and /kevin-pr-review only drives the
   preview on RISKY PRs. Test the exact commit that will merge. A failure here
   BLOCKS the merge — fix on-branch (which redeploys the preview) and re-run until
   it passes.

8. MERGE GATE — auto-merge only if ALL are true (else self-resolve or escalate):
   - `gh pr checks <PR#>` all green (verified).
   - /kevin-pr-review verdict >= 4/5.
   - The step-7 preview production test passed on the final commit.
   - Every task for <PhaseN> is satisfied (you checked, step 3).
   - No "Decisions Required" for this phase is unresolved. «resolved-state note»
   - UNIVERSAL SQL CHECK (do this for EVERY phase, regardless of flags): run
     `git diff --name-only <base>...HEAD -- 'supabase/migrations/**'` on the branch.
     If it lists ANY file, the MIGRATION SAFETY GATE below MUST pass before merge —
     even on a phase carrying no ⚠ flag. Ground truth is the diff, not the flag;
     the ⚠migration / ⚠migration-if-schema flags are only advance hints about which
     phases are likely to trip this. A phase with no SQL in its diff merges normally.
   All true → /merge-into-main, then confirm the merge commit landed on main.

9. MIGRATION SAFETY GATE — the supervisor MAY apply the SQL to prod itself only if
   ALL true; if uncertain on ANY point, do NOT apply, do NOT merge, ping the human
   with specifics:
   - Expand-only: CREATE {TABLE,COLUMN,FUNCTION,INDEX CONCURRENTLY,POLICY} or ADD
     COLUMN with a safe default. NO DROP/RENAME/type-narrowing/destructive
     DML/TRUNCATE on live objects. «spec migration-discipline quote, if any»
   - Expand/contract holds: new code runs on the OLD schema AND old code runs on
     the NEW schema (code and SQL deploy separately).
   - Dry-run applied + verified green on staging «staging DB» FIRST.
   - Prod objects the migration assumes exist actually exist — checked LIVE via
     «prod DB access». Prod schema has drifted; never infer from migration history.
   - New tables: REVOKE ALL from anon/authenticated, then GRANT minimal; RLS
     policies are TO authenticated and tenant-scoped (RLS ≠ table grants).
   - Unique version prefix (no collision with existing YYYYMMDD prefixes«; known
     collided baselines to avoid: …»).
   - APPLY ORDER: expand migrations applied to prod BEFORE the code merge; pure
     cleanup/contract migrations deferred to after.
   All true → supervisor applies via «prod DB access», verifies with a live query,
   then merges code.

10. POST-DEPLOY PRODUCTION TEST — a merge to main IS a prod deploy, so verify the
    phase LIVE ON PRODUCTION, not just on the branch or preview. Once the merge
    commit is on main (and any expand migration from step 9 is applied +
    live-verified), run /testing:general:test-review-general to exercise THIS
    phase's changes against production. This is distinct from step 2's pre-merge
    /qa-pipeline (local branch) and step 7's preview test (pre-merge deploy): step
    10 confirms the deployed product actually works for the live customer. If it
    surfaces a regression, treat it as a hotfix through this same loop on a new
    branch before continuing — never leave prod red or mark the phase done on a
    broken deploy.
11. Mark <PhaseN> [x] (only after step 10 passes) — or [f] + reason — in the plan.
    On [x]: CLOSE this phase's panes (`herdr pane close <pane_id>` for its worktree
    build pane and its main-checkout review/test pane) per the PANE LIFECYCLE rule,
    then open the next phase's fresh pane and repeat from step 1. On [f]: leave the
    panes open for inspection.

PHASE-SPECIFIC NOTES (override the generic loop):
«per Step 1.8 — e.g. "P7: if advancement math unconfirmed, mark that sub-task [f]
and CONTINUE, don't escalate." · "P10 is M3/post-QA/gated: STOP after P9 and ping
the human before starting it."  Omit this block if there are none.»

STOP-AND-ASK ONLY WHEN: a merge or migration gate can't be satisfied safely and you
can't self-resolve it; /kevin-pr-review is still <4/5 after codex:rescue; CI stays
red after the fix loop; you hit a PHASE-SPECIFIC NOTE that says stop; or a phase hits
an UNRESOLVED decision («list them, or "none remain in this plan"»). Otherwise solve
it yourself and keep going.

NEVER assert a gate passed without checking it: CI via `gh`, review score via the
review output, merge via `git log`, migration via a live query. A pane reporting
success is not proof it happened.

────────────────────────────────────────────────────────────────────────────
DELEGATION BLOCKS (send the matching one to the build pane as `/goal <block>` —
the prompt's first characters must literally be `/goal ` per step 1)

── P1 · «title» · «milestone» «flags» ──
Tasks:
  «every task bullet, verbatim»
Relevant files: «files attributed to P1»
Exit when: «🔁 condition»
Must pass: «test commands»

── P2 · … ──
  «…repeat for every phase…»
────────────────────────────────────────────────────────────────────────────
```

## Notes

- Keep the two safety gates verbatim across every prompt you generate — a plan with
  no migrations simply never triggers gate 8.
- If the plan has independent phases within a milestone and the human wants speed,
  mention that `/squadron-v2 <plan>` fans the same build→review→one-PR flow out in
  parallel (it never merges) — but the default this skill emits is pure sequential.
- Convert any relative dates in the plan to absolute before embedding them.
