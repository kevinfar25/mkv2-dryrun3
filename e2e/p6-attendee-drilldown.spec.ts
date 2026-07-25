import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";

// P6 switch-on, driven in a REAL Chromium against a REAL Postgres:
//   1. RSVP a name on /events/<id> → it appears in [data-testid="attendee-list"] as an
//      [data-testid="attendee"] row, in the browser.
//   2. GET /api/events/<id>/attendees returns that name in JSON.
//   3. An event with NO RSVPs shows the empty-state (a message, not a bare empty list).
//   4. 42P01 DEGRADATION FOR REAL: `drop table attendees` in the live DB, then the detail
//      page must still be 200 + render the empty-state, and the attendees API must return
//      [] with 200 — never a 500. Then restore via POST /api/setup and re-confirm.
//
// Two isolation rules, because Playwright runs FILES in parallel and this DB is shared:
//   · This file RSVPs to event 2, never event 1 — e2e/p4-event-detail-rsvp.spec.ts owns
//     event 1 and asserts its count rises by EXACTLY one, so a stray RSVP there fails it.
//   · Test 4 drops a table, which no amount of per-event scoping can isolate. It is
//     therefore OPT-IN via E2E_DESTRUCTIVE=1 so a plain `npm run test:e2e` cannot yank
//     the schema out from under a concurrently-running spec. The switch-on run sets it.
// Within this file the tests share state, so they are SERIAL.
test.describe.configure({ mode: "serial" });

const EVENT_ID = process.env.E2E_EVENT_ID ?? "2";
// A second seeded event that is deliberately never RSVP'd — the empty-state fixture.
const EMPTY_EVENT_ID = process.env.E2E_EMPTY_EVENT_ID ?? "3";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
// The throwaway Docker Postgres backing the app under test (localhost:5446). Named, not
// derived from DATABASE_URL, so this spec can never reach for a shared or hosted DB.
const DB_CONTAINER = process.env.E2E_DB_CONTAINER ?? "mkv2-p6-db";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "";
const DESTRUCTIVE = process.env.E2E_DESTRUCTIVE === "1";

/** Run SQL directly against the throwaway container — used only to break the schema. */
function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();
}

const attendeeName = (label: string) => `Ada ${label} ${Date.now()}`;

function rows(page: Page) {
  return page.getByTestId("attendee-list").getByTestId("attendee");
}

