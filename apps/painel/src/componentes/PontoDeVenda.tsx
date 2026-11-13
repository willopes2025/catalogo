import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { centavosParaTexto, paraCentavos, reais } from '../formato';
import { Campo, Erro } from './ui';
import { Leitor, type ItemLido } from './Leitor';

export const FORMAS: [string, string][] = [['dinheiro', 'Dinheiro'], ['pix', 'Pix'], ['debito', 'Débito'], ['credito', 'Crédito'], ['credito_loja', 'Crédito da cliente'], ['boleto', 'Boleto / crediário']];
const MAQUININHAS = ['PagBank', 'Stone', 'InfinitePay'];

interface Pag { forma: string; valor: string; parcelas: number; maquininha: string }

/**
 * Tela de venda: leitor, cliente, desconto e pagamentos (podem ser várias formas).
 * Usada no caixa da loja e dos eventos (tipo balcão) e nas vendas avulsas e de revenda da matriz.
 */
export function PontoDeVenda({ localId, tipo, aoConcluir }: { localId: string; tipo: 'balcao' | 'avulsa' | 'revenda'; aoConcluir: (venda: any) => void }) {
  const qc = useQueryClient();
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [buscaCliente, setBuscaCliente] = useState('');
  const [cliente, setCliente] = useState<{ id: string; nome: string } | null>(null);
  const [descTexto, setDescTexto] = useState('');
  const [pags, setPags] = useState<Pag[]>([{ forma: 'pix', valor: '', parcelas: 1, maquininha: '' }]);
  const regras = useQuery({ queryKey: ['regras-venda'], queryFn: () => api<any>('/configuracoes/regras-venda') });
  const tipoCliente = tipo === 'revenda' ? 'representante' : 'cliente';
  const clientes = useQuery({
    queryKey: ['busca-cliente', tipoCliente, buscaCliente],
    queryFn: () => api<{ itens: any[] }>(`/pessoas?tipo=${tipoCliente}&status=ativo&busca=${encodeURIComponent(buscaCliente)}`),
    enabled: buscaCliente.trim().length >= 2,
  });

  // Revenda usa o preço de atacado de cada peça.
  const linhas = itens.map((i) => ({ ...i, precoUsado: tipo === 'revenda' ? i.precoAtacado ?? i.preco : i.preco }));
  const subtotal = linhas.reduce((a, i) => a + i.precoUsado * i.quantidade, 0);
  const desconto = Math.min(paraCentavos(descTexto || '0'), subtotal);
  const total = subtotal - desconto;
  const pago = pags.reduce((a, p) => a + paraCentavos(p.valor || '0'), 0);
  const falta = Math.max(0, total - pago);
  const troco = Math.max(0, pago - total);
  const dinheiro = pags.filter((p) => p.forma === 'dinheiro').reduce((a, p) => a + paraCentavos(p.valor || '0'), 0);
  const limitePct = (regras.data?.descontoMaximoPb ?? 1000) / 100;
  const acimaLimite = tipo !== 'revenda' && subtotal > 0 && desconto > (subtotal * limitePct) / 100;
  const problemas = useMemo(() => {
    const p: string[] = [];
    if (!itens.length) p.push('Inclua as peças.');
    if (falta > 0) p.push(`Falta receber ${reais(falta)}.`);
    if (troco > dinheiro) p.push('Troco só para pagamento em dinheiro.');
    if (tipo === 'revenda' && !cliente) p.push('Escolha a representante.');
    if (pags.some((x) => ['credito_loja', 'boleto'].includes(x.forma)) && !cliente) p.push('Identifique a cliente para usar crédito ou boleto.');
    if (acimaLimite && !pode('configuracoes', 'editar')) p.push(`Desconto acima de ${limitePct}% precisa de autorização da gerência.`);
    return p;
  }, [itens, falta, troco, dinheiro, tipo, cliente, pags, acimaLimite, limitePct]);

  const vender = useMutation({
    mutationFn: () =>
      api<any>('/vendas', {
        corpo: {
          localId,
          tipo,
          clienteId: cliente?.id ?? null,
          itens: itens.map((i) => ({ codigoBarras: i.codigoBarras, quantidade: i.quantidade })),
          descontoTotal: desconto || undefined,
          pagamentos: pags.filter((p) => paraCentavos(p.valor || '0') > 0).map((p) => ({ forma: p.forma, valor: paraCentavos(p.valor), parcelas: p.parcelas, maquininha: p.maquininha || null })),
        },
      }),
    onSuccess: (v) => {
      setItens([]);
      setCliente(null);
      setDescTexto('');
      setPags([{ forma: 'pix', valor: '', parcelas: 1, maquininha: '' }]);
      qc.invalidateQueries({ queryKey: ['caixa-atual'] });
      qc.invalidateQueries({ queryKey: ['vendas'] });
      aoConcluir(v);
    },
  });

  const setPag = (i: number, campos: Partial<Pag>) => setPags(pags.map((p, j) => (j === i ? { ...p, ...campos } : p)));
  const tudoEm = (forma: string) => setPags([{ forma, valor: centavosParaTexto(total), parcelas: 1, maquininha: '' }]);

  return (
    <div className="grade" style={{ gridTemplateColumns: '1fr 380px', alignItems: 'start' }}>
      <div className="cartao">
        <Leitor itens={itens} mudar={setItens} usarAtacado={tipo === 'revenda'} />
      </div>
      <div className="coluna" style={{ position: 'sticky', top: 20 }}>
        <div className="cartao coluna">
          <Campo rotulo={tipo === 'revenda' ? 'Representante (compradora)' : 'Cliente (opcional)'}>
            {cliente ? (
              <div className="flex entre"><b>{cliente.nome}</b><button className="botao claro pequeno" onClick={() => setCliente(null)}>Trocar</button></div>
            ) : (
              <>
                <input placeholder="Nome, CPF ou telefone" value={buscaCliente} onChange={(e) => setBuscaCliente(e.target.value)} />
                {clientes.data?.itens.slice(0, 6).map((c) => (
                  <button key={c.id} className="botao claro pequeno" style={{ justifyContent: 'flex-start' }} onClick={() => { setCliente({ id: c.id, nome: c.nome }); setBuscaCliente(''); }}>{c.nome}{c.cidade ? ` · ${c.cidade}` : ''}</button>
                ))}
              </>
            )}
          </Campo>
          <div className="resumo-linha"><span>Subtotal</span><span>{reais(subtotal)}</span></div>
          <div className="flex entre">
            <span>Desconto (R$)</span>
            <input style={{ maxWidth: 120, textAlign: 'right' }} inputMode="decimal" value={descTexto} onChange={(e) => setDescTexto(e.target.value)} placeholder="0,00" />
          </div>
          {acimaLimite && <span className="muted" style={{ color: 'var(--erro)' }}>Acima do limite de {limitePct}%.</span>}
          <div className="resumo-linha total"><span>Total</span><span>{reais(total)}</span></div>
        </div>
        <div className="cartao coluna">
          <div className="flex entre"><h3>Pagamento</h3><span className="muted">Tudo em:</span></div>
          <div className="flex" style={{ flexWrap: 'wrap', gap: 6 }}>
            {['pix', 'dinheiro', 'debito', 'credito'].map((f) => <button key={f} className="botao claro pequeno" onClick={() => tudoEm(f)}>{FORMAS.find((x) => x[0] === f)![1]}</button>)}
          </div>
          {pags.map((p, i) => (
            <div key={i} className="coluna" style={{ gap: 6, borderTop: i ? '1px dashed var(--linha)' : undefined, paddingTop: i ? 8 : 0 }}>
              <div className="flex">
                <select value={p.forma} onChange={(e) => setPag(i, { forma: e.target.value })}>{FORMAS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
                <input style={{ maxWidth: 110, textAlign: 'right' }} inputMode="decimal" placeholder="0,00" value={p.valor} onChange={(e) => setPag(i, { valor: e.target.value })} />
                {pags.length > 1 && <button className="botao perigo pequeno" onClick={() => setPags(pags.filter((_, j) => j !== i))}>×</button>}
              </div>
              {['debito', 'credito'].includes(p.forma) && (
                <div className="flex">
                  <select value={p.maquininha} onChange={(e) => setPag(i, { maquininha: e.target.value })}><option value="">Maquininha</option>{MAQUININHAS.map((m) => <option key={m}>{m}</option>)}</select>
                  {p.forma === 'credito' && <select value={p.parcelas} onChange={(e) => setPag(i, { parcelas: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, k) => <option key={k} value={k + 1}>{k + 1}x</option>)}</select>}
                </div>
              )}
              {p.forma === 'boleto' && <select value={p.parcelas} onChange={(e) => setPag(i, { parcelas: Number(e.target.value) })}>{Array.from({ length: 6 }, (_, k) => <option key={k} value={k + 1}>{k + 1}x de 30 dias</option>)}</select>}
            </div>
          ))}
          <button className="botao claro pequeno" onClick={() => setPags([...pags, { forma: 'dinheiro', valor: falta ? centavosParaTexto(falta) : '', parcelas: 1, maquininha: '' }])}>Outra forma de pagamento</button>
          {falta > 0 && <div className="resumo-linha"><span>Falta</span><b style={{ color: 'var(--erro)' }}>{reais(falta)}</b></div>}
          {troco > 0 && <div className="resumo-linha total"><span>Troco</span><span>{reais(troco)}</span></div>}
        </div>
        {problemas.length > 0 && itens.length > 0 && <div className="aviso alerta"><ul style={{ margin: 0 }}>{problemas.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        {vender.error && <Erro erro={vender.error} />}
        <button className="botao" style={{ padding: 14, fontSize: 17 }} disabled={problemas.length > 0 || vender.isPending} onClick={() => vender.mutate()}>{vender.isPending ? 'Registrando…' : `Finalizar venda · ${reais(total)}`}</button>
      </div>
    </div>
  );
}
