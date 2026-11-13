import type { Centavos } from './dinheiro';
import { somarDias, type DataISO } from './datas';

export interface Parcela {
  numero: number;
  valor: Centavos;
  vencimento: DataISO;
}

/** Divide o total em parcelas iguais; a diferença de centavos vai para a primeira. */
export function gerarParcelas(total: Centavos, quantidade: number, primeiroVencimento: DataISO, intervaloDias = 30): Parcela[] {
  if (!Number.isInteger(quantidade) || quantidade < 1) throw new Error('Quantidade de parcelas inválida');
  if (total <= 0) return [];
  const base = Math.floor(total / quantidade);
  const resto = total - base * quantidade;
  return Array.from({ length: quantidade }, (_, i) => ({
    numero: i + 1,
    valor: base + (i === 0 ? resto : 0),
    vencimento: somarDias(primeiroVencimento, i * intervaloDias),
  }));
}
