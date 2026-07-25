import { expect, test, type APIRequestContext } from "@playwright/test";

// P3 switch-on: a REAL browser fills the /new form, lands on the created event's detail
// page, and the event shows up on the home list. Invalid submits must show the inline
// error AND create nothing — proven by an event-count delta of zero, not by eyeballing.

async function eventCount(request: APIRequestContext): Promise<number> {
  const res = await request.get("/api/events");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { events: unknown[] };
  return body.events.length;
}

test("create an event from /new, land on its detail page, and see it on the home list", async ({
  page,
}) => {
  // Unique per run so the assertions can't pass on a leftover row from an earlier run.
  const title = `P3 Switch-On Event ${Date.now()}`;
  const location = "Valletta HQ — Room 2";

  await page.goto("/new");
  await expect(page.getByTestId("new-event")).toBeVisible();

  await page.getByTestId("create-title").fill(title);
  await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
  await page.getByTestId("create-location").fill(location);
  await page.getByTestId("create-submit").click();

  // 201 → routed to /events/<id> for the row that was just created.
  await page.waitForURL(/\/events\/\d+$/);
  const id = Number(new URL(page.url()).pathname.split("/").pop());
  expect(Number.isInteger(id)).toBe(true);
  await expect(page.getByTestId("event-title")).toHaveText(title);
  await page.screenshot({ path: "/tmp/p3-switchon-detail.png", fullPage: true });

  // …and it is on the home list.
  await page.goto("/");
  const list = page.getByTestId("events-list");
  await expect(list).toBeVisible();
  await expect(list.getByRole("link", { name: title })).toBeVisible();
  await page.screenshot({ path: "/tmp/p3-switchon-home.png", fullPage: true });
});

test("an empty title shows the inline error and creates nothing", async ({ page, request }) => {
  const before = await eventCount(request);

  await page.goto("/new");
  await page.getByTestId("create-title").fill("");
  await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
  await page.getByTestId("create-location").fill("Somewhere");
  await page.getByTestId("create-submit").click();

  await expect(page.getByTestId("form-error")).toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
  await page.screenshot({ path: "/tmp/p3-switchon-error-title.png", fullPage: true });

  const after = await eventCount(request);
  console.log(`[p3] empty-title invalid submit: events before=${before} after=${after}`);
  expect(after).toBe(before);
});

test("an empty starts-at shows the inline error and creates nothing", async ({ page, request }) => {
  const before = await eventCount(request);

  await page.goto("/new");
  await page.getByTestId("create-title").fill("Event with no date");
  await page.getByTestId("create-starts-at").fill("");
  await page.getByTestId("create-location").fill("Somewhere");
  await page.getByTestId("create-submit").click();

  await expect(page.getByTestId("form-error")).toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
  await page.screenshot({ path: "/tmp/p3-switchon-error-date.png", fullPage: true });

  const after = await eventCount(request);
  console.log(`[p3] empty-date invalid submit: events before=${before} after=${after}`);
  expect(after).toBe(before);
});
