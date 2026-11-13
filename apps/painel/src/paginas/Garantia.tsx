import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { data, dataHora, paraCentavos, reais, telefone } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

const STATUS: Record<string, [string, string]> = {
  aberta: ['alerta', 'Aberta'],
  na_assistencia: ['marrom', 'Na assistência'],
  concluida: ['ok', 'Concluída'],
  cancelada: ['neutra', 'Cancelada'],
};
const DECISAO: Record<string, string> = { troca: 'Troca', conserto: 'Conserto', devolucao_fornecedor: 'Devolvida ao fornecedor', recusada: 'Recusada' };

export function Garantia() {
  const [aba, setAba] = useState<'abertas' | 'todas' | 'nova' | 'servicos'>('abertas');
  const [aberta, setAberta] = useState<string | null>(null);
  return (
    <>
      <Topo eb="Garantia e consertos" titulo="Peça com defeito tem dono e prazo" sub="Garantia dentro do prazo, troca, envio para a assistência e conserto pago" />
      <Abas
        ativa={aba}
        mudar={(a) => { setAba(a); setAberta(null); }}
        abas={[['abertas', 'Em andamento'], ['todas', 'Todas'], ...(pode('garantia', 'criar') ? ([['nova', 'Nova ordem']] as [typeof aba, string][]) : []), ['servicos', 'Tabela de consertos']]}
      />
      {aberta ? (
        <DetalheOS id={aberta} voltar={() => setAberta(null)} />
      ) : aba === 'nova' ? (
        <NovaOS criada={(id) => { setAba('abertas'); setAberta(id); }} />
      ) : aba === 'servicos' ? (
        <Servicos />
      ) : (
        <Lista filtro={aba} abrir={setAberta} />
      )}
    </>
  );
}

