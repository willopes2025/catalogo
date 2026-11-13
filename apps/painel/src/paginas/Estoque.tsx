import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { dataHora, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';
import { Leitor, type ItemLido } from '../componentes/Leitor';
import { Inventario, Etiquetas, Lotes } from './EstoqueExtra';

interface Local { id: string; nome: string; tipo: string; empresa: string }

const TIPO_MOV: Record<string, string> = { entrada: 'Entrada', ajuste: 'Ajuste', transferencia: 'Transferência', maleta_envio: 'Foi para maleta', maleta_devolucao: 'Voltou da maleta', venda: 'Vendida', perda: 'Perdida', garantia: 'Garantia', devolucao: 'Devolução' };

export function Estoque() {
  const [params] = useSearchParams();
  const [aba, setAba] = useState<'saldos' | 'entrada' | 'transferencia' | 'inventario' | 'etiquetas' | 'lotes' | 'rastreio'>(params.get('rastreio') ? 'rastreio' : 'saldos');
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<Local[]>('/estoque/locais') });
  return (
    <>
      <Topo eb="Estoque" titulo="Cada peça com endereço" sub="Depósito, loja, eventos e maletas das representantes" />
      <Abas ativa={aba} mudar={setAba} abas={[['saldos', 'Saldos'], ['entrada', 'Entrada'], ['transferencia', 'Transferência'], ['inventario', 'Inventário e ajuste'], ['etiquetas', 'Etiquetas'], ['lotes', 'Lotes de banho'], ['rastreio', 'Rastreio da peça']]} />
      {aba === 'saldos' && <Saldos locais={locais.data ?? []} />}
      {aba === 'entrada' && <Movimentar tipo="entrada" locais={locais.data ?? []} />}
      {aba === 'transferencia' && <Movimentar tipo="transferencia" locais={locais.data ?? []} />}
      {aba === 'inventario' && <Inventario locais={locais.data ?? []} />}
      {aba === 'etiquetas' && <Etiquetas locais={locais.data ?? []} />}
      {aba === 'lotes' && <Lotes />}
      {aba === 'rastreio' && <Rastreio inicial={params.get('rastreio') ?? ''} />}
    </>
  );
}

