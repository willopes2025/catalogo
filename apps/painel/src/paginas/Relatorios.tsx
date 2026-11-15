import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { Abas, Carregando, Erro, Topo } from '../componentes/ui';
import { hoje, periodos, Tabela } from './indicadores/comum';
import { Geral } from './indicadores/Geral';
import { Rede } from './indicadores/Rede';
import { Produtos } from './indicadores/Produtos';
import { Financeiro } from './indicadores/Financeiro';
import { CrmInd } from './indicadores/CrmInd';

type Aba = 'geral' | 'rede' | 'produtos' | 'financeiro' | 'crm' | 'tabelas';
type Tabelas = 'desempenho' | 'maletas' | 'produtos' | 'vendas' | 'financeiro';

/** Indicadores para decisão (visão do negócio, rede, produtos, financeiro, CRM) e as tabelas completas para exportar. */
export function Relatorios() {
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) ?? 'geral';
  const ps = periodos();
  const [atalho, setAtalho] = useState(params.get('periodo') ?? 'mes');
  const [de, setDe] = useState(ps.find((p) => p[0] === atalho)?.[2] ?? ps[0][2]);
  const [ate, setAte] = useState(ps.find((p) => p[0] === atalho)?.[3] ?? hoje());
  const comPeriodo = aba !== 'financeiro';
  const valido = /^\d{4}-\d{2}-\d{2}$/.test(de) && /^\d{4}-\d{2}-\d{2}$/.test(ate) && de <= ate;
  const abas: [Aba, string][] = [['geral', 'Visão do negócio'], ['rede', 'Rede'], ['produtos', 'Produtos'], ['financeiro', 'Financeiro'], ...(pode('crm', 'ver') ? ([['crm', 'CRM']] as [Aba, string][]) : []), ['tabelas', 'Tabelas para Excel']];
  return (
    <>
      <Topo
        eb="Relatórios"
        titulo="Indicadores e relatórios"
        acoes={<button className="botao claro" onClick={() => window.print()}>Imprimir</button>}
      />
      <Abas ativa={aba} mudar={(a) => setParams(a === 'geral' ? {} : { aba: a })} abas={abas} />
      {comPeriodo && (
        <div className="ind-periodo" style={{ marginBottom: 14 }}>
          {ps.map(([k, nome, d, a]) => (
            <button key={k} className={atalho === k ? 'ativo' : ''} onClick={() => { setAtalho(k); setDe(d); setAte(a); }}>{nome}</button>
          ))}
          <span className="muted" style={{ fontSize: 13, marginLeft: 6 }}>ou de</span>
          <input type="date" value={de} max={ate} onChange={(e) => { setDe(e.target.value); setAtalho(''); }} />
          <span className="muted" style={{ fontSize: 13 }}>até</span>
          <input type="date" value={ate} min={de} max={hoje()} onChange={(e) => { setAte(e.target.value); setAtalho(''); }} />
        </div>
      )}
      {!valido ? <div className="aviso alerta">Escolha um período válido.</div> : (
        <>
          {aba === 'geral' && <Geral de={de} ate={ate} />}
          {aba === 'rede' && <Rede de={de} ate={ate} />}
          {aba === 'produtos' && <Produtos de={de} ate={ate} />}
          {aba === 'financeiro' && <Financeiro />}
          {aba === 'crm' && <CrmInd de={de} ate={ate} />}
          {aba === 'tabelas' && <TabelasCompletas de={de} ate={ate} />}
        </>
      )}
    </>
  );
}

