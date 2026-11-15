import { lerSessao } from '../../api';

export const hojeBR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
export const competenciaAtual = () => hojeBR().slice(0, 7);
export function ultimasCompetencias(n = 12) {
  const [a, m] = competenciaAtual().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(a, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}
export const nomeMes = (c: string) => new Date(`${c}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const ROTULO_BATIDA = ['Entrada', 'Saída para o intervalo', 'Volta do intervalo', 'Saída'];
export const rotuloBatida = (i: number) => (i < 4 ? ROTULO_BATIDA[i] : i % 2 === 0 ? `Entrada (${Math.floor(i / 2) + 1}ª)` : `Saída (${Math.floor(i / 2) + 1}ª)`);
export const hm = (min?: number | null) => {
  if (!min) return '—';
  const m = Math.abs(Math.round(min));
  return `${min < 0 ? '-' : ''}${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};
export const horaDe = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

/** Abre um arquivo protegido (precisa do login) numa aba nova, ou baixa. */
export async function abrirArquivo(url: string, opcoes: { metodo?: string; corpo?: unknown; baixarComo?: string } = {}) {
  const s = lerSessao();
  const r = await fetch(`/api${url}`, {
    method: opcoes.metodo ?? 'GET',
    headers: { authorization: `Bearer ${s?.token ?? ''}`, ...(opcoes.corpo ? { 'content-type': 'application/json' } : {}) },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.mensagem ?? `Não foi possível abrir o arquivo (${r.status}).`);
  }
  const blob = await r.blob();
  const link = URL.createObjectURL(blob);
  if (opcoes.baixarComo) {
    const a = document.createElement('a');
    a.href = link;
    a.download = opcoes.baixarComo;
    a.click();
  } else window.open(link, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(link), 60_000);
}

/** Arquivo do computador → base64 (sem o prefixo data:). */
export function lerArquivo(f: File): Promise<string> {
  return new Promise((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^;]+;base64,/, ''));
    r.onerror = () => erro(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(f);
  });
}
