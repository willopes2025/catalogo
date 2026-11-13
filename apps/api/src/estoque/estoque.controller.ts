import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { categorias, locaisEstoque, maletas, movimentos, pessoas, produtos, saldos, usuarios, empresas } from '../db/schema';
import { EstoqueService } from './estoque.service';

const itensSchema = z.array(z.object({ codigoBarras: z.string().min(1), quantidade: z.number().int().positive() })).min(1, 'Inclua ao menos um item');

const entradaSchema = z.object({ destinoId: z.string().uuid(), motivo: z.string().max(300).optional(), chaveNota: z.string().max(60).optional(), itens: itensSchema });
const ajusteSchema = z.object({
  localId: z.string().uuid(),
  motivo: z.string().min(3, 'Informe o motivo do ajuste').max(300),
  itens: z.array(z.object({ codigoBarras: z.string().min(1), quantidadeContada: z.number().int().min(0) })).min(1),
});
const transferenciaSchema = z.object({ origemId: z.string().uuid(), destinoId: z.string().uuid(), motivo: z.string().max(300).optional(), itens: itensSchema });

@Controller('estoque')
export class EstoqueController {
  constructor(@Inject(DB) private readonly db: Db, private readonly estoque: EstoqueService, private readonly auditoria: AuditoriaService) {}

  /** Entrada, ajuste e transferência não mexem em maleta: maleta só muda pela própria tela (incluir, retirar, acerto). */
  private async exigirLocaisComuns(...ids: string[]) {
    const ls = await this.db.select({ id: locaisEstoque.id, tipo: locaisEstoque.tipo, ativo: locaisEstoque.ativo }).from(locaisEstoque).where(inArray(locaisEstoque.id, ids));
    for (const id of ids) {
      const l = ls.find((x) => x.id === id);
      if (!l || !l.ativo) throw new BadRequestException('Local de estoque inválido.');
      if (l.tipo === 'maleta') throw new BadRequestException('O estoque de uma maleta só muda pela própria maleta (incluir, retirar ou acerto).');
    }
  }

  @Get('locais')
  @Permissao('estoque', 'ver')
  locais(@Query('incluirMaletas') incluirMaletas?: string) {
    return this.db
      .select({ id: locaisEstoque.id, nome: locaisEstoque.nome, tipo: locaisEstoque.tipo, empresa: empresas.nome, empresaId: empresas.id })
      .from(locaisEstoque)
      .innerJoin(empresas, eq(empresas.id, locaisEstoque.empresaId))
      .where(and(eq(locaisEstoque.ativo, true), incluirMaletas ? undefined : ne(locaisEstoque.tipo, 'maleta')))
      .orderBy(asc(locaisEstoque.nome));
  }

