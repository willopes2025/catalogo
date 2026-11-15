import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { dataHora, paraCentavos, reais } from '../formato';
import { Campo, Carregando, Erro } from '../componentes/ui';
import { FORMAS } from '../componentes/PontoDeVenda';

interface Pedido {
  id: string; numero: number; pessoaId: string; consultora: string; modelo: string | null; origem: 'maleta' | 'matriz'; status: 'novo' | 'confirmado' | 'entregue' | 'cancelado';
  clienteNome: string; clienteTelefone: string; clienteCidade: string | null; entrega: string; endereco: string | null; observacao: string | null;
  itens: { produtoId: string; referencia: string; descricao: string; preco: number; quantidade: number }[]; total: number; vendaId: string | null; leadId: string | null; motivoCancelamento: string | null; criadoEm: string;
}
const SIT: Record<Pedido['status'], [string, string]> = { novo: ['Novo', 'alerta'], confirmado: ['Confirmado', ''], entregue: ['Entregue', 'ok'], cancelado: ['Cancelado', 'erro'] };
const ENTREGA: Record<string, string> = { retirar: 'vai retirar', entregar: 'receber em casa', combinar: 'combinar' };

/** Vendas › Pedidos pelo link: pedidos das clientes nos catálogos das consultoras e afiliadas. */
export function PedidosLink() {
  const [status, setStatus] = useState('abertos');
  const [origem, setOrigem] = useState('');
  const [aberto, setAberto] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['pedidos-link', status, origem], queryFn: () => api<Pedido[]>(`/pedidos-link?${new URLSearchParams({ ...(status && { status }), ...(origem && { origem }) })}`), refetchInterval: 60_000 });
  return (
    <div className="coluna" style={{ gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>
        A cliente monta o pedido no catálogo da consultora. Peças da maleta: a própria consultora confirma e entrega pelo portal. Afiliada (ou consultora sem maleta): as peças saem do estoque da matriz, a equipe fatura aqui e a comissão entra no fechamento do mês.
      </p>
      <div className="busca">
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="abertos">Em aberto</option><option value="entregue">Entregues</option><option value="cancelado">Cancelados</option><option value="">Todos</option></select>
        <select value={origem} onChange={(e) => setOrigem(e.target.value)}><option value="">Matriz e maletas</option><option value="matriz">Atendidos pela matriz</option><option value="maleta">Da maleta da consultora</option></select>
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : !q.data!.length ? <div className="cartao vazio">Nenhum pedido aqui. Os catálogos ficam em Rede › ficha da consultora (link do catálogo).</div> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Quando</th><th>Cliente</th><th>Consultora</th><th>Atende</th><th>Situação</th><th className="num">Total</th></tr></thead>
          <tbody>
            {q.data!.map((p) => [
              <tr key={p.id} className="clicavel" onClick={() => setAberto(aberto === p.id ? null : p.id)}>
                <td><b>{p.numero}</b></td>
                <td>{dataHora(p.criadoEm)}</td>
                <td>{p.clienteNome}{p.clienteCidade ? <span className="muted"> · {p.clienteCidade}</span> : null}</td>
                <td><Link to={`/rede/${p.pessoaId}`} onClick={(e) => e.stopPropagation()}>{p.consultora}</Link>{p.modelo === 'afiliado' && <span className="etiqueta" style={{ marginLeft: 6 }}>afiliada</span>}</td>
                <td>{p.origem === 'matriz' ? 'Matriz' : 'Maleta dela'}</td>
                <td><span className={`etiqueta ${SIT[p.status][1]}`}>{SIT[p.status][0]}</span></td>
                <td className="num">{reais(p.total)}</td>
              </tr>,
              aberto === p.id && <tr key={`${p.id}-d`}><td colSpan={7} style={{ background: 'var(--fundo)' }}><Detalhe p={p} /></td></tr>,
            ])}
          </tbody>
        </table>
      )}
      {pode('configuracoes', 'editar') && <Regras />}
    </div>
  );
}

