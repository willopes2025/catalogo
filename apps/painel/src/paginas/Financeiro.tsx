import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { data, paraCentavos, reais } from '../formato';
import { ConciliarCartao } from './ConciliarCartao';
import { Abas, Campo, Carregando, Erro, Indicador, Topo, camposComErro } from '../componentes/ui';
import { Dre } from './financeiro/Dre';
import { PlanoContas } from './financeiro/PlanoContas';
import { ContasBancarias } from './financeiro/ContasBancarias';
import { Asaas } from './financeiro/Asaas';
import { SeletorPlano, usePlano } from './financeiro/comum';
import './financeiro/financeiro.css';
import { comVisao, usarVisao } from '../visao';
import { ConversaCobranca, EmitirCobranca } from '../componentes/CobrancaPessoa';
import { PixRecebidos } from './financeiro/PixRecebidos';

/** Eventos cadastrados (cada um é um centro de custo). */
export const usarEventos = () => useQuery({ queryKey: ['eventos'], queryFn: () => api<{ id: string; nome: string; ativo: boolean; inicio: string | null }[]>('/eventos'), staleTime: 60_000 });

type Secao = 'lancamentos' | 'dre' | 'plano' | 'contas' | 'asaas';

/** Financeiro: lançamentos (contas a receber e a pagar), DRE, plano de contas e contas bancárias. */
export function Financeiro() {
  const [params, setParams] = useSearchParams();
  const secao = (['lancamentos', 'dre', 'plano', 'contas', 'asaas'] as Secao[]).includes(params.get('secao') as Secao) ? (params.get('secao') as Secao) : 'lancamentos';
  const ir = (s: Secao, extra: Record<string, string> = {}) => setParams(s === 'lancamentos' && !Object.keys(extra).length ? {} : { secao: s, ...extra });
  const secoes = <Abas ativa={secao} mudar={(s) => ir(s)} abas={[['lancamentos', 'Lançamentos'], ['dre', 'DRE'], ['plano', 'Plano de contas'], ['contas', 'Contas bancárias'], ['asaas', 'Asaas']]} />;
  if (secao === 'dre') return <><Topo eb="Financeiro" titulo="DRE" sub="Resultado mês a mês, aberto por conta do plano, com o peso de cada uma" />{secoes}<Dre irParaTitulos={() => ir('lancamentos', { semPlano: '1' })} /></>;
  if (secao === 'plano') return <><Topo eb="Financeiro" titulo="Plano de contas" sub="As contas em que cada receita e despesa é classificada" />{secoes}<PlanoContas verLancamentos={(id) => ir('lancamentos', { plano: id })} /></>;
  if (secao === 'asaas') return <><Topo eb="Financeiro" titulo="Asaas" sub="A conta do Asaas inteira: cobranças, extrato, transferências, Pix, antecipação, notas e o resto" />{secoes}<Asaas /></>;
  if (secao === 'contas') return <><Topo eb="Financeiro" titulo="Contas bancárias e caixas" sub="Onde o dinheiro entra e sai" />{secoes}<ContasBancarias /></>;
  return <Titulos secoes={secoes} />;
}

type Aba = 'abertos' | 'vencidos' | 'renegociados' | 'pagos' | 'protestados' | 'cartoes' | 'pix';

/** Datas (AAAA-MM-DD) de um período rápido, no horário de Brasília. */
function periodoRapido(p: string): [string, string] | null {
  const h = new Date(Date.now() - 3 * 3600_000);
  const y = h.getUTCFullYear(), m = h.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const mes = (dy: number, dm: number) => [iso(new Date(Date.UTC(dy, dm, 1))), iso(new Date(Date.UTC(dy, dm + 1, 0)))] as [string, string];
  if (p === 'este_mes') return mes(y, m);
  if (p === 'mes_passado') return mes(y, m - 1);
  if (p === 'proximo_mes') return mes(y, m + 1);
  if (p === 'hoje') return [iso(h), iso(h)];
  return null;
}

