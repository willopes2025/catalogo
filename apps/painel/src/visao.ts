import { useSyncExternalStore } from 'react';

/**
 * Visão por CNPJ: consolidado (todas as empresas) ou uma empresa só. Fica guardada neste navegador
 * e vale para o Início, Indicadores, Financeiro e DRE.
 */
const CHAVE = 'aritana.visao';
const ouvintes = new Set<() => void>();

export function lerVisao(): string {
  try {
    return localStorage.getItem(CHAVE) ?? '';
  } catch {
    return '';
  }
}

export function mudarVisao(empresaId: string) {
  try {
    if (empresaId) localStorage.setItem(CHAVE, empresaId);
    else localStorage.removeItem(CHAVE);
  } catch {
    /* sem armazenamento: vale só nesta tela */
  }
  ouvintes.forEach((f) => f());
}

export function usarVisao() {
  return useSyncExternalStore(
    (f) => {
      ouvintes.add(f);
      return () => ouvintes.delete(f);
    },
    lerVisao,
    () => '',
  );
}

/** Acrescenta a empresa da visão na URL da API (consolidado: não acrescenta nada). */
export const comVisao = (url: string, empresaId: string) => (empresaId ? `${url}${url.includes('?') ? '&' : '?'}empresaId=${empresaId}` : url);
