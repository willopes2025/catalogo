import { describe, expect, it } from 'vitest';
import { calcularAcordo, calcularEncargos, faixaAtraso, preencherTexto, somarMeses } from './cobranca';

const r = { multaPb: 200, jurosMesPb: 100, diasCarencia: 0 };

describe('encargos de atraso', () => {
  it('em dia não cobra nada', () => {
    expect(calcularEncargos(10000, '2026-11-10', '2026-11-10', r)).toEqual({ dias: 0, multa: 0, juros: 0, total: 10000 });
    expect(calcularEncargos(10000, '2026-11-10', '2026-11-01', r).total).toBe(10000);
  });
  it('multa de 2% e juros de 1% ao mês por dia', () => {
    // R$ 100,00 com 30 dias: multa R$ 2,00 + juros R$ 1,00
    expect(calcularEncargos(10000, '2026-10-01', '2026-10-31', r)).toEqual({ dias: 30, multa: 200, juros: 100, total: 10300 });
    // 15 dias: juros de meio mês
    expect(calcularEncargos(10000, '2026-10-01', '2026-10-16', r).juros).toBe(50);
  });
  it('respeita a carência', () => {
    expect(calcularEncargos(10000, '2026-10-01', '2026-10-04', { ...r, diasCarencia: 3 }).total).toBe(10000);
    expect(calcularEncargos(10000, '2026-10-01', '2026-10-05', { ...r, diasCarencia: 3 }).multa).toBe(200);
  });
});

describe('acordo', () => {
  it('soma, desconta, separa a entrada e parcela', () => {
    const a = calcularAcordo({
      itens: [{ valor: 10000, vencimento: '2026-10-01' }, { valor: 5000, vencimento: '2026-10-31' }],
      data: '2026-10-31', regras: r, desconto: 300, entrada: 3000, vencimentoEntrada: '2026-11-05', parcelas: 3, primeiroVencimento: '2026-11-30',
    });
    expect([a.original, a.multa, a.juros, a.atualizado]).toEqual([15000, 200, 100, 15300]);
    expect([a.desconto, a.total]).toEqual([300, 15000]);
    expect(a.entrada).toEqual({ valor: 3000, vencimento: '2026-11-05' });
    expect(a.parcelas.map((p) => p.valor)).toEqual([4000, 4000, 4000]);
    expect(a.parcelas.map((p) => p.vencimento)).toEqual(['2026-11-30', '2026-12-30', '2027-01-30']);
    expect(a.descontoPb).toBe(196);
  });
  it('centavos que sobram vão na última parcela', () => {
    const a = calcularAcordo({ itens: [{ valor: 10000, vencimento: '2026-11-01' }], data: '2026-11-01', regras: r, desconto: 0, entrada: 0, parcelas: 3, primeiroVencimento: '2026-11-30' });
    expect(a.parcelas.map((p) => p.valor)).toEqual([3333, 3333, 3334]);
    expect(a.entrada).toBeNull();
  });
  it('à vista: só a entrada', () => {
    const a = calcularAcordo({ itens: [{ valor: 10000, vencimento: '2026-11-01' }], data: '2026-11-01', regras: r, desconto: 0, entrada: 10000, parcelas: 1, primeiroVencimento: '2026-11-30' });
    expect(a.parcelas).toEqual([]);
    expect(a.entrada?.valor).toBe(10000);
  });
  it('recusa o que não fecha', () => {
    const base = { itens: [{ valor: 10000, vencimento: '2026-11-01' }], data: '2026-11-01', regras: r, desconto: 0, entrada: 0, parcelas: 2, primeiroVencimento: '2026-11-30' };
    expect(() => calcularAcordo({ ...base, desconto: 10000 })).toThrow(/desconto/);
    expect(() => calcularAcordo({ ...base, entrada: 20000 })).toThrow(/entrada/);
    expect(() => calcularAcordo({ ...base, parcelas: 200 })).toThrow(/R\$ 1,00/);
    expect(() => calcularAcordo({ ...base, itens: [] })).toThrow(/título/);
  });
  it('meses mais curtos', () => {
    expect(somarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(somarMeses('2026-01-31', 2)).toBe('2026-03-31');
  });
});

describe('painel e régua', () => {
  it('faixas de atraso', () => {
    expect([0, 1, 30, 31, 61, 91, 181].map(faixaAtraso)).toEqual(['a_vencer', '1_30', '1_30', '31_60', '61_90', '91_180', 'mais_180']);
  });
  it('preenche as variáveis da mensagem', () => {
    expect(preencherTexto('Oi {primeiro_nome}! Valor {valor}.\n{link}\nObrigada', { primeiro_nome: 'Ana', valor: 'R$ 10,00', link: '' })).toBe('Oi Ana! Valor R$ 10,00.\n\nObrigada');
  });
});
