import { describe, it, expect, vi, beforeEach } from "vitest";

// Same trick tests/unit/store-attendees.test.ts uses: vitest.config.ts declares NO path
// alias (adding one would be a shared-file edit every other phase has to merge around), so
// the db module is mocked BY THE SPECIFIER the source imports — "@/lib/db". Fully hermetic:
// no pool is constructed, no connection is opened, no database is ever touched.
const query = vi.fn();
vi.mock("@/lib/db", () => ({
  query,
  withTransaction: vi.fn(),
}));

// The route also imports "@/lib/store" and "@/lib/format" through the same alias, which the
// aliasless vitest config cannot resolve either. These two are NOT stubs: the factory
// re-exports the REAL module by relative path, so the genuine isUndefinedTable /
// isUndefinedColumn / formatShowUpRate implementations are what run — vi.mock is used purely
// as a resolver here. (lib/store's own "@/lib/db" import still lands on the mock above.)
vi.mock("@/lib/store", async () => await import("../../lib/store"));
vi.mock("@/lib/format", async () => await import("../../lib/format"));

const { GET } = await import("../../app/api/attendance/route");
const { showUpRatePercent, formatShowUpRate } = await import("../../lib/format");

/** What node-postgres actually raises: an Error carrying a `code` string. */
function pgError(code: string): Error {
  return Object.assign(new Error(`relation does not exist (${code})`), { code });
}

type Rows = Record<string, unknown>[];

/**
 * Routes each of the route's three fixed statements to a fixture (or a rejection) by
 * matching the SQL text, so the queries may run concurrently without the test depending on
 * call order. Anything not supplied resolves to [].
 */
function mockDb(handlers: {
  events?: Rows | Error;
  attendees?: Rows | Error;
  attendeesFallback?: Rows | Error;
  sessions?: Rows | Error;
  sessionsFallback?: Rows | Error;
}) {
  query.mockImplementation(async (sql: string) => {
    let value: Rows | Error | undefined;
    if (/from events/.test(sql)) value = handlers.events;
    else if (/from attendees/.test(sql)) {
      value = /checked_in_at/.test(sql) ? handlers.attendees : handlers.attendeesFallback;
    } else if (/from sessions s/.test(sql)) {
      value = /left join attendees/.test(sql) ? handlers.sessions : handlers.sessionsFallback;
    }
    if (value instanceof Error) throw value;
    return value ?? [];
  });
}

/** The response body is JSON the route pins the shape of; the test reads it structurally. */
type ReportBody = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function getReport(): Promise<{ status: number; body: ReportBody }> {
  const response = await GET();
  return { status: response.status, body: await response.json() };
}

/** Every SQL string the mocked query() was called with, in call order. */
const issuedSql = (): string[] => query.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  query.mockReset();
});

describe("GET /api/attendance — board shape", () => {
  it("returns 200 with a well-formed ZERO report for an empty board", async () => {
    mockDb({});
    const { status, body } = await getReport();

    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.totals).toEqual({
      events: 0,
      sessions: 0,
      attendees: 0,
      checkedIn: 0,
      showUpRate: 0,
      showUpRateLabel: "no attendees yet",
    });
    expect(body.busiestSession).toBeNull();
  });

  it("keeps the SQL's newest-first event order — the route must not re-sort", async () => {
    // Ids are deliberately NOT descending, so this fails if the route re-sorts by id:
    // SQL order is 3, 9, 1 — descending id would be 9, 3, 1.
    mockDb({
      events: [
        { id: 3, title: "Newest" },
        { id: 9, title: "Middle" },
        { id: 1, title: "Oldest" },
      ],
    });
    const { body } = await getReport();

    expect(body.events.map((e: { id: number; title: string }) => [e.id, e.title])).toEqual([
      [3, "Newest"],
      [9, "Middle"],
      [1, "Oldest"],
    ]);
    const sql = issuedSql().find((text) => /from events/.test(text));
    expect(sql).toMatch(/order by created_at desc, id desc/i);
  });

  it("issues a CONSTANT three queries regardless of event count — no per-event fan-out", async () => {
    mockDb({
      events: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: `Event ${i + 1}` })),
    });
    await getReport();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("reports a zero-attendee event as 0 / 'no attendees yet' — never NaN or Infinity", async () => {
    mockDb({ events: [{ id: 1, title: "Quiet" }] });
    const { status, body } = await getReport();

    expect(status).toBe(200);
    const [event] = body.events;
    expect(event.attendeeCount).toBe(0);
    expect(event.checkedInCount).toBe(0);
    expect(event.showUpRate).toBe(0);
    expect(Number.isNaN(event.showUpRate)).toBe(false);
    expect(Number.isFinite(event.showUpRate)).toBe(true);
    expect(event.showUpRateLabel).toBe("no attendees yet");
    expect(body.totals.showUpRateLabel).toBe("no attendees yet");
    expect(Number.isFinite(body.totals.showUpRate)).toBe(true);
  });

  it("casts bigint counts and derives the rate and label from them", async () => {
    mockDb({
      events: [
        { id: 2, title: "Demo Day" },
        { id: 1, title: "Offsite" },
      ],
      // bigint comes back from node-postgres as a STRING.
      attendees: [
        { event_id: 2, total: "8", checked_in: "5" },
        { event_id: 1, total: "4", checked_in: "4" },
      ],
      sessions: [
        { id: 10, event_id: 2, title: "Keynote", starts_at: new Date("2026-08-01T10:00:00Z"), attendee_count: "6" },
        { id: 11, event_id: 1, title: "Retro", starts_at: new Date("2026-08-02T10:00:00Z"), attendee_count: "4" },
      ],
    });
    const { body } = await getReport();

    expect(body.events[0]).toEqual({
      id: 2,
      title: "Demo Day",
      sessionCount: 1,
      attendeeCount: 8,
      checkedInCount: 5,
      showUpRate: 62.5,
      showUpRateLabel: "62.5% showed up (5 of 8 checked in)",
    });
    expect(body.totals).toEqual({
      events: 2,
      sessions: 2,
      attendees: 12,
      checkedIn: 9,
      showUpRate: 75,
      showUpRateLabel: "75% showed up (9 of 12 checked in)",
    });
  });
});

