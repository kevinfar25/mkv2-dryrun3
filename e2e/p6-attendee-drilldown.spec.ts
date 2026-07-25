import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";

// P6 switch-on: the attendee drill-down, driven in a REAL Chromium against a REAL Postgres.
// Covered here, end to end:
//   1. RSVP typed into the real form → the row appears in [data-testid="attendee-list"] as an
//      [data-testid="attendee"]; a second RSVP lands ABOVE it (most-recent-first); a reload
//      proves it is persisted; a case-variant duplicate does NOT add a row; P4's rsvp-summary
//      tracks the same writes.
//   2. Attendee names are ESCAPED — several XSS payloads render as literal text, nothing is
//      injected into the list, no dialog fires and no page error is raised.
//   3. Bad ids 404 on BOTH the page and the attendees route, never 500 (and a good id is
//      still 200 on both, so the guard is not a blanket 404).
//   4. The ATTENDEE_PAGE_LIMIT = 200 cap and its [data-testid="attendee-truncated"] notice at
//      n = 0, 1, exactly 200 and 250.
//   5. 42P01 DEGRADATION FOR REAL: `drop table attendees` in the live DB, then the detail page
//      must still be 200 + render the empty-state and the attendees API must return [] with
//      200 — never a 500. Then restore via POST /api/setup and re-confirm the flow.
//   6. P2/P3/P4 regression: the home list and the /new create form still work, and a fresh
//      event created through the form shows P6's empty-state and accepts an RSVP.
//
// These tests WRITE to the database, so — exactly like e2e/p2-events-list.spec.ts and
// e2e/p3-create-event-form.spec.ts — the whole file is skipped unless DATABASE_URL points at
// localhost. Otherwise `npm run test:e2e` aimed at the hosted URL (the prod back-gate, which
// CLAUDE.md says runs the full write-bearing pass against PRODUCTION) would permanently add
// junk attendee rows to that deployment's data.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const LOCAL_DB = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

test.skip(
  !LOCAL_DB,
  "needs DATABASE_URL pointing at a local throwaway Postgres (these tests write to it)",
);

// Every test owns a THROWAWAY event it creates and deletes in finally{} — no test writes to,
// or asserts the contents of, the seeded events. That keeps the DB residue-free and removes
// the cross-spec coupling with e2e/p4-event-detail-rsvp.spec.ts, which owns seeded event 1
// and asserts its count rises by exactly one.
//
// The throwaway Docker Postgres backing the app under test. Named, not derived from
// DATABASE_URL, so this spec can never reach for a shared or hosted DB.
const DB_CONTAINER = process.env.E2E_DB_CONTAINER ?? "mkv2-jig-p6-db";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "";
// Test 5 drops a table, which no amount of per-event scoping can isolate. It is therefore
// OPT-IN so a plain `npm run test:e2e` cannot yank the schema out from under a concurrently
// running spec. The switch-on run sets it.
const DESTRUCTIVE = process.env.E2E_DESTRUCTIVE === "1";

