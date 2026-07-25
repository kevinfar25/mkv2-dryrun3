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

const { listAttendees, UNDEFINED_TABLE } = await import("../../lib/store");

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
    expect(params).toEqual([42]);
  });

  it("normalizes created_at Date objects to ISO strings", async () => {
    query.mockResolvedValue([
      { name: "Ada", created_at: new Date("2026-07-25T10:00:00.000Z") },
    ]);
    await expect(listAttendees(1)).resolves.toEqual([
      { name: "Ada", createdAt: "2026-07-25T10:00:00.000Z" },
    ]);
  });

  it("passes through a created_at that is already a string", async () => {
    query.mockResolvedValue([
      { name: "Grace", created_at: "2026-07-25T09:00:00.000Z" },
    ]);
    await expect(listAttendees(1)).resolves.toEqual([
      { name: "Grace", createdAt: "2026-07-25T09:00:00.000Z" },
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
