---
name: planf3
description: Creates a concise engineering implementation plan based on user requirements and saves it to specs directory
argument-hint: "[user-prompt] [questionable]"
---

# Plan F3

## Purpose

Create a detailed, **HTML-first** implementation plan based on the `USER_PROMPT` variable. The plan is authored as a single self-contained `.html` page so it can be opened in a browser, embed focused images with a synced visual identity, and be created/updated/consumed by the agent trifecta (engineer, team, AI agents). Analyze the request, think through the implementation approach, follow the `## Instructions`, and work through the `## Workflow` to produce the plan from the `## Plan Template`.

## Variables

USER_PROMPT: $1
QUESTIONABLE: $2 - default false
PLAN_OUTPUT_DIRECTORY: `specs/`
PLAN_FILE: `PLAN_OUTPUT_DIRECTORY/<descriptive-kebab-name>.html`
IMAGES_OUTPUT_DIR: `PLAN_OUTPUT_DIRECTORY/<plan-name>/`
AI_DOCS: `AI_DOCS/`
APP_DOCS: `APP_DOCS/`
IDE: `code`
BROWSER: `chrome`

## Instructions

- IMPORTANT: If no `USER_PROMPT` is provided, stop and ask the user to provide it
- Carefully analyze the user's requirements provided in the `USER_PROMPT` variable
- Think deeply (ultrathink) about the best approach to implement the requested functionality or solve the problem
- Explore the codebase to understand existing patterns, documentation, previous specs and architecture
- The plan is **HTML-first**: produce a single self-contained `.html` document from the `## Plan Template` below
- The template uses `{{PLACEHOLDER}}` variables — replace EVERY `{{...}}` with real content. Do not leave any `{{}}` token in the final file
- Blocks marked with `<!-- repeat -->` are repeatable: duplicate them as many times as the plan needs (e.g. one block per phase, task, file, or Q&A entry) and delete the comment markers
- Keep the document self-contained: all CSS lives in the single `<style>` block; do not link external stylesheets or scripts
- Maintain a **synced visual identity** between the html styling and the generated images. We want a professional, focused, minimal theme based on the original `USER_PROMPT` that created the plan. The CSS custom properties in `:root` define the palette/typography. Any embedded image must be generated to match this same identity.
- For every image created keep them professional and focused on one or two primary ideas. Keep text bloat down by minimizing the total number of sets of words requested in the image prompt under 10. The goal is to build images that aid the plan and convey the core information throughout the plan given the section the image was created for. 
- Build images for professional software engineers to convey exactly what is going to be built. Be sure to center and space images properly. 
- Embed images via the `{{...IMAGE}}` slots. During Create, leave them as commented placeholders noting the intended subject; the Image Generation workflow fills them later
- Populate the metadata header (`created`, `modified`, `commits`, `agent`, `session`, back/forward references) — these are updatable across the plan's lifecycle. Every metadata field except `CREATED_ISO` is a comma-separated list that must only ever be appended to — never overwrite or remove existing entries
- **Decisions vs. Questionables:** any choice where guessing wrong would invert the work (build vs. don't-build, rename vs. new feature, one approach vs. its opposite) is a **blocking Decision** — it goes in the mandatory top-of-plan `Decisions Required` section, marked `[open]` with owner, options, recommendation, and the phases it blocks (`data-blocks`). Never bury a blocking decision inside a phase body or a collapsed toggle; a phase may reference it, but the Decisions section is the canonical home. The section is always present — write "None." rather than omitting it
- Resolve decisions at creation time when possible: put them to the user via AskUserQuestion while authoring; only park as `[open]` what genuinely needs someone unavailable (e.g. a product owner), and name that person as the owner
- If `QUESTIONABLE` is true, actively surface open questions/assumptions in the toggleable Q&A section rather than silently deciding — but blocking decisions go in `Decisions Required` regardless of this flag
- **IMPORTANT — for defect / bug-fix plans, a root cause derived only from reading source code is a HYPOTHESIS, not a finding.** Static analysis is a hypothesis generator that presents as a conclusion, and it is confidently wrong often enough to waste whole phases. Before writing a cause into the plan as established, confirm it against something outside the source: run the `SELECT` (if the theory rests on data), drive the real screen (if it rests on behavior), and check that the defect still reproduces on a build containing any prior fix. A large fraction of "reopened" tickets are **not code defects at all** — they are stale-build retests or unusable test fixtures (e.g. an `@*.test` / `.example` / `.invalid` email can never receive mail, RFC 2606). Ask "was the retest even valid?" before asking "where is the bug?"
- Any cause you could not verify empirically must be written as an explicit hypothesis (`Root cause (HYPOTHESIS)`), listed in Questionables, and have its verification as the first task of its phase — never laundered into the plan as fact
- Every defect phase MUST open with the **Reproduce-or-close** task from the template. A plan that cannot prove a bug exists must not schedule work to fix it
- Ensure the plan is detailed enough that another developer (or agent) could follow it to implement the solution
- Include code examples or pseudo-code where appropriate to clarify complex concepts
- Consider edge cases, error handling, and scalability concerns
- Save the complete plan to `PLAN_FILE` using a descriptive kebab-case filename

## Workflow

Based on the `USER_PROMPT`, select the single best-matching workflow below and read its file for the step-by-step instructions before acting.

| Workflow | When to call it | File to read |
| --- | --- | --- |
| Create Plan | The prompt asks to plan, spec, or design new work and no existing plan is referenced | `workflows/create-plan.md` |
| Update Plan | The prompt asks to change, extend, or revise the content of an existing plan | `workflows/update-plan.md` |
| Update References | The prompt asks to refresh plan metadata or back/forward references (created, modified, commits, agent, session) | `workflows/update-references.md` |
| Build Plan | The prompt asks to implement, execute, or carry out the work described in an existing plan | `workflows/build-plan.md` |

### Subworkflow

Called by other workflows rather than selected directly from the `USER_PROMPT`.

| Subworkflow | When it's called | File to read |
| --- | --- | --- |
| Image Generation | Invoked by other workflows (e.g. Create Plan) to generate, fill, or regenerate the embedded images in a plan | `workflows/image-generation.md` |

## Plan Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Plan: {{PLAN_TITLE}}</title>
</head>
<body>
<main>

  <!-- ===== HEADER + UPDATABLE METADATA ===== -->
  <header>
    <h1>Plan: {{PLAN_TITLE}}</h1>
    <details class="meta">
      <summary>Metadata</summary>
      <dl>
        <dt>created</dt>      <dd>{{CREATED_ISO}}</dd>
        <dt>modified</dt>     <dd>{{MODIFIED_ISO_LIST}}</dd>
        <dt>commits</dt>      <dd>{{COMMIT_SHA_LIST}}</dd>
        <dt>agent name</dt>        <dd>{{AGENT_NAME_LIST}}</dd>
        <dt>session id</dt>      <dd>{{SESSION_ID_LIST}}</dd>
        <dt>back refs</dt>    <dd>{{BACK_REFERENCES}}</dd>
        <dt>forward refs</dt> <dd>{{FORWARD_REFERENCES}}</dd>
      </dl>
    </details>
  </header>

  <!-- Hero image — synced to the :root visual identity. Replace with <img> once generated. -->
  <figure>
    <!-- {{HERO_IMAGE: subject describing the plan at a glance}} -->
    <figcaption>{{HERO_IMAGE_CAPTION}}</figcaption>
  </figure>

  <!-- ===== PURPOSE / PROBLEM / SOLUTION ===== -->
  <section id="purpose">
    <h2>Purpose</h2>
    <p>{{PURPOSE}}</p>
  </section>

  <!-- ===== DECISIONS REQUIRED (mandatory — never omit, never collapse) ===== -->
  <!-- One entry per BLOCKING decision a human must make. Rule of thumb: if guessing
       wrong would invert the work (build vs. don't-build, rename vs. new feature),
       it is a Decision and belongs here; if it merely annotates a judgement call,
       it is a Questionable. If there are none, keep the section with "None." -->
  <section id="decisions">
    <h2>⚠ Decisions Required</h2>
    <ul>
      <!-- repeat: one <li> per blocking decision; delete the li and write <li>None.</li> if there are none -->
      <li data-blocks="{{PHASE_NUMBERS_BLOCKED}}">
        <code class="status">[open]</code> <strong>{{DECISION_QUESTION}}</strong> —
        owner: {{WHO_DECIDES}}; blocks Phase {{PHASE_NUMBERS_BLOCKED}}.
        Options: {{OPTIONS_WITH_RECOMMENDATION}}.
        <!-- when resolved, change [open] to [resolved: <choice>] and note who/when -->
      </li>
    </ul>
  </section>

  <section id="problem">
    <h2>Problem</h2>
    <p>{{PROBLEM}}</p>
    <figure>
      <!-- {{PROBLEM_IMAGE: subject visualizing the problem this plan addresses}} -->
      <figcaption>{{PROBLEM_IMAGE_CAPTION}}</figcaption>
    </figure>
  </section>

  <section id="solution">
    <h2>Solution</h2>
    <p>{{SOLUTION}}</p>
    <figure>
      <!-- {{SOLUTION_IMAGE: subject visualizing the proposed solution}} -->
      <figcaption>{{SOLUTION_IMAGE_CAPTION}}</figcaption>
    </figure>
  </section>

  <!-- ===== RELEVANT FILES ===== -->
  <section id="files" class="files">
    <h2>Relevant Files</h2>

    <h3>Existing Files</h3>
    <ul>
      <!-- repeat -->
      <li><span class="tag existing">existing</span> <code>{{EXISTING_FILE_PATH}}</code> — {{WHY_RELEVANT}}</li>
    </ul>

    <h3>New Files</h3>
    <ul>
      <!-- repeat -->
      <li><span class="tag new">new</span> <code>{{NEW_FILE_PATH}}</code> — {{WHY_NEEDED}}</li>
    </ul>
  </section>

  <!-- ===== IMPLEMENTATION PHASES ===== -->
  <section id="phases">
    <h2>Implementation Phases</h2>
    <p><strong>IMPORTANT:</strong> Execute every phase and task step by step, in order, top to bottom.</p>
    <p>Status markers: <code>[]</code> idle · <code>[wip]</code> in progress · <code>[x]</code> complete · <code>[f]</code> failed. All start as <code>[]</code>; the Build Plan workflow updates them as it works.</p>

    <!-- repeat: one .phase block per phase -->
    <div class="phase">
      <h3><code class="status">[]</code> Phase {{PHASE_NUMBER}}: {{PHASE_NAME}}</h3>
      <p>{{PHASE_DESCRIPTION}}</p>

      <!-- Optional focused image for this phase, synced to :root identity -->
      <figure>
        <!-- {{PHASE_IMAGE: subject describing this phase's architecture/flow}} -->
        <figcaption>{{PHASE_IMAGE_CAPTION}}</figcaption>
      </figure>

      <!-- DEFECT PLANS ONLY — MANDATORY FIRST TASK of every phase that fixes a reported bug.
           A root cause read out of source is a hypothesis. This task is what turns it into a
           finding, or kills the phase. Delete this block for feature/greenfield phases. -->
      <h4>1. Reproduce-or-close</h4>
      <ul class="checklist">
        <li><code class="status">[]</code> Reproduce {{DEFECT_ID}} on a build that <strong>contains any prior fix</strong> — confirm which commit/build the reporter tested. If it does not reproduce, close as <em>stale-build retest</em> and mark the rest of this phase <code>[f]</code>.</li>
        <li><code class="status">[]</code> Confirm the test data can physically pass (deliverable mailbox, seeded rows present, correct org/tenant). Bad fixtures produce phantom defects.</li>
        <li><code class="status">[]</code> Confirm the screen/route in the ticket is the one this phase patches — a fix on the wrong code path is indistinguishable from no fix.</li>
        <li><code class="status">[]</code> Prove the stated root cause against something outside the source (a <code>SELECT</code>, a rendered screen). {{HOW_THE_CAUSE_IS_PROVEN}}</li>
      </ul>
      <div class="cause">
        <b>Root cause ({{VERIFIED_OR_HYPOTHESIS}}).</b> {{ROOT_CAUSE}}
      </div>

      <!-- repeat: one <h4> + checklist per task -->
      <h4>{{TASK_NUMBER}}. {{TASK_NAME}}</h4>
      <ul class="checklist">
        <!-- repeat -->
        <li><code class="status">[]</code> {{SPECIFIC_ACTION}}</li>
      </ul>

      <!-- Final task of every phase: Testing Strategy + validation loop -->
      <h4>{{LAST_TASK_NUMBER}}. Testing Strategy</h4>
      <p>{{TESTING_APPROACH: technology used to test/validate, including edge cases}}</p>
      <ul class="checklist">
        <!-- repeat -->
        <li><code class="status">[]</code> <code>{{VALIDATION_COMMAND}}</code> — {{WHAT_IT_PROVES}}</li>
      </ul>
      <div class="loop">
        🔁 <strong>Do not exit this phase until every box above is checked.</strong>
        If any command fails, fix the cause and re-run — loop until all pass.
      </div>
    </div>
  </section>

  <!-- ===== GLOBAL VALIDATION ===== -->
  <section id="validation">
    <h2>Validation Commands</h2>
    <p>Execute these commands to validate the entire plan is complete:</p>
    <ul class="checklist">
      <!-- repeat -->
      <li><code class="status">[]</code> <code>{{VALIDATION_COMMAND}}</code> — {{WHAT_IT_PROVES}}</li>
    </ul>
    <div class="loop">
      🔁 <strong>The plan is not complete until every box is checked and every command passes. If for some reason a step is not possible to complete, mark it with [f] and move on if possible.</strong>
    </div>
  </section>

  <!-- ===== QUESTIONABLES (only include this section if QUESTIONABLE is true) ===== -->
  <section id="questionables">
    <h2>Questionables</h2>
    <!-- Optional image for this section, synced to :root identity -->
    <figure>
      <!-- {{QUESTIONABLES_IMAGE: subject visualizing the key open question/risk}} -->
      <figcaption>{{QUESTIONABLES_IMAGE_CAPTION}}</figcaption>
    </figure>
    <!-- repeat: one <details> per questionable decision / assumption / risk -->
    <details>
      <summary>{{QUESTIONABLE}}</summary>
      <p class="qa-answer">{{ASSUMPTION_OR_RATIONALE}}</p>
    </details>
  </section>

  <!-- ===== NOTES ===== -->
  <!-- Open canvas — the planning agent runs free here. There is no fixed shape:
       use whatever HTML best serves the plan (prose, lists, tables, code blocks,
       diagrams, callouts, decision logs, alternatives considered, open threads,
       links, anything). Embed as many image slots as the plan benefits from. -->
  <section id="notes">
    <h2>Notes</h2>
    {{NOTES: free-form. Capture anything that helps the trifecta understand, build,
      or extend this plan — context, dependencies (new libraries via `uv add`),
      tradeoffs, rejected approaches, risks, future work, references. Author rich,
      bespoke HTML as needed.}}
    <!-- repeat: add as many of these image slots as the notes warrant including the image block below -->
    <figure>
      <!-- {{NOTES_IMAGE: subject for a note worth visualizing}} -->
      <figcaption>{{NOTES_IMAGE_CAPTION}}</figcaption>
    </figure>
  </section>

  <!-- ===== AMENDMENTS ===== -->
  <!-- Running history of changes made AFTER the plan was first executed. Append-only.
       Populated by the Update Plan and Update References workflows — never edited during Create. -->
  <section id="amendments">
    <h2>Amendments</h2>
    <!-- repeat: one entry per amendment, newest at the bottom -->
    <details>
      <summary>{{AMEND_ISO}} — {{AMEND_SUMMARY}}</summary>
      <p>{{AMEND_DETAIL: what changed and why}}</p>
    </details>
  </section>

</main>
</body>
</html>
```