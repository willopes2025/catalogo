/** Datas tratadas como dia civil (AAAA-MM-DD), sem hora, para não depender de fuso. */
export type DataISO = string;

function paraUTC(d: DataISO): number {
  const [a, m, dia] = d.slice(0, 10).split('-').map(Number);
  if (!a || !m || !dia) throw new Error(`Data inválida: ${d}`);
  return Date.UTC(a, m - 1, dia);
}

/** Dias corridos de `de` até `ate` (positivo se `ate` for depois). */
export function diasEntre(de: DataISO, ate: DataISO): number {
  return Math.round((paraUTC(ate) - paraUTC(de)) / 86_400_000);
}

export function somarDias(d: DataISO, dias: number): DataISO {
  return new Date(paraUTC(d) + dias * 86_400_000).toISOString().slice(0, 10);
}
