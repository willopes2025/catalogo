import type { RegrasConsignado } from './configuracao';
import { aplicarPercentual, type Centavos } from './dinheiro';

export interface SituacaoRepresentante {
  limite: Centavos;
  /** Valor em peças que ela tem hoje em maletas abertas (preço de etiqueta). */
  emMaletas: Centavos;
  maletasAbertas: number;
  /** Maior atraso, em dias, entre acertos e títulos em aberto. */
  maiorAtrasoDias: number;
  bloqueadaManualmente: boolean;
}

export interface Liberacao {
  pode: boolean;
  creditoLivre: Centavos;
  motivos: string[];
}

/** Diz se a representante pode receber uma maleta deste valor, e por quê não. */
export function podeRetirarMaleta(s: SituacaoRepresentante, valorMaleta: Centavos, regras: RegrasConsignado): Liberacao {
  const creditoLivre = Math.max(0, s.limite - s.emMaletas);
  const motivos: string[] = [];
  if (s.bloqueadaManualmente) motivos.push('Representante bloqueada pela matriz.');
  if (regras.diasParaBloquear > 0 && s.maiorAtrasoDias >= regras.diasParaBloquear) motivos.push(`Pendência com ${s.maiorAtrasoDias} dias de atraso.`);
  if (s.maletasAbertas >= regras.maletasSimultaneas) motivos.push(`Já tem ${s.maletasAbertas} maleta(s) aberta(s); o máximo é ${regras.maletasSimultaneas}.`);
  if (valorMaleta > creditoLivre) motivos.push('Valor da maleta passa do crédito livre.');
  return { pode: motivos.length === 0, creditoLivre, motivos };
}

/**
 * Novo limite depois de um acerto.
 * Em dia e com a meta batida: aumenta. Com atraso acima do prazo de bloqueio (se houver): volta ao limite inicial.
 * Caso contrário: mantém.
 */
export function novoLimite(
  limiteAtual: Centavos,
  acerto: { diasAtraso: number; percentualVendidoPb: number; houvePerda: boolean },
  regras: RegrasConsignado,
): { limite: Centavos; motivo: string } {
  if (regras.diasParaBloquear > 0 && acerto.diasAtraso >= regras.diasParaBloquear) {
    return { limite: Math.min(limiteAtual, regras.limiteInicial), motivo: 'Acerto com atraso: limite reduzido ao inicial.' };
  }
  if (acerto.diasAtraso === 0 && acerto.percentualVendidoPb >= regras.metaMinimaVendidaPb && !acerto.houvePerda) {
    const aumentado = limiteAtual + aplicarPercentual(limiteAtual, regras.aumentoLimitePb);
    const limite = Math.min(aumentado, regras.limiteMaximo);
    return { limite, motivo: limite > limiteAtual ? 'Acerto em dia com meta batida: limite aumentado.' : 'Limite já está no máximo.' };
  }
  return { limite: limiteAtual, motivo: 'Limite mantido.' };
}
