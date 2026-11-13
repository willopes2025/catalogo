import 'dotenv/config';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { criarConexao } from './client';

async function main() {
  const { db, pool } = criarConexao();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  await pool.end();
  console.log('Banco atualizado.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
