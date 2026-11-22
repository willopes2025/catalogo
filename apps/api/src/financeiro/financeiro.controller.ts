import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { contas, empresas, pessoas, planoContas, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { AsaasService } from '../integracoes/asaas.service';
import { PlanoContasService } from './plano.service';

const tituloSchema = z.object({
  empresaId: z.string().uuid(),
  tipo: z.enum(['receber', 'pagar']),
  pessoaId: z.string().uuid().optional().nullable(),
  descricao: z.string().min(2).max(200),
  categoria: z.string().max(80).optional().nullable(),
  planoContaId: z.string().uuid().optional().nullable(),
  /** Lança já como pago (despesa paga na hora, receita recebida): conta e dia do pagamento. */
  pagoEm: dataISO.optional().nullable(),
  contaId: z.string().uuid().optional().nullable(),
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
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService, private readonly asaas: AsaasService, private readonly plano: PlanoContasService) {}

  @Get('titulos')
  @Permissao('financeiro', 'ver')
  async titulos(
    @Query('tipo') tipo = 'receber',
    @Query('aba') aba = 'abertos',
    @Query('pessoaId') pessoaId?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('busca') busca?: string,
    @Query('semPessoa') semPessoa?: string,
    @Query('semPlano') semPlano?: string,
    @Query('planoContaId') planoContaId?: string,
  ) {
    const f: SQL[] = [eq(titulos.tipo, tipo)];
    if (semPessoa === '1') f.push(isNull(titulos.pessoaId));
    if (semPlano === '1') f.push(isNull(titulos.planoContaId));
    if (planoContaId && /^[0-9a-f-]{36}$/i.test(planoContaId)) f.push(eq(titulos.planoContaId, planoContaId));
    if (busca?.trim()) f.push(or(ilike(titulos.descricao, `%${busca.trim()}%`), ilike(pessoas.nome, `%${busca.trim()}%`))!);
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
        planoContaId: titulos.planoContaId,
        planoCodigo: planoContas.codigo,
        planoNome: planoContas.nome,
        origemTipo: titulos.origemTipo,
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
      .leftJoin(planoContas, eq(planoContas.id, titulos.planoContaId))
      .where(and(...f))
      .orderBy(aba === 'pagos' ? desc(titulos.pagoEm) : asc(titulos.vencimento))
      .limit(500);
    // Total e quantidade de tudo que bate com o filtro (a lista mostra no máximo 500).
    const [soma] = await this.db
      .select({ total: sql<number>`coalesce(sum(${titulos.valor}), 0)::bigint`, quantidade: sql<number>`count(*)::int` })
      .from(titulos)
      .leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId))
      .where(and(...f));
    return { itens, total: Number(soma.total), quantidade: soma.quantidade };
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
        saldo: sql<number>`(${contas.saldoInicial} + coalesce((select sum(case when t.tipo='receber' then t.valor_pago else -t.valor_pago end) from ${titulos} t where t.conta_id = ${contas.id} and t.status='pago'),0))::bigint`,
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
    const conta = d.planoContaId ? await this.plano.paraLancar(d.planoContaId) : null;
    if (d.pagoEm) {
      if (d.parcelas > 1) throw new BadRequestException('Lançamento já pago é de uma parcela só.');
      if (d.pagoEm > hoje()) throw new BadRequestException('A data do pagamento não pode ser no futuro.');
      if (!d.contaId) throw new BadRequestException('Escolha a conta por onde o dinheiro passou.');
      const [cb] = await this.db.select({ ativo: contas.ativo }).from(contas).where(eq(contas.id, d.contaId));
      if (!cb?.ativo) throw new BadRequestException('Conta bancária não encontrada ou desativada.');
    }
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
        categoria: conta?.nome ?? d.categoria ?? null,
        planoContaId: conta?.id ?? null,
        ...(d.pagoEm ? { status: 'pago' as const, pagoEm: d.pagoEm, valorPago: d.valor, contaId: d.contaId } : {}),
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
      if (t.status !== 'aberto' && t.status !== 'protestado') throw new BadRequestException(`Título está ${t.status}.`);
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
        const { id: _i, criadoEm: _c, cobrancaExternaId: _e, cobrancaUrl: _u, pixCopiaCola: _p, cobrancaTipo: _t, cobrancaValor: _v, cobrancaVencimento: _cv, ...resto } = t;
        [saldo] = await tx.insert(titulos).values({ ...resto, valor: t.valor - valorPago, descricao: `${t.descricao} · saldo`, status: t.status, pagoEm: null, valorPago: null, contaId: null }).returning();
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

  /** Liga um título em aberto à pessoa certa (ex.: contas do Jueri que vieram só com o nome do contato). */
  @Post('titulos/:id/pessoa')
  @Permissao('financeiro', 'editar')
  async ligarPessoa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { pessoaId } = validar(z.object({ pessoaId: z.string().uuid('Escolha a pessoa') }), body);
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, id));
    if (!t) throw new NotFoundException('Título não encontrado.');
    if (t.status !== 'aberto' && t.status !== 'protestado') throw new BadRequestException('Só títulos em aberto podem mudar de pessoa.');
    if (t.cobrancaExternaId) throw new BadRequestException('Este título já tem boleto ou Pix gerado para outra pessoa. Cancele a cobrança antes.');
    const [p] = await this.db.select({ id: pessoas.id, nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p) throw new BadRequestException('Pessoa não encontrada.');
    const [r] = await this.db.update(titulos).set({ pessoaId }).where(eq(titulos.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'titulo', entidadeId: id, dados: { pessoaAntes: t.pessoaId, pessoaDepois: pessoaId, nome: p.nome } });
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

  /**
   * Recebíveis de cartão em aberto (a maquininha é quem paga), agrupados por dia previsto, forma e maquininha,
   * para conferir com o extrato da operadora e dar baixa de vários de uma vez.
   */
  @Get('cartao')
  @Permissao('financeiro', 'ver')
  async cartao(@Query('ate') ate?: string) {
    const limite = ate && /^\d{4}-\d{2}-\d{2}$/.test(ate) ? ate : null;
    const itens = await this.db
      .select({ id: titulos.id, descricao: titulos.descricao, valor: titulos.valor, vencimento: titulos.vencimento, forma: titulos.formaPagamento, parcela: titulos.parcela, totalParcelas: titulos.totalParcelas, empresaId: titulos.empresaId, empresa: empresas.nome })
      .from(titulos)
      .innerJoin(empresas, eq(empresas.id, titulos.empresaId))
      .where(and(eq(titulos.tipo, 'receber'), eq(titulos.status, 'aberto'), inArray(titulos.formaPagamento, ['debito', 'credito']), ...(limite ? [lte(titulos.vencimento, limite)] : [])))
      .orderBy(asc(titulos.vencimento), asc(titulos.criadoEm))
      .limit(2000);
    const comMaquininha = itens.map((t) => ({ ...t, maquininha: maquininhaDa(t.descricao) }));
    const grupos = new Map<string, { chave: string; vencimento: string; forma: string; maquininha: string; empresaId: string; empresa: string; total: number; ids: string[] }>();
    for (const t of comMaquininha) {
      const chave = `${t.vencimento}|${t.forma}|${t.maquininha}|${t.empresaId}`;
      const g = grupos.get(chave) ?? { chave, vencimento: t.vencimento, forma: t.forma!, maquininha: t.maquininha, empresaId: t.empresaId, empresa: t.empresa, total: 0, ids: [] };
      g.total += t.valor;
      g.ids.push(t.id);
      grupos.set(chave, g);
    }
    const h = hoje();
    return {
      hoje: h,
      itens: comMaquininha,
      grupos: [...grupos.values()],
      resumo: {
        vencido: comMaquininha.filter((t) => t.vencimento < h).reduce((a, t) => a + t.valor, 0),
        hoje: comMaquininha.filter((t) => t.vencimento === h).reduce((a, t) => a + t.valor, 0),
        aVencer: comMaquininha.filter((t) => t.vencimento > h).reduce((a, t) => a + t.valor, 0),
      },
    };
  }

  /**
   * Concilia um depósito da maquininha: baixa os títulos marcados pelo valor cheio (a receita continua bruta)
   * e lança a diferença como despesa paga "Taxas de cartão" na mesma conta. Assim o saldo da conta bate com o extrato.
   */
  @Post('cartao/conciliar')
  @Permissao('financeiro', 'editar')
  async conciliar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        ids: z.array(z.string().uuid()).min(1, 'Marque os recebimentos').max(2000),
        valorRecebido: centavos.refine((v) => v > 0, 'Informe o valor que caiu na conta'),
        recebidoEm: dataISO,
        contaId: z.string().uuid('Escolha a conta onde o dinheiro caiu'),
        aceitarDiferenca: z.boolean().default(false),
      }),
      body,
    );
    const ids = [...new Set(d.ids)];
    return this.db.transaction(async (tx) => {
      const ts = await tx.select().from(titulos).where(inArray(titulos.id, ids)).for('update');
      if (ts.length !== ids.length) throw new NotFoundException('Algum recebimento não foi encontrado.');
      const ruim = ts.find((t) => t.tipo !== 'receber' || t.status !== 'aberto' || !['debito', 'credito'].includes(t.formaPagamento ?? ''));
      if (ruim) throw new BadRequestException(`"${ruim.descricao}" não é um recebimento de cartão em aberto.`);
      const empresasDif = new Set(ts.map((t) => t.empresaId));
      if (empresasDif.size > 1) throw new BadRequestException('Marque recebimentos de uma empresa só (cada CNPJ tem sua maquininha e sua conta).');
      const [conta] = await tx.select().from(contas).where(eq(contas.id, d.contaId));
      if (!conta) throw new BadRequestException('Conta não encontrada.');
      if (conta.empresaId !== ts[0].empresaId) throw new BadRequestException('A conta escolhida é de outra empresa.');
      const bruto = ts.reduce((a, t) => a + t.valor, 0);
      const taxa = bruto - d.valorRecebido;
      if (taxa < 0) throw new BadRequestException(`Caiu mais (${(d.valorRecebido / 100).toFixed(2)}) do que o total marcado (${(bruto / 100).toFixed(2)}). Confira se falta marcar algum recebimento.`);
      const taxaPb = Math.round((taxa * 10000) / bruto);
      if (taxaPb > 1500 && !d.aceitarDiferenca) throw new BadRequestException(`A diferença é de ${(taxaPb / 100).toFixed(1).replace('.', ',')}% do total, alta para taxa de cartão. Confira o valor ou confirme a diferença.`);
      await tx.update(titulos).set({ status: 'pago', pagoEm: d.recebidoEm, valorPago: sql`${titulos.valor}`, contaId: d.contaId }).where(inArray(titulos.id, ids));
      const lote = randomUUID();
      let despesa = null;
      if (taxa > 0) {
        [despesa] = await tx
          .insert(titulos)
          .values({ empresaId: ts[0].empresaId, tipo: 'pagar', descricao: `Taxa da maquininha · ${ts.length} recebimento(s) de cartão`, categoria: 'Taxas de cartão', ...(await this.plano.daChave('taxas_cartao')), valor: taxa, vencimento: d.recebidoEm, formaPagamento: 'debito_em_conta', status: 'pago', pagoEm: d.recebidoEm, valorPago: taxa, contaId: d.contaId, origemTipo: 'conciliacao_cartao', origemId: lote })
          .returning();
      }
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'conciliar', entidade: 'titulo', entidadeId: despesa?.id ?? null, dados: { lote, ids, bruto, recebido: d.valorRecebido, taxa, contaId: d.contaId } }, tx);
      return { lote, quantidade: ts.length, bruto, recebido: d.valorRecebido, taxa, taxaPb, despesaId: despesa?.id ?? null };
    });
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

/** Nome da maquininha no fim da descrição do título de cartão ("Venda nº 12 · Cartão de crédito (1/3) · Stone"). */
export function maquininhaDa(descricao: string) {
  const partes = descricao.split(' · ');
  return partes.length >= 3 && !/^Cartão de/.test(partes[partes.length - 1]) ? partes[partes.length - 1] : 'Sem maquininha';
}
