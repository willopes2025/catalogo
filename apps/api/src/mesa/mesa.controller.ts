import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { configuracoes, grupos, mesaConversas, mesaMensagens, mesaParticipantes, mesaTarefas, usuarios } from '../db/schema';

const uuid = z.string().uuid();
const dataISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').refine((d) => !Number.isNaN(Date.parse(d)), 'Data inválida');
const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

/** Indicadores que podem ir para o painel de um setor. Cada um exige o módulo indicado. */
const INDICADORES: Record<string, { rotulo: string; modulo: string; formato: 'reais' | 'numero'; link: string; alerta?: boolean; sql: (u: string) => ReturnType<typeof sql> }> = {
  vendas_hoje: { rotulo: 'Vendas de loja hoje', modulo: 'vendas', formato: 'reais', link: '/vendas', sql: () => sql`select coalesce(sum(total - devolvido), 0) as v from vendas where status = 'concluida' and (criado_em at time zone 'America/Sao_Paulo')::date = ${hoje()}::date` },
  vendas_mes: { rotulo: 'Vendas de loja no mês', modulo: 'vendas', formato: 'reais', link: '/vendas', sql: () => sql`select coalesce(sum(total - devolvido), 0) as v from vendas where status = 'concluida' and (criado_em at time zone 'America/Sao_Paulo')::date >= date_trunc('month', ${hoje()}::date)` },
  maletas_abertas: { rotulo: 'Maletas na rua', modulo: 'maletas', formato: 'numero', link: '/maletas', sql: () => sql`select count(*) as v from maletas where status = 'aberta'` },
  acertos_atrasados: { rotulo: 'Acertos atrasados', modulo: 'maletas', formato: 'numero', link: '/maletas', alerta: true, sql: () => sql`select count(*) as v from maletas where status = 'aberta' and data_limite < ${hoje()}::date` },
  acertos_semana: { rotulo: 'Acertos nos próximos 7 dias', modulo: 'maletas', formato: 'numero', link: '/maletas', sql: () => sql`select count(*) as v from maletas where status = 'aberta' and data_limite between ${hoje()}::date and ${hoje()}::date + 7` },
  receber_vencido: { rotulo: 'A receber vencido', modulo: 'financeiro', formato: 'reais', link: '/financeiro', alerta: true, sql: () => sql`select coalesce(sum(valor), 0) as v from titulos where tipo = 'receber' and status = 'aberto' and vencimento < ${hoje()}::date and coalesce(forma_pagamento, '') not in ('debito', 'credito')` },
  recebido_mes: { rotulo: 'Recebido no mês', modulo: 'financeiro', formato: 'reais', link: '/financeiro', sql: () => sql`select coalesce(sum(coalesce(valor_pago, valor)), 0) as v from titulos where tipo = 'receber' and status = 'pago' and pago_em >= date_trunc('month', ${hoje()}::date)` },
  pagar_semana: { rotulo: 'A pagar nos próximos 7 dias', modulo: 'financeiro', formato: 'reais', link: '/financeiro', sql: () => sql`select coalesce(sum(valor), 0) as v from titulos where tipo = 'pagar' and status = 'aberto' and vencimento <= ${hoje()}::date + 7` },
  promessas_hoje: { rotulo: 'Promessas de pagamento até hoje', modulo: 'cobranca', formato: 'numero', link: '/cobranca', alerta: true, sql: () => sql`select count(*) as v from cobranca_contatos where promessa_status = 'aberta' and promessa_data <= ${hoje()}::date` },
  crm_fila: { rotulo: 'Conversas na fila', modulo: 'crm', formato: 'numero', link: '/crm', alerta: true, sql: () => sql`select count(*) as v from crm_conversas where status = 'fila'` },
  crm_minhas: { rotulo: 'Minhas conversas em atendimento', modulo: 'crm', formato: 'numero', link: '/crm', sql: (u) => sql`select count(*) as v from crm_conversas where status = 'atendimento' and atendente_id = ${u}::uuid` },
  leads_semana: { rotulo: 'Cards novos em 7 dias', modulo: 'crm', formato: 'numero', link: '/crm', sql: () => sql`select count(*) as v from crm_leads where criado_em >= now() - interval '7 days'` },
  candidatas_novas: { rotulo: 'Candidatas esperando contato', modulo: 'crm', formato: 'numero', link: '/crm', alerta: true, sql: () => sql`select count(*) as v from candidaturas where etapa = 'nova'` },
  estoque_baixo: { rotulo: 'Produtos abaixo do mínimo', modulo: 'estoque', formato: 'numero', link: '/estoque', alerta: true, sql: () => sql`select count(*) as v from produtos p where p.ativo and p.estoque_minimo > 0 and coalesce((select sum(s.quantidade) from saldos s join locais_estoque l on l.id = s.local_id where s.produto_id = p.id and l.tipo <> 'maleta'), 0) < p.estoque_minimo` },
  garantias_abertas: { rotulo: 'Garantias e consertos em aberto', modulo: 'garantia', formato: 'numero', link: '/garantia', sql: () => sql`select count(*) as v from ordens_servico where status in ('aberta', 'na_assistencia', 'pronta')` },
  tarefas_equipe_atrasadas: { rotulo: 'Tarefas da equipe atrasadas', modulo: 'configuracoes', formato: 'numero', link: '/mesa', alerta: true, sql: () => sql`select count(*) as v from mesa_tarefas where feita_em is null and vence_em < ${hoje()}::date` },
};

