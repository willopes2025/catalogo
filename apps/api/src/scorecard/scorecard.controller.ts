import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { REGRAS_SCORECARD_PADRAO, calcularScorecard, notaIndicador, type RegrasScorecard } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { sqlAtivos, sqlChurn, sqlChurnPercentual, sqlRenovacoes } from '../relatorios/consignado';
import { bscAvaliacoes, bscIndicadores, bscOcorrencias, bscResultados, configuracoes, grupos, usuarios } from '../db/schema';

const CHAVE_REGRAS = 'scorecard_regras';
const uuid = z.string().uuid();
const mesRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const limitesDoMes = (mes: string) => {
  const [a, m] = mes.split('-').map(Number);
  const fim = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
  return { ini: `${mes}-01`, fim };
};

/** Contas que o sistema faz sozinho para um indicador, pessoa a pessoa. */
const FONTES: Record<string, { nome: string; unidade: 'numero' | 'reais' | 'percentual'; sentido: 'maior' | 'menor'; ajuda: string; sql: (u: string, ini: string, fim: string) => ReturnType<typeof sql> }> = {
  vendas_valor: { nome: 'Vendas de loja (valor)', unidade: 'reais', sentido: 'maior', ajuda: 'Soma das vendas concluídas em que a pessoa é a vendedora, menos devoluções.', sql: (u, i, f) => sql`select coalesce(sum(total - devolvido), 0) as v from vendas where vendedor_id = ${u}::uuid and status = 'concluida' and (criado_em at time zone 'America/Sao_Paulo')::date between ${i}::date and ${f}::date` },
  vendas_quantidade: { nome: 'Vendas de loja (quantidade)', unidade: 'numero', sentido: 'maior', ajuda: 'Quantas vendas concluídas a pessoa fez.', sql: (u, i, f) => sql`select count(*) as v from vendas where vendedor_id = ${u}::uuid and status = 'concluida' and (criado_em at time zone 'America/Sao_Paulo')::date between ${i}::date and ${f}::date` },
  conversas_atendidas: { nome: 'Conversas atendidas no CRM', unidade: 'numero', sentido: 'maior', ajuda: 'Conversas em que a pessoa mandou ao menos uma mensagem no mês.', sql: (u, i, f) => sql`select count(distinct conversa_id) as v from crm_mensagens where usuario_id = ${u}::uuid and direcao = 'saida' and (criado_em at time zone 'America/Sao_Paulo')::date between ${i}::date and ${f}::date` },
  tarefas_concluidas: { nome: 'Tarefas concluídas', unidade: 'numero', sentido: 'maior', ajuda: 'Tarefas da Minha mesa concluídas no mês.', sql: (u, i, f) => sql`select count(*) as v from mesa_tarefas where responsavel_id = ${u}::uuid and (feita_em at time zone 'America/Sao_Paulo')::date between ${i}::date and ${f}::date` },
  tarefas_no_prazo: { nome: 'Tarefas feitas no prazo (%)', unidade: 'percentual', sentido: 'maior', ajuda: 'Das tarefas com prazo no mês, quantas foram concluídas até o prazo.', sql: (u, i, f) => sql`select case when count(*) = 0 then null else round(100.0 * count(*) filter (where feita_em is not null and (feita_em at time zone 'America/Sao_Paulo')::date <= vence_em) / count(*), 1) end as v from mesa_tarefas where responsavel_id = ${u}::uuid and vence_em between ${i}::date and ${f}::date` },
  tarefas_atrasadas: { nome: 'Tarefas atrasadas', unidade: 'numero', sentido: 'menor', ajuda: 'Tarefas com prazo no mês que passaram do prazo (feitas depois ou ainda abertas).', sql: (u, i, f) => sql`select count(*) as v from mesa_tarefas where responsavel_id = ${u}::uuid and vence_em between ${i}::date and ${f}::date and vence_em < (now() at time zone 'America/Sao_Paulo')::date and (feita_em is null or (feita_em at time zone 'America/Sao_Paulo')::date > vence_em)` },
};