function Detalhe({ p }: { p: Pedido }) {
  const qc = useQueryClient();
  const [pag, setPag] = useState({ forma: 'pix', valor: (p.total / 100).toFixed(2).replace('.', ','), parcelas: 1 });
  const [faturando, setFaturando] = useState(false);
  const acao = useMutation({
    mutationFn: ({ rota, corpo }: { rota: string; corpo?: unknown }) => api<any>(`/pedidos-link/${p.id}/${rota}`, { corpo: corpo ?? {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pedidos-link'] }); setFaturando(false); },
  });
  const aberto = p.status === 'novo' || p.status === 'confirmado';
  return (
    <div className="coluna" style={{ gap: 8, padding: '6px 2px' }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        <div>
          {p.itens.map((i) => <div key={i.produtoId} className="flex entre" style={{ gap: 12, padding: '4px 0', borderBottom: '1px dashed var(--linha)' }}><span>{i.quantidade}× {i.descricao} <span className="muted">ref. {i.referencia}</span></span><span style={{ whiteSpace: 'nowrap' }}>{reais(i.preco * i.quantidade)}</span></div>)}
          <div className="flex entre" style={{ gap: 12, padding: '6px 0' }}><b>Total</b><b>{reais(p.total)}</b></div>
        </div>
        <div>
          <div className="par"><span>WhatsApp</span><span><a href={`https://wa.me/${p.clienteTelefone.replace(/\D/g, '').replace(/^(?!55)/, '55')}`} target="_blank" rel="noreferrer">{p.clienteTelefone}</a></span></div>
          <div className="par"><span>Entrega</span><span>{ENTREGA[p.entrega] ?? p.entrega}{p.endereco ? ` · ${p.endereco}` : ''}</span></div>
          {p.observacao && <div className="par"><span>Observação</span><span>{p.observacao}</span></div>}
          {p.leadId && <div className="par"><span>CRM</span><span><Link to={`/crm/lead/${p.leadId}`}>Abrir card</Link></span></div>}
          {p.vendaId && <div className="par"><span>Venda</span><span><Link to={`/vendas/${p.vendaId}`}>Abrir venda</Link></span></div>}
          {p.motivoCancelamento && <div className="par"><span>Motivo</span><span>{p.motivoCancelamento}</span></div>}
        </div>
      </div>
      {aberto && p.origem === 'maleta' && <p className="muted" style={{ margin: 0 }}>Peças da maleta de {p.consultora.split(' ')[0]}: ela confirma e marca como entregue pelo portal.</p>}
      {aberto && pode('vendas', 'editar') && (
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
          {p.status === 'novo' && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'confirmar' })}>Confirmar e avisar a cliente</button>}
          {p.origem === 'matriz' && pode('vendas', 'criar') && !faturando && <button className="botao pequeno" onClick={() => setFaturando(true)}>Faturar</button>}
          <button className="botao claro pequeno perigo" disabled={acao.isPending} onClick={() => { const m = window.prompt('Cancelar o pedido? Motivo (opcional):'); if (m !== null) acao.mutate({ rota: 'cancelar', corpo: { motivo: m || null } }); }}>Cancelar</button>
        </div>
      )}
      {faturando && (
        <div className="cartao form">
          <Campo rotulo="Como a cliente pagou"><select value={pag.forma} onChange={(e) => setPag({ ...pag, forma: e.target.value })}>{FORMAS.filter(([f]) => f !== 'credito_loja').map(([f, n]) => <option key={f} value={f}>{n}</option>)}</select></Campo>
          <Campo rotulo="Valor (R$)"><input inputMode="decimal" value={pag.valor} onChange={(e) => setPag({ ...pag, valor: e.target.value })} /></Campo>
          {pag.forma === 'credito' && <Campo rotulo="Parcelas"><input inputMode="numeric" value={pag.parcelas} onChange={(e) => setPag({ ...pag, parcelas: Math.min(12, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) })} /></Campo>}
          <div className="l4 flex" style={{ gap: 8 }}>
            <button className="botao" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'faturar', corpo: { pagamentos: [{ forma: pag.forma, valor: paraCentavos(pag.valor), ...(pag.forma === 'credito' ? { parcelas: pag.parcelas } : {}) }] } })}>Faturar (sai do estoque)</button>
            <button className="botao claro" onClick={() => setFaturando(false)}>Voltar</button>
          </div>
        </div>
      )}
      {acao.error && <Erro erro={acao.error} />}
      {acao.data?.venda && <div className="aviso ok">Faturado: venda nº {acao.data.venda.numero}.</div>}
    </div>
  );
}

