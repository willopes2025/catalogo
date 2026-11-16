import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { SegredosService } from '../segredos/segredos.service';
import { CrmService } from '../crm/crm.service';
import { normalizarTelefone } from '../crm/telefone';
import { urlPublica } from '../comum/url';
import { candidaturas, crmFunis, metaLeads, pessoas, produtos, saldos } from '../db/schema';

type Json = Record<string, any>;
export type Nivel = 'campaign' | 'adset' | 'ad';
export type OrigemPublico = 'clientes' | 'representantes' | 'candidatas';

const NOMES_ORIGEM: Record<OrigemPublico, string> = { clientes: 'Clientes', representantes: 'Representantes ativas', candidatas: 'Candidatas' };
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const centavosDe = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const numero = (v: unknown) => Number(v ?? 0) || 0;

/** O Meta recusou. `permissao` diz qual permissão falta no token, quando é esse o caso. */
export class ErroMeta extends Error {
  constructor(mensagem: string, public readonly status: number, public readonly codigo?: number, public readonly permissao?: string) {
    super(mensagem);
  }
}

/**
 * Tudo que o sistema faz no Meta (Facebook e Instagram) com o token do usuário do sistema:
 * campanhas e resultados, pausar e orçamento, catálogo de produtos, públicos, leads de formulário e a página.
 */
