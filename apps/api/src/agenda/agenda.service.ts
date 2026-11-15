import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { urlPublica } from '../comum/url';
import { agendaCompromissos, crmCanais, crmContatos, crmLeads, maletas, pessoas, usuarios } from '../db/schema';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { GoogleService } from './google.service';

export type Compromisso = typeof agendaCompromissos.$inferSelect;

export const TIPOS_COMPROMISSO = {
  entrevista: { nome: 'Entrevista de candidata', duracao: 30, online: true },
  acerto_video: { nome: 'Acerto por vídeo', duracao: 45, online: true },
  retirada: { nome: 'Retirada de maleta', duracao: 30, online: false },
  reuniao: { nome: 'Reunião', duracao: 60, online: true },
  outro: { nome: 'Outro', duracao: 30, online: false },
} as const;
export type TipoCompromisso = keyof typeof TIPOS_COMPROMISSO;

export interface DadosCompromisso {
  tipo: TipoCompromisso;
  titulo?: string | null;
  inicio: Date;
  duracaoMin: number;
  online: boolean;
  local?: string | null;
  link?: string | null;
  responsavelId?: string | null;
  pessoaId?: string | null;
  leadId?: string | null;
  maletaId?: string | null;
  convidadoNome?: string | null;
  convidadoTelefone?: string | null;
  observacao?: string | null;
  avisar: boolean;
  /** Marca mesmo batendo com outro compromisso do mesmo responsável. */
  forcar?: boolean;
}

const hora = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const dia = (d: Date) => d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });

