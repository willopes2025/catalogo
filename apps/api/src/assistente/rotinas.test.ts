import { describe, expect, it } from 'vitest';
import { csv, descreverAgenda, descreverDias, proximaDaRotina, proximaExecucao } from './rotinas';

// 21/11/2026 é sábado. Horários em Brasília = UTC−3.
const em = (iso: string) => new Date(iso);

describe('proximaExecucao', () => {
  it('hoje, se o horário ainda não passou', () => {
    expect(proximaExecucao('08:00', [0, 1, 2, 3, 4, 5, 6], em('2026-11-21T10:00:00Z')).toISOString()).toBe('2026-11-21T11:00:00.000Z');
  });
  it('amanhã, se já passou', () => {
    expect(proximaExecucao('08:00', [0, 1, 2, 3, 4, 5, 6], em('2026-11-21T11:00:00Z')).toISOString()).toBe('2026-11-22T11:00:00.000Z');
  });
  it('só dias úteis: de sábado pula para segunda', () => {
    expect(proximaExecucao('08:00', [1, 2, 3, 4, 5], em('2026-11-21T22:00:00Z')).toISOString()).toBe('2026-11-23T11:00:00.000Z');
  });
  it('perto da meia-noite usa o dia de Brasília, não o de UTC', () => {
    // 22h de sábado em Brasília = 01h de domingo em UTC; rotina de sábado às 23h ainda é hoje.
    expect(proximaExecucao('23:00', [6], em('2026-11-22T01:00:00Z')).toISOString()).toBe('2026-11-22T02:00:00.000Z');
  });
  it('recusa horário inválido', () => {
    expect(() => proximaExecucao('25:00', [1])).toThrow();
  });
});

describe('descreverDias e csv', () => {
  it('descreve', () => {
    expect(descreverDias([0, 1, 2, 3, 4, 5, 6])).toBe('todo dia');
    expect(descreverDias([5, 1, 2, 3, 4])).toBe('de segunda a sexta');
    expect(descreverDias([1, 3])).toBe('segunda, quarta');
  });
  it('gera CSV com BOM, ; e aspas', () => {
    const t = csv(['Nome', 'Valor'], [['Ana; "Lu"', 'R$ 10,00']]).toString('utf8');
    expect(t).toBe('\uFEFFNome;Valor\r\n"Ana; ""Lu""";R$ 10,00');
  });
});

describe('rotina por intervalo', () => {
  const r = { tipo: 'intervalo', horario: '08:00', dias: [1, 2, 3, 4, 5], intervaloMin: 120, janelaInicio: '08:00', janelaFim: '18:00' };
  it('soma o intervalo dentro da janela', () => {
    // segunda 23/11 10:00 Brasília → 12:00
    expect(proximaDaRotina(r, em('2026-11-23T13:00:00Z')).toISOString()).toBe('2026-11-23T15:00:00.000Z');
  });
  it('passou do fim da janela: vai para o início da janela do próximo dia útil', () => {
    // sexta 27/11 17:00 → +2h = 19:00 (fora) → segunda 30/11 08:00
    expect(proximaDaRotina(r, em('2026-11-27T20:00:00Z')).toISOString()).toBe('2026-11-30T11:00:00.000Z');
  });
  it('antes da janela começa no início dela', () => {
    expect(proximaDaRotina(r, em('2026-11-23T05:00:00Z')).toISOString()).toBe('2026-11-23T11:00:00.000Z');
  });
  it('sem janela, roda o dia todo', () => {
    expect(proximaDaRotina({ tipo: 'intervalo', horario: '00:00', dias: [], intervaloMin: 30 }, em('2026-11-21T10:00:00Z')).toISOString()).toBe('2026-11-21T10:30:00.000Z');
  });
  it('descreve', () => {
    expect(descreverAgenda(r)).toBe('a cada 2 h, de segunda a sexta, das 08:00 às 18:00');
    expect(descreverAgenda({ tipo: 'horario', horario: '08:00', dias: [0, 1, 2, 3, 4, 5, 6] })).toBe('todo dia às 08:00');
  });
});
