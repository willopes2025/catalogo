import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from './db.module';
import type { Tx } from '../db/client';
import { auditoria } from '../db/schema';

@Injectable()
export class AuditoriaService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Registra quem fez o quê. Aceita uma transação para gravar junto com a operação. */
  async registrar(
    p: { usuarioId?: string | null; acao: string; entidade: string; entidadeId?: string | null; dados?: unknown },
    tx?: Tx,
  ) {
    await (tx ?? this.db).insert(auditoria).values({
      usuarioId: p.usuarioId ?? null,
      acao: p.acao,
      entidade: p.entidade,
      entidadeId: p.entidadeId ?? null,
      dados: p.dados ?? null,
    });
  }
}
