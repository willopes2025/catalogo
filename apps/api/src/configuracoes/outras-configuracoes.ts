import { z } from 'zod';

/**
 * Configurações simples guardadas por chave, com valor padrão e validação.
 * Lidas pelos serviços com `lerConfig` e editadas na tela Configurações.
 */
export const CONFIGS = {
  impressao: {
    padrao: { etiquetaLarguraMm: 50, etiquetaAlturaMm: 25, etiquetaColunas: 1, etiquetaMostrarPreco: true, etiquetaMostrarRef: true, etiquetaTexto: 'Aritana', rodapePedido: '' },
    schema: z.object({
      etiquetaLarguraMm: z.number().min(15).max(120),
      etiquetaAlturaMm: z.number().min(8).max(80),
      etiquetaColunas: z.number().int().min(1).max(4),
      etiquetaMostrarPreco: z.boolean(),
      etiquetaMostrarRef: z.boolean(),
      etiquetaTexto: z.string().max(30),
      rodapePedido: z.string().max(500),
    }),
  },
  avisos: {
    padrao: { ativo: true, hora: 8, emailsEquipe: [] as string[], diasAntesMaleta: 3, diasAntesTitulo: 1 },
    schema: z.object({
      ativo: z.boolean(),
      hora: z.number().int().min(0).max(23),
      emailsEquipe: z.array(z.string().email('E-mail inválido')).max(20),
      diasAntesMaleta: z.number().int().min(0).max(15),
      diasAntesTitulo: z.number().int().min(0).max(15),
    }),
  },
  regras_garantia: {
    padrao: { prazoDias: 90 },
    schema: z.object({ prazoDias: z.number().int().min(0).max(3650) }),
  },
  regras_comissao: {
    padrao: { lojaPadraoPb: 300, redeLiderPb: 0, diaPagamento: 10 },
    schema: z.object({ lojaPadraoPb: z.number().int().min(0).max(10000), redeLiderPb: z.number().int().min(0).max(10000), diaPagamento: z.number().int().min(1).max(28) }),
  },
} as const;

export type ChaveConfig = keyof typeof CONFIGS;
export type ValorConfig<K extends ChaveConfig> = (typeof CONFIGS)[K]['padrao'];
