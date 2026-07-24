import { describe, it, expect } from "vitest";
// Relative import: vitest.config.ts declares no path aliases, and adding one there
// would be a shared-file edit the other phases would have to merge around.
import { parseEventInput } from "../../lib/validation";

const valid = {
  title: "Team Offsite Planning",
  startsAt: "2026-08-04T17:00:00.000Z",
  location: "Valletta HQ — Room 2",
};

describe("parseEventInput", () => {
  it("accepts a valid event and returns typed data", () => {
    const result = parseEventInput(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual(valid);
  });

  it("trims surrounding whitespace on title and location", () => {
    const result = parseEventInput({ ...valid, title: "  Padded  ", location: "  Hall  " });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.title).toBe("Padded");
    expect(result.data.location).toBe("Hall");
  });

  it("accepts boundary-length title (120) and location (160)", () => {
    const result = parseEventInput({
      ...valid,
      title: "t".repeat(120),
      location: "l".repeat(160),
    });
    expect(result.ok).toBe(true);
  });

  for (const [name, raw] of [
    ["missing title", { ...valid, title: undefined }],
    ["empty title", { ...valid, title: "" }],
    ["whitespace-only title", { ...valid, title: "   " }],
    ["over-length title (121)", { ...valid, title: "t".repeat(121) }],
    ["non-string title", { ...valid, title: 42 }],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = parseEventInput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.errors.join(" ")).toContain("title");
    });
  }

  for (const [name, raw] of [
    ["missing startsAt", { ...valid, startsAt: undefined }],
    ["non-ISO startsAt", { ...valid, startsAt: "next tuesday" }],
    ["date-only startsAt", { ...valid, startsAt: "2026-08-04" }],
    ["non-string startsAt", { ...valid, startsAt: 1786000000000 }],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = parseEventInput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.errors.join(" ")).toContain("startsAt");
    });
  }

  for (const [name, raw] of [
    ["missing location", { ...valid, location: undefined }],
    ["empty location", { ...valid, location: "" }],
    ["over-length location (161)", { ...valid, location: "l".repeat(161) }],
    ["non-string location", { ...valid, location: null }],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = parseEventInput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.errors.join(" ")).toContain("location");
    });
  }

  it("rejects a non-object body", () => {
    expect(parseEventInput(null).ok).toBe(false);
    expect(parseEventInput("nope").ok).toBe(false);
    expect(parseEventInput(undefined).ok).toBe(false);
  });
});
