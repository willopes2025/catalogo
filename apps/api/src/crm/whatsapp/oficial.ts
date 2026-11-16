import { createHmac, timingSafeEqual } from 'node:crypto';
import { ErroCanal, type AlvoMensagem, type Conexao, type MensagemEntrada, type MensagemSaida, type ReacaoEntrada, type StatusEntrada, type TemplateRemoto } from './tipos';

export interface ConfigOficial {
  phoneNumberId: string;
  wabaId: string;
  token: string;
  appSecret?: string;
}

const base = () => (process.env.META_WHATSAPP_URL ?? 'https://graph.facebook.com/v21.0').replace(/\/$/, '');

/** WhatsApp oficial (API Cloud da Meta). */
export class ConexaoOficial implements Conexao {
  constructor(private readonly c: ConfigOficial) {}

  private async chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base()}/${caminho}`, { ...init, headers: { authorization: `Bearer ${this.c.token}`, ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
    if (!res.ok) {
      const msg = j.error?.message ?? `a Meta respondeu ${res.status}`;
      if (j.error?.code === 131047 || /24 hours|re-engagement/i.test(msg)) throw new ErroCanal('Fora da janela de 24h: o contato não falou com vocês nas últimas 24 horas. Use um template aprovado.');
      throw new ErroCanal(`WhatsApp oficial: ${msg}`);
    }
    return j;
  }

  private async subirMidia(m: NonNullable<MensagemSaida['midia']>) {
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', m.mime);
    fd.append('file', new Blob([new Uint8Array(m.conteudo)], { type: m.mime }), m.nome);
    const r = await this.chamar<{ id: string }>(`${this.c.phoneNumberId}/media`, { method: 'POST', body: fd });
    return r.id;
  }

  async enviar(m: MensagemSaida) {
    const corpo: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.para, ...(m.citar && m.tipo !== 'template' ? { context: { message_id: m.citar.idExterno } } : {}) };
    if (m.tipo === 'texto') Object.assign(corpo, { type: 'text', text: { body: m.texto ?? '', preview_url: true } });
    else if (m.tipo === 'template') {
      const t = m.template!;
      Object.assign(corpo, {
        type: 'template',
        template: { name: t.nome, language: { code: t.idioma }, components: t.parametros.length ? [{ type: 'body', parameters: t.parametros.map((p) => ({ type: 'text', text: p || '-' })) }] : [] },
      });
    } else {
      const id = await this.subirMidia(m.midia!);
      const tipo = { imagem: 'image', audio: 'audio', video: 'video', documento: 'document' }[m.tipo];
      Object.assign(corpo, { type: tipo, [tipo]: { id, ...(m.texto && m.tipo !== 'audio' ? { caption: m.texto } : {}), ...(m.tipo === 'documento' ? { filename: m.midia!.nome } : {}) } });
    }
    const r = await this.chamar<{ messages?: { id: string }[] }>(`${this.c.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify(corpo) });
    const id = r.messages?.[0]?.id;
    if (!id) throw new ErroCanal('A Meta não devolveu o id da mensagem.');
    return { idExterno: id };
  }

  async reagir(para: string, alvo: AlvoMensagem, emoji: string) {
    await this.chamar(`${this.c.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'reaction', reaction: { message_id: alvo.idExterno, emoji } }) });
  }

  /** Confere a assinatura X-Hub-Signature-256 (quando o App Secret foi informado). */
  assinaturaValida(bruto: Buffer | undefined, assinatura: string | undefined) {
    if (!this.c.appSecret) return true;
    if (!bruto || !assinatura?.startsWith('sha256=')) return false;
    const esperado = Buffer.from(`sha256=${createHmac('sha256', this.c.appSecret).update(bruto).digest('hex')}`);
    const recebido = Buffer.from(assinatura);
    return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  }

  ler(corpo: unknown) {
    const mensagens: MensagemEntrada[] = [];
    const status: StatusEntrada[] = [];
    const reacoes: ReacaoEntrada[] = [];
    const entradas = ((corpo as { entry?: unknown[] })?.entry ?? []) as { changes?: { value?: Record<string, unknown> }[] }[];
    for (const e of entradas) {
      for (const ch of e.changes ?? []) {
        const v = ch.value ?? {};
        const nomes = new Map(((v.contacts as { wa_id: string; profile?: { name?: string } }[]) ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
        for (const m of (v.messages as Record<string, any>[]) ?? []) {
          const tipo = m.type as string;
          if (tipo === 'reaction') {
            if (m.reaction?.message_id) reacoes.push({ idExterno: String(m.reaction.message_id), emoji: String(m.reaction.emoji ?? ''), minha: false });
            continue;
          }
          const cartoes = tipo === 'contacts' ? ((m.contacts as Record<string, any>[]) ?? []).map((c) => `👤 ${c.name?.formatted_name ?? 'Contato'}${c.phones?.[0]?.wa_id || c.phones?.[0]?.phone ? ` · +${String(c.phones[0].wa_id ?? c.phones[0].phone).replace(/\D/g, '')}` : ''}`).join('\n') : null;
          const midiaDe = (o?: Record<string, any>) => (o?.id ? { ref: String(o.id), mime: o.mime_type ?? null, nome: o.filename ?? null } : undefined);
          const mapa: Record<string, MensagemEntrada['tipo']> = { text: 'texto', image: 'imagem', audio: 'audio', voice: 'audio', video: 'video', document: 'documento', sticker: 'imagem', location: 'localizacao', button: 'texto', interactive: 'texto' };
          const texto =
            cartoes ??
            m.text?.body ??
            m.button?.text ??
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            m[tipo]?.caption ??
            (tipo === 'location' ? `📍 ${m.location?.latitude},${m.location?.longitude}${m.location?.name ? ` · ${m.location.name}` : ''}` : null);
          mensagens.push({
            telefone: String(m.from),
            nome: nomes.get(m.from) ?? null,
            idExterno: String(m.id),
            minha: false,
            tipo: cartoes ? 'texto' : (mapa[tipo] ?? 'outro'),
            citaIdExterno: m.context?.id ? String(m.context.id) : undefined,
            texto: texto ?? (mapa[tipo] ? null : `[mensagem do tipo ${tipo}]`),
            midia: ['image', 'audio', 'voice', 'video', 'document', 'sticker'].includes(tipo) ? midiaDe(m[tipo]) : undefined,
            quando: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000),
            referencia: m.referral
              ? Object.fromEntries(
                  Object.entries({
                    utm_source: 'meta_ads',
                    utm_medium: 'clique_para_whatsapp',
                    anuncio_id: m.referral.source_id,
                    anuncio_tipo: m.referral.source_type,
                    anuncio_titulo: m.referral.headline,
                    anuncio_texto: m.referral.body,
                    pagina: m.referral.source_url,
                    ctwa_clid: m.referral.ctwa_clid,
                  }).filter(([, v]) => v),
                ) as Record<string, string>
              : undefined,
          });
        }
        for (const s of (v.statuses as Record<string, any>[]) ?? []) {
          const mapa: Record<string, StatusEntrada['status']> = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
          if (mapa[s.status]) status.push({ idExterno: String(s.id), status: mapa[s.status], erro: s.errors?.[0]?.title ?? s.errors?.[0]?.message });
        }
      }
    }
    return { mensagens, status, reacoes };
  }

  async baixarMidia(ref: string) {
    const info = await this.chamar<{ url: string; mime_type: string }>(ref);
    const res = await fetch(info.url, { headers: { authorization: `Bearer ${this.c.token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ErroCanal(`Não foi possível baixar a mídia (${res.status}).`);
    return { conteudo: Buffer.from(await res.arrayBuffer()), mime: info.mime_type };
  }

  async situacao() {
    try {
      const r = await this.chamar<{ display_phone_number?: string; verified_name?: string; quality_rating?: string }>(`${this.c.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
      return { conectado: true, detalhe: `${r.verified_name ?? ''} ${r.display_phone_number ?? ''}${r.quality_rating ? ` · qualidade ${r.quality_rating}` : ''}`.trim(), numero: r.display_phone_number?.replace(/\D/g, '') ?? null };
    } catch (e) {
      return { conectado: false, detalhe: (e as Error).message };
    }
  }

  async templates(): Promise<TemplateRemoto[]> {
    const out: TemplateRemoto[] = [];
    let caminho: string | null = `${this.c.wabaId}/message_templates?limit=200&fields=name,language,status,category,components`;
    for (let i = 0; caminho && i < 20; i++) {
      const r: { data?: Record<string, any>[]; paging?: { next?: string } } = await this.chamar(caminho);
      for (const t of r.data ?? []) {
        const corpo = (t.components ?? []).find((c: Record<string, any>) => c.type === 'BODY');
        const texto = String(corpo?.text ?? '');
        out.push({ nome: t.name, idioma: t.language, categoria: t.category ?? null, status: t.status, texto, componentes: t.components ?? null, variaveis: new Set(texto.match(/\{\{\d+\}\}/g) ?? []).size });
      }
      caminho = r.paging?.next ? r.paging.next.replace(/^https?:\/\/[^/]+\/v[\d.]+\//, '') : null;
    }
    return out;
  }
}
