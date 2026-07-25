import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";

// P2 gate: events list page + /api/events, driven in a REAL browser against a live DB.
// Mutating tests (empty state, created events) restore what they touched, so the suite is
// re-runnable. Run with --workers=1: several tests write to the shared events table.
//
// These tests assert the page against the DB directly, and the empty-state one DELETES
// every row before restoring it. That is only ever acceptable against a local throwaway
// Postgres, so the whole file is skipped unless DATABASE_URL points at localhost —
// otherwise `npm run test:e2e` aimed at a hosted URL (the prod back-gate) would try to
// wipe that deployment's data.
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

type DbEvent = {
  id: number;
  title: string;
  starts_at: Date;
  location: string;
  created_at: Date;
};

async function dbEvents(): Promise<DbEvent[]> {
  const { rows } = await pool.query<DbEvent>(
    "select id, title, starts_at, location, created_at from events order by created_at desc, id desc",
  );
  return rows;
}

async function rowTitles(page: Page): Promise<string[]> {
  return page.locator('[data-testid="event-row"] td:first-child a').allTextContents();
}

/** A strict ISO-8601 instant with millisecond precision and a Z suffix. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── 1. list rendering + ordering ───────────────────────────────────────────────

test("home page renders every seeded event in events-list, newest-first", async ({ page }) => {
  const expected = await dbEvents();
  expect(expected.length, "seeded DB must have events for this gate").toBeGreaterThan(1);

  await page.goto("/");

  const list = page.getByTestId("events-list");
  await expect(list).toBeVisible();
  await expect(page.getByTestId("events-empty")).toHaveCount(0);

  const rows = page.getByTestId("event-row");
  await expect(rows).toHaveCount(expected.length);

  // Exact DOM order must equal the DB's newest-first order — not just "contains".
  expect(await rowTitles(page)).toEqual(expected.map((e) => e.title));

  // Each row carries the right link target and a machine-readable ISO timestamp.
  for (const [i, event] of expected.entries()) {
    const row = rows.nth(i);
    await expect(row.locator("td:first-child a")).toHaveAttribute(
      "href",
      `/events/${event.id}`,
    );
    const dateTime = await row.locator("time").getAttribute("dateTime");
    expect(dateTime, `row ${i} <time dateTime>`).toMatch(ISO);
    expect(new Date(dateTime!).toISOString()).toBe(dateTime);
    expect(new Date(dateTime!).getTime()).toBe(event.starts_at.getTime());
    await expect(row.locator("td").nth(2)).toHaveText(event.location);
  }
});

// ── 2. rows really navigate to P4's detail page, and the RSVP write path works ─

test("clicking a row navigates to a working P4 detail page and an RSVP increments the count", async ({
  page,
}) => {
  const [newest] = await dbEvents();
  await page.goto("/");

  await page.locator('[data-testid="event-row"] td:first-child a').first().click();

  await expect(page).toHaveURL(new RegExp(`/events/${newest.id}$`));
  await expect(page.getByTestId("event-title")).toHaveText(newest.title);
  await expect(page.getByTestId("event-location")).toHaveText(newest.location);
  await expect(page.getByTestId("app-error")).toHaveCount(0);

  const summary = page.getByTestId("rsvp-summary");
  await expect(summary).toBeVisible();
  const before = Number(
    await pool
      .query<{ c: string }>("select count(*)::text as c from attendees where event_id = $1", [
        newest.id,
      ])
      .then((r) => r.rows[0].c),
  );

  const name = `Gate Tester ${Date.now()}`;
  await page.getByTestId("rsvp-name").fill(name);
  await page.getByTestId("rsvp-submit").click();

  // The server component re-renders via router.refresh(); the summary must show the new count.
  await expect(summary).toContainText(String(before + 1));
  await expect(page.getByTestId("rsvp-error")).toHaveCount(0);
  const after = await pool.query("select 1 from attendees where event_id = $1 and name = $2", [
    newest.id,
    name,
  ]);
  expect(after.rowCount, "RSVP must be persisted").toBe(1);

  // The shared top nav from app/layout.tsx must get us back to the list.
  await page.getByTestId("top-nav").getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("events-list")).toBeVisible();

  // Clean up this test's attendee so the suite is re-runnable.
  await pool.query("delete from attendees where name = $1", [name]);
});

test("every row on the list resolves to its own detail page", async ({ page }) => {
  const expected = await dbEvents();

  for (const [i, event] of expected.entries()) {
    await page.goto("/");
    await page.locator('[data-testid="event-row"] td:first-child a').nth(i).click();
    await expect(page).toHaveURL(new RegExp(`/events/${event.id}$`));
    await expect(page.getByTestId("event-title")).toHaveText(event.title);
    // Not a 404 and not the error boundary.
    await expect(page.getByTestId("rsvp-form")).toBeVisible();
  }
});

test("the shared top nav is on every page and links Home", async ({ page }) => {
  const [event] = await dbEvents();

  for (const path of ["/", `/events/${event.id}`]) {
    await page.goto(path);
    const nav = page.getByTestId("top-nav");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  }
});

// ── 3. GET /api/events ─────────────────────────────────────────────────────────

test("GET /api/events returns the right shape, order and genuine ISO timestamps", async ({
  request,
}) => {
  const expected = await dbEvents();
  const res = await request.get("/api/events");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");

  const body = (await res.json()) as { events: Record<string, unknown>[] };
  expect(Object.keys(body)).toEqual(["events"]);
  expect(body.events).toHaveLength(expected.length);

  body.events.forEach((event, i) => {
    expect(Object.keys(event).sort()).toEqual([
      "created_at",
      "id",
      "location",
      "starts_at",
      "title",
    ]);
    expect(event.id).toBe(expected[i].id);
    expect(event.title).toBe(expected[i].title);
    expect(event.location).toBe(expected[i].location);

    // Genuine ISO strings — NOT a stringified Date ("Tue Aug 04 2026 ...") and not a
    // pg timestamp ("2026-08-04 17:00:00+00").
    for (const key of ["starts_at", "created_at"] as const) {
      const value = event[key];
      expect(typeof value, `${key} must be a string`).toBe("string");
      expect(value as string, `${key} must be strict ISO`).toMatch(ISO);
      expect(new Date(value as string).toISOString()).toBe(value);
    }
    expect(new Date(event.starts_at as string).getTime()).toBe(expected[i].starts_at.getTime());
  });

  // Ordering is genuinely descending by created_at, then id.
  const keys = body.events.map((e) => [
    new Date(e.created_at as string).getTime(),
    e.id as number,
  ]);
  for (let i = 1; i < keys.length; i++) {
    const [prevTs, prevId] = keys[i - 1];
    const [ts, id] = keys[i];
    expect(prevTs > ts || (prevTs === ts && prevId > id)).toBe(true);
  }
});

// ── 4. POST /api/events happy path, end to end through the browser ─────────────

test("POST /api/events creates an event that appears first on the list and opens", async ({
  page,
  request,
}) => {
  const created = `Gate Created ${Date.now()}`;
  const res = await request.post("/api/events", {
    data: {
      title: `  ${created}  `, // must be trimmed by the schema
      startsAt: "2026-12-01T18:30:00.000Z",
      location: "  Gate Hall  ",
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as { event: Record<string, unknown> };
  expect(Object.keys(body)).toEqual(["event"]);
  const event = body.event;
  expect(Object.keys(event).sort()).toEqual([
    "created_at",
    "id",
    "location",
    "starts_at",
    "title",
  ]);
  expect(typeof event.id).toBe("number");
  expect(event.title).toBe(created);
  expect(event.location).toBe("Gate Hall");
  expect(event.starts_at).toBe("2026-12-01T18:30:00.000Z");
  expect(event.created_at as string).toMatch(ISO);

  const id = event.id as number;
  try {
    // It is really in the DB with the trimmed values.
    const row = await pool.query<DbEvent>("select * from events where id = $1", [id]);
    expect(row.rows[0].title).toBe(created);

    // Newest-first is proven by a WRITE, not just by the seed order.
    await page.goto("/");
    const titles = await rowTitles(page);
    expect(titles[0]).toBe(created);

    // And the freshly created row's link resolves.
    await page.locator('[data-testid="event-row"] td:first-child a').first().click();
    await expect(page).toHaveURL(new RegExp(`/events/${id}$`));
    await expect(page.getByTestId("event-title")).toHaveText(created);
    await expect(page.getByTestId("event-location")).toHaveText("Gate Hall");
  } finally {
    await pool.query("delete from attendees where event_id = $1", [id]);
    await pool.query("delete from sessions where event_id = $1", [id]);
    await pool.query("delete from events where id = $1", [id]);
  }
});

// ── 5. POST /api/events rejection matrix ──────────────────────────────────────

const LONG = (n: number) => "x".repeat(n);
const VALID = {
  title: "Valid",
  startsAt: "2026-12-01T18:30:00.000Z",
  location: "Somewhere",
};

// `expected` is the substring the returned `errors[]` must mention, so a case cannot pass
// for the wrong reason (e.g. the whole body being rejected as "expected object").
const INVALID: Array<{ name: string; data: unknown; expected: string }> = [
  { name: "missing title", data: { startsAt: VALID.startsAt, location: VALID.location }, expected: "title: Invalid input: expected string, received undefined" },
  { name: "missing startsAt", data: { title: VALID.title, location: VALID.location }, expected: "startsAt: startsAt must be an ISO 8601 datetime" },
  { name: "missing location", data: { title: VALID.title, startsAt: VALID.startsAt }, expected: "location: Invalid input: expected string, received undefined" },
  { name: "empty body object", data: {}, expected: "title: Invalid input: expected string, received undefined" },
  { name: "empty title", data: { ...VALID, title: "" }, expected: "title: title is required" },
  { name: "whitespace-only title", data: { ...VALID, title: "   " }, expected: "title: title is required" },
  { name: "whitespace-only location", data: { ...VALID, location: "  \t " }, expected: "location: location is required" },
  { name: "title over 120 chars", data: { ...VALID, title: LONG(121) }, expected: "title: title must be 120 characters or fewer" },
  { name: "location over 160 chars", data: { ...VALID, location: LONG(161) }, expected: "location: location must be 160 characters or fewer" },
  { name: "title wrong type (number)", data: { ...VALID, title: 42 }, expected: "title: Invalid input: expected string, received number" },
  { name: "title wrong type (null)", data: { ...VALID, title: null }, expected: "title: Invalid input: expected string, received null" },
  { name: "title wrong type (array)", data: { ...VALID, title: ["a"] }, expected: "title: Invalid input: expected string, received array" },
  { name: "title wrong type (boolean)", data: { ...VALID, title: true }, expected: "title: Invalid input: expected string, received boolean" },
  { name: "location wrong type (object)", data: { ...VALID, location: { a: 1 } }, expected: "location: Invalid input: expected string, received object" },
  { name: "startsAt wrong type (number)", data: { ...VALID, startsAt: 1764614400000 }, expected: "startsAt: startsAt must be an ISO 8601 datetime" },
  { name: "startsAt not a date", data: { ...VALID, startsAt: "not-a-date" }, expected: "startsAt: startsAt must be an ISO 8601 datetime" },
  { name: "startsAt without offset", data: { ...VALID, startsAt: "2026-12-01T18:30:00" }, expected: "startsAt: startsAt must be an ISO 8601 datetime" },
  { name: "startsAt date only", data: { ...VALID, startsAt: "2026-12-01" }, expected: "startsAt: startsAt must be an ISO 8601 datetime" },
  { name: "startsAt year 0000", data: { ...VALID, startsAt: "0000-01-01T00:00:00.000Z" }, expected: "startsAt must be year 0001 or later" },
  { name: "startsAt offset beyond +15:59", data: { ...VALID, startsAt: "2026-12-01T18:30:00+16:00" }, expected: "UTC offset within +/-15:59" },
  { name: "title with NUL byte", data: { ...VALID, title: "bad\u0000title" }, expected: "title: title must not contain a NUL character" },
  { name: "location with NUL byte", data: { ...VALID, location: "bad\u0000place" }, expected: "location: location must not contain a NUL character" },
  { name: "body is a JSON string", data: "not an object", expected: "expected object, received string" },
  { name: "body is a JSON array", data: [VALID], expected: "expected object, received array" },
  { name: "body is JSON null", data: null, expected: "expected object, received null" },
  { name: "body is a JSON number", data: 7, expected: "expected object, received number" },
  { name: "body is JSON true", data: true, expected: "expected object, received boolean" },
];

/**
 * Send a RAW body. Playwright re-serializes a string `data` when content-type is
 * application/json, so `JSON.stringify(x)` would arrive DOUBLE-encoded and every case
 * would 400 as "expected object, received string" — passing for the wrong reason.
 * A Buffer is sent through untouched.
 */
