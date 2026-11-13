import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from './comum/db.module';
import { Publico } from './comum/auth';

/** Usado pelo monitoramento e pela aba Suporte › Status do sistema. */
@Controller('saude')
export class SaudeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Publico()
  @Get()
  async saude() {
    const inicio = Date.now();
    await this.db.execute(sql`select 1`);
    return { ok: true, banco: `${Date.now() - inicio} ms`, versao: process.env.npm_package_version ?? '0.1.0' };
  }
}
