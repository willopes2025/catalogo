import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  calcularAcerto,
  diasEntre,
  gerarParcelas,
  novoLimite,
  podeRetirarMaleta,
  somarDias,
  type FormaAcerto,
  type ItemAcerto,
} from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { acertos, creditos, locaisEstoque, maletaItens, maletas, pessoas, produtos, titulos } from '../db/schema';

export const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10); // horário de Brasília

export interface ItemCodigo {
  codigoBarras: string;
  quantidade: number;
}

export interface DadosAcerto {
  forma: FormaAcerto;
  modalidade: 'presencial' | 'video' | 'envio';
  parcial: boolean;
  dataAcerto?: string;
  itens: { produtoId: string; vendida: number; devolvida: number; perdida: number }[];
  parcelas: number;
  primeiroVencimento?: string;
  formaPagamento: 'pix' | 'boleto' | 'cartao' | 'dinheiro';
  pagoAgora: boolean;
  usarCredito: boolean;
}

@Injectable()
export class MaletasService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly estoque: EstoqueService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Situação de crédito da representante: limite, quanto está usado e pendências. */
  async situacao(representanteId: string, tx?: Tx) {
    const db = tx ?? this.db;
    const [rep] = await db.select().from(pessoas).where(eq(pessoas.id, representanteId));
    if (!rep || rep.tipo !== 'representante') throw new NotFoundException('Representante não encontrada.');
    const [m] = await db
      .select({
        abertas: sql<number>`count(distinct ${maletas.id})::int`,
        emMaletas: sql<number>`coalesce(sum(${maletaItens.preco} * (${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})),0)::int`,
        atrasoMaleta: sql<number>`coalesce(max(greatest(current_date - ${maletas.dataLimite}, 0)),0)::int`,
      })
      .from(maletas)
      .leftJoin(maletaItens, eq(maletaItens.maletaId, maletas.id))
      .where(and(eq(maletas.representanteId, representanteId), eq(maletas.status, 'aberta')));
    const [t] = await db
      .select({
        atraso: sql<number>`coalesce(max(current_date - ${titulos.vencimento}),0)::int`,
        vencido: sql<number>`coalesce(sum(${titulos.valor}),0)::int`,
      })
      .from(titulos)
      .where(and(eq(titulos.pessoaId, representanteId), eq(titulos.status, 'aberto'), eq(titulos.tipo, 'receber'), lt(titulos.vencimento, sql`current_date`)));
    const [c] = await db.select({ saldo: sql<number>`coalesce(sum(${creditos.valor}),0)::int` }).from(creditos).where(eq(creditos.pessoaId, representanteId));
    return {
      representante: { id: rep.id, nome: rep.nome, status: rep.status, modeloTrabalho: rep.modeloTrabalho },
      limite: rep.limiteCredito,
      emMaletas: m.emMaletas,
      creditoLivre: Math.max(0, rep.limiteCredito - m.emMaletas),
      maletasAbertas: m.abertas,
      maiorAtrasoDias: Math.max(m.atrasoMaleta, t.atraso),
      titulosVencidos: t.vencido,
      saldoCredito: c.saldo,
      bloqueado: rep.bloqueado,
      motivoBloqueio: rep.motivoBloqueio,
    };
  }

  private async resolverItens(tx: Tx, itens: ItemCodigo[]) {
    const codigos = [...new Set(itens.map((i) => i.codigoBarras))];
    const ps = await tx.select().from(produtos).where(inArray(produtos.codigoBarras, codigos));
    const mapa = new Map(ps.map((p) => [p.codigoBarras, p]));
    const faltando = codigos.filter((c) => !mapa.has(c));
    if (faltando.length) throw new NotFoundException(`Código(s) não cadastrado(s): ${faltando.join(', ')}`);
    const inativos = ps.filter((p) => !p.ativo).map((p) => p.codigoBarras);
    if (inativos.length) throw new BadRequestException(`Produto(s) inativo(s): ${inativos.join(', ')}`);
    // junta leituras repetidas do mesmo código
    const agrupado = new Map<string, number>();
    for (const i of itens) agrupado.set(i.codigoBarras, (agrupado.get(i.codigoBarras) ?? 0) + i.quantidade);
    return [...agrupado].map(([codigo, quantidade]) => ({ produto: mapa.get(codigo)!, quantidade }));
  }

  async criar(
    d: { representanteId: string; origemId: string; dataRetirada?: string; entrega: 'retirada' | 'envio'; observacao?: string | null; observacaoInterna?: string | null; itens: ItemCodigo[]; liberarExcecao?: boolean },
    usuarioId: string,
    podeLiberarExcecao: boolean,
  ) {
    return this.db.transaction(async (tx) => {
      const sit = await this.situacao(d.representanteId, tx);
      if (sit.representante.status !== 'ativo') throw new BadRequestException('A representante precisa estar ativa (aprovada na triagem).');
      if (sit.representante.modeloTrabalho && sit.representante.modeloTrabalho !== 'consignado') {
        throw new BadRequestException(`A representante está no modelo ${sit.representante.modeloTrabalho}, não no consignado.`);
      }
      const [origem] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, d.origemId));
      if (!origem || origem.tipo === 'maleta') throw new BadRequestException('Local de origem inválido.');

      const itens = await this.resolverItens(tx, d.itens);
      const valor = itens.reduce((a, i) => a + i.produto.preco * i.quantidade, 0);
      const regras = await this.config.regras(tx);
      const lib = podeRetirarMaleta({ limite: sit.limite, emMaletas: sit.emMaletas, maletasAbertas: sit.maletasAbertas, maiorAtrasoDias: sit.maiorAtrasoDias, bloqueadaManualmente: sit.bloqueado }, valor, regras);
      if (!lib.pode && !(d.liberarExcecao && podeLiberarExcecao)) {
        throw new BadRequestException({ mensagem: 'Maleta não liberada.', motivos: lib.motivos, creditoLivre: lib.creditoLivre, valor });
      }

      const dataRetirada = d.dataRetirada ?? hoje();
      const [local] = await tx.insert(locaisEstoque).values({ empresaId: origem.empresaId, nome: `Maleta · ${sit.representante.nome}`, tipo: 'maleta' }).returning();
      const [maleta] = await tx
        .insert(maletas)
        .values({
          empresaId: origem.empresaId,
          representanteId: d.representanteId,
          localId: local.id,
          origemId: origem.id,
          dataRetirada,
          dataLimite: somarDias(dataRetirada, regras.prazoAcertoDias),
          entrega: d.entrega,
          linkToken: randomBytes(18).toString('base64url'),
          observacao: d.observacao ?? null,
          observacaoInterna: d.observacaoInterna ?? null,
          usuarioId,
        })
        .returning();
      await tx.update(locaisEstoque).set({ nome: `Maleta nº ${maleta.numero} · ${sit.representante.nome}` }).where(eq(locaisEstoque.id, local.id));

      for (const i of itens) {
        await tx.insert(maletaItens).values({ maletaId: maleta.id, produtoId: i.produto.id, preco: i.produto.preco, custo: i.produto.custo, enviada: i.quantidade });
        await this.estoque.mover(tx, { produtoId: i.produto.id, origemId: origem.id, destinoId: local.id, quantidade: i.quantidade, tipo: 'maleta_envio', referenciaTipo: 'maleta', referenciaId: maleta.id, usuarioId });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'criar', entidade: 'maleta', entidadeId: maleta.id, dados: { valor, pecas: itens.reduce((a, i) => a + i.quantidade, 0), excecao: !lib.pode ? lib.motivos : undefined } }, tx);
      return maleta;
    });
  }

  private async maletaAberta(tx: Tx, id: string) {
    const [m] = await tx.select().from(maletas).where(eq(maletas.id, id)).for('update');
    if (!m) throw new NotFoundException('Maleta não encontrada.');
    if (m.status !== 'aberta') throw new BadRequestException(`A maleta nº ${m.numero} está ${m.status}.`);
    return m;
  }

  /** Troca no meio do ciclo: inclui peças (respeitando o crédito). */
  async incluirItens(id: string, itens: ItemCodigo[], usuarioId: string, podeLiberarExcecao: boolean, liberarExcecao = false) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      const resolvidos = await this.resolverItens(tx, itens);
      const valor = resolvidos.reduce((a, i) => a + i.produto.preco * i.quantidade, 0);
      const sit = await this.situacao(m.representanteId, tx);
      if (valor > sit.creditoLivre && !(liberarExcecao && podeLiberarExcecao)) {
        throw new BadRequestException({ mensagem: 'Valor passa do crédito livre.', motivos: [`Crédito livre: ${sit.creditoLivre}, peças: ${valor}`] });
      }
      for (const i of resolvidos) {
        await tx
          .insert(maletaItens)
          .values({ maletaId: id, produtoId: i.produto.id, preco: i.produto.preco, custo: i.produto.custo, enviada: i.quantidade })
          .onConflictDoUpdate({ target: [maletaItens.maletaId, maletaItens.produtoId], set: { enviada: sql`${maletaItens.enviada} + ${i.quantidade}` } });
        await this.estoque.mover(tx, { produtoId: i.produto.id, origemId: m.origemId, destinoId: m.localId, quantidade: i.quantidade, tipo: 'maleta_envio', motivo: 'Inclusão durante o ciclo', referenciaTipo: 'maleta', referenciaId: id, usuarioId });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'incluir_itens', entidade: 'maleta', entidadeId: id, dados: { itens } }, tx);
      return { ok: true };
    });
  }

  /** Troca no meio do ciclo: retira peças que voltam à matriz antes do acerto. */
  async retirarItens(id: string, itens: ItemCodigo[], usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      const resolvidos = await this.resolverItens(tx, itens);
      for (const i of resolvidos) {
        const [it] = await tx.select().from(maletaItens).where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produto.id)));
        const naMaleta = it ? it.enviada - it.vendida - it.devolvida - it.perdida : 0;
        if (i.quantidade > naMaleta) throw new BadRequestException(`${i.produto.descricao}: só há ${naMaleta} na maleta.`);
        await tx.update(maletaItens).set({ enviada: it!.enviada - i.quantidade }).where(eq(maletaItens.id, it!.id));
        await this.estoque.mover(tx, { produtoId: i.produto.id, origemId: m.localId, destinoId: m.origemId, quantidade: i.quantidade, tipo: 'maleta_devolucao', motivo: 'Retirada durante o ciclo', referenciaTipo: 'maleta', referenciaId: id, usuarioId });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'retirar_itens', entidade: 'maleta', entidadeId: id, dados: { itens } }, tx);
      return { ok: true };
    });
  }

  async obter(id: string) {
    const [m] = await this.db
      .select({ maleta: maletas, representante: pessoas.nome, telefone: pessoas.telefone1, cidade: pessoas.cidade, origem: locaisEstoque.nome })
      .from(maletas)
      .innerJoin(pessoas, eq(pessoas.id, maletas.representanteId))
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, maletas.origemId))
      .where(eq(maletas.id, id));
    if (!m) throw new NotFoundException('Maleta não encontrada.');
    const itens = await this.db
      .select({
        id: maletaItens.id,
        produtoId: maletaItens.produtoId,
        codigoBarras: produtos.codigoBarras,
        referencia: produtos.referencia,
        descricao: produtos.descricao,
        foto: sql<string | null>`${produtos.fotos}->>0`,
        preco: maletaItens.preco,
        custo: maletaItens.custo,
        enviada: maletaItens.enviada,
        vendida: maletaItens.vendida,
        devolvida: maletaItens.devolvida,
        perdida: maletaItens.perdida,
        prebaixaVendida: maletaItens.prebaixaVendida,
        prebaixaDevolvida: maletaItens.prebaixaDevolvida,
      })
      .from(maletaItens)
      .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
      .where(eq(maletaItens.maletaId, id))
      .orderBy(asc(produtos.descricao));
    const comSaldo = itens.map((i) => ({ ...i, naMaleta: i.enviada - i.vendida - i.devolvida - i.perdida }));
    const historico = await this.db.select().from(acertos).where(eq(acertos.maletaId, id)).orderBy(asc(acertos.criadoEm));
    const totais = {
      pecas: comSaldo.reduce((a, i) => a + i.naMaleta, 0),
      valor: comSaldo.reduce((a, i) => a + i.naMaleta * i.preco, 0),
      pecasEnviadas: comSaldo.reduce((a, i) => a + i.enviada, 0),
      valorEnviado: comSaldo.reduce((a, i) => a + i.enviada * i.preco, 0),
    };
    const diasAtraso = m.maleta.status === 'aberta' ? Math.max(0, diasEntre(m.maleta.dataLimite, hoje())) : 0;
    return { ...m.maleta, representante: m.representante, telefone: m.telefone, cidade: m.cidade, origem: m.origem, itens: comSaldo, acertos: historico, totais, diasAtraso };
  }

  async prebaixa(id: string, itens: { produtoId: string; vendida: number; devolvida: number }[], usuarioId: string | null) {
    return this.db.transaction(async (tx) => {
      await this.maletaAberta(tx, id);
      for (const i of itens) {
        await tx.update(maletaItens).set({ prebaixaVendida: i.vendida, prebaixaDevolvida: i.devolvida }).where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produtoId)));
      }
      await tx.update(maletas).set({ prebaixaEm: new Date() }).where(eq(maletas.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'prebaixa', entidade: 'maleta', entidadeId: id }, tx);
      return { ok: true };
    });
  }

  private async montarCalculo(tx: Tx, id: string, d: DadosAcerto) {
    const m = await this.maletaAberta(tx, id);
    const doBanco = await tx.select().from(maletaItens).where(eq(maletaItens.maletaId, id));
    const porProduto = new Map(d.itens.map((i) => [i.produtoId, i]));
    const desconhecidos = d.itens.filter((i) => !doBanco.some((b) => b.produtoId === i.produtoId));
    if (desconhecidos.length) throw new BadRequestException('Há produtos que não estão nesta maleta.');
    const itens: ItemAcerto[] = doBanco
      .map((b) => {
        const inf = porProduto.get(b.produtoId);
        return {
          produtoId: b.produtoId,
          preco: b.preco,
          custo: b.custo,
          emMaleta: b.enviada - b.vendida - b.devolvida - b.perdida,
          vendida: inf?.vendida ?? 0,
          devolvida: inf?.devolvida ?? 0,
          perdida: inf?.perdida ?? 0,
        };
      })
      .filter((i) => i.emMaleta > 0);
    const regras = await this.config.regrasDaRepresentante(m.representanteId, tx);
    const sit = await this.situacao(m.representanteId, tx);
    const dataAcerto = d.dataAcerto ?? hoje();
    const resultado = calcularAcerto({
      itens,
      forma: d.forma,
      dataLimite: m.dataLimite,
      dataAcerto,
      creditoDisponivel: d.usarCredito ? Math.max(0, sit.saldoCredito) : 0,
      parcial: d.parcial,
      regras,
    });
    if (d.parcelas > regras.parcelasMaximas) throw new BadRequestException(`Máximo de ${regras.parcelasMaximas} parcelas.`);
    if (d.forma === 'avista' && d.parcelas > 1) throw new BadRequestException('Pagamento à vista não pode ser parcelado.');
    const primeiro = d.primeiroVencimento ?? dataAcerto;
    const parcelas = gerarParcelas(resultado.totalAPagar, d.parcelas, primeiro);
    return { m, itens, regras, sit, resultado, parcelas, dataAcerto };
  }

  async simular(id: string, d: DadosAcerto) {
    // Executa numa transação que é sempre desfeita: nada é gravado.
    let saida: unknown;
    await this.db
      .transaction(async (tx) => {
        const c = await this.montarCalculo(tx, id, d);
        const lim = novoLimite(c.sit.limite, { diasAtraso: c.resultado.diasAtraso, percentualVendidoPb: c.resultado.percentualVendidoPb, houvePerda: c.resultado.pecas.perdidas > 0 }, c.regras);
        saida = { resultado: c.resultado, parcelas: c.parcelas, regras: c.regras, limiteAtual: c.sit.limite, limiteNovo: d.parcial ? c.sit.limite : lim.limite, motivoLimite: d.parcial ? 'Acerto parcial: limite revisto no fechamento.' : lim.motivo };
        throw new SimulacaoConcluida();
      })
      .catch((e) => {
        if (!(e instanceof SimulacaoConcluida)) throw e;
      });
    return saida;
  }

  async acertar(id: string, d: DadosAcerto, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const { m, regras, sit, resultado, parcelas, dataAcerto, itens } = await this.montarCalculo(tx, id, d);
      const ref = { referenciaTipo: 'maleta', referenciaId: id, usuarioId };

      for (const i of itens) {
        if (i.devolvida) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, destinoId: m.origemId, quantidade: i.devolvida, tipo: 'maleta_devolucao', motivo: 'Devolução no acerto', ...ref });
        if (i.vendida) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, quantidade: i.vendida, tipo: 'venda', motivo: 'Vendida pela representante', ...ref });
        if (i.perdida) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, quantidade: i.perdida, tipo: 'perda', motivo: 'Perdida ou quebrada (cobrada no acerto)', ...ref });
        if (i.vendida || i.devolvida || i.perdida) {
          await tx
            .update(maletaItens)
            .set({
              vendida: sql`${maletaItens.vendida} + ${i.vendida}`,
              devolvida: sql`${maletaItens.devolvida} + ${i.devolvida}`,
              perdida: sql`${maletaItens.perdida} + ${i.perdida}`,
            })
            .where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produtoId)));
        }
      }

      const fechou = resultado.pecas.continuam === 0;
      const lim = fechou
        ? novoLimite(sit.limite, { diasAtraso: resultado.diasAtraso, percentualVendidoPb: resultado.percentualVendidoPb, houvePerda: resultado.pecas.perdidas > 0 }, regras)
        : { limite: sit.limite, motivo: 'Acerto parcial.' };

      const [acerto] = await tx
        .insert(acertos)
        .values({
          maletaId: id,
          data: dataAcerto,
          forma: d.forma,
          modalidade: d.modalidade,
          parcial: !fechou,
          resultado,
          regras,
          totalAPagar: resultado.totalAPagar,
          parcelas: parcelas.length,
          limiteAnterior: sit.limite,
          limiteNovo: lim.limite,
          usuarioId,
        })
        .returning();

      if (resultado.creditoUsado > 0) {
        await tx.insert(creditos).values({ pessoaId: m.representanteId, valor: -resultado.creditoUsado, descricao: `Usado no acerto da maleta nº ${m.numero}`, origemTipo: 'acerto', origemId: acerto.id, usuarioId });
      }
      for (const p of parcelas) {
        const pago = d.pagoAgora && parcelas.length === 1;
        await tx.insert(titulos).values({
          empresaId: m.empresaId,
          tipo: 'receber',
          pessoaId: m.representanteId,
          descricao: `Acerto da maleta nº ${m.numero}${parcelas.length > 1 ? ` (${p.numero}/${parcelas.length})` : ''}`,
          categoria: 'Acerto de maleta',
          valor: p.valor,
          vencimento: p.vencimento,
          parcela: p.numero,
          totalParcelas: parcelas.length,
          formaPagamento: d.formaPagamento,
          status: pago ? 'pago' : 'aberto',
          pagoEm: pago ? dataAcerto : null,
          valorPago: pago ? p.valor : null,
          origemTipo: 'acerto',
          origemId: acerto.id,
        });
      }

      if (lim.limite !== sit.limite) await tx.update(pessoas).set({ limiteCredito: lim.limite, atualizadoEm: new Date() }).where(eq(pessoas.id, m.representanteId));
      if (fechou) await tx.update(maletas).set({ status: 'acertada', acertadaEm: new Date(), conferida: true }).where(eq(maletas.id, id));

      await this.auditoria.registrar({ usuarioId, acao: fechou ? 'acerto' : 'acerto_parcial', entidade: 'maleta', entidadeId: id, dados: { acertoId: acerto.id, total: resultado.totalAPagar, limite: [sit.limite, lim.limite] } }, tx);
      return { acerto, resultado, parcelas, limiteNovo: lim.limite, motivoLimite: lim.motivo, fechou };
    });
  }

  async cancelar(id: string, motivo: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      const ac = await tx.select({ id: acertos.id }).from(acertos).where(eq(acertos.maletaId, id)).limit(1);
      if (ac.length) throw new BadRequestException('A maleta já teve acerto parcial; finalize pelo acerto.');
      const itens = await tx.select().from(maletaItens).where(eq(maletaItens.maletaId, id));
      for (const i of itens) {
        if (i.enviada > 0) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, destinoId: m.origemId, quantidade: i.enviada, tipo: 'maleta_devolucao', motivo: `Cancelamento: ${motivo}`, referenciaTipo: 'maleta', referenciaId: id, usuarioId });
      }
      await tx.update(maletas).set({ status: 'cancelada', observacaoInterna: sql`concat_ws(E'\n', ${maletas.observacaoInterna}, ${'Cancelada: ' + motivo}::text)` }).where(eq(maletas.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'cancelar', entidade: 'maleta', entidadeId: id, dados: { motivo } }, tx);
      return { ok: true };
    });
  }
}

class SimulacaoConcluida extends Error {}
