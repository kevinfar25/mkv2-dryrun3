import { describe, it, expect, vi, beforeEach } from "vitest";

// lib/store.ts imports "@/lib/db", and vitest.config.ts declares NO path alias (adding
// one there would be a shared-file edit every other phase has to merge around). So the
// db module is mocked BY THE SPECIFIER the source actually uses — vi.mock registers the
// factory under that raw specifier, which is what the import in lib/store.ts resolves
// through. Hermetic: no pool is ever constructed, no connection is ever opened.
const query = vi.fn();
vi.mock("@/lib/db", () => ({
  query,
  withTransaction: vi.fn(),
}));

const { listAttendees, UNDEFINED_TABLE, ATTENDEE_PAGE_LIMIT } = await import(
  "../../lib/store"
);

/** What node-postgres actually raises: an Error carrying a `code` string. */
function pgError(code: string): Error {
  return Object.assign(new Error(`relation does not exist (${code})`), { code });
}

beforeEach(() => {
  query.mockReset();
});

describe("listAttendees", () => {
  it("issues exactly ONE query — no per-row fan-out", async () => {
    query.mockResolvedValue([
      { name: "Ada", created_at: new Date("2026-07-25T10:00:00.000Z") },
      { name: "Grace", created_at: new Date("2026-07-25T09:00:00.000Z") },
      { name: "Alan", created_at: new Date("2026-07-25T08:00:00.000Z") },
    ]);

    const rows = await listAttendees(7);

    expect(rows).toHaveLength(3);
    // Three attendees, ONE round trip. A regression to a per-row lookup fails here.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("orders most-recent-first in SQL and parameterizes the event id", async () => {
    query.mockResolvedValue([]);
    await listAttendees(42);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/order by created_at desc/i);
    expect(sql).toMatch(/where event_id = \$1/i);
    // The id is bound, never interpolated — no string-concatenated SQL.
    expect(sql).not.toContain("42");
    expect(params).toEqual([42, ATTENDEE_PAGE_LIMIT]);
  });

  it("caps the row count IN SQL with a bound limit — default is ATTENDEE_PAGE_LIMIT", async () => {
    query.mockResolvedValue([]);
    await listAttendees(7);

    const [sql, params] = query.mock.calls[0];
    // The bound is a placeholder, NOT string-interpolated into the SQL text.
    expect(sql).toMatch(/limit \$2/i);
    expect(sql).not.toMatch(/limit\s+\d/i);
    expect(ATTENDEE_PAGE_LIMIT).toBe(200);
    expect(params).toEqual([7, 200]);
  });

  it("honours a smaller explicit limit but never exceeds the cap", async () => {
    query.mockResolvedValue([]);

    await listAttendees(7, 5);
    expect(query.mock.calls[0][1]).toEqual([7, 5]);

    // Above the cap, at the cap, and nonsense values all clamp to ATTENDEE_PAGE_LIMIT.
    for (const bad of [10_000, 0, -1, 1.5, Number.NaN]) {
      query.mockClear();
      await listAttendees(7, bad);
      expect(query.mock.calls[0][1]).toEqual([7, ATTENDEE_PAGE_LIMIT]);
    }
  });

  it("normalizes created_at Date objects to ISO strings", async () => {
    query.mockResolvedValue([
      { name: "Ada", created_at: new Date("2026-07-25T10:00:00.000Z") },
    ]);
    // X1 added sessionId/checkedInAt/rsvpedAt to Attendee. The mocked row deliberately keeps
    // the PRE-X1 column set, so this also pins the null-safe defaults for a database where the
    // new columns do not exist yet.
    await expect(listAttendees(1)).resolves.toEqual([
      {
        name: "Ada",
        createdAt: "2026-07-25T10:00:00.000Z",
        rsvpedAt: "2026-07-25T10:00:00.000Z",
        sessionId: null,
        checkedInAt: null,
      },
    ]);
  });

  it("passes through a created_at that is already a string", async () => {
    query.mockResolvedValue([
      { name: "Grace", created_at: "2026-07-25T09:00:00.000Z" },
    ]);
    await expect(listAttendees(1)).resolves.toEqual([
      {
        name: "Grace",
        createdAt: "2026-07-25T09:00:00.000Z",
        rsvpedAt: "2026-07-25T09:00:00.000Z",
        sessionId: null,
        checkedInAt: null,
      },
    ]);
  });

  it("returns [] for an empty event without touching the result shape", async () => {
    query.mockResolvedValue([]);
    await expect(listAttendees(1)).resolves.toEqual([]);
  });

  it("degrades to [] on 42P01 undefined_table (pre-/api/setup window)", async () => {
    query.mockRejectedValue(pgError(UNDEFINED_TABLE));
    await expect(listAttendees(1)).resolves.toEqual([]);
  });

  it("rethrows any OTHER database error — it must not be silently swallowed", async () => {
    query.mockRejectedValue(pgError("08006")); // connection_failure
    await expect(listAttendees(1)).rejects.toThrow(/08006/);
  });

  it("rejects a non-integer event id before issuing a query", async () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(listAttendees(bad)).resolves.toEqual([]);
    }
    expect(query).not.toHaveBeenCalled();
  });
});
