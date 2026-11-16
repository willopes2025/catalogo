import { ErroCanal, type AlvoMensagem, type Conexao, type MensagemEntrada, type MensagemSaida, type ReacaoEntrada, type StatusEntrada } from './tipos';

export interface ConfigZapi {
  instancia: string;
  token: string;
  clientToken?: string;
}

const base = () => (process.env.ZAPI_URL ?? 'https://api.z-api.io').replace(/\/$/, '');

/** WhatsApp por QR code (Z-API): qualquer número, conectado lendo o QR na tela. */
export class ConexaoZapi implements Conexao {
  constructor(private readonly c: ConfigZapi) {}

  private async chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base()}/instances/${encodeURIComponent(this.c.instancia)}/token/${encodeURIComponent(this.c.token)}/${caminho}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(this.c.clientToken ? { 'client-token': this.c.clientToken } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
    if (!res.ok || j.error) throw new ErroCanal(`Z-API: ${j.message ?? j.error ?? `respondeu ${res.status}`}`);
    return j;
  }

  async enviar(m: MensagemSaida) {
    let r: { messageId?: string; id?: string; zaapId?: string };
    const dataUri = m.midia ? `data:${m.midia.mime};base64,${m.midia.conteudo.toString('base64')}` : '';
    // Responder citando: a Z-API recebe o id da mensagem original.
    const citar = m.citar ? { messageId: m.citar.idExterno } : {};
    if (m.tipo === 'texto' || m.tipo === 'template') r = await this.chamar('send-text', { method: 'POST', body: JSON.stringify({ phone: m.para, message: m.texto ?? '', ...citar }) });
    else if (m.tipo === 'imagem') r = await this.chamar('send-image', { method: 'POST', body: JSON.stringify({ phone: m.para, image: dataUri, caption: m.texto ?? '', ...citar }) });
    else if (m.tipo === 'audio') r = await this.chamar('send-audio', { method: 'POST', body: JSON.stringify({ phone: m.para, audio: dataUri, ...citar }) });
    else if (m.tipo === 'video') r = await this.chamar('send-video', { method: 'POST', body: JSON.stringify({ phone: m.para, video: dataUri, caption: m.texto ?? '', ...citar }) });
    else {
      const ext = (m.midia!.nome.split('.').pop() ?? 'pdf').toLowerCase();
      r = await this.chamar(`send-document/${ext}`, { method: 'POST', body: JSON.stringify({ phone: m.para, document: dataUri, fileName: m.midia!.nome, caption: m.texto ?? '', ...citar }) });
    }
    const id = r.messageId ?? r.id ?? r.zaapId;
    if (!id) throw new ErroCanal('A Z-API não devolveu o id da mensagem.');
    return { idExterno: String(id) };
  }

  ler(corpo: unknown) {
    const mensagens: MensagemEntrada[] = [];
    const status: StatusEntrada[] = [];
    const reacoes: ReacaoEntrada[] = [];
    const apagadas: string[] = [];
    const b = (corpo ?? {}) as Record<string, any>;
    if (b.type === 'ReceivedCallback' && b.reaction) {
      const alvo = b.reaction.referencedMessage?.messageId;
      if (alvo && !b.isGroup) reacoes.push({ idExterno: String(alvo), emoji: String(b.reaction.value ?? ''), minha: !!b.fromMe });
    } else if (b.type === 'ReceivedCallback' && !b.isGroup && !b.isNewsletter && b.phone) {
      const cartoes = b.contact ? [b.contact] : (b.contacts ?? []);
      const textoContato = cartoes.length ? cartoes.map((c: Record<string, any>) => `👤 ${c.displayName ?? c.name ?? 'Contato'}${c.phones?.[0] ? ` · +${String(c.phones[0]).replace(/\D/g, '')}` : ''}`).join('\n') : null;
      const tipo: MensagemEntrada['tipo'] = textoContato ? 'texto' : b.image ? 'imagem' : b.audio ? 'audio' : b.video ? 'video' : b.document ? 'documento' : b.location ? 'localizacao' : b.sticker ? 'imagem' : b.text ? 'texto' : 'outro';
      const midia = b.image ? { ref: b.image.imageUrl, mime: b.image.mimeType ?? null, nome: null } : b.audio ? { ref: b.audio.audioUrl, mime: b.audio.mimeType ?? null, nome: null } : b.video ? { ref: b.video.videoUrl, mime: b.video.mimeType ?? null, nome: null } : b.document ? { ref: b.document.documentUrl, mime: b.document.mimeType ?? null, nome: b.document.fileName ?? null } : b.sticker ? { ref: b.sticker.stickerUrl, mime: b.sticker.mimeType ?? 'image/webp', nome: null } : undefined;
      mensagens.push({
        telefone: String(b.phone).replace(/\D/g, ''),
        nome: b.senderName ?? b.chatName ?? null,
        idExterno: String(b.messageId),
        minha: !!b.fromMe,
        tipo,
        citaIdExterno: b.referenceMessageId ? String(b.referenceMessageId) : undefined,
        texto: textoContato ?? b.text?.message ?? b.image?.caption ?? b.video?.caption ?? b.document?.caption ?? (b.location ? `📍 ${b.location.latitude},${b.location.longitude}` : null) ?? (tipo === 'outro' ? '[mensagem não suportada]' : null),
        midia: midia?.ref ? midia : undefined,
        quando: new Date(Number(b.momment ?? Date.now())),
      });
    }
    if (b.type === 'MessageStatusCallback') {
      const mapa: Record<string, StatusEntrada['status']> = { SENT: 'enviada', RECEIVED: 'entregue', READ: 'lida', PLAYED: 'lida', FAILED: 'falhou' };
      for (const id of (b.ids as string[]) ?? []) if (mapa[b.status]) status.push({ idExterno: String(id), status: mapa[b.status] });
      if (b.status === 'DELETED') for (const id of (b.ids as string[]) ?? []) apagadas.push(String(id));
    }
    return { mensagens, status, reacoes, apagadas };
  }

  async reagir(para: string, alvo: AlvoMensagem, emoji: string) {
    if (emoji) await this.chamar('send-reaction', { method: 'POST', body: JSON.stringify({ phone: para, messageId: alvo.idExterno, reaction: emoji }) });
    else await this.chamar('send-remove-reaction', { method: 'POST', body: JSON.stringify({ phone: para, messageId: alvo.idExterno }) });
  }

  async apagar(para: string, alvo: AlvoMensagem) {
    await this.chamar(`messages?messageId=${encodeURIComponent(alvo.idExterno)}&phone=${encodeURIComponent(para)}&owner=${alvo.minha}`, { method: 'DELETE' });
  }

  async baixarMidia(ref: string) {
    if (!/^https?:\/\//i.test(ref)) throw new ErroCanal('Link da mídia inválido.');
    const res = await fetch(ref, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ErroCanal(`Não foi possível baixar a mídia (${res.status}).`);
    return { conteudo: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0] };
  }

  async situacao() {
    try {
      const s = await this.chamar<{ connected?: boolean; error?: string; smartphoneConnected?: boolean }>('status');
      if (s.connected) {
        const eu = await this.chamar<{ phone?: string }>('device').catch(() => ({ phone: undefined }));
        return { conectado: true, detalhe: s.smartphoneConnected === false ? 'Conectado, mas o celular está sem internet' : 'Conectado', numero: eu.phone?.replace(/\D/g, '') ?? null };
      }
      const qr = await this.chamar<{ value?: string }>('qr-code/image').catch(() => ({ value: undefined }));
      return { conectado: false, detalhe: 'Leia o QR code com o WhatsApp do celular (Aparelhos conectados › Conectar um aparelho).', qrcode: qr.value ?? null };
    } catch (e) {
      return { conectado: false, detalhe: (e as Error).message };
    }
  }

  /** Aponta os webhooks da instância para o sistema. */
  async configurarWebhooks(url: string) {
    await this.chamar('update-every-webhooks', { method: 'PUT', body: JSON.stringify({ value: url, notifySentByMe: true }) });
  }

  async desconectar() {
    await this.chamar('disconnect', { method: 'GET' });
  }
}
