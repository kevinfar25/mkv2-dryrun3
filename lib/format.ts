/**
 * Human-readable RSVP summary. Pure: no I/O, no Date, no globals.
 *
 * Input hardening (so no non-finite / fractional value ever reaches the output):
 * - count is normalised to a finite, non-negative integer: NaN and non-finite
 *   values become 0, negatives clamp to 0, and fractional counts are FLOORED
 *   (e.g. 0.5 -> 0, 3.9 -> 3).
 * - capacity is honoured only when it is a finite positive integer. Anything
 *   else — undefined, NaN, ±Infinity, 0, negative, or fractional — is treated
 *   as ABSENT, so the output falls back to the no-capacity form.
 */
export function rsvpSummary(count: number, capacity?: number): string {
  const going = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

  if (going === 0) {
    return "No RSVPs yet";
  }

  const goingText = going === 1 ? "1 going" : `${going} going`;

  const cap =
    capacity !== undefined && Number.isInteger(capacity) && capacity > 0
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
