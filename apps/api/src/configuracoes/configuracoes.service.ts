import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { REGRAS_PADRAO, type RegrasConsignado } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { configuracoes, niveis, pessoas } from '../db/schema';

@Injectable()
export class ConfiguracoesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async regras(tx?: Tx): Promise<RegrasConsignado> {
    const [c] = await (tx ?? this.db).select().from(configuracoes).where(eq(configuracoes.chave, 'regras_consignado'));
    return { ...REGRAS_PADRAO, ...((c?.valor as Partial<RegrasConsignado>) ?? {}) };
  }

  /** Regras com a comissão do nível da representante, se o nível tiver comissão própria. */
  async regrasDaRepresentante(representanteId: string, tx?: Tx): Promise<RegrasConsignado> {
    const base = await this.regras(tx);
    const [n] = await (tx ?? this.db)
      .select({ a: niveis.comissaoAvistaPb, p: niveis.comissaoPrazoPb })
      .from(pessoas)
      .leftJoin(niveis, eq(niveis.id, pessoas.nivelId))
      .where(eq(pessoas.id, representanteId));
    return { ...base, comissaoAvistaPb: n?.a ?? base.comissaoAvistaPb, comissaoPrazoPb: n?.p ?? base.comissaoPrazoPb };
  }

  async salvarRegras(valor: RegrasConsignado) {
    await this.db
      .insert(configuracoes)
      .values({ chave: 'regras_consignado', valor })
      .onConflictDoUpdate({ target: configuracoes.chave, set: { valor, atualizadoEm: new Date() } });
    return valor;
  }
}
