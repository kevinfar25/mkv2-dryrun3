---
name: kevin-pr-review
description: >-
  Review a GitHub pull request the way Kevin wants it done: two Codex passes
  (native + adversarial) GENERATE candidate findings, then Claude VERIFIES each
  one against the real code and reports confirmed/refuted with evidence. Scales
  by risk into three tiers, and on risky PRs (auth, payments, migrations,
  destructive ops, permissions, CRM writes) adds a functional pass on the Vercel
  preview that both targets what the diff changed AND adversarially tries to
  break it. Two modes: default reports + posts PR comments; `--fix` fixes confirmed
  findings on the feature branch AND loops greploop-style — re-review, fix, re-verify
  — until the PR earns a verified confidence score of 4/5 or 5/5 (max 3 iterations).
  NEVER merges, NEVER moves board cards. Invoke with a PR number, e.g.
  "/kevin-pr-review 922" or "/kevin-pr-review 922 --fix".
---

# Kevin PR Review

Reviews a GitHub PR with a generate-then-verify pipeline. **Codex generates
candidate findings; Claude verifies them against the code before anything is
reported.** That separation is the whole point — a single reviewer that is
confidently wrong has nothing to catch it. In the session this skill came from,
Codex's scariest finding (a "P1 cross-team data exposure") was *plausible and
wrong*, and only died because the claim was checked against the actual dashboard
code. Never relay a Codex finding as fact without verifying it yourself.

## Modes

- **`/kevin-pr-review <PR#>`** (default) — read, verify, and **report**. With the
  user's ok (or when they say "post them"), post confirmed findings as inline PR
  **review comments** (`COMMENT` event only — never Approve / Request Changes).
- **`/kevin-pr-review <PR# > --fix`** — everything above, **plus** fix confirmed
  findings on the PR's feature branch, push, and then **loop** (Step 7): re-review,
  fix, re-verify, re-score, until the PR earns a verified **confidence score of ≥4/5**
  or a **hard cap of 3 iterations** is hit. Invoking `--fix` is the explicit
  authorization to commit + push to that branch. Still verify findings *before*
  fixing, fix only confirmed ones, and re-verify after each round.

## Hard gates (both modes, non-negotiable)

- **NEVER merge to main.** The user reviews and merges on GitHub.
- **NEVER move board cards.** Kevin owns card status (board #6).
- **NEVER push to `main`** or any branch other than the PR's own feature branch,
  and only push at all in `--fix` mode.
- Post reviews as `COMMENT` only — this skill does not approve or block PRs.

## Step 0 — Isolate in a dedicated worktree, then read the PR

**Every review runs in its own git worktree — one per PR.** Never `gh pr checkout`
in the user's main working tree: reviews run in parallel (this skill is often
launched several at once in separate panes), and a checkout in the shared tree
yanks files out from under another in-flight review or the user's own work. A
per-PR worktree gives each review an isolated checkout on the PR's branch while
they all share one `.git`.

```bash
HEAD_REF=$(gh pr view <PR#> --json headRefName --jq .headRefName)
gh pr view <PR#> --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles,url
git fetch origin "$HEAD_REF"
WT=.claude/worktrees/pr<PR#>
git worktree add "$WT" "$HEAD_REF"   # reuse if it already exists
```

Do **all** review work against `$WT` — read files there, run `git diff main` and
the Codex passes with `$WT` as the working dir (`cd "$WT" && node …codex…`). This
keeps the main tree (and any sibling reviews) untouched.

**Bootstrap gotcha:** this skill file must exist inside the worktree for a fresh
session launched *in* the worktree to find it. Until the skill is committed to a
branch the PR shares, whoever launches a worktree-local session must copy
`.claude/skills/kevin-pr-review/` into the worktree first — OR launch the session
from the main repo dir (where the skill lives) and let it operate on `$WT` via
absolute paths. An untracked skill file is not shared into a worktree.

**Cleanup:** at the end, offer to `git worktree remove "$WT"` (git auto-drops it
if unchanged). Never leave the user's main tree on the PR branch.

Read the PR body, then the diff — but **verify its claims against `main`, don't
trust the body**. Large `additions` counts are usually lockfiles / generated
snapshots; look at the real code files.

## Step 1 — Triage into a tier

Pick the tier from what the diff actually touches:

| Tier | When | What runs |
|---|---|---|
| **0 — Light** | docs, config, copy, small mechanical diffs, test-only changes | A single read or `/code-review`. **No Codex, no preview.** Report and stop. |
| **1 — Standard** | substantive application logic with no high-risk surface | Codex `review` + `adversarial-review` → verify every finding → report. **Static only, no code execution.** |
| **2 — Deep** | touches **auth, payments/billing, data migrations, destructive ops (delete/overwrite), permissions/access control, or external integrations (CRM writes, ServiceTitan, webhooks)** | Everything in Tier 1 **plus** the functional + adversarial preview pass in Step 4. |

When unsure between two tiers, pick the higher one. State the chosen tier and why.

## Step 2 — Codex passes (Tier 1 and 2)

Run both Codex reviews against the PR base, foreground so you get results this
turn. `${CODEX}` = the codex-companion script path (find it under
`~/.claude/plugins/*/openai-codex/codex/*/scripts/codex-companion.mjs`).

```bash
node "${CODEX}" review "--wait --base <baseRef> --scope branch"
node "${CODEX}" adversarial-review "--wait --base <baseRef> --scope branch"
```

Treat both outputs as **candidate findings, not verdicts.** Native review tends
to surface implementation defects; adversarial review challenges the approach,
assumptions, and failure-under-real-conditions. Expect overlap and expect some
false positives.

## Step 3 — Verify every finding (this is the actual product)

For each candidate finding from either Codex pass:

1. Open the cited file **and the code it depends on** — the callee, the schema,
   the "parity" reference it claims to match. The false P1 died here: the claim
   assumed the dashboard scoped to unassigned reps; the dashboard code actually
   unioned in *all* org reps, so the PR was correct.
2. Decide: **CONFIRMED**, **REFUTED**, or **UNCERTAIN** (needs the preview to
   settle — push it to Step 4 if Tier 2, otherwise report as uncertain).
3. Record **how** you verified it (which file/line/behavior proved it), and a
   severity (blocker / should-fix / follow-up).

Also do your own read independent of Codex — Codex misses things too, especially
repo-specific conventions. Cross-check against known repo gotchas (see the
project memory index): worker code paths that exist in *both* the Vercel app and
the Railway worker; the `conversations.appointment_id` two-id-space trap; auth
round-trips; migration ledger high-water skips.

### Assign a verified confidence score (drives `--fix` looping)