function psql(sql: string): string {
  // psql -tA still echoes the command tag ("INSERT 0 1") after a RETURNING row, so take the
  // FIRST line — otherwise Number("5\nINSERT 0 1") is NaN.
  return execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-tAc", sql], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0]
    .trim();
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * `drop table attendees` destroys EVERY event's RSVPs, not just this spec's, and
 * POST /api/setup only re-creates an EMPTY table. So snapshot the rows as JSON first and
 * put them back afterwards — otherwise the destructive test silently deletes other specs'
 * (and the seed's) attendee rows, which is exactly the residue this file must not leave.
 */
function snapshotAttendees(exceptEventId: number): string {
  return psql(
    `select coalesce(json_agg(row_to_json(a))::text, '[]')
       from attendees a where a.event_id <> ${exceptEventId}`,
  );
}
function restoreAttendees(snapshot: string) {
  if (snapshot === "[]") return;
  psql(
    `insert into attendees (id, event_id, name, created_at)
     select (r->>'id')::int, (r->>'event_id')::int, r->>'name', (r->>'created_at')::timestamptz
       from json_array_elements(${lit(snapshot)}::json) r
      where not exists (select 1 from attendees x where x.id = (r->>'id')::int)`,
  );
  // Keep the serial sequence ahead of the restored ids so later inserts still work.
  psql("select setval('attendees_id_seq', coalesce((select max(id) from attendees), 1))");
}

/** A throwaway event, owned by one test, removed in finally{}. */
function makeEvent(title: string): number {
  return Number(
    psql(
      `insert into events (title, starts_at, location)
       values (${lit(title)}, now() + interval '10 days', 'P6 Switch-On')
       returning id`,
    ),
  );
}
function dropEvent(id: number) {
  if (!Number.isInteger(id) || id < 1) return;
  psql(`delete from attendees where event_id = ${id}`);
  // X1 adds `sessions`, a child of events with a plain FK — clear it before the parent.
  psql(`delete from sessions where event_id = ${id}`);
  psql(`delete from events where id = ${id}`);
}

const rows = (page: Page) => page.getByTestId("attendee-list").getByTestId("attendee");
const names = (page: Page) => page.getByTestId("attendee-list").getByTestId("attendee-name");

/** A strict ISO-8601 instant with millisecond precision and a Z suffix. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Within this file the destructive test mutates the schema, so the file runs SERIAL.
test.describe.configure({ mode: "serial" });

// ── 1. The full RSVP → list flow, typed into the real form ─────────────────────
test("RSVP flow: type, submit, row appears, most-recent-first, persists", async ({
  page,
  request,
}) => {
  const id = makeEvent(`P6 flow ${Date.now()}`);
  try {
    await page.goto(`/events/${id}`);
    await expect(page.getByTestId("event-title")).toBeVisible();

    // Fresh event → the empty-state, not a bare empty list.
    await expect(page.getByTestId("attendee-list")).toBeVisible();
    await expect(page.getByTestId("attendees-empty")).toBeVisible();
    await expect(page.getByTestId("attendees-empty")).not.toBeEmpty();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId("rsvp-summary")).toHaveText(/No RSVPs|0/i);
    await expect(page.getByTestId("attendee-truncated")).toHaveCount(0);

    // --- first RSVP: real typing into the real input, real click ---
    await page.getByTestId("rsvp-name").click();
    await page.keyboard.type("Ada Lovelace", { delay: 15 });
    await expect(page.getByTestId("rsvp-name")).toHaveValue("Ada Lovelace");
    await page.getByTestId("rsvp-submit").click();

    await expect(rows(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(names(page).first()).toHaveText("Ada Lovelace");
    await expect(page.getByTestId("attendees-empty")).toHaveCount(0);
    await expect(page.getByTestId("rsvp-error")).toHaveCount(0);
    // The input was cleared by the form, so a second RSVP starts clean.
    await expect(page.getByTestId("rsvp-name")).toHaveValue("");
    // P4 regression: the summary counts the same write.
    await expect(page.getByTestId("rsvp-summary")).toContainText("1");

    // --- second RSVP must land ABOVE the first ---
    await page.getByTestId("rsvp-name").fill("Grace Hopper");
    await page.getByTestId("rsvp-submit").click();
    await expect(rows(page)).toHaveCount(2, { timeout: 15_000 });
    expect(await names(page).allInnerTexts()).toEqual(["Grace Hopper", "Ada Lovelace"]);
    await expect(page.getByTestId("rsvp-summary")).toContainText("2");

    // --- persisted, not optimistic client state ---
    await page.reload();
    expect(await names(page).allInnerTexts()).toEqual(["Grace Hopper", "Ada Lovelace"]);

    // --- third: a case-variant duplicate is a server no-op, list must not grow ---
    await page.getByTestId("rsvp-name").fill("ada lovelace");
    await page.getByTestId("rsvp-submit").click();
    await expect(page.getByTestId("rsvp-submit")).toBeEnabled();
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(rows(page)).toHaveCount(2);
    expect(await names(page).allInnerTexts()).toEqual(["Grace Hopper", "Ada Lovelace"]);

    // --- each row carries a real machine-readable timestamp ---
    const dt = await rows(page).first().locator("time").getAttribute("datetime");
    expect(dt).toMatch(ISO);

    // --- the API agrees with what the browser shows ---
    const res = await request.get(`/api/events/${id}/attendees`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { name: string; createdAt: string }[];
    expect(body.map((a) => a.name)).toEqual(["Grace Hopper", "Ada Lovelace"]);
    for (const a of body) {
      // A GENUINE ISO string — not "Sat Jul 25 2026 ..." from a stringified Date.
      expect(a.createdAt).toMatch(ISO);
      expect(new Date(a.createdAt).toISOString()).toBe(a.createdAt);
    }
    // Most-recent-first is a real ordering, not insertion luck.
    expect(Date.parse(body[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(body[1].createdAt));
  } finally {
    dropEvent(id);
  }
});

// ── 2. XSS: an attendee name is escaped, never executed ────────────────────────
test("attendee names are escaped, never executed (dialog listener armed)", async ({
  page,
  request,
}) => {
  const id = makeEvent(`P6 xss ${Date.now()}`);
  const dialogs: string[] = [];
  const errors: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    const payloads = [
      `<img src=x onerror="window.__pwned=1">`,
      `"><script>window.__pwned=2</script>`,
      `<svg/onload=alert(1)>`,
      `'><iframe src=javascript:alert(1)>`,
    ];
    await page.goto(`/events/${id}`);
    for (const p of payloads) {
      await page.getByTestId("rsvp-name").fill(p);
      await page.getByTestId("rsvp-submit").click();
      await expect(page.getByTestId("rsvp-name")).toHaveValue("", { timeout: 15_000 });
    }
    await page.reload();
    await expect(rows(page)).toHaveCount(payloads.length);

    // The payloads render as TEXT, character for character.
    const shown = await names(page).allInnerTexts();
    for (const p of payloads) expect(shown.map((s) => s.trim())).toContain(p);

    // Nothing was injected into the DOM and nothing executed.
    expect(
      await page
        .locator(
          "[data-testid='attendee-list'] img, [data-testid='attendee-list'] script, [data-testid='attendee-list'] svg, [data-testid='attendee-list'] iframe",
        )
        .count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__pwned),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);

    // The JSON route returns the raw payload as a string value (no HTML context).
    const body = (await (await request.get(`/api/events/${id}/attendees`)).json()) as {
      name: string;
    }[];
    for (const p of payloads) expect(body.map((a) => a.name)).toContain(p);
  } finally {
    dropEvent(id);
  }
});

// ── 3. Bad ids: 404 on BOTH surfaces, never a 500 ──────────────────────────────
test("bad ids 404 on the page and the attendees route, never 500", async ({ page, request }) => {
  const bad = ["0", "-1", "abc", "1.5", "2147483648", "12345678901234567890", "999999"];
  for (const id of bad) {
    const pageRes = await page.goto(`/events/${id}`, { waitUntil: "domcontentloaded" });
    expect(pageRes?.status(), `page /events/${id}`).toBe(404);
    // A real Next.js not-found page, not a crash surface.
    await expect(page.locator("body")).not.toContainText("Application error");

    const api = await request.get(`/api/events/${id}/attendees`);
    expect(api.status(), `api /api/events/${id}/attendees`).toBe(404);
    expect(await api.json()).toHaveProperty("error");
  }
  // Sanity: a good id is still 200 on both, so the guard is not a blanket 404.
  const ok = makeEvent(`P6 goodid ${Date.now()}`);
  try {
    expect((await page.goto(`/events/${ok}`))?.status()).toBe(200);
    expect((await request.get(`/api/events/${ok}/attendees`)).status()).toBe(200);
  } finally {
    dropEvent(ok);
  }
});

// ── 4. The 200-row cap and its truncation notice at the boundaries ─────────────
test("the 200-row cap and truncation notice at 0, 1, exactly 200, 250", async ({
  page,
  request,
}) => {
  test.slow(); // seeds 250 rows and re-renders the page four times
  const id = makeEvent(`P6 cap ${Date.now()}`);
  try {
    const seed = (n: number) => {
      psql(`delete from attendees where event_id = ${id}`);
      if (n > 0) {
        psql(
          `insert into attendees (event_id, name, created_at)
           select ${id}, 'Cap ' || g, now() - (g || ' seconds')::interval
             from generate_series(1, ${n}) g`,
        );
      }
      expect(psql(`select count(*) from attendees where event_id = ${id}`)).toBe(String(n));
    };

    for (const { n, expectRows, truncated } of [
      { n: 0, expectRows: 0, truncated: false },
      { n: 1, expectRows: 1, truncated: false },
      { n: 200, expectRows: 200, truncated: false },
      { n: 250, expectRows: 200, truncated: true },
    ]) {
      seed(n);
      await page.goto(`/events/${id}`);
      await expect(rows(page), `page rows at n=${n}`).toHaveCount(expectRows);
      await expect(page.getByTestId("attendees-empty")).toHaveCount(n === 0 ? 1 : 0);
      await expect(
        page.getByTestId("attendee-truncated"),
        `truncation notice at n=${n}`,
      ).toHaveCount(truncated ? 1 : 0);
      if (truncated) {
        await expect(page.getByTestId("attendee-truncated")).toContainText("200");
        await expect(page.getByTestId("attendee-truncated")).toContainText(String(n));
      }
      // P4 regression: the summary reports the TRUE total, not the capped slice.
      if (n > 0) await expect(page.getByTestId("rsvp-summary")).toContainText(String(n));
      // Newest-first survives the cap: row 1 is 'Cap 1' (created_at closest to now()).
      if (n > 0) await expect(names(page).first()).toHaveText("Cap 1");

      const api = await request.get(`/api/events/${id}/attendees`);
      expect(api.status()).toBe(200);
      const body = (await api.json()) as { name: string }[];
      expect(body.length, `api rows at n=${n}`).toBe(expectRows);
      if (n > 0) expect(body[0].name).toBe("Cap 1");
      // The API and the page show the SAME slice.
      expect(body.map((a) => a.name)).toEqual(
        (await names(page).allInnerTexts()).map((s) => s.trim()),
      );
    }
  } finally {
    dropEvent(id);
  }
});

// ── 5. 42P01 degradation, for real ─────────────────────────────────────────────
test("42P01: dropping `attendees` degrades to the empty-state + [], then restores", async ({
  page,
  request,
}) => {
  test.skip(!DESTRUCTIVE, "drops a shared table — opt in with E2E_DESTRUCTIVE=1");
  test.slow(); // a full migrate + seed runs before this test can finish
  expect(SETUP_TOKEN, "SETUP_TOKEN must be set to restore the schema").not.toBe("");
  // DB-SENTINEL: only ever the local throwaway container.
  expect(psql("select current_database()")).toBe("postgres");
  const id = makeEvent(`P6 42P01 ${Date.now()}`);
  try {
    // Give it real rows first, so an empty-state afterwards proves degradation.
    psql(`insert into attendees (event_id, name) values (${id}, 'Before Drop')`);
    await page.goto(`/events/${id}`);
    await expect(rows(page)).toHaveCount(1);

    // This event's own 'Before Drop' row is deliberately NOT snapshotted: the restore must
    // leave it gone so the empty-state re-check below is honest.
    const snapshot = snapshotAttendees(id);
    psql("drop table attendees");
    expect(psql("select to_regclass('public.attendees') is null")).toBe("t");
    try {
      const res = await page.goto(`/events/${id}`);
      expect(res?.status(), "detail page during 42P01").toBe(200);
      await expect(page.getByTestId("event-title")).toBeVisible();
      await expect(page.getByTestId("attendees-empty")).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByTestId("attendee-truncated")).toHaveCount(0);
      // P4/P2 regression during the outage: the summary and the home list still render.
      await expect(page.getByTestId("rsvp-summary")).toBeVisible();
      expect((await page.goto("/"))?.status()).toBe(200);

      const api = await request.get(`/api/events/${id}/attendees`);
      expect(api.status(), "attendees route during 42P01").toBe(200);
      expect(await api.json()).toEqual([]);
    } finally {
      // Restore through the real mechanism the deploy uses.
      const setup = await request.post("/api/setup", {
        headers: { "x-setup-token": SETUP_TOKEN, "content-type": "application/json" },
        data: { seed: true },
      });
      expect(setup.status()).toBe(200);
      restoreAttendees(snapshot);
    }
    expect(psql("select to_regclass('public.attendees') is null")).toBe("f");

    // End-to-end again after the restore, in the browser.
    await page.goto(`/events/${id}`);
    await expect(page.getByTestId("attendees-empty")).toBeVisible();
    await page.getByTestId("rsvp-name").fill("After Restore");
    await page.getByTestId("rsvp-submit").click();
    await expect(names(page).first()).toHaveText("After Restore", { timeout: 15_000 });
    const api = await request.get(`/api/events/${id}/attendees`);
    expect(api.status()).toBe(200);
    expect(((await api.json()) as { name: string }[]).map((a) => a.name)).toContain(
      "After Restore",
    );
  } finally {
    dropEvent(id);
  }
});

// ── 6. P2/P3/P4 regression: home list + /new form + RSVP still work ────────────
test("the P2 home list and P3 create form still work end to end", async ({ page }) => {
  let created = 0;
  const title = `P6 regression ${Date.now()}`;
  try {
    // P2: the home list renders events and links into the detail page.
    await page.goto("/");
    expect(await page.getByTestId("event-row").count()).toBeGreaterThan(0);

    // P3: fill the create form for real and submit it.
    await page.goto("/new");
    await page.getByTestId("create-title").fill(title);
    await page.getByTestId("create-starts-at").fill("2027-03-04T18:30");
    await page.getByTestId("create-location").fill("P6 Switch-On Hall");
    await page.getByTestId("create-submit").click();

    // It navigates to the new event's detail page…
    await page.waitForURL(/\/events\/\d+$/, { timeout: 20_000 });
    created = Number(new URL(page.url()).pathname.split("/").pop());
    expect(created).toBeGreaterThan(0);
    await expect(page.getByTestId("event-title")).toHaveText(title);

    // …which shows P6's empty-state, and a P4 RSVP write still lands there.
    await expect(page.getByTestId("attendees-empty")).toBeVisible();
    await page.getByTestId("rsvp-name").fill("Regression Rita");
    await page.getByTestId("rsvp-submit").click();
    await expect(names(page).first()).toHaveText("Regression Rita", { timeout: 15_000 });
    await expect(page.getByTestId("rsvp-summary")).toContainText("1");

    // P2 again: the new event is now on the home list.
    await page.goto("/");
    await expect(page.getByTestId("event-row").filter({ hasText: title })).toHaveCount(1);
  } finally {
    dropEvent(created);
  }
});
