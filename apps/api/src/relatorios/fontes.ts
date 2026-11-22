import { sql } from 'drizzle-orm';

/**
 * Fontes únicas dos relatórios e indicadores, para os números baterem entre si.
 *
 * ITENS_VENDIDOS: uma linha por peça vendida, com o preço e o custo REAIS do momento da venda.
 *  - Loja, eventos, avulsas e revenda: itens das vendas concluídas (canceladas ficam de fora), já sem o que foi
 *    devolvido e com o desconto geral da venda rateado.
 *  - Rede: peças marcadas como vendidas nos acertos, pelo preço e custo com que entraram na maleta.
 *    O movimento de estoque e o acerto nascem na mesma transação (mesmo instante), e é isso que liga um ao outro.
 * Colunas: produto_id, dia, canal (rede | loja | evento | outras), qtd, valor, custo, pessoa_id (representante ou cliente), empresa_id.
 */
export const ITENS_VENDIDOS = sql`(
  select vi.produto_id, v.criado_em::date as dia,
    case when l.tipo = 'loja' and v.tipo = 'balcao' then 'loja' when l.tipo = 'evento' then 'evento' else 'outras' end as canal,
    (vi.quantidade - vi.devolvida) as qtd,
    round(vi.total::numeric / nullif(vi.quantidade, 0) * (vi.quantidade - vi.devolvida)
      * coalesce(v.total::numeric / nullif(sum(vi.total) over (partition by vi.venda_id), 0), 1))::bigint as valor,
    (vi.custo * (vi.quantidade - vi.devolvida))::bigint as custo,
    v.cliente_id as pessoa_id, v.empresa_id
  from venda_itens vi
  join vendas v on v.id = vi.venda_id and v.status = 'concluida'
  join locais_estoque l on l.id = v.local_id
  union all
  select mv.produto_id, a.data as dia, 'rede' as canal, mv.quantidade as qtd,
    (mi.preco * mv.quantidade)::bigint as valor, (mi.custo * mv.quantidade)::bigint as custo, m.representante_id as pessoa_id, m.empresa_id
  from movimentos mv
  join acertos a on a.maleta_id = mv.referencia_id and a.criado_em = mv.criado_em
  join maletas m on m.id = a.maleta_id
  join maleta_itens mi on mi.maleta_id = mv.referencia_id and mi.produto_id = mv.produto_id
  where mv.tipo = 'venda' and mv.referencia_tipo = 'maleta'
)`;

/** Peças que voltaram nos acertos (não venderam), para medir aceitação do produto na rede. */
export const ITENS_DEVOLVIDOS_REDE = sql`(
  select mv.produto_id, a.data as dia, mv.quantidade as qtd, m.representante_id as pessoa_id
  from movimentos mv
  join acertos a on a.maleta_id = mv.referencia_id and a.criado_em = mv.criado_em
  join maletas m on m.id = a.maleta_id
  where mv.tipo = 'maleta_devolucao' and mv.referencia_tipo = 'maleta'
)`;

/**
 * Título de cartão (débito/crédito) é previsão de repasse da maquininha, não dívida de cliente:
 * fica fora da inadimplência e aparece à parte, como "a conciliar".
 */
export const E_CARTAO = sql`coalesce(forma_pagamento, '') in ('debito', 'credito')`;
export const NAO_E_CARTAO = sql`coalesce(forma_pagamento, '') not in ('debito', 'credito')`;

/** Colunas que são texto mesmo quando só têm dígitos (código de barras com zero à esquerda, telefone…). */
const TEXTO = /telefone|codigo|referencia|documento|nome|descricao|cidade|cep|numero_nota/i;

/** Converte texto numérico do Postgres (bigint, numeric) em número, sem tocar em colunas de texto. */
export function numeros<T>(rows: unknown): T[] {
  const lista = ((rows as { rows?: unknown[] }).rows ?? rows) as Record<string, unknown>[];
  return lista.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && !TEXTO.test(k) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]))) as T[];
}
