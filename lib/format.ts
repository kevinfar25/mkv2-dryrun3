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
