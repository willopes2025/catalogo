import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { data, pct, reais, telefone } from '../../formato';
import '../inicio.css';
import './indicadores.css';

export type TipoCol = 'dinheiro' | 'pct' | 'data' | 'num' | 'tel' | 'var';
export type Col = [chave: string, titulo: string, tipo?: TipoCol, dica?: string];

export const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const menos = (d: string, dias: number) => new Date(new Date(d + 'T12:00:00Z').getTime() - dias * 86_400_000).toISOString().slice(0, 10);

/** Períodos prontos: o que o dono mais olha. */
export function periodos(): [string, string, string, string][] {
  const h = hoje();
  const iniMes = h.slice(0, 8) + '01';
  const fimMesPassado = menos(iniMes, 1);
  return [
    ['mes', 'Este mês', iniMes, h],
    ['mes_passado', 'Mês passado', fimMesPassado.slice(0, 8) + '01', fimMesPassado],
    ['30', '30 dias', menos(h, 29), h],
    ['90', '90 dias', menos(h, 89), h],
    ['ano', 'Este ano', h.slice(0, 4) + '-01-01', h],
  ];
}

export function valorCelula(v: unknown, tipo?: TipoCol): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (tipo === 'dinheiro') return reais(Number(v));
  if (tipo === 'pct') return pct(Number(v));
  if (tipo === 'var') return <Variacao pb={Number(v)} />;
  if (tipo === 'data') return data(String(v));
  if (tipo === 'tel') return telefone(String(v));
  if (tipo === 'num') return Number(v).toLocaleString('pt-BR');
  return String(v);
}

