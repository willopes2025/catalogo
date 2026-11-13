/** Cliente da API do portal da representante (sessão separada da equipe). */
const CHAVE = 'aritana.portal';
let memoria: { token: string; nome: string } | null = null;
try {
  const v = localStorage.getItem(CHAVE);
  memoria = v ? JSON.parse(v) : null;
} catch {
  memoria = null;
}

export const sessaoPortal = () => memoria;
export function salvarSessaoPortal(s: { token: string; nome: string } | null) {
  memoria = s;
  try {
    if (s) localStorage.setItem(CHAVE, JSON.stringify(s));
    else localStorage.removeItem(CHAVE);
  } catch {
    /* sem armazenamento: dura até fechar */
  }
}

export class ErroPortal extends Error {
  constructor(public status: number, public dados: { mensagem?: string; campos?: Record<string, string> }) {
    super(dados.mensagem ?? (dados.campos ? Object.values(dados.campos)[0] : 'Erro'));
  }
}

export async function apiPortal<T = any>(rota: string, opcoes: { metodo?: string; corpo?: unknown } = {}): Promise<T> {
  const r = await fetch('/api/portal' + rota, {
    method: opcoes.metodo ?? (opcoes.corpo !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(memoria ? { authorization: `Bearer ${memoria.token}` } : {}) },
    body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && memoria) {
    salvarSessaoPortal(null);
    window.location.href = '/portal/entrar';
  }
  if (!r.ok) throw new ErroPortal(r.status, dados);
  return dados as T;
}
