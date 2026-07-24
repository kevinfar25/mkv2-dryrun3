/**
 * Human-readable RSVP summary. Pure: no I/O, no Date, no globals.
 *
 * - count is clamped at 0 (negatives are treated as no RSVPs).
 * - capacity is ignored when it is undefined or <= 0.
 */
export function rsvpSummary(count: number, capacity?: number): string {
  const going = count > 0 ? count : 0;

  if (going === 0) {
    return "No RSVPs yet";
  }

  const goingText = going === 1 ? "1 going" : `${going} going`;

  if (capacity === undefined || capacity <= 0) {
    return goingText;
  }

  if (going >= capacity) {
    return `Full (${going} going)`;
  }

  return `${goingText} · ${capacity - going} spots left`;
}
