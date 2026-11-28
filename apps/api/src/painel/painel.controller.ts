import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { acertos, auditoria, grupos, maletaItens, maletas, pessoas, titulos, usuarios } from '../db/schema';
import { sqlAtivos, sqlChurn, sqlChurnPercentual, sqlRenovacoes } from '../relatorios/consignado';
import { hoje } from '../maletas/maletas.service';
import { daEmpresa, empresaDaVisao } from '../relatorios/fontes';

/** Considera "conectado" quem falou com o servidor nos últimos 5 minutos (o painel aberto consulta a cada minuto). */
const ONLINE_MS = 5 * 60_000;

const n = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v]));
const linhas = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];

/** Tela Início: o que precisa de atenção hoje, vendas, pendências, equipe e o que cada pessoa mexeu. */
@Controller('painel')
export class PainelController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('inicio')
  @Permissao('inicio', 'ver')
  async inicio(@Usuario() u: UsuarioLogado, @Query('empresaId') empresa?: string) {
    const emp = empresaDaVisao(empresa);
    const pode = (m: string, a = 'ver') => temPermissao(u.permissoes, m, a);
    const gestao = pode('configuracoes');
    const h = hoje();
    const em7 = somarDias(h, 7);
    const inicioMes = h.slice(0, 8) + '01';
    const naMaleta = sql`(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})`;

    const [m] = await this.db
      .select({
        abertas: sql<number>`count(distinct ${maletas.id})::int`,
        atrasadas: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.dataLimite} < ${h})::int`,
        vencendo: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.dataLimite} between ${h} and ${em7})::int`,
        acertosHoje: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.dataLimite} = ${h})::int`,
        pecasNaRua: sql<number>`coalesce(sum(${naMaleta}),0)::int`,
        valorNaRua: sql<number>`coalesce(sum(${maletaItens.preco} * ${naMaleta}),0)::bigint`,
        prebaixasPendentes: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.prebaixaEm} is not null)::int`,
      })
      .from(maletas)
      .leftJoin(maletaItens, eq(maletaItens.maletaId, maletas.id))
      .where(and(eq(maletas.status, 'aberta'), emp ? eq(maletas.empresaId, emp) : undefined));

    const [rede] = await this.db
      .select({
        ativas: sql<number>`count(*) filter (where ${pessoas.status} = 'ativo')::int`,
        triagem: sql<number>`count(*) filter (where ${pessoas.status} = 'triagem')::int`,
        novasMes: sql<number>`count(*) filter (where ${pessoas.criadoEm} >= ${inicioMes}::date)::int`,
        bloqueadas: sql<number>`count(*) filter (where ${pessoas.bloqueado})::int`,
        semMaleta: sql<number>`count(*) filter (where ${pessoas.status} = 'ativo' and ${pessoas.modeloTrabalho} = 'consignado' and not exists (select 1 from ${maletas} mm where mm.representante_id = "pessoas"."id" and mm.status = 'aberta'))::int`,
      })
      .from(pessoas)
      .where(eq(pessoas.tipo, 'representante'));

    const [fin] = await this.db
      .select({
        receberHoje: sql<number>`coalesce(sum(${titulos.valor}) filter (where ${titulos.vencimento} = ${h}),0)::bigint`,
        vencido: sql<number>`coalesce(sum(${titulos.valor}) filter (where ${titulos.vencimento} < ${h}),0)::bigint`,
        vencidos: sql<number>`count(*) filter (where ${titulos.vencimento} < ${h})::int`,
        aReceber: sql<number>`coalesce(sum(${titulos.valor}),0)::bigint`,
      })
      .from(titulos)
      // Cartão é repasse da maquininha, não dívida de cliente: não entra em "vencido".
      .where(and(eq(titulos.tipo, 'receber'), eq(titulos.status, 'aberto'), sql`coalesce(${titulos.formaPagamento}, '') not in ('debito', 'credito')`, emp ? eq(titulos.empresaId, emp) : undefined));

    const [mes] = await this.db
      .select({
        acertos: sql<number>`count(*)::int`,
        vendido: sql<number>`coalesce(sum((${acertos.resultado}->>'totalVendido')::int),0)::bigint`,
        recebido: sql<number>`coalesce(sum(${acertos.totalAPagar}),0)::bigint`,
        percentualMedio: sql<number>`coalesce(avg((${acertos.resultado}->>'percentualVendidoPb')::int),0)::int`,
      })
      .from(acertos)
      .where(and(sql`${acertos.data} >= ${inicioMes}::date`, emp ? sql`exists (select 1 from maletas mm where mm.id = ${acertos.maletaId} and mm.empresa_id = ${emp}::uuid)` : undefined));

    // Consignado do mês: pedidos ativos, renovações e churn (da empresa e da carteira de quem está vendo).
    const um = async (q: SQL) => { const v = (await this.db.execute<{ v: number | string | null }>(q)).rows[0]?.v; return v === null || v === undefined ? null : Number(v); };
    const fimMes = new Date(Date.UTC(Number(h.slice(0, 4)), Number(h.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const consignadoDe = async (sup: string | null) => {
      const [ativos, renovacoes, churn, churnPct] = await Promise.all([um(sqlAtivos(h, sup)), um(sqlRenovacoes(inicioMes, fimMes, sup)), um(sqlChurn(inicioMes, fimMes, sup)), um(sqlChurnPercentual(inicioMes, fimMes, sup))]);
      return { ativos: ativos ?? 0, renovacoes: renovacoes ?? 0, churn: churn ?? 0, churnPct };
    };
    const consignado = pode('maletas') ? await consignadoDe(null) : null;
    const [{ carteira }] = (await this.db.execute<{ carteira: number }>(sql`select count(*)::int as carteira from pessoas where supervisor_id = ${u.id}::uuid and tipo = 'representante'`)).rows;
    const minhaCarteira = Number(carteira) > 0 ? { consultoras: Number(carteira), ...(await consignadoDe(u.id)) } : null;
    const vendas = pode('vendas') || pode('maletas') || pode('lojas') ? await this.vendas(h, inicioMes, emp) : null;
    const pendencias = await this.pendencias(u, pode, h);
    const tarefas = pode('crm') ? await this.minhasTarefas(u.id) : [];
    const equipe = gestao ? await this.equipe() : null;
    const atividades = await this.atividades(gestao ? null : u.id, 25);
    const porPessoa = gestao ? await this.atividadePorPessoa(h) : null;

    return { data: h, gestao, maletas: n(m), rede: n(rede), financeiro: n(fin), mes: n(mes), consignado, minhaCarteira, vendas, pendencias, tarefas, equipe, atividades, porPessoa };
  }

  /** Últimas alterações, de todos (gestão) ou só minhas; filtro por pessoa e paginação por data. */
  @Get('atividades')
  @Permissao('inicio', 'ver')
  async listarAtividades(@Usuario() u: UsuarioLogado, @Query('usuarioId') usuarioId?: string, @Query('antes') antes?: string) {
    const gestao = temPermissao(u.permissoes, 'configuracoes', 'ver');
    if (usuarioId && usuarioId !== u.id && !gestao) throw new ForbiddenException('Você só pode ver as suas alterações.');
    if (antes && Number.isNaN(Date.parse(antes))) throw new BadRequestException('Data inválida.');
    return this.atividades(gestao ? usuarioId || null : u.id, 40, antes);
  }

  private async atividades(usuarioId: string | null, limite: number, antes?: string) {
    const filtros: SQL[] = [sql`${auditoria.acao} <> 'login'`];
    if (usuarioId) filtros.push(eq(auditoria.usuarioId, usuarioId));
    if (antes) filtros.push(sql`${auditoria.criadoEm} < ${new Date(antes)}`);
    return this.db
      .select({ id: auditoria.id, criadoEm: auditoria.criadoEm, acao: auditoria.acao, entidade: auditoria.entidade, entidadeId: auditoria.entidadeId, dados: auditoria.dados, usuarioId: auditoria.usuarioId, usuario: usuarios.nome })
      .from(auditoria)
      .leftJoin(usuarios, eq(usuarios.id, auditoria.usuarioId))
      .where(and(...filtros))
      .orderBy(desc(auditoria.criadoEm))
      .limit(limite);
  }

  /** Quantas alterações cada pessoa fez hoje e a última delas. */
  private async atividadePorPessoa(h: string) {
    const r = await this.db.execute(sql`
      select u.id, u.nome, count(a.id)::int as hoje, max(a.criado_em) as ultima
      from usuarios u
      join auditoria a on a.usuario_id = u.id and a.acao <> 'login' and a.criado_em >= (${h}::date + time '00:00') at time zone 'America/Sao_Paulo'
      group by u.id, u.nome
      order by count(a.id) desc
      limit 12`);
    return linhas<{ id: string; nome: string; hoje: number; ultima: string }>(r);
  }

  /** Vendas do dia e do mês: rede (acertos das consultoras) separada das lojas e eventos. */
  private async vendas(h: string, inicioMes: string, emp: string | null = null) {
    const e = (c: string) => daEmpresa(emp, c);
    const inicio30 = somarDias(h, -29);
    const dia = sql`(v.criado_em at time zone 'America/Sao_Paulo')::date`;
    const porLocal = linhas<{ id: string; nome: string; tipo: string; hoje: number; mes: number; qtdMes: number }>(
      await this.db.execute(sql`
        select l.id, l.nome, l.tipo::text as tipo,
          coalesce(sum(v.total - v.devolvido) filter (where ${dia} = ${h}::date),0)::bigint as hoje,
          coalesce(sum(v.total - v.devolvido),0)::bigint as mes,
          count(v.id)::int as "qtdMes"
        from vendas v join locais_estoque l on l.id = v.local_id
        where v.status = 'concluida' and ${dia} >= ${inicioMes}::date${e('v.empresa_id')}
        group by l.id, l.nome, l.tipo
        order by sum(v.total) desc`),
    ).map((x) => n(x) as typeof x);

    const [redeHoje] = linhas<{ hoje: number; qtd: number }>(
      await this.db.execute(sql`select coalesce(sum((resultado->>'totalVendido')::int),0)::bigint as hoje, count(*)::int as qtd from acertos a where a.data = ${h}::date and exists (select 1 from maletas m where m.id = a.maleta_id${e('m.empresa_id')})`),
    ).map((x) => n(x) as typeof x);

    const consultoras = linhas<{ id: string; nome: string; vendido: number; acertos: number }>(
      await this.db.execute(sql`
        select p.id, p.nome, coalesce(sum((a.resultado->>'totalVendido')::int),0)::bigint as vendido, count(a.id)::int as acertos
        from acertos a join maletas m on m.id = a.maleta_id join pessoas p on p.id = m.representante_id
        where a.data >= ${inicioMes}::date${e('m.empresa_id')}
        group by p.id, p.nome
        order by sum((a.resultado->>'totalVendido')::int) desc nulls last
        limit 6`),
    ).map((x) => n(x) as typeof x);

    const vendedoras = linhas<{ id: string; nome: string; vendido: number; vendas: number }>(
      await this.db.execute(sql`
        select u.id, u.nome, coalesce(sum(v.total - v.devolvido),0)::bigint as vendido, count(v.id)::int as vendas
        from vendas v join usuarios u on u.id = v.vendedor_id
        where v.status = 'concluida' and ${dia} >= ${inicioMes}::date${e('v.empresa_id')}
        group by u.id, u.nome
        order by sum(v.total) desc
        limit 6`),
    ).map((x) => n(x) as typeof x);

    const serie = linhas<{ dia: string; rede: number; lojas: number; eventos: number }>(
      await this.db.execute(sql`
        with dias as (select generate_series(${inicio30}::date, ${h}::date, interval '1 day')::date as dia),
        r as (select a.data as dia, sum((a.resultado->>'totalVendido')::int) as t from acertos a join maletas m on m.id = a.maleta_id where a.data >= ${inicio30}::date${e('m.empresa_id')} group by a.data),
        lv as (
          select ${dia} as dia, sum(v.total - v.devolvido) filter (where l.tipo = 'evento') as ev, sum(v.total - v.devolvido) filter (where l.tipo <> 'evento') as lj
          from vendas v join locais_estoque l on l.id = v.local_id
          where v.status = 'concluida' and ${dia} >= ${inicio30}::date${e('v.empresa_id')} group by 1)
        select to_char(d.dia, 'YYYY-MM-DD') as dia, coalesce(r.t,0)::bigint as rede, coalesce(lv.lj,0)::bigint as lojas, coalesce(lv.ev,0)::bigint as eventos
        from dias d left join r on r.dia = d.dia left join lv on lv.dia = d.dia order by d.dia`),
    ).map((x) => n(x) as typeof x);

    const soma = (tipo: (t: string) => boolean, campo: 'hoje' | 'mes') => porLocal.filter((l) => tipo(l.tipo)).reduce((s, l) => s + Number(l[campo]), 0);
    return {
      rede: { hoje: Number(redeHoje?.hoje ?? 0), acertosHoje: Number(redeHoje?.qtd ?? 0) },
      lojas: { hoje: soma((t) => t === 'loja', 'hoje'), mes: soma((t) => t === 'loja', 'mes') },
      eventos: { hoje: soma((t) => t === 'evento', 'hoje'), mes: soma((t) => t === 'evento', 'mes') },
      outras: { hoje: soma((t) => t !== 'loja' && t !== 'evento', 'hoje'), mes: soma((t) => t !== 'loja' && t !== 'evento', 'mes') },
      porLocal,
      consultoras,
      vendedoras,
      serie,
    };
  }

  /** Tudo que está esperando alguém, conforme o que a pessoa pode ver. */
  private async pendencias(u: UsuarioLogado, pode: (m: string, a?: string) => boolean, h: string) {
    const r: { chave: string; rotulo: string; quantidade: number; link: string; tom: 'erro' | 'alerta' | 'info'; detalhe?: string }[] = [];
    const conta = async (q: SQL) => Number(linhas<{ n: number }>(await this.db.execute(q))[0]?.n ?? 0);
    if (pode('crm')) {
      const gestor = pode('crm', 'excluir');
      const vencidas = await conta(sql`select count(*)::int as n from crm_tarefas where feita_em is null and vence_em < now() and (responsavel_id = ${u.id} or (${gestor} and responsavel_id is null))`);
      const deHoje = await conta(sql`select count(*)::int as n from crm_tarefas where feita_em is null and vence_em >= now() and (vence_em at time zone 'America/Sao_Paulo')::date = ${h}::date and responsavel_id = ${u.id}`);
      const fila = await conta(
        gestor
          ? sql`select count(*)::int as n from crm_conversas where status = 'fila'`
          : sql`select count(*)::int as n from crm_conversas cv join crm_canais c on c.id = cv.canal_id where cv.status = 'fila' and c.ativo and (c.atendentes = '[]'::jsonb or c.atendentes ? ${u.id} or c.usuario_id = ${u.id})`,
      );
      const naoLidas = await conta(sql`select coalesce(sum(nao_lidas),0)::int as n from crm_conversas where status = 'atendimento' and atendente_id = ${u.id}`);
      if (vencidas) r.push({ chave: 'tarefas_vencidas', rotulo: 'Tarefas atrasadas', quantidade: vencidas, link: '/crm?aba=tarefas', tom: 'erro' });
      if (deHoje) r.push({ chave: 'tarefas_hoje', rotulo: 'Tarefas para hoje', quantidade: deHoje, link: '/crm?aba=tarefas', tom: 'info' });
      if (fila) r.push({ chave: 'fila', rotulo: 'Conversas na fila de espera', quantidade: fila, link: '/crm?aba=conversas', tom: 'alerta' });
      if (naoLidas) r.push({ chave: 'nao_lidas', rotulo: 'Mensagens não lidas nas suas conversas', quantidade: naoLidas, link: '/crm?aba=conversas', tom: 'alerta' });
    }
    if (pode('maletas')) {
      const atrasadas = await conta(sql`select count(*)::int as n from maletas where status = 'aberta' and data_limite < ${h}::date`);
      const prebaixas = await conta(sql`select count(*)::int as n from maletas where status = 'aberta' and prebaixa_em is not null`);
      const pedidos = await conta(sql`select count(*)::int as n from pedidos_pecas where status = 'novo'`);
      if (atrasadas) r.push({ chave: 'maletas_atrasadas', rotulo: 'Maletas atrasadas', quantidade: atrasadas, link: '/maletas?aba=atrasadas', tom: 'erro' });
      if (prebaixas) r.push({ chave: 'prebaixas', rotulo: 'Pré-baixas para conferir', quantidade: prebaixas, link: '/maletas', tom: 'alerta' });
      if (pedidos) r.push({ chave: 'pedidos_pecas', rotulo: 'Pedidos de peças das representantes', quantidade: pedidos, link: '/maletas?aba=pedidos', tom: 'alerta' });
    }
    if (pode('financeiro')) {
      const vencidos = await conta(sql`select count(*)::int as n from titulos where tipo = 'receber' and status = 'aberto' and vencimento < ${h}::date and coalesce(forma_pagamento, '') not in ('debito', 'credito')`);
      const pagarHoje = await conta(sql`select count(*)::int as n from titulos where tipo = 'pagar' and status = 'aberto' and vencimento <= ${h}::date`);
      if (vencidos) r.push({ chave: 'contas_vencidas', rotulo: 'Contas a receber vencidas', quantidade: vencidos, link: '/financeiro', tom: 'erro' });
      if (pagarHoje) r.push({ chave: 'pagar_hoje', rotulo: 'Contas a pagar até hoje', quantidade: pagarHoje, link: '/financeiro', tom: 'alerta' });
    }
    if (pode('rede')) {
      const triagem = await conta(sql`select count(*)::int as n from pessoas where tipo = 'representante' and status = 'triagem'`);
      if (triagem) r.push({ chave: 'triagem', rotulo: 'Candidatas para analisar', quantidade: triagem, link: '/rede?status=triagem', tom: 'info' });
    }
    if (pode('garantia')) {
      const prontas = await conta(sql`select count(*)::int as n from ordens_servico where status = 'pronta'`);
      const abertas = await conta(sql`select count(*)::int as n from ordens_servico where status = 'aberta'`);
      if (prontas) r.push({ chave: 'os_prontas', rotulo: 'Garantias prontas para devolver', quantidade: prontas, link: '/garantia', tom: 'alerta' });
      if (abertas) r.push({ chave: 'os_abertas', rotulo: 'Garantias abertas', quantidade: abertas, link: '/garantia', tom: 'info' });
    }
    const peso = { erro: 0, alerta: 1, info: 2 };
    return r.sort((a, b) => peso[a.tom] - peso[b.tom]);
  }

  private async minhasTarefas(usuarioId: string) {
    return linhas<{ id: string; titulo: string; venceEm: string; leadId: string; lead: string; funil: string }>(
      await this.db.execute(sql`
        select t.id, t.titulo, t.vence_em as "venceEm", l.id as "leadId", l.titulo as lead, f.nome as funil
        from crm_tarefas t join crm_leads l on l.id = t.lead_id join crm_funis f on f.id = l.funil_id
        where t.feita_em is null and t.responsavel_id = ${usuarioId}
        order by t.vence_em
        limit 8`),
    );
  }

  /** Quem está conectado agora e desde quando; os demais com o último acesso. */
  private async equipe() {
    const r = await this.db
      .select({ id: usuarios.id, nome: usuarios.nome, grupo: grupos.nome, ultimaAtividadeEm: usuarios.ultimaAtividadeEm, sessaoInicioEm: usuarios.sessaoInicioEm, ultimoAcesso: usuarios.ultimoAcesso })
      .from(usuarios)
      .innerJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .where(eq(usuarios.ativo, true))
      .orderBy(desc(sql`coalesce(${usuarios.ultimaAtividadeEm}, ${usuarios.ultimoAcesso})`));
    const agora = Date.now();
    return r.map((x) => ({ ...x, online: !!x.ultimaAtividadeEm && agora - x.ultimaAtividadeEm.getTime() < ONLINE_MS }));
  }
}
