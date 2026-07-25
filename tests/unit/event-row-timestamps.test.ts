import { describe, it, expect, vi } from "vitest";
import type { EventRow } from "../../lib/store";

// lib/store.ts imports "@/lib/db", and vitest.config.ts declares no path aliases — the
// bare specifier would fail to resolve. Stub it: this suite exercises a pure function
// and must never open a connection anyway. (Aliasing in vitest.config.ts would be a
// shared-file edit every other phase has to merge around, so it stays local.)
vi.mock("@/lib/db", () => ({
  query: vi.fn(async () => {
    throw new Error("normalizeEventRow tests must not touch the DB");
  }),
}));

const { normalizeEventRow } = await import("../../lib/store");

// REGRESSION GUARD. EventRow types starts_at/created_at as `string`, but node-postgres
// parses timestamptz into a JS Date — and query<T>() is an unchecked assertion, so
// nothing at the type level catches the mismatch. app/page.tsx and GET /api/events both
// depend on these being real ISO strings (the page renders <time dateTime={…}>; the API
// serializes them). If normalization is ever dropped, the page still "works" via
// JSON/React coercion but emits a non-ISO date string — a silent wrong-format bug.
// Hermetic: pure function, no DB.
describe("normalizeEventRow", () => {
  const base = { id: 7, title: "Team Offsite", location: "Valletta HQ" };

  it("converts pg Date timestamps to ISO strings", () => {
    const row = normalizeEventRow({
      ...base,
      starts_at: new Date("2026-08-04T17:00:00.000Z"),
      created_at: new Date("2026-07-25T09:30:00.000Z"),
    });

    expect(row.starts_at).toBe("2026-08-04T17:00:00.000Z");
    expect(row.created_at).toBe("2026-07-25T09:30:00.000Z");
    expect(typeof row.starts_at).toBe("string");
    expect(typeof row.created_at).toBe("string");
  });

  it("leaves an already-string timestamp untouched", () => {
    const row = normalizeEventRow({
      ...base,
      starts_at: "2026-08-04T17:00:00.000Z",
      created_at: "2026-07-25T09:30:00.000Z",
    });

    expect(row.starts_at).toBe("2026-08-04T17:00:00.000Z");
    expect(row.created_at).toBe("2026-07-25T09:30:00.000Z");
  });

  it("preserves the non-timestamp fields", () => {
    const row: EventRow = normalizeEventRow({
      ...base,
      starts_at: new Date("2026-08-04T17:00:00.000Z"),
      created_at: new Date("2026-07-25T09:30:00.000Z"),
    });

    expect(row.id).toBe(7);
    expect(row.title).toBe("Team Offsite");
    expect(row.location).toBe("Valletta HQ");
  });

  it("round-trips through new Date() — what app/page.tsx does to format it", () => {
    const row = normalizeEventRow({
      ...base,
      starts_at: new Date("2026-08-04T17:00:00.000Z"),
      created_at: new Date("2026-07-25T09:30:00.000Z"),
    });

    expect(Number.isNaN(new Date(row.starts_at).getTime())).toBe(false);
    expect(new Date(row.starts_at).toISOString()).toBe(row.starts_at);
  });
});