/** As tabelas completas, linha a linha, para ordenar na tela ou levar para o Excel. */
function TabelasCompletas({ de, ate }: { de: string; ate: string }) {
  const [aba, setAba] = useState<Tabelas>('desempenho');
  const comPeriodo = ['desempenho', 'produtos', 'vendas'].includes(aba);
  const q = useQuery({ queryKey: ['relatorio', aba, de, ate], queryFn: () => api<any>(`/relatorios/${aba}${comPeriodo ? `?de=${de}&ate=${ate}` : ''}`) });
  return (
    <>
      <div className="ind-filtro">
        {([['desempenho', 'Desempenho da rede'], ['maletas', 'Maletas'], ['produtos', 'Produtos'], ['vendas', 'Vendas'], ['financeiro', 'Financeiro']] as [Tabelas, string][]).map(([k, n]) => (
          <button key={k} className={aba === k ? 'ativo' : ''} onClick={() => setAba(k)}>{n}</button>
        ))}
        {!comPeriodo && <span className="muted" style={{ fontSize: 13 }}>posição de hoje (não usa o período)</span>}
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          {aba === 'desempenho' && <Tabela nome="desempenho" linhas={q.data.linhas} colunas={[['nome', 'Representante'], ['cidade', 'Cidade'], ['nivel', 'Nível'], ['lider', 'Líder'], ['acertos', 'Acertos', 'num'], ['pecas_acertadas', 'Peças', 'num'], ['pecas_vendidas', 'Vendidas', 'num'], ['percentual_medio_pb', '% vendido', 'pct'], ['vendido', 'Vendido', 'dinheiro'], ['comissao', 'Comissão', 'dinheiro'], ['devido_matriz', 'Devido à matriz', 'dinheiro'], ['pecas_perdidas', 'Perdidas', 'num'], ['atraso_medio', 'Atraso médio (dias)', 'num']]} />}
          {aba === 'maletas' && (
            <div className="coluna" style={{ gap: 18 }}>
              <Tabela nome="maletas-atrasadas" titulo={`Maletas atrasadas (${q.data.atrasadas.length})`} linhas={q.data.atrasadas} colunas={[['numero', 'Maleta', 'num'], ['nome', 'Representante'], ['telefone', 'Telefone', 'tel'], ['data_limite', 'Acerto era em', 'data'], ['dias_atraso', 'Dias de atraso', 'num'], ['valor', 'Valor na maleta', 'dinheiro']]} />
              <Tabela nome="representantes-sem-maleta" titulo={`Representantes ativas sem maleta (${q.data.semMaleta.length})`} linhas={q.data.semMaleta} colunas={[['nome', 'Representante'], ['cidade', 'Cidade'], ['telefone', 'Telefone', 'tel'], ['ultimo_acerto', 'Último acerto', 'data']]} />
            </div>
          )}
          {aba === 'produtos' && <Tabela nome="produtos" linhas={q.data.linhas} sub="Todos os produtos com venda ou estoque. Vendas pelo preço real, sem canceladas e sem devoluções." colunas={[['curva', 'Curva'], ['referencia', 'Ref.'], ['descricao', 'Descrição'], ['categoria', 'Categoria'], ['vendidas', 'Vendidas', 'num'], ['devolvidas_rede', 'Devolvidas na rede', 'num'], ['faturamento', 'Faturamento', 'dinheiro'], ['cmv', 'Custo vendido', 'dinheiro'], ['margem', 'Lucro bruto', 'dinheiro'], ['margem_pb', 'Margem', 'pct'], ['estoque', 'Estoque', 'num'], ['em_maletas', 'Em maletas', 'num'], ['giro', 'Giro', 'num'], ['preco', 'Preço', 'dinheiro'], ['custo', 'Custo', 'dinheiro']]} />}
          {aba === 'vendas' && (
            <div className="coluna" style={{ gap: 18 }}>
              <Tabela nome="vendas-por-forma" titulo="Por forma de pagamento (loja e vendas avulsas)" linhas={q.data.porForma} colunas={[['forma', 'Forma'], ['quantidade', 'Pagamentos', 'num'], ['valor', 'Valor', 'dinheiro']]} />
              <Tabela nome="vendas-por-dia" titulo="Por dia" sub="Já descontadas as devoluções." linhas={q.data.porDia.filter((d: any) => d.rede || d.loja || d.outras)} colunas={[['dia', 'Dia', 'data'], ['rede', 'Rede (acertos)', 'dinheiro'], ['loja', 'Loja e eventos', 'dinheiro'], ['outras', 'Avulsas e revenda', 'dinheiro']]} />
            </div>
          )}
          {aba === 'financeiro' && (
            <div className="coluna" style={{ gap: 18 }}>
              <Tabela nome="fluxo-de-caixa" titulo="Fluxo de caixa por mês" linhas={q.data.fluxo} colunas={[['mes', 'Mês'], ['recebido', 'Recebido', 'dinheiro'], ['pago', 'Pago', 'dinheiro'], ['a_receber', 'A receber', 'dinheiro'], ['a_pagar', 'A pagar', 'dinheiro']]} />
              <Tabela nome="inadimplencia" titulo="Inadimplência por faixa de atraso" sub="Clientes e revendedoras; repasses de cartão ficam de fora." linhas={q.data.faixas} colunas={[['faixa', 'Atraso'], ['pessoas', 'Pessoas', 'num'], ['titulos', 'Títulos', 'num'], ['valor', 'Valor', 'dinheiro']]} />
              <Tabela nome="maiores-devedores" titulo="Maiores valores em atraso" linhas={q.data.devedores} colunas={[['nome', 'Nome'], ['telefone', 'Telefone', 'tel'], ['titulos', 'Títulos', 'num'], ['maior_atraso', 'Maior atraso (dias)', 'num'], ['valor', 'Valor', 'dinheiro']]} />
            </div>
          )}
        </>
      )}
    </>
  );
}