  /** Resumo por local: peças e valor a custo e a preço de venda. */
  @Get('resumo')
  @Permissao('estoque', 'ver')
  async resumo() {
    const porLocal = await this.db
      .select({
        localId: locaisEstoque.id,
        nome: locaisEstoque.nome,
        tipo: locaisEstoque.tipo,
        pecas: sql<number>`coalesce(sum(${saldos.quantidade}),0)::int`,
        valorCusto: sql<number>`coalesce(sum(${saldos.quantidade} * ${produtos.custo}),0)::bigint`,
        valorVenda: sql<number>`coalesce(sum(${saldos.quantidade} * ${produtos.preco}),0)::bigint`,
      })
      .from(locaisEstoque)
      .leftJoin(saldos, eq(saldos.localId, locaisEstoque.id))
      .leftJoin(produtos, eq(produtos.id, saldos.produtoId))
      .where(ne(locaisEstoque.tipo, 'maleta'))
      .groupBy(locaisEstoque.id);
    const [emMaletas] = await this.db
      .select({
        pecas: sql<number>`coalesce(sum(${saldos.quantidade}),0)::int`,
        valorCusto: sql<number>`coalesce(sum(${saldos.quantidade} * ${produtos.custo}),0)::bigint`,
        valorVenda: sql<number>`coalesce(sum(${saldos.quantidade} * ${produtos.preco}),0)::bigint`,
      })
      .from(saldos)
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, saldos.localId))
      .innerJoin(produtos, eq(produtos.id, saldos.produtoId))
      .where(eq(locaisEstoque.tipo, 'maleta'));
    const num = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v]));
    return { locais: porLocal.map(num), emMaletas: num(emMaletas) };
  }

  /** Tudo o que o sistema diz que há no local, para conferir no inventário. */
  @Get('inventario/:localId')
  @Permissao('estoque', 'ver')
  inventario(@Param('localId', ParseUUIDPipe) localId: string) {
    return this.db
      .select({ produtoId: produtos.id, codigoBarras: produtos.codigoBarras, referencia: produtos.referencia, descricao: produtos.descricao, preco: produtos.preco, quantidade: saldos.quantidade })
      .from(saldos)
      .innerJoin(produtos, eq(produtos.id, saldos.produtoId))
      .where(and(eq(saldos.localId, localId), ne(saldos.quantidade, 0)))
      .orderBy(asc(produtos.descricao));
  }

  @Get('saldos')
  @Permissao('estoque', 'ver')
  async saldos(@Query('localId') localId?: string, @Query('busca') busca?: string, @Query('critico') critico?: string) {
    const filtros = [eq(produtos.ativo, true)];
    if (busca?.trim()) {
      const b = `%${busca.trim()}%`;
      filtros.push(or(ilike(produtos.descricao, b), ilike(produtos.referencia, b), eq(produtos.codigoBarras, busca.trim()))!);
    }
    const total = localId
      ? sql<number>`coalesce((select quantidade from ${saldos} s where s.produto_id = ${produtos.id} and s.local_id = ${localId}),0)::int`
      : sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo <> 'maleta'),0)::int`;
    const emMaletas = sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo = 'maleta'),0)::int`;
    let q = this.db
      .select({
        id: produtos.id,
        codigoBarras: produtos.codigoBarras,
        referencia: produtos.referencia,
        descricao: produtos.descricao,
        categoria: categorias.nome,
        preco: produtos.preco,
        custo: produtos.custo,
        estoqueMinimo: produtos.estoqueMinimo,
        quantidade: total,
        emMaletas,
      })
      .from(produtos)
      .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
      .where(and(...filtros))
      .orderBy(asc(produtos.descricao))
      .limit(300)
      .$dynamic();
    const linhas = await q;
    return critico ? linhas.filter((l) => l.quantidade <= l.estoqueMinimo) : linhas;
  }

  /** Rastreio da peça: todo o caminho de um produto. */
  @Get('rastreio/:codigo')
  @Permissao('estoque', 'ver')
  async rastreio(@Param('codigo') codigo: string) {
    const [p] = await this.db.select().from(produtos).where(or(eq(produtos.codigoBarras, codigo), eq(produtos.referencia, codigo)));
    if (!p) throw new NotFoundException('Produto não encontrado.');
    const origem = alias(locaisEstoque, 'origem');
    const destino = alias(locaisEstoque, 'destino');
    const historico = await this.db
      .select({
        id: movimentos.id,
        criadoEm: movimentos.criadoEm,
        tipo: movimentos.tipo,
        quantidade: movimentos.quantidade,
        origem: origem.nome,
        destino: destino.nome,
        motivo: movimentos.motivo,
        referenciaTipo: movimentos.referenciaTipo,
        referenciaId: movimentos.referenciaId,
        usuario: usuarios.nome,
      })
      .from(movimentos)
      .leftJoin(origem, eq(origem.id, movimentos.origemId))
      .leftJoin(destino, eq(destino.id, movimentos.destinoId))
      .leftJoin(usuarios, eq(usuarios.id, movimentos.usuarioId))
      .where(eq(movimentos.produtoId, p.id))
      .orderBy(desc(movimentos.criadoEm))
      .limit(200);
    const porLocal = await this.db
      .select({ local: locaisEstoque.nome, tipo: locaisEstoque.tipo, quantidade: saldos.quantidade, representante: pessoas.nome, maletaNumero: maletas.numero })
      .from(saldos)
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, saldos.localId))
      .leftJoin(maletas, eq(maletas.localId, locaisEstoque.id))
      .leftJoin(pessoas, eq(pessoas.id, maletas.representanteId))
      .where(and(eq(saldos.produtoId, p.id), ne(saldos.quantidade, 0)));
    return { produto: p, porLocal, historico };
  }

  private async produtosPorCodigo(codigos: string[]) {
    const lista = await this.db.select({ id: produtos.id, codigoBarras: produtos.codigoBarras }).from(produtos);
    const mapa = new Map(lista.map((p) => [p.codigoBarras, p.id]));
    const faltando = codigos.filter((c) => !mapa.has(c));
    if (faltando.length) throw new NotFoundException(`Código(s) não cadastrado(s): ${faltando.join(', ')}`);
    return mapa;
  }

  @Post('entradas')
  @Permissao('estoque', 'criar')
  async entrada(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(entradaSchema, body);
    await this.exigirLocaisComuns(d.destinoId);
    const mapa = await this.produtosPorCodigo(d.itens.map((i) => i.codigoBarras));
    const motivo = [d.motivo, d.chaveNota && `NF ${d.chaveNota}`].filter(Boolean).join(' · ') || 'Entrada de mercadoria';
    await this.db.transaction(async (tx) => {
      for (const i of d.itens) {
        await this.estoque.mover(tx, { produtoId: mapa.get(i.codigoBarras)!, destinoId: d.destinoId, quantidade: i.quantidade, tipo: 'entrada', motivo, usuarioId: u.id });
      }
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'entrada', entidade: 'estoque', dados: { destinoId: d.destinoId, itens: d.itens.length } }, tx);
    });
    return { ok: true, pecas: d.itens.reduce((a, i) => a + i.quantidade, 0) };
  }

  /** Ajuste por contagem: informa quanto há de fato; o sistema lança a diferença. */
  @Post('ajustes')
  @Permissao('estoque', 'editar')
  async ajuste(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(ajusteSchema, body);
    await this.exigirLocaisComuns(d.localId);
    const mapa = await this.produtosPorCodigo(d.itens.map((i) => i.codigoBarras));
    const diferencas: { codigoBarras: string; antes: number; depois: number }[] = [];
    await this.db.transaction(async (tx) => {
      for (const i of d.itens) {
        const produtoId = mapa.get(i.codigoBarras)!;
        const antes = await this.estoque.saldo(tx, produtoId, d.localId);
        const dif = i.quantidadeContada - antes;
        if (dif === 0) continue;
        await this.estoque.mover(tx, {
          produtoId,
          origemId: dif < 0 ? d.localId : null,
          destinoId: dif > 0 ? d.localId : null,
          quantidade: Math.abs(dif),
          tipo: 'ajuste',
          motivo: d.motivo,
          usuarioId: u.id,
        });
        diferencas.push({ codigoBarras: i.codigoBarras, antes, depois: i.quantidadeContada });
      }
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'ajuste', entidade: 'estoque', dados: { localId: d.localId, motivo: d.motivo, diferencas } }, tx);
    });
    return { ok: true, diferencas };
  }

  @Post('transferencias')
  @Permissao('estoque', 'criar')
  async transferencia(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(transferenciaSchema, body);
    if (d.origemId === d.destinoId) throw new BadRequestException('Origem e destino são o mesmo local.');
    await this.exigirLocaisComuns(d.origemId, d.destinoId);
    const mapa = await this.produtosPorCodigo(d.itens.map((i) => i.codigoBarras));
    await this.db.transaction(async (tx) => {
      for (const i of d.itens) {
        await this.estoque.mover(tx, { produtoId: mapa.get(i.codigoBarras)!, origemId: d.origemId, destinoId: d.destinoId, quantidade: i.quantidade, tipo: 'transferencia', motivo: d.motivo ?? 'Transferência', usuarioId: u.id });
      }
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'transferencia', entidade: 'estoque', dados: d }, tx);
    });
    return { ok: true };
  }
}
