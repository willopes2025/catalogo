import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { planoContas } from '../db/schema';

/** Grupos da DRE, na ordem em que aparecem. As contas de primeiro nível do plano são estes grupos. */
export const GRUPOS_DRE = [
  { chave: 'receita', nome: 'Receita bruta' },
  { chave: 'deducoes', nome: 'Deduções da receita' },
  { chave: 'custos', nome: 'Custos' },
  { chave: 'despesas_vendas', nome: 'Despesas com vendas' },
  { chave: 'despesas_pessoal', nome: 'Despesas com pessoal' },
  { chave: 'despesas_administrativas', nome: 'Despesas administrativas' },
  { chave: 'financeiro', nome: 'Resultado financeiro' },
  { chave: 'outras', nome: 'Outras receitas e despesas' },
  { chave: 'fora', nome: 'Fora do resultado' },
] as const;
export type GrupoDre = (typeof GRUPOS_DRE)[number]['chave'];

/** Contas que o sistema usa para lançar sozinho. */
export type ChavePlano = 'recebimentos' | 'consertos' | 'comissoes' | 'taxas_cartao' | 'devolucoes_caixa' | 'transferencias' | 'compras';

export type ContaPlano = typeof planoContas.$inferSelect;

@Injectable()
export class PlanoContasService {
  private porChave = new Map<string, { id: string; nome: string } | null>();

  constructor(@Inject(DB) private readonly db: Db) {}

  async todas(): Promise<ContaPlano[]> {
    return this.db.select().from(planoContas).orderBy(asc(planoContas.codigo));
  }

  /** Conta do sistema pela chave (para os lançamentos automáticos). Sem a conta, o título fica sem classificação. */
  async daChave(chave: ChavePlano): Promise<{ planoContaId: string | null; categoria?: string }> {
    let c = this.porChave.get(chave);
    if (c === undefined) {
      const [l] = await this.db.select({ id: planoContas.id, nome: planoContas.nome }).from(planoContas).where(eq(planoContas.chave, chave));
      c = l ?? null;
      if (c) this.porChave.set(chave, c);
    }
    return c ? { planoContaId: c.id } : { planoContaId: null };
  }

  esquecer() {
    this.porChave.clear();
  }

  /** Conta em que um título pode ser lançado: existe, está ativa, não é grupo nem calculada pelo sistema. */
  async paraLancar(id: string): Promise<ContaPlano> {
    const [c] = await this.db.select().from(planoContas).where(eq(planoContas.id, id));
    if (!c) throw new BadRequestException('Conta do plano de contas não encontrada.');
    if (!c.ativo) throw new BadRequestException(`A conta "${c.nome}" está desativada.`);
    if (!c.paiId) throw new BadRequestException(`"${c.nome}" é um grupo: escolha uma conta dentro dele.`);
    if (c.calculada) throw new BadRequestException(`"${c.nome}" é calculada pelo sistema (vendas, acertos e custo das peças); não recebe lançamento.`);
    return c;
  }
}