function Saldos({ locais }: { locais: Local[] }) {
  const [localId, setLocalId] = useState('');
  const [busca, setBusca] = useState('');
  const [critico, setCritico] = useState(false);
  const resumo = useQuery({ queryKey: ['estoque-resumo'], queryFn: () => api<{ locais: any[]; emMaletas: any }>('/estoque/resumo') });
  const q = useQuery({
    queryKey: ['saldos', localId, busca, critico],
    queryFn: () => api<any[]>(`/estoque/saldos?${new URLSearchParams({ ...(localId && { localId }), ...(busca && { busca }), ...(critico && { critico: '1' }) })}`),
  });
  return (
    <>
      {resumo.data && (
        <div className="grade g4" style={{ marginBottom: 16 }}>
          {resumo.data.locais.map((l) => <Indicador key={l.localId} rotulo={l.nome} valor={`${l.pecas} peças`} detalhe={`${reais(l.valorVenda)} em venda · ${reais(l.valorCusto)} a custo`} />)}
          <Indicador tipo="destaque" rotulo="Em maletas na rua" valor={`${resumo.data.emMaletas.pecas} peças`} detalhe={`${reais(resumo.data.emMaletas.valorVenda)} em venda`} />
        </div>
      )}
      <div className="busca">
        <select value={localId} onChange={(e) => setLocalId(e.target.value)}><option value="">Todos os locais (sem maletas)</option>{locais.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>
        <input placeholder="Buscar produto" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <label className="check"><input type="checkbox" checked={critico} onChange={(e) => setCritico(e.target.checked)} /> Só estoque crítico</label>
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th>Código</th><th>Ref.</th><th>Descrição</th><th>Categoria</th><th className="num">Mínimo</th><th className="num">Quantidade</th><th className="num">Em maletas</th><th className="num">Valor (venda)</th></tr></thead>
          <tbody>
            {q.data!.map((s) => (
              <tr key={s.id}>
                <td className="muted"><Link to={`/estoque?rastreio=${s.codigoBarras}`} onClick={() => window.scrollTo(0, 0)}>{s.codigoBarras}</Link></td>
                <td>{s.referencia}</td>
                <td>{s.descricao}</td>
                <td>{s.categoria ?? '—'}</td>
                <td className="num">{s.estoqueMinimo}</td>
                <td className="num">{s.quantidade <= s.estoqueMinimo ? <span className="etiqueta erro">{s.quantidade}</span> : s.quantidade}</td>
                <td className="num">{s.emMaletas}</td>
                <td className="num">{reais(s.quantidade * s.preco)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Movimentar({ tipo, locais }: { tipo: 'entrada' | 'transferencia'; locais: Local[] }) {
  const qc = useQueryClient();
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [destinoId, setDestinoId] = useState('');
  const [origemId, setOrigemId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [chaveNota, setChaveNota] = useState('');
  const m = useMutation({
    mutationFn: () =>
      tipo === 'entrada'
        ? api('/estoque/entradas', { corpo: { destinoId, motivo: motivo || undefined, chaveNota: chaveNota || undefined, itens: itens.map((i) => ({ codigoBarras: i.codigoBarras, quantidade: i.quantidade })) } })
        : api('/estoque/transferencias', { corpo: { origemId, destinoId, motivo: motivo || undefined, itens: itens.map((i) => ({ codigoBarras: i.codigoBarras, quantidade: i.quantidade })) } }),
    onSuccess: () => { setItens([]); setMotivo(''); setChaveNota(''); qc.invalidateQueries(); },
  });
  if (!pode('estoque', 'criar')) return <div className="aviso alerta">Você não tem permissão para movimentar o estoque.</div>;
  return (
    <div className="coluna">
      <div className="cartao form">
        {tipo === 'transferencia' && <Campo rotulo="De"><select value={origemId} onChange={(e) => setOrigemId(e.target.value)}><option value="">Escolha</option>{locais.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>}
        <Campo rotulo={tipo === 'entrada' ? 'Local que recebe' : 'Para'}><select value={destinoId} onChange={(e) => setDestinoId(e.target.value)}><option value="">Escolha</option>{locais.filter((l) => l.id !== origemId).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
        {tipo === 'entrada' && <Campo rotulo="Chave da nota do fornecedor"><input value={chaveNota} onChange={(e) => setChaveNota(e.target.value)} /></Campo>}
        <Campo rotulo="Observação" className={tipo === 'entrada' ? '' : 'l2'}><input value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
      </div>
      <div className="cartao"><Leitor itens={itens} mudar={setItens} /></div>
      {m.error && <Erro erro={m.error} />}
      {m.isSuccess && <div className="aviso ok">{tipo === 'entrada' ? 'Entrada registrada.' : 'Transferência registrada.'}</div>}
      <div><button className="botao" disabled={!itens.length || !destinoId || (tipo === 'transferencia' && !origemId) || m.isPending} onClick={() => m.mutate()}>{tipo === 'entrada' ? 'Registrar entrada' : 'Transferir'}</button></div>
    </div>
  );
}

function Rastreio({ inicial }: { inicial: string }) {
  const [codigo, setCodigo] = useState(inicial);
  const [busca, setBusca] = useState(inicial);
  const q = useQuery({ queryKey: ['rastreio', busca], queryFn: () => api<any>(`/estoque/rastreio/${encodeURIComponent(busca)}`), enabled: !!busca });
  return (
    <div className="coluna">
      <form className="leitor" onSubmit={(e) => { e.preventDefault(); setBusca(codigo.trim()); }}>
        <input autoFocus placeholder="Bipe ou digite o código da peça" value={codigo} onChange={(e) => setCodigo(e.target.value)} />
        <button className="botao">Rastrear</button>
      </form>
      {q.isLoading && busca && <Carregando />}
      {q.error && <Erro erro={q.error} />}
      {q.data && (
        <>
          <div className="cartao">
            <h2>{q.data.produto.descricao}</h2>
            <p className="muted">{q.data.produto.codigoBarras} · ref. {q.data.produto.referencia} · {reais(q.data.produto.preco)}</p>
            <div className="flex" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              {q.data.porLocal.map((l: any, i: number) => <span key={i} className={`etiqueta ${l.tipo === 'maleta' ? 'marrom' : 'neutra'}`}>{l.tipo === 'maleta' ? `Maleta nº ${l.maletaNumero} · ${l.representante}` : l.local}: {l.quantidade}</span>)}
            </div>
          </div>
          <table className="tabela">
            <thead><tr><th>Quando</th><th>O que aconteceu</th><th className="num">Qtd.</th><th>De</th><th>Para</th><th>Motivo</th><th>Quem</th></tr></thead>
            <tbody>
              {q.data.historico.map((h: any) => (
                <tr key={h.id}>
                  <td>{dataHora(h.criadoEm)}</td>
                  <td>{TIPO_MOV[h.tipo] ?? h.tipo}{h.referenciaTipo === 'maleta' && <> · <Link to={`/maletas/${h.referenciaId}`}>ver maleta</Link></>}</td>
                  <td className="num">{h.quantidade}</td>
                  <td>{h.origem ?? '—'}</td>
                  <td>{h.destino ?? (h.tipo === 'venda' ? 'Cliente' : '—')}</td>
                  <td className="muted">{h.motivo}</td>
                  <td>{h.usuario ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
