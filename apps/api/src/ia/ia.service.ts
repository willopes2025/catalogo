import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DB, type Db } from '../comum/db.module';
import { iaUsos } from '../db/schema';
import { SegredosService } from '../segredos/segredos.service';

export type Recurso = 'agente' | 'triagem' | 'sugestao' | 'reconhecer_peca' | 'maleta' | 'foto' | 'transcricao' | 'teste';
export type Bloco = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } };
export interface MensagemIa {
  role: 'user' | 'assistant';
  content: string | Bloco[];
}

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

  /** Pergunta ao Claude e devolve o texto da resposta. */
  async perguntar(o: { recurso: Recurso; sistema: string; mensagens: MensagemIa[]; maxTokens?: number; usuarioId?: string | null; modelo?: string }): Promise<string> {
    const chave = this.segredos.v('ANTHROPIC_API_KEY');
    if (!chave) throw new ServiceUnavailableException({ mensagem: 'A inteligência artificial não está ligada. Cole a chave do Claude em Configurações › Integrações › Inteligência artificial.' });
    const modelo = o.modelo || this.modelo;
    let res: Response;
    try {
      res = await fetch(`${(process.env.IA_CLAUDE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: o.maxTokens ?? 1024, system: o.sistema, messages: o.mensagens }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      throw new ErroIa(`A IA não respondeu (${(e as Error).message}). Tente de novo.`);
    }
    const j = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; error?: { type?: string; message?: string }; stop_reason?: string };
    if (!res.ok) {
      const tipo = j.error?.type ?? '';
      if (res.status === 401) throw new ErroIa('A chave do Claude foi recusada. Confira a chave em Configurações › Integrações › Inteligência artificial.');
      if (res.status === 404 || tipo === 'not_found_error') throw new ErroIa(`O modelo "${modelo}" não existe nesta conta. Deixe o campo "Modelo do Claude" em branco para usar o padrão.`);
      if (res.status === 429) throw new ErroIa('A IA está no limite de uso agora. Tente de novo em um minuto.');
      if (res.status === 400 && /credit|billing/i.test(j.error?.message ?? '')) throw new ErroIa('A conta do Claude está sem créditos. Coloque créditos em console.anthropic.com.');
      if (res.status >= 500 || tipo === 'overloaded_error') throw new ErroIa('A IA está sobrecarregada agora. Tente de novo em instantes.');
      throw new ErroIa(`A IA recusou o pedido: ${j.error?.message ?? res.status}`);
    }
    await this.registrar(o.recurso, modelo, j.usage?.input_tokens ?? 0, j.usage?.output_tokens ?? 0, o.usuarioId);
    if (j.stop_reason === 'refusal') throw new ErroIa('A IA não quis responder a este pedido.');
    return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
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
