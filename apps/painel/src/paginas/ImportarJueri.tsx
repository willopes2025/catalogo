import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dataHora } from '../formato';
import { Campo, Erro } from '../componentes/ui';

const ETAPAS: [string, string, string][] = [
  ['cadastros', 'Categorias, fornecedores e níveis', ''],
  ['produtos', 'Produtos e estoque', 'Preço de varejo e atacado, custos, fiscal e quantidade em estoque'],
  ['pessoas', 'Revendedoras, representantes e clientes', 'Com líderes, referências e telefones'],
  ['maletas', 'Maletas abertas', 'Pedidos "Aberto" do Jueri, com as peças que estão com cada uma'],
  ['financeiro', 'Contas a receber em aberto', ''],
];

interface Parte { lidos: number; criados: number; atualizados: number; ignorados: number; erros: string[]; avisos: string[] }
interface Execucao { id: string; simular: boolean; etapas: string[]; inicio: string; fim: string | null; situacao: 'rodando' | 'concluida' | 'falhou'; fase: string; erro: string | null; partes: Record<string, Parte>; estruturas: Record<string, string[]> }

/** Migração direto da API do Jueri: simula, confere o relatório e só então grava. */
export function ImportarJueri() {
  const qc = useQueryClient();
  const [etapas, setEtapas] = useState<string[]>(ETAPAS.map(([k]) => k));
  const [localId, setLocalId] = useState('');
  const [estoque, setEstoque] = useState(true);
  const [comissao, setComissao] = useState('10');
  const locais = useQuery({ queryKey: ['locais'], queryFn: () => api<any[]>('/estoque/locais') });
  const sit = useQuery({
    queryKey: ['jueri'],
    queryFn: () => api<{ configurado: boolean; execucao: Execucao | null }>('/jueri'),
    refetchInterval: (q) => (q.state.data?.execucao?.situacao === 'rodando' ? 2000 : false),
  });
  const ex = sit.data?.execucao;
  const iniciar = useMutation({
    mutationFn: (simular: boolean) =>
      api<Execucao>('/jueri/importar', { corpo: { simular, etapas, localId, atualizarEstoque: estoque, comissaoRepresentantePb: Math.round(Number(comissao.replace(',', '.')) * 100) || 0 } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jueri'] }),
  });
  const rodando = ex?.situacao === 'rodando';
  const ultimaSimulacaoOk = ex && ex.simular && ex.situacao === 'concluida';
  const terminouDeVerdade = !!ex && ex.situacao !== 'rodando' && !ex.simular;
  useEffect(() => {
    if (terminouDeVerdade) void qc.invalidateQueries();
  }, [terminouDeVerdade, ex?.id, qc]);

  if (sit.data && !sit.data.configurado) {
    return (
      <div className="cartao">
        <div className="secao">Importar direto do Jueri</div>
        <p className="muted">Para trazer tudo de uma vez, gere um token no Jueri (Configurações › API › Gerar token) e salve em <Link to="/configuracoes?aba=integracoes">Integrações › Jueri</Link> com o ID de cliente 11566. Sem o token, use as planilhas abaixo.</p>
      </div>
    );
  }

  return (
    <div className="cartao form">
      <div className="secao">Importar direto do Jueri</div>
      <p className="muted l4">Busca tudo pela API do Jueri. Primeiro <b>simule</b>: nada é gravado e você vê o que aconteceria. Pode repetir quantas vezes quiser; o que já veio é atualizado, nunca duplicado.</p>
      <div className="l4 coluna" style={{ gap: 6 }}>
        {ETAPAS.map(([k, r, a]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={etapas.includes(k)} disabled={rodando} onChange={(e) => setEtapas(e.target.checked ? [...etapas, k] : etapas.filter((x) => x !== k))} /> {r}
            {a && <span className="muted"> · {a}</span>}
          </label>
        ))}
      </div>
      <Campo rotulo="Estoque da empresa fica em" ajuda="As peças das maletas vão para cada maleta"><select value={localId} onChange={(e) => setLocalId(e.target.value)} disabled={rodando}><option value="">Escolha…</option>{locais.data?.filter((l) => l.tipo !== 'maleta').map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
      <Campo rotulo="Comissão de quem é Representante no Jueri (%)" ajuda="Revendedoras seguem a regra padrão"><input value={comissao} onChange={(e) => setComissao(e.target.value)} inputMode="decimal" disabled={rodando} /></Campo>
      <div className="campo l2"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={estoque} onChange={(e) => setEstoque(e.target.checked)} disabled={rodando} /> Acertar o estoque pela quantidade do Jueri</label></div>
      <div className="l4 flex">
        <button className="botao claro" onClick={() => iniciar.mutate(true)} disabled={rodando || !localId || !etapas.length || iniciar.isPending}>Simular</button>
        {ultimaSimulacaoOk && <button className="botao" onClick={() => iniciar.mutate(false)} disabled={rodando || !localId || iniciar.isPending}>Importar de verdade</button>}
      </div>
      {iniciar.error && <div className="l4"><Erro erro={iniciar.error} /></div>}
      {ex && (
        <div className={`l4 aviso ${ex.situacao === 'falhou' ? 'erro' : ex.situacao === 'rodando' ? '' : Object.values(ex.partes).some((p) => p.erros.length) ? 'alerta' : 'ok'}`}>
          <b>{ex.simular ? 'Simulação' : 'Importação'} de {dataHora(ex.inicio)}:</b> {ex.fase}
          {ex.erro && <div>{ex.erro}</div>}
          {Object.keys(ex.partes).length > 0 && (
            <table className="tabela" style={{ marginTop: 8 }}>
              <thead><tr><th>Parte</th><th className="num">Lidos</th><th className="num">Novos</th><th className="num">Atualizados</th><th className="num">Já existiam</th><th className="num">Problemas</th></tr></thead>
              <tbody>{Object.entries(ex.partes).map(([n, p]) => <tr key={n}><td>{n}</td><td className="num">{p.lidos}</td><td className="num">{p.criados}</td><td className="num">{p.atualizados}</td><td className="num">{p.ignorados}</td><td className="num">{p.erros.length}</td></tr>)}</tbody>
            </table>
          )}
          {Object.entries(ex.partes).map(([n, p]) => (p.avisos.length || p.erros.length) ? (
            <details key={n} style={{ marginTop: 6 }} open={p.erros.length > 0 && p.erros.length < 10}>
              <summary>{n}: {p.avisos.length} aviso(s), {p.erros.length} problema(s)</summary>
              <ul>{p.avisos.map((a, i) => <li key={`a${i}`}>{a}</li>)}{p.erros.map((e, i) => <li key={`e${i}`} style={{ color: 'var(--perigo, #b42318)' }}>{e}</li>)}</ul>
            </details>
          ) : null)}
          {Object.keys(ex.estruturas).length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="muted">Campos recebidos do Jueri (para conferência técnica)</summary>
              {Object.entries(ex.estruturas).map(([k, v]) => <p key={k} className="muted" style={{ fontSize: 12 }}><b>{k}:</b> {v.join(', ') || '—'}</p>)}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
