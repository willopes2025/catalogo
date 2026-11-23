import type { Centavos } from './dinheiro';

/**
 * Precificação das peças pela fórmula que a Aritana usa na planilha:
 *   custo do banho = peso da peça (g) × coeficiente do metal (R$ por grama)
 *   custo total    = custo bruto + custo do banho
 *   preço sugerido = custo total × multiplicador (markup) + insumos
 * O multiplicador pode mudar por faixa de custo total (peça barata leva markup maior).
 * O preço final é decisão de quem precifica: o sugerido é só o ponto de partida.
 */
export type Metal = 'ouro' | 'prata';

export interface FaixaMarkup {
  /** Custo total (bruto + banho) até este valor, em centavos. null = daqui para cima. */
  ate: Centavos | null;
  /** Multiplicador em centésimos: 700 = ×7. */
  multiplicador: number;
}

export interface RegraMetal {
  /** Centavos por grama de peça. */
  coeficiente: Centavos;
  faixas: FaixaMarkup[];
}

export interface RegrasPrecificacao {
  ouro: RegraMetal;
  prata: RegraMetal;
  /** Insumos por peça (embalagem, tag, etc.), em centavos. */
  insumos: Centavos;
  /** Centavos em que o preço sugerido termina (90 = …,90). null = não arredonda. */
  terminacao: number | null;
}

export const REGRAS_PRECIFICACAO_PADRAO: RegrasPrecificacao = {
  ouro: { coeficiente: 550, faixas: [{ ate: null, multiplicador: 700 }] },
  prata: {
    coeficiente: 150,
    faixas: [
      { ate: 1500, multiplicador: 1000 },
      { ate: 3000, multiplicador: 900 },
      { ate: 5000, multiplicador: 800 },
      { ate: null, multiplicador: 700 },
    ],
  },
  insumos: 500,
  terminacao: 90,
};

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Descobre o metal do banho pelo que está escrito no cadastro (banho, cor ou descrição, nesta ordem). */
export function metalDoTexto(...textos: (string | null | undefined)[]): Metal | null {
  for (const t of textos) {
    if (!t) continue;
    const s = semAcento(t);
    const prata = /prata|pratead|rodio/.test(s);
    const ouro = /ouro|dourad|18k/.test(s);
    if (prata !== ouro) return prata ? 'prata' : 'ouro';
  }
  return null;
}

/** Multiplicador da faixa em que o custo total cai. */
export function multiplicadorDaFaixa(regra: RegraMetal, custoTotal: Centavos): number {
  const ordenadas = [...regra.faixas].sort((a, b) => (a.ate ?? Infinity) - (b.ate ?? Infinity));
  return (ordenadas.find((f) => f.ate === null || custoTotal <= f.ate) ?? ordenadas[ordenadas.length - 1])?.multiplicador ?? 100;
}

/** Sobe o preço até o próximo valor com a terminação pedida (90 → 141,00 vira 141,90; 141,95 vira 142,90). */
export function arredondarTerminacao(valor: Centavos, terminacao: number | null): Centavos {
  if (terminacao === null || valor <= 0) return Math.max(0, Math.round(valor));
  const v = Math.round(valor);
  const base = Math.floor(v / 100) * 100 + terminacao;
  return base >= v ? base : base + 100;
}

export interface EntradaPreco {
  /** Peso da peça em gramas. */
  peso: number;
  bruto: Centavos;
  metal: Metal;
  /** Coeficiente desta peça (centavos por grama). Sem ele, vale o da regra. */
  coeficiente?: number | null;
  /** Insumos desta peça. Sem ele, vale o da regra. */
  insumos?: Centavos | null;
}

export interface PrecoCalculado {
  coeficiente: number;
  banho: Centavos;
  custoTotal: Centavos;
  multiplicador: number;
  insumos: Centavos;
  /** Preço da fórmula, sem arredondar. */
  sugerido: Centavos;
  /** Sugerido com a terminação da regra. */
  arredondado: Centavos;
}

export function calcularPreco(e: EntradaPreco, regras: RegrasPrecificacao): PrecoCalculado {
  const regra = regras[e.metal];
  const coeficiente = e.coeficiente ?? regra.coeficiente;
  // A conta usa o banho sem arredondar (como a planilha); os centavos só são fechados no fim.
  const banhoExato = Math.max(0, e.peso) * coeficiente;
  const exato = Math.max(0, e.bruto) + banhoExato;
  const multiplicador = multiplicadorDaFaixa(regra, exato);
  const insumos = e.insumos ?? regras.insumos;
  const sugerido = Math.round((exato * multiplicador) / 100 + 1e-6) + insumos;
  const banho = Math.round(banhoExato);
  return { coeficiente, banho, custoTotal: Math.max(0, e.bruto) + banho, multiplicador, insumos, sugerido, arredondado: arredondarTerminacao(sugerido, regras.terminacao) };
}
