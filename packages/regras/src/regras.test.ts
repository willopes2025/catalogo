import { describe, expect, it } from 'vitest';
import {
  REGRAS_PADRAO,
  calcularAcerto,
  ErroAcerto,
  gerarParcelas,
  podeRetirarMaleta,
  novoLimite,
  formatarReais,
  diasEntre,
  type ItemAcerto,
} from './index';

/** Regras com encargos e bloqueio ligados, para testar os cálculos. */
const R = { ...REGRAS_PADRAO, comissaoPrazoPb: 2500, multaAtrasoPb: 200, jurosMesPb: 100, diasParaBloquear: 5 };

const itens = (): ItemAcerto[] => [
  // Brinco: R$ 100, custo R$ 30. Levou 3, vendeu 2, devolveu 1.
  { produtoId: 'A', preco: 10000, custo: 3000, emMaleta: 3, vendida: 2, devolvida: 1, perdida: 0 },
  // Colar: R$ 50, custo R$ 15. Levou 2, devolveu 1, perdeu 1.
  { produtoId: 'B', preco: 5000, custo: 1500, emMaleta: 2, vendida: 0, devolvida: 1, perdida: 1 },
];

const base = { dataLimite: '2026-12-10', dataAcerto: '2026-12-10', creditoDisponivel: 0, parcial: false, regras: R };

describe('acerto', () => {
  it('à vista, em dia: vendido − 30% + peça perdida pelo custo', () => {
    const r = calcularAcerto({ ...base, itens: itens(), forma: 'avista' });
    expect(r.totalVendido).toBe(20000);
    expect(r.comissao).toBe(6000);
    expect(r.liquidoVendas).toBe(14000);
    expect(r.perdidas).toBe(1500);
    expect(r.multa).toBe(0);
    expect(r.juros).toBe(0);
    expect(r.totalAPagar).toBe(15500);
    expect(r.percentualVendidoPb).toBe(5000);
    expect(r.pecas).toEqual({ emMaleta: 5, vendidas: 2, devolvidas: 2, perdidas: 1, continuam: 0 });
  });

  it('a prazo usa a comissão a prazo (25%)', () => {
    const r = calcularAcerto({ ...base, itens: itens(), forma: 'prazo' });
    expect(r.comissao).toBe(5000);
    expect(r.totalAPagar).toBe(16500);
  });

  it('10 dias de atraso: multa de 2% e juros de 1% ao mês pro rata', () => {
    const r = calcularAcerto({ ...base, dataAcerto: '2026-12-20', itens: itens(), forma: 'avista' });
    expect(r.diasAtraso).toBe(10);
    expect(r.multa).toBe(310); // 2% de 155,00
    expect(r.juros).toBe(52); // 155,00 × 1% × 10/30
    expect(r.totalAPagar).toBe(15862);
  });

  it('respeita a carência antes de cobrar encargos', () => {
    const regras = { ...R, carenciaDias: 3 };
    const r = calcularAcerto({ ...base, regras, dataAcerto: '2026-12-12', itens: itens(), forma: 'avista' });
    expect(r.diasAtraso).toBe(0);
    expect(r.multa).toBe(0);
  });

  it('usa créditos até zerar o valor', () => {
    const r = calcularAcerto({ ...base, creditoDisponivel: 20000, itens: itens(), forma: 'avista' });
    expect(r.creditoUsado).toBe(15500);
    expect(r.totalAPagar).toBe(0);
  });

  it('peça perdida pelo preço de venda, se configurado', () => {
    const regras = { ...R, perdidaPeloCusto: false };
    const r = calcularAcerto({ ...base, regras, itens: itens(), forma: 'avista' });
    expect(r.perdidas).toBe(5000);
  });

  it('recusa peça sem destino num acerto completo', () => {
    const i = itens();
    i[0].devolvida = 0;
    expect(() => calcularAcerto({ ...base, itens: i, forma: 'avista' })).toThrow(ErroAcerto);
  });

  it('acerto parcial deixa peças na maleta', () => {
    const i = itens();
    i[0].devolvida = 0;
    const r = calcularAcerto({ ...base, parcial: true, itens: i, forma: 'avista' });
    expect(r.pecas.continuam).toBe(1);
    expect(r.totalAPagar).toBe(15500);
  });

  it('recusa mais peças do que havia na maleta', () => {
    const i = itens();
    i[0].vendida = 4;
    expect(() => calcularAcerto({ ...base, itens: i, forma: 'avista' })).toThrow(/só há 3/);
  });
});

