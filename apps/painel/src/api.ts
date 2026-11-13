/** Cliente da API. Guarda a sessão no navegador e traduz erros para mensagens legíveis. */
const BASE = import.meta.env.VITE_API_URL ?? '/api';
const CHAVE = 'aritana.sessao';

export interface Sessao {
  token: string;
  usuario: { id: string; nome: string; email: string; grupo: string; permissoes: Record<string, string[]> };
}

export function lerSessao(): Sessao | null {
  try {
    const v = localStorage.getItem(CHAVE);
    return v ? (JSON.parse(v) as Sessao) : null;
  } catch {
    return null;
  }
}
export function salvarSessao(s: Sessao | null) {
  try {
    if (s) localStorage.setItem(CHAVE, JSON.stringify(s));
    else localStorage.removeItem(CHAVE);
  } catch {
    /* navegador sem armazenamento: a sessão dura até fechar a aba */
  }
  memoria = s;
}
let memoria: Sessao | null = lerSessao();

export class ErroApi extends Error {
  constructor(public status: number, public dados: { mensagem?: string; campos?: Record<string, string>; motivos?: string[] }) {
    super(dados.mensagem ?? 'Erro');
  }
}

export async function api<T = unknown>(rota: string, opcoes: { metodo?: string; corpo?: unknown } = {}): Promise<T> {
  const r = await fetch(BASE + rota, {
    method: opcoes.metodo ?? (opcoes.corpo ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(memoria ? { authorization: `Bearer ${memoria.token}` } : {}) },
    body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && memoria && !rota.startsWith('/auth/login')) {
    salvarSessao(null);
    window.location.href = '/entrar';
  }
  // Senha provisória: o sistema só libera depois da troca.
  if (r.status === 403 && dados?.trocarSenha && window.location.pathname !== '/minha-senha') window.location.href = '/minha-senha';
  if (!r.ok) throw new ErroApi(r.status, dados);
  return dados as T;
}

/** Atualiza nome, grupo e permissões guardados (mudam quando a gerência edita o usuário ou o grupo). */
export function atualizarUsuario(u: Sessao['usuario']) {
  if (!memoria) return;
  salvarSessao({ ...memoria, usuario: { ...memoria.usuario, ...u } });
}

export function pode(modulo: string, acao: string): boolean {
  const p = memoria?.usuario.permissoes ?? {};
  const t = p['*'] ?? [];
  const m = p[modulo] ?? [];
  return t.includes('*') || t.includes(acao) || m.includes('*') || m.includes(acao);
}
