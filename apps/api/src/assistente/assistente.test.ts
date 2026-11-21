import { describe, expect, it } from 'vitest';
import { CANCELA, CONFIRMA, montarHistorico, paraFala, resumoFinal } from './assistente.service';

describe('confirmação por voz', () => {
  it('entende "pode" e variações como confirmação', () => {
    for (const t of ['pode', 'Pode mandar', 'sim, pode', 'confirmo', 'ok', 'manda ver', 'pode enviar sim']) expect(CONFIRMA.test(t), t).toBe(true);
  });
  it('não confunde pedido novo com confirmação', () => {
    for (const t of ['pode me mostrar as vendas do mês passado e comparar com o anterior por loja?', 'quais maletas estão atrasadas', 'manda whatsapp pros inadimplentes acima de 60 dias e depois emite os boletos de todos']) expect(CONFIRMA.test(t), t).toBe(false);
  });
  it('entende cancelamento', () => {
    for (const t of ['não', 'nao, cancela', 'cancela', 'para', 'esquece isso']) expect(CANCELA.test(t), t).toBe(true);
    expect(CANCELA.test('não tem ninguém atrasado no evento de sábado? me mostra a lista completa')).toBe(false);
  });
});

describe('montarHistorico', () => {
  it('junta mensagens seguidas do mesmo lado e termina na vez da pessoa', () => {
    const h = montarHistorico([
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ]);
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(h[1].content).toHaveLength(2);
  });

  it('completa uso de ferramenta sem resultado (servidor caiu no meio)', () => {
    const h = montarHistorico([
      { role: 'user', content: [{ type: 'text', text: 'inadimplentes' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'consultar_inadimplentes', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'e aí?' }] },
    ]);
    expect(h[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
    expect(h[2].content[1]).toMatchObject({ type: 'text', text: 'e aí?' });
  });

  it('não começa com resultado de ferramenta solto (histórico cortado)', () => {
    const h = montarHistorico([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'pronto' }] },
      { role: 'user', content: [{ type: 'text', text: 'valeu' }] },
    ]);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'valeu' }] });
  });

  it('transforma em texto o resultado que não responde a um uso logo antes', () => {
    const h = montarHistorico([
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'olá' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'perdido', content: 'abc' }, { type: 'text', text: 'segue' }] },
    ]);
    expect(h[2].content[0]).toMatchObject({ type: 'text' });
  });

  it('mantém o par uso → resultado intacto', () => {
    const h = montarHistorico([
      { role: 'user', content: [{ type: 'text', text: 'vendas' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'vou ver' }, { type: 'tool_use', id: 'a', name: 'resumo_vendas', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"total":1}' }] },
    ]);
    expect(h).toHaveLength(3);
    expect(h[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a' });
  });
});

describe('resumoFinal', () => {
  it('resume o envio em lote', () => {
    expect(resumoFinal({ enviados: 21, naoEnviados: 2, falhas: [{ nome: 'Ana', erro: 'Sem telefone' }, { nome: 'Bia', erro: 'Número inválido' }] })).toContain('21 mensagem(ns) enviada(s), 2 não enviada(s)');
    expect(resumoFinal({ enviados: 5, falhas: [] })).toBe('Terminei: 5 mensagem(ns) enviada(s).');
  });
});

describe('paraFala', () => {
  it('não lê links, marcadores nem símbolos de formatação', () => {
    expect(paraFala('Resumo:\n- **Vendas**: R$ 1.200,00\n- Boleto: https://asaas.com/x/1\n\nQuer mais?')).toBe('Resumo:, Vendas: R$ 1.200,00, Boleto: o link. Quer mais?');
  });
});

import { semTagsDeVoz } from '../ia/ia.service';
describe('semTagsDeVoz', () => {
  it('tira só as marcações de emoção conhecidas', () => {
    expect(semTagsDeVoz('[excited] Subiu 15%! [laughs] Ótimo. [Confirmou no botão]')).toBe('Subiu 15%! Ótimo. [Confirmou no botão]');
  });
});
