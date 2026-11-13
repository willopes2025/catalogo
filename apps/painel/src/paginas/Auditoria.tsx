import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { dataHora } from '../formato';
import { Carregando, Erro, Topo } from '../componentes/ui';

const ACOES: Record<string, string> = {
  criar: 'Criou', editar: 'Editou', excluir: 'Excluiu', cancelar: 'Cancelou', login: 'Entrou', ajuste: 'Ajustou estoque', acerto: 'Fez acerto',
  decidir: 'Decidiu garantia', concluir: 'Concluiu', fechar_comissoes: 'Fechou comissões', reabrir_comissoes: 'Reabriu comissões', executar: 'Rodou',
};

export function Auditoria() {
  const [f, setF] = useState({ usuarioId: '', entidade: '', acao: '', de: '', ate: '' });
  const [pagina, setPagina] = useState(1);
  const [aberta, setAberta] = useState<string | null>(null);
  const filtros = useQuery({ queryKey: ['auditoria-filtros'], queryFn: () => api<{ entidades: string[]; acoes: string[]; usuarios: { id: string; nome: string }[] }>('/auditoria/filtros') });
  const params = new URLSearchParams({ pagina: String(pagina), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
  const q = useQuery({ queryKey: ['auditoria', params.toString()], queryFn: () => api<any>(`/auditoria?${params}`) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setPagina(1); };
  return (
    <>
      <Topo eb="Configurações" titulo="Auditoria" sub="Quem fez o quê, e quando. Ninguém consegue apagar estes registros pelo sistema." />
      <div className="busca">
        <select value={f.usuarioId} onChange={set('usuarioId')}><option value="">Todos os usuários</option>{filtros.data?.usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select>
        <select value={f.entidade} onChange={set('entidade')}><option value="">Tudo</option>{filtros.data?.entidades.map((e) => <option key={e} value={e}>{e.replace(/_/g, ' ')}</option>)}</select>
        <select value={f.acao} onChange={set('acao')}><option value="">Qualquer ação</option>{filtros.data?.acoes.map((a) => <option key={a} value={a}>{ACOES[a] ?? a.replace(/_/g, ' ')}</option>)}</select>
        <input type="date" value={f.de} onChange={set('de')} title="De" />
        <input type="date" value={f.ate} onChange={set('ate')} title="Até" />
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          <table className="tabela">
            <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Onde</th><th>Detalhes</th></tr></thead>
            <tbody>
              {q.data.linhas.map((l: any) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dataHora(l.criadoEm)}</td>
                  <td>{l.usuario ?? <span className="muted">sistema / público</span>}</td>
                  <td>{ACOES[l.acao] ?? l.acao.replace(/_/g, ' ')}</td>
                  <td>{l.entidade.replace(/_/g, ' ')}{l.entidadeId && <div className="muted" title={l.entidadeId}>{String(l.entidadeId).slice(0, 8)}</div>}</td>
                  <td>
                    {l.dados ? (
                      aberta === l.id ? (
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxWidth: 520 }} onClick={() => setAberta(null)}>{JSON.stringify(l.dados, null, 2)}</pre>
                      ) : (
                        <button className="botao claro pequeno" onClick={() => setAberta(l.id)}>Ver</button>
                      )
                    ) : '—'}
                  </td>
                </tr>
              ))}
              {!q.data.linhas.length && <tr><td colSpan={5} className="vazio">Nada encontrado com esses filtros.</td></tr>}
            </tbody>
          </table>
          <div className="flex">
            <button className="botao claro pequeno" disabled={pagina === 1} onClick={() => setPagina(pagina - 1)}>← Anteriores</button>
            <span className="muted">Página {pagina}</span>
            <button className="botao claro pequeno" disabled={!q.data.temMais} onClick={() => setPagina(pagina + 1)}>Mais antigos →</button>
          </div>
        </>
      )}
    </>
  );
}
