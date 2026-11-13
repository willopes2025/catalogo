/**
 * Todo valor em dinheiro circula em CENTAVOS (número inteiro).
 * Ex.: R$ 129,90 = 12990. Assim não há erro de arredondamento de ponto flutuante.
 */
export type Centavos = number;

/** Percentual em pontos-base para evitar frações: 100 = 1%, 2500 = 25%. */
export type PontosBase = number;

/** Aplica um percentual (em pontos-base) a um valor em centavos, arredondando para o centavo mais próximo. */
export function aplicarPercentual(valor: Centavos, pct: PontosBase): Centavos {
  return Math.round((valor * pct) / 10000);
}

export function reaisParaCentavos(reais: number): Centavos {
  return Math.round(reais * 100);
}

export function formatarReais(c: Centavos): string {
  const negativo = c < 0;
  const abs = Math.abs(c);
  const inteiro = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const centavos = (abs % 100).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}R$ ${inteiro},${centavos}`;
}

export function somar(valores: Centavos[]): Centavos {
  return valores.reduce((a, b) => a + b, 0);
}
