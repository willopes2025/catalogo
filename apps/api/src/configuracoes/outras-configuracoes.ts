import { z } from 'zod';
import { REGRAS_PONTOS_PADRAO, REGRAS_PRECIFICACAO_PADRAO } from '@aritana/regras';

const regraMetal = z.object({
  coeficiente: z.number().min(0).max(1_000_000),
  faixas: z
    .array(z.object({ ate: z.number().int().min(1).nullable(), multiplicador: z.number().int().min(100, 'O multiplicador mínimo é 1').max(10000) }))
    .min(1, 'Informe ao menos uma faixa')
    .max(8)
    .refine((f) => f.filter((x) => x.ate === null).length === 1, 'Deixe uma única faixa sem limite (a última)'),
});

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
  /**
   * Mensagens de WhatsApp da Agenda (ao marcar, remarcar, cancelar e os lembretes) e o número que manda.
   * Variáveis: {{primeiro_nome}} {{nome}} {{titulo}} {{dia}} {{hora}} {{onde}} {{link}} {{local}} {{portal}}.
   * Linha que fica vazia depois de trocar as variáveis some sozinha.
   */
  mensagens_agenda: {
    padrao: {
      canalId: null as string | null,
      marcado: 'Oi, {{primeiro_nome}}! Marcamos: *{{titulo}}*\n📅 {{dia}}, às {{hora}}\n{{onde}}\n{{portal}}',
      remarcado: 'Oi, {{primeiro_nome}}! Mudamos o horário: *{{titulo}}*\n📅 agora {{dia}}, às {{hora}}\n{{onde}}\n{{portal}}',
      cancelado: 'Oi, {{primeiro_nome}}! O compromisso *{{titulo}}* de {{dia}}, às {{hora}}, foi cancelado. Qualquer dúvida, é só responder aqui.',
      lembrete_dia: 'Oi, {{primeiro_nome}}! Lembrete: *{{titulo}}* amanhã ({{dia}}), às {{hora}}.\n{{onde}}\n{{portal}}',
      lembrete_hora: 'Oi, {{primeiro_nome}}! Daqui a pouco, às {{hora}}: *{{titulo}}*.\n{{onde}}',
    },
    schema: z.object({
      canalId: z.string().uuid().nullable(),
      marcado: z.string().trim().min(5, 'Escreva a mensagem de compromisso marcado.').max(1500),
      remarcado: z.string().trim().min(5, 'Escreva a mensagem de compromisso remarcado.').max(1500),
      cancelado: z.string().trim().min(5, 'Escreva a mensagem de compromisso cancelado.').max(1500),
      lembrete_dia: z.string().trim().min(5, 'Escreva o lembrete da véspera.').max(1500),
      lembrete_hora: z.string().trim().min(5, 'Escreva o lembrete de pouco antes.').max(1500),
    }),
  },
  /** Indique e ganhe: prêmio para quem traz uma nova consultora pelo próprio link. */
  indicacao: {
    padrao: { ativo: true, valor: 5000, valorEquipe: null as number | null, validadeDias: 120, lancarNoFinanceiro: true, prazoPagamentoDias: 10, mensagemConvite: 'Quer ganhar uma renda extra vendendo semijoias? Faça seu cadastro para ser consultora Aritana pelo meu link:' },
    schema: z.object({
      ativo: z.boolean(),
      /** Prêmio por consultora indicada (centavos), pago quando ela paga o primeiro pedido. */
      valor: z.number().int().min(0).max(10_000_000),
      /** Prêmio quando quem indicou é da equipe (null = o mesmo valor). */
      valorEquipe: z.number().int().min(0).max(10_000_000).nullable(),
      /** A nova consultora tem estes dias, depois de aprovada, para pagar o primeiro pedido; depois disso a indicação expira. */
      validadeDias: z.number().int().min(7).max(730),
      lancarNoFinanceiro: z.boolean(),
      prazoPagamentoDias: z.number().int().min(0).max(90),
      mensagemConvite: z.string().trim().max(300),
    }),
  },
  precificacao: {
    padrao: { ...REGRAS_PRECIFICACAO_PADRAO },
    schema: z.object({ ouro: regraMetal, prata: regraMetal, insumos: z.number().int().min(0).max(1_000_000), terminacao: z.number().int().min(0).max(99).nullable() }),
  },
  regras_pontos: {
    padrao: { ...REGRAS_PONTOS_PADRAO },
    schema: z.object({
      ativo: z.boolean(),
      porAcertoEmDia: z.number().int().min(0).max(10000),
      porCemReaisVendidos: z.number().int().min(0).max(10000),
      porMetaBatida: z.number().int().min(0).max(10000),
      porParcelaEmDia: z.number().int().min(0).max(10000),
      desde: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')]),
    }),
  },
  regras_garantia: {
    padrao: { prazoDias: 90 },
    schema: z.object({ prazoDias: z.number().int().min(0).max(3650) }),
  },
  regras_link: {
    padrao: { ativo: true, localId: '', comissaoPb: 1000, catalogoMatrizSemMaleta: true, aceitaEntrega: true, mensagemFinal: '' },
    schema: z.object({
      ativo: z.boolean(),
      /** Local do estoque da matriz que abastece os pedidos das afiliadas (vazio: o primeiro depósito ativo). */
      localId: z.union([z.literal(''), z.string().uuid()]),
      /** Comissão da consultora/afiliada sobre pedidos atendidos pela matriz. */
      comissaoPb: z.number().int().min(0).max(10000),
      /** Consultora sem maleta aberta mostra as peças da matriz (em vez de catálogo vazio). */
      catalogoMatrizSemMaleta: z.boolean(),
      aceitaEntrega: z.boolean(),
      mensagemFinal: z.string().max(300),
    }),
  },
  regras_comissao: {
    padrao: { lojaPadraoPb: 300, redeLiderPb: 0, diaPagamento: 10 },
    schema: z.object({ lojaPadraoPb: z.number().int().min(0).max(10000), redeLiderPb: z.number().int().min(0).max(10000), diaPagamento: z.number().int().min(1).max(28) }),
  },
  regras_rh: {
    padrao: {
      /** Batida fora da cerca do GPS: só sinaliza no espelho ou recusa. */
      cercaGps: 'sinalizar' as 'sinalizar' | 'bloquear',
      exigirFoto: true,
      /** Número de registro do programa no INPI (aparece no AFD, no AEJ e no comprovante). */
      inpi: '',
      contabilidadeNome: '',
      contabilidadeEmail: '',
      contabilidadeWhatsapp: '',
      /** Número de WhatsApp da empresa que manda os arquivos para a contabilidade. */
      contabilidadeCanalId: '',
      /** Quem desenvolveu o programa de ponto (identificação obrigatória no AEJ). */
      desenvolvedorDocumento: '',
      desenvolvedorNome: 'Wide Inteligência Comercial',
      desenvolvedorEmail: 'contato@wideic.com',
    },
    schema: z.object({
      cercaGps: z.enum(['sinalizar', 'bloquear']),
      exigirFoto: z.boolean(),
      inpi: z.string().max(17),
      contabilidadeNome: z.string().max(120),
      contabilidadeEmail: z.union([z.literal(''), z.string().email('E-mail da contabilidade inválido')]),
      contabilidadeWhatsapp: z.string().max(20),
      contabilidadeCanalId: z.string().max(40),
      desenvolvedorDocumento: z.string().max(18),
      desenvolvedorNome: z.string().max(150),
      desenvolvedorEmail: z.string().max(50),
    }),
  },
} as const;

export type ChaveConfig = keyof typeof CONFIGS;
export type ValorConfig<K extends ChaveConfig> = (typeof CONFIGS)[K]['padrao'];
