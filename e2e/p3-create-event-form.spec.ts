import { expect, test, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";

// P3 switch-on: a REAL browser fills the /new form, lands on the created event's detail
// page, and the event shows up on the home list. Invalid submits must show the inline
// error AND create nothing — proven by an event-count delta of zero, not by eyeballing.
//
// Several tests CREATE events, and each one deletes the row it made so the suite is
// re-runnable. That cleanup needs a direct DB connection, and writing to the DB behind a
// deployment is only ever acceptable against a local throwaway Postgres — so the whole
// file is skipped unless DATABASE_URL points at localhost. Otherwise `npm run test:e2e`
// aimed at the hosted URL (the prod back-gate) would permanently add junk rows to it.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const LOCAL_DB = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

test.skip(
  !LOCAL_DB,
  "needs DATABASE_URL pointing at a local throwaway Postgres (these tests write to it)",
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
  max: 2,
});

test.afterAll(async () => {
  await pool.end();
});

/** Remove the rows a test created, identified by its unique title. */
async function deleteEventsByTitle(title: string): Promise<void> {
  await pool.query(
    "delete from attendees where event_id in (select id from events where title = $1)",
    [title],
  );
  await pool.query("delete from events where title = $1", [title]);
}

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

  try {
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
  } finally {
    await deleteEventsByTitle(title);
  }
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

test("a double submit creates exactly one event", async ({ page, request }) => {
  // Regression: `pending` is async state, so two submits could enter the handler before the
  // button disabled and fire two independent POSTs — and creation is intentionally non-unique.
  const before = await eventCount(request);
  const title = `P3 Double Submit ${Date.now()}`;

  try {
    await page.goto("/new");
    await page.getByTestId("create-title").fill(title);
    await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
    await page.getByTestId("create-location").fill("Valletta HQ — Room 2");

    // Two submits back-to-back, dispatched in ONE task so React cannot re-render in between —
    // this is the race a human double-click only sometimes wins.
    await page.getByTestId("create-form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });

    await page.waitForURL(/\/events\/\d+$/);

    const after = await eventCount(request);
    console.log(`[p3] double submit: events before=${before} after=${after}`);
    expect(after).toBe(before + 1);

    // …and exactly one row bears the unique title.
    const res = await request.get("/api/events");
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.filter((e) => e.title === title)).toHaveLength(1);
  } finally {
    await deleteEventsByTitle(title);
  }
});

test("submits during the route transition still create exactly one event", async ({
  page,
  request,
}) => {
  // Regression for the NAVIGATION window specifically: App Router `router.push()` is async,
  // so the form stays mounted and interactive after a successful POST. If the submit lock is
  // released on the success path, a submit landing in that window creates a SECOND event.
  const before = await eventCount(request);
  const title = `P3 Nav Window ${Date.now()}`;

  try {
    await page.goto("/new");
    await page.getByTestId("create-title").fill(title);
    await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
    await page.getByTestId("create-location").fill("Valletta HQ — Room 2");

    await page.getByTestId("create-form").evaluate((form: HTMLFormElement) => {
      // Fire another submit the instant the POST response resolves — after the fetch settles
      // but before `router.push()` has finished navigating. That is the exact race window.
      const realFetch = window.fetch;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const res = await realFetch(...args);
        queueMicrotask(() => form.requestSubmit());
        setTimeout(() => form.requestSubmit(), 0);
        return res;
      };

      // …plus the same-task double submit, and a hammer across the whole transition.
      form.requestSubmit();
      form.requestSubmit();
      for (let i = 1; i <= 40; i++) setTimeout(() => form.requestSubmit(), i * 50);
    });

    await page.waitForURL(/\/events\/\d+$/);
    // Give any straggling in-flight resubmit time to have landed before counting.
    await page.waitForTimeout(2000);

    const after = await eventCount(request);
    console.log(`[p3] nav-window resubmits: events before=${before} after=${after}`);
    expect(after).toBe(before + 1);

    const res = await request.get("/api/events");
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.filter((e) => e.title === title)).toHaveLength(1);
  } finally {
    await deleteEventsByTitle(title);
  }
});

