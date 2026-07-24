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

  it("is pure: repeated calls with the same input return the same string", () => {
    expect(rsvpSummary(4, 9)).toBe(rsvpSummary(4, 9));
    expect(rsvpSummary(0)).toBe(rsvpSummary(0));
  });
});
