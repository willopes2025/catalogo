import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { calcularAcordo, calcularEncargos, formatarReais, preencherTexto, type ResultadoAcordo } from '@aritana/regras';
import { temPermissao, type UsuarioLogado } from '../comum/auth';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { cobradores, cobrancaAcordos, cobrancaCarteira, cobrancaContatos, cobrancaEnvios, cobrancaProtestos, crmCanais, empresas, pessoas, titulos, usuarios } from '../db/schema';
import { AsaasService } from '../integracoes/asaas.service';
import { EmailService } from '../integracoes/email.service';
import { CanaisService } from '../crm/canais.service';
import { hoje } from '../maletas/maletas.service';
import { CobrancaConfigService, type ConfigCobranca } from './cobranca-config.service';

/** O que este usuário pode ver na cobrança. */
export interface Escopo {
  /** Cobrador do usuário (terceirizada ou funcionário). */
  cobradorId: string | null;
  /** Terceirizada: só vê a carteira dela. */
  restrito: boolean;
  /** Gestão da cobrança: atribui carteiras, dá descontos maiores, manda a protesto. */
  gestor: boolean;
}

/** Títulos que contam como dívida: a receber, em aberto ou protestados, que não são de cartão. */
const ehDivida = () => and(eq(titulos.tipo, 'receber'), inArray(titulos.status, ['aberto', 'protestado']), sql`coalesce(${titulos.formaPagamento}, '') not in ('debito', 'credito')`);
const dataBR = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

