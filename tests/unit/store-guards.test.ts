import { describe, it, expect, vi } from "vitest";

// lib/store imports "@/lib/db", and vitest.config.ts declares no path aliases (adding
// one is a shared-file edit the other phases would have to merge around). Stubbing the
// specifier both resolves it and makes the file hermetic: if the guard ever let one of
// these ids through, query() would throw here instead of silently opening a connection.
vi.mock("@/lib/db", () => ({
  query: () => {
    throw new Error("getEvent reached the database for a guard-rejected id");
  },
}));

// Relative import: vitest.config.ts declares no path aliases, and adding one there
// would be a shared-file edit the other phases would have to merge around.
import { getEvent } from "../../lib/store";

// Hermetic by construction: every id below is rejected by getEvent's guard, so no
// connection is ever opened and this file needs no DATABASE_URL. In-range ids (0, -1,
// 2147483647) also answer null, but only after a real SELECT, so they belong to the
// integration pass rather than here.
describe("getEvent id guard", () => {
  for (const [name, id] of [
    ["above int4 max", 2147483648],
    ["below int4 min", -2147483649],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["-MAX_SAFE_INTEGER", -Number.MAX_SAFE_INTEGER],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ] as const) {
    it(`answers null without querying for an id ${name}`, async () => {
      await expect(getEvent(id)).resolves.toBeNull();
    });
  }

  it("answers null for a non-numeric id that slipped past the type system", async () => {
    // Route params arrive as strings; a caller that forgets Number() must not reach SQL.
    await expect(getEvent("1" as unknown as number)).resolves.toBeNull();
  });
});
