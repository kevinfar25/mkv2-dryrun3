import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SCHEMA_SQL } from "../../lib/schema";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

/** Every migration, in version order — the exact sequence scripts/migrate.mjs applies. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// The hosted DB is migrated by POST /api/setup (SCHEMA_SQL); local/CI by
// db/migrations/*.sql. If the two drift, prod and dev silently disagree — so pin
// them byte-for-byte. Hermetic: reads files, never opens a DB connection.
describe("SCHEMA_SQL", () => {
  it("is byte-equivalent to db/migrations/*.sql concatenated in version order", () => {
    const files = migrationFiles();
    // A new migration that nobody mirrored into SCHEMA_SQL must fail here, so assert
    // the set we compared against is the WHOLE directory, not a hard-coded subset.
    expect(files).toEqual([
      "20260725010000_events.sql",
      "20260725020000_attendees.sql",
    ]);
    const migrations = files
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("");
    expect(SCHEMA_SQL).toBe(migrations);
  });

  it("is expand-only (no drop/rename/type-narrow)", () => {
    expect(SCHEMA_SQL).toMatch(/create table if not exists events/);
    expect(SCHEMA_SQL).toMatch(/create table if not exists attendees/);
    expect(SCHEMA_SQL).toMatch(
      /create unique index if not exists attendees_event_name_uniq/,
    );
    // Scan statements only — `-- ...no drop / rename...` comments are prose, not DDL.
    const statements = SCHEMA_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(statements).not.toMatch(/\bdrop\b|\brename\b|alter column/);
  });
});
