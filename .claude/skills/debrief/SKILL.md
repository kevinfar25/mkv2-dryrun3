---
name: debrief
description: >-
  Take a planf3 plan whose groups have LANDED (implemented + PR'd, e.g. by
  /squadron) and divide the preview-branch review across named human reviewers,
  writing a "Preview Testing Assignments" section into the same plan HTML. Splits
  by whole group (each reviewer owns entire preview branches), balances load,
  emits a per-reviewer, per-ticket checklist with preview URL + PR + role + what to
  verify, plus a shared login block and a "known/deferred — do not re-file" list.
  Never merges, never moves cards. Invoke after /squadron, e.g.
  "/debrief specs/my-feature.html Abhi Raj Adithya".
argument-hint: "[path-to-planf3-plan.html] [reviewer names...]"
---

# Debrief

The post-flight human-review handoff. After `squadron` (or any process) has **landed**
a planf3 plan's groups — phases implemented, one PR + Vercel preview per group — debrief
**divides that review across named human reviewers** and writes a **Preview Testing
Assignments** section into the same plan HTML so the file is a ready-to-hand-off
deliverable.

Debrief does **not** touch code, merge, push, or move cards. It only reads the landed
state and writes the assignment section into the plan.

## Input

- **Plan path:** the planf3 `.html` whose phases are implemented + PR'd (status markers
  mostly `[x]`, PR links present, an Amendments entry from the build run). If omitted,
  infer the most recently built plan in `specs/` and confirm.
- **Reviewer names:** the humans to split the work across (e.g. `Abhi Raj Adithya`). If
  omitted, ask. If reviewer identities are in memory (e.g. a team roster), resolve their
  roles/emails from there.

## Procedure

### 1. Read the landed state
From the plan (and `gh` where needed), collect per group: phase/group name, PR number +
URL, **Vercel preview URL**, the tickets/acceptance items it covers, and the role/screen
each ticket needs. Pull preview URLs from each PR's Vercel comment
(`gh pr view <n> --json comments`); they're stable branch aliases that serve the latest
push. Confirm every group actually landed (PR open, branch pushed) before assigning it.

### 2. Gather the shared context (ask if not derivable)
- **Login block:** the credentials reviewers use on the previews (role → account →
  password), and which env the previews run on (branch previews commonly run on the
  **staging** DB). Resolve from memory/config if known; otherwise ask.
- **"Known / deferred — do NOT re-file" list:** anything intentionally deferred, env-
  dependent, or by-design (pull these from the plan's Amendments / follow-up tickets so
  reviewers don't waste time re-reporting them).

### 3. Divide the work — whole groups, balanced
- **Assign whole groups per reviewer** (each person owns entire preview branches end to
  end — cleaner than splitting a branch across people).
- **Balance by ticket count AND spread the heavy/complex groups** (auth/email, field/
  device flows, big multi-ticket groups) so no one reviewer gets all the hard ones.
- Aim for roughly even ticket counts; when groups don't divide evenly, give the reviewer
  with fewer groups the lighter ones. Present the proposed split and let the user adjust
  before writing.

### 4. Write the assignments into the plan HTML (in place)
Add a `<section id="qa-testing">` (before `<section id="validation">`), matching the
plan's existing CSS classes, containing:
- An intro paragraph (reviewers verify their groups on the live preview → confirm
  merge-ready; split by whole group).
- A **login `.callout`** (roles → accounts → shared password; env note; any special-
  access note like a platform login).
- A **"Already known / deferred — do NOT re-file" `.callout`** (the step-2 list).
- A **summary table** (reviewer → groups → ticket count → # branches).
- One **`.phase` block per reviewer**, and within it one `<h4>` per assigned group with
  its preview URL, PR link, required role, and a `<ul class="checklist">` — one
  `<li><code class="status">[]</code> #ticket — what to verify</li>` per ticket.
- A closing `.loop`: "mark `[x]` pass / `[f]` fail (with a Loom/screenshot); a group is
  merge-ready only when all its tickets pass."

Then update the plan metadata (append-only): `modified` (ISO now), `agent name`,
`session id`. Optionally append a short Amendments `<details>` noting the review was
assigned and to whom.

### 5. Report + hand off
Summarize the split (who got which groups/tickets), confirm the section is in the plan,
and offer to open the plan in the browser and/or render it as a shareable Artifact. The
plan HTML is now the reviewer-facing deliverable.

## Guardrails
- Read-only on code/git — never edit source, commit, push, merge, or move cards.
- Only assign groups that actually landed (PR + pushed branch verified).
- Resolve REAL preview URLs, credentials, and roles — never leave a placeholder a
  reviewer can't act on. If a login can't be resolved, ask rather than guess.
- Don't invent tickets — assignments come from the plan's own phases/tickets.

## Related
- Pairs with `squadron` (which lands the plan); debrief is the human-review handoff.
- Reviewer roster / team identities may live in memory (resolve names → roles/emails).
