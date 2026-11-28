import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { data, dataHora, reais } from '../formato';
import { Abas, Carregando, ETAPAS_MALETA, Erro, StatusMaleta, Topo, EtapaMaleta } from '../componentes/ui';
import { AutorizacoesDaMaleta } from './DetalheMaleta';

type Aba = 'abertas' | 'vencendo' | 'atrasadas' | 'acertadas' | 'canceladas' | 'pedidos';

const hojeBr = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somar = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** De-até de cada período rápido. */
function periodoDe(p: string, de: string, ate: string): [string, string] | null {
  const h = hojeBr();
  const [a, m] = h.split('-').map(Number);
  const ini = (ano: number, mes: number) => new Date(Date.UTC(ano, mes - 1, 1)).toISOString().slice(0, 10);
  const fim = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
  switch (p) {
    case 'hoje': return [h, h];
    case 'ontem': return [somar(h, -1), somar(h, -1)];
    case '7': return [somar(h, -6), h];
    case '30': return [somar(h, -29), h];
    case 'mes': return [ini(a, m), fim(a, m)];
    case 'mesPassado': return m === 1 ? [ini(a - 1, 12), fim(a - 1, 12)] : [ini(a, m - 1), fim(a, m - 1)];
    case 'ano': return [`${a}-01-01`, `${a}-12-31`];
    case 'personalizado': return de || ate ? [de, ate] : null;
    default: return null;
  }
}

