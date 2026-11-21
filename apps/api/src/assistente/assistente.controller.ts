import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { assistentePedidos, chamados, usuarios } from '../db/schema';
import { ErroIa, IaService } from '../ia/ia.service';
import { AssistenteService, VOZES_ELEVENLABS, VOZES_OPENAI } from './assistente.service';
import { FerramentasAssistente } from './ferramentas';
import { AgenteService } from '../crm/agente.service';

const EXTENSOES: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a' };

/** Assistente da equipe: conversa por texto ou voz, ações com confirmação e pedidos de configuração/desenvolvimento. */
@Controller('assistente')
export class AssistenteController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly assistente: AssistenteService,
    private readonly ferramentas: FerramentasAssistente,
    private readonly ia: IaService,
    private readonly agente: AgenteService,
  ) {}

  /** Estado para a tela: IA ligada, voz ligada, nome e o que esta pessoa consegue pedir. */
  @Get('estado')
  @Permissao('assistente', 'ver')
  async estado(@Usuario() u: UsuarioLogado) {
    const cfg = await this.assistente.config();
    return {
      ligado: this.ia.texto,
      voz: this.ia.imagem,
      nome: cfg.nome,
      vozResposta: await this.assistente.provedorVoz(cfg),
      ferramentas: this.ferramentas.lista.filter((f) => f.permitido(u)).map((f) => ({ nome: f.nome, risco: f.risco })),
      podeConfigurar: temPermissao(u.permissoes, 'configuracoes', 'editar'),
      podeAutomatico: this.assistente.podeAutomatico(u, cfg),
    };
  }

  @Get('config')
  @Permissao('configuracoes', 'ver')
  async config() {
    return { ...(await this.assistente.config()), opcoes: { elevenlabs: VOZES_ELEVENLABS, openai: VOZES_OPENAI }, chaves: { elevenlabs: this.ia.temElevenlabs, openai: this.ia.imagem } };
  }

  @Put('config')
  @Permissao('configuracoes', 'editar')
  salvarConfig(@Body() body: unknown) {
    const d = validar(
      z.object({
        nome: z.string().trim().min(2, 'Dê um nome ao assistente').max(40),
        instrucoes: z.string().max(6000).default(''),
        voz: z.enum(['automatica', 'elevenlabs', 'openai', 'navegador']).default('automatica'),
        aprovacaoAutomatica: z.enum(['gestao', 'todos', 'ninguem']).default('gestao'),
        vozElevenlabs: z.string().trim().regex(/^[A-Za-z0-9]{10,40}$/, 'Id de voz da ElevenLabs inválido').default(VOZES_ELEVENLABS[0].id),
        vozOpenai: z.enum(VOZES_OPENAI.map((v) => v.id) as [string, ...string[]]).default('ash'),
      }),
      body,
    );
    return this.assistente.salvarConfig(d);
  }

  @Get('sessoes')
  @Permissao('assistente', 'ver')
  sessoes(@Usuario() u: UsuarioLogado) {
    return this.assistente.sessoes(u);
  }

  @Post('sessoes')
  @Permissao('assistente', 'ver')
  criar(@Usuario() u: UsuarioLogado) {
    return this.assistente.criarSessao(u);
  }

  @Get('sessoes/:id')
  @Permissao('assistente', 'ver')
  sessao(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.sessao(u, id);
  }

  /** "Pedir aprovação" ou "Aprovar automaticamente" nesta conversa. */
  @Patch('sessoes/:id')
  @Permissao('assistente', 'ver')
  mudarSessao(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ aprovacao: z.enum(['perguntar', 'automatico']) }), body);
    return this.assistente.mudarAprovacao(u, id, d.aprovacao);
  }

  @Delete('sessoes/:id')
  @Permissao('assistente', 'ver')
  excluir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.excluirSessao(u, id);
  }

  @Post('sessoes/:id/mensagens')
  @Permissao('assistente', 'ver')
  enviar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ texto: z.string().trim().max(8000).default(''), origem: z.enum(['texto', 'voz']).default('texto'), anexos: z.array(z.string().uuid()).max(10).default([]) }), body);
    if (!d.texto && !d.anexos.length) throw new BadRequestException('Escreva, fale ou anexe o que precisa.');
    return this.assistente.enviar(u, id, d.texto, d.origem, d.anexos);
  }

  /** Anexo da conversa (foto, PDF, planilha, documento, vídeo, áudio), em base64. Devolve o id para mandar junto com a mensagem. */
  @Post('anexos')
  @Permissao('assistente', 'ver')
  anexar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(1).max(200), mime: z.string().max(120).default(''), conteudo: z.string().min(4, 'Arquivo vazio').max(25_000_000, 'Arquivo grande demais (máximo de 18 MB)') }), body);
    return this.assistente.anexar(u, { nome: d.nome, mime: d.mime, conteudo: Buffer.from(d.conteudo, 'base64') });
  }

  @Get('anexos/:id')
  @Permissao('assistente', 'ver')
  async baixarAnexo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const a = await this.assistente.anexo(u, id);
    res.setHeader('content-type', a.mime);
    res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.sendFile(a.caminho);
  }

  /** Áudio gravado no microfone da tela: devolve o texto (a tela mostra e envia). */
  @Post('transcrever')
  @Permissao('assistente', 'ver')
  async transcrever(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ audio: z.string().min(100, 'Áudio vazio').max(20_000_000, 'Áudio longo demais (máximo de ~10 minutos)'), mime: z.string().max(80) }), body);
    const extensao = EXTENSOES[d.mime.split(';')[0].trim().toLowerCase()];
    if (!extensao) throw new BadRequestException(`Formato de áudio não aceito (${d.mime}).`);
    try {
      return { texto: await this.ia.transcrever({ conteudo: Buffer.from(d.audio, 'base64'), extensao, usuarioId: u.id }) };
    } catch (e) {
      if (e instanceof ErroIa) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Resposta falada (MP3), na voz configurada. Com "provedor" e "voz", toca um exemplo antes de salvar. */
  @Post('falar')
  @Permissao('assistente', 'ver')
  async falar(@Usuario() u: UsuarioLogado, @Body() body: unknown, @Res() res: Response) {
    const d = validar(z.object({ texto: z.string().trim().min(1).max(6000), provedor: z.enum(['elevenlabs', 'openai']).optional(), voz: z.string().trim().max(40).optional() }), body);
    const audio = await this.assistente.falar(u, d.texto, d.provedor && d.voz ? { provedor: d.provedor, voz: d.voz } : undefined);
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('cache-control', 'private, max-age=600');
    res.send(audio);
  }

  @Post('acoes/:id/confirmar')
  @Permissao('assistente', 'ver')
  confirmar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.confirmar(u, id);
  }

  @Post('acoes/:id/cancelar')
  @Permissao('assistente', 'ver')
  cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.cancelar(u, id);
  }

  /** Todos os agentes numa lista: os agendados (rotinas) e os que atendem no WhatsApp. */
  @Get('agentes')
  @Permissao('assistente', 'ver')
  async agentes(@Usuario() u: UsuarioLogado) {
    const veWhatsapp = temPermissao(u.permissoes, 'crm', 'ver');
    const cfg = veWhatsapp ? await this.agente.config() : null;
    return {
      rotinas: await this.assistente.rotinas(u),
      whatsapp: cfg ? { ligado: cfg.ativo, nome: cfg.nome, maxRespostas: cfg.maxRespostas, especialistas: await this.agente.especialistas(true) } : null,
      podeEditarWhatsapp: temPermissao(u.permissoes, 'configuracoes', 'editar'),
    };
  }

  // ───── Rotinas agendadas ─────

  @Get('rotinas')
  @Permissao('assistente', 'ver')
  rotinas(@Usuario() u: UsuarioLogado) {
    return this.assistente.rotinas(u);
  }

  @Patch('rotinas/:id')
  @Permissao('assistente', 'ver')
  mudarRotina(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ ativa: z.boolean().optional(), aprovacao: z.enum(['perguntar', 'automatico']).optional() }), body);
    return this.assistente.mudarRotina(u, id, d);
  }

  @Delete('rotinas/:id')
  @Permissao('assistente', 'ver')
  excluirRotina(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.excluirRotina(u, id);
  }

  @Post('rotinas/:id/duplicar')
  @Permissao('assistente', 'ver')
  duplicarRotina(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.duplicarRotina(u, id);
  }

  @Post('rotinas/:id/executar')
  @Permissao('assistente', 'ver')
  rodarAgora(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.rodarAgora(u, id);
  }

  /** Pedidos de configuração e desenvolvimento (a gestão vê todos; os demais, os seus). */
  @Get('pedidos')
  @Permissao('assistente', 'ver')
  pedidos(@Usuario() u: UsuarioLogado, @Query('status') status?: string) {
    const todos = temPermissao(u.permissoes, 'configuracoes', 'editar');
    const filtros = [todos ? undefined : eq(assistentePedidos.usuarioId, u.id), status ? eq(assistentePedidos.status, status) : undefined].filter(Boolean);
    return this.db
      .select({ id: assistentePedidos.id, numero: assistentePedidos.numero, tipo: assistentePedidos.tipo, titulo: assistentePedidos.titulo, especificacao: assistentePedidos.especificacao, plano: assistentePedidos.plano, modulo: assistentePedidos.modulo, prioridade: assistentePedidos.prioridade, status: assistentePedidos.status, autor: usuarios.nome, chamado: chamados.numero, criadoEm: assistentePedidos.criadoEm, atualizadoEm: assistentePedidos.atualizadoEm })
      .from(assistentePedidos)
      .leftJoin(usuarios, eq(usuarios.id, assistentePedidos.usuarioId))
      .leftJoin(chamados, eq(chamados.id, assistentePedidos.chamadoId))
      .where(filtros.length ? and(...filtros) : undefined)
      .orderBy(desc(assistentePedidos.criadoEm))
      .limit(200);
  }

  @Patch('pedidos/:id')
  @Permissao('configuracoes', 'editar')
  async mudarPedido(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ status: z.enum(['novo', 'em_analise', 'em_andamento', 'pronto', 'recusado']) }), body);
    const [p] = await this.db.update(assistentePedidos).set({ status: d.status, atualizadoEm: new Date() }).where(eq(assistentePedidos.id, id)).returning();
    if (!p) throw new BadRequestException('Pedido não encontrado.');
    return p;
  }
}