test("after a 400 the form recovers and submits successfully once corrected", async ({
  page,
  request,
}) => {
  // The success path holds the submit lock forever on purpose — this proves the FAILURE
  // paths still release it, so a 400 does not wedge the form.
  const before = await eventCount(request);
  const title = `P3 Recovery After 400 ${Date.now()}`;

  try {
    await page.goto("/new");
    await page.getByTestId("create-title").fill("");
    await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
    await page.getByTestId("create-location").fill("Valletta HQ — Room 2");
    await page.getByTestId("create-submit").click();

    await expect(page.getByTestId("form-error")).toBeVisible();
    await expect(page).toHaveURL(/\/new$/);
    // The button must be interactive again, not stuck in "Creating…".
    await expect(page.getByTestId("create-submit")).toBeEnabled();

    await page.getByTestId("create-title").fill(title);
    await page.getByTestId("create-submit").click();

    await page.waitForURL(/\/events\/\d+$/);
    await expect(page.getByTestId("event-title")).toHaveText(title);

    const after = await eventCount(request);
    console.log(`[p3] recovery after 400: events before=${before} after=${after}`);
    expect(after).toBe(before + 1);
  } finally {
    await deleteEventsByTitle(title);
  }
});

test("after a network error the form recovers and submits successfully", async ({
  page,
  request,
}) => {
  const before = await eventCount(request);
  const title = `P3 Recovery After Network Error ${Date.now()}`;

  try {
    // Kill only the FIRST POST, so the retry hits the real route.
    let killed = false;
    await page.route("**/api/events", async (route) => {
      if (route.request().method() === "POST" && !killed) {
        killed = true;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });

    await page.goto("/new");
    await page.getByTestId("create-title").fill(title);
    await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
    await page.getByTestId("create-location").fill("Valletta HQ — Room 2");
    await page.getByTestId("create-submit").click();

    await expect(page.getByTestId("form-error")).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeEnabled();

    await page.getByTestId("create-submit").click();
    await page.waitForURL(/\/events\/\d+$/);
    await expect(page.getByTestId("event-title")).toHaveText(title);

    const after = await eventCount(request);
    console.log(`[p3] recovery after network error: events before=${before} after=${after}`);
    expect(after).toBe(before + 1);
  } finally {
    await deleteEventsByTitle(title);
  }
});

test("after a malformed response the form recovers and submits successfully", async ({
  page,
  request,
}) => {
  const title = `P3 Recovery After Malformed ${Date.now()}`;

  try {
    // First POST answers 201 with an unusable id; the retry goes to the real route.
    let mangled = false;
    await page.route("**/api/events", async (route) => {
      if (route.request().method() === "POST" && !mangled) {
        mangled = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ event: { id: "not-a-number" } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/new");
    await page.getByTestId("create-title").fill(title);
    await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
    await page.getByTestId("create-location").fill("Valletta HQ — Room 2");
    await page.getByTestId("create-submit").click();

    await expect(page.getByTestId("form-error")).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeEnabled();

    await page.getByTestId("create-submit").click();
    await page.waitForURL(/\/events\/\d+$/);
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // The intercepted first attempt never reached the DB, so exactly one row exists.
    const res = await request.get("/api/events");
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.filter((e) => e.title === title)).toHaveLength(1);
  } finally {
    await deleteEventsByTitle(title);
  }
});

test("typing into the title clears a server validation error", async ({ page }) => {
  await page.goto("/new");
  await page.getByTestId("create-title").fill("");
  await page.getByTestId("create-starts-at").fill("2026-09-15T18:30");
  await page.getByTestId("create-location").fill("Somewhere");
  await page.getByTestId("create-submit").click();

  await expect(page.getByTestId("form-error")).toBeVisible();

  // Correcting the offending field must retire the stale error immediately, not on next submit.
  await page.getByTestId("create-title").fill("Now it has a title");
  await expect(page.getByTestId("form-error")).toHaveCount(0);
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
