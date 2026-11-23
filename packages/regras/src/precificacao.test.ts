import { describe, expect, it } from 'vitest';
import { REGRAS_PRECIFICACAO_PADRAO as R, arredondarTerminacao, calcularPreco, metalDoTexto } from './precificacao';

describe('precificação pela fórmula da planilha', () => {
  it('ouro: (bruto + peso × 5,50) × 7 + insumos', () => {
    // Choker Corrente Oval Achatada: 20 g, bruto 9,50 → planilha dá 841,50
    const p = calcularPreco({ peso: 20, bruto: 950, metal: 'ouro' }, R);
    expect([p.banho, p.custoTotal, p.multiplicador, p.sugerido]).toEqual([11000, 11950, 700, 84150]);
    // Colar Anjinho: 4,21 g, bruto 7,00 → 216,085 na planilha
    expect(calcularPreco({ peso: 4.21, bruto: 700, metal: 'ouro' }, R).sugerido).toBe(21609);
  });
  it('prata: markup por faixa do custo total', () => {
    // Choker Aro com Coração: 6 g, bruto 4,00 → custo 13,00 → ×10 + 5 = 135,00
    expect(calcularPreco({ peso: 6, bruto: 400, metal: 'prata' }, R).sugerido).toBe(13500);
    // Colar Aro Liso: 6,4 g, bruto 4,00 → 13,60 × 10 + 5 = 141,00
    expect(calcularPreco({ peso: 6.4, bruto: 400, metal: 'prata' }, R).sugerido).toBe(14100);
    expect(calcularPreco({ peso: 10, bruto: 1000, metal: 'prata' }, R).multiplicador).toBe(900);
    expect(calcularPreco({ peso: 10, bruto: 3000, metal: 'prata' }, R).multiplicador).toBe(800);
    expect(calcularPreco({ peso: 10, bruto: 6000, metal: 'prata' }, R).multiplicador).toBe(700);
  });
  it('coeficiente e insumos próprios da peça', () => {
    const p = calcularPreco({ peso: 10, bruto: 0, metal: 'ouro', coeficiente: 400, insumos: 0 }, R);
    expect([p.banho, p.sugerido]).toEqual([4000, 28000]);
  });
  it('terminação', () => {
    expect(arredondarTerminacao(14100, 90)).toBe(14190);
    expect(arredondarTerminacao(14195, 90)).toBe(14290);
    expect(arredondarTerminacao(14190, 90)).toBe(14190);
    expect(arredondarTerminacao(14123, null)).toBe(14123);
  });
  it('metal pelo texto do cadastro', () => {
    expect(metalDoTexto('B. de Prata')).toBe('prata');
    expect(metalDoTexto('-', 'Colar Fígaro Elos 3x1 Banho Ouro')).toBe('ouro');
    expect(metalDoTexto('Ouro 18k')).toBe('ouro');
    expect(metalDoTexto('Aço Prateado')).toBe('prata');
    expect(metalDoTexto('-', 'Choker 3 esferas')).toBeNull();
    expect(metalDoTexto(null, 'Colar ouro e prata')).toBeNull();
  });
});
