import { and, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Tira acento, caixa e caracteres de LIKE do que foi digitado. */
export const normalizarBusca = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[%_\\]/g, ' ')
    .trim();

const palavrasDe = (busca: string) => normalizarBusca(busca).split(/\s+/).filter(Boolean).slice(0, 6);

/**
 * Busca por nome que perdoa: sem acento ("Luciene" acha "Lucíene"), palavras em qualquer ordem e em qualquer
 * dos campos ("rovena costa"), grafia parecida (Luiza/Luísa, Sheyla/Sheila, Souza/Sousa, Vanessa/Vaneça) e
 * um erro de digitação por palavra (dois em palavras longas: "Robena" acha "Rovena", "Apolonia" acha "Apolinia").
 * Usa as funções busca_norm/busca_fon da migração 0052.
 */
export function buscaNome(campos: SQLWrapper[], busca: string): SQL | undefined {
  const palavras = palavrasDe(busca);
  if (!palavras.length) return undefined;
  const junto = sql`concat_ws(' ', ${sql.join(campos.map((c) => sql`${c}`), sql`, `)})`;
  const norm = sql`busca_norm(${junto})`;
  const fon = sql`busca_fon(${junto})`;
  return and(
    ...palavras.map((p) => {
      const exato = sql`${norm} like ${'%' + p + '%'}`;
      const parecido = sql`${fon} like '%' || busca_fon(${p}) || '%'`;
      if (p.length < 4 || /^\d+$/.test(p)) return or(exato, parecido)!;
      const erros = p.length >= 8 ? 2 : 1;
      const digitacao = sql`exists (select 1 from unnest(string_to_array(${fon}, ' ')) as w(x) where length(w.x) >= 3 and levenshtein(w.x, busca_fon(${p})) <= ${erros})`;
      return or(exato, parecido, digitacao)!;
    }),
  );
}

/** Para ordenar: primeiro quem tem todas as palavras exatas (sem acento), depois os parecidos. */
export function ordemBuscaNome(campos: SQLWrapper[], busca: string): SQL {
  const palavras = palavrasDe(busca);
  if (!palavras.length) return sql`0`;
  const norm = sql`busca_norm(concat_ws(' ', ${sql.join(campos.map((c) => sql`${c}`), sql`, `)}))`;
  return sql`(case when ${and(...palavras.map((p) => sql`${norm} like ${'%' + p + '%'}`))} then 0 else 1 end)`;
}