function rawBody(value: string) {
  return {
    headers: { "content-type": "application/json" },
    data: Buffer.from(value, "utf8"),
  };
}

test("POST /api/events answers 400 on every invalid body and creates nothing", async ({
  request,
}) => {
  const before = (await dbEvents()).map((e) => e.id).sort();

  for (const { name, data, expected } of INVALID) {
    const res = await request.post("/api/events", rawBody(JSON.stringify(data)));
    expect(res.status(), `${name} must be 400, not ${res.status()}`).toBe(400);
    const body = (await res.json()) as { error?: string; errors?: string[] };
    expect(body.error, name).toBe("invalid input");
    // The message must name the field/rule actually under test.
    expect((body.errors ?? []).join(" | "), `${name} → wrong rejection reason`).toContain(
      expected,
    );
  }

  // Malformed JSON is a client error too, not a 500.
  for (const bad of ["{", "{ not json }", "", "undefined", "{'a':1}"]) {
    const res = await request.post("/api/events", rawBody(bad));
    expect(res.status(), `malformed body ${JSON.stringify(bad)} must be 400`).toBe(400);
    expect((await res.json()).error, JSON.stringify(bad)).toBe("invalid JSON body");
  }

  const after = (await dbEvents()).map((e) => e.id).sort();
  expect(after, "no rejected request may have written a row").toEqual(before);
});

