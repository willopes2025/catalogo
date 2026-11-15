import { BadRequestException, Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { diasEntre, somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao } from '../comum/auth';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { hoje } from '../maletas/maletas.service';
import { E_CARTAO, ITENS_DEVOLVIDOS_REDE, ITENS_VENDIDOS, NAO_E_CARTAO, numeros } from './fontes';

type N = Record<string, number>;
const pb = (parte: number, todo: number) => (todo > 0 ? Math.round((parte * 10000) / todo) : 0);
const variacaoPb = (agora: number, antes: number) => (antes > 0 ? Math.round(((agora - antes) * 10000) / antes) : null);

export interface Alerta { tom: 'erro' | 'alerta' | 'info' | 'ok'; titulo: string; texto: string; link?: string }

/**
 * Indicadores para decisão: visão do negócio, rede, produtos, financeiro e CRM.
 * Todos aceitam ?de=AAAA-MM-DD&ate=AAAA-MM-DD (padrão: mês corrente) e comparam com o período anterior de mesmo tamanho.
 * Faturamento é sempre líquido de devoluções; vendas canceladas não entram.
 */
@Controller('indicadores')
export class IndicadoresController {
  constructor(@Inject(DB) private readonly db: Db, private readonly config: ConfiguracoesService) {}

  private periodo(de?: string, ate?: string) {
    const h = hoje();
    const fim = ate ?? h;
    const ini = de ?? h.slice(0, 8) + '01';
    const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
    if (!ok(ini) || !ok(fim) || ini > fim) throw new BadRequestException('Período inválido.');
    const dias = diasEntre(ini, fim) + 1;
    if (dias > 800) throw new BadRequestException('Escolha um período de até dois anos.');
    return { ini, fim, dias, antIni: somarDias(ini, -dias), antFim: somarDias(ini, -1) };
  }

  /** Números de um período: faturamento por canal, comissão, custo, margem, acertos, recebimentos. */
  private async resultado(ini: string, fim: string) {
    const [r] = numeros<N>(
      await this.db.execute(sql`
        with ac as (
          select a.*, m.representante_id from acertos a join maletas m on m.id = a.maleta_id where a.data between ${ini}::date and ${fim}::date
        ), vd as (
          select v.total - v.devolvido as liquido, v.devolvido, l.tipo as local, v.tipo
          from vendas v join locais_estoque l on l.id = v.local_id
          where v.status = 'concluida' and v.criado_em::date between ${ini}::date and ${fim}::date
        ), iv as (
          select * from ${ITENS_VENDIDOS} x where x.dia between ${ini}::date and ${fim}::date
        )
        select
          (select coalesce(sum((resultado->>'totalVendido')::bigint), 0) from ac) as rede,
          (select coalesce(sum((resultado->>'comissao')::bigint), 0) from ac) as comissao_rede,
          (select coalesce(sum((resultado->>'perdidas')::bigint), 0) from ac) as perdas,
          (select coalesce(sum((resultado->>'multa')::bigint + (resultado->>'juros')::bigint), 0) from ac) as encargos,
          (select count(*) from ac)::int as acertos,
          (select count(distinct representante_id) from ac)::int as revendedoras_acertaram,
          (select coalesce(sum((resultado->'pecas'->>'vendidas')::int), 0) from ac)::int as pecas_vendidas_rede,
          (select coalesce(sum(((resultado->'pecas'->>'emMaleta')::int - coalesce((resultado->'pecas'->>'continuam')::int, 0))), 0) from ac)::int as pecas_acertadas,
          (select coalesce(avg((resultado->>'diasAtraso')::int) filter (where (resultado->>'diasAtraso')::int > 0), 0) from ac)::int as atraso_medio,
          (select count(*) filter (where (resultado->>'diasAtraso')::int > 0) from ac)::int as acertos_atrasados,
          (select coalesce(sum(liquido) filter (where local = 'loja' and tipo = 'balcao'), 0) from vd) as lojas,
          (select coalesce(sum(liquido) filter (where local = 'evento'), 0) from vd) as eventos,
          (select coalesce(sum(liquido) filter (where not (local = 'loja' and tipo = 'balcao') and local <> 'evento'), 0) from vd) as outras,
          (select coalesce(sum(devolvido), 0) from vd) as devolucoes,
          (select count(*) from vd)::int as vendas,
          (select coalesce(sum(custo), 0) from iv) as cmv,
          (select coalesce(sum(qtd), 0) from iv)::int as pecas_vendidas,
          (select coalesce(sum(valor) filter (where custo = 0), 0) from iv) as vendido_sem_custo,
          (select coalesce(sum(valor_pago), 0) from titulos where tipo = 'receber' and status = 'pago' and pago_em between ${ini}::date and ${fim}::date) as recebido,
          (select coalesce(sum(valor_pago), 0) from titulos where tipo = 'pagar' and status = 'pago' and pago_em between ${ini}::date and ${fim}::date) as pago,
          (select count(*) from pessoas where tipo = 'representante' and criado_em::date between ${ini}::date and ${fim}::date and id_jueri is null)::int as novas_revendedoras`),
    );
    const balcao = r.lojas + r.eventos + r.outras;
    const faturamento = r.rede + balcao;
    const receitaLiquida = faturamento - r.comissao_rede;
    const lucroBruto = receitaLiquida - r.cmv;
    return {
      faturamento,
      rede: r.rede,
      lojas: r.lojas,
      eventos: r.eventos,
      outras: r.outras,
      devolucoes: r.devolucoes,
      comissaoRede: r.comissao_rede,
      receitaLiquida,
      cmv: r.cmv,
      lucroBruto,
      margemPb: pb(lucroBruto, faturamento),
      vendidoSemCusto: r.vendido_sem_custo,
      perdas: r.perdas,
      encargos: r.encargos,
      acertos: r.acertos,
      acertoMedio: r.acertos ? Math.round(r.rede / r.acertos) : 0,
      revendedorasAcertaram: r.revendedoras_acertaram,
      vendaPorRevendedora: r.revendedoras_acertaram ? Math.round(r.rede / r.revendedoras_acertaram) : 0,
      sellThroughPb: pb(r.pecas_vendidas_rede, r.pecas_acertadas),
      acertosAtrasadosPb: pb(r.acertos_atrasados, r.acertos),
      atrasoMedio: r.atraso_medio,
      vendas: r.vendas,
      ticketMedio: r.vendas ? Math.round(balcao / r.vendas) : 0,
      pecasVendidas: r.pecas_vendidas,
      recebido: r.recebido,
      pago: r.pago,
      novasRevendedoras: r.novas_revendedoras,
    };
  }

  /** Fotografia de agora: capital na rua, estoque, contas e situação da rede. */
  private async foto() {
    const [f] = numeros<N>(
      await this.db.execute(sql`
        with rua as (
          select m.id, m.data_limite, m.data_retirada,
            coalesce(sum(mi.preco * (mi.enviada - mi.vendida - mi.devolvida - mi.perdida)), 0) as preco,
            coalesce(sum(mi.custo * (mi.enviada - mi.vendida - mi.devolvida - mi.perdida)), 0) as custo,
            coalesce(sum(mi.enviada - mi.vendida - mi.devolvida - mi.perdida), 0) as pecas
          from maletas m left join maleta_itens mi on mi.maleta_id = m.id where m.status = 'aberta' group by m.id
        ), est as (
          select coalesce(sum(s.quantidade * p.custo), 0) as custo, coalesce(sum(s.quantidade * p.preco), 0) as preco, coalesce(sum(s.quantidade), 0) as pecas,
            count(distinct p.id) filter (where p.custo = 0 and s.quantidade > 0) as sem_custo
          from saldos s join locais_estoque l on l.id = s.local_id and l.tipo <> 'maleta' join produtos p on p.id = s.produto_id where s.quantidade > 0
        ), rep as (
          select p.id,
            exists (select 1 from maletas m where m.representante_id = p.id and m.status = 'aberta') as com_maleta,
            (select max(a.data) from acertos a join maletas m on m.id = a.maleta_id where m.representante_id = p.id) as ultimo
          from pessoas p where p.tipo = 'representante' and p.status = 'ativo'
        )
        select
          (select count(*) from rua)::int as maletas_abertas,
          (select coalesce(sum(preco), 0) from rua) as rua_preco,
          (select coalesce(sum(custo), 0) from rua) as rua_custo,
          (select coalesce(sum(pecas), 0) from rua)::int as rua_pecas,
          (select count(*) from rua where data_limite < current_date)::int as maletas_atrasadas,
          (select coalesce(sum(preco), 0) from rua where data_limite < current_date) as rua_atrasado,
          (select coalesce(avg(current_date - data_retirada), 0) from rua)::int as idade_media_maletas,
          (select custo from est) as estoque_custo, (select preco from est) as estoque_preco, (select pecas from est)::int as estoque_pecas, (select sem_custo from est)::int as produtos_sem_custo,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${NAO_E_CARTAO}) as a_receber,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${NAO_E_CARTAO} and vencimento < current_date) as vencido,
          (select count(distinct pessoa_id) from titulos where tipo = 'receber' and status = 'aberto' and ${NAO_E_CARTAO} and vencimento < current_date)::int as devedores,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${E_CARTAO}) as cartao_a_receber,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${E_CARTAO} and vencimento < current_date) as cartao_a_conciliar,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'pagar' and status = 'aberto') as a_pagar,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'pagar' and status = 'aberto' and vencimento < current_date) as a_pagar_vencido,
          (select coalesce(sum(c.saldo_inicial + coalesce((select sum(case when t.tipo = 'receber' then t.valor_pago else -t.valor_pago end) from titulos t where t.conta_id = c.id and t.status = 'pago'), 0)), 0) from contas c where c.ativo) as saldo_contas,
          (select count(*) from rep)::int as ativas,
          (select count(*) from rep where com_maleta)::int as com_maleta,
          (select count(*) from rep where not com_maleta and (ultimo is null or ultimo < current_date - 60))::int as paradas,
          (select count(*) from pessoas where tipo = 'representante' and status = 'triagem')::int as triagem,
          (select coalesce(avg(a.data - m.data_retirada), 0) from acertos a join maletas m on m.id = a.maleta_id where not a.parcial and a.data >= current_date - 90)::int as ciclo_medio,
          (select coalesce(sum(x.custo), 0) from ${ITENS_VENDIDOS} x where x.dia >= current_date - 90) as cmv_90`),
    );
    const capital = f.rua_custo + f.estoque_custo;
    return {
      maletasAbertas: f.maletas_abertas,
      ruaPreco: f.rua_preco,
      ruaCusto: f.rua_custo,
      ruaPecas: f.rua_pecas,
      maletasAtrasadas: f.maletas_atrasadas,
      ruaAtrasado: f.rua_atrasado,
      idadeMediaMaletas: f.idade_media_maletas,
      cicloMedio: f.ciclo_medio,
      estoqueCusto: f.estoque_custo,
      estoquePreco: f.estoque_preco,
      estoquePecas: f.estoque_pecas,
      produtosSemCusto: f.produtos_sem_custo,
      capitalEmPecas: capital,
      /** Quantos dias o estoque (casa + rua) dura no ritmo de venda dos últimos 90 dias. */
      coberturaDias: f.cmv_90 > 0 ? Math.round(capital / (f.cmv_90 / 90)) : null,
      aReceber: f.a_receber,
      vencido: f.vencido,
      devedores: f.devedores,
      inadimplenciaPb: pb(f.vencido, f.a_receber),
      cartaoAReceber: f.cartao_a_receber,
      cartaoAConciliar: f.cartao_a_conciliar,
      aPagar: f.a_pagar,
      aPagarVencido: f.a_pagar_vencido,
      saldoContas: f.saldo_contas,
      revendedoras: { ativas: f.ativas, comMaleta: f.com_maleta, semMaleta: f.ativas - f.com_maleta, paradas: f.paradas, triagem: f.triagem },
    };
  }

  @Get('geral')
  @Permissao('relatorios', 'ver')
  async geral(@Query('de') de?: string, @Query('ate') ate?: string) {
    const p = this.periodo(de, ate);
    const [atual, anterior, foto, regras] = await Promise.all([this.resultado(p.ini, p.fim), this.resultado(p.antIni, p.antFim), this.foto(), this.config.regras()]);
    const serie = numeros<N & { mes: string }>(
      await this.db.execute(sql`
        with meses as (select generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month')::date as mes),
        ac as (select date_trunc('month', data)::date as mes, sum((resultado->>'totalVendido')::bigint) as rede, sum((resultado->>'comissao')::bigint) as comissao from acertos where data >= date_trunc('month', current_date) - interval '11 months' group by 1),
        vd as (
          select date_trunc('month', v.criado_em)::date as mes,
            sum(v.total - v.devolvido) filter (where l.tipo = 'loja' and v.tipo = 'balcao') as lojas,
            sum(v.total - v.devolvido) filter (where l.tipo = 'evento') as eventos,
            sum(v.total - v.devolvido) filter (where not (l.tipo = 'loja' and v.tipo = 'balcao') and l.tipo <> 'evento') as outras
          from vendas v join locais_estoque l on l.id = v.local_id
          where v.status = 'concluida' and v.criado_em >= date_trunc('month', current_date) - interval '11 months' group by 1),
        cm as (select date_trunc('month', x.dia)::date as mes, sum(x.custo) as cmv from ${ITENS_VENDIDOS} x where x.dia >= date_trunc('month', current_date) - interval '11 months' group by 1),
        rc as (select date_trunc('month', pago_em)::date as mes, sum(valor_pago) as recebido from titulos where tipo = 'receber' and status = 'pago' and pago_em >= date_trunc('month', current_date) - interval '11 months' group by 1)
        select to_char(m.mes, 'YYYY-MM') as mes, coalesce(ac.rede, 0) as rede, coalesce(ac.comissao, 0) as comissao, coalesce(vd.lojas, 0) as lojas, coalesce(vd.eventos, 0) as eventos,
          coalesce(vd.outras, 0) as outras, coalesce(cm.cmv, 0) as cmv, coalesce(rc.recebido, 0) as recebido
        from meses m left join ac on ac.mes = m.mes left join vd on vd.mes = m.mes left join cm on cm.mes = m.mes left join rc on rc.mes = m.mes order by m.mes`),
    ).map((s) => {
      const faturamento = s.rede + s.lojas + s.eventos + s.outras;
      return { ...s, faturamento, lucroBruto: faturamento - s.comissao - s.cmv, margemPb: pb(faturamento - s.comissao - s.cmv, faturamento) };
    });

    const variacoes = Object.fromEntries(
      (['faturamento', 'rede', 'lojas', 'eventos', 'receitaLiquida', 'lucroBruto', 'acertos', 'ticketMedio', 'acertoMedio', 'recebido', 'pecasVendidas', 'vendaPorRevendedora'] as const).map((k) => [k, variacaoPb(atual[k], anterior[k])]),
    );
    return { periodo: p, atual, anterior, variacoes, foto, serie, metaSellThroughPb: regras.metaMinimaVendidaPb, alertas: this.alertas(atual, anterior, foto, regras.metaMinimaVendidaPb) };
  }

  /** O que o número está dizendo, em português, com o caminho para agir. */
  private alertas(a: Awaited<ReturnType<IndicadoresController['resultado']>>, ant: Awaited<ReturnType<IndicadoresController['resultado']>>, f: Awaited<ReturnType<IndicadoresController['foto']>>, metaPb: number): Alerta[] {
    const r: Alerta[] = [];
    const reais = (c: number) => `R$ ${(c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pct = (x: number) => `${(x / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
    const queda = variacaoPb(a.faturamento, ant.faturamento);
    if (queda !== null && queda <= -1500) r.push({ tom: 'erro', titulo: `Faturamento caiu ${pct(-queda)}`, texto: `${reais(a.faturamento)} agora contra ${reais(ant.faturamento)} no período anterior de mesmo tamanho.` });
    else if (queda !== null && queda >= 1500) r.push({ tom: 'ok', titulo: `Faturamento cresceu ${pct(queda)}`, texto: `${reais(a.faturamento)} agora contra ${reais(ant.faturamento)} no período anterior.` });
    if (f.maletasAtrasadas) r.push({ tom: 'erro', titulo: `${f.maletasAtrasadas} maleta(s) com acerto atrasado`, texto: `${reais(f.ruaAtrasado)} em peças paradas com revendedoras fora do prazo.`, link: '/maletas?aba=atrasadas' });
    if (f.inadimplenciaPb >= 1000) r.push({ tom: 'erro', titulo: `Inadimplência em ${pct(f.inadimplenciaPb)}`, texto: `${reais(f.vencido)} vencidos de ${f.devedores} pessoa(s), sobre ${reais(f.aReceber)} a receber.`, link: '/relatorios?aba=financeiro' });
    else if (f.vencido > 0) r.push({ tom: 'alerta', titulo: `${reais(f.vencido)} vencidos`, texto: `${f.devedores} pessoa(s) em atraso (${pct(f.inadimplenciaPb)} do que há a receber).`, link: '/relatorios?aba=financeiro' });
    if (a.acertos >= 3 && a.sellThroughPb < metaPb) r.push({ tom: 'alerta', titulo: `Rede vendeu ${pct(a.sellThroughPb)} das peças acertadas`, texto: `Abaixo da meta de ${pct(metaPb)}. Veja em Rede quem vende menos e em Produtos o que mais volta.`, link: '/relatorios?aba=rede' });
    if (f.revendedoras.paradas) r.push({ tom: 'alerta', titulo: `${f.revendedoras.paradas} revendedora(s) ativas paradas`, texto: 'Sem maleta aberta e sem acerto há mais de 60 dias. São as mais baratas de reativar.', link: '/relatorios?aba=rede' });
    if (f.revendedoras.triagem) r.push({ tom: 'info', titulo: `${f.revendedoras.triagem} candidata(s) esperando análise`, texto: 'Cada dia de espera esfria a candidata.', link: '/crm' });
    if (f.coberturaDias !== null && f.coberturaDias > 240) r.push({ tom: 'alerta', titulo: `Estoque para ${f.coberturaDias} dias`, texto: `${reais(f.capitalEmPecas)} em peças (a custo) no ritmo atual de venda. Veja em Produtos o que está parado.`, link: '/relatorios?aba=produtos' });
    if (f.coberturaDias !== null && f.coberturaDias < 45) r.push({ tom: 'alerta', titulo: `Estoque para só ${f.coberturaDias} dias`, texto: 'No ritmo atual de venda, falta peça em breve. Veja a sugestão de reposição em Produtos.', link: '/relatorios?aba=produtos' });
    if (a.faturamento > 0 && a.vendidoSemCusto > a.faturamento * 0.1) r.push({ tom: 'alerta', titulo: 'Margem imprecisa: peças vendidas sem custo cadastrado', texto: `${reais(a.vendidoSemCusto)} vendidos de produtos com custo zero. Preencha o custo para a margem ficar certa.`, link: '/produtos' });
    else if (f.produtosSemCusto > 0) r.push({ tom: 'info', titulo: `${f.produtosSemCusto} produto(s) em estoque sem custo`, texto: 'Sem custo, o sistema não calcula margem nem capital parado desses produtos.', link: '/produtos' });
    if (f.cartaoAConciliar > 0) r.push({ tom: 'info', titulo: `${reais(f.cartaoAConciliar)} de cartão para conciliar`, texto: 'Repasses de maquininha com data vencida que ainda não foram baixados no Financeiro.', link: '/financeiro' });
    if (f.aPagarVencido > 0) r.push({ tom: 'alerta', titulo: `${reais(f.aPagarVencido)} de contas a pagar vencidas`, texto: 'Contas da empresa que passaram do vencimento.', link: '/financeiro' });
    if (a.faturamento > 0 && a.devolucoes > (a.lojas + a.eventos + a.outras + a.devolucoes) * 0.08) r.push({ tom: 'alerta', titulo: 'Devoluções altas na loja', texto: `${reais(a.devolucoes)} devolvidos no período.`, link: '/vendas' });
    const peso = { erro: 0, alerta: 1, info: 2, ok: 3 };
    return r.sort((x, y) => peso[x.tom] - peso[y.tom]);
  }

  /** Rede: cada revendedora no período, com tendência, risco e curva ABC; mais os cortes por cidade, líder e nível. */
  @Get('rede')
  @Permissao('relatorios', 'ver')
  async rede(@Query('de') de?: string, @Query('ate') ate?: string) {
    const p = this.periodo(de, ate);
    const regras = await this.config.regras();
    const linhas = numeros<Record<string, any>>(
      await this.db.execute(sql`
        with ac as (select a.*, m.representante_id as rid, m.data_retirada from acertos a join maletas m on m.id = a.maleta_id),
        per as (
          select rid, count(*)::int as acertos, sum((resultado->>'totalVendido')::bigint) as vendido, sum((resultado->>'comissao')::bigint) as comissao,
            sum((resultado->'pecas'->>'vendidas')::int)::int as pecas_vendidas, sum(((resultado->'pecas'->>'emMaleta')::int - coalesce((resultado->'pecas'->>'continuam')::int, 0)))::int as pecas_acertadas,
            coalesce(sum((resultado->>'perdidas')::bigint), 0) as perdas, max((resultado->>'diasAtraso')::int)::int as maior_atraso,
            round(avg(data - data_retirada) filter (where not parcial))::int as ciclo
          from ac where data between ${p.ini}::date and ${p.fim}::date group by rid),
        ant as (select rid, sum((resultado->>'totalVendido')::bigint) as vendido from ac where data between ${p.antIni}::date and ${p.antFim}::date group by rid),
        vida as (select rid, max(data) as ultimo, count(*)::int as acertos, sum((resultado->>'totalVendido')::bigint) as vendido from ac group by rid),
        ab as (
          select m.representante_id as rid, min(m.data_limite) as limite, count(distinct m.id)::int as maletas,
            coalesce(sum(mi.preco * (mi.enviada - mi.vendida - mi.devolvida - mi.perdida)), 0) as valor
          from maletas m left join maleta_itens mi on mi.maleta_id = m.id where m.status = 'aberta' group by 1),
        venc as (select pessoa_id as rid, sum(valor) as vencido, max(current_date - vencimento)::int as dias from titulos where tipo = 'receber' and status = 'aberto' and vencimento < current_date and pessoa_id is not null group by 1)
        select p.id, p.nome, p.cidade, p.uf, p.telefone1 as telefone, n.nome as nivel, l.nome as lider, p.status, p.criado_em::date as desde, p.limite_credito as limite, p.bloqueado,
          coalesce(per.acertos, 0) as acertos, coalesce(per.vendido, 0) as vendido, coalesce(per.comissao, 0) as comissao, coalesce(per.pecas_vendidas, 0) as pecas_vendidas,
          coalesce(per.pecas_acertadas, 0) as pecas_acertadas, coalesce(per.perdas, 0) as perdas, coalesce(per.maior_atraso, 0) as maior_atraso, per.ciclo,
          coalesce(ant.vendido, 0) as vendido_anterior, vida.ultimo as ultimo_acerto, coalesce(vida.acertos, 0) as acertos_vida, coalesce(vida.vendido, 0) as vendido_vida,
          coalesce(ab.maletas, 0) as maletas_abertas, coalesce(ab.valor, 0) as em_maleta, ab.limite as acerto_ate,
          coalesce(venc.vencido, 0) as vencido, coalesce(venc.dias, 0) as dias_vencido
        from pessoas p
        left join niveis n on n.id = p.nivel_id left join pessoas l on l.id = p.lider_id
        left join per on per.rid = p.id left join ant on ant.rid = p.id left join vida on vida.rid = p.id left join ab on ab.rid = p.id left join venc on venc.rid = p.id
        where p.tipo = 'representante' and (p.status = 'ativo' or per.rid is not null or ab.rid is not null or venc.rid is not null)
        order by coalesce(per.vendido, 0) desc, p.nome`),
    );
    const h = hoje();
    const total = linhas.reduce((a, l) => a + l.vendido, 0);
    let acumulado = 0;
    const iso = (d: unknown) => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
    for (const l of linhas) {
      l.ultimo_acerto = iso(l.ultimo_acerto);
      l.acerto_ate = iso(l.acerto_ate);
      l.desde = iso(l.desde);
      acumulado += l.vendido;
      l.curva = !l.vendido ? '—' : acumulado / total <= 0.8 ? 'A' : acumulado / total <= 0.95 ? 'B' : 'C';
      l.sell_through_pb = pb(l.pecas_vendidas, l.pecas_acertadas);
      l.tendencia_pb = variacaoPb(l.vendido, l.vendido_anterior);
      l.dias_sem_acerto = l.ultimo_acerto ? diasEntre(l.ultimo_acerto, h) : null;
      l.dias_atraso_maleta = l.acerto_ate && l.acerto_ate < h ? diasEntre(l.acerto_ate, h) : 0;
      const riscos: string[] = [];
      if (l.dias_atraso_maleta > 0) riscos.push(`maleta atrasada ${l.dias_atraso_maleta} d`);
      if (l.vencido > 0) riscos.push(`deve há ${l.dias_vencido} d`);
      if (l.vendido_anterior > 0 && l.vendido < l.vendido_anterior * 0.5) riscos.push('venda caiu pela metade');
      if (l.status === 'ativo' && !l.maletas_abertas && (l.dias_sem_acerto === null || l.dias_sem_acerto > 60)) riscos.push(l.dias_sem_acerto === null ? 'nunca acertou e está sem maleta' : `parada há ${l.dias_sem_acerto} d`);
      if (l.acertos > 0 && l.sell_through_pb < regras.metaMinimaVendidaPb) riscos.push('vende abaixo da meta');
      if (l.perdas > 0) riscos.push('teve peça perdida');
      l.riscos = riscos;
      l.risco = (l.dias_atraso_maleta > 0 ? 3 : 0) + (l.vencido > 0 ? 3 : 0) + (riscos.length ? riscos.length : 0);
    }
    const grupo = (chave: string) => {
      const m = new Map<string, { nome: string; revendedoras: number; acertaram: number; vendido: number; pv: number; pa: number; em_maleta: number; vencido: number }>();
      for (const l of linhas) {
        const k = l[chave] || '(sem)';
        const g = m.get(k) ?? { nome: k, revendedoras: 0, acertaram: 0, vendido: 0, pv: 0, pa: 0, em_maleta: 0, vencido: 0 };
        g.revendedoras++;
        if (l.acertos) g.acertaram++;
        g.vendido += l.vendido;
        g.pv += l.pecas_vendidas;
        g.pa += l.pecas_acertadas;
        g.em_maleta += l.em_maleta;
        g.vencido += l.vencido;
        m.set(k, g);
      }
      return [...m.values()].map(({ pv, pa, ...g }) => ({ ...g, sell_through_pb: pb(pv, pa), media: g.acertaram ? Math.round(g.vendido / g.acertaram) : 0 })).sort((a, b) => b.vendido - a.vendido);
    };
    const comVenda = linhas.filter((l) => l.vendido > 0);
    const vendiamAntes = linhas.filter((l) => l.vendido_anterior > 0);
    const faixas = [
      ['Menos de 20%', 0, 2000],
      ['20% a 40%', 2000, 4000],
      ['40% a 60%', 4000, 6000],
      ['60% a 80%', 6000, 8000],
      ['80% ou mais', 8000, 100001],
    ].map(([nome, de2, ate2]) => ({ nome, revendedoras: linhas.filter((l) => l.acertos > 0 && l.sell_through_pb >= (de2 as number) && l.sell_through_pb < (ate2 as number)).length }));
    return {
      periodo: p,
      metaSellThroughPb: regras.metaMinimaVendidaPb,
      resumo: {
        ativas: linhas.filter((l) => l.status === 'ativo').length,
        acertaram: linhas.filter((l) => l.acertos > 0).length,
        vendido: total,
        mediaPorRevendedora: comVenda.length ? Math.round(total / comVenda.length) : 0,
        top10Pb: pb(linhas.slice(0, 10).reduce((a, l) => a + l.vendido, 0), total),
        curvaA: linhas.filter((l) => l.curva === 'A').length,
        /** Das que venderam no período anterior, quantas venderam de novo agora. */
        retencaoPb: pb(vendiamAntes.filter((l) => l.vendido > 0).length, vendiamAntes.length),
        emRisco: linhas.filter((l) => l.risco >= 3).length,
        sellThroughPb: pb(linhas.reduce((a, l) => a + l.pecas_vendidas, 0), linhas.reduce((a, l) => a + l.pecas_acertadas, 0)),
      },
      linhas,
      porCidade: grupo('cidade'),
      porLider: grupo('lider'),
      porNivel: grupo('nivel'),
      faixas,
    };
  }

  /** Produtos: o que vende, o que dá margem, o que repor, o que está parado e o que a rede devolve. */
  @Get('produtos')
  @Permissao('relatorios', 'ver')
  async produtos(@Query('de') de?: string, @Query('ate') ate?: string) {
    const p = this.periodo(de, ate);
    const linhas = numeros<Record<string, any>>(
      await this.db.execute(sql`
        with iv as (select * from ${ITENS_VENDIDOS} x),
        v as (
          select produto_id, sum(qtd)::int as vendidas, sum(valor) as faturamento, sum(custo) as cmv, coalesce(sum(qtd) filter (where canal = 'rede'), 0)::int as vendidas_rede
          from iv where dia between ${p.ini}::date and ${p.fim}::date group by 1),
        ult as (select produto_id, max(dia) as ultima from iv group by 1),
        dev as (select produto_id, sum(qtd)::int as devolvidas from ${ITENS_DEVOLVIDOS_REDE} d where d.dia between ${p.ini}::date and ${p.fim}::date group by 1),
        est as (
          select s.produto_id,
            sum(case when l.tipo <> 'maleta' then s.quantidade else 0 end)::int as estoque,
            sum(case when l.tipo = 'maleta' then s.quantidade else 0 end)::int as em_maletas
          from saldos s join locais_estoque l on l.id = s.local_id group by s.produto_id)
        select p.id, p.codigo_barras, p.referencia, p.descricao, coalesce(c.nome, '(sem categoria)') as categoria, p.preco, p.custo, p.estoque_minimo, p.criado_em::date as cadastrado_em,
          coalesce(v.vendidas, 0) as vendidas, coalesce(v.faturamento, 0) as faturamento, coalesce(v.cmv, 0) as cmv, coalesce(v.vendidas_rede, 0) as vendidas_rede,
          coalesce(dev.devolvidas, 0) as devolvidas_rede, coalesce(e.estoque, 0) as estoque, coalesce(e.em_maletas, 0) as em_maletas, ult.ultima as ultima_venda
        from produtos p
        left join categorias c on c.id = p.categoria_id left join v on v.produto_id = p.id left join ult on ult.produto_id = p.id left join dev on dev.produto_id = p.id left join est e on e.produto_id = p.id
        where p.ativo and (coalesce(v.vendidas, 0) > 0 or coalesce(e.estoque, 0) > 0 or coalesce(e.em_maletas, 0) > 0 or coalesce(dev.devolvidas, 0) > 0)
        order by coalesce(v.faturamento, 0) desc, p.descricao`),
    );
    const h = hoje();
    const iso = (d: unknown) => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
    const total = linhas.reduce((a, l) => a + l.faturamento, 0);
    let acumulado = 0;
    for (const l of linhas) {
      l.ultima_venda = iso(l.ultima_venda);
      l.cadastrado_em = iso(l.cadastrado_em);
      acumulado += l.faturamento;
      l.curva = !l.faturamento ? '—' : acumulado / total <= 0.8 ? 'A' : acumulado / total <= 0.95 ? 'B' : 'C';
      l.margem = l.faturamento - l.cmv;
      l.margem_pb = l.cmv > 0 ? pb(l.margem, l.faturamento) : null;
      /** Margem de tabela: quanto sobra do preço depois do custo. */
      l.markup_pb = l.custo > 0 && l.preco > 0 ? pb(l.preco - l.custo, l.preco) : null;
      l.aceitacao_pb = l.vendidas_rede + l.devolvidas_rede > 0 ? pb(l.vendidas_rede, l.vendidas_rede + l.devolvidas_rede) : null;
      const porDia = l.vendidas / p.dias;
      l.cobertura_dias = porDia > 0 ? Math.round(l.estoque / porDia) : null;
      l.dias_sem_venda = l.ultima_venda ? diasEntre(l.ultima_venda, h) : null;
      /** Reposição para 45 dias de venda, descontado o que há em casa. O que está na rua não conta: pode voltar ou não. */
      l.sugestao = porDia > 0 ? Math.max(0, Math.ceil(porDia * 45) - l.estoque) : 0;
      l.parado_custo = l.estoque * l.custo;
    }
    const categorias = new Map<string, any>();
    for (const l of linhas) {
      const g = categorias.get(l.categoria) ?? { categoria: l.categoria, produtos: 0, vendidas: 0, faturamento: 0, cmv: 0, vr: 0, dr: 0, estoque: 0, em_maletas: 0, estoque_custo: 0 };
      g.produtos++;
      g.vendidas += l.vendidas;
      g.faturamento += l.faturamento;
      g.cmv += l.cmv;
      g.vr += l.vendidas_rede;
      g.dr += l.devolvidas_rede;
      g.estoque += l.estoque;
      g.em_maletas += l.em_maletas;
      g.estoque_custo += l.estoque * l.custo;
      categorias.set(l.categoria, g);
    }
    const porCategoria = [...categorias.values()]
      .map(({ vr, dr, ...g }) => ({ ...g, margem_pb: g.cmv > 0 ? pb(g.faturamento - g.cmv, g.faturamento) : null, participacao_pb: pb(g.faturamento, total), aceitacao_pb: vr + dr > 0 ? pb(vr, vr + dr) : null, cobertura_dias: g.vendidas > 0 ? Math.round(g.estoque / (g.vendidas / p.dias)) : null }))
      .sort((a, b) => b.faturamento - a.faturamento);

    const novoDemais = (l: any) => l.cadastrado_em && diasEntre(l.cadastrado_em, h) < 60;
    const parados = linhas.filter((l) => l.estoque > 0 && !novoDemais(l) && (l.dias_sem_venda === null || l.dias_sem_venda > 90)).sort((a, b) => b.parado_custo - a.parado_custo || b.estoque * b.preco - a.estoque * a.preco);
    const repor = linhas.filter((l) => l.vendidas >= 3 && l.sugestao > 0 && (l.cobertura_dias ?? 0) < 30).sort((a, b) => b.faturamento - a.faturamento);
    const devolvidos = linhas.filter((l) => l.vendidas_rede + l.devolvidas_rede >= 5 && (l.aceitacao_pb ?? 10000) < 3000).sort((a, b) => b.devolvidas_rede - a.devolvidas_rede);
    const margemBaixa = linhas.filter((l) => l.vendidas > 0 && l.margem_pb !== null && l.margem_pb < 4000).sort((a, b) => a.margem_pb - b.margem_pb);
    const vendidos = linhas.filter((l) => l.vendidas > 0);
    return {
      periodo: p,
      resumo: {
        faturamento: total,
        cmv: linhas.reduce((a, l) => a + l.cmv, 0),
        margemPb: pb(total - linhas.reduce((a, l) => a + l.cmv, 0), total),
        pecasVendidas: linhas.reduce((a, l) => a + l.vendidas, 0),
        produtosVendidos: vendidos.length,
        curvaA: linhas.filter((l) => l.curva === 'A').length,
        aceitacaoPb: pb(linhas.reduce((a, l) => a + l.vendidas_rede, 0), linhas.reduce((a, l) => a + l.vendidas_rede + l.devolvidas_rede, 0)),
        paradosProdutos: parados.length,
        paradosPecas: parados.reduce((a, l) => a + l.estoque, 0),
        paradosCusto: parados.reduce((a, l) => a + l.parado_custo, 0),
        paradosPreco: parados.reduce((a, l) => a + l.estoque * l.preco, 0),
        reporProdutos: repor.length,
        reporPecas: repor.reduce((a, l) => a + l.sugestao, 0),
        reporCusto: repor.reduce((a, l) => a + l.sugestao * l.custo, 0),
        semCusto: linhas.filter((l) => !l.custo && (l.estoque > 0 || l.vendidas > 0)).length,
      },
      porCategoria,
      maisVendidos: vendidos.slice(0, 100),
      repor: repor.slice(0, 200),
      parados: parados.slice(0, 300),
      devolvidos: devolvidos.slice(0, 100),
      margemBaixa: margemBaixa.slice(0, 100),
    };
  }

  /** Financeiro: resultado mês a mês, caixa projetado para as próximas semanas e inadimplência. */
  @Get('financeiro')
  @Permissao('relatorios', 'ver')
  async financeiro() {
    const meses = numeros<N & { mes: string }>(
      await this.db.execute(sql`
        with meses as (select generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month')::date as mes),
        ac as (select date_trunc('month', data)::date as mes, sum((resultado->>'totalVendido')::bigint) as rede, sum((resultado->>'comissao')::bigint) as comissao from acertos where data >= date_trunc('month', current_date) - interval '5 months' group by 1),
        vd as (select date_trunc('month', criado_em)::date as mes, sum(total) as vendas, sum(devolvido) as devolucoes from vendas where status = 'concluida' and criado_em >= date_trunc('month', current_date) - interval '5 months' group by 1),
        cm as (select date_trunc('month', x.dia)::date as mes, sum(x.custo) as cmv from ${ITENS_VENDIDOS} x where x.dia >= date_trunc('month', current_date) - interval '5 months' group by 1),
        dp as (select date_trunc('month', pago_em)::date as mes, sum(valor_pago) as despesas from titulos where tipo = 'pagar' and status = 'pago' and coalesce(categoria, '') <> 'Devoluções' and pago_em >= date_trunc('month', current_date) - interval '5 months' group by 1),
        rc as (select date_trunc('month', pago_em)::date as mes, sum(valor_pago) as recebido from titulos where tipo = 'receber' and status = 'pago' and pago_em >= date_trunc('month', current_date) - interval '5 months' group by 1)
        select to_char(m.mes, 'YYYY-MM') as mes, coalesce(ac.rede, 0) as rede, coalesce(vd.vendas, 0) as vendas, coalesce(vd.devolucoes, 0) as devolucoes, coalesce(ac.comissao, 0) as comissao,
          coalesce(cm.cmv, 0) as cmv, coalesce(dp.despesas, 0) as despesas, coalesce(rc.recebido, 0) as recebido
        from meses m left join ac on ac.mes = m.mes left join vd on vd.mes = m.mes left join cm on cm.mes = m.mes left join dp on dp.mes = m.mes left join rc on rc.mes = m.mes order by m.mes`),
    ).map((m) => {
      const bruta = m.rede + m.vendas;
      const liquida = bruta - m.devolucoes - m.comissao;
      const lucroBruto = liquida - m.cmv;
      return { ...m, bruta, liquida, lucroBruto, resultado: lucroBruto - m.despesas, margemPb: pb(lucroBruto, bruta - m.devolucoes) };
    });
    const despesas = numeros<{ mes: string; categoria: string; valor: number }>(
      await this.db.execute(sql`
        select to_char(date_trunc('month', pago_em), 'YYYY-MM') as mes, coalesce(nullif(categoria, ''), 'Sem categoria') as categoria, sum(valor_pago) as valor
        from titulos where tipo = 'pagar' and status = 'pago' and coalesce(categoria, '') <> 'Devoluções' and pago_em >= date_trunc('month', current_date) - interval '5 months'
        group by 1, 2 order by 3 desc`),
    );
    const semanas = numeros<N & { semana: string }>(
      await this.db.execute(sql`
        with s as (select generate_series(date_trunc('week', current_date), date_trunc('week', current_date) + interval '7 weeks', interval '1 week')::date as ini)
        select to_char(s.ini, 'YYYY-MM-DD') as semana,
          coalesce((select sum(valor) from titulos where tipo = 'receber' and status = 'aberto' and vencimento >= greatest(s.ini, current_date) and vencimento < s.ini + 7), 0) as receber,
          coalesce((select sum(valor) from titulos where tipo = 'pagar' and status = 'aberto' and vencimento >= greatest(s.ini, current_date) and vencimento < s.ini + 7), 0) as pagar
        from s order by s.ini`),
    );
    const [c] = numeros<N>(
      await this.db.execute(sql`
        select
          (select coalesce(sum(c.saldo_inicial + coalesce((select sum(case when t.tipo = 'receber' then t.valor_pago else -t.valor_pago end) from titulos t where t.conta_id = c.id and t.status = 'pago'), 0)), 0) from contas c where c.ativo) as saldo,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${NAO_E_CARTAO} and vencimento < current_date) as receber_atrasado,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${E_CARTAO} and vencimento < current_date) as cartao_a_conciliar,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'pagar' and status = 'aberto' and vencimento < current_date) as pagar_atrasado,
          (select coalesce(sum(valor), 0) from titulos where tipo = 'receber' and status = 'aberto' and ${NAO_E_CARTAO}) as a_receber,
          (select count(*) from titulos where tipo = 'receber' and status = 'pago' and pessoa_id is not null and ${NAO_E_CARTAO} and pago_em >= current_date - 90)::int as pagos_90,
          (select count(*) from titulos where tipo = 'receber' and status = 'pago' and pessoa_id is not null and ${NAO_E_CARTAO} and pago_em >= current_date - 90 and pago_em <= vencimento)::int as pagos_em_dia_90,
          (select coalesce(avg(pago_em - vencimento), 0) from titulos where tipo = 'receber' and status = 'pago' and pessoa_id is not null and ${NAO_E_CARTAO} and pago_em >= current_date - 90 and pago_em > vencimento)::int as atraso_medio_pagos`),
    );
    let saldo = c.saldo;
    const fluxo = semanas.map((s) => {
      saldo += s.receber - s.pagar;
      return { ...s, saldo };
    });
    const faixas = numeros<N & { faixa: string }>(
      await this.db.execute(sql`
        select case when current_date - vencimento <= 15 then '1 a 15 dias' when current_date - vencimento <= 30 then '16 a 30 dias' when current_date - vencimento <= 60 then '31 a 60 dias' when current_date - vencimento <= 90 then '61 a 90 dias' else 'Mais de 90 dias' end as faixa,
          count(*)::int as titulos, count(distinct pessoa_id)::int as pessoas, sum(valor) as valor
        from titulos where tipo = 'receber' and status = 'aberto' and vencimento < current_date and ${NAO_E_CARTAO}
        group by 1 order by min(current_date - vencimento)`),
    );
    const devedores = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select p.id, p.nome, p.telefone1 as telefone, p.tipo, count(*)::int as titulos, sum(t.valor) as valor, max(current_date - t.vencimento)::int as maior_atraso,
          coalesce((select sum(mi.preco * (mi.enviada - mi.vendida - mi.devolvida - mi.perdida)) from maletas m join maleta_itens mi on mi.maleta_id = m.id where m.representante_id = p.id and m.status = 'aberta'), 0) as em_maleta
        from titulos t join pessoas p on p.id = t.pessoa_id
        where t.tipo = 'receber' and t.status = 'aberto' and t.vencimento < current_date and coalesce(t.forma_pagamento, '') not in ('debito', 'credito')
        group by p.id order by valor desc limit 50`),
    );
    return {
      meses,
      despesas,
      caixa: { saldo: c.saldo, receberAtrasado: c.receber_atrasado, cartaoAConciliar: c.cartao_a_conciliar, pagarAtrasado: c.pagar_atrasado, aReceber: c.a_receber, inadimplenciaPb: pb(c.receber_atrasado, c.a_receber), pagosEmDiaPb: pb(c.pagos_em_dia_90, c.pagos_90), atrasoMedioPagos: c.atraso_medio_pagos },
      fluxo,
      faixas,
      devedores,
    };
  }

  /** CRM: conversão dos funis, de onde vêm os leads que fecham, e a velocidade do atendimento. */
  @Get('crm')
  @Permissao('relatorios', 'ver')
  async crm(@Query('de') de?: string, @Query('ate') ate?: string) {
    const p = this.periodo(de, ate);
    const funis = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select f.id, f.nome, f.tipo,
          count(l.id) filter (where l.criado_em::date between ${p.ini}::date and ${p.fim}::date)::int as criados,
          count(l.id) filter (where l.status = 'ganho' and l.atualizado_em::date between ${p.ini}::date and ${p.fim}::date)::int as ganhos,
          count(l.id) filter (where l.status = 'perdido' and l.atualizado_em::date between ${p.ini}::date and ${p.fim}::date)::int as perdidos,
          count(l.id) filter (where l.status = 'aberto')::int as abertos,
          coalesce(sum(l.valor) filter (where l.status = 'aberto'), 0) as valor_aberto,
          coalesce(sum(l.valor) filter (where l.status = 'ganho' and l.atualizado_em::date between ${p.ini}::date and ${p.fim}::date), 0) as valor_ganho,
          coalesce(round(avg(extract(epoch from l.atualizado_em - l.criado_em) / 86400) filter (where l.status = 'ganho' and l.atualizado_em::date between ${p.ini}::date and ${p.fim}::date)), 0)::int as dias_ate_ganhar
        from crm_funis f left join crm_leads l on l.funil_id = f.id where f.ativo group by f.id order by f.ordem`),
    ).map((f) => ({ ...f, conversao_pb: pb(f.ganhos, f.ganhos + f.perdidos) }));
    const etapas = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select e.funil_id, e.nome, e.cor, e.tipo, e.ordem, count(l.id)::int as cards, coalesce(sum(l.valor), 0) as valor,
          coalesce(round(avg(extract(epoch from now() - l.entrou_na_etapa_em) / 86400)), 0)::int as dias_na_etapa
        from crm_etapas e left join crm_leads l on l.etapa_id = e.id and l.status = 'aberto' where e.tipo = 'aberta' group by e.id order by e.funil_id, e.ordem`),
    );
    const origens = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select coalesce(nullif(l.origem->>'utm_source', ''), nullif(l.origem->>'origem', ''), 'direto / sem rastreio') as origem,
          coalesce(nullif(l.origem->>'utm_campaign', ''), '—') as campanha,
          count(*)::int as leads, count(*) filter (where l.status = 'ganho')::int as ganhos, count(*) filter (where l.status = 'perdido')::int as perdidos, coalesce(sum(l.valor) filter (where l.status = 'ganho'), 0) as valor_ganho
        from crm_leads l where l.criado_em::date between ${p.ini}::date and ${p.fim}::date
        group by 1, 2 order by leads desc limit 40`),
    ).map((o) => ({ ...o, conversao_pb: pb(o.ganhos, o.leads) }));
    const motivos = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select coalesce(nullif(motivo_perda, ''), 'sem motivo informado') as motivo, count(*)::int as cards
        from crm_leads where status = 'perdido' and atualizado_em::date between ${p.ini}::date and ${p.fim}::date group by 1 order by 2 desc limit 15`),
    );
    const [at] = numeros<N>(
      await this.db.execute(sql`
        select
          (select count(*) from crm_conversas where status = 'fila')::int as fila,
          (select coalesce(round(avg(extract(epoch from now() - fila_desde) / 60)), 0) from crm_conversas where status = 'fila')::int as espera_agora_min,
          (select coalesce(round(avg(extract(epoch from pega_em - fila_desde) / 60)), 0) from crm_conversas where pega_em::date between ${p.ini}::date and ${p.fim}::date and pega_em > fila_desde)::int as espera_media_min,
          (select count(*) from crm_mensagens where direcao = 'entrada' and criado_em::date between ${p.ini}::date and ${p.fim}::date)::int as recebidas,
          (select count(*) from crm_mensagens where direcao = 'saida' and criado_em::date between ${p.ini}::date and ${p.fim}::date)::int as enviadas,
          (select count(*) from crm_tarefas where feita_em is null and vence_em < now())::int as tarefas_vencidas`),
    );
    const atendentes = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select u.id, u.nome,
          (select count(*) from crm_mensagens m where m.usuario_id = u.id and m.direcao = 'saida' and m.criado_em::date between ${p.ini}::date and ${p.fim}::date)::int as mensagens,
          (select count(*) from crm_conversas c where c.atendente_id = u.id and c.status = 'atendimento')::int as em_atendimento,
          (select count(*) from crm_leads l where l.responsavel_id = u.id and l.status = 'aberto')::int as cards_abertos,
          (select count(*) from crm_leads l where l.responsavel_id = u.id and l.status = 'ganho' and l.atualizado_em::date between ${p.ini}::date and ${p.fim}::date)::int as ganhos,
          (select count(*) from crm_tarefas t where t.responsavel_id = u.id and t.feita_em is null and t.vence_em < now())::int as tarefas_vencidas
        from usuarios u where u.ativo
          and (exists (select 1 from crm_leads l where l.responsavel_id = u.id) or exists (select 1 from crm_mensagens m where m.usuario_id = u.id))
        order by mensagens desc`),
    );
    const disparos = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select d.id, d.nome, d.status, d.total, d.enviados, d.falhas, d.criado_em,
          (select count(*) from crm_disparo_destinos x where x.disparo_id = d.id and x.status = 'respondeu')::int as responderam
        from crm_disparos d where d.criado_em::date between ${p.ini}::date and ${p.fim}::date order by d.criado_em desc limit 20`),
    ).map((d) => ({ ...d, resposta_pb: pb(d.responderam, d.enviados) }));
    return { periodo: p, funis, etapas, origens, motivos, atendimento: at, atendentes, disparos };
  }

  /**
   * Venda da rede mês a mês somando o histórico trazido do Jueri (acertos baixados antes da virada)
   * com os acertos feitos na plataforma. Com pessoaId, só daquela consultora.
   */
  private async historicoMeses(meses: number, pessoaId?: string) {
    const n = Math.min(Math.max(meses, 3), 60);
    const h = hoje();
    const ini = new Date(Date.UTC(Number(h.slice(0, 4)), Number(h.slice(5, 7)) - n, 1)).toISOString().slice(0, 10);
    const filtroJ = pessoaId ? sql`and pessoa_id = ${pessoaId}` : sql``;
    const filtroP = pessoaId ? sql`and m.representante_id = ${pessoaId}` : sql``;
    const linhas = numeros<Record<string, any>>(
      await this.db.execute(sql`
        with meses as (select to_char(g, 'YYYY-MM') as mes from generate_series(${ini}::date, ${h}::date, interval '1 month') g),
        j as (select to_char(data, 'YYYY-MM') as mes, sum(valor_vendido) as vendido, count(*) as acertos, sum(pecas_vendidas) as vendidas, sum(pecas_enviadas) as enviadas, count(distinct coalesce(pessoa_id::text, revendedor_jueri)) as consultoras
              from jueri_historico where data >= ${ini}::date ${filtroJ} group by 1),
        p as (select to_char(a.data, 'YYYY-MM') as mes, sum((a.resultado->>'totalVendido')::bigint) as vendido, count(*) as acertos,
                sum((a.resultado->'pecas'->>'vendidas')::int) as vendidas,
                sum((a.resultado->'pecas'->>'emMaleta')::int - coalesce((a.resultado->'pecas'->>'continuam')::int, 0)) as enviadas,
                count(distinct m.representante_id) as consultoras
              from acertos a join maletas m on m.id = a.maleta_id where a.data >= ${ini}::date ${filtroP} group by 1)
        select meses.mes,
          coalesce(j.vendido, 0) as jueri, coalesce(p.vendido, 0) as plataforma,
          coalesce(j.acertos, 0) + coalesce(p.acertos, 0) as acertos,
          coalesce(j.vendidas, 0) + coalesce(p.vendidas, 0) as pecas_vendidas,
          coalesce(j.enviadas, 0) + coalesce(p.enviadas, 0) as pecas_acertadas,
          greatest(coalesce(j.consultoras, 0), coalesce(p.consultoras, 0)) as consultoras
        from meses left join j using (mes) left join p using (mes) order by meses.mes`),
    ).map((l) => ({ ...l, total: l.jueri + l.plataforma, sell_through_pb: l.pecas_acertadas > 0 ? Math.round((l.pecas_vendidas * 10000) / l.pecas_acertadas) : 0 }));
    const [ex] = numeros<Record<string, any>>(await this.db.execute(sql`select count(*)::int as acertos, min(data)::text as de, max(data)::text as ate, coalesce(sum(valor_vendido), 0) as vendido from jueri_historico where true ${filtroJ}`));
    return { linhas, jueri: { acertos: ex.acertos, de: ex.de, ate: ex.ate, vendido: ex.vendido } };
  }

  @Get('historico')
  @Permissao('relatorios', 'ver')
  async historico(@Query('meses') meses = '24') {
    const r = await this.historicoMeses(Number(meses) || 24);
    // O que a rede mais vendeu no histórico (12 meses), para comparar a curva de produtos antes e depois.
    const produtos = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select coalesce(p.referencia, i.produto_jueri) as referencia, coalesce(p.descricao, '(produto não importado)') as descricao, p.id,
          sum(i.vendidas)::int as vendidas, sum(i.enviadas)::int as enviadas, sum(i.vendidas * coalesce(i.preco_unitario, 0)) as vendido
        from jueri_historico_itens i join jueri_historico h on h.id = i.historico_id left join produtos p on p.id = i.produto_id
        where h.data >= (current_date - interval '12 months') group by 1, 2, 3 having sum(i.vendidas) > 0 order by vendido desc limit 30`),
    ).map((x) => ({ ...x, sell_through_pb: x.enviadas ? Math.round((x.vendidas * 10000) / x.enviadas) : 0 }));
    return { ...r, produtos };
  }

  @Get('historico/pessoa/:id')
  @Permissao('relatorios', 'ver')
  historicoPessoa(@Param('id', ParseUUIDPipe) id: string, @Query('meses') meses = '24') {
    return this.historicoMeses(Number(meses) || 24, id);
  }
}
