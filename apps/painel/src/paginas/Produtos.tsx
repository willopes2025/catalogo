import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ErroApi, pode } from '../api';
import { centavosParaTexto, paraCentavos, pct, reais } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';

interface Linha { id: string; codigoBarras: string; referencia: string; descricao: string; categoria: string | null; cor: string | null; custo: number; preco: number; foto: string | null; estoque: number; emMaletas: number; ativo: boolean }

export function Produtos() {
  const [params, setParams] = useSearchParams();
  const [busca, setBusca] = useState(params.get('busca') ?? '');
  const navegar = useNavigate();
  const cats = useQuery({ queryKey: ['categorias'], queryFn: () => api<{ id: string; nome: string; caminho: string }[]>('/produtos/categorias') });
  const q = useQuery({ queryKey: ['produtos', params.toString()], queryFn: () => api<{ itens: Linha[]; total: number }>(`/produtos?${params.toString()}`) });
  return (
    <>
      <Topo eb="Produtos" titulo="Catálogo" sub={q.data ? `${q.data.total} produtos ativos` : undefined} acoes={pode('produtos', 'criar') && <Link className="botao" to="/produtos/novo">Novo produto</Link>} />
      <form className="busca" onSubmit={(e) => { e.preventDefault(); const p = new URLSearchParams(params); busca ? p.set('busca', busca) : p.delete('busca'); setParams(p); }}>
        <input placeholder="Descrição, referência ou código de barras" value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus />
        <select value={params.get('categoriaId') ?? ''} onChange={(e) => { const p = new URLSearchParams(params); e.target.value ? p.set('categoriaId', e.target.value) : p.delete('categoriaId'); setParams(p); }}>
          <option value="">Todas as categorias</option>
          {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.caminho}</option>)}
        </select>
        <button className="botao claro">Buscar</button>
      </form>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th></th><th>Código</th><th>Ref.</th><th>Descrição</th><th>Categoria</th><th className="num">Custo</th><th className="num">Preço</th><th className="num">Margem</th><th className="num">Estoque</th><th className="num">Em maletas</th></tr></thead>
          <tbody>
            {q.data!.itens.map((p) => (
              <tr key={p.id} className="clicavel" onClick={() => navegar(`/produtos/${p.id}`)}>
                <td>{p.foto ? <img className="miniatura" src={p.foto} alt="" /> : <span className="miniatura" />}</td>
                <td className="muted">{p.codigoBarras}</td>
                <td>{p.referencia}</td>
                <td><b>{p.descricao}</b></td>
                <td>{p.categoria ?? '—'}</td>
                <td className="num">{reais(p.custo)}</td>
                <td className="num">{reais(p.preco)}</td>
                <td className="num">{p.preco ? pct(Math.round(((p.preco - p.custo) * 10000) / p.preco)) : '—'}</td>
                <td className="num">{p.estoque}</td>
                <td className="num">{p.emMaletas}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const DINHEIRO = ['custo', 'preco', 'precoAtacado'] as const;
/** Composição do custo (opcional; vem do Jueri). */
const CUSTOS: [string, string][] = [['bruto', 'Custo bruto'], ['insumos', 'Insumos'], ['banhoOuro', 'Banho ouro'], ['banhoPrata', 'Banho prata'], ['banhoRodio', 'Banho ródio'], ['verniz', 'Verniz']];
const PCTS: [string, string][] = [['lucroVarejoPb', 'Lucro varejo (%)'], ['lucroAtacadoPb', 'Lucro atacado (%)'], ['fcpPb', 'FCP (%)'], ['impostoPb', 'Imposto (%)']];
const MEDIDAS: [string, string][] = [['largura', 'Largura (mm)'], ['altura', 'Altura (mm)'], ['profundidade', 'Profundidade (mm)'], ['peso', 'Peso (g)']];
const pbTexto = (v: number | null | undefined) => (v == null ? '' : String(v / 100).replace('.', ','));
const textoPb = (t: string) => (t.trim() ? Math.round(Number(t.replace(',', '.')) * 100) : null);

export function FichaProduto() {
  const { id } = useParams();
  const novo = !id;
  const navegar = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, any>>({ exibeCatalogo: true, ativo: true, estoqueMinimo: 0 });
  const [din, setDin] = useState<Record<string, string>>({ custo: '', preco: '', precoAtacado: '' });
  const [extra, setExtra] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['produto', id], queryFn: () => api<Record<string, any>>(`/produtos/${id}`), enabled: !novo });
  const cats = useQuery({ queryKey: ['categorias'], queryFn: () => api<{ id: string; nome: string; caminho: string }[]>('/produtos/categorias') });
  const lotes = useQuery({ queryKey: ['lotes'], queryFn: () => api<{ id: string; codigo: string }[]>('/lotes') });
  useEffect(() => {
    if (q.data) {
      setF(q.data);
      setDin(Object.fromEntries(DINHEIRO.map((k) => [k, centavosParaTexto(q.data![k])])));
      const d = q.data;
      setExtra({
        ...Object.fromEntries(CUSTOS.map(([k]) => [`c_${k}`, d.custos?.[k] != null ? centavosParaTexto(d.custos[k]) : ''])),
        ...Object.fromEntries(PCTS.map(([k]) => [k, pbTexto(d[k])])),
        ...Object.fromEntries(MEDIDAS.map(([k]) => [`m_${k}`, d.medidas?.[k] != null ? String(d.medidas[k]).replace('.', ',') : ''])),
        marketplaces: (d.marketplaces ?? []).join(', '),
      });
    }
  }, [q.data]);
  const salvar = useMutation({
    mutationFn: () => {
      const { estoque, fornecedor, criadoEm, atualizadoEm, id: _i, fotos, idJueri, ...c } = f;
      c.loteBanhoId = c.loteBanhoId || null;
      for (const k of DINHEIRO) c[k] = din[k] ? paraCentavos(din[k]) : k === 'precoAtacado' ? null : 0;
      c.estoqueMinimo = Number(c.estoqueMinimo) || 0;
      c.estoqueMaximo = c.estoqueMaximo === '' || c.estoqueMaximo == null ? null : Number(c.estoqueMaximo) || 0;
      c.custos = Object.fromEntries(CUSTOS.filter(([k]) => extra[`c_${k}`]?.trim()).map(([k]) => [k, paraCentavos(extra[`c_${k}`])]));
      for (const [k] of PCTS) c[k] = textoPb(extra[k] ?? '');
      c.medidas = Object.fromEntries(MEDIDAS.filter(([k]) => extra[`m_${k}`]?.trim()).map(([k]) => [k, Number(extra[`m_${k}`].replace(',', '.')) || 0]));
      c.marketplaces = (extra.marketplaces ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      return novo ? api<any>('/produtos', { corpo: c }) : api<any>(`/produtos/${id}`, { metodo: 'PATCH', corpo: c });
    },
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['produtos'] }); if (novo) navegar(`/produtos/${p.id}`, { replace: true }); },
  });
  const campos = salvar.error instanceof ErroApi ? salvar.error.dados.campos ?? {} : {};
  if (!novo && q.isLoading) return <Carregando />;
  const editavel = novo ? pode('produtos', 'criar') : pode('produtos', 'editar');
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const inp = (k: string, r: string, cls = '', extra = {}) => <Campo rotulo={r} erro={campos[k]} className={cls}><input value={f[k] ?? ''} onChange={set(k)} disabled={!editavel} {...extra} /></Campo>;
  const custo = paraCentavos(din.custo || '0');
  const preco = paraCentavos(din.preco || '0');
  return (
    <>
      <Topo eb={novo ? 'Produtos · Novo' : `Produtos · ${f.codigoBarras ?? ''}`} titulo={novo ? 'Novo produto' : f.descricao} acoes={editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar</button>} />
      {salvar.isSuccess && <div className="aviso ok" style={{ marginBottom: 12 }}>Produto salvo.</div>}
      {salvar.error && <div style={{ marginBottom: 12 }}><Erro erro={salvar.error} /></div>}
      <div className="grade" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <div className="cartao form">
          <div className="secao">Dados</div>
          {inp('descricao', 'Descrição', 'l2')}
          {inp('referencia', 'Referência')}
          {inp('codigoBarras', 'Código de barras', '', { placeholder: novo ? 'Gerado se ficar vazio' : '' })}
          {inp('ean', 'EAN de fábrica', '', { placeholder: 'Se diferente do código de barras' })}
          <Campo rotulo="Categoria"><select value={f.categoriaId ?? ''} onChange={(e) => setF({ ...f, categoriaId: e.target.value || null })} disabled={!editavel}><option value="">—</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.caminho}</option>)}</select></Campo>
          {inp('tamanho', 'Tamanho')}
          {inp('cor', 'Cor')}
          {inp('tipoBanho', 'Tipo de banho', '', { placeholder: 'Ouro, prata, ródio…' })}
          {inp('pesoBanho', 'Banho')}
          {inp('milesimos', 'Milésimos')}
          {inp('codigoFornecedor', 'Código do fornecedor')}
          <Campo rotulo="Lote do banho"><select value={f.loteBanhoId ?? ''} onChange={set('loteBanhoId')} disabled={!editavel}><option value="">—</option>{lotes.data?.map((l) => <option key={l.id} value={l.id}>{l.codigo}</option>)}</select></Campo>
          {inp('localizacao', 'Localização na prateleira')}
          {inp('estoqueMinimo', 'Estoque mínimo', '', { type: 'number', min: 0 })}
          {inp('estoqueMaximo', 'Estoque máximo', '', { type: 'number', min: 0 })}
          <Campo rotulo="Descrição completa (catálogo)" className="l4"><textarea rows={2} value={f.descricaoCompleta ?? ''} onChange={set('descricaoCompleta')} disabled={!editavel} /></Campo>
          <div className="secao">Valores</div>
          <Campo rotulo="Custo (R$)" erro={campos.custo}><input value={din.custo} onChange={(e) => setDin({ ...din, custo: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>
          <Campo rotulo="Preço de varejo (R$)" erro={campos.preco}><input value={din.preco} onChange={(e) => setDin({ ...din, preco: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>
          <Campo rotulo="Preço de atacado (R$)"><input value={din.precoAtacado} onChange={(e) => setDin({ ...din, precoAtacado: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>
          <Campo rotulo="Margem"><input value={preco ? pct(Math.round(((preco - custo) * 10000) / preco)) : '—'} disabled /></Campo>
          {PCTS.slice(0, 2).map(([k, r]) => <Campo key={k} rotulo={r}><input value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>)}
          <details className="l4"><summary className="muted">Composição do custo</summary><div className="form" style={{ marginTop: 8 }}>
            {CUSTOS.map(([k, r]) => <Campo key={k} rotulo={`${r} (R$)`}><input value={extra[`c_${k}`] ?? ''} onChange={(e) => setExtra({ ...extra, [`c_${k}`]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>)}
          </div></details>
          <div className="secao">Fiscal</div>
          {inp('ncm', 'NCM')}
          {inp('cfop', 'CFOP')}
          {PCTS.slice(2).map(([k, r]) => <Campo key={k} rotulo={r}><input value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>)}
          <div className="secao">Medidas e vendas online</div>
          {MEDIDAS.map(([k, r]) => <Campo key={k} rotulo={r}><input value={extra[`m_${k}`] ?? ''} onChange={(e) => setExtra({ ...extra, [`m_${k}`]: e.target.value })} inputMode="decimal" disabled={!editavel} /></Campo>)}
          <Campo rotulo="Marketplaces" className="l2" ajuda="Separados por vírgula"><input value={extra.marketplaces ?? ''} onChange={(e) => setExtra({ ...extra, marketplaces: e.target.value })} disabled={!editavel} /></Campo>
          <Campo rotulo="Observação" className="l2"><textarea rows={2} value={f.observacao ?? ''} onChange={set('observacao')} disabled={!editavel} /></Campo>
          {f.camposExtras && Object.keys(f.camposExtras).length > 0 && <div className="l4 muted">Outros dados do Jueri: {Object.entries(f.camposExtras as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
          <div className="campo l2"><label>&nbsp;</label><div className="flex"><label className="check"><input type="checkbox" checked={!!f.exibeCatalogo} onChange={(e) => setF({ ...f, exibeCatalogo: e.target.checked })} disabled={!editavel} /> Aparece no catálogo</label><label className="check"><input type="checkbox" checked={!!f.ativo} onChange={(e) => setF({ ...f, ativo: e.target.checked })} disabled={!editavel} /> Ativo</label></div></div>
        </div>
        <div className="cartao">
          <h3 style={{ marginBottom: 10 }}>Estoque por local</h3>
          {f.estoque?.length ? f.estoque.map((e: any, i: number) => <div key={i} className="resumo-linha"><span>{e.local}</span><b>{e.quantidade}</b></div>) : <p className="muted">Sem estoque.</p>}
          {!novo && <p style={{ marginTop: 12 }}><Link to={`/estoque?rastreio=${f.codigoBarras}`}>Ver o caminho desta peça</Link></p>}
        </div>
      </div>
    </>
  );
}
