import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { data, dataHora, documento, pct, reais, telefone } from '../../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo, camposComErro } from '../../componentes/ui';
import './cobranca.css';

export type Eu = { cobradorId: string | null; restrito: boolean; gestor: boolean; cobrador: string | null; protestoLigado: boolean };
export const useEu = () => useQuery({ queryKey: ['cobranca', 'eu'], queryFn: () => api<Eu>('/cobranca/eu'), staleTime: 60_000 });

export const FAIXAS: [string, string][] = [['1_30', '1 a 30 dias'], ['31_60', '31 a 60'], ['61_90', '61 a 90'], ['91_180', '91 a 180'], ['mais_180', 'Mais de 180']];
export const STATUS_PROTESTO: Record<string, [string, string]> = {
  enviado: ['Enviado à CRA', 'neutra'], em_cartorio: ['No cartório', 'alerta'], protestado: ['Protestado', 'erro'], pago: ['Pago no cartório', 'ok'], retirado: ['Retirado', 'neutra'],
  cancelado: ['Cancelado', 'neutra'], sustado: ['Sustado', 'alerta'], devolvido: ['Devolvido', 'alerta'], recusado: ['Recusado pela CRA', 'erro'],
};
export const STATUS_ACORDO: Record<string, [string, string]> = { ativo: ['Em dia', 'ok'], quitado: ['Quitado', 'marrom'], quebrado: ['Quebrado', 'erro'], cancelado: ['Cancelado', 'neutra'] };
const pbParaTexto = (pb: number) => String(pb / 100).replace('.', ',');
const textoParaPb = (t: string) => Math.round(Number((t || '0').replace(',', '.')) * 100);

type AbaCob = 'painel' | 'carteira' | 'acordos' | 'protestos' | 'cobradores' | 'configurar';

export function Cobranca() {
  const eu = useEu();
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as AbaCob) || 'painel';
  const mudar = (a: AbaCob) => setParams(a === 'painel' ? {} : { aba: a }, { replace: true });
  if (eu.isLoading) return <Carregando />;
  if (eu.error) return <Erro erro={eu.error} />;
  const e = eu.data!;
  const abas: [AbaCob, string][] = [['painel', 'Painel'], ['carteira', 'Carteira'], ['acordos', 'Acordos']];
  if (!e.restrito) abas.push(['protestos', 'Protesto']);
  if (e.gestor) abas.push(['cobradores', 'Cobradores e acessos'], ['configurar', 'Configurar']);
  return (
    <>
      <Topo eb="Cobrança" titulo={e.restrito ? `Carteira de ${e.cobrador}` : 'Cobrança'} sub={e.restrito ? 'Só os devedores que a Aritana passou para vocês' : 'Títulos vencidos, carteiras dos cobradores, acordos, régua de mensagens e protesto'} />
      <Abas ativa={abas.some((x) => x[0] === aba) ? aba : 'painel'} mudar={mudar} abas={abas} />
      {aba === 'carteira' ? <Carteira eu={e} /> : aba === 'acordos' ? <Acordos /> : aba === 'protestos' && !e.restrito ? <Protestos eu={e} /> : aba === 'cobradores' && e.gestor ? <Cobradores /> : aba === 'configurar' && e.gestor ? <Configurar /> : <Painel irPara={(f) => setParams({ aba: 'carteira', faixa: f })} />}
    </>
  );
}

// ───────────── Painel ─────────────

