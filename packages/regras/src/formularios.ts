/**
 * Formulários montados pela equipe: tipos de campo e validação das respostas.
 * Fica nas regras (sem banco) para a mesma validação valer na API e nos testes.
 */
export const TIPOS_CAMPO = ['texto', 'texto_longo', 'telefone', 'email', 'cpf', 'numero', 'data', 'escolha', 'multipla', 'nota'] as const;
export type TipoCampo = (typeof TIPOS_CAMPO)[number];

/** Papel do campo quando o formulário cria um cliente ou uma candidata. */
export const PAPEIS = ['nome', 'telefone', 'email', 'cpf', 'cidade', 'uf'] as const;
export type Papel = (typeof PAPEIS)[number];

export interface CampoFormulario {
  id: string;
  tipo: TipoCampo;
  rotulo: string;
  obrigatorio: boolean;
  opcoes?: string[];
  ajuda?: string | null;
  papel?: Papel | null;
}

export type ValorResposta = string | number | string[] | null;

const soDig = (s: string) => s.replace(/\D/g, '');

export function cpfValidoForm(c: string): boolean {
  const d = soDig(c);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/**
 * Confere e normaliza as respostas. Devolve os valores limpos ou os erros por campo.
 * Campos que não existem no formulário são ignorados.
 */
export function validarRespostas(campos: CampoFormulario[], entrada: Record<string, unknown>): { ok: true; valores: Record<string, ValorResposta> } | { ok: false; erros: Record<string, string> } {
  const erros: Record<string, string> = {};
  const valores: Record<string, ValorResposta> = {};
  for (const c of campos) {
    const bruto = entrada[c.id];
    const vazio = bruto === undefined || bruto === null || bruto === '' || (Array.isArray(bruto) && bruto.length === 0);
    if (vazio) {
      if (c.obrigatorio) erros[c.id] = 'Obrigatório';
      valores[c.id] = null;
      continue;
    }
    const texto = typeof bruto === 'string' ? bruto.trim() : typeof bruto === 'number' ? String(bruto) : '';
    switch (c.tipo) {
      case 'texto':
      case 'texto_longo':
        if (typeof bruto !== 'string') erros[c.id] = 'Resposta inválida';
        else if (texto.length > (c.tipo === 'texto' ? 300 : 3000)) erros[c.id] = 'Texto longo demais';
        else valores[c.id] = texto;
        break;
      case 'telefone': {
        const d = soDig(texto);
        if (d.length < 10 || d.length > 11) erros[c.id] = 'Telefone com DDD';
        else valores[c.id] = d;
        break;
      }
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto) || texto.length > 200) erros[c.id] = 'E-mail inválido';
        else valores[c.id] = texto.toLowerCase();
        break;
      case 'cpf':
        if (!cpfValidoForm(texto)) erros[c.id] = 'CPF inválido';
        else valores[c.id] = soDig(texto);
        break;
      case 'numero': {
        const n = Number(texto.replace(',', '.'));
        if (!Number.isFinite(n)) erros[c.id] = 'Número inválido';
        else valores[c.id] = n;
        break;
      }
      case 'data': {
        const [a, m, d] = texto.split('-').map(Number);
        const x = new Date(Date.UTC(a, (m ?? 0) - 1, d));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(texto) || x.getUTCDate() !== d) erros[c.id] = 'Data inválida';
        else valores[c.id] = texto;
        break;
      }
      case 'escolha':
        if (!c.opcoes?.includes(texto)) erros[c.id] = 'Escolha uma das opções';
        else valores[c.id] = texto;
        break;
      case 'multipla': {
        const lista = Array.isArray(bruto) ? bruto.map(String) : [];
        if (!lista.length || lista.some((x) => !c.opcoes?.includes(x))) erros[c.id] = 'Escolha entre as opções';
        else valores[c.id] = [...new Set(lista)];
        break;
      }
      case 'nota': {
        const n = Number(texto);
        if (!Number.isInteger(n) || n < 0 || n > 10) erros[c.id] = 'Nota de 0 a 10';
        else valores[c.id] = n;
        break;
      }
    }
  }
  return Object.keys(erros).length ? { ok: false, erros } : { ok: true, valores };
}

/** NPS: % de promotores (9–10) menos % de detratores (0–6). Sem notas, null. */
export function calcularNps(notas: number[]): { nps: number | null; promotores: number; neutros: number; detratores: number; total: number } {
  const total = notas.length;
  const promotores = notas.filter((n) => n >= 9).length;
  const detratores = notas.filter((n) => n <= 6).length;
  return { nps: total ? Math.round(((promotores - detratores) / total) * 100) : null, promotores, neutros: total - promotores - detratores, detratores, total };
}