describe("GET /api/attendance — busiest session tiebreak", () => {
  const event = [{ id: 1, title: "Offsite" }];

  it("(a) picks the strictly highest attendeeCount", async () => {
    // Deliberately UNSORTED — the winner is neither first nor last.
    mockDb({
      events: event,
      sessions: [
        { id: 3, event_id: 1, title: "Retro", starts_at: new Date("2026-08-01T09:00:00Z"), attendee_count: "2" },
        { id: 1, event_id: 1, title: "Keynote", starts_at: new Date("2026-08-01T12:00:00Z"), attendee_count: "9" },
        { id: 2, event_id: 1, title: "Budget", starts_at: new Date("2026-08-01T08:00:00Z"), attendee_count: "7" },
      ],
    });
    const { body } = await getReport();
    expect(body.busiestSession).toEqual({
      id: 1,
      eventId: 1,
      title: "Keynote",
      attendeeCount: 9,
    });
  });

  it("(b) breaks an attendeeCount tie on the EARLIEST starts_at", async () => {
    // Deliberately UNSORTED, and the earliest session carries the HIGHEST id: an
    // implementation that ignored starts_at and broke the tie on the lowest id would pick
    // id 1 ("Late"), so this case fails unless starts_at really is the tiebreak.
    mockDb({
      events: event,
      sessions: [
        { id: 1, event_id: 1, title: "Late", starts_at: new Date("2026-08-01T18:00:00Z"), attendee_count: "4" },
        { id: 9, event_id: 1, title: "Early", starts_at: new Date("2026-08-01T08:00:00Z"), attendee_count: "4" },
        { id: 6, event_id: 1, title: "Mid", starts_at: new Date("2026-08-01T12:00:00Z"), attendee_count: "4" },
      ],
    });
    const { body } = await getReport();
    expect(body.busiestSession).toMatchObject({ id: 9, title: "Early", attendeeCount: 4 });
  });

  it("(c) breaks an equal-count, equal-starts_at tie on the LOWEST id", async () => {
    const at = new Date("2026-08-04T17:00:00Z");
    mockDb({
      events: event,
      sessions: [
        { id: 30, event_id: 1, title: "Roadmap", starts_at: at, attendee_count: "3" },
        { id: 12, event_id: 1, title: "Budget", starts_at: at, attendee_count: "3" },
        { id: 21, event_id: 1, title: "Retro", starts_at: at, attendee_count: "3" },
      ],
    });
    const { body } = await getReport();
    expect(body.busiestSession).toMatchObject({ id: 12, title: "Budget", attendeeCount: 3 });
  });

  it("still names a winner when every session has zero attendees", async () => {
    mockDb({
      events: event,
      sessions: [
        { id: 8, event_id: 1, title: "B", starts_at: new Date("2026-08-01T10:00:00Z"), attendee_count: "0" },
        { id: 7, event_id: 1, title: "A", starts_at: new Date("2026-08-01T09:00:00Z"), attendee_count: "0" },
      ],
    });
    const { body } = await getReport();
    expect(body.busiestSession).toEqual({ id: 7, eventId: 1, title: "A", attendeeCount: 0 });
  });

  it("is null ONLY when there are no sessions at all", async () => {
    mockDb({ events: event, attendees: [{ event_id: 1, total: "3", checked_in: "1" }] });
    const { body } = await getReport();
    expect(body.busiestSession).toBeNull();
    expect(body.events[0].attendeeCount).toBe(3);
  });
});

