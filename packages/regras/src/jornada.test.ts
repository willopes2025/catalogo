import { describe, expect, it } from 'vitest';
import { calcularDia, feriadosNacionais, paraMinutos as m, previstoDoTurno, somarJornada } from './jornada';

const comercial = { entrada: '08:00', saidaIntervalo: '12:00', voltaIntervalo: '13:00', saida: '17:48' };
const dia = (marc: string[], extra: Partial<Parameters<typeof calcularDia>[0]> = {}) =>
  calcularDia({ marcacoes: marc.map(m), turno: comercial, domingo: false, feriado: false, abonado: false, ...extra });

describe('jornada (CLT)', () => {
  it('turno comercial prevê 8h48', () => expect(previstoDoTurno(comercial)).toBe(528));

  it('até 5 min por batida e 10 no dia não contam (art. 58 §1º)', () => {
    const r = dia(['08:04', '12:00', '13:03', '17:50']);
    expect(r.computado).toBe(528);
    expect(r.extra50 + r.atraso + r.falta).toBe(0);
  });

  it('passou da tolerância: conta a diferença inteira', () => {
    const r = dia(['07:45', '12:00', '13:00', '18:20']);
    expect(r.extra50).toBe(47);
  });

  it('atraso e saída antecipada separados do resto da falta', () => {
    const r = dia(['08:30', '12:00', '13:00', '17:00']);
    expect(r.atraso).toBe(30);
    expect(r.saidaAntecipada).toBe(48);
    expect(r.falta).toBe(0);
  });

  it('dia útil sem batida e sem justificativa é falta', () => {
    const r = dia([]);
    expect(r.faltaDia).toBe(true);
    expect(r.falta).toBe(528);
  });

  it('atestado (abonado) não gera falta', () => {
    const r = dia([], { abonado: true });
    expect(r.falta).toBe(0);
    expect(r.computado).toBe(528);
  });

  it('domingo de folga e feriado trabalhados são extra a 100%', () => {
    expect(calcularDia({ marcacoes: [m('09:00'), m('13:00')], turno: null, domingo: true, feriado: false, abonado: false }).extra100).toBe(240);
    expect(dia(['08:00', '12:00'], { feriado: true }).extra100).toBe(240);
  });

  it('noturno entre 22h e 5h, inclusive virando a meia-noite', () => {
    const r = calcularDia({ marcacoes: [m('20:00'), m('23:00')], turno: null, domingo: false, feriado: false, abonado: false });
    expect(calcularDia({ marcacoes: [m('03:00'), m('07:00')], turno: null, domingo: false, feriado: false, abonado: false }).noturno).toBe(120);
    expect(r.noturno).toBe(60);
    const virada = calcularDia({ marcacoes: [m('21:00'), 1440 + m('06:00')], turno: null, domingo: false, feriado: false, abonado: false });
    expect(virada.noturno).toBe(420);
  });

  it('batida faltando deixa o dia pendente', () => {
    const r = dia(['08:00', '12:00', '13:00']);
    expect(r.pendente).toBe(true);
    expect(r.avisos[0]).toMatch(/Falta uma marcação/);
  });

  it('intervalo menor que 1h acima de 6h gera aviso', () => {
    expect(dia(['08:00', '12:00', '12:30', '17:48']).avisos.join()).toMatch(/Intervalo menor/);
    expect(dia(['07:58', '12:02', '13:01', '17:49']).avisos.join()).not.toMatch(/Intervalo menor/);
  });

  it('soma o mês e o saldo', () => {
    const t = somarJornada([dia(['07:45', '12:00', '13:00', '18:20']), dia(['08:30', '12:00', '13:00', '17:48']), dia([])]);
    expect(t.extra50).toBe(47);
    expect(t.atraso).toBe(30);
    expect(t.faltasDias).toBe(1);
    expect(t.saldo).toBe(47 - 30 - 528);
  });

  it('feriados nacionais com Páscoa móvel', () => {
    const f = feriadosNacionais(2026).map((x) => x.data);
    expect(f).toContain('2026-04-03'); // Sexta-feira Santa 2026
    expect(f).toContain('2026-11-20');
  });
});
