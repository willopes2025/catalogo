import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';

/** EAN-13 com prefixo interno 200 (uso restrito da loja), para produto que chega sem código. */
export function ean13Interno(seq: number): string {
  const base = `200${String(seq).padStart(9, '0')}`.slice(0, 12);
  const soma = [...base].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (soma % 10)) % 10);
}

/** Próximo código interno livre: segue a maior sequência 200… já usada (não depende da contagem de produtos). */
export async function proximoCodigoInterno(db: Db | Tx): Promise<string> {
  const r = await db.execute<{ max: string | null }>(sql`select max(substring(codigo_barras from 4 for 9)) as max from produtos where codigo_barras ~ '^200[0-9]{10}$'`);
  return ean13Interno(Number(r.rows[0]?.max ?? 0) + 1);
}