describe("GET /api/attendance — session-less attendees are legal", () => {
  it("counts them in the event and board totals but in NO session", async () => {
    // The event has 5 attendees (3 checked in); only 2 of them sit in the one session.
    // The other 3 are pre-X2 RSVPs with session_id NULL — real attendees, no session.
    mockDb({
      events: [{ id: 1, title: "Offsite" }],
      attendees: [{ event_id: 1, total: "5", checked_in: "3" }],
      sessions: [
        {
          id: 10,
          event_id: 1,
          title: "Keynote",
          starts_at: new Date("2026-08-01T10:00:00Z"),
          attendee_count: "2",
        },
      ],
    });
    const { status, body } = await getReport();

    expect(status).toBe(200);
    // Bucket 1 — the EVENT roll: session-less attendees are inside it.
    expect(body.events[0].attendeeCount).toBe(5);
    expect(body.events[0].checkedInCount).toBe(3);
    expect(body.totals.attendees).toBe(5);
    expect(body.totals.checkedIn).toBe(3);
    // Bucket 2 — the SESSION roll: they are not, and the event count is NOT the sum of it.
    expect(body.busiestSession).toMatchObject({ id: 10, attendeeCount: 2 });

    // The event aggregate must group by event_id, not travel through sessions.
    const attendeeSql = issuedSql().find(
      (sql) => /from attendees\b/.test(sql) && /group by event_id/.test(sql),
    );
    expect(attendeeSql).toBeDefined();
    expect(attendeeSql).not.toMatch(/join sessions/i);
  });
});