// Consignado da carteira da pessoa (consultoras com ela como supervisora).
FONTES.pedidos_ativos = { nome: 'Pedidos ativos da carteira', unidade: 'numero', sentido: 'maior', ajuda: 'Pedidos (maletas) com as consultoras da carteira dela no fim do mês (ou hoje, no mês corrente).', sql: (u, _i, f) => sqlAtivos(f < new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10) ? f : new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10), u) };
FONTES.renovacoes = { nome: 'Renovações da carteira', unidade: 'numero', sentido: 'maior', ajuda: 'Pedidos novos no mês de consultoras da carteira que já tinham tido pedido.', sql: (u, i, f) => sqlRenovacoes(i, f, u) };
FONTES.churn = { nome: 'Churn da carteira (quantidade)', unidade: 'numero', sentido: 'menor', ajuda: 'Consultoras da carteira com pedido baixado no mês que não pegaram outro.', sql: (u, i, f) => sqlChurn(i, f, u) };
FONTES.churn_percentual = { nome: 'Churn da carteira (%)', unidade: 'percentual', sentido: 'menor', ajuda: 'Das consultoras da carteira com pedido baixado no mês, quantas não renovaram.', sql: (u, i, f) => sqlChurnPercentual(i, f, u) };

const indicadorSchema = z
  .object({
    nome: z.string().trim().min(2, 'Dê um nome ao indicador').max(120),
    descricao: z.string().trim().max(500).nullable().optional(),
    perspectiva: z.enum(['financeira', 'clientes', 'processos', 'aprendizado']).default('processos'),
    fonte: z.string().refine((f) => f === 'manual' || !!FONTES[f], 'Conta automática desconhecida').default('manual'),
    unidade: z.enum(['numero', 'reais', 'percentual']).default('numero'),
    meta: z.number().min(0, 'A meta não pode ser negativa').max(1e12),
    sentido: z.enum(['maior', 'menor']).default('maior'),
    peso: z.number().int().min(1, 'Peso mínimo 1').max(100),
    grupoId: uuid.nullable().optional(),
    usuarioId: uuid.nullable().optional(),
    ativo: z.boolean().default(true),
  })
  .refine((d) => !(d.grupoId && d.usuarioId), { message: 'Escolha um setor ou uma pessoa, não os dois', path: ['usuarioId'] });

const regrasSchema = z.object({
  teto: z.number().int().min(100, 'O teto mínimo é 100').max(200),
  limiteOcorrencias: z.number().min(0).max(100),
  bonusPadrao: z.number().int().min(0).max(100_000_000),
  bonusPorSetor: z.record(uuid, z.number().int().min(0).max(100_000_000)),
  faixas: z.array(z.object({ notaMinima: z.number().min(0).max(200), percentual: z.number().min(0).max(1000) })).max(10),
  mostrarAoFuncionario: z.boolean(),
});

/**
 * Scorecard da equipe: indicadores com meta e peso (por todos, setor ou pessoa), acertos e erros do mês,
 * avaliação mensal feita pela gestão e o bônus pela faixa da nota. Tudo configurado pela tela.
 * Ninguém fecha a própria avaliação.
 */
