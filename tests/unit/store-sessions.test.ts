import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked by the SPECIFIER lib/store.ts actually imports ("@/lib/db"), exactly as
// tests/unit/store-attendees.test.ts does — vitest.config.ts declares no path alias, and adding
// one there would be a shared-file edit every other phase has to merge around. HERMETIC: no
// pool is ever constructed and no database connection is ever opened.
const query = vi.fn();
vi.mock("@/lib/db", () => ({
  query,
  withTransaction: vi.fn(),
}));

const {
  listSessions,
  listAttendees,
  UNDEFINED_TABLE,
  UNDEFINED_COLUMN,
  isUndefinedColumn,
} = await import("../../lib/store");

/** What node-postgres actually raises: an Error carrying a `code` string. */
function pgError(code: string): Error {
  return Object.assign(new Error(`postgres error (${code})`), { code });
}

beforeEach(() => {
  query.mockReset();
});

describe("listSessions", () => {
  it("orders by starts_at then title in SQL, and aggregates in ONE query", async () => {
    query.mockResolvedValue([]);
    await listSessions(7);

    const [sql, params] = query.mock.calls[0];
    expect(query).toHaveBeenCalledTimes(1);
    // starts_at first, then title as the tiebreak for two sessions at the same moment, then id
    // so even a duplicate title cannot reorder between requests.
    expect(sql).toMatch(/order by s\.starts_at asc, s\.title asc, s\.id asc/i);
    expect(sql).toMatch(/left join attendees a on a\.session_id = s\.id/i);
    expect(sql).toMatch(/group by/i);
    expect(sql).toMatch(/where s\.event_id = \$1/i);
    // The id is bound, never interpolated.
    expect(sql).not.toContain(" 7");
    expect(params).toEqual([7]);
  });

  it("preserves the database's order, including two sessions at the same starts_at", async () => {
    // The DB does the ordering; this pins that the store does not re-sort or reverse it. The
    // rows are given in the exact order `order by starts_at, title, id` produces.
    query.mockResolvedValue([
      {
        id: 11,
        event_id: 3,
        title: "Budget Review",
        starts_at: new Date("2026-08-04T17:00:00.000Z"),
        room: "Room 2",
        attendee_count: "2",
        checked_in_count: "1",
      },
      {
        id: 12,
        event_id: 3,
        title: "Roadmap Deep Dive",
        starts_at: new Date("2026-08-04T17:00:00.000Z"),
        room: null,
        attendee_count: "5",
        checked_in_count: "5",
      },
      {
        id: 10,
        event_id: 3,
        title: "Retro and Wrap-up",
        starts_at: new Date("2026-08-04T18:30:00.000Z"),
        room: "Room 3",
        attendee_count: "0",
        checked_in_count: "0",
      },
    ]);

    const rows = await listSessions(3);

    expect(rows.map((r) => r.title)).toEqual([
      "Budget Review",
      "Roadmap Deep Dive",
      "Retro and Wrap-up",
    ]);
    // Same starts_at → the two titles are alphabetical, and the LATER session still sorts last
    // even though its id is lowest.
    expect(rows[0].startsAt).toBe(rows[1].startsAt);
    expect(rows[2].startsAt).toBe("2026-08-04T18:30:00.000Z");
  });

  it("maps the aggregate counts to numbers and normalizes the row shape", async () => {
    query.mockResolvedValue([
      {
        id: 11,
        event_id: 3,
        title: "Budget Review",
        starts_at: new Date("2026-08-04T17:00:00.000Z"),
        room: "Room 2",
        // count(*)::text — bigint arrives as a string from node-postgres either way.
        attendee_count: "12",
        checked_in_count: "7",
      },
    ]);

    await expect(listSessions(3)).resolves.toEqual([
      {
        id: 11,
        eventId: 3,
        title: "Budget Review",
        startsAt: "2026-08-04T17:00:00.000Z",
        room: "Room 2",
        attendeeCount: 12,
        checkedInCount: 7,
      },
    ]);
  });

  it("keeps a null room null and zero counts numeric zero (not NaN)", async () => {
    query.mockResolvedValue([
      {
        id: 1,
        event_id: 1,
        title: "Lightning Talks",
        starts_at: "2026-08-11T18:30:00.000Z",
        room: null,
        attendee_count: "0",
        checked_in_count: "0",
      },
    ]);

    const [row] = await listSessions(1);
    expect(row.room).toBeNull();
    expect(row.attendeeCount).toBe(0);
    expect(row.checkedInCount).toBe(0);
    // starts_at that is already a string passes straight through.
    expect(row.startsAt).toBe("2026-08-11T18:30:00.000Z");
  });

  it("returns [] for an event with no sessions", async () => {
    query.mockResolvedValue([]);
    await expect(listSessions(9)).resolves.toEqual([]);
  });

  // THE production-critical case: this code is deployed BEFORE 20260727010000 can be applied
  // (the runner lives inside the deployed app), so on the live site listSessions runs against a
  // database with no `sessions` table on every event-page request.
  it("degrades to [] when the sessions table does not exist yet (42P01)", async () => {
    query.mockRejectedValue(pgError(UNDEFINED_TABLE));
    await expect(listSessions(3)).resolves.toEqual([]);
  });

  it("degrades to [] when a column does not exist yet (42703)", async () => {
    query.mockRejectedValue(pgError(UNDEFINED_COLUMN));
    await expect(listSessions(3)).resolves.toEqual([]);
  });

  it("rethrows any OTHER database error — it must not be silently swallowed", async () => {
    query.mockRejectedValue(pgError("08006")); // connection_failure
    await expect(listSessions(3)).rejects.toThrow(/08006/);
  });

  it("rejects a non-integer or out-of-int4-range event id before issuing a query", async () => {
    // sessions.event_id is int4: an out-of-range id makes Postgres THROW (22003) rather than
    // return no rows, so the range is part of the guard — the contract is list-or-empty.
    for (const bad of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2147483648,
      -2147483649,
    ]) {
      await expect(listSessions(bad)).resolves.toEqual([]);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe("isUndefinedColumn", () => {
  it("recognizes 42703 and nothing else", () => {
    expect(isUndefinedColumn(pgError(UNDEFINED_COLUMN))).toBe(true);
    expect(UNDEFINED_COLUMN).toBe("42703");
    expect(isUndefinedColumn(pgError(UNDEFINED_TABLE))).toBe(false);
    expect(isUndefinedColumn(new Error("no code"))).toBe(false);
    expect(isUndefinedColumn(null)).toBe(false);
    expect(isUndefinedColumn("42703")).toBe(false);
  });
});

describe("listAttendees — X1 additions", () => {
  it("reads the RSVP moment via coalesce(rsvped_at, created_at) and selects the new columns", async () => {
    query.mockResolvedValue([]);
    await listAttendees(4);

    const [sql] = query.mock.calls[0];
    // Correct against BOTH schemas: after the migration rsvped_at wins, and on a row the
    // backfill has not reached, created_at does.
    expect(sql).toMatch(/coalesce\(rsvped_at, created_at\) as rsvped_at/i);
    expect(sql).toMatch(/session_id/i);
    expect(sql).toMatch(/checked_in_at/i);
    // created_at is KEPT — the page and the existing ordering still use it.
    expect(sql).toMatch(/order by created_at desc, id desc/i);
  });

  it("exposes sessionId / checkedInAt, null-safe", async () => {
    query.mockResolvedValue([
      {
        name: "Ada",
        created_at: new Date("2026-07-25T10:00:00.000Z"),
        rsvped_at: new Date("2026-07-25T09:00:00.000Z"),
        session_id: 11,
        checked_in_at: new Date("2026-07-25T11:00:00.000Z"),
      },
      {
        name: "Grace",
        created_at: new Date("2026-07-25T08:00:00.000Z"),
        rsvped_at: null,
        session_id: null,
        checked_in_at: null,
      },
    ]);

    await expect(listAttendees(4)).resolves.toEqual([
      {
        name: "Ada",
        createdAt: "2026-07-25T10:00:00.000Z",
        rsvpedAt: "2026-07-25T09:00:00.000Z",
        sessionId: 11,
        checkedInAt: "2026-07-25T11:00:00.000Z",
      },
      {
        name: "Grace",
        createdAt: "2026-07-25T08:00:00.000Z",
        // Nothing to coalesce in the mock, so the row's own created_at stands in — never null.
        rsvpedAt: "2026-07-25T08:00:00.000Z",
        sessionId: null,
        checkedInAt: null,
      },
    ]);
  });

  it("falls back to the PRE-X1 column list on 42703 rather than 500ing", async () => {
    // The deploy → apply window: the code selects session_id/checked_in_at/rsvped_at before the
    // migration adds them, and the event page calls this on EVERY request.
    query
      .mockRejectedValueOnce(pgError(UNDEFINED_COLUMN))
      .mockResolvedValueOnce([
        { name: "Ada", created_at: new Date("2026-07-25T10:00:00.000Z") },
      ]);

    await expect(listAttendees(4)).resolves.toEqual([
      {
        name: "Ada",
        createdAt: "2026-07-25T10:00:00.000Z",
        rsvpedAt: "2026-07-25T10:00:00.000Z",
        sessionId: null,
        checkedInAt: null,
      },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    const [retrySql] = query.mock.calls[1];
    expect(retrySql).not.toMatch(/rsvped_at/i);
    expect(retrySql).not.toMatch(/session_id/i);
    expect(retrySql).not.toMatch(/checked_in_at/i);
  });

  it("degrades to [] when even the fallback read fails on the old schema", async () => {
    query
      .mockRejectedValueOnce(pgError(UNDEFINED_COLUMN))
      .mockRejectedValueOnce(pgError(UNDEFINED_TABLE));
    await expect(listAttendees(4)).resolves.toEqual([]);
  });

  it("still rethrows a real error raised by the fallback read", async () => {
    query
      .mockRejectedValueOnce(pgError(UNDEFINED_COLUMN))
      .mockRejectedValueOnce(pgError("08006"));
    await expect(listAttendees(4)).rejects.toThrow(/08006/);
  });
});
