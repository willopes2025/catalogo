import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { SegredosService } from '../segredos/segredos.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { crmCanais, crmContatos, crmConversas, crmDisparoDestinos, crmMensagens, crmTemplates } from '../db/schema';
import { CrmService } from './crm.service';
import { PEDIU_SAIR, preencherTexto, primeiroNome } from './telefone';
import { ConexaoOficial } from './whatsapp/oficial';
import { ConexaoZapi } from './whatsapp/zapi';
import { ErroCanal, type Conexao, type MensagemEntrada, type MensagemSaida, type StatusEntrada } from './whatsapp/tipos';

type Canal = typeof crmCanais.$inferSelect;
/** Campos das credenciais que ficam cifrados. */
const SECRETOS = ['token', 'appSecret', 'clientToken'];
const ORDEM_STATUS: Record<string, number> = { pendente: 0, falhou: 0, enviada: 1, entregue: 2, lida: 3 };
const JANELA_MS = 24 * 3600_000;

export interface EnvioCrm {
  conversaId: string;
  tipo: MensagemSaida['tipo'];
  texto?: string | null;
  templateId?: string | null;
  midia?: { conteudo: Buffer; mime: string; nome: string } | null;
  usuarioId?: string | null;
  gatilhoId?: string | null;
  disparoId?: string | null;
  /** Lead para preencher {{nome}}, {{etapa}}… */
  leadId?: string | null;
}

/**
 * Números de WhatsApp do CRM (vários, oficiais e por QR code), envio, recebimento e a fila de atendimento:
 * conversa nova cai na fila do número; um atendente pega; ao resolver, a próxima mensagem do contato volta para a fila.
 */
