/** Telefone para o WhatsApp: só dígitos, com DDI 55 quando vier só com DDD. */
export function normalizarTelefone(t: string | null | undefined): string | null {
  const d = (t ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}

/**
 * O WhatsApp às vezes manda celular brasileiro sem o 9 da frente (5527 9999 8888 → 5527 99998888).
 * Devolve as duas formas para achar o contato de qualquer jeito.
 */
export function variantesTelefone(t: string): string[] {
  const out = new Set([t]);
  if (t.startsWith('55') && t.length === 12 && /[6-9]/.test(t[4])) out.add(`${t.slice(0, 4)}9${t.slice(4)}`);
  if (t.startsWith('55') && t.length === 13 && t[4] === '9') out.add(`${t.slice(0, 4)}${t.slice(5)}`);
  return [...out];
}

/** Troca {{nome}}, {{primeiro_nome}}, {{telefone}}, {{etapa}} e {{funil}} pelos dados do lead. */
export function preencherTexto(texto: string, dados: Record<string, string | null | undefined>) {
  return texto.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k: string) => dados[k.toLowerCase()] ?? (k.toLowerCase().startsWith('campo_') ? '' : m));
}

export function primeiroNome(nome: string | null | undefined) {
  const p = (nome ?? '').trim().split(/\s+/)[0] ?? '';
  return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : '';
}

/** Pedido de descadastro de disparos. */
export const PEDIU_SAIR = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|não quero mais|nao quero mais)\s*[.!]*\s*$/i;

/** Nome do campo personalizado → variável de mensagem: "Cidade de entrega" vira campo_cidade_de_entrega. */
export function variavelDoCampo(nome: string) {
  return 'campo_' + nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Valores dos campos personalizados como variáveis ({{campo_cidade}}); moeda vai formatada. */
export function variaveisDosCampos(...extras: (Record<string, string> | null | undefined)[]) {
  const r: Record<string, string> = {};
  for (const e of extras) for (const [k, v] of Object.entries(e ?? {})) if (v != null && v !== '') r[variavelDoCampo(k)] = String(v);
  return r;
}
