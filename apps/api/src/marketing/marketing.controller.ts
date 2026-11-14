import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, ServiceUnavailableException } from '@nestjs/common';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, opcional, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { SegredosService } from '../segredos/segredos.service';
import { campanhas } from '../db/schema';

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
    }>(sql`
      with utms as (
        select lower(origem->>'utm_campaign') as utm from candidaturas where coalesce(origem->>'utm_campaign','') <> ''
        union select lower(origem->>'utm_campaign') from formulario_respostas where coalesce(origem->>'utm_campaign','') <> ''
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
        coalesce(v.vendido, 0) as vendido,
        coalesce(v.reps, 0) as representantes_vendendo
      from utms u left join vendas v on v.utm = u.utm`);
    const cs = await this.db.select().from(campanhas);
    const linhas = r.rows.map((x) => {
      const c = cs.find((k) => k.utmCampaign === x.utm) ?? null;
      const investimento = c ? (c.investimentoSincronizado ?? c.investimento) : 0;
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
        vendidoPelasAprovadas: vendido,
        representantesVendendo: x.representantes_vendendo,
        custoPorCandidata: div(investimento, x.candidatas),
        custoPorAprovada: div(investimento, x.aprovadas),
        custoPorCliente: div(investimento, x.clientes),
        /** Quanto as aprovadas venderam para cada real investido (vendido ÷ investimento). */
        retorno: c && investimento > 0 && x.aprovadas > 0 ? Math.round((vendido / investimento) * 100) / 100 : null,
      };
    });
    linhas.sort((a, b) => Number(!!b.campanha) - Number(!!a.campanha) || b.candidatas + b.respostas - (a.candidatas + a.respostas));
    // Totais só das campanhas cadastradas: investimento e resultados do mesmo conjunto.
    const soma = (k: 'investimento' | 'candidatas' | 'aprovadas' | 'clientes' | 'vendidoPelasAprovadas') => linhas.filter((l) => l.campanha).reduce((s, l) => s + l[k], 0);
    const direto = await this.db.execute<{ n: number }>(sql`select count(*)::int as n from candidaturas where coalesce(origem->>'utm_campaign','') = ''`);
    const codigosSemCampanha = linhas.filter((l) => !l.campanha).reduce((s, l) => s + l.candidatas, 0);
    return {
      linhas,
      totais: { investimento: soma('investimento'), candidatas: soma('candidatas'), aprovadas: soma('aprovadas'), clientes: soma('clientes'), vendidoPelasAprovadas: soma('vendidoPelasAprovadas'), candidatasSemCampanha: direto.rows[0].n, candidatasComCodigoSemCampanha: codigosSemCampanha },
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
    let url: string | null = `${base}/act_${conta}/insights?level=campaign&fields=campaign_id,campaign_name,spend&date_preset=maximum&limit=500`;
    for (let pagina = 0; url && pagina < 20; pagina++) {
      const res: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const j = (await res.json().catch(() => ({}))) as { data?: { campaign_id: string; spend: string }[]; paging?: { next?: string }; error?: { message?: string } };
      if (!res.ok) throw new ServiceUnavailableException(`O Meta recusou: ${j.error?.message ?? res.status}`);
      for (const d of j.data ?? []) gastos.set(d.campaign_id, (gastos.get(d.campaign_id) ?? 0) + Math.round(Number(d.spend) * 100));
      url = j.paging?.next ?? null;
    }
    let atualizadas = 0;
    for (const c of ligadas) {
      if (!gastos.has(c.metaCampanhaId!)) continue;
      await this.db.update(campanhas).set({ investimentoSincronizado: gastos.get(c.metaCampanhaId!)!, sincronizadoEm: new Date() }).where(eq(campanhas.id, c.id));
      atualizadas++;
    }
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'sincronizar_meta', entidade: 'marketing', dados: { atualizadas, encontradas: gastos.size } });
    return { atualizadas, semDados: ligadas.length - atualizadas };
  }
}
