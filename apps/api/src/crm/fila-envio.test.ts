import { describe, expect, it } from 'vitest';
import { dentroDaJanela, previsaoTermino, proximaAbertura } from './fila-envio.service';

// Seg a sáb, das 8h às 18h (Brasília), 3 a 6 minutos entre mensagens.
const j = { envioInicio: '08:00', envioFim: '18:00', envioDias: [1, 2, 3, 4, 5, 6], envioIntervaloMinS: 180, envioIntervaloMaxS: 360 };
const br = (iso: string) => new Date(`${iso}-03:00`);

describe('janela do envio em massa', () => {
  it('respeita horário e dia da semana de Brasília', () => {
    expect(dentroDaJanela(j, br('2026-11-25T08:00:00'))).toBe(true); // quarta
    expect(dentroDaJanela(j, br('2026-11-25T17:59:00'))).toBe(true);
    expect(dentroDaJanela(j, br('2026-11-25T18:00:00'))).toBe(false);
    expect(dentroDaJanela(j, br('2026-11-25T07:59:00'))).toBe(false);
    expect(dentroDaJanela(j, br('2026-11-29T10:00:00'))).toBe(false); // domingo
  });
  it('fora do horário, a próxima abertura é o início do próximo dia permitido', () => {
    expect(proximaAbertura(j, br('2026-11-25T20:00:00'))!.toISOString()).toBe(br('2026-11-26T08:00:00').toISOString());
    expect(proximaAbertura(j, br('2026-11-28T19:00:00'))!.toISOString()).toBe(br('2026-11-30T08:00:00').toISOString()); // sábado à noite → segunda
    expect(proximaAbertura(j, br('2026-11-25T06:00:00'))!.toISOString()).toBe(br('2026-11-25T08:00:00').toISOString());
    expect(proximaAbertura({ ...j, envioDias: [] }, br('2026-11-25T06:00:00'))).toBeNull();
  });
  it('previsão: 41 mensagens a ~4,5 min cabem num dia; 200 passam para o seguinte', () => {
    const inicio = br('2026-11-25T08:00:00');
    expect(previsaoTermino(j, 41, null, inicio)!.toISOString()).toBe(new Date(inicio.getTime() + 40 * 270_000).toISOString());
    const fim = previsaoTermino(j, 200, null, inicio)!;
    expect(fim > br('2026-11-26T08:00:00')).toBe(true);
    expect(dentroDaJanela(j, fim)).toBe(true);
  });
});
