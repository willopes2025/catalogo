import { BadRequestException, Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { calcularPreco, metalDoTexto, type Metal } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { categorias, locaisEstoque, produtos, saldos } from '../db/schema';

const aplicarSchema = z.object({
  itens: z
    .array(
      z.object({
        id: z.string().uuid(),
        /** Peso da peça em gramas. */
        peso: z.number().min(0).max(100000).optional(),
        bruto: centavos.optional(),
        insumos: centavos.optional(),
        metal: z.enum(['ouro', 'prata']).optional(),
        /** Centavos por grama, quando esta peça foge do coeficiente padrão. */
        coeficiente: z.number().min(0).max(1_000_000).optional(),
        /** Novo preço de venda. Sem ele, o preço não muda. */
        preco: centavos.refine((v) => v > 0, 'O preço precisa ser maior que zero').optional(),
      }),
    )
    .min(1, 'Nada para aplicar')
    .max(500, 'Aplique no máximo 500 peças por vez'),
});

type Produto = typeof produtos.$inferSelect;

/**
 * Precificação: a planilha de preços da Aritana dentro do sistema.
 * Lista as peças com peso, custo bruto, banho, custo total e preço sugerido pela fórmula;
 * quem precifica ajusta e aplica o novo preço em várias peças de uma vez.
 */
@Controller('precificacao')
export class PrecificacaoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** O que a tela mostra de cada peça, já com a conta feita quando há peso e metal. */
  private linha(p: Pick<Produto, 'id' | 'codigoBarras' | 'referencia' | 'descricao' | 'cor' | 'tipoBanho' | 'custo' | 'preco' | 'custos' | 'medidas'>, regras: Awaited<ReturnType<PrecificacaoController['regras']>>) {
    const custos = p.custos ?? {};
    const peso = Number(p.medidas?.peso) || 0;
    const metal: Metal | null = custos.banhoOuro > 0 && !(custos.banhoPrata > 0) ? 'ouro' : custos.banhoPrata > 0 && !(custos.banhoOuro > 0) ? 'prata' : metalDoTexto(p.tipoBanho, p.cor, p.descricao);
    const banhoAtual = metal === 'ouro' ? custos.banhoOuro : metal === 'prata' ? custos.banhoPrata : undefined;
    // Peça que já tem banho gravado guarda o coeficiente com que foi precificada.
    const coeficiente = metal && peso > 0 && banhoAtual && banhoAtual > 0 ? Math.round((banhoAtual / peso) * 100) / 100 : null;
    const bruto = custos.bruto ?? 0;
    const insumos = custos.insumos ?? null;
    const calculo = metal && peso > 0 ? calcularPreco({ peso, bruto, metal, coeficiente, insumos }, regras) : null;
    return { id: p.id, codigoBarras: p.codigoBarras, referencia: p.referencia, descricao: p.descricao, cor: p.cor, tipoBanho: p.tipoBanho, peso, bruto, insumos, metal, coeficiente, custo: p.custo, preco: p.preco, calculo };
  }

  private regras() {
    return this.config.ler('precificacao');
  }

  @Get()
  @Permissao('produtos', 'ver')
  async listar(@Query('busca') busca?: string, @Query('categoriaId') categoriaId?: string, @Query('situacao') situacao?: string, @Query('pagina') paginaQ = '1') {
    const pagina = Math.max(1, Number(paginaQ) || 1);
    const porPagina = 100;
    const f: SQL[] = [eq(produtos.ativo, true)];
    if (categoriaId) {
      if (!/^[0-9a-f-]{36}$/i.test(categoriaId)) throw new BadRequestException('Categoria inválida.');
      // A categoria e tudo que está dentro dela.
      f.push(sql`${produtos.categoriaId} in (with recursive c as (select id from categorias where id = ${categoriaId}::uuid union all select x.id from categorias x join c on x.pai_id = c.id) select id from c)`);
    }
    if (busca?.trim()) {
      const b = `%${busca.trim()}%`;
      f.push(or(ilike(produtos.descricao, b), ilike(produtos.referencia, b), eq(produtos.codigoBarras, busca.trim()))!);
    }
    const temPeso = sql`coalesce((${produtos.medidas}->>'peso')::numeric, 0) > 0`;
    if (situacao === 'sem_peso') f.push(sql`not ${temPeso}`);
    if (situacao === 'com_peso') f.push(temPeso);
    if (situacao === 'com_estoque') f.push(sql`exists (select 1 from ${saldos} s where s.produto_id = ${produtos.id} and s.quantidade > 0)`);
    const where = and(...f);
    const regras = await this.regras();
    const linhas = await this.db
      .select({
        id: produtos.id,
        codigoBarras: produtos.codigoBarras,
        referencia: produtos.referencia,
        descricao: produtos.descricao,
        cor: produtos.cor,
        tipoBanho: produtos.tipoBanho,
        custo: produtos.custo,
        preco: produtos.preco,
        custos: produtos.custos,
        medidas: produtos.medidas,
        categoria: categorias.nome,
        estoque: sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo <> 'maleta'),0)::int`,
        emMaletas: sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo = 'maleta'),0)::int`,
      })
      .from(produtos)
      .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
      .where(where)
      .orderBy(asc(produtos.descricao), asc(produtos.codigoBarras))
      .limit(porPagina)
      .offset((pagina - 1) * porPagina);
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(produtos).where(where);
    return { itens: linhas.map((p) => ({ ...this.linha(p, regras), categoria: p.categoria, estoque: p.estoque, emMaletas: p.emMaletas })), total, pagina, porPagina, regras };
  }

  /** Peças de uma planilha: procura cada linha pelo código de barras e, se não achar, pela referência. */
  @Post('buscar')
  @Permissao('produtos', 'ver')
  async buscar(@Body() body: unknown) {
    const { codigos } = validar(z.object({ codigos: z.array(z.string().trim().min(1).max(60)).min(1).max(5000) }), body);
    const unicos = [...new Set(codigos)];
    const regras = await this.regras();
    const achados = await this.db
      .select()
      .from(produtos)
      .where(or(inArray(produtos.codigoBarras, unicos), inArray(produtos.referencia, unicos)));
    const porCodigo = new Map(achados.map((p) => [p.codigoBarras, p]));
    const porRef = new Map<string, Produto | null>();
    for (const p of achados) porRef.set(p.referencia, porRef.has(p.referencia) ? null : p); // referência repetida não identifica a peça
    const itens: Record<string, ReturnType<PrecificacaoController['linha']>> = {};
    for (const c of unicos) {
      const p = porCodigo.get(c) ?? porRef.get(c);
      if (p) itens[c] = this.linha(p, regras);
    }
    return { itens, regras };
  }

  /**
   * Grava o que foi ajustado na tela: peso, custo bruto, insumos, banho (peso × coeficiente) e, se informado, o novo preço.
   * O custo do produto passa a ser a soma da composição (bruto, insumos, banhos e verniz).
   */
  @Post('aplicar')
  @Permissao('produtos', 'editar')
  async aplicar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const { itens } = validar(aplicarSchema, body);
    const ids = [...new Set(itens.map((i) => i.id))];
    if (ids.length !== itens.length) throw new BadRequestException('A mesma peça apareceu duas vezes.');
    const regras = await this.regras();
    const mudancas: { id: string; codigo: string; preco: [number, number]; custo: [number, number] }[] = [];
    await this.db.transaction(async (tx) => {
      const atuais = new Map((await tx.select().from(produtos).where(inArray(produtos.id, ids)).for('update')).map((p) => [p.id, p]));
      for (const i of itens) {
        const p = atuais.get(i.id);
        if (!p) throw new BadRequestException('Uma das peças não existe mais. Atualize a tela.');
        const antes = this.linha(p, regras);
        const peso = i.peso ?? antes.peso;
        const metal = i.metal ?? antes.metal;
        const custos: Record<string, number> = { ...(p.custos ?? {}) };
        if (i.bruto !== undefined) custos.bruto = i.bruto;
        if (i.insumos !== undefined) custos.insumos = i.insumos;
        else if (custos.insumos === undefined && metal && peso > 0) custos.insumos = regras.insumos;
        if (metal && peso > 0) {
          const c = calcularPreco({ peso, bruto: custos.bruto ?? 0, metal, coeficiente: i.coeficiente ?? (i.metal && i.metal !== antes.metal ? null : antes.coeficiente), insumos: custos.insumos }, regras);
          custos[metal === 'ouro' ? 'banhoOuro' : 'banhoPrata'] = c.banho;
          delete custos[metal === 'ouro' ? 'banhoPrata' : 'banhoOuro'];
        }
        const medidas = i.peso !== undefined ? { ...(p.medidas ?? {}), peso: i.peso } : p.medidas;
        const mexeuNoCusto = i.bruto !== undefined || i.insumos !== undefined || i.peso !== undefined || i.metal !== undefined || i.coeficiente !== undefined;
        const custo = mexeuNoCusto ? Object.values(custos).reduce((a, b) => a + (Number(b) || 0), 0) : p.custo;
        const preco = i.preco ?? p.preco;
        await tx.update(produtos).set({ custos, medidas, custo, preco, atualizadoEm: new Date() }).where(eq(produtos.id, p.id));
        if (preco !== p.preco || custo !== p.custo) mudancas.push({ id: p.id, codigo: p.codigoBarras, preco: [p.preco, preco], custo: [p.custo, custo] });
      }
    });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'precificacao', dados: { pecas: itens.length, mudancas: mudancas.slice(0, 200) } });
    return { ok: true, pecas: itens.length, precosAlterados: mudancas.filter((m) => m.preco[0] !== m.preco[1]).length };
  }
}
