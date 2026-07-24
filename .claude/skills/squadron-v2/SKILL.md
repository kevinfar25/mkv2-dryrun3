---
name: squadron-v2
description: >-
  Squadron v2 — take an unimplemented planf3 HTML plan and fly it from scratch to
  review-ready PRs with a parallel fleet of isolated agents (one git worktree +
  cmux window + Docker DB per phase), with the OpenAI Codex plugin wired in as
  four explicit gates: the plan is challenged before wave 1, every branch gets a
  defect review then a Goose-tuned adversarial design review, hard fixes are
  handed to codex rescue instead of spiralling, and the ORCHESTRATOR reads the raw
  Codex verdict itself rather than trusting an agent's self-report. Bounded
  cap-and-fix, one PR per group, never merges, never moves cards. Invoke with the
  plan path, e.g. "/squadron-v2 specs/my-feature.html".
argument-hint: "[path-to-planf3-plan.html]"
---

# Squadron v2

Flies a whole **planf3 plan** from *created-but-unimplemented* to *review-ready PRs*
using a **parallel fleet of isolated agents** — one per phase, each in its own git
worktree + cmux window + Docker DB. Instead of one agent executing phases
sequentially, it fans out one agent per phase, runs them in **dependency-ordered
waves**, has each self-verify, then puts every branch through **four Codex gates**
with a **bounded cap-and-fix** loop before opening one PR per group.

**What's new vs `/squadron` (v1):** v1 told each agent "go get a Codex review and fix
what it finds" — no command named, and the agent both ran the review and reported its
own verdict. v2 names the exact invocations, adds a **plan-level challenge before any
code is written**, splits per-branch review into a cheap **defect sweep** + a
**Goose-tuned adversarial design challenge**, routes hard fixes to **codex rescue**,
and makes the **orchestrator read the raw Codex result** (job id → structured findings)
instead of trusting the pane. See "Codex gates" below.

**Runs autonomously.** Opens a **PR per verified group** and **never merges**. The
human reviews/merges on GitHub and moves board cards. Dividing the finished PRs among
named human reviewers is a **separate follow-up skill** (`/debrief`), not squadron.

## Authorization this skill carries

Invoking squadron-v2 **is** the user's explicit, durable authorization to, within this
run only: create git worktrees, stand up local Docker DBs, create branches,
`git add`/`commit`, `git push` the **branch**, `gh pr create`, and run Codex
review/rescue jobs. It does **NOT** authorize: `gh pr merge`, pushing to `main`,
force-pushing shared branches, or moving Kanban cards (the user does those). This
scoping overrides the default "never commit/push without asking" only for the
branch+PR steps above.

## Input

One argument: the path to a **planf3-authored `.html` plan** whose phases are
**not yet implemented** (all `<code class="status">` markers are `[]`). If no path is
given, infer the most recent unimplemented plan in `specs/` and confirm before
launching. If the file isn't a planf3 plan (no `<section id="phases">` with
`<div class="phase">` blocks), stop and say so — squadron only consumes planf3 output.

---

## Codex gates (the v2 core — read this before the procedure)

### What the plugin actually exposes

| Surface | What it does | Callable how |
|---|---|---|
| `/codex:review` | Native Codex **defect** review of git state. `--base <ref>`, `--scope auto\|working-tree\|branch`. **No custom focus text.** | Slash command only (`disable-model-invocation: true`), or the companion script |
| `/codex:adversarial-review` | **Challenges the approach/design/assumptions**, not just defects. Same target selection **and accepts focus text**. The big one. | Slash command only, or the companion script |
| `codex:codex-rescue` | **Write-capable** Codex agent. Resumable (`--resume`), `--model`, `--effort`. For *fixing/diagnosing*, not reviewing. | `Agent(subagent_type: "codex:codex-rescue")` — **is** model-invocable |
| `/codex:status`, `/codex:result`, `/codex:cancel` | Background-job control. `result <job-id> --json` returns the job record; the actual verdict is **prose** at `.storedJob.result.codex.stdout` — a verdict paragraph plus `[P1]/[P2] <title> — <file>:<lines>` findings. There are NO structured verdict/findings JSON fields; the orchestrator reads the prose. | Slash command only, or the companion script |

**Two hard facts that shape everything below:**

1. **The review commands are `disable-model-invocation: true`** — an agent's *model*
   cannot call them. But squadron's fleet agents are **real `claude` sessions in cmux
   panes**, so the orchestrator **typing `/codex:adversarial-review …` into a pane is a
   genuine user invocation**. That is the sanctioned path for in-pane reviews.
2. **Everything sits on one script**, with per-repo/worktree job state — so the
   **orchestrator** can call it directly from each worktree and read machine-readable
   results without screen-scraping cmux:

