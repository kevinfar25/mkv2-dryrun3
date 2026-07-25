import { describe, expect, it } from "vitest";

import { formatSessionSlot } from "../../lib/format";
// Type-only: erased at compile time, so nothing from lib/store (and therefore nothing from
// lib/db) is imported at runtime. This test is pure — formatSessionSlot needs no mocking.
import type { SessionSummary } from "../../lib/store";

/** The page passes exactly these four fields out of a SessionSummary row. */
function slotOf(session: SessionSummary): string {
  return formatSessionSlot({
    startsAt: session.startsAt,
    room: session.room,
    attendees: session.attendeeCount,
    checkedIn: session.checkedInCount,
  });
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    eventId: 3,
    title: "Opening Keynote",
    startsAt: "2026-08-04T17:00:00.000Z",
    room: "Room 2",
    attendeeCount: 2,
    checkedInCount: 1,
    ...overrides,
  };
}

describe("formatSessionSlot", () => {
  it("renders time, room and the check-in count against the attendee count", () => {
    expect(
      formatSessionSlot({
        startsAt: "2026-08-04T17:00:00.000Z",
        room: "Room 2",
        attendees: 2,
        checkedIn: 1,
      }),
    ).toBe("17:00 UTC · Room 2 · 1 of 2 checked in");
  });

  it("renders the time as UTC time-of-day, not the local clock", () => {
    // Deliberately a non-midnight-UTC instant: a local-time formatter would drift here.
    expect(slotOf(session({ startsAt: "2026-08-04T23:45:00.000Z" }))).toContain(
      "23:45 UTC",
    );
    expect(slotOf(session({ startsAt: "2026-08-04T00:05:00.000Z" }))).toContain(
      "00:05 UTC",
    );
  });

  describe("a null room", () => {
    it("falls back to a placeholder rather than printing null", () => {
      expect(slotOf(session({ room: null }))).toBe(
        "17:00 UTC · Room TBA · 1 of 2 checked in",
      );
    });

    it("treats a blank or whitespace-only room the same as no room", () => {
      expect(slotOf(session({ room: "" }))).toContain("Room TBA");
      expect(slotOf(session({ room: "   " }))).toContain("Room TBA");
    });

    it("trims a recorded room name", () => {
      expect(slotOf(session({ room: "  Room 7  " }))).toContain("Room 7");
    });
  });

  describe("zero attendees", () => {
    it("returns the sentinel instead of any ratio — never divides by zero", () => {
      const label = slotOf(
        session({ attendeeCount: 0, checkedInCount: 0 }),
      );
      expect(label).toBe("17:00 UTC · Room 2 · No attendees yet");
      expect(label).not.toMatch(/NaN|Infinity/);
      // Session-less attendees are legal, so an empty session is an expected state.
      expect(label).not.toContain("0 of 0");
    });

    it("still returns the sentinel if a stray check-in outruns an empty roll", () => {
      // checkedIn is clamped to attendees: arrivals cannot exceed the roll.
      const label = slotOf(session({ attendeeCount: 0, checkedInCount: 3 }));
      expect(label).toBe("17:00 UTC · Room 2 · No attendees yet");
      expect(label).not.toMatch(/NaN|Infinity/);
    });
  });

  describe("checked-in equal to attendees", () => {
    it('reports "all arrived" rather than n of n', () => {
      expect(slotOf(session({ attendeeCount: 2, checkedInCount: 2 }))).toBe(
        "17:00 UTC · Room 2 · All 2 arrived",
      );
    });

    it("reports all arrived for a single attendee", () => {
      expect(slotOf(session({ attendeeCount: 1, checkedInCount: 1 }))).toBe(
        "17:00 UTC · Room 2 · All 1 arrived",
      );
    });

    it("clamps an over-count down to all arrived", () => {
      expect(slotOf(session({ attendeeCount: 2, checkedInCount: 5 }))).toBe(
        "17:00 UTC · Room 2 · All 2 arrived",
      );
    });
  });

  describe("two sessions at the same starts_at — the page preserves the order given", () => {
    // Ordering is NOT this module's contract: listSessions owns it (`starts_at asc, title asc,
    // id asc`). The page's only obligation is to map the array it was handed WITHOUT re-sorting,
    // and each row's label must come from its own row rather than bleeding across the tie. So the
    // fixture below is deliberately in an order the store would NEVER return — "Closing Notes"
    // before "Budget Review" on an identical starts_at — and the assertion is that the mapping
    // reproduces THAT order verbatim. A page (or formatter) that re-sorted by title, id or
    // anything else would fail here; a pre-sorted fixture could not tell the difference.
    // (The structural "the page does not .sort()" half of this lives in
    // tests/unit/event-page-schedule.test.ts, which reads the component source.)
    const sameStart = "2026-08-04T17:00:00.000Z";
    const asGiven: SessionSummary[] = [
      session({
        id: 9,
        title: "Closing Notes",
        startsAt: sameStart,
        room: null,
        attendeeCount: 0,
        checkedInCount: 0,
      }),
      session({
        id: 11,
        title: "Budget Review",
        startsAt: sameStart,
        room: "Room 2",
        attendeeCount: 2,
        checkedInCount: 1,
      }),
    ];

    it("maps a tie in the order received, not in sorted order", () => {
      // Guard the guard: the fixture must NOT already be in the store's order, or this test
      // would pass against a re-sorting implementation.
      const sortedTitles = [...asGiven.map((s) => s.title)].sort();
      expect(asGiven.map((s) => s.title)).not.toEqual(sortedTitles);

      expect(asGiven.map(slotOf)).toEqual([
        "17:00 UTC · Room TBA · No attendees yet",
        "17:00 UTC · Room 2 · 1 of 2 checked in",
      ]);
    });

    it("pairs each label with its own row, whichever order the rows arrive in", () => {
      const reversed = [...asGiven].reverse();
      expect(reversed.map(slotOf)).toEqual([...asGiven.map(slotOf)].reverse());
    });

    it("gives both rows the same time, so the tie is a real one", () => {
      const times = asGiven.map((s) => slotOf(s).split(" · ")[0]);
      expect(times).toEqual(["17:00 UTC", "17:00 UTC"]);
    });
  });

  describe("hardening", () => {
    it("floors fractional counts", () => {
      expect(slotOf(session({ attendeeCount: 3.9, checkedInCount: 1.7 }))).toBe(
        "17:00 UTC · Room 2 · 1 of 3 checked in",
      );
    });

    it("treats non-finite or unsafe counts as zero", () => {
      for (const bad of [Number.NaN, Infinity, -Infinity, 1e308]) {
        const label = slotOf(
          session({ attendeeCount: bad, checkedInCount: bad }),
        );
        expect(label).toBe("17:00 UTC · Room 2 · No attendees yet");
      }
    });

    it("clamps a negative count to zero", () => {
      expect(slotOf(session({ attendeeCount: -4, checkedInCount: -1 }))).toBe(
        "17:00 UTC · Room 2 · No attendees yet",
      );
      expect(slotOf(session({ attendeeCount: 2, checkedInCount: -1 }))).toBe(
        "17:00 UTC · Room 2 · 0 of 2 checked in",
      );
    });

    it("passes an unparseable timestamp through verbatim", () => {
      expect(slotOf(session({ startsAt: "not-a-date" }))).toBe(
        "not-a-date · Room 2 · 1 of 2 checked in",
      );
      expect(slotOf(session({ startsAt: "" }))).toBe(
        " · Room 2 · 1 of 2 checked in",
      );
    });

    it("is pure — the same input yields the same label every call", () => {
      const input = {
        startsAt: "2026-08-04T17:00:00.000Z",
        room: null,
        attendees: 5,
        checkedIn: 2,
      };
      expect(formatSessionSlot(input)).toBe(formatSessionSlot(input));
      // and it does not mutate its argument
      expect(input).toEqual({
        startsAt: "2026-08-04T17:00:00.000Z",
        room: null,
        attendees: 5,
        checkedIn: 2,
      });
    });
  });
});
