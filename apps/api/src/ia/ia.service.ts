import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DB, type Db } from '../comum/db.module';
import { iaUsos } from '../db/schema';
import { SegredosService } from '../segredos/segredos.service';

export type Recurso = 'agente' | 'triagem' | 'sugestao' | 'reconhecer_peca' | 'maleta' | 'foto' | 'transcricao' | 'teste' | 'assistente' | 'voz';
export type Bloco = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } };
export interface MensagemIa {
  role: 'user' | 'assistant';
  content: string | Bloco[];
}

/** Blocos da conversa com ferramentas (formato da API do Claude). */
export type BlocoFerramenta =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** Anexo guardado na conversa (vira imagem, documento ou texto na hora de mandar ao Claude). */
  | { type: 'anexo'; anexoId: string; nome: string; mime: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };
export interface MensagemFerramentas {
  role: 'user' | 'assistant';
  content: BlocoFerramenta[];
}
export interface DefinicaoFerramenta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Marcações de emoção que o assistente pode usar na conversa falada (o modelo v3 da ElevenLabs interpreta). */
export const TAGS_VOZ = ['excited', 'warmly', 'cheerfully', 'laughs', 'chuckles', 'sighs', 'curious', 'thoughtful', 'reassuring', 'happy', 'surprised', 'serious'];
const RE_TAGS = new RegExp(`\\[(?:${TAGS_VOZ.join('|')})\\]\\s*`, 'gi');
/** Tira as marcações de emoção (para a tela e para vozes que não as entendem). */
export const semTagsDeVoz = (t: string) => t.replace(RE_TAGS, '').replace(/\s{2,}/g, ' ').trim();

/** A IA respondeu com erro (chave errada, sem crédito, fora do ar). A mensagem já está pronta para a tela. */
export class ErroIa extends Error {}

const MODELO_PADRAO = 'claude-sonnet-5-5';

/**
 * Porta única para a inteligência artificial.
 * Texto e leitura de imagem: Claude (Anthropic). Geração de imagem e transcrição de áudio: OpenAI.
 * As chaves ficam em Configurações › Integrações › Inteligência artificial.
 */
@Injectable()
export class IaService {
  private readonly log = new Logger('IA');

  constructor(@Inject(DB) private readonly db: Db, private readonly segredos: SegredosService) {}

  /** Claude ligado (agente, sugestão, maleta, reconhecer peça). */
  get texto() {
    return !!this.segredos.v('ANTHROPIC_API_KEY');
  }
  /** OpenAI ligada (foto de catálogo). */
  get imagem() {
    return !!this.segredos.v('OPENAI_API_KEY');
  }
  get modelo() {
    return this.segredos.v('IA_MODELO')?.trim() || MODELO_PADRAO;
  }
  /** Modelo da recepção do agente (só escolhe o especialista): rápido e barato. */
  get modeloTriagem() {
    return this.segredos.v('IA_MODELO_TRIAGEM')?.trim() || 'claude-haiku-5-5';
  }

  private async registrar(recurso: Recurso, modelo: string, entrada: number, saida: number, usuarioId?: string | null) {
    await this.db.insert(iaUsos).values({ recurso, modelo, tokensEntrada: entrada, tokensSaida: saida, usuarioId: usuarioId ?? null }).catch((e) => this.log.warn(`Uso não registrado: ${(e as Error).message}`));
  }

