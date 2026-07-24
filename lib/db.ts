import { Pool } from "pg";

// LAZY pool — do NOT construct at module import. An eager `new Pool()` (or reading
// DATABASE_URL at import time) runs during `next build`, where the var is absent, and
// throws. The pool is created on first query and cached on globalThis across hot reloads.
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function getPool(): Pool {
  if (globalThis.__pgPool) return globalThis.__pgPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // SSL on for hosted (Neon/Vercel); off for a local Postgres.
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
  });
  globalThis.__pgPool = pool;
  return pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}