@Injectable()
export class CanaisService {
  private readonly log = new Logger('WhatsApp');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly segredos: SegredosService,
    private readonly arquivos: ArquivosService,
    private readonly crm: CrmService,
  ) {}

  // ───────────── Cadastro dos números ─────────────

  private cifrarConfig(config: Record<string, string>, anterior: Record<string, string> = {}) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) {
      if (SECRETOS.includes(k)) {
        if (v === '' || v === undefined) continue;
        // "••••" vindo da tela = não mudou.
        out[k] = v.startsWith('••••') ? anterior[k] : `enc:${this.segredos.cifrar(v)}`;
      } else out[k] = v;
    }
    for (const k of SECRETOS) if (!(k in out) && anterior[k] && config[k] === undefined) out[k] = anterior[k];
    return out;
  }

  private abrirConfig(c: Canal): Record<string, string> {
    return Object.fromEntries(Object.entries(c.config).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('enc:') ? this.segredos.decifrar(v.slice(4)) : v]));
  }

  /** Para a tela: segredos mascarados. */
  publico(c: Canal) {
    const cfg = Object.fromEntries(Object.entries(c.config).map(([k, v]) => [k, SECRETOS.includes(k) ? (v ? `••••${this.abrirConfig(c)[k]?.slice(-4) ?? ''}` : '') : v]));
    return { ...c, config: cfg, tokenWebhook: undefined, webhook: this.urlWebhook(c) };
  }

  urlWebhook(c: Canal) {
    const base = (process.env.API_PUBLICA_URL ?? process.env.PAINEL_URL ?? '').replace(/\/$/, '');
    return `${base}/api/webhooks/whatsapp/${c.id}/${c.tokenWebhook}`;
  }

  async listar() {
    return (await this.db.select().from(crmCanais).orderBy(crmCanais.criadoEm)).map((c) => this.publico(c));
  }

  async obter(id: string) {
    const [c] = await this.db.select().from(crmCanais).where(eq(crmCanais.id, id));
    if (!c) throw new NotFoundException('Número de WhatsApp não encontrado.');
    return c;
  }

  validarConfig(tipo: string, cfg: Record<string, string>) {
    if (tipo === 'oficial' && !(cfg.phoneNumberId && cfg.wabaId && cfg.token)) throw new BadRequestException('Preencha o Phone Number ID, o WABA ID e o token da Meta.');
    if (tipo === 'qrcode' && !(cfg.instancia && cfg.token)) throw new BadRequestException('Preencha a instância e o token da Z-API.');
  }

  async criar(d: { nome: string; tipo: 'oficial' | 'qrcode'; config: Record<string, string>; usuarioId?: string | null; atendentes?: string[]; funilEntradaId?: string | null }) {
    this.validarConfig(d.tipo, d.config);
    const [c] = await this.db
      .insert(crmCanais)
      .values({ nome: d.nome, tipo: d.tipo, config: this.cifrarConfig(d.config), tokenWebhook: randomBytes(18).toString('base64url'), usuarioId: d.usuarioId ?? null, atendentes: d.atendentes ?? [], funilEntradaId: d.funilEntradaId ?? null })
      .returning();
    if (c.tipo === 'qrcode') await this.apontarWebhookZapi(c).catch((e) => this.log.warn(`Webhook da Z-API não configurado: ${(e as Error).message}`));
    return this.publico(c);
  }

  async atualizar(id: string, d: Partial<{ nome: string; config: Record<string, string>; usuarioId: string | null; atendentes: string[]; funilEntradaId: string | null; ativo: boolean }>) {
    const atual = await this.obter(id);
    const config = d.config ? this.cifrarConfig({ ...Object.fromEntries(Object.entries(atual.config).filter(([k]) => !SECRETOS.includes(k))), ...d.config }, atual.config) : atual.config;
    if (d.config) this.validarConfig(atual.tipo, { ...this.abrirConfig({ ...atual, config }) });
    const [c] = await this.db.update(crmCanais).set({ ...d, config }).where(eq(crmCanais.id, id)).returning();
    return this.publico(c);
  }

  conexao(c: Canal): Conexao {
    const cfg = this.abrirConfig(c);
    if (c.tipo === 'oficial') return new ConexaoOficial({ phoneNumberId: cfg.phoneNumberId, wabaId: cfg.wabaId, token: cfg.token, appSecret: cfg.appSecret || undefined });
    return new ConexaoZapi({ instancia: cfg.instancia, token: cfg.token, clientToken: cfg.clientToken || undefined });
  }

  async apontarWebhookZapi(c: Canal) {
    if (c.tipo !== 'qrcode') return;
    await (this.conexao(c) as ConexaoZapi).configurarWebhooks(this.urlWebhook(c));
  }

  async situacao(id: string) {
    const c = await this.obter(id);
    const s = await this.conexao(c).situacao();
    if (s.numero && s.numero !== c.numero) await this.db.update(crmCanais).set({ numero: s.numero }).where(eq(crmCanais.id, id));
    return s;
  }

  async desconectar(id: string) {
    const c = await this.obter(id);
    if (c.tipo !== 'qrcode') throw new BadRequestException('Só números por QR code se desconectam por aqui.');
    await (this.conexao(c) as ConexaoZapi).desconectar();
    return { ok: true };
  }

  /** Templates aprovados na Meta para o número oficial. */
  async sincronizarTemplates(id: string) {
    const c = await this.obter(id);
    const con = this.conexao(c);
    if (!con.templates) throw new BadRequestException('Templates só existem no WhatsApp oficial.');
    const lista = await con.templates();
    const atuais = await this.db.select().from(crmTemplates).where(eq(crmTemplates.canalId, id));
    for (const t of lista) {
      const ja = atuais.find((a) => a.nome === t.nome && a.idioma === t.idioma);
      const valores = { canalId: id, nome: t.nome, tipo: 'meta', idioma: t.idioma, categoria: t.categoria, texto: t.texto, componentes: t.componentes, status: t.status, atualizadoEm: new Date() };
      if (ja) await this.db.update(crmTemplates).set({ ...valores, variaveis: ja.variaveis.length === t.variaveis ? ja.variaveis : Array.from({ length: t.variaveis }, (_, i) => ja.variaveis[i] ?? (i === 0 ? 'primeiro_nome' : '')) }).where(eq(crmTemplates.id, ja.id));
      else await this.db.insert(crmTemplates).values({ ...valores, variaveis: Array.from({ length: t.variaveis }, (_, i) => (i === 0 ? 'primeiro_nome' : '')) });
    }
    const nomes = new Set(lista.map((t) => `${t.nome}|${t.idioma}`));
    const sumiram = atuais.filter((a) => !nomes.has(`${a.nome}|${a.idioma}`));
    if (sumiram.length) await this.db.delete(crmTemplates).where(inArray(crmTemplates.id, sumiram.map((s) => s.id)));
    return { total: lista.length, aprovados: lista.filter((t) => t.status === 'APPROVED').length, removidos: sumiram.length };
  }

  // ───────────── Quem pode atender ─────────────

  podeAtender(c: Canal, usuarioId: string, gestor: boolean) {
    return gestor || !c.atendentes.length || c.atendentes.includes(usuarioId) || c.usuarioId === usuarioId;
  }

  /** Canais que o usuário enxerga. */
  async canaisDoUsuario(usuarioId: string, gestor: boolean) {
    const todos = await this.db.select().from(crmCanais).where(eq(crmCanais.ativo, true));
    return todos.filter((c) => this.podeAtender(c, usuarioId, gestor));
  }

  /** Conversa do contato naquele número. Aberta pela equipe ou por automação, nasce resolvida (só entra na fila quando o contato responder). */
  async garantirConversa(contatoId: string, canalId: string, inicial: 'fila' | 'resolvida' = 'fila') {
    const [ja] = await this.db.select().from(crmConversas).where(and(eq(crmConversas.contatoId, contatoId), eq(crmConversas.canalId, canalId)));
    if (ja) return ja;
    const [nova] = await this.db
      .insert(crmConversas)
      .values({ contatoId, canalId, status: inicial, filaDesde: inicial === 'fila' ? new Date() : null })
      .onConflictDoUpdate({ target: [crmConversas.contatoId, crmConversas.canalId], set: { contatoId } })
      .returning();
    return nova;
  }

  async pegar(conversaId: string, usuarioId: string, gestor: boolean) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, conversaId));
    if (!cv) throw new NotFoundException('Conversa não encontrada.');
    const canal = await this.obter(cv.canalId);
    if (!this.podeAtender(canal, usuarioId, gestor)) throw new ForbiddenException('Você não atende por este número.');
    // Só pega se ninguém pegou antes (dois atendentes clicando ao mesmo tempo).
    const [r] = await this.db
      .update(crmConversas)
      .set({ status: 'atendimento', atendenteId: usuarioId, pegaEm: new Date(), naoLidas: 0 })
      .where(and(eq(crmConversas.id, conversaId), sql`(${crmConversas.atendenteId} is null or ${crmConversas.status} <> 'atendimento' or ${crmConversas.atendenteId} = ${usuarioId})`))
      .returning();
    if (!r) throw new BadRequestException('Outra pessoa já pegou esta conversa.');
    // Quem pega a conversa vira responsável pelos cards abertos que ainda não têm dono.
    await this.db.execute(sql`update crm_leads set responsavel_id = ${usuarioId} where contato_id = ${cv.contatoId} and status = 'aberto' and responsavel_id is null`);
    await this.notaNosLeads(cv.contatoId, 'Conversa pega para atendimento.', usuarioId);
    return r;
  }

  async transferir(conversaId: string, para: string | null, usuarioId: string, gestor: boolean) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, conversaId));
    if (!cv) throw new NotFoundException('Conversa não encontrada.');
    if (!gestor && cv.atendenteId !== usuarioId) throw new ForbiddenException('Só quem está atendendo (ou a gestão) pode transferir.');
    const [r] = await this.db
      .update(crmConversas)
      .set(para ? { status: 'atendimento', atendenteId: para, pegaEm: new Date() } : { status: 'fila', atendenteId: null, filaDesde: new Date() })
      .where(eq(crmConversas.id, conversaId))
      .returning();
    await this.notaNosLeads(cv.contatoId, para ? 'Conversa transferida.' : 'Conversa devolvida para a fila.', usuarioId, { para });
    return r;
  }

  async resolver(conversaId: string, usuarioId: string, gestor: boolean) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, conversaId));
    if (!cv) throw new NotFoundException('Conversa não encontrada.');
    if (!gestor && cv.atendenteId && cv.atendenteId !== usuarioId) throw new ForbiddenException('Esta conversa é de outro atendente.');
    const [r] = await this.db.update(crmConversas).set({ status: 'resolvida', naoLidas: 0 }).where(eq(crmConversas.id, conversaId)).returning();
    await this.notaNosLeads(cv.contatoId, 'Atendimento resolvido.', usuarioId);
    return r;
  }

  private async notaNosLeads(contatoId: string, texto: string, usuarioId: string | null, dados?: unknown) {
    for (const l of await this.crm.leadsAbertosDoContato(contatoId)) await this.crm.evento(l.id, 'sistema', texto, usuarioId, dados);
  }

  // ───────────── Envio ─────────────

  dentroDaJanela(cv: typeof crmConversas.$inferSelect) {
    return !!cv.ultimaEntradaEm && Date.now() - cv.ultimaEntradaEm.getTime() < JANELA_MS;
  }

  async enviar(e: EnvioCrm) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, e.conversaId));
    if (!cv) throw new NotFoundException('Conversa não encontrada.');
    const canal = await this.obter(cv.canalId);
    if (!canal.ativo) throw new BadRequestException('Este número de WhatsApp está desativado.');
    const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, cv.contatoId));
    const dados = e.leadId ? await this.crm.dadosDoLead(e.leadId) : null;
    const vars: Record<string, string> = { nome: contato.nome, primeiro_nome: primeiroNome(contato.nome), telefone: contato.telefone, etapa: dados?.etapa ?? '', funil: dados?.funil ?? '' };

    let saida: MensagemSaida;
    let textoGuardado = e.texto ?? null;
    let templateNome: string | null = null;
    if (e.tipo === 'template') {
      const [t] = await this.db.select().from(crmTemplates).where(eq(crmTemplates.id, e.templateId ?? ''));
      if (!t) throw new BadRequestException('Template não encontrado.');
      templateNome = t.nome;
      if (t.tipo === 'meta') {
        if (canal.tipo !== 'oficial' || t.canalId !== canal.id) throw new BadRequestException('Este template é de outro número oficial.');
        if (t.status !== 'APPROVED') throw new BadRequestException('Template ainda não aprovado pela Meta.');
        const parametros = t.variaveis.map((v) => (v in vars ? vars[v] : v));
        textoGuardado = t.texto.replace(/\{\{(\d+)\}\}/g, (_, n: string) => parametros[Number(n) - 1] ?? '');
        saida = { para: contato.telefone, tipo: 'template', template: { nome: t.nome, idioma: t.idioma, parametros } };
      } else {
        textoGuardado = preencherTexto(t.texto, vars);
        if (canal.tipo === 'oficial' && !this.dentroDaJanela(cv)) throw new BadRequestException('Fora da janela de 24h: no número oficial só templates aprovados pela Meta podem ser enviados agora.');
        saida = { para: contato.telefone, tipo: 'texto', texto: textoGuardado };
      }
    } else {
      if (canal.tipo === 'oficial' && !this.dentroDaJanela(cv)) throw new BadRequestException('Fora da janela de 24h: o contato não escreveu nas últimas 24 horas. No número oficial, use um template aprovado.');
      if (e.tipo === 'texto' && !e.texto?.trim()) throw new BadRequestException('Escreva a mensagem.');
      textoGuardado = e.texto ? preencherTexto(e.texto, vars) : null;
      saida = { para: contato.telefone, tipo: e.tipo, texto: textoGuardado ?? undefined, midia: e.midia ?? undefined };
    }

    const midiaNome = e.midia ? await this.arquivos.salvarMidia(e.midia.conteudo, e.midia.mime) : null;
    const [m] = await this.db
      .insert(crmMensagens)
      .values({ conversaId: cv.id, direcao: 'saida', tipo: e.tipo, texto: textoGuardado, midia: midiaNome, midiaNome: e.midia?.nome ?? null, templateNome, status: 'pendente', usuarioId: e.usuarioId ?? null, gatilhoId: e.gatilhoId ?? null, disparoId: e.disparoId ?? null })
      .returning();
    try {
      const r = await this.conexao(canal).enviar(saida);
      const [ok] = await this.db.update(crmMensagens).set({ status: 'enviada', idExterno: r.idExterno }).where(eq(crmMensagens.id, m.id)).returning();
      const resumo = textoGuardado ?? `[${e.tipo}]`;
      // Atendente respondendo uma conversa da fila: ela passa a ser dele.
      const pegar = e.usuarioId && cv.status !== 'atendimento' ? { status: 'atendimento', atendenteId: e.usuarioId, pegaEm: new Date() } : {};
      await this.db.update(crmConversas).set({ ultimaMensagem: resumo.slice(0, 200), ultimaMensagemEm: new Date(), ...pegar }).where(eq(crmConversas.id, cv.id));
      await this.crm.tocarInteracao(cv.contatoId);
      return ok;
    } catch (err) {
      const msg = (err as Error).message;
      await this.db.update(crmMensagens).set({ status: 'falhou', erro: msg }).where(eq(crmMensagens.id, m.id));
      throw err instanceof ErroCanal ? new BadRequestException(msg) : err;
    }
  }

  // ───────────── Recebimento (webhooks) ─────────────

  async verificarMeta(canalId: string, token: string, modo?: string, verificacao?: string, desafio?: string) {
    const c = await this.obter(canalId).catch(() => null);
    if (!c || c.tokenWebhook !== token || modo !== 'subscribe' || verificacao !== token) throw new ForbiddenException('Token de verificação inválido.');
    return desafio ?? '';
  }

  async receber(canalId: string, token: string, corpo: unknown, bruto?: Buffer, assinatura?: string) {
    const c = await this.obter(canalId).catch(() => null);
    if (!c || c.tokenWebhook !== token) throw new ForbiddenException('Webhook inválido.');
    const con = this.conexao(c);
    if (con instanceof ConexaoOficial && !con.assinaturaValida(bruto, assinatura)) throw new ForbiddenException('Assinatura da Meta inválida.');
    const { mensagens, status } = con.ler(corpo);
    for (const m of mensagens) await this.entrada(c, con, m).catch((e) => this.log.error(`Mensagem recebida não gravada: ${(e as Error).message}`));
    for (const s of status) await this.status(s);
    return { ok: true };
  }

  private async entrada(c: Canal, con: Conexao, m: MensagemEntrada) {
    const [dup] = await this.db.select({ id: crmMensagens.id }).from(crmMensagens).where(eq(crmMensagens.idExterno, m.idExterno)).limit(1);
    if (dup) return;
    const contato = await this.crm.garantirContato({ telefone: m.telefone, nome: m.minha ? null : m.nome });
    const cv = await this.garantirConversa(contato.id, c.id);
    let midia: string | null = null;
    let texto = m.texto;
    if (m.midia) {
      try {
        const b = await con.baixarMidia(m.midia.ref);
        if (b.conteudo.length > 25_000_000) throw new Error('arquivo grande demais');
        midia = await this.arquivos.salvarMidia(b.conteudo, m.midia.mime ?? b.mime);
      } catch (e) {
        texto = [texto, `[mídia não baixada: ${(e as Error).message}]`].filter(Boolean).join(' ');
      }
    }
    await this.db.insert(crmMensagens).values({
      conversaId: cv.id,
      direcao: m.minha ? 'saida' : 'entrada',
      tipo: m.tipo,
      texto,
      midia,
      midiaNome: m.midia?.nome ?? null,
      status: m.minha ? 'enviada' : 'recebida',
      idExterno: m.idExterno,
      criadoEm: m.quando,
    });
    const resumo = (texto ?? `[${m.tipo}]`).slice(0, 200);
    if (m.minha) {
      // Respondido pelo próprio celular (QR code).
      await this.db.update(crmConversas).set({ ultimaMensagem: resumo, ultimaMensagemEm: m.quando }).where(eq(crmConversas.id, cv.id));
      return;
    }
    // Resolvida e o contato escreveu de novo: volta para a fila. Em atendimento: continua com o atendente.
    const voltaFila = cv.status === 'resolvida';
    await this.db
      .update(crmConversas)
      .set({
        ultimaMensagem: resumo,
        ultimaMensagemEm: m.quando,
        ultimaEntradaEm: m.quando,
        naoLidas: sql`${crmConversas.naoLidas} + 1`,
        ...(voltaFila ? { status: 'fila', atendenteId: null, filaDesde: new Date() } : {}),
        ...(cv.status === 'fila' && !cv.filaDesde ? { filaDesde: new Date() } : {}),
      })
      .where(eq(crmConversas.id, cv.id));

    if (texto && PEDIU_SAIR.test(texto)) await this.db.update(crmContatos).set({ descadastrado: true }).where(eq(crmContatos.id, contato.id));

    // Quem respondeu a um disparo dos últimos 7 dias.
    await this.db
      .update(crmDisparoDestinos)
      .set({ status: 'respondeu' })
      .where(and(eq(crmDisparoDestinos.contatoId, contato.id), inArray(crmDisparoDestinos.status, ['enviada', 'entregue', 'lida']), gte(crmDisparoDestinos.enviadoEm, new Date(Date.now() - 7 * 86400_000))));

    let leads = await this.crm.leadsAbertosDoContato(contato.id);
    if (!leads.length && c.funilEntradaId) {
      const l = await this.crm.criarLead({ funilId: c.funilEntradaId, contatoId: contato.id, titulo: contato.nome, origem: { utm_source: 'whatsapp', canal: c.nome, ...(m.referencia ?? {}) } });
      leads = [l];
    } else if (m.referencia) {
      // Já tinha card: registra de que anúncio voltou.
      for (const l of leads) await this.crm.evento(l.id, 'sistema', `Veio de anúncio da Meta${m.referencia.anuncio_titulo ? `: "${m.referencia.anuncio_titulo}"` : ''}.`, null, m.referencia);
    }
    await this.crm.tocarInteracao(contato.id);
    for (const l of leads) this.crm.emitir({ tipo: 'mensagem_recebida', leadId: l.id, texto: texto ?? '' });
  }

  private async status(s: StatusEntrada) {
    const [m] = await this.db.select().from(crmMensagens).where(eq(crmMensagens.idExterno, s.idExterno)).orderBy(desc(crmMensagens.criadoEm)).limit(1);
    if (!m) return;
    if (s.status !== 'falhou' && (ORDEM_STATUS[s.status] ?? 0) <= (ORDEM_STATUS[m.status] ?? 0)) return;
    await this.db.update(crmMensagens).set({ status: s.status, ...(s.erro ? { erro: s.erro } : {}) }).where(eq(crmMensagens.id, m.id));
    if (m.disparoId) {
      await this.db
        .update(crmDisparoDestinos)
        .set({ status: s.status, ...(s.erro ? { erro: s.erro } : {}) })
        .where(and(eq(crmDisparoDestinos.mensagemId, m.id), sql`${crmDisparoDestinos.status} <> 'respondeu'`));
    }
  }
}