```bash
# resolve once, at run start
CODEX=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
node "$CODEX" review            "--background --base main"   # defect sweep — see detach caveat below
node "$CODEX" adversarial-review "--background --base main --scope branch <focus>"
env -u CODEX_COMPANION_SESSION_ID node "$CODEX" status --json   # job board for THIS worktree — see filter caveat
node "$CODEX" result  <job-id>                               # verdict + findings + file:line
node "$CODEX" cancel  <job-id>
```
Run these **with the group's worktree as cwd** (or `--cwd <worktree>`) — job state is
keyed per repo checkout (`git rev-parse --show-toplevel`), so parallel groups don't collide.

**Two verified script gotchas that will silently break the orchestrator if ignored:**

1. **`--background` is a NO-OP for `review`/`adversarial-review`** — in the companion
   script only `task` (rescue) actually detaches; the review commands always run in the
   foreground regardless of the flag. In-pane dispatch is fine (the pane's Claude
   backgrounds the Bash call itself). But when the ORCHESTRATOR dispatches directly, it
   MUST use `Bash(..., run_in_background: true)` — a plain foreground call blocks for the
   whole review and gets killed at the Bash timeout ceiling, which can wedge the job as
   `running` forever.
2. **The job-board `status` listing is session-filtered.** The script filters jobs by the
   `CODEX_COMPANION_SESSION_ID` env var, which is set in EVERY Claude session — the
   orchestrator's included — and `--all` does NOT bypass the filter. A job dispatched
   in-pane belongs to the *pane's* session, so the orchestrator's plain `status --json`
   shows an **empty board** for exactly the jobs it needs. Two working paths: strip the
   var (`env -u CODEX_COMPANION_SESSION_ID node "$CODEX" status --json`), and/or require
   the pane to echo the job id from the launch message (`started in the background as
   <job-id>`) — explicit `status <job-id>` and `result <job-id>` are NOT filtered.

### The four gates

