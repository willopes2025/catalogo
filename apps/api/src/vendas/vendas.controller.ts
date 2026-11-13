import { Body, Controller, ForbiddenException, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { caixas, configuracoes, locaisEstoque, pessoas, usuarios, vendas } from '../db/schema';
import { FORMAS, VendasService } from './vendas.service';

const vendaSchema = z.object({
  localId: z.string().uuid('Escolha o ponto de venda'),
  tipo: z.enum(['balcao', 'avulsa', 'revenda']).default('balcao'),
  clienteId: z.string().uuid().nullable().optional(),
  itens: z.array(z.object({ codigoBarras: z.string().min(1), quantidade: z.number().int().positive(), desconto: centavos.optional() })).min(1, 'Inclua ao menos uma peça'),
  descontoTotal: centavos.optional(),
  pagamentos: z.array(z.object({ forma: z.enum(FORMAS), valor: centavos.refine((v) => v > 0, 'Valor do pagamento'), parcelas: z.number().int().min(1).max(12).optional(), maquininha: z.string().max(40).nullable().optional(), autorizacao: z.string().max(40).nullable().optional() })).min(1, 'Informe o pagamento'),
  observacao: z.string().max(500).nullable().optional(),
});

@Controller()
export class VendasController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: VendasService, private readonly auditoria: AuditoriaService) {}

  private exigir(u: UsuarioLogado, tipo: string, acao: string) {
    const modulo = tipo === 'balcao' ? 'lojas' : 'vendas';
    if (!temPermissao(u.permissoes, modulo, acao)) throw new ForbiddenException('Você não tem permissão para esta ação.');
  }

  // ───── Caixa ─────

  @Get('caixas/atual')
  @Permissao('lojas', 'ver')
  async atual(@Query('localId', ParseUUIDPipe) localId: string) {
    const c = await this.svc.caixaAberto(localId);
    return c ? { aberto: true, ...c, ...(await this.svc.resumoCaixa(c.id)) } : { aberto: false };
  }

  @Get('caixas')
  @Permissao('lojas', 'ver')
  historico(@Query('localId') localId?: string) {
    return this.db
      .select({ id: caixas.id, local: locaisEstoque.nome, status: caixas.status, abertoEm: caixas.abertoEm, fechadoEm: caixas.fechadoEm, valorAbertura: caixas.valorAbertura, diferenca: caixas.diferenca, abertoPor: usuarios.nome, esperado: caixas.esperado, contado: caixas.contado })
      .from(caixas)
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, caixas.localId))
      .leftJoin(usuarios, eq(usuarios.id, caixas.abertoPor))
      .where(localId ? eq(caixas.localId, localId) : undefined)
      .orderBy(desc(caixas.abertoEm))
      .limit(60);
  }

  @Post('caixas/abrir')
  @Permissao('lojas', 'criar')
  abrir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ localId: z.string().uuid(), valorAbertura: centavos.default(0) }), body);
    return this.svc.abrirCaixa(d.localId, d.valorAbertura, u.id);
  }

  @Post('caixas/:id/movimento')
  @Permissao('lojas', 'criar')
  movimento(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ tipo: z.enum(['sangria', 'reforco']), valor: centavos.refine((v) => v > 0, 'Informe o valor'), descricao: z.string().min(3, 'Informe o motivo').max(200) }), body);
    return this.svc.movimentarCaixa(id, d.tipo, d.valor, d.descricao, u.id);
  }

  @Post('caixas/:id/fechar')
  @Permissao('lojas', 'criar')
  fechar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ contado: z.record(z.string(), z.number().int()), observacao: z.string().max(500).nullable().optional() }), body);
    return this.svc.fecharCaixa(id, d.contado, d.observacao ?? null, u.id);
  }

  // ───── Vendas ─────

  @Get('vendas')
  async listar(@Usuario() u: UsuarioLogado, @Query('tipo') tipo?: string, @Query('aba') aba = 'concluidas', @Query('de') de?: string, @Query('ate') ate?: string, @Query('caixaId') caixaId?: string) {
    if (!temPermissao(u.permissoes, 'vendas', 'ver') && !temPermissao(u.permissoes, 'lojas', 'ver')) throw new ForbiddenException('Sem permissão.');
    const f: SQL[] = [eq(vendas.status, aba === 'canceladas' ? 'cancelada' : 'concluida')];
    if (tipo) f.push(eq(vendas.tipo, tipo));
    if (de) f.push(gte(vendas.criadoEm, new Date(`${de}T00:00:00-03:00`)));
    if (ate) f.push(lte(vendas.criadoEm, new Date(`${ate}T23:59:59-03:00`)));
    if (caixaId) f.push(eq(vendas.caixaId, caixaId));
    const itens = await this.db
      .select({ id: vendas.id, numero: vendas.numero, tipo: vendas.tipo, criadoEm: vendas.criadoEm, cliente: pessoas.nome, local: locaisEstoque.nome, vendedor: usuarios.nome, subtotal: vendas.subtotal, desconto: vendas.desconto, total: vendas.total, status: vendas.status })
      .from(vendas)
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, vendas.localId))
      .leftJoin(pessoas, eq(pessoas.id, vendas.clienteId))
      .leftJoin(usuarios, eq(usuarios.id, vendas.vendedorId))
      .where(and(...f))
      .orderBy(desc(vendas.criadoEm))
      .limit(300);
    return { itens, total: itens.reduce((a, v) => a + v.total, 0) };
  }

  @Get('vendas/:id')
  obter(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    if (!temPermissao(u.permissoes, 'vendas', 'ver') && !temPermissao(u.permissoes, 'lojas', 'ver')) throw new ForbiddenException('Sem permissão.');
    return this.svc.obter(id);
  }

  @Post('vendas')
  registrar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(vendaSchema, body);
    this.exigir(u, d.tipo, 'criar');
    return this.svc.registrar(d, u.id, temPermissao(u.permissoes, 'configuracoes', 'editar'));
  }

  @Post('vendas/:id/cancelar')
  async cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const v = await this.svc.obter(id);
    this.exigir(u, v.tipo, 'excluir');
    return this.svc.cancelar(id, validar(z.object({ motivo: z.string().min(3, 'Informe o motivo') }), body).motivo, u.id);
  }

  @Post('vendas/:id/devolver')
  async devolver(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const v = await this.svc.obter(id);
    this.exigir(u, v.tipo, 'editar');
    const d = validar(z.object({ itens: z.array(z.object({ produtoId: z.string().uuid(), quantidade: z.number().int().positive() })).min(1), destino: z.enum(['credito', 'dinheiro']) }), body);
    return this.svc.devolver(id, d.itens, d.destino, u.id);
  }

  // ───── Regras de venda ─────

  @Get('configuracoes/regras-venda')
  regras() {
    return this.svc.regras();
  }

  @Put('configuracoes/regras-venda')
  @Permissao('configuracoes', 'editar')
  async salvarRegras(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ descontoMaximoPb: z.number().int().min(0).max(10000), prazoTrocaDias: z.number().int().min(0).max(365), prazoDebitoDias: z.number().int().min(0).max(60), prazoCreditoDias: z.number().int().min(0).max(60) }), body);
    await this.db.insert(configuracoes).values({ chave: 'regras_venda', valor: d }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: d, atualizadoEm: new Date() } });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'regras_venda', dados: d });
    return d;
  }
}

export { sql, dataISO };
