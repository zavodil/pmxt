import pg from 'pg';
import { config } from '../config';

pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric → number

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}
