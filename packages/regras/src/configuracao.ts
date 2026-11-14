import type { Centavos, PontosBase } from './dinheiro';

/**
 * Regras do consignado. Ficam numa tela de Configurações e podem ser mudadas
 * pela Aritana sem programador. Os valores padrão abaixo são os que a Aritana
 * usa hoje no Jueri: comissão fixa de 30%, acerto em 30 dias, meta de 30%,
 * sem multa, sem juros e sem bloqueio automático por atraso.
 */
export interface RegrasConsignado {
  /** Dias entre a retirada e o acerto. */
  prazoAcertoDias: number;
  /** Comissão da representante quando ela paga o acerto à vista (pontos-base: 3000 = 30%). */
  comissaoAvistaPb: PontosBase;
  /** Comissão quando ela paga a prazo (boleto ou cartão parcelado). */
  comissaoPrazoPb: PontosBase;
  /** Multa única por atraso (pontos-base sobre o valor devido). */
  multaAtrasoPb: PontosBase;
  /** Juros por mês de atraso, cobrados por dia (pontos-base ao mês). */
  jurosMesPb: PontosBase;
  /** Dias de tolerância antes de começar a cobrar multa e juros. */
  carenciaDias: number;
  /** Dias de atraso a partir dos quais não pode retirar nova maleta. 0 = nunca bloqueia (só avisa). */
  diasParaBloquear: number;
  /** Peça perdida ou quebrada é cobrada pelo custo (true) ou pelo preço de venda (false). */
  perdidaPeloCusto: boolean;
  /** Limite de crédito da primeira maleta. */
  limiteInicial: Centavos;
  /** Limite máximo que o crédito pode alcançar. */
  limiteMaximo: Centavos;
  /** Aumento do limite após um acerto em dia que bateu a meta (pontos-base). */
  aumentoLimitePb: PontosBase;
  /** Percentual mínimo vendido da maleta para contar como meta batida (pontos-base). */
  metaMinimaVendidaPb: PontosBase;
  /** Quantidade de maletas abertas ao mesmo tempo por representante. */
  maletasSimultaneas: number;
  /** Número máximo de parcelas no acerto. */
  parcelasMaximas: number;
}

export const REGRAS_PADRAO: RegrasConsignado = {
  prazoAcertoDias: 30,
  comissaoAvistaPb: 3000,
  comissaoPrazoPb: 3000,
  multaAtrasoPb: 0,
  jurosMesPb: 0,
  carenciaDias: 0,
  diasParaBloquear: 0,
  perdidaPeloCusto: true,
  limiteInicial: 150_000,
  limiteMaximo: 1_500_000,
  aumentoLimitePb: 2000,
  metaMinimaVendidaPb: 3000,
  maletasSimultaneas: 1,
  parcelasMaximas: 3,
};
