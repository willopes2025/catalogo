import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { pct, reais } from '../../formato';
import { Abas, Carregando, Erro } from '../../componentes/ui';
import { BarrasLista, Cartao, Kpi, Tabela, type Col } from './comum';

type Lista = 'categorias' | 'vendidos' | 'repor' | 'parados' | 'devolvidos' | 'margem';

/** Produtos: o que vende, o que dá lucro, o que comprar e o que está prendendo dinheiro. */
export function Produtos({ de, ate }: { de: string; ate: string }) {
  const q = useQuery({ queryKey: ['indicadores', 'produtos', de, ate], queryFn: () => api<any>(`/indicadores/produtos?de=${de}&ate=${ate}`) });
  const [lista, setLista] = useState<Lista>('categorias');
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const d = q.data;
  const r = d.resumo;
  const base: Col[] = [['referencia', 'Ref.'], ['descricao', 'Produto'], ['categoria', 'Categoria']];
  const curva = (l: any, k: string) => (k === 'curva' ? <span className={`ind-curva ${l.curva}`}>{l.curva}</span> : undefined);
  return (
    <>
      <div className="ind-grade k5">
        <Kpi i={0} tom="escuro" rotulo="Faturamento em produtos" valor={reais(r.faturamento)} detalhe={`${r.pecasVendidas.toLocaleString('pt-BR')} peças · ${r.produtosVendidos} produtos`} />
        <Kpi i={1} rotulo="Margem bruta" valor={pct(r.margemPb)} detalhe={`custo vendido ${reais(r.cmv)}`} dica="Antes da comissão das revendedoras: (preço vendido − custo) ÷ preço vendido." />
        <Kpi i={2} rotulo="Aceitação na rede" valor={pct(r.aceitacaoPb)} detalhe="vendidas ÷ (vendidas + devolvidas)" dica="Das peças que saíram das maletas nos acertos, quantas foram vendidas em vez de voltar." />
        <Kpi i={3} tom={r.paradosCusto > 0 ? 'atencao' : undefined} rotulo="Capital parado" valor={reais(r.paradosCusto)} detalhe={`${r.paradosPecas.toLocaleString('pt-BR')} peças de ${r.paradosProdutos} produtos, 90+ dias sem vender`} dica="Peças em casa (a custo) de produtos sem nenhuma venda há mais de 90 dias. Candidatas a promoção, kit ou banho novo." />
        <Kpi i={4} tom={r.reporProdutos ? 'atencao' : undefined} rotulo="Repor" valor={`${r.reporProdutos} produtos`} detalhe={`${r.reporPecas.toLocaleString('pt-BR')} peças · ${reais(r.reporCusto)} a custo`} dica="Produtos que vendem e têm menos de 30 dias de estoque em casa. Sugestão para cobrir 45 dias." />
      </div>
      {r.semCusto > 0 && <div className="aviso alerta" style={{ marginBottom: 14 }}><b>{r.semCusto} produto(s) sem custo cadastrado.</b> A margem e o capital parado deles aparecem zerados. Preencha o custo no cadastro do produto.</div>}

      <div className="ind-grade k2">
        <Cartao i={5} titulo="Categorias que mais faturam" sub="participação">
          <BarrasLista itens={d.porCategoria.filter((c: any) => c.faturamento > 0).slice(0, 8).map((c: any) => ({ nome: c.categoria, valor: c.faturamento, extra: `${pct(c.participacao_pb)} · margem ${c.margem_pb === null ? '—' : pct(c.margem_pb)}` }))} />
        </Cartao>
        <Cartao i={6} titulo="Onde está o estoque em casa" sub="a custo">
          <BarrasLista itens={[...d.porCategoria].sort((a: any, b: any) => b.estoque_custo - a.estoque_custo).slice(0, 8).map((c: any) => ({ nome: c.categoria, valor: c.estoque_custo, extra: `${c.estoque.toLocaleString('pt-BR')} peças · dura ${c.cobertura_dias === null ? 'sem venda' : `${c.cobertura_dias} dias`}` }))} />
        </Cartao>
      </div>

      <Abas<Lista> ativa={lista} mudar={setLista} abas={[['categorias', 'Por categoria'], ['vendidos', 'Mais vendidos'], ['repor', `Repor (${d.repor.length})`], ['parados', `Parados (${r.paradosProdutos})`], ['devolvidos', `A rede devolve (${d.devolvidos.length})`], ['margem', `Margem baixa (${d.margemBaixa.length})`]]} />
      {lista === 'categorias' && <Tabela nome="categorias" linhas={d.porCategoria} colunas={[['categoria', 'Categoria'], ['produtos', 'Produtos', 'num'], ['vendidas', 'Peças vendidas', 'num'], ['faturamento', 'Faturamento', 'dinheiro'], ['participacao_pb', 'Participação', 'pct'], ['margem_pb', 'Margem', 'pct'], ['aceitacao_pb', 'Aceitação na rede', 'pct', 'Vendidas ÷ (vendidas + devolvidas) nos acertos'], ['estoque', 'Em casa', 'num'], ['em_maletas', 'Na rua', 'num'], ['estoque_custo', 'Estoque a custo', 'dinheiro'], ['cobertura_dias', 'Dura (dias)', 'num']]} />}
      {lista === 'vendidos' && <Tabela nome="mais-vendidos" celula={curva} linhas={d.maisVendidos} sub="Os 100 que mais faturaram. Curva A = os que somam 80% do faturamento." colunas={[['curva', 'Curva'], ...base, ['vendidas', 'Vendidas', 'num'], ['faturamento', 'Faturamento', 'dinheiro'], ['margem', 'Lucro bruto', 'dinheiro'], ['margem_pb', 'Margem', 'pct'], ['aceitacao_pb', 'Aceitação', 'pct'], ['estoque', 'Em casa', 'num'], ['em_maletas', 'Na rua', 'num'], ['cobertura_dias', 'Dura (dias)', 'num']]} />}
      {lista === 'repor' && <Tabela nome="repor" linhas={d.repor} vazio="Nenhum produto pedindo reposição neste período." sub="Vendem bem e têm menos de 30 dias de estoque em casa. A sugestão cobre 45 dias de venda; o que está na rua não entra na conta porque pode voltar ou não." colunas={[...base, ['vendidas', 'Vendidas', 'num'], ['estoque', 'Em casa', 'num'], ['em_maletas', 'Na rua', 'num'], ['cobertura_dias', 'Dura (dias)', 'num'], ['sugestao', 'Sugestão de compra', 'num'], ['custo', 'Custo unit.', 'dinheiro'], ['faturamento', 'Faturamento', 'dinheiro']]} />}
      {lista === 'parados' && <Tabela nome="parados" linhas={d.parados} vazio="Nada parado há mais de 90 dias." sub={`Peças em casa de produtos sem venda há mais de 90 dias: ${reais(r.paradosCusto)} a custo, ${reais(r.paradosPreco)} a preço de venda. Produtos cadastrados há menos de 60 dias não entram.`} colunas={[...base, ['estoque', 'Em casa', 'num'], ['em_maletas', 'Na rua', 'num'], ['parado_custo', 'Parado (custo)', 'dinheiro'], ['preco', 'Preço', 'dinheiro'], ['dias_sem_venda', 'Dias sem vender', 'num'], ['ultima_venda', 'Última venda', 'data']]} />}
      {lista === 'devolvidos' && <Tabela nome="rede-devolve" linhas={d.devolvidos} vazio="Nenhum produto com devolução alta nos acertos do período." sub="Foram para as maletas e voltaram: menos de 30% vendido nos acertos. Tire do mix das maletas ou reveja preço." colunas={[...base, ['vendidas_rede', 'Vendidas na rede', 'num'], ['devolvidas_rede', 'Devolvidas', 'num'], ['aceitacao_pb', 'Aceitação', 'pct'], ['preco', 'Preço', 'dinheiro'], ['estoque', 'Em casa', 'num'], ['em_maletas', 'Na rua', 'num']]} />}
      {lista === 'margem' && <Tabela nome="margem-baixa" linhas={d.margemBaixa} vazio="Nenhum produto vendido com margem abaixo de 40%." sub="Vendidos com menos de 40% de margem bruta (antes da comissão de 30% da rede, sobra pouco)." colunas={[...base, ['vendidas', 'Vendidas', 'num'], ['faturamento', 'Faturamento', 'dinheiro'], ['cmv', 'Custo', 'dinheiro'], ['margem_pb', 'Margem', 'pct'], ['preco', 'Preço', 'dinheiro'], ['custo', 'Custo unit.', 'dinheiro']]} />}
    </>
  );
}
