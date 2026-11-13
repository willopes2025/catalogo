import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, BadRequestException } from '@nestjs/common';
import { and, asc, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { contas, empresas, pessoas, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

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
});

@Controller('financeiro')
export class FinanceiroController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

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
      const venc = new Date(Date.UTC(a, m - 1 + i, dia)).toISOString().slice(0, 10);
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
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, id));
    if (!t) throw new NotFoundException('Título não encontrado.');
    if (t.status !== 'aberto') throw new BadRequestException(`Título está ${t.status}.`);
    const [r] = await this.db
      .update(titulos)
      .set({ status: 'pago', pagoEm: d.pagoEm ?? hoje(), valorPago: d.valorPago ?? t.valor, contaId: d.contaId ?? null, formaPagamento: d.formaPagamento ?? t.formaPagamento })
      .where(eq(titulos.id, id))
      .returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'baixar', entidade: 'titulo', entidadeId: id, dados: d });
    return r;
  }
}