function Painel({ irPara }: { irPara: (faixa: string) => void }) {
  const q = useQuery({ queryKey: ['cobranca', 'painel'], queryFn: () => api<any>('/cobranca/painel') });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const p = q.data;
  const ativos = p.acordos.find((a: any) => a.status === 'ativo');
  const maior = Math.max(1, ...p.faixas.map((f: any) => Number(f.atualizado)));
  return (
    <div className="coluna">
      <div className="grade g4">
        <Indicador tipo="atencao" rotulo="Vencido hoje (com encargos)" valor={reais(p.vencido.atualizado)} detalhe={`${reais(p.vencido.original)} sem multa e juros · ${p.vencido.devedores} devedor(es)`} />
        <Indicador tipo="destaque" rotulo="Recuperado no mês" valor={reais(p.recuperadoMes.valor)} detalhe={`${p.recuperadoMes.titulos} título(s) pagos depois do vencimento ou em acordo`} />
        <Indicador rotulo="Acordos em andamento" valor={ativos?.n ?? 0} detalhe={ativos ? `${reais(ativos.total)} negociados` : 'Nenhum'} />
        <Indicador rotulo="Protesto" valor={`${p.protestos?.emCartorio ?? 0} no cartório`} detalhe={`${p.protestos?.protestados ?? 0} protestado(s)`} />
      </div>
      <div className="cob-faixas">
        {FAIXAS.map(([k, nome]) => {
          const f = p.faixas.find((x: any) => x.faixa === k);
          return (
            <button key={k} className="cob-faixa" onClick={() => irPara(k)} title="Ver na carteira">
              <span className="muted">{nome}</span>
              <b>{reais(Number(f?.atualizado ?? 0))}</b>
              <span className="muted">{f?.devedores ?? 0} devedor(es) · {f?.titulos ?? 0} título(s)</span>
              <div className="barra"><i style={{ width: `${(Number(f?.atualizado ?? 0) / maior) * 100}%` }} /></div>
            </button>
          );
        })}
      </div>
      <div className="grade g2">
        <div className="cartao">
          <h3 style={{ marginTop: 0 }}>Promessas de pagamento (próximos 7 dias)</h3>
          {p.promessas.length ? (
            <table className="tabela"><tbody>{p.promessas.map((x: any) => <tr key={x.id}><td><Link to={`/cobranca/devedor/${x.pessoaId}`}>{x.nome}</Link></td><td>{data(x.data)}</td><td className="num">{x.valor ? reais(x.valor) : '—'}</td></tr>)}</tbody></table>
          ) : <p className="muted">Nenhuma promessa para os próximos dias.</p>}
        </div>
        <div className="cartao">
          <h3 style={{ marginTop: 0 }}>Retornos combinados para hoje ou atrasados</h3>
          {p.retornos.length ? (
            <table className="tabela"><tbody>{p.retornos.map((x: any, i: number) => <tr key={i}><td><Link to={`/cobranca/devedor/${x.pessoaId}`}>{x.nome}</Link><div className="muted">{x.texto.slice(0, 80)}</div></td><td>{data(x.data)}</td></tr>)}</tbody></table>
          ) : <p className="muted">Nenhum retorno pendente.</p>}
        </div>
      </div>
      {p.porCobrador.length > 0 && (
        <div className="cartao">
          <h3 style={{ marginTop: 0 }}>Por cobrador</h3>
          <table className="tabela">
            <thead><tr><th>Cobrador</th><th className="num">Devedores</th><th className="num">Carteira vencida</th><th className="num">Recuperado no mês</th><th className="num">Comissão</th></tr></thead>
            <tbody>{p.porCobrador.map((c: any) => <tr key={c.id}><td><b>{c.nome}</b> <span className="etiqueta neutra">{c.tipo === 'terceirizada' ? 'Terceirizada' : 'Funcionário'}</span></td><td className="num">{c.devedores}</td><td className="num">{reais(Number(c.carteira))}</td><td className="num">{reais(Number(c.recuperado))}</td><td className="num">{c.comissaoPb ? `${reais(c.comissao)} (${pct(c.comissaoPb)})` : '—'}</td></tr>)}</tbody>
          </table>
          <p className="muted">Recuperado: o que foi pago depois de o devedor entrar na carteira, de títulos vencidos ou parcelas de acordo.</p>
        </div>
      )}
    </div>
  );
}

// ───────────── Carteira ─────────────

