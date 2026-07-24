come up with a plan to test the code you created. also come up with a plan to review this code that's working against the original plan you created.

use the playwright mcp to open up non headless browser instances and click/type/test all the stuff that needs to be tested.

THIS NEEDS TO BE PROPER FUNCTIONAL TESTING. JUST SEEING AN ITEM EXISTS IS NOT A TEST. NO SURFACE LEVEL VISUAL CHECKS. YOU MUST CLICK THROUGH FLOWS, SUBMIT FORMS AND VERIFY FUNCTIONALITY END TO END.

PROPER FUNCTIONAL TESTING - FOR EXAMPLE (DEPENDING ON WHAT YOU JUST BUILT) THIS MIGHT INCLUDE: actually generating content, saving drafts, using the Comment Keyword CTA, verifying the research page no longer crashes, and testing the full transcript extraction.

then come up with a report of how things are working and what things need to be fixed.

then use subagents to fix these issues.

read the .claude/commands/subagents.md file for this and use the info in here.

after they fixes complete, rerun the test-review.md file (this file to ensure stuff has been fixed roperly)

itearte this process as many times as needed to ensure this is production-ready and ready to be tested