@Injectable()
export class MetaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Meta');
  private timer?: NodeJS.Timeout;
  private tokenPagina: { id: string; token: string; ate: number } | null = null;

  constructor(@Inject(DB) private readonly db: Db, private readonly segredos: SegredosService, private readonly crm: CrmService) {}

  onModuleInit() {
    // Leads de formulário entram sozinhos quando a opção está ligada.
    if (process.env.META_LEADS_AUTOMATICO !== '0') this.timer = setInterval(() => void this.importarLeadsAgendado(), 10 * 60_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ───── Configuração ─────

  get token() {
    return this.segredos.v('META_ADS_TOKEN');
  }
  get conta() {
    return (this.segredos.v('META_ADS_CONTA') ?? '').replace(/^act_/, '').trim();
  }
  get config() {
    return {
      conta: this.conta ? `act_${this.conta}` : null,
      paginaId: this.segredos.v('META_PAGINA_ID') ?? null,
      catalogoId: this.segredos.v('META_CATALOGO_ID') ?? null,
      catalogoLink: this.segredos.v('META_CATALOGO_LINK') ?? null,
      leadsFunilId: this.segredos.v('META_LEADS_FUNIL') ?? null,
      leadsAuto: this.segredos.v('META_LEADS_AUTO') === '1',
    };
  }

  private base() {
    return (process.env.META_ADS_URL ?? 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
  }

  /** Chama a Graph API. `token` troca o do sistema pelo da página (leads e publicações). */
  private async chamar<T = Json>(caminho: string, o: { metodo?: 'GET' | 'POST'; params?: Record<string, unknown>; token?: string } = {}): Promise<T> {
    const token = o.token ?? this.token;
    if (!token) throw new ServiceUnavailableException({ mensagem: 'Preencha o token do Meta em Configurações › Integrações › Meta Ads.' });
    const metodo = o.metodo ?? 'GET';
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(o.params ?? {})) if (v !== undefined && v !== null) params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const url = /^https?:/.test(caminho) ? caminho : `${this.base()}/${caminho.replace(/^\//, '')}${metodo === 'GET' && params.size ? `?${params}` : ''}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(metodo === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: metodo === 'POST' ? params : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ErroMeta(`Não deu para falar com o Meta agora (${(e as Error).message}).`, 503);
    }
    const j = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || j.error) {
      const e = (j.error ?? {}) as { message?: string; code?: number; error_user_msg?: string };
      const texto = e.error_user_msg || e.message || String(res.status);
      // (#200) Requires leads_retrieval permission…  |  (#10) … requires the 'ads_management' permission
      const falta = /\b(ads_management|ads_read|business_management|catalog_management|pages_manage_ads|pages_read_engagement|pages_show_list|leads_retrieval|pages_manage_metadata|read_insights)\b/.exec(texto)?.[1];
      if (e.code === 190) throw new ErroMeta('O token do Meta venceu ou foi revogado. Gere outro no Gerenciador de Negócios e cole em Configurações › Integrações.', 503, 190);
      if (falta && (e.code === 200 || e.code === 10 || e.code === 3 || res.status === 403)) throw new ErroMeta(`O token não tem a permissão "${falta}". Adicione essa permissão ao app no Meta e gere o token de novo.`, 503, e.code, falta);
      throw new ErroMeta(`O Meta recusou: ${texto}`, res.status >= 500 ? 503 : 400, e.code);
    }
    return j as T;
  }

  /** Segue as páginas de uma listagem (até `max` itens). */
  private async todos<T = Json>(caminho: string, params: Record<string, unknown>, o: { token?: string; max?: number } = {}): Promise<T[]> {
    const max = o.max ?? 2000;
    const itens: T[] = [];
    let r = await this.chamar<{ data?: T[]; paging?: { next?: string } }>(caminho, { params: { limit: 200, ...params }, token: o.token });
    for (let p = 0; p < 40; p++) {
      itens.push(...(r.data ?? []));
      if (!r.paging?.next || itens.length >= max) break;
      r = await this.chamar(r.paging.next, { token: o.token });
    }
    return itens.slice(0, max);
  }

  private exigirConta() {
    if (!this.conta) throw new BadRequestException({ mensagem: 'Escolha a conta de anúncios em Marketing › Meta › Configurar.' });
    return `act_${this.conta}`;
  }

  /** O que o token enxerga: permissões, contas de anúncio, páginas e catálogos (para escolher numa lista). */
  async opcoes() {
    const tentar = async <T>(f: () => Promise<T>, vazio: T): Promise<{ v: T; erro: string | null }> => {
      try {
        return { v: await f(), erro: null };
      } catch (e) {
        if (e instanceof ErroMeta && e.codigo === 190) throw e;
        return { v: vazio, erro: (e as Error).message };
      }
    };
    const perms = await tentar(() => this.todos<{ permission: string; status: string }>('me/permissions', {}), []);
    const contas = await tentar(() => this.todos<Json>('me/adaccounts', { fields: 'account_id,name,currency,account_status,business' }), []);
    const paginas = await tentar(() => this.todos<Json>('me/accounts', { fields: 'id,name' }), []);
    // Catálogos ficam no portfólio empresarial: acha os portfólios pelo token e pelas contas de anúncio.
    const negocios = new Map<string, string>();
    for (const n of (await tentar(() => this.todos<Json>('me/businesses', { fields: 'id,name' }), [])).v) negocios.set(n.id, n.name);
    for (const c of contas.v) if (c.business?.id) negocios.set(c.business.id, c.business.name ?? 'Portfólio');
    const catalogos: { id: string; nome: string; negocio: string }[] = [];
    let erroCatalogo: string | null = null;
    for (const [id, nome] of negocios) {
      const r = await tentar(() => this.todos<Json>(`${id}/owned_product_catalogs`, { fields: 'id,name' }), []);
      if (r.erro) erroCatalogo = r.erro;
      for (const c of r.v) catalogos.push({ id: c.id, nome: c.name, negocio: nome });
    }
    return {
      permissoes: perms.v.filter((p) => p.status === 'granted').map((p) => p.permission).sort(),
      contas: contas.v.map((c) => ({ id: `act_${c.account_id}`, nome: c.name, moeda: c.currency, ativa: c.account_status === 1 })),
      paginas: paginas.v.map((p) => ({ id: p.id, nome: p.name })),
      catalogos,
      avisos: [contas.erro && `Contas de anúncio: ${contas.erro}`, paginas.erro && `Páginas: ${paginas.erro}`, erroCatalogo && `Catálogos: ${erroCatalogo}`].filter(Boolean) as string[],
    };
  }

  async funis() {
    return this.db.select({ id: crmFunis.id, nome: crmFunis.nome }).from(crmFunis).where(eq(crmFunis.ativo, true)).orderBy(crmFunis.ordem);
  }

  // ───── Campanhas: resultados, pausar e orçamento ─────

  async painel(de: string, ate: string, nivel: Nivel, paiId?: string) {
    const conta = this.exigirConta();
    const lista = nivel === 'campaign' ? 'campaigns' : nivel === 'adset' ? 'adsets' : 'ads';
    const camposObj = nivel === 'ad' ? 'id,name,status,effective_status,adset_id,campaign_id' : nivel === 'adset' ? 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id' : 'id,name,status,effective_status,daily_budget,lifetime_budget,objective';
    const filtro = paiId ? [{ field: nivel === 'ad' ? 'adset.id' : 'campaign.id', operator: 'EQUAL', value: paiId }] : undefined;
    const raiz = paiId && nivel !== 'campaign' ? `${paiId}/${lista}` : `${conta}/${lista}`;
    const [objetos, insights] = await Promise.all([
      this.todos<Json>(raiz, { fields: camposObj, effective_status: ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'WITH_ISSUES', 'IN_PROCESS', 'PENDING_REVIEW'] }),
      this.todos<Json>(`${conta}/insights`, { level: nivel, fields: `${nivel}_id,${nivel}_name,spend,impressions,reach,clicks,inline_link_clicks,actions`, time_range: { since: de, until: ate }, ...(filtro ? { filtering: filtro } : {}) }),
    ]);
    const porId = new Map(insights.map((i) => [String(i[`${nivel}_id`]), i]));
    const acao = (i: Json | undefined, tipos: string[]) => {
      for (const t of tipos) {
        const a = (i?.actions as { action_type: string; value: string }[] | undefined)?.find((x) => x.action_type === t);
        if (a) return numero(a.value);
      }
      return 0;
    };
    const ids = new Set(objetos.map((o) => String(o.id)));
    // Campanhas arquivadas ou apagadas que ainda gastaram no período entram só com os números.
    const soNumeros = insights.filter((i) => !ids.has(String(i[`${nivel}_id`]))).map((i) => ({ id: String(i[`${nivel}_id`]), name: i[`${nivel}_name`], status: 'ARCHIVED', effective_status: 'ARCHIVED' }) as Json);
    const linhas = [...objetos, ...soNumeros].map((o) => {
      const i = porId.get(String(o.id));
      const gasto = centavosDe(i?.spend);
      const cliques = numero(i?.inline_link_clicks) || numero(i?.clicks);
      const leads = acao(i, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
      const conversas = acao(i, ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection']);
      const impressoes = numero(i?.impressions);
      return {
        id: String(o.id), nome: o.name as string, status: o.status as string, situacao: (o.effective_status ?? o.status) as string, objetivo: (o.objective as string) ?? null,
        orcamentoDiario: o.daily_budget ? Number(o.daily_budget) : null, orcamentoTotal: o.lifetime_budget ? Number(o.lifetime_budget) : null,
        gasto, impressoes, alcance: numero(i?.reach), cliques, leads, conversas,
        ctr: impressoes ? Math.round((cliques / impressoes) * 10000) / 100 : null,
        custoPorClique: cliques ? Math.round(gasto / cliques) : null,
        custoPorLead: leads ? Math.round(gasto / leads) : null,
        custoPorConversa: conversas ? Math.round(gasto / conversas) : null,
      };
    });
    linhas.sort((a, b) => Number(b.situacao === 'ACTIVE') - Number(a.situacao === 'ACTIVE') || b.gasto - a.gasto || a.nome.localeCompare(b.nome));
    const soma = (k: 'gasto' | 'impressoes' | 'cliques' | 'leads' | 'conversas') => linhas.reduce((s, l) => s + l[k], 0);
    return { linhas, totais: { gasto: soma('gasto'), impressoes: soma('impressoes'), cliques: soma('cliques'), leads: soma('leads'), conversas: soma('conversas'), ativas: linhas.filter((l) => l.situacao === 'ACTIVE').length } };
  }

  /** Só mexe em campanha, conjunto ou anúncio da conta escolhida (nunca em outra conta que o token alcance). */
  private async conferirDono(id: string) {
    const o = await this.chamar<Json>(id, { params: { fields: 'id,name,account_id,status,daily_budget,lifetime_budget' } });
    if (String(o.account_id ?? '') !== this.conta) throw new BadRequestException({ mensagem: 'Este item não é da conta de anúncios escolhida no sistema.' });
    return o;
  }

  async mudarStatus(id: string, status: 'ACTIVE' | 'PAUSED') {
    const antes = await this.conferirDono(id);
    await this.chamar(id, { metodo: 'POST', params: { status } });
    return { id, nome: antes.name as string, de: antes.status as string, para: status };
  }

  async mudarOrcamento(id: string, diario: number) {
    const antes = await this.conferirDono(id);
    if (!antes.daily_budget) throw new BadRequestException({ mensagem: antes.lifetime_budget ? 'Este item usa orçamento total (não diário). Mude pelo Gerenciador de Anúncios.' : 'O orçamento desta campanha fica nos conjuntos de anúncios. Abra a campanha e mude no conjunto.' });
    await this.chamar(id, { metodo: 'POST', params: { daily_budget: String(diario) } });
    return { id, nome: antes.name as string, de: Number(antes.daily_budget), para: diario };
  }

  // ───── Catálogo de produtos ─────

  /** Manda produtos, fotos, preços e estoque para o catálogo do Meta (loja do Instagram, anúncios de catálogo, WhatsApp). */
  async sincronizarCatalogo() {
    const { catalogoId, catalogoLink } = this.config;
    if (!catalogoId) throw new BadRequestException({ mensagem: 'Escolha o catálogo em Marketing › Meta › Configurar.' });
    if (!catalogoLink || !/^https:\/\//.test(catalogoLink)) throw new BadRequestException({ mensagem: 'Preencha o endereço (https://…) para onde o produto leva quem clica, em Marketing › Meta › Configurar.' });
    const linhas = await this.db
      .select({ id: produtos.id, referencia: produtos.referencia, descricao: produtos.descricao, completa: produtos.descricaoCompleta, preco: produtos.preco, fotos: produtos.fotos, ativo: produtos.ativo, exibe: produtos.exibeCatalogo, ean: produtos.ean, estoque: sql<number>`coalesce((select sum(${saldos.quantidade}) from ${saldos} where ${saldos.produtoId} = ${produtos.id}), 0)::int` })
      .from(produtos);
    const sep = catalogoLink.includes('?') ? '&' : '?';
    // As fotos do sistema ficam guardadas como /api/fotos/…: o Meta precisa do endereço completo para baixar.
    const raiz = urlPublica();
    const fotosDe = (p: { fotos: string[] | null }) => (p.fotos ?? []).map((f) => (f.startsWith('/') ? `${raiz}${f}` : f)).filter((f) => /^https?:\/\//.test(f));
    const semFoto = linhas.filter((p) => p.ativo && p.exibe && !fotosDe(p).length).length;
    const enviar = linhas.filter((p) => p.ativo && p.exibe && p.preco > 0 && fotosDe(p).length);
    const tirar = linhas.filter((p) => !p.ativo || !p.exibe);
    const pedidos: Json[] = [
      ...enviar.map((p) => {
        const fotos = fotosDe(p);
        return {
          method: 'UPDATE', // cria quando não existe
          data: {
            id: p.referencia, title: p.descricao.slice(0, 150), description: (p.completa || p.descricao).slice(0, 5000),
            availability: p.estoque > 0 ? 'in stock' : 'out of stock', condition: 'new', price: `${(p.preco / 100).toFixed(2)} BRL`,
            link: `${catalogoLink}${sep}produto=${encodeURIComponent(p.referencia)}`, image_link: fotos[0], ...(fotos.length > 1 ? { additional_image_link: fotos.slice(1, 10) } : {}),
            brand: 'Aritana', ...(p.ean ? { gtin: p.ean } : {}), quantity_to_sell_on_facebook: Math.max(0, p.estoque),
          },
        };
      }),
      // Produto desativado ou fora do catálogo some do Meta também.
      ...tirar.map((p) => ({ method: 'DELETE', data: { id: p.referencia } })),
    ];
    const erros: string[] = [];
    for (let i = 0; i < pedidos.length; i += 300) {
      const r = await this.chamar<Json>(`${catalogoId}/items_batch`, { metodo: 'POST', params: { item_type: 'PRODUCT_ITEM', requests: pedidos.slice(i, i + 300) } });
      for (const v of (r.validation_status as { retailer_id?: string; errors?: { message: string }[] }[] | undefined) ?? []) for (const e of v.errors ?? []) erros.push(`${v.retailer_id ?? '?'}: ${e.message}`);
    }
    return { enviados: enviar.length, semEstoque: enviar.filter((p) => p.estoque <= 0).length, retirados: tirar.length, semFoto, erros: erros.slice(0, 20) };
  }

  // ───── Públicos ─────

  /** Telefones e e-mails de quem autorizou o uso dos dados (LGPD). Saem do sistema já embaralhados (SHA-256). */
  private async contatosDe(origem: OrigemPublico) {
    const linhas =
      origem === 'candidatas'
        ? await this.db.select({ telefone: candidaturas.telefone, email: candidaturas.email, ok: candidaturas.consentimentoLgpd }).from(candidaturas)
        : await this.db
            .select({ telefone: pessoas.telefone1, email: pessoas.email, ok: pessoas.consentimentoLgpd })
            .from(pessoas)
            .where(origem === 'clientes' ? eq(pessoas.tipo, 'cliente') : and(eq(pessoas.tipo, 'representante'), eq(pessoas.status, 'ativo')));
    const vistos = new Set<string>();
    const dados: string[][] = [];
    for (const l of linhas.filter((x) => x.ok)) {
      const tel = normalizarTelefone(l.telefone);
      const email = l.email?.trim().toLowerCase() || '';
      if (!tel && !email) continue;
      const chave = `${tel ?? ''}|${email}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      dados.push([tel ? sha(tel) : '', email ? sha(email) : '']);
    }
    return { dados, semAutorizacao: linhas.filter((x) => !x.ok).length };
  }

  async previaPublico(origem: OrigemPublico) {
    const { dados, semAutorizacao } = await this.contatosDe(origem);
    return { origem, comAutorizacao: dados.length, semAutorizacao };
  }

  async publicos() {
    const conta = this.exigirConta();
    const lista = await this.todos<Json>(`${conta}/customaudiences`, { fields: 'id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_updated,operation_status' });
    return lista.map((p) => {
      const origem = /^Aritana:(clientes|representantes|candidatas)$/.exec(p.description ?? '')?.[1] as OrigemPublico | undefined;
      return { id: p.id as string, nome: p.name as string, tipo: p.subtype === 'LOOKALIKE' ? 'semelhante' : origem ? 'sistema' : 'outro', origem: origem ?? null, tamanhoDe: p.approximate_count_lower_bound ?? null, tamanhoAte: p.approximate_count_upper_bound ?? null, atualizadoEm: p.time_updated ? new Date(Number(p.time_updated) * 1000).toISOString() : null, situacao: (p.operation_status?.description as string) ?? null };
    });
  }

  private async enviarContatos(publicoId: string, dados: string[][]) {
    let recebidos = 0;
    for (let i = 0; i < dados.length; i += 5000) {
      const r = await this.chamar<Json>(`${publicoId}/users`, { metodo: 'POST', params: { payload: { schema: ['PHONE', 'EMAIL'], data: dados.slice(i, i + 5000) } } });
      recebidos += numero(r.num_received);
    }
    return recebidos;
  }

  async criarPublico(origem: OrigemPublico, nome?: string) {
    const conta = this.exigirConta();
    const { dados, semAutorizacao } = await this.contatosDe(origem);
    if (dados.length < 100) throw new BadRequestException({ mensagem: `São ${dados.length} contatos com autorização de uso dos dados. O Meta só aceita público com 100 ou mais.` });
    const p = await this.chamar<{ id: string }>(`${conta}/customaudiences`, { metodo: 'POST', params: { name: (nome?.trim() || `Aritana · ${NOMES_ORIGEM[origem]}`).slice(0, 100), subtype: 'CUSTOM', description: `Aritana:${origem}`, customer_file_source: 'USER_PROVIDED_ONLY' } });
    const recebidos = await this.enviarContatos(p.id, dados);
    return { id: p.id, enviados: dados.length, recebidos, semAutorizacao };
  }

  /** Manda de novo quem está no sistema hoje (entra quem é novo; o Meta ignora os repetidos). */
  async atualizarPublico(id: string) {
    const conta = this.exigirConta();
    const p = await this.chamar<Json>(id, { params: { fields: 'id,description,account_id' } });
    const origem = /^Aritana:(clientes|representantes|candidatas)$/.exec(p.description ?? '')?.[1] as OrigemPublico | undefined;
    if (String(p.account_id ?? '') !== conta.replace('act_', '') || !origem) throw new BadRequestException({ mensagem: 'Só dá para atualizar os públicos criados pelo sistema nesta conta.' });
    const { dados, semAutorizacao } = await this.contatosDe(origem);
    return { id, enviados: dados.length, recebidos: await this.enviarContatos(id, dados), semAutorizacao };
  }

  /** Público semelhante: pessoas no Brasil parecidas com as do público de origem. */
  async criarSemelhante(origemId: string, percentual: number) {
    const conta = this.exigirConta();
    const o = await this.chamar<Json>(origemId, { params: { fields: 'id,name,account_id' } });
    if (String(o.account_id ?? '') !== conta.replace('act_', '')) throw new BadRequestException({ mensagem: 'Este público não é da conta de anúncios escolhida.' });
    const p = await this.chamar<{ id: string }>(`${conta}/customaudiences`, { metodo: 'POST', params: { name: `Semelhante ${percentual}% · ${o.name}`.slice(0, 100), subtype: 'LOOKALIKE', origin_audience_id: origemId, lookalike_spec: { type: 'similarity', ratio: percentual / 100, country: 'BR' } } });
    return { id: p.id };
  }

  // ───── Página: leads de formulário e publicações ─────

  private async paginaToken() {
    const { paginaId } = this.config;
    if (!paginaId) throw new BadRequestException({ mensagem: 'Escolha a página em Marketing › Meta › Configurar.' });
    if (this.tokenPagina && this.tokenPagina.id === paginaId && this.tokenPagina.ate > Date.now()) return { id: paginaId, token: this.tokenPagina.token };
    const p = await this.chamar<{ access_token?: string }>(paginaId, { params: { fields: 'access_token' } });
    if (!p.access_token) throw new ErroMeta('O token não tem acesso a esta página. No Gerenciador de Negócios, atribua a página ao usuário do sistema e gere o token de novo.', 503);
    this.tokenPagina = { id: paginaId, token: p.access_token, ate: Date.now() + 30 * 60_000 };
    return { id: paginaId, token: p.access_token };
  }

  async formularios() {
    const pg = await this.paginaToken();
    const lista = await this.todos<Json>(`${pg.id}/leadgen_forms`, { fields: 'id,name,status,leads_count,created_time' }, { token: pg.token, max: 200 });
    const importados = await this.db.select({ formId: metaLeads.formId, n: sql<number>`count(*)::int` }).from(metaLeads).groupBy(metaLeads.formId);
    const n = new Map(importados.map((i) => [i.formId, i.n]));
    return lista.map((f) => ({ id: f.id as string, nome: f.name as string, ativo: f.status === 'ACTIVE', leadsNoMeta: numero(f.leads_count), importados: n.get(f.id) ?? 0, criadoEm: f.created_time as string }));
  }

  /** Traz para o CRM quem preencheu formulário de anúncio. Cada lead entra uma vez só. */
  async importarLeads() {
    const { leadsFunilId } = this.config;
    if (!leadsFunilId) throw new BadRequestException({ mensagem: 'Escolha o funil que recebe os leads em Marketing › Meta › Configurar.' });
    const pg = await this.paginaToken();
    const forms = await this.todos<Json>(`${pg.id}/leadgen_forms`, { fields: 'id,name,status' }, { token: pg.token, max: 200 });
    let novos = 0;
    let semTelefone = 0;
    let repetidos = 0;
    for (const f of forms) {
      // O Meta guarda os leads de formulário por 90 dias.
      const leads = await this.todos<Json>(`${f.id}/leads`, { fields: 'id,created_time,field_data,campaign_name,ad_name,platform' }, { token: pg.token, max: 3000 });
      if (!leads.length) continue;
      const ja = new Set((await this.db.select({ id: metaLeads.leadgenId }).from(metaLeads).where(inArray(metaLeads.leadgenId, leads.map((l) => String(l.id))))).map((x) => x.id));
      for (const l of leads) {
        if (ja.has(String(l.id))) continue;
        const campos = new Map<string, string>(((l.field_data as { name: string; values?: string[] }[]) ?? []).map((c) => [c.name.toLowerCase(), (c.values ?? []).join(', ').trim()]));
        const pegar = (...nomes: string[]) => nomes.map((n) => campos.get(n)).find((v) => v) ?? null;
        const nome = pegar('full_name', 'nome_completo', 'nome', 'name') ?? ([pegar('first_name'), pegar('last_name')].filter(Boolean).join(' ') || null);
        const telefone = pegar('phone_number', 'telefone', 'whatsapp', 'celular', 'phone');
        const email = pegar('email', 'e-mail');
        let leadId: string | null = null;
        try {
          if (!telefone) throw new BadRequestException('sem telefone');
          const contato = await this.crm.garantirContato({ telefone, nome, email });
          const aberto = await this.crm.leadAberto(contato.id, leadsFunilId);
          if (aberto) {
            leadId = aberto.id;
            repetidos++;
          } else {
            const extras: Record<string, string> = {};
            const usados = new Set(['full_name', 'nome_completo', 'nome', 'name', 'first_name', 'last_name', 'phone_number', 'telefone', 'whatsapp', 'celular', 'phone']);
            for (const [k, v] of campos) if (v && !usados.has(k)) extras[k === 'city' || k === 'cidade' ? 'Cidade' : k === 'state' || k === 'estado' ? 'UF' : k === 'email' ? 'E-mail' : k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 60)] = v.slice(0, 300);
            const origem: Record<string, string> = { utm_source: l.platform === 'ig' ? 'instagram' : 'facebook', utm_medium: 'formulario_meta', formulario_meta: String(f.name ?? f.id).slice(0, 120) };
            if (l.campaign_name) origem.utm_campaign = String(l.campaign_name).slice(0, 120);
            if (l.ad_name) origem.utm_content = String(l.ad_name).slice(0, 120);
            const novo = await this.crm.criarLead({ funilId: leadsFunilId, contatoId: contato.id, titulo: nome || telefone, origem, camposExtras: extras });
            leadId = novo.id;
            novos++;
          }
        } catch (e) {
          // Sem telefone ou telefone que não serve para WhatsApp: fica registrado para não tentar de novo a cada rodada.
          semTelefone++;
          this.log.warn(`Lead ${l.id} do formulário "${f.name}" não virou card: ${(e as Error).message}`);
        }
        await this.db.insert(metaLeads).values({ leadgenId: String(l.id), formId: String(f.id), leadId, recebidoEm: l.created_time ? new Date(l.created_time) : new Date() }).onConflictDoNothing();
      }
    }
    return { formularios: forms.length, novos, repetidos, semTelefone };
  }

  private rodando = false;
  private async importarLeadsAgendado() {
    const c = this.config;
    if (this.rodando || !c.leadsAuto || !c.leadsFunilId || !c.paginaId || !this.token) return;
    this.rodando = true;
    try {
      const r = await this.importarLeads();
      if (r.novos) this.log.log(`${r.novos} lead(s) de formulário do Meta entraram no CRM.`);
    } catch (e) {
      this.log.warn(`Leads do Meta: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  async pagina() {
    const pg = await this.paginaToken();
    const [info, posts] = await Promise.all([
      this.chamar<Json>(pg.id, { params: { fields: 'name,fan_count,followers_count,link' }, token: pg.token }),
      this.chamar<{ data?: Json[] }>(`${pg.id}/posts`, { params: { fields: 'id,message,created_time,permalink_url,full_picture,shares,likes.summary(true).limit(0),comments.summary(true).limit(0)', limit: 25 }, token: pg.token }),
    ]);
    const publicacoes = (posts.data ?? []).map((p) => ({ id: p.id as string, texto: ((p.message as string) ?? '').slice(0, 280), em: p.created_time as string, link: (p.permalink_url as string) ?? null, foto: (p.full_picture as string) ?? null, curtidas: numero(p.likes?.summary?.total_count), comentarios: numero(p.comments?.summary?.total_count), compartilhamentos: numero(p.shares?.count) }));
    return { nome: info.name as string, curtidas: numero(info.fan_count), seguidores: numero(info.followers_count), link: (info.link as string) ?? null, publicacoes };
  }
}