  /** Chamada à API do Claude, com as mensagens de erro já prontas para a tela. */
  private async requisitar(recurso: Recurso, modelo: string, corpo: Record<string, unknown>, usuarioId?: string | null) {
    const chave = this.segredos.v('ANTHROPIC_API_KEY');
    if (!chave) throw new ServiceUnavailableException({ mensagem: 'A inteligência artificial não está ligada. Cole a chave do Claude em Configurações › Integrações › Inteligência artificial.' });
    let res: Response;
    try {
      res = await fetch(`${(process.env.IA_CLAUDE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, ...corpo }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ErroIa(`A IA não respondeu (${(e as Error).message}). Tente de novo.`);
    }
    const j = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; error?: { type?: string; message?: string }; stop_reason?: string };
    if (!res.ok) {
      const tipo = j.error?.type ?? '';
      if (res.status === 401) throw new ErroIa('A chave do Claude foi recusada. Confira a chave em Configurações › Integrações › Inteligência artificial.');
      if (res.status === 404 || tipo === 'not_found_error') throw new ErroIa(`O modelo "${modelo}" não existe nesta conta. Deixe o campo "Modelo do Claude" em branco para usar o padrão.`);
      if (res.status === 429) throw new ErroIa('A IA está no limite de uso agora. Tente de novo em um minuto.');
      if (res.status === 400 && /credit|billing/i.test(j.error?.message ?? '')) throw new ErroIa('A conta do Claude está sem créditos. Coloque créditos em console.anthropic.com.');
      if (res.status >= 500 || tipo === 'overloaded_error') throw new ErroIa('A IA está sobrecarregada agora. Tente de novo em instantes.');
      throw new ErroIa(`A IA recusou o pedido: ${j.error?.message ?? res.status}`);
    }
    const u = j.usage ?? {};
    await this.registrar(recurso, modelo, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.output_tokens ?? 0, usuarioId);
    if (j.stop_reason === 'refusal') throw new ErroIa('A IA não quis responder a este pedido.');
    return j;
  }

  /** Pergunta ao Claude e devolve o texto da resposta. */
  async perguntar(o: { recurso: Recurso; sistema: string; mensagens: MensagemIa[]; maxTokens?: number; usuarioId?: string | null; modelo?: string }): Promise<string> {
    const j = await this.requisitar(o.recurso, o.modelo || this.modelo, { max_tokens: o.maxTokens ?? 1024, system: o.sistema, messages: o.mensagens }, o.usuarioId);
    return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  }

  /** Modelo do assistente da equipe (orquestrador). */
  get modeloAssistente() {
    return this.segredos.v('IA_MODELO_ASSISTENTE')?.trim() || this.modelo;
  }

  /**
   * Uma rodada da conversa com ferramentas: o Claude responde com texto e/ou pede ferramentas.
   * As instruções e a lista de ferramentas vão em cache (a parte fixa fica bem mais barata nas rodadas seguintes).
   */
  async comFerramentas(o: { recurso: Recurso; sistema: string; mensagens: MensagemFerramentas[]; ferramentas: DefinicaoFerramenta[]; maxTokens?: number; usuarioId?: string | null; modelo?: string }) {
    const ferramentas = o.ferramentas.map((f, i) => (i === o.ferramentas.length - 1 ? { ...f, cache_control: { type: 'ephemeral' } } : f));
    const j = await this.requisitar(
      o.recurso,
      o.modelo || this.modeloAssistente,
      { max_tokens: o.maxTokens ?? 2048, system: [{ type: 'text', text: o.sistema, cache_control: { type: 'ephemeral' } }], messages: o.mensagens, ...(ferramentas.length ? { tools: ferramentas } : {}) },
      o.usuarioId,
    );
    const content: BlocoFerramenta[] = [];
    for (const b of j.content ?? []) {
      if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use' && b.id && b.name) content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
    }
    return { content, parada: j.stop_reason ?? 'end_turn' };
  }

  /** Pergunta esperando JSON de volta. Aceita o JSON puro ou dentro de um bloco de código. */
  async perguntarJson<T>(o: Parameters<IaService['perguntar']>[0]): Promise<T> {
    const texto = await this.perguntar(o);
    const ini = texto.indexOf('{');
    const fim = texto.lastIndexOf('}');
    try {
      if (ini < 0 || fim <= ini) throw new Error('sem JSON');
      return JSON.parse(texto.slice(ini, fim + 1)) as T;
    } catch {
      this.log.warn(`Resposta da IA fora do formato (${o.recurso}): ${texto.slice(0, 200)}`);
      throw new ErroIa('A IA respondeu fora do formato esperado. Tente de novo.');
    }
  }

  /** Gera uma imagem a partir de outra(s), pela OpenAI. Devolve o PNG. */
  async gerarImagem(o: { prompt: string; imagens: { conteudo: Buffer; mime: string }[]; tamanho?: '1024x1024' | '1024x1536' | '1536x1024'; usuarioId?: string | null }): Promise<Buffer> {
    const chave = this.segredos.v('OPENAI_API_KEY');
    if (!chave) throw new ServiceUnavailableException({ mensagem: 'A geração de fotos não está ligada. Cole a chave da OpenAI em Configurações › Integrações › Inteligência artificial.' });
    const modelo = this.segredos.v('IA_MODELO_IMAGEM')?.trim();
    let res: Response;
    try {
      res = await fetch(`${(process.env.IA_OPENAI_URL ?? 'https://api.openai.com').replace(/\/$/, '')}/v1/images/edits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${chave}` },
        body: JSON.stringify({ ...(modelo ? { model: modelo } : {}), prompt: o.prompt, images: o.imagens.map((i) => ({ image_url: `data:${i.mime};base64,${i.conteudo.toString('base64')}` })), size: o.tamanho ?? '1024x1024', n: 1 }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      throw new ErroIa(`A geração de imagem não respondeu (${(e as Error).message}). Ela pode levar até 2 minutos; tente de novo.`);
    }
    const j = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string; code?: string } };
    if (!res.ok) {
      if (res.status === 401) throw new ErroIa('A chave da OpenAI foi recusada. Confira a chave em Configurações › Integrações › Inteligência artificial.');
      if (res.status === 429) throw new ErroIa(/quota|billing/i.test(j.error?.message ?? '') ? 'A conta da OpenAI está sem créditos.' : 'A OpenAI está no limite de uso agora. Tente de novo em um minuto.');
      if (res.status === 403 || /verif/i.test(j.error?.message ?? '')) throw new ErroIa('A OpenAI pede a verificação da organização para gerar imagens. Faça em platform.openai.com › Settings › Organization.');
      if (j.error?.code === 'moderation_blocked' || /safety|moderation/i.test(j.error?.message ?? '')) throw new ErroIa('A OpenAI recusou esta imagem pelas regras de conteúdo dela. Tente outra foto ou outro estilo.');
      throw new ErroIa(`A OpenAI recusou o pedido: ${j.error?.message ?? res.status}`);
    }
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) throw new ErroIa('A OpenAI não devolveu a imagem. Tente de novo.');
    await this.registrar('foto', modelo || 'padrão da OpenAI', j.usage?.input_tokens ?? 0, j.usage?.output_tokens ?? 0, o.usuarioId);
    return Buffer.from(b64, 'base64');
  }

  /** Quem fala as respostas do Assistente: ElevenLabs (mais natural), OpenAI ou ninguém (fica a voz do navegador). */
  get vozDisponivel(): 'elevenlabs' | 'openai' | null {
    if (this.segredos.v('ELEVENLABS_API_KEY')) return 'elevenlabs';
    if (this.segredos.v('OPENAI_API_KEY')) return 'openai';
    return null;
  }
  get temElevenlabs() {
    return !!this.segredos.v('ELEVENLABS_API_KEY');
  }

  /** Transforma o texto em fala (MP3). Na ElevenLabs v3, as marcações de emoção ([warmly], [laughs]…) dão o tom; nas outras vozes, saem do texto. */
  async falar(o: { texto: string; provedor: 'elevenlabs' | 'openai'; voz: string; usuarioId?: string | null }): Promise<Buffer> {
    if (o.provedor === 'elevenlabs') {
      const modelo = this.segredos.v('IA_MODELO_VOZ')?.trim() || 'eleven_v3';
      try {
        return await this.falarElevenlabs(o, modelo);
      } catch (e) {
        // Conta ou voz sem o v3: tenta o modelo anterior, sem as marcações.
        if (modelo === 'eleven_v3' && e instanceof ErroIa && !/chave|créditos|limite/i.test(e.message)) return this.falarElevenlabs({ ...o, texto: semTagsDeVoz(o.texto) }, 'eleven_multilingual_v2');
        throw e;
      }
    }
    return this.falarOpenai({ ...o, texto: semTagsDeVoz(o.texto) });
  }

  private async erroVoz(res: Response, quem: string, provedor: string) {
    const j = (await res.json().catch(() => ({}))) as { detail?: { status?: string; message?: string } | string; error?: { message?: string } };
    const msg = typeof j.detail === 'object' ? (j.detail?.message ?? j.detail?.status) : (j.detail ?? j.error?.message);
    if (res.status === 401) return new ErroIa(`A chave da ${quem} foi recusada. Confira em Configurações › Integrações › Inteligência artificial.`);
    if (res.status === 429 || /quota|credit/i.test(String(msg ?? ''))) return new ErroIa(`A ${quem} está sem créditos ou no limite de uso agora.`);
    if (res.status === 404 || /voice_not_found|voice.*not found/i.test(String(msg ?? ''))) return new ErroIa(`A voz escolhida não está disponível na conta da ${quem}. ${provedor === 'elevenlabs' ? 'Adicione a voz em "My Voices" na ElevenLabs ou escolha outra no Assistente › Configurar.' : 'Escolha outra no Assistente › Configurar.'}`);
    return new ErroIa(`A ${quem} recusou o pedido de voz: ${msg ?? res.status}`);
  }

  private async falarElevenlabs(o: { texto: string; voz: string; usuarioId?: string | null }, modelo: string) {
    const chave = this.segredos.v('ELEVENLABS_API_KEY');
    if (!chave) throw new ErroIa('Cole a chave da ElevenLabs em Configurações › Integrações › Inteligência artificial.');
    const v3 = modelo === 'eleven_v3';
    const texto = (v3 ? o.texto : semTagsDeVoz(o.texto)).slice(0, v3 ? 3000 : 2500);
    let res: Response;
    try {
      res = await fetch(`${(process.env.ELEVENLABS_URL ?? 'https://api.elevenlabs.io').replace(/\/$/, '')}/v1/text-to-speech/${encodeURIComponent(o.voz)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': chave, accept: 'audio/mpeg' },
        // v3: estabilidade "natural" (0,5) deixa a emoção aparecer sem perder a voz.
        body: JSON.stringify(v3 ? { text: texto, model_id: modelo, voice_settings: { stability: 0.5 } } : { text: texto, model_id: modelo, language_code: 'pt', voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new ErroIa(`A voz não respondeu (${(e as Error).message}). Tente de novo.`);
    }
    if (!res.ok) throw await this.erroVoz(res, 'ElevenLabs', 'elevenlabs');
    const audio = Buffer.from(await res.arrayBuffer());
    await this.registrar('voz', `elevenlabs:${modelo}`, texto.length, 0, o.usuarioId);
    return audio;
  }

  private async falarOpenai(o: { texto: string; voz: string; usuarioId?: string | null }) {
    const chave = this.segredos.v('OPENAI_API_KEY');
    if (!chave) throw new ErroIa('Cole a chave da OpenAI em Configurações › Integrações › Inteligência artificial.');
    const texto = o.texto.slice(0, 2500);
    let res: Response;
    try {
      res = await fetch(`${(process.env.IA_OPENAI_URL ?? 'https://api.openai.com').replace(/\/$/, '')}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${chave}` },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: o.voz, input: texto, response_format: 'mp3', instructions: 'Fale em português do Brasil, com sotaque brasileiro neutro, como numa conversa de verdade entre colegas: expressivo, caloroso, com variação de entonação e emoção conforme o conteúdo (animado com boas notícias, cuidadoso com as ruins), ritmo natural com pequenas pausas.' }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new ErroIa(`A voz não respondeu (${(e as Error).message}). Tente de novo.`);
    }
    if (!res.ok) throw await this.erroVoz(res, 'OpenAI', 'openai');
    const audio = Buffer.from(await res.arrayBuffer());
    await this.registrar('voz', 'openai:gpt-4o-mini-tts', texto.length, 0, o.usuarioId);
    return audio;
  }

  /** Transcreve sozinho os áudios que chegam? (padrão: sim, se a chave da OpenAI estiver preenchida) */
  get transcreverSozinho() {
    return this.imagem && this.segredos.v('IA_TRANSCREVER_AUTO') !== 'nao';
  }

  /** Transcreve um áudio pela OpenAI (o Claude não ouve áudio). Devolve o texto. */
  async transcrever(o: { conteudo: Buffer; extensao: string; usuarioId?: string | null }): Promise<string> {
    const chave = this.segredos.v('OPENAI_API_KEY');
    if (!chave) throw new ErroIa('A transcrição de áudio usa a OpenAI: cole a chave dela em Configurações › Integrações › Inteligência artificial.');
    // A OpenAI aceita estes formatos; "weba" é webm com outro nome. AMR e AAC (áudios antigos) ela não lê.
    const ext = ({ weba: 'webm', oga: 'ogg', opus: 'ogg' } as Record<string, string>)[o.extensao] ?? o.extensao;
    if (!['ogg', 'mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'wav', 'webm', 'flac'].includes(ext)) throw new ErroIa(`A OpenAI não lê áudio no formato ${o.extensao.toUpperCase()}.`);
    if (o.conteudo.length > 25_000_000) throw new ErroIa('Áudio grande demais para transcrever (o limite é 25 MB, uns 25 minutos).');
    const modelo = this.segredos.v('IA_MODELO_TRANSCRICAO')?.trim() || 'gpt-4o-mini-transcribe';
    const corpo = new FormData();
    corpo.append('file', new Blob([new Uint8Array(o.conteudo)]), `audio.${ext}`);
    corpo.append('model', modelo);
    corpo.append('language', 'pt');
    corpo.append('response_format', 'json');
    let res: Response;
    try {
      res = await fetch(`${(process.env.IA_OPENAI_URL ?? 'https://api.openai.com').replace(/\/$/, '')}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${chave}` }, body: corpo, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      throw new ErroIa(`A transcrição não respondeu (${(e as Error).message}). Tente de novo.`);
    }
    const j = (await res.json().catch(() => ({}))) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number; seconds?: number }; error?: { message?: string } };
    if (!res.ok) {
      if (res.status === 401) throw new ErroIa('A chave da OpenAI foi recusada. Confira a chave em Configurações › Integrações › Inteligência artificial.');
      if (res.status === 429) throw new ErroIa(/quota|billing/i.test(j.error?.message ?? '') ? 'A conta da OpenAI está sem créditos.' : 'A OpenAI está no limite de uso agora. Tente de novo em um minuto.');
      if (res.status === 404 || /model/i.test(j.error?.message ?? '')) throw new ErroIa(`O modelo de transcrição "${modelo}" não existe nesta conta. Deixe o campo em branco para usar o padrão.`);
      throw new ErroIa(`A OpenAI recusou o áudio: ${j.error?.message ?? res.status}`);
    }
    await this.registrar('transcricao', modelo, j.usage?.input_tokens ?? Math.round(j.usage?.seconds ?? 0), j.usage?.output_tokens ?? 0, o.usuarioId);
    return (j.text ?? '').trim();
  }
}