interface RegrasLink { ativo: boolean; localId: string; comissaoPb: number; catalogoMatrizSemMaleta: boolean; aceitaEntrega: boolean; mensagemFinal: string }

function Regras() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'regras_link'], queryFn: () => api<RegrasLink>('/configuracoes/chave/regras_link') });
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<{ id: string; nome: string; tipo: string; ativo: boolean }[]>('/estoque/locais') });
  const [r, setR] = useState<RegrasLink | null>(null);
  useEffect(() => { if (q.data) setR(q.data); }, [q.data]);
  const salvar = useMutation({ mutationFn: () => api('/configuracoes/chave/regras_link', { metodo: 'PUT', corpo: r }), onSuccess: () => qc.invalidateQueries({ queryKey: ['config', 'regras_link'] }) });
  if (!r) return null;
  return (
    <details className="cartao">
      <summary><b>Regras da venda pelo link</b> <span className="muted">· comissão {String(r.comissaoPb / 100).replace('.', ',')}% {r.ativo ? '' : '· pedidos pausados'}</span></summary>
      <div className="form" style={{ marginTop: 10 }}>
        <label className="check l4"><input type="checkbox" checked={r.ativo} onChange={(e) => setR({ ...r, ativo: e.target.checked })} /> Clientes podem fazer pedido pelo catálogo (desligado: só o botão do WhatsApp)</label>
        <Campo rotulo="Comissão da consultora/afiliada (%)" ajuda="Sobre pedidos atendidos pela matriz, no fechamento do mês."><input inputMode="decimal" value={String(r.comissaoPb / 100).replace('.', ',')} onChange={(e) => setR({ ...r, comissaoPb: Math.round(Number(e.target.value.replace(',', '.')) * 100) || 0 })} /></Campo>
        <Campo rotulo="Estoque que atende a matriz" className="l2"><select value={r.localId} onChange={(e) => setR({ ...r, localId: e.target.value })}><option value="">O primeiro depósito</option>{locais.data?.filter((l) => l.ativo && l.tipo !== 'maleta').map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
        <label className="check l2"><input type="checkbox" checked={r.catalogoMatrizSemMaleta} onChange={(e) => setR({ ...r, catalogoMatrizSemMaleta: e.target.checked })} /> Consultora sem maleta mostra as peças da matriz</label>
        <label className="check l2"><input type="checkbox" checked={r.aceitaEntrega} onChange={(e) => setR({ ...r, aceitaEntrega: e.target.checked })} /> Oferecer "receber em casa"</label>
        <Campo rotulo="Mensagem depois do pedido (opcional)" className="l4"><input value={r.mensagemFinal} maxLength={300} onChange={(e) => setR({ ...r, mensagemFinal: e.target.value })} placeholder="Obrigada! A consultora vai falar com você pelo WhatsApp." /></Campo>
        {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
        <div className="l4"><button className="botao pequeno" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar regras</button>{salvar.isSuccess && <span className="muted" style={{ marginLeft: 8 }}>Salvo.</span>}</div>
      </div>
    </details>
  );
}
