import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { chamadoMensagens, chamados, usuarios } from '../db/schema';
import { EmailService } from '../integracoes/email.service';
import { AsaasService } from '../integracoes/asaas.service';
import { AssertivaService } from '../integracoes/assertiva.service';
import { FiscalService } from '../fiscal/fiscal.service';

/** Canal da Aritana com a Wide durante os 12 meses de suporte. Qualquer usuário pode abrir chamado. */
@Controller('suporte')
export class SuporteController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly email: EmailService,
    private readonly asaas: AsaasService,
    private readonly assertiva: AssertivaService,
    private readonly fiscal: FiscalService,
  ) {}

  private veTodos(u: UsuarioLogado) {
    return temPermissao(u.permissoes, 'suporte', 'editar') || temPermissao(u.permissoes, 'configuracoes', 'ver');
  }

  @Get('chamados')
  listar(@Usuario() u: UsuarioLogado) {
    return this.db
      .select({ id: chamados.id, numero: chamados.numero, titulo: chamados.titulo, tipo: chamados.tipo, modulo: chamados.modulo, prioridade: chamados.prioridade, status: chamados.status, autor: usuarios.nome, criadoEm: chamados.criadoEm, atualizadoEm: chamados.atualizadoEm, mensagens: sql<number>`(select count(*)::int from ${chamadoMensagens} cm where cm.chamado_id = ${chamados.id})` })
      .from(chamados)
      .leftJoin(usuarios, eq(usuarios.id, chamados.usuarioId))
      .where(this.veTodos(u) ? undefined : eq(chamados.usuarioId, u.id))
      .orderBy(desc(chamados.atualizadoEm));
  }

  @Get('chamados/:id')
  async obter(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [c] = await this.db.select().from(chamados).where(eq(chamados.id, id));
    if (!c) throw new NotFoundException('Chamado não encontrado.');
    if (!this.veTodos(u) && c.usuarioId !== u.id) throw new ForbiddenException('Chamado de outro usuário.');
    const msgs = await this.db
      .select({ id: chamadoMensagens.id, texto: chamadoMensagens.texto, daWide: chamadoMensagens.daWide, autor: usuarios.nome, criadoEm: chamadoMensagens.criadoEm })
      .from(chamadoMensagens)
      .leftJoin(usuarios, eq(usuarios.id, chamadoMensagens.usuarioId))
      .where(eq(chamadoMensagens.chamadoId, id))
      .orderBy(asc(chamadoMensagens.criadoEm));
    return { ...c, mensagens: msgs };
  }

  @Post('chamados')
  async abrir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        titulo: z.string().trim().min(5, 'Descreva em poucas palavras').max(150),
        tipo: z.enum(['duvida', 'erro', 'melhoria']),
        modulo: z.string().max(40).optional().nullable(),
        tela: z.string().max(300).optional().nullable(),
        prioridade: z.enum(['baixa', 'normal', 'alta', 'urgente']).default('normal'),
        descricao: z.string().trim().min(10, 'Conte um pouco mais').max(5000),
      }),
      body,
    );
    const [c] = await this.db.insert(chamados).values({ titulo: d.titulo, tipo: d.tipo, modulo: d.modulo ?? null, tela: d.tela ?? null, prioridade: d.prioridade, usuarioId: u.id }).returning();
    await this.db.insert(chamadoMensagens).values({ chamadoId: c.id, usuarioId: u.id, texto: d.descricao });
    if (process.env.EMAIL_SUPORTE) {
      await this.email.enviar(process.env.EMAIL_SUPORTE, `[Aritana] Chamado nº ${c.numero} · ${d.titulo}`, `${u.nome} (${u.email}) abriu um chamado de ${d.tipo}, prioridade ${d.prioridade}.\nMódulo: ${d.modulo ?? '—'}\nTela: ${d.tela ?? '—'}\n\n${d.descricao}`).catch(() => undefined);
    }
    return c;
  }

  @Post('chamados/:id/mensagens')
  async responder(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const c = await this.obter(u, id);
    const d = validar(z.object({ texto: z.string().trim().min(2).max(5000), status: z.enum(['aberto', 'em_analise', 'em_desenvolvimento', 'resolvido']).optional() }), body);
    await this.db.insert(chamadoMensagens).values({ chamadoId: id, usuarioId: u.id, texto: d.texto });
    const status = d.status && this.veTodos(u) ? d.status : c.status === 'resolvido' ? 'aberto' : c.status;
    await this.db.update(chamados).set({ status, atualizadoEm: new Date() }).where(eq(chamados.id, id));
    return { ok: true };
  }

  /** Situação do sistema e das integrações, para a aba Suporte. */
  @Get('status')
  async status() {
    const ini = Date.now();
    await this.db.execute(sql`select 1`);
    return {
      sistema: { ok: true, banco: `${Date.now() - ini} ms`, versao: process.env.npm_package_version ?? '0.1.0', ambiente: process.env.NODE_ENV ?? 'desenvolvimento' },
      integracoes: [
        { nome: 'E-mail', ligada: this.email.configurado },
        { nome: 'Asaas', ligada: this.asaas.configurado },
        { nome: 'Assertiva', ligada: this.assertiva.configurada },
        { nome: `Emissor fiscal (${this.fiscal.ambiente})`, ligada: this.fiscal.configurado },
      ],
      ultimoBackup: process.env.ULTIMO_BACKUP_ARQUIVO ? await lerUltimoBackup(process.env.ULTIMO_BACKUP_ARQUIVO) : null,
    };
  }
}

async function lerUltimoBackup(arquivo: string) {
  try {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(arquivo, 'utf8')).trim().slice(0, 40);
  } catch {
    return null;
  }
}
