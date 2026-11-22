import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { ITENS_VENDIDOS, numeros } from '../relatorios/fontes';
import { GRUPOS_DRE, PlanoContasService, type ContaPlano, type GrupoDre } from './plano.service';

export type Regime = 'caixa' | 'competencia';

export interface LinhaDre {
  id: string;
  codigo: string;
  nome: string;
  nivel: number;
  calculada: boolean;
  ativo: boolean;
  /** Valor por mês, com sinal: receita positiva, custo e despesa negativos. */
  valores: number[];
  total: number;
  filhos: LinhaDre[];
}

const mesesEntre = (de: string, ate: string) => {
  const meses: string[] = [];
  let [a, m] = de.split('-').map(Number);
  const [af, mf] = ate.split('-').map(Number);
  while (a < af || (a === af && m <= mf)) {
    meses.push(`${a}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; a++; }
  }
  return meses;
};
const ultimoDia = (mes: string) => {
  const [a, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * DRE gerencial montada sobre o plano de contas.
 * - Receita, devoluções, comissão retida e custo das peças vêm das vendas e dos acertos (contas "calculadas"),
 *   sempre pela data da venda ou do acerto, para bater com os indicadores.
 * - O resto vem dos títulos classificados: no regime de caixa, pelo dia do pagamento; no de competência, pelo vencimento.
 * - O grupo "fora do resultado" (recebimento de vendas, compra de mercadoria, transferência, empréstimo) não entra na conta.
 */
@Injectable()
export class DreService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly plano: PlanoContasService,
  ) {}

  periodo(de?: string, ate?: string) {
    const agora = new Date(Date.now() - 3 * 3600_000);
    const atual = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
    const valido = (v?: string) => (v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null);
    const fim = valido(ate) ?? atual;
    let ini = valido(de);
    if (!ini) {
      const d = new Date(Date.UTC(Number(fim.slice(0, 4)), Number(fim.slice(5)) - 6, 1));
      ini = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    if (ini > fim) throw new BadRequestException('O mês inicial vem depois do final.');
    const meses = mesesEntre(ini, fim);
    if (meses.length > 24) throw new BadRequestException('Escolha no máximo 24 meses.');
    return { meses, ini: `${ini}-01`, fim: ultimoDia(fim) };
  }

  /** Valores das contas calculadas, por chave e mês. */
  private async calculadas(ini: string, fim: string, empresaId?: string) {
    const emp = (coluna: string) => (empresaId ? sql` and ${sql.raw(coluna)} = ${empresaId}::uuid` : sql``);
    const r = new Map<string, Map<string, number>>();
    const por = (chave: string, mes: string, v: number) => {
      if (!v) return;
      const m = r.get(chave) ?? new Map<string, number>();
      m.set(mes, (m.get(mes) ?? 0) + v);
      r.set(chave, m);
    };
    for (const l of numeros<{ mes: string; rede: number; comissao: number }>(
      await this.db.execute(sql`select to_char(a.data, 'YYYY-MM') as mes, coalesce(sum((a.resultado->>'totalVendido')::bigint), 0) as rede, coalesce(sum((a.resultado->>'comissao')::bigint), 0) as comissao from acertos a join maletas m on m.id = a.maleta_id where a.data between ${ini}::date and ${fim}::date${emp('m.empresa_id')} group by 1`),
    )) {
      por('vendas_rede', l.mes, l.rede);
      por('comissao_rede', l.mes, -l.comissao);
    }
    for (const l of numeros<{ mes: string; canal: string; vendas: number; devolucoes: number }>(
      await this.db.execute(sql`
        select to_char(v.criado_em::date, 'YYYY-MM') as mes,
          case when l.tipo = 'loja' and v.tipo = 'balcao' then 'vendas_lojas' when l.tipo = 'evento' then 'vendas_eventos' else 'vendas_outras' end as canal,
          coalesce(sum(v.total), 0) as vendas, coalesce(sum(v.devolvido), 0) as devolucoes
        from vendas v join locais_estoque l on l.id = v.local_id
        where v.status = 'concluida' and v.criado_em::date between ${ini}::date and ${fim}::date${emp('v.empresa_id')} group by 1, 2`),
    )) {
      por(l.canal, l.mes, l.vendas);
      por('devolucoes', l.mes, -l.devolucoes);
    }
    for (const l of numeros<{ mes: string; cmv: number }>(
      await this.db.execute(sql`select to_char(x.dia, 'YYYY-MM') as mes, coalesce(sum(x.custo), 0) as cmv from ${ITENS_VENDIDOS} x where x.dia between ${ini}::date and ${fim}::date${emp('x.empresa_id')} group by 1`),
    ))
      por('cmv', l.mes, -l.cmv);
    return r;
  }

  /** Títulos por conta e mês (com sinal: a receber soma, a pagar diminui). Sem conta: chave "sem:receber" ou "sem:pagar". */
  private async titulosPorConta(ini: string, fim: string, regime: Regime, empresaId?: string) {
    const emp = empresaId ? sql` and empresa_id = ${empresaId}::uuid` : sql``;
    const linhas = numeros<{ mes: string; conta: string | null; tipo: string; valor: number; n: number }>(
      regime === 'caixa'
        ? await this.db.execute(sql`
            select to_char(pago_em, 'YYYY-MM') as mes, plano_conta_id::text as conta, tipo, sum(coalesce(valor_pago, valor)) as valor, count(*)::int as n
            from titulos where status = 'pago' and pago_em between ${ini}::date and ${fim}::date${emp} group by 1, 2, 3`)
        : await this.db.execute(sql`
            select to_char(vencimento, 'YYYY-MM') as mes, plano_conta_id::text as conta, tipo, sum(valor) as valor, count(*)::int as n
            from titulos where status in ('aberto', 'pago', 'protestado') and vencimento between ${ini}::date and ${fim}::date${emp} group by 1, 2, 3`),
    );
    const r = new Map<string, Map<string, number>>();
    let semConta = 0;
    for (const l of linhas) {
      const chave = l.conta ?? `sem:${l.tipo}`;
      if (!l.conta) semConta += l.n;
      const m = r.get(chave) ?? new Map<string, number>();
      m.set(l.mes, (m.get(l.mes) ?? 0) + (l.tipo === 'receber' ? l.valor : -l.valor));
      r.set(chave, m);
    }
    return { porConta: r, semConta };
  }

  async montar(o: { de?: string; ate?: string; regime: Regime; empresaId?: string }) {
    const { meses, ini, fim } = this.periodo(o.de, o.ate);
    const [contas, calc, tit] = await Promise.all([this.plano.todas(), this.calculadas(ini, fim, o.empresaId), this.titulosPorConta(ini, fim, o.regime, o.empresaId)]);
    const zeros = () => meses.map(() => 0);
    const doMapa = (m?: Map<string, number>) => meses.map((mes) => m?.get(mes) ?? 0);
    const somar = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);

    // Títulos sem conta entram em "a classificar" (ou numa linha própria, se a empresa apagou essas contas).
    const proprio = new Map<string, number[]>();
    for (const c of contas) proprio.set(c.id, c.calculada ? doMapa(c.chave ? calc.get(c.chave) : undefined) : doMapa(tit.porConta.get(c.id)));
    const avulsas: LinhaDre[] = [];
    for (const [tipo, chave, nome] of [['receber', 'classificar_receitas', 'Receitas sem classificação'], ['pagar', 'classificar_despesas', 'Despesas sem classificação']] as const) {
      const v = doMapa(tit.porConta.get(`sem:${tipo}`));
      if (!v.some(Boolean)) continue;
      const destino = contas.find((c) => c.chave === chave);
      if (destino) proprio.set(destino.id, somar(proprio.get(destino.id)!, v));
      else avulsas.push({ id: `sem:${tipo}`, codigo: '', nome, nivel: 2, calculada: false, ativo: true, valores: v, total: v.reduce((a, b) => a + b, 0), filhos: [] });
    }

    const filhosDe = new Map<string | null, ContaPlano[]>();
    for (const c of contas) filhosDe.set(c.paiId, [...(filhosDe.get(c.paiId) ?? []), c]);
    const linha = (c: ContaPlano, nivel: number): LinhaDre => {
      const filhos = (filhosDe.get(c.id) ?? []).map((f) => linha(f, nivel + 1));
      const valores = filhos.reduce((a, f) => somar(a, f.valores), proprio.get(c.id) ?? zeros());
      return { id: c.id, codigo: c.codigo, nome: c.nome, nivel, calculada: c.calculada, ativo: c.ativo, valores, total: valores.reduce((a, b) => a + b, 0), filhos };
    };
    // Conta desativada e zerada no período não polui a DRE.
    const podar = (l: LinhaDre): LinhaDre => ({ ...l, filhos: l.filhos.filter((f) => f.ativo || f.valores.some(Boolean)).map(podar) });

    const grupos = GRUPOS_DRE.map((g) => {
      const raizes = (filhosDe.get(null) ?? []).filter((c) => c.grupo === g.chave).map((c) => podar(linha(c, 1)));
      const contasDoGrupo = raizes.length === 1 ? raizes[0].filhos : raizes;
      const extras = g.chave === 'outras' ? avulsas : [];
      const valores = [...raizes, ...extras].reduce((a, r) => somar(a, r.valores), zeros());
      return { chave: g.chave as GrupoDre, nome: raizes.length === 1 ? raizes[0].nome : g.nome, id: raizes.length === 1 ? raizes[0].id : null, valores, total: valores.reduce((a, b) => a + b, 0), contas: [...contasDoGrupo, ...extras] };
    });
    const g = (chave: GrupoDre) => grupos.find((x) => x.chave === chave)!.valores;
    const sub = (...chaves: GrupoDre[]) => chaves.reduce((a, c) => somar(a, g(c)), zeros());
    const total = (v: number[]) => ({ valores: v, total: v.reduce((a, b) => a + b, 0) });
    const receitaLiquida = sub('receita', 'deducoes');
    const lucroBruto = somar(receitaLiquida, g('custos'));
    const operacional = somar(lucroBruto, sub('despesas_vendas', 'despesas_pessoal', 'despesas_administrativas'));
    const resultado = somar(operacional, sub('financeiro', 'outras'));
    return {
      meses,
      regime: o.regime,
      grupos: grupos.filter((x) => x.chave !== 'fora'),
      fora: grupos.find((x) => x.chave === 'fora')!,
      subtotais: { receitaLiquida: total(receitaLiquida), lucroBruto: total(lucroBruto), operacional: total(operacional), resultado: total(resultado) },
      semClassificar: tit.semConta,
    };
  }

  /** Lançamentos de uma conta (e das contas dentro dela) num mês, para abrir a linha da DRE. */
  async lancamentos(o: { contaId: string; mes: string; regime: Regime; empresaId?: string }) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.mes)) throw new BadRequestException('Mês no formato AAAA-MM.');
    const ini = `${o.mes}-01`;
    const fim = ultimoDia(o.mes);
    const sem = /^sem:(receber|pagar)$/.exec(o.contaId);
    if (!sem && !/^[0-9a-f-]{36}$/i.test(o.contaId)) throw new BadRequestException('Conta inválida.');
    const contas = await this.plano.todas();
    const conta = contas.find((c) => c.id === o.contaId);
    if (!sem && !conta) throw new BadRequestException('Conta não encontrada.');
    const ids: string[] = [];
    const descer = (id: string) => {
      ids.push(id);
      contas.filter((c) => c.paiId === id).forEach((c) => descer(c.id));
    };
    if (conta) descer(conta.id);
    const calculadas = contas.filter((c) => ids.includes(c.id) && c.calculada);
    // "A classificar" também mostra os títulos que estão sem conta nenhuma.
    const tipoSem = sem ? sem[1] : conta?.chave === 'classificar_receitas' ? 'receber' : conta?.chave === 'classificar_despesas' ? 'pagar' : null;
    const daConta = ids.length ? sql`t.plano_conta_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql`false`;
    const filtro = tipoSem ? sql`(${daConta} or (t.plano_conta_id is null and t.tipo = ${tipoSem}))` : daConta;
    const periodo = o.regime === 'caixa' ? sql`t.status = 'pago' and t.pago_em between ${ini}::date and ${fim}::date` : sql`t.status in ('aberto', 'pago', 'protestado') and t.vencimento between ${ini}::date and ${fim}::date`;
    const itens = numeros<Record<string, unknown>>(
      await this.db.execute(sql`
        select t.id, t.tipo, t.descricao, t.status, t.vencimento, t.pago_em as "pagoEm", t.valor, t.valor_pago as "valorPago", t.forma_pagamento as "formaPagamento",
          p.nome as pessoa, e.nome as empresa, pc.codigo, pc.nome as conta, cb.nome as "contaBancaria"
        from titulos t join empresas e on e.id = t.empresa_id left join pessoas p on p.id = t.pessoa_id left join plano_contas pc on pc.id = t.plano_conta_id left join contas cb on cb.id = t.conta_id
        where ${filtro} and ${periodo}${o.empresaId ? sql` and t.empresa_id = ${o.empresaId}::uuid` : sql``}
        order by ${o.regime === 'caixa' ? sql`t.pago_em` : sql`t.vencimento`}, t.criado_em limit 500`),
    );
    return {
      conta: conta ? { id: conta.id, codigo: conta.codigo, nome: conta.nome } : { id: o.contaId, codigo: '', nome: tipoSem === 'receber' ? 'Receitas sem classificação' : 'Despesas sem classificação' },
      itens,
      calculadas: calculadas.map((c) => ({ codigo: c.codigo, nome: c.nome })),
    };
  }
}
