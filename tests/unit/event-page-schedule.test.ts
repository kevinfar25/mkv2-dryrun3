import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-level assertions, in the precedent of tests/unit/repo-hygiene.test.ts: the vitest
// environment here is `node` (no DOM, and no DOM dep may be added), so the only way to pin a
// RENDER-STRUCTURE invariant is to read the component source. Two invariants matter enough to
// pin, because neither is covered by the pure formatter tests:
//
//  1. The schedule renders NOTHING when there are no sessions. `sessions` is [] for every event
//     on the hosted DB until 20260727010000 is applied, so the zero-session branch IS the
//     current production path — "an event with no sessions renders exactly as it does today" is
//     this phase's exit condition. A regression that hoisted the <section> or its <h2> out of
//     the `sessions.length > 0` guard would ship empty scaffolding with every other test green.
//  2. The page does not re-sort. Ordering is X1's contract in listSessions
//     (`starts_at asc, title asc, id asc`); the page's only job is to map what it was given.
const PAGE_PATH = "app/events/[id]/page.tsx";
const source = readFileSync(PAGE_PATH, "utf8");

const GUARD = "{sessions.length > 0 && (";
const SECTION = '<section data-testid="session-schedule">';
const HEADING = "<h2>Schedule</h2>";

/**
 * The JSX guarded by `{sessions.length > 0 && ( … )}`, found by balancing parentheses from the
 * guard's own opening paren. Structural, not a grep: if the section is hoisted above/below the
 * guard, or the guard is deleted, the section is no longer inside this slice.
 */
function guardedBlock(): string {
  const guardStart = source.indexOf(GUARD);
  expect(
    guardStart,
    `${PAGE_PATH} must gate the schedule on \`${GUARD}\``,
  ).toBeGreaterThan(-1);

  const open = guardStart + GUARD.length - 1; // the "(" that opens the guarded JSX
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses after \`${GUARD}\` in ${PAGE_PATH}`);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("the event page's schedule section", () => {
  it("renders nothing at all when an event has no sessions", () => {
    const block = guardedBlock();

    // Inside the guard...
    expect(block).toContain(SECTION);
    expect(block).toContain(HEADING);
    expect(block).toContain("sessions.map(");

    // ...and NOWHERE else, so there is no second, unguarded copy that would render on the
    // zero-session path. Exactly one occurrence in the file, and it is the guarded one.
    expect(occurrences(source, SECTION)).toBe(1);
    expect(occurrences(source, HEADING)).toBe(1);
    expect(occurrences(source, 'data-testid="session"')).toBe(1);
    expect(occurrences(block, 'data-testid="session"')).toBe(1);
  });

  it("keeps the row testids the plan pins", () => {
    const block = guardedBlock();
    expect(block).toContain('data-testid="session-slot"');
    expect(block).toContain('data-testid="session-title"');
  });

  it("leads each row with the slot label, so the time comes first", () => {
    const block = guardedBlock();
    expect(block.indexOf('data-testid="session-slot"')).toBeLessThan(
      block.indexOf('data-testid="session-title"'),
    );
  });

  it("does not re-sort the sessions it was given", () => {
    // listSessions already orders `starts_at asc, title asc, id asc`; a .sort()/.reverse() here
    // would silently override that contract.
    expect(source).not.toMatch(/sessions[\s\S]{0,40}\.(sort|reverse)\(/);
    expect(guardedBlock()).not.toMatch(/\.(sort|reverse)\(/);
  });
});
