import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { assistentePedidos, chamados, usuarios } from '../db/schema';
import { ErroIa, IaService } from '../ia/ia.service';
import { AssistenteService } from './assistente.service';
import { FerramentasAssistente } from './ferramentas';

const EXTENSOES: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a' };

/** Assistente da equipe: conversa por texto ou voz, ações com confirmação e pedidos de configuração/desenvolvimento. */
@Controller('assistente')
export class AssistenteController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly assistente: AssistenteService,
    private readonly ferramentas: FerramentasAssistente,
    private readonly ia: IaService,
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
      ferramentas: this.ferramentas.lista.filter((f) => f.permitido(u)).map((f) => ({ nome: f.nome, risco: f.risco })),
      podeConfigurar: temPermissao(u.permissoes, 'configuracoes', 'editar'),
    };
  }

  @Get('config')
  @Permissao('configuracoes', 'ver')
  config() {
    return this.assistente.config();
  }

  @Put('config')
  @Permissao('configuracoes', 'editar')
  salvarConfig(@Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2, 'Dê um nome ao assistente').max(40), instrucoes: z.string().max(6000).default('') }), body);
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

  @Delete('sessoes/:id')
  @Permissao('assistente', 'ver')
  excluir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistente.excluirSessao(u, id);
  }

  @Post('sessoes/:id/mensagens')
  @Permissao('assistente', 'ver')
  enviar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ texto: z.string().trim().min(1, 'Escreva ou fale o que precisa').max(8000), origem: z.enum(['texto', 'voz']).default('texto') }), body);
    return this.assistente.enviar(u, id, d.texto, d.origem);
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
