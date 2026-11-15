/**
 * Jornada de trabalho (CLT): o que cada dia do espelho de ponto mostra.
 * Tudo em MINUTOS a partir da meia-noite do dia (marcação depois da meia-noite seguinte passa de 1440).
 *
 * Regras aplicadas:
 *  - Art. 58 §1º: variações de até 5 minutos por marcação, sem passar de 10 minutos no dia, não contam;
 *    passou disso, conta a diferença inteira.
 *  - Art. 73: trabalho entre 22h e 5h é noturno (a hora noturna tem 52min30s; o adicional é calculado pela contabilidade).
 *  - Art. 71: jornada acima de 6h exige intervalo de pelo menos 1h; acima de 4h, de 15 min.
 *  - Domingo fora da escala e feriado trabalhados: hora extra a 100%. Demais extras: 50%.
 */

export interface Turno {
  /** "08:00" */
  entrada: string;
  saidaIntervalo?: string | null;
  voltaIntervalo?: string | null;
  saida: string;
}

export interface Escala {
  /** Turno de cada dia da semana (0 = domingo … 6 = sábado); null = folga. */
  dias: (Turno | null)[];
  /** Tolerância por marcação (padrão 5) e no dia (padrão 10), art. 58 §1º. */
  toleranciaMarcacao?: number;
  toleranciaDia?: number;
}

export interface EntradaDia {
  /** Marcações válidas do dia, em minutos desde 00:00 (já sem as desconsideradas e com as incluídas). */
  marcacoes: number[];
  turno: Turno | null;
  domingo: boolean;
  feriado: boolean;
  /** Atestado, férias, folga compensada etc.: o previsto do dia conta como cumprido. */
  abonado: boolean;
  toleranciaMarcacao?: number;
  toleranciaDia?: number;
}

export interface ResultadoDia {
  previsto: number;
  trabalhado: number;
  /** Trabalhado + abonado (o que conta para o saldo). */
  computado: number;
  extra50: number;
  extra100: number;
  atraso: number;
  saidaAntecipada: number;
  /** Falta parcial ou do dia inteiro, em minutos, já sem atraso e saída antecipada. */
  falta: number;
  /** Faltou o dia inteiro sem justificativa. */
  faltaDia: boolean;
  noturno: number;
  intervalo: number;
  /** Marcações em número ímpar: falta uma batida (o dia fica pendente de ajuste). */
  pendente: boolean;
  avisos: string[];
}