function Titulos({ secoes }: { secoes: React.ReactNode }) {
  const [params, setParams] = useSearchParams();
  const filtroPlano = params.get('plano') ?? '';
  const [tipo, setTipo] = useState<'receber' | 'pagar'>(params.get('semPlano') === '1' ? 'pagar' : 'receber');
  const [aba, setAba] = useState<Aba>('abertos');
  const [originais, setOriginais] = useState(false);
  const [situacaoReneg, setSituacaoReneg] = useState('');
  const [contaId, setContaId] = useState('');
  const [busca, setBusca] = useState('');
  const [periodo, setPeriodo] = useState('');
  const [deP, setDeP] = useState('');
  const [ateP, setAteP] = useState('');
  const datasPeriodo = periodo === 'escolher' ? (deP || ateP ? [deP, ateP] : null) : periodoRapido(periodo);
  const [semPessoa, setSemPessoa] = useState(false);
  const [semPlano, setSemPlano] = useState(params.get('semPlano') === '1');
  const [marcados, setMarcados] = useState<string[]>([]);
  const [destino, setDestino] = useState('');
  const [novo, setNovo] = useState(false);
  const [editando, setEditando] = useState<any | null>(null);
  const plano = usePlano();
  const contaFiltro = plano.data?.contas.find((c) => c.id === filtroPlano);
  const [ligando, setLigando] = useState<string | null>(null);
  const [evento, setEvento] = useState(params.get('evento') ?? '');
  const eventos = usarEventos();
  const visao = usarVisao();
  const qc = useQueryClient();
  const filtro = `tipo=${tipo}&aba=${aba}${tipo === 'receber' ? '&separarRenegociados=1' : ''}${aba === 'renegociados' && originais ? '&originais=1' : ''}${aba === 'renegociados' && situacaoReneg && !originais ? `&situacao=${situacaoReneg}` : ''}${evento ? `&centroCustoId=${evento}` : ''}${visao ? `&empresaId=${visao}` : ''}${busca.trim() ? `&busca=${encodeURIComponent(busca.trim())}` : ''}${semPessoa ? '&semPessoa=1' : ''}${semPlano ? '&semPlano=1' : ''}${filtroPlano ? `&planoContaId=${filtroPlano}` : ''}${datasPeriodo?.[0] ? `&de=${datasPeriodo[0]}` : ''}${datasPeriodo?.[1] ? `&ate=${datasPeriodo[1]}` : ''}`;
  const q = useQuery({ queryKey: ['titulos', filtro], queryFn: () => api<{ itens: any[]; total: number; quantidade: number }>(`/financeiro/titulos?${filtro}`) });
  const contas = useQuery({ queryKey: ['contas', visao], queryFn: () => api<any[]>(comVisao('/financeiro/contas', visao)) });
  const [cobranca, setCobranca] = useState<any | null>(null);
  const [emitindo, setEmitindo] = useState<{ t: any; tipo: 'PIX' | 'BOLETO' } | null>(null);
  const [baixa, setBaixa] = useState<{ id: string; valor: string; pagoEm: string; desconto: boolean; total: number } | null>(null);
  const baixar = useMutation({
    mutationFn: () => api(`/financeiro/titulos/${baixa!.id}/baixar`, { corpo: { contaId: contaId || null, valorPago: baixa!.valor ? paraCentavos(baixa!.valor) : undefined, pagoEm: baixa!.pagoEm || undefined, quitarComDesconto: baixa!.desconto } }),
    onSuccess: () => { setBaixa(null); qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['contas'] }); },
  });
  const acao = useMutation({
    mutationFn: ({ id, tipo, motivo }: { id: string; tipo: 'cancelar' | 'estornar'; motivo: string }) => api(`/financeiro/titulos/${id}/${tipo}`, { corpo: { motivo } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['contas'] }); },
  });
  const classificar = useMutation({
    mutationFn: () => api('/financeiro/titulos/classificar', { corpo: { ids: marcados, planoContaId: destino || null } }),
    onSuccess: () => { setMarcados([]); setDestino(''); qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['dre'] }); qc.invalidateQueries({ queryKey: ['plano-contas'] }); },
  });
  const pedirMotivo = (id: string, tipo: 'cancelar' | 'estornar') => {
    const motivo = window.prompt(tipo === 'cancelar' ? 'Motivo do cancelamento do título:' : 'Motivo do estorno da baixa:');
    if (motivo && motivo.trim().length >= 3) acao.mutate({ id, tipo, motivo: motivo.trim() });
  };
  return (
    <>
      <Topo eb="Financeiro" titulo={tipo === 'receber' ? 'Contas a receber' : 'Contas a pagar'} acoes={<div className="flex">{pode('financeiro', 'criar') && <button className="botao" onClick={() => setNovo(true)}>+ Novo lançamento</button>}<button className={`botao ${tipo === 'receber' ? '' : 'claro'}`} onClick={() => setTipo('receber')}>A receber</button><button className={`botao ${tipo === 'pagar' ? '' : 'claro'}`} onClick={() => { setTipo('pagar'); if (['cartoes', 'renegociados', 'protestados', 'pix'].includes(aba)) setAba('abertos'); }}>A pagar</button></div>} />
      {secoes}
      {contas.data && (
        <div className="grade g4" style={{ marginBottom: 14 }}>
          {contas.data.slice(0, 4).map((c) => <Indicador key={c.id} rotulo={c.nome} valor={reais(c.saldo)} detalhe={c.empresa} />)}
        </div>
      )}
      {tipo === 'receber' && aba !== 'cartoes' && <ResumoReceber visao={visao} irPara={(a, sit) => { setAba(a); if (a === 'renegociados') { setOriginais(sit === 'originais'); setSituacaoReneg(sit && sit !== 'originais' ? sit : ''); } }} />}
      <Abas ativa={aba} mudar={setAba} abas={[['abertos', tipo === 'receber' ? 'A receber' : 'Em aberto'], ['vencidos', 'Vencidos'], ...(tipo === 'receber' ? ([['renegociados', 'Renegociado']] as [Aba, string][]) : []), ['pagos', 'Pagos'], ...(tipo === 'receber' ? ([['protestados', 'Protestados'], ['cartoes', 'Cartões (conciliar)'], ['pix', 'Pix recebidos']] as [Aba, string][]) : [])]} />
      {aba === 'cartoes' ? <ConciliarCartao contas={contas.data ?? []} /> : aba === 'pix' ? <PixRecebidos contas={contas.data ?? []} /> : <>
      <div className="busca">
        <input placeholder="Buscar por descrição ou nome…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={semPessoa} onChange={(e) => setSemPessoa(e.target.checked)} /> Só sem pessoa ligada</label>
        <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={semPlano} onChange={(e) => setSemPlano(e.target.checked)} /> Só sem conta do plano</label>
        <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} aria-label="Período" style={{ maxWidth: 200 }}>
          <option value="">{aba === 'pagos' ? 'Pago em qualquer data' : 'Qualquer vencimento'}</option>
          <option value="hoje">Hoje</option>
          <option value="este_mes">Este mês</option>
          <option value="mes_passado">Mês passado</option>
          <option value="proximo_mes">Próximo mês</option>
          <option value="escolher">Escolher datas…</option>
        </select>
        {periodo === 'escolher' && <><input type="date" aria-label="De" value={deP} onChange={(e) => setDeP(e.target.value)} style={{ maxWidth: 160 }} /><input type="date" aria-label="Até" value={ateP} onChange={(e) => setAteP(e.target.value)} style={{ maxWidth: 160 }} /></>}
        {(busca || periodo || semPessoa || semPlano || evento) && <button type="button" className="botao claro" onClick={() => { setBusca(''); setPeriodo(''); setDeP(''); setAteP(''); setSemPessoa(false); setSemPlano(false); setEvento(''); }}>Limpar filtros</button>}
        {(eventos.data?.length ?? 0) > 0 && (
          <select value={evento} onChange={(e) => setEvento(e.target.value)} aria-label="Evento (centro de custo)" style={{ maxWidth: 240 }}>
            <option value="">Todos os eventos e a operação</option>
            <option value="sem">Sem evento (operação)</option>
            {eventos.data!.map((e) => <option key={e.id} value={e.id}>Evento: {e.nome}</option>)}
          </select>
        )}
      </div>
      {aba === 'renegociados' && (
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {([['', 'Em aberto'], ['avencer', 'A vencer'], ['vencido', 'Vencidas'], ['protestado', 'Protestadas'], ['recebido', 'Recebidas']] as [string, string][]).map(([v, n]) => (
            <button key={v} className={`botao pequeno ${!originais && situacaoReneg === v ? '' : 'claro'}`} onClick={() => { setOriginais(false); setSituacaoReneg(v); }}>{n}</button>
          ))}
          <button className={`botao pequeno ${originais ? '' : 'claro'}`} onClick={() => setOriginais(true)}>Títulos originais transferidos</button>
        </div>
      )}
      {contaFiltro && (
        <div className="aviso" style={{ marginBottom: 12 }}>
          Mostrando só a conta <b>{contaFiltro.codigo} {contaFiltro.nome}</b>. <button className="botao claro pequeno" onClick={() => setParams({})}>Ver todas</button>
        </div>
      )}
      {marcados.length > 0 && (
        <div className="cartao flex" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <b>{marcados.length} marcado(s)</b>
          <div style={{ minWidth: 280 }}><SeletorPlano valor={destino} mudar={setDestino} tipo={tipo} vazio="Classificar em…" /></div>
          <button className="botao pequeno" disabled={!destino || classificar.isPending} onClick={() => classificar.mutate()}>Classificar</button>
          <button className="botao claro pequeno" onClick={() => setMarcados([])}>Desmarcar</button>
          {classificar.error && <Erro erro={classificar.error} />}
        </div>
      )}
      {aba !== 'pagos' && pode('financeiro', 'editar') && (
        <div className="busca">
          <select value={contaId} onChange={(e) => setContaId(e.target.value)}><option value="">Conta para as baixas…</option>{contas.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
          <span className="muted" style={{ alignSelf: 'center' }}>Boleto e Pix são gerados no Asaas; quando a pessoa paga, o título baixa sozinho.</span>
        </div>
      )}
      {(baixar.error || acao.error) && <Erro erro={baixar.error ?? acao.error} />}
      {baixa && (
        <div className="cartao form" style={{ marginBottom: 14 }}>
          <div className="secao">Baixar título de {reais(baixa.total)}</div>
          <Campo rotulo="Valor pago (R$)" ajuda="Em branco = valor cheio"><input inputMode="decimal" autoFocus value={baixa.valor} onChange={(e) => setBaixa({ ...baixa, valor: e.target.value })} /></Campo>
          <Campo rotulo="Data do pagamento"><input type="date" value={baixa.pagoEm} onChange={(e) => setBaixa({ ...baixa, pagoEm: e.target.value })} /></Campo>
          {baixa.valor && paraCentavos(baixa.valor) < baixa.total ? (
            <label className="check l2"><input type="checkbox" checked={baixa.desconto} onChange={(e) => setBaixa({ ...baixa, desconto: e.target.checked })} /> Dar o restante como desconto (sem isso, abre um título com o saldo de {reais(baixa.total - paraCentavos(baixa.valor))})</label>
          ) : <div className="l2" />}
          <div className="flex" style={{ gridColumn: 'span 4' }}><button className="botao" disabled={baixar.isPending} onClick={() => baixar.mutate()}>Confirmar baixa</button><button className="botao claro" onClick={() => setBaixa(null)}>Voltar</button></div>
        </div>
      )}
      {cobranca && (
        <div className="aviso ok" style={{ marginBottom: 12 }}>
          {cobranca.tipo === 'PIX' ? 'Pix' : 'Boleto'} emitido para <b>{cobranca.t.pessoa}</b>, vencimento {data(cobranca.vencimento)}. <a href={cobranca.url} target="_blank" rel="noreferrer">Abrir link de pagamento</a>
          {cobranca.pixCopiaCola && <> · <button className="botao claro pequeno" onClick={async () => { try { await navigator.clipboard.writeText(cobranca.pixCopiaCola); } catch { window.prompt('Pix copia e cola:', cobranca.pixCopiaCola); } }}>Copiar Pix copia e cola</button></>}
          <div className="flex" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {cobranca.url && <ConversaCobranca pessoaId={cobranca.t.pessoaId} url={cobranca.url} valor={cobranca.t.valor} vencimento={cobranca.vencimento} tipo={cobranca.tipo} />}
            <button className="botao claro pequeno" onClick={() => setCobranca(null)}>Fechar</button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>O link fica guardado na ficha da pessoa (aba Financeiro), com a situação.</div>
        </div>
      )}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.itens.length === 0 ? <div className="cartao vazio">Nada nesta aba.</div> : (
        <table className="tabela">
          <thead><tr>{pode('financeiro', 'editar') && <th style={{ width: 28 }}><input type="checkbox" aria-label="Marcar todos" checked={marcados.length > 0 && q.data!.itens.every((t) => marcados.includes(t.id))} onChange={(e) => setMarcados(e.target.checked ? q.data!.itens.map((t) => t.id) : [])} /></th>}<th>Vencimento</th><th>Descrição</th><th>Conta do plano</th><th>{tipo === 'receber' ? 'Quem paga' : 'Fornecedor'}</th><th>Forma</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {q.data!.itens.map((t) => (
              <tr key={t.id}>
                {pode('financeiro', 'editar') && <td><input type="checkbox" aria-label={`Marcar ${t.descricao}`} checked={marcados.includes(t.id)} onChange={() => setMarcados((m) => (m.includes(t.id) ? m.filter((x) => x !== t.id) : [...m, t.id]))} /></td>}
                <td>{data(t.vencimento)}</td>
                <td>{t.descricao}{t.centroCusto && <> <span className="etiqueta neutra" title="Centro de custo">Evento: {t.centroCusto}</span></>}</td>
                <td>
                  {t.planoNome ? <span title={t.planoCodigo}>{t.planoNome}</span> : <span className="etiqueta alerta">Sem conta</span>}
                  {pode('financeiro', 'editar') && <> <button className="botao claro pequeno" onClick={() => setEditando(t)}>Editar</button></>}
                </td>
                <td>
                  {t.pessoaId ? <Link to={`/rede/${t.pessoaId}`}>{t.pessoa}</Link> : ['debito', 'credito'].includes(t.formaPagamento) ? 'Maquininha' : '—'}
                  {!t.pessoaId && ['aberto', 'protestado'].includes(t.status) && !t.cobrancaUrl && pode('financeiro', 'editar') && (
                    ligando === t.id ? <LigarPessoa tituloId={t.id} sugestao={sugestaoDe(t.descricao)} fechar={() => setLigando(null)} /> : <> <button className="botao claro pequeno" onClick={() => setLigando(t.id)}>Ligar pessoa</button></>
                  )}
                </td>
                <td>{t.formaPagamento ?? '—'}</td>
                <td className="num">{reais(t.valor)}</td>
                <td>{t.status === 'pago' ? <span className="etiqueta ok">Pago {data(t.pagoEm)}</span> : t.diasAtraso > 0 ? <span className="etiqueta erro">{t.diasAtraso} dias</span> : <span className="etiqueta alerta">A vencer</span>}</td>
                <td>
                  <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {t.cobrancaUrl && <a className="botao claro pequeno" href={t.cobrancaUrl} target="_blank" rel="noreferrer">{t.cobrancaTipo === 'PIX' ? 'Pix' : 'Boleto'}</a>}
                    {t.status === 'aberto' && tipo === 'receber' && t.pessoaId && !t.cobrancaUrl && !['debito', 'credito'].includes(t.formaPagamento) && pode('financeiro', 'editar') && (
                      <>
                        {emitindo?.t.id === t.id ? (
                          <EmitirCobranca titulo={t} tipo={emitindo!.tipo} fechar={() => setEmitindo(null)} aoEmitir={(r) => { const tipoE = emitindo!.tipo; setEmitindo(null); setCobranca({ ...r, t, tipo: tipoE, vencimento: r.vencimento }); window.scrollTo(0, 0); }} />
                        ) : (
                          <>
                            <button className="botao claro pequeno" onClick={() => setEmitindo({ t, tipo: 'PIX' })}>Gerar Pix</button>
                            <button className="botao claro pequeno" onClick={() => setEmitindo({ t, tipo: 'BOLETO' })}>Gerar boleto</button>
                          </>
                        )}
                      </>
                    )}
                    {t.status === 'aberto' && pode('financeiro', 'editar') && <button className="botao claro pequeno" onClick={() => { setBaixa({ id: t.id, valor: '', pagoEm: '', desconto: false, total: t.valor }); window.scrollTo(0, 0); }}>Baixar</button>}
                    {t.status === 'aberto' && pode('financeiro', 'excluir') && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => pedirMotivo(t.id, 'cancelar')}>Cancelar</button>}
                    {t.status === 'pago' && pode('financeiro', 'excluir') && !(t.cobrancaUrl && ['pix', 'boleto'].includes(t.formaPagamento)) && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => pedirMotivo(t.id, 'estornar')}>Estornar</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={pode('financeiro', 'editar') ? 6 : 5}>Total{q.data!.quantidade > q.data!.itens.length ? ` (${q.data!.quantidade} títulos; a lista mostra os ${q.data!.itens.length} primeiros, use a busca)` : ` (${q.data!.quantidade} títulos)`}</td><td className="num">{reais(q.data!.total)}</td><td colSpan={2}></td></tr></tfoot>
        </table>
      )}
      </>}
      {novo && <Lancamento tipoInicial={tipo} contas={contas.data ?? []} fechar={() => setNovo(false)} />}
      {editando && <Lancamento titulo={editando} tipoInicial={tipo} contas={contas.data ?? []} fechar={() => setEditando(null)} />}
    </>
  );
}

