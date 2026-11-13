import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Uma transação do Drizzle tem a mesma interface do banco. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function criarConexao(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL não definido');
  const pool = new Pool({ connectionString: url, max: 10 });
  return { pool, db: drizzle(pool, { schema }) };
}

export { schema };