After verifying every finding, assign the PR a **confidence score from 1–5**. The
score is computed **only over CONFIRMED findings** — refuted findings never count
against the PR (that is the whole reason the score is trustworthy, and what
separates this from greploop chasing a bot's raw comments). Severity buckets are
the ones from Step 3.3: **blocker / should-fix / follow-up**.

| Score | Meaning |
|---|---|
| **5** | Zero confirmed **blocker** or **should-fix** findings. Follow-ups may exist (noted, not blocking). Tier 2: every previewable path was driven clean. |
| **4** | No confirmed **blockers**. Any confirmed **should-fix** is either fixed this round or explicitly accepted as a follow-up. No console/network errors on a happy-path flow. |
| **3** | ≥1 confirmed **blocker** still open, **OR** (Tier 2) a previewable path the diff touches has not yet been driven. |
| **≤2** | Multiple confirmed blockers, a happy-path silent failure / console error, or verification could not be completed. |

**The loop target is ≥4.** Report the score with a one-line justification (which
confirmed findings, if any, are holding it below 5) every time you compute it —
in default mode you compute it once; in `--fix` mode you recompute it each
iteration (Step 7).

## Step 4 — Preview verification (Tier 2 only)

Testing a PR means **exercising it**, which mutates state — that's expected, not
a violation of anything. The rule is *where* and *cleanup*, not "read-only":

- Test on the **Vercel branch preview**, which runs against the **staging DB**
  (`sxopkwjblibuqzapgcmn`), not prod. Resolve the real preview deployment URL
  (not the dashboard/checks link).
- **Leave no residue** — keep test data cleaned up or use rolled-back
  transactions. Never run destructive/adversarial checks against the prod DB.
- Use the **Playwright MCP, non-headless**. Proper functional testing: click
  through flows, submit forms, verify **state actually persisted** (network
  status + payload, and the record really exists) — *seeing an element exist is
  not a test*.
- **Preview blind spots to call out, not paper over:** the Railway **worker**
  half of any dual-path logic does NOT run on preview (no Redis) — "verified on
  preview" is not verification for a worker path. CRM flows need branch-scoped
  keys (`CRM_ENCRYPTION_KEY`, provider secrets) in Vercel Preview or they can't
  be exercised. If a path can't be driven on the preview, say so as an explicit
  limitation — never fake a pass.

**Mandatory: drive at least one path live.** A Tier-2 review MUST actually
exercise at least one previewable path in the browser — not just offer to. Before
concluding, enumerate the paths the diff touches and split them into *previewable*
(a route/UI/API you can hit on the preview against the staging DB) vs.
*un-previewable* (worker-only, needs prod, needs data that doesn't exist on
staging). If **any** path is previewable, you must drive at least one end-to-end
(prefer the highest-risk previewable one — e.g. an access-control guard as the
wrong user/org) and report the network status + payload as evidence. "The riskiest
paths happen to be un-previewable" does NOT excuse skipping the live drive when a
lower-risk path is still previewable. Only when you've shown that *every* touched
path is genuinely un-previewable (with the reason for each) may the live drive be
skipped — and then say so explicitly, per path. Offering to drive a path "if you
want" instead of driving it is a skipped step, not a completed one.

Two required, distinct sub-passes:

**4a — Targeted test (what THIS PR does).** Derive the test plan from the diff,
not a generic checklist. If the PR changes practice-XP reconciliation, run a
practice session to completion and check the persisted `xpEarned` against the
ledger. If it adds an ownership guard, try the guarded action as the wrong user.

**4b — Adversarial test (try to break it).** Then genuinely attack what the PR
touches. Run the full battery against every form/action/flow the diff affects:

- Empty submits, whitespace-only, maximum-length, malformed input (wrong types,
  special chars, emoji, pasted trailing whitespace, very long strings)
- Double-clicks and rapid repeated clicks on the same action; concurrent actions
- Navigate away mid-action, back button mid-flow, refresh mid-submit
- Expired / invalid / wrong-role auth against every gate the PR adds or relies on
- Permission matrix where relevant: exercise as logged-out, basic, privileged,
  other-org — confirm boundaries hold under adversarial input
- Destructive paths: verify deletes delete, confirmations confirm, and check
  **state in the DB**, not just the UI success toast

Console errors and failed network requests on a happy-path flow are **blockers**,
not notes. Silent failures (UI says success, state didn't change) are blockers.

## Step 5 — Report (both modes)

Produce a plain-English verdict Kevin can act on:

- **What the PR accomplishes** in non-technical terms, and whether it looks safe
  to merge.
- **Findings**, most-severe first. For each: CONFIRMED / REFUTED / UNCERTAIN,
  **how you verified it**, severity, and file:line. Explicitly list refuted Codex
  findings so a scary-but-wrong claim doesn't get re-raised later.
- **What you verified end-to-end vs. couldn't verify** (preview limitations,
  worker paths, missing CRM keys).
- **The Vercel preview URL for this PR**, so Kevin can look himself. Always
  include it in the closing (resolve the real branch-preview deployment URL for
  the PR's HEAD — not the dashboard/checks link — via the Vercel CLI or the PR's
  status checks). On Tier 2 you already resolved it in Step 4; reuse it. On
  Tier 0/1 you didn't test on the preview, but still surface the URL if one
  exists. If no preview deployment exists (e.g. build failed, or previews aren't
  wired for this PR), say so explicitly instead of omitting it.
- A clear closing ask — including the two post options (consolidated `COMMENT`
  review, or `--fix`) alongside the preview URL.

### Required posting outcome (both `comment` and `--fix` mode)

When findings are posted to the PR, the end state on GitHub must be BOTH of:

1. **One consolidated top-level comment** that indexes every finding in **severity
   order** — the single canonical list. Each entry: severity, one-line summary,
   CONFIRMED/REFUTED/UNCERTAIN, `file:line`, and (in `--fix` mode) its disposition
   (fixed / follow-up). Include the refuted-Codex findings and the
   verified-end-to-end vs. couldn't-verify notes here too, so this one comment
   stands alone as the review of record.
2. **The inline comments left in place as anchors** — each finding also pinned to
   its line in the diff, so the discussion sits on the actual code.

Implement it as a single `COMMENT` review via
`gh api repos/<owner>/<repo>/pulls/<PR#>/reviews`: the review `body` is the
consolidated severity-ordered index (#1), and the `comments` array is the inline
anchors (#2) — one API call produces both. Anchor each inline comment to a line
**inside a diff hunk** (right side) or the API 422s with "Line could not be
resolved" — if a finding's line isn't in a hunk, anchor to the nearest changed
line and reference the real location in the comment body. Event stays `COMMENT`
(never Approve / Request Changes).

## Step 6 — Fix (only in `--fix` mode)

This is **one iteration** of the loop. Step 7 governs whether to run another.

- Fix **only CONFIRMED** findings, in the application code (not by weakening
  tests — if a test is genuinely wrong, call that out explicitly).
- If a fix is hard or you spiral, hand it to `codex:rescue` rather than thrashing.
- **Re-verify** each fix (re-run the failing check; on Tier 2, re-drive it on the
  rebuilt preview).
- Commit to the feature branch with a clear message and push (`fix: address
  kevin-pr-review finding — <summary> (iteration N)`).
- Then go to **Step 7** to re-score and decide whether to loop. Only post the
  Step 5 review (consolidated index + inline anchors) **once, after the loop
  exits** — not once per iteration — with each finding marked **fixed** or
  **follow-up** in the top-level list, plus the final score and iteration count.
- Still: no merge, no card moves.

## Step 7 — Loop until confidence ≥4 (only in `--fix` mode)

Greploop-style, but gated on the **verified** score from Step 3, never on raw
Codex output. Repeat the cycle **generate → verify → score → fix** until the exit
condition, with a **hard cap of 3 iterations**.

**Exit as soon as ANY of these is true — check before starting each new iteration:**

1. Verified confidence score is **≥4/5** (the target). Stop, post, report.
2. **3 iterations** have run. Stop and report current score + remaining confirmed
   blockers — do **not** run a 4th.
3. An iteration produced **no new confirmed findings and no score change**
   (converged / stuck). Stop; looping again would only thrash.

**Each iteration after the first:**

1. Re-run the Step 2 Codex passes against the *current* branch HEAD (the fixes
   are now in), then Step 3 verify.
2. **Consult the ledgers before verifying/fixing anything** (see below) — skip
   anything already refuted or accepted.
3. Fix confirmed blockers/should-fix (Step 6), commit + push.
4. Recompute the score. Log one line: `iteration N → score X/5 (holding: <reason>)`.

**Two ledgers keep the loop converging instead of oscillating** (greploop lacks
these and re-litigates every comment):

- **Refuted ledger** — record `{file:line, one-line claim}` for every finding you
  REFUTE, across all iterations. If a later Codex pass re-surfaces a refuted
  claim, **skip it**: don't re-verify, don't fix. A refuted finding must never
  come back and drag the score down or trigger a pointless fix.
- **Accepted-follow-up ledger** — record any confirmed **should-fix** you and the
  user consciously defer. An accepted follow-up **stops counting against reaching
  4** (per the Step 3 rubric) — otherwise the loop can never converge on a PR that
  legitimately has a deferred nice-to-have.

**Where the expensive Tier-2 preview pass runs — NOT every iteration.** The live
Playwright drive rebuilds the preview and mutates the staging DB; running it each
round is wasteful and slow. Run it:

- **once** at the first iteration to establish the baseline, and
- again **only** on the final iteration right before declaring ≥4, **or** in any
  iteration whose fix touched a previewable path.

The cheap static **generate → verify → fix** cycle is what actually loops; the
preview pass is a gate at the ends, not a per-round step. A score can't reach 5 on
a Tier-2 PR until its previewable paths have been driven clean (Step 3 rubric).

**Cost note — why the cap is 3, not greploop's 5.** Each iteration here is *two*
Codex passes + N verifications + possibly a preview rebuild — far heavier than
greploop's single hosted-bot call. Three rounds is the ceiling; if a PR still
scores <4 after three, that's a signal for a human look, not more automated
grinding.

## What NOT to do

- Don't relay Codex output verbatim as findings — verify first.
- Don't certify "production-ready" off static review alone for a Tier 2 PR.
- Don't loop in default (non-`--fix`) mode — default computes the score once and
  reports; the fix/re-review loop (Step 7) only runs under `--fix`.
- Don't loop on the raw score without the ledgers — a refuted finding re-surfacing
  each round and re-triggering a fix is the exact greploop failure this design
  avoids. Never re-fix a refuted claim; never let an accepted follow-up block ≥4.
- Don't exceed 3 iterations, and don't run the Tier-2 preview drive every round
  (baseline + final + any round whose fix touched a previewable path).
- Don't leave test residue on the staging DB; don't touch the prod DB destructively.
- Don't *offer* to drive a previewable path "if you want" in place of driving it —
  on Tier 2, if a path is previewable, drive at least one live (see Step 4).
- Don't `gh pr checkout` in the user's main working tree — every review gets its
  own worktree (see Step 0). Don't leave the main tree on the PR branch.