/** Exporta para Excel (CSV com ponto e vírgula, que o Excel em português abre direto). */
export function exportar(nome: string, colunas: Col[], linhas: Record<string, unknown>[]) {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cel = (v: unknown, t?: TipoCol) =>
    v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : t === 'dinheiro' ? (Number(v) / 100).toFixed(2).replace('.', ',') : t === 'pct' || t === 'var' ? (Number(v) / 100).toFixed(1).replace('.', ',') : String(v);
  const csv = [colunas.map((c) => esc(c[1])).join(';'), ...linhas.map((l) => colunas.map((c) => esc(cel(l[c[0]], c[2]))).join(';'))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nome}-${hoje()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const LIMITE_TELA = 300;
const numerica = (t?: TipoCol) => !!t && t !== 'tel' && t !== 'data';

/** Tabela que ordena ao clicar no título e exporta tudo para Excel. */
export function Tabela({ nome, colunas, linhas, titulo, sub, celula, limite = LIMITE_TELA, vazio = 'Nada no período.', ordemInicial }: {
  nome: string; colunas: Col[]; linhas: Record<string, any>[]; titulo?: ReactNode; sub?: ReactNode; limite?: number; vazio?: string; ordemInicial?: [string, 1 | -1];
  /** Desenho próprio de uma célula (ex.: nome com link). Devolva undefined para usar o padrão. */
  celula?: (linha: Record<string, any>, chave: string) => ReactNode | undefined;
}) {
  const [ordem, setOrdem] = useState<[string, 1 | -1] | null>(ordemInicial ?? null);
  const ordenadas = useMemo(() => {
    if (!ordem) return linhas;
    const [k, d] = ordem;
    return [...linhas].sort((a, b) => {
      const x = a[k], y = b[k];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR')) * d;
    });
  }, [linhas, ordem]);
  return (
    <div className="coluna" style={{ gap: 8 }}>
      <div className="flex entre" style={{ alignItems: 'flex-end', gap: 12 }}>
        <div>{titulo && <h3>{titulo}</h3>}{sub && <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{sub}</div>}</div>
        <button className="botao claro pequeno" disabled={!linhas.length} onClick={() => exportar(nome, colunas, ordenadas)}>Exportar para Excel</button>
      </div>
      {linhas.length === 0 ? <div className="cartao vazio" style={{ padding: 22 }}>{vazio}</div> : (
        <div className="ind-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                {colunas.map((c) => (
                  <th key={c[0]} className={`ordenavel ${numerica(c[2]) ? 'num' : ''}`} title={c[3] ?? 'Clique para ordenar'} onClick={() => setOrdem((o) => (o && o[0] === c[0] ? [c[0], o[1] === 1 ? -1 : 1] : [c[0], numerica(c[2]) ? -1 : 1]))}>
                    {c[1]}{ordem?.[0] === c[0] ? (ordem[1] === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordenadas.slice(0, limite).map((l, i) => (
                <tr key={l.id ?? i}>{colunas.map((c) => <td key={c[0]} className={numerica(c[2]) ? 'num' : ''}>{celula?.(l, c[0]) ?? valorCelula(l[c[0]], c[2])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {linhas.length > limite && <p className="muted" style={{ fontSize: 13 }}>Mostrando {limite} de {linhas.length.toLocaleString('pt-BR')} linhas. O Excel leva todas.</p>}
    </div>
  );
}

/** Variação contra o período anterior. `inverso`: quando subir é ruim (inadimplência, atraso). */
export function Variacao({ pb, inverso }: { pb: number | null | undefined; inverso?: boolean }) {
  if (pb === null || pb === undefined) return <span className="ind-var neutro">novo</span>;
  if (Math.abs(pb) < 50) return <span className="ind-var neutro">estável</span>;
  const bom = inverso ? pb < 0 : pb > 0;
  return <span className={`ind-var ${bom ? 'bom' : 'ruim'}`}>{pb > 0 ? '▲' : '▼'} {pct(Math.abs(pb))}</span>;
}

export function Kpi({ rotulo, valor, variacao, inverso, detalhe, tom, dica, i = 0 }: { rotulo: string; valor: ReactNode; variacao?: number | null; inverso?: boolean; detalhe?: ReactNode; tom?: 'escuro' | 'atencao' | 'bom'; dica?: string; i?: number }) {
  return (
    <div className={`cartao ini-kpi ini-anim ind-kpi ${tom ?? ''}`} style={{ '--i': i } as CSSProperties} title={dica}>
      <div className="rotulo">{rotulo}{dica && <span className="ind-i">?</span>}</div>
      <div className="valor">{valor}</div>
      <div className="detalhe">{variacao !== undefined && <Variacao pb={variacao} inverso={inverso} />} {detalhe}</div>
    </div>
  );
}

export function Cartao({ titulo, sub, children, i = 0, acao }: { titulo: ReactNode; sub?: ReactNode; children: ReactNode; i?: number; acao?: ReactNode }) {
  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i } as CSSProperties}>
      <h2>{titulo} <small>{acao ?? sub}</small></h2>
      {children}
    </div>
  );
}

/** Barras empilhadas por período (mês ou semana), com o valor ao passar o mouse. */
export function BarrasTempo({ pontos, series, altura = 190, linha }: {
  pontos: { rotulo: string; valores: Record<string, number>; extra?: string }[]; series: [chave: string, nome: string, cor: string][]; altura?: number;
  /** Linha por cima das barras (ex.: saldo projetado), na mesma escala. */
  linha?: { chave: string; nome: string; cor: string };
}) {
  const max = Math.max(1, ...pontos.map((p) => Math.max(series.reduce((a, s) => a + Math.max(0, p.valores[s[0]] ?? 0), 0), linha ? p.valores[linha.chave] ?? 0 : 0)));
  return (
    <>
      <div className="ini-legenda">
        {series.map((s) => <span key={s[0]}><i style={{ background: s[2] }} />{s[1]}</span>)}
        {linha && <span><i style={{ background: linha.cor, borderRadius: '50%' }} />{linha.nome}</span>}
      </div>
      <div className="ini-barras ind-barras" style={{ height: altura }} role="img">
        {pontos.map((p, k) => (
          <div key={p.rotulo + k} className="col" style={{ '--d': k * 2 } as CSSProperties}>
            {series.map((s) => <span key={s[0]} style={{ height: `${(Math.max(0, p.valores[s[0]] ?? 0) / max) * 100}%`, background: s[2] }} />)}
            {linha && <b className="ind-ponto" style={{ bottom: `${(Math.max(0, p.valores[linha.chave] ?? 0) / max) * 100}%`, background: linha.cor }} />}
            <div className="dica">
              <b>{p.rotulo}</b>
              {series.map((s) => <div key={s[0]}>{s[1]}: {reais(p.valores[s[0]] ?? 0)}</div>)}
              {linha && <div>{linha.nome}: {reais(p.valores[linha.chave] ?? 0)}</div>}
              {p.extra && <div>{p.extra}</div>}
            </div>
            <em>{p.rotulo}</em>
          </div>
        ))}
      </div>
    </>
  );
}

/** Lista com barra horizontal proporcional (rankings e participações). */
export function BarrasLista({ itens, formato = reais, vazio = 'Nada no período.' }: { itens: { nome: ReactNode; valor: number; extra?: ReactNode; cor?: string }[]; formato?: (n: number) => string; vazio?: string }) {
  const max = Math.max(1, ...itens.map((x) => x.valor));
  if (!itens.length) return <p className="muted">{vazio}</p>;
  return (
    <div className="ini-rank">
      {itens.map((x, k) => (
        <div key={k}>
          <div className="lin">
            <span className="pos">{k + 1}</span>
            <span className="nome">{x.nome} {x.extra && <span className="muted" style={{ fontSize: 12 }}>· {x.extra}</span>}</span>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{formato(x.valor)}</b>
          </div>
          <div className="lin"><div className="trilho"><span style={{ width: `${(x.valor / max) * 100}%`, background: x.cor, '--d': k } as CSSProperties} /></div></div>
        </div>
      ))}
    </div>
  );
}

export interface Alerta { tom: 'erro' | 'alerta' | 'info' | 'ok'; titulo: string; texto: string; link?: string }
export function Alertas({ alertas }: { alertas: Alerta[] }) {
  if (!alertas.length) return <div className="ind-alerta ok"><b>Tudo dentro do esperado.</b><span>Nenhum ponto de atenção nos números deste período.</span></div>;
  return (
    <div className="ind-alertas">
      {alertas.map((a, k) => {
        const corpo = <><b>{a.titulo}</b><span>{a.texto}</span></>;
        return a.link ? <Link key={k} to={a.link} className={`ind-alerta ${a.tom}`} style={{ '--d': k } as CSSProperties}>{corpo}<i>›</i></Link> : <div key={k} className={`ind-alerta ${a.tom}`} style={{ '--d': k } as CSSProperties}>{corpo}</div>;
      })}
    </div>
  );
}

export const mesCurto = (m: string) => `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
export const COR = { rede: '#896f4b', lojas: '#5c4a3d', eventos: '#c49a5a', outras: '#b9ad9c', bom: '#3e6b47', ruim: '#9b3226', neutro: '#b9ad9c' };