@Injectable()
export class CobrancaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Cobrança');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: CobrancaConfigService,
    private readonly asaas: AsaasService,
    private readonly canais: CanaisService,
    private readonly email: EmailService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit() {
    // De hora em hora: acordos (quitados e quebrados), promessas vencidas e, a partir das 9h, a régua do dia.
    if (process.env.COBRANCA_AUTOMATICA === '0') return;
    this.timer = setInterval(() => void this.rotina().catch((e) => this.log.warn(`Rotina: ${(e as Error).message}`)), 60 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private reguaRodadaEm: string | null = null;
  async rotina() {
    await this.verificarAcordos();
    await this.verificarPromessas();
    const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    if (hora >= 9 && hora < 20 && this.reguaRodadaEm !== hoje()) {
      this.reguaRodadaEm = hoje();
      const r = await this.rodarRegua(false);
      if (r.enviados || r.falhas) this.log.log(`Régua: ${r.enviados} mensagem(ns) enviada(s), ${r.falhas} falha(s).`);
    }
  }

  // ───────────── Escopo ─────────────

  async escopo(u: UsuarioLogado): Promise<Escopo> {
    const [x] = await this.db.select({ cobradorId: usuarios.cobradorId, tipo: cobradores.tipo }).from(usuarios).leftJoin(cobradores, eq(cobradores.id, usuarios.cobradorId)).where(eq(usuarios.id, u.id));
    const restrito = x?.tipo === 'terceirizada';
    return { cobradorId: x?.cobradorId ?? null, restrito, gestor: !restrito && temPermissao(u.permissoes, 'cobranca', 'excluir') };
  }

  /** Terceirizada só mexe em quem está na carteira dela. */
  async exigirAcesso(e: Escopo, pessoaId: string) {
    if (!e.restrito) return;
    const [c] = await this.db.select().from(cobrancaCarteira).where(eq(cobrancaCarteira.pessoaId, pessoaId));
    if (!c || c.cobradorId !== e.cobradorId) throw new ForbiddenException('Este devedor não está na sua carteira.');
  }
  exigirGestor(e: Escopo) {
    if (!e.gestor) throw new ForbiddenException('Só a gestão da cobrança faz isso.');
  }

  /** Valor atualizado (com multa e juros até hoje) de cada título vencido, em SQL, para ordenar e somar. */
  private atualizadoSql(cfg: ConfigCobranca) {
    const dias = sql`greatest(0, ${hoje()}::date - ${titulos.vencimento})`;
    return sql<number>`(${titulos.valor} + case when ${dias} > ${Math.max(0, cfg.diasCarencia)} then round(${titulos.valor} * ${cfg.multaPb} / 10000.0) + round(${titulos.valor} * ${cfg.jurosMesPb} * ${dias} / 300000.0) else 0 end)`;
  }

  // ───────────── Carteira ─────────────

  async carteira(e: Escopo, f: { busca?: string; cobradorId?: string; faixa?: string; tipo?: string; pagina?: number }) {
    const cfg = await this.config.obter();
    const h = hoje();
    const filtros = [ehDivida(), lt(titulos.vencimento, h)];
    if (e.restrito) filtros.push(eq(cobrancaCarteira.cobradorId, e.cobradorId!));
    else if (f.cobradorId === 'sem') filtros.push(isNull(cobrancaCarteira.cobradorId));
    else if (f.cobradorId) filtros.push(eq(cobrancaCarteira.cobradorId, f.cobradorId));
    if (f.tipo === 'representante' || f.tipo === 'cliente') filtros.push(eq(pessoas.tipo, f.tipo));
    if (f.busca?.trim()) {
      const b = `%${f.busca.trim()}%`;
      const dig = f.busca.replace(/\D/g, '');
      filtros.push(or(sql`${pessoas.nome} ilike ${b}`, ...(dig.length >= 4 ? [sql`${pessoas.documento} like ${'%' + dig + '%'}`, sql`regexp_replace(coalesce(${pessoas.telefone1}, ''), '\\D', '', 'g') like ${'%' + dig + '%'}`] : []))!);
    }
    const maiorAtraso = sql<number>`max(${h}::date - ${titulos.vencimento})::int`;
    const faixas: Record<string, [number, number]> = { '1_30': [1, 30], '31_60': [31, 60], '61_90': [61, 90], '91_180': [91, 180], mais_180: [181, 1_000_000] };
    const having = f.faixa && faixas[f.faixa] ? sql`${maiorAtraso} between ${faixas[f.faixa][0]} and ${faixas[f.faixa][1]}` : undefined;
    const pagina = Math.max(1, f.pagina ?? 1);
    const base = this.db
      .select({
        pessoaId: pessoas.id,
        nome: pessoas.nome,
        tipo: pessoas.tipo,
        documento: pessoas.documento,
        telefone: pessoas.telefone1,
        cidade: pessoas.cidade,
        uf: pessoas.uf,
        cobradorId: cobrancaCarteira.cobradorId,
        cobrador: cobradores.nome,
        pausada: sql<boolean>`coalesce(${cobrancaCarteira.pausada}, false)`,
        titulos: sql<number>`count(*)::int`,
        original: sql<number>`sum(${titulos.valor})::bigint`,
        atualizado: sql<number>`sum(${this.atualizadoSql(cfg)})::bigint`,
        maiorAtraso,
        emProtesto: sql<number>`count(*) filter (where exists (select 1 from cobranca_protestos p where p.titulo_id = ${titulos.id} and p.status in ('enviado', 'em_cartorio', 'protestado')))::int`,
        ultimoContato: sql<string | null>`(select max(c.criado_em) from cobranca_contatos c where c.pessoa_id = ${pessoas.id} and c.tipo <> 'sistema')`,
        promessa: sql<string | null>`(select min(c.promessa_data) from cobranca_contatos c where c.pessoa_id = ${pessoas.id} and c.promessa_status = 'aberta')`,
      })
      .from(titulos)
      .innerJoin(pessoas, eq(pessoas.id, titulos.pessoaId))
      .leftJoin(cobrancaCarteira, eq(cobrancaCarteira.pessoaId, pessoas.id))
      .leftJoin(cobradores, eq(cobradores.id, cobrancaCarteira.cobradorId))
      .where(and(...filtros))
      .groupBy(pessoas.id, cobrancaCarteira.cobradorId, cobradores.nome, cobrancaCarteira.pausada)
      .$dynamic();
    const consulta = having ? base.having(having) : base;
    const linhas = await consulta.orderBy(sql`sum(${this.atualizadoSql(cfg)}) desc`).limit(51).offset((pagina - 1) * 50);
    return { itens: linhas.slice(0, 50), temMais: linhas.length > 50, pagina };
  }

  async atribuir(e: Escopo, u: UsuarioLogado, pessoaIds: string[], cobradorId: string | null) {
    this.exigirGestor(e);
    let cobrador: string | null = null;
    if (cobradorId) {
      const [c] = await this.db.select().from(cobradores).where(eq(cobradores.id, cobradorId));
      if (!c || !c.ativo) throw new BadRequestException('Cobrador não encontrado ou inativo.');
      cobrador = c.nome;
    }
    for (const pessoaId of [...new Set(pessoaIds)]) {
      const [antes] = await this.db.select().from(cobrancaCarteira).where(eq(cobrancaCarteira.pessoaId, pessoaId));
      if (antes?.cobradorId === cobradorId) continue;
      await this.db
        .insert(cobrancaCarteira)
        .values({ pessoaId, cobradorId, desde: new Date() })
        .onConflictDoUpdate({ target: cobrancaCarteira.pessoaId, set: { cobradorId, desde: new Date(), atualizadoEm: new Date() } });
      await this.db.insert(cobrancaContatos).values({ pessoaId, usuarioId: u.id, cobradorId, tipo: 'sistema', texto: cobrador ? `Passou para a carteira de ${cobrador}.` : 'Saiu da carteira (sem cobrador).' });
    }
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'atribuir_carteira', entidade: 'cobranca', dados: { pessoas: pessoaIds.length, cobradorId } });
    return { ok: true, atribuidos: pessoaIds.length };
  }

  async pausar(e: Escopo, u: UsuarioLogado, pessoaId: string, pausada: boolean, motivo?: string | null) {
    await this.exigirAcesso(e, pessoaId);
    await this.db
      .insert(cobrancaCarteira)
      .values({ pessoaId, pausada, motivoPausa: pausada ? (motivo ?? null) : null })
      .onConflictDoUpdate({ target: cobrancaCarteira.pessoaId, set: { pausada, motivoPausa: pausada ? (motivo ?? null) : null, atualizadoEm: new Date() } });
    await this.db.insert(cobrancaContatos).values({ pessoaId, usuarioId: u.id, cobradorId: e.cobradorId, tipo: 'sistema', texto: pausada ? `Régua pausada${motivo ? `: ${motivo}` : '.'}` : 'Régua retomada.' });
    return { ok: true };
  }

  // ───────────── Ficha do devedor ─────────────

  async ficha(e: Escopo, pessoaId: string) {
    await this.exigirAcesso(e, pessoaId);
    const cfg = await this.config.obter();
    const h = hoje();
    const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p) throw new NotFoundException('Pessoa não encontrada.');
    const [cart] = await this.db.select({ c: cobrancaCarteira, cobrador: cobradores.nome }).from(cobrancaCarteira).leftJoin(cobradores, eq(cobradores.id, cobrancaCarteira.cobradorId)).where(eq(cobrancaCarteira.pessoaId, pessoaId));
    const abertos = await this.db
      .select()
      .from(titulos)
      .where(and(eq(titulos.pessoaId, pessoaId), ehDivida()))
      .orderBy(asc(titulos.vencimento));
    const protestos = abertos.length ? await this.db.select().from(cobrancaProtestos).where(inArray(cobrancaProtestos.tituloId, abertos.map((t) => t.id))).orderBy(desc(cobrancaProtestos.criadoEm)) : [];
    const lista = abertos.map((t) => {
      const enc = calcularEncargos(t.valor, t.vencimento, h, cfg);
      const pr = protestos.find((x) => x.tituloId === t.id);
      return {
        id: t.id, descricao: t.descricao, valor: t.valor, vencimento: t.vencimento, status: t.status, parcela: t.parcela, totalParcelas: t.totalParcelas, origemTipo: t.origemTipo, acordoId: t.acordoId,
        dias: enc.dias, multa: enc.multa, juros: enc.juros, atualizado: enc.total,
        cobranca: t.cobrancaExternaId ? { tipo: t.cobrancaTipo, url: t.cobrancaUrl, pix: t.pixCopiaCola, valor: t.cobrancaValor ?? t.valor, vencimento: t.cobrancaVencimento ?? t.vencimento } : null,
        protesto: pr ? { id: pr.id, status: pr.status, protocolo: pr.protocolo, cartorio: pr.cartorio, pedido: pr.pedido } : null,
      };
    });
    const acordos = await this.db
      .select({ a: cobrancaAcordos, usuario: usuarios.nome })
      .from(cobrancaAcordos)
      .leftJoin(usuarios, eq(usuarios.id, cobrancaAcordos.usuarioId))
      .where(eq(cobrancaAcordos.pessoaId, pessoaId))
      .orderBy(desc(cobrancaAcordos.criadoEm))
      .limit(20);
    const contatos = await this.db
      .select({ c: cobrancaContatos, usuario: usuarios.nome, cobrador: cobradores.nome })
      .from(cobrancaContatos)
      .leftJoin(usuarios, eq(usuarios.id, cobrancaContatos.usuarioId))
      .leftJoin(cobradores, eq(cobradores.id, cobrancaContatos.cobradorId))
      .where(eq(cobrancaContatos.pessoaId, pessoaId))
      .orderBy(desc(cobrancaContatos.criadoEm))
      .limit(100);
    const pagos = await this.db
      .select({ id: titulos.id, descricao: titulos.descricao, valorPago: titulos.valorPago, pagoEm: titulos.pagoEm, formaPagamento: titulos.formaPagamento })
      .from(titulos)
      .where(and(eq(titulos.pessoaId, pessoaId), eq(titulos.tipo, 'receber'), eq(titulos.status, 'pago')))
      .orderBy(desc(titulos.pagoEm))
      .limit(10);
    const vencidos = lista.filter((t) => t.dias > 0);
    return {
      pessoa: { id: p.id, nome: p.nome, tipo: p.tipo, documento: p.documento, telefone: p.telefone1, telefone2: p.telefone2, email: p.email, cep: p.cep, logradouro: p.logradouro, numero: p.numero, complemento: p.complemento, bairro: p.bairro, cidade: p.cidade, uf: p.uf },
      carteira: { cobradorId: cart?.c.cobradorId ?? null, cobrador: cart?.cobrador ?? null, desde: cart?.c.desde ?? null, pausada: cart?.c.pausada ?? false, motivoPausa: cart?.c.motivoPausa ?? null },
      resumo: { vencidos: vencidos.length, original: vencidos.reduce((s, t) => s + t.valor, 0), atualizado: vencidos.reduce((s, t) => s + t.atualizado, 0), aVencer: lista.filter((t) => t.dias <= 0).reduce((s, t) => s + t.valor, 0), maiorAtraso: Math.max(0, ...vencidos.map((t) => t.dias)) },
      titulos: lista,
      acordos: acordos.map((x) => ({ ...x.a, usuario: x.usuario })),
      contatos: contatos.map((x) => ({ ...x.c, usuario: x.usuario, cobrador: x.cobrador })),
      pagos,
      regras: { multaPb: cfg.multaPb, jurosMesPb: cfg.jurosMesPb, diasCarencia: cfg.diasCarencia, descontoMaxPb: e.gestor ? cfg.descontoMaxGestorPb : cfg.descontoMaxPb, parcelasMax: cfg.parcelasMax },
      asaas: this.asaas.configurado,
    };
  }

  async registrarContato(e: Escopo, u: UsuarioLogado, pessoaId: string, d: { tipo: string; texto: string; promessaData?: string | null; promessaValor?: number | null; retornoEm?: string | null }) {
    await this.exigirAcesso(e, pessoaId);
    if (d.promessaData && d.promessaData < hoje()) throw new BadRequestException('A data da promessa já passou.');
    const [c] = await this.db
      .insert(cobrancaContatos)
      .values({ pessoaId, usuarioId: u.id, cobradorId: e.cobradorId, tipo: d.tipo, texto: d.texto, promessaData: d.promessaData ?? null, promessaValor: d.promessaData ? (d.promessaValor ?? null) : null, promessaStatus: d.promessaData ? 'aberta' : null, retornoEm: d.retornoEm ?? null })
      .returning();
    // Promessa nova substitui a anterior que ainda estava aberta.
    if (d.promessaData) await this.db.update(cobrancaContatos).set({ promessaStatus: 'substituida' }).where(and(eq(cobrancaContatos.pessoaId, pessoaId), eq(cobrancaContatos.promessaStatus, 'aberta'), sql`${cobrancaContatos.id} <> ${c.id}`));
    return c;
  }

  /** Promessa vencida: cumprida se a pessoa pagou (o valor prometido, ou algo) desde que prometeu; senão, quebrada. */
  async verificarPromessas() {
    const abertas = await this.db.select().from(cobrancaContatos).where(eq(cobrancaContatos.promessaStatus, 'aberta'));
    let cumpridas = 0;
    let quebradas = 0;
    for (const c of abertas) {
      const desde = c.criadoEm.toISOString().slice(0, 10);
      const [{ pago }] = await this.db
        .select({ pago: sql<number>`coalesce(sum(${titulos.valorPago}), 0)::bigint` })
        .from(titulos)
        .where(and(eq(titulos.pessoaId, c.pessoaId), eq(titulos.tipo, 'receber'), eq(titulos.status, 'pago'), gte(titulos.pagoEm, desde)));
      const ok = Number(pago) > 0 && Number(pago) >= Math.round((c.promessaValor ?? 1) * 0.95);
      if (ok) {
        await this.db.update(cobrancaContatos).set({ promessaStatus: 'cumprida' }).where(eq(cobrancaContatos.id, c.id));
        cumpridas++;
      } else if (c.promessaData! < hoje()) {
        await this.db.update(cobrancaContatos).set({ promessaStatus: 'quebrada' }).where(eq(cobrancaContatos.id, c.id));
        quebradas++;
      }
    }
    return { cumpridas, quebradas };
  }

  // ───────────── Segunda via ─────────────

  /** Boleto/Pix novo (outro vencimento, valor com encargos ou sem). O anterior é apagado e o título passa a apontar só para o novo. */
  async segundaVia(e: Escopo, u: UsuarioLogado, tituloId: string, d: { vencimento: string; tipo: 'BOLETO' | 'PIX'; comEncargos: boolean }) {
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, tituloId));
    if (!t || !t.pessoaId) throw new NotFoundException('Título não encontrado.');
    await this.exigirAcesso(e, t.pessoaId);
    // Protestado também pode pagar à Aritana: depois do pagamento, o cancelamento do protesto é autorizado sozinho.
    if (t.status !== 'aberto' && t.status !== 'protestado') throw new BadRequestException(`O título está ${t.status}.`);
    if (d.vencimento < hoje()) throw new BadRequestException('O novo vencimento não pode ser antes de hoje.');
    if (!this.asaas.configurado) throw new BadRequestException('O Asaas não está ligado: não dá para emitir boleto ou Pix.');
    const cfg = await this.config.obter();
    const valor = d.comEncargos ? calcularEncargos(t.valor, t.vencimento, d.vencimento, cfg).total : t.valor;
    const r = await this.asaas.cobrar(t.id, d.tipo, u.id, { valor, vencimento: d.vencimento });
    await this.db.insert(cobrancaContatos).values({ pessoaId: t.pessoaId, usuarioId: u.id, cobradorId: e.cobradorId, tipo: 'sistema', texto: `Nova ${d.tipo === 'PIX' ? 'cobrança Pix' : '2ª via de boleto'}: ${formatarReais(valor)} para ${dataBR(d.vencimento)} (${t.descricao}).` });
    return { ...r, valor, vencimento: d.vencimento };
  }

  // ───────────── Acordos ─────────────

  private async titulosDoAcordo(pessoaId: string, ids: string[]) {
    const ts = await this.db.select().from(titulos).where(and(inArray(titulos.id, ids), eq(titulos.pessoaId, pessoaId)));
    if (ts.length !== new Set(ids).size) throw new BadRequestException('Algum título não é deste devedor.');
    for (const t of ts) {
      if (t.tipo !== 'receber' || !['aberto', 'protestado'].includes(t.status)) throw new BadRequestException(`"${t.descricao}" não está em aberto.`);
      if (t.formaPagamento === 'debito' || t.formaPagamento === 'credito') throw new BadRequestException(`"${t.descricao}" é de cartão: é recebido pela maquininha.`);
    }
    const emCartorio = ids.length ? await this.db.select({ tituloId: cobrancaProtestos.tituloId }).from(cobrancaProtestos).where(and(inArray(cobrancaProtestos.tituloId, ids), inArray(cobrancaProtestos.status, ['enviado', 'em_cartorio']))) : [];
    if (emCartorio.length) throw new BadRequestException('Há título em cartório (ainda não protestado). Peça a desistência do protesto antes de fazer o acordo.');
    return ts;
  }

  async simularAcordo(e: Escopo, pessoaId: string, d: { tituloIds: string[]; desconto: number; entrada: number; vencimentoEntrada?: string; parcelas: number; primeiroVencimento: string }): Promise<ResultadoAcordo & { descontoMaxPb: number }> {
    await this.exigirAcesso(e, pessoaId);
    const cfg = await this.config.obter();
    const ts = await this.titulosDoAcordo(pessoaId, d.tituloIds);
    if (d.parcelas > cfg.parcelasMax) throw new BadRequestException(`O máximo é de ${cfg.parcelasMax} parcelas.`);
    if (d.primeiroVencimento < hoje() || (d.vencimentoEntrada && d.vencimentoEntrada < hoje())) throw new BadRequestException('O vencimento não pode ser antes de hoje.');
    let r: ResultadoAcordo;
    try {
      r = calcularAcordo({ itens: ts.map((t) => ({ valor: t.valor, vencimento: t.vencimento })), data: hoje(), regras: cfg, desconto: d.desconto, entrada: d.entrada, vencimentoEntrada: d.vencimentoEntrada, parcelas: d.parcelas, primeiroVencimento: d.primeiroVencimento });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const descontoMaxPb = e.gestor ? cfg.descontoMaxGestorPb : cfg.descontoMaxPb;
    if (r.descontoPb > descontoMaxPb) throw new BadRequestException(`O desconto passa do seu limite de ${(descontoMaxPb / 100).toLocaleString('pt-BR')}% (até ${formatarReais(Math.floor((r.atualizado * descontoMaxPb) / 10000))}).`);
    return { ...r, descontoMaxPb };
  }

  async criarAcordo(e: Escopo, u: UsuarioLogado, pessoaId: string, d: { tituloIds: string[]; desconto: number; entrada: number; vencimentoEntrada?: string; parcelas: number; primeiroVencimento: string; cobranca: 'BOLETO' | 'PIX' | 'nenhuma'; observacao?: string | null }) {
    const r = await this.simularAcordo(e, pessoaId, d);
    const ts = await this.titulosDoAcordo(pessoaId, d.tituloIds);
    const empresaId = ts[0].empresaId;
    const acordo = await this.db.transaction(async (tx) => {
      const [a] = await tx
        .insert(cobrancaAcordos)
        .values({ pessoaId, cobradorId: e.cobradorId, usuarioId: u.id, original: r.original, multa: r.multa, juros: r.juros, desconto: r.desconto, total: r.total, entrada: r.entrada?.valor ?? 0, parcelas: r.parcelas.length, observacao: d.observacao ?? null })
        .returning();
      // Os títulos de origem ficam "renegociados" (ligados ao acordo); voltam se o acordo quebrar.
      for (const t of ts) {
        const atualizado = await tx.update(titulos).set({ status: 'renegociado', renegociadoAcordoId: a.id }).where(and(eq(titulos.id, t.id), inArray(titulos.status, ['aberto', 'protestado']))).returning({ id: titulos.id });
        if (!atualizado.length) throw new BadRequestException(`"${t.descricao}" mudou enquanto o acordo era feito. Abra a ficha de novo.`);
      }
      const novas = [...(r.entrada ? [{ ...r.entrada, numero: 0 }] : []), ...r.parcelas];
      const total = novas.length;
      const criadas = await tx
        .insert(titulos)
        .values(
          novas.map((p, i) => ({
            empresaId,
            tipo: 'receber',
            pessoaId,
            descricao: `Acordo nº ${a.numero} · ${p.numero === 0 ? 'entrada' : `parcela ${p.numero}/${r.parcelas.length}`}`,
            categoria: 'Acordo de cobrança',
            valor: p.valor,
            vencimento: p.vencimento,
            parcela: i + 1,
            totalParcelas: total,
            formaPagamento: d.cobranca === 'PIX' ? 'pix' : d.cobranca === 'BOLETO' ? 'boleto' : null,
            origemTipo: 'acordo',
            origemId: a.id,
            acordoId: a.id,
          })),
        )
        .returning();
      await tx.insert(cobrancaContatos).values({ pessoaId, usuarioId: u.id, cobradorId: e.cobradorId, tipo: 'sistema', texto: `Acordo nº ${a.numero}: ${formatarReais(r.total)}${r.entrada ? ` (entrada de ${formatarReais(r.entrada.valor)} + ` : ' ('}${r.parcelas.length}x). Dívida de ${formatarReais(r.original)}, ${formatarReais(r.multa + r.juros)} de encargos, ${formatarReais(r.desconto)} de desconto.` });
      // Promessas abertas deixam de valer: o acordo é o compromisso agora.
      await tx.update(cobrancaContatos).set({ promessaStatus: 'substituida' }).where(and(eq(cobrancaContatos.pessoaId, pessoaId), eq(cobrancaContatos.promessaStatus, 'aberta')));
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar_acordo', entidade: 'cobranca_acordo', entidadeId: a.id, dados: { pessoaId, titulos: d.tituloIds, total: r.total, desconto: r.desconto, parcelas: r.parcelas.length } }, tx);
      return { ...a, parcelasCriadas: criadas };
    });
    // Boletos dos títulos de origem deixam de valer.
    for (const t of ts) if (t.cobrancaExternaId) await this.asaas.cancelarCobranca(t.cobrancaExternaId);
    // Boleto/Pix de cada parcela. Se o Asaas falhar, o acordo fica feito e dá para emitir depois pela ficha.
    const avisos: string[] = [];
    if (d.cobranca !== 'nenhuma') {
      if (!this.asaas.configurado) avisos.push('O Asaas não está ligado: os boletos não foram emitidos.');
      else
        for (const p of acordo.parcelasCriadas) {
          try {
            await this.asaas.cobrar(p.id, d.cobranca, u.id);
          } catch (err) {
            avisos.push(`${p.descricao}: ${(err as Error).message}`);
          }
        }
    }
    const [final] = await this.db.select().from(cobrancaAcordos).where(eq(cobrancaAcordos.id, acordo.id));
    const parcelas = await this.db.select().from(titulos).where(eq(titulos.acordoId, acordo.id)).orderBy(asc(titulos.vencimento), asc(titulos.parcela));
    return { acordo: final, parcelas, avisos };
  }

  async acordo(e: Escopo, id: string) {
    const [a] = await this.db.select().from(cobrancaAcordos).where(eq(cobrancaAcordos.id, id));
    if (!a) throw new NotFoundException('Acordo não encontrado.');
    await this.exigirAcesso(e, a.pessoaId);
    const parcelas = await this.db.select().from(titulos).where(eq(titulos.acordoId, id)).orderBy(asc(titulos.vencimento), asc(titulos.parcela));
    const origem = await this.db.select().from(titulos).where(eq(titulos.renegociadoAcordoId, id)).orderBy(asc(titulos.vencimento));
    return { acordo: a, parcelas, origem };
  }

  async listarAcordos(e: Escopo, status?: string) {
    const f = [];
    if (status) f.push(eq(cobrancaAcordos.status, status));
    if (e.restrito) f.push(eq(cobrancaAcordos.cobradorId, e.cobradorId!));
    return this.db
      .select({
        id: cobrancaAcordos.id, numero: cobrancaAcordos.numero, status: cobrancaAcordos.status, total: cobrancaAcordos.total, parcelas: cobrancaAcordos.parcelas, criadoEm: cobrancaAcordos.criadoEm,
        pessoaId: pessoas.id, nome: pessoas.nome, cobrador: cobradores.nome,
        pago: sql<number>`coalesce((select sum(t.valor_pago) from titulos t where t.acordo_id = ${cobrancaAcordos.id} and t.status = 'pago'), 0)::bigint`,
        atrasadas: sql<number>`(select count(*) from titulos t where t.acordo_id = ${cobrancaAcordos.id} and t.status = 'aberto' and t.vencimento < ${hoje()})::int`,
      })
      .from(cobrancaAcordos)
      .innerJoin(pessoas, eq(pessoas.id, cobrancaAcordos.pessoaId))
      .leftJoin(cobradores, eq(cobradores.id, cobrancaAcordos.cobradorId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(desc(cobrancaAcordos.criadoEm))
      .limit(300);
  }

  /** Quitado quando todas as parcelas foram pagas; quebrado quando uma atrasa além do limite. */
  async verificarAcordos() {
    const cfg = await this.config.obter();
    const ativos = await this.db.select().from(cobrancaAcordos).where(eq(cobrancaAcordos.status, 'ativo'));
    let quitados = 0;
    let quebrados = 0;
    for (const a of ativos) {
      const ps = await this.db.select().from(titulos).where(eq(titulos.acordoId, a.id));
      if (ps.length && ps.every((p) => p.status === 'pago' || p.status === 'cancelado') && ps.some((p) => p.status === 'pago')) {
        await this.db.update(cobrancaAcordos).set({ status: 'quitado', encerradoEm: new Date(), motivoEncerramento: 'Todas as parcelas pagas.' }).where(and(eq(cobrancaAcordos.id, a.id), eq(cobrancaAcordos.status, 'ativo')));
        await this.db.insert(cobrancaContatos).values({ pessoaId: a.pessoaId, tipo: 'sistema', texto: `Acordo nº ${a.numero} quitado.` });
        quitados++;
        continue;
      }
      const limite = new Date(Date.now() - cfg.diasQuebraAcordo * 86400_000).toISOString().slice(0, 10);
      const atrasada = ps.find((p) => p.status === 'aberto' && p.vencimento < limite);
      if (atrasada) {
        await this.encerrarAcordo(a.id, 'quebrado', `"${atrasada.descricao}" com mais de ${cfg.diasQuebraAcordo} dias de atraso.`, null);
        quebrados++;
      }
    }
    return { quitados, quebrados };
  }

  /**
   * Quebra ou cancela o acordo: as parcelas em aberto são canceladas e os títulos de origem voltam,
   * descontado o que já foi pago no acordo (abatido dos mais antigos primeiro).
   */
  async encerrarAcordo(id: string, status: 'quebrado' | 'cancelado', motivo: string, usuarioId: string | null) {
    const r = await this.db.transaction(async (tx) => {
      const [a] = await tx.select().from(cobrancaAcordos).where(eq(cobrancaAcordos.id, id)).for('update');
      if (!a) throw new NotFoundException('Acordo não encontrado.');
      if (a.status !== 'ativo') throw new BadRequestException(`O acordo já está ${a.status}.`);
      const ps = await tx.select().from(titulos).where(eq(titulos.acordoId, id));
      const cancelar = ps.filter((p) => p.status === 'aberto');
      if (cancelar.length) await tx.update(titulos).set({ status: 'cancelado' }).where(inArray(titulos.id, cancelar.map((p) => p.id)));
      let pago = ps.filter((p) => p.status === 'pago').reduce((s, p) => s + (p.valorPago ?? p.valor), 0);
      const origem = await tx.select().from(titulos).where(eq(titulos.renegociadoAcordoId, id)).orderBy(asc(titulos.vencimento));
      let abatido = 0;
      for (const t of origem) {
        const volta = (await tx.select({ n: sql<number>`count(*)::int` }).from(cobrancaProtestos).where(and(eq(cobrancaProtestos.tituloId, t.id), eq(cobrancaProtestos.status, 'protestado'))))[0].n > 0 ? 'protestado' : 'aberto';
        if (pago <= 0) {
          await tx.update(titulos).set({ status: volta, renegociadoAcordoId: null }).where(eq(titulos.id, t.id));
          continue;
        }
        // O que foi pago no acordo quita os títulos mais antigos; o que sobra de um título vira um título com o saldo.
        const usar = Math.min(pago, t.valor);
        await tx.update(titulos).set({ status: 'pago', valor: usar, valorPago: usar, pagoEm: hoje(), formaPagamento: 'acordo', renegociadoAcordoId: null }).where(eq(titulos.id, t.id));
        if (usar < t.valor) {
          const { id: _i, criadoEm: _c, cobrancaExternaId: _e, cobrancaUrl: _u, pixCopiaCola: _p, cobrancaTipo: _t, cobrancaValor: _v, cobrancaVencimento: _cv, ...resto } = t;
          await tx.insert(titulos).values({ ...resto, valor: t.valor - usar, descricao: `${t.descricao} · saldo`, status: volta, pagoEm: null, valorPago: null, contaId: null, renegociadoAcordoId: null });
        }
        pago -= usar;
        abatido += usar;
      }
      await tx.update(cobrancaAcordos).set({ status, encerradoEm: new Date(), motivoEncerramento: motivo }).where(eq(cobrancaAcordos.id, id));
      await tx.insert(cobrancaContatos).values({ pessoaId: a.pessoaId, usuarioId, tipo: 'sistema', texto: `Acordo nº ${a.numero} ${status}: ${motivo}${abatido ? ` ${formatarReais(abatido)} pagos no acordo foram abatidos da dívida.` : ''}` });
      await this.auditoria.registrar({ usuarioId, acao: status === 'quebrado' ? 'quebrar_acordo' : 'cancelar_acordo', entidade: 'cobranca_acordo', entidadeId: id, dados: { motivo, abatido } }, tx);
      return { cancelados: cancelar, abatido };
    });
    for (const p of r.cancelados) if (p.cobrancaExternaId) await this.asaas.cancelarCobranca(p.cobrancaExternaId);
    return { ok: true, abatido: r.abatido };
  }

  // ───────────── Régua ─────────────

  /**
   * Manda as mensagens do dia: para cada passo da régua, os títulos que vencem (ou venceram) há exatamente aqueles dias.
   * Junta os títulos da mesma pessoa numa mensagem só. Cada título recebe cada passo uma vez.
   * `simular`: só mostra o que seria enviado.
   */
  async rodarRegua(simular: boolean) {
    const cfg = await this.config.obter();
    const previa: { pessoaId: string; nome: string; passo: number; canal: string; titulos: number; valor: number; texto: string; destino: string | null; problema: string | null }[] = [];
    let enviados = 0;
    let falhas = 0;
    if (!simular && !cfg.regua.ativa) return { enviados, falhas, previa };
    const [canal] = cfg.regua.canalId ? await this.db.select().from(crmCanais).where(eq(crmCanais.id, cfg.regua.canalId)) : [];
    const [empresa] = await this.db.select({ nome: empresas.nome }).from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    const h = hoje();
    for (const passo of cfg.regua.passos) {
      const alvo = new Date(Date.parse(`${h}T12:00:00Z`) - passo.dias * 86400_000).toISOString().slice(0, 10);
      const linhas = await this.db
        .select({ t: titulos, p: pessoas })
        .from(titulos)
        .innerJoin(pessoas, eq(pessoas.id, titulos.pessoaId))
        .leftJoin(cobrancaCarteira, eq(cobrancaCarteira.pessoaId, pessoas.id))
        .where(
          and(
            eq(titulos.tipo, 'receber'),
            eq(titulos.status, 'aberto'),
            eq(titulos.vencimento, alvo),
            sql`coalesce(${titulos.formaPagamento}, '') not in ('debito', 'credito', 'dinheiro')`,
            sql`coalesce(${cobrancaCarteira.pausada}, false) = false`,
            sql`not exists (select 1 from cobranca_envios e where e.titulo_id = ${titulos.id} and e.passo = ${passo.dias})`,
            sql`not exists (select 1 from cobranca_protestos p where p.titulo_id = ${titulos.id} and p.status in ('enviado', 'em_cartorio', 'protestado'))`,
          ),
        );
      const porPessoa = new Map<string, typeof linhas>();
      for (const l of linhas) porPessoa.set(l.p.id, [...(porPessoa.get(l.p.id) ?? []), l]);
      for (const [pessoaId, grupo] of porPessoa) {
        const p = grupo[0].p;
        const destino = passo.canal === 'email' ? p.email : p.telefone1;
        let problema: string | null = null;
        if (!destino) problema = passo.canal === 'email' ? 'Sem e-mail no cadastro.' : 'Sem telefone no cadastro.';
        else if (passo.canal === 'whatsapp' && (!canal || !canal.ativo || canal.excluidoEm)) problema = 'Escolha o número de WhatsApp da régua em Cobrança › Configurar.';
        else if (passo.canal === 'whatsapp' && canal?.tipo === 'oficial' && !passo.templateId) problema = 'No WhatsApp oficial, cada passo precisa de um template aprovado.';
        // Boleto/Pix antes de mandar, para a mensagem já ir com o link.
        if (!simular && !problema && this.asaas.configurado && p.documento)
          for (const g of grupo)
            if (!g.t.cobrancaExternaId) {
              try {
                const r = await this.asaas.cobrar(g.t.id, g.t.formaPagamento === 'pix' ? 'PIX' : 'BOLETO', null);
                g.t.cobrancaUrl = r.url ?? null;
                g.t.pixCopiaCola = r.pixCopiaCola ?? null;
              } catch (err) {
                this.log.warn(`Régua: boleto de ${g.t.id} não emitido: ${(err as Error).message}`);
              }
            }
        const valor = grupo.reduce((s, g) => s + g.t.valor, 0);
        const atualizado = grupo.reduce((s, g) => s + calcularEncargos(g.t.valor, g.t.vencimento, h, cfg).total, 0);
        const links = grupo.map((g) => (g.t.cobrancaUrl ? `${grupo.length > 1 ? `${g.t.descricao}: ` : 'Boleto/Pix: '}${g.t.cobrancaUrl}` : null)).filter(Boolean).join('\n');
        const texto = preencherTexto(passo.texto, {
          nome: p.nome,
          primeiro_nome: p.nome.split(' ')[0],
          valor: formatarReais(valor),
          valor_atualizado: formatarReais(atualizado),
          vencimento: dataBR(alvo),
          dias: Math.abs(passo.dias),
          link: links,
          pix: grupo.length === 1 ? (grupo[0].t.pixCopiaCola ?? '') : '',
          titulos: grupo.map((g) => `${g.t.descricao}: ${formatarReais(g.t.valor)}`).join('\n'),
          empresa: empresa?.nome ?? 'Aritana',
        });
        previa.push({ pessoaId, nome: p.nome, passo: passo.dias, canal: passo.canal, titulos: grupo.length, valor, texto, destino: destino ?? null, problema });
        if (simular) continue;
        let resultado = 'enviado';
        let detalhe: string | null = null;
        if (problema) {
          resultado = 'sem_contato';
          detalhe = problema;
        } else {
          try {
            if (passo.canal === 'email') await this.email.enviar(destino!, `${empresa?.nome ?? 'Aritana'}: ${passo.dias < 0 ? 'lembrete de vencimento' : passo.dias === 0 ? 'vencimento hoje' : 'pagamento em atraso'}`, texto);
            else await this.canais.enviarParaTelefone({ canalId: canal!.id, telefone: destino!, nome: p.nome, texto, templateId: passo.templateId });
          } catch (err) {
            resultado = 'falhou';
            detalhe = (err as Error).message.slice(0, 300);
          }
        }
        if (resultado === 'enviado') enviados++;
        else falhas++;
        await this.db.insert(cobrancaEnvios).values(grupo.map((g) => ({ tituloId: g.t.id, passo: passo.dias, canal: passo.canal, resultado, detalhe }))).onConflictDoNothing();
        await this.db.insert(cobrancaContatos).values({ pessoaId, tipo: 'regua', texto: resultado === 'enviado' ? `Régua (${passo.dias < 0 ? `${-passo.dias} dias antes` : passo.dias === 0 ? 'no vencimento' : `${passo.dias} dias depois`}), por ${passo.canal === 'email' ? 'e-mail' : 'WhatsApp'}:\n${texto}` : `Régua não enviada (${passo.canal === 'email' ? 'e-mail' : 'WhatsApp'}): ${detalhe}` });
      }
    }
    return { enviados, falhas, previa };
  }

  // ───────────── Painel ─────────────

  async painel(e: Escopo) {
    const cfg = await this.config.obter();
    const h = hoje();
    const inicioMes = `${h.slice(0, 8)}01`;
    // Nas subconsultas, a coluna de fora vai com o nome da tabela: numa consulta de uma tabela só, o drizzle a escreveria sem ele.
    const daCarteira = e.restrito ? sql`exists (select 1 from cobranca_carteira c where c.pessoa_id = "titulos"."pessoa_id" and c.cobrador_id = ${e.cobradorId})` : sql`true`;
    const dias = sql`(${h}::date - ${titulos.vencimento})`;
    const faixas = await this.db
      .select({
        faixa: sql<string>`case when ${dias} <= 30 then '1_30' when ${dias} <= 60 then '31_60' when ${dias} <= 90 then '61_90' when ${dias} <= 180 then '91_180' else 'mais_180' end`,
        titulos: sql<number>`count(*)::int`,
        devedores: sql<number>`count(distinct ${titulos.pessoaId})::int`,
        original: sql<number>`sum(${titulos.valor})::bigint`,
        atualizado: sql<number>`sum(${this.atualizadoSql(cfg)})::bigint`,
      })
      .from(titulos)
      .where(and(ehDivida(), lt(titulos.vencimento, h), daCarteira))
      .groupBy(sql`1`);
    const [totalDevedores] = await this.db.select({ n: sql<number>`count(distinct ${titulos.pessoaId})::int` }).from(titulos).where(and(ehDivida(), lt(titulos.vencimento, h), daCarteira));
    // Recuperado: o que foi pago neste mês de títulos que estavam vencidos (inclui parcelas de acordo).
    const [rec] = await this.db
      .select({ valor: sql<number>`coalesce(sum(${titulos.valorPago}), 0)::bigint`, titulos: sql<number>`count(*)::int` })
      .from(titulos)
      .where(and(eq(titulos.tipo, 'receber'), eq(titulos.status, 'pago'), gte(titulos.pagoEm, inicioMes), or(sql`${titulos.pagoEm} > ${titulos.vencimento}`, sql`${titulos.acordoId} is not null`), daCarteira));
    const acordos = await this.db
      .select({ status: cobrancaAcordos.status, n: sql<number>`count(*)::int`, total: sql<number>`sum(${cobrancaAcordos.total})::bigint` })
      .from(cobrancaAcordos)
      .where(e.restrito ? eq(cobrancaAcordos.cobradorId, e.cobradorId!) : undefined)
      .groupBy(cobrancaAcordos.status);
    const promessas = await this.db
      .select({ id: cobrancaContatos.id, pessoaId: cobrancaContatos.pessoaId, nome: pessoas.nome, data: cobrancaContatos.promessaData, valor: cobrancaContatos.promessaValor })
      .from(cobrancaContatos)
      .innerJoin(pessoas, eq(pessoas.id, cobrancaContatos.pessoaId))
      .where(and(eq(cobrancaContatos.promessaStatus, 'aberta'), sql`${cobrancaContatos.promessaData} <= ${new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)}`, e.restrito ? sql`exists (select 1 from cobranca_carteira c where c.pessoa_id = ${cobrancaContatos.pessoaId} and c.cobrador_id = ${e.cobradorId})` : undefined))
      .orderBy(asc(cobrancaContatos.promessaData))
      .limit(30);
    const retornos = await this.db
      .select({ pessoaId: cobrancaContatos.pessoaId, nome: pessoas.nome, data: cobrancaContatos.retornoEm, texto: cobrancaContatos.texto })
      .from(cobrancaContatos)
      .innerJoin(pessoas, eq(pessoas.id, cobrancaContatos.pessoaId))
      .where(and(sql`${cobrancaContatos.retornoEm} <= ${h}`, sql`${cobrancaContatos.retornoEm} >= ${new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)}`, sql`not exists (select 1 from cobranca_contatos d where d.pessoa_id = ${cobrancaContatos.pessoaId} and d.criado_em > ${cobrancaContatos.criadoEm} and d.tipo not in ('sistema', 'regua'))`, e.restrito ? sql`exists (select 1 from cobranca_carteira c where c.pessoa_id = ${cobrancaContatos.pessoaId} and c.cobrador_id = ${e.cobradorId})` : undefined))
      .orderBy(asc(cobrancaContatos.retornoEm))
      .limit(30);
    // Por cobrador: carteira vencida, recuperado no mês (pago depois de entrar na carteira) e comissão.
    const porCobrador = await this.db
      .select({
        id: cobradores.id, nome: cobradores.nome, tipo: cobradores.tipo, comissaoPb: cobradores.comissaoPb,
        devedores: sql<number>`(select count(distinct t.pessoa_id) from titulos t join cobranca_carteira c on c.pessoa_id = t.pessoa_id where c.cobrador_id = "cobradores"."id" and t.tipo = 'receber' and t.status in ('aberto', 'protestado') and t.vencimento < ${h})::int`,
        carteira: sql<number>`coalesce((select sum(t.valor) from titulos t join cobranca_carteira c on c.pessoa_id = t.pessoa_id where c.cobrador_id = "cobradores"."id" and t.tipo = 'receber' and t.status in ('aberto', 'protestado') and t.vencimento < ${h}), 0)::bigint`,
        recuperado: sql<number>`coalesce((select sum(t.valor_pago) from titulos t join cobranca_carteira c on c.pessoa_id = t.pessoa_id where c.cobrador_id = "cobradores"."id" and t.tipo = 'receber' and t.status = 'pago' and t.pago_em >= ${inicioMes} and t.pago_em >= c.desde::date and (t.pago_em > t.vencimento or t.acordo_id is not null)), 0)::bigint`,
      })
      .from(cobradores)
      .where(and(eq(cobradores.ativo, true), e.restrito ? eq(cobradores.id, e.cobradorId!) : undefined))
      .orderBy(asc(cobradores.nome));
    const [protestos] = await this.db
      .select({
        emCartorio: sql<number>`count(*) filter (where ${cobrancaProtestos.status} in ('enviado', 'em_cartorio'))::int`,
        protestados: sql<number>`count(*) filter (where ${cobrancaProtestos.status} = 'protestado')::int`,
      })
      .from(cobrancaProtestos)
      .where(e.restrito ? sql`false` : undefined);
    return {
      faixas,
      vencido: { original: faixas.reduce((s, f) => s + Number(f.original), 0), atualizado: faixas.reduce((s, f) => s + Number(f.atualizado), 0), devedores: Number(totalDevedores?.n ?? 0) },
      recuperadoMes: { valor: Number(rec.valor), titulos: rec.titulos },
      acordos,
      promessas,
      retornos,
      porCobrador: porCobrador.map((c) => ({ ...c, comissao: Math.round((Number(c.recuperado) * c.comissaoPb) / 10000) })),
      protestos,
    };
  }
}
