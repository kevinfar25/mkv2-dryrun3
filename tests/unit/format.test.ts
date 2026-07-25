import { describe, expect, it } from "vitest";

import { rsvpSummary } from "../../lib/format";

describe("rsvpSummary", () => {
  describe("without capacity", () => {
    it("reports the empty state for zero", () => {
      expect(rsvpSummary(0)).toBe("No RSVPs yet");
    });

    it("uses the singular form for one", () => {
      expect(rsvpSummary(1)).toBe("1 going");
    });

    it("uses the plural form for many", () => {
      expect(rsvpSummary(2)).toBe("2 going");
      expect(rsvpSummary(42)).toBe("42 going");
    });

    it("reports the spec's verbatim example for the no-capacity form", () => {
      expect(rsvpSummary(12)).toBe("12 going");
    });

    it("clamps a negative count to the empty state", () => {
      expect(rsvpSummary(-1)).toBe("No RSVPs yet");
      expect(rsvpSummary(-99)).toBe("No RSVPs yet");
    });

    it("treats an explicit undefined capacity as no capacity", () => {
      expect(rsvpSummary(3, undefined)).toBe("3 going");
    });
  });

  describe("with capacity", () => {
    it("reports remaining spots when under capacity", () => {
      expect(rsvpSummary(3, 10)).toBe("3 going · 7 spots left");
    });

    it("reports remaining spots for a single attendee", () => {
      expect(rsvpSummary(1, 5)).toBe("1 going · 4 spots left");
    });

    it("reports the spec's verbatim example for the spots-left form", () => {
      expect(rsvpSummary(8, 10)).toBe("8 going · 2 spots left");
    });

    it("reports full when exactly at capacity", () => {
      expect(rsvpSummary(10, 10)).toBe("Full (10 going)");
      expect(rsvpSummary(1, 1)).toBe("Full (1 going)");
    });

    it("reports full when over capacity", () => {
      expect(rsvpSummary(12, 10)).toBe("Full (12 going)");
    });

    it("reports the empty state for zero even with capacity", () => {
      expect(rsvpSummary(0, 10)).toBe("No RSVPs yet");
    });

    it("reports the empty state for a negative count even with capacity", () => {
      expect(rsvpSummary(-5, 10)).toBe("No RSVPs yet");
    });
  });

  describe("at the exact capacity threshold", () => {
    // The spec's template is literally "M spots left", so one remaining spot
    // renders as "1 spots left" — grammatically odd, but spec-literal. This is
    // pinned deliberately: it must NOT be special-cased to "1 spot left".
    it("is still not full with exactly one spot left", () => {
      expect(rsvpSummary(9, 10)).toBe("9 going · 1 spots left");
    });

    it("walks capacity - 1 -> capacity -> capacity + 1 for capacity 10", () => {
      expect(rsvpSummary(9, 10)).toBe("9 going · 1 spots left");
      expect(rsvpSummary(10, 10)).toBe("Full (10 going)");
      expect(rsvpSummary(11, 10)).toBe("Full (11 going)");
    });

    it("walks capacity - 1 -> capacity -> capacity + 1 for capacity 2", () => {
      expect(rsvpSummary(1, 2)).toBe("1 going · 1 spots left");
      expect(rsvpSummary(2, 2)).toBe("Full (2 going)");
      expect(rsvpSummary(3, 2)).toBe("Full (3 going)");
    });

    it("walks capacity - 1 -> capacity -> capacity + 1 for capacity 1", () => {
      // capacity - 1 is 0 here, and a zero count short-circuits before capacity
      // is ever considered.
      expect(rsvpSummary(0, 1)).toBe("No RSVPs yet");
      expect(rsvpSummary(1, 1)).toBe("Full (1 going)");
      expect(rsvpSummary(2, 1)).toBe("Full (2 going)");
    });

    it("never claims zero or negative spots left", () => {
      for (let capacity = 1; capacity <= 50; capacity += 1) {
        for (let count = 0; count <= capacity + 2; count += 1) {
          const summary = rsvpSummary(count, capacity);
          // \b keeps "10 spots left" etc. from matching the "0 spots left" tail.
          expect(summary).not.toMatch(/\b0 spots left/);
          expect(summary).not.toMatch(/-\d+ spots left/);
        }
      }
    });
  });

  describe("with a non-positive capacity (ignored)", () => {
    it("ignores a zero capacity", () => {
      expect(rsvpSummary(3, 0)).toBe("3 going");
      expect(rsvpSummary(1, 0)).toBe("1 going");
    });

    it("ignores a negative capacity", () => {
      expect(rsvpSummary(3, -4)).toBe("3 going");
    });

    it("still reports the empty state for zero with an ignored capacity", () => {
      expect(rsvpSummary(0, 0)).toBe("No RSVPs yet");
      expect(rsvpSummary(-2, -2)).toBe("No RSVPs yet");
    });
  });

  describe("with a non-finite or fractional count (hardened)", () => {
    it("treats a NaN count as no RSVPs", () => {
      expect(rsvpSummary(NaN)).toBe("No RSVPs yet");
      expect(rsvpSummary(NaN, 10)).toBe("No RSVPs yet");
    });

    it("treats an Infinity count as no RSVPs", () => {
      expect(rsvpSummary(Infinity)).toBe("No RSVPs yet");
      expect(rsvpSummary(Infinity, 10)).toBe("No RSVPs yet");
    });

    it("treats a -Infinity count as no RSVPs", () => {
      expect(rsvpSummary(-Infinity)).toBe("No RSVPs yet");
      expect(rsvpSummary(-Infinity, 10)).toBe("No RSVPs yet");
    });

    it("floors a fractional count", () => {
      expect(rsvpSummary(0.5)).toBe("No RSVPs yet");
      expect(rsvpSummary(0.5, 10)).toBe("No RSVPs yet");
      expect(rsvpSummary(1.9)).toBe("1 going");
      expect(rsvpSummary(3.7)).toBe("3 going");
      expect(rsvpSummary(3.7, 10)).toBe("3 going · 7 spots left");
      expect(rsvpSummary(10.5, 10)).toBe("Full (10 going)");
    });

    it("floors a negative fractional count to the empty state", () => {
      expect(rsvpSummary(-0.5)).toBe("No RSVPs yet");
    });
  });

  describe("with a non-finite or fractional capacity (ignored)", () => {
    it("ignores a NaN capacity", () => {
      expect(rsvpSummary(3, NaN)).toBe("3 going");
      expect(rsvpSummary(1, NaN)).toBe("1 going");
    });

    it("ignores an Infinity capacity", () => {
      expect(rsvpSummary(3, Infinity)).toBe("3 going");
    });

    it("ignores a -Infinity capacity", () => {
      expect(rsvpSummary(3, -Infinity)).toBe("3 going");
    });

    it("ignores a fractional capacity", () => {
      expect(rsvpSummary(3, 3.5)).toBe("3 going");
      expect(rsvpSummary(3, 10.5)).toBe("3 going");
      expect(rsvpSummary(3, 0.5)).toBe("3 going");
      expect(rsvpSummary(3, -2.5)).toBe("3 going");
    });
  });

  describe("with an unsafe-integer capacity (ignored)", () => {
    it("ignores a capacity just past MAX_SAFE_INTEGER", () => {
      expect(rsvpSummary(1, 9007199254740993)).toBe("1 going");
      expect(rsvpSummary(1, Number.MAX_SAFE_INTEGER + 1)).toBe("1 going");
      expect(rsvpSummary(3, 9007199254740993)).toBe("3 going");
    });

    it("ignores a capacity below -MAX_SAFE_INTEGER", () => {
      expect(rsvpSummary(3, -9007199254740993)).toBe("3 going");
      expect(rsvpSummary(3, -(Number.MAX_SAFE_INTEGER + 1))).toBe("3 going");
    });
  });

  describe("with an unsafe-integer count (hardened to the empty state)", () => {
    it("treats a count just past MAX_SAFE_INTEGER as no RSVPs", () => {
      expect(rsvpSummary(Number.MAX_SAFE_INTEGER + 1)).toBe("No RSVPs yet");
      expect(rsvpSummary(9007199254740993)).toBe("No RSVPs yet");
      expect(rsvpSummary(9007199254740993, 10)).toBe("No RSVPs yet");
    });

    it("treats a count below -MAX_SAFE_INTEGER as no RSVPs", () => {
      expect(rsvpSummary(-9007199254740993)).toBe("No RSVPs yet");
    });
  });

  describe("at the safe-integer boundary (still accepted)", () => {
    it("accepts MAX_SAFE_INTEGER as a count", () => {
      expect(rsvpSummary(Number.MAX_SAFE_INTEGER)).toBe(
        "9007199254740991 going",
      );
    });

    it("accepts MAX_SAFE_INTEGER as a capacity", () => {
      expect(rsvpSummary(1, Number.MAX_SAFE_INTEGER)).toBe(
        "1 going · 9007199254740990 spots left",
      );
    });

    it("accepts MAX_SAFE_INTEGER as both count and capacity", () => {
      expect(
        rsvpSummary(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      ).toBe("Full (9007199254740991 going)");
    });
  });

  it("is pure: repeated calls with the same input return the same string", () => {
    expect(rsvpSummary(4, 9)).toBe(rsvpSummary(4, 9));
    expect(rsvpSummary(0)).toBe(rsvpSummary(0));
  });
});
