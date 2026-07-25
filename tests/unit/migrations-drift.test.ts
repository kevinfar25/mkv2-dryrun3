import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { MIGRATIONS } from "../../lib/migrations";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

// lib/migrations.ts is GENERATED from db/migrations/*.sql, and it is what the deployed atomic
// runner (POST /api/migrate) actually applies. If the generated copy goes stale, the hosted DB
// gets a different schema from the one CI's migration-hygiene check inspected — and the drift is
// invisible, because both halves look internally consistent. So pin them here.
describe("lib/migrations.ts", () => {
  it("is up to date with db/migrations (regenerate with: npm run gen:migrations)", () => {
    // The generator's own --check does the byte comparison, including the header and escaping.
    expect(() =>
      execFileSync("node", ["scripts/gen-migrations.mjs", "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("covers every .sql file in db/migrations, in version order", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort());
  });

  it("has no duplicate version prefixes", () => {
    // A shared prefix means only one file ever runs while the version is recorded as applied,
    // silently orphaning the other forever.
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
