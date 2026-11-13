import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACOES, MODULOS } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, contemPermissoes, invalidarSessoes, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { grupos, niveis, usuarios } from '../db/schema';

const chavesModulo = MODULOS.map((m) => m.chave) as [string, ...string[]];
// Só os módulos informados (os demais ficam sem acesso).
const permissoesSchema = z
  .partialRecord(z.enum(['*', ...chavesModulo]), z.array(z.enum(['*', ...ACOES])))
  .transform((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v && v.length)) as Record<string, string[]>);

const usuarioSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome').max(120),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  grupoId: z.string().uuid('Escolha o grupo'),
  ativo: z.boolean().default(true),
});

/** Ninguém coloca alguém (nem a si mesmo) num grupo com mais acesso do que o próprio. */
async function exigirGrupoPermitido(db: Db, u: UsuarioLogado, grupoId: string) {
  const [g] = await db.select().from(grupos).where(eq(grupos.id, grupoId));
  if (!g) throw new NotFoundException('Grupo não encontrado.');
  if (!contemPermissoes(u.permissoes, g.permissoes)) throw new ForbiddenException(`O grupo ${g.nome} tem acessos que você não tem; peça à Diretoria.`);
}

@Controller('usuarios')
export class UsuariosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  /** Só quem tem todos os acessos do usuário-alvo pode mexer nele (evita rebaixar ou trocar a senha da Diretoria). */
  private async exigirAlvoPermitido(u: UsuarioLogado, id: string) {
    const [alvo] = await this.db.select({ permissoes: grupos.permissoes }).from(usuarios).innerJoin(grupos, eq(grupos.id, usuarios.grupoId)).where(eq(usuarios.id, id));
    if (!alvo) throw new NotFoundException('Usuário não encontrado.');
    if (!contemPermissoes(u.permissoes, alvo.permissoes)) throw new ForbiddenException('Este usuário tem acessos que você não tem; peça à Diretoria.');
  }

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
    await exigirGrupoPermitido(this.db, u, d.grupoId);
    const senha = randomBytes(9).toString('base64url');
    const [n] = await this.db.insert(usuarios).values({ ...d, senhaHash: await bcrypt.hash(senha, 10), senhaProvisoria: true }).returning({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'usuario', entidadeId: n.id });
    return { ...n, senhaProvisoria: senha };
  }

  @Patch(':id')
  @Permissao('configuracoes', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(usuarioSchema.partial(), body);
    if (id === u.id && d.ativo === false) throw new BadRequestException('Você não pode desativar o próprio usuário.');
    await this.exigirAlvoPermitido(u, id);
    if (d.grupoId) await exigirGrupoPermitido(this.db, u, d.grupoId);
    const [r] = await this.db.update(usuarios).set(d).where(eq(usuarios.id, id)).returning({ id: usuarios.id });
    if (!r) throw new NotFoundException('Usuário não encontrado.');
    invalidarSessoes();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'usuario', entidadeId: id, dados: d });
    return r;
  }

  @Post(':id/nova-senha')
  @Permissao('configuracoes', 'editar')
  async novaSenha(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    await this.exigirAlvoPermitido(u, id);
    const senha = randomBytes(9).toString('base64url');
    const [r] = await this.db.update(usuarios).set({ senhaHash: await bcrypt.hash(senha, 10), senhaProvisoria: true }).where(eq(usuarios.id, id)).returning({ id: usuarios.id });
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
    if (!contemPermissoes(u.permissoes, d.permissoes)) throw new ForbiddenException('Você não pode criar um grupo com acessos que você não tem.');
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
    if (!contemPermissoes(u.permissoes, atual.permissoes) || (d.permissoes && !contemPermissoes(u.permissoes, d.permissoes))) {
      throw new ForbiddenException('Só quem tem todos os acessos deste grupo pode alterá-lo.');
    }
    if (atual.permissoes['*']?.includes('*') && d.permissoes && !d.permissoes['*']?.includes('*')) {
      const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(grupos).where(sql`${grupos.permissoes}->'*' ? '*'`);
      if (n <= 1) throw new BadRequestException('Este é o único grupo com acesso total; não dá para retirar esse acesso.');
    }
    const [g] = await this.db.update(grupos).set(d).where(eq(grupos.id, id)).returning();
    invalidarSessoes();
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
