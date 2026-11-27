import type React from 'react';
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
      {aberta && <ZoomFoto src={src} alt={alt} fechar={() => setAberta(false)} />}
    </>
  );
}

/** Foto grande por cima da tela: clique na foto (ou +/−) para dar zoom e mova o mouse para ver os detalhes; fora da foto, Esc ou × fecha. */
function ZoomFoto({ src, alt, fechar }: { src: string; alt: string; fechar: () => void }) {
  const [escala, setEscala] = useState(1);
  const [origem, setOrigem] = useState('50% 50%');
  const mover = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOrigem(`${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}% ${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
  };
  return (
    <div className="zoom-foto" role="dialog" aria-label={alt || 'Foto da peça'} onClick={(e) => { e.stopPropagation(); fechar(); }}>
      <figure onClick={(e) => e.stopPropagation()}>
        <div className="zoom-quadro">
          <img src={src} alt={alt} onMouseMove={escala > 1 ? mover : undefined} onClick={(e) => { mover(e); setEscala(escala > 1 ? 1 : 2.5); }} style={{ transform: `scale(${escala})`, transformOrigin: origem, cursor: escala > 1 ? 'zoom-out' : 'zoom-in' }} />
        </div>
        <div className="zoom-botoes">
          <button type="button" aria-label="Diminuir" onClick={() => setEscala((x) => Math.max(1, x - 0.5))}>−</button>
          <span>{Math.round(escala * 100)}%</span>
          <button type="button" aria-label="Aumentar" onClick={() => setEscala((x) => Math.min(5, x + 0.5))}>+</button>
          <button type="button" aria-label="Fechar" onClick={fechar}>×</button>
        </div>
        {alt && <figcaption>{alt}</figcaption>}
      </figure>
    </div>
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
