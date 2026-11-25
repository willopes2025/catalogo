import { ErroCanal, type AlvoMensagem, type Conexao, type MensagemEntrada, type MensagemSaida, type ReacaoEntrada, type StatusEntrada } from './tipos';

/**
 * WhatsApp por QR code no servidor próprio (Evolution API, que roda na mesma VPS, sem porta aberta para a internet).
 * Quem usa só dá um nome ao número e lê o QR: a instância, a chave e o webhook são criados pelo sistema.
 *
 *   EVOLUTION_URL          endereço interno do servidor (na VPS: http://aritana-whatsapp:8080)
 *   EVOLUTION_API_KEY      chave global do servidor (gerada pelo instalador no .env)
 *   EVOLUTION_WEBHOOK_URL  como o servidor de WhatsApp chega na API (na VPS: http://aritana-api:3000)
 */
export const evolutionDisponivel = () => !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_API_KEY);

/**
 * Onde a instância mora. Sem nada, é o servidor próprio da VPS (QR code criado pelo sistema).
 * Com endereço e token, é uma instância que já existe em outro servidor Evolution (ligada pelo token dela).
 */
export interface ServidorEvolution {
  url: string;
  /** Token (apikey) da instância, ou a chave global do servidor. */
  chave: string;
}

/** Confere o endereço digitado de um servidor Evolution de fora. Devolve sem a barra do fim. */
export function validarEnderecoEvolution(bruto: string) {
  let u: URL;
  try {
    u = new URL(bruto.trim());
  } catch {
    throw new ErroCanal('Endereço do servidor Evolution inválido. Exemplo: https://evolution.suaempresa.com.br');
  }
  const teste = process.env.EVOLUTION_EXTERNA_HTTP === '1';
  if (u.protocol !== 'https:' && !(teste && u.protocol === 'http:')) throw new ErroCanal('O endereço do servidor Evolution precisa começar com https://');
  // Só servidor na internet: nada de endereço da rede interna da VPS.
  const h = u.hostname.toLowerCase();
  if (!teste && (h === 'localhost' || !h.includes('.') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.startsWith('[') || h.endsWith('.internal') || h.endsWith('.local'))) throw new ErroCanal('Informe o endereço público do servidor Evolution (não um endereço interno).');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Eventos que o sistema precisa ouvir. */
const EVENTOS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE'];

async function chamar<T>(caminho: string, init: RequestInit = {}, fora?: ServidorEvolution): Promise<T> {
  if (!fora && !evolutionDisponivel()) throw new ErroCanal('O servidor de WhatsApp por QR code não está instalado nesta VPS. Rode o instalador de novo para ativá-lo.');
  const raiz = fora ? fora.url.replace(/\/$/, '') : (process.env.EVOLUTION_URL ?? '').replace(/\/$/, '');
  let res: Response;
  try {
    // Servidor de fora: não segue redirecionamento (o token não vai parar em outro endereço).
    res = await fetch(`${raiz}/${caminho}`, { ...init, headers: { 'content-type': 'application/json', apikey: fora ? fora.chave : (process.env.EVOLUTION_API_KEY ?? '') }, redirect: fora ? 'manual' : 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ErroCanal(fora ? `O servidor Evolution (${raiz}) não respondeu (${(e as Error).message}). Confira o endereço.` : `O servidor de WhatsApp não respondeu (${(e as Error).message}). Ele pode estar reiniciando; tente de novo em um minuto.`);
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (fora && (res.status === 401 || res.status === 403)) {
    const erro = new ErroCanal('O servidor Evolution recusou o token. Confira o token (API key) da instância.');
    (erro as ErroCanal & { status?: number }).status = res.status;
    throw erro;
  }
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
  /** `fora`: instância de outro servidor Evolution, ligada pelo token (o sistema não cria nem apaga). */
  constructor(private readonly instancia: string, private readonly webhook: string, private readonly fora?: ServidorEvolution) {}

  private chamar<T>(caminho: string, init: RequestInit = {}) {
    return chamar<T>(caminho, init, this.fora);
  }

  private get i() {
    return encodeURIComponent(this.instancia);
  }

  async enviar(m: MensagemSaida) {
    const numero = m.para.replace(/\D/g, '');
    let r: { key?: { id?: string } };
    // Responder citando: o WhatsApp mostra a mensagem original em cima da resposta.
    const citar = m.citar ? { quoted: { key: { id: m.citar.idExterno, fromMe: m.citar.minha, remoteJid: `${numero}@s.whatsapp.net` }, message: { conversation: m.citar.texto ?? '' } } } : {};
    if (m.tipo === 'texto' || m.tipo === 'template') {
      r = await this.chamar(`message/sendText/${this.i}`, { method: 'POST', body: JSON.stringify({ number: numero, text: m.texto ?? '', ...citar }) });
    } else if (m.tipo === 'audio') {
      // "encoding": o servidor converte para o formato de áudio de voz do WhatsApp (o navegador grava em outro).
      r = await this.chamar(`message/sendWhatsAppAudio/${this.i}`, { method: 'POST', body: JSON.stringify({ number: numero, audio: m.midia!.conteudo.toString('base64'), encoding: true, ...citar }) });
    } else {
      const mediatype = m.tipo === 'imagem' ? 'image' : m.tipo === 'video' ? 'video' : 'document';
      r = await this.chamar(`message/sendMedia/${this.i}`, {
        method: 'POST',
        body: JSON.stringify({ number: numero, mediatype, mimetype: m.midia!.mime, caption: m.texto ?? '', media: m.midia!.conteudo.toString('base64'), fileName: m.midia!.nome, ...citar }),
      });
    }
    const id = r.key?.id;
    if (!id) throw new ErroCanal('O servidor de WhatsApp não devolveu o id da mensagem.');
    return { idExterno: String(id) };
  }

  ler(corpo: unknown) {
    const mensagens: MensagemEntrada[] = [];
    const status: StatusEntrada[] = [];
    const reacoes: ReacaoEntrada[] = [];
    const apagadas: string[] = [];
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
        // Reação a uma mensagem e "apagar para todos" não são mensagens novas.
        if (msg.reactionMessage) {
          if (msg.reactionMessage.key?.id) reacoes.push({ idExterno: String(msg.reactionMessage.key.id), emoji: String(msg.reactionMessage.text ?? ''), minha: !!k.fromMe });
          continue;
        }
        if (msg.protocolMessage) {
          const p = msg.protocolMessage;
          if ((p.type === 'REVOKE' || p.type === 0) && p.key?.id) apagadas.push(String(p.key.id));
          continue;
        }
        const cartoes = msg.contactMessage ? [msg.contactMessage] : (msg.contactsArrayMessage?.contacts ?? []);
        const textoContato = cartoes.length ? cartoes.map((c: Record<string, any>) => `👤 ${c.displayName ?? 'Contato'}${/waid=(\d+)/.exec(c.vcard ?? '')?.[1] ? ` · +${/waid=(\d+)/.exec(c.vcard)![1]}` : ''}`).join('\n') : null;
        const ctx = msg.extendedTextMessage?.contextInfo ?? msg.imageMessage?.contextInfo ?? msg.videoMessage?.contextInfo ?? msg.audioMessage?.contextInfo ?? msg.documentMessage?.contextInfo ?? msg.stickerMessage?.contextInfo ?? d.contextInfo;
        const tipo: MensagemEntrada['tipo'] = textoContato ? 'texto' : msg.imageMessage || msg.stickerMessage ? 'imagem' : msg.audioMessage ? 'audio' : msg.videoMessage ? 'video' : msg.documentMessage || msg.documentWithCaptionMessage ? 'documento' : msg.locationMessage ? 'localizacao' : msg.conversation || msg.extendedTextMessage ? 'texto' : 'outro';
        const doc = msg.documentMessage ?? msg.documentWithCaptionMessage?.message?.documentMessage;
        const midiaInfo = msg.imageMessage ?? msg.stickerMessage ?? msg.audioMessage ?? msg.videoMessage ?? doc;
        mensagens.push({
          telefone,
          nome: d.pushName ?? null,
          idExterno: String(k.id),
          minha: !!k.fromMe,
          tipo,
          citaIdExterno: ctx?.stanzaId ? String(ctx.stanzaId) : undefined,
          texto:
            textoContato ??
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
        if (id && String(d.status ?? '') === 'DELETED') apagadas.push(String(id));
      }
    }
    if (evento === 'messages.delete') {
      for (const d of lista) {
        const id = d.id ?? d.keyId ?? d.key?.id;
        if (id) apagadas.push(String(id));
      }
    }
    return { mensagens, status, reacoes, apagadas };
  }

  async reagir(para: string, alvo: AlvoMensagem, emoji: string) {
    await this.chamar(`message/sendReaction/${this.i}`, { method: 'POST', body: JSON.stringify({ key: { remoteJid: `${para.replace(/\D/g, '')}@s.whatsapp.net`, fromMe: alvo.minha, id: alvo.idExterno }, reaction: emoji }) });
  }

  async apagar(para: string, alvo: AlvoMensagem) {
    await this.chamar(`chat/deleteMessageForEveryone/${this.i}`, { method: 'DELETE', body: JSON.stringify({ id: alvo.idExterno, remoteJid: `${para.replace(/\D/g, '')}@s.whatsapp.net`, fromMe: alvo.minha }) });
  }

  async baixarMidia(ref: string) {
    let mensagem: unknown;
    try {
      mensagem = JSON.parse(ref);
    } catch {
      mensagem = { key: { id: ref } };
    }
    const r = await this.chamar<{ base64?: string; mimetype?: string }>(`chat/getBase64FromMediaMessage/${this.i}`, { method: 'POST', body: JSON.stringify({ message: mensagem, convertToMp4: false }) });
    if (!r.base64) throw new ErroCanal('A mídia não está mais disponível no WhatsApp.');
    return { conteudo: Buffer.from(r.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), mime: (r.mimetype ?? 'application/octet-stream').split(';')[0] };
  }

  async situacao() {
    try {
      let estado: string;
      try {
        estado = (await this.chamar<{ instance?: { state?: string } }>(`instance/connectionState/${this.i}`)).instance?.state ?? 'close';
      } catch (e) {
        // Instância sumiu do servidor (reinstalação, volume apagado): recria sozinha, com o mesmo webhook.
        if ((e as { status?: number }).status !== 404) throw e;
        if (this.fora) return { conectado: false, detalhe: `A instância "${this.instancia}" não existe nesse servidor Evolution. Confira o nome.` };
        const nova = await criarInstancia(this.instancia, this.webhook);
        return { conectado: false, detalhe: 'Leia o QR code com o WhatsApp do celular.', qrcode: nova.qrcode };
      }
      if (estado === 'open') {
        const [inst] = await this.chamar<{ ownerJid?: string; number?: string; profileName?: string }[]>(`instance/fetchInstances?instanceName=${this.i}`).catch(() => []);
        const numero = numeroDoJid(inst?.ownerJid) || (inst?.number ?? '').replace(/\D/g, '') || null;
        return { conectado: true, detalhe: inst?.profileName ? `Conectado como ${inst.profileName}` : 'Conectado', numero };
      }
      const qr = await this.chamar<{ base64?: string; pairingCode?: string }>(`instance/connect/${this.i}`);
      return { conectado: false, detalhe: 'Abra o WhatsApp no celular › Aparelhos conectados › Conectar um aparelho, e aponte para o QR code.', qrcode: qr.base64 ?? null };
    } catch (e) {
      return { conectado: false, detalhe: (e as Error).message };
    }
  }

  /** Reaponta o webhook (ex.: depois de mudar o endereço da API). */
  async configurarWebhooks() {
    await this.chamar(`webhook/set/${this.i}`, { method: 'POST', body: JSON.stringify({ webhook: { enabled: true, url: this.webhook, byEvents: false, base64: false, events: EVENTOS } }) });
  }

  /** Para de mandar as mensagens desta instância para o sistema (a instância continua existindo no servidor dela). */
  async desligarWebhook() {
    await this.chamar(`webhook/set/${this.i}`, { method: 'POST', body: JSON.stringify({ webhook: { enabled: false, url: this.webhook, byEvents: false, base64: false, events: EVENTOS } }) });
  }

  /** Confere endereço, token e nome da instância (erro claro para cada caso). */
  async testar() {
    try {
      await this.chamar(`instance/connectionState/${this.i}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw new ErroCanal(`A instância "${this.instancia}" não existe nesse servidor Evolution. Confira o nome (maiúsculas e minúsculas contam).`);
      throw e;
    }
  }

  /** Estado da conexão no servidor: open | connecting | close. */
  async estado() {
    return (await this.chamar<{ instance?: { state?: string } }>(`instance/connectionState/${this.i}`)).instance?.state ?? 'close';
  }

  /** Passa a pedir o histórico ao WhatsApp na próxima vez que o celular conectar (ler o QR). */
  async pedirHistoricoAoConectar() {
    await this.chamar(`settings/set/${this.i}`, {
      method: 'POST',
      body: JSON.stringify({ rejectCall: false, msgCall: '', groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: true }),
    });
  }

  /**
   * Mensagens que o servidor guardou entre duas datas, página por página (as mais novas primeiro).
   * Devolve já no formato das mensagens recebidas; grupos e status ficam de fora.
   */
  async *mensagensGuardadas(de: Date, ate: Date) {
    const porPagina = 250;
    for (let pagina = 1; pagina <= 400; pagina++) {
      const r = await this.chamar<Record<string, any>>(`chat/findMessages/${this.i}`, {
        method: 'POST',
        body: JSON.stringify({ where: { messageTimestamp: { gte: de.toISOString(), lte: ate.toISOString() } }, page: pagina, offset: porPagina }),
      });
      const bloco = r.messages ?? r;
      const registros: Record<string, any>[] = Array.isArray(bloco?.records) ? bloco.records : Array.isArray(bloco) ? bloco : [];
      if (!registros.length) return;
      // Confere o período aqui também (servidor antigo pode ignorar o filtro de data).
      const dentro = registros.filter((d) => {
        const t = Number(d.messageTimestamp ?? 0) * 1000;
        return t >= de.getTime() && t <= ate.getTime();
      });
      yield this.ler({ event: 'messages.upsert', data: dentro }).mensagens;
      const total = Number(bloco?.pages ?? 0);
      if ((total && pagina >= total) || registros.length < porPagina) return;
    }
  }

  /** Desliga o número do sistema (no celular, some de "Aparelhos conectados"). Ler o QR de novo reconecta. */
  async desconectar() {
    await this.chamar(`instance/logout/${this.i}`, { method: 'DELETE' });
  }
}