| Gate | When | What | Who runs it |
|---|---|---|---|
| **G0 — Challenge the plan** | Once, **before wave 1** | Hand the plan HTML + the relevant existing code to Codex read-only: *attack the phasing, the dependency waves, the assumptions.* There is no diff yet, so `review` does not apply — use **`codex:codex-rescue`** with an explicit **read-only, do-not-edit** instruction. | Orchestrator |
| **G1 — Defect sweep** | Per group, right after it self-verifies | `/codex:review --background --base main`. Cheap, parallel, finds the ordinary bugs. | Group agent (in-pane), orchestrator reads result |
| **G2 — Adversarial design challenge** | Per group, **after G1 findings are fixed**, so it sees the final diff | `adversarial-review --base main --scope branch <FOCUS>`. **The only surface that takes focus text** — that's why it, not `review`, carries the Goose-specific suspicions. | **Orchestrator, direct script dispatch** (multi-line focus won't survive `cmux send` — see step 6); reads result itself |
| **G3 — Rescue the hard ones** | Only when a trip-wire fires (below) | Hand **that single finding** to `codex:codex-rescue` (write-capable, `--resume` to dig deeper) instead of letting the pane patch-on-patch. | **Orchestrator** — dispatches it itself (via `Agent(subagent_type: "codex:codex-rescue")` pointed at the group's worktree, or `node "$CODEX" task --background --write …` from that worktree). Agents never dispatch Codex jobs (see the leash) |

### The G2 focus text (Goose's standing failure modes)

`adversarial-review` is the one place you can aim the reviewer. Always append the
phase's intent from the plan **plus** this repo's recurring ways of being wrong:

```
Phase intent: <one line from the plan>.
Challenge the approach, not just the code. Be specifically suspicious of:
- multi-tenant leakage: any query missing an organizationId scope; any route trusting a
  caller-supplied userId/repId/orgId instead of deriving it from getCurrentUser()
- authz: role checks missing or done client-side only; rep able to read another rep's data
- unauthenticated endpoints (this repo has shipped some: geofence/check, recording auto-start)
- timezone: raw `new Date()` where company-scoped logic requires getCompanyNow(organizationId)
- N+1 / in-JS aggregation on manager, leaderboard, or call-detail paths
- three-tier AI prompt inheritance bypassed (org+role → org → system default)
- Socket.IO assumed to work under serverless; AI routes missing maxDuration
- notification created without the createNotification() preference check
- external writes (ServiceTitan write-back, Resend email) firing where they shouldn't
```

### Orchestrator verifies the review — do NOT trust the pane

v1's blind spot: the agent ran the review, decided what it meant, and reported "clean."
Same rule you already apply to `git push` applies here.

- Every gate dispatch must capture the **job id**: for in-pane dispatch, the brief
  requires the pane to echo the launch line (`started in the background as <job-id>`)
  verbatim; the orchestrator also cross-checks with the **unfiltered** board
  (`env -u CODEX_COMPANION_SESSION_ID node "$CODEX" status --json` in that worktree —
  the plain filtered form will NOT show pane-dispatched jobs).
- The orchestrator then reads `node "$CODEX" result <job-id> --json` **itself** (job-id
  forms are not session-filtered). Parse path: `.storedJob.result.codex.stdout` — a prose
  verdict plus `[P1]/[P2] <title> — <file>:<line-range>` findings (verified live; there
  are no structured verdict/findings JSON fields).
- **Per-job wall-clock timeout: 30 minutes.** If a job is still `queued`/`running` past
  it, `cancel` it — that gate **burns its round** as an errored job (step 6a). A job
  wedged as `running` (e.g. its worker died) must never be waited on indefinitely.
- The **orchestrator** — not the agent — decides ship / cap / defer from the raw verdict.
- Those structured findings (verdict, summary, file:line) are what get written into the
  plan HTML amendment (step 9) — not prose the agent typed.
- Add a **`codex` column** to the wave tracking table: `running / clean / N findings`,
  sourced from `status --json` rather than inferred from screen output.

### Do NOT enable the stop-time review gate

`/codex:setup --enable-review-gate` installs a `Stop` hook that reviews on **every**
agent stop (900s timeout), not just the final one. In a fleet that would block
mid-implementation pauses on full reviews, wreck wave timing, and make a busy agent look
**flat/hung** to the liveness detector in step 5. Keep it **off**; trigger the gates
deliberately.

---

## Procedure

### 0. G0 — challenge the plan before anyone builds
Before standing up a single worktree, hand the plan to Codex **read-only** via
`Agent(subagent_type: "codex:codex-rescue")`: give it the plan path, the Relevant Files,
and ask it to attack the **phasing, dependency waves, and assumptions** — explicitly
*"review only; do not edit any files."* If it lands a real objection (a phase depends on
one that runs later, a shared file is touched by two parallel phases, the approach is
wrong), **stop and take it to the user** before launching. One review here beats
discovering it after eight agents have built on the flaw. Record the outcome — it goes in
the final report either way.

Rescue is a **write-capable** agent and "review only" is a prompt-level leash, not an
enforced one — so after G0 returns, verify `git status --porcelain` in the main checkout
is as clean as before it ran. If G0 edited anything, revert it before proceeding.

**G0 budget: ONE job. No re-review loop.** G0 is advisory input to a human decision, not a
fix→re-review cycle — it must never become one. Codex critiques the plan **once**; the
orchestrator surfaces the objections to the **user**, who decides. Do **not** revise the
plan and re-submit it to Codex for another opinion (that is an unbounded loop with no
diff to converge on). If the plan changes materially, that is a **new squadron run** the
human starts. G0 does not draw from any group's round budget, and no group's budget may be
spent before wave 1 launches.

### 1. Parse the plan (tied to the planf3 template)
Read the full plan (metadata header, back references depth 1, Relevant Files, every
`<div class="phase">`). Extract, per phase:
- phase number + name (from `<h3>… Phase N: Name</h3>`),
- the tasks (`<h4>` + `<ul class="checklist">` actions) and the **Testing Strategy** block,
- the phase's **dependencies** — see step 2.

**Check `<section id="decisions">` (planf3's Decisions Required block).** Any decision
still `[open]` blocks the phases named in its `data-blocks` — those groups do NOT
launch; list them as blocked in the confirmation below and let the user resolve the
decision on the spot or confirm the reduced fleet. Older plans without that section:
scan phase bodies for "DECISION NEEDED"/"blocking" language and treat matches the same
way. Never launch a group whose phase hinges on an unanswered product call.

**Each `.phase` = one group = one agent.** Fleet size = number of phases (read from the
plan; do not accept an override flag). Confirm the parsed phase list + wave plan (+ any
G0 objections + any decision-blocked phases) with the user before standing anything up.

### 2. Build the dependency waves — DO NOT blindly parallelize
planf3 phases are authored to run **top-to-bottom because later phases often depend on
earlier ones**. Squadron must respect that:
- Look for an explicit dependency hint per phase (e.g. a `data-deps="1,2"` attribute, a
  "Depends on: Phase N" line, or prose naming a prior phase/file it builds on). If the
  plan states none, treat a phase as depending on all phases that **create or heavily
  modify files it also touches** (infer from the Relevant Files + task text).
- Topologically sort into **waves**: a wave is the set of phases whose dependencies are
  all already complete. Run **all phases in a wave in parallel**; start the next wave
  only when the current wave's groups have landed (verified + pushed).
- If the dependency graph is ambiguous, present your proposed wave grouping and let the
  user correct it before launch. When truly unsure, prefer a smaller wave (more
  sequential) over risking a cross-phase collision. **G0's objections outrank your own
  inference** — if Codex says two phases collide, don't put them in the same wave.
- **If a group FAILS (verification failed, capped out, or timed out), its dependents do
  not run.** Mark every phase that depends on it `blocked`, skip them in later waves,
  keep flying the independent phases, and report the blocked set in the final report.
  A failed group must never deadlock the run — "wait until every group lands" applies
  only to groups still eligible to land.

### 3. Stand up isolation per group — worktree + Docker DB + window
For **every phase in the current wave**, before launching its agent:
- **Git worktree:** `git fetch -q origin` once at run start, then
  `git worktree add .claude/worktrees/sq-p<N> -b sq/<plan-slug>-p<N> origin/main`
  (branch off **fresh `origin/main`**, not local `main` — a stale local main gives every
  PR an unrelated diff tail). Each group gets its own checkout + branch + `reports/`.
- **Isolated Docker DB (mandatory — from-scratch agents run migrations/writes):** give
  each group its **own** DB so parallel migrations/writes never collide. Use the
  `qa-fleet` Docker many-DBs recipe (see `reference_local_docker_qa_env` memory): one
  pg17 container hosting N prod-copy DBs (or N restored Supabase projects), one per
  group, each on its own port. Write a per-worktree `.env.local` (worktrees do NOT
  inherit it) that **replaces** (not appends — dotenv is first-wins) all four data vars
  to point at that group's DB: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Neutralize
  `SERVICETITAN_APP_KEY` + `RESEND_API_KEY`. Give each group a distinct `PORT`
  (e.g. 3021, 3022, …) and make `playwright.config.ts` read `process.env.PORT` — if that
  requires editing the config, the edit stays **uncommitted** in the worktree (it must
  never appear in the group's PR).
- **⚠️ SECRET-MANAGER OVERRIDE — the `.env.local` sandbox is a LIE if the dev command
  injects prod secrets.** In repos wired to a secret manager (Doppler, Infisical, `direnv`,
  Vault, `dotenv-vault`, etc.), the normal dev/build/migrate scripts are wrapped (e.g.
  `doppler run -- next dev`) so the manager injects `DATABASE_URL` into the process env
  **before** Next.js reads `.env.local` — and Next.js does **not** override an already-set
  env var. Net effect: `npm run dev` silently connects to **production**, overriding the
  per-worktree `.env.local` you just wrote, and every write-action the agent performs
  during "local" verification lands in the **prod DB**. This is not hypothetical — it
  happened (XP grants, practice sessions, achievement unlocks leaked to prod test accounts
  on a real run). Before launching any group you MUST: (a) detect whether dev/build/migrate
  are secret-manager-wrapped (grep `package.json` scripts for `doppler run`, `infisical
  run`, etc.); (b) give each brief the **non-injecting** dev command (in this repo:
  `npm run dev:nodoppler`, or `PORT=<port> next dev` directly) so `.env.local` wins; and
  (c) make each agent **prove the running server is on its local DB before any write** (see
  step 4). Never let a group verify with the wrapped `npm run dev`.
- **cmux window:** `cmux new-workspace --name "SQ P<N> · <phase>" --cwd <worktree>
  --command 'claude --dangerously-skip-permissions "<pointer to the brief>"' --focus false
  --id-format both`. Record the returned `workspace:N` as the group's tracking id.

### 4. Write ONE brief per group
Derive each agent's brief from its phase: the phase description, the exact task
checklist, the Testing Strategy, the phase's slice of Relevant Files, its DB/port, its
branch, and its acceptance criteria. Include:
- "Implement THIS phase only, following planf3 conventions."
- The verification ORDER, explicitly — the agent cannot push, so preview comes later:
  **local verify → emit `SQ-VERIFIED P<N>:` and WAIT → Codex gates (orchestrator-driven)
  → orchestrator authorizes the push (step 7) → confirm on the Vercel preview → emit
  `SQ-DONE P<N>:`.** Never write "push and confirm on preview" as part of local
  verification — the preview does not exist until the orchestrator-authorized push.
  Start the dev server with the **non-secret-manager-wrapped** command
  (`npm run dev:nodoppler` / `PORT=<port> next dev` — NOT `npm run dev` if that is
  Doppler/Infisical-wrapped; see step 3). Include an explicit **DB-sentinel gate**: before
  performing ANY write-action (grant, create, toggle, complete), the agent must confirm the
  live server is talking to its OWN local DB — e.g. hit a debug/health route or run a
  one-row query and check the host/db-name is the group's Docker DB, not the prod pooler.
  If it can't prove local, it STOPS and reports — it must never write against an unverified
  DB. All destructive/write verification runs only after this gate passes."
- The bounded-autonomy contract (step 6) verbatim.
- "**Do not invent your own review.** When you have self-verified, emit `SQ-VERIFIED P<N>:`
  and WAIT — the orchestrator drives the Codex gates. Do not push or open a PR."
- "When the orchestrator has you run a `/codex:*` command, **echo the launch line
  verbatim** (`… started in the background as <job-id> …`) — the orchestrator needs that
  job id; its own job-board listing cannot see your session's jobs."
- A machine-greppable close tag: `SQ-DONE P<N>:` (emitted only after the preview check,
  per the order above).
Briefs live in the orchestrator's scratchpad (never committed).

### 5. Launch + supervise the wave
Launch every group in the wave (step 3). Then **actively supervise** (not just a
filesystem watcher):
- Poll each window (`cmux read-screen`) on a cadence; roll status into a tracking table
  (group, phase, PR, `workspace:N`, **codex**, status). Use scheduled wake-ups, not
  blocking sleeps.
- **Liveness/stuck detection:** if a window's tokens/output are flat for ~10 minutes,
  read its screen to judge progress vs. hang; intervene rather than wait indefinitely.
  A pane sitting at a prompt **waiting for input** (a question, a confirmation) is a
  stuck state too — answer it or fail the group; it will wait forever otherwise.
  A pane waiting on a *backgrounded* Codex job is legitimately quiet **only while the
  orchestrator can see that specific job `queued`/`running` by job id** (unfiltered
  status — see the filter caveat) **and it is inside its 30-minute job timeout**. "It's
  probably waiting on Codex" without a verified live job id is a hang, not a wait.
- **WALL-CLOCK CEILINGS — supervision must terminate.** The Codex budget bounds review
  spend, but only deadlines bound waiting. Hard limits, counted like the gate ledger:
  - **Per stuck pane: max 2 interventions** (nudge/answer/restart). If it is still stuck
    after the second, mark the group **failed**, stop supervising it, move on.
  - **Per group: a wall-clock deadline** set at launch (default 2h from launch to
    `SQ-VERIFIED`, +1h through gates to landed; scale consciously for a big phase and
    record why). Past deadline → treat as failed, same as above.
  - **Per run: a whole-run deadline** (default 8h). Past it, cancel outstanding Codex
    jobs, report what landed / failed / was blocked, and STOP scheduling wake-ups. A
    squadron run must never idle on wake-ups forever; ending with a partial report is
    the designed outcome, not a failure mode.
- **cmux send gotcha:** after `cmux send` of a long message, wait ~300–500ms before
  `send-key enter` (or send Enter as a separate step) — an immediate Enter is absorbed as
  a newline and the message sits unsent. This applies to the `/codex:*` commands you type
  into panes.
- A wave is done when every group emits `SQ-DONE P<N>:`, has **passed its Codex gates as
  read by the orchestrator**, and is verified+pushed. Only then start the next wave.

### 6. G1 + G2 + BOUNDED cap-and-fix (per group)

**G1 — defect sweep.** Once a group emits `SQ-VERIFIED P<N>:`, send its pane:
```
/codex:review --background --base main
```
Then the **orchestrator** reads the result itself (`status --json` → `result <job-id>` in
that worktree). Send confirmed findings back to the pane to fix, under the leash below.

**G2 — adversarial design challenge.** After G1 findings are fixed (so the reviewer sees
the *final* diff), the orchestrator dispatches it **directly** — the Goose focus block is
multi-line, and a multi-line message through `cmux send` into a TUI prompt gets mangled
or submitted early. From the group's worktree:
```
Bash(command: node "$CODEX" adversarial-review --base main --scope branch '<FOCUS TEXT>',
     run_in_background: true)   # the script's --background is a no-op for reviews
```
using the Goose focus block from "Codex gates" above, with the phase intent prepended,
as ONE quoted argument. (In-pane dispatch is acceptable only if the focus is collapsed
to a single line.) Orchestrator reads the result itself, same as G1.

### 6a. THE ROUND BUDGET — hard, counted, orchestrator-enforced

The gates are a **fix → re-review** loop, and a fix can legitimately trigger the next
finding forever. **This is the single most dangerous construct in the skill.** It is
bounded by a hard budget, not by judgement.

**The budget, per group — these are ceilings, not targets:**

| Counter | Hard max | Counts |
|---|---|---|
| `g1_rounds` | **2** | Each `/codex:review` run (initial + at most one re-review) |
| `g2_rounds` | **2** | Each `/codex:adversarial-review` run (initial + at most one re-review) |
| `rescue_calls` | **2** | Each `codex:codex-rescue` invocation, **including every `--resume`** |
| `total_codex_jobs` | **5** | **Global backstop.** Every Codex job of any kind for this group |

**Enforcement rules — non-negotiable:**
- **The orchestrator owns the counters — ON DISK, not in its head.** It drives every gate
  (agents just emit `SQ-VERIFIED` and wait), so it is the only thing that can count — and
  it MUST. The per-group **gate ledger** lives in a scratchpad FILE (e.g.
  `<scratchpad>/sq-gate-ledger.md`): `P<N> — g1:1/2 g2:0/2 rescue:0/2 total:1/5`, plus
  each job id. **Write the increment before dispatching each job, and re-read the file
  before every dispatch.** A ledger kept only in the conversation is how a long fleet run
  resets its counters at context compaction — the one way this loop becomes unbounded.
  Mirror it into the tracking table for display, but the file is the truth.
- **A counter is monotonic. It never resets** — not on a new finding, not on a "different"
  issue, not because the last round "almost worked", not because the agent asks. There is
  no "one more round."
- **Hitting ANY ceiling immediately triggers the cap procedure** (below). No exceptions, no
  appeal, no orchestrator discretion to extend. If the human wants more, that is a **new
  run on a fresh branch**, decided by the human, outside this loop.
- **`total_codex_jobs` = 5 is the backstop that makes the loop provably terminate**, even
  if a sub-counter is mis-tracked. When it trips, the group is done reviewing, full stop.
  (Yes, the sub-ceilings sum to 6 — the backstop binding first is **intentional**: a
  group can max out g1+g2 *or* lean on rescue, never both. Do not "fix" the arithmetic.)
- **A gate that errors (job failed, unparseable result) OR exceeds its 30-minute job
  timeout (cancel it) burns its round.** Retrying a crashed job is the cheapest possible
  infinite loop. Max **one** re-dispatch of a *failed* job per group, and it counts.
- **G3 rescue does not reset anything.** A rescue and each of its `--resume`s burns
  `rescue_calls` **and** `total_codex_jobs`. Rescue is a way to fix something well once —
  not a fresh loop.
- **No new gate after a rescue fix.** A rescue's diff gets **one** confirming pass, which
  spends a normal `g1`/`g2` round from the remaining budget. If there is no budget left, the
  rescue's diff must be **reverted or reduced**, not shipped unreviewed.
- **Bail early, don't spend the budget.** The ceilings are limits, not goals. Both
  trip-wires below mean **stop now**, even at round 1 with budget remaining.

**The trip-wires — stop *before* the ceiling:**
- **"New front":** a re-review surfaces a *distinct new issue class* (security/IDOR,
  cross-entity, external-system interaction) → **pause and report**, do not silently grow
  the diff.
- **"Fix caused the next bug":** if round N's fix caused round N+1's finding, the approach
  is fragile → **step back and escalate**. Patch-on-patch is the loop. Do not take round
  N+2 just because the budget allows it.
- **Diff-growth:** if the review-driven fixes have grown the diff beyond the phase's stated
  scope, that is the same signal — cap it.

**The leash — bounded autonomy, "escalate, don't spiral".** Agents may fix related,
in-blast-radius issues freely (a regression their own change introduced, an obvious
correctness gap in the same function). They must **NOT** re-architect, open a new distinct
issue class, or enter a "my last fix caused the next bug" cycle without **reporting back to
the orchestrator**. Agents **never** dispatch a Codex job themselves — that is how counters
get bypassed. If a pane runs `/codex:*` on its own initiative, treat the group as
**budget-compromised**: stop it, count what it spent, and cap.

- **Never push a state a review just flagged as buggy.** Reduce/revert first.
- **The orchestrator (with the human) owns the scope decision:** keep going,
  cap-and-ship-the-safe-subset, or defer to a ticket. Agents propose; they don't grow
  the PR unilaterally.

**Cap procedure** (what the orchestrator sends when a ceiling is hit or a trip-wire
fires): keep the verified-clean parts; reduce the hard part to the MINIMAL safe change
(forward-only, self-scoped); drop the logic that keeps generating new failure modes; then
**at most ONE** final confirming pass — and **only if `total_codex_jobs` has a slot left**.
If the budget is exhausted, do **not** run another gate: **revert the unreviewed part** and
ship the clean subset without it. Push the clean subset, OR drop that item from the PR and
ticket it. Close with a summary of what shipped vs. what's ticketed, and the final gate
ledger. **The cap procedure is itself terminal — it runs once, and the group is then done
reviewing either way.**

### 7. Finalize the group — commit + push + verify sync (never force-push)
This step owns the commit and the push; step 8 only opens the PR. Do NOT trust an
agent's "pushed". Send the group's window the `/github` command (commit + push) with
the constraints: stage only the intended files (code/tests/new files — NOT `reports/`,
NOT `.env*`, NOT the uncommitted playwright PORT edit), and end the commit message with
the standard co-author trailer for whatever model is flying the pane (e.g.
`Co-Authored-By: Claude <noreply@anthropic.com>` — do not hardcode a model name that
will go stale). Then the **orchestrator independently verifies**:
```
git -C <worktree> fetch -q origin
git -C <worktree> rev-list --left-right --count @{u}...HEAD   # must be "0  0"
```
and that local HEAD == origin HEAD. Only mark the group **landed** once that passes.

### 8. Open one PR per group (only if step 7's verification PASSED)
The branch is already committed and pushed (step 7) — this step is `gh pr create` only;
do not stage or commit anything new here. Body: per-task what/why + verification evidence + a **Codex gates**
section (G1 verdict, G2 verdict, findings fixed, findings capped/deferred, taken from
the raw `result` output — not the agent's summary) + "🤖 Generated with Claude Code".
**Do not merge.** If verification failed, do NOT open a PR — leave the branch, record
what failed, continue.

### 9. Orchestrator writes back to the plan HTML — SOLE WRITER
Parallel agents **never** edit the shared plan file (concurrent-write collision). The
**orchestrator is the only writer**. As each group lands, update the input `.html`
in place (planf3 conventions):
- Flip that phase's `<code class="status">` markers `[] → [wip]` at launch, `→ [x]` on
  pass or `[f]` on failure.
- Append the PR link into the phase heading.
- Append a `<section id="amendments">` `<details>` entry (newest at bottom) summarizing
  what the wave shipped, the **G0 plan objections** (and how they were resolved), the
  **G1/G2 findings with file:line from the raw Codex `result`**, any scope caps, and
  deferred tickets.
- Append the metadata lists (append-only, never overwrite): `modified` (ISO now),
  `agent name`, `session id`, and the group commit SHA(s) into `commits`.

### 10. Final report
After all waves: the **G0 verdict on the plan**, then per group — PR link or failure
reason, the phase's final task status, **G1 + G2 verdicts and findings + how resolved**,
any G3 rescue handoffs, any scope caps, deferred tickets/decisions, and which groups are
merge-ready. Note the human-reviewer handoff is a separate skill.

### 11. Report cleanup — HUMAN-GATED, never auto-tear-down
Squadron **never removes worktrees, kills servers, or drops Docker DBs on its own**, and
**never leaves cmux windows in a surprising state**. Teardown is the human's call. When
the run is reported:
- **Do NOT** run `git worktree remove`, `git worktree prune`, `docker rm`, or kill the
  per-group dev servers automatically. Leave every group's worktree, branch, Docker DB,
  and cmux window **intact** so the human (and reviewers) can still inspect them.
- **Cancel any still-running Codex jobs** (`node "$CODEX" cancel <job-id>` per worktree)
  before reporting a group done — an orphaned background review will keep burning.
- Instead, **emit a cleanup manifest** the human can act on: per group, the worktree path,
  its branch, the branch's **verified origin SHA** (proof the work is safe on origin), the
  Docker DB/port, and the cmux `workspace:N`. Confirm for each that `git status --porcelain`
  is empty **and** `git rev-list --left-right --count @{u}...HEAD` is `0  0` before calling
  it "safe to remove"; flag any group that isn't as **NOT safe — has unpushed/uncommitted
  work**.
- Offer a **ready-to-paste cleanup command** but do not execute it. When you do build a
  removal command (only on the user's explicit go-ahead), use **plain `git worktree remove`
  — never `--force`**. Git's refusal to remove a dirty/unpushed worktree is a safety
  feature; if it refuses, STOP and report, don't override.
- **State the window convention explicitly** in the report: the cmux windows stay open with
  their agent transcripts preserved; note that once a worktree is removed, that window's
  cwd is deleted (it will report "working directory … was deleted") — so windows should be
  closed *before or together with* removing their worktree, on the user's say-so.

### 12. Offer the debrief handoff
When the run is finished and reported, **ask the user whether to run `/debrief`** on the
same plan — the sibling skill that divides the landed preview branches across named human
reviewers and writes a "Preview Testing Assignments" section into this plan HTML. If yes
and reviewer names are known/in memory, offer to launch it directly
(`/debrief <plan.html> <names…>`); otherwise ask for the reviewer names first. Do not run
it automatically — only on the user's go-ahead.

## Guardrails
- **Waves, not free-for-all.** Never launch a phase whose dependencies haven't landed.
- **Full isolation is mandatory** for parallel groups: own worktree + own branch + own
  `reports/` + own Docker DB + own PORT/BASE_URL. Half-isolation is worse than sequential.
- **The orchestrator reads the Codex verdict, not the agent's summary of it.** An agent
  saying "Codex passed" is worth exactly as much as an agent saying "I pushed" — verify.
- **No PR without both gates.** A group ships only when G1 and G2 have been run AND their
  raw results read by the orchestrator. A gate that errored is a **blocker**, not a pass.
- **The round budget is a hard ceiling (step 6a): g1≤2, g2≤2, rescue≤2 (resumes included),
  and `total_codex_jobs ≤ 5` per group as a global backstop.** Counters are monotonic, the
  orchestrator owns them, and hitting one triggers the terminal cap procedure — there is no
  "one more round" and no discretion to extend. The fix→re-review loop is the one construct
  here that can run forever; the budget is what makes it provably terminate. Extending it is
  a **human decision on a fresh run**, never an in-run judgement call.
- **Agents never dispatch Codex jobs themselves.** Only the orchestrator does — otherwise
  the counters are bypassed and the budget is a fiction. A pane that self-dispatches is
  **budget-compromised**: stop it and cap. (The orchestrator *typing* a `/codex:*`
  command into a pane counts as orchestrator dispatch — the ledger increments first.)
- **Waiting is bounded too (step 5): 30 min per Codex job, 2 interventions per stuck
  pane, a per-group deadline, and a whole-run deadline (default 8h).** The Codex budget
  bounds spend; these bound time. A run that idles on scheduled wake-ups with nothing
  actionable is a failure of THIS guardrail — end it with a partial report instead.
- **The gate ledger lives on disk** (scratchpad file), incremented before dispatch and
  re-read before every dispatch — never trusted from conversation memory after
  compaction.
- Never `gh pr merge`, never push to `main`, never force-push shared branches, never move
  Kanban cards.
- **Never auto-tear-down.** Removing worktrees, pruning, dropping Docker DBs, killing the
  per-group servers, and closing cmux windows are **human-gated** (step 11) — squadron
  reports what's safe to remove and hands the human a command, it does not run it. When a
  removal IS authorized, use plain `git worktree remove` — **`--force` is banned** because
  it bypasses git's refusal to delete a worktree with unpushed/uncommitted work.
- **Neutralize external writes** in every group's env: unset `SERVICETITAN_APP_KEY`
  (ServiceTitan write-back) and `RESEND_API_KEY` (email). ServiceTitan write-back is the
  one genuine external risk.
- **Prove the sandbox before writing.** A per-worktree `.env.local` is NOT sufficient
  isolation on its own — if the dev command is secret-manager-wrapped (Doppler/Infisical/
  etc.) it injects the prod `DATABASE_URL` and overrides `.env.local`, so "local"
  verification writes to prod. Every group must start the dev server with the non-injecting
  command and **prove its live DB is the local one before any write-action** (steps 3 & 4).
  Neutralizing `RESEND`/`SERVICETITAN` in `.env.local` is also void under a wrapped command
  — the manager re-injects the real keys. Treat unverified-DB as a hard stop.
- **Orchestrator is the sole writer of the plan HTML.** Agents report structured results.
- **Never fabricate** verification. If a group can't be exercised (missing env, external
  server, device-only flow), report it as a blocker, not a pass.

## Gotchas
- **`/codex:review` and `/codex:adversarial-review` are `disable-model-invocation: true`.**
  A model can't call them as skills. Get them either by **typing the slash command into a
  fleet agent's cmux pane** (a real user invocation) or by calling
  `node "$CODEX" review|adversarial-review …` directly from the worktree. `codex:rescue`
  is the exception — it *is* model-invocable via `Agent(subagent_type: "codex:codex-rescue")`.
- **Only `adversarial-review` accepts focus text.** `review` takes none. That is the whole
  reason G2 (not G1) carries the Goose failure-mode block.
- **Codex job state is per-repo-checkout** — run every companion call with the group's
  worktree as cwd (or `--cwd`), or you'll read another group's job board.
- **The script's `--background` only detaches `task` (rescue) — reviews always run
  foreground.** Direct review dispatch from the orchestrator needs
  `Bash(..., run_in_background: true)` or it blocks and gets killed at the Bash timeout,
  wedging the job as `running`.
- **`status` (job-board form) is session-filtered by `CODEX_COMPANION_SESSION_ID` and
  `--all` does not bypass it** — pane-dispatched jobs are invisible to the orchestrator's
  plain listing. Use `env -u CODEX_COMPANION_SESSION_ID …` for the board;
  `status <job-id>` / `result <job-id>` are unfiltered.
- **Don't enable the stop-time review gate** (`/codex:setup --enable-review-gate`): it fires
  on every stop with a 900s timeout, stalls waves, and makes busy agents look hung.
- A backgrounded Codex job makes a pane go quiet — check `status --json` before your
  liveness detector calls it a hang.
- `.claude/skills` is tracked — squadron belongs on `main`, shared tooling.
- Worktrees do NOT inherit `.env.local`; build a per-group one pointing at that group's
  Docker DB (replace, don't append — dotenv is first-wins).
- A secret manager (Doppler/Infisical/direnv) wrapping the dev/build/migrate scripts wins
  over `.env.local` — injected env is set before Next.js loads `.env.local`, and Next.js
  won't override an existing var. So `npm run dev` → prod DB even with a local `.env.local`.
  Use the non-wrapped command (`npm run dev:nodoppler` here) and prove-your-DB before
  writing. (This bit a real run: writes leaked to prod test accounts. See
  `reference_local_docker_qa_env` memory.)
- Preview doesn't exist until the branch is pushed; that's why per-agent verification is
  **local first, preview as the final check**.
- cmux `send` of a long message needs a submit delay before Enter (see step 5).
- Kill hung runs **cwd-scoped**, never a bare `pkill -f` (that kills sibling groups).

## Related
- Predecessor: `/squadron` (v1) — same fleet mechanics, single unspecified self-run Codex
  review. v2 supersedes it; v1 is kept working as a fallback.
- Consumes: `planf3` output (see `planf3/workflows/build-plan.md` for per-phase build
  conventions each agent follows).
- Isolation recipe: `qa-fleet` + the `reference_local_docker_qa_env` memory.
- Codex plugin: `openai-codex` marketplace, `codex` plugin — commands under
  `~/.claude/plugins/cache/openai-codex/codex/<version>/`.
- Sibling: `/debrief` (divides landed PRs among named humans).