@Injectable()
export class AgendaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Agenda');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly google: GoogleService,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
  ) {}

  onModuleInit() {
    if (process.env.CRM_AUTOMATICO === '0') return;
    this.timer = setInterval(() => void this.enviarLembretes().catch((e) => this.log.error((e as Error).message)), 5 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async obter(id: string) {
    const [c] = await this.db.select().from(agendaCompromissos).where(eq(agendaCompromissos.id, id));
    if (!c) throw new NotFoundException('Compromisso não encontrado.');
    return c;
  }

  /** Quem vai receber o lembrete: a representante, o contato do card ou o convidado digitado. */
  private async convidado(c: Pick<Compromisso, 'pessoaId' | 'leadId' | 'convidadoNome' | 'convidadoTelefone'>) {
    if (c.pessoaId) {
      const [p] = await this.db.select({ id: pessoas.id, nome: pessoas.nome, telefone: pessoas.telefone1 }).from(pessoas).where(eq(pessoas.id, c.pessoaId));
      if (p) return { nome: p.nome, telefone: p.telefone, pessoaId: p.id };
    }
    if (c.leadId) {
      const [l] = await this.db.select({ nome: crmContatos.nome, telefone: crmContatos.telefone }).from(crmLeads).innerJoin(crmContatos, eq(crmContatos.id, crmLeads.contatoId)).where(eq(crmLeads.id, c.leadId));
      if (l) return { nome: l.nome, telefone: l.telefone, pessoaId: null };
    }
    return c.convidadoTelefone ? { nome: c.convidadoNome ?? 'Olá', telefone: c.convidadoTelefone, pessoaId: null } : null;
  }

  /** Compromissos do mesmo responsável que se sobrepõem a este horário. */
  async conflitos(responsavelId: string | null | undefined, inicio: Date, fim: Date, ignorar?: string) {
    if (!responsavelId) return [];
    return this.db
      .select({ id: agendaCompromissos.id, titulo: agendaCompromissos.titulo, inicio: agendaCompromissos.inicio, fim: agendaCompromissos.fim })
      .from(agendaCompromissos)
      .where(and(eq(agendaCompromissos.responsavelId, responsavelId), inArray(agendaCompromissos.status, ['marcado', 'confirmado']), lt(agendaCompromissos.inicio, fim), gt(agendaCompromissos.fim, inicio), ...(ignorar ? [ne(agendaCompromissos.id, ignorar)] : [])));
  }

  private async titulo(d: DadosCompromisso) {
    if (d.titulo?.trim()) return d.titulo.trim();
    const quem = await this.convidado({ pessoaId: d.pessoaId ?? null, leadId: d.leadId ?? null, convidadoNome: d.convidadoNome ?? null, convidadoTelefone: d.convidadoTelefone ?? null });
    return `${TIPOS_COMPROMISSO[d.tipo].nome}${quem ? ` · ${quem.nome}` : ''}`;
  }

  /** Cria no Google (com Meet, se online) quando a conta está conectada. Falha do Google não impede marcar. */
  private async noGoogle(c: Compromisso, avisos: string[]) {
    if (!this.google.conectado) {
      if (c.online && !c.link) avisos.push('Sem link da chamada: conecte a conta Google em Agenda para gerar o Meet sozinho, ou cole um link.');
      return c;
    }
    const evento = { titulo: c.titulo, descricao: [c.observacao, `Marcado pelo sistema Aritana.`].filter(Boolean).join('\n\n'), inicio: c.inicio, fim: c.fim, local: c.online ? null : c.local, comMeet: c.online && !c.link };
    try {
      const r = c.googleEventoId ? await this.google.atualizar(c.googleEventoId, evento, !!c.link) : await this.google.criar(evento);
      const [n] = await this.db.update(agendaCompromissos).set({ googleEventoId: r.id, link: c.link ?? r.link }).where(eq(agendaCompromissos.id, c.id)).returning();
      return n;
    } catch (e) {
      avisos.push(`Marcado aqui, mas não foi para o Google: ${(e as Error).message}`);
      return c;
    }
  }

  async criar(d: DadosCompromisso, usuarioId: string) {
    const fim = new Date(d.inicio.getTime() + d.duracaoMin * 60_000);
    if (d.inicio.getTime() < Date.now() - 5 * 60_000) throw new BadRequestException('O horário já passou.');
    d.responsavelId = d.responsavelId ?? usuarioId;
    if (!d.forcar) {
      const bate = await this.conflitos(d.responsavelId, d.inicio, fim);
      if (bate.length) throw new ConflictException({ mensagem: `Bate com "${bate[0].titulo}" (${hora(bate[0].inicio)}–${hora(bate[0].fim)}). Marque mesmo assim ou escolha outro horário.`, conflito: true });
    }
    if (d.maletaId) {
      const [m] = await this.db.select({ rep: maletas.representanteId }).from(maletas).where(eq(maletas.id, d.maletaId));
      if (!m) throw new BadRequestException('Maleta não encontrada.');
      d.pessoaId = d.pessoaId ?? m.rep;
    }
    const titulo = await this.titulo(d);
    const [c] = await this.db
      .insert(agendaCompromissos)
      .values({
        tipo: d.tipo, titulo, inicio: d.inicio, fim, online: d.online, local: d.online ? null : (d.local ?? null), link: d.online ? (d.link ?? null) : null,
        responsavelId: d.responsavelId ?? usuarioId, pessoaId: d.pessoaId ?? null, leadId: d.leadId ?? null, maletaId: d.maletaId ?? null,
        convidadoNome: d.convidadoNome ?? null, convidadoTelefone: d.convidadoTelefone ?? null, observacao: d.observacao ?? null, avisar: d.avisar, criadoPor: usuarioId,
      })
      .returning();
    const avisos: string[] = [];
    const final = await this.noGoogle(c, avisos);
    if (c.leadId) await this.crm.evento(c.leadId, 'sistema', `${titulo}: ${dia(c.inicio)}, ${hora(c.inicio)}${c.online ? ' (online)' : c.local ? ` em ${c.local}` : ''}.`, usuarioId);
    if (d.avisar) await this.avisar(final, 'marcado').catch((e) => avisos.push(`Aviso pelo WhatsApp não foi: ${(e as Error).message}`));
    return { ...final, avisos };
  }

  async editar(id: string, d: Partial<DadosCompromisso>, usuarioId: string) {
    const atual = await this.obter(id);
    if (['cancelado', 'realizado', 'faltou'].includes(atual.status)) throw new BadRequestException('Este compromisso já foi encerrado.');
    const inicio = d.inicio ?? atual.inicio;
    const duracao = d.duracaoMin ?? Math.round((atual.fim.getTime() - atual.inicio.getTime()) / 60_000);
    const fim = new Date(inicio.getTime() + duracao * 60_000);
    const mudouHora = inicio.getTime() !== atual.inicio.getTime() || fim.getTime() !== atual.fim.getTime();
    if (mudouHora && !d.forcar) {
      const bate = await this.conflitos(d.responsavelId ?? atual.responsavelId, inicio, fim, id);
      if (bate.length) throw new ConflictException({ mensagem: `Bate com "${bate[0].titulo}" (${hora(bate[0].inicio)}–${hora(bate[0].fim)}).`, conflito: true });
    }
    const online = d.online ?? atual.online;
    const [c] = await this.db
      .update(agendaCompromissos)
      .set({
        titulo: d.titulo?.trim() || atual.titulo, inicio, fim, online, local: online ? null : (d.local !== undefined ? d.local : atual.local),
        link: online ? (d.link !== undefined ? d.link : atual.link) : null, responsavelId: d.responsavelId ?? atual.responsavelId,
        observacao: d.observacao !== undefined ? d.observacao : atual.observacao, avisar: d.avisar ?? atual.avisar,
        // Remarcou: os lembretes valem de novo e a confirmação anterior não.
        ...(mudouHora ? { lembreteDiaEm: null, lembreteHoraEm: null, confirmadoEm: null, status: 'marcado' } : {}),
        atualizadoEm: new Date(),
      })
      .where(eq(agendaCompromissos.id, id))
      .returning();
    const avisos: string[] = [];
    const final = await this.noGoogle(c, avisos);
    if (mudouHora && c.leadId) await this.crm.evento(c.leadId, 'sistema', `${c.titulo} remarcado para ${dia(inicio)}, ${hora(inicio)}.`, usuarioId);
    if (mudouHora && c.avisar) await this.avisar(final, 'remarcado').catch((e) => avisos.push(`Aviso pelo WhatsApp não foi: ${(e as Error).message}`));
    return { ...final, avisos };
  }

  async situacao(id: string, status: 'confirmado' | 'realizado' | 'faltou' | 'cancelado', usuarioId: string | null, motivo?: string | null) {
    const c = await this.obter(id);
    if (c.status === 'cancelado') throw new BadRequestException('Este compromisso foi cancelado.');
    if ((status === 'realizado' || status === 'faltou') && c.inicio.getTime() > Date.now()) throw new BadRequestException('Ainda não chegou a hora deste compromisso.');
    const [n] = await this.db
      .update(agendaCompromissos)
      .set({ status, ...(status === 'confirmado' ? { confirmadoEm: new Date() } : {}), observacao: motivo ? [c.observacao, motivo].filter(Boolean).join('\n') : c.observacao, atualizadoEm: new Date() })
      .where(eq(agendaCompromissos.id, id))
      .returning();
    if (status === 'cancelado') {
      if (c.googleEventoId && this.google.conectado) await this.google.apagar(c.googleEventoId);
      if (c.avisar && c.inicio.getTime() > Date.now()) await this.avisar(n, 'cancelado').catch(() => undefined);
    }
    const nomes = { confirmado: 'confirmado', realizado: 'realizado', faltou: 'não compareceu', cancelado: 'cancelado' };
    if (c.leadId) await this.crm.evento(c.leadId, 'sistema', `${c.titulo}: ${nomes[status]}${motivo ? ` (${motivo})` : ''}.`, usuarioId);
    return n;
  }

  // ───── WhatsApp ─────

  private async canalPadrao() {
    const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(asc(crmCanais.criadoEm));
    return (cs.find((c) => c.tipo !== 'oficial') ?? cs[0])?.id ?? null;
  }

  private async avisar(c: Compromisso, motivo: 'marcado' | 'remarcado' | 'cancelado' | 'lembrete_dia' | 'lembrete_hora') {
    const quem = await this.convidado(c);
    if (!quem?.telefone) throw new Error('sem telefone de quem vai participar');
    const canalId = await this.canalPadrao();
    if (!canalId) throw new Error('nenhum número de WhatsApp ativo no CRM');
    const primeiro = quem.nome.split(' ')[0];
    const onde = c.online ? (c.link ? `Link da chamada: ${c.link}` : 'É online: o link chega antes do horário.') : c.local ? `Local: ${c.local}` : '';
    const portal = quem.pessoaId ? `\nConfirme no portal: ${urlPublica()}/portal` : '';
    const textos = {
      marcado: `Oi, ${primeiro}! Marcamos: *${c.titulo}*\n📅 ${dia(c.inicio)}, às ${hora(c.inicio)}\n${onde}${portal}`,
      remarcado: `Oi, ${primeiro}! Mudamos o horário: *${c.titulo}*\n📅 agora ${dia(c.inicio)}, às ${hora(c.inicio)}\n${onde}${portal}`,
      cancelado: `Oi, ${primeiro}! O compromisso *${c.titulo}* de ${dia(c.inicio)}, às ${hora(c.inicio)}, foi cancelado. Qualquer dúvida, é só responder aqui.`,
      lembrete_dia: `Oi, ${primeiro}! Lembrete: *${c.titulo}* amanhã (${dia(c.inicio)}), às ${hora(c.inicio)}.\n${onde}${portal}`,
      lembrete_hora: `Oi, ${primeiro}! Daqui a pouco, às ${hora(c.inicio)}: *${c.titulo}*.\n${onde}`,
    };
    const contato = await this.crm.garantirContato({ telefone: quem.telefone, nome: quem.nome, pessoaId: quem.pessoaId });
    const cv = await this.canais.garantirConversa(contato.id, canalId, 'resolvida');
    await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto: textos[motivo].trim(), leadId: c.leadId ?? undefined });
  }

  /** Véspera (entre 2 h e 24 h antes) e uma hora antes. Cada lembrete sai uma vez só. */
  async enviarLembretes(agora = new Date()) {
    let enviados = 0;
    const ativos = and(eq(agendaCompromissos.avisar, true), inArray(agendaCompromissos.status, ['marcado', 'confirmado']));
    const emUmDia = await this.db.select().from(agendaCompromissos).where(and(ativos, isNull(agendaCompromissos.lembreteDiaEm), gt(agendaCompromissos.inicio, new Date(agora.getTime() + 2 * 3600_000)), lte(agendaCompromissos.inicio, new Date(agora.getTime() + 24 * 3600_000))));
    for (const c of emUmDia) {
      // Marcado com menos de 24 h de antecedência: o aviso de "marcado" já fez esse papel.
      if (c.criadoEm.getTime() > c.inicio.getTime() - 24 * 3600_000) {
        await this.db.update(agendaCompromissos).set({ lembreteDiaEm: agora }).where(eq(agendaCompromissos.id, c.id));
        continue;
      }
      const [trava] = await this.db.update(agendaCompromissos).set({ lembreteDiaEm: agora }).where(and(eq(agendaCompromissos.id, c.id), isNull(agendaCompromissos.lembreteDiaEm))).returning({ id: agendaCompromissos.id });
      if (!trava) continue;
      await this.avisar(c, 'lembrete_dia').then(() => enviados++).catch((e) => this.log.warn(`Lembrete de ${c.titulo}: ${(e as Error).message}`));
    }
    const emUmaHora = await this.db.select().from(agendaCompromissos).where(and(ativos, isNull(agendaCompromissos.lembreteHoraEm), gt(agendaCompromissos.inicio, agora), lte(agendaCompromissos.inicio, new Date(agora.getTime() + 70 * 60_000))));
    for (const c of emUmaHora) {
      const [trava] = await this.db.update(agendaCompromissos).set({ lembreteHoraEm: agora }).where(and(eq(agendaCompromissos.id, c.id), isNull(agendaCompromissos.lembreteHoraEm))).returning({ id: agendaCompromissos.id });
      if (!trava) continue;
      await this.avisar(c, 'lembrete_hora').then(() => enviados++).catch((e) => this.log.warn(`Lembrete de ${c.titulo}: ${(e as Error).message}`));
    }
    return { enviados };
  }

  /** Lista com nomes, para a tela e o portal. */
  async listar(filtro: { de: Date; ate: Date; responsavelId?: string; pessoaId?: string; leadId?: string; incluirCancelados?: boolean }) {
    return this.db
      .select({
        c: agendaCompromissos,
        responsavel: usuarios.nome,
        pessoa: pessoas.nome,
        contato: sql<string | null>`(select ct.nome from crm_leads l join crm_contatos ct on ct.id = l.contato_id where l.id = ${agendaCompromissos.leadId})`,
      })
      .from(agendaCompromissos)
      .leftJoin(usuarios, eq(usuarios.id, agendaCompromissos.responsavelId))
      .leftJoin(pessoas, eq(pessoas.id, agendaCompromissos.pessoaId))
      .where(
        and(
          gt(agendaCompromissos.fim, filtro.de),
          lt(agendaCompromissos.inicio, filtro.ate),
          filtro.incluirCancelados ? undefined : ne(agendaCompromissos.status, 'cancelado'),
          filtro.responsavelId ? eq(agendaCompromissos.responsavelId, filtro.responsavelId) : undefined,
          filtro.pessoaId ? eq(agendaCompromissos.pessoaId, filtro.pessoaId) : undefined,
          filtro.leadId ? eq(agendaCompromissos.leadId, filtro.leadId) : undefined,
        ),
      )
      .orderBy(asc(agendaCompromissos.inicio))
      .limit(500)
      .then((r) => r.map(({ c, responsavel, pessoa, contato }) => ({ ...c, responsavel, quem: pessoa ?? contato ?? c.convidadoNome })));
  }
}
