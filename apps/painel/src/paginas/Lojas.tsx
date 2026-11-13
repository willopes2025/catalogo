import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { centavosParaTexto, dataHora, paraCentavos, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';
import { FORMAS, PontoDeVenda } from '../componentes/PontoDeVenda';

const nomeForma = (f: string) => FORMAS.find((x) => x[0] === f)?.[1] ?? f;
const CHAVE_LOCAL = 'aritana.pdv.local';

/** Lojas e eventos: caixa do dia e frente de caixa. */
export function Lojas() {
  const qc = useQueryClient();
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const pontos = (locais.data ?? []).filter((l) => l.tipo === 'loja' || l.tipo === 'evento');
  const [localId, setLocalId] = useState(() => { try { return localStorage.getItem(CHAVE_LOCAL) ?? ''; } catch { return ''; } });
  useEffect(() => { if ((!localId || (pontos.length && !pontos.some((p) => p.id === localId))) && pontos.length) setLocalId((pontos.find((p) => p.tipo === 'loja') ?? pontos[0]).id); }, [pontos, localId]);
  useEffect(() => { try { if (localId) localStorage.setItem(CHAVE_LOCAL, localId); } catch { /* sem armazenamento */ } }, [localId]);
  const [aba, setAba] = useState<'vender' | 'caixa' | 'historico'>('vender');
  const [ultima, setUltima] = useState<any | null>(null);
  const caixa = useQuery({ queryKey: ['caixa-atual', localId], queryFn: () => api<any>(`/caixas/atual?localId=${localId}`), enabled: !!localId });
  const local = pontos.find((p) => p.id === localId);

  return (
    <>
      <Topo
        eb="Lojas e eventos"
        titulo="Frente de caixa"
        acoes={
          <select value={localId} onChange={(e) => { setLocalId(e.target.value); setUltima(null); }} style={{ minWidth: 220 }}>
            {pontos.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        }
        sub={caixa.data?.aberto ? <><span className="etiqueta ok">Caixa aberto</span> &nbsp; desde {dataHora(caixa.data.abertoEm)} · {caixa.data.vendas} vendas · {reais(caixa.data.totalVendas)}</> : caixa.data ? <span className="etiqueta neutra">Caixa fechado</span> : undefined}
      />
      {!localId || caixa.isLoading ? <Carregando /> : !caixa.data?.aberto ? (
        <AbrirCaixa localId={localId} nome={local?.nome ?? ''} />
      ) : (
        <>
          <Abas ativa={aba} mudar={setAba} abas={[['vender', 'Vender'], ['caixa', 'Caixa do dia'], ['historico', 'Caixas anteriores']]} />
          {aba === 'vender' && (
            <>
              {ultima && (
                <div className="aviso ok flex entre" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
                  <span>Venda nº <b>{ultima.numero}</b> registrada · {reais(ultima.total)}{ultima.troco ? <> · <b>troco {reais(ultima.troco)}</b></> : ''}</span>
                  <span className="flex">
                    <BotaoNfce vendaId={ultima.id} />
                    <a className="botao claro pequeno" href={`/imprimir/venda/${ultima.id}`} target="_blank" rel="noreferrer">Recibo</a>
                    <Link className="botao claro pequeno" to={`/vendas/${ultima.id}`}>Detalhes</Link>
                  </span>
                </div>
              )}
              {pode('lojas', 'criar') ? <PontoDeVenda localId={localId} tipo="balcao" aoConcluir={(v) => { setUltima(v); qc.invalidateQueries({ queryKey: ['caixa-atual', localId] }); }} /> : <div className="aviso alerta">Sem permissão para vender.</div>}
            </>
          )}
          {aba === 'caixa' && <CaixaDoDia caixa={caixa.data} />}
          {aba === 'historico' && <HistoricoCaixas localId={localId} />}
        </>
      )}
    </>
  );
}

function AbrirCaixa({ localId, nome }: { localId: string; nome: string }) {
  const qc = useQueryClient();
  const [valor, setValor] = useState('');
  const abrir = useMutation({ mutationFn: () => api('/caixas/abrir', { corpo: { localId, valorAbertura: paraCentavos(valor || '0') } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['caixa-atual', localId] }) });
  return (
    <div className="cartao coluna" style={{ maxWidth: 460 }}>
      <h2>Abrir o caixa · {nome}</h2>
      <p className="muted">Conte o dinheiro do troco antes de começar.</p>
      <Campo rotulo="Troco inicial (R$)"><input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" autoFocus /></Campo>
      {abrir.error && <Erro erro={abrir.error} />}
      <button className="botao" disabled={!pode('lojas', 'criar') || abrir.isPending} onClick={() => abrir.mutate()}>Abrir caixa</button>
    </div>
  );
}

function CaixaDoDia({ caixa }: { caixa: any }) {
  const qc = useQueryClient();
  const [mov, setMov] = useState({ tipo: 'sangria', valor: '', descricao: '' });
  const formas = Object.keys(caixa.porForma);
  const [contado, setContado] = useState<Record<string, string>>({});
  const [obs, setObs] = useState('');
  const atualizar = () => qc.invalidateQueries({ queryKey: ['caixa-atual'] });
  const movimentar = useMutation({ mutationFn: () => api(`/caixas/${caixa.id}/movimento`, { corpo: { tipo: mov.tipo, valor: paraCentavos(mov.valor || '0'), descricao: mov.descricao } }), onSuccess: () => { setMov({ ...mov, valor: '', descricao: '' }); atualizar(); } });
  const fechar = useMutation({ mutationFn: () => api<any>(`/caixas/${caixa.id}/fechar`, { corpo: { contado: Object.fromEntries(formas.map((f) => [f, paraCentavos(contado[f] ?? '0')])), observacao: obs || null } }), onSuccess: atualizar });
  const dif = formas.reduce((a, f) => a + paraCentavos(contado[f] ?? '0') - caixa.porForma[f], 0);
  return (
    <div className="grade g2" style={{ alignItems: 'start' }}>
      <div className="coluna">
        <div className="grade g2">
          {formas.map((f) => <Indicador key={f} rotulo={nomeForma(f)} valor={reais(caixa.porForma[f])} detalhe={f === 'dinheiro' ? 'na gaveta' : 'esperado'} tipo={f === 'dinheiro' ? 'destaque' : undefined} />)}
        </div>
        <div className="cartao form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="secao" style={{ gridColumn: 'span 2' }}>Sangria ou reforço</div>
          <Campo rotulo="Tipo"><select value={mov.tipo} onChange={(e) => setMov({ ...mov, tipo: e.target.value })}><option value="sangria">Sangria (retirar)</option><option value="reforco">Reforço (colocar)</option></select></Campo>
          <Campo rotulo="Valor (R$)"><input inputMode="decimal" value={mov.valor} onChange={(e) => setMov({ ...mov, valor: e.target.value })} /></Campo>
          <Campo rotulo="Motivo" className="l2" ><input value={mov.descricao} onChange={(e) => setMov({ ...mov, descricao: e.target.value })} placeholder="Ex.: depósito no banco" /></Campo>
          <div style={{ gridColumn: 'span 2' }}>{movimentar.error && <Erro erro={movimentar.error} />}<button className="botao claro" disabled={!mov.valor || mov.descricao.length < 3 || movimentar.isPending} onClick={() => movimentar.mutate()}>Registrar</button></div>
        </div>
        <div className="cartao">
          <h3 style={{ marginBottom: 8 }}>Movimentos</h3>
          {caixa.movimentos.slice().reverse().map((m: any) => <div key={m.id} className="resumo-linha"><span>{dataHora(m.criadoEm)} · {m.descricao ?? m.tipo} · {nomeForma(m.forma)}</span><b style={{ color: m.valor < 0 ? 'var(--erro)' : undefined }}>{reais(m.valor)}</b></div>)}
        </div>
      </div>
      <div className="cartao coluna">
        <h3>Fechar o caixa</h3>
        <p className="muted">Conte o dinheiro da gaveta e confira os comprovantes de cada forma.</p>
        {formas.map((f) => (
          <div key={f} className="flex entre">
            <span style={{ flex: 1 }}>{nomeForma(f)} <span className="muted">(esperado {reais(caixa.porForma[f])})</span></span>
            <input style={{ maxWidth: 130, textAlign: 'right' }} inputMode="decimal" placeholder={centavosParaTexto(caixa.porForma[f])} value={contado[f] ?? ''} onChange={(e) => setContado({ ...contado, [f]: e.target.value })} />
          </div>
        ))}
        <div className="resumo-linha total"><span>Diferença</span><span style={{ color: dif ? 'var(--erro)' : 'var(--ok)' }}>{reais(dif)}</span></div>
        <Campo rotulo="Observação"><input value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
        {fechar.error && <Erro erro={fechar.error} />}
        <button className="botao" disabled={formas.some((f) => contado[f] === undefined || contado[f] === '') || fechar.isPending} onClick={() => fechar.mutate()}>Fechar caixa</button>
      </div>
    </div>
  );
}

function HistoricoCaixas({ localId }: { localId: string }) {
  const q = useQuery({ queryKey: ['caixas', localId], queryFn: () => api<any[]>(`/caixas?localId=${localId}`) });
  if (q.isLoading) return <Carregando />;
  return (
    <table className="tabela">
      <thead><tr><th>Abertura</th><th>Fechamento</th><th>Quem abriu</th><th className="num">Esperado</th><th className="num">Diferença</th><th>Situação</th></tr></thead>
      <tbody>
        {q.data!.map((c) => {
          const esp = c.esperado ? Object.values(c.esperado as Record<string, number>).reduce((a, b) => a + b, 0) : null;
          return <tr key={c.id}><td>{dataHora(c.abertoEm)}</td><td>{dataHora(c.fechadoEm)}</td><td>{c.abertoPor}</td><td className="num">{esp != null ? reais(esp) : '—'}</td><td className="num">{c.diferenca != null ? <span style={{ color: c.diferenca ? 'var(--erro)' : undefined }}>{reais(c.diferenca)}</span> : '—'}</td><td>{c.status === 'aberto' ? <span className="etiqueta ok">Aberto</span> : <span className="etiqueta neutra">Fechado</span>}</td></tr>;
        })}
      </tbody>
    </table>
  );
}

export function BotaoNfce({ vendaId }: { vendaId: string }) {
  const [r, setR] = useState<any>(null);
  const emitir = useMutation({ mutationFn: () => api<any>(`/fiscal/nfce/venda/${vendaId}`, { corpo: {} }), onSuccess: setR });
  if (!pode('fiscal', 'criar')) return null;
  if (r?.status === 'autorizada') return <a className="botao pequeno" href={r.urlDanfe} target="_blank" rel="noreferrer">Cupom fiscal nº {r.numero}</a>;
  return (
    <>
      <button className="botao claro pequeno" onClick={() => emitir.mutate()} disabled={emitir.isPending}>{emitir.isPending ? 'Emitindo…' : 'Emitir NFC-e'}</button>
      {(emitir.error || r?.status === 'erro') && <span className="muted" style={{ color: 'var(--erro)' }}>{(emitir.error as any)?.dados?.mensagem ?? r?.mensagem}</span>}
    </>
  );
}
