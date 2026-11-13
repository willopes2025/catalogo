import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { data, reais } from '../formato';
import { Campo, Carregando, Erro } from '../componentes/ui';
import { Leitor, type ItemLido } from '../componentes/Leitor';

interface Local { id: string; nome: string; tipo: string }

// ───────────── Inventário e ajuste ─────────────

/**
 * Contagem parcial: só as peças bipadas são ajustadas.
 * Inventário completo: o que não foi bipado e o sistema diz que existe no local vira zero.
 */
export function Inventario({ locais }: { locais: Local[] }) {
  const qc = useQueryClient();
  const [localId, setLocalId] = useState('');
  const [modo, setModo] = useState<'parcial' | 'completo'>('parcial');
  const [motivo, setMotivo] = useState('');
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [conferindo, setConferindo] = useState(false);
  const sistema = useQuery({ queryKey: ['inventario', localId], queryFn: () => api<{ codigoBarras: string; referencia: string; descricao: string; preco: number; quantidade: number }[]>(`/estoque/inventario/${localId}`), enabled: !!localId });
  const resultado = useMutation({
    mutationFn: (corpo: any) => api<{ diferencas: { codigoBarras: string; antes: number; depois: number }[] }>('/estoque/ajustes', { corpo }),
    onSuccess: () => { setItens([]); setConferindo(false); qc.invalidateQueries(); },
  });

  const linhas = useMemo(() => {
    const noSistema = new Map((sistema.data ?? []).map((s) => [s.codigoBarras, s]));
    const contadas = new Map(itens.map((i) => [i.codigoBarras, i]));
    const l = itens.map((i) => ({ codigoBarras: i.codigoBarras, descricao: i.descricao, referencia: i.referencia, preco: i.preco, sistema: noSistema.get(i.codigoBarras)?.quantidade ?? 0, contada: i.quantidade }));
    if (modo === 'completo') for (const s of sistema.data ?? []) if (!contadas.has(s.codigoBarras)) l.push({ codigoBarras: s.codigoBarras, descricao: s.descricao, referencia: s.referencia, preco: s.preco, sistema: s.quantidade, contada: 0 });
    return l;
  }, [itens, sistema.data, modo]);
  const diferentes = linhas.filter((l) => l.sistema !== l.contada);
  const falta = diferentes.reduce((a, l) => a + Math.max(0, l.sistema - l.contada) * l.preco, 0);
  const sobra = diferentes.reduce((a, l) => a + Math.max(0, l.contada - l.sistema) * l.preco, 0);

  if (!pode('estoque', 'editar')) return <div className="aviso alerta">Você não tem permissão para ajustar o estoque.</div>;
  return (
    <div className="coluna">
      <div className="cartao form">
        <Campo rotulo="Local contado"><select value={localId} onChange={(e) => { setLocalId(e.target.value); setItens([]); setConferindo(false); }}><option value="">Escolha</option>{locais.filter((l) => l.tipo !== 'maleta').map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
        <Campo rotulo="Tipo de contagem" ajuda={modo === 'completo' ? 'O que não for bipado será zerado' : 'Só as peças bipadas são ajustadas'}>
          <select value={modo} onChange={(e) => { setModo(e.target.value as typeof modo); setConferindo(false); }}><option value="parcial">Contagem parcial</option><option value="completo">Inventário completo do local</option></select>
        </Campo>
        <Campo rotulo="Motivo" className="l2"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={modo === 'completo' ? 'Ex.: inventário de dezembro' : 'Ex.: peça quebrada, recontagem da vitrine'} /></Campo>
        {localId && sistema.data && <div className="muted" style={{ gridColumn: 'span 4' }}>O sistema registra {sistema.data.reduce((a, s) => a + s.quantidade, 0)} peças em {sistema.data.length} produtos neste local.</div>}
      </div>
      {localId && (
        <div className="cartao">
          <p className="muted" style={{ marginTop: 0 }}>Bipe cada peça que está fisicamente no local. Bipar de novo soma; você também pode digitar a quantidade.</p>
          <Leitor itens={itens} mudar={(i) => { setItens(i); setConferindo(false); }} />
        </div>
      )}
      {resultado.error && <Erro erro={resultado.error} />}
      {resultado.isSuccess && <div className="aviso ok">Ajuste gravado: {resultado.data.diferencas.length} produto(s) corrigido(s). Tudo fica registrado na auditoria e no rastreio de cada peça.</div>}
      {localId && (itens.length > 0 || modo === 'completo') && !conferindo && (
        <div><button className="botao claro" disabled={!sistema.data} onClick={() => setConferindo(true)}>Conferir diferenças</button></div>
      )}
      {conferindo && (
        <>
          <div className="grade g3">
            <div className="cartao"><div className="muted">Produtos com diferença</div><b style={{ fontSize: 22 }}>{diferentes.length}</b></div>
            <div className="cartao"><div className="muted">Faltando (preço de venda)</div><b style={{ fontSize: 22, color: 'var(--erro)' }}>{reais(falta)}</b></div>
            <div className="cartao"><div className="muted">Sobrando (preço de venda)</div><b style={{ fontSize: 22 }}>{reais(sobra)}</b></div>
          </div>
          {diferentes.length ? (
            <table className="tabela">
              <thead><tr><th>Código</th><th>Peça</th><th className="num">No sistema</th><th className="num">Contada</th><th className="num">Diferença</th></tr></thead>
              <tbody>
                {diferentes.map((l) => (
                  <tr key={l.codigoBarras}>
                    <td className="muted">{l.codigoBarras}</td>
                    <td>{l.descricao}<div className="muted">ref. {l.referencia}</div></td>
                    <td className="num">{l.sistema}</td>
                    <td className="num">{l.contada}</td>
                    <td className="num"><span className={`etiqueta ${l.contada < l.sistema ? 'erro' : 'ok'}`}>{l.contada - l.sistema > 0 ? '+' : ''}{l.contada - l.sistema}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="aviso ok">A contagem bate com o sistema. Nada a ajustar.</div>
          )}
          {diferentes.length > 0 && (
            <div>
              <button
                className="botao"
                disabled={motivo.trim().length < 3 || resultado.isPending}
                title={motivo.trim().length < 3 ? 'Informe o motivo' : undefined}
                onClick={() => resultado.mutate({ localId, motivo: motivo.trim(), itens: diferentes.map((l) => ({ codigoBarras: l.codigoBarras, quantidadeContada: l.contada })) })}
              >
                Gravar ajuste de {diferentes.length} produto(s)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ───────────── Etiquetas ─────────────

export const CHAVE_FILA = 'aritana-fila-etiquetas';

export function Etiquetas({ locais }: { locais: Local[] }) {
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [localId, setLocalId] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const total = itens.reduce((a, i) => a + i.quantidade, 0);

  async function puxarDoLocal() {
    if (!localId) return;
    const lista = await api<{ produtoId: string; codigoBarras: string; referencia: string; descricao: string; preco: number; quantidade: number }[]>(`/estoque/inventario/${localId}`);
    const pos = lista.filter((l) => l.quantidade > 0);
    setItens(pos.map((l) => ({ produtoId: l.produtoId, codigoBarras: l.codigoBarras, referencia: l.referencia, descricao: l.descricao, preco: l.preco, custo: 0, quantidade: l.quantidade })));
    setAviso(`${pos.length} produtos carregados com a quantidade em estoque. Ajuste antes de imprimir.`);
  }

  function imprimir() {
    try {
      localStorage.setItem(CHAVE_FILA, JSON.stringify(itens.map((i) => ({ codigoBarras: i.codigoBarras, referencia: i.referencia, descricao: i.descricao, preco: i.preco, quantidade: i.quantidade }))));
      window.open('/imprimir/etiquetas', '_blank');
    } catch {
      setAviso('O navegador bloqueou o armazenamento local; libere para esta página e tente de novo.');
    }
  }

  return (
    <div className="coluna">
      <div className="cartao">
        <p className="muted" style={{ marginTop: 0 }}>Bipe ou digite as peças e a quantidade de etiquetas de cada uma. Tamanho, colunas e o que aparece na etiqueta ficam em Configurações → Avisos e regras.</p>
        <div className="flex" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <select value={localId} onChange={(e) => setLocalId(e.target.value)}><option value="">Puxar tudo de um local…</option>{locais.filter((l) => l.tipo !== 'maleta').map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>
          <button className="botao claro pequeno" disabled={!localId} onClick={() => void puxarDoLocal()}>Carregar</button>
          {itens.length > 0 && <button className="botao claro pequeno" onClick={() => { setItens([]); setAviso(null); }}>Limpar lista</button>}
        </div>
        {aviso && <div className="aviso alerta" style={{ marginBottom: 12 }}>{aviso}</div>}
        <Leitor itens={itens} mudar={setItens} />
      </div>
      <div><button className="botao" disabled={!total} onClick={imprimir}>Imprimir {total} etiqueta{total === 1 ? '' : 's'}</button></div>
    </div>
  );
}

// ───────────── Lotes de banho ─────────────

export function Lotes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lotes'], queryFn: () => api<any[]>('/lotes') });
  const forn = useQuery({ queryKey: ['fornecedores'], queryFn: () => api<any>('/pessoas?tipo=fornecedor').then((r) => r.itens as any[]) });
  const [n, setN] = useState({ codigo: '', fornecedorId: '', fabricacao: '', validade: '', observacao: '' });
  const criar = useMutation({
    mutationFn: () => api('/lotes', { corpo: { codigo: n.codigo, fornecedorId: n.fornecedorId || null, fabricacao: n.fabricacao || null, validade: n.validade || null, observacao: n.observacao || null } }),
    onSuccess: () => { setN({ codigo: '', fornecedorId: '', fabricacao: '', validade: '', observacao: '' }); qc.invalidateQueries({ queryKey: ['lotes'] }); },
  });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      <p className="muted">O lote do banho fica na ficha do produto. Quando uma peça volta com defeito, dá para saber de qual banho ela veio e quantas outras do mesmo lote estão na rua.</p>
      <table className="tabela">
        <thead><tr><th>Lote</th><th>Fornecedor do banho</th><th>Fabricação</th><th>Validade da garantia</th><th>Observação</th></tr></thead>
        <tbody>
          {q.data!.map((l) => <tr key={l.id}><td><b>{l.codigo}</b></td><td>{l.fornecedor ?? '—'}</td><td>{data(l.fabricacao)}</td><td>{data(l.validade)}</td><td className="muted">{l.observacao}</td></tr>)}
          {!q.data!.length && <tr><td colSpan={5} className="vazio">Nenhum lote cadastrado.</td></tr>}
        </tbody>
      </table>
      {criar.error && <Erro erro={criar.error} />}
      {pode('produtos', 'criar') && (
        <div className="cartao form">
          <div className="secao">Novo lote</div>
          <Campo rotulo="Código do lote"><input value={n.codigo} onChange={(e) => setN({ ...n, codigo: e.target.value })} /></Campo>
          <Campo rotulo="Fornecedor"><select value={n.fornecedorId} onChange={(e) => setN({ ...n, fornecedorId: e.target.value })}><option value="">—</option>{forn.data?.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</select></Campo>
          <Campo rotulo="Fabricação"><input type="date" value={n.fabricacao} onChange={(e) => setN({ ...n, fabricacao: e.target.value })} /></Campo>
          <Campo rotulo="Validade da garantia"><input type="date" value={n.validade} onChange={(e) => setN({ ...n, validade: e.target.value })} /></Campo>
          <Campo rotulo="Observação" className="l2"><input value={n.observacao} onChange={(e) => setN({ ...n, observacao: e.target.value })} placeholder="Ex.: ouro 18k, 5 milésimos" /></Campo>
          <div className="campo"><label>&nbsp;</label><button className="botao" disabled={!n.codigo.trim() || criar.isPending} onClick={() => criar.mutate()}>Cadastrar lote</button></div>
        </div>
      )}
    </div>
  );
}
