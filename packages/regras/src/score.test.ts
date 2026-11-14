import { describe, expect, it } from 'vitest';
import { calcularScore, faixaDoScore, nivelSugerido, pontosDoAcerto, REGRAS_PONTOS_PADRAO } from './score';

const boa = { diasAtraso: 0, percentualVendidoPb: 6500, pecasPerdidas: 0, pecasNaMaleta: 40 };
const semParcelas = { pagasEmDia: 0, pagasComAtraso: 0, vencidasEmAberto: 0, maiorAtrasoAbertoDias: 0 };

describe('score interno', () => {
  it('representante exemplar fica em 1000', () => {
    const r = calcularScore({ acertos: [boa, boa, boa], parcelas: { ...semParcelas, pagasEmDia: 6 }, mesesDeCasa: 24 });
    expect(r.score).toBe(1000);
    expect(r.faixa).toBe('A');
    expect(r.pontosDeAtencao).toEqual([]);
  });
  it('sem acerto completo não tem score', () => {
    const r = calcularScore({ acertos: [], parcelas: semParcelas, mesesDeCasa: 1 });
    expect(r.score).toBeNull();
    expect(r.faixa).toBe('nova');
  });
  it('atraso e parcela vencida derrubam e aparecem como atenção', () => {
    const r = calcularScore({
      acertos: [{ ...boa, diasAtraso: 15 }, { ...boa, diasAtraso: 30 }],
      parcelas: { pagasEmDia: 1, pagasComAtraso: 1, vencidasEmAberto: 2, maiorAtrasoAbertoDias: 45 },
      mesesDeCasa: 6,
    });
    expect(r.score!).toBeLessThan(600);
    expect(r.pontosDeAtencao[0]).toBe('Acertos com atraso');
    expect(r.pontosDeAtencao).toContain('Parcelas vencidas em aberto');
  });
  it('perder 10% das peças zera o componente de perdas', () => {
    const r = calcularScore({ acertos: [{ ...boa, pecasPerdidas: 4, pecasNaMaleta: 40 }], parcelas: semParcelas, mesesDeCasa: 12 });
    expect(r.componentes.perdas).toBe(0);
    expect(r.score).toBe(900);
  });
  it('faixas', () => {
    expect([800, 799, 600, 400, 399].map(faixaDoScore)).toEqual(['A', 'B', 'B', 'C', 'D']);
  });
});

describe('nível sugerido', () => {
  const niveis = [
    { id: 'bronze', ordem: 1, metaMensal: 0 },
    { id: 'prata', ordem: 2, metaMensal: 100000 },
    { id: 'ouro', ordem: 3, metaMensal: 250000 },
  ];
  it('escolhe o maior nível cuja meta a média alcança', () => {
    expect(nivelSugerido(niveis, 50000)?.id).toBe('bronze');
    expect(nivelSugerido(niveis, 100000)?.id).toBe('prata');
    expect(nivelSugerido(niveis, 999999)?.id).toBe('ouro');
  });
});

describe('pontos do acerto', () => {
  it('vendas, em dia e meta', () => {
    const p = pontosDoAcerto(REGRAS_PONTOS_PADRAO, { diasAtraso: 0, totalVendido: 125050, metaDoNivel: 100000, parcial: false });
    expect(p.map((x) => [x.regra, x.pontos])).toEqual([['vendas', 120], ['em_dia', 50], ['meta', 100]]);
  });
  it('acerto parcial ou atrasado', () => {
    expect(pontosDoAcerto(REGRAS_PONTOS_PADRAO, { diasAtraso: 0, totalVendido: 50000, metaDoNivel: 0, parcial: true })).toEqual([]);
    expect(pontosDoAcerto(REGRAS_PONTOS_PADRAO, { diasAtraso: 3, totalVendido: 9999, metaDoNivel: 0, parcial: false })).toEqual([]);
  });
  it('desligado não dá pontos', () => {
    expect(pontosDoAcerto({ ...REGRAS_PONTOS_PADRAO, ativo: false }, { diasAtraso: 0, totalVendido: 90000, metaDoNivel: 0, parcial: false })).toEqual([]);
  });
});
