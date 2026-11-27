import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { data, dataHora, reais } from '../formato';
import { Abas, Carregando, Erro, StatusMaleta, Topo, EtapaMaleta } from '../componentes/ui';
import { AutorizacoesDaMaleta } from './DetalheMaleta';

type Aba = 'abertas' | 'vencendo' | 'atrasadas' | 'acertadas' | 'canceladas' | 'pedidos';

export function Maletas() {
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) ?? 'abertas';
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const navegar = useNavigate();
  const q = useQuery({ queryKey: ['maletas', aba, buscaAtiva], queryFn: () => api<any[]>(`/maletas?aba=${aba}${buscaAtiva ? `&busca=${encodeURIComponent(buscaAtiva)}` : ''}`), enabled: aba !== 'pedidos' });
  const total = q.data?.reduce((a, m) => a + m.valor, 0) ?? 0;
  return (
    <>
      <Topo eb="Maletas" titulo="Consignado" sub={q.data && `${q.data.length} maletas · ${reais(total)} em peças`} acoes={pode('maletas', 'criar') && <Link className="botao" to="/maletas/nova">Nova maleta</Link>} />
      <AutorizacoesDaMaleta />
      <Abas ativa={aba} mudar={(a) => setParams({ aba: a })} abas={[['abertas', 'Abertas'], ['acertadas', 'Baixadas'], ['canceladas', 'Canceladas'], ['pedidos', 'Pedidos das representantes']]} />
      {aba === 'pedidos' ? <PedidosRepresentantes /> : <>
      <form className="busca" onSubmit={(e) => { e.preventDefault(); setBuscaAtiva(busca); }}>
        <input placeholder="Nº da maleta ou nome da representante" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <button className="botao claro">Buscar</button>
      </form>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.length === 0 ? <div className="cartao vazio">Nenhuma maleta nesta aba.</div> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Representante</th><th>Cidade</th><th className="num">Peças</th><th className="num">Valor</th><th>Retirada</th><th>Acerto até</th><th>Entrega</th><th>Onde está</th><th>Pré-baixa</th><th>Situação</th></tr></thead>
          <tbody>
            {q.data!.map((m) => (
              <tr key={m.id} className="clicavel" onClick={() => navegar(`/maletas/${m.id}`)}>
                <td><b>{m.numero}</b></td>
                <td>{m.representante}</td>
                <td>{m.cidade ?? '—'}</td>
                <td className="num">{m.status === 'aberta' ? m.pecas : '—'}</td>
                <td className="num">{reais(m.status === 'aberta' ? m.valor : m.valorEnviado)}</td>
                <td>{data(m.dataRetirada)}</td>
                <td>{data(m.dataLimite)}</td>
                <td>{m.entrega === 'envio' ? 'Envio' : 'Retirada'}</td>
                <td>{m.status === 'aberta' ? <EtapaMaleta etapa={m.etapa} /> : <span className="muted">—</span>}</td>
                <td>{m.prebaixa ? <span className="etiqueta alerta">Informada</span> : <span className="muted">—</span>}</td>
                <td><StatusMaleta status={m.status} diasAtraso={m.diasAtraso} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </>}
    </>
  );
}

/** Peças que as representantes pediram pelo portal. */
function PedidosRepresentantes() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('novo');
  const q = useQuery({ queryKey: ['pedidos-pecas', status], queryFn: () => api<any[]>(`/portal/admin/pedidos?status=${status}`) });
  const responder = useMutation({
    mutationFn: (d: { id: string; status: 'atendido' | 'recusado'; resposta: string | null }) => api(`/portal/admin/pedidos/${d.id}`, { corpo: { status: d.status, resposta: d.resposta } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pedidos-pecas'] }),
  });
  const atenderVenda = useMutation({
    mutationFn: (d: { id: string; resposta: string | null }) => api<{ como: string }>(`/consultoras/pedidos-venda/${d.id}/atender`, { corpo: { resposta: d.resposta } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pedidos-pecas'] }),
  });
  return (
    <div className="coluna">
      <div className="busca">
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="novo">Aguardando</option><option value="atendido">Atendidos</option><option value="recusado">Recusados</option><option value="todos">Todos</option></select>
        <span className="muted" style={{ alignSelf: 'center' }}>A representante pede pelo portal; a resposta aparece para ela no celular.</span>
      </div>
      {(responder.error || atenderVenda.error) && <Erro erro={responder.error ?? atenderVenda.error} />}
      {atenderVenda.data && <div className="aviso ok">Atendido: {atenderVenda.data.como}.</div>}
      {q.isLoading ? <Carregando /> : !q.data?.length ? <div className="cartao vazio">Nenhum pedido.</div> : q.data.map((p) => (
        <div key={p.id} className="cartao coluna" style={{ gap: 8 }}>
          <div className="flex entre"><b>Pedido nº {p.numero} · <Link to={`/rede/${p.pessoaId}`}>{p.representante}</Link>{p.tipo === 'venda' && <> <span className="etiqueta alerta">Venda do catálogo</span></>}</b><span className="muted">{dataHora(p.criadoEm)}</span></div>
          {p.tipo === 'venda' && <div className="aviso" style={{ margin: 0 }}>{p.entrega === 'frete' ? <>Enviar para a cliente (frete por conta dela): <b>{p.enderecoEntrega}</b></> : 'A consultora retira na Aritana.'} Ao atender, as peças entram na maleta aberta dela já como vendidas (cobradas no acerto).</div>}
          <table className="tabela"><tbody>{p.itens.map((i: any) => <tr key={i.produtoId}><td>{i.referencia}</td><td>{i.descricao}</td><td className="num">{i.quantidade}</td></tr>)}</tbody></table>
          {p.observacao && <div className="muted">Obs.: {p.observacao}</div>}
          {p.resposta && <div className="muted">Resposta: {p.resposta}</div>}
          {p.status === 'novo' && pode('maletas', 'editar') && (
            <div className="flex" style={{ flexWrap: 'wrap' }}>
              {p.tipo === 'venda' ? <button className="botao" disabled={atenderVenda.isPending} onClick={() => { const r = window.prompt('Mensagem para a consultora (opcional):', p.entrega === 'frete' ? 'Enviamos para a sua cliente.' : 'Separado para você retirar.'); if (r !== null) atenderVenda.mutate({ id: p.id, resposta: r || null }); }}>Atender (lançar na maleta)</button> : <Link className="botao" to={`/maletas/nova?representante=${p.pessoaId}`}>Montar maleta</Link>}
              <button className="botao claro" onClick={() => { const r = window.prompt('Mensagem para a representante (opcional):', 'Separamos para a sua próxima maleta.'); if (r !== null) responder.mutate({ id: p.id, status: 'atendido', resposta: r || null }); }}>Marcar atendido</button>
              <button className="botao claro" onClick={() => { const r = window.prompt('Motivo (aparece para a representante):'); if (r) responder.mutate({ id: p.id, status: 'recusado', resposta: r }); }}>Recusar</button>
              {p.telefone && <a className="botao claro" href={`https://wa.me/55${p.telefone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
