import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { existsSync } from 'node:fs';
import type { Request, Response } from 'express';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { opcional, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { SegredosService } from '../segredos/segredos.service';
import {
  candidaturas,
  crmCanais,
  crmContatos,
  crmConversas,
  crmDisparoDestinos,
  crmDisparos,
  crmEtapas,
  crmEventos,
  crmFila,
  crmFunis,
  crmGatilhos,
  crmLeads,
  crmMensagens,
  crmRespostasRapidas,
  crmCampos,
  crmRamais,
  configuracoes,
  crmTarefas,
  crmTemplates,
  pessoas,
  usuarios,
  iaAgentes,
} from '../db/schema';
import { ESPECIALISTAS_SUGERIDOS, duplicarEspecialista } from './especialistas';
import { CrmService } from './crm.service';
import { CanaisService } from './canais.service';
import { HistoricoWhatsappService } from './historico.service';
import { TarefasMensagemService } from './tarefas-mensagem.service';
import { TranscricaoService } from './transcricao.service';
import { AgenteService } from './agente.service';
import { ErroIa, IaService } from '../ia/ia.service';
import { VOZES_ELEVENLABS, VOZES_OPENAI } from '../ia/vozes';
import { AutomacaoService } from './automacao.service';

/** Lista como array do Postgres (o sql`` do Drizzle expande arrays em vários parâmetros). */
const arr = (xs: string[], tipo = 'uuid') => sql`array[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::${sql.raw(tipo)}[]`;
const gestor = (u: UsuarioLogado) => temPermissao(u.permissoes, 'crm', 'excluir');
const uuid = z.string().uuid();
const etiquetas = z.array(z.string().trim().min(1).max(40)).max(30);
export const TIPOS_CAMPO = ['texto', 'textao', 'numero', 'moeda', 'data', 'lista', 'multipla', 'telefone', 'email', 'url', 'sim_nao'] as const;
const campos = z.record(z.string().max(60), z.string().max(4000));
const acao = z
  .object({ tipo: z.enum(['esperar', 'enviar_template', 'enviar_mensagem', 'mover_etapa', 'atribuir', 'adicionar_etiqueta', 'criar_tarefa']) })
  .catchall(z.unknown())
  .superRefine((a, ctx) => {
    const r = a as Record<string, unknown>;
    const falta = (m: string) => ctx.addIssue({ code: 'custom', message: m });
    if (a.tipo === 'esperar' && !(Number(r.minutos) >= 1)) falta('Informe quantos minutos esperar');
    if (a.tipo === 'enviar_template' && !r.templateId) falta('Escolha o template');
    if (a.tipo === 'enviar_mensagem' && !String(r.texto ?? '').trim()) falta('Escreva a mensagem');
    if (a.tipo === 'mover_etapa' && !r.etapaId) falta('Escolha a etapa');
    if (a.tipo === 'atribuir' && !(Array.isArray(r.usuarios) && r.usuarios.length)) falta('Escolha quem recebe');
    if (a.tipo === 'adicionar_etiqueta' && !String(r.etiqueta ?? '').trim()) falta('Escreva a etiqueta');
  });
const gatilhoSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  funilId: uuid.nullable().optional(),
  evento: z.enum(['lead_criado', 'entrou_etapa', 'mensagem_recebida', 'sem_resposta', 'etiqueta_adicionada']),
  etapaId: uuid.nullable().optional(),
  parametro: opcional(120),
  acoes: z.array(acao).min(1, 'Adicione ao menos uma ação').max(20),
  ativo: z.boolean().default(true),
});

/**
 * CRM no padrão Kommo/Widezap: funis, cards, conversas com fila de atendimento, vários números de WhatsApp,
 * templates, respostas rápidas, gatilhos e disparos em massa.
 * Atendente vê a fila e as próprias conversas; quem tem "excluir" no CRM é gestão: vê tudo e reatribui.
 */
