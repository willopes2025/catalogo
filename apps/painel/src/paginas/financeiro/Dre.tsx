import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { data, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';
import { mesAtual, nomeMes, somarMeses } from './comum';

interface Linha { id: string; codigo: string; nome: string; nivel: number; calculada: boolean; ativo: boolean; valores: number[]; total: number; filhos: Linha[] }
interface Grupo { chave: string; nome: string; id: string | null; valores: number[]; total: number; contas: Linha[] }
interface Sub { valores: number[]; total: number }
interface DreDados { meses: string[]; regime: 'caixa' | 'competencia'; grupos: Grupo[]; fora: Grupo; subtotais: { receitaLiquida: Sub; lucroBruto: Sub; operacional: Sub; resultado: Sub }; semClassificar: number }

const num = (c: number) => (Math.abs(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const valor = (c: number) => (c < 0 ? `(${num(c)})` : num(c));
const pc = (parte: number, todo: number) => (todo ? `${((Math.abs(parte) / Math.abs(todo)) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—');
/** Onde cada subtotal aparece: depois de qual grupo. */
const DEPOIS: Record<string, [keyof DreDados['subtotais'], string, boolean?]> = {
  deducoes: ['receitaLiquida', '= Receita líquida'],
  custos: ['lucroBruto', '= Lucro bruto'],
  despesas_administrativas: ['operacional', '= Resultado operacional'],
  outras: ['resultado', '= Resultado do período', true],
};
const SINAL: Record<string, string> = { receita: '', deducoes: '(−) ', custos: '(−) ', despesas_vendas: '(−) ', despesas_pessoal: '(−) ', despesas_administrativas: '(−) ', financeiro: '(±) ', outras: '(±) ' };

export function Dre({ irParaTitulos }: { irParaTitulos: () => void }) {
  const [ate, setAte] = useState(mesAtual());
  const [de, setDe] = useState(somarMeses(mesAtual(), -5));
  const [regime, setRegime] = useState<'caixa' | 'competencia'>('caixa');
  const [base, setBase] = useState<'receita' | 'grupo'>('receita');
  const [abertos, setAbertos] = useState<Set<string>>(() => new Set(['receita', 'deducoes', 'custos', 'despesas_vendas', 'despesas_pessoal', 'despesas_administrativas', 'financeiro', 'outras']));
  const [zeradas, setZeradas] = useState(false);
  const [foco, setFoco] = useState<{ contaId: string; mes: string; nome: string } | null>(null);
  const q = useQuery({ queryKey: ['dre', de, ate, regime], queryFn: () => api<DreDados>(`/financeiro/dre?de=${de}&ate=${ate}&regime=${regime}`), placeholderData: (a) => a });
  const alternar = (k: string) => setAbertos((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const d = q.data;
  const rl = d?.subtotais.receitaLiquida;

  const celulas = (valores: number[], total: number, baseV: number[], baseT: number, clique?: (i: number) => void) => (
    <>
      {valores.map((v, i) => (
        <td key={i} className={`${v < 0 ? 'neg' : ''} ${clique && v ? 'clicavel' : ''}`} onClick={clique && v ? () => clique(i) : undefined} title={clique && v ? 'Ver os lançamentos' : undefined}>
          {v ? valor(v) : '—'}
          {v !== 0 && <span className="pc">{pc(v, baseV[i])}</span>}
        </td>
      ))}
      <td className={total < 0 ? 'neg' : ''}><b>{total ? valor(total) : '—'}</b>{total !== 0 && <span className="pc">{pc(total, baseT)}</span>}</td>
    </>
  );

  const linhasConta = (l: Linha, g: Grupo, nivel: number): JSX.Element[] => {
    if (!zeradas && !l.valores.some(Boolean)) return [];
    const temFilhos = l.filhos.length > 0;
    const aberto = abertos.has(l.id);
    const baseV = base === 'grupo' ? g.valores : rl!.valores;
    const baseT = base === 'grupo' ? g.total : rl!.total;
    const largura = g.total ? Math.round((Math.abs(l.total) / Math.abs(g.total)) * 60) : 0;
    return [
      <tr key={l.id} className="conta">
        <td style={{ paddingLeft: 14 + nivel * 18 }} onClick={temFilhos ? () => alternar(l.id) : undefined} className={temFilhos ? 'clicavel' : ''}>
          <span className="seta">{temFilhos ? (aberto ? '▾' : '▸') : ''}</span>
          {l.codigo && <span className="cod">{l.codigo}</span>}
          {l.nome}
          {l.calculada && <span className="tag" title="Calculada pelo sistema a partir das vendas e dos acertos">automática</span>}
          {largura > 0 && <span className="barra" style={{ width: largura }} title={`${pc(l.total, g.total)} de ${g.nome}`} />}
        </td>
        {celulas(l.valores, l.total, baseV, baseT, l.calculada && !temFilhos ? undefined : (i) => setFoco({ contaId: l.id, mes: d!.meses[i], nome: `${l.codigo} ${l.nome}`.trim() }))}
      </tr>,
      ...(temFilhos && aberto ? l.filhos.flatMap((f) => linhasConta(f, g, nivel + 1)) : []),
    ];
  };

  const exportar = () => {
    if (!d) return;
    const linhas: string[][] = [['Conta', ...d.meses.map(nomeMes), 'Total', '% da receita líquida']];
    const cel = (c: number) => (c / 100).toFixed(2).replace('.', ',');
    const pct = (v: number) => (rl!.total ? ((v / rl!.total) * 100).toFixed(1).replace('.', ',') : '');
    const conta = (l: Linha, nivel: number) => { linhas.push([`${'  '.repeat(nivel)}${l.codigo} ${l.nome}`.trimEnd(), ...l.valores.map(cel), cel(l.total), pct(l.total)]); l.filhos.forEach((f) => conta(f, nivel + 1)); };
    for (const g of d.grupos) {
      linhas.push([`${SINAL[g.chave] ?? ''}${g.nome}`, ...g.valores.map(cel), cel(g.total), pct(g.total)]);
      g.contas.forEach((c) => conta(c, 1));
      const s = DEPOIS[g.chave];
      if (s) linhas.push([s[1], ...d.subtotais[s[0]].valores.map(cel), cel(d.subtotais[s[0]].total), pct(d.subtotais[s[0]].total)]);
    }
    const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const url = URL.createObjectURL(new Blob(['﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `dre-${de}-a-${ate}-${regime}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="coluna">
      <div className="busca">
        <label className="flex" style={{ gap: 6 }}>De <input type="month" value={de} max={ate} onChange={(e) => e.target.value && setDe(e.target.value)} /></label>
        <label className="flex" style={{ gap: 6 }}>até <input type="month" value={ate} min={de} onChange={(e) => e.target.value && setAte(e.target.value)} /></label>
        <select value={regime} onChange={(e) => setRegime(e.target.value as 'caixa' | 'competencia')} aria-label="Regime">
          <option value="caixa">Caixa (pelo dia do pagamento)</option>
          <option value="competencia">Competência (pelo vencimento)</option>
        </select>
        <select value={base} onChange={(e) => setBase(e.target.value as 'receita' | 'grupo')} aria-label="Percentual">
          <option value="receita">% sobre a receita líquida</option>
          <option value="grupo">% dentro do grupo</option>
        </select>
        <button className="botao claro" onClick={() => setAbertos(d && abertos.size ? new Set() : new Set(d?.grupos.map((g) => g.chave)))}>{abertos.size ? 'Recolher tudo' : 'Abrir tudo'}</button>
        <button className="botao claro" onClick={exportar} disabled={!d}>Exportar</button>
        <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={zeradas} onChange={(e) => setZeradas(e.target.checked)} /> Mostrar contas sem valor</label>
      </div>
      {q.error && <Erro erro={q.error} />}
      {d && d.semClassificar > 0 && (
        <div className="cartao" style={{ borderColor: 'var(--dourado)' }}>
          <b>{d.semClassificar} lançamento(s) do período estão sem conta do plano.</b> Eles aparecem em "Outras receitas e despesas › a classificar".{' '}
          <button className="botao claro pequeno" onClick={irParaTitulos}>Classificar agora</button>
        </div>
      )}
      {q.isLoading || !d || !rl ? <Carregando /> : (
        <>
          <div className="dre-rolagem">
            <table className="dre">
              <thead><tr><th>Conta</th>{d.meses.map((m) => <th key={m}>{nomeMes(m)}</th>)}<th>Total</th></tr></thead>
              <tbody>
                {d.grupos.map((g) => {
                  const s = DEPOIS[g.chave];
                  return (
                    <Fragment key={g.chave}>
                      <tr className="grupo" onClick={() => alternar(g.chave)}>
                        <td><span className="seta">{abertos.has(g.chave) ? '▾' : '▸'}</span>{SINAL[g.chave]}{g.nome}</td>
                        {celulas(g.valores, g.total, rl.valores, rl.total)}
                      </tr>
                      {abertos.has(g.chave) && g.contas.flatMap((c) => linhasConta(c, g, 1))}
                      {abertos.has(g.chave) && !g.contas.some((c) => zeradas || c.valores.some(Boolean)) && <tr className="conta"><td style={{ paddingLeft: 32 }} className="muted" colSpan={d.meses.length + 2}>Nada lançado neste grupo no período.</td></tr>}
                      {s && <tr className={`subtotal ${s[2] ? 'final' : ''}`}><td>{s[1]}</td>{celulas(d.subtotais[s[0]].valores, d.subtotais[s[0]].total, rl.valores, rl.total)}</tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Embaixo de cada valor está o percentual {base === 'receita' ? 'sobre a receita líquida do mês' : 'dentro do grupo'}; a barrinha mostra o peso da conta no grupo. Clique num valor para ver os lançamentos.
            As contas "automáticas" (vendas, devoluções, comissão retida no acerto e custo das peças vendidas) vêm das vendas e dos acertos, pela data em que aconteceram, nos dois regimes.
          </p>
          {d.fora.contas.some((c) => c.total !== 0) && (
            <details className="cartao">
              <summary><b>Movimentos que não entram no resultado</b> <span className="muted">(recebimento de vendas, compra de mercadoria, transferências, empréstimos)</span></summary>
              <div className="dre-rolagem" style={{ marginTop: 10 }}>
                <table className="dre">
                  <thead><tr><th>Conta</th>{d.meses.map((m) => <th key={m}>{nomeMes(m)}</th>)}<th>Total</th></tr></thead>
                  <tbody>{d.fora.contas.filter((c) => c.total !== 0 || c.valores.some(Boolean)).flatMap((c) => linhasConta(c, d.fora, 0))}</tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
      {foco && <Lancamentos {...foco} regime={regime} fechar={() => setFoco(null)} />}
    </div>
  );
}

function Lancamentos({ contaId, mes, nome, regime, fechar }: { contaId: string; mes: string; nome: string; regime: string; fechar: () => void }) {
  const q = useQuery({ queryKey: ['dre', 'lancamentos', contaId, mes, regime], queryFn: () => api<any>(`/financeiro/dre/lancamentos?contaId=${contaId}&mes=${mes}&regime=${regime}`) });
  const itens: any[] = q.data?.itens ?? [];
  const total = itens.reduce((a, t) => a + (t.tipo === 'receber' ? 1 : -1) * (regime === 'caixa' ? t.valorPago ?? t.valor : t.valor), 0);
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
        <h3 style={{ marginTop: 0 }}>{nome} · {nomeMes(mes)}</h3>
        {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
          <>
            {q.data.calculadas.length > 0 && <p className="muted">{q.data.calculadas.map((c: any) => c.nome).join(', ')}: valor calculado pelo sistema a partir das vendas e dos acertos (veja o detalhe em Relatórios › Indicadores).</p>}
            {itens.length > 0 ? (
              <table className="tabela">
                <thead><tr><th>{regime === 'caixa' ? 'Pago em' : 'Vencimento'}</th><th>Descrição</th><th>Conta do plano</th><th>Pessoa</th><th>Situação</th><th className="num">Valor</th></tr></thead>
                <tbody>
                  {itens.map((t) => (
                    <tr key={t.id}>
                      <td>{data(regime === 'caixa' ? t.pagoEm : t.vencimento)}</td>
                      <td>{t.descricao}</td>
                      <td>{t.conta ? `${t.codigo} ${t.conta}` : <span className="etiqueta alerta">Sem conta</span>}</td>
                      <td>{t.pessoa ?? '—'}</td>
                      <td>{t.status === 'pago' ? `Pago${t.contaBancaria ? ` · ${t.contaBancaria}` : ''}` : t.status === 'aberto' ? 'Em aberto' : t.status}</td>
                      <td className="num">{t.tipo === 'pagar' ? '−' : ''}{reais(regime === 'caixa' ? t.valorPago ?? t.valor : t.valor)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={5}>{itens.length} lançamento(s){itens.length >= 500 ? ' (mostrando os 500 primeiros)' : ''}</td><td className="num">{total < 0 ? '−' : ''}{reais(Math.abs(total))}</td></tr></tfoot>
              </table>
            ) : !q.data.calculadas.length && <p className="muted">Nenhum lançamento.</p>}
          </>
        )}
        <div className="flex" style={{ marginTop: 12 }}><button className="botao claro" onClick={fechar}>Fechar</button></div>
      </div>
    </div>
  );
}
