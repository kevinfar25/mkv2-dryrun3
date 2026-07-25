import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SCHEMA_SQL } from "../../lib/schema";

// The hosted DB is migrated by POST /api/setup (SCHEMA_SQL); local/CI by
// db/migrations/*.sql. If the two drift, prod and dev silently disagree — so pin
// them byte-for-byte. Hermetic: reads a file, never opens a DB connection.
describe("SCHEMA_SQL", () => {
  it("is byte-equivalent to db/migrations/20260725010000_events.sql", () => {
    const migration = readFileSync(
      join(process.cwd(), "db", "migrations", "20260725010000_events.sql"),
      "utf8",
    );
    expect(SCHEMA_SQL).toBe(migration);
  });

  it("is expand-only (no drop/rename/type-narrow)", () => {
    expect(SCHEMA_SQL).toMatch(/create table if not exists events/);
    // Scan statements only — `-- ...no drop / rename...` comments are prose, not DDL.
    const statements = SCHEMA_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(statements).not.toMatch(/\bdrop\b|\brename\b|alter column/);
  });
});
