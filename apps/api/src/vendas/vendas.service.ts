import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { aplicarPercentual, somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { caixaMovimentos, caixas, configuracoes, creditos, locaisEstoque, pessoas, produtos, titulos, vendaItens, vendaPagamentos, vendas } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

export const FORMAS = ['dinheiro', 'pix', 'debito', 'credito', 'credito_loja', 'boleto'] as const;
export type Forma = (typeof FORMAS)[number];
export const NOME_FORMA: Record<Forma, string> = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Cartão de débito', credito: 'Cartão de crédito', credito_loja: 'Crédito da cliente', boleto: 'Boleto / crediário' };

export interface RegrasVenda {
  /** Desconto máximo sem autorização (pontos-base). Quem pode editar configurações passa do limite. */
  descontoMaximoPb: number;
  /** Prazo para troca ou devolução em dias. */
  prazoTrocaDias: number;
  /** Dias até o dinheiro do cartão cair, para previsão no financeiro. */
  prazoDebitoDias: number;
  prazoCreditoDias: number;
}
export const REGRAS_VENDA_PADRAO: RegrasVenda = { descontoMaximoPb: 1000, prazoTrocaDias: 30, prazoDebitoDias: 1, prazoCreditoDias: 30 };

export interface DadosVenda {
  localId: string;
  caixaId?: string | null;
  tipo: 'balcao' | 'avulsa' | 'revenda';
  clienteId?: string | null;
  itens: { codigoBarras: string; quantidade: number; desconto?: number }[];
  descontoTotal?: number;
  pagamentos: { forma: Forma; valor: number; parcelas?: number; maquininha?: string | null; autorizacao?: string | null }[];
  observacao?: string | null;
}

@Injectable()
export class VendasService {
  constructor(@Inject(DB) private readonly db: Db, private readonly estoque: EstoqueService, private readonly auditoria: AuditoriaService) {}

  async regras(tx?: Tx | Db): Promise<RegrasVenda> {
    const [c] = await (tx ?? this.db).select().from(configuracoes).where(eq(configuracoes.chave, 'regras_venda'));
    return { ...REGRAS_VENDA_PADRAO, ...((c?.valor as Partial<RegrasVenda>) ?? {}) };
  }

  // ───────── Caixa ─────────

  async caixaAberto(localId: string, tx?: Tx | Db) {
    const [c] = await (tx ?? this.db).select().from(caixas).where(and(eq(caixas.localId, localId), eq(caixas.status, 'aberto')));
    return c ?? null;
  }

  async abrirCaixa(localId: string, valorAbertura: number, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [local] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, localId));
      if (!local || !['loja', 'evento'].includes(local.tipo)) throw new BadRequestException('O caixa só abre em loja ou evento.');
      if (await this.caixaAberto(localId, tx)) throw new BadRequestException('Já existe um caixa aberto neste ponto de venda.');
      const [c] = await tx.insert(caixas).values({ empresaId: local.empresaId, localId, valorAbertura, abertoPor: usuarioId }).returning();
      if (valorAbertura > 0) await tx.insert(caixaMovimentos).values({ caixaId: c.id, tipo: 'abertura', forma: 'dinheiro', valor: valorAbertura, descricao: 'Troco inicial', usuarioId });
      await this.auditoria.registrar({ usuarioId, acao: 'abrir_caixa', entidade: 'caixa', entidadeId: c.id, dados: { valorAbertura } }, tx);
      return c;
    });
  }

  async movimentarCaixa(caixaId: string, tipo: 'sangria' | 'reforco', valor: number, descricao: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(caixas).where(eq(caixas.id, caixaId)).for('update');
      if (!c || c.status !== 'aberto') throw new BadRequestException('Caixa não está aberto.');
      if (tipo === 'sangria') {
        const resumo = await this.resumoCaixa(caixaId, tx);
        if (valor > (resumo.porForma.dinheiro ?? 0)) throw new BadRequestException('A sangria é maior que o dinheiro no caixa.');
      }
      await tx.insert(caixaMovimentos).values({ caixaId, tipo, forma: 'dinheiro', valor: tipo === 'sangria' ? -valor : valor, descricao, usuarioId });
      await this.auditoria.registrar({ usuarioId, acao: tipo, entidade: 'caixa', entidadeId: caixaId, dados: { valor, descricao } }, tx);
      return { ok: true };
    });
  }

  async resumoCaixa(caixaId: string, tx?: Tx | Db) {
    const db = tx ?? this.db;
    const movs = await db.select().from(caixaMovimentos).where(eq(caixaMovimentos.caixaId, caixaId)).orderBy(caixaMovimentos.criadoEm);
    const porForma: Record<string, number> = {};
    for (const m of movs) porForma[m.forma] = (porForma[m.forma] ?? 0) + m.valor;
    const [v] = await db
      .select({ qtd: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${vendas.total}),0)::int` })
      .from(vendas)
      .where(and(eq(vendas.caixaId, caixaId), eq(vendas.status, 'concluida')));
    return { porForma, movimentos: movs, vendas: v.qtd, totalVendas: v.total };
  }

  /** Fecha o caixa comparando o contado com o esperado, forma por forma. */
  async fecharCaixa(caixaId: string, contado: Record<string, number>, observacao: string | null, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(caixas).where(eq(caixas.id, caixaId)).for('update');
      if (!c || c.status !== 'aberto') throw new BadRequestException('Caixa não está aberto.');
      const { porForma } = await this.resumoCaixa(caixaId, tx);
      const formas = new Set([...Object.keys(porForma), ...Object.keys(contado)]);
      let diferenca = 0;
      for (const f of formas) diferenca += (contado[f] ?? 0) - (porForma[f] ?? 0);
      const [r] = await tx
        .update(caixas)
        .set({ status: 'fechado', fechadoEm: new Date(), fechadoPor: usuarioId, contado, esperado: porForma, diferenca, observacao })
        .where(eq(caixas.id, caixaId))
        .returning();
      await this.auditoria.registrar({ usuarioId, acao: 'fechar_caixa', entidade: 'caixa', entidadeId: caixaId, dados: { diferenca } }, tx);
      return r;
    });
  }

  // ───────── Venda ─────────

  async registrar(d: DadosVenda, usuarioId: string, podePassarDesconto: boolean) {
    return this.db.transaction(async (tx) => {
      const regras = await this.regras(tx);
      const [local] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, d.localId));
      if (!local || local.tipo === 'maleta') throw new BadRequestException('Local de venda inválido.');
      let caixaId: string | null = null;
      if (d.tipo === 'balcao') {
        const c = await this.caixaAberto(d.localId, tx);
        if (!c) throw new BadRequestException('Abra o caixa antes de vender.');
        caixaId = c.id;
      }
      let cliente: typeof pessoas.$inferSelect | null = null;
      if (d.clienteId) {
        [cliente] = await tx.select().from(pessoas).where(eq(pessoas.id, d.clienteId));
        if (!cliente) throw new NotFoundException('Cliente não encontrado.');
      }
      if (d.tipo === 'revenda' && cliente?.tipo !== 'representante') throw new BadRequestException('Venda de revenda precisa de uma representante como compradora.');

      // Itens: junta leituras repetidas e calcula preço (revenda usa o preço de atacado).
      const codigos = [...new Set(d.itens.map((i) => i.codigoBarras))];
      const ps = await tx.select().from(produtos).where(inArray(produtos.codigoBarras, codigos));
      const mapa = new Map(ps.map((p) => [p.codigoBarras, p]));
      const faltando = codigos.filter((c) => !mapa.has(c));
      if (faltando.length) throw new NotFoundException(`Código(s) não cadastrado(s): ${faltando.join(', ')}`);
      const agrupado = new Map<string, { quantidade: number; desconto: number }>();
      for (const i of d.itens) {
        const a = agrupado.get(i.codigoBarras) ?? { quantidade: 0, desconto: 0 };
        agrupado.set(i.codigoBarras, { quantidade: a.quantidade + i.quantidade, desconto: a.desconto + (i.desconto ?? 0) });
      }
      const linhas = [...agrupado].map(([codigo, x]) => {
        const p = mapa.get(codigo)!;
        const preco = d.tipo === 'revenda' ? p.precoAtacado ?? p.preco : p.preco;
        const bruto = preco * x.quantidade;
        if (x.desconto > bruto) throw new BadRequestException(`Desconto maior que o valor de ${p.descricao}.`);
        return { produto: p, quantidade: x.quantidade, preco, desconto: x.desconto, total: bruto - x.desconto };
      });
      const subtotal = linhas.reduce((a, l) => a + l.preco * l.quantidade, 0);
      const descontoItens = linhas.reduce((a, l) => a + l.desconto, 0);
      const descontoTotal = d.descontoTotal ?? 0;
      const desconto = descontoItens + descontoTotal;
      const total = subtotal - desconto;
      if (total < 0) throw new BadRequestException('Desconto maior que o total da venda.');
      if (d.tipo !== 'revenda' && desconto > aplicarPercentual(subtotal, regras.descontoMaximoPb) && !podePassarDesconto) {
        throw new ForbiddenException(`Desconto acima do limite de ${regras.descontoMaximoPb / 100}%. Peça autorização da gerência.`);
      }

      // Pagamentos
      const pago = d.pagamentos.reduce((a, p) => a + p.valor, 0);
      const dinheiro = d.pagamentos.filter((p) => p.forma === 'dinheiro').reduce((a, p) => a + p.valor, 0);
      if (pago < total) throw new BadRequestException(`Falta receber ${((total - pago) / 100).toFixed(2).replace('.', ',')}.`);
      const troco = pago - total;
      if (troco > dinheiro) throw new BadRequestException('Só há troco para pagamento em dinheiro.');
      const creditoLoja = d.pagamentos.filter((p) => p.forma === 'credito_loja').reduce((a, p) => a + p.valor, 0);
      if (creditoLoja > 0) {
        if (!cliente) throw new BadRequestException('Para usar crédito, identifique a cliente.');
        const [s] = await tx.select({ saldo: sql<number>`coalesce(sum(${creditos.valor}),0)::int` }).from(creditos).where(eq(creditos.pessoaId, cliente.id));
        if (creditoLoja > s.saldo) throw new BadRequestException(`A cliente tem só ${(s.saldo / 100).toFixed(2).replace('.', ',')} de crédito.`);
      }
      if (d.pagamentos.some((p) => p.forma === 'boleto') && !cliente) throw new BadRequestException('Para vender no boleto ou crediário, identifique a cliente.');

      const [venda] = await tx
        .insert(vendas)
        .values({ empresaId: local.empresaId, localId: local.id, caixaId, tipo: d.tipo, clienteId: cliente?.id ?? null, vendedorId: usuarioId, subtotal, desconto, total, troco, observacao: d.observacao ?? null })
        .returning();

      for (const l of linhas) {
        await tx.insert(vendaItens).values({ vendaId: venda.id, produtoId: l.produto.id, quantidade: l.quantidade, preco: l.preco, custo: l.produto.custo, desconto: l.desconto, total: l.total });
        await this.estoque.mover(tx, { produtoId: l.produto.id, origemId: local.id, quantidade: l.quantidade, tipo: 'venda', motivo: `Venda nº ${venda.numero}`, referenciaTipo: 'venda', referenciaId: venda.id, usuarioId });
      }

      const h = hoje();
      for (const p of d.pagamentos) {
        const liquido = p.forma === 'dinheiro' ? p.valor - Math.min(troco, p.valor) : p.valor;
        await tx.insert(vendaPagamentos).values({ vendaId: venda.id, forma: p.forma, valor: liquido, parcelas: p.parcelas ?? 1, maquininha: p.maquininha ?? null, autorizacao: p.autorizacao ?? null });
        if (caixaId) await tx.insert(caixaMovimentos).values({ caixaId, tipo: 'venda', forma: p.forma, valor: liquido, descricao: `Venda nº ${venda.numero}`, vendaId: venda.id, usuarioId });
        if (p.forma === 'credito_loja') {
          await tx.insert(creditos).values({ pessoaId: cliente!.id, valor: -liquido, descricao: `Usado na venda nº ${venda.numero}`, origemTipo: 'venda', origemId: venda.id, usuarioId });
          continue;
        }
        // Títulos: dinheiro e Pix entram pagos; cartão vira previsão de recebimento da maquininha; boleto fica com a cliente.
        const n = p.forma === 'boleto' || p.forma === 'credito' ? Math.max(1, p.parcelas ?? 1) : 1;
        const base = Math.floor(liquido / n);
        for (let i = 0; i < n; i++) {
          const valor = base + (i === 0 ? liquido - base * n : 0);
          const venc =
            p.forma === 'debito' ? somarDias(h, regras.prazoDebitoDias) : p.forma === 'credito' ? somarDias(h, regras.prazoCreditoDias * (i + 1)) : p.forma === 'boleto' ? somarDias(h, 30 * (i + 1)) : h;
          const pago = p.forma === 'dinheiro' || p.forma === 'pix';
          await tx.insert(titulos).values({
            empresaId: local.empresaId,
            tipo: 'receber',
            // Cartão: quem paga é a operadora da maquininha, não a cliente.
            pessoaId: p.forma === 'debito' || p.forma === 'credito' ? null : cliente?.id ?? null,
            descricao: `Venda nº ${venda.numero} · ${NOME_FORMA[p.forma]}${n > 1 ? ` (${i + 1}/${n})` : ''}${p.maquininha ? ` · ${p.maquininha}` : ''}`,
            categoria: d.tipo === 'revenda' ? 'Revenda' : 'Venda loja',
            valor,
            vencimento: venc,
            parcela: i + 1,
            totalParcelas: n,
            formaPagamento: p.forma,
            status: pago ? 'pago' : 'aberto',
            pagoEm: pago ? h : null,
            valorPago: pago ? valor : null,
            origemTipo: 'venda',
            origemId: venda.id,
          });
        }
      }
      await this.auditoria.registrar({ usuarioId, acao: 'venda', entidade: 'venda', entidadeId: venda.id, dados: { total, desconto, itens: linhas.length } }, tx);
      return venda;
    });
  }

  async obter(id: string) {
    const [v] = await this.db
      .select({ v: vendas, cliente: pessoas.nome, clienteDocumento: pessoas.documento, local: locaisEstoque.nome })
      .from(vendas)
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, vendas.localId))
      .leftJoin(pessoas, eq(pessoas.id, vendas.clienteId))
      .where(eq(vendas.id, id));
    if (!v) throw new NotFoundException('Venda não encontrada.');
    const itens = await this.db
      .select({ id: vendaItens.id, produtoId: vendaItens.produtoId, codigoBarras: produtos.codigoBarras, referencia: produtos.referencia, descricao: produtos.descricao, quantidade: vendaItens.quantidade, preco: vendaItens.preco, desconto: vendaItens.desconto, total: vendaItens.total, devolvida: vendaItens.devolvida })
      .from(vendaItens)
      .innerJoin(produtos, eq(produtos.id, vendaItens.produtoId))
      .where(eq(vendaItens.vendaId, id));
    const pagamentos = await this.db.select().from(vendaPagamentos).where(eq(vendaPagamentos.vendaId, id));
    return { ...v.v, cliente: v.cliente, clienteDocumento: v.clienteDocumento, local: v.local, itens, pagamentos };
  }

  /** Cancelamento no mesmo dia: devolve estoque, estorna caixa, cancela títulos e créditos usados. */
  async cancelar(id: string, motivo: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(vendas).where(eq(vendas.id, id)).for('update');
      if (!v) throw new NotFoundException('Venda não encontrada.');
      if (v.status !== 'concluida') throw new BadRequestException('Venda já cancelada.');
      if (v.criadoEm.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) throw new BadRequestException('Só dá para cancelar no mesmo dia. Depois disso, use devolução.');
      const itens = await tx.select().from(vendaItens).where(eq(vendaItens.vendaId, id));
      if (itens.some((i) => i.devolvida > 0)) throw new BadRequestException('A venda já teve devolução; não pode ser cancelada.');
      for (const i of itens) await this.estoque.mover(tx, { produtoId: i.produtoId, destinoId: v.localId, quantidade: i.quantidade, tipo: 'ajuste', motivo: `Cancelamento da venda nº ${v.numero}`, referenciaTipo: 'venda', referenciaId: id, usuarioId });
      if (v.caixaId) {
        const [c] = await tx.select().from(caixas).where(eq(caixas.id, v.caixaId));
        if (c.status !== 'aberto') throw new BadRequestException('O caixa desta venda já foi fechado. Use devolução.');
        const pags = await tx.select().from(vendaPagamentos).where(eq(vendaPagamentos.vendaId, id));
        for (const p of pags) await tx.insert(caixaMovimentos).values({ caixaId: v.caixaId, tipo: 'cancelamento', forma: p.forma, valor: -p.valor, descricao: `Cancelamento da venda nº ${v.numero}`, vendaId: id, usuarioId });
      }
      await tx.update(titulos).set({ status: 'cancelado' }).where(and(eq(titulos.origemTipo, 'venda'), eq(titulos.origemId, id)));
      await tx.delete(creditos).where(and(eq(creditos.origemTipo, 'venda'), eq(creditos.origemId, id)));
      await tx.update(vendas).set({ status: 'cancelada', canceladaEm: new Date(), motivoCancelamento: motivo }).where(eq(vendas.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'cancelar', entidade: 'venda', entidadeId: id, dados: { motivo } }, tx);
      return { ok: true };
    });
  }

  /** Devolução ou troca: a peça volta ao estoque e a cliente recebe crédito (ou dinheiro de volta, pelo caixa aberto). */
  async devolver(id: string, itens: { produtoId: string; quantidade: number }[], destino: 'credito' | 'dinheiro', usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(vendas).where(eq(vendas.id, id)).for('update');
      if (!v || v.status !== 'concluida') throw new BadRequestException('Venda não encontrada ou cancelada.');
      const regras = await this.regras(tx);
      const dias = Math.floor((Date.now() - v.criadoEm.getTime()) / 86_400_000);
      if (dias > regras.prazoTrocaDias) throw new BadRequestException(`Passou o prazo de troca de ${regras.prazoTrocaDias} dias.`);
      if (destino === 'credito' && !v.clienteId) throw new BadRequestException('Para gerar crédito, a venda precisa ter a cliente identificada.');
      // Valor devolvido = preço do item já com o desconto dele, menos a parte proporcional do desconto geral da venda.
      const todos = await tx.select().from(vendaItens).where(eq(vendaItens.vendaId, id));
      const somaItens = todos.reduce((a, i) => a + i.total, 0);
      const fator = somaItens > 0 ? v.total / somaItens : 1;
      let valor = 0;
      for (const d of itens) {
        const it = todos.find((i) => i.produtoId === d.produtoId);
        if (!it) throw new BadRequestException('Peça não faz parte desta venda.');
        if (d.quantidade > it.quantidade - it.devolvida) throw new BadRequestException(`Só ${it.quantidade - it.devolvida} unidade(s) podem ser devolvidas.`);
        valor += Math.round((it.total / it.quantidade) * fator * d.quantidade);
        await tx.update(vendaItens).set({ devolvida: it.devolvida + d.quantidade }).where(eq(vendaItens.id, it.id));
        await this.estoque.mover(tx, { produtoId: d.produtoId, destinoId: v.localId, quantidade: d.quantidade, tipo: 'ajuste', motivo: `Devolução da venda nº ${v.numero}`, referenciaTipo: 'venda', referenciaId: id, usuarioId });
      }
      if (destino === 'credito') {
        await tx.insert(creditos).values({ pessoaId: v.clienteId!, valor, descricao: `Devolução da venda nº ${v.numero}`, origemTipo: 'devolucao', origemId: id, usuarioId });
      } else {
        const caixa = await this.caixaAberto(v.localId, tx);
        if (!caixa) throw new BadRequestException('Para devolver em dinheiro, abra o caixa.');
        await tx.insert(caixaMovimentos).values({ caixaId: caixa.id, tipo: 'devolucao', forma: 'dinheiro', valor: -valor, descricao: `Devolução da venda nº ${v.numero}`, vendaId: id, usuarioId });
        await tx.insert(titulos).values({ empresaId: v.empresaId, tipo: 'pagar', pessoaId: v.clienteId, descricao: `Devolução da venda nº ${v.numero}`, categoria: 'Devoluções', valor, vencimento: hoje(), status: 'pago', pagoEm: hoje(), valorPago: valor, origemTipo: 'devolucao', origemId: id });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'devolucao', entidade: 'venda', entidadeId: id, dados: { valor, destino } }, tx);
      return { ok: true, valor, destino };
    });
  }
}
