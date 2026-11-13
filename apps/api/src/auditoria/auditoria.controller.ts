import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { Permissao } from '../comum/auth';
import { auditoria, usuarios } from '../db/schema';

/** Quem fez o quê e quando. Somente leitura. */
@Controller('auditoria')
export class AuditoriaController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Permissao('configuracoes', 'ver')
  async listar(
    @Query('usuarioId') usuarioId?: string,
    @Query('entidade') entidade?: string,
    @Query('entidadeId') entidadeId?: string,
    @Query('acao') acao?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('pagina') pagina = '1',
  ) {
    const f: SQL[] = [];
    const uuid = /^[0-9a-f-]{36}$/i;
    const data = /^\d{4}-\d{2}-\d{2}$/;
    if (usuarioId && uuid.test(usuarioId)) f.push(eq(auditoria.usuarioId, usuarioId));
    if (entidade) f.push(eq(auditoria.entidade, entidade));
    if (entidadeId) f.push(eq(auditoria.entidadeId, entidadeId));
    if (acao) f.push(eq(auditoria.acao, acao));
    if (de && data.test(de)) f.push(gte(auditoria.criadoEm, sql`(${de}::date at time zone 'America/Sao_Paulo')`));
    if (ate && data.test(ate)) f.push(lt(auditoria.criadoEm, sql`((${ate}::date + 1) at time zone 'America/Sao_Paulo')`));
    const p = Math.max(1, Math.min(500, Number(pagina) || 1));
    const tamanho = 100;
    const linhas = await this.db
      .select({ id: auditoria.id, criadoEm: auditoria.criadoEm, usuario: usuarios.nome, acao: auditoria.acao, entidade: auditoria.entidade, entidadeId: auditoria.entidadeId, dados: auditoria.dados })
      .from(auditoria)
      .leftJoin(usuarios, eq(usuarios.id, auditoria.usuarioId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(desc(auditoria.criadoEm))
      .limit(tamanho + 1)
      .offset((p - 1) * tamanho);
    return { pagina: p, temMais: linhas.length > tamanho, linhas: linhas.slice(0, tamanho) };
  }

  @Get('filtros')
  @Permissao('configuracoes', 'ver')
  async filtros() {
    const ent = await this.db.selectDistinct({ v: auditoria.entidade }).from(auditoria).orderBy(auditoria.entidade);
    const ac = await this.db.selectDistinct({ v: auditoria.acao }).from(auditoria).orderBy(auditoria.acao);
    const us = await this.db.select({ id: usuarios.id, nome: usuarios.nome }).from(usuarios).orderBy(usuarios.nome);
    return { entidades: ent.map((e) => e.v), acoes: ac.map((a) => a.v), usuarios: us };
  }
}