describe("GET /api/attendance — old-schema degradation", () => {
  it("returns 200 with sessions zeroed when the sessions table is missing (42P01)", async () => {
    mockDb({
      events: [{ id: 1, title: "Offsite" }],
      attendees: [{ event_id: 1, total: "4", checked_in: "1" }],
      sessions: pgError("42P01"),
      sessionsFallback: pgError("42P01"),
    });
    const { status, body } = await getReport();

    expect(status).toBe(200);
    expect(body.events[0].sessionCount).toBe(0);
    expect(body.totals.sessions).toBe(0);
    expect(body.busiestSession).toBeNull();
    // The attendee counts must STILL be correct.
    expect(body.events[0].attendeeCount).toBe(4);
    expect(body.events[0].checkedInCount).toBe(1);
    expect(body.events[0].showUpRate).toBe(25);
  });

  it("returns 200 with checkedIn 0 when checked_in_at is missing (42703)", async () => {
    mockDb({
      events: [{ id: 1, title: "Offsite" }],
      attendees: pgError("42703"),
      attendeesFallback: [{ event_id: 1, total: "6", checked_in: "0" }],
      sessions: pgError("42703"),
      sessionsFallback: [
        { id: 2, event_id: 1, title: "Keynote", starts_at: new Date("2026-08-01T10:00:00Z"), attendee_count: "0" },
      ],
    });
    const { status, body } = await getReport();

    expect(status).toBe(200);
    expect(body.events[0].attendeeCount).toBe(6);
    expect(body.events[0].checkedInCount).toBe(0);
    expect(body.events[0].showUpRate).toBe(0);
    expect(Number.isNaN(body.events[0].showUpRate)).toBe(false);
    expect(body.events[0].showUpRateLabel).toBe("0% showed up (0 of 6 checked in)");
    // sessions survive through the un-joined fallback.
    expect(body.events[0].sessionCount).toBe(1);
    expect(body.busiestSession).toMatchObject({ id: 2, attendeeCount: 0 });
  });

  it("returns the empty report when even the events table is missing", async () => {
    mockDb({
      events: pgError("42P01"),
      attendees: pgError("42P01"),
      sessions: pgError("42P01"),
      sessionsFallback: pgError("42P01"),
    });
    const { status, body } = await getReport();

    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.totals.events).toBe(0);
    expect(body.busiestSession).toBeNull();
  });

  it("returns 503 with a STATIC message on a non-PG failure — no Postgres code leaks", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDb({ events: new Error("ECONNREFUSED 10.0.0.1:5432") });
    const { status, body } = await getReport();

    expect(status).toBe(503);
    expect(body).toEqual({ error: "attendance report is temporarily unavailable" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/42P01|42703|ECONNREFUSED|5432/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("also 503s on a connection-class PG error — only 42P01/42703 degrade", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDb({ events: pgError("08006") });
    const { status, body } = await getReport();

    expect(status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("08006");
    spy.mockRestore();
  });
});

describe("showUpRatePercent / formatShowUpRate", () => {
  it("returns the pinned sentinel for a zero denominator", () => {
    expect(formatShowUpRate({ attendees: 0, checkedIn: 0 })).toBe("no attendees yet");
    expect(formatShowUpRate({ attendees: 0, checkedIn: 5 })).toBe("no attendees yet");
    expect(showUpRatePercent({ attendees: 0, checkedIn: 5 })).toBe(0);
  });

  it("rounds to ONE decimal place", () => {
    expect(showUpRatePercent({ attendees: 8, checkedIn: 5 })).toBe(62.5);
    expect(showUpRatePercent({ attendees: 3, checkedIn: 1 })).toBe(33.3);
    expect(showUpRatePercent({ attendees: 3, checkedIn: 2 })).toBe(66.7);
    expect(showUpRatePercent({ attendees: 7, checkedIn: 7 })).toBe(100);
    expect(showUpRatePercent({ attendees: 7, checkedIn: 1 })).toBe(14.3);
    expect(showUpRatePercent({ attendees: 200, checkedIn: 1 })).toBe(0.5);
  });

  it("rounds EXACT half-tenths up — the ×1000 must not ride on a float quotient", () => {
    // Each of these lands exactly on a half-tenth. Scaling the quotient instead of the
    // integer numerator loses that: (1001 / 2000) * 1000 is 500.49999999999994, which
    // rounds DOWN to 50 instead of 50.1. The label must carry the same number.
    expect(showUpRatePercent({ attendees: 2000, checkedIn: 1001 })).toBe(50.1);
    expect(formatShowUpRate({ attendees: 2000, checkedIn: 1001 })).toContain("50.1%");

    expect(showUpRatePercent({ attendees: 400, checkedIn: 201 })).toBe(50.3);
    expect(formatShowUpRate({ attendees: 400, checkedIn: 201 })).toContain("50.3%");

    expect(showUpRatePercent({ attendees: 800, checkedIn: 406 })).toBe(50.8);
    expect(formatShowUpRate({ attendees: 800, checkedIn: 406 })).toContain("50.8%");

    // The neighbouring non-boundary ratio is unchanged.
    expect(showUpRatePercent({ attendees: 2000, checkedIn: 999 })).toBe(50);
  });

  it("clamps checkedIn to attendees — arrivals cannot exceed the roll", () => {
    expect(showUpRatePercent({ attendees: 4, checkedIn: 9 })).toBe(100);
    expect(formatShowUpRate({ attendees: 4, checkedIn: 9 })).toBe(
      "100% showed up (4 of 4 checked in)",
    );
  });

  it("never yields NaN, Infinity, a negative or a value above 100", () => {
    const nasty = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -5,
      1.7,
      Number.MAX_SAFE_INTEGER + 10,
      0,
      3,
    ];
    for (const attendees of nasty) {
      for (const checkedIn of nasty) {
        const rate = showUpRatePercent({ attendees, checkedIn });
        expect(Number.isFinite(rate)).toBe(true);
        expect(Number.isNaN(rate)).toBe(false);
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
        expect(formatShowUpRate({ attendees, checkedIn })).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("floors fractional counts the way safeCount does", () => {
    // 3.9 -> 3 attendees, 2.9 -> 2 checked in.
    expect(showUpRatePercent({ attendees: 3.9, checkedIn: 2.9 })).toBe(66.7);
    expect(formatShowUpRate({ attendees: 3.9, checkedIn: 2.9 })).toBe(
      "66.7% showed up (2 of 3 checked in)",
    );
  });

  it("round-trips: the label always contains the number the endpoint returns", () => {
    const pairs: [number, number][] = [
      [8, 5],
      [3, 1],
      [3, 2],
      [1, 1],
      [1000, 1],
      [7, 0],
      [9, 4],
      [4, 9],
      [2.5, 1.9],
    ];
    for (const [attendees, checkedIn] of pairs) {
      const rate = showUpRatePercent({ attendees, checkedIn });
      const label = formatShowUpRate({ attendees, checkedIn });
      if (label === "no attendees yet") {
        expect(rate).toBe(0);
      } else {
        expect(label).toContain(`${rate}%`);
      }
    }
  });
});
