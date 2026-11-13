import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { importacoes, usuarios } from '../db/schema';
import { ALIASES_PESSOA, ALIASES_PRODUTO, ImportacaoService } from './importacao.service';

const linhas = z.array(z.record(z.string(), z.unknown())).min(1, 'Planilha vazia').max(30_000, 'Divida a planilha em partes de até 30 mil linhas');

@Controller('importacao')
export class ImportacaoController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: ImportacaoService) {}

  @Get('colunas')
  colunas() {
    return { produtos: ALIASES_PRODUTO, pessoas: ALIASES_PESSOA };
  }

  @Get('historico')
  @Permissao('configuracoes', 'ver')
  historico() {
    return this.db
      .select({ id: importacoes.id, tipo: importacoes.tipo, arquivo: importacoes.arquivo, linhas: importacoes.linhas, criados: importacoes.criados, atualizados: importacoes.atualizados, erros: importacoes.erros, usuario: usuarios.nome, criadoEm: importacoes.criadoEm })
      .from(importacoes)
      .leftJoin(usuarios, eq(usuarios.id, importacoes.usuarioId))
      .orderBy(desc(importacoes.criadoEm))
      .limit(50);
  }

  @Post('produtos')
  @Permissao('produtos', 'criar')
  produtos(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ linhas, localId: z.string().uuid().nullable().optional(), simular: z.boolean().default(true), arquivo: z.string().max(200).optional() }), body);
    return this.svc.produtos(d.linhas, d, u.id);
  }

  @Post('pessoas')
  @Permissao('cadastros', 'criar')
  pessoas(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ tipo: z.enum(['representante', 'cliente', 'fornecedor']), linhas, simular: z.boolean().default(true), arquivo: z.string().max(200).optional() }), body);
    return this.svc.pessoas(d.tipo, d.linhas, d, u.id);
  }
}
