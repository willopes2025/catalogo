import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, opcional, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { SegredosService } from '../segredos/segredos.service';
import { campanhas, marketingGastos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

const campanhaSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  canal: z.enum(['meta', 'google', 'instagram', 'whatsapp', 'evento', 'outro']),
  utmCampaign: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,60}$/, 'Código da campanha: letras minúsculas, números, hífen e sublinhado'),
  objetivo: z.enum(['candidatas', 'clientes']).default('candidatas'),
  inicio: dataISO.nullable().optional(),
  fim: dataISO.nullable().optional(),
  investimento: centavos.default(0),
  metaCampanhaId: z.string().trim().regex(/^\d{5,30}$/, 'Id da campanha no Meta: só números').nullable().optional().or(z.literal('').transform(() => null)),
  observacao: opcional(500),
  ativa: z.boolean().optional(),
});

/**
 * Marketing: quanto custa trazer cada candidata e quanto as aprovadas venderam depois.
 * Os resultados ligam a campanha ao utm_campaign dos links (formulário de candidatas e formulários).
 * O investimento é lançado à mão ou vem do Meta Ads, quando a integração estiver ligada.
 */
@Controller('marketing')
export class MarketingController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService, private readonly segredos: SegredosService) {}

  @Get('campanhas')
  @Permissao('marketing', 'ver')
  listar() {
    return this.db.select().from(campanhas).orderBy(asc(campanhas.nome));
  }

  @Post('campanhas')
  @Permissao('marketing', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const [c] = await this.db.insert(campanhas).values(validar(campanhaSchema, body)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'campanha', entidadeId: c.id });
    return c;
  }

  @Patch('campanhas/:id')
  @Permissao('marketing', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(campanhaSchema.partial(), body);
    const [c] = await this.db.update(campanhas).set(d).where(eq(campanhas.id, id)).returning();
    if (!c) throw new NotFoundException('Campanha não encontrada.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'campanha', entidadeId: id, dados: d });
    return c;
  }

  /** Resultado por campanha (e os códigos usados nos links que ainda não têm campanha cadastrada). */
  @Get('resultados')
  @Permissao('marketing', 'ver')
  async resultados() {
    const r = await this.db.execute<{
      utm: string;
      candidatas: number;
      aprovadas: number;
      respostas: number;
      clientes: number;
      vendido: string;
      representantes_vendendo: number;
      leads: number;
    }>(sql`
      with utms as (
        select lower(origem->>'utm_campaign') as utm from candidaturas where coalesce(origem->>'utm_campaign','') <> ''
        union select lower(origem->>'utm_campaign') from formulario_respostas where coalesce(origem->>'utm_campaign','') <> ''
        union select lower(origem->>'utm_campaign') from crm_leads where coalesce(origem->>'utm_campaign','') <> ''
        union select utm_campaign from campanhas
      ),
      aprovadas as (
        select lower(c.origem->>'utm_campaign') as utm, c.pessoa_id from candidaturas c where c.etapa = 'aprovada' and c.pessoa_id is not null
      ),
      vendas as (
        select ap.utm, sum((a.resultado->>'totalVendido')::int)::bigint as vendido, count(distinct m.representante_id)::int as reps
        from aprovadas ap join maletas m on m.representante_id = ap.pessoa_id join acertos a on a.maleta_id = m.id
        group by ap.utm
      )
      select u.utm,
        (select count(*)::int from candidaturas c where lower(c.origem->>'utm_campaign') = u.utm) as candidatas,
        (select count(*)::int from candidaturas c where lower(c.origem->>'utm_campaign') = u.utm and c.etapa = 'aprovada') as aprovadas,
        (select count(*)::int from formulario_respostas fr where lower(fr.origem->>'utm_campaign') = u.utm) as respostas,
        (select count(*)::int from formulario_respostas fr where lower(fr.origem->>'utm_campaign') = u.utm and fr.pessoa_id is not null) as clientes,
        (select count(*)::int from crm_leads l where lower(l.origem->>'utm_campaign') = u.utm) as leads,
        coalesce(v.vendido, 0) as vendido,
        coalesce(v.reps, 0) as representantes_vendendo
      from utms u left join vendas v on v.utm = u.utm`);
    const cs = await this.db.select().from(campanhas);
    const extras = await this.extrasPorCampanha();
    const linhas = r.rows.map((x) => {
      const c = cs.find((k) => k.utmCampaign === x.utm) ?? null;
      // Investimento: o do Meta (ou o lançado na campanha) + os gastos lançados mês a mês para ela.
      const investimento = c ? (c.investimentoSincronizado ?? c.investimento) + (extras.get(c.id) ?? 0) : 0;
      const vendido = Number(x.vendido);
      // Custo só faz sentido para campanha cadastrada (com investimento conhecido).
      const div = (a: number, b: number) => (c && b > 0 ? Math.round(a / b) : null);
      return {
        utm: x.utm,
        campanha: c && { id: c.id, nome: c.nome, canal: c.canal, objetivo: c.objetivo, ativa: c.ativa, sincronizado: c.investimentoSincronizado !== null },
        investimento,
        candidatas: x.candidatas,
        aprovadas: x.aprovadas,
        respostas: x.respostas,
        clientes: x.clientes,
        leads: x.leads,
        vendidoPelasAprovadas: vendido,
        representantesVendendo: x.representantes_vendendo,
        custoPorCandidata: div(investimento, x.candidatas),
        custoPorAprovada: div(investimento, x.aprovadas),
        custoPorCliente: div(investimento, x.clientes),
        custoPorLead: div(investimento, x.leads),
        /** Quanto as aprovadas venderam para cada real investido (vendido ÷ investimento). */
        retorno: c && investimento > 0 && x.aprovadas > 0 ? Math.round((vendido / investimento) * 100) / 100 : null,
      };
    });
    linhas.sort((a, b) => Number(!!b.campanha) - Number(!!a.campanha) || b.candidatas + b.respostas - (a.candidatas + a.respostas));
    // Totais só das campanhas cadastradas: investimento e resultados do mesmo conjunto.
    const soma = (k: 'investimento' | 'candidatas' | 'aprovadas' | 'clientes' | 'leads' | 'vendidoPelasAprovadas') => linhas.filter((l) => l.campanha).reduce((s, l) => s + l[k], 0);
    const direto = await this.db.execute<{ n: number }>(sql`select count(*)::int as n from candidaturas where coalesce(origem->>'utm_campaign','') = ''`);
    const codigosSemCampanha = linhas.filter((l) => !l.campanha).reduce((s, l) => s + l.candidatas, 0);
    return {
      linhas,
      totais: { investimento: soma('investimento'), candidatas: soma('candidatas'), aprovadas: soma('aprovadas'), clientes: soma('clientes'), leads: soma('leads'), vendidoPelasAprovadas: soma('vendidoPelasAprovadas'), candidatasSemCampanha: direto.rows[0].n, candidatasComCodigoSemCampanha: codigosSemCampanha },
      metaLigado: !!(this.segredos.v('META_ADS_TOKEN') && this.segredos.v('META_ADS_CONTA')),
    };
  }

  /** Traz do Meta Ads o gasto de cada campanha que tem o id do Meta preenchido. */
  @Post('sincronizar-meta')
  @Permissao('marketing', 'editar')
  async sincronizarMeta(@Usuario() u: UsuarioLogado) {
    const token = this.segredos.v('META_ADS_TOKEN');
    const conta = (this.segredos.v('META_ADS_CONTA') ?? '').replace(/^act_/, '');
    if (!token || !conta) throw new ServiceUnavailableException('Preencha o token e a conta de anúncios do Meta em Configurações › Integrações.');
    const ligadas = await this.db.select().from(campanhas).where(isNotNull(campanhas.metaCampanhaId));
    if (!ligadas.length) throw new BadRequestException('Nenhuma campanha tem o id do Meta preenchido.');
    const base = (process.env.META_ADS_URL ?? 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
    const gastos = new Map<string, number>();
    const porMes = new Map<string, Map<string, number>>();
    let url: string | null = `${base}/act_${conta}/insights?level=campaign&fields=campaign_id,campaign_name,spend&date_preset=maximum&time_increment=monthly&limit=500`;
    for (let pagina = 0; url && pagina < 20; pagina++) {
      const res: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const j = (await res.json().catch(() => ({}))) as { data?: { campaign_id: string; spend: string; date_start?: string }[]; paging?: { next?: string }; error?: { message?: string } };
      if (!res.ok) throw new ServiceUnavailableException(`O Meta recusou: ${j.error?.message ?? res.status}`);
      for (const d of j.data ?? []) {
        const v = Math.round(Number(d.spend) * 100);
        gastos.set(d.campaign_id, (gastos.get(d.campaign_id) ?? 0) + v);
        // Com time_increment=monthly cada linha é um mês da campanha.
        if (d.date_start && /^\d{4}-\d{2}/.test(d.date_start)) {
          const m = porMes.get(d.campaign_id) ?? new Map<string, number>();
          m.set(d.date_start.slice(0, 7), (m.get(d.date_start.slice(0, 7)) ?? 0) + v);
          porMes.set(d.campaign_id, m);
        }
      }
      url = j.paging?.next ?? null;
    }
    let atualizadas = 0;
    for (const c of ligadas) {
      if (!gastos.has(c.metaCampanhaId!)) continue;
      await this.db.transaction(async (tx) => {
        await tx.update(campanhas).set({ investimentoSincronizado: gastos.get(c.metaCampanhaId!)!, sincronizadoEm: new Date() }).where(eq(campanhas.id, c.id));
        await tx.delete(marketingGastos).where(and(eq(marketingGastos.campanhaId, c.id), eq(marketingGastos.origem, 'meta')));
        const meses = [...(porMes.get(c.metaCampanhaId!) ?? new Map()).entries()].filter(([, v]) => v > 0);
        if (meses.length) await tx.insert(marketingGastos).values(meses.map(([competencia, valor]) => ({ competencia, campanhaId: c.id, descricao: `Meta Ads · ${c.nome}`, valor, origem: 'meta', usuarioId: u.id })));
      });
      atualizadas++;
    }
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'sincronizar_meta', entidade: 'marketing', dados: { atualizadas, encontradas: gastos.size } });
    return { atualizadas, semDados: ligadas.length - atualizadas };
  }

  /** Gastos lançados à mão por campanha (somam ao investimento dela). Os do Meta já estão no total sincronizado. */
  private async extrasPorCampanha() {
    const r = await this.db.execute<{ id: string; v: string }>(sql`select campanha_id as id, sum(valor)::bigint as v from marketing_gastos where origem = 'manual' and campanha_id is not null group by 1`);
    return new Map(r.rows.map((x) => [x.id, Number(x.v)]));
  }

  @Get('gastos')
  @Permissao('marketing', 'ver')
  gastos(@Query('competencia') competencia?: string) {
    return this.db
      .select({ id: marketingGastos.id, competencia: marketingGastos.competencia, descricao: marketingGastos.descricao, valor: marketingGastos.valor, origem: marketingGastos.origem, campanhaId: marketingGastos.campanhaId, campanha: campanhas.nome })
      .from(marketingGastos)
      .leftJoin(campanhas, eq(campanhas.id, marketingGastos.campanhaId))
      .where(competencia && /^\d{4}-\d{2}$/.test(competencia) ? eq(marketingGastos.competencia, competencia) : undefined)
      .orderBy(desc(marketingGastos.competencia), asc(marketingGastos.descricao))
      .limit(500);
  }

  @Post('gastos')
  @Permissao('marketing', 'editar')
  async lancarGasto(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        competencia: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM'),
        campanhaId: z.string().uuid().nullable().optional(),
        descricao: z.string().trim().min(2, 'Descreva o gasto').max(120),
        valor: centavos.refine((v) => v > 0, 'Informe o valor'),
      }),
      body,
    );
    const [g] = await this.db.insert(marketingGastos).values({ ...d, campanhaId: d.campanhaId ?? null, origem: 'manual', usuarioId: u.id }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'marketing_gasto', entidadeId: g.id, dados: d });
    return g;
  }

  @Delete('gastos/:id')
  @Permissao('marketing', 'editar')
  async apagarGasto(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [g] = await this.db.delete(marketingGastos).where(and(eq(marketingGastos.id, id), eq(marketingGastos.origem, 'manual'))).returning();
    if (!g) throw new BadRequestException('Gasto não encontrado (os do Meta mudam só sincronizando de novo).');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'marketing_gasto', entidadeId: id, dados: { competencia: g.competencia, valor: g.valor } });
    return { ok: true };
  }

  /**
   * Aquisição mês a mês: quanto foi investido, quantos leads e candidatas vieram, quantas foram aprovadas,
   * o custo de cada uma e quanto as aprovadas daquele mês já venderam (retorno do investimento).
   * Investimento do mês = gastos lançados + mês a mês do Meta; campanha só com valor total é rateada pelos dias dela.
   */
  @Get('mensal')
  @Permissao('marketing', 'ver')
  async mensal(@Query('meses') m = '12') {
    const n = Math.min(Math.max(Number(m) || 12, 3), 36);
    const h = hoje();
    const meses = Array.from({ length: n }, (_, i) => new Date(Date.UTC(Number(h.slice(0, 4)), Number(h.slice(5, 7)) - n + i, 1)).toISOString().slice(0, 7));
    const ini = `${meses[0]}-01`;
    const inv = new Map<string, number>(meses.map((x) => [x, 0]));
    const somar = (mes: string, v: number) => inv.has(mes) && inv.set(mes, inv.get(mes)! + v);
    const gs = await this.db.select().from(marketingGastos);
    for (const g of gs) somar(g.competencia, g.valor);
    // Campanhas sem os meses do Meta: o valor total é dividido pelos dias em que ela rodou.
    const comMeta = new Set(gs.filter((g) => g.origem === 'meta' && g.campanhaId).map((g) => g.campanhaId!));
    for (const c of await this.db.select().from(campanhas)) {
      const total = c.investimentoSincronizado ?? c.investimento;
      if (!total || comMeta.has(c.id)) continue;
      const de = c.inicio ?? c.criadoEm.toISOString().slice(0, 10);
      let ate = c.fim ?? (c.ativa ? h : de);
      if (ate < de) ate = de;
      const dias = Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000) + 1;
      const porMes = new Map<string, number>();
      for (let i = 0; i < dias; i++) {
        const d = new Date(Date.parse(de) + i * 86_400_000).toISOString().slice(0, 7);
        porMes.set(d, (porMes.get(d) ?? 0) + 1);
      }
      let usado = 0;
      const lista = [...porMes.entries()];
      lista.forEach(([mes, qtd], i) => {
        const v = i === lista.length - 1 ? total - usado : Math.round((total * qtd) / dias);
        usado += v;
        somar(mes, v);
      });
    }
    const r = await this.db.execute<Record<string, any>>(sql`
      with c as (select to_char(criado_em at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes, etapa, pessoa_id from candidaturas where criado_em >= ${ini}::date),
      l as (select to_char(criado_em at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes, count(*)::int as n from crm_leads where criado_em >= ${ini}::date group by 1),
      v as (select c.mes, sum((a.resultado->>'totalVendido')::bigint) as vendido from c join maletas mm on mm.representante_id = c.pessoa_id join acertos a on a.maleta_id = mm.id where c.etapa = 'aprovada' group by 1)
      select x.mes,
        coalesce((select n from l where l.mes = x.mes), 0) as leads,
        (select count(*)::int from c where c.mes = x.mes) as candidatas,
        (select count(*)::int from c where c.mes = x.mes and c.etapa = 'aprovada') as aprovadas,
        coalesce((select vendido from v where v.mes = x.mes), 0)::bigint as vendido
      from unnest(${sql.raw(`array[${meses.map((x) => `'${x}'`).join(',')}]`)}::text[]) as x(mes)`);
    const div = (a: number, b: number) => (b > 0 && a > 0 ? Math.round(a / b) : null);
    const linhas = r.rows.map((x) => {
      const investimento = inv.get(x.mes) ?? 0;
      const vendido = Number(x.vendido);
      return { mes: x.mes, investimento, leads: x.leads, candidatas: x.candidatas, aprovadas: x.aprovadas, custoPorLead: div(investimento, x.leads), custoPorCandidata: div(investimento, x.candidatas), custoPorAprovada: div(investimento, x.aprovadas), vendidoPelasAprovadas: vendido, retorno: investimento > 0 && x.aprovadas > 0 ? Math.round((vendido / investimento) * 100) / 100 : null };
    });
    const t = linhas.reduce((a, l) => ({ investimento: a.investimento + l.investimento, leads: a.leads + l.leads, candidatas: a.candidatas + l.candidatas, aprovadas: a.aprovadas + l.aprovadas, vendido: a.vendido + l.vendidoPelasAprovadas }), { investimento: 0, leads: 0, candidatas: 0, aprovadas: 0, vendido: 0 });
    return {
      linhas,
      totais: { ...t, custoPorLead: div(t.investimento, t.leads), custoPorCandidata: div(t.investimento, t.candidatas), custoPorAprovada: div(t.investimento, t.aprovadas), retorno: t.investimento > 0 && t.aprovadas > 0 ? Math.round((t.vendido / t.investimento) * 100) / 100 : null },
    };
  }
}
