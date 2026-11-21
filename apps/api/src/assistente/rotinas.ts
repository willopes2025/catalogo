/** Brasília não tem mais horário de verão: UTC−3 o ano todo. */
const FUSO_MS = 3 * 3600_000;

export const NOMES_DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * Próxima vez em que a rotina roda, depois de `apos`: o primeiro dia marcado, no horário (de Brasília).
 * Se hoje é dia marcado e o horário ainda não passou, é hoje.
 */
export function proximaExecucao(horario: string, dias: number[], apos: Date = new Date()): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(horario);
  if (!m) throw new Error('Horário no formato HH:MM');
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error('Horário inválido');
  const marcados = new Set(dias.length ? dias : [0, 1, 2, 3, 4, 5, 6]);
  // Meia-noite de hoje em Brasília, expressa em UTC.
  const local = new Date(apos.getTime() - FUSO_MS);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + FUSO_MS;
  for (let d = 0; d <= 7; d++) {
    const dia = new Date(base + d * 86400_000);
    const semana = new Date(dia.getTime() - FUSO_MS).getUTCDay();
    if (!marcados.has(semana)) continue;
    const quando = new Date(dia.getTime() + (h * 60 + min) * 60_000);
    if (quando.getTime() > apos.getTime()) return quando;
  }
  throw new Error('Nenhum dia marcado');
}

export interface Agenda {
  tipo: string;
  horario: string;
  dias: number[];
  intervaloMin?: number | null;
  janelaInicio?: string | null;
  janelaFim?: string | null;
}

const minutos = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Horário no formato HH:MM');
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * Próxima execução de uma rotina: por horário (uma vez por dia) ou por intervalo (a cada N minutos, só nos dias
 * marcados e dentro da janela do dia, se houver; fora dela, começa no início da janela do próximo dia válido).
 */
export function proximaDaRotina(r: Agenda, apos: Date = new Date()): Date {
  if (r.tipo !== 'intervalo') return proximaExecucao(r.horario, r.dias, apos);
  const intervalo = Math.max(1, r.intervaloMin ?? 60);
  const ini = r.janelaInicio ? minutos(r.janelaInicio) : 0;
  const fim = r.janelaFim ? minutos(r.janelaFim) : 24 * 60 - 1;
  if (fim < ini) throw new Error('A janela termina antes de começar.');
  const marcados = new Set(r.dias.length ? r.dias : [0, 1, 2, 3, 4, 5, 6]);
  // Candidata: agora + intervalo, arredondada para o minuto.
  let t = Math.ceil((apos.getTime() + intervalo * 60_000) / 60_000) * 60_000;
  for (let volta = 0; volta < 10; volta++) {
    const local = new Date(t - FUSO_MS);
    const inicioDia = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + FUSO_MS;
    const minDoDia = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (!marcados.has(local.getUTCDay()) || minDoDia > fim) {
      t = inicioDia + 86400_000 + ini * 60_000;
      continue;
    }
    if (minDoDia < ini) t = inicioDia + ini * 60_000;
    return new Date(t);
  }
  throw new Error('Nenhum dia marcado');
}

/** "a cada 2 h", "a cada 30 min" etc. */
export function descreverIntervalo(min: number) {
  if (min % 1440 === 0) return min === 1440 ? 'a cada 1 dia' : `a cada ${min / 1440} dias`;
  if (min % 60 === 0) return `a cada ${min / 60} h`;
  if (min > 60) return `a cada ${Math.floor(min / 60)} h ${min % 60} min`;
  return `a cada ${min} min`;
}

/** Frase da agenda: "todo dia às 08:00" ou "a cada 2 h, de segunda a sexta, das 08:00 às 18:00". */
export function descreverAgenda(r: Agenda) {
  if (r.tipo !== 'intervalo') return `${descreverDias(r.dias)} às ${r.horario}`;
  const janela = r.janelaInicio || r.janelaFim ? `, das ${r.janelaInicio ?? '00:00'} às ${r.janelaFim ?? '23:59'}` : '';
  return `${descreverIntervalo(r.intervaloMin ?? 60)}, ${descreverDias(r.dias)}${janela}`;
}

/** "todo dia", "dias úteis", "fins de semana" ou a lista dos dias. */
export function descreverDias(dias: number[]) {
  const s = [...new Set(dias)].sort();
  if (s.length === 7 || !s.length) return 'todo dia';
  if (s.join() === '1,2,3,4,5') return 'de segunda a sexta';
  if (s.join() === '0,6') return 'sábado e domingo';
  return s.map((d) => NOMES_DIAS[d]).join(', ');
}

/** Planilha CSV que o Excel abre direto (separador ";" e BOM para os acentos). */
export function csv(colunas: string[], linhas: (string | number | null | undefined)[][]) {
  const cel = (v: string | number | null | undefined) => {
    const t = v == null ? '' : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return Buffer.from('﻿' + [colunas, ...linhas].map((l) => l.map(cel).join(';')).join('\r\n'), 'utf8');
}
