#!/usr/bin/env node
// Runs any unapplied Supabase migrations in order.
// Tracks applied migrations in a _migrations table.
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping migrations');
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../supabase/migrations');

async function sql(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SQL error: ${text}`);
  }
  return res.json();
}

async function sqlDirect(query) {
  // Use pg REST endpoint for DDL statements
  const res = await fetch(`${SUPABASE_URL}/pg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SQL error: ${text}`);
  }
  return res.json().catch(() => ({}));
}

async function runMigrations() {
  // Bootstrap migrations tracking table via Supabase SQL editor API
  const bootstrapUrl = `${SUPABASE_URL}/rest/v1/`;

  // Use the management API to run SQL
  const baseUrl = SUPABASE_URL.replace('https://', '');
  const projectRef = baseUrl.split('.')[0];
  const mgmtBase = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

  async function runSql(query) {
    const res = await fetch(mgmtBase, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SQL error (${res.status}): ${text}`);
    }
    return res.json();
  }

  // Create tracking table
  await runSql(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    );
  `);

  // Get already-applied migrations
  const applied = await runSql(`SELECT filename FROM _migrations ORDER BY filename;`);
  const appliedSet = new Set((applied.rows || []).map(r => r.filename || r[0]));

  // Read migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  ✓ ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  → Applying ${file}…`);
    await runSql(sql);
    await runSql(`INSERT INTO _migrations (filename) VALUES ('${file.replace(/'/g, "''")}');`);
    console.log(`  ✓ ${file} applied`);
    count++;
  }

  console.log(`\nMigrations complete. ${count} new migration(s) applied.`);
}

runMigrations().catch(err => {
  console.error('Migration runner failed:', err.message);
  process.exit(1);
});