test("RSVP puts the name in the attendee list, in the browser", async ({ page }) => {
  const name = attendeeName("browser");

  await page.goto(`/events/${EVENT_ID}`);
  await expect(page.getByTestId("event-title")).toBeVisible();
  // The list wrapper is present whether or not anybody has RSVP'd.
  await expect(page.getByTestId("attendee-list")).toBeVisible();
  // Counts are RELATIVE: this DB is re-used across runs, so "before" is not always 0.
  const before = await rows(page).count();

  await page.getByTestId("rsvp-name").fill(name);
  await page.getByTestId("rsvp-submit").click();

  // rsvp-form.tsx calls router.refresh(); the server component re-renders with the row.
  await expect(rows(page).filter({ hasText: name })).toHaveCount(1, { timeout: 10_000 });
  await expect(rows(page)).toHaveCount(before + 1);
  await expect(page.getByTestId("rsvp-error")).toHaveCount(0);
  // A real row exists, so the empty-state is gone.
  await expect(page.getByTestId("attendees-empty")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/p6-switchon-1-rsvp-in-list.png`, fullPage: true });

  // It is PERSISTED, not just optimistic client state.
  await page.reload();
  await expect(rows(page).filter({ hasText: name })).toHaveCount(1);

  // Most-recent-first: a second RSVP must land ABOVE the first.
  const later = attendeeName("second");
  await page.getByTestId("rsvp-name").fill(later);
  await page.getByTestId("rsvp-submit").click();
  await expect(rows(page)).toHaveCount(before + 2, { timeout: 10_000 });
  const texts = await rows(page).allInnerTexts();
  expect(texts[0]).toContain(later);
  expect(texts[1]).toContain(name);
  await page.screenshot({ path: `${SHOT_DIR}/p6-switchon-2-order.png`, fullPage: true });
});

test("GET /api/events/<id>/attendees returns the RSVP'd names as JSON", async ({
  page,
  request,
}) => {
  // Read the names the browser is currently showing, then assert the API agrees — same
  // names, same most-recent-first order.
  await page.goto(`/events/${EVENT_ID}`);
  const shown = (await page.getByTestId("attendee-name").allInnerTexts()).map((s) => s.trim());
  expect(shown.length).toBeGreaterThan(0);

  const res = await request.get(`/api/events/${EVENT_ID}/attendees`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body.map((a: { name: string }) => a.name)).toEqual(shown);
  // The shape the phase task specifies: {name, createdAt}.
  for (const attendee of body) {
    expect(typeof attendee.name).toBe("string");
    expect(Number.isNaN(Date.parse(attendee.createdAt))).toBe(false);
  }
});

test("an event with no RSVPs shows the empty-state", async ({ page, request }) => {
  const res = await page.goto(`/events/${EMPTY_EVENT_ID}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("attendee-list")).toBeVisible();
  await expect(page.getByTestId("attendees-empty")).toBeVisible();
  // A MESSAGE, not a silently empty list.
  await expect(page.getByTestId("attendees-empty")).not.toBeEmpty();
  await expect(page.getByTestId("attendee")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/p6-switchon-3-empty-state.png`, fullPage: true });

  const api = await request.get(`/api/events/${EMPTY_EVENT_ID}/attendees`);
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual([]);
});

test("42P01: dropping `attendees` degrades to the empty-state + [], never a 500", async ({
  page,
  request,
}) => {
  test.skip(!DESTRUCTIVE, "drops a shared table — opt in with E2E_DESTRUCTIVE=1");
  expect(SETUP_TOKEN, "SETUP_TOKEN must be set to restore the schema").not.toBe("");
  // DB-SENTINEL: only ever the local throwaway container.
  expect(psql("select current_database()")).toBe("postgres");
  expect(psql("select count(*) from attendees")).not.toBe("");

  psql("drop table attendees");
  expect(psql("select to_regclass('public.attendees') is null")).toBe("t");

  try {
    // The PAGE still renders — 200, empty-state, no crash.
    const res = await page.goto(`/events/${EVENT_ID}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("event-title")).toBeVisible();
    await expect(page.getByTestId("attendees-empty")).toBeVisible();
    await expect(page.getByTestId("attendee")).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/p6-switchon-4-42P01-dropped.png`, fullPage: true });

    // The API returns [] with 200 — explicitly NOT a 500.
    const api = await request.get(`/api/events/${EVENT_ID}/attendees`);
    expect(api.status()).toBe(200);
    expect(await api.json()).toEqual([]);
  } finally {
    // Restore through the real mechanism the deploy uses.
    const setup = await request.post("/api/setup", {
      headers: { "x-setup-token": SETUP_TOKEN, "content-type": "application/json" },
      data: { seed: true },
    });
    expect(setup.status()).toBe(200);
  }

  expect(psql("select to_regclass('public.attendees') is null")).toBe("f");

  // RE-CONFIRM after restore: the table is back and the flow works end to end again.
  const name = attendeeName("restored");
  await page.goto(`/events/${EVENT_ID}`);
  await page.getByTestId("rsvp-name").fill(name);
  await page.getByTestId("rsvp-submit").click();
  await expect(rows(page).filter({ hasText: name })).toHaveCount(1, { timeout: 10_000 });
  await page.screenshot({ path: `${SHOT_DIR}/p6-switchon-5-restored.png`, fullPage: true });

  const api = await request.get(`/api/events/${EVENT_ID}/attendees`);
  expect(api.status()).toBe(200);
  expect((await api.json()).map((a: { name: string }) => a.name)).toContain(name);
});
