import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACOES, MODULOS } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { grupos, niveis, usuarios } from '../db/schema';

const chavesModulo = MODULOS.map((m) => m.chave) as [string, ...string[]];
const permissoesSchema = z.record(z.enum(['*', ...chavesModulo]), z.array(z.enum(['*', ...ACOES])));

const usuarioSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome').max(120),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  grupoId: z.string().uuid('Escolha o grupo'),
  ativo: z.boolean().default(true),
});

@Controller('usuarios')
export class UsuariosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('configuracoes', 'ver')
  listar() {
    return this.db
      .select({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email, grupoId: usuarios.grupoId, grupo: grupos.nome, ativo: usuarios.ativo, ultimoAcesso: usuarios.ultimoAcesso })
      .from(usuarios)
      .innerJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .orderBy(asc(usuarios.nome));
  }

  /** Cria o usuário com uma senha provisória, mostrada uma única vez para ser repassada. */
  @Post()
  @Permissao('configuracoes', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(usuarioSchema, body);
    const senha = randomBytes(9).toString('base64url');
    const [n] = await this.db.insert(usuarios).values({ ...d, senhaHash: await bcrypt.hash(senha, 10) }).returning({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'usuario', entidadeId: n.id });
    return { ...n, senhaProvisoria: senha };
  }

  @Patch(':id')
  @Permissao('configuracoes', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(usuarioSchema.partial(), body);
    if (id === u.id && d.ativo === false) throw new BadRequestException('Você não pode desativar o próprio usuário.');
    const [r] = await this.db.update(usuarios).set(d).where(eq(usuarios.id, id)).returning({ id: usuarios.id });
    if (!r) throw new NotFoundException('Usuário não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'usuario', entidadeId: id, dados: d });
    return r;
  }

  @Post(':id/nova-senha')
  @Permissao('configuracoes', 'editar')
  async novaSenha(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const senha = randomBytes(9).toString('base64url');
    const [r] = await this.db.update(usuarios).set({ senhaHash: await bcrypt.hash(senha, 10) }).where(eq(usuarios.id, id)).returning({ id: usuarios.id });
    if (!r) throw new NotFoundException('Usuário não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'nova_senha', entidade: 'usuario', entidadeId: id });
    return { senhaProvisoria: senha };
  }
}

@Controller('grupos')
export class GruposController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('configuracoes', 'ver')
  listar() {
    return this.db
      .select({ id: grupos.id, nome: grupos.nome, permissoes: grupos.permissoes, usuarios: sql<number>`(select count(*)::int from ${usuarios} u where u.grupo_id = ${grupos.id})` })
      .from(grupos)
      .orderBy(asc(grupos.nome));
  }

  @Post()
  @Permissao('configuracoes', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(60), permissoes: permissoesSchema.default({}) }), body);
    const [g] = await this.db.insert(grupos).values(d).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'grupo', entidadeId: g.id });
    return g;
  }

  @Patch(':id')
  @Permissao('configuracoes', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(60).optional(), permissoes: permissoesSchema.optional() }), body);
    const [atual] = await this.db.select().from(grupos).where(eq(grupos.id, id));
    if (!atual) throw new NotFoundException('Grupo não encontrado.');
    if (atual.permissoes['*']?.includes('*') && d.permissoes && !d.permissoes['*']?.includes('*')) {
      const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(grupos).where(sql`${grupos.permissoes}->'*' ? '*'`);
      if (n <= 1) throw new BadRequestException('Este é o único grupo com acesso total; não dá para retirar esse acesso.');
    }
    const [g] = await this.db.update(grupos).set(d).where(eq(grupos.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'grupo', entidadeId: id, dados: { antes: atual.permissoes, depois: g.permissoes } });
    return g;
  }
}

const nivelSchema = z.object({
  nome: z.string().trim().min(2).max(40),
  ordem: z.number().int().min(0).default(0),
  metaMensal: z.number().int().min(0).default(0),
  comissaoAvistaPb: z.number().int().min(0).max(10000).nullable().optional(),
  comissaoPrazoPb: z.number().int().min(0).max(10000).nullable().optional(),
});

@Controller('niveis')
export class NiveisController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  @Get()
  listar() {
    return this.db.select().from(niveis).orderBy(asc(niveis.ordem));
  }

  @Post()
  @Permissao('rede', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const [n] = await this.db.insert(niveis).values(validar(nivelSchema, body)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'nivel', entidadeId: n.id });
    return n;
  }

  @Patch(':id')
  @Permissao('rede', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(nivelSchema.partial(), body);
    const [n] = await this.db.update(niveis).set(d).where(eq(niveis.id, id)).returning();
    if (!n) throw new NotFoundException('Nível não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'nivel', entidadeId: id, dados: d });
    return n;
  }
}
