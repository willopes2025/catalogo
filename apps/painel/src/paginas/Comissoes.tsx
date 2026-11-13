import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { centavosParaTexto, dataHora, paraCentavos, pct, reais } from '../formato';
import { Abas, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const nomeMes = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

export function Comissoes() {
  const [aba, setAba] = useState<'mes' | 'vendedoras'>('mes');
  return (
    <>
      <Topo eb="Comissões" titulo="Fechamento do mês" sub="Vendedoras da loja e dos eventos, líderes de rede e conferência das representantes" />
      <Abas ativa={aba} mudar={setAba} abas={[['mes', 'Fechamento'], ['vendedoras', 'Percentual e meta por vendedora']]} />
      {aba === 'mes' ? <Mes /> : <Vendedoras />}
    </>
  );
}

function Mes() {
  const qc = useQueryClient();
  const [mes, setMes] = useState(mesAtual());
  const q = useQuery({ queryKey: ['comissoes', mes], queryFn: () => api<any>(`/comissoes?mes=${mes}`) });
  const fechar = useMutation({ mutationFn: () => api('/comissoes/fechar', { corpo: { mes } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comissoes', mes] }) });
  const reabrir = useMutation({ mutationFn: () => api('/comissoes/reabrir', { corpo: { mes } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comissoes', mes] }) });
  const c = q.data;
  return (
    <div className="coluna">
      <div className="busca">
        <input type="month" value={mes} max={mesAtual()} onChange={(e) => e.target.value && setMes(e.target.value)} />
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          <div className="grade g4">
            <Indicador tipo="destaque" rotulo={`A pagar · ${nomeMes(mes)}`} valor={reais(c.total)} detalhe={c.fechado ? `Fechado em ${dataHora(c.fechadoEm)}` : 'Prévia: ainda não fechado'} />
            <Indicador rotulo="Vendedoras" valor={c.linhas.filter((l: any) => l.tipo === 'loja').length} detalhe={`Padrão ${pct(c.regras.lojaPadraoPb)} das vendas`} />
            <Indicador rotulo="Líderes de rede" valor={c.linhas.filter((l: any) => l.tipo === 'rede').length} detalhe={c.regras.redeLiderPb ? `${pct(c.regras.redeLiderPb)} do vendido pela rede` : 'Desligado nas configurações'} />
            <Indicador rotulo="Retida pelas representantes" valor={reais(c.representantes.reduce((a: number, r: any) => a + r.comissao, 0))} detalhe="Já descontada nos acertos" />
          </div>
          {(fechar.error || reabrir.error) && <Erro erro={fechar.error ?? reabrir.error} />}
          <table className="tabela">
            <thead><tr><th>Quem</th><th>Tipo</th><th className="num">Base</th><th className="num">%</th><th className="num">Comissão</th><th>Meta</th></tr></thead>
            <tbody>
              {c.linhas.map((l: any, i: number) => (
                <tr key={i}>
                  <td><b>{l.nome}</b>{l.tipo === 'loja' && <div className="muted">{l.detalhes.vendas} venda(s){l.detalhes.devolvido ? ` · ${reais(l.detalhes.devolvido)} devolvido` : ''}</div>}{l.tipo === 'rede' && <div className="muted">{l.detalhes.representantes} representante(s) · {l.detalhes.acertos} acerto(s)</div>}</td>
                  <td>{l.tipo === 'loja' ? 'Vendas' : 'Rede'}</td>
                  <td className="num">{reais(l.base)}</td>
                  <td className="num">{pct(l.percentualPb)}</td>
                  <td className="num"><b>{reais(l.valor)}</b></td>
                  <td>{l.meta ? <>{reais(l.meta)} {l.detalhes.bateuMeta ? <span className="etiqueta ok">Bateu</span> : <span className="etiqueta neutra">{Math.round((l.base / l.meta) * 100)}%</span>}</> : '—'}</td>
                </tr>
              ))}
              {!c.linhas.length && <tr><td colSpan={6} className="vazio">Nenhuma venda com vendedora neste mês.</td></tr>}
            </tbody>
          </table>
          <div className="flex">
            {!c.fechado && pode('comissoes', 'criar') && (
              <button className="botao" disabled={fechar.isPending || !c.linhas.length} onClick={() => window.confirm(`Fechar ${nomeMes(mes)}? Serão geradas as contas a pagar das comissões.`) && fechar.mutate()}>Fechar o mês e gerar contas a pagar</button>
            )}
            {c.fechado && pode('comissoes', 'excluir') && (
              <button className="botao claro" disabled={reabrir.isPending} onClick={() => window.confirm('Reabrir? As contas a pagar ainda não pagas serão canceladas.') && reabrir.mutate()}>Reabrir o mês</button>
            )}
            {c.fechado && <span className="muted">As comissões estão em Financeiro → Contas a pagar, categoria "Comissões".</span>}
          </div>
          {c.representantes.length > 0 && (
            <>
              <h3 style={{ marginBottom: 0 }}>Conferência: comissão das representantes nos acertos</h3>
              <table className="tabela">
                <thead><tr><th>Representante</th><th className="num">Acertos</th><th className="num">Vendido</th><th className="num">Comissão retida</th></tr></thead>
                <tbody>{c.representantes.map((r: any, i: number) => <tr key={i}><td>{r.nome}</td><td className="num">{r.acertos}</td><td className="num">{reais(r.vendido)}</td><td className="num">{reais(r.comissao)}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Vendedoras() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['vendedoras'], queryFn: () => api<any[]>('/comissoes/vendedoras') });
  const regras = useQuery({ queryKey: ['config', 'regras_comissao'], queryFn: () => api<any>('/configuracoes/chave/regras_comissao') });
  const [edit, setEdit] = useState<Record<string, { pct: string; meta: string }>>({});
  const salvar = useMutation({
    mutationFn: (id: string) => {
      const e = edit[id];
      return api(`/comissoes/vendedoras/${id}`, { metodo: 'PATCH', corpo: { comissaoPb: e.pct.trim() ? Math.round(Number(e.pct.replace(',', '.')) * 100) : null, metaMensal: e.meta.trim() ? paraCentavos(e.meta) : null } });
    },
    onSuccess: (_r, id) => { setEdit((x) => { const n = { ...x }; delete n[id]; return n; }); qc.invalidateQueries({ queryKey: ['vendedoras'] }); },
  });
  if (q.isLoading) return <Carregando />;
  const podeEditar = pode('comissoes', 'editar');
  return (
    <div className="coluna">
      <p className="muted">Em branco, vale o padrão de {regras.data ? pct(regras.data.lojaPadraoPb) : '…'} (Configurações → Avisos e regras). A comissão sai sobre o vendido menos as devoluções.</p>
      {salvar.error && <Erro erro={salvar.error} />}
      <table className="tabela">
        <thead><tr><th>Usuário</th><th>Comissão (%)</th><th>Meta mensal (R$)</th><th></th></tr></thead>
        <tbody>
          {q.data!.filter((u) => u.ativo).map((u) => {
            const e = edit[u.id] ?? { pct: u.comissaoPb == null ? '' : String(u.comissaoPb / 100).replace('.', ','), meta: centavosParaTexto(u.metaMensal) };
            const mudou = !!edit[u.id];
            return (
              <tr key={u.id}>
                <td>{u.nome}</td>
                <td><input style={{ width: 90 }} inputMode="decimal" disabled={!podeEditar} value={e.pct} placeholder="padrão" onChange={(ev) => setEdit({ ...edit, [u.id]: { ...e, pct: ev.target.value } })} /></td>
                <td><input style={{ width: 130 }} inputMode="decimal" disabled={!podeEditar} value={e.meta} placeholder="sem meta" onChange={(ev) => setEdit({ ...edit, [u.id]: { ...e, meta: ev.target.value } })} /></td>
                <td>{mudou && <button className="botao pequeno" disabled={salvar.isPending} onClick={() => salvar.mutate(u.id)}>Salvar</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
