import { describe, it, expect } from "vitest";

// Baseline smoke test so CI's `npm test` has something to run and is green from the
// first commit. The fleet adds real unit tests per phase (validation, store logic).
describe("baseline", () => {
  it("arithmetic sanity", () => {
    expect(1 + 1).toBe(2);
  });
});
