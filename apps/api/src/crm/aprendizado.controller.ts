import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { iaAgentes, iaLicoes, usuarios } from '../db/schema';
import { AprendizadoService } from './aprendizado.service';

const licao = z.object({
  funcao: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, 'Especialista inválido').nullable().optional(),
  quando: z.string().trim().min(8, 'Descreva a situação').max(400),
  resposta: z.string().trim().min(8, 'Diga o que a IA deve responder ou fazer').max(1200),
});

/** O que a IA do WhatsApp aprendeu: correções da equipe e sugestões da revisão semanal. */
@Controller('crm')
export class AprendizadoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly aprendizado: AprendizadoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get('ia-licoes')
  @Permissao('crm', 'ver')
  async listar(@Query('status') status?: string) {
    const lista = await this.db
      .select({ id: iaLicoes.id, funcao: iaLicoes.funcao, quando: iaLicoes.quando, resposta: iaLicoes.resposta, status: iaLicoes.status, origem: iaLicoes.origem, criadoEm: iaLicoes.criadoEm, por: usuarios.nome })
      .from(iaLicoes)
      .leftJoin(usuarios, eq(usuarios.id, iaLicoes.criadoPor))
      .where(status && ['ativa', 'pendente', 'recusada'].includes(status) ? eq(iaLicoes.status, status) : undefined)
      .orderBy(desc(iaLicoes.criadoEm))
      .limit(300);
    return lista;
  }

  /** Para preencher a correção: o que o cliente tinha dito antes daquela resposta da IA. */
  @Get('mensagens/:id/pergunta')
  @Permissao('crm', 'ver')
  async pergunta(@Param('id', ParseUUIDPipe) id: string) {
    const p = await this.aprendizado.perguntaAntesDe(id);
    if (!p) throw new NotFoundException('Mensagem não encontrada.');
    const [a] = p.agenteId ? await this.db.select({ funcao: iaAgentes.funcao }).from(iaAgentes).where(eq(iaAgentes.id, p.agenteId)) : [];
    return { pergunta: p.pergunta, respostaDaIa: p.mensagem.texto ?? '', funcao: a?.funcao ?? null };
  }

  /**
   * Ensina a IA. Quem atende pode corrigir uma resposta: vira lição pendente.
   * Quem pode editar Configurações já grava como ativa (passa a valer na próxima resposta).
   */
  @Post('ia-licoes')
  @Permissao('crm', 'editar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(licao.extend({ mensagemId: z.string().uuid().optional() }), body);
    const gestao = temPermissao(u.permissoes, 'configuracoes', 'editar');
    const origem = d.mensagemId ? await this.aprendizado.perguntaAntesDe(d.mensagemId) : null;
    const [l] = await this.db
      .insert(iaLicoes)
      .values({ funcao: d.funcao || null, quando: d.quando, resposta: d.resposta, status: gestao ? 'ativa' : 'pendente', origem: d.mensagemId ? 'correcao' : 'manual', conversaId: origem?.mensagem.conversaId ?? null, criadoPor: u.id })
      .returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'ia_licao', entidadeId: l.id, dados: { status: l.status, origem: l.origem } });
    return l;
  }

  /** Aprovar, recusar ou reescrever uma lição. */
  @Patch('ia-licoes/:id')
  @Permissao('configuracoes', 'editar')
  async mudar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(licao.partial().extend({ status: z.enum(['ativa', 'pendente', 'recusada']).optional() }), body);
    const [l] = await this.db.update(iaLicoes).set({ ...d, funcao: d.funcao === undefined ? undefined : d.funcao || null, atualizadoEm: new Date() }).where(eq(iaLicoes.id, id)).returning();
    if (!l) throw new NotFoundException('Lição não encontrada.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'ia_licao', entidadeId: id, dados: { status: l.status } });
    return l;
  }

  @Delete('ia-licoes/:id')
  @Permissao('configuracoes', 'editar')
  async apagar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [l] = await this.db.delete(iaLicoes).where(eq(iaLicoes.id, id)).returning({ id: iaLicoes.id });
    if (!l) throw new NotFoundException('Lição não encontrada.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'ia_licao', entidadeId: id });
    return { ok: true };
  }

  /** Roda agora a revisão das conversas que a IA passou para a equipe nos últimos 7 dias. */
  @Post('ia-licoes/revisar')
  @Permissao('configuracoes', 'editar')
  async revisar(@Usuario() u: UsuarioLogado) {
    return this.aprendizado.revisarSemana(u.id);
  }
}
