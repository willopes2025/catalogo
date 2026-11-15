import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { data, paraCentavos, pct, reais } from '../formato';
import { Campo, Carregando, Erro, Indicador } from '../componentes/ui';

interface Item { id: string; descricao: string; valor: number; vencimento: string; forma: string; maquininha: string; empresaId: string; empresa: string }
interface Grupo { chave: string; vencimento: string; forma: string; maquininha: string; empresaId: string; empresa: string; total: number; ids: string[] }
interface Resp { hoje: string; itens: Item[]; grupos: Grupo[]; resumo: { vencido: number; hoje: number; aVencer: number } }

const FORMA: Record<string, string> = { debito: 'Débito', credito: 'Crédito' };

/**
 * Conciliação de cartão: marque o que a maquininha depositou (por dia, por forma, por maquininha),
 * digite o valor que caiu na conta e o sistema baixa tudo e lança a taxa como despesa.
 */
export function ConciliarCartao({ contas }: { contas: any[] }) {
  const qc = useQueryClient();
  const [ate, setAte] = useState('');
  const q = useQuery({ queryKey: ['cartao', ate], queryFn: () => api<Resp>(`/financeiro/cartao${ate ? `?ate=${ate}` : ''}`) });
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [recebido, setRecebido] = useState('');
  const [recebidoEm, setRecebidoEm] = useState('');
  const [contaId, setContaId] = useState('');
  const [aceitar, setAceitar] = useState(false);
  const [feito, setFeito] = useState<any | null>(null);
  const porId = useMemo(() => new Map(q.data?.itens.map((i) => [i.id, i]) ?? []), [q.data]);
  const sel = [...marcados].map((id) => porId.get(id)).filter((x): x is Item => !!x);
  const bruto = sel.reduce((a, t) => a + t.valor, 0);
  const empresaSel = sel[0]?.empresaId;
  const valor = recebido ? paraCentavos(recebido) : 0;
  const taxa = valor ? bruto - valor : 0;
  const contasDaEmpresa = contas.filter((c) => !sel[0] || c.empresa === sel[0].empresa);
  const conta = contaId && contasDaEmpresa.some((c) => c.id === contaId) ? contaId : contasDaEmpresa.length === 1 ? contasDaEmpresa[0].id : '';
  const conciliar = useMutation({
    mutationFn: () => api<any>('/financeiro/cartao/conciliar', { corpo: { ids: sel.map((t) => t.id), valorRecebido: valor, recebidoEm: recebidoEm || q.data!.hoje, contaId: conta, aceitarDiferenca: aceitar } }),
    onSuccess: (r) => {
      setFeito(r); setMarcados(new Set()); setRecebido(''); setAceitar(false);
      qc.invalidateQueries({ queryKey: ['cartao'] }); qc.invalidateQueries({ queryKey: ['titulos'] }); qc.invalidateQueries({ queryKey: ['contas'] });
    },
  });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const d = q.data!;
  const editar = pode('financeiro', 'editar');
  const alternar = (ids: string[], ligar: boolean) => {
    const n = new Set(marcados);
    ids.forEach((id) => (ligar ? n.add(id) : n.delete(id)));
    setMarcados(n);
    setFeito(null);
  };
  const outraEmpresa = (g: Grupo) => !!empresaSel && g.empresaId !== empresaSel;
  const pedeConfirmacao = conciliar.error && /confirme a diferença/i.test(String((conciliar.error as Error).message));

  return (
    <div className="coluna" style={{ gap: 14 }}>
      <div className="grade g3">
        <Indicador rotulo="Já devia ter caído" valor={reais(d.resumo.vencido)} detalhe="previsto até ontem e ainda em aberto" />
        <Indicador rotulo="Previsto para hoje" valor={reais(d.resumo.hoje)} />
        <Indicador rotulo="A receber das maquininhas" valor={reais(d.resumo.aVencer)} detalhe="próximos dias e parcelas" />
      </div>
      <div className="busca">
        <span className="muted" style={{ alignSelf: 'center' }}>Mostrar previstos até</span>
        <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} style={{ maxWidth: 180 }} />
        <span className="muted" style={{ alignSelf: 'center' }}>Confira o extrato da operadora, marque o que caiu e informe o valor depositado.</span>
      </div>
      {feito && (
        <div className="aviso ok">
          {feito.quantidade} recebimento(s) baixado(s): bruto {reais(feito.bruto)}, caiu {reais(feito.recebido)}
          {feito.taxa > 0 ? `, taxa ${reais(feito.taxa)} (${pct(feito.taxaPb)}) lançada em Contas a pagar › Taxas de cartão.` : ', sem taxa.'}
        </div>
      )}
      {!d.grupos.length ? <div className="cartao vazio">Nenhum recebimento de cartão em aberto.</div> : (
        <table className="tabela">
          <thead><tr><th style={{ width: 32 }}></th><th>Previsto</th><th>Forma</th><th>Maquininha</th><th>Empresa</th><th className="num">Vendas</th><th className="num">Valor bruto</th></tr></thead>
          <tbody>
            {d.grupos.map((g) => {
              const todos = g.ids.every((id) => marcados.has(id));
              const alguns = !todos && g.ids.some((id) => marcados.has(id));
              const aberto = abertos.has(g.chave);
              return [
                <tr key={g.chave} style={{ opacity: outraEmpresa(g) ? 0.45 : 1 }}>
                  <td><input type="checkbox" disabled={!editar || outraEmpresa(g)} checked={todos} ref={(el) => { if (el) el.indeterminate = alguns; }} onChange={(e) => alternar(g.ids, e.target.checked)} /></td>
                  <td>{data(g.vencimento)} {g.vencimento < d.hoje && <span className="etiqueta erro">atrasado</span>}</td>
                  <td>{FORMA[g.forma] ?? g.forma}</td>
                  <td>{g.maquininha}</td>
                  <td>{g.empresa}</td>
                  <td className="num"><button className="botao claro pequeno" onClick={() => { const n = new Set(abertos); aberto ? n.delete(g.chave) : n.add(g.chave); setAbertos(n); }}>{g.ids.length} {aberto ? '▴' : '▾'}</button></td>
                  <td className="num"><b>{reais(g.total)}</b></td>
                </tr>,
                ...(aberto
                  ? g.ids.map((id) => {
                      const t = porId.get(id)!;
                      return (
                        <tr key={id} style={{ background: 'var(--fundo)' }}>
                          <td></td>
                          <td colSpan={5}><label className="check"><input type="checkbox" disabled={!editar || outraEmpresa(g)} checked={marcados.has(id)} onChange={(e) => alternar([id], e.target.checked)} /> {t.descricao}</label></td>
                          <td className="num">{reais(t.valor)}</td>
                        </tr>
                      );
                    })
                  : []),
              ];
            })}
          </tbody>
        </table>
      )}

      {editar && sel.length > 0 && (
        <div className="cartao form" style={{ position: 'sticky', bottom: 10, boxShadow: '0 6px 24px rgba(0,0,0,.12)' }}>
          <div className="secao" style={{ marginTop: 0 }}>{sel.length} recebimento(s) marcado(s) · bruto {reais(bruto)}</div>
          <Campo rotulo="Valor que caiu na conta (R$)"><input inputMode="decimal" value={recebido} onChange={(e) => { setRecebido(e.target.value); setAceitar(false); }} placeholder={(bruto / 100).toFixed(2).replace('.', ',')} autoFocus /></Campo>
          <Campo rotulo="Data do depósito" ajuda="Em branco = hoje"><input type="date" value={recebidoEm} onChange={(e) => setRecebidoEm(e.target.value)} /></Campo>
          <Campo rotulo="Conta onde caiu" className="l2">
            <select value={conta} onChange={(e) => setContaId(e.target.value)}>
              <option value="">Escolha a conta…</option>
              {contasDaEmpresa.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </Campo>
          <div className="l4" style={{ fontSize: 14 }}>
            {!valor ? <span className="muted">Digite o valor depositado; a diferença vira a taxa da maquininha.</span>
              : taxa < 0 ? <span style={{ color: 'var(--erro)' }}>Caiu {reais(-taxa)} a mais do que o marcado. Falta marcar algum recebimento?</span>
              : <>Taxa da maquininha: <b>{reais(taxa)}</b> ({pct(Math.round((taxa * 10000) / bruto))} do bruto){taxa === 0 ? ' · sem taxa' : ' · será lançada como despesa paga'}</>}
          </div>
          {conciliar.error && <div className="l4"><Erro erro={conciliar.error} /></div>}
          {pedeConfirmacao && <label className="check l4"><input type="checkbox" checked={aceitar} onChange={(e) => setAceitar(e.target.checked)} /> Conferi: a diferença está certa (taxa de antecipação, aluguel da máquina descontado etc.)</label>}
          <div className="l4 flex" style={{ gap: 8 }}>
            <button className="botao" disabled={conciliar.isPending || !valor || taxa < 0 || !conta} onClick={() => conciliar.mutate()}>Conciliar e dar baixa</button>
            <button className="botao claro" onClick={() => setMarcados(new Set())}>Limpar</button>
          </div>
        </div>
      )}
    </div>
  );
}
