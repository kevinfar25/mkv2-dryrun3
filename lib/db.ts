import { Pool, type PoolClient } from "pg";

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

/**
 * Run `fn` inside a single BEGIN/COMMIT on one checked-out client. query() above is a
 * one-statement-per-connection helper, so anything needing statements to share a
 * transaction (e.g. a transaction-scoped advisory lock) must go through here.
 * Rolls back and rethrows on error; always releases the client.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}