@Controller()
export class AtendimentoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
    private readonly agente: AgenteService,
    private readonly ia: IaService,
    private readonly automacao: AutomacaoService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly segredos: SegredosService,
    private readonly transcricao: TranscricaoService,
    private readonly historico: HistoricoWhatsappService,
    private readonly tarefasMensagem: TarefasMensagemService,
  ) {}

  // ───────────── Funis e etapas ─────────────

  @Get('crm/funis')
  @Permissao('crm', 'ver')
  async funis(@Query('todos') todos?: string) {
    const fs = await this.crm.funis(!todos);
    const contagem = await this.db.execute<{ etapa_id: string; n: number; valor: number }>(sql`select etapa_id, count(*)::int as n, coalesce(sum(valor),0)::bigint as valor from crm_leads group by etapa_id`);
    const porEtapa = new Map(contagem.rows.map((c) => [c.etapa_id, { n: c.n, valor: Number(c.valor) }]));
    return fs.map((f) => ({ ...f, etapas: f.etapas.map((e) => ({ ...e, leads: porEtapa.get(e.id)?.n ?? 0, valor: porEtapa.get(e.id)?.valor ?? 0 })) }));
  }

  @Post('crm/funis')
  @Permissao('crm', 'excluir')
  async criarFunil(@Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80) }), body);
    const [{ ordem }] = await this.db.select({ ordem: sql<number>`coalesce(max(${crmFunis.ordem}),0)+1` }).from(crmFunis);
    const [f] = await this.db.insert(crmFunis).values({ nome: d.nome, ordem }).returning();
    await this.db.insert(crmEtapas).values([
      { funilId: f.id, nome: 'Novo', ordem: 1 },
      { funilId: f.id, nome: 'Em andamento', ordem: 2 },
      { funilId: f.id, nome: 'Ganho', ordem: 3, tipo: 'ganho', cor: '#4f8a5b' },
      { funilId: f.id, nome: 'Perdido', ordem: 4, tipo: 'perdido', cor: '#b0574f' },
    ]);
    return f;
  }

  @Patch('crm/funis/:id')
  @Permissao('crm', 'excluir')
  async editarFunil(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80).optional(), ativo: z.boolean().optional(), ordem: z.number().int().optional() }), body);
    const [f] = await this.db.update(crmFunis).set(d).where(eq(crmFunis.id, id)).returning();
    if (!f) throw new NotFoundException('Funil não encontrado.');
    return f;
  }

  @Post('crm/funis/:id/etapas')
  @Permissao('crm', 'excluir')
  async criarEtapa(@Param('id', ParseUUIDPipe) funilId: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(1).max(60), cor: z.string().regex(/^#[0-9a-f]{6}$/i).default('#a68a64'), tipo: z.enum(['aberta', 'ganho', 'perdido']).default('aberta') }), body);
    const [{ ordem }] = await this.db.select({ ordem: sql<number>`coalesce(max(${crmEtapas.ordem}),0)+1` }).from(crmEtapas).where(eq(crmEtapas.funilId, funilId));
    const [e] = await this.db.insert(crmEtapas).values({ ...d, funilId, ordem }).returning();
    return e;
  }

  @Patch('crm/etapas/:id')
  @Permissao('crm', 'excluir')
  async editarEtapa(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(1).max(60).optional(), cor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), tipo: z.enum(['aberta', 'ganho', 'perdido']).optional() }), body);
    const [e] = await this.db.update(crmEtapas).set(d).where(eq(crmEtapas.id, id)).returning();
    if (!e) throw new NotFoundException('Etapa não encontrada.');
    return e;
  }

  @Post('crm/funis/:id/ordem')
  @Permissao('crm', 'excluir')
  async ordenarEtapas(@Param('id', ParseUUIDPipe) funilId: string, @Body() body: unknown) {
    const { ids } = validar(z.object({ ids: z.array(uuid).min(1) }), body);
    for (const [i, id] of ids.entries()) await this.db.update(crmEtapas).set({ ordem: i + 1 }).where(and(eq(crmEtapas.id, id), eq(crmEtapas.funilId, funilId)));
    return { ok: true };
  }

  @Delete('crm/etapas/:id')
  @Permissao('crm', 'excluir')
  async apagarEtapa(@Param('id', ParseUUIDPipe) id: string) {
    const [e] = await this.db.select().from(crmEtapas).where(eq(crmEtapas.id, id));
    if (!e) throw new NotFoundException('Etapa não encontrada.');
    if (e.chave) throw new BadRequestException('Esta etapa é usada pelo funil automático; renomeie em vez de apagar.');
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(crmLeads).where(eq(crmLeads.etapaId, id));
    if (n) throw new BadRequestException(`Há ${n} card(s) nesta etapa. Mova-os antes de apagar.`);
    await this.db.delete(crmEtapas).where(eq(crmEtapas.id, id));
    return { ok: true };
  }

  // ───────────── Cards (leads) ─────────────

  @Get('crm/leads')
  @Permissao('crm', 'ver')
  async leads(
    @Usuario() u: UsuarioLogado,
    @Query('funilId') funilId?: string,
    @Query('busca') busca?: string,
    @Query('responsavelId') responsavelId?: string,
    @Query('etiqueta') etiqueta?: string,
    @Query('status') status?: string,
  ) {
    const f: SQL[] = [];
    if (funilId) f.push(eq(crmLeads.funilId, funilId));
    if (responsavelId === 'eu') f.push(eq(crmLeads.responsavelId, u.id));
    else if (responsavelId === 'ninguem') f.push(sql`${crmLeads.responsavelId} is null`);
    else if (responsavelId) f.push(eq(crmLeads.responsavelId, responsavelId));
    if (etiqueta) f.push(sql`${crmLeads.etiquetas} ? ${etiqueta}`);
    // Ganhos e perdidos somem do quadro depois de 30 dias (continuam na busca).
    if (status) f.push(eq(crmLeads.status, status));
    else if (!busca?.trim()) f.push(sql`(${crmLeads.status} = 'aberto' or ${crmLeads.atualizadoEm} > now() - interval '30 days')`);
    if (busca?.trim()) {
      const b = `%${busca.trim()}%`;
      const dig = busca.replace(/\D/g, '');
      f.push(sql`(${crmLeads.titulo} ilike ${b} or ${crmContatos.nome} ilike ${b} or ${crmLeads.camposExtras}::text ilike ${b} or ${crmContatos.camposExtras}::text ilike ${b}${dig.length >= 4 ? sql` or ${crmContatos.telefone} like ${'%' + dig + '%'}` : sql``})`);
    }
    return this.db
      .select({
        id: crmLeads.id,
        numero: crmLeads.numero,
        titulo: crmLeads.titulo,
        valor: crmLeads.valor,
        funilId: crmLeads.funilId,
        etapaId: crmLeads.etapaId,
        status: crmLeads.status,
        etiquetas: crmLeads.etiquetas,
        responsavelId: crmLeads.responsavelId,
        responsavel: usuarios.nome,
        contatoId: crmLeads.contatoId,
        contato: crmContatos.nome,
        telefone: crmContatos.telefone,
        camposExtras: crmLeads.camposExtras,
        contatoExtras: crmContatos.camposExtras,
        entrouNaEtapaEm: crmLeads.entrouNaEtapaEm,
        ultimaInteracaoEm: crmLeads.ultimaInteracaoEm,
        criadoEm: crmLeads.criadoEm,
        naoLidas: sql<number>`(select coalesce(sum(c.nao_lidas),0)::int from crm_conversas c where c.contato_id = ${crmLeads.contatoId})`,
        tarefas: sql<number>`(select count(*)::int from crm_tarefas t where t.lead_id = ${crmLeads.id} and t.feita_em is null)`,
        tarefaVencida: sql<boolean>`exists (select 1 from crm_tarefas t where t.lead_id = ${crmLeads.id} and t.feita_em is null and t.vence_em < now())`,
        distribuicao: crmLeads.distribuicao,
        consultora: sql<string | null>`(select p.nome from pessoas p where p.id = ${crmLeads.consultoraId})`,
      })
      .from(crmLeads)
      .innerJoin(crmContatos, eq(crmContatos.id, crmLeads.contatoId))
      .leftJoin(usuarios, eq(usuarios.id, crmLeads.responsavelId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(desc(crmLeads.atualizadoEm))
      .limit(2000);
  }

  @Post('crm/leads')
  @Permissao('crm', 'criar')
  async criarLead(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        funilId: uuid,
        etapaId: uuid.nullable().optional(),
        nome: z.string().trim().min(2).max(150),
        telefone: z.string().trim().min(8, 'Informe o WhatsApp'),
        email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
        titulo: opcional(200),
        valor: z.number().int().min(0).default(0),
        etiquetas: etiquetas.default([]),
        camposExtras: campos.default({}),
        responsavelId: uuid.nullable().optional(),
      }),
      body,
    );
    const contato = await this.crm.garantirContato({ telefone: d.telefone, nome: d.nome, email: d.email });
    const aberto = await this.crm.leadAberto(contato.id, d.funilId);
    if (aberto) throw new BadRequestException(`Este contato já tem um card aberto neste funil (nº ${aberto.numero}).`);
    return this.crm.criarLead({ funilId: d.funilId, etapaId: d.etapaId, contatoId: contato.id, titulo: d.titulo || d.nome, valor: d.valor, etiquetas: d.etiquetas, camposExtras: d.camposExtras, responsavelId: d.responsavelId ?? u.id, usuarioId: u.id, origem: { utm_source: 'equipe' } });
  }

  @Get('crm/leads/:id')
  @Permissao('crm', 'ver')
  async lead(@Param('id', ParseUUIDPipe) id: string) {
    const [l] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, id));
    if (!l) throw new NotFoundException('Card não encontrado.');
    const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, l.contatoId));
    const [eventos, tarefas, conversas, outros] = await Promise.all([
      this.db
        .select({ id: crmEventos.id, tipo: crmEventos.tipo, texto: crmEventos.texto, autor: usuarios.nome, criadoEm: crmEventos.criadoEm })
        .from(crmEventos)
        .leftJoin(usuarios, eq(usuarios.id, crmEventos.usuarioId))
        .where(eq(crmEventos.leadId, id))
        .orderBy(desc(crmEventos.criadoEm))
        .limit(300),
      this.db
        .select({
          id: crmTarefas.id, titulo: crmTarefas.titulo, venceEm: crmTarefas.venceEm, feitaEm: crmTarefas.feitaEm, responsavelId: crmTarefas.responsavelId, responsavel: usuarios.nome,
          mensagemTipo: crmTarefas.mensagemTipo, mensagemTexto: crmTarefas.mensagemTexto, envio: crmTarefas.envio, mensagemStatus: crmTarefas.mensagemStatus, mensagemErro: crmTarefas.mensagemErro, mensagemEnviadaEm: crmTarefas.mensagemEnviadaEm,
          mensagemNome: sql<string | null>`coalesce((select '/' || r.atalho from crm_respostas_rapidas r where r.id = ${crmTarefas.respostaId}), (select t.nome from crm_templates t where t.id = ${crmTarefas.templateId}))`,
          canal: sql<string | null>`(select c.nome from crm_canais c where c.id = ${crmTarefas.canalId})`,
        })
        .from(crmTarefas)
        .leftJoin(usuarios, eq(usuarios.id, crmTarefas.responsavelId))
        .where(eq(crmTarefas.leadId, id))
        .orderBy(asc(crmTarefas.feitaEm), asc(crmTarefas.venceEm)),
      this.db
        .select({ id: crmConversas.id, canalId: crmConversas.canalId, canal: crmCanais.nome, canalTipo: crmCanais.tipo, status: crmConversas.status, atendenteId: crmConversas.atendenteId, naoLidas: crmConversas.naoLidas, ultimaEntradaEm: crmConversas.ultimaEntradaEm, ultimaMensagemEm: crmConversas.ultimaMensagemEm })
        .from(crmConversas)
        .innerJoin(crmCanais, eq(crmCanais.id, crmConversas.canalId))
        .where(eq(crmConversas.contatoId, l.contatoId))
        .orderBy(desc(crmConversas.ultimaMensagemEm)),
      this.db
        .select({ id: crmLeads.id, numero: crmLeads.numero, titulo: crmLeads.titulo, funil: crmFunis.nome, etapa: crmEtapas.nome, status: crmLeads.status })
        .from(crmLeads)
        .innerJoin(crmFunis, eq(crmFunis.id, crmLeads.funilId))
        .innerJoin(crmEtapas, eq(crmEtapas.id, crmLeads.etapaId))
        .where(and(eq(crmLeads.contatoId, l.contatoId), sql`${crmLeads.id} <> ${id}`)),
    ]);
    const [candidatura] = l.candidaturaId ? await this.db.select().from(candidaturas).where(eq(candidaturas.id, l.candidaturaId)) : [];
    const pessoaId = l.pessoaId ?? contato.pessoaId;
    const [pessoa] = pessoaId ? await this.db.select({ id: pessoas.id, nome: pessoas.nome, tipo: pessoas.tipo, status: pessoas.status, cidade: pessoas.cidade }).from(pessoas).where(eq(pessoas.id, pessoaId)) : [];
    const [consultora] = l.consultoraId ? await this.db.select({ id: pessoas.id, nome: pessoas.nome, cidade: pessoas.cidade, uf: pessoas.uf, telefone: pessoas.telefone1 }).from(pessoas).where(eq(pessoas.id, l.consultoraId)) : [];
    return { ...l, contato, eventos, tarefas, conversas, outrosCards: outros, candidatura: candidatura ?? null, pessoa: pessoa ?? null, consultora: consultora ?? null };
  }

  @Patch('crm/leads/:id')
  @Permissao('crm', 'editar')
  async editarLead(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        titulo: z.string().trim().min(1).max(200).optional(),
        valor: z.number().int().min(0).optional(),
        responsavelId: uuid.nullable().optional(),
        etiquetas: etiquetas.optional(),
        camposExtras: campos.optional(),
        etapaId: uuid.optional(),
        motivoPerda: opcional(300),
      }),
      body,
    );
    const [atual] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, id));
    if (!atual) throw new NotFoundException('Card não encontrado.');
    if (d.etapaId && d.etapaId !== atual.etapaId) {
      const [e] = await this.db.select().from(crmEtapas).where(eq(crmEtapas.id, d.etapaId));
      if (atual.candidaturaId && e?.chave === 'aprovada') throw new BadRequestException('Para aprovar a candidata, use "Aprovar e criar revendedora" no card.');
      await this.crm.moverLead(id, d.etapaId, { usuarioId: u.id, motivo: d.motivoPerda });
    }
    const { etapaId: _e, motivoPerda: _m, ...resto } = d;
    const mudou = Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined));
    if (Object.keys(mudou).length) {
      await this.db.update(crmLeads).set({ ...mudou, atualizadoEm: new Date() }).where(eq(crmLeads.id, id));
      if (d.responsavelId !== undefined && d.responsavelId !== atual.responsavelId) {
        const [r] = d.responsavelId ? await this.db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, d.responsavelId)) : [];
        await this.crm.evento(id, 'campo', `Responsável: ${r?.nome ?? 'ninguém'}.`, u.id);
      }
      if (d.valor !== undefined && d.valor !== atual.valor) await this.crm.evento(id, 'campo', `Valor: R$ ${(d.valor / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`, u.id);
      for (const e of (d.etiquetas ?? []).filter((x) => !atual.etiquetas.includes(x))) {
        await this.crm.evento(id, 'campo', `Etiqueta "${e}" adicionada.`, u.id);
        this.crm.emitir({ tipo: 'etiqueta_adicionada', leadId: id, etiqueta: e });
      }
    }
    return { ok: true };
  }

  @Delete('crm/leads/:id')
  @Permissao('crm', 'excluir')
  async apagarLead(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [l] = await this.db.delete(crmLeads).where(eq(crmLeads.id, id)).returning();
    if (!l) throw new NotFoundException('Card não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'crm_lead', entidadeId: id, dados: { titulo: l.titulo } });
    return { ok: true };
  }

  @Post('crm/leads/:id/notas')
  @Permissao('crm', 'editar')
  async nota(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { texto } = validar(z.object({ texto: z.string().trim().min(1).max(4000) }), body);
    await this.crm.evento(id, 'nota', texto, u.id);
    await this.db.update(crmLeads).set({ atualizadoEm: new Date() }).where(eq(crmLeads.id, id));
    return { ok: true };
  }

  @Post('crm/leads/:id/tarefas')
  @Permissao('crm', 'editar')
  async criarTarefa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        titulo: z.string().trim().min(2).max(200),
        venceEm: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)),
        responsavelId: uuid.nullable().optional(),
        // Mensagem de WhatsApp da tarefa (opcional): template, resposta rápida ou texto escrito na hora.
        mensagem: z
          .object({
            tipo: z.enum(['texto', 'template', 'resposta']),
            texto: z.string().trim().max(4096).nullable().optional(),
            templateId: uuid.nullable().optional(),
            respostaId: uuid.nullable().optional(),
            canalId: uuid.nullable().optional(),
            envio: z.enum(['automatico', 'lembrete']).default('lembrete'),
          })
          .nullable()
          .optional(),
      }),
      body,
    );
    const m = d.mensagem;
    if (m) await this.tarefasMensagem.validar(m);
    const [t] = await this.db
      .insert(crmTarefas)
      .values({
        leadId: id, titulo: d.titulo, venceEm: new Date(d.venceEm), responsavelId: d.responsavelId ?? u.id, criadoPor: u.id,
        ...(m ? { mensagemTipo: m.tipo, mensagemTexto: m.tipo === 'texto' ? m.texto : null, templateId: m.tipo === 'template' ? m.templateId : null, respostaId: m.tipo === 'resposta' ? m.respostaId : null, canalId: m.canalId ?? null, envio: m.envio, mensagemStatus: 'pendente' } : {}),
      })
      .returning();
    await this.crm.evento(id, 'tarefa', `Tarefa: ${d.titulo}.${m ? (m.envio === 'automatico' ? ' Mensagem de WhatsApp agendada para o horário da tarefa.' : ' Com mensagem de WhatsApp pronta para enviar.') : ''}`, u.id);
    return t;
  }

  /** Manda agora a mensagem de WhatsApp da tarefa (e conclui a tarefa). */
  @Post('crm/tarefas/:id/enviar')
  @Permissao('crm', 'editar')
  async enviarMensagemTarefa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [t] = await this.db.select({ leadId: crmTarefas.leadId, canalId: crmTarefas.canalId }).from(crmTarefas).where(eq(crmTarefas.id, id));
    if (!t) throw new NotFoundException('Tarefa não encontrada.');
    if (t.canalId) {
      const canal = await this.canais.obter(t.canalId);
      if (!this.canais.podeAtender(canal, u.id, gestor(u))) throw new ForbiddenException('Você não atende por este número.');
    }
    return this.tarefasMensagem.enviar(id, u.id);
  }

  @Patch('crm/tarefas/:id')
  @Permissao('crm', 'editar')
  async tarefa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { feita } = validar(z.object({ feita: z.boolean() }), body);
    const [t] = await this.db.update(crmTarefas).set({ feitaEm: feita ? new Date() : null }).where(eq(crmTarefas.id, id)).returning();
    if (!t) throw new NotFoundException('Tarefa não encontrada.');
    if (feita) await this.crm.evento(t.leadId, 'tarefa', `Tarefa concluída: ${t.titulo}.`, u.id);
    return t;
  }

  @Get('crm/tarefas')
  @Permissao('crm', 'ver')
  async tarefas(@Usuario() u: UsuarioLogado, @Query('todas') todas?: string) {
    return (await this.automacao.tarefas(todas && gestor(u) ? null : u.id)).rows;
  }

  @Patch('crm/contatos/:id')
  @Permissao('crm', 'editar')
  async contato(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(1).max(150).optional(), email: z.string().trim().email().nullable().optional(), etiquetas: etiquetas.optional(), descadastrado: z.boolean().optional(), memoriaIa: z.string().trim().max(700).nullable().optional(), camposExtras: campos.optional() }), body);
    const [c] = await this.db.update(crmContatos).set(d).where(eq(crmContatos.id, id)).returning();
    if (!c) throw new NotFoundException('Contato não encontrado.');
    return c;
  }

  // ───────────── Conversas e fila ─────────────

  @Get('crm/contadores')
  @Permissao('crm', 'ver')
  async contadores(@Usuario() u: UsuarioLogado) {
    const canais = (await this.canais.canaisDoUsuario(u.id, gestor(u))).map((c) => c.id);
    const mencoes = (await this.buscarMencoes(u, true)).length;
    if (!canais.length) return { fila: 0, minhas: 0, naoLidas: 0, tarefasVencidas: 0, mencoes };
    const r = await this.db.execute<{ fila: number; minhas: number; nao_lidas: number; tarefas: number }>(sql`
      select
        (select count(*)::int from crm_conversas where status = 'fila' and canal_id = any(${arr(canais)})) as fila,
        (select count(*)::int from crm_conversas where status = 'atendimento' and atendente_id = ${u.id}) as minhas,
        (select coalesce(sum(nao_lidas),0)::int from crm_conversas where status = 'atendimento' and atendente_id = ${u.id}) as nao_lidas,
        (select count(*)::int from crm_tarefas where feita_em is null and vence_em < now() and responsavel_id = ${u.id}) as tarefas`);
    const x = r.rows[0];
    return { fila: x.fila, minhas: x.minhas, naoLidas: x.nao_lidas, tarefasVencidas: x.tarefas, mencoes };
  }

  @Get('crm/conversas')
  @Permissao('crm', 'ver')
  async conversas(
    @Usuario() u: UsuarioLogado,
    @Query('aba') aba = 'fila',
    @Query('canalId') canalId?: string,
    @Query('busca') busca?: string,
    @Query('naoLidas') naoLidas?: string,
    @Query('etiqueta') etiqueta?: string,
    @Query('atendenteId') atendenteId?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
  ) {
    const g = gestor(u);
    const meus = (await this.canais.canaisDoUsuario(u.id, g)).map((c) => c.id);
    if (!meus.length) return [];
    const f: SQL[] = [inArray(crmConversas.canalId, canalId && meus.includes(canalId) ? [canalId] : meus)];
    if (aba === 'fila') f.push(eq(crmConversas.status, 'fila'));
    else if (aba === 'minhas') f.push(eq(crmConversas.status, 'atendimento'), eq(crmConversas.atendenteId, u.id));
    else if (aba === 'atendimento') {
      // Todas em atendimento: só a gestão vê as dos outros.
      f.push(eq(crmConversas.status, 'atendimento'));
      if (!g) f.push(eq(crmConversas.atendenteId, u.id));
    } else if (aba === 'resolvidas') {
      f.push(eq(crmConversas.status, 'resolvida'));
      if (!g) f.push(sql`(${crmConversas.atendenteId} = ${u.id} or ${crmConversas.atendenteId} is null)`);
    }
    else if (aba === 'todas' && !g) {
      // Todas (para buscar e unificar): quem não é da gestão não vê as que estão com outra pessoa.
      f.push(sql`(${crmConversas.atendenteId} = ${u.id} or ${crmConversas.atendenteId} is null or ${crmConversas.status} <> 'atendimento')`);
    }
    if (naoLidas === '1') f.push(sql`${crmConversas.naoLidas} > 0`);
    // Etiqueta do contato ou de algum card dele.
    if (etiqueta?.trim()) f.push(sql`(${crmContatos.etiquetas} ? ${etiqueta.trim()} or exists (select 1 from crm_leads l where l.contato_id = ${crmContatos.id} and l.etiquetas ? ${etiqueta.trim()}))`);
    // Por responsável: só a gestão escolhe outra pessoa.
    if (atendenteId && g && /^[0-9a-f-]{36}$/i.test(atendenteId)) f.push(eq(crmConversas.atendenteId, atendenteId));
    // Período da última mensagem (dias inteiros, horário de Brasília).
    if (de && /^\d{4}-\d{2}-\d{2}$/.test(de)) f.push(sql`${crmConversas.ultimaMensagemEm} >= ${new Date(`${de}T00:00:00-03:00`)}`);
    if (ate && /^\d{4}-\d{2}-\d{2}$/.test(ate)) f.push(sql`${crmConversas.ultimaMensagemEm} <= ${new Date(`${ate}T23:59:59.999-03:00`)}`);
    if (busca?.trim()) {
      const dig = busca.replace(/\D/g, '');
      f.push(sql`(${crmContatos.nome} ilike ${'%' + busca.trim() + '%'}${dig.length >= 4 ? sql` or ${crmContatos.telefone} like ${'%' + dig + '%'}` : sql``})`);
    }
    return this.db
      .select({
        id: crmConversas.id,
        status: crmConversas.status,
        naoLidas: crmConversas.naoLidas,
        fixada: crmConversas.fixada,
        iaAtiva: crmConversas.iaAtiva,
        ultimaMensagem: crmConversas.ultimaMensagem,
        ultimaMensagemEm: crmConversas.ultimaMensagemEm,
        ultimaEntradaEm: crmConversas.ultimaEntradaEm,
        filaDesde: crmConversas.filaDesde,
        atendenteId: crmConversas.atendenteId,
        atendente: usuarios.nome,
        canalId: crmConversas.canalId,
        canal: crmCanais.nome,
        canalTipo: crmCanais.tipo,
        contatoId: crmContatos.id,
        contato: crmContatos.nome,
        telefone: crmContatos.telefone,
        lead: sql<{ id: string; titulo: string; etapa: string; funil: string } | null>`(
          select json_build_object('id', l.id, 'titulo', l.titulo, 'etapa', e.nome, 'funil', f.nome)
          from crm_leads l join crm_etapas e on e.id = l.etapa_id join crm_funis f on f.id = l.funil_id
          where l.contato_id = ${crmContatos.id} order by (l.status = 'aberto') desc, l.atualizado_em desc limit 1)`,
      })
      .from(crmConversas)
      .innerJoin(crmContatos, eq(crmContatos.id, crmConversas.contatoId))
      .innerJoin(crmCanais, eq(crmCanais.id, crmConversas.canalId))
      .leftJoin(usuarios, eq(usuarios.id, crmConversas.atendenteId))
      .where(and(...f))
      // Fila: quem espera há mais tempo primeiro. Demais: mais recentes primeiro.
      .orderBy(desc(crmConversas.fixada), aba === 'fila' ? asc(crmConversas.filaDesde) : sql`${crmConversas.ultimaMensagemEm} desc nulls last`)
      .limit(300);
  }

  private async conversaVisivel(u: UsuarioLogado, id: string) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, id));
    if (!cv) throw new NotFoundException('Conversa não encontrada.');
    const canal = await this.canais.obter(cv.canalId);
    if (!this.canais.podeAtender(canal, u.id, gestor(u))) throw new ForbiddenException('Você não atende por este número.');
    return { cv, canal };
  }

  @Get('crm/conversas/:id/mensagens')
  @Permissao('crm', 'ver')
  async mensagens(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Query('antes') antes?: string) {
    const { cv, canal } = await this.conversaVisivel(u, id);
    const ms = await this.db
      .select({
        id: crmMensagens.id,
        direcao: crmMensagens.direcao,
        tipo: crmMensagens.tipo,
        texto: crmMensagens.texto,
        midia: crmMensagens.midia,
        midiaNome: crmMensagens.midiaNome,
        templateNome: crmMensagens.templateNome,
        status: crmMensagens.status,
        erro: crmMensagens.erro,
        autor: usuarios.nome,
        automatica: sql<boolean>`(${crmMensagens.gatilhoId} is not null or ${crmMensagens.disparoId} is not null)`,
        ia: crmMensagens.ia,
        transcricao: crmMensagens.transcricao,
        transcricaoStatus: crmMensagens.transcricaoStatus,
        transcricaoErro: crmMensagens.transcricaoErro,
        criadoEm: crmMensagens.criadoEm,
        reacoes: crmMensagens.reacoes,
        apagada: sql<boolean>`${crmMensagens.apagadaEm} is not null`,
        noWhatsApp: sql<boolean>`${crmMensagens.idExterno} is not null`,
        // A mensagem citada (resposta), resumida para aparecer em cima do balão.
        citada: sql<{ id: string; direcao: string; texto: string | null; tipo: string } | null>`(
          select json_build_object('id', c.id, 'direcao', c.direcao, 'tipo', c.tipo, 'texto', case when c.apagada_em is not null then null else left(c.texto, 160) end)
          from crm_mensagens c where c.id = ${crmMensagens.citadaId})`,
      })
      .from(crmMensagens)
      .leftJoin(usuarios, eq(usuarios.id, crmMensagens.usuarioId))
      .where(and(eq(crmMensagens.conversaId, id), antes ? sql`${crmMensagens.criadoEm} < ${new Date(antes)}` : undefined))
      .orderBy(desc(crmMensagens.criadoEm))
      .limit(100);
    // Quem está atendendo leu.
    if (cv.naoLidas && cv.atendenteId === u.id) await this.db.update(crmConversas).set({ naoLidas: 0 }).where(eq(crmConversas.id, id));
    const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, cv.contatoId));
    return {
      conversa: { ...cv, canal: canal.nome, canalTipo: canal.tipo, dentroDaJanela: canal.tipo === 'oficial' ? this.canais.dentroDaJanela(cv) : true },
      contato,
      // Apagada para todos: o texto e o arquivo não aparecem mais.
      mensagens: ms.reverse().map((m) => (m.apagada ? { ...m, texto: null, midia: null, midiaNome: null, transcricao: null } : m)),
      // O que este tipo de número consegue fazer com uma mensagem.
      recursos: { reagir: true, apagar: canal.tipo !== 'oficial', ia: this.ia.texto, transcrever: this.ia.imagem },
      // A IA está atendendo esta conversa agora?
      iaAtendendo: this.ia.texto && (cv.iaAtiva === true || (cv.iaAtiva === null && cv.status === 'fila' && (await this.agente.config().then((a) => a.ativo && (!a.canais.length || a.canais.includes(cv.canalId)))))),
    };
  }

  @Post('crm/conversas/:id/pegar')
  @Permissao('crm', 'editar')
  pegar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.canais.pegar(id, u.id, gestor(u));
  }

  /**
   * Para quem esta conversa pode ir: todos os usuários ativos, com o motivo de quem não pode receber
   * (sem acesso ao CRM, ou não atende pelo número desta conversa).
   */
  @Get('crm/conversas/:id/transferir-para')
  @Permissao('crm', 'editar')
  async transferirPara(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const { canal } = await this.conversaVisivel(u, id);
    const us = await this.db.execute<{ id: string; nome: string; grupo: string; permissoes: Record<string, string[]> }>(sql`select u.id, u.nome, g.nome as grupo, g.permissoes from usuarios u join grupos g on g.id = u.grupo_id where u.ativo order by u.nome`);
    return us.rows.map((x) => {
      const crm = !!(x.permissoes['*'] || x.permissoes.crm?.includes('editar'));
      const numero = !canal.atendentes.length || canal.atendentes.includes(x.id) || canal.usuarioId === x.id;
      return { id: x.id, nome: x.nome, grupo: x.grupo, pode: crm && numero, motivo: !crm ? 'Sem acesso ao CRM' : !numero ? `Não atende pelo número ${canal.nome}` : null };
    });
  }

  @Post('crm/conversas/:id/transferir')
  @Permissao('crm', 'editar')
  async transferir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { usuarioId } = validar(z.object({ usuarioId: uuid.nullable() }), body);
    if (usuarioId) {
      const { canal } = await this.conversaVisivel(u, id);
      const [dest] = await this.db.select({ id: usuarios.id, ativo: usuarios.ativo }).from(usuarios).where(eq(usuarios.id, usuarioId));
      if (!dest?.ativo) throw new BadRequestException('Atendente não encontrado.');
      const [g] = (await this.db.execute<{ permissoes: Record<string, string[]> }>(sql`select g.permissoes from usuarios u join grupos g on g.id = u.grupo_id where u.id = ${usuarioId}`)).rows;
      if (!(g?.permissoes['*'] || g?.permissoes.crm?.includes('editar'))) throw new BadRequestException('Esta pessoa não tem acesso ao CRM. Libere em Configurações › Grupos e permissões (CRM › editar).');
      if (canal.atendentes.length && !canal.atendentes.includes(usuarioId) && canal.usuarioId !== usuarioId) throw new BadRequestException('Esta pessoa não atende por este número.');
    }
    return this.canais.transferir(id, usuarioId, u.id, gestor(u));
  }

  @Post('crm/conversas/:id/resolver')
  @Permissao('crm', 'editar')
  resolver(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.canais.resolver(id, u.id, gestor(u));
  }

  @Post('crm/conversas/:id/mensagens')
  @Permissao('crm', 'editar')
  async enviar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ tipo: z.enum(['texto', 'template']).default('texto'), texto: z.string().max(4096).nullable().optional(), templateId: uuid.nullable().optional(), leadId: uuid.nullable().optional(), citarId: uuid.nullable().optional() }), body);
    const { cv } = await this.conversaVisivel(u, id);
    if (cv.status === 'atendimento' && cv.atendenteId && cv.atendenteId !== u.id && !gestor(u)) throw new ForbiddenException('Esta conversa está com outro atendente.');
    return this.canais.enviar({ conversaId: id, tipo: d.tipo, texto: d.texto, templateId: d.templateId, citarId: d.citarId, usuarioId: u.id, leadId: d.leadId ?? (await this.leadPrincipal(cv.contatoId)) });
  }

  @Post('crm/conversas/:id/midia')
  @Permissao('crm', 'editar')
  async enviarMidia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(1).max(150), mime: z.string().min(3).max(120), base64: z.string().min(10), texto: z.string().max(1024).nullable().optional(), citarId: uuid.nullable().optional() }), body);
    const { cv } = await this.conversaVisivel(u, id);
    if (cv.status === 'atendimento' && cv.atendenteId && cv.atendenteId !== u.id && !gestor(u)) throw new ForbiddenException('Esta conversa está com outro atendente.');
    const conteudo = Buffer.from(d.base64.replace(/^data:[^,]+,/, ''), 'base64');
    if (conteudo.length > 16_000_000) throw new BadRequestException('Arquivo maior que 16 MB.');
    const tipo = d.mime.startsWith('image/') ? 'imagem' : d.mime.startsWith('audio/') ? 'audio' : d.mime.startsWith('video/') ? 'video' : 'documento';
    return this.canais.enviar({ conversaId: id, tipo, texto: d.texto, citarId: d.citarId, midia: { conteudo, mime: d.mime, nome: d.nome }, usuarioId: u.id, leadId: await this.leadPrincipal(cv.contatoId) });
  }

  /** Só quem está atendendo (ou a gestão) mexe nas mensagens da conversa. */
  private async conversaMinha(u: UsuarioLogado, id: string) {
    const r = await this.conversaVisivel(u, id);
    if (r.cv.status === 'atendimento' && r.cv.atendenteId && r.cv.atendenteId !== u.id && !gestor(u)) throw new ForbiddenException('Esta conversa está com outro atendente.');
    return r;
  }

  /** Transcreve um áudio da conversa (ou tenta de novo, se falhou). */
  @Post('crm/conversas/:id/mensagens/:mensagemId/transcrever')
  @Permissao('crm', 'ver')
  async transcrever(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Param('mensagemId', ParseUUIDPipe) mensagemId: string) {
    await this.conversaVisivel(u, id);
    const [m] = await this.db.select({ id: crmMensagens.id }).from(crmMensagens).where(and(eq(crmMensagens.id, mensagemId), eq(crmMensagens.conversaId, id)));
    if (!m) throw new NotFoundException('Mensagem não encontrada nesta conversa.');
    return this.transcricao.manual(mensagemId, u.id);
  }

  @Post('crm/conversas/:id/mensagens/:mensagemId/reagir')
  @Permissao('crm', 'editar')
  async reagir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Param('mensagemId', ParseUUIDPipe) mensagemId: string, @Body() body: unknown) {
    // Um emoji só (pode ter vários "pedaços", como tom de pele); vazio tira a reação.
    const { emoji } = validar(z.object({ emoji: z.string().max(16).refine((e) => e === '' || /\p{Extended_Pictographic}/u.test(e), 'Escolha um emoji') }), body);
    await this.conversaMinha(u, id);
    return this.canais.reagir(id, mensagemId, emoji);
  }

  @Post('crm/conversas/:id/mensagens/:mensagemId/apagar')
  @Permissao('crm', 'editar')
  async apagarMensagem(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Param('mensagemId', ParseUUIDPipe) mensagemId: string) {
    await this.conversaMinha(u, id);
    const r = await this.canais.apagarMensagem(id, mensagemId);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'apagar_mensagem', entidade: 'crm_mensagem', entidadeId: mensagemId });
    return r;
  }

  // ───────────── Agente de IA ─────────────

  @Get('crm/ia-agente')
  @Permissao('crm', 'ver')
  async agenteConfig() {
    return { ...(await this.agente.config()), ligada: this.ia.texto, especialistas: await this.agente.especialistas(true), voz: { disponivel: this.ia.vozDisponivel, elevenlabs: this.ia.temElevenlabs, openai: this.ia.imagem, opcoes: { elevenlabs: VOZES_ELEVENLABS, openai: VOZES_OPENAI } } };
  }

  @Put('crm/ia-agente')
  @Permissao('configuracoes', 'editar')
  async salvarAgente(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const atual = await this.agente.config();
    const d = validar(
      z.object({
        ativo: z.boolean(),
        canais: z.array(uuid).max(50).default([]),
        instrucoes: z.string().max(6000).default(''),
        conhecimento: z.string().max(20000).default(''),
        maxRespostas: z.number().int().min(1).max(50).default(10),
        nome: z.string().trim().max(40).default(''),
        maxTransferencias: z.number().int().min(0).max(5).default(2),
        respostaAudio: z.enum(['nunca', 'espelhar', 'sempre']).default(atual.respostaAudio),
        vozProvedor: z.enum(['automatica', 'elevenlabs', 'openai']).default(atual.vozProvedor),
        vozElevenlabs: z.string().trim().regex(/^[A-Za-z0-9]{10,40}$/, 'Id de voz da ElevenLabs inválido').default(atual.vozElevenlabs),
        vozOpenai: z.enum(VOZES_OPENAI.map((v) => v.id) as [string, ...string[]]).default(atual.vozOpenai),
        audioComTexto: z.boolean().default(atual.audioComTexto),
        ferramentas: z
          .object({ segundaVia: z.boolean(), promessa: z.boolean(), promessaMaxDias: z.number().int().min(1).max(60), estoque: z.boolean(), candidatura: z.boolean() })
          .default(atual.ferramentas),
        memoriaClientes: z.boolean().default(atual.memoriaClientes),
      }),
      body,
    );
    if (d.respostaAudio !== 'nunca' && !this.ia.vozDisponivel) throw new BadRequestException('Para responder em áudio, cole a chave da ElevenLabs ou da OpenAI em Configurações › Integrações › Inteligência artificial.');
    if (d.ativo && !this.ia.texto) throw new BadRequestException('Cole a chave do Claude em Configurações › Integrações › Inteligência artificial antes de ligar o agente.');
    await this.agente.salvarConfig(d);
    await this.auditoria.registrar({ usuarioId: u.id, acao: d.ativo ? 'ligar' : 'configurar', entidade: 'ia_agente', dados: { ativo: d.ativo, canais: d.canais.length, maxRespostas: d.maxRespostas } });
    return { ...d, ligada: this.ia.texto };
  }

  /** Exemplo da voz do agente (para escolher antes de salvar). */
  @Post('crm/ia-agente/ouvir')
  @Permissao('crm', 'ver')
  async ouvirVoz(@Usuario() u: UsuarioLogado, @Body() body: unknown, @Res() res: Response) {
    const d = validar(z.object({ texto: z.string().trim().min(1).max(600), provedor: z.enum(['elevenlabs', 'openai']), voz: z.string().trim().max(40) }), body);
    try {
      const audio = await this.ia.falar({ texto: d.texto, provedor: d.provedor, voz: d.voz, usuarioId: u.id });
      res.setHeader('content-type', 'audio/mpeg');
      res.send(audio);
    } catch (e) {
      if (e instanceof ErroIa) throw new BadRequestException(e.message);
      throw e;
    }
  }

  // ───── Especialistas do agente (multiagentes) ─────

  private especialistaSchema = z.object({
    funcao: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,29}$/, 'Use só letras minúsculas, sem espaço (ex.: vendas)'),
    nome: z.string().trim().min(2, 'Dê um nome ao especialista').max(60),
    quando: z.string().trim().min(10, 'Explique quando a recepção deve passar para ele').max(600),
    instrucoes: z.string().max(6000).default(''),
    conhecimento: z.string().max(20000).default(''),
    ativo: z.boolean().default(true),
    ordem: z.number().int().min(0).max(100).default(0),
  });

  @Post('crm/ia-agentes')
  @Permissao('configuracoes', 'editar')
  async criarEspecialista(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(this.especialistaSchema, body);
    const [ja] = await this.db.select({ id: iaAgentes.id }).from(iaAgentes).where(eq(iaAgentes.funcao, d.funcao));
    if (ja) throw new BadRequestException(`Já existe um especialista com a chave "${d.funcao}".`);
    const [a] = await this.db.insert(iaAgentes).values(d).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'ia_agente', entidadeId: a.id, dados: { funcao: a.funcao } });
    return a;
  }

  /** Cria os especialistas sugeridos (vendas, quero revender, revendedora) que ainda não existem. */
  @Post('crm/ia-agentes/sugeridos')
  @Permissao('configuracoes', 'editar')
  async sugeridos(@Usuario() u: UsuarioLogado) {
    const existentes = new Set((await this.db.select({ f: iaAgentes.funcao }).from(iaAgentes)).map((x) => x.f));
    const novos = ESPECIALISTAS_SUGERIDOS.filter((e) => !existentes.has(e.funcao));
    if (novos.length) await this.db.insert(iaAgentes).values(novos);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'ia_agente', dados: { sugeridos: novos.map((n) => n.funcao) } });
    return this.agente.especialistas(true);
  }

  @Patch('crm/ia-agentes/:id')
  @Permissao('configuracoes', 'editar')
  async editarEspecialista(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(this.especialistaSchema.partial(), body);
    if (d.funcao) {
      const [ja] = await this.db.select({ id: iaAgentes.id }).from(iaAgentes).where(and(eq(iaAgentes.funcao, d.funcao), sql`${iaAgentes.id} <> ${id}`));
      if (ja) throw new BadRequestException(`Já existe um especialista com a chave "${d.funcao}".`);
    }
    const [a] = await this.db.update(iaAgentes).set({ ...d, atualizadoEm: new Date() }).where(eq(iaAgentes.id, id)).returning();
    if (!a) throw new NotFoundException('Especialista não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'ia_agente', entidadeId: id, dados: { funcao: a.funcao, ativo: a.ativo } });
    return a;
  }

  /** Cópia do especialista (nasce desligada, com chave e nome novos), para criar outro parecido sem começar do zero. */
  @Post('crm/ia-agentes/:id/duplicar')
  @Permissao('configuracoes', 'editar')
  async duplicarEspecialista(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [o] = await this.db.select().from(iaAgentes).where(eq(iaAgentes.id, id));
    if (!o) throw new NotFoundException('Especialista não encontrado.');
    const a = await duplicarEspecialista(this.db, o);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'duplicar', entidade: 'ia_agente', entidadeId: a.id, dados: { de: o.funcao, para: a.funcao } });
    return a;
  }

  @Delete('crm/ia-agentes/:id')
  @Permissao('configuracoes', 'editar')
  async excluirEspecialista(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [a] = await this.db.delete(iaAgentes).where(eq(iaAgentes.id, id)).returning();
    if (!a) throw new NotFoundException('Especialista não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'ia_agente', entidadeId: id, dados: { funcao: a.funcao } });
    return { ok: true };
  }

  /** Liga ou pausa a IA nesta conversa ("Acionar IA"). */
  @Post('crm/conversas/:id/ia')
  @Permissao('crm', 'editar')
  async acionarIa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ativa } = validar(z.object({ ativa: z.boolean() }), body);
    await this.conversaMinha(u, id);
    if (ativa && !this.ia.texto) throw new BadRequestException('A inteligência artificial não está ligada. Cole a chave do Claude em Configurações › Integrações.');
    return this.agente.acionar(id, ativa);
  }

  /** Sugestão de resposta para o atendente revisar e enviar. */
  @Post('crm/conversas/:id/sugerir')
  @Permissao('crm', 'editar')
  async sugerir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    await this.conversaVisivel(u, id);
    try {
      return await this.agente.sugerir(id, u.id);
    } catch (e) {
      if (e instanceof ErroIa) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Etiquetas em uso (contatos e cards), para o filtro da lista de conversas. */
  @Get('crm/etiquetas')
  @Permissao('crm', 'ver')
  async etiquetasEmUso() {
    const r = await this.db.execute<{ etiqueta: string }>(sql`
      select distinct e as etiqueta from (
        select jsonb_array_elements_text(etiquetas) as e from crm_contatos
        union all select jsonb_array_elements_text(etiquetas) as e from crm_leads
      ) t where e <> '' order by 1 limit 300`);
    return r.rows.map((x) => x.etiqueta);
  }

  /** Várias conversas de uma vez: resolver, marcar lida / não lida, devolver para a fila ou transferir. */
  @Post('crm/conversas/lote')
  @Permissao('crm', 'editar')
  async lote(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ ids: z.array(uuid).min(1).max(200), acao: z.enum(['resolver', 'lida', 'nao_lida', 'fila', 'transferir']), usuarioId: uuid.nullable().optional() }), body);
    if (d.acao === 'transferir' && !d.usuarioId) throw new BadRequestException('Escolha para quem transferir.');
    let feitas = 0;
    const falhas: string[] = [];
    for (const id of [...new Set(d.ids)]) {
      try {
        // As mesmas regras de uma conversa só: cada uma confere se a pessoa atende pelo número e se pode mexer.
        if (d.acao === 'resolver') await this.canais.resolver(id, u.id, gestor(u));
        else if (d.acao === 'fila') await this.transferir(u, id, { usuarioId: null });
        else if (d.acao === 'transferir') await this.transferir(u, id, { usuarioId: d.usuarioId });
        else {
          await this.conversaVisivel(u, id);
          await this.db.update(crmConversas).set({ naoLidas: d.acao === 'lida' ? 0 : sql`greatest(${crmConversas.naoLidas}, 1)` }).where(eq(crmConversas.id, id));
        }
        feitas++;
      } catch (e) {
        falhas.push((e as Error).message);
      }
    }
    // Um motivo de cada tipo basta para a pessoa entender o que ficou de fora.
    return { feitas, falhas: falhas.length, motivos: [...new Set(falhas)].slice(0, 3) };
  }

  /** Apaga a conversa e as mensagens dela (o contato e os cards continuam). Só a gestão. */
  @Delete('crm/conversas/:id')
  @Permissao('crm', 'excluir')
  async excluirConversa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const { cv } = await this.conversaVisivel(u, id);
    const [{ n }] = (await this.db.execute<{ n: number }>(sql`select count(*)::int as n from crm_mensagens where conversa_id = ${id}`)).rows;
    await this.db.delete(crmConversas).where(eq(crmConversas.id, id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'crm_conversa', entidadeId: id, dados: { contatoId: cv.contatoId, canalId: cv.canalId, mensagens: n } });
    return { ok: true, mensagens: n };
  }

  /**
   * Unifica dois contatos que são a mesma pessoa (dois números, ou o mesmo com e sem o 9):
   * as conversas, mensagens e cards da outra conversa passam para o contato desta, e o contato repetido some.
   */
  @Post('crm/conversas/:id/unificar')
  @Permissao('crm', 'excluir')
  async unificar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comConversaId } = validar(z.object({ comConversaId: uuid }), body);
    const { cv: fica } = await this.conversaVisivel(u, id);
    const { cv: sai } = await this.conversaVisivel(u, comConversaId);
    if (fica.contatoId === sai.contatoId) throw new BadRequestException('As duas conversas já são do mesmo contato.');
    const [principal] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, fica.contatoId));
    const [repetido] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, sai.contatoId));
    const r = await this.db.transaction(async (tx) => {
      let juntadas = 0;
      // Conversas do contato repetido: no mesmo número, as mensagens entram na conversa que fica; em outro número, a conversa só troca de dono.
      for (const c of await tx.select().from(crmConversas).where(eq(crmConversas.contatoId, repetido.id))) {
        const [destino] = await tx.select().from(crmConversas).where(and(eq(crmConversas.contatoId, principal.id), eq(crmConversas.canalId, c.canalId)));
        if (!destino) {
          await tx.update(crmConversas).set({ contatoId: principal.id }).where(eq(crmConversas.id, c.id));
          continue;
        }
        await tx.update(crmMensagens).set({ conversaId: destino.id }).where(eq(crmMensagens.conversaId, c.id));
        const maisNova = (c.ultimaMensagemEm?.getTime() ?? 0) > (destino.ultimaMensagemEm?.getTime() ?? 0);
        await tx
          .update(crmConversas)
          .set({
            naoLidas: destino.naoLidas + c.naoLidas,
            ...(maisNova ? { ultimaMensagem: c.ultimaMensagem, ultimaMensagemEm: c.ultimaMensagemEm } : {}),
            ...((c.ultimaEntradaEm?.getTime() ?? 0) > (destino.ultimaEntradaEm?.getTime() ?? 0) ? { ultimaEntradaEm: c.ultimaEntradaEm } : {}),
          })
          .where(eq(crmConversas.id, destino.id));
        await tx.delete(crmConversas).where(eq(crmConversas.id, c.id));
        juntadas++;
      }
      const cards = await tx.update(crmLeads).set({ contatoId: principal.id }).where(eq(crmLeads.contatoId, repetido.id)).returning({ id: crmLeads.id });
      // Disparos: se os dois estavam no mesmo disparo, fica o registro do principal.
      await tx.execute(sql`delete from crm_disparo_destinos d where d.contato_id = ${repetido.id} and exists (select 1 from crm_disparo_destinos p where p.disparo_id = d.disparo_id and p.contato_id = ${principal.id})`);
      await tx.execute(sql`update crm_disparo_destinos set contato_id = ${principal.id} where contato_id = ${repetido.id}`);
      // O que o principal não tinha, herda do repetido.
      await tx
        .update(crmContatos)
        .set({
          nome: principal.nome === principal.telefone && repetido.nome !== repetido.telefone ? repetido.nome : principal.nome,
          email: principal.email ?? repetido.email,
          pessoaId: principal.pessoaId ?? repetido.pessoaId,
          etiquetas: [...new Set([...principal.etiquetas, ...repetido.etiquetas])].slice(0, 30),
          camposExtras: { ...repetido.camposExtras, ...principal.camposExtras, ...(repetido.telefone !== principal.telefone && !principal.camposExtras['Outro telefone'] ? { 'Outro telefone': repetido.telefone } : {}) },
          descadastrado: principal.descadastrado || repetido.descadastrado,
        })
        .where(eq(crmContatos.id, principal.id));
      await tx.delete(crmContatos).where(eq(crmContatos.id, repetido.id));
      return { juntadas, cards: cards.length };
    });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'unificar', entidade: 'crm_contato', entidadeId: principal.id, dados: { repetido: { id: repetido.id, nome: repetido.nome, telefone: repetido.telefone }, ...r } });
    return { ok: true, ...r };
  }

  /** Conversa avulsa: escrever para um telefone que ainda não tem conversa (nem precisa ter card). */
  @Post('crm/conversas/nova')
  @Permissao('crm', 'editar')
  novaConversa(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ canalId: uuid, telefone: z.string().trim().min(8, 'Informe o telefone com DDD').max(25), nome: z.string().trim().max(120).nullable().optional() }), body);
    return this.canais.novaConversa({ ...d, usuarioId: u.id, gestor: gestor(u) });
  }

  @Post('crm/conversas/:id/fixar')
  @Permissao('crm', 'editar')
  async fixar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { fixada } = validar(z.object({ fixada: z.boolean() }), body);
    await this.conversaVisivel(u, id);
    await this.db.update(crmConversas).set({ fixada }).where(eq(crmConversas.id, id));
    return { ok: true, fixada };
  }

  @Post('crm/conversas/:id/nao-lida')
  @Permissao('crm', 'editar')
  async naoLida(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    await this.conversaVisivel(u, id);
    await this.db.update(crmConversas).set({ naoLidas: sql`greatest(${crmConversas.naoLidas}, 1)` }).where(eq(crmConversas.id, id));
    return { ok: true };
  }

  private async leadPrincipal(contatoId: string) {
    const [l] = await this.db.select({ id: crmLeads.id }).from(crmLeads).where(eq(crmLeads.contatoId, contatoId)).orderBy(desc(sql`${crmLeads.status} = 'aberto'`), desc(crmLeads.atualizadoEm)).limit(1);
    return l?.id ?? null;
  }

  /** Abre (ou acha) a conversa com o contato num número, para escrever a partir do card. */
  @Post('crm/contatos/:id/conversa')
  @Permissao('crm', 'editar')
  async abrirConversa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) contatoId: string, @Body() body: unknown) {
    const { canalId } = validar(z.object({ canalId: uuid }), body);
    const canal = await this.canais.obter(canalId);
    if (!this.canais.podeAtender(canal, u.id, gestor(u))) throw new ForbiddenException('Você não atende por este número.');
    return this.canais.garantirConversa(contatoId, canalId, 'resolvida');
  }

  @Get('crm/midia/:nome')
  @Permissao('crm', 'ver')
  midia(@Param('nome') nome: string, @Res() res: Response) {
    const caminho = this.arquivos.caminhoMidia(nome);
    if (!caminho || !existsSync(caminho)) throw new NotFoundException('Arquivo não encontrado.');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(caminho);
  }

  /** Conversa interna: a equipe escreve no chat do lead e o cliente não vê. "@Nome" avisa o colega. */
  @Post('crm/conversas/:id/interna')
  @Permissao('crm', 'editar')
  async interna(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { texto } = validar(z.object({ texto: z.string().trim().min(1).max(4000) }), body);
    const { cv } = await this.conversaVisivel(u, id);
    const [m] = await this.db.insert(crmMensagens).values({ conversaId: id, direcao: 'interna', tipo: 'texto', texto, status: 'interna', usuarioId: u.id }).returning();
    const lead = await this.leadPrincipal(cv.contatoId);
    if (lead) await this.crm.evento(lead, 'nota', `Conversa interna: ${texto}`, u.id);
    return m;
  }

  /** Menções a mim em conversas internas desde a última vez que olhei. */
  @Get('crm/mencoes')
  @Permissao('crm', 'ver')
  async mencoes(@Usuario() u: UsuarioLogado, @Query('marcar') marcar?: string) {
    const lista = await this.buscarMencoes(u);
    if (marcar) {
      const chave = `crm_mencoes_visto:${u.id}`;
      const valor = { em: new Date().toISOString() };
      await this.db.insert(configuracoes).values({ chave, valor }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor, atualizadoEm: new Date() } });
    }
    return lista;
  }

  private async buscarMencoes(u: UsuarioLogado, so_contar = false) {
    const primeiro = (u.nome ?? '').trim().split(/\s+/)[0];
    if (!primeiro || primeiro.length < 2) return [];
    const [visto] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, `crm_mencoes_visto:${u.id}`));
    const desde = (visto?.valor as { em?: string } | undefined)?.em ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    const r = await this.db.execute<{ id: string; texto: string; conversa_id: string; contato: string; autor: string; criado_em: string }>(sql`
      select m.id, m.texto, m.conversa_id, c.nome as contato, us.nome as autor, m.criado_em
      from crm_mensagens m join crm_conversas cv on cv.id = m.conversa_id join crm_contatos c on c.id = cv.contato_id left join usuarios us on us.id = m.usuario_id
      where m.direcao = 'interna' and m.usuario_id is distinct from ${u.id} and m.criado_em > ${desde}::timestamptz
        and m.texto ~* ${'(^|\s)@' + primeiro.replace(/[^\p{L}\p{N}]/gu, '') + '(\M|$)'}
      order by m.criado_em desc limit ${so_contar ? 100 : 50}`);
    return r.rows;
  }

  // ───────────── Campos personalizados ─────────────

  @Get('crm/campos')
  @Permissao('crm', 'ver')
  campos() {
    return this.db.select().from(crmCampos).orderBy(asc(crmCampos.entidade), asc(crmCampos.ordem), asc(crmCampos.nome));
  }

  @Post('crm/campos')
  @Permissao('crm', 'excluir')
  async criarCampo(@Body() body: unknown) {
    const d = validar(
      z.object({
        entidade: z.enum(['contato', 'lead']),
        nome: z.string().trim().min(1).max(60),
        tipo: z.enum(TIPOS_CAMPO).default('texto'),
        opcoes: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
        funilId: uuid.nullable().optional(),
        noQuadro: z.boolean().default(false),
      }),
      body,
    );
    if ((d.tipo === 'lista' || d.tipo === 'multipla') && !d.opcoes.length) throw new BadRequestException('Informe as opções da lista.');
    const [repetido] = await this.db.select({ id: crmCampos.id }).from(crmCampos).where(and(eq(crmCampos.entidade, d.entidade), sql`lower(${crmCampos.nome}) = lower(${d.nome})`));
    if (repetido) throw new BadRequestException('Já existe um campo com esse nome.');
    const [{ ordem }] = await this.db.select({ ordem: sql<number>`coalesce(max(${crmCampos.ordem}),0)+1` }).from(crmCampos).where(eq(crmCampos.entidade, d.entidade));
    const [c] = await this.db.insert(crmCampos).values({ ...d, funilId: d.entidade === 'lead' ? (d.funilId ?? null) : null, ordem }).returning();
    return c;
  }

  @Patch('crm/campos/:id')
  @Permissao('crm', 'excluir')
  async editarCampo(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        nome: z.string().trim().min(1).max(60).optional(),
        opcoes: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        ordem: z.number().int().optional(),
        noQuadro: z.boolean().optional(),
        funilId: uuid.nullable().optional(),
      }),
      body,
    );
    const [atual] = await this.db.select().from(crmCampos).where(eq(crmCampos.id, id));
    if (!atual) throw new NotFoundException('Campo não encontrado.');
    if (atual.entidade === 'contato') delete d.funilId;
    if (d.opcoes && (atual.tipo === 'lista' || atual.tipo === 'multipla') && !d.opcoes.length) throw new BadRequestException('A lista precisa de pelo menos uma opção.');
    if (d.nome && d.nome.toLowerCase() !== atual.nome.toLowerCase()) {
      const [repetido] = await this.db.select({ id: crmCampos.id }).from(crmCampos).where(and(eq(crmCampos.entidade, atual.entidade), sql`lower(${crmCampos.nome}) = lower(${d.nome})`));
      if (repetido) throw new BadRequestException('Já existe um campo com esse nome.');
    }
    const [c] = await this.db.update(crmCampos).set(d).where(eq(crmCampos.id, id)).returning();
    // Renomeou: leva os valores já preenchidos para o nome novo.
    if (d.nome && d.nome !== atual.nome) {
      const tabela = atual.entidade === 'contato' ? 'crm_contatos' : 'crm_leads';
      await this.db.execute(sql.raw(`update ${tabela} set campos_extras = (campos_extras - '${atual.nome.replace(/'/g, "''")}') || jsonb_build_object('${d.nome.replace(/'/g, "''")}', campos_extras->'${atual.nome.replace(/'/g, "''")}') where campos_extras ? '${atual.nome.replace(/'/g, "''")}'`));
    }
    return c;
  }

  /** Nova ordem dos campos (lista de ids na ordem desejada). */
  @Post('crm/campos/ordem')
  @Permissao('crm', 'excluir')
  async ordenarCampos(@Body() body: unknown) {
    const { ids } = validar(z.object({ ids: z.array(uuid).min(1).max(300) }), body);
    await this.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(crmCampos).set({ ordem: i + 1 }).where(eq(crmCampos.id, id));
    });
    return { ok: true };
  }

  @Delete('crm/campos/:id')
  @Permissao('crm', 'excluir')
  async apagarCampo(@Param('id', ParseUUIDPipe) id: string) {
    await this.db.delete(crmCampos).where(eq(crmCampos.id, id));
    return { ok: true };
  }

  // ───────────── Softphone ─────────────

  /** O ramal do próprio atendente, para o softphone do navegador registrar no servidor de voz. */
  @Get('crm/ramal')
  @Permissao('crm', 'ver')
  async meuRamal(@Usuario() u: UsuarioLogado) {
    const [r] = await this.db.select().from(crmRamais).where(and(eq(crmRamais.usuarioId, u.id), eq(crmRamais.ativo, true)));
    if (!r) return null;
    return { servidor: r.servidor, usuarioSip: r.usuarioSip, senha: this.segredos.decifrar(r.senhaCifrada), nomeExibicao: r.nomeExibicao ?? u.nome, prefixo: r.prefixo ?? '' };
  }

  @Get('crm/ramais')
  @Permissao('configuracoes', 'editar')
  async ramais() {
    const r = await this.db.select({ r: crmRamais, nome: usuarios.nome }).from(crmRamais).innerJoin(usuarios, eq(usuarios.id, crmRamais.usuarioId)).orderBy(asc(usuarios.nome));
    return r.map(({ r, nome }) => ({ usuarioId: r.usuarioId, nome, servidor: r.servidor, usuarioSip: r.usuarioSip, nomeExibicao: r.nomeExibicao, prefixo: r.prefixo, ativo: r.ativo }));
  }

  @Post('crm/ramais')
  @Permissao('configuracoes', 'editar')
  async salvarRamal(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        usuarioId: uuid,
        servidor: z.string().trim().regex(/^wss?:\/\/.+/i, 'O servidor começa com wss://'),
        usuarioSip: z.string().trim().regex(/^sip:[^@\s]+@[^\s]+$/i, 'Formato: sip:ramal@dominio'),
        senha: z.string().max(200).optional(),
        nomeExibicao: opcional(80),
        prefixo: z.string().trim().max(5).regex(/^[0-9*#]*$/).nullable().optional(),
        ativo: z.boolean().default(true),
      }),
      body,
    );
    const [atual] = await this.db.select().from(crmRamais).where(eq(crmRamais.usuarioId, d.usuarioId));
    if (!atual && !d.senha) throw new BadRequestException('Informe a senha do ramal.');
    const valores = { servidor: d.servidor, usuarioSip: d.usuarioSip, nomeExibicao: d.nomeExibicao ?? null, prefixo: d.prefixo ?? null, ativo: d.ativo, senhaCifrada: d.senha ? this.segredos.cifrar(d.senha) : atual!.senhaCifrada, atualizadoEm: new Date() };
    await this.db.insert(crmRamais).values({ usuarioId: d.usuarioId, ...valores }).onConflictDoUpdate({ target: crmRamais.usuarioId, set: valores });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'crm_ramal', entidadeId: d.usuarioId, dados: { servidor: d.servidor, usuarioSip: d.usuarioSip } });
    return { ok: true };
  }

  /** Ligação feita pelo softphone: entra no histórico do card. */
  @Post('crm/leads/:id/ligacoes')
  @Permissao('crm', 'editar')
  async ligacao(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ numero: z.string().trim().max(30), duracaoSeg: z.number().int().min(0).max(86400), resultado: z.enum(['atendida', 'nao_atendida', 'ocupado', 'falhou', 'cancelada']), observacao: opcional(500) }), body);
    const dur = `${Math.floor(d.duracaoSeg / 60)}min${String(d.duracaoSeg % 60).padStart(2, '0')}s`;
    const rotulo = { atendida: `atendida, ${dur}`, nao_atendida: 'não atendida', ocupado: 'ocupado', falhou: 'falhou', cancelada: 'cancelada' }[d.resultado];
    await this.crm.evento(id, 'ligacao', `Ligação para ${d.numero}: ${rotulo}.${d.observacao ? ` ${d.observacao}` : ''}`, u.id, d);
    await this.db.update(crmLeads).set({ ultimaInteracaoEm: new Date(), atualizadoEm: new Date() }).where(eq(crmLeads.id, id));
    return { ok: true };
  }

  // ───────────── Números de WhatsApp ─────────────

  @Get('crm/canais')
  @Permissao('crm', 'ver')
  async listarCanais(@Usuario() u: UsuarioLogado) {
    const todos = await this.canais.listar();
    if (temPermissao(u.permissoes, 'configuracoes', 'editar')) return todos;
    // Atendente: só os números dele, sem credenciais nem webhook.
    const meus = new Set((await this.canais.canaisDoUsuario(u.id, gestor(u))).map((c) => c.id));
    return todos.filter((c) => meus.has(c.id)).map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo, numero: c.numero, ativo: c.ativo }));
  }

  @Post('crm/canais')
  @Permissao('configuracoes', 'editar')
  async criarCanal(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        nome: z.string().trim().min(2).max(80),
        tipo: z.enum(['oficial', 'qrcode', 'evolution']),
        config: z.record(z.string().max(40), z.string().max(2000)).default({}),
        usuarioId: uuid.nullable().optional(),
        atendentes: z.array(uuid).default([]),
        funilEntradaId: uuid.nullable().optional(),
      }),
      body,
    );
    const c = await this.canais.criar(d);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'crm_canal', entidadeId: c.id, dados: { nome: d.nome, tipo: d.tipo } });
    return c;
  }

  @Patch('crm/canais/:id')
  @Permissao('configuracoes', 'editar')
  async editarCanal(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        nome: z.string().trim().min(2).max(80).optional(),
        config: z.record(z.string().max(40), z.string().max(2000)).optional(),
        usuarioId: uuid.nullable().optional(),
        atendentes: z.array(uuid).optional(),
        funilEntradaId: uuid.nullable().optional(),
        ativo: z.boolean().optional(),
      }),
      body,
    );
    const c = await this.canais.atualizar(id, d);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'crm_canal', entidadeId: id, dados: { campos: Object.keys(d) } });
    return c;
  }

  /** O que a tela pode oferecer ao ligar um número. */
  @Get('crm/canais-opcoes')
  @Permissao('crm', 'ver')
  opcoesCanais() {
    return { qrcodeProprio: this.canais.qrcodeProprioDisponivel() };
  }

  @Get('crm/canais/:id/situacao')
  @Permissao('crm', 'ver')
  situacaoCanal(@Param('id', ParseUUIDPipe) id: string) {
    return this.canais.situacao(id);
  }

  @Post('crm/canais/:id/templates')
  @Permissao('crm', 'excluir')
  sincronizar(@Param('id', ParseUUIDPipe) id: string) {
    return this.canais.sincronizarTemplates(id);
  }

  @Post('crm/canais/:id/webhook')
  @Permissao('configuracoes', 'editar')
  async webhook(@Param('id', ParseUUIDPipe) id: string) {
    try {
      await this.canais.apontarWebhookZapi(await this.canais.obter(id));
    } catch (e) {
      throw new BadRequestException(`Não deu para reapontar: ${(e as Error).message}`);
    }
    return { ok: true };
  }

  @Delete('crm/canais/:id')
  @Permissao('configuracoes', 'editar')
  async excluirCanal(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.canais.obter(id);
    const r = await this.canais.excluir(id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'crm_canal', entidadeId: id, dados: { nome: c.nome, tipo: c.tipo, apagado: r.apagado } });
    return r;
  }

  @Post('crm/canais/:id/desconectar')
  @Permissao('configuracoes', 'editar')
  desconectar(@Param('id', ParseUUIDPipe) id: string) {
    return this.canais.desconectar(id);
  }

  /** Importações do histórico deste número (as últimas 10). */
  @Get('crm/canais/:id/historico')
  @Permissao('configuracoes', 'ver')
  historicoCanal(@Param('id', ParseUUIDPipe) id: string) {
    return this.historico.listar(id);
  }

  /** Importa o histórico de conversas do período (no servidor próprio, a primeira vez pede o QR de novo). */
  @Post('crm/canais/:id/historico')
  @Permissao('configuracoes', 'editar')
  async importarHistorico(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Usuario() u: UsuarioLogado) {
    const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
    const d = validar(z.object({ de: dia, ate: dia, midias: z.boolean().default(false) }), body);
    const r = await this.historico.iniciar(id, d, u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'importar_historico', entidade: 'crm_canais', entidadeId: id, dados: d });
    return r;
  }

  /** Confere na hora se o celular já conectou e roda a importação (o sistema também faz isso sozinho, de minuto em minuto). */
  @Post('crm/importacoes/conferir')
  @Permissao('configuracoes', 'editar')
  async conferirImportacoes() {
    await this.historico.acompanhar();
    return { ok: true };
  }

  @Post('crm/importacoes/:id/cancelar')
  @Permissao('configuracoes', 'editar')
  cancelarImportacao(@Param('id', ParseUUIDPipe) id: string) {
    return this.historico.cancelar(id);
  }

  /** Atendentes que podem receber conversas (para transferir e para o rodízio dos gatilhos). */
  @Get('crm/atendentes')
  @Permissao('crm', 'ver')
  async atendentes(@Query('todos') todos?: string) {
    const us = await this.db.execute<{ id: string; nome: string; grupo: string; permissoes: Record<string, string[]> }>(sql`select u.id, u.nome, g.nome as grupo, g.permissoes from usuarios u join grupos g on g.id = u.grupo_id where u.ativo order by u.nome`);
    const atende = (u: { permissoes: Record<string, string[]> }) => !!(u.permissoes['*'] || u.permissoes.crm?.includes('editar'));
    // ?todos=1: todo usuário ativo (para escolher o dono de um número), dizendo quem ainda não tem acesso ao CRM.
    if (todos === '1') return us.rows.map((u) => ({ id: u.id, nome: u.nome, grupo: u.grupo, semCrm: !atende(u) }));
    return us.rows.filter(atende).map((u) => ({ id: u.id, nome: u.nome }));
  }

  // ───────────── Templates e respostas rápidas ─────────────

  @Get('crm/templates')
  @Permissao('crm', 'ver')
  templates(@Query('canalId') canalId?: string) {
    return this.db
      .select()
      .from(crmTemplates)
      .where(canalId ? sql`(${crmTemplates.canalId} = ${canalId} or ${crmTemplates.canalId} is null)` : undefined)
      .orderBy(asc(crmTemplates.tipo), asc(crmTemplates.nome));
  }

  @Post('crm/templates')
  @Permissao('crm', 'excluir')
  async criarTemplate(@Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80), texto: z.string().trim().min(1).max(4096), categoria: opcional(40) }), body);
    const [t] = await this.db.insert(crmTemplates).values({ ...d, tipo: 'livre', status: 'ATIVO' }).returning();
    return t;
  }

  @Patch('crm/templates/:id')
  @Permissao('crm', 'excluir')
  async editarTemplate(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [t] = await this.db.select().from(crmTemplates).where(eq(crmTemplates.id, id));
    if (!t) throw new NotFoundException('Template não encontrado.');
    // Template da Meta: só se escolhe de onde vêm as variáveis ({{1}} = nome…). O texto é aprovado lá.
    const d = t.tipo === 'meta'
      ? validar(z.object({ variaveis: z.array(z.string().max(200)).max(20) }), body)
      : validar(z.object({ nome: z.string().trim().min(2).max(80).optional(), texto: z.string().trim().min(1).max(4096).optional(), categoria: opcional(40) }), body);
    const [r] = await this.db.update(crmTemplates).set({ ...d, atualizadoEm: new Date() }).where(eq(crmTemplates.id, id)).returning();
    return r;
  }

  @Delete('crm/templates/:id')
  @Permissao('crm', 'excluir')
  async apagarTemplate(@Param('id', ParseUUIDPipe) id: string) {
    const [t] = await this.db.select().from(crmTemplates).where(eq(crmTemplates.id, id));
    if (t?.tipo === 'meta') throw new BadRequestException('Templates da Meta são apagados no Gerenciador do WhatsApp e somem na próxima sincronização.');
    await this.db.delete(crmTemplates).where(eq(crmTemplates.id, id));
    return { ok: true };
  }

  @Get('crm/respostas')
  @Permissao('crm', 'ver')
  respostas() {
    return this.db.select().from(crmRespostasRapidas).orderBy(asc(crmRespostasRapidas.atalho));
  }

  @Post('crm/respostas')
  @Permissao('crm', 'excluir')
  async criarResposta(@Body() body: unknown) {
    const d = validar(
      z.object({
        atalho: z.string().trim().min(2).max(30).regex(/^[a-z0-9_-]+$/i, 'Use letras, números, - ou _').transform((s) => s.toLowerCase()),
        texto: z.string().trim().max(4096).default(''),
        midia: z.object({ nome: z.string().trim().min(1).max(200), mime: z.string().trim().max(100), base64: z.string().min(10) }).nullable().optional(),
      }),
      body,
    );
    if (!d.texto && !d.midia) throw new BadRequestException('Escreva o texto ou escolha uma foto, vídeo ou áudio.');
    let arquivo: { midia: string; midiaMime: string; midiaNome: string } | null = null;
    if (d.midia) {
      const mime = d.midia.mime.split(';')[0].toLowerCase();
      if (!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|quicktime)|audio\/(ogg|mpeg|mp4|aac|webm|wav|x-m4a|amr))$/.test(mime)) throw new BadRequestException('Use foto (JPG, PNG, WEBP), vídeo (MP4) ou áudio (OGG, MP3, M4A).');
      const conteudo = Buffer.from(d.midia.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (conteudo.length > 16_000_000) throw new BadRequestException('Arquivo maior que 16 MB.');
      arquivo = { midia: await this.arquivos.salvarMidia(conteudo, mime), midiaMime: mime, midiaNome: d.midia.nome };
    }
    const [ja] = await this.db.select({ id: crmRespostasRapidas.id }).from(crmRespostasRapidas).where(eq(crmRespostasRapidas.atalho, d.atalho));
    if (ja) throw new BadRequestException(`Já existe a resposta /${d.atalho}. Apague a antiga ou use outro atalho.`);
    const [r] = await this.db.insert(crmRespostasRapidas).values({ atalho: d.atalho, texto: d.texto, ...(arquivo ?? {}) }).returning();
    return r;
  }

  @Delete('crm/respostas/:id')
  @Permissao('crm', 'excluir')
  async apagarResposta(@Param('id', ParseUUIDPipe) id: string) {
    await this.db.delete(crmRespostasRapidas).where(eq(crmRespostasRapidas.id, id));
    return { ok: true };
  }

  // ───────────── Gatilhos ─────────────

  @Get('crm/gatilhos')
  @Permissao('crm', 'ver')
  async gatilhos() {
    const gs = await this.db.select().from(crmGatilhos).orderBy(asc(crmGatilhos.criadoEm));
    const pend = await this.db.execute<{ gatilho_id: string; n: number }>(sql`select gatilho_id, count(*)::int as n from crm_fila where status = 'pendente' group by gatilho_id`);
    const erros = await this.db.execute<{ gatilho_id: string; n: number }>(sql`select gatilho_id, count(*)::int as n from crm_fila where status = 'erro' and criado_em > now() - interval '7 days' group by gatilho_id`);
    const p = new Map(pend.rows.map((x) => [x.gatilho_id, x.n]));
    const e = new Map(erros.rows.map((x) => [x.gatilho_id, x.n]));
    return gs.map((g) => ({ ...g, agendados: p.get(g.id) ?? 0, errosSemana: e.get(g.id) ?? 0 }));
  }

  @Post('crm/gatilhos')
  @Permissao('crm', 'excluir')
  async criarGatilho(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(gatilhoSchema, body);
    if (d.evento === 'entrou_etapa' && !d.etapaId) throw new BadRequestException('Escolha a etapa.');
    if (d.evento === 'sem_resposta' && !(Number(d.parametro) >= 1)) throw new BadRequestException('Informe quantas horas sem resposta.');
    const [g] = await this.db.insert(crmGatilhos).values({ ...d, acoes: d.acoes as Record<string, unknown>[] }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'crm_gatilho', entidadeId: g.id, dados: { nome: d.nome } });
    return g;
  }

  @Patch('crm/gatilhos/:id')
  @Permissao('crm', 'excluir')
  async editarGatilho(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(gatilhoSchema.partial(), body);
    const [g] = await this.db.update(crmGatilhos).set({ ...d, acoes: d.acoes as Record<string, unknown>[] | undefined }).where(eq(crmGatilhos.id, id)).returning();
    if (!g) throw new NotFoundException('Gatilho não encontrado.');
    // Desligado: o que estava esperando não acontece mais.
    if (d.ativo === false) await this.db.update(crmFila).set({ status: 'cancelado', erro: 'gatilho desligado' }).where(and(eq(crmFila.gatilhoId, id), eq(crmFila.status, 'pendente')));
    return g;
  }

  @Delete('crm/gatilhos/:id')
  @Permissao('crm', 'excluir')
  async apagarGatilho(@Param('id', ParseUUIDPipe) id: string) {
    await this.db.delete(crmGatilhos).where(eq(crmGatilhos.id, id));
    return { ok: true };
  }

  // ───────────── Disparos em massa ─────────────

  @Get('crm/disparos')
  @Permissao('crm', 'ver')
  async disparos() {
    const ds = await this.db
      .select({ d: crmDisparos, canal: crmCanais.nome, template: crmTemplates.nome })
      .from(crmDisparos)
      .innerJoin(crmCanais, eq(crmCanais.id, crmDisparos.canalId))
      .leftJoin(crmTemplates, eq(crmTemplates.id, crmDisparos.templateId))
      .orderBy(desc(crmDisparos.criadoEm))
      .limit(100);
    const st = await this.db.execute<{ disparo_id: string; status: string; n: number }>(sql`select disparo_id, status, count(*)::int as n from crm_disparo_destinos group by 1, 2`);
    return ds.map(({ d, canal, template }) => ({ ...d, canal, template, porStatus: Object.fromEntries(st.rows.filter((x) => x.disparo_id === d.id).map((x) => [x.status, x.n])) }));
  }

  @Post('crm/disparos')
  @Permissao('crm', 'excluir')
  async criarDisparo(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        nome: z.string().trim().min(2).max(120),
        canalId: uuid,
        templateId: uuid.nullable().optional(),
        texto: z.string().trim().max(4096).nullable().optional(),
        filtro: z.object({ funilId: uuid.optional(), etapaIds: z.array(uuid).optional(), etiquetas: z.array(z.string()).optional(), status: z.enum(['aberto', 'ganho', 'perdido']).optional(), contatoIds: z.array(uuid).max(5000).optional() }),
        ritmo: z.number().int().min(1).max(200).default(20),
      }),
      body,
    );
    const canal = await this.canais.obter(d.canalId);
    if (!d.templateId && !d.texto) throw new BadRequestException('Escolha um template ou escreva a mensagem.');
    if (canal.tipo === 'oficial' && !d.templateId) throw new BadRequestException('No número oficial, disparo em massa só com template aprovado pela Meta.');
    if (d.templateId) {
      const [t] = await this.db.select().from(crmTemplates).where(eq(crmTemplates.id, d.templateId));
      if (!t) throw new BadRequestException('Template não encontrado.');
      if (canal.tipo === 'oficial' && (t.tipo !== 'meta' || t.canalId !== canal.id)) throw new BadRequestException('Use um template aprovado deste número.');
      if (t.tipo === 'meta' && t.status !== 'APPROVED') throw new BadRequestException('Template ainda não aprovado pela Meta.');
    }
    const [r] = await this.db.insert(crmDisparos).values({ ...d, usuarioId: u.id }).returning();
    const total = await this.automacao.prepararDisparo(r.id);
    return { ...r, total };
  }

  @Get('crm/disparos/:id')
  @Permissao('crm', 'ver')
  async disparo(@Param('id', ParseUUIDPipe) id: string) {
    const [d] = await this.db.select().from(crmDisparos).where(eq(crmDisparos.id, id));
    if (!d) throw new NotFoundException('Disparo não encontrado.');
    const destinos = await this.db
      .select({ id: crmDisparoDestinos.id, status: crmDisparoDestinos.status, erro: crmDisparoDestinos.erro, enviadoEm: crmDisparoDestinos.enviadoEm, contato: crmContatos.nome, telefone: crmContatos.telefone })
      .from(crmDisparoDestinos)
      .innerJoin(crmContatos, eq(crmContatos.id, crmDisparoDestinos.contatoId))
      .where(eq(crmDisparoDestinos.disparoId, id))
      .orderBy(asc(crmContatos.nome))
      .limit(2000);
    return { ...d, destinos };
  }

  @Post('crm/disparos/:id/iniciar')
  @Permissao('crm', 'excluir')
  async iniciar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { quando } = validar(z.object({ quando: z.string().datetime({ offset: true }).nullable().optional() }), body ?? {});
    const r = await this.automacao.iniciarDisparo(id, quando ? new Date(quando) : null);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'disparo', entidade: 'crm_disparo', entidadeId: id, dados: r });
    if (r.status === 'enviando') void this.automacao.ciclo();
    return r;
  }

  @Post('crm/disparos/:id/pausar')
  @Permissao('crm', 'excluir')
  async pausar(@Param('id', ParseUUIDPipe) id: string) {
    const [d] = await this.db.update(crmDisparos).set({ status: 'pausado' }).where(and(eq(crmDisparos.id, id), inArray(crmDisparos.status, ['enviando', 'agendado']))).returning();
    if (!d) throw new BadRequestException('Só disparos em andamento ou agendados podem ser pausados.');
    return d;
  }

  @Post('crm/disparos/:id/cancelar')
  @Permissao('crm', 'excluir')
  async cancelarDisparo(@Param('id', ParseUUIDPipe) id: string) {
    const [d] = await this.db.update(crmDisparos).set({ status: 'cancelado' }).where(and(eq(crmDisparos.id, id), inArray(crmDisparos.status, ['rascunho', 'enviando', 'agendado', 'pausado']))).returning();
    if (!d) throw new BadRequestException('Este disparo já terminou.');
    await this.db.update(crmDisparoDestinos).set({ status: 'pulado', erro: 'disparo cancelado' }).where(and(eq(crmDisparoDestinos.disparoId, id), eq(crmDisparoDestinos.status, 'pendente')));
    return d;
  }

  // ───────────── Motor ─────────────

  @Post('crm/processar')
  @Permissao('crm', 'excluir')
  async processar() {
    await this.automacao.ciclo();
    return { ok: true };
  }

  @Post('crm/revendedoras/sincronizar')
  @Permissao('crm', 'excluir')
  sincronizarRevendedoras() {
    return this.automacao.sincronizarRevendedoras();
  }

  // ───────────── Webhooks do WhatsApp ─────────────

  /** Verificação do webhook pela Meta (hub.challenge). */
  @Publico()
  @Get('webhooks/whatsapp/:canalId/:token')
  async verificar(@Param('canalId', ParseUUIDPipe) canalId: string, @Param('token') token: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const desafio = await this.canais.verificarMeta(canalId, token, q['hub.mode'], q['hub.verify_token'], q['hub.challenge']);
    res.type('text/plain').send(desafio);
  }

  @Publico()
  @Post('webhooks/whatsapp/:canalId/:token')
  @HttpCode(200)
  receber(@Param('canalId', ParseUUIDPipe) canalId: string, @Param('token') token: string, @Body() body: unknown, @Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') assinatura?: string) {
    return this.canais.receber(canalId, token, body, req.rawBody, assinatura);
  }
}
