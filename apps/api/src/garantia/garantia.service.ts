import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { empresas, locaisEstoque, maletaItens, maletas, ordensServico, produtos, titulos, vendaItens, vendas } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

export interface NovaOS {
  tipo: 'garantia' | 'conserto';
  clienteId?: string | null;
  representanteId?: string | null;
  codigoProduto?: string | null;
  vendaId?: string | null;
  maletaId?: string | null;
  vendaNumero?: number | null;
  maletaNumero?: number | null;
  dataCompra?: string | null;
  defeito: string;
  prestadorId?: string | null;
  servicoId?: string | null;
  valor?: number;
  previsao?: string | null;
  observacao?: string | null;
}

/**
 * Garantia (defeito dentro do prazo do Código de Defesa do Consumidor) e conserto pago.
 * Na troca, a peça nova sai do estoque escolhido e a peça com defeito entra no local "Avarias e garantia",
 * de onde segue para o fornecedor ou para descarte.
 */
@Injectable()
export class GarantiaService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly estoque: EstoqueService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Local das peças com defeito; criado na primeira vez, na matriz. */
  private async localAvarias(tx: Tx) {
    const [l] = await tx.select().from(locaisEstoque).where(and(eq(locaisEstoque.nome, 'Avarias e garantia'), eq(locaisEstoque.tipo, 'deposito')));
    if (l) return l;
    const [matriz] = await tx.select().from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    const [novo] = await tx.insert(locaisEstoque).values({ empresaId: matriz.id, nome: 'Avarias e garantia', tipo: 'deposito' }).returning();
    return novo;
  }

  async criar(d: NovaOS, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      let produtoId: string | null = null;
      if (d.codigoProduto) {
        const [p] = await tx.select({ id: produtos.id }).from(produtos).where(eq(produtos.codigoBarras, d.codigoProduto));
        const [r] = p ? [p] : await tx.select({ id: produtos.id }).from(produtos).where(eq(produtos.referencia, d.codigoProduto));
        if (!r) throw new NotFoundException(`Código ${d.codigoProduto} não cadastrado.`);
        produtoId = r.id;
      }
      let clienteId = d.clienteId ?? null;
      let representanteId = d.representanteId ?? null;
      let dataCompra = d.dataCompra ?? null;
      // No balcão é mais fácil digitar o número impresso no recibo ou no pedido da maleta.
      if (!d.vendaId && d.vendaNumero) {
        const [v] = await tx.select({ id: vendas.id }).from(vendas).where(eq(vendas.numero, d.vendaNumero));
        if (!v) throw new NotFoundException(`Venda nº ${d.vendaNumero} não encontrada.`);
        d.vendaId = v.id;
      }
      if (!d.maletaId && d.maletaNumero) {
        const [m] = await tx.select({ id: maletas.id }).from(maletas).where(eq(maletas.numero, d.maletaNumero));
        if (!m) throw new NotFoundException(`Maleta nº ${d.maletaNumero} não encontrada.`);
        d.maletaId = m.id;
      }
      // Venda da loja: a cliente e a data vêm da venda, e a peça precisa ser dela.
      if (d.vendaId) {
        const [v] = await tx.select().from(vendas).where(eq(vendas.id, d.vendaId));
        if (!v) throw new NotFoundException('Venda não encontrada.');
        clienteId = clienteId ?? v.clienteId;
        dataCompra = dataCompra ?? v.criadoEm.toISOString().slice(0, 10);
        if (produtoId) {
          const [it] = await tx.select().from(vendaItens).where(and(eq(vendaItens.vendaId, v.id), eq(vendaItens.produtoId, produtoId)));
          if (!it) throw new BadRequestException('Esta peça não faz parte da venda informada.');
        }
      }
      // Peça vendida pela representante: vem de uma maleta dela.
      if (d.maletaId) {
        const [m] = await tx.select().from(maletas).where(eq(maletas.id, d.maletaId));
        if (!m) throw new NotFoundException('Maleta não encontrada.');
        representanteId = representanteId ?? m.representanteId;
        if (produtoId) {
          const [it] = await tx.select().from(maletaItens).where(and(eq(maletaItens.maletaId, m.id), eq(maletaItens.produtoId, produtoId)));
          if (!it) throw new BadRequestException('Esta peça não esteve nesta maleta.');
        }
      }
      if (d.tipo === 'garantia' && !dataCompra) throw new BadRequestException('Informe a data da compra para calcular o prazo da garantia.');
      const { prazoDias } = await this.config.ler('regras_garantia', tx);
      const garantiaAte = dataCompra ? somarDias(dataCompra, prazoDias) : null;
      const [os] = await tx
        .insert(ordensServico)
        .values({
          tipo: d.tipo,
          clienteId,
          representanteId,
          produtoId,
          vendaId: d.vendaId ?? null,
          maletaId: d.maletaId ?? null,
          dataCompra,
          garantiaAte,
          defeito: d.defeito,
          prestadorId: d.prestadorId ?? null,
          servicoId: d.servicoId ?? null,
          valor: d.tipo === 'garantia' ? 0 : d.valor ?? 0,
          previsao: d.previsao ?? null,
          observacao: d.observacao ?? null,
          status: d.prestadorId ? 'na_assistencia' : 'aberta',
          usuarioId,
        })
        .returning();
      await this.auditoria.registrar({ usuarioId, acao: 'criar', entidade: 'ordem_servico', entidadeId: os.id, dados: { tipo: d.tipo } }, tx);
      return { ...os, foraDoPrazo: !!garantiaAte && garantiaAte < hoje() };
    });
  }

  async enviarAssistencia(id: string, prestadorId: string, previsao: string | null, usuarioId: string) {
    const [os] = await this.db.update(ordensServico).set({ prestadorId, previsao, status: 'na_assistencia' }).where(and(eq(ordensServico.id, id), eq(ordensServico.status, 'aberta'))).returning();
    if (!os) throw new BadRequestException('Só ordens abertas podem ir para a assistência.');
    await this.auditoria.registrar({ usuarioId, acao: 'enviar_assistencia', entidade: 'ordem_servico', entidadeId: id });
    return os;
  }

  /** Decisão sobre a peça: troca, conserto, devolução ao fornecedor ou recusa. */
  async decidir(id: string, d: { decisao: 'troca' | 'conserto' | 'devolucao_fornecedor' | 'recusada'; motivo?: string | null; codigoTroca?: string | null; localId?: string | null; receberPeca: boolean }, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [os] = await tx.select().from(ordensServico).where(eq(ordensServico.id, id)).for('update');
      if (!os) throw new NotFoundException('Ordem não encontrada.');
      if (['concluida', 'cancelada'].includes(os.status)) throw new BadRequestException(`A ordem está ${os.status}.`);
      if (d.decisao === 'recusada' && !d.motivo) throw new BadRequestException('Informe o motivo da recusa (ex.: mau uso, fora do prazo).');
      const ref = { referenciaTipo: 'ordem_servico', referenciaId: id, usuarioId, motivo: `OS nº ${os.numero}` };
      let produtoTrocaId: string | null = null;

      // A peça com defeito fica com a matriz (troca ou devolução ao fornecedor).
      if (d.receberPeca && os.produtoId && (d.decisao === 'troca' || d.decisao === 'devolucao_fornecedor')) {
        const avarias = await this.localAvarias(tx);
        await this.estoque.mover(tx, { produtoId: os.produtoId, destinoId: avarias.id, quantidade: 1, tipo: 'garantia', ...ref, motivo: `${ref.motivo}: peça com defeito recebida` });
      }
      if (d.decisao === 'troca') {
        if (!d.codigoTroca || !d.localId) throw new BadRequestException('Na troca, bipe a peça nova e escolha de onde ela sai.');
        const [p] = await tx.select().from(produtos).where(eq(produtos.codigoBarras, d.codigoTroca));
        if (!p) throw new NotFoundException(`Código ${d.codigoTroca} não cadastrado.`);
        await this.estoque.mover(tx, { produtoId: p.id, origemId: d.localId, quantidade: 1, tipo: 'garantia', ...ref, motivo: `${ref.motivo}: peça entregue na troca` });
        produtoTrocaId = p.id;
      }
      const status = d.decisao === 'conserto' ? (os.prestadorId ? 'na_assistencia' : 'aberta') : 'concluida';
      const [r] = await tx
        .update(ordensServico)
        .set({ decisao: d.decisao, motivoDecisao: d.motivo ?? null, produtoTrocaId, status, concluidaEm: status === 'concluida' ? new Date() : null })
        .where(eq(ordensServico.id, id))
        .returning();
      await this.auditoria.registrar({ usuarioId, acao: 'decidir', entidade: 'ordem_servico', entidadeId: id, dados: { decisao: d.decisao } }, tx);
      return r;
    });
  }

  /** Peça voltou da assistência e foi entregue: conserto pago gera o recebimento. */
  async concluir(id: string, valorPago: number, formaPagamento: string | null, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [os] = await tx.select().from(ordensServico).where(eq(ordensServico.id, id)).for('update');
      if (!os) throw new NotFoundException('Ordem não encontrada.');
      if (['concluida', 'cancelada'].includes(os.status)) throw new BadRequestException(`A ordem está ${os.status}.`);
      if (os.tipo === 'conserto' && os.valor > 0) {
        const [matriz] = await tx.select().from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
        const pago = valorPago >= os.valor;
        await tx.insert(titulos).values({
          empresaId: matriz.id,
          tipo: 'receber',
          pessoaId: os.clienteId ?? os.representanteId,
          descricao: `Conserto · OS nº ${os.numero}`,
          categoria: 'Consertos',
          valor: os.valor,
          vencimento: hoje(),
          formaPagamento,
          status: pago ? 'pago' : 'aberto',
          pagoEm: pago ? hoje() : null,
          valorPago: pago ? os.valor : null,
          origemTipo: 'ordem_servico',
          origemId: os.id,
        });
      }
      const [r] = await tx.update(ordensServico).set({ status: 'concluida', valorPago, concluidaEm: new Date(), decisao: os.decisao ?? 'conserto' }).where(eq(ordensServico.id, id)).returning();
      await this.auditoria.registrar({ usuarioId, acao: 'concluir', entidade: 'ordem_servico', entidadeId: id }, tx);
      return r;
    });
  }

  async cancelar(id: string, motivo: string, usuarioId: string) {
    const [r] = await this.db.update(ordensServico).set({ status: 'cancelada', motivoDecisao: motivo }).where(and(eq(ordensServico.id, id), eq(ordensServico.status, 'aberta'))).returning();
    if (!r) throw new BadRequestException('Só ordens abertas, sem decisão, podem ser canceladas.');
    await this.auditoria.registrar({ usuarioId, acao: 'cancelar', entidade: 'ordem_servico', entidadeId: id, dados: { motivo } });
    return r;
  }
}

export { somarDias };
