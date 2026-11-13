import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { Publico } from '../comum/auth';
import { categorias, maletaItens, maletas, pessoas, produtos } from '../db/schema';

/**
 * Catálogo simples da representante (substitui nome.aritanaonline.com.br do Jueri na Versão 1).
 * Mostra as peças que ela tem na maleta aberta, com preço de etiqueta. Nunca mostra custo nem dados pessoais além do nome, cidade e WhatsApp.
 */
@Controller('publico/catalogo')
export class CatalogoController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Publico()
  @Get(':slug')
  async ver(@Param('slug') slug: string) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new NotFoundException('Catálogo não encontrado.');
    const [rep] = await this.db
      .select({ id: pessoas.id, nome: pessoas.nome, cidade: pessoas.cidade, uf: pessoas.uf, whatsapp: pessoas.telefone1, instagram: pessoas.instagram })
      .from(pessoas)
      .where(and(eq(pessoas.slug, slug), eq(pessoas.tipo, 'representante'), eq(pessoas.status, 'ativo')));
    if (!rep) throw new NotFoundException('Catálogo não encontrado.');
    const disponivel = sql<number>`sum(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})::int`;
    const pecas = await this.db
      .select({
        id: produtos.id,
        referencia: produtos.referencia,
        descricao: produtos.descricao,
        categoria: categorias.nome,
        cor: produtos.cor,
        tamanho: produtos.tamanho,
        preco: produtos.preco,
        foto: sql<string | null>`${produtos.fotos}->>0`,
        disponivel,
      })
      .from(maletaItens)
      .innerJoin(maletas, eq(maletas.id, maletaItens.maletaId))
      .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
      .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
      .where(and(eq(maletas.representanteId, rep.id), eq(maletas.status, 'aberta'), eq(produtos.exibeCatalogo, true), eq(produtos.ativo, true)))
      .groupBy(produtos.id, categorias.nome)
      .having(sql`${disponivel} > 0`)
      .orderBy(asc(categorias.nome), asc(produtos.descricao));
    const { id, ...publico } = rep;
    void id;
    return { representante: { ...publico, nome: rep.nome }, pecas };
  }
}
