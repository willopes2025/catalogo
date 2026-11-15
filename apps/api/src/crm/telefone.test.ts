import { describe, expect, it } from 'vitest';
import { preencherTexto, variaveisDosCampos, variavelDoCampo } from './telefone';

describe('variáveis dos campos personalizados', () => {
  it('nome do campo vira variável sem acento e sem espaço', () => {
    expect(variavelDoCampo('Peça de interesse')).toBe('campo_peca_de_interesse');
    expect(variavelDoCampo('  Nº do anel ')).toBe('campo_n_do_anel');
  });
  it('preenche os campos do contato e do card; campo vazio some do texto', () => {
    const vars = variaveisDosCampos({ Cidade: 'Vila Velha' }, { 'Peça de interesse': 'Brinco argola', Vazio: '' });
    expect(preencherTexto('Oi! O {{campo_peca_de_interesse}} chega em {{campo_cidade}}{{campo_vazio}} amanhã. {{outra}}', vars)).toBe('Oi! O Brinco argola chega em Vila Velha amanhã. {{outra}}');
  });
});
