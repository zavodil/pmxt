import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './client';
import { config } from '../config';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8').replaceAll(
    '__EMBED_DIM__',
    String(config.EMBED_DIM),
  );
  await pool.query(sql);
  console.log(`[migrate] applied schema (embedding dim = ${config.EMBED_DIM})`);
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
