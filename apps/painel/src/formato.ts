export { formatarReais as reais } from '@aritana/regras';

/**
 * Texto digitado → centavos. Aceita "129,90", "1.299,90", "129.90" e "1299".
 * Com vírgula, os pontos são milhar; sem vírgula, um ponto seguido de 1 ou 2 dígitos é a casa decimal.
 */
export function paraCentavos(v: string): number {
  let t = v.replace(/[^\d,.-]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,2}$/.test(t) && (t.match(/\./g) ?? []).length === 1) t = t;
  else t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
export const centavosParaTexto = (c?: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

export function data(d?: string | null) {
  if (!d) return '—';
  const [a, m, dia] = d.slice(0, 10).split('-');
  return `${dia}/${m}/${a}`;
}
export function dataHora(d?: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export const pct = (pb: number) => `${(pb / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
export const telefone = (t?: string | null) => {
  const d = (t ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return t ?? '';
};
export const documento = (d?: string | null) => {
  const x = (d ?? '').replace(/\D/g, '');
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d ?? '';
};
