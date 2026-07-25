/**
 * Human-readable RSVP summary. Pure: no I/O, no Date, no globals.
 *
 * Input hardening (so no non-finite / fractional / unrepresentable value ever
 * reaches the output):
 * - count is normalised to a SAFE, non-negative integer: it is FLOORED first
 *   (e.g. 0.5 -> 0, 3.9 -> 3), then the result must be a safe integer. NaN,
 *   ±Infinity and anything beyond ±Number.MAX_SAFE_INTEGER — where consecutive
 *   integers are no longer exactly representable — become 0, and negatives
 *   clamp to 0.
 * - capacity is honoured only when it is a positive SAFE integer. Anything
 *   else — undefined, NaN, ±Infinity, 0, negative, fractional, or outside the
 *   safe-integer range — is treated as ABSENT, so the output falls back to the
 *   no-capacity form.
 */
export function rsvpSummary(count: number, capacity?: number): string {
  const flooredCount = Math.floor(count);
  const going = Number.isSafeInteger(flooredCount)
    ? Math.max(0, flooredCount)
    : 0;

  if (going === 0) {
    return "No RSVPs yet";
  }

  const goingText = going === 1 ? "1 going" : `${going} going`;

  const cap =
    capacity !== undefined && Number.isSafeInteger(capacity) && capacity > 0
      ? capacity
      : undefined;

  if (cap === undefined) {
    return goingText;
  }

  if (going >= cap) {
    return `Full (${going} going)`;
  }

  return `${goingText} · ${cap - going} spots left`;
}


// A colleague's unrelated helper, appended at the SAME position W3 appends to.
export function formatColleagueNote(n: number): string {
  return `${n} note(s)`;
}

/**
 * W3 — capacity badge for the events list. Pure: no DB, no React.
 * capacity null => no limit, so show the attendee count alone.
 */
export function formatCapacity(input: {
  attendees: number;
  capacity: number | null;
  waiting?: number | null;
}): string {
  const { attendees, capacity } = input;
  const waiting = input.waiting ?? 0;
  if (capacity === null) {
    return `${attendees} going`;
  }
  const base = `${attendees} / ${capacity}`;
  // Over-subscribed historical rows are real: attendees can exceed a later-added capacity.
  if (attendees >= capacity) {
    return waiting > 0 ? `${base} · Full · ${waiting} waiting` : `${base} · Full`;
  }
  return waiting > 0 ? `${base} · ${waiting} waiting` : base;
}

/** Shared by the X3 slot label: same hardening rsvpSummary applies to a count. */
function safeCount(value: number): number {
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? Math.max(0, floored) : 0;
}

/**
 * X3 — one session's label for the schedule on the event page. Pure: no DB, no
 * React, no Date.now(), no globals.
 *
 * Shape: `HH:MM UTC · <room> · <check-in>` — e.g. `17:00 UTC · Room 2 · 1 of 2 checked in`.
 *
 * Defensive, in the style of rsvpSummary / formatCapacity above:
 * - startsAt is rendered as UTC time-of-day; an unparseable string is passed
 *   through verbatim rather than becoming "Invalid Date".
 * - room null / blank / whitespace-only => "Room TBA" (no room was recorded).
 * - attendees and checkedIn are floored to safe, non-negative integers (NaN,
 *   ±Infinity, negatives and out-of-safe-range values become 0), and checkedIn
 *   is clamped to attendees — a count of arrivals cannot exceed the roll.
 * - zero attendees is the SENTINEL case: "No attendees yet". Nothing here ever
 *   divides, so no derived number can be NaN or Infinity. Session-less
 *   attendees are legal, so a legitimately empty session is expected.
 */
