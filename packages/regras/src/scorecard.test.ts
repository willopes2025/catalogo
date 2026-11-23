import { describe, expect, it } from 'vitest';
import { REGRAS_SCORECARD_PADRAO as R, calcularScorecard, notaIndicador } from './scorecard';

describe('scorecard', () => {
  it('nota do indicador: maior é melhor, menor é melhor, teto', () => {
    expect(notaIndicador({ meta: 100, sentido: 'maior', resultado: 80 }, 100)).toBe(80);
    expect(notaIndicador({ meta: 100, sentido: 'maior', resultado: 130 }, 100)).toBe(100);
    expect(notaIndicador({ meta: 100, sentido: 'maior', resultado: 130 }, 120)).toBe(120);
    // Menor é melhor (ex.: atrasos): 5 de meta, fez 10 → 50; fez 0 → acima da meta (limitado ao teto).
    expect(notaIndicador({ meta: 5, sentido: 'menor', resultado: 10 }, 100)).toBe(50);
    expect(notaIndicador({ meta: 5, sentido: 'menor', resultado: 5 }, 100)).toBe(100);
    expect(notaIndicador({ meta: 5, sentido: 'menor', resultado: 0 }, 120)).toBe(120);
    expect(notaIndicador({ meta: 0, sentido: 'menor', resultado: 2 }, 100)).toBe(0);
    expect(notaIndicador({ meta: 0, sentido: 'menor', resultado: 0 }, 100)).toBe(100);
    expect(notaIndicador({ meta: 10, sentido: 'maior', resultado: null }, 100)).toBeNull();
  });
  it('média ponderada, acertos e erros com limite, faixa de bônus', () => {
    const r = calcularScorecard(
      [
        { meta: 100, sentido: 'maior', peso: 3, resultado: 90 }, // 90
        { meta: 10, sentido: 'menor', peso: 1, resultado: 20 }, // 50
        { meta: 1, sentido: 'maior', peso: 5, resultado: null }, // fora
      ],
      [{ tipo: 'acerto', pontos: 8 }, { tipo: 'acerto', pontos: 9 }, { tipo: 'erro', pontos: 3 }],
      R,
      50000,
    );
    expect(r.notas).toEqual([90, 50, null]);
    expect(r.notaIndicadores).toBe(80);
    expect([r.acertos, r.erros, r.ajuste]).toEqual([17, 3, 10]);
    expect(r.notaFinal).toBe(90);
    expect([r.percentualBonus, r.bonus]).toEqual([100, 50000]);
    const ruim = calcularScorecard([{ meta: 100, sentido: 'maior', peso: 1, resultado: 70 }], [{ tipo: 'erro', pontos: 15 }], R, 50000);
    expect([ruim.ajuste, ruim.notaFinal, ruim.percentualBonus, ruim.bonus]).toEqual([-10, 60, 40, 20000]);
    expect(calcularScorecard([{ meta: 100, sentido: 'maior', peso: 1, resultado: 50 }], [], R, 50000).bonus).toBe(0);
    expect(calcularScorecard([], [{ tipo: 'acerto', pontos: 5 }], R, 50000).notaFinal).toBeNull();
  });
});