const tarefaSchema = z.object({
  titulo: z.string().trim().min(3, 'Diga o que precisa ser feito').max(200),
  descricao: z.string().trim().max(2000).nullable().optional(),
  responsavelId: uuid.optional(),
  venceEm: dataISO.nullable().optional(),
  prioridade: z.enum(['baixa', 'normal', 'alta']).optional(),
});

/**
 * Minha mesa: conversa interna da equipe, tarefas de cada pessoa e o painel do setor.
 * Vale para todo usuário do painel (não depende de módulo): cada um só vê as conversas de que participa
 * e as tarefas que são dele ou que ele criou; a gestão vê as tarefas de todos.
 */
@Controller('mesa')
export class MesaController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  private gestao(u: UsuarioLogado) {
    return temPermissao(u.permissoes, 'configuracoes', 'ver');
  }

  private async participa(conversaId: string, usuarioId: string) {
    const [p] = await this.db.select().from(mesaParticipantes).where(and(eq(mesaParticipantes.conversaId, conversaId), eq(mesaParticipantes.usuarioId, usuarioId)));
    if (!p) throw new NotFoundException('Conversa não encontrada.');
    return p;
  }

  /** Para o aviso na tela: quantas mensagens não lidas, tarefas abertas e o que chegou depois de `desde`. */
  @Get('resumo')
  @Permissao('inicio', 'ver')
  async resumo(@Usuario() u: UsuarioLogado, @Query('desde') desde?: string) {
    const d = desde && !Number.isNaN(Date.parse(desde)) ? new Date(desde) : new Date();
    const [{ n: naoLidas }] = (await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from mesa_mensagens m join mesa_participantes p on p.conversa_id = m.conversa_id and p.usuario_id = ${u.id}
      where m.criado_em > p.lido_ate and m.usuario_id is distinct from ${u.id}`)).rows;
    const [t] = (await this.db.execute<{ abertas: number; atrasadas: number }>(sql`
      select count(*)::int as abertas, count(*) filter (where vence_em < ${hoje()}::date)::int as atrasadas from mesa_tarefas where feita_em is null and responsavel_id = ${u.id}`)).rows;
    const mensagens = (await this.db.execute<{ id: string; conversaId: string; de: string; texto: string; criadoEm: string }>(sql`
      select m.id, m.conversa_id as "conversaId", coalesce(a.nome, 'Alguém') as de, left(m.texto, 140) as texto, m.criado_em as "criadoEm"
      from mesa_mensagens m join mesa_participantes p on p.conversa_id = m.conversa_id and p.usuario_id = ${u.id} left join usuarios a on a.id = m.usuario_id
      where m.criado_em > ${d} and m.criado_em > p.lido_ate and m.usuario_id is distinct from ${u.id} order by m.criado_em desc limit 5`)).rows;
    const tarefas = (await this.db.execute<{ id: string; de: string; titulo: string; criadoEm: string }>(sql`
      select t.id, coalesce(a.nome, 'Alguém') as de, t.titulo, t.criado_em as "criadoEm" from mesa_tarefas t left join usuarios a on a.id = t.criado_por
      where t.responsavel_id = ${u.id} and t.criado_por is distinct from ${u.id} and t.feita_em is null and t.criado_em > ${d} order by t.criado_em desc limit 5`)).rows;
    return { agora: new Date().toISOString(), naoLidas, tarefasAbertas: t.abertas, tarefasAtrasadas: t.atrasadas, novas: { mensagens, tarefas } };
  }

  /** Quem está na equipe, para escolher com quem falar e para quem passar tarefa. */
  @Get('equipe')
  @Permissao('inicio', 'ver')
  async equipe() {
    return this.db
      .select({ id: usuarios.id, nome: usuarios.nome, setor: grupos.nome, online: sql<boolean>`coalesce(${usuarios.ultimaAtividadeEm} > now() - interval '5 minutes', false)` })
      .from(usuarios)
      .innerJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .where(eq(usuarios.ativo, true))
      .orderBy(asc(usuarios.nome));
  }

  // ───────── Conversa interna ─────────

  @Get('conversas')
  @Permissao('inicio', 'ver')
  async conversas(@Usuario() u: UsuarioLogado) {
    return (await this.db.execute(sql`
      select c.id, c.direta, c.ultima_em as "ultimaEm",
        case when c.direta then coalesce((select x.nome from mesa_participantes o join usuarios x on x.id = o.usuario_id where o.conversa_id = c.id and o.usuario_id <> ${u.id} limit 1), 'Conversa') else coalesce(c.nome, 'Grupo') end as nome,
        (select coalesce(json_agg(json_build_object('id', x.id, 'nome', x.nome) order by x.nome), '[]'::json) from mesa_participantes o join usuarios x on x.id = o.usuario_id where o.conversa_id = c.id) as participantes,
        (select left(m.texto, 100) from mesa_mensagens m where m.conversa_id = c.id order by m.criado_em desc limit 1) as ultima,
        (select count(*)::int from mesa_mensagens m where m.conversa_id = c.id and m.criado_em > p.lido_ate and m.usuario_id is distinct from ${u.id}) as "naoLidas"
      from mesa_conversas c join mesa_participantes p on p.conversa_id = c.id and p.usuario_id = ${u.id}
      order by c.ultima_em desc limit 200`)).rows;
  }

  /** Abre a conversa com uma pessoa (reaproveita a que já existe) ou cria um grupo. */
  @Post('conversas')
  @Permissao('inicio', 'ver')
  async abrir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ usuarioIds: z.array(uuid).min(1, 'Escolha com quem falar').max(40), nome: z.string().trim().max(60).nullable().optional() }), body);
    const outros = [...new Set(d.usuarioIds)].filter((id) => id !== u.id);
    if (!outros.length) throw new BadRequestException('Escolha outra pessoa da equipe.');
    const ativos = await this.db.select({ id: usuarios.id }).from(usuarios).where(and(inArray(usuarios.id, outros), eq(usuarios.ativo, true)));
    if (ativos.length !== outros.length) throw new BadRequestException('Uma das pessoas não está mais ativa.');
    const direta = outros.length === 1 && !d.nome;
    if (!direta && !d.nome) throw new BadRequestException('Dê um nome ao grupo.');
    const chave = direta ? [u.id, outros[0]].sort().join(':') : null;
    if (chave) {
      const [ja] = await this.db.select({ id: mesaConversas.id }).from(mesaConversas).where(eq(mesaConversas.chave, chave));
      if (ja) return { id: ja.id };
    }
    return this.db.transaction(async (tx) => {
      const [c] = await tx.insert(mesaConversas).values({ nome: direta ? null : d.nome, direta, chave, criadoPor: u.id }).onConflictDoNothing().returning({ id: mesaConversas.id });
      if (!c) {
        // Os dois abriram a conversa ao mesmo tempo.
        const [ja] = await tx.select({ id: mesaConversas.id }).from(mesaConversas).where(eq(mesaConversas.chave, chave!));
        return { id: ja.id };
      }
      await tx.insert(mesaParticipantes).values([u.id, ...outros].map((usuarioId) => ({ conversaId: c.id, usuarioId })));
      return { id: c.id };
    });
  }

  /** Mensagens da conversa (as 80 mais recentes, ou as anteriores a `antes`). Abrir marca como lida. */
  @Get('conversas/:id/mensagens')
  @Permissao('inicio', 'ver')
  async mensagens(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Query('antes') antes?: string) {
    await this.participa(id, u.id);
    const f = [eq(mesaMensagens.conversaId, id)];
    if (antes && !Number.isNaN(Date.parse(antes))) f.push(sql`${mesaMensagens.criadoEm} < ${new Date(antes)}`);
    const lista = await this.db
      .select({ id: mesaMensagens.id, usuarioId: mesaMensagens.usuarioId, de: usuarios.nome, texto: mesaMensagens.texto, criadoEm: mesaMensagens.criadoEm })
      .from(mesaMensagens)
      .leftJoin(usuarios, eq(usuarios.id, mesaMensagens.usuarioId))
      .where(and(...f))
      .orderBy(desc(mesaMensagens.criadoEm))
      .limit(80);
    if (!antes) await this.db.update(mesaParticipantes).set({ lidoAte: new Date() }).where(and(eq(mesaParticipantes.conversaId, id), eq(mesaParticipantes.usuarioId, u.id)));
    return { mensagens: lista.reverse(), temMais: lista.length === 80 };
  }

  @Post('conversas/:id/mensagens')
  @Permissao('inicio', 'ver')
  async enviar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ texto: z.string().trim().min(1, 'Escreva a mensagem').max(4000) }), body);
    await this.participa(id, u.id);
    const agora = new Date();
    const [m] = await this.db.insert(mesaMensagens).values({ conversaId: id, usuarioId: u.id, texto: d.texto, criadoEm: agora }).returning();
    await this.db.update(mesaConversas).set({ ultimaEm: agora }).where(eq(mesaConversas.id, id));
    await this.db.update(mesaParticipantes).set({ lidoAte: agora }).where(and(eq(mesaParticipantes.conversaId, id), eq(mesaParticipantes.usuarioId, u.id)));
    return { id: m.id, usuarioId: u.id, de: u.nome, texto: m.texto, criadoEm: m.criadoEm };
  }

  // ───────── Tarefas ─────────

  /** minhas (padrão) | criadas (que passei para outros) | equipe (todas, só gestão). `feitas=1` mostra as concluídas dos últimos 30 dias. */
  @Get('tarefas')
  @Permissao('inicio', 'ver')
  async tarefas(@Usuario() u: UsuarioLogado, @Query('filtro') filtro = 'minhas', @Query('feitas') feitas?: string) {
    if (filtro === 'equipe' && !this.gestao(u)) throw new ForbiddenException('Só a gestão vê as tarefas de toda a equipe.');
    const quem = filtro === 'equipe' ? sql`true` : filtro === 'criadas' ? sql`t.criado_por = ${u.id} and t.responsavel_id <> ${u.id}` : sql`t.responsavel_id = ${u.id}`;
    const situacao = feitas ? sql`t.feita_em > now() - interval '30 days'` : sql`t.feita_em is null`;
    return (await this.db.execute(sql`
      select t.id, t.titulo, t.descricao, t.prioridade, t.vence_em as "venceEm", t.feita_em as "feitaEm", t.criado_em as "criadoEm",
        t.responsavel_id as "responsavelId", r.nome as responsavel, t.criado_por as "criadoPorId", c.nome as "criadoPor",
        (t.feita_em is null and t.vence_em < ${hoje()}::date) as atrasada
      from mesa_tarefas t join usuarios r on r.id = t.responsavel_id left join usuarios c on c.id = t.criado_por
      where ${quem} and ${situacao}
      order by t.feita_em desc nulls first, (t.vence_em is null), t.vence_em, case t.prioridade when 'alta' then 0 when 'normal' then 1 else 2 end, t.criado_em
      limit 300`)).rows;
  }

  @Post('tarefas')
  @Permissao('inicio', 'ver')
  async criarTarefa(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(tarefaSchema, body);
    const responsavelId = d.responsavelId ?? u.id;
    const [r] = await this.db.select({ id: usuarios.id }).from(usuarios).where(and(eq(usuarios.id, responsavelId), eq(usuarios.ativo, true)));
    if (!r) throw new BadRequestException('Responsável não encontrado.');
    const [t] = await this.db.insert(mesaTarefas).values({ titulo: d.titulo, descricao: d.descricao || null, responsavelId, criadoPor: u.id, venceEm: d.venceEm ?? null, prioridade: d.prioridade ?? 'normal' }).returning();
    if (responsavelId !== u.id) await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'tarefa', entidadeId: t.id, dados: { para: responsavelId } });
    return t;
  }

  /** Concluir, reabrir ou mudar a tarefa. Só o responsável, quem criou ou a gestão. */
  @Patch('tarefas/:id')
  @Permissao('inicio', 'ver')
  async mudarTarefa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(tarefaSchema.partial().extend({ feita: z.boolean().optional() }), body);
    const [t] = await this.db.select().from(mesaTarefas).where(eq(mesaTarefas.id, id));
    if (!t) throw new NotFoundException('Tarefa não encontrada.');
    const dono = t.criadoPor === u.id || this.gestao(u);
    if (t.responsavelId !== u.id && !dono) throw new ForbiddenException('Esta tarefa não é sua.');
    // Quem só é responsável conclui e reabre; mudar o combinado é com quem passou a tarefa (ou a gestão).
    const mudaCombinado = d.titulo !== undefined || d.descricao !== undefined || d.venceEm !== undefined || d.prioridade !== undefined || (d.responsavelId !== undefined && d.responsavelId !== t.responsavelId);
    if (mudaCombinado && !dono) throw new ForbiddenException('Só quem passou a tarefa (ou a gestão) muda o prazo, o texto ou o responsável.');
    if (d.responsavelId && d.responsavelId !== t.responsavelId) {
      const [r] = await this.db.select({ id: usuarios.id }).from(usuarios).where(and(eq(usuarios.id, d.responsavelId), eq(usuarios.ativo, true)));
      if (!r) throw new BadRequestException('Responsável não encontrado.');
    }
    const [n] = await this.db
      .update(mesaTarefas)
      .set({
        ...(d.titulo !== undefined ? { titulo: d.titulo } : {}),
        ...(d.descricao !== undefined ? { descricao: d.descricao || null } : {}),
        ...(d.venceEm !== undefined ? { venceEm: d.venceEm } : {}),
        ...(d.prioridade !== undefined ? { prioridade: d.prioridade } : {}),
        ...(d.responsavelId ? { responsavelId: d.responsavelId } : {}),
        ...(d.feita === undefined ? {} : d.feita ? { feitaEm: new Date(), feitaPor: u.id } : { feitaEm: null, feitaPor: null }),
      })
      .where(eq(mesaTarefas.id, id))
      .returning();
    return n;
  }

  // ───────── Painel do setor ─────────

  private async paineis(): Promise<Record<string, string[]>> {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, 'mesa_paineis'));
    return (c?.valor as Record<string, string[]>) ?? {};
  }

  /**
   * Indicadores do setor (grupo) de quem está logado. Sem configuração, entram os dos módulos que a pessoa pode ver.
   * A gestão recebe também o catálogo e a escolha de cada setor, para configurar.
   */
  @Get('painel')
  @Permissao('inicio', 'ver')
  async painel(@Usuario() u: UsuarioLogado) {
    const [eu] = await this.db.select({ grupoId: usuarios.grupoId, setor: grupos.nome }).from(usuarios).innerJoin(grupos, eq(grupos.id, usuarios.grupoId)).where(eq(usuarios.id, u.id));
    const paineis = await this.paineis();
    const permitidos = Object.entries(INDICADORES).filter(([, i]) => temPermissao(u.permissoes, i.modulo, 'ver')).map(([k]) => k);
    const escolhidos = eu && paineis[eu.grupoId] ? paineis[eu.grupoId].filter((k) => permitidos.includes(k)) : permitidos.slice(0, 8);
    const indicadores = await Promise.all(
      escolhidos.map(async (chave) => {
        const i = INDICADORES[chave];
        const valor = Number((await this.db.execute<{ v: string }>(i.sql(u.id))).rows[0]?.v ?? 0);
        return { chave, rotulo: i.rotulo, formato: i.formato, link: i.link, valor, alerta: !!i.alerta && valor > 0 };
      }),
    );
    const gestao = temPermissao(u.permissoes, 'configuracoes', 'editar');
    return {
      setor: eu?.setor ?? null,
      personalizado: !!(eu && paineis[eu.grupoId]),
      indicadores,
      ...(gestao ? { catalogo: Object.entries(INDICADORES).map(([chave, i]) => ({ chave, rotulo: i.rotulo, modulo: i.modulo })), setores: (await this.db.select({ id: grupos.id, nome: grupos.nome }).from(grupos).orderBy(asc(grupos.nome))).map((g) => ({ ...g, indicadores: paineis[g.id] ?? null })) } : {}),
    };
  }

  /** Define os indicadores do painel de um setor. Lista vazia volta ao padrão. */
  @Put('painel')
  @Permissao('configuracoes', 'editar')
  async salvarPainel(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ grupoId: uuid, indicadores: z.array(z.string()).max(12, 'No máximo 12 indicadores por setor') }), body);
    const desconhecidos = d.indicadores.filter((k) => !INDICADORES[k]);
    if (desconhecidos.length) throw new BadRequestException(`Indicador desconhecido: ${desconhecidos.join(', ')}`);
    const [g] = await this.db.select({ id: grupos.id }).from(grupos).where(eq(grupos.id, d.grupoId));
    if (!g) throw new NotFoundException('Setor não encontrado.');
    const paineis = await this.paineis();
    if (d.indicadores.length) paineis[d.grupoId] = [...new Set(d.indicadores)];
    else delete paineis[d.grupoId];
    await this.db.insert(configuracoes).values({ chave: 'mesa_paineis', valor: paineis }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: paineis, atualizadoEm: new Date() } });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'configurar', entidade: 'mesa_painel', entidadeId: d.grupoId, dados: { indicadores: d.indicadores } });
    return { ok: true };
  }
}
