import { describe, it, expect } from "vitest";
// Relative import: vitest.config.ts declares no path aliases, and adding one there
// would be a shared-file edit the other phases would have to merge around.
import { parseEventInput, rsvpInput } from "../../lib/validation";

// Built, never typed literally: a raw NUL byte in a source file breaks tooling that
// reads it as text (and git treats the file as binary).
const NUL = String.fromCharCode(0);

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
    // Postgres text cannot store a NUL byte, so this has to fail validation, not INSERT.
    ["title containing a NUL byte", { ...valid, title: `ok${NUL}bad` }],
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
    // ISO 8601 allows these; timestamptz does not, so accepting them would turn a 400
    // into a 500 at INSERT time.
    ["startsAt with an offset beyond +/-15:59", { ...valid, startsAt: "2026-08-04T17:00:00-23:00" }],
    ["startsAt in year 0000", { ...valid, startsAt: "0000-01-01T00:00:00Z" }],
    ["startsAt in year 0000 with an offset", { ...valid, startsAt: "0000-12-31T23:00:00+02:00" }],
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
    ["location containing a NUL byte", { ...valid, location: `Ha${NUL}ll` }],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = parseEventInput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.errors.join(" ")).toContain("location");
    });
  }

  // The timestamptz guard must not narrow what was already legal: these all round-trip
  // through Postgres, and the parsed value stays the caller's original string (later
  // phases are built against that shape) rather than being normalized to UTC.
  for (const startsAt of [
    "2026-08-04T17:00:00Z",
    "2026-08-04T17:00:00.000Z",
    "2026-08-04T17:00:00.123456Z",
    "2026-08-04T17:00:00+00:00",
    "2026-08-04T17:00:00-05:00",
    "2026-08-04T17:00:00-15:59",
    "2026-08-04T17:00:00+15:59",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
  ] as const) {
    it(`accepts storable startsAt ${startsAt}`, () => {
      const result = parseEventInput({ ...valid, startsAt });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.data.startsAt).toBe(startsAt);
    });
  }

  it("accepts ordinary unicode in title and location", () => {
    const result = parseEventInput({ ...valid, title: "Valletta — 会議", location: "Room ✅" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.title).toBe("Valletta — 会議");
    expect(result.data.location).toBe("Room ✅");
  });

  it("rejects a non-object body", () => {
    expect(parseEventInput(null).ok).toBe(false);
    expect(parseEventInput("nope").ok).toBe(false);
    expect(parseEventInput(undefined).ok).toBe(false);
  });
});

describe("rsvpInput", () => {
  it("accepts a valid name and trims it", () => {
    const result = rsvpInput.safeParse({ name: "  Ada Lovelace  " });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.name).toBe("Ada Lovelace");
  });

  it("accepts a boundary-length name (120)", () => {
    expect(rsvpInput.safeParse({ name: "n".repeat(120) }).success).toBe(true);
  });

  // Legitimate unicode must stay storable — the NUL guard must not over-tighten into
  // rejecting these.
  for (const [label, name] of [
    ["ordinary unicode", "Valletta — 会議 ✅"],
    ["unpaired surrogate", `Bad${String.fromCharCode(0xd800)}Surrogate`],
    ["astral emoji", "\u{1f600}".repeat(60)],
    ["embedded newlines", "a\nb\rc"],
  ] as const) {
    it(`accepts ${label}`, () => {
      expect(rsvpInput.safeParse({ name }).success).toBe(true);
    });
  }

  for (const [label, raw, expected] of [
    // A missing name never reaches .min(1), so zod's own type message stands.
    ["a missing name", {}, "expected string"],
    ["an empty name", { name: "" }, "name is required"],
    ["a whitespace-only name", { name: "   " }, "name is required"],
    ["an over-length name (121)", { name: "n".repeat(121) }, "name must be 120 characters or fewer"],
    // Postgres text cannot store a NUL byte: without this the INSERT 500s.
    ["a name containing a NUL byte", { name: `Nul${NUL}Byte` }, "name must not contain a NUL character"],
    ["a lone NUL name", { name: NUL }, "name must not contain a NUL character"],
    ["a NUL padded with spaces", { name: `  ${NUL}  ` }, "name must not contain a NUL character"],
  ] as const) {
    it(`rejects ${label}`, () => {
      const result = rsvpInput.safeParse(raw);
      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected failure");
      expect(result.error.issues.map((i) => i.message).join("; ")).toContain(expected);
    });
  }

  it("rejects a non-string name", () => {
    expect(rsvpInput.safeParse({ name: 42 }).success).toBe(false);
  });

  // .strict(): an unknown key must be a 400, not a silently ignored field.
  it("rejects unknown keys", () => {
    expect(rsvpInput.safeParse({ name: "Zed", role: "admin" }).success).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(rsvpInput.safeParse(null).success).toBe(false);
    expect(rsvpInput.safeParse("nope").success).toBe(false);
  });
});
