/** O que o CRM precisa de qualquer conexão de WhatsApp. */
export interface MensagemSaida {
  para: string;
  tipo: 'texto' | 'template' | 'imagem' | 'audio' | 'video' | 'documento';
  texto?: string;
  /** Template da Meta. */
  template?: { nome: string; idioma: string; parametros: string[] };
  /** Mídia: conteúdo e tipo. */
  midia?: { conteudo: Buffer; mime: string; nome: string };
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
  ler(corpo: unknown): { mensagens: MensagemEntrada[]; status: StatusEntrada[] };
  baixarMidia(ref: string): Promise<{ conteudo: Buffer; mime: string }>;
  situacao(): Promise<{ conectado: boolean; detalhe: string; qrcode?: string | null; numero?: string | null }>;
  templates?(): Promise<TemplateRemoto[]>;
}

export class ErroCanal extends Error {}
