import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { data, reais } from '../formato';
import { Abas, Carregando, Erro, StatusMaleta, Topo } from '../componentes/ui';

type Aba = 'abertas' | 'vencendo' | 'atrasadas' | 'acertadas' | 'canceladas';

export function Maletas() {
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) ?? 'abertas';
  const [busca, setBusca] = useState('');
  const [buscaAtiva, setBuscaAtiva] = useState('');
  const navegar = useNavigate();
  const q = useQuery({ queryKey: ['maletas', aba, buscaAtiva], queryFn: () => api<any[]>(`/maletas?aba=${aba}${buscaAtiva ? `&busca=${encodeURIComponent(buscaAtiva)}` : ''}`) });
  const total = q.data?.reduce((a, m) => a + m.valor, 0) ?? 0;
  return (
    <>
      <Topo eb="Maletas" titulo="Consignado" sub={q.data && `${q.data.length} maletas · ${reais(total)} em peças`} acoes={pode('maletas', 'criar') && <Link className="botao" to="/maletas/nova">Nova maleta</Link>} />
      <Abas ativa={aba} mudar={(a) => setParams({ aba: a })} abas={[['abertas', 'Abertas'], ['vencendo', 'Vencendo em 7 dias'], ['atrasadas', 'Atrasadas'], ['acertadas', 'Acertadas'], ['canceladas', 'Canceladas']]} />
      <form className="busca" onSubmit={(e) => { e.preventDefault(); setBuscaAtiva(busca); }}>
        <input placeholder="Nº da maleta ou nome da representante" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <button className="botao claro">Buscar</button>
      </form>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.length === 0 ? <div className="cartao vazio">Nenhuma maleta nesta aba.</div> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Representante</th><th>Cidade</th><th className="num">Peças</th><th className="num">Valor</th><th>Retirada</th><th>Acerto até</th><th>Entrega</th><th>Pré-baixa</th><th>Situação</th></tr></thead>
          <tbody>
            {q.data!.map((m) => (
              <tr key={m.id} className="clicavel" onClick={() => navegar(`/maletas/${m.id}`)}>
                <td><b>{m.numero}</b></td>
                <td>{m.representante}</td>
                <td>{m.cidade ?? '—'}</td>
                <td className="num">{m.status === 'aberta' ? m.pecas : '—'}</td>
                <td className="num">{reais(m.status === 'aberta' ? m.valor : m.valorEnviado)}</td>
                <td>{data(m.dataRetirada)}</td>
                <td>{data(m.dataLimite)}</td>
                <td>{m.entrega === 'envio' ? 'Envio' : 'Retirada'}</td>
                <td>{m.prebaixa ? <span className="etiqueta alerta">Informada</span> : <span className="muted">—</span>}</td>
                <td><StatusMaleta status={m.status} diasAtraso={m.diasAtraso} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
