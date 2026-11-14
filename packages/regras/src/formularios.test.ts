import { describe, expect, it } from 'vitest';
import { calcularNps, validarRespostas, type CampoFormulario } from './formularios';

const campos: CampoFormulario[] = [
  { id: 'nome', tipo: 'texto', rotulo: 'Nome', obrigatorio: true, papel: 'nome' },
  { id: 'fone', tipo: 'telefone', rotulo: 'WhatsApp', obrigatorio: true, papel: 'telefone' },
  { id: 'mail', tipo: 'email', rotulo: 'E-mail', obrigatorio: false },
  { id: 'cpf', tipo: 'cpf', rotulo: 'CPF', obrigatorio: false },
  { id: 'nota', tipo: 'nota', rotulo: 'Nota', obrigatorio: true },
  { id: 'loja', tipo: 'escolha', rotulo: 'Loja', obrigatorio: true, opcoes: ['Vila Velha', 'Vitória'] },
  { id: 'gosta', tipo: 'multipla', rotulo: 'Do que gosta', obrigatorio: false, opcoes: ['Brincos', 'Anéis'] },
  { id: 'nasc', tipo: 'data', rotulo: 'Nascimento', obrigatorio: false },
];

describe('respostas de formulário', () => {
  it('aceita e normaliza', () => {
    const r = validarRespostas(campos, { nome: ' Ana ', fone: '(27) 99999-1234', mail: 'ANA@X.COM', cpf: '390.533.447-05', nota: '9', loja: 'Vitória', gosta: ['Anéis', 'Anéis'], nasc: '1990-02-28', intruso: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.valores).toEqual({ nome: 'Ana', fone: '27999991234', mail: 'ana@x.com', cpf: '39053344705', nota: 9, loja: 'Vitória', gosta: ['Anéis'], nasc: '1990-02-28' });
      expect('intruso' in r.valores).toBe(false);
    }
  });
  it('aponta os erros por campo', () => {
    const r = validarRespostas(campos, { nome: '', fone: '123', mail: 'x@', cpf: '111.111.111-11', nota: 11, loja: 'Serra', gosta: ['Colares'], nasc: '2026-02-31' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.erros).sort()).toEqual(['cpf', 'fone', 'gosta', 'loja', 'mail', 'nasc', 'nome', 'nota']);
  });
  it('opcional em branco vira null', () => {
    const r = validarRespostas(campos, { nome: 'Ana', fone: '27999991234', nota: 0, loja: 'Vila Velha' });
    expect(r.ok && r.valores.mail).toBeNull();
    expect(r.ok && r.valores.nota).toBe(0);
  });
});

describe('NPS', () => {
  it('promotores menos detratores', () => {
    expect(calcularNps([10, 9, 9, 8, 7, 6, 0, 10]).nps).toBe(25);
    expect(calcularNps([]).nps).toBeNull();
  });
});
