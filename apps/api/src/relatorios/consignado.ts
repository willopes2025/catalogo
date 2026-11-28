import { sql, type SQL } from 'drizzle-orm';

/**
 * Indicadores do consignado (pedidos/maletas), da empresa toda ou da carteira de uma usuária
 * (consultoras com ela como supervisora). Datas em AAAA-MM-DD, horário de Brasília.
 *  - ativos: pedidos com a consultora no fim do período (retirados até lá e ainda não baixados).
 *  - renovações: pedidos novos no período de quem já tinha tido pedido antes.
 *  - churn: consultoras que tiveram pedido baixado no período e não pegaram outro depois.
 */
const daCarteira = (sup?: string | null) => (sup ? sql`and p.supervisor_id = ${sup}::uuid` : sql``);
const baixa = sql`(m.acertada_em at time zone 'America/Sao_Paulo')::date`;

export const sqlAtivos = (fim: string, sup?: string | null): SQL => sql`
  select count(*)::int as v from maletas m join pessoas p on p.id = m.representante_id
  where m.status <> 'cancelada' and m.data_retirada <= ${fim}::date and (m.acertada_em is null or ${baixa} > ${fim}::date) ${daCarteira(sup)}`;

export const sqlRenovacoes = (ini: string, fim: string, sup?: string | null): SQL => sql`
  select count(*)::int as v from maletas m join pessoas p on p.id = m.representante_id
  where m.status <> 'cancelada' and m.data_retirada between ${ini}::date and ${fim}::date ${daCarteira(sup)}
    and exists (select 1 from maletas a where a.representante_id = m.representante_id and a.id <> m.id and a.status <> 'cancelada' and (a.data_retirada < m.data_retirada or (a.data_retirada = m.data_retirada and a.numero < m.numero)))`;

const baixadasNoPeriodo = (ini: string, fim: string, sup?: string | null) => sql`
  select m.representante_id as rep, max(m.acertada_em) as em from maletas m join pessoas p on p.id = m.representante_id
  where m.status = 'acertada' and ${baixa} between ${ini}::date and ${fim}::date ${daCarteira(sup)}
  group by m.representante_id`;

const semNovo = sql`not exists (select 1 from maletas n where n.representante_id = b.rep and n.status <> 'cancelada' and (n.status = 'aberta' or n.criado_em > b.em))`;

export const sqlChurn = (ini: string, fim: string, sup?: string | null): SQL => sql`
  select count(*)::int as v from (${baixadasNoPeriodo(ini, fim, sup)}) b where ${semNovo}`;

/** Churn em %: das que tiveram pedido baixado no período, quantas não renovaram. */
export const sqlChurnPercentual = (ini: string, fim: string, sup?: string | null): SQL => sql`
  select case when count(*) = 0 then null else round(100.0 * count(*) filter (where ${semNovo}) / count(*), 1) end as v from (${baixadasNoPeriodo(ini, fim, sup)}) b`;
