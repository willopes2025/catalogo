import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { data, reais } from '../formato';
import { Carregando, Erro } from '../componentes/ui';

/** Página que a representante abre pelo link enviado no WhatsApp. Feita para celular, sem login. */
export function LinkPedido() {
  const { token } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pedido', token], queryFn: () => api<any>(`/publico/maletas/${token}`) });
  const [vendidas, setVendidas] = useState<Record<string, number>>({});
  const [modo, setModo] = useState(false);
  const recebida = useMutation({ mutationFn: () => api(`/publico/maletas/${token}/recebida`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['pedido', token] }) });
  const prebaixa = useMutation({
    mutationFn: () => api(`/publico/maletas/${token}/prebaixa`, { corpo: { itens: q.data.itens.map((i: any) => ({ produtoId: i.produtoId, vendida: vendidas[i.produtoId] ?? 0 })) } }),
    onSuccess: () => { setModo(false); qc.invalidateQueries({ queryKey: ['pedido', token] }); },
  });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <div className="publico"><Erro erro={q.error} /></div>;
  const m = q.data;
  const totalVendido = m.itens.reduce((a: number, i: any) => a + (vendidas[i.produtoId] ?? 0) * i.preco, 0);
  return (
    <div className="publico">
      <div className="cab">
        <img src="/logo-creme.png" alt="Aritana Semijoias" />
        <div>
          <div style={{ fontSize: 13, color: '#e0cba6', letterSpacing: 2, textTransform: 'uppercase' }}>Maleta nº {m.numero}</div>
          <h1 style={{ fontSize: 24 }}>Olá, {m.representante.split(' ')[0]}!</h1>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div><div style={{ fontSize: 12, color: '#d9cfc1' }}>Peças</div><b style={{ fontSize: 20 }}>{m.totais.pecas}</b></div>
          <div><div style={{ fontSize: 12, color: '#d9cfc1' }}>Valor</div><b style={{ fontSize: 20 }}>{reais(m.totais.valor)}</b></div>
          <div><div style={{ fontSize: 12, color: '#d9cfc1' }}>Acerto até</div><b style={{ fontSize: 20 }}>{data(m.dataLimite)}</b></div>
        </div>
      </div>
      {m.status !== 'aberta' ? <div className="aviso ok" style={{ marginTop: 14 }}>Esta maleta já foi acertada. Obrigada!</div> : (
        <>
          {m.diasAtraso > 0 && <div className="aviso erro" style={{ marginTop: 14 }}>O acerto está atrasado há {m.diasAtraso} dias. Fale com a matriz para agendar.</div>}
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!m.recebidaEm ? <button className="botao" onClick={() => recebida.mutate()} disabled={recebida.isPending}>Confirmar que recebi as peças</button> : <span className="etiqueta ok">Recebimento confirmado</span>}
            {!modo && <button className="botao claro" onClick={() => { setModo(true); setVendidas(Object.fromEntries(m.itens.map((i: any) => [i.produtoId, i.prebaixaVendida ?? 0]))); }}>Informar o que vendi</button>}
          </div>
          {m.prebaixaEm && !modo && <p className="muted" style={{ marginTop: 8 }}>Você já informou suas vendas. A matriz confere no acerto.</p>}
          {prebaixa.error && <Erro erro={prebaixa.error} />}
          <div style={{ marginTop: 10 }}>
            {m.itens.map((i: any) => (
              <div key={i.produtoId} className="peca">
                {i.foto ? <img className="miniatura" src={i.foto} alt="" /> : <span className="miniatura" />}
                <div className="info"><b>{i.descricao}</b><div className="muted">ref. {i.referencia} · {reais(i.preco)}</div></div>
                {modo ? (
                  <div className="flex">
                    <button className="botao claro pequeno" aria-label="menos" onClick={() => setVendidas({ ...vendidas, [i.produtoId]: Math.max(0, (vendidas[i.produtoId] ?? 0) - 1) })}>−</button>
                    <b style={{ minWidth: 40, textAlign: 'center' }}>{vendidas[i.produtoId] ?? 0}/{i.quantidade}</b>
                    <button className="botao claro pequeno" aria-label="mais" onClick={() => setVendidas({ ...vendidas, [i.produtoId]: Math.min(i.quantidade, (vendidas[i.produtoId] ?? 0) + 1) })}>+</button>
                  </div>
                ) : <b>{i.quantidade}x</b>}
              </div>
            ))}
          </div>
          {modo && (
            <div className="cartao" style={{ marginTop: 14, position: 'sticky', bottom: 10 }}>
              <div className="resumo-linha total"><span>Você vendeu</span><span>{reais(totalVendido)}</span></div>
              <button className="botao" style={{ width: '100%', marginTop: 8 }} onClick={() => prebaixa.mutate()} disabled={prebaixa.isPending}>Enviar para a matriz</button>
            </div>
          )}
        </>
      )}
      <p className="muted" style={{ marginTop: 24, textAlign: 'center' }}>Aritana Semijoias</p>
    </div>
  );
}
