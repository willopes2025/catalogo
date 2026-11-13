import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, opcional, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { proximoCodigoInterno } from '../comum/codigos';
import { categorias, locaisEstoque, pessoas, produtos, saldos } from '../db/schema';

const produtoSchema = z.object({
  codigoBarras: z.string().trim().max(30).optional(),
  referencia: z.string().trim().min(1, 'Informe a referência').max(40),
  descricao: z.string().trim().min(2, 'Informe a descrição').max(200),
  categoriaId: z.string().uuid().optional().nullable(),
  tamanho: opcional(30),
  cor: opcional(40),
  pesoBanho: opcional(40),
  milesimos: opcional(20),
  fornecedorId: z.string().uuid().optional().nullable(),
  codigoFornecedor: opcional(60),
  loteBanhoId: z.string().uuid().nullable().optional(),
  custo: centavos.default(0),
  preco: centavos.refine((v) => v > 0, 'Informe o preço de venda'),
  precoAtacado: centavos.optional().nullable(),
  descontoMaximoPb: z.number().int().min(0).max(10000).default(0),
  estoqueMinimo: z.number().int().min(0).default(0),
  localizacao: opcional(60),
  ncm: opcional(10),
  cfop: opcional(5),
  exibeCatalogo: z.boolean().default(true),
  ativo: z.boolean().default(true),
});


@Controller('produtos')
export class ProdutosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('produtos', 'ver')
  async listar(@Query('busca') busca?: string, @Query('categoriaId') categoriaId?: string, @Query('pagina') paginaQ = '1', @Query('inativos') inativos?: string) {
    const pagina = Math.max(1, Number(paginaQ) || 1);
    const porPagina = 50;
    const f: SQL[] = [];
    if (!inativos) f.push(eq(produtos.ativo, true));
    if (categoriaId) f.push(eq(produtos.categoriaId, categoriaId));
    if (busca?.trim()) {
      const b = `%${busca.trim()}%`;
      f.push(or(ilike(produtos.descricao, b), ilike(produtos.referencia, b), eq(produtos.codigoBarras, busca.trim()))!);
    }
    const where = f.length ? and(...f) : undefined;
    const itens = await this.db
      .select({
        id: produtos.id,
        codigoBarras: produtos.codigoBarras,
        referencia: produtos.referencia,
        descricao: produtos.descricao,
        categoria: categorias.nome,
        cor: produtos.cor,
        tamanho: produtos.tamanho,
        custo: produtos.custo,
        preco: produtos.preco,
        foto: sql<string | null>`${produtos.fotos}->>0`,
        ativo: produtos.ativo,
        estoque: sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo <> 'maleta'),0)::int`,
        emMaletas: sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo = 'maleta'),0)::int`,
      })
      .from(produtos)
      .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
      .where(where)
      .orderBy(asc(produtos.descricao))
      .limit(porPagina)
      .offset((pagina - 1) * porPagina);
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(produtos).where(where);
    return { itens, total, pagina, porPagina };
  }

  /** Busca pelo código lido no leitor. Usado na montagem da maleta e no caixa. */
  @Get('codigo/:codigo')
  @Permissao('produtos', 'ver')
  async porCodigo(@Param('codigo') codigo: string) {
    // Primeiro o código de barras (único). A referência pode se repetir entre variações (cor, tamanho).
    const [p] = await this.db.select().from(produtos).where(eq(produtos.codigoBarras, codigo));
    if (p) return p;
    const porRef = await this.db.select().from(produtos).where(and(eq(produtos.referencia, codigo), eq(produtos.ativo, true))).limit(2);
    if (porRef.length > 1) throw new BadRequestException(`A referência ${codigo} tem mais de uma peça (cores ou tamanhos). Bipe o código de barras.`);
    if (!porRef.length) throw new NotFoundException(`Código ${codigo} não cadastrado.`);
    return porRef[0];
  }

  @Get('categorias')
  categorias() {
    return this.db.select().from(categorias).orderBy(asc(categorias.nome));
  }

  @Get(':id')
  @Permissao('produtos', 'ver')
  async obter(@Param('id', ParseUUIDPipe) id: string) {
    const [p] = await this.db.select({ p: produtos, fornecedor: pessoas.nome }).from(produtos).leftJoin(pessoas, eq(pessoas.id, produtos.fornecedorId)).where(eq(produtos.id, id));
    if (!p) throw new NotFoundException('Produto não encontrado.');
    const estoque = await this.db
      .select({ local: locaisEstoque.nome, tipo: locaisEstoque.tipo, quantidade: saldos.quantidade })
      .from(saldos)
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, saldos.localId))
      .where(eq(saldos.produtoId, id));
    return { ...p.p, fornecedor: p.fornecedor, estoque };
  }

  @Post()
  @Permissao('produtos', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(produtoSchema, body);
    if (!d.codigoBarras) d.codigoBarras = await proximoCodigoInterno(this.db);
    const [p] = await this.db.insert(produtos).values({ ...d, codigoBarras: d.codigoBarras }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'produto', entidadeId: p.id });
    return p;
  }

  @Patch(':id')
  @Permissao('produtos', 'editar')
  async atualizar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(produtos).where(eq(produtos.id, id));
    if (!atual) throw new NotFoundException('Produto não encontrado.');
    const d = validar(produtoSchema, { ...atual, ...(body as object) });
    const [p] = await this.db.update(produtos).set({ ...d, codigoBarras: d.codigoBarras ?? atual.codigoBarras, atualizadoEm: new Date() }).where(eq(produtos.id, id)).returning();
    const precoMudou = atual.preco !== p.preco || atual.custo !== p.custo;
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'produto', entidadeId: id, dados: precoMudou ? { preco: [atual.preco, p.preco], custo: [atual.custo, p.custo] } : undefined });
    return p;
  }
}