const sem = (t: unknown) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function Maletas() {
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) ?? 'abertas';
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const [periodo, setPeriodo] = useState('');
  const [campoData, setCampoData] = useState('retirada');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [col, setCol] = useState<Record<string, string>>({});
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const navegar = useNavigate();
  const faixa = periodoDe(periodo, de, ate);
  const qs = new URLSearchParams({ aba, ...(buscaAtiva && { busca: buscaAtiva }), ...(faixa && { campoData, ...(faixa[0] && { de: faixa[0] }), ...(faixa[1] && { ate: faixa[1] }) }) });
  const q = useQuery({ queryKey: ['maletas', aba, buscaAtiva, faixa?.[0], faixa?.[1], campoData], queryFn: () => api<any[]>(`/maletas?${qs}`), enabled: aba !== 'pedidos' });
  // Busca no cabeçalho: filtra a lista por coluna, sem acento.
  const linhas = useMemo(() => (q.data ?? []).filter((m) => {
    const tem = (k: string, v: unknown) => !col[k]?.trim() || sem(v).includes(sem(col[k].trim()));
    return tem('numero', m.numero) && tem('representante', m.representante) && tem('cidade', m.cidade)
      && (!col.entrega || m.entrega === col.entrega) && (!col.etapa || m.etapa === col.etapa) && (!col.prebaixa || (col.prebaixa === 'pago' ? !!m.prebaixaPagaEm : (col.prebaixa === 'sim') === !!m.prebaixa))
      && (!col.situacao || (col.situacao === 'atrasado' ? m.diasAtraso > 0 : col.situacao === 'em_dia' ? m.status === 'aberta' && !m.diasAtraso : true));
  }), [q.data, col]);
  const total = linhas.reduce((a, m) => a + (m.status === 'aberta' ? m.valor : m.valorEnviado), 0);
  const filtrando = Object.values(col).some((v) => v?.trim());
  const campoTxt = campoData === 'acerto' ? 'acerto até' : campoData === 'baixa' ? 'baixa' : 'retirada';
  return (
    <>
      <Topo eb="Pedidos" titulo="Consignado" sub={q.data && `${linhas.length} pedido${linhas.length === 1 ? '' : 's'}${filtrando ? ` (de ${q.data.length})` : ''} · ${reais(total)} em peças`} acoes={pode('maletas', 'criar') && <Link className="botao" to="/maletas/nova">Novo pedido</Link>} />
      <AutorizacoesDaMaleta />
      <Abas ativa={aba} mudar={(a) => setParams({ aba: a })} abas={[['abertas', 'Abertos'], ['acertadas', 'Baixados'], ['canceladas', 'Cancelados'], ['pedidos', 'Solicitações das representantes']]} />
      {aba === 'pedidos' ? <PedidosRepresentantes /> : <>
      <form className="busca" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); setBuscaAtiva(busca); }}>
        <input placeholder="Nº do pedido ou nome da representante" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={campoData} onChange={(e) => setCampoData(e.target.value)} aria-label="Data usada no período">
          <option value="retirada">Data de retirada</option>
          <option value="acerto">Data do acerto</option>
          <option value="baixa">Data da baixa</option>
        </select>
        <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} aria-label="Período">
          <option value="">Qualquer data</option>
          <option value="hoje">Hoje</option>
          <option value="ontem">Ontem</option>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="mes">Este mês</option>
          <option value="mesPassado">Mês passado</option>
          <option value="ano">Este ano</option>
          <option value="personalizado">Personalizado…</option>
        </select>
        {periodo === 'personalizado' && <>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} aria-label="De" style={{ maxWidth: 160 }} />
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} aria-label="Até" style={{ maxWidth: 160 }} />
        </>}
        <button className="botao claro">Buscar</button>
        <button type="button" className="botao claro" onClick={() => setFiltrosAbertos(!filtrosAbertos)}>{filtrosAbertos ? 'Esconder filtros' : 'Filtrar colunas'}</button>
        {(filtrando || periodo || buscaAtiva) && <button type="button" className="botao claro" onClick={() => { setCol({}); setPeriodo(''); setDe(''); setAte(''); setBusca(''); setBuscaAtiva(''); }}>Limpar</button>}
      </form>
      {faixa && <div className="muted" style={{ fontSize: 13 }}>Período pela {campoTxt}: {faixa[0] ? data(faixa[0]) : 'início'} a {faixa[1] ? data(faixa[1]) : 'hoje'}</div>}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead>
            <tr><th>Nº</th><th>Representante</th><th>Cidade</th><th className="num">Peças</th><th className="num">Valor</th><th>Retirada</th><th>Acerto até</th><th>Entrega</th><th>Onde está</th><th>Pré-baixa</th><th>Situação</th></tr>
            {filtrosAbertos && (
              <tr className="filtros-cabecalho">
                <th><input value={col.numero ?? ''} onChange={(e) => setCol({ ...col, numero: e.target.value })} placeholder="Nº" style={{ width: 70 }} /></th>
                <th><input value={col.representante ?? ''} onChange={(e) => setCol({ ...col, representante: e.target.value })} placeholder="Nome" /></th>
                <th><input value={col.cidade ?? ''} onChange={(e) => setCol({ ...col, cidade: e.target.value })} placeholder="Cidade" style={{ width: 110 }} /></th>
                <th /><th /><th /><th />
                <th><select value={col.entrega ?? ''} onChange={(e) => setCol({ ...col, entrega: e.target.value })}><option value="">Todas</option><option value="retirada">Retirada</option><option value="envio">Envio</option></select></th>
                <th><select value={col.etapa ?? ''} onChange={(e) => setCol({ ...col, etapa: e.target.value })}><option value="">Todas</option>{ETAPAS_MALETA.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></th>
                <th><select value={col.prebaixa ?? ''} onChange={(e) => setCol({ ...col, prebaixa: e.target.value })}><option value="">Todas</option><option value="sim">Informada</option><option value="pago">Boleto pago</option><option value="nao">Sem</option></select></th>
                <th>{aba === 'abertas' && <select value={col.situacao ?? ''} onChange={(e) => setCol({ ...col, situacao: e.target.value })}><option value="">Todas</option><option value="em_dia">Em dia</option><option value="atrasado">Atrasados</option></select>}</th>
              </tr>
            )}
          </thead>
          <tbody>
            {!linhas.length && <tr><td colSpan={11} className="vazio">Nenhum pedido{faixa || filtrando || buscaAtiva ? ' com esses filtros' : ' nesta aba'}.</td></tr>}
            {linhas.map((m) => (
              <tr key={m.id} className="clicavel" onClick={() => navegar(`/maletas/${m.id}`)}>
                <td><b>{m.numero}</b></td>
                <td>{m.representante}</td>
                <td>{m.cidade ?? '—'}</td>
                <td className="num">{m.status === 'aberta' ? m.pecas : '—'}</td>
                <td className="num">{reais(m.status === 'aberta' ? m.valor : m.valorEnviado)}</td>
                <td>{data(m.dataRetirada)}</td>
                <td>{data(m.dataLimite)}{m.acertadaEm && <div className="muted" style={{ fontSize: 12 }}>baixado {data(String(m.acertadaEm).slice(0, 10))}</div>}</td>
                <td>{m.entrega === 'envio' ? 'Envio' : 'Retirada'}</td>
                <td>{m.status === 'aberta' ? <EtapaMaleta etapa={m.etapa} /> : <span className="muted">—</span>}</td>
                <td>{m.prebaixaPagaEm ? <span className="etiqueta ok">Boleto pago</span> : m.prebaixaBoleto ? <span className="etiqueta alerta">Boleto enviado</span> : m.prebaixa ? <span className="etiqueta alerta">Informada</span> : <span className="muted">—</span>}</td>
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
