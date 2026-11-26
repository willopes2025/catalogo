import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { assistenteAcoes, cobrancaContatos, cobrancaEnvios, crmCanais, envioItens, envioLotes, usuarios } from '../db/schema';
import { CanaisService } from './canais.service';

type Canal = typeof crmCanais.$inferSelect;
type Lote = typeof envioLotes.$inferSelect;
type Item = typeof envioItens.$inferSelect;

/** Horário e intervalo do envio em massa de um número. */
export type JanelaEnvio = Pick<Canal, 'envioInicio' | 'envioFim' | 'envioDias' | 'envioIntervaloMinS' | 'envioIntervaloMaxS'>;

export interface NovoItem {
  pessoaId?: string | null;
  nome: string;
  telefone: string;
  texto: string;
  templateId?: string | null;
  dados?: Item['dados'];
}

/** Brasília não tem horário de verão desde 2019: UTC−3 o ano todo. */
const FUSO_MS = 3 * 3600_000;
const minutosDe = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** O envio em massa pode sair agora por este número? (dia da semana e horário de Brasília) */
export function dentroDaJanela(j: JanelaEnvio, agora = new Date()) {
  const local = new Date(agora.getTime() - FUSO_MS);
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  return j.envioDias.includes(local.getUTCDay()) && min >= minutosDe(j.envioInicio) && min < minutosDe(j.envioFim);
}

/** Primeiro instante, a partir de `de`, em que o número pode mandar. Null se nenhum dia está marcado. */
export function proximaAbertura(j: JanelaEnvio, de = new Date()): Date | null {
  if (!j.envioDias.length || minutosDe(j.envioFim) <= minutosDe(j.envioInicio)) return null;
  if (dentroDaJanela(j, de)) return de;
  const local = new Date(de.getTime() - FUSO_MS);
  for (let d = 0; d <= 7; d++) {
    const dia = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d));
    if (!j.envioDias.includes(dia.getUTCDay())) continue;
    const abre = new Date(dia.getTime() + minutosDe(j.envioInicio) * 60_000 + FUSO_MS);
    const fecha = new Date(dia.getTime() + minutosDe(j.envioFim) * 60_000 + FUSO_MS);
    if (fecha <= de) continue;
    return abre > de ? abre : de;
  }
  return null;
}

/** Previsão de quando a última de `restantes` mensagens sai, com o intervalo médio e respeitando o horário. */
export function previsaoTermino(j: JanelaEnvio, restantes: number, proximo: Date | null, agora = new Date()): Date | null {
  if (restantes <= 0) return agora;
  const media = ((j.envioIntervaloMinS + j.envioIntervaloMaxS) / 2) * 1000;
  let t: Date | null = proximo && proximo > agora ? proximo : agora;
  for (let i = 0; i < restantes; i++) {
    t = proximaAbertura(j, t!);
    if (!t) return null;
    if (i < restantes - 1) t = new Date(t.getTime() + media);
  }
  return t;
}

const sorteio = (j: JanelaEnvio) => Math.round((j.envioIntervaloMinS + Math.random() * Math.max(0, j.envioIntervaloMaxS - j.envioIntervaloMinS)) * 1000);
const FALHAS_PARA_PARAR = 3;

/**
 * Envio em massa pelo WhatsApp, uma mensagem por vez por número: espera sorteada entre o mínimo e o máximo
 * configurados no número e só no horário permitido. O que não sai hoje continua no próximo dia permitido.
 * A fila fica no banco: sobrevive a atualização do sistema. Lotes do mesmo número revezam entre si.
 */