export function formatSessionSlot(input: {
  startsAt: string;
  room: string | null;
  attendees: number;
  checkedIn: number;
}): string {
  const when = formatSlotTime(input.startsAt);

  const trimmedRoom = (input.room ?? "").trim();
  const room = trimmedRoom.length > 0 ? trimmedRoom : "Room TBA";

  const attendees = safeCount(input.attendees);
  const checkedIn = Math.min(safeCount(input.checkedIn), attendees);

  if (attendees === 0) {
    return `${when} · ${room} · No attendees yet`;
  }
  if (checkedIn === attendees) {
    return `${when} · ${room} · All ${attendees} arrived`;
  }
  return `${when} · ${room} · ${checkedIn} of ${attendees} checked in`;
}

/** UTC time-of-day for an ISO timestamp; the raw input when it is not a date. */
function formatSlotTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(11, 16)} UTC`;
}

// ── X4 — show-up rate ──────────────────────────────────────────────────────
//
// APPENDED, additive only: nothing above is reordered, rewritten or re-commented.
// Both helpers are pure — no DB, no React, no Date.now(), no globals — and both reuse
// the existing safeCount hardening in place rather than repeating it.

/** The pinned sentinel for a zero denominator — never "NaN%", never "0% of 0". */
const NO_ATTENDEES = "no attendees yet";

/**
 * Hardens the pair every rate is computed from: both counts are floored to safe,
 * non-negative integers (NaN, ±Infinity, negatives and out-of-safe-range become 0), and
 * checkedIn is CLAMPED to attendees — arrivals cannot exceed the roll.
 */
function safeAttendance(input: { attendees: number; checkedIn: number }): {
  attendees: number;
  checkedIn: number;
} {
  const attendees = safeCount(input.attendees);
  return { attendees, checkedIn: Math.min(safeCount(input.checkedIn), attendees) };
}

/**
 * X4 — the show-up percentage, 0..100, rounded to ONE decimal place.
 *
 * The only division in this module, so it is the only place a NaN or an Infinity could
 * be born: zero attendees short-circuits to 0 BEFORE dividing, and the clamp above bounds
 * the quotient to [0, 1]. The result can therefore never be NaN, Infinity, negative or
 * greater than 100.
 */
export function showUpRatePercent(input: { attendees: number; checkedIn: number }): number {
  const { attendees, checkedIn } = safeAttendance(input);
  if (attendees === 0) return 0;
  // ×1000 / 10 rather than toFixed(1): this returns a NUMBER, and the endpoint pins
  // showUpRate as a number.
  //
  // The ×1000 is applied to the INTEGER numerator, not to the quotient: a float quotient
  // loses exact half-tenths, so `(1001 / 2000) * 1000` is 500.49999999999994 and rounds
  // DOWN to 50 instead of 50.1. `(checkedIn * 1000) / attendees` divides an exact integer
  // and lands on 500.5, which rounds to the required 50.1.
  //
  // safeCount permits counts up to MAX_SAFE_INTEGER, so `checkedIn * 1000` can itself leave
  // the exactly-representable range; in that (pathological) case fall back to the quotient
  // form. Either way the clamp above bounds the ratio to [0, 1], so the result is still
  // never NaN, Infinity, negative or greater than 100.
  const scaled = checkedIn * 1000;
  return Number.isSafeInteger(scaled)
    ? Math.round(scaled / attendees) / 10
    : Math.round((checkedIn / attendees) * 1000) / 10;
}

/**
 * X4 — the human label the /api/attendance report returns alongside the number.
 *
 * Zero attendees => EXACTLY "no attendees yet" (the plan pins that string; nothing is
 * appended to it). Otherwise the percentage is taken from showUpRatePercent, so the
 * number and the label physically cannot disagree.
 */
export function formatShowUpRate(input: { attendees: number; checkedIn: number }): string {
  const { attendees, checkedIn } = safeAttendance(input);
  if (attendees === 0) return NO_ATTENDEES;
  const percent = showUpRatePercent({ attendees, checkedIn });
  return `${percent}% showed up (${checkedIn} of ${attendees} checked in)`;
}
