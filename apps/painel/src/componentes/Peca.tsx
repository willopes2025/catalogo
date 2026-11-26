import { useEffect, useMemo, useState } from 'react';

/** Tira acento e põe em minúsculas, para a busca não ligar para "Anél" x "anel". */
export const normalizar = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Cada palavra digitada precisa aparecer no texto ("anel ouro" acha "Anel solitário Ouro 18k"). */
export function casa(texto: string | null | undefined, busca: string) {
  const t = normalizar(texto ?? '');
  return normalizar(busca).split(/\s+/).filter(Boolean).every((p) => t.includes(p));
}

/**
 * Foto da peça em miniatura: clicou, a foto aumenta na mesma tela (sem abrir outra página);
 * clicou de novo, ou apertou Esc, ela fecha.
 */
export function FotoPeca({ src, alt = '', tamanho = 38 }: { src?: string | null; alt?: string; tamanho?: number }) {
  const [aberta, setAberta] = useState(false);
  useEffect(() => {
    if (!aberta) return;
    const fechar = (e: KeyboardEvent) => e.key === 'Escape' && setAberta(false);
    window.addEventListener('keydown', fechar);
    return () => window.removeEventListener('keydown', fechar);
  }, [aberta]);
  if (!src) return <span className="miniatura" style={{ width: tamanho, height: tamanho }} aria-hidden="true" />;
  return (
    <>
      <button type="button" className="foto-peca" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setAberta(true); }} title="Ver a foto maior" aria-label={`Ver a foto de ${alt || 'peça'}`}>
        <img className="miniatura" src={src} alt={alt} loading="lazy" style={{ width: tamanho, height: tamanho }} />
      </button>
      {aberta && (
        <div className="zoom-foto" role="dialog" aria-label={alt || 'Foto da peça'} onClick={(e) => { e.stopPropagation(); setAberta(false); }}>
          <figure>
            <img src={src} alt={alt} />
            {alt && <figcaption>{alt}</figcaption>}
          </figure>
        </div>
      )}
    </>
  );
}

/** Filtro digitado no cabeçalho da tabela: um campo por coluna (ex.: digite "anel" em Descrição). */
export function useFiltroColunas<T>(itens: T[], colunas: Record<string, (i: T) => string | null | undefined>) {
  const [filtro, setFiltro] = useState<Record<string, string>>({});
  const filtrados = useMemo(() => itens.filter((i) => Object.entries(filtro).every(([k, v]) => !v.trim() || !colunas[k] || casa(colunas[k](i), v))), [itens, filtro, colunas]);
  const ativo = Object.values(filtro).some((v) => v.trim());
  return { filtro, setFiltro, filtrados, ativo, limpar: () => setFiltro({}) };
}

/** Linha de filtro dentro do <thead>: `celulas` na ordem das colunas; null = coluna sem filtro. */
export function LinhaFiltro({ celulas, filtro, setFiltro }: { celulas: (string | null)[]; filtro: Record<string, string>; setFiltro: (f: Record<string, string>) => void }) {
  return (
    <tr className="linha-filtro">
      {celulas.map((c, i) => (
        <th key={i}>{c && <input type="search" placeholder="Filtrar…" aria-label={`Filtrar ${c}`} value={filtro[c] ?? ''} onChange={(e) => setFiltro({ ...filtro, [c]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} />}</th>
      ))}
    </tr>
  );
}
