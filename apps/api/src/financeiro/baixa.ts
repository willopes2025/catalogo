import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { AuditoriaService } from '../comum/auditoria.service';
import { titulos } from '../db/schema';

export interface DadosBaixa {
  pagoEm: string;
  valorPago?: number;
  contaId?: string | null;
  formaPagamento?: string;
  quitarComDesconto?: boolean;
}

/**
 * Baixa um título a receber/pagar. Pagamento parcial (sem "quitar com desconto"): baixa o que foi pago e abre um título
 * com o saldo, no mesmo vencimento. Devolve o título baixado, o saldo (se houver) e o boleto/Pix que existia no Asaas.
 */
export async function baixarTitulo(tx: Tx, id: string, d: DadosBaixa, usuarioId: string | null, auditoria: AuditoriaService, extra: Record<string, unknown> = {}) {
  const [t] = await tx.select().from(titulos).where(eq(titulos.id, id)).for('update');
  if (!t) throw new NotFoundException('Título não encontrado.');
  if (t.status !== 'aberto' && t.status !== 'protestado') throw new BadRequestException(`Título está ${t.status}.`);
  const valorPago = d.valorPago ?? t.valor;
  if (valorPago <= 0) throw new BadRequestException('Informe o valor pago.');
  const parcial = !d.quitarComDesconto && valorPago < t.valor;
  const [baixado] = await tx
    .update(titulos)
    .set({ status: 'pago', pagoEm: d.pagoEm, valor: parcial ? valorPago : t.valor, valorPago, contaId: d.contaId ?? null, formaPagamento: d.formaPagamento ?? t.formaPagamento })
    .where(eq(titulos.id, id))
    .returning();
  let saldo = null;
  if (parcial) {
    const { id: _i, criadoEm: _c, cobrancaExternaId: _e, cobrancaUrl: _u, pixCopiaCola: _p, cobrancaTipo: _t, cobrancaValor: _v, cobrancaVencimento: _cv, ...resto } = t;
    [saldo] = await tx.insert(titulos).values({ ...resto, valor: t.valor - valorPago, descricao: `${t.descricao} · saldo`, status: t.status, pagoEm: null, valorPago: null, contaId: null }).returning();
  }
  await auditoria.registrar({ usuarioId, acao: 'baixar', entidade: 'titulo', entidadeId: id, dados: { ...d, parcial, saldoId: saldo?.id, ...extra } }, tx);
  return { ...baixado, saldo, cobrancaAnterior: t.cobrancaExternaId };
}
