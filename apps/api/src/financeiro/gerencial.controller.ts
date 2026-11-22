import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { DB, type Db } from '../comum/db.module';
import { centavos, dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { contas, empresas, planoContas, titulos } from '../db/schema';
import { numeros } from '../relatorios/fontes';
import { DreService, type Regime } from './dre.service';
import { GRUPOS_DRE, PlanoContasService } from './plano.service';

const uuid = z.string().uuid();
const TIPOS_CONTA = ['banco', 'caixa', 'carteira', 'aplicacao'] as const;

/** Financeiro gerencial: plano de contas, DRE, contas bancárias, transferências e extrato. */
/** Filtro de empresa vindo da URL: só aceita um uuid. */
const umaEmpresa = (v?: string) => {
  if (!v) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new BadRequestException('Empresa inválida.');
  return v;
};

@Controller('financeiro')
export class GerencialController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly plano: PlanoContasService,
    private readonly dre: DreService,
    private readonly auditoria: AuditoriaService,
  ) {}

  // ───── Plano de contas ─────

  @Get('plano-contas')
  @Permissao('financeiro', 'ver')
  async planoContas() {
    const [lista, uso] = await Promise.all([
      this.plano.todas(),
      this.db.select({ id: titulos.planoContaId, n: sql<number>`count(*)::int` }).from(titulos).where(sql`${titulos.planoContaId} is not null`).groupBy(titulos.planoContaId),
    ]);
    const usados = new Map(uso.map((u) => [u.id, u.n]));
    return { grupos: GRUPOS_DRE, contas: lista.map((c) => ({ ...c, titulos: usados.get(c.id) ?? 0, nivel: c.codigo.split('.').length })) };
  }

  private async proximoCodigo(pai: { id: string; codigo: string }) {
    const irmaos = await this.db.select({ codigo: planoContas.codigo }).from(planoContas).where(eq(planoContas.paiId, pai.id));
    const usados = new Set(irmaos.map((i) => i.codigo));
    for (let n = irmaos.length + 1; n < 1000; n++) {
      const codigo = `${pai.codigo}.${String(n).padStart(2, '0')}`;
      if (!usados.has(codigo)) return codigo;
    }
    throw new BadRequestException('Muitas contas neste grupo.');
  }

  private async codigoLivre(codigo: string, menosId?: string) {
    const [ja] = await this.db.select({ id: planoContas.id }).from(planoContas).where(eq(planoContas.codigo, codigo));
    if (ja && ja.id !== menosId) throw new BadRequestException(`Já existe uma conta com o código ${codigo}.`);
  }

  @Post('plano-contas')
  @Permissao('financeiro', 'editar')
  async criarConta(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2, 'Dê um nome à conta').max(80), paiId: uuid, codigo: z.string().trim().regex(/^\d+(\.\d+)*$/, 'Use números e pontos (ex.: 6.10)').max(20).optional() }), body);
    const [pai] = await this.db.select().from(planoContas).where(eq(planoContas.id, d.paiId));
    if (!pai) throw new BadRequestException('Escolha o grupo ou a conta em que esta entra.');
    if (pai.calculada) throw new BadRequestException(`"${pai.nome}" é calculada pelo sistema e não tem subcontas.`);
    if (pai.codigo.split('.').length >= 4) throw new BadRequestException('O plano vai até 4 níveis.');
    const codigo = d.codigo ?? (await this.proximoCodigo(pai));
    await this.codigoLivre(codigo);
    const [c] = await this.db.insert(planoContas).values({ nome: d.nome, paiId: pai.id, grupo: pai.grupo, codigo }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'plano_conta', entidadeId: c.id, dados: { codigo, nome: d.nome } });
    return c;
  }

  @Patch('plano-contas/:id')
  @Permissao('financeiro', 'editar')
  async editarConta(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80).optional(), codigo: z.string().trim().regex(/^\d+(\.\d+)*$/, 'Use números e pontos (ex.: 6.10)').max(20).optional(), paiId: uuid.optional(), ativo: z.boolean().optional() }), body);
    const todas = await this.plano.todas();
    const c = todas.find((x) => x.id === id);
    if (!c) throw new NotFoundException('Conta não encontrada.');
    const mudar: Partial<typeof planoContas.$inferInsert> = {};
    if (d.nome && d.nome !== c.nome) mudar.nome = d.nome;
    if (d.codigo && d.codigo !== c.codigo) {
      await this.codigoLivre(d.codigo, id);
      mudar.codigo = d.codigo;
    }
    if (d.ativo !== undefined && d.ativo !== c.ativo) {
      if (!c.paiId) throw new BadRequestException('Os grupos da DRE não podem ser desativados.');
      if (c.calculada || c.chave) throw new BadRequestException(`"${c.nome}" é usada pelo sistema e não pode ser desativada.`);
      mudar.ativo = d.ativo;
    }
    const descendentes: string[] = [];
    const descer = (pid: string) => todas.filter((x) => x.paiId === pid).forEach((x) => { descendentes.push(x.id); descer(x.id); });
    descer(id);
    let novoGrupo: string | null = null;
    if (d.paiId && d.paiId !== c.paiId) {
      if (!c.paiId) throw new BadRequestException('Os grupos da DRE ficam onde estão.');
      if (c.calculada) throw new BadRequestException(`"${c.nome}" é calculada pelo sistema e fica no grupo dela.`);
      const pai = todas.find((x) => x.id === d.paiId);
      if (!pai) throw new BadRequestException('Grupo de destino não encontrado.');
      if (pai.id === id || descendentes.includes(pai.id)) throw new BadRequestException('Uma conta não pode entrar dentro dela mesma.');
      if (pai.calculada) throw new BadRequestException(`"${pai.nome}" é calculada pelo sistema e não tem subcontas.`);
      const altura = (pid: string): number => 1 + Math.max(0, ...todas.filter((x) => x.paiId === pid).map((x) => altura(x.id)));
      if (pai.codigo.split('.').length + altura(id) > 4) throw new BadRequestException('O plano vai até 4 níveis.');
      mudar.paiId = pai.id;
      if (!d.codigo) mudar.codigo = await this.proximoCodigo(pai);
      if (pai.grupo !== c.grupo) novoGrupo = pai.grupo;
    }
    if (!Object.keys(mudar).length) return c;
    const [nova] = await this.db.transaction(async (tx) => {
      const r = await tx.update(planoContas).set({ ...mudar, ...(novoGrupo ? { grupo: novoGrupo } : {}) }).where(eq(planoContas.id, id)).returning();
      if (novoGrupo && descendentes.length) await tx.update(planoContas).set({ grupo: novoGrupo }).where(inArray(planoContas.id, descendentes));
      // O código das subcontas acompanha o da conta.
      if (mudar.codigo) for (const x of todas.filter((y) => descendentes.includes(y.id))) await tx.update(planoContas).set({ codigo: mudar.codigo + x.codigo.slice(c.codigo.length) }).where(eq(planoContas.id, x.id));
      // A categoria em texto dos títulos acompanha o nome da conta.
      if (mudar.nome) await tx.update(titulos).set({ categoria: mudar.nome }).where(eq(titulos.planoContaId, id));
      return r;
    });
    this.plano.esquecer();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'plano_conta', entidadeId: id, dados: { ...mudar, grupo: novoGrupo ?? undefined } });
    return nova;
  }

  @Delete('plano-contas/:id')
  @Permissao('financeiro', 'excluir')
  async excluirConta(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [c] = await this.db.select().from(planoContas).where(eq(planoContas.id, id));
    if (!c) throw new NotFoundException('Conta não encontrada.');
    if (!c.paiId) throw new BadRequestException('Os grupos da DRE não podem ser excluídos.');
    if (c.calculada || c.chave) throw new BadRequestException(`"${c.nome}" é usada pelo sistema e não pode ser excluída.`);
    const [filho] = await this.db.select({ id: planoContas.id }).from(planoContas).where(eq(planoContas.paiId, id)).limit(1);
    if (filho) throw new BadRequestException('Esta conta tem subcontas. Exclua ou mova as subcontas antes.');
    const [uso] = await this.db.select({ n: sql<number>`count(*)::int` }).from(titulos).where(eq(titulos.planoContaId, id));
    if (uso.n) throw new BadRequestException(`Há ${uso.n} lançamento(s) nesta conta. Desative a conta (ela some das listas e o histórico fica) ou reclassifique os lançamentos antes.`);
    await this.db.delete(planoContas).where(eq(planoContas.id, id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'plano_conta', entidadeId: id, dados: { codigo: c.codigo, nome: c.nome } });
    return { ok: true };
  }

  // ───── Classificação dos títulos ─────

  /** Classifica vários títulos de uma vez (ou tira a classificação, com planoContaId nulo). */
  @Post('titulos/classificar')
  @Permissao('financeiro', 'editar')
  async classificar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ ids: z.array(uuid).min(1, 'Marque os títulos').max(1000), planoContaId: uuid.nullable() }), body);
    const conta = d.planoContaId ? await this.plano.paraLancar(d.planoContaId) : null;
    const r = await this.db.update(titulos).set({ planoContaId: conta?.id ?? null, categoria: conta?.nome ?? null }).where(inArray(titulos.id, d.ids)).returning({ id: titulos.id });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'classificar', entidade: 'titulo', dados: { quantidade: r.length, conta: conta ? `${conta.codigo} ${conta.nome}` : null } });
    return { classificados: r.length };
  }

  /** Corrige um título: descrição e conta sempre; vencimento e valor só enquanto está em aberto e sem boleto emitido. */
  @Patch('titulos/:id')
  @Permissao('financeiro', 'editar')
  async editarTitulo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ descricao: z.string().trim().min(2).max(200).optional(), planoContaId: uuid.nullable().optional(), vencimento: dataISO.optional(), valor: centavos.refine((v) => v > 0, 'Informe o valor').optional() }), body);
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, id));
    if (!t) throw new NotFoundException('Título não encontrado.');
    const mudar: Partial<typeof titulos.$inferInsert> = {};
    if (d.descricao) mudar.descricao = d.descricao;
    if (d.planoContaId !== undefined) {
      const conta = d.planoContaId ? await this.plano.paraLancar(d.planoContaId) : null;
      mudar.planoContaId = conta?.id ?? null;
      mudar.categoria = conta?.nome ?? null;
    }
    if ((d.vencimento && d.vencimento !== t.vencimento) || (d.valor && d.valor !== t.valor)) {
      if (t.status !== 'aberto') throw new BadRequestException(`O título está ${t.status}: só a descrição e a conta podem mudar.`);
      if (t.cobrancaExternaId) throw new BadRequestException('Este título já tem boleto ou Pix emitido. Emita a 2ª via pela Cobrança para mudar valor ou vencimento.');
      if (t.origemTipo && d.valor && d.valor !== t.valor) throw new BadRequestException('O valor deste título veio de uma venda, acerto ou acordo e não pode ser alterado aqui.');
      if (d.vencimento) mudar.vencimento = d.vencimento;
      if (d.valor) mudar.valor = d.valor;
    }
    if (!Object.keys(mudar).length) return t;
    const [novo] = await this.db.update(titulos).set(mudar).where(eq(titulos.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'titulo', entidadeId: id, dados: mudar });
    return novo;
  }

  // ───── DRE ─────

  @Get('dre')
  @Permissao('financeiro', 'ver')
  demonstrativo(@Query('de') de?: string, @Query('ate') ate?: string, @Query('regime') regime?: string, @Query('empresaId') empresaId?: string) {
    return this.dre.montar({ de, ate, regime: regime === 'competencia' ? 'competencia' : 'caixa', empresaId: umaEmpresa(empresaId) });
  }

  @Get('dre/lancamentos')
  @Permissao('financeiro', 'ver')
  lancamentos(@Query('contaId') contaId = '', @Query('mes') mes = '', @Query('regime') regime?: string, @Query('empresaId') empresaId?: string) {
    return this.dre.lancamentos({ contaId, mes, regime: (regime === 'competencia' ? 'competencia' : 'caixa') as Regime, empresaId: umaEmpresa(empresaId) });
  }

  // ───── Contas bancárias e caixas ─────

  private contaSchema = z.object({
    empresaId: uuid,
    nome: z.string().trim().min(2, 'Dê um nome à conta').max(60),
    tipo: z.enum(TIPOS_CONTA).default('banco'),
    saldoInicial: z.number().int().min(-100_000_000_00).max(100_000_000_00).default(0),
    banco: z.string().trim().max(60).nullable().optional(),
    agencia: z.string().trim().max(20).nullable().optional(),
    numero: z.string().trim().max(30).nullable().optional(),
    pix: z.string().trim().max(120).nullable().optional(),
    observacao: z.string().trim().max(300).nullable().optional(),
    ativo: z.boolean().default(true),
  });

  /** Cadastro completo (com as desativadas), com saldo de hoje e quantos lançamentos cada conta tem. */
  @Get('contas-cadastro')
  @Permissao('financeiro', 'ver')
  async cadastroContas() {
    return numeros<Record<string, unknown>>(
      await this.db.execute(sql`
        select c.id, c.empresa_id as "empresaId", e.nome as empresa, c.nome, c.tipo, c.saldo_inicial as "saldoInicial", c.ativo, c.banco, c.agencia, c.numero, c.pix, c.observacao,
          (c.saldo_inicial + coalesce((select sum(case when t.tipo = 'receber' then t.valor_pago else -t.valor_pago end) from titulos t where t.conta_id = c.id and t.status = 'pago'), 0))::bigint as saldo,
          (select count(*) from titulos t where t.conta_id = c.id)::int as lancamentos
        from contas c join empresas e on e.id = c.empresa_id order by c.ativo desc, c.nome`),
    );
  }

  @Post('contas')
  @Permissao('financeiro', 'editar')
  async criarContaBancaria(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(this.contaSchema, body);
    const [e] = await this.db.select({ id: empresas.id }).from(empresas).where(eq(empresas.id, d.empresaId));
    if (!e) throw new BadRequestException('Empresa não encontrada.');
    const [ja] = await this.db.select({ id: contas.id }).from(contas).where(and(eq(contas.empresaId, d.empresaId), sql`lower(${contas.nome}) = lower(${d.nome})`));
    if (ja) throw new BadRequestException('Já existe uma conta com esse nome nesta empresa.');
    const [c] = await this.db.insert(contas).values(d).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'conta', entidadeId: c.id, dados: { nome: c.nome, tipo: c.tipo, saldoInicial: c.saldoInicial } });
    return c;
  }

  @Patch('contas/:id')
  @Permissao('financeiro', 'editar')
  async editarContaBancaria(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(this.contaSchema.partial().omit({ empresaId: true }), body);
    const [atual] = await this.db.select().from(contas).where(eq(contas.id, id));
    if (!atual) throw new NotFoundException('Conta não encontrada.');
    if (d.ativo === false && atual.ativo) {
      const [s] = numeros<{ saldo: number }>(
        await this.db.execute(sql`select (c.saldo_inicial + coalesce((select sum(case when t.tipo = 'receber' then t.valor_pago else -t.valor_pago end) from titulos t where t.conta_id = c.id and t.status = 'pago'), 0))::bigint as saldo from contas c where c.id = ${id}`),
      );
      if (s.saldo !== 0) throw new BadRequestException('A conta ainda tem saldo. Transfira o saldo para outra conta antes de desativar.');
    }
    const [c] = await this.db.update(contas).set(d).where(eq(contas.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'conta', entidadeId: id, dados: d });
    return c;
  }

  /** Transferência entre contas: sai de uma e entra na outra no mesmo dia, sem mexer no resultado. */
  @Post('transferencias')
  @Permissao('financeiro', 'editar')
  async transferir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ origemId: uuid, destinoId: uuid, valor: centavos.refine((v) => v > 0, 'Informe o valor'), data: dataISO, descricao: z.string().trim().max(120).nullable().optional() }), body);
    if (d.origemId === d.destinoId) throw new BadRequestException('Escolha duas contas diferentes.');
    const cs = await this.db.select().from(contas).where(inArray(contas.id, [d.origemId, d.destinoId]));
    const origem = cs.find((c) => c.id === d.origemId);
    const destino = cs.find((c) => c.id === d.destinoId);
    if (!origem || !destino) throw new BadRequestException('Conta não encontrada.');
    if (!origem.ativo || !destino.ativo) throw new BadRequestException('Uma das contas está desativada.');
    if (d.data > new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)) throw new BadRequestException('A data da transferência não pode ser no futuro.');
    const plano = await this.plano.daChave('transferencias');
    const lote = randomUUID();
    const base = { ...plano, categoria: 'Transferência entre contas', valor: d.valor, vencimento: d.data, status: 'pago' as const, pagoEm: d.data, valorPago: d.valor, formaPagamento: 'transferencia', origemTipo: 'transferencia', origemId: lote };
    const sufixo = d.descricao ? ` · ${d.descricao}` : '';
    await this.db.transaction(async (tx) => {
      await tx.insert(titulos).values({ ...base, empresaId: origem.empresaId, tipo: 'pagar', contaId: origem.id, descricao: `Transferência para ${destino.nome}${sufixo}` });
      await tx.insert(titulos).values({ ...base, empresaId: destino.empresaId, tipo: 'receber', contaId: destino.id, descricao: `Transferência de ${origem.nome}${sufixo}` });
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'transferir', entidade: 'conta', entidadeId: origem.id, dados: { destino: destino.id, valor: d.valor, data: d.data, lote } }, tx);
    });
    return { ok: true, lote };
  }

  /** Extrato da conta no período, com saldo anterior e saldo linha a linha. */
  @Get('contas/:id/extrato')
  @Permissao('financeiro', 'ver')
  async extrato(@Param('id', ParseUUIDPipe) id: string, @Query('de') de?: string, @Query('ate') ate?: string) {
    const [c] = await this.db.select().from(contas).where(eq(contas.id, id));
    if (!c) throw new NotFoundException('Conta não encontrada.');
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const dia = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const fim = dia(ate) ?? hoje;
    const ini = dia(de) ?? `${fim.slice(0, 8)}01`;
    const [ant] = numeros<{ v: number }>(
      await this.db.execute(sql`select coalesce(sum(case when tipo = 'receber' then valor_pago else -valor_pago end), 0) as v from titulos where conta_id = ${id} and status = 'pago' and pago_em < ${ini}::date`),
    );
    let saldo = c.saldoInicial + ant.v;
    const saldoAnterior = saldo;
    const linhas = numeros<{ id: string; tipo: string; valor: number } & Record<string, unknown>>(
      await this.db.execute(sql`
        select t.id, t.pago_em as data, t.tipo, t.descricao, t.valor_pago as valor, t.forma_pagamento as "formaPagamento", p.nome as pessoa, pc.codigo, pc.nome as conta
        from titulos t left join pessoas p on p.id = t.pessoa_id left join plano_contas pc on pc.id = t.plano_conta_id
        where t.conta_id = ${id} and t.status = 'pago' and t.pago_em between ${ini}::date and ${fim}::date
        order by t.pago_em, t.criado_em limit 2000`),
    ).map((l) => {
      saldo += l.tipo === 'receber' ? l.valor : -l.valor;
      return { ...l, saldo };
    });
    return {
      conta: { id: c.id, nome: c.nome, tipo: c.tipo },
      de: ini,
      ate: fim,
      saldoAnterior,
      entradas: linhas.filter((l) => l.tipo === 'receber').reduce((a, l) => a + l.valor, 0),
      saidas: linhas.filter((l) => l.tipo === 'pagar').reduce((a, l) => a + l.valor, 0),
      saldoFinal: saldo,
      linhas,
    };
  }
}
