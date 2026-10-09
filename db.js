import pg from 'pg';

function resolveSsl(urlString) {
  const mode = (process.env.PGSSL || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  let host = '';
  try {
    host = new URL(urlString).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.railway.internal')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

const connectionString = process.env.DATABASE_URL;

export const pool = new pg.Pool({
  connectionString,
  ssl: connectionString ? resolveSsl(connectionString) : false,
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL CHECK (char_length(name) <= 120),
      type TEXT NOT NULL CHECK (type IN ('SERVICE', 'TOOL', 'FEATURE', 'LIBRARY')),
      description TEXT NOT NULL CHECK (char_length(description) <= 1000),
      owner TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEPRECATED')),
      repo_url TEXT,
      docs_url TEXT,
      install TEXT CHECK (install IS NULL OR char_length(install) <= 500),
      usage_example TEXT CHECK (usage_example IS NULL OR char_length(usage_example) <= 2000),
      tags TEXT[] NOT NULL DEFAULT '{}',
      last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Idempotent in-place migration for databases created before "catalog as code".
  // The inline constraints are only applied when the column is actually added.
  await pool.query(`
    ALTER TABLE items
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'GIT')),
      ADD COLUMN IF NOT EXISTS source_repo TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ
  `);
}
