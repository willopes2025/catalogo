import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { REGRAS_PADRAO, type RegrasConsignado } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { configuracoes, niveis, pessoas } from '../db/schema';
import { CONFIGS, type ChaveConfig, type ValorConfig } from './outras-configuracoes';

@Injectable()
export class ConfiguracoesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async regras(tx?: Tx): Promise<RegrasConsignado> {
    const [c] = await (tx ?? this.db).select().from(configuracoes).where(eq(configuracoes.chave, 'regras_consignado'));
    return { ...REGRAS_PADRAO, ...((c?.valor as Partial<RegrasConsignado>) ?? {}) };
  }

  /**
   * Regras com a comissão que vale para esta representante:
   * a comissão própria dela (cadastro) > a do nível > a padrão.
   */
  async regrasDaRepresentante(representanteId: string, tx?: Tx): Promise<RegrasConsignado> {
    const base = await this.regras(tx);
    const [n] = await (tx ?? this.db)
      .select({ propria: pessoas.comissaoPb, a: niveis.comissaoAvistaPb, p: niveis.comissaoPrazoPb })
      .from(pessoas)
      .leftJoin(niveis, eq(niveis.id, pessoas.nivelId))
      .where(eq(pessoas.id, representanteId));
    if (n?.propria != null) return { ...base, comissaoAvistaPb: n.propria, comissaoPrazoPb: n.propria };
    return { ...base, comissaoAvistaPb: n?.a ?? base.comissaoAvistaPb, comissaoPrazoPb: n?.p ?? base.comissaoPrazoPb };
  }

  async salvarRegras(valor: RegrasConsignado) {
    await this.db
      .insert(configuracoes)
      .values({ chave: 'regras_consignado', valor })
      .onConflictDoUpdate({ target: configuracoes.chave, set: { valor, atualizadoEm: new Date() } });
    return valor;
  }

  async ler<K extends ChaveConfig>(chave: K, tx?: Tx): Promise<ValorConfig<K>> {
    const [c] = await (tx ?? this.db).select().from(configuracoes).where(eq(configuracoes.chave, chave));
    return { ...CONFIGS[chave].padrao, ...((c?.valor as object) ?? {}) } as ValorConfig<K>;
  }

  async salvar<K extends ChaveConfig>(chave: K, valor: ValorConfig<K>) {
    await this.db.insert(configuracoes).values({ chave, valor }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor, atualizadoEm: new Date() } });
    return valor;
  }
}
