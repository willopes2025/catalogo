import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { centavos, dataISO } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { contas, locaisEstoque, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { PlanoContasService } from './plano.service';

export const tituloSchema = z.object({
  empresaId: z.string().uuid(),
  tipo: z.enum(['receber', 'pagar']),
  pessoaId: z.string().uuid().optional().nullable(),
  descricao: z.string().min(2).max(200),
  categoria: z.string().max(80).optional().nullable(),
  planoContaId: z.string().uuid().optional().nullable(),
  /** Centro de custo: o evento a que o lançamento pertence. */
  centroCustoId: z.string().uuid().optional().nullable(),
  /** Lança já como pago (despesa paga na hora, receita recebida): conta e dia do pagamento. */
  pagoEm: dataISO.optional().nullable(),
  contaId: z.string().uuid().optional().nullable(),
  valor: centavos.refine((v) => v > 0, 'Informe o valor'),
  vencimento: dataISO,
  formaPagamento: z.string().max(30).optional().nullable(),
  /** Divide o valor em parcelas mensais. */
  parcelas: z.number().int().min(1).max(48).default(1),
  /** Conta fixa: repete o valor inteiro todo mês, por tantos meses (ex.: aluguel, prestador). */
  repetirMeses: z.number().int().min(2).max(36).optional().nullable(),
});
export type NovoTitulo = z.infer<typeof tituloSchema>;

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Mesmo dia nos meses seguintes; em mês mais curto, cai no último dia (31/01 → 28/02). */
export function vencimentoDoMes(vencimento: string, i: number) {
  const [a, m, dia] = vencimento.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m + i, 0)).getUTCDate();
  return new Date(Date.UTC(a, m - 1 + i, Math.min(dia, ultimo))).toISOString().slice(0, 10);
}

/** Lançamento de contas a pagar e a receber (tela do Financeiro e assistente usam o mesmo caminho). */
@Injectable()
export class LancamentosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly plano: PlanoContasService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async lancar(d: NovoTitulo, usuarioId: string | null) {
    const conta = d.planoContaId ? await this.plano.paraLancar(d.planoContaId) : null;
    if (d.centroCustoId) {
      const [l] = await this.db.select({ tipo: locaisEstoque.tipo }).from(locaisEstoque).where(eq(locaisEstoque.id, d.centroCustoId));
      if (l?.tipo !== 'evento') throw new BadRequestException('O centro de custo precisa ser um evento cadastrado.');
    }
    const repetir = d.repetirMeses ?? 0;
    if (repetir && d.parcelas > 1) throw new BadRequestException('Escolha parcelar ou repetir todo mês, não os dois.');
    if (d.pagoEm) {
      if (d.parcelas > 1 || repetir) throw new BadRequestException('Lançamento já pago é de uma parcela só.');
      if (d.pagoEm > hoje()) throw new BadRequestException('A data do pagamento não pode ser no futuro.');
      if (!d.contaId) throw new BadRequestException('Escolha a conta por onde o dinheiro passou.');
      const [cb] = await this.db.select({ ativo: contas.ativo }).from(contas).where(eq(contas.id, d.contaId));
      if (!cb?.ativo) throw new BadRequestException('Conta bancária não encontrada ou desativada.');
    }
    const n = repetir || d.parcelas;
    const base = repetir ? d.valor : Math.floor(d.valor / d.parcelas);
    const resto = repetir ? 0 : d.valor - base * d.parcelas;
    const linhas = Array.from({ length: n }, (_, i) => {
      const venc = vencimentoDoMes(d.vencimento, i);
      const [va, vm] = venc.split('-').map(Number);
      return {
        empresaId: d.empresaId,
        tipo: d.tipo,
        pessoaId: d.pessoaId ?? null,
        descricao: repetir ? `${d.descricao} · ${MESES[vm - 1]}/${va}` : d.parcelas > 1 ? `${d.descricao} (${i + 1}/${d.parcelas})` : d.descricao,
        categoria: conta?.nome ?? d.categoria ?? null,
        planoContaId: conta?.id ?? null,
        centroCustoId: d.centroCustoId ?? null,
        ...(d.pagoEm ? { status: 'pago' as const, pagoEm: d.pagoEm, valorPago: d.valor, contaId: d.contaId } : {}),
        valor: base + (i === 0 ? resto : 0),
        vencimento: venc,
        parcela: i + 1,
        totalParcelas: n,
        formaPagamento: d.formaPagamento ?? null,
      };
    });
    const criados = await this.db.insert(titulos).values(linhas).returning();
    await this.auditoria.registrar({ usuarioId, acao: 'criar', entidade: 'titulo', dados: { ids: criados.map((c) => c.id), valor: d.valor, ...(repetir ? { repetirMeses: repetir } : {}) } });
    return criados;
  }
}
