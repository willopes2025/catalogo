import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, BadRequestException } from '@nestjs/common';
import { and, asc, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { contas, empresas, pessoas, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { AsaasService } from '../integracoes/asaas.service';

const tituloSchema = z.object({
  empresaId: z.string().uuid(),
  tipo: z.enum(['receber', 'pagar']),
  pessoaId: z.string().uuid().optional().nullable(),
  descricao: z.string().min(2).max(200),
  categoria: z.string().max(80).optional().nullable(),
  valor: centavos.refine((v) => v > 0, 'Informe o valor'),
  vencimento: dataISO,
  formaPagamento: z.string().max(30).optional().nullable(),
  parcelas: z.number().int().min(1).max(48).default(1),
});

const baixaSchema = z.object({
  pagoEm: dataISO.optional(),
  valorPago: centavos.optional(),
  contaId: z.string().uuid().optional().nullable(),
  formaPagamento: z.string().max(30).optional(),
  /** Pagou menos, mas a matriz dá o resto como desconto (não abre saldo). */
  quitarComDesconto: z.boolean().default(false),
});

@Controller('financeiro')
export class FinanceiroController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService, private readonly asaas: AsaasService) {}

  @Get('titulos')
  @Permissao('financeiro', 'ver')
  async titulos(
    @Query('tipo') tipo = 'receber',
    @Query('aba') aba = 'abertos',
    @Query('pessoaId') pessoaId?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
  ) {
    const f: SQL[] = [eq(titulos.tipo, tipo)];
    if (aba === 'abertos') f.push(eq(titulos.status, 'aberto'));
    if (aba === 'vencidos') f.push(eq(titulos.status, 'aberto'), lt(titulos.vencimento, hoje()));
    if (aba === 'pagos') f.push(eq(titulos.status, 'pago'));
    if (aba === 'protestados') f.push(eq(titulos.status, 'protestado'));
    if (pessoaId) f.push(eq(titulos.pessoaId, pessoaId));
    if (de) f.push(gte(titulos.vencimento, de));
    if (ate) f.push(lte(titulos.vencimento, ate));
    const itens = await this.db
      .select({
        id: titulos.id,
        descricao: titulos.descricao,
        pessoa: pessoas.nome,
        pessoaId: titulos.pessoaId,
        empresa: empresas.nome,
        categoria: titulos.categoria,
        valor: titulos.valor,
        vencimento: titulos.vencimento,
        parcela: titulos.parcela,
        totalParcelas: titulos.totalParcelas,
        formaPagamento: titulos.formaPagamento,
        status: titulos.status,
        pagoEm: titulos.pagoEm,
        valorPago: titulos.valorPago,
        conta: contas.nome,
        cobrancaTipo: titulos.cobrancaTipo,
        cobrancaUrl: titulos.cobrancaUrl,
        pixCopiaCola: titulos.pixCopiaCola,
        diasAtraso: sql<number>`case when ${titulos.status} = 'aberto' then greatest(${hoje()}::date - ${titulos.vencimento}, 0) else 0 end`,
      })
      .from(titulos)
      .innerJoin(empresas, eq(empresas.id, titulos.empresaId))
      .leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId))
      .leftJoin(contas, eq(contas.id, titulos.contaId))
      .where(and(...f))
      .orderBy(asc(titulos.vencimento))
      .limit(500);
    const total = itens.reduce((a, t) => a + t.valor, 0);
    return { itens, total };
  }

  @Get('contas')
  @Permissao('financeiro', 'ver')
  async contas() {
    return this.db
      .select({
        id: contas.id,
        nome: contas.nome,
        tipo: contas.tipo,
        empresa: empresas.nome,
        saldo: sql<number>`(${contas.saldoInicial} + coalesce((select sum(case when t.tipo='receber' then t.valor_pago else -t.valor_pago end) from ${titulos} t where t.conta_id = ${contas.id} and t.status='pago'),0))::int`,
      })
      .from(contas)
      .innerJoin(empresas, eq(empresas.id, contas.empresaId))
      .where(eq(contas.ativo, true))
      .orderBy(asc(contas.nome));
  }

  @Post('titulos')
  @Permissao('financeiro', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(tituloSchema, body);
    const base = Math.floor(d.valor / d.parcelas);
    const resto = d.valor - base * d.parcelas;
    const [a, m, dia] = d.vencimento.split('-').map(Number);
    const linhas = Array.from({ length: d.parcelas }, (_, i) => {
      // Mesmo dia nos meses seguintes; em mês mais curto, cai no último dia (31/01 → 28/02).
      const ultimo = new Date(Date.UTC(a, m + i, 0)).getUTCDate();
      const venc = new Date(Date.UTC(a, m - 1 + i, Math.min(dia, ultimo))).toISOString().slice(0, 10);
      return {
        empresaId: d.empresaId,
        tipo: d.tipo,
        pessoaId: d.pessoaId ?? null,
        descricao: d.parcelas > 1 ? `${d.descricao} (${i + 1}/${d.parcelas})` : d.descricao,
        categoria: d.categoria ?? null,
        valor: base + (i === 0 ? resto : 0),
        vencimento: venc,
        parcela: i + 1,
        totalParcelas: d.parcelas,
        formaPagamento: d.formaPagamento ?? null,
      };
    });
    const criados = await this.db.insert(titulos).values(linhas).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'titulo', dados: { ids: criados.map((c) => c.id), valor: d.valor } });
    return criados;
  }

  @Post('titulos/:id/baixar')
  @Permissao('financeiro', 'editar')
  async baixar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(baixaSchema, body);
    const pagoEm = d.pagoEm ?? hoje();
    const r = await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(titulos).where(eq(titulos.id, id)).for('update');
      if (!t) throw new NotFoundException('Título não encontrado.');
      if (t.status !== 'aberto') throw new BadRequestException(`Título está ${t.status}.`);
      const valorPago = d.valorPago ?? t.valor;
      if (valorPago <= 0) throw new BadRequestException('Informe o valor pago.');
      // Pagamento parcial: baixa o que foi pago e abre um título com o saldo, no mesmo vencimento.
      const parcial = !d.quitarComDesconto && valorPago < t.valor;
      const [baixado] = await tx
        .update(titulos)
        .set({ status: 'pago', pagoEm, valor: parcial ? valorPago : t.valor, valorPago, contaId: d.contaId ?? null, formaPagamento: d.formaPagamento ?? t.formaPagamento })
        .where(eq(titulos.id, id))
        .returning();
      let saldo = null;
      if (parcial) {
        const { id: _i, criadoEm: _c, cobrancaExternaId: _e, cobrancaUrl: _u, pixCopiaCola: _p, cobrancaTipo: _t, ...resto } = t;
        [saldo] = await tx.insert(titulos).values({ ...resto, valor: t.valor - valorPago, descricao: `${t.descricao} · saldo`, status: 'aberto', pagoEm: null, valorPago: null, contaId: null }).returning();
      }
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'baixar', entidade: 'titulo', entidadeId: id, dados: { ...d, parcial, saldoId: saldo?.id } }, tx);
      return { ...baixado, saldo, cobrancaAnterior: t.cobrancaExternaId };
    });
    // Se havia boleto/Pix no Asaas, avisa que foi pago por fora (ou, no parcial, apaga a cobrança do valor cheio).
    if (r.cobrancaAnterior) {
      if (r.saldo) await this.asaas.cancelarCobranca(r.cobrancaAnterior);
      else await this.asaas.informarPagamentoManual(r.cobrancaAnterior, pagoEm, r.valorPago ?? r.valor);
    }
    return r;
  }

  /** Cancela um título em aberto (lançado errado, renegociado). Apaga também a cobrança no Asaas. */
  @Post('titulos/:id/cancelar')
  @Permissao('financeiro', 'excluir')
  async cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Informe o motivo') }), body);
    const [t] = await this.db.update(titulos).set({ status: 'cancelado' }).where(and(eq(titulos.id, id), eq(titulos.status, 'aberto'))).returning();
    if (!t) throw new BadRequestException('Só títulos em aberto podem ser cancelados.');
    await this.asaas.cancelarCobranca(t.cobrancaExternaId);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'cancelar', entidade: 'titulo', entidadeId: id, dados: { motivo, valor: t.valor } });
    return t;
  }

  /** Desfaz uma baixa manual feita por engano (baixas automáticas do Asaas não são desfeitas aqui). */
  @Post('titulos/:id/estornar')
  @Permissao('financeiro', 'excluir')
  async estornar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Informe o motivo') }), body);
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, id));
    if (!t || t.status !== 'pago') throw new BadRequestException('Só títulos pagos podem ter a baixa estornada.');
    if (t.cobrancaExternaId && (t.formaPagamento === 'pix' || t.formaPagamento === 'boleto')) throw new BadRequestException('Este título foi pago pelo Asaas; o estorno é feito no próprio Asaas.');
    if (t.origemTipo === 'venda' && (t.formaPagamento === 'dinheiro' || t.formaPagamento === 'pix')) throw new BadRequestException('Recebimento de venda no caixa: use o cancelamento ou a devolução da venda.');
    const [r] = await this.db.update(titulos).set({ status: 'aberto', pagoEm: null, valorPago: null, contaId: null }).where(eq(titulos.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'estornar', entidade: 'titulo', entidadeId: id, dados: { motivo, pagoEm: t.pagoEm, valorPago: t.valorPago } });
    return r;
  }
}
