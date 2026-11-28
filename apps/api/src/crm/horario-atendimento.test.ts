import { describe, expect, it } from 'vitest';
import { descreverHorario, foraDoHorario, mensagemForaHorario } from './horario-atendimento';

const c = { atendimentoAtivo: true, atendimentoInicio: '09:00', atendimentoFim: '18:00', atendimentoDias: [1, 2, 3, 4, 5] };

describe('horário do atendimento humano', () => {
  it('descreve os dias', () => {
    expect(descreverHorario(c)).toBe('de segunda a sexta, das 09:00 às 18:00');
    expect(descreverHorario({ ...c, atendimentoDias: [1, 3] })).toBe('segunda e quarta, das 09:00 às 18:00');
  });
  it('dentro do horário não avisa', () => {
    expect(foraDoHorario(c, new Date('2026-11-24T15:00:00Z'))).toBeNull(); // terça 12h
    expect(foraDoHorario({ ...c, atendimentoAtivo: false }, new Date('2026-11-24T23:00:00Z'))).toBeNull();
  });
  it('à noite volta amanhã; de manhã cedo volta hoje; sexta à noite volta segunda', () => {
    expect(foraDoHorario(c, new Date('2026-11-24T22:00:00Z'))!.retorno).toBe('amanhã a partir das 09:00'); // terça 19h
    expect(foraDoHorario(c, new Date('2026-11-25T10:00:00Z'))!.retorno).toBe('hoje a partir das 09:00'); // quarta 7h
    expect(foraDoHorario(c, new Date('2026-11-27T22:30:00Z'))!.retorno).toBe('na segunda-feira a partir das 09:00'); // sexta 19h30
    expect(foraDoHorario({ ...c, atendimentoDias: [1, 2, 3, 4, 5, 6] }, new Date('2026-11-27T22:30:00Z'))!.retorno).toBe('amanhã a partir das 09:00');
  });
  it('monta a mensagem', () => {
    expect(mensagemForaHorario('', { horario: 'X', retorno: 'Y' })).toContain('Nosso atendimento é X. A equipe responde Y.');
  });
});