test("POST /api/events accepts the exact boundary values (limits are not off by one)", async ({
  request,
}) => {
  const accepted: Array<{ name: string; data: Record<string, unknown> }> = [
    { name: "title exactly 120 chars", data: { ...VALID, title: LONG(120) } },
    { name: "location exactly 160 chars", data: { ...VALID, location: LONG(160) } },
    {
      name: "startsAt offset exactly +15:59",
      data: { ...VALID, startsAt: "2026-12-01T18:30:00+15:59" },
    },
    {
      name: "startsAt with a negative offset",
      data: { ...VALID, startsAt: "2026-12-01T18:30:00-05:00" },
    },
  ];

  const ids: number[] = [];
  try {
    for (const { name, data } of accepted) {
      const res = await request.post("/api/events", rawBody(JSON.stringify(data)));
      expect(res.status(), `${name} must be 201, not ${res.status()}`).toBe(201);
      const event = (await res.json()).event as Record<string, unknown>;
      expect(event.starts_at as string, name).toMatch(ISO);
      ids.push(event.id as number);
    }
  } finally {
    if (ids.length > 0) {
      await pool.query("delete from attendees where event_id = any($1::int[])", [ids]);
      await pool.query("delete from sessions where event_id = any($1::int[])", [ids]);
      await pool.query("delete from events where id = any($1::int[])", [ids]);
    }
  }
});

