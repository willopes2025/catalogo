import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { data, pct, reais, telefone } from '../formato';
import { Abas, Carregando, Erro, Topo } from '../componentes/ui';

type Aba = 'desempenho' | 'maletas' | 'produtos' | 'vendas' | 'financeiro';
type Col = [chave: string, titulo: string, tipo?: 'dinheiro' | 'pct' | 'data' | 'num' | 'tel'];

const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const menos30 = () => new Date(Date.now() - 33 * 86_400_000).toISOString().slice(0, 10);

function valor(v: unknown, tipo?: Col[2]) {
  if (v === null || v === undefined || v === '') return '—';
  if (tipo === 'dinheiro') return reais(Number(v));
  if (tipo === 'pct') return pct(Number(v));
  if (tipo === 'data') return data(String(v));
  if (tipo === 'tel') return telefone(String(v));
  return String(v);
}

/** Exporta para Excel (CSV com ponto e vírgula, que o Excel em português abre direto). */
function exportar(nome: string, colunas: Col[], linhas: Record<string, unknown>[]) {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cel = (v: unknown, t?: Col[2]) => (v === null || v === undefined ? '' : t === 'dinheiro' ? (Number(v) / 100).toFixed(2).replace('.', ',') : t === 'pct' ? (Number(v) / 100).toFixed(1).replace('.', ',') : String(v));
  const csv = [colunas.map((c) => esc(c[1])).join(';'), ...linhas.map((l) => colunas.map((c) => esc(cel(l[c[0]], c[2]))).join(';'))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nome}-${hoje()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Tabela({ nome, colunas, linhas, titulo }: { nome: string; colunas: Col[]; linhas: Record<string, unknown>[]; titulo?: string }) {
  return (
    <div className="coluna" style={{ gap: 8 }}>
      <div className="flex entre">{titulo ? <h3>{titulo}</h3> : <span />}<button className="botao claro pequeno" disabled={!linhas.length} onClick={() => exportar(nome, colunas, linhas)}>Exportar para Excel</button></div>
      {linhas.length === 0 ? <div className="cartao vazio">Nada no período.</div> : (
        <table className="tabela">
          <thead><tr>{colunas.map((c) => <th key={c[0]} className={c[2] && c[2] !== 'tel' && c[2] !== 'data' ? 'num' : ''}>{c[1]}</th>)}</tr></thead>
          <tbody>{linhas.map((l, i) => <tr key={i}>{colunas.map((c) => <td key={c[0]} className={c[2] && c[2] !== 'tel' && c[2] !== 'data' ? 'num' : ''}>{valor(l[c[0]], c[2])}</td>)}</tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

export function Relatorios() {
  const [aba, setAba] = useState<Aba>('desempenho');
  const [de, setDe] = useState(menos30());
  const [ate, setAte] = useState(hoje());
  const comPeriodo = ['desempenho', 'produtos', 'vendas'].includes(aba);
  const q = useQuery({ queryKey: ['relatorio', aba, de, ate], queryFn: () => api<any>(`/relatorios/${aba}${comPeriodo ? `?de=${de}&ate=${ate}` : ''}`) });
  return (
    <>
      <Topo eb="Relatórios" titulo="Relatórios" acoes={comPeriodo && <div className="flex"><input type="date" value={de} onChange={(e) => setDe(e.target.value)} /><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></div>} />
      <Abas ativa={aba} mudar={setAba} abas={[['desempenho', 'Desempenho da rede'], ['maletas', 'Maletas'], ['produtos', 'Produtos'], ['vendas', 'Vendas'], ['financeiro', 'Financeiro']]} />
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          {aba === 'desempenho' && <Tabela nome="desempenho" linhas={q.data.linhas} colunas={[['nome', 'Representante'], ['cidade', 'Cidade'], ['nivel', 'Nível'], ['lider', 'Líder'], ['acertos', 'Acertos', 'num'], ['pecas_acertadas', 'Peças', 'num'], ['pecas_vendidas', 'Vendidas', 'num'], ['percentual_medio_pb', '% vendido', 'pct'], ['vendido', 'Vendido', 'dinheiro'], ['comissao', 'Comissão', 'dinheiro'], ['devido_matriz', 'Devido à matriz', 'dinheiro'], ['pecas_perdidas', 'Perdidas', 'num'], ['atraso_medio', 'Atraso médio (dias)', 'num']]} />}
          {aba === 'maletas' && (
            <div className="coluna">
              <Tabela nome="maletas-atrasadas" titulo={`Maletas atrasadas (${q.data.atrasadas.length})`} linhas={q.data.atrasadas} colunas={[['numero', 'Maleta', 'num'], ['nome', 'Representante'], ['telefone', 'Telefone', 'tel'], ['data_limite', 'Acerto era em', 'data'], ['dias_atraso', 'Dias de atraso', 'num'], ['valor', 'Valor na maleta', 'dinheiro']]} />
              <Tabela nome="representantes-sem-maleta" titulo={`Representantes ativas sem maleta (${q.data.semMaleta.length})`} linhas={q.data.semMaleta} colunas={[['nome', 'Representante'], ['cidade', 'Cidade'], ['telefone', 'Telefone', 'tel'], ['ultimo_acerto', 'Último acerto', 'data']]} />
            </div>
          )}
          {aba === 'produtos' && <Tabela nome="produtos" linhas={q.data.linhas} colunas={[['curva', 'Curva'], ['referencia', 'Ref.'], ['descricao', 'Descrição'], ['categoria', 'Categoria'], ['vendidas', 'Vendidas', 'num'], ['faturamento', 'Faturamento', 'dinheiro'], ['estoque', 'Estoque', 'num'], ['em_maletas', 'Em maletas', 'num'], ['giro', 'Giro', 'num'], ['preco', 'Preço', 'dinheiro']]} />}
          {aba === 'vendas' && (
            <div className="coluna">
              <Tabela nome="vendas-por-forma" titulo="Por forma de pagamento (loja e vendas avulsas)" linhas={q.data.porForma} colunas={[['forma', 'Forma'], ['quantidade', 'Pagamentos', 'num'], ['valor', 'Valor', 'dinheiro']]} />
              <Tabela nome="vendas-por-dia" titulo="Por dia" linhas={q.data.porDia.filter((d: any) => d.rede || d.loja || d.outras)} colunas={[['dia', 'Dia', 'data'], ['rede', 'Rede (acertos)', 'dinheiro'], ['loja', 'Loja e eventos', 'dinheiro'], ['outras', 'Avulsas e revenda', 'dinheiro']]} />
            </div>
          )}
          {aba === 'financeiro' && (
            <div className="coluna">
              <Tabela nome="fluxo-de-caixa" titulo="Fluxo de caixa por mês" linhas={q.data.fluxo} colunas={[['mes', 'Mês'], ['recebido', 'Recebido', 'dinheiro'], ['pago', 'Pago', 'dinheiro'], ['a_receber', 'A receber', 'dinheiro'], ['a_pagar', 'A pagar', 'dinheiro']]} />
              <Tabela nome="inadimplencia" titulo="Inadimplência por faixa de atraso" linhas={q.data.faixas} colunas={[['faixa', 'Atraso'], ['pessoas', 'Pessoas', 'num'], ['titulos', 'Títulos', 'num'], ['valor', 'Valor', 'dinheiro']]} />
              <Tabela nome="maiores-devedores" titulo="Maiores valores em atraso" linhas={q.data.devedores} colunas={[['nome', 'Nome'], ['telefone', 'Telefone', 'tel'], ['titulos', 'Títulos', 'num'], ['maior_atraso', 'Maior atraso (dias)', 'num'], ['valor', 'Valor', 'dinheiro']]} />
            </div>
          )}
        </>
      )}
    </>
  );
}