@Controller('scorecard')
export class ScorecardController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  private async regras(): Promise<RegrasScorecard> {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, CHAVE_REGRAS));
    return { ...REGRAS_SCORECARD_PADRAO, ...((c?.valor as Partial<RegrasScorecard>) ?? {}) };
  }

  @Get('regras')
  @Permissao('scorecard', 'ver')
  async verRegras() {
    return {
      regras: await this.regras(),
      fontes: Object.entries(FONTES).map(([chave, f]) => ({ chave, nome: f.nome, unidade: f.unidade, sentido: f.sentido, ajuda: f.ajuda })),
      setores: await this.db.select({ id: grupos.id, nome: grupos.nome }).from(grupos).orderBy(asc(grupos.nome)),
    };
  }

  @Put('regras')
  @Permissao('scorecard', 'editar')
  async salvarRegras(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(regrasSchema, body);
    await this.db.insert(configuracoes).values({ chave: CHAVE_REGRAS, valor: d }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: d, atualizadoEm: new Date() } });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'configurar', entidade: 'scorecard_regras', dados: d });
    return d;
  }

  // ───────── Indicadores ─────────

  @Get('indicadores')
  @Permissao('scorecard', 'ver')
  async indicadores() {
    return this.db
      .select({ i: bscIndicadores, setor: grupos.nome, pessoa: usuarios.nome })
      .from(bscIndicadores)
      .leftJoin(grupos, eq(grupos.id, bscIndicadores.grupoId))
      .leftJoin(usuarios, eq(usuarios.id, bscIndicadores.usuarioId))
      .orderBy(asc(bscIndicadores.perspectiva), asc(bscIndicadores.nome))
      .then((l) => l.map((x) => ({ ...x.i, setor: x.setor, pessoa: x.pessoa })));
  }

  @Post('indicadores')
  @Permissao('scorecard', 'editar')
  async criarIndicador(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(indicadorSchema, body);
    const [i] = await this.db.insert(bscIndicadores).values({ ...d, descricao: d.descricao || null, grupoId: d.grupoId ?? null, usuarioId: d.usuarioId ?? null }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'scorecard_indicador', entidadeId: i.id });
    return i;
  }

  @Patch('indicadores/:id')
  @Permissao('scorecard', 'editar')
  async mudarIndicador(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(bscIndicadores).where(eq(bscIndicadores.id, id));
    if (!atual) throw new NotFoundException('Indicador não encontrado.');
    const d = validar(indicadorSchema, { ...atual, descricao: atual.descricao, ...(body as object) });
    const [i] = await this.db.update(bscIndicadores).set({ ...d, descricao: d.descricao || null, grupoId: d.grupoId ?? null, usuarioId: d.usuarioId ?? null }).where(eq(bscIndicadores.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'scorecard_indicador', entidadeId: id });
    return i;
  }

  /** Apaga o indicador. As avaliações já fechadas guardam a foto dele e não mudam. */
  @Delete('indicadores/:id')
  @Permissao('scorecard', 'excluir')
  async apagarIndicador(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [i] = await this.db.delete(bscIndicadores).where(eq(bscIndicadores.id, id)).returning({ id: bscIndicadores.id });
    if (!i) throw new NotFoundException('Indicador não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'scorecard_indicador', entidadeId: id });
    return { ok: true };
  }

  // ───────── Acertos e erros ─────────

  @Get('ocorrencias')
  @Permissao('scorecard', 'ver')
  async ocorrencias(@Query('mes') mes = mesAtual(), @Query('usuarioId') usuarioId?: string) {
    if (!mesRe.test(mes)) throw new BadRequestException('Mês inválido.');
    const { ini, fim } = limitesDoMes(mes);
    const f = [gte(bscOcorrencias.data, ini), lte(bscOcorrencias.data, fim)];
    if (usuarioId) f.push(eq(bscOcorrencias.usuarioId, validar(uuid, usuarioId)));
    const quem = sql<string>`(select nome from usuarios where id = ${bscOcorrencias.registradoPor})`;
    return this.db
      .select({ id: bscOcorrencias.id, usuarioId: bscOcorrencias.usuarioId, pessoa: usuarios.nome, data: bscOcorrencias.data, tipo: bscOcorrencias.tipo, pontos: bscOcorrencias.pontos, descricao: bscOcorrencias.descricao, registradoPor: quem })
      .from(bscOcorrencias)
      .innerJoin(usuarios, eq(usuarios.id, bscOcorrencias.usuarioId))
      .where(and(...f))
      .orderBy(asc(bscOcorrencias.data), asc(bscOcorrencias.criadoEm));
  }

  private async fechada(usuarioId: string, mes: string) {
    const [a] = await this.db.select({ status: bscAvaliacoes.status }).from(bscAvaliacoes).where(and(eq(bscAvaliacoes.usuarioId, usuarioId), eq(bscAvaliacoes.mes, mes)));
    return a?.status === 'fechada';
  }

  @Post('ocorrencias')
  @Permissao('scorecard', 'criar')
  async registrar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        usuarioId: uuid,
        data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida'),
        tipo: z.enum(['acerto', 'erro']),
        pontos: z.number().positive('Os pontos precisam ser maiores que zero').max(100),
        descricao: z.string().trim().min(5, 'Conte o que aconteceu').max(1000),
      }),
      body,
    );
    if (d.usuarioId === u.id) throw new ForbiddenException('Ninguém registra acerto ou erro de si mesmo.');
    if (d.data > new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)) throw new BadRequestException('A data não pode ser no futuro.');
    if (await this.fechada(d.usuarioId, d.data.slice(0, 7))) throw new BadRequestException('A avaliação deste mês já foi fechada. Reabra para mudar.');
    const [o] = await this.db.insert(bscOcorrencias).values({ ...d, registradoPor: u.id }).returning();
    return o;
  }

  @Delete('ocorrencias/:id')
  @Permissao('scorecard', 'editar')
  async apagarOcorrencia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [o] = await this.db.select().from(bscOcorrencias).where(eq(bscOcorrencias.id, id));
    if (!o) throw new NotFoundException('Registro não encontrado.');
    if (await this.fechada(o.usuarioId, o.data.slice(0, 7))) throw new BadRequestException('A avaliação deste mês já foi fechada. Reabra para mudar.');
    await this.db.delete(bscOcorrencias).where(eq(bscOcorrencias.id, id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'scorecard_ocorrencia', entidadeId: id, dados: { tipo: o.tipo, pontos: o.pontos } });
    return { ok: true };
  }

  // ───────── Avaliação ─────────

  /** Monta a avaliação de uma pessoa no mês: indicadores que valem para ela, contas automáticas, o que já foi lançado e a conta. */
  private async montar(usuarioId: string, mes: string) {
    const [pessoa] = await this.db.select({ id: usuarios.id, nome: usuarios.nome, grupoId: usuarios.grupoId, setor: grupos.nome }).from(usuarios).innerJoin(grupos, eq(grupos.id, usuarios.grupoId)).where(eq(usuarios.id, usuarioId));
    if (!pessoa) throw new NotFoundException('Pessoa não encontrada.');
    const regras = await this.regras();
    const bonusCheio = regras.bonusPorSetor[pessoa.grupoId] ?? regras.bonusPadrao;
    const [av] = await this.db.select().from(bscAvaliacoes).where(and(eq(bscAvaliacoes.usuarioId, usuarioId), eq(bscAvaliacoes.mes, mes)));
    const { ini, fim } = limitesDoMes(mes);
    const ocorrencias = await this.db.select().from(bscOcorrencias).where(and(eq(bscOcorrencias.usuarioId, usuarioId), gte(bscOcorrencias.data, ini), lte(bscOcorrencias.data, fim))).orderBy(asc(bscOcorrencias.data));
    const salvos = av ? await this.db.select().from(bscResultados).where(eq(bscResultados.avaliacaoId, av.id)) : [];
    type Linha = { indicadorId: string; nome: string; perspectiva: string; unidade: string; meta: number; sentido: 'maior' | 'menor'; peso: number; fonte: string; automatico: number | null; resultado: number | null; comentario: string | null };
    let linhas: Linha[];
    if (av?.status === 'fechada') {
      linhas = salvos.map((r) => ({ ...r, sentido: r.sentido as 'maior' | 'menor', fonte: 'fechada', automatico: null }));
    } else {
      const inds = await this.db
        .select()
        .from(bscIndicadores)
        .where(and(eq(bscIndicadores.ativo, true), or(and(isNull(bscIndicadores.grupoId), isNull(bscIndicadores.usuarioId)), eq(bscIndicadores.grupoId, pessoa.grupoId), eq(bscIndicadores.usuarioId, usuarioId))))
        .orderBy(asc(bscIndicadores.perspectiva), asc(bscIndicadores.nome));
      const porId = new Map(salvos.map((r) => [r.indicadorId, r]));
      linhas = await Promise.all(
        inds.map(async (i) => {
          const f = FONTES[i.fonte];
          const v = f ? (await this.db.execute<{ v: string | null }>(f.sql(usuarioId, ini, fim))).rows[0]?.v : null;
          const automatico = v === null || v === undefined ? null : Number(v);
          const s = porId.get(i.id);
          // Lançado à mão vale; sem lançamento, vale a conta automática.
          const resultado = s && s.resultado !== null ? s.resultado : automatico;
          return { indicadorId: i.id, nome: i.nome, perspectiva: i.perspectiva, unidade: i.unidade, meta: i.meta, sentido: i.sentido as 'maior' | 'menor', peso: i.peso, fonte: i.fonte, automatico, resultado, comentario: s?.comentario ?? null };
        }),
      );
    }
    const conta = calcularScorecard(linhas, ocorrencias.map((o) => ({ tipo: o.tipo as 'acerto' | 'erro', pontos: o.pontos })), regras, bonusCheio);
    return {
      pessoa,
      mes,
      avaliacao: av ? { id: av.id, status: av.status, observacao: av.observacao, fechadaEm: av.fechadaEm, avaliadorId: av.avaliadorId } : null,
      indicadores: linhas.map((l, k) => ({ ...l, nota: conta.notas[k] })),
      ocorrencias,
      conta: av?.status === 'fechada' ? { ...conta, notaIndicadores: av.notaIndicadores, ajuste: av.ajuste ?? conta.ajuste, notaFinal: av.nota, percentualBonus: av.percentualBonus ?? 0, bonus: av.bonus ?? 0 } : conta,
      bonusCheio,
      faixas: regras.faixas,
    };
  }

  /** Todas as pessoas ativas no mês, com a nota (prévia nas abertas) e o bônus. */
  @Get('mes')
  @Permissao('scorecard', 'ver')
  async mes(@Query('mes') mes = mesAtual()) {
    if (!mesRe.test(mes)) throw new BadRequestException('Mês inválido.');
    const pessoas = await this.db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.ativo, true)).orderBy(asc(usuarios.nome));
    const itens = [];
    for (const p of pessoas) {
      const m = await this.montar(p.id, mes);
      itens.push({ usuarioId: p.id, nome: m.pessoa.nome, setor: m.pessoa.setor, status: m.avaliacao?.status ?? 'nao_iniciada', indicadores: m.indicadores.length, semResultado: m.indicadores.filter((i) => i.resultado === null).length, acertos: m.conta.acertos, erros: m.conta.erros, nota: m.conta.notaFinal, percentualBonus: m.conta.percentualBonus, bonus: m.conta.bonus });
    }
    return { mes, itens, totalBonus: itens.filter((i) => i.status === 'fechada').reduce((a, i) => a + i.bonus, 0) };
  }

  @Get('avaliacao')
  @Permissao('scorecard', 'ver')
  async avaliacao(@Query('usuarioId', ParseUUIDPipe) usuarioId: string, @Query('mes') mes = mesAtual()) {
    if (!mesRe.test(mes)) throw new BadRequestException('Mês inválido.');
    return this.montar(usuarioId, mes);
  }

  /** Guarda os resultados lançados (a avaliação continua aberta). */
  @Put('avaliacao')
  @Permissao('scorecard', 'editar')
  async salvar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        usuarioId: uuid,
        mes: z.string().regex(mesRe, 'Mês inválido'),
        observacao: z.string().trim().max(2000).nullable().optional(),
        resultados: z.array(z.object({ indicadorId: uuid, resultado: z.number().min(0).max(1e12).nullable(), comentario: z.string().trim().max(500).nullable().optional() })).max(60),
      }),
      body,
    );
    if (d.usuarioId === u.id) throw new ForbiddenException('Ninguém avalia a si mesmo.');
    const atual = await this.montar(d.usuarioId, d.mes);
    if (atual.avaliacao?.status === 'fechada') throw new BadRequestException('A avaliação já foi fechada. Reabra para mudar.');
    const porId = new Map(atual.indicadores.map((i) => [i.indicadorId, i]));
    await this.db.transaction(async (tx) => {
      const [av] = await tx
        .insert(bscAvaliacoes)
        .values({ usuarioId: d.usuarioId, mes: d.mes, observacao: d.observacao ?? null, avaliadorId: u.id })
        .onConflictDoUpdate({ target: [bscAvaliacoes.usuarioId, bscAvaliacoes.mes], set: { ...(d.observacao !== undefined ? { observacao: d.observacao } : {}), avaliadorId: u.id } })
        .returning();
      for (const r of d.resultados) {
        const i = porId.get(r.indicadorId);
        if (!i) continue;
        const linha = { avaliacaoId: av.id, indicadorId: i.indicadorId, nome: i.nome, perspectiva: i.perspectiva, unidade: i.unidade, meta: i.meta, sentido: i.sentido, peso: i.peso, resultado: r.resultado, nota: null, comentario: r.comentario || null };
        await tx.insert(bscResultados).values(linha).onConflictDoUpdate({ target: [bscResultados.avaliacaoId, bscResultados.indicadorId], set: { resultado: r.resultado, comentario: linha.comentario } });
      }
    });
    return this.montar(d.usuarioId, d.mes);
  }

  /** Fecha a avaliação: grava a foto dos indicadores, a nota e o bônus. */
  @Post('avaliacao/fechar')
  @Permissao('scorecard', 'editar')
  async fechar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ usuarioId: uuid, mes: z.string().regex(mesRe, 'Mês inválido') }), body);
    if (d.usuarioId === u.id) throw new ForbiddenException('Ninguém fecha a própria avaliação.');
    if (d.mes > mesAtual()) throw new BadRequestException('Não dá para fechar um mês que ainda não começou.');
    const m = await this.montar(d.usuarioId, d.mes);
    if (m.avaliacao?.status === 'fechada') throw new BadRequestException('Esta avaliação já está fechada.');
    if (!m.indicadores.length) throw new BadRequestException('Esta pessoa não tem indicadores. Cadastre em Indicadores.');
    if (m.conta.notaFinal === null) throw new BadRequestException('Lance o resultado de ao menos um indicador.');
    const regras = await this.regras();
    await this.db.transaction(async (tx) => {
      const [av] = await tx
        .insert(bscAvaliacoes)
        .values({ usuarioId: d.usuarioId, mes: d.mes, avaliadorId: u.id })
        .onConflictDoUpdate({ target: [bscAvaliacoes.usuarioId, bscAvaliacoes.mes], set: { avaliadorId: u.id } })
        .returning();
      await tx.delete(bscResultados).where(eq(bscResultados.avaliacaoId, av.id));
      await tx.insert(bscResultados).values(m.indicadores.map((i) => ({ avaliacaoId: av.id, indicadorId: i.indicadorId, nome: i.nome, perspectiva: i.perspectiva, unidade: i.unidade, meta: i.meta, sentido: i.sentido, peso: i.peso, resultado: i.resultado, nota: notaIndicador(i, regras.teto), comentario: i.comentario })));
      await tx.update(bscAvaliacoes).set({ status: 'fechada', notaIndicadores: m.conta.notaIndicadores, ajuste: m.conta.ajuste, nota: m.conta.notaFinal, percentualBonus: m.conta.percentualBonus, bonus: m.conta.bonus, fechadaEm: new Date(), avaliadorId: u.id }).where(eq(bscAvaliacoes.id, av.id));
    });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'fechar', entidade: 'scorecard_avaliacao', dados: { usuarioId: d.usuarioId, mes: d.mes, nota: m.conta.notaFinal, bonus: m.conta.bonus } });
    return this.montar(d.usuarioId, d.mes);
  }

  @Post('avaliacao/reabrir')
  @Permissao('scorecard', 'editar')
  async reabrir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ usuarioId: uuid, mes: z.string().regex(mesRe, 'Mês inválido') }), body);
    if (d.usuarioId === u.id) throw new ForbiddenException('Ninguém mexe na própria avaliação.');
    const [av] = await this.db.update(bscAvaliacoes).set({ status: 'aberta', fechadaEm: null }).where(and(eq(bscAvaliacoes.usuarioId, d.usuarioId), eq(bscAvaliacoes.mes, d.mes), eq(bscAvaliacoes.status, 'fechada'))).returning();
    if (!av) throw new BadRequestException('Esta avaliação não está fechada.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'reabrir', entidade: 'scorecard_avaliacao', entidadeId: av.id });
    return this.montar(d.usuarioId, d.mes);
  }

  /** As avaliações fechadas da própria pessoa (para a Minha mesa), se as regras deixarem. */
  @Get('minhas')
  @Permissao('inicio', 'ver')
  async minhas(@Usuario() u: UsuarioLogado) {
    const regras = await this.regras();
    if (!regras.mostrarAoFuncionario && !temPermissao(u.permissoes, 'scorecard', 'ver')) return { liberado: false, avaliacoes: [] };
    const avs = await this.db.select().from(bscAvaliacoes).where(and(eq(bscAvaliacoes.usuarioId, u.id), eq(bscAvaliacoes.status, 'fechada'))).orderBy(sql`${bscAvaliacoes.mes} desc`).limit(12);
    const res = avs.length ? await this.db.select().from(bscResultados).where(inArray(bscResultados.avaliacaoId, avs.map((a) => a.id))) : [];
    const ocorr = avs.length
      ? await this.db.select({ data: bscOcorrencias.data, tipo: bscOcorrencias.tipo, pontos: bscOcorrencias.pontos, descricao: bscOcorrencias.descricao }).from(bscOcorrencias).where(and(eq(bscOcorrencias.usuarioId, u.id), gte(bscOcorrencias.data, `${avs.at(-1)!.mes}-01`))).orderBy(asc(bscOcorrencias.data))
      : [];
    return {
      liberado: true,
      avaliacoes: avs.map((a) => ({ mes: a.mes, nota: a.nota, notaIndicadores: a.notaIndicadores, ajuste: a.ajuste, percentualBonus: a.percentualBonus, bonus: a.bonus, observacao: a.observacao, indicadores: res.filter((r) => r.avaliacaoId === a.id), ocorrencias: ocorr.filter((o) => o.data.startsWith(a.mes)) })),
    };
  }
}