describe('parcelas', () => {
  it('divide em 3 com a sobra de centavos na primeira', () => {
    const p = gerarParcelas(10000, 3, '2026-12-10');
    expect(p.map((x) => x.valor)).toEqual([3334, 3333, 3333]);
    expect(p.map((x) => x.vencimento)).toEqual(['2026-12-10', '2027-01-09', '2027-02-08']);
  });
  it('total zero não gera parcelas', () => {
    expect(gerarParcelas(0, 2, '2026-12-10')).toEqual([]);
  });
});

describe('crédito', () => {
  const s = { limite: 150000, emMaletas: 0, maletasAbertas: 0, maiorAtrasoDias: 0, bloqueadaManualmente: false };
  it('libera maleta dentro do limite', () => {
    expect(podeRetirarMaleta(s, 120000, R).pode).toBe(true);
  });
  it('bloqueia acima do crédito livre, com maleta aberta e com atraso', () => {
    const r = podeRetirarMaleta({ ...s, maletasAbertas: 1, maiorAtrasoDias: 7 }, 200000, R);
    expect(r.pode).toBe(false);
    expect(r.motivos).toHaveLength(3);
  });
  it('aumenta 20% após acerto em dia com meta batida', () => {
    expect(novoLimite(150000, { diasAtraso: 0, percentualVendidoPb: 5000, houvePerda: false }, R).limite).toBe(180000);
  });
  it('não passa do limite máximo', () => {
    expect(novoLimite(1400000, { diasAtraso: 0, percentualVendidoPb: 5000, houvePerda: false }, R).limite).toBe(1500000);
  });
  it('volta ao inicial com atraso acima do bloqueio', () => {
    expect(novoLimite(300000, { diasAtraso: 6, percentualVendidoPb: 9000, houvePerda: false }, R).limite).toBe(150000);
  });
  it('mantém quando vendeu pouco', () => {
    expect(novoLimite(150000, { diasAtraso: 0, percentualVendidoPb: 1000, houvePerda: false }, R).limite).toBe(150000);
  });
});

describe('utilitários', () => {
  it('formata reais', () => {
    expect(formatarReais(123456789)).toBe('R$ 1.234.567,89');
    expect(formatarReais(5)).toBe('R$ 0,05');
  });
  it('conta dias entre datas atravessando o ano', () => {
    expect(diasEntre('2026-12-25', '2027-01-04')).toBe(10);
  });
});

describe('padrão Jueri (sem bloqueio, sem encargos)', () => {
  it('diasParaBloquear 0 nunca bloqueia nem reduz limite', () => {
    const s = { limite: 300000, emMaletas: 0, maletasAbertas: 0, maiorAtrasoDias: 90, bloqueadaManualmente: false };
    expect(podeRetirarMaleta(s, 100000, REGRAS_PADRAO).pode).toBe(true);
    expect(novoLimite(300000, { diasAtraso: 40, percentualVendidoPb: 9000, houvePerda: false }, REGRAS_PADRAO).limite).toBe(300000);
  });
  it('comissão fixa de 30% e sem multa/juros', () => {
    const itens = [{ produtoId: 'a', preco: 10000, custo: 3000, emMaleta: 1, vendida: 1, devolvida: 0, perdida: 0 }];
    const r = calcularAcerto({ itens, forma: 'prazo', dataLimite: '2026-12-10', dataAcerto: '2027-01-30', creditoDisponivel: 0, parcial: false, regras: REGRAS_PADRAO });
    expect(r.comissao).toBe(3000);
    expect(r.multa + r.juros).toBe(0);
  });
});
