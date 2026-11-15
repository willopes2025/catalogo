import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { candidaturas, crmContatos, crmEtapas, crmEventos, crmFunis, crmLeads } from '../db/schema';
import { normalizarTelefone, variantesTelefone } from './telefone';

export type EventoCrm =
  | { tipo: 'lead_criado'; leadId: string }
  | { tipo: 'entrou_etapa'; leadId: string; etapaId: string }
  | { tipo: 'mensagem_recebida'; leadId: string; texto: string }
  | { tipo: 'etiqueta_adicionada'; leadId: string; etiqueta: string };

type Executor = Db | Tx;

/** Etapas do funil de recrutamento que espelham a etapa da candidatura. */
const ETAPAS_CANDIDATURA = ['nova', 'contato', 'entrevista', 'documentos', 'aprovada', 'recusada'];

/**
 * Núcleo do CRM: contatos, cards (leads), etapas e linha do tempo.
 * Toda mudança de etapa e todo lead novo avisa quem estiver ouvindo (os gatilhos).
 */
@Injectable()
export class CrmService {
  private readonly log = new Logger('CRM');
  private ouvintes: ((e: EventoCrm) => void | Promise<void>)[] = [];

  constructor(@Inject(DB) private readonly db: Db) {}

  ouvir(fn: (e: EventoCrm) => void | Promise<void>) {
    this.ouvintes.push(fn);
  }

  emitir(e: EventoCrm) {
    for (const fn of this.ouvintes) {
      Promise.resolve()
        .then(() => fn(e))
        .catch((err) => this.log.error(`Gatilho falhou (${e.tipo}): ${(err as Error).message}`));
    }
  }

  async funis(somenteAtivos = true) {
    const fs = await this.db.select().from(crmFunis).where(somenteAtivos ? eq(crmFunis.ativo, true) : undefined).orderBy(asc(crmFunis.ordem), asc(crmFunis.nome));
    const es = await this.db.select().from(crmEtapas).orderBy(asc(crmEtapas.ordem));
    return fs.map((f) => ({ ...f, etapas: es.filter((e) => e.funilId === f.id) }));
  }

  /** Funil automático (recrutamento, clientes, revendedoras) e a etapa pela chave. */
  async etapaAuto(tipoFunil: string, chave: string, db: Executor = this.db) {
    const [r] = await db
      .select({ funilId: crmFunis.id, etapaId: crmEtapas.id })
      .from(crmEtapas)
      .innerJoin(crmFunis, eq(crmFunis.id, crmEtapas.funilId))
      .where(and(eq(crmFunis.tipo, tipoFunil), eq(crmEtapas.chave, chave)))
      .orderBy(asc(crmFunis.ordem))
      .limit(1);
    return r ?? null;
  }

  async contatoPorTelefone(telefone: string, db: Executor = this.db) {
    const [c] = await db.select().from(crmContatos).where(inArray(crmContatos.telefone, variantesTelefone(telefone))).limit(1);
    return c ?? null;
  }

  /** Acha pelo telefone (com ou sem o 9) ou cria. Completa nome, e-mail e ficha quando faltam. */
  async garantirContato(d: { telefone: string; nome?: string | null; email?: string | null; pessoaId?: string | null }, db: Executor = this.db) {
    const tel = normalizarTelefone(d.telefone);
    if (!tel) throw new BadRequestException('Telefone inválido para WhatsApp.');
    const ja = await this.contatoPorTelefone(tel, db);
    if (ja) {
      const mudar: Partial<typeof crmContatos.$inferInsert> = {};
      if (d.pessoaId && !ja.pessoaId) mudar.pessoaId = d.pessoaId;
      if (d.email && !ja.email) mudar.email = d.email;
      if (d.nome && (ja.nome === ja.telefone || !ja.nome)) mudar.nome = d.nome;
      if (Object.keys(mudar).length) await db.update(crmContatos).set(mudar).where(eq(crmContatos.id, ja.id));
      return { ...ja, ...mudar };
    }
    const [novo] = await db
      .insert(crmContatos)
      .values({ telefone: tel, nome: d.nome?.trim() || tel, email: d.email ?? null, pessoaId: d.pessoaId ?? null })
      .onConflictDoUpdate({ target: crmContatos.telefone, set: { telefone: tel } })
      .returning();
    return novo;
  }

  async evento(leadId: string, tipo: string, texto: string, usuarioId?: string | null, dados?: unknown, db: Executor = this.db) {
    await db.insert(crmEventos).values({ leadId, tipo, texto, usuarioId: usuarioId ?? null, dados: dados ?? null });
  }

  async criarLead(
    d: {
      funilId: string;
      etapaId?: string | null;
      contatoId: string;
      titulo: string;
      valor?: number;
      origem?: Record<string, string>;
      camposExtras?: Record<string, string>;
      etiquetas?: string[];
      candidaturaId?: string | null;
      pessoaId?: string | null;
      responsavelId?: string | null;
      usuarioId?: string | null;
    },
    db: Executor = this.db,
  ) {
    let etapaId = d.etapaId ?? null;
    const [etapa] = etapaId
      ? await db.select().from(crmEtapas).where(and(eq(crmEtapas.id, etapaId), eq(crmEtapas.funilId, d.funilId)))
      : await db.select().from(crmEtapas).where(eq(crmEtapas.funilId, d.funilId)).orderBy(asc(crmEtapas.ordem)).limit(1);
    if (!etapa) throw new BadRequestException('Etapa não pertence a este funil.');
    etapaId = etapa.id;
    const [l] = await db
      .insert(crmLeads)
      .values({
        funilId: d.funilId,
        etapaId,
        contatoId: d.contatoId,
        titulo: d.titulo.slice(0, 200),
        valor: d.valor ?? 0,
        origem: d.origem ?? {},
        camposExtras: d.camposExtras ?? {},
        etiquetas: d.etiquetas ?? [],
        candidaturaId: d.candidaturaId ?? null,
        pessoaId: d.pessoaId ?? null,
        responsavelId: d.responsavelId ?? null,
        status: etapa.tipo === 'ganho' ? 'ganho' : etapa.tipo === 'perdido' ? 'perdido' : 'aberto',
      })
      .returning();
    await this.evento(l.id, 'sistema', `Card criado em "${etapa.nome}".`, d.usuarioId, null, db);
    const emitir = () => {
      this.emitir({ tipo: 'lead_criado', leadId: l.id });
      this.emitir({ tipo: 'entrou_etapa', leadId: l.id, etapaId: etapa.id });
    };
    // Dentro de transação, os gatilhos só depois de gravar.
    if (db === this.db) emitir();
    else setTimeout(emitir, 50);
    return l;
  }