function Lista({ filtro, abrir }: { filtro: 'abertas' | 'todas'; abrir: (id: string) => void }) {
  const q = useQuery({ queryKey: ['os', filtro], queryFn: () => api<any[]>(`/garantia/ordens${filtro === 'abertas' ? '?status=abertas' : ''}`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const l = q.data!;
  const atrasadas = l.filter((o) => o.previsao && o.previsao < new Date().toISOString().slice(0, 10) && ['aberta', 'na_assistencia'].includes(o.status)).length;
  return (
    <div className="coluna">
      {filtro === 'abertas' && (
        <div className="grade g4">
          <Indicador rotulo="Abertas" valor={l.filter((o) => o.status === 'aberta').length} />
          <Indicador rotulo="Na assistência" valor={l.filter((o) => o.status === 'na_assistencia').length} />
          <Indicador rotulo="Com previsão vencida" valor={atrasadas} tipo={atrasadas ? 'atencao' : undefined} />
        </div>
      )}
      {!l.length ? (
        <div className="cartao vazio">Nenhuma ordem {filtro === 'abertas' ? 'em andamento' : 'registrada'}.</div>
      ) : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Tipo</th><th>Peça</th><th>De quem</th><th>Defeito</th><th>Garantia até</th><th>Previsão</th><th>Situação</th></tr></thead>
          <tbody>
            {l.map((o) => (
              <tr key={o.id} className="clicavel" onClick={() => abrir(o.id)}>
                <td><b>{o.numero}</b></td>
                <td>{o.tipo === 'garantia' ? 'Garantia' : 'Conserto'}</td>
                <td>{o.produto ? <>{o.produto}<div className="muted">ref. {o.referencia}</div></> : '—'}</td>
                <td>{o.cliente ?? o.representante ?? '—'}</td>
                <td className="muted">{o.defeito}</td>
                <td>{data(o.garantiaAte)}</td>
                <td>{data(o.previsao)}{o.prestador && <div className="muted">{o.prestador}</div>}</td>
                <td><span className={`etiqueta ${STATUS[o.status]?.[0]}`}>{STATUS[o.status]?.[1] ?? o.status}</span>{o.decisao && <div className="muted">{DECISAO[o.decisao]}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NovaOS({ criada }: { criada: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ clienteId: '', tipo: 'garantia', origem: 'venda', codigoProduto: '', vendaNumero: '', maletaNumero: '', dataCompra: '', defeito: '', servicoId: '', valor: '', previsao: '', observacao: '' });
  const servicos = useQuery({ queryKey: ['servicos'], queryFn: () => api<any[]>('/garantia/servicos') });
  const m = useMutation({
    mutationFn: () =>
      api<any>('/garantia/ordens', {
        corpo: {
          tipo: f.tipo,
          codigoProduto: f.codigoProduto || null,
          clienteId: f.origem === 'outra' && f.clienteId ? f.clienteId : null,
          vendaNumero: f.origem === 'venda' && f.vendaNumero ? Number(f.vendaNumero) : null,
          maletaNumero: f.origem === 'maleta' && f.maletaNumero ? Number(f.maletaNumero) : null,
          dataCompra: f.dataCompra || null,
          defeito: f.defeito,
          servicoId: f.servicoId || null,
          valor: f.tipo === 'conserto' ? paraCentavos(f.valor || '0') : 0,
          previsao: f.previsao || null,
          observacao: f.observacao || null,
        },
      }),
    onSuccess: (os) => { qc.invalidateQueries({ queryKey: ['os'] }); criada(os.id); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="coluna">
      <div className="cartao form">
        <Campo rotulo="Tipo">
          <select value={f.tipo} onChange={set('tipo')}><option value="garantia">Garantia (defeito no prazo)</option><option value="conserto">Conserto pago</option></select>
        </Campo>
        <Campo rotulo="Código ou referência da peça" ajuda="Bipe a etiqueta, se ainda estiver na peça"><input value={f.codigoProduto} onChange={set('codigoProduto')} /></Campo>
        <Campo rotulo="Onde foi comprada">
          <select value={f.origem} onChange={set('origem')}><option value="venda">Na loja ou evento</option><option value="maleta">Com uma representante</option><option value="outra">Não sei / outra</option></select>
        </Campo>
        {f.origem === 'venda' && <Campo rotulo="Nº da venda (recibo)" ajuda="Preenche a cliente e a data sozinho"><input inputMode="numeric" value={f.vendaNumero} onChange={set('vendaNumero')} /></Campo>}
        {f.origem === 'maleta' && <Campo rotulo="Nº da maleta"><input inputMode="numeric" value={f.maletaNumero} onChange={set('maletaNumero')} /></Campo>}
        {f.origem === 'outra' && <BuscaCliente valor={f.clienteId} mudar={(id) => setF({ ...f, clienteId: id })} />}
        <Campo rotulo="Data da compra" ajuda={f.origem === 'venda' && f.vendaNumero ? 'Vem da venda; preencha só se for diferente' : undefined}><input type="date" value={f.dataCompra} onChange={set('dataCompra')} /></Campo>
        <Campo rotulo="Defeito relatado" className="l2"><input value={f.defeito} onChange={set('defeito')} placeholder="Ex.: banho escurecendo, fecho quebrado" /></Campo>
        <Campo rotulo="Previsão de entrega"><input type="date" value={f.previsao} onChange={set('previsao')} /></Campo>
        {f.tipo === 'conserto' && (
          <>
            <Campo rotulo="Serviço">
              <select value={f.servicoId} onChange={(e) => { const s = servicos.data?.find((x) => x.id === e.target.value); setF({ ...f, servicoId: e.target.value, valor: s ? (s.valor / 100).toFixed(2).replace('.', ',') : f.valor }); }}>
                <option value="">Escolha</option>
                {servicos.data?.filter((s) => s.ativo).map((s) => <option key={s.id} value={s.id}>{s.descricao} · {reais(s.valor)}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Valor cobrado (R$)"><input inputMode="decimal" value={f.valor} onChange={set('valor')} /></Campo>
          </>
        )}
        <Campo rotulo="Observação" className="l2"><input value={f.observacao} onChange={set('observacao')} /></Campo>
      </div>
      {m.error && <Erro erro={m.error} />}
      <div><button className="botao" disabled={f.defeito.length < 3 || m.isPending} onClick={() => m.mutate()}>Abrir ordem</button></div>
    </div>
  );
}

function DetalheOS({ id, voltar }: { id: string; voltar: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['os-detalhe', id], queryFn: () => api<any>(`/garantia/ordens/${id}`) });
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const assist = useQuery({ queryKey: ['assistencias'], queryFn: () => api<any>('/pessoas?tipo=assistencia').then((r) => r.itens as any[]) });
  const [dec, setDec] = useState({ decisao: 'troca', motivo: '', codigoTroca: '', localId: '', receberPeca: true });
  const [envio, setEnvio] = useState({ prestadorId: '', previsao: '' });
  const [pago, setPago] = useState({ valor: '', forma: 'pix' });
  const pronto = () => { qc.invalidateQueries({ queryKey: ['os'] }); qc.invalidateQueries({ queryKey: ['os-detalhe', id] }); };
  const decidir = useMutation({ mutationFn: () => api(`/garantia/ordens/${id}/decisao`, { corpo: { ...dec, motivo: dec.motivo || null, codigoTroca: dec.codigoTroca || null, localId: dec.localId || null } }), onSuccess: pronto });
  const enviar = useMutation({ mutationFn: () => api(`/garantia/ordens/${id}/assistencia`, { corpo: { prestadorId: envio.prestadorId, previsao: envio.previsao || null } }), onSuccess: pronto });
  const concluir = useMutation({ mutationFn: () => api(`/garantia/ordens/${id}/concluir`, { corpo: { valorPago: pago.valor ? paraCentavos(pago.valor) : q.data.valor, formaPagamento: pago.forma } }), onSuccess: pronto });
  const cancelar = useMutation({ mutationFn: (motivo: string) => api(`/garantia/ordens/${id}/cancelar`, { corpo: { motivo } }), onSuccess: pronto });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const o = q.data;
  const ativa = ['aberta', 'na_assistencia'].includes(o.status);
  const erro = decidir.error ?? enviar.error ?? concluir.error ?? cancelar.error;
  return (
    <div className="coluna">
      <div><button className="botao claro pequeno" onClick={voltar}>← Voltar</button></div>
      <div className="cartao">
        <div className="flex entre">
          <h2 style={{ margin: 0 }}>OS nº {o.numero} · {o.tipo === 'garantia' ? 'Garantia' : 'Conserto'}</h2>
          <span className={`etiqueta ${STATUS[o.status]?.[0]}`}>{STATUS[o.status]?.[1]}</span>
        </div>
        <div className="grade g4" style={{ marginTop: 14 }}>
          <div><div className="muted">Peça</div>{o.produto ?? '—'}{o.referencia && <div className="muted">ref. {o.referencia} · {o.codigoBarras}</div>}</div>
          <div><div className="muted">De quem</div>{o.cliente ?? o.representante ?? '—'}{o.clienteTelefone && <div className="muted">{telefone(o.clienteTelefone)}</div>}</div>
          <div>
            <div className="muted">Compra · garantia até</div>
            {data(o.dataCompra)} · {data(o.garantiaAte)}
            {o.dentroDoPrazo === false && <div><span className="etiqueta erro">Fora do prazo</span></div>}
            {o.dentroDoPrazo === true && <div><span className="etiqueta ok">No prazo</span></div>}
          </div>
          <div><div className="muted">Aberta em</div>{dataHora(o.criadoEm)}</div>
        </div>
        <p style={{ marginTop: 14 }}><b>Defeito:</b> {o.defeito}</p>
        {o.servico && <p><b>Serviço:</b> {o.servico} · {reais(o.valor)}</p>}
        {o.prestador && <p><b>Assistência:</b> {o.prestador}{o.previsao && ` · previsão ${data(o.previsao)}`}</p>}
        {o.decisao && <p><b>Decisão:</b> {DECISAO[o.decisao]}{o.motivoDecisao && ` · ${o.motivoDecisao}`}{o.troca && ` · peça entregue: ${o.troca}`}</p>}
        {o.observacao && <p className="muted">{o.observacao}</p>}
      </div>
      {erro && <Erro erro={erro} />}
      {ativa && pode('garantia', 'editar') && (
        <>
          {o.status === 'aberta' && (
            <div className="cartao form">
              <div className="secao">Mandar para a assistência</div>
              <Campo rotulo="Assistência"><select value={envio.prestadorId} onChange={(e) => setEnvio({ ...envio, prestadorId: e.target.value })}><option value="">Escolha</option>{assist.data?.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select></Campo>
              <Campo rotulo="Previsão de volta"><input type="date" value={envio.previsao} onChange={(e) => setEnvio({ ...envio, previsao: e.target.value })} /></Campo>
              <div className="campo"><label>&nbsp;</label><button className="botao claro" disabled={!envio.prestadorId || enviar.isPending} onClick={() => enviar.mutate()}>Enviar</button></div>
            </div>
          )}
          {o.tipo === 'garantia' && !o.decisao && (
            <div className="cartao form">
              <div className="secao">Decisão da garantia</div>
              <Campo rotulo="Decisão">
                <select value={dec.decisao} onChange={(e) => setDec({ ...dec, decisao: e.target.value })}>
                  <option value="troca">Trocar por peça nova</option>
                  <option value="conserto">Consertar</option>
                  <option value="devolucao_fornecedor">Devolver ao fornecedor</option>
                  <option value="recusada">Recusar (mau uso, fora do prazo)</option>
                </select>
              </Campo>
              {dec.decisao === 'troca' && (
                <>
                  <Campo rotulo="Código da peça nova"><input value={dec.codigoTroca} onChange={(e) => setDec({ ...dec, codigoTroca: e.target.value })} placeholder="Bipe a etiqueta" /></Campo>
                  <Campo rotulo="Sai de onde"><select value={dec.localId} onChange={(e) => setDec({ ...dec, localId: e.target.value })}><option value="">Escolha</option>{locais.data?.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
                </>
              )}
              {(dec.decisao === 'recusada' || dec.decisao === 'devolucao_fornecedor') && <Campo rotulo="Motivo" className="l2"><input value={dec.motivo} onChange={(e) => setDec({ ...dec, motivo: e.target.value })} /></Campo>}
              {(dec.decisao === 'troca' || dec.decisao === 'devolucao_fornecedor') && o.produtoId && (
                <label className="check l2"><input type="checkbox" checked={dec.receberPeca} onChange={(e) => setDec({ ...dec, receberPeca: e.target.checked })} /> A peça com defeito ficou conosco (entra em "Avarias e garantia")</label>
              )}
              <div className="campo"><label>&nbsp;</label><button className="botao" disabled={decidir.isPending} onClick={() => decidir.mutate()}>Registrar decisão</button></div>
            </div>
          )}
          {(o.tipo === 'conserto' || o.decisao === 'conserto') && (
            <div className="cartao form">
              <div className="secao">Peça pronta e entregue</div>
              {o.tipo === 'conserto' && o.valor > 0 && (
                <>
                  <Campo rotulo="Valor recebido (R$)" ajuda={`Cobrado: ${reais(o.valor)}. Em branco = valor cheio.`}><input inputMode="decimal" value={pago.valor} onChange={(e) => setPago({ ...pago, valor: e.target.value })} /></Campo>
                  <Campo rotulo="Forma"><select value={pago.forma} onChange={(e) => setPago({ ...pago, forma: e.target.value })}><option value="pix">Pix</option><option value="dinheiro">Dinheiro</option><option value="debito">Débito</option><option value="credito">Crédito</option></select></Campo>
                </>
              )}
              <div className="campo"><label>&nbsp;</label><button className="botao" disabled={concluir.isPending} onClick={() => concluir.mutate()}>Concluir e entregar</button></div>
            </div>
          )}
          {o.status === 'aberta' && !o.decisao && pode('garantia', 'excluir') && (
            <div>
              <button className="botao claro pequeno" onClick={() => { const m = window.prompt('Motivo do cancelamento'); if (m) cancelar.mutate(m); }}>Cancelar ordem</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Servicos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['servicos'], queryFn: () => api<any[]>('/garantia/servicos') });
  const [novo, setNovo] = useState({ descricao: '', valor: '' });
  const criar = useMutation({ mutationFn: () => api('/garantia/servicos', { corpo: { descricao: novo.descricao, valor: paraCentavos(novo.valor || '0') } }), onSuccess: () => { setNovo({ descricao: '', valor: '' }); qc.invalidateQueries({ queryKey: ['servicos'] }); } });
  const editar = useMutation({ mutationFn: ({ id, corpo }: { id: string; corpo: any }) => api(`/garantia/servicos/${id}`, { metodo: 'PATCH', corpo }), onSuccess: () => qc.invalidateQueries({ queryKey: ['servicos'] }) });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      {(criar.error || editar.error) && <Erro erro={criar.error ?? editar.error} />}
      <table className="tabela">
        <thead><tr><th>Serviço</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          {q.data!.map((s) => (
            <tr key={s.id}>
              <td>{s.descricao}</td>
              <td className="num">{reais(s.valor)}</td>
              <td>{s.ativo ? <span className="etiqueta ok">Ativo</span> : <span className="etiqueta neutra">Inativo</span>}</td>
              <td>{pode('garantia', 'editar') && <button className="botao claro pequeno" onClick={() => editar.mutate({ id: s.id, corpo: { ativo: !s.ativo } })}>{s.ativo ? 'Desativar' : 'Reativar'}</button>}</td>
            </tr>
          ))}
          {!q.data!.length && <tr><td colSpan={4} className="vazio">Cadastre os consertos mais comuns e seus preços.</td></tr>}
        </tbody>
      </table>
      {pode('garantia', 'criar') && (
        <div className="cartao form">
          <Campo rotulo="Serviço" className="l2"><input value={novo.descricao} onChange={(e) => setNovo({ ...novo, descricao: e.target.value })} placeholder="Ex.: troca de fecho" /></Campo>
          <Campo rotulo="Valor (R$)"><input inputMode="decimal" value={novo.valor} onChange={(e) => setNovo({ ...novo, valor: e.target.value })} /></Campo>
          <div className="campo"><label>&nbsp;</label><button className="botao" disabled={novo.descricao.length < 2 || criar.isPending} onClick={() => criar.mutate()}>Adicionar</button></div>
        </div>
      )}
    </div>
  );
}

function BuscaCliente({ valor, mudar }: { valor: string; mudar: (id: string) => void }) {
  const [busca, setBusca] = useState('');
  const q = useQuery({ queryKey: ['clientes-busca', busca], queryFn: () => api<any>(`/pessoas?tipo=cliente&busca=${encodeURIComponent(busca)}`).then((r) => r.itens as any[]), enabled: busca.trim().length >= 2 });
  return (
    <Campo rotulo="Cliente" ajuda="Digite parte do nome, CPF ou telefone">
      <div className="flex" style={{ gap: 6 }}>
        <input style={{ flex: 1, minWidth: 0 }} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar" />
        <select style={{ flex: 1, minWidth: 0 }} value={valor} onChange={(e) => mudar(e.target.value)}>
          <option value="">{busca.trim().length < 2 ? '—' : q.data?.length ? 'Escolha' : 'Nenhuma'}</option>
          {q.data?.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
        </select>
      </div>
    </Campo>
  );
}
