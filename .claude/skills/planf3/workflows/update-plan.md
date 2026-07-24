# Update Plan

1. Identify the Plan - From the `USER_PROMPT`, locate the target plan `.html` file to modify
2. Scope the Change - THINK HARD about exactly what the prompt asks to change, extend, or revise; keep the edit surgical and touch only the affected sections
3. Apply the Change - Edit the relevant plan sections in place, preserving existing structure, content, and `{{...}}` conventions
   - If the change answers a blocking decision, flip its entry in `Decisions Required` from `[open]` to `[resolved: <choice>]` with who decided and when; if it introduces a new blocking decision, add it there `[open]` (see the Decisions vs. Questionables rule in the Instructions)
4. Update Metadata - Append the current ISO timestamp to `modified` and append the agent name / session id to their lists; never overwrite existing metadata entries
5. Record Amendment - Append a new entry to the Amendments section (newest at the bottom) summarizing what changed and why
6. Report - Summarize the change made and the amendment recorded