  /** Lead aberto do contato no funil (para não duplicar cards). */
  async leadAberto(contatoId: string, funilId: string, db: Executor = this.db) {
    const [l] = await db.select().from(crmLeads).where(and(eq(crmLeads.contatoId, contatoId), eq(crmLeads.funilId, funilId), eq(crmLeads.status, 'aberto'))).limit(1);
    return l ?? null;
  }

  async moverLead(leadId: string, etapaId: string, opcoes: { usuarioId?: string | null; motivo?: string | null; origem?: string } = {}, db: Executor = this.db) {
    const [l] = await db.select().from(crmLeads).where(eq(crmLeads.id, leadId));
    if (!l) throw new NotFoundException('Card não encontrado.');
    if (l.etapaId === etapaId) return l;
    const [e] = await db.select().from(crmEtapas).where(and(eq(crmEtapas.id, etapaId), eq(crmEtapas.funilId, l.funilId)));
    if (!e) throw new BadRequestException('Etapa não pertence ao funil do card.');
    const [antes] = await db.select({ nome: crmEtapas.nome }).from(crmEtapas).where(eq(crmEtapas.id, l.etapaId));
    if (e.tipo === 'perdido' && !opcoes.motivo && opcoes.origem !== 'automatico') throw new BadRequestException('Informe o motivo da perda.');
    const status = e.tipo === 'ganho' ? 'ganho' : e.tipo === 'perdido' ? 'perdido' : 'aberto';
    const [r] = await db
      .update(crmLeads)
      .set({ etapaId, status, entrouNaEtapaEm: new Date(), atualizadoEm: new Date(), ...(e.tipo === 'perdido' ? { motivoPerda: opcoes.motivo ?? null } : {}) })
      .where(eq(crmLeads.id, leadId))
      .returning();
    await this.evento(leadId, 'etapa', `De "${antes?.nome ?? '?'}" para "${e.nome}"${opcoes.motivo ? `: ${opcoes.motivo}` : ''}${opcoes.origem === 'automatico' ? ' (automático)' : opcoes.origem === 'gatilho' ? ' (gatilho)' : ''}.`, opcoes.usuarioId, null, db);
    // Recrutamento: a candidatura acompanha (a aprovação tem fluxo próprio, que cria a revendedora).
    if (l.candidaturaId && e.chave && ETAPAS_CANDIDATURA.includes(e.chave) && e.chave !== 'aprovada') {
      await db.update(candidaturas).set({ etapa: e.chave, atualizadoEm: new Date(), ...(e.chave === 'recusada' ? { motivoRecusa: opcoes.motivo ?? null } : {}) }).where(eq(candidaturas.id, l.candidaturaId));
    }
    if (db === this.db) this.emitir({ tipo: 'entrou_etapa', leadId, etapaId });
    else setTimeout(() => this.emitir({ tipo: 'entrou_etapa', leadId, etapaId }), 50);
    return r;
  }

  async adicionarEtiqueta(leadId: string, etiqueta: string, usuarioId?: string | null) {
    const e = etiqueta.trim().slice(0, 40);
    if (!e) return;
    const [l] = await this.db.select({ etiquetas: crmLeads.etiquetas }).from(crmLeads).where(eq(crmLeads.id, leadId));
    if (!l || l.etiquetas.includes(e)) return;
    await this.db.update(crmLeads).set({ etiquetas: [...l.etiquetas, e], atualizadoEm: new Date() }).where(eq(crmLeads.id, leadId));
    await this.evento(leadId, 'campo', `Etiqueta "${e}" adicionada.`, usuarioId);
    this.emitir({ tipo: 'etiqueta_adicionada', leadId, etiqueta: e });
  }

  async tocarInteracao(contatoId: string) {
    await this.db.update(crmLeads).set({ ultimaInteracaoEm: new Date() }).where(and(eq(crmLeads.contatoId, contatoId), eq(crmLeads.status, 'aberto')));
  }

  async leadsAbertosDoContato(contatoId: string) {
    return this.db.select().from(crmLeads).where(and(eq(crmLeads.contatoId, contatoId), eq(crmLeads.status, 'aberto')));
  }

  /** Dados para preencher {{nome}}, {{primeiro_nome}}, {{etapa}}… numa mensagem. */
  async dadosDoLead(leadId: string) {
    const r = await this.db.execute<{ nome: string; telefone: string; etapa: string; funil: string; titulo: string }>(sql`
      select c.nome, c.telefone, e.nome as etapa, f.nome as funil, l.titulo
      from crm_leads l join crm_contatos c on c.id = l.contato_id join crm_etapas e on e.id = l.etapa_id join crm_funis f on f.id = l.funil_id
      where l.id = ${leadId}`);
    return r.rows[0] ?? null;
  }
}
