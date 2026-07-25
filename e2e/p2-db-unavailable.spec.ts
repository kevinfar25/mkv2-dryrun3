import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

// P2 degradation gate: when the database is unreachable the home page must render
// app/error.tsx (data-testid="app-error"), NOT a white screen, and GET /api/events must
// answer a handled 503 rather than an unhandled 500.
//
// The jig container runs with --rm, so `docker stop` would DESTROY it. Instead the DB is
// made unreachable IN PLACE: pg_hba.conf is rewritten to reject TCP logins and reloaded,
// and existing backends are terminated. The `local` (unix socket) trust line is kept so
// this test can always undo itself. Nothing is stopped and no data is lost.

// Only ever safe against a local throwaway Postgres running in a named docker container:
// it deliberately breaks the database. Skipped otherwise, so `npm run test:e2e` aimed at a
// hosted URL (the prod back-gate) cannot take that deployment's database down.
const CONTAINER = process.env.JIG_DB_CONTAINER ?? "mkv2-jig-p2-db";
const LOCAL_DB = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "");

function containerIsRunning(): boolean {
  try {
    return (
      execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

test.skip(
  !LOCAL_DB || !containerIsRunning(),
  `needs a local throwaway Postgres in the docker container "${CONTAINER}" (this suite breaks the database on purpose)`,
);
const HBA = "/var/lib/postgresql/data/pg_hba.conf";
const BACKUP = "/tmp/pg_hba.gate-backup.conf";

const sh = (script: string) =>
  execFileSync("docker", ["exec", CONTAINER, "sh", "-c", script], { encoding: "utf8" });

const psql = (sql: string) =>
  execFileSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql], {
    encoding: "utf8",
  }).trim();

function blockTcpLogins() {
  sh(`cp -n ${HBA} ${BACKUP}; printf 'local all all trust\\nhost all all all reject\\n' > ${HBA}`);
  psql("select pg_reload_conf()");
  // Drop the Next server's pooled connections so it must re-dial (and be rejected).
  psql(
    "select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and backend_type = 'client backend'",
  );
}

function restoreTcpLogins() {
  sh(`cp ${BACKUP} ${HBA}`);
  psql("select pg_reload_conf()");
}

/** The DB is reachable over TCP again from outside the container. */
async function waitForRecovery(probe: () => Promise<number>) {
  for (let i = 0; i < 40; i++) {
    if ((await probe()) === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("database did not become reachable again");
}

test("with the database unreachable the page shows the error boundary and the API 503s", async ({
  page,
  request,
}) => {
  // Sanity: healthy before we break anything.
  expect((await request.get("/api/events")).status()).toBe(200);

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  let blocked = true;
  try {
    blockTcpLogins();

    // ── the API degrades to a handled 503, never a 500 ──
    // Retry briefly: a connection already checked out of the pool may serve one more query.
    let apiStatus = 0;
    let apiBody: unknown = null;
    for (let i = 0; i < 40; i++) {
      const res = await request.get("/api/events");
      apiStatus = res.status();
      apiBody = await res.json().catch(() => null);
      if (apiStatus !== 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(apiStatus, "GET /api/events with the DB down").toBe(503);
    expect(apiBody).toEqual({ error: "events are temporarily unavailable" });

    // A write must degrade the same way — not a 500.
    const post = await request.post("/api/events", {
      data: { title: "Nope", startsAt: "2026-12-01T18:30:00.000Z", location: "Nowhere" },
    });
    expect(post.status(), "POST /api/events with the DB down").toBe(503);
    expect(await post.json()).toEqual({ error: "events are temporarily unavailable" });

    // …but validation still runs BEFORE the DB, so a bad body is still a 400.
    const bad = await request.post("/api/events", { data: { title: "" } });
    expect(bad.status(), "validation must not be masked by the outage").toBe(400);

    // ── the page renders the error boundary, not a white screen ──
    const response = await page.goto("/");
    const errorBoundary = page.getByTestId("app-error");
    await expect(errorBoundary).toBeVisible();
    await expect(errorBoundary.getByRole("heading")).toHaveText("Something went wrong");
    await expect(page.getByTestId("app-error-retry")).toBeVisible();
    // Not a white screen: real text, and the shared layout/nav survived.
    expect((await page.getByTestId("app-error").innerText()).length).toBeGreaterThan(20);
    await expect(page.getByTestId("top-nav")).toBeVisible();
    await expect(page.getByTestId("events-list")).toHaveCount(0);
    await expect(page.getByTestId("events-empty")).toHaveCount(0);
    expect(response?.status(), "the boundary is served as a 500 document, not a blank 200")
      .toBeGreaterThanOrEqual(500);

    // ── the retry button actually recovers once the DB is back ──
    restoreTcpLogins();
    blocked = false;
    await waitForRecovery(async () => (await request.get("/api/events")).status());

    await page.getByTestId("app-error-retry").click();
    await expect(page.getByTestId("events-list")).toBeVisible();
    await expect(page.getByTestId("event-row").first()).toBeVisible();
    await expect(page.getByTestId("app-error")).toHaveCount(0);
  } finally {
    if (blocked) restoreTcpLogins();
  }

  // The outage left nothing behind: the list is fully healthy again.
  await page.goto("/");
  await expect(page.getByTestId("events-list")).toBeVisible();
  expect((await request.get("/api/events")).status()).toBe(200);
});

// The realistic prod window: merging the PR deploys the code, and POST /api/setup applies
// the migration only afterwards — so P2's code briefly runs against a schema with no
// `events` table (Postgres 42P01). That must degrade, not white-screen.
test("with the events table not yet created the page degrades and the API 503s", async ({
  page,
  request,
}) => {
  let renamed = true;
  try {
    psql("alter table events rename to events_gate_hidden");

    const get = await request.get("/api/events");
    expect(get.status(), "GET /api/events on the pre-migration schema").toBe(503);
    expect(await get.json()).toEqual({ error: "events are temporarily unavailable" });

    const post = await request.post("/api/events", {
      data: { title: "Nope", startsAt: "2026-12-01T18:30:00.000Z", location: "Nowhere" },
    });
    expect(post.status(), "POST /api/events on the pre-migration schema").toBe(503);

    await page.goto("/");
    // The error boundary is a client component, so it appears after hydration — assert on
    // the rendered DOM, not the streamed HTML.
    await expect(page.getByTestId("app-error")).toBeVisible();
    await expect(page.getByTestId("top-nav")).toBeVisible();
    await expect(page.getByTestId("events-list")).toHaveCount(0);

    psql("alter table events_gate_hidden rename to events");
    renamed = false;
    await waitForRecovery(async () => (await request.get("/api/events")).status());

    // Recovery through the boundary's own button, exactly as a visitor would.
    await page.getByTestId("app-error-retry").click();
    await expect(page.getByTestId("events-list")).toBeVisible();
    await expect(page.getByTestId("app-error")).toHaveCount(0);
  } finally {
    if (renamed) psql("alter table events_gate_hidden rename to events");
  }

  await page.goto("/");
  await expect(page.getByTestId("events-list")).toBeVisible();
});
