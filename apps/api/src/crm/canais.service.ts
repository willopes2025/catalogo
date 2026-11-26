import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { SegredosService } from '../segredos/segredos.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { crmCanais, crmContatos, crmConversas, crmDisparoDestinos, crmImportacoes, crmMensagens, crmTemplates } from '../db/schema';
import { CrmService } from './crm.service';
import { TranscricaoService } from './transcricao.service';
import { PEDIU_SAIR, preencherTexto, primeiroNome, variaveisDosCampos } from './telefone';
import { ConexaoOficial } from './whatsapp/oficial';
import { ConexaoZapi } from './whatsapp/zapi';
import { ConexaoEvolution, apagarInstancia, criarInstancia, evolutionDisponivel, nomeInstancia, validarEnderecoEvolution } from './whatsapp/evolution';
import { ErroCanal, type Conexao, type MensagemEntrada, type MensagemSaida, type ReacaoEntrada, type StatusEntrada } from './whatsapp/tipos';
import { urlPublica } from '../comum/url';

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
  /** Mensagem da conversa que esta responde (citação). */
  citarId?: string | null;
  /** Escrita pelo agente de IA. */
  ia?: boolean;
  /** Lead para preencher {{nome}}, {{etapa}}… */
  leadId?: string | null;
}

/**
 * Números de WhatsApp do CRM (vários, oficiais e por QR code), envio, recebimento e a fila de atendimento:
 * conversa nova cai na fila do número; um atendente pega; ao resolver, a próxima mensagem do contato volta para a fila.
 */
@Injectable()
export class CanaisService implements OnModuleInit {
  private readonly log = new Logger('WhatsApp');

  /**
   * Ao subir, reaponta o webhook dos números por QR code / token para o endereço atual do sistema.
   * Conserta sozinho número que parou de receber (endereço mudou, evento novo passou a ser ouvido).
   */
  onModuleInit() {
    if (process.env.WEBHOOKS_AO_INICIAR === '0') return;
    setTimeout(() => void this.reapontarTodos(), 20_000).unref();
  }

