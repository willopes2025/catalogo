import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { Permissao } from '../comum/auth';
import { hoje } from '../maletas/maletas.service';
import { somarDias } from '@aritana/regras';

/** Relatórios gerenciais. Todos aceitam ?de=AAAA-MM-DD&ate=AAAA-MM-DD (padrão: últimos 30 dias). */
@Controller('relatorios')
export class RelatoriosController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private periodo(de?: string, ate?: string) {
    const fim = ate ?? hoje();
    const ini = de ?? somarDias(fim, -30);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ini) || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) throw new BadRequestException('Datas no formato AAAA-MM-DD.');
    return { ini, fim };
  }

  private num<T extends Record<string, unknown>>(rows: T[]) {
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
  }

  /** Desempenho por representante nos acertos do período. */
  @Get('desempenho')
  @Permissao('relatorios', 'ver')
  async desempenho(@Query('de') de?: string, @Query('ate') ate?: string) {
    const { ini, fim } = this.periodo(de, ate);
    const r = await this.db.execute(sql`
      select p.id, p.nome, p.cidade, n.nome as nivel, l.nome as lider,
        count(a.id)::int as acertos,
        coalesce(sum((a.resultado->'pecas'->>'emMaleta')::int),0)::int as pecas_acertadas,
        coalesce(sum((a.resultado->'pecas'->>'vendidas')::int),0)::int as pecas_vendidas,
        coalesce(sum((a.resultado->'pecas'->>'perdidas')::int),0)::int as pecas_perdidas,
        coalesce(sum((a.resultado->>'totalVendido')::int),0)::bigint as vendido,
        coalesce(sum((a.resultado->>'comissao')::int),0)::bigint as comissao,
        coalesce(sum(a.total_a_pagar),0)::bigint as devido_matriz,
        coalesce(round(avg((a.resultado->>'percentualVendidoPb')::int)),0)::int as percentual_medio_pb,
        coalesce(round(avg((a.resultado->>'diasAtraso')::int)),0)::int as atraso_medio
      from acertos a
      join maletas m on m.id = a.maleta_id
      join pessoas p on p.id = m.representante_id
      left join niveis n on n.id = p.nivel_id
      left join pessoas l on l.id = p.lider_id
      where a.data between ${ini} and ${fim}
      group by p.id, n.nome, l.nome
      order by vendido desc`);
    return { de: ini, ate: fim, linhas: this.num(r.rows) };
  }

  /** Maletas: na rua, atrasadas e representantes ativas sem maleta. */
  @Get('maletas')
  @Permissao('relatorios', 'ver')
  async maletas() {
    const atrasadas = await this.db.execute(sql`
      select m.numero, p.nome, p.telefone1 as telefone, m.data_limite, (current_date - m.data_limite)::int as dias_atraso,
        coalesce(sum(mi.preco * (mi.enviada - mi.vendida - mi.devolvida - mi.perdida)),0)::bigint as valor
      from maletas m join pessoas p on p.id = m.representante_id left join maleta_itens mi on mi.maleta_id = m.id
      where m.status = 'aberta' and m.data_limite < current_date
      group by m.id, p.nome, p.telefone1 order by dias_atraso desc`);
    const semMaleta = await this.db.execute(sql`
      select p.nome, p.cidade, p.telefone1 as telefone,
        (select max(a.data) from acertos a join maletas mm on mm.id = a.maleta_id where mm.representante_id = p.id) as ultimo_acerto
      from pessoas p
      where p.tipo = 'representante' and p.status = 'ativo' and p.modelo_trabalho = 'consignado'
        and not exists (select 1 from maletas m where m.representante_id = p.id and m.status = 'aberta')
      order by ultimo_acerto nulls first`);
    return { atrasadas: this.num(atrasadas.rows), semMaleta: this.num(semMaleta.rows) };
  }

  /** Produtos: vendidos no período (rede + loja), giro, estoque e peças paradas. */
  @Get('produtos')
  @Permissao('relatorios', 'ver')
  async produtos(@Query('de') de?: string, @Query('ate') ate?: string) {
    const { ini, fim } = this.periodo(de, ate);
    const r = await this.db.execute(sql`
      with vend as (
        select produto_id, sum(quantidade)::int as vendidas from movimentos
        where tipo = 'venda' and criado_em >= ${ini}::date and criado_em < ${fim}::date + 1
        group by produto_id
      ), est as (
        select s.produto_id,
          sum(case when l.tipo <> 'maleta' then s.quantidade else 0 end)::int as estoque,
          sum(case when l.tipo = 'maleta' then s.quantidade else 0 end)::int as em_maletas
        from saldos s join locais_estoque l on l.id = s.local_id group by s.produto_id
      )
      select p.codigo_barras, p.referencia, p.descricao, c.nome as categoria, p.preco, p.custo,
        coalesce(v.vendidas,0) as vendidas, coalesce(e.estoque,0) as estoque, coalesce(e.em_maletas,0) as em_maletas,
        coalesce(v.vendidas,0) * p.preco as faturamento,
        case when coalesce(e.estoque,0) + coalesce(e.em_maletas,0) > 0 then round(coalesce(v.vendidas,0)::numeric / (coalesce(e.estoque,0) + coalesce(e.em_maletas,0)), 2) else null end as giro
      from produtos p left join categorias c on c.id = p.categoria_id left join vend v on v.produto_id = p.id left join est e on e.produto_id = p.id
      where p.ativo
      order by faturamento desc nulls last, p.descricao`);
    const linhas = this.num(r.rows) as Record<string, number | string>[];
    // Curva ABC pelo faturamento: A = 80% do total, B = até 95%, C = o resto.
    const total = linhas.reduce((a, l) => a + Number(l.faturamento ?? 0), 0);
    let acumulado = 0;
    for (const l of linhas) {
      acumulado += Number(l.faturamento ?? 0);
      l.curva = !Number(l.faturamento) ? '—' : acumulado / total <= 0.8 ? 'A' : acumulado / total <= 0.95 ? 'B' : 'C';
    }
    return { de: ini, ate: fim, linhas };
  }

  /** Vendas por dia e por canal (acertos da rede e vendas da loja). */
  @Get('vendas')
  @Permissao('relatorios', 'ver')
  async vendas(@Query('de') de?: string, @Query('ate') ate?: string) {
    const { ini, fim } = this.periodo(de, ate);
    const porDia = await this.db.execute(sql`
      with d as (select generate_series(${ini}::date, ${fim}::date, '1 day')::date as dia)
      select d.dia,
        coalesce((select sum((a.resultado->>'totalVendido')::int) from acertos a where a.data = d.dia),0)::bigint as rede,
        coalesce((select sum(v.total) from vendas v where v.status = 'concluida' and v.tipo = 'balcao' and (v.criado_em at time zone 'America/Sao_Paulo')::date = d.dia),0)::bigint as loja,
        coalesce((select sum(v.total) from vendas v where v.status = 'concluida' and v.tipo <> 'balcao' and (v.criado_em at time zone 'America/Sao_Paulo')::date = d.dia),0)::bigint as outras
      from d order by d.dia`);
    const porForma = await this.db.execute(sql`
      select vp.forma, count(*)::int as quantidade, sum(vp.valor)::bigint as valor
      from venda_pagamentos vp join vendas v on v.id = vp.venda_id
      where v.status = 'concluida' and (v.criado_em at time zone 'America/Sao_Paulo')::date between ${ini} and ${fim}
      group by vp.forma order by valor desc`);
    return { de: ini, ate: fim, porDia: this.num(porDia.rows), porForma: this.num(porForma.rows) };
  }

  /** Financeiro: recebido e a receber por mês, e inadimplência por faixa de atraso. */
  @Get('financeiro')
  @Permissao('relatorios', 'ver')
  async financeiro() {
    const fluxo = await this.db.execute(sql`
      select to_char(date_trunc('month', coalesce(t.pago_em, t.vencimento)), 'YYYY-MM') as mes,
        coalesce(sum(case when t.tipo='receber' and t.status='pago' then t.valor_pago end),0)::bigint as recebido,
        coalesce(sum(case when t.tipo='pagar' and t.status='pago' then t.valor_pago end),0)::bigint as pago,
        coalesce(sum(case when t.tipo='receber' and t.status='aberto' then t.valor end),0)::bigint as a_receber,
        coalesce(sum(case when t.tipo='pagar' and t.status='aberto' then t.valor end),0)::bigint as a_pagar
      from titulos t where t.status in ('pago','aberto')
        and coalesce(t.pago_em, t.vencimento) >= date_trunc('month', current_date) - interval '5 months'
        and coalesce(t.pago_em, t.vencimento) < date_trunc('month', current_date) + interval '3 months'
      group by 1 order by 1`);
    const faixas = await this.db.execute(sql`
      select case when current_date - vencimento <= 15 then '1 a 15 dias' when current_date - vencimento <= 30 then '16 a 30 dias' when current_date - vencimento <= 60 then '31 a 60 dias' else 'Mais de 60 dias' end as faixa,
        count(*)::int as titulos, count(distinct pessoa_id)::int as pessoas, sum(valor)::bigint as valor
      from titulos where tipo = 'receber' and status = 'aberto' and vencimento < current_date
      group by 1 order by min(current_date - vencimento)`);
    const devedores = await this.db.execute(sql`
      select p.nome, p.telefone1 as telefone, count(*)::int as titulos, sum(t.valor)::bigint as valor, max(current_date - t.vencimento)::int as maior_atraso
      from titulos t join pessoas p on p.id = t.pessoa_id
      where t.tipo = 'receber' and t.status = 'aberto' and t.vencimento < current_date
      group by p.id order by valor desc limit 30`);
    return { fluxo: this.num(fluxo.rows), faixas: this.num(faixas.rows), devedores: this.num(devedores.rows) };
  }
}
