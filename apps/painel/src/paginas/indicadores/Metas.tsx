import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../../api';
import { centavosParaTexto, paraCentavos, pct, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';
import { Cartao, Tabela } from './comum';
import './indicadores.css';

interface Linha { id: string; tipo: string; nome: string; localId: string | null; dinheiro: boolean; meta: number; realizado: number; atingidoPb: number; projecao: number; projecaoPb: number; falta: number; porDia: number; mesAnterior: number; situacao: 'batida' | 'nao_batida' | 'no_ritmo' | 'perto' | 'abaixo' }
export interface MetasResp { competencia: string; dias: number; decorridos: number; restantes: number; tipos: Record<string, { nome: string; dinheiro: boolean }>; linhas: Linha[]; consultoras: { total: number; bateram: number; lista: any[] }; vendedoras: any[] }

const SITUACAO: Record<Linha['situacao'], [string, string]> = {
  batida: ['Meta batida', 'var(--ok)'],
  nao_batida: ['Não bateu', 'var(--erro)'],
  no_ritmo: ['No ritmo', 'var(--ok)'],
  perto: ['Quase no ritmo', '#c08a1e'],
  abaixo: ['Abaixo do ritmo', 'var(--erro)'],
};
const nomeMes = (c: string) => new Date(`${c}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const meses = () => {
  const h = new Date(Date.now() - 3 * 3600_000);
  return Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + 2 - i, 1)).toISOString().slice(0, 7));
};

/** Barra de meta: realizado (cheio), projeção (listrado) e a marca de 100%. */
export function BarraMeta({ l, i = 0 }: { l: Linha; i?: number }) {
  const v = (n: number) => (l.dinheiro ? reais(n) : n.toLocaleString('pt-BR'));
  const escala = Math.max(l.meta, l.projecao, l.realizado) * 1.05 || 1;
  const [rotulo, cor] = SITUACAO[l.situacao];
  return (
    <div className="ind-meta ini-anim" style={{ '--i': i } as CSSProperties}>
      <div className="flex entre" style={{ alignItems: 'baseline', gap: 10 }}>
        <b>{l.nome}</b>
        <span style={{ color: cor, fontWeight: 700, fontSize: 13 }}>{rotulo}</span>
      </div>
      <div className="trilho">
        <span className="proj" style={{ width: `${(l.projecao / escala) * 100}%` }} />
        <span className="real" style={{ width: `${(l.realizado / escala) * 100}%`, background: cor }} />
        <i style={{ left: `${(l.meta / escala) * 100}%` }} title={`Meta ${v(l.meta)}`} />
      </div>
      <div className="flex entre" style={{ fontSize: 13, gap: 10, flexWrap: 'wrap' }}>
        <span><b>{v(l.realizado)}</b> de {v(l.meta)} ({pct(l.atingidoPb)})</span>
        <span className="muted">
          {l.situacao === 'batida' || l.situacao === 'nao_batida' ? `mês anterior ${v(l.mesAnterior)}` : `projeção ${v(l.projecao)}${l.porDia ? ` · precisa de ${v(l.porDia)} por dia` : ''}`}
        </span>
      </div>
    </div>
  );
}

export function Metas() {
  const qc = useQueryClient();
  const [comp, setComp] = useState(new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7));
  const q = useQuery({ queryKey: ['metas', comp], queryFn: () => api<MetasResp>(`/metas?competencia=${comp}`) });
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState<{ tipo: string; localId: string | null; valor: string }[]>([]);
  useEffect(() => {
    if (q.data) setRascunho(q.data.linhas.map((l) => ({ tipo: l.tipo, localId: l.localId, valor: l.dinheiro ? centavosParaTexto(l.meta) : String(l.meta) })));
  }, [q.data]);
  const anterior = useQuery({ queryKey: ['metas', 'anterior', comp], queryFn: () => api<MetasResp>(`/metas?competencia=${new Date(Date.UTC(Number(comp.slice(0, 4)), Number(comp.slice(5)) - 2, 1)).toISOString().slice(0, 7)}`), enabled: editando });
  const salvar = useMutation({
    mutationFn: () => api('/metas', { metodo: 'PUT', corpo: { competencia: comp, metas: rascunho.filter((r) => r.valor.trim()).map((r) => ({ tipo: r.tipo, localId: r.localId, valor: q.data!.tipos[r.tipo]?.dinheiro ? paraCentavos(r.valor) : Number(r.valor.replace(/\D/g, '')) })) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['metas'] }); setEditando(false); },
  });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const d = q.data!;
  const editar = pode('relatorios', 'editar');
  const usados = new Set(rascunho.map((r) => `${r.tipo}:${r.localId ?? ''}`));
  return (
    <div className="coluna" style={{ gap: 14 }}>
      <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={comp} onChange={(e) => { setComp(e.target.value); setEditando(false); }} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit', width: 'auto', textTransform: 'capitalize' }}>{meses().map((c) => <option key={c} value={c}>{nomeMes(c)}</option>)}</select>
        <span className="muted">{d.restantes === 0 ? 'Mês encerrado' : d.decorridos === 0 ? 'Mês ainda não começou' : `Dia ${d.decorridos} de ${d.dias} · faltam ${d.restantes} dia(s)`}</span>
        {editar && !editando && <button className="botao claro" style={{ marginLeft: 'auto' }} onClick={() => setEditando(true)}>{d.linhas.length ? 'Editar metas' : 'Definir metas do mês'}</button>}
      </div>

      {editando ? (
        <div className="cartao form">
          <div className="secao" style={{ marginTop: 0 }}>Metas de {nomeMes(comp)}</div>
          {rascunho.map((r, k) => (
            <div key={k} className="l4 flex" style={{ gap: 8, alignItems: 'center' }}>
              <select value={r.tipo} onChange={(e) => setRascunho(rascunho.map((x, j) => (j === k ? { ...x, tipo: e.target.value, localId: null } : x)))} style={{ flex: 1 }}>{Object.entries(d.tipos).map(([t, x]) => <option key={t} value={t}>{x.nome}</option>)}</select>
              {r.tipo === 'local' && <select value={r.localId ?? ''} onChange={(e) => setRascunho(rascunho.map((x, j) => (j === k ? { ...x, localId: e.target.value || null } : x)))} style={{ flex: 1 }}><option value="">Escolha a loja ou evento</option>{locais.data?.filter((l) => l.tipo === 'loja' || l.tipo === 'evento').map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>}
              <input value={r.valor} onChange={(e) => setRascunho(rascunho.map((x, j) => (j === k ? { ...x, valor: e.target.value } : x)))} placeholder={d.tipos[r.tipo]?.dinheiro ? 'R$ 0,00' : 'quantidade'} inputMode="decimal" style={{ width: 160 }} />
              <button className="botao claro pequeno" onClick={() => setRascunho(rascunho.filter((_, j) => j !== k))}>×</button>
            </div>
          ))}
          <div className="l4 flex" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="botao claro pequeno" onClick={() => setRascunho([...rascunho, { tipo: Object.keys(d.tipos).find((t) => t !== 'local' && !usados.has(`${t}:`)) ?? 'local', localId: null, valor: '' }])}>+ Meta</button>
            {anterior.data?.linhas.length ? <button className="botao claro pequeno" onClick={() => setRascunho(anterior.data!.linhas.map((l) => ({ tipo: l.tipo, localId: l.localId, valor: l.dinheiro ? centavosParaTexto(l.meta) : String(l.meta) })))}>Copiar do mês anterior</button> : null}
          </div>
          {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
          <div className="l4 flex" style={{ gap: 8 }}>
            <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar metas</button>
            <button className="botao claro" onClick={() => setEditando(false)}>Cancelar</button>
          </div>
        </div>
      ) : !d.linhas.length ? (
        <div className="cartao vazio">Nenhuma meta para {nomeMes(comp)}. Defina o faturamento, a meta da rede, de cada loja e de novas revendedoras: o sistema mostra o ritmo todo dia.</div>
      ) : (
        <div className="ind-grade k2">{d.linhas.map((l, i) => <div key={l.id} className="cartao"><BarraMeta l={l} i={i} /></div>)}</div>
      )}

      <div className="ind-grade k2">
        <Cartao i={6} titulo="Consultoras com meta" sub={d.consultoras.total ? `${d.consultoras.bateram} de ${d.consultoras.total} bateram` : 'meta no cadastro ou no nível'}>
          {!d.consultoras.total ? <p className="muted">Nenhuma consultora com meta. A meta vem do cadastro dela ou, se vazio, do nível (Configurações › Níveis).</p> : (
            <Tabela nome={`metas-consultoras-${comp}`} linhas={d.consultoras.lista} limite={50} colunas={[['nome', 'Consultora'], ['nivel', 'Nível'], ['meta', 'Meta', 'dinheiro'], ['vendido', 'Vendido', 'dinheiro'], ['atingidoPb', 'Atingido', 'pct']]} celula={(l, k) => (k === 'nome' ? <Link to={`/rede/${l.id}`}>{l.nome}</Link> : k === 'atingidoPb' ? <b style={{ color: l.atingidoPb >= 10000 ? 'var(--ok)' : undefined }}>{pct(l.atingidoPb)}</b> : undefined)} />
          )}
        </Cartao>
        <Cartao i={7} titulo="Vendedoras das lojas" sub="meta no cadastro do usuário">
          {!d.vendedoras.length ? <p className="muted">Nenhuma vendedora com meta. Defina em Configurações › Usuários.</p> : (
            <Tabela nome={`metas-vendedoras-${comp}`} linhas={d.vendedoras} colunas={[['nome', 'Vendedora'], ['meta', 'Meta', 'dinheiro'], ['vendido', 'Vendido', 'dinheiro'], ['projecao', 'Projeção', 'dinheiro'], ['atingidoPb', 'Atingido', 'pct']]} />
          )}
        </Cartao>
      </div>
    </div>
  );
}