function Carteira({ eu }: { eu: Eu }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [busca, setBusca] = useState('');
  const [faixa, setFaixa] = useState(params.get('faixa') ?? '');
  const [cobrador, setCobrador] = useState('');
  const [tipo, setTipo] = useState('');
  const [pagina, setPagina] = useState(1);
  const [marcados, setMarcados] = useState<string[]>([]);
  const [destino, setDestino] = useState('');
  const qs = new URLSearchParams({ busca, faixa, cobradorId: cobrador, tipo, pagina: String(pagina) }).toString();
  const q = useQuery({ queryKey: ['cobranca', 'carteira', qs], queryFn: () => api<any>(`/cobranca/carteira?${qs}`) });
  const cobs = useQuery({ queryKey: ['cobranca', 'cobradores'], queryFn: () => api<any[]>('/cobranca/cobradores'), enabled: !eu.restrito });
  const atribuir = useMutation({
    mutationFn: () => api('/cobranca/carteira/atribuir', { corpo: { pessoaIds: marcados, cobradorId: destino === 'sem' ? null : destino } }),
    onSuccess: () => { setMarcados([]); qc.invalidateQueries({ queryKey: ['cobranca'] }); },
  });
  const itens: any[] = q.data?.itens ?? [];
  const todos = itens.length > 0 && itens.every((i) => marcados.includes(i.pessoaId));
  return (
    <div className="coluna">
      <div className="busca">
        <input type="search" placeholder="Nome, CPF/CNPJ ou telefone" value={busca} onChange={(e) => { setBusca(e.target.value); setPagina(1); }} />
        <select value={faixa} onChange={(e) => { setFaixa(e.target.value); setPagina(1); }} aria-label="Atraso">
          <option value="">Todo atraso</option>
          {FAIXAS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
        <select value={tipo} onChange={(e) => { setTipo(e.target.value); setPagina(1); }} aria-label="Tipo">
          <option value="">Revendedoras e clientes</option>
          <option value="representante">Só revendedoras</option>
          <option value="cliente">Só clientes</option>
        </select>
        {!eu.restrito && (
          <select value={cobrador} onChange={(e) => { setCobrador(e.target.value); setPagina(1); }} aria-label="Cobrador">
            <option value="">Todos os cobradores</option>
            <option value="sem">Sem cobrador</option>
            {cobs.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        )}
      </div>
      {eu.gestor && marcados.length > 0 && (
        <div className="cartao flex" style={{ flexWrap: 'wrap' }}>
          <b>{marcados.length} marcado(s)</b>
          <select value={destino} onChange={(e) => setDestino(e.target.value)} aria-label="Passar para">
            <option value="">Passar para…</option>
            {cobs.data?.filter((c) => c.ativo).map((c) => <option key={c.id} value={c.id}>{c.nome}{c.tipo === 'terceirizada' ? ' (terceirizada)' : ''}</option>)}
            <option value="sem">Tirar da carteira (sem cobrador)</option>
          </select>
          <button className="botao pequeno" disabled={!destino || atribuir.isPending} onClick={() => atribuir.mutate()}>Passar</button>
          <button className="botao claro pequeno" onClick={() => setMarcados([])}>Desmarcar</button>
          {atribuir.error && <Erro erro={atribuir.error} />}
        </div>
      )}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          <table className="tabela">
            <thead>
              <tr>
                {eu.gestor && <th style={{ width: 28 }}><input type="checkbox" aria-label="Marcar todos" checked={todos} onChange={() => setMarcados(todos ? [] : itens.map((i) => i.pessoaId))} /></th>}
                <th>Devedor</th><th className="num">Títulos</th><th className="num">Maior atraso</th><th className="num">Devido</th><th className="num">Com encargos</th><th>Cobrador</th><th>Último contato</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((i) => (
                <tr key={i.pessoaId}>
                  {eu.gestor && <td><input type="checkbox" aria-label={`Marcar ${i.nome}`} checked={marcados.includes(i.pessoaId)} onChange={() => setMarcados((m) => (m.includes(i.pessoaId) ? m.filter((x) => x !== i.pessoaId) : [...m, i.pessoaId]))} /></td>}
                  <td>
                    <Link to={`/cobranca/devedor/${i.pessoaId}`}><b>{i.nome}</b></Link>
                    <div className="muted">{i.tipo === 'representante' ? 'Revendedora' : 'Cliente'} · {documento(i.documento) || 'sem CPF'} · {telefone(i.telefone) || 'sem telefone'}{i.cidade ? ` · ${i.cidade}/${i.uf}` : ''}</div>
                    <div className="flex" style={{ gap: 6, marginTop: 2 }}>
                      {i.pausada && <span className="etiqueta neutra">Régua pausada</span>}
                      {i.emProtesto > 0 && <span className="etiqueta erro">{i.emProtesto} em protesto</span>}
                      {i.promessa && <span className="etiqueta alerta">Prometeu para {data(i.promessa)}</span>}
                    </div>
                  </td>
                  <td className="num">{i.titulos}</td>
                  <td className="num">{i.maiorAtraso} dias</td>
                  <td className="num">{reais(Number(i.original))}</td>
                  <td className="num"><b>{reais(Number(i.atualizado))}</b></td>
                  <td>{i.cobrador ?? <span className="muted">—</span>}</td>
                  <td>{i.ultimoContato ? dataHora(i.ultimoContato) : <span className="muted">Nunca</span>}</td>
                </tr>
              ))}
              {!itens.length && <tr><td colSpan={8} className="vazio">Ninguém com título vencido nesse filtro.</td></tr>}
            </tbody>
          </table>
          {(pagina > 1 || q.data.temMais) && (
            <div className="flex">
              <button className="botao claro pequeno" disabled={pagina === 1} onClick={() => setPagina(pagina - 1)}>Anterior</button>
              <span className="muted">Página {pagina}</span>
              <button className="botao claro pequeno" disabled={!q.data.temMais} onClick={() => setPagina(pagina + 1)}>Próxima</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ───────────── Acordos ─────────────

function Acordos() {
  const [status, setStatus] = useState('ativo');
  const q = useQuery({ queryKey: ['cobranca', 'acordos', status], queryFn: () => api<any[]>(`/cobranca/acordos?status=${status}`) });
  return (
    <div className="coluna">
      <div className="busca">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
          <option value="ativo">Em andamento</option>
          <option value="quitado">Quitados</option>
          <option value="quebrado">Quebrados</option>
          <option value="cancelado">Cancelados</option>
          <option value="">Todos</option>
        </select>
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Devedor</th><th>Feito em</th><th className="num">Total</th><th className="num">Pago</th><th className="num">Parcelas</th><th>Situação</th></tr></thead>
          <tbody>
            {q.data!.map((a) => (
              <tr key={a.id}>
                <td>{a.numero}</td>
                <td><Link to={`/cobranca/devedor/${a.pessoaId}`}>{a.nome}</Link>{a.cobrador && <div className="muted">{a.cobrador}</div>}</td>
                <td>{dataHora(a.criadoEm)}</td>
                <td className="num">{reais(a.total)}</td>
                <td className="num">{reais(Number(a.pago))}</td>
                <td className="num">{a.parcelas}</td>
                <td><span className={`etiqueta ${STATUS_ACORDO[a.status]?.[1]}`}>{STATUS_ACORDO[a.status]?.[0] ?? a.status}</span>{a.status === 'ativo' && a.atrasadas > 0 && <span className="etiqueta alerta" style={{ marginLeft: 6 }}>{a.atrasadas} atrasada(s)</span>}</td>
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={7} className="vazio">Nenhum acordo.</td></tr>}
          </tbody>
        </table>
      )}
      <p className="muted">Acordo com parcela atrasada além do prazo configurado quebra sozinho: as parcelas abertas são canceladas e a dívida volta, já descontado o que foi pago.</p>
    </div>
  );
}

// ───────────── Protesto ─────────────

function Protestos({ eu }: { eu: Eu }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [arquivo, setArquivo] = useState<string | null>(null);
  const [pedido, setPedido] = useState<{ id: string; tipo: 'desistencia' | 'autoriza_cancelamento'; nome: string } | null>(null);
  const q = useQuery({ queryKey: ['cobranca', 'protestos', status], queryFn: () => api<any>(`/cobranca/protestos${status ? `?status=${status}` : ''}`) });
  const arqs = useQuery({ queryKey: ['cobranca', 'arquivos'], queryFn: () => api<any[]>('/cobranca/protestos/arquivos'), enabled: eu.gestor });
  const sinc = useMutation({ mutationFn: () => api<any>('/cobranca/protestos/sincronizar', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca'] }) });
  return (
    <div className="coluna">
      {!eu.protestoLigado && (
        <div className="cartao" style={{ borderColor: 'var(--dourado)' }}>
          <b>O protesto ainda não está ligado.</b>
          <p className="muted" style={{ marginBottom: 0 }}>
            Falta o convênio da Aritana com a CRA do estado (IEPTB). Com o convênio, a CRA entrega o endereço do webservice, o usuário, a senha e o código de apresentante: preencha em Configurações › Integrações › Protesto (CRA21).
            Comece pelo endereço de homologação; a CRA confere os primeiros arquivos antes de liberar a produção. Até lá, dá para conferir os títulos e ver o arquivo que seria enviado.
          </p>
        </div>
      )}
      <div className="busca">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
          <option value="">Todas as situações</option>
          {Object.entries(STATUS_PROTESTO).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}
        </select>
        {eu.gestor && eu.protestoLigado && <button className="botao claro" disabled={sinc.isPending} onClick={() => sinc.mutate()}>{sinc.isPending ? 'Buscando…' : 'Buscar retorno da CRA agora'}</button>}
        {sinc.data && <span className="muted">{sinc.data.atualizados} atualização(ões), {sinc.data.pedidos} pedido(s) de cancelamento/desistência.</span>}
      </div>
      {sinc.error && <Erro erro={sinc.error} />}
      <p className="muted">Para mandar a protesto, abra a ficha do devedor e marque os títulos. O sistema busca a confirmação e o retorno do cartório a cada 3 horas. Quando o devedor paga à Aritana, pede sozinho a desistência (se ainda está no cartório) ou autoriza o cancelamento (se já foi protestado).</p>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Devedor e título</th><th className="num">Valor</th><th>Cartório</th><th>Situação</th><th>Atualizado</th><th></th></tr></thead>
          <tbody>
            {q.data.itens.map((p: any) => (
              <tr key={p.id}>
                <td>{p.numero}</td>
                <td><Link to={`/cobranca/devedor/${p.pessoaId}`}>{p.nome}</Link><div className="muted">{p.descricao} · venceu {data(p.vencimento)}</div></td>
                <td className="num">{reais(p.valor)}</td>
                <td>{p.protocolo ? <>Cartório {p.cartorio}<div className="muted">Protocolo {p.protocolo}</div></> : '—'}{p.custas ? <div className="muted">Custas {reais(p.custas)}</div> : null}</td>
                <td>
                  <span className={`etiqueta ${STATUS_PROTESTO[p.status]?.[1] ?? 'neutra'}`}>{STATUS_PROTESTO[p.status]?.[0] ?? p.status}</span>
                  {p.ocorrencia && <div className="muted">{q.data.ocorrencias[p.ocorrencia] ?? `Ocorrência ${p.ocorrencia}`}</div>}
                  {p.irregularidade && <div className="muted">Irregularidade {p.irregularidade}</div>}
                  {p.pedido && <div className="muted">{p.pedido === 'desistencia' ? 'Desistência pedida' : 'Cancelamento autorizado'}</div>}
                </td>
                <td>{dataHora(p.atualizadoEm)}</td>
                <td>
                  {eu.gestor && !p.pedido && p.status === 'em_cartorio' && <button className="botao claro pequeno" onClick={() => setPedido({ id: p.id, tipo: 'desistencia', nome: p.nome })}>Desistir</button>}
                  {eu.gestor && !p.pedido && p.status === 'protestado' && <button className="botao claro pequeno" onClick={() => setPedido({ id: p.id, tipo: 'autoriza_cancelamento', nome: p.nome })}>Autorizar cancelamento</button>}
                </td>
              </tr>
            ))}
            {!q.data.itens.length && <tr><td colSpan={7} className="vazio">Nenhum título em protesto.</td></tr>}
          </tbody>
        </table>
      )}
      {eu.gestor && (arqs.data?.length ?? 0) > 0 && (
        <details className="cartao">
          <summary><b>Arquivos trocados com a CRA</b> <span className="muted">(para conferir na homologação)</span></summary>
          <table className="tabela">
            <thead><tr><th>Arquivo</th><th>Tipo</th><th>Situação</th><th>Quando</th><th></th></tr></thead>
            <tbody>{arqs.data!.map((a) => <tr key={a.id}><td>{a.nome}</td><td>{a.tipo.replace('_', ' ')}</td><td><span className={`etiqueta ${a.situacao === 'recusado' ? 'erro' : 'neutra'}`}>{a.situacao}</span>{a.situacao === 'recusado' && a.resposta && <div className="muted">{a.resposta.slice(0, 160)}</div>}</td><td>{dataHora(a.criadoEm)}</td><td><button className="botao claro pequeno" onClick={() => setArquivo(a.id)}>Ver</button></td></tr>)}</tbody>
          </table>
        </details>
      )}
      {arquivo && <VerArquivo id={arquivo} fechar={() => setArquivo(null)} />}
      {pedido && <Pedido {...pedido} fechar={() => setPedido(null)} />}
    </div>
  );
}

function VerArquivo({ id, fechar }: { id: string; fechar: () => void }) {
  const q = useQuery({ queryKey: ['cobranca', 'arquivo', id], queryFn: () => api<any>(`/cobranca/protestos/arquivos/${id}`) });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900 }}>
        <h3 style={{ marginTop: 0 }}>{q.data?.nome ?? 'Arquivo'}</h3>
        {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
          <>
            <div className="cob-xml">{q.data.conteudo.replace(/></g, '>\n<')}</div>
            {q.data.resposta && <><h4>Resposta da CRA</h4><div className="cob-xml">{q.data.resposta}</div></>}
          </>
        )}
        <div className="flex" style={{ marginTop: 12 }}><button className="botao claro" onClick={fechar}>Fechar</button></div>
      </div>
    </div>
  );
}

function Pedido({ id, tipo, nome, fechar }: { id: string; tipo: 'desistencia' | 'autoriza_cancelamento'; nome: string; fechar: () => void }) {
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState('');
  const m = useMutation({ mutationFn: () => api(`/cobranca/protestos/${id}/pedido`, { corpo: { tipo, motivo } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['cobranca'] }); fechar(); } });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>{tipo === 'desistencia' ? 'Desistir do protesto' : 'Autorizar o cancelamento do protesto'} · {nome}</h3>
        <p className="muted">{tipo === 'desistencia' ? 'O título ainda está no cartório: a desistência tira o título antes de ser protestado. Pode haver custas.' : 'O título já foi protestado: a autorização permite ao devedor cancelar o protesto no cartório (as custas do cancelamento são dele).'}</p>
        <Campo rotulo="Motivo"><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: pagou à Aritana, fez acordo…" /></Campo>
        {m.error && <Erro erro={m.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={motivo.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Enviar à CRA</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

// ───────────── Cobradores ─────────────

function Cobradores() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cobranca', 'cobradores'], queryFn: () => api<any[]>('/cobranca/cobradores') });
  const usuarios = useQuery({ queryKey: ['usuarios'], queryFn: () => api<any[]>('/usuarios'), enabled: pode('configuracoes', 'ver') });
  const [form, setForm] = useState<any | null>(null);
  const [acesso, setAcesso] = useState<{ id: string; tipo: string; nome: string } | null>(null);
  const [senha, setSenha] = useState<{ email: string; senha: string } | null>(null);
  const salvar = useMutation({
    mutationFn: (f: any) => api(f.id ? `/cobranca/cobradores/${f.id}` : '/cobranca/cobradores', { metodo: f.id ? 'PATCH' : 'POST', corpo: { nome: f.nome, tipo: f.tipo, documento: f.documento || null, telefone: f.telefone || null, email: f.email || null, comissaoPb: textoParaPb(f.comissao), ativo: f.ativo } }),
    onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ['cobranca'] }); },
  });
  const remover = useMutation({ mutationFn: (x: { cobradorId: string; usuarioId: string }) => api(`/cobranca/cobradores/${x.cobradorId}/acessos/${x.usuarioId}/remover`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca', 'cobradores'] }) });
  const erros = camposComErro(salvar.error);
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      <p className="muted">Funcionário: alguém da equipe que já tem usuário no sistema. Terceirizada: empresa de cobrança de fora; quem entra por ela vê só a Cobrança e só os devedores passados para ela (sem Financeiro, cadastros ou outros módulos).</p>
      <div className="flex"><button className="botao" onClick={() => setForm({ nome: '', tipo: 'terceirizada', documento: '', telefone: '', email: '', comissao: '', ativo: true })}>Novo cobrador</button></div>
      <table className="tabela">
        <thead><tr><th>Cobrador</th><th>Tipo</th><th className="num">Comissão</th><th>Quem entra no sistema</th><th></th></tr></thead>
        <tbody>
          {q.data!.map((c) => (
            <tr key={c.id} style={c.ativo ? undefined : { opacity: 0.55 }}>
              <td><b>{c.nome}</b>{!c.ativo && <span className="etiqueta neutra" style={{ marginLeft: 6 }}>Inativo</span>}<div className="muted">{[documento(c.documento), telefone(c.telefone), c.email].filter(Boolean).join(' · ')}</div></td>
              <td>{c.tipo === 'terceirizada' ? 'Terceirizada' : 'Funcionário'}</td>
              <td className="num">{c.comissaoPb ? pct(c.comissaoPb) : '—'}</td>
              <td>
                {c.acessos.map((a: any) => (
                  <div key={a.id} className="flex" style={{ gap: 6 }}>
                    <span>{a.nome} <span className="muted">{a.email}{!a.ativo ? ' · desativado' : ''}</span></span>
                    <button className="botao claro pequeno" disabled={remover.isPending} onClick={() => window.confirm(`Tirar o acesso de ${a.nome} a esta carteira?`) && remover.mutate({ cobradorId: c.id, usuarioId: a.id })}>Tirar</button>
                  </div>
                ))}
                {c.ativo && <button className="botao claro pequeno" onClick={() => setAcesso({ id: c.id, tipo: c.tipo, nome: c.nome })}>{c.tipo === 'terceirizada' ? '+ Acesso' : '+ Ligar usuário'}</button>}
              </td>
              <td><button className="botao claro pequeno" onClick={() => setForm({ ...c, comissao: pbParaTexto(c.comissaoPb), documento: c.documento ?? '', telefone: c.telefone ?? '', email: c.email ?? '' })}>Editar</button></td>
            </tr>
          ))}
          {!q.data!.length && <tr><td colSpan={5} className="vazio">Nenhum cobrador ainda.</td></tr>}
        </tbody>
      </table>
      {remover.error && <Erro erro={remover.error} />}
      {senha && (
        <div className="cartao" style={{ borderColor: 'var(--dourado)' }}>
          <b>Acesso criado.</b> Passe para a pessoa por um canal seguro: e-mail <b>{senha.email}</b>, senha provisória <code>{senha.senha}</code>. Ela troca a senha no primeiro acesso. A senha não aparece de novo.
          <div><button className="botao claro pequeno" style={{ marginTop: 8 }} onClick={() => setSenha(null)}>Já anotei</button></div>
        </div>
      )}
      {form && (
        <div className="modal-fundo" onClick={() => setForm(null)}>
          <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0 }}>{form.id ? 'Editar cobrador' : 'Novo cobrador'}</h3>
            <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Campo rotulo="Nome" erro={erros.nome} className="l2"><input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></Campo>
              <Campo rotulo="Tipo"><select value={form.tipo} disabled={!!form.id} onChange={(e) => setForm({ ...form, tipo: e.target.value })}><option value="terceirizada">Terceirizada</option><option value="interno">Funcionário</option></select></Campo>
              <Campo rotulo="Comissão sobre o recuperado (%)" ajuda="Só para o relatório; o pagamento é feito fora."><input inputMode="decimal" value={form.comissao} onChange={(e) => setForm({ ...form, comissao: e.target.value })} placeholder="0" /></Campo>
              <Campo rotulo="CNPJ/CPF" erro={erros.documento}><input value={form.documento} onChange={(e) => setForm({ ...form, documento: e.target.value })} /></Campo>
              <Campo rotulo="Telefone"><input value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} /></Campo>
              <Campo rotulo="E-mail" erro={erros.email} className="l2"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Campo>
              {form.id && <label className="l2 check"><input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} /> Ativo (desativar também desativa os acessos)</label>}
            </div>
            {salvar.error && <Erro erro={salvar.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate(form)}>Salvar</button>
              <button className="botao claro" onClick={() => setForm(null)}>Voltar</button>
            </div>
          </div>
        </div>
      )}
      {acesso && <NovoAcesso {...acesso} usuarios={usuarios.data ?? []} fechar={() => setAcesso(null)} criado={(s) => { setSenha(s); setAcesso(null); }} />}
    </div>
  );
}