  async reapontarTodos() {
    const lista = await this.db.select().from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm), inArray(crmCanais.tipo, ['evolution', 'qrcode'])));
    let ok = 0;
    for (const c of lista) {
      try {
        await this.apontarWebhookZapi(c);
        ok++;
      } catch (e) {
        this.log.warn(`Webhook do número "${c.nome}" não foi reapontado: ${(e as Error).message}`);
      }
    }
    if (lista.length) this.log.log(`Webhooks reapontados: ${ok} de ${lista.length} número(s).`);
    return { total: lista.length, ok };
  }

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly segredos: SegredosService,
    private readonly arquivos: ArquivosService,
    private readonly crm: CrmService,
    private readonly transcricao: TranscricaoService,
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
    // Endereço público do sistema. Sem isso o WhatsApp recebe um endereço sem domínio e nunca avisa das mensagens.
    const base = (process.env.API_PUBLICA_URL ?? urlPublica()).replace(/\/$/, '');
    return `${base}/api/webhooks/whatsapp/${c.id}/${c.tokenWebhook}`;
  }

  /** O servidor de WhatsApp próprio fala com a API pela rede interna da VPS, sem passar pela internet. */
  private urlWebhookInterno(c: Canal) {
    const base = (process.env.EVOLUTION_WEBHOOK_URL ?? process.env.API_PUBLICA_URL ?? urlPublica()).replace(/\/$/, '');
    return `${base}/api/webhooks/whatsapp/${c.id}/${c.tokenWebhook}`;
  }

  /** Se a VPS tem o servidor de WhatsApp por QR code (a tela usa para escolher o que oferecer). */
  qrcodeProprioDisponivel() {
    return evolutionDisponivel();
  }

  async listar() {
    return (await this.db.select().from(crmCanais).where(isNull(crmCanais.excluidoEm)).orderBy(crmCanais.criadoEm)).map((c) => this.publico(c));
  }

  async obter(id: string) {
    const [c] = await this.db.select().from(crmCanais).where(eq(crmCanais.id, id));
    if (!c) throw new NotFoundException('Número de WhatsApp não encontrado.');
    return c;
  }

  validarConfig(tipo: string, cfg: Record<string, string>) {
    if (tipo === 'oficial' && !(cfg.phoneNumberId && cfg.wabaId && cfg.token)) throw new BadRequestException('Preencha o Phone Number ID, o WABA ID e o token da Meta.');
    if (tipo === 'qrcode' && !(cfg.instancia && cfg.token)) throw new BadRequestException('Preencha a instância e o token da Z-API.');
    if (tipo === 'evolution' && this.evolutionPorToken(cfg)) {
      // Instância que já existe em outro servidor Evolution: endereço, nome e token.
      if (!(cfg.servidor && cfg.instancia && cfg.token)) throw new BadRequestException('Preencha o endereço do servidor Evolution, o nome da instância e o token dela.');
      try {
        validarEnderecoEvolution(cfg.servidor);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      return;
    }
    if (tipo === 'evolution' && !evolutionDisponivel()) throw new BadRequestException('O servidor de WhatsApp por QR code não está instalado nesta VPS. Rode o instalador de novo para ativá-lo.');
  }

  /** Evolution ligada pelo token de uma instância que já existe (em vez do QR code criado pelo sistema). */
  private evolutionPorToken(cfg: Record<string, unknown>) {
    return !!(cfg.servidor || cfg.token);
  }

  async criar(d: { nome: string; tipo: 'oficial' | 'qrcode' | 'evolution'; config: Record<string, string>; usuarioId?: string | null; atendentes?: string[]; funilEntradaId?: string | null }) {
    this.validarConfig(d.tipo, d.config);
    const [c] = await this.db
      .insert(crmCanais)
      .values({ nome: d.nome, tipo: d.tipo, config: d.tipo === 'evolution' && !this.evolutionPorToken(d.config) ? {} : this.cifrarConfig(d.tipo === 'evolution' ? { servidor: validarEnderecoEvolution(d.config.servidor), instancia: d.config.instancia.trim(), token: d.config.token.trim() } : d.config), tokenWebhook: randomBytes(18).toString('base64url'), usuarioId: d.usuarioId ?? null, atendentes: d.atendentes ?? [], funilEntradaId: d.funilEntradaId ?? null })
      .returning();
    if (c.tipo === 'qrcode') await this.apontarWebhookZapi(c).catch((e) => this.log.warn(`Webhook da Z-API não configurado: ${(e as Error).message}`));
    if (c.tipo === 'evolution' && this.evolutionPorToken(c.config)) {
      // Confere endereço, instância e token antes de guardar, e aponta o webhook da instância para o sistema.
      try {
        const con = this.conexao(c) as ConexaoEvolution;
        await con.testar();
        await con.configurarWebhooks();
        const s = await con.situacao();
        if (s.numero) await this.db.update(crmCanais).set({ numero: s.numero }).where(eq(crmCanais.id, c.id));
        return { ...this.publico(c), qrcode: s.conectado ? null : (s.qrcode ?? null), conectado: s.conectado };
      } catch (e) {
        await this.db.delete(crmCanais).where(eq(crmCanais.id, c.id));
        throw new BadRequestException((e as Error).message);
      }
    }
    if (c.tipo === 'evolution') {
      // Nada para digitar: o sistema cria a instância no servidor próprio, com o webhook já apontado.
      const instancia = nomeInstancia(c.id);
      try {
        const r = await criarInstancia(instancia, this.urlWebhookInterno(c));
        const [pronto] = await this.db.update(crmCanais).set({ config: { instancia } }).where(eq(crmCanais.id, c.id)).returning();
        return { ...this.publico(pronto), qrcode: r.qrcode };
      } catch (e) {
        await this.db.delete(crmCanais).where(eq(crmCanais.id, c.id));
        throw new BadRequestException((e as Error).message);
      }
    }
    return this.publico(c);
  }

  async atualizar(id: string, d: Partial<{ nome: string; config: Record<string, string>; usuarioId: string | null; atendentes: string[]; funilEntradaId: string | null; ativo: boolean; envioIntervaloMinS: number; envioIntervaloMaxS: number; envioInicio: string; envioFim: string; envioDias: number[] }>) {
    const atual = await this.obter(id);
    if (atual.excluidoEm) throw new BadRequestException('Este número foi excluído. Para usar de novo, conecte como um número novo.');
    const config = d.config ? this.cifrarConfig({ ...Object.fromEntries(Object.entries(atual.config).filter(([k]) => !SECRETOS.includes(k))), ...d.config }, atual.config) : atual.config;
    if (d.config) this.validarConfig(atual.tipo, { ...this.abrirConfig({ ...atual, config }) });
    const porToken = atual.tipo === 'evolution' && !!d.config && this.evolutionPorToken(config);
    if (porToken) {
      // Mudou endereço, instância ou token: só grava se a conexão nova funcionar.
      config.servidor = validarEnderecoEvolution(config.servidor);
      const con = this.conexao({ ...atual, config }) as ConexaoEvolution;
      try {
        await con.testar();
        await con.configurarWebhooks();
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    const [c] = await this.db.update(crmCanais).set({ ...d, config }).where(eq(crmCanais.id, id)).returning();
    return this.publico(c);
  }

  conexao(c: Canal): Conexao {
    const cfg = this.abrirConfig(c);
    if (c.tipo === 'oficial') return new ConexaoOficial({ phoneNumberId: cfg.phoneNumberId, wabaId: cfg.wabaId, token: cfg.token, appSecret: cfg.appSecret || undefined });
    // Instância de outro servidor Evolution: ele chega no sistema pela internet (endereço público do webhook).
    if (c.tipo === 'evolution' && this.evolutionPorToken(cfg)) return new ConexaoEvolution(cfg.instancia, this.urlWebhook(c), { url: cfg.servidor, chave: cfg.token });
    if (c.tipo === 'evolution') return new ConexaoEvolution(cfg.instancia || nomeInstancia(c.id), this.urlWebhookInterno(c));
    return new ConexaoZapi({ instancia: cfg.instancia, token: cfg.token, clientToken: cfg.clientToken || undefined });
  }

  async apontarWebhookZapi(c: Canal) {
    if (c.tipo === 'evolution') {
      const con = this.conexao(c) as ConexaoEvolution;
      await con.configurarWebhooks();
      // Número que aparece conectado mas parou de receber: reinicia a conexão (sem QR).
      if ((await con.estado().catch(() => 'close')) === 'open') await con.reiniciar().catch((e) => this.log.warn(`Reiniciar ${c.nome}: ${(e as Error).message}`));
      return;
    }
    if (c.tipo !== 'qrcode') return;
    await (this.conexao(c) as ConexaoZapi).configurarWebhooks(this.urlWebhook(c));
  }

  async situacao(id: string) {
    const c = await this.obter(id);
    const s = await this.conexao(c).situacao();
    if (s.numero && s.numero !== c.numero) await this.db.update(crmCanais).set({ numero: s.numero }).where(eq(crmCanais.id, id));
    return s;
  }

  /**
   * Exclui o número. Sem nenhuma conversa nem disparo, apaga de vez; com histórico, tira da tela,
   * para de mandar e receber e apaga as credenciais, mas as conversas antigas continuam para consulta.
   * No QR code do servidor próprio, a sessão do celular é encerrada e apagada lá também.
   */
  async excluir(id: string) {
    const c = await this.obter(id);
    if (c.excluidoEm) return { ok: true, apagado: false };
    // Instância de outro servidor: o sistema só para de receber; ela continua existindo lá.
    if (c.tipo === 'evolution' && this.evolutionPorToken(c.config)) await (this.conexao(c) as ConexaoEvolution).desligarWebhook().catch(() => undefined);
    else if (c.tipo === 'evolution') await apagarInstancia(this.abrirConfig(c).instancia || nomeInstancia(c.id));
    else if (c.tipo === 'qrcode') await (this.conexao(c) as ConexaoZapi).desconectar().catch(() => undefined);
    const [uso] = await this.db.execute<{ conversas: number; disparos: number }>(sql`
      select (select count(*)::int from crm_conversas where canal_id = ${id}) as conversas, (select count(*)::int from crm_disparos where canal_id = ${id}) as disparos`).then((r) => r.rows);
    if (!uso.conversas && !uso.disparos) {
      await this.db.delete(crmCanais).where(eq(crmCanais.id, id));
      return { ok: true, apagado: true };
    }
    await this.db.update(crmCanais).set({ ativo: false, excluidoEm: new Date(), config: {}, tokenWebhook: randomBytes(18).toString('base64url') }).where(eq(crmCanais.id, id));
    // Conversas que estavam na fila ou em atendimento por este número são encerradas.
    await this.db.execute(sql`update crm_conversas set status = 'resolvida' where canal_id = ${id} and status <> 'resolvida'`);
    return { ok: true, apagado: false, conversas: uso.conversas };
  }

  async desconectar(id: string) {
    const c = await this.obter(id);
    if (c.tipo === 'oficial') throw new BadRequestException('Só números por QR code se desconectam por aqui.');
    await (this.conexao(c) as ConexaoZapi | ConexaoEvolution).desconectar();
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
      .set({ status: 'atendimento', atendenteId: usuarioId, pegaEm: new Date(), naoLidas: 0, iaAtiva: false })
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
      // Devolvida para a fila: a IA volta a poder atender (se estiver ligada na configuração).
      .set(para ? { status: 'atendimento', atendenteId: para, pegaEm: new Date(), iaAtiva: false } : { status: 'fila', atendenteId: null, filaDesde: new Date(), iaAtiva: null, iaRespostas: 0, iaAgenteId: null, iaTransferencias: 0 })
      .where(eq(crmConversas.id, conversaId))
      .returning();
    await this.notaNosLeads(cv.contatoId, para ? 'Conversa transferida.' : 'Conversa devolvida para a fila.', usuarioId, { para });
    return r;
  }

  async resolver(conversaId: string, usuarioId: string, gestor: boolean) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, conversaId));
    if (!cv) throw new NotFoundException('Conversa não encontrada.');
    if (!gestor && cv.atendenteId && cv.atendenteId !== usuarioId) throw new ForbiddenException('Esta conversa é de outro atendente.');
    const [r] = await this.db.update(crmConversas).set({ status: 'resolvida', naoLidas: 0, iaAtiva: null, iaRespostas: 0, iaAgenteId: null, iaTransferencias: 0 }).where(eq(crmConversas.id, conversaId)).returning();
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
    const vars: Record<string, string> = { ...variaveisDosCampos(contato.camposExtras, dados?.extrasLead), nome: contato.nome, primeiro_nome: primeiroNome(contato.nome), telefone: contato.telefone, etapa: dados?.etapa ?? '', funil: dados?.funil ?? '' };

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
        const parametros = t.variaveis.map((v) => (v in vars ? vars[v] : v.startsWith('campo_') ? '' : v));
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

    // Responder citando uma mensagem desta conversa.
    let citadaId: string | null = null;
    if (e.citarId) {
      const [alvo] = await this.db.select().from(crmMensagens).where(and(eq(crmMensagens.id, e.citarId), eq(crmMensagens.conversaId, cv.id)));
      if (alvo?.idExterno && alvo.direcao !== 'interna' && !alvo.apagadaEm) {
        citadaId = alvo.id;
        saida.citar = { idExterno: alvo.idExterno, minha: alvo.direcao === 'saida', texto: alvo.texto ?? (alvo.midia ? `[${alvo.tipo}]` : null) };
      }
    }

    const midiaNome = e.midia ? await this.arquivos.salvarMidia(e.midia.conteudo, e.midia.mime) : null;
    const [m] = await this.db
      .insert(crmMensagens)
      .values({ ia: !!e.ia, citadaId, conversaId: cv.id, direcao: 'saida', tipo: e.tipo, texto: textoGuardado, midia: midiaNome, midiaNome: e.midia?.nome ?? null, templateNome, status: 'pendente', usuarioId: e.usuarioId ?? null, gatilhoId: e.gatilhoId ?? null, disparoId: e.disparoId ?? null })
      .returning();
    try {
      const r = await this.conexao(canal).enviar(saida);
      const [ok] = await this.db.update(crmMensagens).set({ status: 'enviada', idExterno: r.idExterno }).where(eq(crmMensagens.id, m.id)).returning();
      const resumo = textoGuardado ?? `[${e.tipo}]`;
      // Atendente respondendo uma conversa da fila: ela passa a ser dele.
      const pegar = e.usuarioId && cv.status !== 'atendimento' ? { status: 'atendimento', atendenteId: e.usuarioId, pegaEm: new Date() } : {};
      // Uma pessoa da equipe escreveu: a IA sai desta conversa.
      const semIa = e.usuarioId ? { iaAtiva: false } : {};
      await this.db.update(crmConversas).set({ ultimaMensagem: resumo.slice(0, 200), ultimaMensagemEm: new Date(), ...pegar, ...semIa }).where(eq(crmConversas.id, cv.id));
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
    const { mensagens, status, reacoes, apagadas }: ReturnType<Conexao['ler']> = con.ler(corpo);
    // Marca que o WhatsApp falou com o sistema por este número (a tela de configuração mostra, para conferir se está chegando).
    if (!c.ultimoWebhookEm || Date.now() - c.ultimoWebhookEm.getTime() > 30_000) await this.db.update(crmCanais).set({ ultimoWebhookEm: new Date() }).where(eq(crmCanais.id, c.id));
    for (const m of mensagens) await this.entrada(c, con, m).catch((e) => this.log.error(`Mensagem recebida não gravada: ${(e as Error).message}`));
    for (const s of status) await this.status(s);
    for (const r of reacoes ?? []) await this.reacaoRecebida(c, r).catch((e) => this.log.warn(`Reação não gravada: ${(e as Error).message}`));
    for (const id of apagadas ?? []) await this.apagadaNoWhatsApp(c, id).catch((e) => this.log.warn(`Mensagem apagada não marcada: ${(e as Error).message}`));
    return { ok: true };
  }

  /** Mensagem deste número pelo id do WhatsApp (o id só vale dentro do mesmo número). */
  private async mensagemDoCanal(canalId: string, idExterno: string) {
    const [m] = await this.db
      .select({ m: crmMensagens })
      .from(crmMensagens)
      .innerJoin(crmConversas, eq(crmConversas.id, crmMensagens.conversaId))
      .where(and(eq(crmMensagens.idExterno, idExterno), eq(crmConversas.canalId, canalId)))
      .orderBy(desc(crmMensagens.criadoEm))
      .limit(1);
    return m?.m ?? null;
  }

  private async reacaoRecebida(c: Canal, r: ReacaoEntrada) {
    const m = await this.mensagemDoCanal(c.id, r.idExterno);
    if (!m) return;
    const de = r.minha ? 'equipe' : 'contato';
    const reacoes = [...m.reacoes.filter((x) => x.de !== de), ...(r.emoji ? [{ de, emoji: r.emoji.slice(0, 16) } as const] : [])];
    await this.db.update(crmMensagens).set({ reacoes }).where(eq(crmMensagens.id, m.id));
  }

  private async apagadaNoWhatsApp(c: Canal, idExterno: string) {
    const m = await this.mensagemDoCanal(c.id, idExterno);
    if (m && !m.apagadaEm) await this.db.update(crmMensagens).set({ apagadaEm: new Date() }).where(eq(crmMensagens.id, m.id));
  }

  // ───────────── Ações numa mensagem ─────────────

  private async alvo(conversaId: string, mensagemId: string) {
    const [cv] = await this.db.select().from(crmConversas).where(eq(crmConversas.id, conversaId));
    const [m] = await this.db.select().from(crmMensagens).where(and(eq(crmMensagens.id, mensagemId), eq(crmMensagens.conversaId, conversaId)));
    if (!cv || !m) throw new NotFoundException('Mensagem não encontrada.');
    if (m.direcao === 'interna' || !m.idExterno) throw new BadRequestException('Esta mensagem não foi para o WhatsApp.');
    if (m.apagadaEm) throw new BadRequestException('Esta mensagem foi apagada.');
    const canal = await this.obter(cv.canalId);
    if (!canal.ativo) throw new BadRequestException('Este número de WhatsApp está desativado.');
    const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, cv.contatoId));
    return { m, canal, contato };
  }

  /** Reage com um emoji (vazio tira a reação). */
  async reagir(conversaId: string, mensagemId: string, emoji: string) {
    const { m, canal, contato } = await this.alvo(conversaId, mensagemId);
    const con = this.conexao(canal);
    if (!con.reagir) throw new BadRequestException('Este tipo de número não manda reação.');
    try {
      await con.reagir(contato.telefone, { idExterno: m.idExterno!, minha: m.direcao === 'saida' }, emoji);
    } catch (e) {
      throw e instanceof ErroCanal ? new BadRequestException(e.message) : e;
    }
    const reacoes = [...m.reacoes.filter((x) => x.de !== 'equipe'), ...(emoji ? [{ de: 'equipe', emoji } as const] : [])];
    await this.db.update(crmMensagens).set({ reacoes }).where(eq(crmMensagens.id, m.id));
    return { ok: true, reacoes };
  }

  /** Apaga para todos uma mensagem que a equipe mandou. */
  async apagarMensagem(conversaId: string, mensagemId: string) {
    const { m, canal, contato } = await this.alvo(conversaId, mensagemId);
    if (m.direcao !== 'saida') throw new BadRequestException('Só dá para apagar mensagens enviadas por vocês.');
    const con = this.conexao(canal);
    if (!con.apagar) throw new BadRequestException('O WhatsApp oficial (Meta) não deixa apagar mensagem enviada.');
    // O WhatsApp só apaga para todos por um tempo (cerca de 2 dias).
    if (Date.now() - m.criadoEm.getTime() > 48 * 3600_000) throw new BadRequestException('O WhatsApp só deixa apagar para todos até 2 dias depois do envio.');
    try {
      await con.apagar(contato.telefone, { idExterno: m.idExterno!, minha: true });
    } catch (e) {
      throw e instanceof ErroCanal ? new BadRequestException(e.message) : e;
    }
    await this.db.update(crmMensagens).set({ apagadaEm: new Date() }).where(eq(crmMensagens.id, m.id));
    return { ok: true };
  }

  /** Mensagem automática para um telefone (régua de cobrança): abre a conversa se não houver, sem tirar ninguém da fila. */
  async enviarParaTelefone(d: { canalId: string; telefone: string; nome?: string | null; texto: string; templateId?: string | null }) {
    const contato = await this.crm.garantirContato({ telefone: d.telefone, nome: d.nome });
    if (contato.descadastrado) throw new BadRequestException('O contato pediu para não receber mensagens.');
    const cv = await this.garantirConversa(contato.id, d.canalId, 'resolvida');
    return this.enviar({ conversaId: cv.id, tipo: d.templateId ? 'template' : 'texto', texto: d.texto, templateId: d.templateId ?? undefined });
  }

  /** Conversa nova com um telefone qualquer (que pode nem estar no CRM): já fica com quem abriu. */
  async novaConversa(d: { canalId: string; telefone: string; nome?: string | null; usuarioId: string; gestor: boolean }) {
    const canal = await this.obter(d.canalId);
    if (!canal.ativo || canal.excluidoEm) throw new BadRequestException('Este número de WhatsApp está desativado.');
    if (!this.podeAtender(canal, d.usuarioId, d.gestor)) throw new ForbiddenException('Você não atende por este número.');
    const contato = await this.crm.garantirContato({ telefone: d.telefone, nome: d.nome });
    const cv = await this.garantirConversa(contato.id, canal.id, 'resolvida');
    // Em atendimento com outra pessoa: não toma a conversa, só abre.
    if (cv.status === 'atendimento' && cv.atendenteId && cv.atendenteId !== d.usuarioId) return { ...cv, contato: contato.nome, comOutro: true };
    const [minha] = await this.db.update(crmConversas).set({ status: 'atendimento', atendenteId: d.usuarioId, pegaEm: new Date(), ultimaMensagemEm: cv.ultimaMensagemEm ?? new Date() }).where(eq(crmConversas.id, cv.id)).returning();
    return { ...minha, contato: contato.nome, comOutro: false };
  }

  private async entrada(c: Canal, con: Conexao, m: MensagemEntrada) {
    const [dup] = await this.db.select({ id: crmMensagens.id }).from(crmMensagens).where(eq(crmMensagens.idExterno, m.idExterno)).limit(1);
    if (dup) return;
    // Número recebendo o histórico (acabou de ler o QR para importar): mensagem antiga só entra no histórico,
    // sem voltar para a fila, sem card e sem IA.
    if (m.quando.getTime() < Date.now() - 30 * 60_000) {
      const [sinc] = await this.db.select({ id: crmImportacoes.id }).from(crmImportacoes).where(and(eq(crmImportacoes.canalId, c.id), inArray(crmImportacoes.status, ['aguardando_qr', 'recebendo']))).limit(1);
      if (sinc) {
        await this.gravarDoHistorico(c, con, m, false);
        return;
      }
    }
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
    // O WhatsApp marca a hora em segundos inteiros: uma mensagem que chega logo depois de uma resposta
    // ficaria "antes" dela na conversa. Mensagem que acabou de chegar nunca entra atrás da última.
    if (cv.ultimaMensagemEm && m.quando <= cv.ultimaMensagemEm && Date.now() - m.quando.getTime() < 60_000) m.quando = new Date(cv.ultimaMensagemEm.getTime() + 1);
    const citada = m.citaIdExterno ? await this.mensagemDoCanal(c.id, m.citaIdExterno) : null;
    const [nova] = await this.db.insert(crmMensagens).values({
      citadaId: citada && citada.conversaId === cv.id ? citada.id : null,
      conversaId: cv.id,
      direcao: m.minha ? 'saida' : 'entrada',
      tipo: m.tipo,
      texto,
      midia,
      midiaNome: m.midia?.nome ?? null,
      status: m.minha ? 'enviada' : 'recebida',
      idExterno: m.idExterno,
      criadoEm: m.quando,
    }).returning({ id: crmMensagens.id });
    if (m.tipo === 'audio' && midia) this.transcricao.aoChegar(nova.id, cv.id);
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
        // Atendimento novo: a IA pode atender de novo, mesmo que tenha passado a vez da outra vez.
        ...(voltaFila && cv.iaAtiva === false ? { iaAtiva: null, iaRespostas: 0, iaAgenteId: null, iaTransferencias: 0 } : {}),
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
    this.crm.emitir({ tipo: 'conversa_entrada', conversaId: cv.id });
  }

  /**
   * Grava uma mensagem antiga (importação do histórico): fica na conversa para consulta, sem mexer na fila,
   * sem contar como não lida, sem criar card e sem acionar IA ou gatilhos. Devolve null se já existia.
   */
  async gravarDoHistorico(c: Canal, con: Conexao, m: MensagemEntrada, baixarMidias: boolean) {
    const [dup] = await this.db.select({ id: crmMensagens.id }).from(crmMensagens).where(eq(crmMensagens.idExterno, m.idExterno)).limit(1);
    if (dup) return null;
    const contato = await this.crm.garantirContato({ telefone: m.telefone, nome: m.minha ? null : m.nome });
    const [ja] = await this.db.select().from(crmConversas).where(and(eq(crmConversas.contatoId, contato.id), eq(crmConversas.canalId, c.id)));
    const cv = ja ?? (await this.garantirConversa(contato.id, c.id, 'resolvida'));
    let midia: string | null = null;
    let texto = m.texto;
    if (m.midia && baixarMidias) {
      try {
        const b = await con.baixarMidia(m.midia.ref);
        if (b.conteudo.length > 25_000_000) throw new Error('arquivo grande demais');
        midia = await this.arquivos.salvarMidia(b.conteudo, m.midia.mime ?? b.mime);
      } catch {
        texto = [texto, '[mídia antiga não disponível]'].filter(Boolean).join(' ');
      }
    } else if (m.midia) {
      const nome = { imagem: 'foto', audio: 'áudio', video: 'vídeo', documento: 'documento' }[m.tipo as string] ?? 'arquivo';
      texto = [texto, `[${nome} do histórico${m.midia.nome ? `: ${m.midia.nome}` : ''}]`].filter(Boolean).join(' ');
    }
    const citada = m.citaIdExterno ? await this.mensagemDoCanal(c.id, m.citaIdExterno) : null;
    await this.db.insert(crmMensagens).values({
      citadaId: citada && citada.conversaId === cv.id ? citada.id : null,
      conversaId: cv.id,
      direcao: m.minha ? 'saida' : 'entrada',
      tipo: midia || !m.midia ? m.tipo : 'texto',
      texto,
      midia,
      midiaNome: midia ? (m.midia?.nome ?? null) : null,
      status: m.minha ? 'enviada' : 'recebida',
      idExterno: m.idExterno,
      criadoEm: m.quando,
    });
    // A conversa só mostra esta como "última" se ela for mais nova do que a que já estava lá.
    const resumo = (texto ?? `[${m.tipo}]`).slice(0, 200);
    await this.db
      .update(crmConversas)
      .set({ ultimaMensagem: resumo, ultimaMensagemEm: m.quando, ...(m.minha ? {} : { ultimaEntradaEm: m.quando }) })
      .where(and(eq(crmConversas.id, cv.id), sql`(${crmConversas.ultimaMensagemEm} is null or ${crmConversas.ultimaMensagemEm} < ${m.quando})`));
    return { conversaNova: !ja, conversaId: cv.id };
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
