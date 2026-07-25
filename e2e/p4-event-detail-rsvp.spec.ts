import { test, expect, type Page } from "@playwright/test";

// P4 switch-on, driven in a REAL Chromium: open a seeded event's detail page, RSVP a
// name, assert the summary count RISES, then re-submit the SAME name (different case)
// and assert it does NOT rise and does NOT error — the unique index makes a repeat
// RSVP a no-op, not a 500.

const EVENT_ID = process.env.E2E_EVENT_ID ?? "1";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";

/** "No RSVPs yet" -> 0 · "1 going" -> 1 · "7 going" -> 7 */
function countFromSummary(text: string): number {
  if (/no rsvps yet/i.test(text)) return 0;
  const match = text.match(/^(\d+) going/);
  if (!match) throw new Error(`unparseable rsvp summary: ${JSON.stringify(text)}`);
  return Number(match[1]);
}

async function summaryCount(page: Page): Promise<number> {
  return countFromSummary((await page.getByTestId("rsvp-summary").innerText()).trim());
}

test("detail page: RSVP raises the count; a duplicate RSVP is a no-op", async ({
  page,
}) => {
  // A fresh name per run so the test is re-runnable against a DB that already has RSVPs.
  const name = `Ada ${Date.now()}`;

  await page.goto(`/events/${EVENT_ID}`);
  await expect(page.getByTestId("event-title")).toBeVisible();
  await expect(page.getByTestId("event-starts-at")).not.toBeEmpty();

  const before = await summaryCount(page);
  await page.screenshot({ path: `${SHOT_DIR}/p4-rsvp-1-before.png`, fullPage: true });

  // --- first RSVP: the count must rise by exactly one -----------------------
  await page.getByTestId("rsvp-name").fill(name);
  await page.getByTestId("rsvp-submit").click();
  await expect
    .poll(async () => summaryCount(page), { timeout: 10_000 })
    .toBe(before + 1);
  await expect(page.getByTestId("rsvp-error")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/p4-rsvp-2-after.png`, fullPage: true });

  // --- duplicate RSVP (same name, different case): no-op, no error ----------
  await page.getByTestId("rsvp-name").fill(name.toUpperCase());
  await page.getByTestId("rsvp-submit").click();
  await expect(page.getByTestId("rsvp-name")).toHaveValue("");
  await expect(page.getByTestId("rsvp-error")).toHaveCount(0);
  await page.waitForTimeout(1_000); // give a (wrong) increment time to show up
  expect(await summaryCount(page)).toBe(before + 1);
  await page.screenshot({ path: `${SHOT_DIR}/p4-rsvp-3-duplicate.png`, fullPage: true });

  // The page survives a reload with the persisted count.
  await page.reload();
  expect(await summaryCount(page)).toBe(before + 1);
});

test("empty name is rejected inline and does not RSVP", async ({ page }) => {
  await page.goto(`/events/${EVENT_ID}`);
  const before = await summaryCount(page);

  await page.getByTestId("rsvp-name").fill("   ");
  await page.getByTestId("rsvp-submit").click();
  await expect(page.getByTestId("rsvp-error")).toBeVisible();
  expect(await summaryCount(page)).toBe(before);
});

test("a missing event id 404s", async ({ page }) => {
  const res = await page.goto("/events/99999999");
  expect(res?.status()).toBe(404);
});