export const paraMinutos = (h: string) => {
  const [hh, mm] = h.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) throw new Error(`Horário inválido: ${h}`);
  return hh * 60 + mm;
};
export const paraHora = (min: number) => {
  const m = Math.round(Math.abs(min));
  return `${min < 0 ? '-' : ''}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Horários previstos do turno, em ordem (entrada, saída p/ intervalo, volta, saída), com virada de meia-noite. */
export function horariosDoTurno(t: Turno): number[] {
  const hs = [t.entrada, t.saidaIntervalo, t.voltaIntervalo, t.saida].filter((x): x is string => !!x).map(paraMinutos);
  for (let i = 1; i < hs.length; i++) while (hs[i] <= hs[i - 1]) hs[i] += 1440; // turno que passa da meia-noite
  return hs;
}

export function previstoDoTurno(t: Turno | null): number {
  if (!t) return 0;
  const hs = horariosDoTurno(t);
  let total = 0;
  for (let i = 0; i + 1 < hs.length; i += 2) total += hs[i + 1] - hs[i];
  return total;
}

/** Minutos dentro de 22h–5h num intervalo [a, b) (minutos desde 00:00 do dia, podendo passar de 1440). */
function minutosNoturnos(a: number, b: number) {
  let n = 0;
  // Faixa noturna de cada dia: das 22h (1320) às 5h do dia seguinte (1740). A do dia anterior cobre a madrugada.
  for (let base = -1440; base <= 1440 * 2; base += 1440) n += Math.max(0, Math.min(b, base + 1740) - Math.max(a, base + 1320));
  return n;
}

export function calcularDia(e: EntradaDia): ResultadoDia {
  const tolM = e.toleranciaMarcacao ?? 5;
  const tolD = e.toleranciaDia ?? 10;
  const avisos: string[] = [];
  const ms = [...e.marcacoes].sort((a, b) => a - b);
  const pendente = ms.length % 2 === 1;
  if (pendente) avisos.push('Falta uma marcação (número ímpar de batidas).');

  let trabalhado = 0;
  let noturno = 0;
  for (let i = 0; i + 1 < ms.length; i += 2) {
    trabalhado += ms[i + 1] - ms[i];
    noturno += minutosNoturnos(ms[i], ms[i + 1]);
  }
  let intervalo = 0;
  for (let i = 1; i + 1 < ms.length; i += 2) intervalo += ms[i + 1] - ms[i];

  const previsto = e.feriado ? 0 : previstoDoTurno(e.turno);
  const r: ResultadoDia = { previsto, trabalhado, computado: trabalhado, extra50: 0, extra100: 0, atraso: 0, saidaAntecipada: 0, falta: 0, faltaDia: false, noturno, intervalo, pendente, avisos };

  // Intervalo do art. 71, com a mesma tolerância das batidas (59 min não é infração; 50 min é).
  if (trabalhado > 360 && ms.length >= 4 && intervalo < 60 - tolM) avisos.push('Intervalo menor que 1 hora em jornada acima de 6 horas.');
  if (trabalhado > 360 && ms.length === 2) avisos.push('Jornada acima de 6 horas sem intervalo marcado.');

  // Dia sem jornada prevista (folga, domingo fora da escala, feriado): tudo que trabalhou é extra.
  if (!previsto) {
    if (trabalhado > 0) {
      if (e.domingo || e.feriado) r.extra100 = trabalhado;
      else r.extra50 = trabalhado;
    }
    return r;
  }

  if (e.abonado) {
    r.computado = Math.max(trabalhado, previsto);
    if (trabalhado > previsto) r.extra50 = trabalhado - previsto;
    return r;
  }

  if (!ms.length) {
    r.falta = previsto;
    r.faltaDia = true;
    return r;
  }
  if (pendente) return r; // não calcula saldo de dia com batida faltando

  const saldo = trabalhado - previsto;
  const contratuais = horariosDoTurno(e.turno!);
  // Tolerância só se as batidas correspondem uma a uma aos horários do turno.
  if (ms.length === contratuais.length) {
    const desvios = ms.map((m, i) => Math.abs(m - contratuais[i]));
    if (desvios.every((d) => d <= tolM) && desvios.reduce((a, d) => a + d, 0) <= tolD) {
      r.computado = previsto;
      return r;
    }
    if (saldo < 0) {
      r.atraso = Math.max(0, ms[0] - contratuais[0]);
      r.saidaAntecipada = Math.max(0, contratuais[contratuais.length - 1] - ms[ms.length - 1]);
    }
  }
  if (saldo > 0) r.extra50 = saldo;
  else if (saldo < 0) {
    const debito = -saldo;
    // O débito se divide em atraso, saída antecipada e o resto (intervalo estourado, saída no meio do dia).
    r.atraso = Math.min(r.atraso, debito);
    r.saidaAntecipada = Math.min(r.saidaAntecipada, debito - r.atraso);
    r.falta = debito - r.atraso - r.saidaAntecipada;
  }
  return r;
}

export interface TotaisPeriodo {
  previsto: number;
  trabalhado: number;
  computado: number;
  extra50: number;
  extra100: number;
  atraso: number;
  saidaAntecipada: number;
  falta: number;
  faltasDias: number;
  noturno: number;
  pendentes: number;
  /** Saldo do período (positivo = horas a mais). */
  saldo: number;
}

export function somarJornada(dias: ResultadoDia[]): TotaisPeriodo {
  const t: TotaisPeriodo = { previsto: 0, trabalhado: 0, computado: 0, extra50: 0, extra100: 0, atraso: 0, saidaAntecipada: 0, falta: 0, faltasDias: 0, noturno: 0, pendentes: 0, saldo: 0 };
  for (const d of dias) {
    t.previsto += d.previsto;
    t.trabalhado += d.trabalhado;
    t.computado += d.computado;
    t.extra50 += d.extra50;
    t.extra100 += d.extra100;
    t.atraso += d.atraso;
    t.saidaAntecipada += d.saidaAntecipada;
    t.falta += d.falta;
    t.noturno += d.noturno;
    if (d.faltaDia) t.faltasDias++;
    if (d.pendente) t.pendentes++;
  }
  t.saldo = t.extra50 + t.extra100 - t.atraso - t.saidaAntecipada - t.falta;
  return t;
}

/** Feriados nacionais fixos e móveis (Páscoa) de um ano. Estaduais e municipais são cadastrados na tela. */
export function feriadosNacionais(ano: number): { data: string; nome: string }[] {
  // Páscoa (algoritmo de Meeus/Jones/Butcher)
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  const pascoa = Date.UTC(ano, mes - 1, dia);
  const rel = (dias: number) => new Date(pascoa + dias * 86_400_000).toISOString().slice(0, 10);
  const fixo = (m2: number, d2: number) => `${ano}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
  return [
    { data: fixo(1, 1), nome: 'Confraternização Universal' },
    { data: rel(-48), nome: 'Carnaval (ponto facultativo)' },
    { data: rel(-47), nome: 'Carnaval (ponto facultativo)' },
    { data: rel(-2), nome: 'Sexta-feira Santa' },
    { data: fixo(4, 21), nome: 'Tiradentes' },
    { data: fixo(5, 1), nome: 'Dia do Trabalho' },
    { data: rel(60), nome: 'Corpus Christi (ponto facultativo)' },
    { data: fixo(9, 7), nome: 'Independência do Brasil' },
    { data: fixo(10, 12), nome: 'Nossa Senhora Aparecida' },
    { data: fixo(11, 2), nome: 'Finados' },
    { data: fixo(11, 15), nome: 'Proclamação da República' },
    ...(ano >= 2024 ? [{ data: fixo(11, 20), nome: 'Dia Nacional de Zumbi e da Consciência Negra' }] : []),
    { data: fixo(12, 25), nome: 'Natal' },
  ];
}
