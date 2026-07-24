# Build Plan

Task status markers: `[]` idle · `[wip]` in progress · `[x]` complete · `[f]` failed.

1. Locate the Plan - From the `USER_PROMPT`, resolve the path to the target plan `.html` file; if no path is given, infer the most likely plan from `PLAN_OUTPUT_DIRECTORY` and confirm before building
2. Absorb Context - Read the full plan: all embedded images, the metadata header, and every back reference (depth 1) so you fully understand prior/related work before writing code
3. Check Decisions Required - Scan the `<section id="decisions">` block BEFORE executing anything. If any decision is still `[open]`: ask the user to resolve it now (AskUserQuestion) if they own it, or — if it blocks only specific phases (`data-blocks`) and the owner isn't available — skip those phases, build the unblocked ones, and say so explicitly in the report. Never guess an `[open]` decision and never silently build a blocked phase. (Older plans without a decisions section: scan phase bodies for "DECISION NEEDED"/"blocking" language and treat matches the same way)
4. Execute Phases - For each phase in order, top to bottom:
   - Announce the phase you are starting
   - Set the phase and current task marker to `[wip]` in the plan file
   - Implement the task's specific actions
   - Run that phase's Testing Strategy commands; loop on failure until they pass
   - Mark each task `[x]` when complete or `[f]` if it cannot be made to pass, then move on
   - Do not start the next phase until the current phase's tasks and tests resolve
5. Final Validation - Run the global Validation Commands and confirm every box passes
6. Update Metadata - Append the current ISO timestamp to `modified`, append agent name / session id, and append the relevant commit SHA(s) to the metadata header
7. Report - Summarize what was built per phase, the final status of every task, any `[f]` failures that need attention, and any phases skipped because of an `[open]` decision (with the owner who needs to answer it)
