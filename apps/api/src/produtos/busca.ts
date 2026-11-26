import { and, sql, type SQL } from 'drizzle-orm';
import { produtos } from '../db/schema';

const COM = 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ';
const SEM = 'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc';
const normalizar = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Busca da peça "por tudo": descrição, referência, código, categoria (e a categoria-mãe), cor, tamanho e banho.
 * Cada palavra precisa aparecer em algum desses campos ("anel ouro" = aneis de ouro), sem ligar para acento.
 */
export function filtroBuscaProduto(busca: string): SQL | undefined {
  const termos = busca.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!termos.length) return undefined;
  const campo = sql`translate(lower(concat_ws(' ', ${produtos.descricao}, ${produtos.referencia}, ${produtos.codigoBarras}, ${produtos.cor}, ${produtos.tamanho}, ${produtos.tipoBanho}, ${produtos.milesimos}, ${produtos.descricaoCompleta},
    (select concat_ws(' ', c.nome, m.nome) from categorias c left join categorias m on m.id = c.pai_id where c.id = ${produtos.categoriaId}))), ${COM}, ${SEM})`;
  return and(...termos.map((t) => sql`${campo} like ${`%${normalizar(t)}%`}`));
}
