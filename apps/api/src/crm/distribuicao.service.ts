import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { candidaturas, crmCanais, crmContatos, crmDistribuicoes, crmEtapas, crmFunis, crmLeads, pessoas } from '../db/schema';
import { distanciaKm, localizar, type Ponto } from '../geo/geo';
import { CanaisService } from './canais.service';
import { CrmService } from './crm.service';

export type Distribuicao = typeof crmDistribuicoes.$inferSelect;
type Lead = typeof crmLeads.$inferSelect;

export interface Candidata {
  id: string;
  nome: string;
  cidade: string | null;
  uf: string | null;
  distanciaKm: number;
  abertos: number;
  telefone: string | null;
}

const CHAVES_CIDADE = /^(cidade|municipio|município|cidade onde mora|sua cidade)$/i;
const CHAVES_UF = /^(uf|estado)$/i;

/**
 * Leads distribuídos por localização: o lead novo do funil vai para a consultora (ou líder) ativa mais perto,
 * que recebe o aviso no WhatsApp e aceita no portal. Só depois de aceitar ela vê o telefone.
 * Sem aceite no prazo, passa para a próxima; esgotadas as tentativas, volta para a equipe.
 */
@Injectable()
export class DistribuicaoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Distribuição');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
  ) {}

  onModuleInit() {
    this.crm.ouvir(async (e) => {
      if (e.tipo !== 'lead_criado') return;
      const [l] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, e.leadId));
      if (!l || l.consultoraId || l.distribuicao) return;
      const cfg = await this.config(l.funilId);
      if (cfg?.ativo) await this.distribuir(l.id).catch((x) => this.log.warn(`Lead ${l.numero}: ${(x as Error).message}`));
    });
    if (process.env.CRM_AUTOMATICO === '0') return;
    this.timer = setInterval(() => void this.verificarPrazos().catch((x) => this.log.error((x as Error).message)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async config(funilId: string) {
    const [c] = await this.db.select().from(crmDistribuicoes).where(eq(crmDistribuicoes.funilId, funilId));
    return c ?? null;
  }

  /** Cidade do lead: a do card, a do contato, a da candidatura; sem nenhuma, a região do DDD. */
  async localDoLead(l: Lead): Promise<Ponto | null> {
    const [c] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, l.contatoId));
    const [cand] = l.candidaturaId ? await this.db.select({ cidade: candidaturas.cidade, uf: candidaturas.uf }).from(candidaturas).where(eq(candidaturas.id, l.candidaturaId)) : [];
    const [p] = l.pessoaId ? await this.db.select({ cidade: pessoas.cidade, uf: pessoas.uf }).from(pessoas).where(eq(pessoas.id, l.pessoaId)) : [];
    const campo = (re: RegExp) => {
      for (const extras of [l.camposExtras, c?.camposExtras ?? {}]) {
        const k = Object.keys(extras).find((x) => re.test(x.trim()));
        if (k && extras[k]?.trim()) return extras[k].trim();
      }
      return null;
    };
    return localizar({ cidade: campo(CHAVES_CIDADE) ?? cand?.cidade ?? p?.cidade, uf: campo(CHAVES_UF) ?? cand?.uf ?? p?.uf, telefone: c?.telefone });
  }

  /** Consultoras (ou líderes) que podem receber, da mais perto para a mais longe. */
  async candidatas(l: Lead, cfg: Pick<Distribuicao, 'destino' | 'raioKm' | 'maxAbertos' | 'soComMaleta'>, ponto: Ponto, opcoes: { ignorarLimites?: boolean } = {}): Promise<Candidata[]> {
    const r = await this.db.execute<{ id: string; nome: string; cidade: string | null; uf: string | null; telefone: string | null; abertos: number }>(sql`
      select p.id, p.nome, p.cidade, p.uf, p.telefone1 as telefone,
        (select count(*)::int from crm_leads x where x.consultora_id = p.id and x.status = 'aberto' and x.distribuicao in ('aguardando', 'aceito')) as abertos
      from pessoas p
      where p.tipo = 'representante' and p.status = 'ativo' and p.cidade is not null
        ${cfg.destino === 'lideres' ? sql`and (exists (select 1 from pessoas d where d.lider_id = p.id and d.status = 'ativo') or p.tipo_revendedor ilike '%l_der%')` : sql``}
        ${cfg.soComMaleta && !opcoes.ignorarLimites ? sql`and exists (select 1 from maletas m where m.representante_id = p.id and m.status = 'aberta')` : sql``}
        ${l.pessoaId ? sql`and p.id <> ${l.pessoaId}` : sql``}`);
    const ja = new Set(l.jaOferecido);
    return r.rows
      .map((p) => {
        const onde = localizar({ cidade: p.cidade, uf: p.uf, telefone: p.telefone });
        return onde?.origem === 'cidade' ? { ...p, distanciaKm: distanciaKm(ponto, onde) } : null;
      })
      .filter((p): p is Candidata => !!p)
      .filter((p) => opcoes.ignorarLimites || (p.distanciaKm <= cfg.raioKm && p.abertos < cfg.maxAbertos && !ja.has(p.id)))
      // Mais perto primeiro; empate (mesma cidade), quem tem menos leads em aberto.
      .sort((a, b) => a.distanciaKm - b.distanciaKm || a.abertos - b.abertos || a.nome.localeCompare(b.nome));
  }

  /**
   * Entrega o lead para a próxima consultora da fila (ou para a escolhida pela equipe).
   * Devolve quem recebeu, ou null se ninguém pode receber (o lead fica com a equipe).
   */
  async distribuir(leadId: string, opcoes: { pessoaId?: string; usuarioId?: string | null } = {}) {
    const [l] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, leadId));
    if (!l) throw new NotFoundException('Card não encontrado.');
    if (l.status !== 'aberto') throw new BadRequestException('Só cards em aberto são distribuídos.');
    const cfg = (await this.config(l.funilId)) ?? { destino: 'consultoras', raioKm: 50, maxAbertos: 10, soComMaleta: false, prazoMinutos: 60, maxTentativas: 3, avisarWhatsapp: true, canalId: null, ativo: false };
    const ponto = await this.localDoLead(l);
    let escolhida: Candidata | undefined;
    if (opcoes.pessoaId) {
      const [p] = await this.db.select().from(pessoas).where(and(eq(pessoas.id, opcoes.pessoaId), eq(pessoas.tipo, 'representante'), eq(pessoas.status, 'ativo')));
      if (!p) throw new BadRequestException('Representante não encontrada ou inativa.');
      const onde = localizar({ cidade: p.cidade, uf: p.uf, telefone: p.telefone1 });
      escolhida = { id: p.id, nome: p.nome, cidade: p.cidade, uf: p.uf, telefone: p.telefone1, abertos: 0, distanciaKm: ponto && onde ? distanciaKm(ponto, onde) : -1 };
    } else if (ponto) {
      escolhida = (await this.candidatas(l, cfg, ponto))[0];
    }
    if (!escolhida) {
      await this.db.update(crmLeads).set({ consultoraId: null, distribuicao: 'sem_consultora', atualizadoEm: new Date() }).where(eq(crmLeads.id, leadId));
      await this.crm.evento(leadId, 'sistema', ponto ? `Distribuição: nenhuma ${cfg.destino === 'lideres' ? 'líder' : 'consultora'} livre até ${cfg.raioKm} km de ${ponto.cidade}/${ponto.uf}. Fica com a equipe.` : 'Distribuição: não deu para saber a cidade do lead (sem cidade e sem DDD conhecido). Fica com a equipe.', opcoes.usuarioId);
      return null;
    }
    await this.db
      .update(crmLeads)
      .set({ consultoraId: escolhida.id, distribuicao: 'aguardando', distribuidoEm: new Date(), aceitoEm: null, distanciaKm: escolhida.distanciaKm >= 0 ? escolhida.distanciaKm : null, jaOferecido: [...new Set([...l.jaOferecido, escolhida.id])], atualizadoEm: new Date() })
      .where(eq(crmLeads.id, leadId));
    const longe = escolhida.distanciaKm >= 0 ? ` (${escolhida.distanciaKm.toLocaleString('pt-BR')} km${ponto?.origem === 'ddd' ? ', pela região do telefone' : ''})` : '';
    await this.crm.evento(leadId, 'sistema', `Distribuído para ${escolhida.nome}${escolhida.cidade ? ` de ${escolhida.cidade}` : ''}${longe}${opcoes.pessoaId ? ' pela equipe' : ''}. Prazo para aceitar: ${cfg.prazoMinutos} min.`, opcoes.usuarioId);
    if (cfg.avisarWhatsapp && escolhida.telefone) await this.avisar(l, escolhida, cfg as Distribuicao, ponto).catch((e) => this.crm.evento(leadId, 'sistema', `Aviso para ${escolhida!.nome} não foi enviado: ${(e as Error).message}`));
    return escolhida;
  }

  private async avisar(l: Lead, p: Candidata, cfg: Pick<Distribuicao, 'canalId' | 'prazoMinutos' | 'destino'>, ponto: Ponto | null) {
    const canalId = cfg.canalId ?? (await this.canalPadrao());
    if (!canalId) throw new Error('nenhum número de WhatsApp ativo no CRM');
    const [funil] = await this.db.select({ tipo: crmFunis.tipo }).from(crmFunis).where(eq(crmFunis.id, l.funilId));
    const oque = funil?.tipo === 'recrutamento' ? 'uma candidata a revendedora' : 'uma cliente';
    const base = (process.env.PAINEL_URL ?? '').replace(/\/$/, '');
    const texto = [
      `Oi, ${p.nome.split(' ')[0]}! Tem ${oque} ${ponto ? `de ${ponto.cidade}` : ''} esperando atendimento, perto de você.`.replace(/\s+/g, ' '),
      `Você tem ${cfg.prazoMinutos} minutos para aceitar no portal; depois passa para outra pessoa.`,
      base ? `${base}/portal/leads` : 'Abra o portal da representante, em "Clientes".',
    ].join('\n');
    const contato = await this.crm.garantirContato({ telefone: p.telefone!, nome: p.nome, pessoaId: p.id });
    const cv = await this.canais.garantirConversa(contato.id, canalId, 'resolvida');
    await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto });
  }

  /** Número para os avisos: um de QR code (não depende da janela de 24 h do oficial); senão o primeiro ativo. */
  private async canalPadrao() {
    const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(eq(crmCanais.ativo, true)).orderBy(asc(crmCanais.criadoEm));
    return (cs.find((c) => c.tipo !== 'oficial') ?? cs[0])?.id ?? null;
  }

  /** Prazo vencido sem aceite: passa para a próxima; sem mais tentativas, volta para a equipe. */
  async verificarPrazos() {
    const cfgs = await this.db.select().from(crmDistribuicoes);
    let movidos = 0;
    for (const cfg of cfgs) {
      const limite = new Date(Date.now() - cfg.prazoMinutos * 60_000);
      const vencidos = await this.db.select({ id: crmLeads.id, consultoraId: crmLeads.consultoraId }).from(crmLeads).where(and(eq(crmLeads.funilId, cfg.funilId), eq(crmLeads.status, 'aberto'), eq(crmLeads.distribuicao, 'aguardando'), lt(crmLeads.distribuidoEm, limite)));
      for (const v of vencidos) {
        // Tira dela numa tacada só: se ela aceitou neste meio-tempo, a linha não bate e o aceite vale.
        const [l] = await this.db
          .update(crmLeads)
          .set({ consultoraId: null, distribuicao: 'devolvido', atualizadoEm: new Date() })
          .where(and(eq(crmLeads.id, v.id), eq(crmLeads.distribuicao, 'aguardando'), lt(crmLeads.distribuidoEm, limite)))
          .returning();
        if (!l) continue;
        const [quem] = v.consultoraId ? await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, v.consultoraId)) : [];
        await this.crm.evento(l.id, 'sistema', `${quem?.nome ?? 'A consultora'} não aceitou em ${cfg.prazoMinutos} min.`);
        await this.proxima(l, cfg).catch((e) => this.log.warn(`Lead ${l.numero}: ${(e as Error).message}`));
        movidos++;
      }
    }
    return { movidos };
  }

  /** Depois de recusa ou prazo vencido. */
  async proxima(l: Lead, cfg: Distribuicao | null) {
    const tentativas = l.jaOferecido.length;
    if (!cfg?.ativo || tentativas >= (cfg?.maxTentativas ?? 3)) {
      await this.db.update(crmLeads).set({ consultoraId: null, distribuicao: 'devolvido', atualizadoEm: new Date() }).where(eq(crmLeads.id, l.id));
      await this.crm.evento(l.id, 'sistema', `Distribuição encerrada depois de ${tentativas} tentativa(s): o card volta para a equipe.`);
      await this.crm.adicionarEtiqueta(l.id, 'Sem consultora');
      return null;
    }
    const r = await this.distribuir(l.id);
    if (!r) await this.crm.adicionarEtiqueta(l.id, 'Sem consultora');
    return r;
  }

  /** Consultoras ativas que nunca recebem porque a cidade do cadastro está vazia ou não foi reconhecida. */
  async semCidade() {
    const r = await this.db.select({ id: pessoas.id, nome: pessoas.nome, cidade: pessoas.cidade, uf: pessoas.uf }).from(pessoas).where(and(eq(pessoas.tipo, 'representante'), eq(pessoas.status, 'ativo')));
    return r.filter((p) => localizar({ cidade: p.cidade, uf: p.uf })?.origem !== 'cidade');
  }

  /** A equipe tira o lead da consultora. */
  async devolver(leadId: string, usuarioId: string) {
    const [l] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, leadId));
    if (!l) throw new NotFoundException('Card não encontrado.');
    if (!l.consultoraId) throw new BadRequestException('Este card não está com nenhuma consultora.');
    const [p] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, l.consultoraId));
    await this.db.update(crmLeads).set({ consultoraId: null, distribuicao: 'devolvido', atualizadoEm: new Date() }).where(eq(crmLeads.id, leadId));
    await this.crm.evento(leadId, 'sistema', `Tirado de ${p?.nome ?? 'consultora'} e devolvido para a equipe.`, usuarioId);
    return { ok: true };
  }

  // ───── Ações da consultora (portal) ─────

  async daConsultora(leadId: string, pessoaId: string) {
    const [l] = await this.db.select().from(crmLeads).where(and(eq(crmLeads.id, leadId), eq(crmLeads.consultoraId, pessoaId)));
    if (!l) throw new NotFoundException('Cliente não encontrada.');
    return l;
  }

  async aceitar(leadId: string, pessoaId: string) {
    const l = await this.daConsultora(leadId, pessoaId);
    if (l.distribuicao !== 'aguardando') throw new BadRequestException(l.distribuicao === 'aceito' ? 'Você já aceitou.' : 'Este contato não está mais disponível.');
    const cfg = await this.config(l.funilId);
    if (cfg && l.distribuidoEm && Date.now() - l.distribuidoEm.getTime() > cfg.prazoMinutos * 60_000 + 30_000) throw new BadRequestException('O prazo para aceitar acabou e o contato passou para outra pessoa.');
    const [r] = await this.db.update(crmLeads).set({ distribuicao: 'aceito', aceitoEm: new Date(), atualizadoEm: new Date() }).where(and(eq(crmLeads.id, leadId), eq(crmLeads.distribuicao, 'aguardando'))).returning();
    if (!r) throw new BadRequestException('Este contato não está mais disponível.');
    const [p] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, pessoaId));
    await this.crm.evento(leadId, 'sistema', `${p?.nome ?? 'A consultora'} aceitou o atendimento.`);
    return r;
  }

  async recusar(leadId: string, pessoaId: string, motivo?: string | null) {
    const l = await this.daConsultora(leadId, pessoaId);
    if (!['aguardando', 'aceito'].includes(l.distribuicao ?? '')) throw new BadRequestException('Este contato não está mais com você.');
    const [p] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, pessoaId));
    await this.crm.evento(leadId, 'sistema', `${p?.nome ?? 'A consultora'} ${l.distribuicao === 'aceito' ? 'devolveu' : 'recusou'}${motivo ? `: ${motivo}` : '.'}`);
    return this.proxima(l, await this.config(l.funilId));
  }

  /** Resultado do atendimento: deu certo ou não. No recrutamento, quem aprova continua sendo a matriz. */
  async resultado(leadId: string, pessoaId: string, deuCerto: boolean, motivo?: string | null) {
    const l = await this.daConsultora(leadId, pessoaId);
    if (l.distribuicao !== 'aceito') throw new BadRequestException('Aceite o contato antes de informar o resultado.');
    const [funil] = await this.db.select({ tipo: crmFunis.tipo }).from(crmFunis).where(eq(crmFunis.id, l.funilId));
    const [p] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, pessoaId));
    const quem = p?.nome ?? 'A consultora';
    if (funil?.tipo === 'recrutamento') {
      await this.crm.evento(leadId, 'sistema', `${quem}: ${deuCerto ? 'conversou e recomenda a candidata' : 'a candidata não seguiu'}${motivo ? ` (${motivo})` : ''}.`);
      await this.crm.adicionarEtiqueta(leadId, deuCerto ? 'Líder recomenda' : 'Líder não recomenda');
      return { ok: true };
    }
    const etapas = await this.db.select().from(crmEtapas).where(eq(crmEtapas.funilId, l.funilId)).orderBy(asc(crmEtapas.ordem));
    // Funil de clientes: "Comprou" (fica aberto para o pós-venda e a recompra); nos outros, a etapa de ganho.
    const alvo = deuCerto ? (etapas.find((e) => e.chave === 'comprou') ?? etapas.find((e) => e.tipo === 'ganho')) : etapas.find((e) => e.tipo === 'perdido');
    await this.db.update(crmLeads).set({ distribuicao: 'concluido', atualizadoEm: new Date() }).where(eq(crmLeads.id, leadId));
    if (alvo) await this.crm.moverLead(leadId, alvo.id, { motivo: deuCerto ? null : `${quem}: ${motivo || 'não deu certo'}`, origem: 'automatico' });
    else await this.crm.evento(leadId, 'sistema', `${quem}: ${deuCerto ? 'vendeu' : `não deu certo${motivo ? ` (${motivo})` : ''}`}.`);
    return { ok: true };
  }
}
