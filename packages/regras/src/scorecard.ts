import type { Centavos } from './dinheiro';

/**
 * Balanced scorecard da equipe: cada pessoa é avaliada no mês por indicadores com meta e peso,
 * mais os acertos e erros registrados durante o mês. A nota final define a faixa de bônus.
 * Tudo é configurável pela gestão no sistema; aqui fica só a conta.
 */
export type Sentido = 'maior' | 'menor';

export interface RegrasScorecard {
  /** Nota máxima de um indicador, em %: 100 = bater a meta é o máximo; 120 = superar a meta rende até 120. */
  teto: number;
  /** Quanto os acertos e erros do mês podem mexer na nota, para mais ou para menos (pontos). */
  limiteOcorrencias: number;
  /** Bônus cheio de cada pessoa, em centavos, quando o setor não tem um valor próprio. */
  bonusPadrao: Centavos;
  /** Bônus cheio por setor (id do grupo de usuários), em centavos. */
  bonusPorSetor: Record<string, Centavos>;
  /** A partir de qual nota a pessoa recebe qual parte do bônus. */
  faixas: { notaMinima: number; percentual: number }[];
  /** A pessoa vê a própria avaliação depois de fechada (na Minha mesa). */
  mostrarAoFuncionario: boolean;
}

export const REGRAS_SCORECARD_PADRAO: RegrasScorecard = {
  teto: 100,
  limiteOcorrencias: 10,
  bonusPadrao: 0,
  bonusPorSetor: {},
  faixas: [
    { notaMinima: 90, percentual: 100 },
    { notaMinima: 75, percentual: 70 },
    { notaMinima: 60, percentual: 40 },
  ],
  mostrarAoFuncionario: true,
};

export interface ItemScorecard {
  meta: number;
  sentido: Sentido;
  peso: number;
  /** null = ainda sem resultado (fica fora da conta). */
  resultado: number | null;
}

const arred = (n: number) => Math.round(n * 10) / 10;

/** Nota de um indicador (0 até o teto): quanto da meta foi atingido. */
export function notaIndicador(i: Pick<ItemScorecard, 'meta' | 'sentido' | 'resultado'>, teto: number): number | null {
  if (i.resultado === null || !Number.isFinite(i.resultado)) return null;
  const r = Math.max(0, i.resultado);
  let atingido: number;
  if (i.sentido === 'maior') atingido = i.meta > 0 ? r / i.meta : 1;
  else atingido = r <= i.meta ? 1 + (i.meta > 0 ? (i.meta - r) / i.meta : 0) : i.meta > 0 ? i.meta / r : 0;
  return arred(Math.min(teto, Math.max(0, atingido * 100)));
}

export interface ResultadoScorecard {
  notas: (number | null)[];
  /** Média ponderada dos indicadores com resultado. */
  notaIndicadores: number | null;
  acertos: number;
  erros: number;
  /** Acertos menos erros, dentro do limite. */
  ajuste: number;
  notaFinal: number | null;
  percentualBonus: number;
  bonus: Centavos;
}

export function calcularScorecard(itens: ItemScorecard[], ocorrencias: { tipo: 'acerto' | 'erro'; pontos: number }[], regras: RegrasScorecard, bonusCheio: Centavos): ResultadoScorecard {
  const notas = itens.map((i) => notaIndicador(i, regras.teto));
  let soma = 0;
  let pesos = 0;
  itens.forEach((i, k) => {
    const n = notas[k];
    if (n === null || i.peso <= 0) return;
    soma += n * i.peso;
    pesos += i.peso;
  });
  const notaIndicadores = pesos > 0 ? arred(soma / pesos) : null;
  const acertos = arred(ocorrencias.filter((o) => o.tipo === 'acerto').reduce((a, o) => a + Math.max(0, o.pontos), 0));
  const erros = arred(ocorrencias.filter((o) => o.tipo === 'erro').reduce((a, o) => a + Math.max(0, o.pontos), 0));
  const lim = Math.max(0, regras.limiteOcorrencias);
  const ajuste = arred(Math.max(-lim, Math.min(lim, acertos - erros)));
  const notaFinal = notaIndicadores === null ? null : arred(Math.max(0, Math.min(regras.teto, notaIndicadores + ajuste)));
  const faixa = notaFinal === null ? undefined : [...regras.faixas].sort((a, b) => b.notaMinima - a.notaMinima).find((f) => notaFinal >= f.notaMinima);
  const percentualBonus = faixa?.percentual ?? 0;
  return { notas, notaIndicadores, acertos, erros, ajuste, notaFinal, percentualBonus, bonus: Math.round((Math.max(0, bonusCheio) * percentualBonus) / 100) };
}
