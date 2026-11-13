import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { dataHora, documento, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Topo } from '../componentes/ui';
import { FORMAS, PontoDeVenda } from '../componentes/PontoDeVenda';
import { BotaoNfce } from './Lojas';

const TIPO: Record<string, string> = { balcao: 'Loja / evento', avulsa: 'Avulsa (matriz)', revenda: 'Revenda' };
const nomeForma = (f: string) => FORMAS.find((x) => x[0] === f)?.[1] ?? f;

export function Vendas() {
  const [aba, setAba] = useState<'concluidas' | 'canceladas'>('concluidas');
  const [tipo, setTipo] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const navegar = useNavigate();
  const q = useQuery({ queryKey: ['vendas', aba, tipo, de, ate], queryFn: () => api<{ itens: any[]; total: number }>(`/vendas?${new URLSearchParams({ aba, ...(tipo && { tipo }), ...(de && { de }), ...(ate && { ate }) })}`) });
  return (
    <>
      <Topo eb="Vendas" titulo="Vendas" sub={q.data && `${q.data.itens.length} vendas · ${reais(q.data.total)}`} acoes={pode('vendas', 'criar') && <><Link className="botao claro" to="/vendas/nova?tipo=revenda">Venda de revenda</Link><Link className="botao" to="/vendas/nova?tipo=avulsa">Venda avulsa</Link></>} />
      <Abas ativa={aba} mudar={setAba} abas={[['concluidas', 'Concluídas'], ['canceladas', 'Canceladas']]} />
      <div className="busca">
        <select value={tipo} onChange={(e) => setTipo(e.target.value)}><option value="">Todos os tipos</option>{Object.entries(TIPO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input type="date" value={de} onChange={(e) => setDe(e.target.value)} style={{ maxWidth: 170 }} />
        <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} style={{ maxWidth: 170 }} />
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.itens.length === 0 ? <div className="cartao vazio">Nenhuma venda.</div> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Data</th><th>Tipo</th><th>Local</th><th>Cliente</th><th>Vendedor</th><th className="num">Desconto</th><th className="num">Total</th></tr></thead>
          <tbody>{q.data!.itens.map((v) => <tr key={v.id} className="clicavel" onClick={() => navegar(`/vendas/${v.id}`)}><td><b>{v.numero}</b></td><td>{dataHora(v.criadoEm)}</td><td>{TIPO[v.tipo]}</td><td>{v.local}</td><td>{v.cliente ?? '—'}</td><td>{v.vendedor ?? '—'}</td><td className="num">{v.desconto ? reais(v.desconto) : '—'}</td><td className="num">{reais(v.total)}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

export function NovaVenda() {
  const [params] = useSearchParams();
  const tipo = (params.get('tipo') === 'revenda' ? 'revenda' : 'avulsa') as 'avulsa' | 'revenda';
  const navegar = useNavigate();
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const [localId, setLocalId] = useState('');
  const id = localId || locais.data?.find((l) => l.tipo === 'deposito')?.id || '';
  return (
    <>
      <Topo eb="Vendas" titulo={tipo === 'revenda' ? 'Venda de revenda' : 'Venda avulsa'} sub={tipo === 'revenda' ? 'Compra da representante no modelo revenda, pelo preço de atacado, sem pedido mínimo.' : 'Venda direta da matriz para uma cliente.'} acoes={<select value={id} onChange={(e) => setLocalId(e.target.value)}>{locais.data?.map((l) => <option key={l.id} value={l.id}>Sai de: {l.nome}</option>)}</select>} />
      {id && <PontoDeVenda localId={id} tipo={tipo} aoConcluir={(v) => navegar(`/vendas/${v.id}`)} />}
    </>
  );
}

export function DetalheVenda() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['venda', id], queryFn: () => api<any>(`/vendas/${id}`) });
  const notas = useQuery({ queryKey: ['notas-venda', id], queryFn: () => api<any[]>(`/fiscal/notas?origemId=${id}`), enabled: pode('fiscal', 'ver') });
  const [dev, setDev] = useState<Record<string, number>>({});
  const [destino, setDestino] = useState<'credito' | 'dinheiro'>('credito');
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['venda', id] }); qc.invalidateQueries({ queryKey: ['vendas'] }); };
  const cancelar = useMutation({ mutationFn: (motivo: string) => api(`/vendas/${id}/cancelar`, { corpo: { motivo } }), onSuccess: atualizar });
  const devolver = useMutation({ mutationFn: () => api<any>(`/vendas/${id}/devolver`, { corpo: { destino, itens: Object.entries(dev).filter(([, q]) => q > 0).map(([produtoId, quantidade]) => ({ produtoId, quantidade })) } }), onSuccess: () => { setDev({}); atualizar(); } });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const v = q.data;
  const ativa = v.status === 'concluida';
  const nfce = notas.data?.find((n) => n.status === 'autorizada');
  return (
    <>
      <Topo
        eb={`Vendas · ${TIPO[v.tipo]}`}
        titulo={`Venda nº ${v.numero}`}
        sub={<>{dataHora(v.criadoEm)} · {v.local}{v.cliente ? ` · ${v.cliente}` : ''}{v.clienteDocumento ? ` (${documento(v.clienteDocumento)})` : ''} &nbsp; {ativa ? <span className="etiqueta ok">Concluída</span> : <span className="etiqueta neutra">Cancelada · {v.motivoCancelamento}</span>}</>}
        acoes={<>
          <a className="botao claro" href={`/imprimir/venda/${id}`} target="_blank" rel="noreferrer">Recibo</a>
          {ativa && !nfce && <BotaoNfce vendaId={id!} />}
          {nfce && <a className="botao claro" href={nfce.urlDanfe} target="_blank" rel="noreferrer">Nota nº {nfce.numero}</a>}
        </>}
      />
      {devolver.isSuccess && <div className="aviso ok" style={{ marginBottom: 12 }}>Devolução registrada: {reais((devolver.data as any).valor)} {(devolver.data as any).destino === 'credito' ? 'em crédito para a cliente' : 'devolvidos em dinheiro'}.</div>}
      {(cancelar.error || devolver.error) && <div style={{ marginBottom: 12 }}><Erro erro={cancelar.error ?? devolver.error} /></div>}
      <div className="grade" style={{ gridTemplateColumns: '1fr 340px', alignItems: 'start' }}>
        <table className="tabela">
          <thead><tr><th>Ref.</th><th>Descrição</th><th className="num">Qtd.</th><th className="num">Preço</th><th className="num">Desconto</th><th className="num">Total</th><th className="num">Devolvida</th>{ativa && <th className="num">Devolver</th>}</tr></thead>
          <tbody>
            {v.itens.map((i: any) => (
              <tr key={i.id}>
                <td>{i.referencia}</td><td>{i.descricao}</td><td className="num">{i.quantidade}</td><td className="num">{reais(i.preco)}</td><td className="num">{i.desconto ? reais(i.desconto) : '—'}</td><td className="num">{reais(i.total)}</td><td className="num">{i.devolvida || '—'}</td>
                {ativa && <td className="num"><input type="number" min={0} max={i.quantidade - i.devolvida} value={dev[i.produtoId] ?? 0} onChange={(e) => setDev({ ...dev, [i.produtoId]: Math.max(0, Math.min(i.quantidade - i.devolvida, Number(e.target.value) || 0)) })} disabled={i.quantidade === i.devolvida} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="coluna">
          <div className="cartao">
            <div className="resumo-linha"><span>Subtotal</span><span>{reais(v.subtotal)}</span></div>
            {v.desconto > 0 && <div className="resumo-linha"><span>Desconto</span><span className="menos">− {reais(v.desconto)}</span></div>}
            <div className="resumo-linha total"><span>Total</span><span>{reais(v.total)}</span></div>
            {v.pagamentos.map((p: any) => <div key={p.id} className="resumo-linha"><span className="muted">{nomeForma(p.forma)}{p.parcelas > 1 ? ` ${p.parcelas}x` : ''}{p.maquininha ? ` · ${p.maquininha}` : ''}</span><span>{reais(p.valor)}</span></div>)}
            {v.troco > 0 && <div className="resumo-linha"><span className="muted">Troco</span><span>{reais(v.troco)}</span></div>}
          </div>
          {ativa && pode(v.tipo === 'balcao' ? 'lojas' : 'vendas', 'editar') && Object.values(dev).some((x) => x > 0) && (
            <div className="cartao coluna">
              <h3>Devolução ou troca</h3>
              <Campo rotulo="Como devolver o valor"><select value={destino} onChange={(e) => setDestino(e.target.value as 'credito')}><option value="credito">Crédito para a cliente usar depois</option><option value="dinheiro">Dinheiro, pelo caixa aberto</option></select></Campo>
              <button className="botao" onClick={() => devolver.mutate()} disabled={devolver.isPending}>Registrar devolução</button>
            </div>
          )}
          {ativa && pode(v.tipo === 'balcao' ? 'lojas' : 'vendas', 'excluir') && <button className="botao perigo" onClick={() => { const m = window.prompt('Motivo do cancelamento:'); if (m && m.trim().length >= 3) cancelar.mutate(m.trim()); }}>Cancelar venda</button>}
        </div>
      </div>
    </>
  );
}
