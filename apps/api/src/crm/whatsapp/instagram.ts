import { createHmac, timingSafeEqual } from 'node:crypto';
import { ErroCanal, type Conexao, type MensagemEntrada, type MensagemSaida, type StatusEntrada } from './tipos';

export interface ConfigInstagram {
  /** Id da conta profissional do Instagram (IG User ID). */
  igId: string;
  /** Token de acesso (da página do Facebook ligada ao Instagram, ou token do login do Instagram, que começa com "IG"). */
  token: string;
  appSecret?: string;
}

/** O Instagram identifica a pessoa por um id próprio (IGSID): no CRM o contato fica como "ig:<id>". */
export const PREFIXO_IG = 'ig:';
export const ehContatoInstagram = (telefone: string | null | undefined) => !!telefone?.startsWith(PREFIXO_IG);

const baseFacebook = () => (process.env.META_INSTAGRAM_URL ?? 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
const baseInstagram = () => (process.env.META_INSTAGRAM_URL ?? 'https://graph.instagram.com/v21.0').replace(/\/$/, '');

/** Direct do Instagram pela API oficial da Meta (Messenger Platform para Instagram). */
export class ConexaoInstagram implements Conexao {
  constructor(private readonly c: ConfigInstagram) {}

  private get base() {
    return this.c.token.startsWith('IG') ? baseInstagram() : baseFacebook();
  }

  private async chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
    const sep = caminho.includes('?') ? '&' : '?';
    const res = await fetch(`${this.base}/${caminho}${sep}access_token=${encodeURIComponent(this.c.token)}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
    if (!res.ok) {
      const msg = j.error?.message ?? `a Meta respondeu ${res.status}`;
      if (j.error?.code === 10 || j.error?.error_subcode === 2534022 || /outside of allowed window|24 hours/i.test(msg)) throw new ErroCanal('Fora da janela de 24h: no Instagram só dá para responder quem mandou mensagem nas últimas 24 horas.');
      throw new ErroCanal(`Instagram: ${msg}`);
    }
    return j;
  }

  async enviar(m: MensagemSaida) {
    const para = m.para.startsWith(PREFIXO_IG) ? m.para.slice(PREFIXO_IG.length) : m.para;
    if (m.tipo !== 'texto') throw new ErroCanal('No Instagram, por enquanto o CRM manda só texto. Mande a foto ou o arquivo pelo app do Instagram.');
    const r = await this.chamar<{ message_id?: string }>(`${this.c.igId}/messages`, { method: 'POST', body: JSON.stringify({ recipient: { id: para }, message: { text: (m.texto ?? '').slice(0, 1000) } }) });
    if (!r.message_id) throw new ErroCanal('A Meta não devolveu o id da mensagem.');
    return { idExterno: r.message_id };
  }

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
    const apagadas: string[] = [];
    const entradas = ((corpo as { entry?: unknown[] })?.entry ?? []) as { messaging?: Record<string, any>[] }[];
    for (const e of entradas) {
      for (const ev of e.messaging ?? []) {
        const m = ev.message as Record<string, any> | undefined;
        if (!m?.mid) continue;
        if (m.is_deleted) {
          apagadas.push(String(m.mid));
          continue;
        }
        const minha = !!m.is_echo;
        const outro = String(minha ? ev.recipient?.id : ev.sender?.id);
        const anexo = (m.attachments as Record<string, any>[] | undefined)?.[0];
        const mapa: Record<string, MensagemEntrada['tipo']> = { image: 'imagem', video: 'video', audio: 'audio', file: 'documento', story_mention: 'imagem', share: 'outro', ig_reel: 'video', reel: 'video' };
        const tipo: MensagemEntrada['tipo'] = anexo ? (mapa[anexo.type] ?? 'outro') : 'texto';
        const ref = m.referral ?? ev.referral;
        mensagens.push({
          telefone: `${PREFIXO_IG}${outro}`,
          nome: null,
          idExterno: String(m.mid),
          minha,
          tipo,
          texto: m.text ?? (anexo?.type === 'story_mention' ? '[mencionou vocês no story]' : anexo?.type === 'share' ? `[compartilhou uma publicação] ${anexo.payload?.url ?? ''}`.trim() : anexo && !mapa[anexo.type] ? `[${anexo.type}]` : null),
          midia: anexo?.payload?.url && ['image', 'video', 'audio', 'file', 'story_mention', 'ig_reel', 'reel'].includes(anexo.type) ? { ref: String(anexo.payload.url), mime: null, nome: null } : undefined,
          quando: new Date(Number(ev.timestamp ?? Date.now())),
          citaIdExterno: m.reply_to?.mid ? String(m.reply_to.mid) : undefined,
          referencia: ref ? (Object.fromEntries(Object.entries({ utm_source: 'meta_ads', utm_medium: 'instagram_direct', anuncio_id: ref.ad_id ?? ref.source_id, origem: ref.source ?? ref.type }).filter(([, v]) => v)) as Record<string, string>) : undefined,
        });
      }
    }
    return { mensagens, status, apagadas };
  }

  /** Nome e @ do contato (a Meta só manda o id na mensagem). */
  async perfil(igsid: string): Promise<{ nome: string | null; usuario: string | null }> {
    try {
      const r = await this.chamar<{ name?: string; username?: string }>(`${igsid.replace(PREFIXO_IG, '')}?fields=name,username`);
      return { nome: r.name ?? null, usuario: r.username ?? null };
    } catch {
      return { nome: null, usuario: null };
    }
  }

  async baixarMidia(ref: string) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ErroCanal(`Não foi possível baixar a mídia (${res.status}).`);
    return { conteudo: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  async situacao() {
    try {
      const r = await this.chamar<{ username?: string; name?: string }>(`${this.c.igId}?fields=username,name`);
      return { conectado: true, detalhe: `Instagram @${r.username ?? '?'}${r.name ? ` · ${r.name}` : ''}`, numero: null };
    } catch (e) {
      return { conectado: false, detalhe: (e as Error).message };
    }
  }
}
