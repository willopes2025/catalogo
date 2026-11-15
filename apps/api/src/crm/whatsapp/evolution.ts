import { ErroCanal, type Conexao, type MensagemEntrada, type MensagemSaida, type StatusEntrada } from './tipos';

/**
 * WhatsApp por QR code no servidor próprio (Evolution API, que roda na mesma VPS, sem porta aberta para a internet).
 * Quem usa só dá um nome ao número e lê o QR: a instância, a chave e o webhook são criados pelo sistema.
 *
 *   EVOLUTION_URL          endereço interno do servidor (na VPS: http://aritana-whatsapp:8080)
 *   EVOLUTION_API_KEY      chave global do servidor (gerada pelo instalador no .env)
 *   EVOLUTION_WEBHOOK_URL  como o servidor de WhatsApp chega na API (na VPS: http://aritana-api:3000)
 */
export const evolutionDisponivel = () => !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_API_KEY);
const base = () => (process.env.EVOLUTION_URL ?? '').replace(/\/$/, '');

/** Eventos que o sistema precisa ouvir. */
const EVENTOS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'];

async function chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  if (!evolutionDisponivel()) throw new ErroCanal('O servidor de WhatsApp por QR code não está instalado nesta VPS. Rode o instalador de novo para ativá-lo.');
  let res: Response;
  try {
    res = await fetch(`${base()}/${caminho}`, { ...init, headers: { 'content-type': 'application/json', apikey: process.env.EVOLUTION_API_KEY ?? '' }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ErroCanal(`O servidor de WhatsApp não respondeu (${(e as Error).message}). Ele pode estar reiniciando; tente de novo em um minuto.`);
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const r = j.response?.message ?? j.message ?? j.error;
    const msg = Array.isArray(r) ? r.map((x) => (typeof x === 'string' ? x : x?.exists === false ? `o número ${x.number ?? ''} não tem WhatsApp` : JSON.stringify(x))).join('; ') : r;
    const erro = new ErroCanal(`WhatsApp: ${msg ?? `respondeu ${res.status}`}`);
    (erro as ErroCanal & { status?: number }).status = res.status;
    throw erro;
  }
  return j as T;
}

/** Nome da instância no servidor, derivado do canal (fixo, para não depender de nada digitado). */
export const nomeInstancia = (canalId: string) => `aritana-${canalId}`;

/** Cria a instância, já com o webhook apontado para o sistema. Devolve o QR inicial. */
export async function criarInstancia(instancia: string, webhook: string) {
  const r = await chamar<{ qrcode?: { base64?: string } }>('instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName: instancia,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: false,
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
      webhook: { url: webhook, byEvents: false, base64: false, events: EVENTOS },
    }),
  });
  return { qrcode: r.qrcode?.base64 ?? null };
}

export async function apagarInstancia(instancia: string) {
  await chamar(`instance/logout/${encodeURIComponent(instancia)}`, { method: 'DELETE' }).catch(() => undefined);
  await chamar(`instance/delete/${encodeURIComponent(instancia)}`, { method: 'DELETE' }).catch(() => undefined);
}

/** Número que veio do WhatsApp: "5527999990000@s.whatsapp.net" → "5527999990000". */
const numeroDoJid = (jid?: string | null) => (jid && /@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0].split(':')[0].replace(/\D/g, '') : '');

export class ConexaoEvolution implements Conexao {
  constructor(private readonly instancia: string, private readonly webhook: string) {}

  private get i() {
    return encodeURIComponent(this.instancia);
  }

  async enviar(m: MensagemSaida) {
    const numero = m.para.replace(/\D/g, '');
    let r: { key?: { id?: string } };
    if (m.tipo === 'texto' || m.tipo === 'template') {
      r = await chamar(`message/sendText/${this.i}`, { method: 'POST', body: JSON.stringify({ number: numero, text: m.texto ?? '' }) });
    } else if (m.tipo === 'audio') {
      r = await chamar(`message/sendWhatsAppAudio/${this.i}`, { method: 'POST', body: JSON.stringify({ number: numero, audio: m.midia!.conteudo.toString('base64') }) });
    } else {
      const mediatype = m.tipo === 'imagem' ? 'image' : m.tipo === 'video' ? 'video' : 'document';
      r = await chamar(`message/sendMedia/${this.i}`, {
        method: 'POST',
        body: JSON.stringify({ number: numero, mediatype, mimetype: m.midia!.mime, caption: m.texto ?? '', media: m.midia!.conteudo.toString('base64'), fileName: m.midia!.nome }),
      });
    }
    const id = r.key?.id;
    if (!id) throw new ErroCanal('O servidor de WhatsApp não devolveu o id da mensagem.');
    return { idExterno: String(id) };
  }

