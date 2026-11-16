/** O que o CRM precisa de qualquer conexão de WhatsApp. */
export interface MensagemSaida {
  para: string;
  tipo: 'texto' | 'template' | 'imagem' | 'audio' | 'video' | 'documento';
  texto?: string;
  /** Template da Meta. */
  template?: { nome: string; idioma: string; parametros: string[] };
  /** Mídia: conteúdo e tipo. */
  midia?: { conteudo: Buffer; mime: string; nome: string };
  /** Responder citando uma mensagem da conversa. */
  citar?: AlvoMensagem & { texto: string | null };
}

/** Uma mensagem que já está no WhatsApp (para citar, reagir ou apagar). */
export interface AlvoMensagem {
  idExterno: string;
  /** Foi mandada por este número (e não pelo contato). */
  minha: boolean;
}

export interface MensagemEntrada {
  telefone: string;
  nome: string | null;
  idExterno: string;
  /** Mandada pelo próprio número (no celular), não pelo contato. */
  minha: boolean;
  tipo: 'texto' | 'imagem' | 'audio' | 'video' | 'documento' | 'localizacao' | 'outro';
  texto: string | null;
  /** Como baixar a mídia (id da Meta ou link da Z-API). */
  midia?: { ref: string; mime: string | null; nome: string | null };
  quando: Date;
  /** Anúncio "clique para WhatsApp" que trouxe a pessoa (Meta). */
  referencia?: Record<string, string>;
  /** Mensagem que esta está respondendo (citação). */
  citaIdExterno?: string;
}

/** Reação (emoji) a uma mensagem. Emoji vazio = tirou a reação. */
export interface ReacaoEntrada {
  idExterno: string;
  emoji: string;
  minha: boolean;
}

export interface StatusEntrada {
  idExterno: string;
  status: 'enviada' | 'entregue' | 'lida' | 'falhou';
  erro?: string;
}

export interface TemplateRemoto {
  nome: string;
  idioma: string;
  categoria: string | null;
  status: string;
  texto: string;
  componentes: unknown;
  variaveis: number;
}

export interface Conexao {
  enviar(m: MensagemSaida): Promise<{ idExterno: string }>;
  /** Lê o corpo de um webhook. */
  ler(corpo: unknown): { mensagens: MensagemEntrada[]; status: StatusEntrada[]; reacoes?: ReacaoEntrada[]; apagadas?: string[] };
  /** Reage a uma mensagem (emoji vazio tira a reação). */
  reagir?(para: string, alvo: AlvoMensagem, emoji: string): Promise<void>;
  /** Apaga para todos uma mensagem enviada por este número. */
  apagar?(para: string, alvo: AlvoMensagem): Promise<void>;
  baixarMidia(ref: string): Promise<{ conteudo: Buffer; mime: string }>;
  situacao(): Promise<{ conectado: boolean; detalhe: string; qrcode?: string | null; numero?: string | null }>;
  templates?(): Promise<TemplateRemoto[]>;
}

export class ErroCanal extends Error {}
