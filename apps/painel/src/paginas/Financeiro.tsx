import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { data, reais } from '../formato';
import { Abas, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

type Aba = 'abertos' | 'vencidos' | 'pagos';

export function Financeiro() {
  const [tipo, setTipo] = useState<'receber' | 'pagar'>('receber');
  const [aba, setAba] = useState<Aba>('abertos');
  const [contaId, setContaId] = useState('');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['titulos', tipo, aba], queryFn: () => api<{ itens: any[]; total: number }>(`/financeiro/titulos?tipo=${tipo}&aba=${aba}`) });
  const contas = useQuery({ queryKey: ['contas'], queryFn: () => api<any[]>('/financeiro/contas') });
  const baixar = useMutation({
    mutationFn: (id: string) => api(`/financeiro/titulos/${id}/baixar`, { corpo: { contaId: contaId || null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['titulos'] }),
  });
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
          <span className="muted" style={{ alignSelf: 'center' }}>Boletos e Pix pelo Asaas entram quando a Aritana enviar a chave da API.</span>
        </div>
      )}
      {baixar.error && <Erro erro={baixar.error} />}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.itens.length === 0 ? <div className="cartao vazio">Nada nesta aba.</div> : (
        <table className="tabela">
          <thead><tr><th>Vencimento</th><th>Descrição</th><th>{tipo === 'receber' ? 'Quem paga' : 'Fornecedor'}</th><th>Forma</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {q.data!.itens.map((t) => (
              <tr key={t.id}>
                <td>{data(t.vencimento)}</td>
                <td>{t.descricao}</td>
                <td>{t.pessoaId ? <Link to={`/rede/${t.pessoaId}`}>{t.pessoa}</Link> : '—'}</td>
                <td>{t.formaPagamento ?? '—'}</td>
                <td className="num">{reais(t.valor)}</td>
                <td>{t.status === 'pago' ? <span className="etiqueta ok">Pago {data(t.pagoEm)}</span> : t.diasAtraso > 0 ? <span className="etiqueta erro">{t.diasAtraso} dias</span> : <span className="etiqueta alerta">A vencer</span>}</td>
                <td>{t.status === 'aberto' && pode('financeiro', 'editar') && <button className="botao claro pequeno" disabled={baixar.isPending} onClick={() => baixar.mutate(t.id)}>Baixar</button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total</td><td className="num">{reais(q.data!.total)}</td><td colSpan={2}></td></tr></tfoot>
        </table>
      )}
    </>
  );
}
