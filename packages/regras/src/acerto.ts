import type { RegrasConsignado } from './configuracao';
import { aplicarPercentual, somar, type Centavos } from './dinheiro';
import { diasEntre, type DataISO } from './datas';

export type FormaAcerto = 'avista' | 'prazo';

export interface ItemAcerto {
  produtoId: string;
  /** Preço de etiqueta (a representante vende pelo preço de etiqueta). */
  preco: Centavos;
  custo: Centavos;
  /** Quantidade que está na maleta (ainda não acertada). */
  emMaleta: number;
  vendida: number;
  devolvida: number;
  perdida: number;
}

export interface EntradaAcerto {
  itens: ItemAcerto[];
  forma: FormaAcerto;
  dataLimite: DataISO;
  dataAcerto: DataISO;
  /** Créditos que a representante tem (devoluções anteriores etc.). */
  creditoDisponivel: Centavos;
  /** Acerto parcial: aceita peças que continuam na maleta. */
  parcial: boolean;
  regras: RegrasConsignado;
}

export interface ResultadoAcerto {
  pecas: { emMaleta: number; vendidas: number; devolvidas: number; perdidas: number; continuam: number };
  totalVendido: Centavos;
  comissaoPb: number;
  comissao: Centavos;
  /** Valor das vendas que pertence à matriz (vendido − comissão). */
  liquidoVendas: Centavos;
  perdidas: Centavos;
  diasAtraso: number;
  multa: Centavos;
  juros: Centavos;
  subtotal: Centavos;
  creditoUsado: Centavos;
  totalAPagar: Centavos;
  /** Percentual vendido sobre o valor que estava na maleta (pontos-base). */
  percentualVendidoPb: number;
}

export class ErroAcerto extends Error {}

/**
 * Calcula o acerto da maleta:
 *   vendido − comissão (à vista ou a prazo) + peças perdidas + multa + juros − créditos.
 * Multa e juros incidem só sobre o que é devido pelas vendas e pelas perdas, nunca sobre a comissão.
 */
export function calcularAcerto(e: EntradaAcerto): ResultadoAcerto {
  const { regras } = e;
  let continuam = 0;

  for (const it of e.itens) {
    if ([it.vendida, it.devolvida, it.perdida].some((q) => q < 0 || !Number.isInteger(q))) {
      throw new ErroAcerto(`Quantidade inválida no produto ${it.produtoId}`);
    }
    const informado = it.vendida + it.devolvida + it.perdida;
    if (informado > it.emMaleta) {
      throw new ErroAcerto(`Produto ${it.produtoId}: informado ${informado}, mas só há ${it.emMaleta} na maleta`);
    }
    if (informado < it.emMaleta && !e.parcial) {
      throw new ErroAcerto(`Produto ${it.produtoId}: faltam ${it.emMaleta - informado} peça(s) sem destino. Marque como vendida, devolvida ou perdida, ou faça acerto parcial.`);
    }
    continuam += it.emMaleta - informado;
  }

  const totalVendido = somar(e.itens.map((i) => i.preco * i.vendida));
  const valorMaleta = somar(e.itens.map((i) => i.preco * i.emMaleta));
  const comissaoPb = e.forma === 'avista' ? regras.comissaoAvistaPb : regras.comissaoPrazoPb;
  const comissao = aplicarPercentual(totalVendido, comissaoPb);
  const liquidoVendas = totalVendido - comissao;
  const perdidas = somar(e.itens.map((i) => (regras.perdidaPeloCusto ? i.custo : i.preco) * i.perdida));

  const atrasoBruto = Math.max(0, diasEntre(e.dataLimite, e.dataAcerto));
  const diasAtraso = atrasoBruto > regras.carenciaDias ? atrasoBruto : 0;
  const baseEncargos = liquidoVendas + perdidas;
  const multa = diasAtraso > 0 ? aplicarPercentual(baseEncargos, regras.multaAtrasoPb) : 0;
  const juros = diasAtraso > 0 ? Math.round((baseEncargos * regras.jurosMesPb * diasAtraso) / (10000 * 30)) : 0;

  const subtotal = liquidoVendas + perdidas + multa + juros;
  const creditoUsado = Math.max(0, Math.min(e.creditoDisponivel, subtotal));

  return {
    pecas: {
      emMaleta: somar(e.itens.map((i) => i.emMaleta)),
      vendidas: somar(e.itens.map((i) => i.vendida)),
      devolvidas: somar(e.itens.map((i) => i.devolvida)),
      perdidas: somar(e.itens.map((i) => i.perdida)),
      continuam,
    },
    totalVendido,
    comissaoPb,
    comissao,
    liquidoVendas,
    perdidas,
    diasAtraso,
    multa,
    juros,
    subtotal,
    creditoUsado,
    totalAPagar: subtotal - creditoUsado,
    percentualVendidoPb: valorMaleta > 0 ? Math.round((totalVendido * 10000) / valorMaleta) : 0,
  };
}
