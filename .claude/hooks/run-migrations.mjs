#!/usr/bin/env node
// Runs any unapplied Supabase migrations in order.
// Uses the Supabase Management API with service role key.
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

// Extract project ref from URL
const projectRef = SUPABASE_URL.replace('https://', '').split('.')[0];

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
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

async function runMigrations() {
  // Create tracking table
  await runSql(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    );
  `);

  // Get already-applied migrations
  const result = await runSql(`SELECT filename FROM _migrations ORDER BY filename;`);
  const rows = result.rows || result || [];
  const appliedSet = new Set(rows.map(r => r.filename || r[0]));

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
    await runSql(`INSERT INTO _migrations (filename) VALUES ('${file.replace(/'/g, "''")}') ON CONFLICT DO NOTHING;`);
    console.log(`  ✓ ${file} applied`);
    count++;
  }

  console.log(`\nMigrations complete. ${count} new migration(s) applied.`);
}

runMigrations().catch(err => {
  console.error('Migration runner failed:', err.message);
  process.exit(1);
});
