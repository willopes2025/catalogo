import { aplicarPercentual, type Centavos, type PontosBase } from './dinheiro';
import { diasEntre, somarDias, type DataISO } from './datas';

export interface RegrasEncargos {
  /** Multa única por atraso (ex.: 200 = 2%). */
  multaPb: PontosBase;
  /** Juros simples por mês de atraso, cobrados por dia (ex.: 100 = 1% ao mês). */
  jurosMesPb: PontosBase;
  /** Dias depois do vencimento sem multa nem juros. */
  diasCarencia: number;
}

export interface Encargos {
  dias: number;
  multa: Centavos;
  juros: Centavos;
  total: Centavos;
}

/** Multa e juros de um valor vencido em `vencimento`, calculados até `ate`. */
export function calcularEncargos(valor: Centavos, vencimento: DataISO, ate: DataISO, r: RegrasEncargos): Encargos {
  const dias = Math.max(0, diasEntre(vencimento, ate));
  if (dias <= Math.max(0, r.diasCarencia) || valor <= 0) return { dias, multa: 0, juros: 0, total: valor };
  const multa = aplicarPercentual(valor, r.multaPb);
  // Juros simples pro rata dia: (juros do mês / 30) por dia de atraso.
  const juros = Math.round((valor * r.jurosMesPb * dias) / (10000 * 30));
  return { dias, multa, juros, total: valor + multa + juros };
}

/** Mesmo dia nos meses seguintes; em mês mais curto, cai no último dia (31/01 → 28/02). */
export function somarMeses(d: DataISO, meses: number): DataISO {
  const [a, m, dia] = d.slice(0, 10).split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m + meses, 0)).getUTCDate();
  return new Date(Date.UTC(a, m - 1 + meses, Math.min(dia, ultimo))).toISOString().slice(0, 10);
}

export interface PedidoAcordo {
  itens: { valor: Centavos; vencimento: DataISO }[];
  /** Data da negociação (os encargos são calculados até ela). */
  data: DataISO;
  regras: RegrasEncargos;
  /** Desconto em centavos sobre o total atualizado. */
  desconto: Centavos;
  /** Entrada em centavos (0 = sem entrada). */
  entrada: Centavos;
  vencimentoEntrada?: DataISO;
  parcelas: number;
  primeiroVencimento: DataISO;
  /** De quanto em quanto tempo vencem as parcelas (padrão: mensal, no mesmo dia do mês). */
  intervalo?: IntervaloParcelas;
}

export type IntervaloParcelas = 'mensal' | 'quinzenal' | 'semanal';
/** Vencimento da parcela n (0 = primeira) conforme o intervalo. */
export function vencimentoParcela(primeiro: DataISO, n: number, intervalo: IntervaloParcelas = 'mensal'): DataISO {
  if (intervalo === 'quinzenal') return somarDias(primeiro, 15 * n);
  if (intervalo === 'semanal') return somarDias(primeiro, 7 * n);
  return somarMeses(primeiro, n);
}

export interface ResultadoAcordo {
  original: Centavos;
  multa: Centavos;
  juros: Centavos;
  atualizado: Centavos;
  desconto: Centavos;
  total: Centavos;
  /** Desconto como percentual do total atualizado. */
  descontoPb: PontosBase;
  entrada: { valor: Centavos; vencimento: DataISO } | null;
  parcelas: { numero: number; valor: Centavos; vencimento: DataISO }[];
}

/**
 * Calcula um acordo: soma os títulos com multa e juros até a data, tira o desconto,
 * separa a entrada e divide o resto em parcelas mensais iguais (a diferença de centavos vai na última).
 */
export function calcularAcordo(p: PedidoAcordo): ResultadoAcordo {
  if (!p.itens.length) throw new Error('Escolha ao menos um título.');
  if (!Number.isInteger(p.parcelas) || p.parcelas < 1) throw new Error('Quantidade de parcelas inválida.');
  let original = 0;
  let multa = 0;
  let juros = 0;
  for (const i of p.itens) {
    const e = calcularEncargos(i.valor, i.vencimento, p.data, p.regras);
    original += i.valor;
    multa += e.multa;
    juros += e.juros;
  }
  const atualizado = original + multa + juros;
  const desconto = Math.max(0, Math.round(p.desconto));
  if (desconto >= atualizado) throw new Error('O desconto não pode ser maior que a dívida.');
  const total = atualizado - desconto;
  const entrada = Math.max(0, Math.round(p.entrada));
  if (entrada > total) throw new Error('A entrada é maior que o total do acordo.');
  const resto = total - entrada;
  const parcelas: ResultadoAcordo['parcelas'] = [];
  if (resto > 0) {
    const base = Math.floor(resto / p.parcelas);
    if (base < 100) throw new Error('Cada parcela precisa ser de pelo menos R$ 1,00.');
    const sobra = resto - base * p.parcelas;
    for (let n = 0; n < p.parcelas; n++) parcelas.push({ numero: n + 1, valor: base + (n === p.parcelas - 1 ? sobra : 0), vencimento: vencimentoParcela(p.primeiroVencimento, n, p.intervalo) });
  }
  return {
    original,
    multa,
    juros,
    atualizado,
    desconto,
    total,
    descontoPb: atualizado ? Math.round((desconto * 10000) / atualizado) : 0,
    entrada: entrada > 0 ? { valor: entrada, vencimento: p.vencimentoEntrada ?? p.data } : null,
    parcelas,
  };
}

/** Faixa de atraso para o painel de cobrança. */
export function faixaAtraso(dias: number): 'a_vencer' | '1_30' | '31_60' | '61_90' | '91_180' | 'mais_180' {
  if (dias <= 0) return 'a_vencer';
  if (dias <= 30) return '1_30';
  if (dias <= 60) return '31_60';
  if (dias <= 90) return '61_90';
  if (dias <= 180) return '91_180';
  return 'mais_180';
}

/** Troca as variáveis {nome}, {valor}… de um texto da régua. Variável sem valor some. */
export function preencherTexto(modelo: string, v: Record<string, string | number | null | undefined>): string {
  return modelo.replace(/\{([a-z_]+)\}/g, (_, k: string) => (v[k] === null || v[k] === undefined ? '' : String(v[k]))).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
