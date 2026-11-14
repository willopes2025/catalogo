/**
 * Leitura tolerante dos registros da API do Jueri.
 * A documentação deles não descreve todos os campos (itens do pedido, contas a receber),
 * então cada valor é procurado em mais de um nome possível.
 */
export type Reg = Record<string, unknown>;

export const txt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Primeiro valor preenchido entre vários caminhos ("produto.codigo_barras", "fk_produto_id"…). */
export function pegar(r: Reg | null | undefined, ...caminhos: string[]): unknown {
  if (!r) return undefined;
  for (const c of caminhos) {
    let v: unknown = r;
    for (const parte of c.split('.')) v = v && typeof v === 'object' ? (v as Reg)[parte] : undefined;
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) return v;
  }
  return undefined;
}

/** 49.99, "49.99", "1.234,56" → centavos. */
export function centavos(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** 30 ou "30.00" (por cento) → pontos-base. */
export function pb(v: unknown): number | null {
  const c = centavos(v);
  return c === null ? null : c;
}

export function inteiro(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.floor(Number(String(v).replace(',', '.')));
  return Number.isFinite(n) ? n : null;
}

/** "2026-03-24 00:00" ou "24/03/2026" → "2026-03-24". */
export function dataISO(v: unknown): string | null {
  const s = txt(v);
  if (!s) return null;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

export const ativo = (r: Reg) => {
  const s = pegar(r, 'fk_status_id', 'status');
  return !(s === 2 || s === '2' || /inativ/i.test(String(s ?? '')));
};

/** Chaves (nunca os valores) de uma lista de registros: mostra a estrutura sem expor dados pessoais. */
export function estrutura(regs: Reg[], limite = 3): string[] {
  const chaves = new Set<string>();
  for (const r of regs.slice(0, limite)) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v as Reg)) chaves.add(`${k}.${k2}`);
      else chaves.add(k);
    }
  }
  return [...chaves].sort();
}

/** Status de pedido do Jueri: 1 Aberto, 2 Baixado, 3 Cancelado, 4 Perdido. */
export const pedidoAberto = (p: Reg) => {
  // A listagem já é pedida com status=1; aqui só se descarta o que vier claramente fechado.
  const s = pegar(p, 'status', 'fk_status_id', 'status_id', 'status.nome');
  if (s === undefined || typeof s === 'object') return true;
  return !['2', '3', '4'].includes(String(s)) && !/baixad|cancelad|perdid/i.test(String(s));
};

/** Conta a receber ainda não paga nem cancelada. */
export function contaEmAberto(c: Reg) {
  if (pegar(c, 'data_pagamento', 'data_baixa', 'pago_em')) return false;
  const s = String(pegar(c, 'status', 'situacao', 'status_nome') ?? '');
  return !/\bpag[oa]s?\b|quitad|baixad|cancelad|liquidad|recebid/i.test(s);
}

/** Quantidade que ainda está com a revendedora, num item de pedido. */
export function qtdEmAberto(it: Reg): number {
  const total = inteiro(pegar(it, 'quantidade', 'quantidade_enviada', 'qtd')) ?? 0;
  const saiu = (inteiro(pegar(it, 'quantidade_vendida')) ?? 0) + (inteiro(pegar(it, 'quantidade_devolvida')) ?? 0) + (inteiro(pegar(it, 'quantidade_perdida')) ?? 0);
  return Math.max(0, total - saiu);
}

/** Acha a lista dentro da resposta, venha ela solta, em data, em data.data ou noutra chave. */
export function extrairLista(j: unknown): { itens: Reg[]; proxima: boolean } {
  if (Array.isArray(j)) return { itens: j as Reg[], proxima: false };
  if (!j || typeof j !== 'object') return { itens: [], proxima: false };
  const o = j as Reg;
  if (Array.isArray(o.data)) return { itens: o.data as Reg[], proxima: !!(o.next_page_url ?? (o.links as Reg | undefined)?.next) };
  if (o.data && typeof o.data === 'object') return extrairLista(o.data);
  const arr = Object.values(o).find((v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object'));
  if (arr) return { itens: arr as Reg[], proxima: false };
  // Objeto indexado por id ({ "1": {...}, "2": {...} }).
  const vals = Object.values(o);
  if (vals.length && vals.every((v) => v && typeof v === 'object' && 'id' in (v as Reg))) return { itens: vals as Reg[], proxima: false };
  return { itens: [], proxima: false };
}

/** Resposta de um registro só, solta ou dentro de data. */
export function umRegistro(j: unknown): Reg {
  const o = (j ?? {}) as Reg;
  return o.data && typeof o.data === 'object' && !Array.isArray(o.data) && !('id' in o) ? (o.data as Reg) : o;
}

