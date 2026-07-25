import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";

// A per-worktree `node_modules` SYMLINK was committed to main once, because .gitignore listed
// `node_modules/` with a trailing slash — which matches a directory but NOT a symlink of that
// name — and a `git add -A` in the worktree picked it up. It then broke every later checkout of
// that branch, and the recursive symlink it produced destroyed the real dependency tree.
// Cheap, permanent guard.
describe("repo hygiene", () => {
  it("does not track node_modules", () => {
    const tracked = execFileSync("git", ["ls-files", "node_modules"], { encoding: "utf8" }).trim();
    expect(tracked).toBe("");
  });
});
