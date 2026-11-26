import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { data, reais } from '../formato';
import { Campo, Carregando, Erro, Indicador, Topo, camposComErro } from '../componentes/ui';
import { Lancamento } from './Financeiro';
import { usarVisao } from '../visao';

interface Evento { id: string; nome: string; empresaId: string; empresa: string; inicio: string | null; fim: string | null; cidade: string | null; observacao: string | null; ativo: boolean }
interface Resultado { id: string; nome: string; vendas: number; qtdVendas: number; descontos: number; devolvido: number; cmv: number; despesas: number; despesasAbertas: number; outrasReceitas: number; resultado: number; margemPb: number | null; primeiraVenda: string | null; ultimaVenda: string | null }

const pct = (pb: number | null) => (pb === null ? '—' : `${(pb / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const periodoTexto = (e: Evento) => (e.inicio ? (e.fim && e.fim !== e.inicio ? `${data(e.inicio)} a ${data(e.fim)}` : data(e.inicio)) : 'sem data');

/**
 * Eventos: cada evento é um ponto de venda (caixa e estoque próprios) e um centro de custo.
 * O resultado junta as vendas do caixa do evento, o custo das peças vendidas e as despesas lançadas com o evento.
 */
export function Eventos() {
  const visao = usarVisao();
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [form, setForm] = useState<Partial<Evento> | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const verResultado = pode('financeiro', 'ver');
  const eventos = useQuery({ queryKey: ['eventos'], queryFn: () => api<Evento[]>('/eventos') });
  const res = useQuery({
    queryKey: ['eventos-resultado', de, ate, visao],
    queryFn: () => api<{ eventos: Resultado[] }>(`/financeiro/eventos/resultado?${new URLSearchParams({ ...(de ? { de } : {}), ...(ate ? { ate } : {}), ...(visao ? { empresaId: visao } : {}) })}`),
    enabled: verResultado,
  });
  const lista = (eventos.data ?? []).filter((e) => !visao || e.empresaId === visao);
  const porId = new Map((res.data?.eventos ?? []).map((r) => [r.id, r]));
  const soma = (k: keyof Resultado) => lista.reduce((a, e) => a + Number(porId.get(e.id)?.[k] ?? 0), 0);

  return (
    <>
      <Topo
        eb="Lojas e eventos"
        titulo="Eventos"
        sub="Cada evento tem caixa, estoque e centro de custo próprios: vendas, custo das peças e despesas formam o resultado."
        acoes={
          <div className="flex" style={{ flexWrap: 'wrap' }}>
            <Link className="botao claro" to="/lojas">Frente de caixa</Link>
            {pode('lojas', 'editar') && <button className="botao" onClick={() => setForm({ nome: '', ativo: true })}>+ Novo evento</button>}
          </div>
        }
      />
      {form && <FormEvento ev={form} fechar={() => setForm(null)} />}
      {verResultado && (
        <div className="busca">
          <label className="flex" style={{ gap: 6 }}>De <input type="date" value={de} onChange={(e) => setDe(e.target.value)} /></label>
          <label className="flex" style={{ gap: 6 }}>Até <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></label>
          {(de || ate) && <button className="botao claro pequeno" onClick={() => { setDe(''); setAte(''); }}>Tudo</button>}
          <span className="muted" style={{ alignSelf: 'center' }}>{de || ate ? 'Vendas pela data da venda; despesas pelo vencimento.' : 'Sem período: tudo de cada evento.'}</span>
        </div>
      )}
      {verResultado && res.data && lista.length > 0 && (
        <div className="grade g4" style={{ marginBottom: 14 }}>
          <Indicador rotulo="Vendas nos eventos" valor={reais(soma('vendas'))} detalhe={`${soma('qtdVendas')} vendas`} />
          <Indicador rotulo="Custo das peças" valor={reais(soma('cmv'))} />
          <Indicador rotulo="Despesas dos eventos" valor={reais(soma('despesas'))} detalhe={soma('despesasAbertas') ? `${reais(soma('despesasAbertas'))} ainda a pagar` : undefined} />
          <Indicador rotulo="Resultado" valor={reais(soma('resultado'))} tipo={soma('resultado') < 0 ? 'atencao' : 'destaque'} />
        </div>
      )}
      {(eventos.isLoading || res.isLoading) && <Carregando />}
      {(eventos.error || res.error) && <Erro erro={eventos.error ?? res.error} />}
      {eventos.data && !lista.length && <div className="cartao vazio">Nenhum evento cadastrado{visao ? ' nesta empresa' : ''}. Cadastre o evento antes para vender pelo caixa dele e lançar as despesas nele.</div>}
      {lista.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tabela">
            <thead><tr><th>Evento</th>{verResultado && <><th className="num">Vendas</th><th className="num">Custo das peças</th><th className="num">Despesas</th><th className="num">Resultado</th><th className="num">Margem</th></>}<th></th></tr></thead>
            <tbody>
              {lista.map((e) => {
                const r = porId.get(e.id);
                return (
                  <tr key={e.id} className={aberto === e.id ? 'selecionada' : ''}>
                    <td>
                      <b>{e.nome}</b> {!e.ativo && <span className="etiqueta neutra">Encerrado</span>}
                      <div className="muted" style={{ fontSize: 12 }}>{periodoTexto(e)}{e.cidade ? ` · ${e.cidade}` : ''}{eventos.data!.some((x) => x.empresaId !== e.empresaId) ? ` · ${e.empresa}` : ''}</div>
                    </td>
                    {verResultado && (
                      <>
                        <td className="num">{reais(r?.vendas ?? 0)}<div className="muted" style={{ fontSize: 12 }}>{r?.qtdVendas ?? 0} vendas</div></td>
                        <td className="num">{reais(r?.cmv ?? 0)}</td>
                        <td className="num">{reais(r?.despesas ?? 0)}{r?.despesasAbertas ? <div className="muted" style={{ fontSize: 12 }}>{reais(r.despesasAbertas)} a pagar</div> : null}</td>
                        <td className="num"><b style={{ color: (r?.resultado ?? 0) < 0 ? 'var(--erro)' : undefined }}>{reais(r?.resultado ?? 0)}</b></td>
                        <td className="num">{pct(r?.margemPb ?? null)}</td>
                      </>
                    )}
                    <td>
                      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {verResultado && <button className="botao claro pequeno" onClick={() => setAberto(aberto === e.id ? null : e.id)}>{aberto === e.id ? 'Fechar' : 'Detalhes'}</button>}
                        {pode('lojas', 'editar') && <button className="botao claro pequeno" onClick={() => setForm(e)}>Editar</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {aberto && <DetalheEvento id={aberto} de={de} ate={ate} evento={lista.find((e) => e.id === aberto)} />}
    </>
  );
}

function FormEvento({ ev, fechar }: { ev: Partial<Evento>; fechar: () => void }) {
  const qc = useQueryClient();
  const empresas = useQuery({ queryKey: ['empresas'], queryFn: () => api<{ id: string; nome: string; tipo: string }[]>('/empresas') });
  const [f, setF] = useState({ nome: ev.nome ?? '', empresaId: ev.empresaId ?? '', inicio: ev.inicio ?? '', fim: ev.fim ?? '', cidade: ev.cidade ?? '', observacao: ev.observacao ?? '', ativo: ev.ativo ?? true });
  const salvar = useMutation({
    mutationFn: () => {
      const corpo = { nome: f.nome, ...(f.empresaId ? { empresaId: f.empresaId } : {}), inicio: f.inicio || null, fim: f.fim || null, cidade: f.cidade || null, observacao: f.observacao || null, ativo: f.ativo };
      return ev.id ? api(`/eventos/${ev.id}`, { metodo: 'PATCH', corpo }) : api('/eventos', { corpo });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['eventos'] }); qc.invalidateQueries({ queryKey: ['eventos-resultado'] }); qc.invalidateQueries({ queryKey: ['locais'] }); fechar(); },
  });
  const erros = camposComErro(salvar.error);
  return (
    <div className="cartao form" style={{ marginBottom: 14 }}>
      <div className="secao">{ev.id ? `Editar ${ev.nome}` : 'Novo evento'}</div>
      <Campo rotulo="Nome" erro={erros.nome} className="l2"><input autoFocus maxLength={80} value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Bioma · dezembro, Feira de Natal Vila Velha" /></Campo>
      {(empresas.data?.length ?? 0) > 1 && (
        <Campo rotulo="Empresa (CNPJ)" className="l2" ajuda="Sem escolher, o evento fica no CNPJ da matriz.">
          <select value={f.empresaId || empresas.data!.find((e) => e.tipo === 'matriz')?.id || ''} onChange={(e) => setF({ ...f, empresaId: e.target.value })}>{empresas.data!.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select>
        </Campo>
      )}
      <Campo rotulo="Início" erro={erros.inicio}><input type="date" value={f.inicio} onChange={(e) => setF({ ...f, inicio: e.target.value })} /></Campo>
      <Campo rotulo="Fim" erro={erros.fim}><input type="date" value={f.fim} onChange={(e) => setF({ ...f, fim: e.target.value })} /></Campo>
      <Campo rotulo="Cidade / local" className="l2"><input maxLength={80} value={f.cidade} onChange={(e) => setF({ ...f, cidade: e.target.value })} placeholder="Ex.: Shopping Vila Velha" /></Campo>
      <Campo rotulo="Observação" className="l4"><input maxLength={500} value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} /></Campo>
      {ev.id && <label className="check l4"><input type="checkbox" checked={!f.ativo} onChange={(e) => setF({ ...f, ativo: !e.target.checked })} /> Evento encerrado (sai da frente de caixa; precisa estar sem peças e com o caixa fechado)</label>}
      {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
      <div className="flex l4">
        <button className="botao" disabled={salvar.isPending || f.nome.trim().length < 2} onClick={() => salvar.mutate()}>Salvar</button>
        <button className="botao claro" onClick={fechar}>Voltar</button>
      </div>
    </div>
  );
}

function DetalheEvento({ id, de, ate, evento }: { id: string; de: string; ate: string; evento?: Evento }) {
  const [lancar, setLancar] = useState(false);
  const q = useQuery({ queryKey: ['eventos-resultado', id, de, ate], queryFn: () => api<any>(`/financeiro/eventos/resultado?${new URLSearchParams({ localId: id, ...(de ? { de } : {}), ...(ate ? { ate } : {}) })}`) });
  const contas = useQuery({ queryKey: ['contas'], queryFn: () => api<any[]>('/financeiro/contas') });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const r = q.data.evento as Resultado | null;
  if (!r) return null;
  return (
    <div className="cartao" style={{ marginTop: 14 }}>
      <div className="flex entre" style={{ flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{r.nome}{evento ? ` · ${periodoTexto(evento)}` : ''}</h3>
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          {pode('financeiro', 'criar') && <button className="botao pequeno" onClick={() => setLancar(true)}>+ Lançar despesa do evento</button>}
          <Link className="botao claro pequeno" to={`/financeiro?evento=${id}`}>Ver no Financeiro</Link>
          <Link className="botao claro pequeno" to={`/vendas?localId=${id}`}>Ver as vendas</Link>
        </div>
      </div>
      <div className="resumo-linha"><span>Vendas ({r.qtdVendas}){r.devolvido ? `, já sem ${reais(r.devolvido)} de devoluções` : ''}{r.descontos ? ` · descontos dados: ${reais(r.descontos)}` : ''}</span><b>{reais(r.vendas)}</b></div>
      <div className="resumo-linha"><span>Custo das peças vendidas</span><span className="menos">− {reais(r.cmv)}</span></div>
      {q.data.porConta.filter((c: any) => c.tipo === 'pagar').map((c: any) => <div key={c.conta} className="resumo-linha"><span className="muted">Despesa · {c.conta} ({c.qtd})</span><span className="menos">− {reais(c.valor)}</span></div>)}
      {q.data.porConta.filter((c: any) => c.tipo === 'receber').map((c: any) => <div key={c.conta} className="resumo-linha"><span className="muted">Outra receita · {c.conta} ({c.qtd})</span><span className="mais">+ {reais(c.valor)}</span></div>)}
      <div className="resumo-linha total"><span>Resultado do evento{r.margemPb !== null ? ` · margem ${pct(r.margemPb)}` : ''}</span><span>{reais(r.resultado)}</span></div>
      {!q.data.porConta.length && <p className="muted">Nenhuma despesa lançada com este evento ainda. Lance aqui (ou no Financeiro, escolhendo o evento) o espaço, montagem, transporte, alimentação, diárias…</p>}
      {q.data.lancamentos.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer' }}>Lançamentos do evento ({q.data.lancamentos.length})</summary>
          <table className="tabela" style={{ marginTop: 6 }}>
            <thead><tr><th>Vencimento</th><th>Descrição</th><th>Conta</th><th className="num">Valor</th><th>Situação</th></tr></thead>
            <tbody>{q.data.lancamentos.map((t: any) => <tr key={t.id}><td>{data(t.vencimento)}</td><td>{t.tipo === 'receber' ? '(receita) ' : ''}{t.descricao}{t.pessoa ? ` · ${t.pessoa}` : ''}</td><td>{t.conta ?? '—'}</td><td className="num">{reais(t.valor)}</td><td>{t.status === 'pago' ? <span className="etiqueta ok">Pago {t.pagoEm ? data(t.pagoEm) : ''}</span> : <span className="etiqueta alerta">Em aberto</span>}</td></tr>)}</tbody>
          </table>
        </details>
      )}
      {lancar && <Lancamento tipoInicial="pagar" contas={contas.data ?? []} centroCustoInicial={id} fechar={() => setLancar(false)} />}
    </div>
  );
}