const hojeISO = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

/** Lançamento novo (receita ou despesa, parcelado ou já pago) ou correção de um título que existe. */
export function Lancamento({ titulo, tipoInicial, contas, fechar, centroCustoInicial }: { titulo?: any; tipoInicial: 'receber' | 'pagar'; contas: any[]; fechar: () => void; centroCustoInicial?: string }) {
  const qc = useQueryClient();
  const empresas = useQuery({ queryKey: ['empresas'], queryFn: () => api<any[]>('/empresas') });
  const eventos = usarEventos();
  const visao = usarVisao();
  const [f, setF] = useState({
    centroCustoId: titulo?.centroCustoId ?? centroCustoInicial ?? '',
    tipo: tipoInicial, empresaId: visao, descricao: titulo?.descricao ?? '', planoContaId: titulo?.planoContaId ?? '', valor: titulo ? (titulo.valor / 100).toFixed(2).replace('.', ',') : '',
    vencimento: titulo?.vencimento ?? hojeISO(), parcelas: '1', formaPagamento: '', pago: false, pagoEm: hojeISO(), contaId: '',
    repetir: false, meses: '12', pessoaId: '',
  });
  const fornecedores = useQuery({ queryKey: ['pessoas', 'fornecedor'], queryFn: () => api<{ itens: { id: string; nome: string }[] }>('/pessoas?tipo=fornecedor&limite=500').then((r) => r.itens).catch(() => []), enabled: !titulo && f.tipo === 'pagar', staleTime: 60_000 });
  const travado = !!titulo && (titulo.status !== 'aberto' || !!titulo.cobrancaUrl);
  const salvar = useMutation({
    mutationFn: () => titulo
      ? api(`/financeiro/titulos/${titulo.id}`, { metodo: 'PATCH', corpo: { descricao: f.descricao, planoContaId: f.planoContaId || null, centroCustoId: f.centroCustoId || null, ...(travado ? {} : { vencimento: f.vencimento, ...(titulo.origemTipo ? {} : { valor: paraCentavos(f.valor) }) }) } })
      : api('/financeiro/titulos', { corpo: { empresaId: f.empresaId || empresas.data?.[0]?.id, tipo: f.tipo, descricao: f.descricao, planoContaId: f.planoContaId || null, centroCustoId: f.centroCustoId || null, valor: paraCentavos(f.valor), vencimento: f.pago ? f.pagoEm : f.vencimento, parcelas: f.pago || f.repetir ? 1 : Number(f.parcelas) || 1, repetirMeses: !f.pago && f.repetir ? Number(f.meses) || 12 : null, pessoaId: f.pessoaId || null, formaPagamento: f.formaPagamento || null, ...(f.pago ? { pagoEm: f.pagoEm, contaId: f.contaId || null } : {}) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['contas'] }); qc.invalidateQueries({ queryKey: ['dre'] }); qc.invalidateQueries({ queryKey: ['plano-contas'] }); qc.invalidateQueries({ queryKey: ['eventos-resultado'] }); fechar(); },
  });
  const erros = camposComErro(salvar.error);
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h3 style={{ marginTop: 0 }}>{titulo ? 'Editar lançamento' : 'Novo lançamento'}</h3>
        <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {!titulo && (
            <Campo rotulo="Tipo">
              <select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value as 'receber' | 'pagar', planoContaId: '' })}>
                <option value="pagar">Despesa (a pagar)</option>
                <option value="receber">Receita (a receber)</option>
              </select>
            </Campo>
          )}
          {!titulo && (empresas.data?.length ?? 0) > 1 && (
            <Campo rotulo="Empresa" erro={erros.empresaId}><select value={f.empresaId || empresas.data?.[0]?.id} onChange={(e) => setF({ ...f, empresaId: e.target.value })}>{empresas.data?.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select></Campo>
          )}
          <Campo rotulo="Descrição" erro={erros.descricao} className="l2"><input autoFocus maxLength={200} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder={f.tipo === 'pagar' ? 'Ex.: Aluguel da matriz · novembro' : 'Ex.: Conserto de colar'} /></Campo>
          <Campo rotulo="Conta do plano de contas" erro={erros.planoContaId} className="l2" ajuda="É o que define em que linha da DRE o lançamento aparece."><SeletorPlano valor={f.planoContaId} mudar={(id) => setF({ ...f, planoContaId: id })} tipo={titulo ? titulo.tipo ?? tipoInicial : f.tipo} /></Campo>
          {(eventos.data?.length ?? 0) > 0 && (
            <Campo rotulo="Evento (centro de custo)" erro={erros.centroCustoId} className="l2" ajuda="Despesa ou receita de um evento entra no resultado dele (Lojas e eventos › Eventos).">
              <select value={f.centroCustoId} onChange={(e) => setF({ ...f, centroCustoId: e.target.value })}>
                <option value="">Nenhum (operação normal)</option>
                {eventos.data!.filter((e) => e.ativo || e.id === f.centroCustoId).map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
            </Campo>
          )}
          <Campo rotulo="Valor (R$)" erro={erros.valor} ajuda={titulo?.origemTipo ? 'Veio de uma venda, acerto ou acordo: não muda aqui.' : undefined}><input inputMode="decimal" disabled={travado || !!titulo?.origemTipo} value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} placeholder="0,00" /></Campo>
          {!f.pago && <Campo rotulo="Vencimento" erro={erros.vencimento}><input type="date" disabled={travado} value={f.vencimento} onChange={(e) => setF({ ...f, vencimento: e.target.value })} /></Campo>}
          {!titulo && !f.pago && !f.repetir && <Campo rotulo="Parcelas" erro={erros.parcelas} ajuda="Divide o valor, uma por mês, a partir do vencimento."><input type="number" min={1} max={48} value={f.parcelas} onChange={(e) => setF({ ...f, parcelas: e.target.value })} /></Campo>}
          {!titulo && !f.pago && f.repetir && <Campo rotulo="Por quantos meses" erro={erros.repetirMeses} ajuda="O mesmo valor todo mês, no mesmo dia."><input type="number" min={2} max={36} value={f.meses} onChange={(e) => setF({ ...f, meses: e.target.value })} /></Campo>}
          {!titulo && !f.pago && <label className="check l2"><input type="checkbox" checked={f.repetir} onChange={(e) => setF({ ...f, repetir: e.target.checked, parcelas: '1' })} /> Repetir todo mês (conta fixa: aluguel, prestador, mensalidade)</label>}
          {!titulo && f.tipo === 'pagar' && (
            <Campo rotulo="Fornecedor / prestador" className="l2" ajuda="Cadastre em Cadastros › Fornecedores se ainda não existir.">
              <select value={f.pessoaId} onChange={(e) => setF({ ...f, pessoaId: e.target.value })}><option value="">Nenhum</option>{fornecedores.data?.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select>
            </Campo>
          )}
          {!titulo && <label className="check l2"><input type="checkbox" checked={f.pago} onChange={(e) => setF({ ...f, pago: e.target.checked })} /> {f.tipo === 'pagar' ? 'Já foi paga' : 'Já foi recebida'}</label>}
          {!titulo && f.pago && <>
            <Campo rotulo={f.tipo === 'pagar' ? 'Paga em' : 'Recebida em'} erro={erros.pagoEm}><input type="date" max={hojeISO()} value={f.pagoEm} onChange={(e) => setF({ ...f, pagoEm: e.target.value })} /></Campo>
            <Campo rotulo="Conta bancária ou caixa" erro={erros.contaId}><select value={f.contaId} onChange={(e) => setF({ ...f, contaId: e.target.value })}><option value="">Escolha…</option>{contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Campo>
          </>}
        </div>
        {travado && <p className="muted">Este título está {titulo.status === 'aberto' ? 'com boleto ou Pix emitido' : titulo.status}: só a descrição e a conta do plano mudam aqui.</p>}
        {salvar.error && <Erro erro={salvar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={salvar.isPending || f.descricao.trim().length < 2 || (!titulo && (!f.valor || (f.pago && !f.contaId)))} onClick={() => salvar.mutate()}>Salvar</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

/** Nome do contato que veio do Jueri no fim da descrição ("… · Maria da Silva"). */
function sugestaoDe(descricao: string) {
  const i = descricao.lastIndexOf(' · ');
  return i >= 0 ? descricao.slice(i + 3).replace(/\s*\(saldo após pagamento parcial\)$/, '').trim() : '';
}

/** Procura a revendedora ou cliente e liga ao título. */
function LigarPessoa({ tituloId, sugestao, fechar }: { tituloId: string; sugestao: string; fechar: () => void }) {
  const qc = useQueryClient();
  const [busca, setBusca] = useState(sugestao);
  const termo = busca.trim();
  const achadas = useQuery({
    queryKey: ['ligar-pessoa', termo],
    enabled: termo.length >= 2,
    queryFn: async () => {
      const [r, c] = await Promise.all(['representante', 'cliente'].map((tipo) => api<{ itens: any[] }>(`/pessoas?tipo=${tipo}&busca=${encodeURIComponent(termo)}`).catch(() => ({ itens: [] }))));
      return [...r.itens.map((p) => ({ ...p, tipoNome: 'revendedora' })), ...c.itens.map((p) => ({ ...p, tipoNome: 'cliente' }))].slice(0, 8);
    },
  });
  const ligar = useMutation({
    mutationFn: (pessoaId: string) => api(`/financeiro/titulos/${tituloId}/pessoa`, { corpo: { pessoaId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['titulos'] }); fechar(); },
  });
  return (
    <div className="coluna" style={{ gap: 4, marginTop: 6, minWidth: 240 }}>
      <input autoFocus placeholder="Nome, CPF ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} />
      {achadas.data?.map((p) => (
        <button key={p.id} className="botao claro pequeno" style={{ justifyContent: 'flex-start' }} disabled={ligar.isPending} onClick={() => ligar.mutate(p.id)}>
          {p.nome} <span className="muted">· {p.tipoNome}{p.cidade ? ` · ${p.cidade}` : ''}</span>
        </button>
      ))}
      {termo.length >= 2 && achadas.data?.length === 0 && <span className="muted">Ninguém com esse nome.</span>}
      {ligar.error && <Erro erro={ligar.error} />}
      <button className="botao claro pequeno" onClick={fechar}>Voltar</button>
    </div>
  );
}

interface ResumoCarteira {
  normal: { aVencer: number; aVencerN: number; vencido: number; vencidoN: number; protestado: number; protestadoN: number; total: number };
  renegociado: { transferido: number; transferidoN: number; acordosAtivos: number; valorAcordos: number; recebido: number; aVencer: number; aVencerN: number; vencido: number; vencidoN: number; protestado: number; protestadoN: number; total: number };
  consolidado: { aVencer: number; vencido: number; protestado: number; total: number };
}

/** Carteira a receber em três blocos: o normal, o renegociado (chance menor de receber) e o consolidado. */
function ResumoReceber({ visao, irPara }: { visao: string; irPara: (aba: 'abertos' | 'vencidos' | 'renegociados', situacao?: string) => void }) {
  const q = useQuery({ queryKey: ['titulos', 'resumo-receber', visao], queryFn: () => api<ResumoCarteira>(`/financeiro/receber/resumo${visao ? `?empresaId=${visao}` : ''}`) });
  if (!q.data) return null;
  const { normal: n, renegociado: r, consolidado: c } = q.data;
  const pct = (v: number, t: number) => (t ? ` · ${Math.round((v / t) * 100)}%` : '');
  const linha = (rotulo: string, valor: number, qtd: number | null, cor?: string, acao?: () => void) => (
    <div className="resumo-linha" style={{ cursor: acao ? 'pointer' : undefined }} onClick={acao}>
      <span>{rotulo}{qtd !== null ? <span className="muted"> ({qtd})</span> : null}</span>
      <b style={{ color: cor }}>{reais(valor)}</b>
    </div>
  );
  return (
    <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 14, alignItems: 'start' }}>
      <div className="cartao">
        <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>A receber (normal)</div>
        <div style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 8px' }}>{reais(n.total)}</div>
        {linha('A vencer', n.aVencer, n.aVencerN, undefined, () => irPara('abertos'))}
        {linha('Vencido', n.vencido, n.vencidoN, n.vencido ? 'var(--erro)' : undefined, () => irPara('vencidos'))}
        {linha('Protestado', n.protestado, n.protestadoN)}
      </div>
      <div className="cartao" style={{ borderLeft: '4px solid var(--dourado)' }}>
        <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Renegociado <span style={{ textTransform: 'none' }}>(chance menor de receber)</span></div>
        <div style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 8px' }}>{reais(r.total)} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>a receber dos acordos</span></div>
        {linha('Transferido para renegociação', r.transferido, r.transferidoN, undefined, () => irPara('renegociados', 'originais'))}
        <div className="muted" style={{ fontSize: 12, margin: '-2px 0 6px' }}>{r.acordosAtivos} acordo(s) ativo(s) somando {reais(r.valorAcordos)} · já recebido {reais(r.recebido)}</div>
        {linha('A vencer', r.aVencer, r.aVencerN, undefined, () => irPara('renegociados', 'avencer'))}
        {linha('Vencido', r.vencido, r.vencidoN, r.vencido ? 'var(--erro)' : undefined, () => irPara('renegociados', 'vencido'))}
        {linha('Protestado', r.protestado, r.protestadoN, undefined, () => irPara('renegociados', 'protestado'))}
      </div>
      <div className="cartao" style={{ background: 'var(--marrom, #5c4a3c)', color: '#faf6ef' }}>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.8 }}>Consolidado</div>
        <div style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 8px' }}>{reais(c.total)}</div>
        <div className="resumo-linha"><span>A vencer</span><b>{reais(c.aVencer)}{pct(c.aVencer, c.total)}</b></div>
        <div className="resumo-linha"><span>Vencido</span><b>{reais(c.vencido)}{pct(c.vencido, c.total)}</b></div>
        <div className="resumo-linha"><span>Protestado</span><b>{reais(c.protestado)}{pct(c.protestado, c.total)}</b></div>
        <div className="resumo-linha" style={{ opacity: 0.85 }}><span>Sendo renegociado</span><b>{reais(r.total)}{pct(r.total, c.total)}</b></div>
      </div>
    </div>
  );
}
