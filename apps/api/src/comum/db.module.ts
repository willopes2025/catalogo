import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { criarConexao, type Db } from '../db/client';

export const DB = Symbol('DB');
export const POOL = Symbol('POOL');

const conexao = () => criarConexao();
let cache: ReturnType<typeof conexao> | undefined;
const obter = () => (cache ??= conexao());

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: () => obter().db },
    { provide: POOL, useFactory: () => obter().pool },
  ],
  exports: [DB, POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
    cache = undefined;
  }
}

export type { Db };