// ── 6. empty state ────────────────────────────────────────────────────────────

test("the empty state renders when there are no events, and the list returns afterwards", async ({
  page,
  request,
}) => {
  const snapshot = await dbEvents();
  const attendees = await pool.query<{
    id: number;
    event_id: number;
    name: string;
    created_at: Date;
  }>("select id, event_id, name, created_at from attendees");

  try {
    await pool.query("delete from attendees");
    // X1 adds `sessions`, a child of events. Its FK has no ON DELETE CASCADE (matching
    // attendees and waitlist), and the migration gives every pre-existing event a
    // General Admission session — so without this the wholesale delete below raises
    // sessions_event_id_fkey and the snapshot restore then fails on a duplicate key.
    await pool.query("delete from sessions");
    await pool.query("delete from events");

    await page.goto("/");
    await expect(page.getByTestId("events-empty")).toBeVisible();
    await expect(page.getByTestId("events-empty")).toHaveText("No events yet.");
    await expect(page.getByTestId("events-list")).toHaveCount(0);
    await expect(page.getByTestId("event-row")).toHaveCount(0);
    // The page is still a working page, not the error boundary.
    await expect(page.getByTestId("app-error")).toHaveCount(0);
    await expect(page.getByTestId("top-nav")).toBeVisible();

    const res = await request.get("/api/events");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  } finally {
    for (const e of snapshot) {
      await pool.query(
        "insert into events (id, title, starts_at, location, created_at) values ($1,$2,$3,$4,$5)",
        [e.id, e.title, e.starts_at, e.location, e.created_at],
      );
    }
    for (const a of attendees.rows) {
      await pool.query(
        "insert into attendees (id, event_id, name, created_at) values ($1,$2,$3,$4)",
        [a.id, a.event_id, a.name, a.created_at],
      );
    }
    // Keep the serial sequences ahead of the restored ids so later inserts still work.
    await pool.query(
      "select setval('events_id_seq', coalesce((select max(id) from events), 1))",
    );
    await pool.query(
      "select setval('attendees_id_seq', coalesce((select max(id) from attendees), 1))",
    );
  }

  // Restored: the list is back exactly as it was.
  await page.goto("/");
  await expect(page.getByTestId("events-list")).toBeVisible();
  expect(await rowTitles(page)).toEqual(snapshot.map((e) => e.title));
});
