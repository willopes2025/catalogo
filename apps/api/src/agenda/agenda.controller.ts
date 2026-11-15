import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { urlPublica } from '../comum/url';
import { AgendaService, TIPOS_COMPROMISSO, type TipoCompromisso } from './agenda.service';
import { GoogleService } from './google.service';

const dataHora = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Data e hora inválidas').transform((v) => new Date(v));
const texto = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const linkSeguro = z.string().trim().max(500).nullable().optional().transform((v) => v || null).refine((v) => !v || /^https:\/\//i.test(v), 'O link precisa começar com https://');
const base = {
  titulo: texto(150),
  inicio: dataHora,
  duracaoMin: z.number().int().min(5).max(12 * 60),
  online: z.boolean(),
  local: texto(200),
  link: linkSeguro,
  responsavelId: z.string().uuid().nullable().optional(),
  observacao: texto(1000),
  avisar: z.boolean().default(true),
  forcar: z.boolean().optional(),
};
const novo = z.object({
  ...base,
  tipo: z.enum(Object.keys(TIPOS_COMPROMISSO) as [TipoCompromisso]),
  pessoaId: z.string().uuid().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  maletaId: z.string().uuid().nullable().optional(),
  convidadoNome: texto(120),
  convidadoTelefone: texto(30),
});

@Controller('agenda')
export class AgendaController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: AgendaService, private readonly google: GoogleService, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('agenda', 'ver')
  listar(@Query('de') de?: string, @Query('ate') ate?: string, @Query('responsavelId') responsavelId?: string, @Query('pessoaId') pessoaId?: string, @Query('leadId') leadId?: string) {
    const ini = de && !Number.isNaN(Date.parse(de)) ? new Date(de) : new Date(Date.now() - 86_400_000);
    const fim = ate && !Number.isNaN(Date.parse(ate)) ? new Date(ate) : new Date(ini.getTime() + 8 * 86_400_000);
    if (fim.getTime() - ini.getTime() > 120 * 86_400_000) return [];
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    return this.svc.listar({ de: ini, ate: fim, responsavelId: uuid(responsavelId), pessoaId: uuid(pessoaId), leadId: uuid(leadId), incluirCancelados: !!uuid(leadId) || !!uuid(pessoaId) });
  }

  @Get('tipos')
  @Permissao('agenda', 'ver')
  tipos() {
    return { tipos: TIPOS_COMPROMISSO, google: { configurado: this.google.configurado, conectado: this.google.conectado, conta: this.google.conta, retorno: this.google.retorno } };
  }

  @Post()
  @Permissao('agenda', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(novo, body);
    const c = await this.svc.criar(d, u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'agenda', entidadeId: c.id, dados: { tipo: d.tipo, inicio: d.inicio } });
    return c;
  }

  @Patch(':id')
  @Permissao('agenda', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    // Sem o padrão de "avisar": remarcar não pode religar o aviso de quem marcou sem aviso.
    const d = validar(z.object({ ...base, avisar: z.boolean().optional() }).partial(), body);
    const c = await this.svc.editar(id, d, u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'agenda', entidadeId: id, dados: { inicio: c.inicio } });
    return c;
  }

  @Post(':id/situacao')
  @Permissao('agenda', 'editar')
  async situacao(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ status: z.enum(['confirmado', 'realizado', 'faltou', 'cancelado']), motivo: texto(300) }), body);
    const c = await this.svc.situacao(id, d.status, u.id, d.motivo);
    await this.auditoria.registrar({ usuarioId: u.id, acao: d.status === 'cancelado' ? 'cancelar' : 'editar', entidade: 'agenda', entidadeId: id, dados: d });
    return c;
  }

  /** Para a equipe (e os testes) mandarem os lembretes na hora. */
  @Post('lembretes')
  @Permissao('agenda', 'editar')
  lembretes() {
    return this.svc.enviarLembretes();
  }

  // ───── Conta Google (Agenda + Meet) ─────

  @Get('google/conectar')
  @Permissao('configuracoes', 'editar')
  conectar(@Usuario() u: UsuarioLogado) {
    return { url: this.google.urlConectar(u.id) };
  }

  /** Volta do Google depois de autorizar. Público porque quem chega é o navegador vindo do Google; o "state" amarra ao pedido. */
  @Publico()
  @Get('google/retorno')
  async retorno(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') erro: string | undefined, @Res() res: Response) {
    const volta = (q: string) => res.redirect(302, `${urlPublica()}/agenda?google=${q}`);
    if (erro || !code || !state) return volta(erro === 'access_denied' ? 'negado' : 'erro');
    try {
      const r = await this.google.concluir(code, state);
      await this.auditoria.registrar({ usuarioId: r.usuarioId, acao: 'editar', entidade: 'integracao', entidadeId: null, dados: { google: 'conectado', conta: r.conta } });
      return volta('ok');
    } catch {
      return volta('erro');
    }
  }

  @Post('google/desconectar')
  @Permissao('configuracoes', 'editar')
  async desconectar(@Usuario() u: UsuarioLogado) {
    await this.google.desconectar(u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'integracao', entidadeId: null, dados: { google: 'desconectado' } });
    return { ok: true };
  }
}
