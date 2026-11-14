import { describe, expect, it } from 'vitest';
import { extrairLista, umRegistro, centavos, contaEmAberto, dataISO, estrutura, pedidoAberto, pegar, qtdEmAberto } from './mapear';

describe('leitura dos dados do Jueri', () => {
  it('dinheiro em número, texto com ponto ou com vírgula', () => {
    expect(centavos(49.99)).toBe(4999);
    expect(centavos('25000.50')).toBe(2500050);
    expect(centavos('1.234,56')).toBe(123456);
    expect(centavos('')).toBeNull();
  });
  it('datas do Jueri e brasileiras; data impossível vira nula', () => {
    expect(dataISO('2026-03-24 00:00')).toBe('2026-03-24');
    expect(dataISO('24/03/2026')).toBe('2026-03-24');
    expect(dataISO('2026-02-31')).toBeNull();
  });
  it('procura o valor em vários nomes de campo', () => {
    expect(pegar({ produto: { codigo_barras: '1' } }, 'fk_produto_id', 'produto.codigo_barras')).toBe('1');
    expect(pegar({ a: '' }, 'a')).toBeUndefined();
  });
  it('só o que ainda está com a revendedora conta na maleta', () => {
    expect(qtdEmAberto({ quantidade: 5, quantidade_vendida: 2, quantidade_devolvida: 1 })).toBe(2);
    expect(qtdEmAberto({ quantidade: 1, quantidade_vendida: 3 })).toBe(0);
  });
  it('situação de pedido e de conta', () => {
    expect(pedidoAberto({ status: 'Aberto' })).toBe(true);
    expect(pedidoAberto({ status: 2 })).toBe(false);
    expect(contaEmAberto({ data_pagamento: '2026-01-01' })).toBe(false);
    expect(contaEmAberto({ status: 'Cancelada' })).toBe(false);
    expect(contaEmAberto({ status: 'Em aberto' })).toBe(true);
    expect(contaEmAberto({ status: 'A pagar' })).toBe(true);
    expect(contaEmAberto({ status: 'A receber' })).toBe(true);
    expect(contaEmAberto({ status: 'Pago' })).toBe(false);
    expect(contaEmAberto({ status: 'Recebido' })).toBe(false);
  });
  it('a estrutura mostra só os nomes dos campos, nunca os valores', () => {
    const e = estrutura([{ nome: 'Fulana', fisico: { cpf: '123' } }]);
    expect(e).toEqual(['fisico.cpf', 'nome']);
    expect(JSON.stringify(e)).not.toContain('Fulana');
  });

  it('acha a lista em qualquer formato de resposta', () => {
    expect(extrairLista([{ id: 1 }]).itens).toHaveLength(1);
    expect(extrairLista({ data: [{ id: 1 }], next_page_url: 'x' })).toEqual({ itens: [{ id: 1 }], proxima: true });
    expect(extrairLista({ data: { data: [{ id: 2 }] } }).itens[0].id).toBe(2);
    expect(extrairLista({ categorias: [{ id: 3 }] }).itens[0].id).toBe(3);
    expect(extrairLista({ '1': { id: 1 }, '2': { id: 2 } }).itens).toHaveLength(2);
    expect(extrairLista(null).itens).toEqual([]);
    expect(umRegistro({ data: { id: 5 } }).id).toBe(5);
    expect(umRegistro({ id: 6, data: 'x' }).id).toBe(6);
  });
});