function NovoAcesso({ id, tipo, nome, usuarios, fechar, criado }: { id: string; tipo: string; nome: string; usuarios: any[]; fechar: () => void; criado: (s: { email: string; senha: string }) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ nome: '', email: '', usuarioId: '' });
  const m = useMutation({
    mutationFn: () => api<any>(`/cobranca/cobradores/${id}/acessos`, { corpo: tipo === 'terceirizada' ? { nome: f.nome, email: f.email } : { usuarioId: f.usuarioId } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['cobranca', 'cobradores'] }); if (r.senhaProvisoria) criado({ email: r.email, senha: r.senhaProvisoria }); else fechar(); },
  });
  const erros = camposComErro(m.error);
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>{tipo === 'terceirizada' ? `Acesso para ${nome}` : `Ligar usuário a ${nome}`}</h3>
        {tipo === 'terceirizada' ? (
          <div className="coluna">
            <Campo rotulo="Nome de quem vai entrar" erro={erros.nome}><input autoFocus value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Campo>
            <Campo rotulo="E-mail (é o login)" erro={erros.email}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
            <p className="muted">Entra no grupo "Cobrança terceirizada": vê a carteira, registra contatos e promessas, emite 2ª via e faz acordo dentro do limite de desconto. Não atribui carteira nem manda a protesto.</p>
          </div>
        ) : (
          <Campo rotulo="Usuário da equipe" ajuda="A carteira e a comissão deste cobrador passam a contar o que esse usuário fizer.">
            <select value={f.usuarioId} onChange={(e) => setF({ ...f, usuarioId: e.target.value })}>
              <option value="">Escolha…</option>
              {usuarios.filter((u) => u.ativo).map((u) => <option key={u.id} value={u.id}>{u.nome} ({u.email})</option>)}
            </select>
          </Campo>
        )}
        {m.error && <Erro erro={m.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={m.isPending || (tipo === 'terceirizada' ? !f.nome || !f.email : !f.usuarioId)} onClick={() => m.mutate()}>{tipo === 'terceirizada' ? 'Criar acesso' : 'Ligar'}</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

// ───────────── Configurar ─────────────

const VARIAVEIS = '{primeiro_nome} {nome} {valor} {valor_atualizado} {vencimento} {dias} {link} {pix} {titulos} {empresa}';

function Configurar() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cobranca', 'config'], queryFn: () => api<any>('/cobranca/config') });
  const canais = useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<any[]>('/crm/canais'), enabled: pode('crm', 'ver') });
  const [c, setC] = useState<any | null>(null);
  const [previa, setPrevia] = useState<any[] | null>(null);
  const cfg = c ?? (q.data ? { ...q.data, multa: pbParaTexto(q.data.multaPb), juros: pbParaTexto(q.data.jurosMesPb), desc: pbParaTexto(q.data.descontoMaxPb), descG: pbParaTexto(q.data.descontoMaxGestorPb) } : null);
  const canal = canais.data?.find((x) => x.id === cfg?.regua.canalId);
  const templates = useQuery({ queryKey: ['crm', 'templates', canal?.id], queryFn: () => api<any[]>(`/crm/templates?canalId=${canal!.id}`), enabled: !!canal && canal.tipo === 'oficial' });
  const salvar = useMutation({
    mutationFn: () => api('/cobranca/config', { metodo: 'PUT', corpo: { multaPb: textoParaPb(cfg.multa), jurosMesPb: textoParaPb(cfg.juros), diasCarencia: Number(cfg.diasCarencia) || 0, descontoMaxPb: textoParaPb(cfg.desc), descontoMaxGestorPb: textoParaPb(cfg.descG), parcelasMax: Number(cfg.parcelasMax), diasQuebraAcordo: Number(cfg.diasQuebraAcordo), regua: { ativa: cfg.regua.ativa, canalId: cfg.regua.canalId || null, passos: cfg.regua.passos.map((p: any) => ({ ...p, dias: Number(p.dias), templateId: p.templateId || null })) }, protesto: { diasMinimos: Number(cfg.protesto.diasMinimos), especie: cfg.protesto.especie } } }),
    onSuccess: () => { setC(null); qc.invalidateQueries({ queryKey: ['cobranca'] }); },
  });
  const verPrevia = useMutation({ mutationFn: () => api<any>('/cobranca/regua/previa'), onSuccess: (r) => setPrevia(r.previa) });
  const rodar = useMutation({ mutationFn: () => api<any>('/cobranca/regua/rodar', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca'] }) });
  if (q.isLoading || !cfg) return <Carregando />;
  const muda = (x: any) => setC({ ...cfg, ...x });
  const passo = (i: number, x: any) => muda({ regua: { ...cfg.regua, passos: cfg.regua.passos.map((p: any, j: number) => (j === i ? { ...p, ...x } : p)) } });
  const erros = camposComErro(salvar.error);
  return (
    <div className="coluna">
      <div className="cartao">
        <h3 style={{ marginTop: 0 }}>Multa, juros e acordos</h3>
        <div className="form">
          <Campo rotulo="Multa por atraso (%)" erro={erros.multaPb}><input inputMode="decimal" value={cfg.multa} onChange={(e) => muda({ multa: e.target.value })} /></Campo>
          <Campo rotulo="Juros ao mês (%)" erro={erros.jurosMesPb} ajuda="Simples, proporcional aos dias."><input inputMode="decimal" value={cfg.juros} onChange={(e) => muda({ juros: e.target.value })} /></Campo>
          <Campo rotulo="Dias de carência" ajuda="Pagando até aqui, não cobra multa nem juros."><input type="number" min={0} value={cfg.diasCarencia} onChange={(e) => muda({ diasCarencia: e.target.value })} /></Campo>
          <Campo rotulo="Parcelas no máximo"><input type="number" min={1} max={60} value={cfg.parcelasMax} onChange={(e) => muda({ parcelasMax: e.target.value })} /></Campo>
          <Campo rotulo="Desconto máximo do cobrador (%)" ajuda="Sobre o valor com encargos."><input inputMode="decimal" value={cfg.desc} onChange={(e) => muda({ desc: e.target.value })} /></Campo>
          <Campo rotulo="Desconto máximo da gestão (%)"><input inputMode="decimal" value={cfg.descG} onChange={(e) => muda({ descG: e.target.value })} /></Campo>
          <Campo rotulo="Acordo quebra com atraso de (dias)"><input type="number" min={1} value={cfg.diasQuebraAcordo} onChange={(e) => muda({ diasQuebraAcordo: e.target.value })} /></Campo>
        </div>
        <p className="muted">Vale para todos os títulos: boleto de 2ª via, Asaas, régua, acordos e para a carteira.</p>
      </div>

      <div className="cartao">
        <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Régua de cobrança</h3>
          <label className="check"><input type="checkbox" checked={cfg.regua.ativa} onChange={(e) => muda({ regua: { ...cfg.regua, ativa: e.target.checked } })} /> Ligada (manda todo dia depois das 9h)</label>
        </div>
        <p className="muted">Cada passo manda uma mensagem quando o título fica a tantos dias do vencimento (negativo é antes). Títulos da mesma pessoa vão juntos. O boleto ou Pix é emitido antes, para o link ir na mensagem. Devedor com a régua pausada, título de cartão e título em protesto ficam de fora.</p>
        <Campo rotulo="Número de WhatsApp que manda" erro={erros['regua.canalId']}>
          <select value={cfg.regua.canalId ?? ''} onChange={(e) => muda({ regua: { ...cfg.regua, canalId: e.target.value || null } })}>
            <option value="">Escolha…</option>
            {canais.data?.filter((x) => x.ativo && !x.excluidoEm).map((x) => <option key={x.id} value={x.id}>{x.nome}{x.tipo === 'oficial' ? ' (oficial: precisa de template)' : ''}</option>)}
          </select>
        </Campo>
        {cfg.regua.passos.map((p: any, i: number) => (
          <div key={i} className="cob-passo">
            <Campo rotulo="Dias do vencimento"><input type="number" value={p.dias} onChange={(e) => passo(i, { dias: e.target.value })} /></Campo>
            <Campo rotulo="Por"><select value={p.canal} onChange={(e) => passo(i, { canal: e.target.value })}><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option></select></Campo>
            <Campo rotulo={Number(p.dias) < 0 ? `${-p.dias} dia(s) antes` : Number(p.dias) === 0 ? 'No dia do vencimento' : `${p.dias} dia(s) depois`}>
              <textarea value={p.texto} onChange={(e) => passo(i, { texto: e.target.value })} />
              {canal?.tipo === 'oficial' && p.canal === 'whatsapp' && (
                <select value={p.templateId ?? ''} onChange={(e) => passo(i, { templateId: e.target.value || null })} style={{ marginTop: 6 }}>
                  <option value="">Template aprovado pela Meta…</option>
                  {templates.data?.filter((t) => t.tipo !== 'livre').map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
                </select>
              )}
            </Campo>
            <button className="botao perigo pequeno" style={{ marginTop: 22 }} onClick={() => muda({ regua: { ...cfg.regua, passos: cfg.regua.passos.filter((_: any, j: number) => j !== i) } })}>Tirar</button>
          </div>
        ))}
        <p className="muted">Pode usar: {VARIAVEIS}</p>
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          <button className="botao claro pequeno" onClick={() => muda({ regua: { ...cfg.regua, passos: [...cfg.regua.passos, { dias: 15, canal: 'whatsapp', texto: 'Olá, {primeiro_nome}. A parcela de {valor} venceu em {vencimento}. Hoje fica em {valor_atualizado}.\n{link}' }] } })}>+ Passo</button>
          <button className="botao claro pequeno" disabled={verPrevia.isPending || !!c} title={c ? 'Salve antes de ver a prévia' : undefined} onClick={() => verPrevia.mutate()}>Ver o que sai hoje</button>
          {cfg.regua.ativa && !c && <button className="botao claro pequeno" disabled={rodar.isPending} onClick={() => window.confirm('Mandar agora as mensagens de hoje? Cada título recebe cada passo uma vez só.') && rodar.mutate()}>Mandar agora</button>}
          {rodar.data && <span className="muted">{rodar.data.enviados} enviada(s), {rodar.data.falhas} com problema.</span>}
        </div>
        {(verPrevia.error || rodar.error) && <Erro erro={verPrevia.error ?? rodar.error} />}
        {previa && (
          <table className="tabela" style={{ marginTop: 10 }}>
            <thead><tr><th>Para</th><th>Passo</th><th>Mensagem</th></tr></thead>
            <tbody>
              {previa.map((x, i) => <tr key={i}><td><Link to={`/cobranca/devedor/${x.pessoaId}`}>{x.nome}</Link><div className="muted">{x.destino ?? '—'}</div>{x.problema && <span className="etiqueta alerta">{x.problema}</span>}</td><td>{x.passo} dia(s) · {x.canal === 'email' ? 'e-mail' : 'WhatsApp'}</td><td style={{ whiteSpace: 'pre-wrap' }}>{x.texto}</td></tr>)}
              {!previa.length && <tr><td colSpan={3} className="vazio">Nenhuma mensagem para hoje.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <div className="cartao">
        <h3 style={{ marginTop: 0 }}>Protesto</h3>
        <div className="form">
          <Campo rotulo="Mandar a protesto só depois de (dias)"><input type="number" min={1} value={cfg.protesto.diasMinimos} onChange={(e) => muda({ protesto: { ...cfg.protesto, diasMinimos: e.target.value } })} /></Campo>
          <Campo rotulo="Espécie do título" erro={erros['protesto.especie']} ajuda="DMI: duplicata mercantil por indicação. Confirme com a CRA no convênio.">
            <input maxLength={3} value={cfg.protesto.especie} onChange={(e) => muda({ protesto: { ...cfg.protesto, especie: e.target.value.toUpperCase() } })} />
          </Campo>
        </div>
      </div>
      {salvar.error && <Erro erro={salvar.error} />}
      <div className="flex">
        <button className="botao" disabled={!c || salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button>
        {c && <button className="botao claro" onClick={() => setC(null)}>Desfazer</button>}
      </div>
    </div>
  );
}
