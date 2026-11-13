import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { notasFiscais, pessoas, regrasFiscais } from '../db/schema';
import { FiscalService } from './fiscal.service';

@Controller('fiscal')
export class FiscalController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: FiscalService, private readonly auditoria: AuditoriaService) {}

  @Get('notas')
  @Permissao('fiscal', 'ver')
  async notas(@Query('status') status?: string, @Query('origemId') origemId?: string) {
    const f: SQL[] = [];
    if (status) f.push(eq(notasFiscais.status, status as 'autorizada'));
    if (origemId) f.push(eq(notasFiscais.origemId, origemId));
    return this.db
      .select({ id: notasFiscais.id, modelo: notasFiscais.modelo, operacao: notasFiscais.operacao, status: notasFiscais.status, numero: notasFiscais.numero, serie: notasFiscais.serie, chave: notasFiscais.chave, valor: notasFiscais.valor, mensagem: notasFiscais.mensagem, urlDanfe: notasFiscais.urlDanfe, urlXml: notasFiscais.urlXml, origemTipo: notasFiscais.origemTipo, origemId: notasFiscais.origemId, destinatario: pessoas.nome, criadoEm: notasFiscais.criadoEm })
      .from(notasFiscais)
      .leftJoin(pessoas, eq(pessoas.id, notasFiscais.destinatarioId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(desc(notasFiscais.criadoEm))
      .limit(300);
  }

  @Get('situacao')
  situacao() {
    return { configurado: this.svc.configurado, ambiente: this.svc.ambiente };
  }

  @Get('regras')
  @Permissao('fiscal', 'ver')
  regras() {
    return this.svc.regras();
  }

  @Put('regras/:operacao')
  @Permissao('configuracoes', 'editar')
  async salvarRegra(@Usuario() u: UsuarioLogado, @Param('operacao') operacao: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        natureza: z.string().min(3).max(60),
        cfopDentro: z.string().regex(/^\d{4}$/, 'CFOP com 4 números'),
        cfopFora: z.string().regex(/^\d{4}$/, 'CFOP com 4 números'),
        csosn: z.string().regex(/^\d{3}$/, 'CSOSN com 3 números'),
        base: z.enum(['venda', 'custo']).default('venda'),
        observacao: z.string().max(300).nullable().optional(),
      }),
      body,
    );
    const [r] = await this.db.insert(regrasFiscais).values({ operacao, ...d }).onConflictDoUpdate({ target: regrasFiscais.operacao, set: { ...d, atualizadoEm: new Date() } }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'regra_fiscal', entidadeId: operacao, dados: d });
    return r;
  }

  @Post('nfce/venda/:id')
  @Permissao('fiscal', 'criar')
  nfce(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.emitirNfce(id, u.id);
  }

  @Post('nfe/maleta/:id')
  @Permissao('fiscal', 'criar')
  remessa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.emitirRemessaMaleta(id, u.id);
  }

  @Post('nfe/acerto/:id')
  @Permissao('fiscal', 'criar')
  acerto(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { operacao } = validar(z.object({ operacao: z.enum(['retorno_consignacao', 'venda_consignacao']) }), body);
    return this.svc.emitirAcerto(id, operacao, u.id);
  }

  @Post('notas/:id/consultar')
  @Permissao('fiscal', 'ver')
  consultar(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.consultar(id);
  }

  @Post('notas/:id/reenviar')
  @Permissao('fiscal', 'criar')
  reenviar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.reenviar(id, u.id);
  }

  @Post('notas/:id/cancelar')
  @Permissao('fiscal', 'excluir')
  cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { justificativa } = validar(z.object({ justificativa: z.string().min(15, 'A SEFAZ exige justificativa com pelo menos 15 caracteres').max(255) }), body);
    return this.svc.cancelar(id, justificativa, u.id);
  }
}
