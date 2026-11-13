import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { data, paraCentavos, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

type Aba = 'abertos' | 'vencidos' | 'pagos';

export function Financeiro() {
  const [tipo, setTipo] = useState<'receber' | 'pagar'>('receber');
  const [aba, setAba] = useState<Aba>('abertos');
  const [contaId, setContaId] = useState('');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['titulos', tipo, aba], queryFn: () => api<{ itens: any[]; total: number }>(`/financeiro/titulos?tipo=${tipo}&aba=${aba}`) });
  const contas = useQuery({ queryKey: ['contas'], queryFn: () => api<any[]>('/financeiro/contas') });
  const [cobranca, setCobranca] = useState<any | null>(null);
  const cobrar = useMutation({
    mutationFn: ({ id, tipo }: { id: string; tipo: 'PIX' | 'BOLETO' }) => api<any>(`/financeiro/titulos/${id}/cobranca`, { corpo: { tipo } }),
    onSuccess: (r) => { setCobranca(r); qc.invalidateQueries({ queryKey: ['titulos'] }); },
  });
  const [baixa, setBaixa] = useState<{ id: string; valor: string; pagoEm: string; desconto: boolean; total: number } | null>(null);
  const baixar = useMutation({
    mutationFn: () => api(`/financeiro/titulos/${baixa!.id}/baixar`, { corpo: { contaId: contaId || null, valorPago: baixa!.valor ? paraCentavos(baixa!.valor) : undefined, pagoEm: baixa!.pagoEm || undefined, quitarComDesconto: baixa!.desconto } }),
    onSuccess: () => { setBaixa(null); qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['contas'] }); },
  });
  const acao = useMutation({
    mutationFn: ({ id, tipo, motivo }: { id: string; tipo: 'cancelar' | 'estornar'; motivo: string }) => api(`/financeiro/titulos/${id}/${tipo}`, { corpo: { motivo } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['contas'] }); },
  });
  const pedirMotivo = (id: string, tipo: 'cancelar' | 'estornar') => {
    const motivo = window.prompt(tipo === 'cancelar' ? 'Motivo do cancelamento do título:' : 'Motivo do estorno da baixa:');
    if (motivo && motivo.trim().length >= 3) acao.mutate({ id, tipo, motivo: motivo.trim() });
  };
  return (
    <>
      <Topo eb="Financeiro" titulo={tipo === 'receber' ? 'Contas a receber' : 'Contas a pagar'} acoes={<div className="flex"><button className={`botao ${tipo === 'receber' ? '' : 'claro'}`} onClick={() => setTipo('receber')}>A receber</button><button className={`botao ${tipo === 'pagar' ? '' : 'claro'}`} onClick={() => setTipo('pagar')}>A pagar</button></div>} />
      {contas.data && (
        <div className="grade g4" style={{ marginBottom: 14 }}>
          {contas.data.slice(0, 4).map((c) => <Indicador key={c.id} rotulo={c.nome} valor={reais(c.saldo)} detalhe={c.empresa} />)}
        </div>
      )}
      <Abas ativa={aba} mudar={setAba} abas={[['abertos', 'Em aberto'], ['vencidos', 'Vencidos'], ['pagos', 'Pagos']]} />
      {aba !== 'pagos' && pode('financeiro', 'editar') && (
        <div className="busca">
          <select value={contaId} onChange={(e) => setContaId(e.target.value)}><option value="">Conta para as baixas…</option>{contas.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
          <span className="muted" style={{ alignSelf: 'center' }}>Boleto e Pix são gerados no Asaas; quando a pessoa paga, o título baixa sozinho.</span>
        </div>
      )}
      {(baixar.error || cobrar.error || acao.error) && <Erro erro={baixar.error ?? cobrar.error ?? acao.error} />}
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
          Cobrança gerada. <a href={cobranca.url} target="_blank" rel="noreferrer">Abrir link de pagamento</a>
          {cobranca.pixCopiaCola && <> · <button className="botao claro pequeno" onClick={async () => { try { await navigator.clipboard.writeText(cobranca.pixCopiaCola); } catch { window.prompt('Pix copia e cola:', cobranca.pixCopiaCola); } }}>Copiar Pix copia e cola</button></>}
        </div>
      )}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.itens.length === 0 ? <div className="cartao vazio">Nada nesta aba.</div> : (
        <table className="tabela">
          <thead><tr><th>Vencimento</th><th>Descrição</th><th>{tipo === 'receber' ? 'Quem paga' : 'Fornecedor'}</th><th>Forma</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {q.data!.itens.map((t) => (
              <tr key={t.id}>
                <td>{data(t.vencimento)}</td>
                <td>{t.descricao}</td>
                <td>{t.pessoaId ? <Link to={`/rede/${t.pessoaId}`}>{t.pessoa}</Link> : ['debito', 'credito'].includes(t.formaPagamento) ? 'Maquininha' : '—'}</td>
                <td>{t.formaPagamento ?? '—'}</td>
                <td className="num">{reais(t.valor)}</td>
                <td>{t.status === 'pago' ? <span className="etiqueta ok">Pago {data(t.pagoEm)}</span> : t.diasAtraso > 0 ? <span className="etiqueta erro">{t.diasAtraso} dias</span> : <span className="etiqueta alerta">A vencer</span>}</td>
                <td>
                  <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {t.cobrancaUrl && <a className="botao claro pequeno" href={t.cobrancaUrl} target="_blank" rel="noreferrer">{t.cobrancaTipo === 'PIX' ? 'Pix' : 'Boleto'}</a>}
                    {t.status === 'aberto' && tipo === 'receber' && t.pessoaId && !t.cobrancaUrl && !['debito', 'credito'].includes(t.formaPagamento) && pode('financeiro', 'editar') && (
                      <>
                        <button className="botao claro pequeno" disabled={cobrar.isPending} onClick={() => cobrar.mutate({ id: t.id, tipo: 'PIX' })}>Gerar Pix</button>
                        <button className="botao claro pequeno" disabled={cobrar.isPending} onClick={() => cobrar.mutate({ id: t.id, tipo: 'BOLETO' })}>Gerar boleto</button>
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
          <tfoot><tr><td colSpan={4}>Total</td><td className="num">{reais(q.data!.total)}</td><td colSpan={2}></td></tr></tfoot>
        </table>
      )}
    </>
  );
}