  ler(corpo: unknown) {
    const mensagens: MensagemEntrada[] = [];
    const status: StatusEntrada[] = [];
    const b = (corpo ?? {}) as Record<string, any>;
    const evento = String(b.event ?? '').toLowerCase().replace(/_/g, '.');
    const lista = Array.isArray(b.data) ? b.data : b.data ? [b.data] : [];
    if (evento === 'messages.upsert') {
      for (const d of lista) {
        const k = d.key ?? {};
        const jid: string = k.remoteJid ?? '';
        if (/@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue;
        // Contas novas do WhatsApp chegam com "@lid" (id interno); o número de verdade vem no campo alternativo.
        const telefone = numeroDoJid(jid) || numeroDoJid(k.remoteJidAlt) || numeroDoJid(k.senderPn) || numeroDoJid(d.senderPn);
        if (!telefone) continue;
        const msg = d.message ?? {};
        const tipo: MensagemEntrada['tipo'] = msg.imageMessage || msg.stickerMessage ? 'imagem' : msg.audioMessage ? 'audio' : msg.videoMessage ? 'video' : msg.documentMessage || msg.documentWithCaptionMessage ? 'documento' : msg.locationMessage ? 'localizacao' : msg.conversation || msg.extendedTextMessage ? 'texto' : 'outro';
        const doc = msg.documentMessage ?? msg.documentWithCaptionMessage?.message?.documentMessage;
        const midiaInfo = msg.imageMessage ?? msg.stickerMessage ?? msg.audioMessage ?? msg.videoMessage ?? doc;
        if (msg.reactionMessage || msg.protocolMessage) continue;
        mensagens.push({
          telefone,
          nome: d.pushName ?? null,
          idExterno: String(k.id),
          minha: !!k.fromMe,
          tipo,
          texto:
            msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? doc?.caption ??
            (msg.locationMessage ? `📍 ${msg.locationMessage.degreesLatitude},${msg.locationMessage.degreesLongitude}` : null) ?? (tipo === 'outro' ? '[mensagem não suportada]' : null),
          // A mídia é baixada mandando a mensagem inteira de volta ao servidor (ele não guarda cópia das mensagens).
          midia: midiaInfo ? { ref: JSON.stringify({ key: k, message: msg }), mime: midiaInfo.mimetype ?? (msg.stickerMessage ? 'image/webp' : null), nome: doc?.fileName ?? null } : undefined,
          quando: new Date(Number(d.messageTimestamp ?? 0) * 1000 || Date.now()),
        });
      }
    }
    if (evento === 'messages.update') {
      const mapa: Record<string, StatusEntrada['status']> = { SERVER_ACK: 'enviada', DELIVERY_ACK: 'entregue', READ: 'lida', PLAYED: 'lida', ERROR: 'falhou' };
      for (const d of lista) {
        const id = d.keyId ?? d.key?.id ?? d.messageId;
        const s = mapa[String(d.status ?? d.update?.status ?? '')];
        if (id && s && d.fromMe !== false) status.push({ idExterno: String(id), status: s });
      }
    }
    return { mensagens, status };
  }

  async baixarMidia(ref: string) {
    let mensagem: unknown;
    try {
      mensagem = JSON.parse(ref);
    } catch {
      mensagem = { key: { id: ref } };
    }
    const r = await chamar<{ base64?: string; mimetype?: string }>(`chat/getBase64FromMediaMessage/${this.i}`, { method: 'POST', body: JSON.stringify({ message: mensagem, convertToMp4: false }) });
    if (!r.base64) throw new ErroCanal('A mídia não está mais disponível no WhatsApp.');
    return { conteudo: Buffer.from(r.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), mime: (r.mimetype ?? 'application/octet-stream').split(';')[0] };
  }

  async situacao() {
    try {
      let estado: string;
      try {
        estado = (await chamar<{ instance?: { state?: string } }>(`instance/connectionState/${this.i}`)).instance?.state ?? 'close';
      } catch (e) {
        // Instância sumiu do servidor (reinstalação, volume apagado): recria sozinha, com o mesmo webhook.
        if ((e as { status?: number }).status !== 404) throw e;
        const nova = await criarInstancia(this.instancia, this.webhook);
        return { conectado: false, detalhe: 'Leia o QR code com o WhatsApp do celular.', qrcode: nova.qrcode };
      }
      if (estado === 'open') {
        const [inst] = await chamar<{ ownerJid?: string; number?: string; profileName?: string }[]>(`instance/fetchInstances?instanceName=${this.i}`).catch(() => []);
        const numero = numeroDoJid(inst?.ownerJid) || (inst?.number ?? '').replace(/\D/g, '') || null;
        return { conectado: true, detalhe: inst?.profileName ? `Conectado como ${inst.profileName}` : 'Conectado', numero };
      }
      const qr = await chamar<{ base64?: string; pairingCode?: string }>(`instance/connect/${this.i}`);
      return { conectado: false, detalhe: 'Abra o WhatsApp no celular › Aparelhos conectados › Conectar um aparelho, e aponte para o QR code.', qrcode: qr.base64 ?? null };
    } catch (e) {
      return { conectado: false, detalhe: (e as Error).message };
    }
  }

  /** Reaponta o webhook (ex.: depois de mudar o endereço da API). */
  async configurarWebhooks() {
    await chamar(`webhook/set/${this.i}`, { method: 'POST', body: JSON.stringify({ webhook: { enabled: true, url: this.webhook, byEvents: false, base64: false, events: EVENTOS } }) });
  }

  /** Desliga o número do sistema (no celular, some de "Aparelhos conectados"). Ler o QR de novo reconecta. */
  async desconectar() {
    await chamar(`instance/logout/${this.i}`, { method: 'DELETE' });
  }
}
