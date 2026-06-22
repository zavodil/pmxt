import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './client';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] chat-api schema applied');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
