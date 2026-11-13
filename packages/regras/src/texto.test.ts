import { describe, expect, it } from 'vitest';
import { gerarSlug, preencherModelo, reaisPorExtenso, variaveisDoModelo } from './texto';

describe('valor por extenso', () => {
  it.each([
    [100, 'um real'],
    [5, 'cinco centavos'],
    [101, 'um real e um centavo'],
    [2150, 'vinte e um reais e cinquenta centavos'],
    [10000, 'cem reais'],
    [12345, 'cento e vinte e três reais e quarenta e cinco centavos'],
    [100000, 'mil reais'],
    [150000, 'mil e quinhentos reais'],
    [123456, 'mil, duzentos e trinta e quatro reais e cinquenta e seis centavos'],
    [200500, 'dois mil e cinco reais'],
    [1_000_000_00, 'um milhão de reais'],
    [0, 'zero real'],
  ])('%i → %s', (c, txt) => expect(reaisPorExtenso(c)).toBe(txt));
});

describe('slug e modelos', () => {
  it('gera slug sem acento', () => expect(gerarSlug('  Maria José da Conceição! ')).toBe('maria-jose-da-conceicao'));
  it('preenche variáveis e marca as vazias', () => {
    expect(preencherModelo('Eu, {{nome}}, CPF {{ cpf }}, aceito {{multa}}.', { nome: 'Ana', cpf: '' })).toBe('Eu, Ana, CPF __________, aceito __________.');
  });
  it('lista variáveis sem repetir', () => expect(variaveisDoModelo('{{a}} {{b}} {{A}}')).toEqual(['a', 'b']));
});
