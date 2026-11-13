import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { lotesBanho, ordensServico, pessoas, produtos, servicos } from '../db/schema';
import { GarantiaService } from './garantia.service';
import { hoje } from '../maletas/maletas.service';

const osSchema = z.object({
  tipo: z.enum(['garantia', 'conserto']),
  clienteId: z.string().uuid().nullable().optional(),
  representanteId: z.string().uuid().nullable().optional(),
  codigoProduto: z.string().trim().max(40).nullable().optional(),
  vendaId: z.string().uuid().nullable().optional(),
  maletaId: z.string().uuid().nullable().optional(),
  vendaNumero: z.number().int().positive().nullable().optional(),
  maletaNumero: z.number().int().positive().nullable().optional(),
  dataCompra: dataISO.nullable().optional(),
  defeito: z.string().trim().min(3, 'Descreva o defeito').max(1000),
  prestadorId: z.string().uuid().nullable().optional(),
  servicoId: z.string().uuid().nullable().optional(),
  valor: centavos.optional(),
  previsao: dataISO.nullable().optional(),
  observacao: z.string().max(1000).nullable().optional(),
});

@Controller('garantia')
export class GarantiaController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: GarantiaService, private readonly auditoria: AuditoriaService) {}

  @Get('ordens')
  @Permissao('garantia', 'ver')
  listar(@Query('status') status?: string, @Query('tipo') tipo?: string) {
    const cliente = alias(pessoas, 'cliente');
    const rep = alias(pessoas, 'rep');
    const prestador = alias(pessoas, 'prestador');
    const f: SQL[] = [];
    if (status === 'abertas') f.push(inArray(ordensServico.status, ['aberta', 'na_assistencia']));
    else if (status) f.push(eq(ordensServico.status, status));
    if (tipo) f.push(eq(ordensServico.tipo, tipo));
    return this.db
      .select({
        id: ordensServico.id,
        numero: ordensServico.numero,
        tipo: ordensServico.tipo,
        status: ordensServico.status,
        decisao: ordensServico.decisao,
        defeito: ordensServico.defeito,
        cliente: cliente.nome,
        representante: rep.nome,
        prestador: prestador.nome,
        produto: produtos.descricao,
        referencia: produtos.referencia,
        dataCompra: ordensServico.dataCompra,
        garantiaAte: ordensServico.garantiaAte,
        previsao: ordensServico.previsao,
        valor: ordensServico.valor,
        criadoEm: ordensServico.criadoEm,
      })
      .from(ordensServico)
      .leftJoin(cliente, eq(cliente.id, ordensServico.clienteId))
      .leftJoin(rep, eq(rep.id, ordensServico.representanteId))
      .leftJoin(prestador, eq(prestador.id, ordensServico.prestadorId))
      .leftJoin(produtos, eq(produtos.id, ordensServico.produtoId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(desc(ordensServico.criadoEm))
      .limit(300);
  }

  @Get('ordens/:id')
  @Permissao('garantia', 'ver')
  async obter(@Param('id', ParseUUIDPipe) id: string) {
    const cliente = alias(pessoas, 'cliente');
    const rep = alias(pessoas, 'rep');
    const prestador = alias(pessoas, 'prestador');
    const troca = alias(produtos, 'troca');
    const [r] = await this.db
      .select({ os: ordensServico, cliente: cliente.nome, clienteTelefone: cliente.telefone1, representante: rep.nome, prestador: prestador.nome, produto: produtos.descricao, referencia: produtos.referencia, codigoBarras: produtos.codigoBarras, troca: troca.descricao, servico: servicos.descricao })
      .from(ordensServico)
      .leftJoin(cliente, eq(cliente.id, ordensServico.clienteId))
      .leftJoin(rep, eq(rep.id, ordensServico.representanteId))
      .leftJoin(prestador, eq(prestador.id, ordensServico.prestadorId))
      .leftJoin(produtos, eq(produtos.id, ordensServico.produtoId))
      .leftJoin(troca, eq(troca.id, ordensServico.produtoTrocaId))
      .leftJoin(servicos, eq(servicos.id, ordensServico.servicoId))
      .where(eq(ordensServico.id, id));
    if (!r) throw new NotFoundException('Ordem não encontrada.');
    const { os, ...extra } = r;
    return { ...os, ...extra, dentroDoPrazo: os.garantiaAte ? os.garantiaAte >= hoje() : null };
  }

  @Post('ordens')
  @Permissao('garantia', 'criar')
  criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    return this.svc.criar(validar(osSchema, body), u.id);
  }

  @Post('ordens/:id/assistencia')
  @Permissao('garantia', 'editar')
  assistencia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ prestadorId: z.string().uuid('Escolha a assistência'), previsao: dataISO.nullable().optional() }), body);
    return this.svc.enviarAssistencia(id, d.prestadorId, d.previsao ?? null, u.id);
  }

  @Post('ordens/:id/decisao')
  @Permissao('garantia', 'editar')
  decidir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ decisao: z.enum(['troca', 'conserto', 'devolucao_fornecedor', 'recusada']), motivo: z.string().max(500).nullable().optional(), codigoTroca: z.string().max(40).nullable().optional(), localId: z.string().uuid().nullable().optional(), receberPeca: z.boolean().default(true) }), body);
    return this.svc.decidir(id, d, u.id);
  }

  @Post('ordens/:id/concluir')
  @Permissao('garantia', 'editar')
  concluir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ valorPago: centavos.default(0), formaPagamento: z.string().max(30).nullable().optional() }), body);
    return this.svc.concluir(id, d.valorPago, d.formaPagamento ?? null, u.id);
  }

  @Post('ordens/:id/cancelar')
  @Permissao('garantia', 'excluir')
  cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.cancelar(id, validar(z.object({ motivo: z.string().min(3, 'Informe o motivo') }), body).motivo, u.id);
  }

  // ───── Serviços (tabela de preços de conserto) ─────

  @Get('servicos')
  servicos() {
    return this.db.select().from(servicos).orderBy(asc(servicos.descricao));
  }

  @Post('servicos')
  @Permissao('garantia', 'criar')
  async criarServico(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const [s] = await this.db.insert(servicos).values(validar(z.object({ descricao: z.string().trim().min(2).max(120), valor: centavos.default(0) }), body)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'servico', entidadeId: s.id });
    return s;
  }

  @Patch('servicos/:id')
  @Permissao('garantia', 'editar')
  async editarServico(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [s] = await this.db.update(servicos).set(validar(z.object({ descricao: z.string().trim().min(2).max(120).optional(), valor: centavos.optional(), ativo: z.boolean().optional() }), body)).where(eq(servicos.id, id)).returning();
    if (!s) throw new NotFoundException('Serviço não encontrado.');
    return s;
  }
}

/** Lotes de banho: rastreia de qual banho veio cada peça (útil na garantia). */
@Controller('lotes')
export class LotesController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('produtos', 'ver')
  listar() {
    return this.db
      .select({ id: lotesBanho.id, codigo: lotesBanho.codigo, fornecedor: pessoas.nome, fornecedorId: lotesBanho.fornecedorId, fabricacao: lotesBanho.fabricacao, validade: lotesBanho.validade, observacao: lotesBanho.observacao })
      .from(lotesBanho)
      .leftJoin(pessoas, eq(pessoas.id, lotesBanho.fornecedorId))
      .orderBy(desc(lotesBanho.criadoEm));
  }

  @Post()
  @Permissao('produtos', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ codigo: z.string().trim().min(1).max(40), fornecedorId: z.string().uuid().nullable().optional(), fabricacao: dataISO.nullable().optional(), validade: dataISO.nullable().optional(), observacao: z.string().max(300).nullable().optional() }), body);
    const [l] = await this.db.insert(lotesBanho).values(d).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'lote_banho', entidadeId: l.id });
    return l;
  }
}
