import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { dentroDaJanela, proximaAbertura } from './fila-envio.service';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { configuracoes, crmCanais, crmContatos, crmConversas, crmDisparoDestinos, crmDisparos, crmEtapas, crmFila, crmGatilhos, crmLeads, crmTarefas, crmTemplates, pessoas, usuarios } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { VendasService } from '../vendas/vendas.service';
import { CanaisService } from './canais.service';
import { TarefasMensagemService } from './tarefas-mensagem.service';
import { CrmService, type EventoCrm } from './crm.service';
import { normalizarTelefone } from './telefone';

type Acao = Record<string, unknown> & { tipo: string };
const arr = (xs: string[], tipo = 'uuid') => sql`array[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::${sql.raw(tipo)}[]`;
const ETAPAS_AUTO_REVENDEDORAS = ['nova', 'ativa', 'acerto_proximo', 'atrasada', 'parada', 'inativa'];
const MAX_ACOES_POR_VEZ = 15;

/**
 * Tudo o que o CRM faz sozinho:
 * - gatilhos (quando acontece X → ações, com esperas);
 * - disparos em massa, no ritmo combinado;
 * - funis automáticos: revendedoras andam conforme as maletas; vendas da loja movem a cliente.
 */
@Injectable()
export class AutomacaoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Automação CRM');
  private timer: NodeJS.Timeout | null = null;
  private ultimoSemResposta = 0;
  readonly intervaloMs = Number(process.env.CRM_INTERVALO_MS ?? 15_000);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
    private readonly vendas: VendasService,
    private readonly tarefasMensagem: TarefasMensagemService,
  ) {}

  onModuleInit() {
    this.crm.ouvir((e) => this.aoEvento(e));
    this.vendas.aoVender((v) => this.registrarVenda(v));
    if (process.env.CRM_AUTOMATICO === '0') return;
    this.timer = setInterval(() => void this.ciclo(), this.intervaloMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Uma volta do motor (também chamada pelo botão "processar agora" e pelos testes). */
  async ciclo(): Promise<void> {
    // Já rodando: espera a volta atual terminar (quem chamou quer o resultado).
    if (this.emAndamento) return this.emAndamento;
    this.emAndamento = this.umaVolta().finally(() => {
      this.emAndamento = null;
    });
    return this.emAndamento;
  }

  private emAndamento: Promise<void> | null = null;

  private async umaVolta() {
    try {
      await this.processarFila();
      await this.processarDisparos();
      await this.tarefasMensagem.processar();
      if (Date.now() - this.ultimoSemResposta > 5 * 60_000) {
        this.ultimoSemResposta = Date.now();
        await this.verificarSemResposta();
      }
      await this.sincronizacaoDiaria();
    } catch (e) {
      this.log.error(`Ciclo falhou: ${(e as Error).message}`);
    }
  }

  // ───────────── Gatilhos ─────────────

  private async aoEvento(e: EventoCrm) {
    if (e.tipo === 'conversa_entrada') return; // é do agente de IA, não dos gatilhos
    const [lead] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, e.leadId));
    if (!lead) return;
    const gatilhos = await this.db.select().from(crmGatilhos).where(and(eq(crmGatilhos.ativo, true), eq(crmGatilhos.evento, e.tipo)));
    for (const g of gatilhos) {
      if (g.funilId && g.funilId !== lead.funilId) continue;
      if (e.tipo === 'entrou_etapa' && g.etapaId && g.etapaId !== e.etapaId) continue;
      if (e.tipo === 'mensagem_recebida' && g.parametro?.trim() && !e.texto.toLowerCase().includes(g.parametro.trim().toLowerCase())) continue;
      if (e.tipo === 'etiqueta_adicionada' && g.parametro?.trim() && g.parametro.trim().toLowerCase() !== e.etiqueta.toLowerCase()) continue;
      // Proteção contra laço (um gatilho que move para uma etapa que dispara ele mesmo).
      const [recente] = await this.db
        .select({ id: crmFila.id })
        .from(crmFila)
        .where(and(eq(crmFila.gatilhoId, g.id), eq(crmFila.leadId, lead.id), sql`${crmFila.criadoEm} > now() - interval '1 minute'`))
        .limit(1);
      if (recente) continue;
      await this.db.insert(crmFila).values({ gatilhoId: g.id, leadId: lead.id, etapaId: lead.etapaId });
    }
    await this.processarFila();
  }

  async processarFila() {
    const pendentes = await this.db
      .select()
      .from(crmFila)
      .where(and(eq(crmFila.status, 'pendente'), lte(crmFila.executarEm, new Date())))
      .orderBy(asc(crmFila.executarEm))
      .limit(100);
    for (const f of pendentes) {
      // Marca como em execução para outra volta do motor não pegar o mesmo item.
      const [meu] = await this.db.update(crmFila).set({ status: 'executando' }).where(and(eq(crmFila.id, f.id), eq(crmFila.status, 'pendente'))).returning();
      if (!meu) continue;
      try {
        const r = await this.executar(f);
        await this.db.update(crmFila).set(r).where(eq(crmFila.id, f.id));
      } catch (e) {
        await this.db.update(crmFila).set({ status: 'erro', erro: (e as Error).message.slice(0, 500) }).where(eq(crmFila.id, f.id));
        await this.crm.evento(f.leadId, 'gatilho', `Gatilho com erro: ${(e as Error).message}`).catch(() => undefined);
      }
    }
  }

  private async executar(f: typeof crmFila.$inferSelect): Promise<Partial<typeof crmFila.$inferInsert>> {
    const [g] = await this.db.select().from(crmGatilhos).where(eq(crmGatilhos.id, f.gatilhoId));
    const [lead] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, f.leadId));
    if (!g || !lead) return { status: 'cancelado', erro: 'gatilho ou card removido' };
    if (!g.ativo) return { status: 'cancelado', erro: 'gatilho desligado' };
    // Gatilho de etapa: se o card saiu da etapa durante a espera, para.
    if (g.evento === 'entrou_etapa' && f.etapaId && lead.etapaId !== f.etapaId && f.passo > 0) return { status: 'cancelado', erro: 'o card saiu da etapa' };
    const acoes = g.acoes as Acao[];
    let passo = f.passo;
    for (let n = 0; passo < acoes.length && n < MAX_ACOES_POR_VEZ; n++, passo++) {
      const a = acoes[passo];
      if (a.tipo === 'esperar') {
        const minutos = Math.max(1, Number(a.minutos ?? 60));
        return { passo: passo + 1, executarEm: new Date(Date.now() + minutos * 60_000), status: 'pendente' };
      }
      await this.acao(g, lead.id, a);
    }
    if (passo === 0 || f.passo === 0) await this.db.update(crmGatilhos).set({ execucoes: sql`${crmGatilhos.execucoes} + 1` }).where(eq(crmGatilhos.id, g.id));
    return { passo, status: passo >= acoes.length ? 'feito' : 'pendente', executarEm: new Date() };
  }

  private async acao(g: typeof crmGatilhos.$inferSelect, leadId: string, a: Acao) {
    const [lead] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, leadId));
    const nota = (t: string) => this.crm.evento(leadId, 'gatilho', `${g.nome}: ${t}`);
    switch (a.tipo) {
      case 'enviar_template':
      case 'enviar_mensagem': {
        const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, lead.contatoId));
        if (contato.descadastrado && a.tipo === 'enviar_template' && a.respeitarDescadastro !== false) return nota('mensagem não enviada (contato pediu para não receber).');
        const tpl = a.tipo === 'enviar_template' ? (await this.db.select().from(crmTemplates).where(eq(crmTemplates.id, String(a.templateId ?? ''))))[0] : null;
        if (a.tipo === 'enviar_template' && !tpl) throw new Error('template não encontrado');
        const canalId = tpl?.tipo === 'meta' ? tpl.canalId! : await this.canalPara(lead.contatoId, a.canalId as string | undefined);
        const cv = await this.canais.garantirConversa(lead.contatoId, canalId, 'resolvida');
        await this.canais.enviar({ conversaId: cv.id, tipo: tpl ? 'template' : 'texto', templateId: tpl?.id, texto: tpl ? null : String(a.texto ?? ''), gatilhoId: g.id, leadId });
        return nota(tpl ? `template "${tpl.nome}" enviado.` : 'mensagem enviada.');
      }
      case 'mover_etapa':
        await this.crm.moverLead(leadId, String(a.etapaId), { origem: 'gatilho', motivo: a.motivo ? String(a.motivo) : null });
        return;
      case 'atribuir': {
        const lista = ((a.usuarios as string[]) ?? []).filter(Boolean);
        if (!lista.length) return;
        // Rodízio: quem tem menos cards abertos naquele funil.
        const cargas = await this.db
          .select({ id: crmLeads.responsavelId, n: sql<number>`count(*)::int` })
          .from(crmLeads)
          .where(and(eq(crmLeads.funilId, lead.funilId), eq(crmLeads.status, 'aberto'), inArray(crmLeads.responsavelId, lista)))
          .groupBy(crmLeads.responsavelId);
        const carga = new Map(cargas.map((c) => [c.id, c.n]));
        const escolhido = [...lista].sort((x, y) => (carga.get(x) ?? 0) - (carga.get(y) ?? 0))[0];
        await this.db.update(crmLeads).set({ responsavelId: escolhido, atualizadoEm: new Date() }).where(eq(crmLeads.id, leadId));
        if (a.conversa !== false) {
          await this.db
            .update(crmConversas)
            .set({ atendenteId: escolhido, status: 'atendimento', pegaEm: new Date() })
            .where(and(eq(crmConversas.contatoId, lead.contatoId), eq(crmConversas.status, 'fila')));
        }
        const [u] = await this.db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, escolhido));
        return nota(`responsável: ${u?.nome ?? '?'}.`);
      }
      case 'adicionar_etiqueta':
        await this.crm.adicionarEtiqueta(leadId, String(a.etiqueta ?? ''));
        return;
      case 'criar_tarefa': {
        const horas = Math.max(0, Number(a.horas ?? 24));
        await this.db.insert(crmTarefas).values({ leadId, titulo: String(a.titulo ?? 'Retornar contato').slice(0, 200), venceEm: new Date(Date.now() + horas * 3600_000), responsavelId: lead.responsavelId });
        return nota(`tarefa "${a.titulo ?? 'Retornar contato'}" criada.`);
      }
      default:
        throw new Error(`ação desconhecida: ${a.tipo}`);
    }
  }

  /** Número para falar com o contato: o da última conversa; senão o escolhido; senão o primeiro número ativo (oficial antes). */
  async canalPara(contatoId: string, preferido?: string) {
    if (preferido) return preferido;
    const [ultima] = await this.db
      .select({ canalId: crmConversas.canalId })
      .from(crmConversas)
      .innerJoin(crmCanais, eq(crmCanais.id, crmConversas.canalId))
      .where(and(eq(crmConversas.contatoId, contatoId), eq(crmCanais.ativo, true)))
      .orderBy(desc(crmConversas.ultimaMensagemEm))
      .limit(1);
    if (ultima) return ultima.canalId;
    const [padrao] = await this.db.select().from(crmCanais).where(eq(crmCanais.ativo, true)).orderBy(desc(sql`${crmCanais.tipo} = 'oficial'`), asc(crmCanais.criadoEm)).limit(1);
    if (!padrao) throw new Error('nenhum número de WhatsApp ativo');
    return padrao.id;
  }

  /** "Sem resposta há X horas": nossa última mensagem ficou sem retorno do contato. */
  async verificarSemResposta() {
    const gs = await this.db.select().from(crmGatilhos).where(and(eq(crmGatilhos.ativo, true), eq(crmGatilhos.evento, 'sem_resposta')));
    for (const g of gs) {
      const horas = Math.max(1, Number(g.parametro ?? 24));
      const r = await this.db.execute<{ lead_id: string; etapa_id: string }>(sql`
        select l.id as lead_id, l.etapa_id
        from crm_leads l
        join lateral (
          select m.direcao, m.criado_em from crm_mensagens m join crm_conversas c on c.id = m.conversa_id
          where c.contato_id = l.contato_id order by m.criado_em desc limit 1
        ) ult on true
        where l.status = 'aberto'
          ${g.funilId ? sql`and l.funil_id = ${g.funilId}` : sql``}
          ${g.etapaId ? sql`and l.etapa_id = ${g.etapaId}` : sql``}
          and ult.direcao = 'saida' and ult.criado_em < now() - make_interval(hours => ${horas})
          and not exists (select 1 from crm_fila f where f.gatilho_id = ${g.id} and f.lead_id = l.id and f.criado_em > ult.criado_em)
        limit 200`);
      for (const x of r.rows) await this.db.insert(crmFila).values({ gatilhoId: g.id, leadId: x.lead_id, etapaId: x.etapa_id });
    }
    if (gs.length) await this.processarFila();
  }

  // ───────────── Disparos em massa ─────────────

  /** Monta a lista de quem recebe (sem repetir contato, sem descadastrados). */
  async prepararDisparo(id: string) {
    const [d] = await this.db.select().from(crmDisparos).where(eq(crmDisparos.id, id));
    if (!d) throw new NotFoundException('Disparo não encontrado.');
    // Lista anexada: os destinos já foram gravados na criação (com as colunas da planilha).
    if (d.origem === 'lista') {
      const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(crmDisparoDestinos).where(eq(crmDisparoDestinos.disparoId, id));
      await this.db.update(crmDisparos).set({ total: n }).where(eq(crmDisparos.id, id));
      return n;
    }
    const f = d.filtro as { funilId?: string; etapaIds?: string[]; etiquetas?: string[]; status?: string; contatoIds?: string[] };
    const r = await this.db.execute<{ contato_id: string; lead_id: string | null }>(sql`
      select distinct on (c.id) c.id as contato_id, l.id as lead_id
      from crm_contatos c
      ${f.contatoIds?.length ? sql`left join crm_leads l on l.contato_id = c.id` : sql`join crm_leads l on l.contato_id = c.id`}
      where not c.descadastrado
        ${f.contatoIds?.length ? sql`and c.id = any(${arr(f.contatoIds)})` : sql``}
        ${f.funilId ? sql`and l.funil_id = ${f.funilId}` : sql``}
        ${f.etapaIds?.length ? sql`and l.etapa_id = any(${arr(f.etapaIds)})` : sql``}
        ${f.status ? sql`and l.status = ${f.status}` : sql``}
        ${f.etiquetas?.length ? sql`and (l.etiquetas ?| ${arr(f.etiquetas, 'text')} or c.etiquetas ?| ${arr(f.etiquetas, 'text')})` : sql``}
      order by c.id, l.atualizado_em desc nulls last`);
    await this.db.delete(crmDisparoDestinos).where(and(eq(crmDisparoDestinos.disparoId, id), eq(crmDisparoDestinos.status, 'pendente')));
    for (let i = 0; i < r.rows.length; i += 500) {
      const lote = r.rows.slice(i, i + 500).map((x) => ({ disparoId: id, contatoId: x.contato_id, leadId: x.lead_id }));
      if (lote.length) await this.db.insert(crmDisparoDestinos).values(lote).onConflictDoNothing();
    }
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(crmDisparoDestinos).where(eq(crmDisparoDestinos.disparoId, id));
    await this.db.update(crmDisparos).set({ total: n }).where(eq(crmDisparos.id, id));
    return n;
  }

  async processarDisparos() {
    const agora = new Date();
    for (const d of await this.db.select().from(crmDisparos).where(and(eq(crmDisparos.status, 'agendado'), lte(crmDisparos.agendadoPara, agora)))) {
      await this.prepararDisparo(d.id);
      await this.db.update(crmDisparos).set({ status: 'enviando' }).where(eq(crmDisparos.id, d.id));
    }
    for (const d of await this.db.select().from(crmDisparos).where(eq(crmDisparos.status, 'enviando'))) {
      // Ritmo detalhado: uma por vez, no intervalo aleatório, no horário/dias, com limite diário e lotes.
      let cota = Math.max(1, Math.round((d.ritmo * this.intervaloMs) / 60_000));
      if (d.envio) {
        const e = d.envio;
        const janela = { envioInicio: e.inicio, envioFim: e.fim, envioDias: e.dias, envioIntervaloMinS: e.intervaloMinS, envioIntervaloMaxS: e.intervaloMaxS };
        if (d.proximoEm && d.proximoEm > agora) continue;
        if (!dentroDaJanela(janela, agora)) {
          await this.db.update(crmDisparos).set({ proximoEm: proximaAbertura(janela, agora) ?? new Date(agora.getTime() + 3600_000) }).where(eq(crmDisparos.id, d.id));
          continue;
        }
        const hojeBR = new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
        if (d.hojeData !== hojeBR) {
          d.hojeEnviados = 0;
          await this.db.update(crmDisparos).set({ hojeData: hojeBR, hojeEnviados: 0 }).where(eq(crmDisparos.id, d.id));
        }
        if (e.limiteDiario && d.hojeEnviados >= e.limiteDiario) {
          // Bateu o limite do dia: volta na abertura de amanhã.
          const amanha = new Date(Date.UTC(Number(hojeBR.slice(0, 4)), Number(hojeBR.slice(5, 7)) - 1, Number(hojeBR.slice(8, 10)) + 1, 3, 0));
          await this.db.update(crmDisparos).set({ proximoEm: proximaAbertura(janela, amanha) ?? amanha }).where(eq(crmDisparos.id, d.id));
          continue;
        }
        cota = 1;
      }
      const lote = await this.db.select().from(crmDisparoDestinos).where(and(eq(crmDisparoDestinos.disparoId, d.id), eq(crmDisparoDestinos.status, 'pendente'))).limit(cota);
      if (!lote.length) {
        await this.db.update(crmDisparos).set({ status: 'concluido', concluidoEm: new Date() }).where(eq(crmDisparos.id, d.id));
        continue;
      }
      for (const dest of lote) {
        // Pausado ou cancelado no meio: para.
        const [atual] = await this.db.select({ status: crmDisparos.status }).from(crmDisparos).where(eq(crmDisparos.id, d.id));
        if (atual.status !== 'enviando') break;
        const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, dest.contatoId));
        if (!contato || contato.descadastrado) {
          await this.db.update(crmDisparoDestinos).set({ status: 'pulado', erro: 'pediu para não receber' }).where(eq(crmDisparoDestinos.id, dest.id));
          continue;
        }
        try {
          const cv = await this.canais.garantirConversa(contato.id, d.canalId, 'resolvida');
          // Colunas da planilha: {{coluna}} vira o valor desta linha (o resto o envio já preenche).
          const vars = dest.variaveis ?? {};
          const texto = d.texto && Object.keys(vars).length ? d.texto.replace(/\{\{\s*([\p{L}\w]+)\s*\}\}/gu, (t, k: string) => vars[k.toLowerCase()] ?? t) : d.texto;
          const m = await this.canais.enviar({ conversaId: cv.id, tipo: d.templateId ? 'template' : 'texto', templateId: d.templateId, texto, disparoId: d.id, leadId: dest.leadId });
          await this.db.update(crmDisparoDestinos).set({ status: 'enviada', mensagemId: m.id, enviadoEm: new Date() }).where(eq(crmDisparoDestinos.id, dest.id));
          await this.db.update(crmDisparos).set({ enviados: sql`${crmDisparos.enviados} + 1` }).where(eq(crmDisparos.id, d.id));
          // Quando ela responder, o agente de IA atende (o especialista escolhido, ou a recepção escolhe).
          if (d.iaAtivar) await this.db.update(crmConversas).set({ iaAtiva: true, iaAgenteId: d.iaAgenteId ?? null, iaRespostas: 0 }).where(eq(crmConversas.id, cv.id));
          if (d.envio) {
            const e = d.envio;
            const lote = (d.loteEnviados ?? 0) + 1;
            const pausaLote = e.loteTamanho && lote >= e.loteTamanho;
            const espera = (e.intervaloMinS + Math.random() * Math.max(0, e.intervaloMaxS - e.intervaloMinS)) * 1000 + (pausaLote ? (e.lotePausaMin ?? 0) * 60_000 : 0);
            await this.db.update(crmDisparos).set({ hojeEnviados: sql`${crmDisparos.hojeEnviados} + 1`, loteEnviados: pausaLote ? 0 : lote, proximoEm: new Date(Date.now() + espera) }).where(eq(crmDisparos.id, d.id));
          }
        } catch (e) {
          const msg = (e as Error).message;
          const janela = /janela de 24h/i.test(msg);
          await this.db.update(crmDisparoDestinos).set({ status: janela ? 'pulado' : 'falhou', erro: msg.slice(0, 300) }).where(eq(crmDisparoDestinos.id, dest.id));
          await this.db.update(crmDisparos).set({ falhas: sql`${crmDisparos.falhas} + 1` }).where(eq(crmDisparos.id, d.id));
        }
      }
      const [resta] = await this.db.select({ id: crmDisparoDestinos.id }).from(crmDisparoDestinos).where(and(eq(crmDisparoDestinos.disparoId, d.id), eq(crmDisparoDestinos.status, 'pendente'))).limit(1);
      if (!resta) await this.db.update(crmDisparos).set({ status: 'concluido', concluidoEm: new Date() }).where(and(eq(crmDisparos.id, d.id), eq(crmDisparos.status, 'enviando')));
    }
  }

  // ───────────── Funis automáticos ─────────────

  private async sincronizacaoDiaria() {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, 'crm_sincronizacao'));
    const dia = hoje();
    if ((c?.valor as { dia?: string } | undefined)?.dia === dia) return;
    const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
    if (hora < 6) return;
    await this.db.insert(configuracoes).values({ chave: 'crm_sincronizacao', valor: { dia } }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: { dia }, atualizadoEm: new Date() } });
    await this.sincronizarRevendedoras();
  }

  /** Cada revendedora num card do funil de relacionamento, na etapa que as maletas dela indicam. */
  async sincronizarRevendedoras() {
    const funil = await this.crm.etapaAuto('revendedoras', 'ativa');
    if (!funil) return { criados: 0, movidos: 0 };
    const etapas = await this.db.select().from(crmEtapas).where(eq(crmEtapas.funilId, funil.funilId));
    const porChave = new Map(etapas.filter((e) => e.chave).map((e) => [e.chave!, e]));
    const dia = hoje();
    const em7 = somarDias(dia, 7);
    const r = await this.db.execute<{ id: string; nome: string; telefone1: string | null; email: string | null; status: string; criado_em: string; limite: string | null; teve: boolean }>(sql`
      select p.id, p.nome, p.telefone1, p.email, p.status::text, p.criado_em,
        (select min(m.data_limite)::text from maletas m where m.representante_id = p.id and m.status = 'aberta') as limite,
        exists (select 1 from maletas m where m.representante_id = p.id) as teve
      from pessoas p where p.tipo = 'representante'`);
    let criados = 0;
    let movidos = 0;
    for (const p of r.rows) {
      const tel = normalizarTelefone(p.telefone1);
      if (!tel) continue;
      const chave =
        p.status !== 'ativo' ? 'inativa' : p.limite && p.limite < dia ? 'atrasada' : p.limite && p.limite <= em7 ? 'acerto_proximo' : p.limite ? 'ativa' : !p.teve && Date.now() - new Date(p.criado_em).getTime() < 30 * 86400_000 ? 'nova' : 'parada';
      const alvo = porChave.get(chave);
      if (!alvo) continue;
      const [lead] = await this.db.select().from(crmLeads).where(and(eq(crmLeads.funilId, funil.funilId), eq(crmLeads.pessoaId, p.id))).orderBy(desc(crmLeads.criadoEm)).limit(1);
      if (!lead) {
        const contato = await this.crm.garantirContato({ telefone: tel, nome: p.nome, email: p.email, pessoaId: p.id });
        await this.crm.criarLead({ funilId: funil.funilId, etapaId: alvo.id, contatoId: contato.id, titulo: p.nome, pessoaId: p.id, origem: { utm_source: 'sistema' } });
        criados++;
        continue;
      }
      if (lead.etapaId === alvo.id) continue;
      // Card movido pela equipe para uma etapa própria: não mexe.
      const atual = etapas.find((e) => e.id === lead.etapaId);
      if (!atual?.chave || !ETAPAS_AUTO_REVENDEDORAS.includes(atual.chave)) continue;
      await this.crm.moverLead(lead.id, alvo.id, { origem: 'automatico' });
      movidos++;
    }
    return { criados, movidos };
  }

  /** Venda na loja com a cliente identificada: card no funil de clientes, em "Comprou". */
  async registrarVenda(v: { id: string; clienteId: string | null; total: number; numero: number }) {
    if (!v.clienteId) return;
    const [cli] = await this.db.select().from(pessoas).where(eq(pessoas.id, v.clienteId));
    const tel = normalizarTelefone(cli?.telefone1);
    const alvo = await this.crm.etapaAuto('clientes', 'comprou');
    if (!cli || !tel || !alvo) return;
    const contato = await this.crm.garantirContato({ telefone: tel, nome: cli.nome, email: cli.email, pessoaId: cli.id });
    const texto = `Comprou na loja: venda nº ${v.numero}, R$ ${(v.total / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`;
    const aberto = await this.crm.leadAberto(contato.id, alvo.funilId);
    if (!aberto) {
      const l = await this.crm.criarLead({ funilId: alvo.funilId, etapaId: alvo.etapaId, contatoId: contato.id, titulo: cli.nome, valor: v.total, pessoaId: cli.id, origem: { utm_source: 'loja' } });
      await this.crm.evento(l.id, 'sistema', texto);
      return;
    }
    await this.db.update(crmLeads).set({ valor: sql`${crmLeads.valor} + ${v.total}`, atualizadoEm: new Date() }).where(eq(crmLeads.id, aberto.id));
    await this.crm.evento(aberto.id, 'sistema', texto);
    if (aberto.etapaId !== alvo.etapaId) await this.crm.moverLead(aberto.id, alvo.etapaId, { origem: 'automatico' });
  }

  async iniciarDisparo(id: string, quando?: Date | null) {
    const [d] = await this.db.select().from(crmDisparos).where(eq(crmDisparos.id, id));
    if (!d) throw new NotFoundException('Disparo não encontrado.');
    if (!['rascunho', 'pausado', 'agendado'].includes(d.status)) throw new BadRequestException('Este disparo já foi enviado ou cancelado.');
    if (quando && quando.getTime() > Date.now()) {
      await this.db.update(crmDisparos).set({ status: 'agendado', agendadoPara: quando }).where(eq(crmDisparos.id, id));
      return { status: 'agendado' };
    }
    if (d.status !== 'pausado') await this.prepararDisparo(id);
    await this.db.update(crmDisparos).set({ status: 'enviando', agendadoPara: null }).where(eq(crmDisparos.id, id));
    return { status: 'enviando' };
  }

  /** Tarefas abertas: do usuário (ou de todos, para a gestão). */
  async tarefas(usuarioId: string | null) {
    return this.db.execute(sql`
      select t.id, t.titulo, t.vence_em, t.lead_id, l.titulo as lead, u.nome as responsavel, t.mensagem_tipo, t.envio, t.mensagem_status, t.mensagem_erro
      from crm_tarefas t join crm_leads l on l.id = t.lead_id left join usuarios u on u.id = t.responsavel_id
      where t.feita_em is null ${usuarioId ? sql`and (t.responsavel_id = ${usuarioId} or t.responsavel_id is null)` : sql``}
      order by t.vence_em limit 200`);
  }

}