@Injectable()
export class FilaEnvioService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Fila de envio');
  private relogio?: NodeJS.Timeout;
  private rodando = false;
  /** Antes de mandar: devolve um motivo para pular a mensagem (ex.: a pessoa já pagou), por origem do lote. */
  private readonly verificadores = new Map<string, (i: Item, l: Lote) => Promise<string | null>>();
  /** Quando um lote termina (concluído ou cancelado), por origem. */
  private readonly aoTerminar = new Map<string, (l: Lote) => Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly canais: CanaisService,
  ) {}

  onModuleInit() {
    if (process.env.FILA_ENVIO === '0') return;
    const ms = Number(process.env.FILA_TICK_MS ?? 15_000);
    this.relogio = setInterval(() => void this.volta().catch((e) => this.log.warn((e as Error).message)), ms);
    this.relogio.unref?.();
  }
  onModuleDestroy() {
    if (this.relogio) clearInterval(this.relogio);
  }

  verificarAntes(origem: string, fn: (i: Item, l: Lote) => Promise<string | null>) {
    this.verificadores.set(origem, fn);
  }
  quandoTerminar(origem: string, fn: (l: Lote) => Promise<void>) {
    this.aoTerminar.set(origem, fn);
  }

  async criarLote(d: { canalId: string; origem: string; titulo: string; criadoPor?: string | null; acaoId?: string | null; itens: NovoItem[]; pausado?: boolean; aviso?: string | null }) {
    if (!d.itens.length) throw new BadRequestException('Nenhuma mensagem para enviar.');
    const canal = await this.canais.obter(d.canalId);
    if (!canal.ativo || canal.excluidoEm) throw new BadRequestException(`O número "${canal.nome}" está desativado.`);
    return this.db.transaction(async (tx) => {
      const [l] = await tx.insert(envioLotes).values({ canalId: d.canalId, origem: d.origem, titulo: d.titulo.slice(0, 200), criadoPor: d.criadoPor ?? null, acaoId: d.acaoId ?? null, total: d.itens.length, ...(d.pausado ? { status: 'pausado' as const } : {}), aviso: d.aviso ?? null }).returning();
      for (let i = 0; i < d.itens.length; i += 200)
        await tx.insert(envioItens).values(d.itens.slice(i, i + 200).map((x, n) => ({ loteId: l.id, ordem: i + n, pessoaId: x.pessoaId ?? null, nome: x.nome, telefone: x.telefone, texto: x.texto, templateId: x.templateId ?? null, dados: x.dados ?? {} })));
      return l;
    });
  }

  /** Lote com o andamento e a previsão de término. */
  private async comPrevisao(l: Lote & { canal: string | null; criador?: string | null }, c?: Canal) {
    const canal = c ?? (await this.canais.obter(l.canalId));
    const [{ restantes }] = await this.db.select({ restantes: sql<number>`count(*)::int` }).from(envioItens).where(and(eq(envioItens.loteId, l.id), inArray(envioItens.status, ['pendente', 'enviando'])));
    // Os outros lotes ativos do mesmo número revezam com este: entram na conta da previsão.
    const [{ outros }] = await this.db
      .select({ outros: sql<number>`count(*)::int` })
      .from(envioItens)
      .innerJoin(envioLotes, eq(envioLotes.id, envioItens.loteId))
      .where(and(eq(envioLotes.canalId, l.canalId), eq(envioLotes.status, 'ativo'), sql`${envioLotes.id} <> ${l.id}`, eq(envioItens.status, 'pendente')));
    const naFrente = l.status === 'ativo' ? restantes + Math.min(outros, restantes) : 0;
    const agora = new Date();
    return {
      ...l,
      restantes,
      janela: { inicio: canal.envioInicio, fim: canal.envioFim, dias: canal.envioDias, intervaloMinS: canal.envioIntervaloMinS, intervaloMaxS: canal.envioIntervaloMaxS },
      agoraNoHorario: dentroDaJanela(canal, agora),
      proximoEnvioEm: l.status === 'ativo' && restantes ? (proximaAbertura(canal, canal.proximoEnvioEm && canal.proximoEnvioEm > agora ? canal.proximoEnvioEm : agora)?.toISOString() ?? null) : null,
      previsaoFim: l.status === 'ativo' && restantes ? (previsaoTermino(canal, naFrente, canal.proximoEnvioEm, agora)?.toISOString() ?? null) : null,
    };
  }

  async listar(f: { status?: string; acaoId?: string; limite?: number } = {}) {
    const lotes = await this.db
      .select({ l: envioLotes, canal: crmCanais.nome, criador: usuarios.nome })
      .from(envioLotes)
      .leftJoin(crmCanais, eq(crmCanais.id, envioLotes.canalId))
      .leftJoin(usuarios, eq(usuarios.id, envioLotes.criadoPor))
      .where(and(f.status === 'andamento' ? inArray(envioLotes.status, ['ativo', 'pausado']) : f.status ? eq(envioLotes.status, f.status) : undefined, f.acaoId ? eq(envioLotes.acaoId, f.acaoId) : undefined))
      .orderBy(desc(envioLotes.criadoEm))
      .limit(Math.min(100, f.limite ?? 30));
    return Promise.all(lotes.map((x) => this.comPrevisao({ ...x.l, canal: x.canal, criador: x.criador })));
  }

  async obter(id: string) {
    const [x] = await this.db.select({ l: envioLotes, canal: crmCanais.nome, criador: usuarios.nome }).from(envioLotes).leftJoin(crmCanais, eq(crmCanais.id, envioLotes.canalId)).leftJoin(usuarios, eq(usuarios.id, envioLotes.criadoPor)).where(eq(envioLotes.id, id));
    if (!x) throw new NotFoundException('Envio não encontrado.');
    const itens = await this.db.select({ id: envioItens.id, nome: envioItens.nome, telefone: envioItens.telefone, status: envioItens.status, erro: envioItens.erro, enviadoEm: envioItens.enviadoEm, texto: envioItens.texto, pessoaId: envioItens.pessoaId }).from(envioItens).where(eq(envioItens.loteId, id)).orderBy(asc(envioItens.ordem)).limit(1000);
    return { ...(await this.comPrevisao({ ...x.l, canal: x.canal, criador: x.criador })), itens };
  }

  async pausar(id: string) {
    const [l] = await this.db.update(envioLotes).set({ status: 'pausado' }).where(and(eq(envioLotes.id, id), eq(envioLotes.status, 'ativo'))).returning();
    if (!l) throw new BadRequestException('Só dá para pausar um envio em andamento.');
    return this.obter(id);
  }

  async retomar(id: string) {
    const [l] = await this.db.update(envioLotes).set({ status: 'ativo', aviso: null }).where(and(eq(envioLotes.id, id), eq(envioLotes.status, 'pausado'))).returning();
    if (!l) throw new BadRequestException('Só dá para retomar um envio pausado.');
    return this.obter(id);
  }

  async cancelar(id: string) {
    const [l] = await this.db.update(envioLotes).set({ status: 'cancelado', concluidoEm: new Date() }).where(and(eq(envioLotes.id, id), inArray(envioLotes.status, ['ativo', 'pausado']))).returning();
    if (!l) throw new BadRequestException('Este envio já terminou.');
    const canceladas = await this.db.update(envioItens).set({ status: 'cancelado' }).where(and(eq(envioItens.loteId, id), eq(envioItens.status, 'pendente'))).returning({ dados: envioItens.dados });
    // Etapa da trilha que não saiu: libera para sair de novo numa próxima rodada.
    const titulosIds = canceladas.flatMap((c) => (c.dados.passo !== undefined ? (c.dados.tituloIds ?? []).map((t) => ({ t, p: c.dados.passo! })) : []));
    for (const x of titulosIds) await this.db.delete(cobrancaEnvios).where(and(eq(cobrancaEnvios.tituloId, x.t), eq(cobrancaEnvios.passo, x.p), eq(cobrancaEnvios.resultado, 'na_fila')));
    await this.terminar(l);
    return this.obter(id);
  }

  /** Uma volta da fila: cada número com envio ativo manda a próxima mensagem, se já deu o tempo e está no horário. */
  async volta() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      const canais = await this.db
        .selectDistinct({ c: crmCanais })
        .from(envioLotes)
        .innerJoin(crmCanais, eq(crmCanais.id, envioLotes.canalId))
        .where(eq(envioLotes.status, 'ativo'));
      const agora = new Date();
      for (const { c } of canais) {
        if (!c.ativo || c.excluidoEm) continue;
        if (c.proximoEnvioEm && c.proximoEnvioEm > agora) continue;
        if (!dentroDaJanela(c, agora)) continue;
        await this.mandarProxima(c).catch((e) => this.log.warn(`Número ${c.nome}: ${(e as Error).message}`));
      }
    } finally {
      this.rodando = false;
    }
  }

  private async mandarProxima(c: Canal) {
    // Revezamento: o lote que mandou há mais tempo (ou nunca) vai primeiro.
    for (let tentativa = 0; tentativa < 50; tentativa++) {
      const [prox] = await this.db
        .select({ i: envioItens, l: envioLotes })
        .from(envioItens)
        .innerJoin(envioLotes, eq(envioLotes.id, envioItens.loteId))
        .where(and(eq(envioLotes.canalId, c.id), eq(envioLotes.status, 'ativo'), eq(envioItens.status, 'pendente')))
        .orderBy(sql`${envioLotes.ultimoEnvioEm} asc nulls first`, asc(envioLotes.criadoEm), asc(envioItens.ordem))
        .limit(1);
      if (!prox) {
        // Lotes ativos sem nada pendente: terminaram.
        const fim = await this.db.update(envioLotes).set({ status: 'concluido', concluidoEm: new Date() }).where(and(eq(envioLotes.canalId, c.id), eq(envioLotes.status, 'ativo'), sql`not exists (select 1 from envio_itens i where i.lote_id = ${envioLotes.id} and i.status in ('pendente', 'enviando'))`)).returning();
        for (const l of fim) await this.terminar(l);
        return;
      }
      const [tomado] = await this.db.update(envioItens).set({ status: 'enviando' }).where(and(eq(envioItens.id, prox.i.id), eq(envioItens.status, 'pendente'))).returning();
      if (!tomado) continue;
      // Ainda vale mandar? (ex.: a pessoa pagou depois de entrar na fila) Pulada não gasta o intervalo.
      const motivo = await this.verificadores.get(prox.l.origem)?.(tomado, prox.l).catch((e) => `não deu para conferir: ${(e as Error).message}`);
      if (motivo) {
        await this.db.update(envioItens).set({ status: 'pulado', erro: motivo.slice(0, 300) }).where(eq(envioItens.id, tomado.id));
        await this.db.update(envioLotes).set({ pulados: sql`${envioLotes.pulados} + 1` }).where(eq(envioLotes.id, prox.l.id));
        await this.marcarCobranca(tomado, 'pulado', motivo);
        await this.depoisDoItem(prox.l.id);
        continue;
      }
      let erro: string | null = null;
      try {
        await this.canais.enviarParaTelefone({ canalId: c.id, telefone: tomado.telefone, nome: tomado.nome, texto: tomado.texto, templateId: tomado.templateId });
      } catch (e) {
        erro = (e as Error).message.slice(0, 300);
      }
      const agora = new Date();
      await this.db.update(envioItens).set({ status: erro ? 'falhou' : 'enviado', erro, enviadoEm: agora }).where(eq(envioItens.id, tomado.id));
      await this.db.update(envioLotes).set(erro ? { falhas: sql`${envioLotes.falhas} + 1`, ultimoEnvioEm: agora } : { enviados: sql`${envioLotes.enviados} + 1`, ultimoEnvioEm: agora }).where(eq(envioLotes.id, prox.l.id));
      await this.db.update(crmCanais).set({ proximoEnvioEm: new Date(agora.getTime() + sorteio(c)) }).where(eq(crmCanais.id, c.id));
      await this.marcarCobranca(tomado, erro ? 'falhou' : 'enviado', erro);
      if (erro) await this.pararSeFalhando(prox.l.id);
      await this.depoisDoItem(prox.l.id);
      return;
    }
  }

  /** Falhas seguidas (número desconectado, bloqueado…): pausa o lote em vez de queimar a lista toda. */
  private async pararSeFalhando(loteId: string) {
    const ultimos = await this.db.select({ status: envioItens.status, erro: envioItens.erro }).from(envioItens).where(and(eq(envioItens.loteId, loteId), inArray(envioItens.status, ['enviado', 'falhou']))).orderBy(desc(envioItens.enviadoEm)).limit(FALHAS_PARA_PARAR);
    if (ultimos.length === FALHAS_PARA_PARAR && ultimos.every((u) => u.status === 'falhou'))
      await this.db.update(envioLotes).set({ status: 'pausado', aviso: `Pausado sozinho: ${FALHAS_PARA_PARAR} mensagens seguidas não saíram (última: ${ultimos[0].erro ?? 'erro'}). Confira o número e retome.` }).where(and(eq(envioLotes.id, loteId), eq(envioLotes.status, 'ativo')));
  }

  /** Histórico de cobrança da pessoa e controle da trilha. */
  private async marcarCobranca(i: Item, resultado: 'enviado' | 'falhou' | 'pulado', detalhe: string | null) {
    if (i.dados.passo !== undefined && i.dados.tituloIds?.length)
      await this.db.update(cobrancaEnvios).set({ resultado, detalhe: detalhe?.slice(0, 300) ?? null }).where(and(inArray(cobrancaEnvios.tituloId, i.dados.tituloIds), eq(cobrancaEnvios.passo, i.dados.passo)));
    if (!i.pessoaId || !(i.dados.registrarCobranca || i.dados.passo !== undefined)) return;
    if (resultado === 'pulado' && i.dados.passo === undefined) return;
    const etapa = i.dados.etapa ? `Trilha de cobrança (${i.dados.etapa})` : 'Mensagem do envio em lote';
    const texto = resultado === 'enviado' ? `${etapa}, por WhatsApp:\n${i.texto}` : resultado === 'pulado' ? `${etapa} não enviada: ${detalhe}` : `${etapa} não saiu: ${detalhe}`;
    await this.db.insert(cobrancaContatos).values({ pessoaId: i.pessoaId, usuarioId: i.dados.usuarioId ?? null, tipo: i.dados.passo !== undefined ? 'regua' : 'whatsapp', texto });
  }

  /** Andamento no cartão do assistente e fim do lote. */
  private async depoisDoItem(loteId: string) {
    const [l] = await this.db.select().from(envioLotes).where(eq(envioLotes.id, loteId));
    if (!l) return;
    if (l.acaoId) await this.db.update(assistenteAcoes).set({ progresso: { feitos: l.enviados + l.falhas + l.pulados, total: l.total, falhas: l.falhas } }).where(eq(assistenteAcoes.id, l.acaoId));
    const [{ resta }] = await this.db.select({ resta: sql<number>`count(*)::int` }).from(envioItens).where(and(eq(envioItens.loteId, loteId), inArray(envioItens.status, ['pendente', 'enviando'])));
    if (resta) return;
    const [fim] = await this.db.update(envioLotes).set({ status: 'concluido', concluidoEm: new Date() }).where(and(eq(envioLotes.id, loteId), inArray(envioLotes.status, ['ativo', 'pausado']))).returning();
    if (fim) await this.terminar(fim);
  }

  private async terminar(l: Lote) {
    await this.aoTerminar.get(l.origem)?.(l).catch((e) => this.log.warn(`Fim do lote ${l.id}: ${(e as Error).message}`));
  }

  /** Falhas do lote (nome e motivo), para o aviso de fim. */
  async falhas(loteId: string) {
    return this.db.select({ nome: envioItens.nome, erro: envioItens.erro, status: envioItens.status }).from(envioItens).where(and(eq(envioItens.loteId, loteId), inArray(envioItens.status, ['falhou', 'pulado']))).orderBy(asc(envioItens.ordem));
  }

  /** Lotes ainda abertos de uma origem num número (ex.: a trilha do dia). */
  async aberto(canalId: string, origem: string, titulo: string) {
    const [l] = await this.db.select().from(envioLotes).where(and(eq(envioLotes.canalId, canalId), eq(envioLotes.origem, origem), eq(envioLotes.titulo, titulo), inArray(envioLotes.status, ['ativo', 'pausado']), isNull(envioLotes.concluidoEm))).limit(1);
    return l ?? null;
  }

  /** Acrescenta mensagens a um lote aberto. */
  async acrescentar(loteId: string, itens: NovoItem[]) {
    if (!itens.length) return;
    const [{ max }] = await this.db.select({ max: sql<number>`coalesce(max(${envioItens.ordem}), -1)::int` }).from(envioItens).where(eq(envioItens.loteId, loteId));
    await this.db.insert(envioItens).values(itens.map((x, n) => ({ loteId, ordem: max + 1 + n, pessoaId: x.pessoaId ?? null, nome: x.nome, telefone: x.telefone, texto: x.texto, templateId: x.templateId ?? null, dados: x.dados ?? {} })));
    await this.db.update(envioLotes).set({ total: sql`${envioLotes.total} + ${itens.length}` }).where(eq(envioLotes.id, loteId));
  }
}
