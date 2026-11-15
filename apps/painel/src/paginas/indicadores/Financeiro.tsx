import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { data, pct, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';
import { BarrasLista, BarrasTempo, Cartao, COR, Kpi, mesCurto, Tabela } from './comum';

/** Financeiro: resultado mês a mês, o caixa das próximas semanas e quem deve. */
export function Financeiro() {
  const q = useQuery({ queryKey: ['indicadores', 'financeiro'], queryFn: () => api<any>('/indicadores/financeiro') });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { meses, despesas, caixa: c, fluxo, faixas, devedores } = q.data;
  const linha = (rotulo: string, chave: string, classe = '', sinal = 1) => (
    <tr className={classe}>
      <td>{rotulo}</td>
      {meses.map((m: any) => {
        const v = m[chave] * sinal;
        return <td key={m.mes} className={classe === 'total' ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : ''}>{v ? reais(v) : '—'}</td>;
      })}
    </tr>
  );
  const categorias = [...new Set<string>(despesas.map((x: any) => x.categoria))];
  const totalDesp = (cat: string) => despesas.filter((x: any) => x.categoria === cat).reduce((a: number, x: any) => a + x.valor, 0);
  const menorSaldo = Math.min(...fluxo.map((s: any) => s.saldo));
  return (
    <>
      <div className="ind-grade k5">
        <Kpi i={0} tom="escuro" rotulo="Saldo nas contas" valor={reais(c.saldo)} detalhe="contas cadastradas" />
        <Kpi i={1} tom={menorSaldo < 0 ? 'atencao' : 'bom'} rotulo="Menor saldo em 8 semanas" valor={reais(menorSaldo)} detalhe={menorSaldo < 0 ? 'vai faltar caixa: antecipe recebimentos' : 'caixa cobre as contas previstas'} dica="Saldo de hoje + o que vence a receber − o que vence a pagar, semana a semana. Não conta o que está atrasado." />
        <Kpi i={2} tom={c.inadimplenciaPb >= 1000 ? 'atencao' : undefined} rotulo="Inadimplência" valor={pct(c.inadimplenciaPb)} detalhe={`${reais(c.receberAtrasado)} vencidos`} />
        <Kpi i={3} rotulo="Pagam em dia" valor={pct(c.pagosEmDiaPb)} detalhe={c.atrasoMedioPagos ? `quem atrasa, atrasa ${c.atrasoMedioPagos} dias` : 'últimos 90 dias'} dica="Dos títulos de clientes e revendedoras pagos nos últimos 90 dias, quantos foram pagos até o vencimento." />
        <Kpi i={4} rotulo="Cartão para conciliar" valor={reais(c.cartaoAConciliar)} detalhe="repasses vencidos sem baixa" dica="Vendas no cartão cujo repasse já deveria ter caído e ainda não foi baixado no Financeiro." />
      </div>

      <div className="ind-grade">
        <Cartao i={5} titulo="Resultado mês a mês" sub="vendas pela data da venda; despesas pela data do pagamento">
          <div className="ind-rolagem">
            <table className="ind-dre">
              <thead><tr><th></th>{meses.map((m: any) => <th key={m.mes}>{mesCurto(m.mes)}</th>)}</tr></thead>
              <tbody>
                {linha('Vendido pela rede (acertos)', 'rede', 'sub')}
                {linha('Lojas, eventos e avulsas', 'vendas', 'sub')}
                {linha('(−) Devoluções', 'devolucoes', 'sub', -1)}
                {linha('(−) Comissão das revendedoras', 'comissao', 'sub', -1)}
                {linha('= Receita da empresa', 'liquida', 'total')}
                {linha('(−) Custo das peças vendidas', 'cmv', 'sub', -1)}
                {linha('= Lucro bruto', 'lucroBruto', 'total')}
                <tr><td>Margem bruta</td>{meses.map((m: any) => <td key={m.mes}>{m.bruta ? pct(m.margemPb) : '—'}</td>)}</tr>
                {linha('(−) Despesas pagas', 'despesas', 'sub', -1)}
                {linha('= Resultado', 'resultado', 'total')}
              </tbody>
            </table>
          </div>
          <p className="ind-nota">Despesas são as contas a pagar baixadas no Financeiro (aluguel, folha, fornecedores, comissões de vendedoras). Para o resultado ficar certo, lance todas as contas da empresa lá, com categoria.</p>
        </Cartao>
      </div>

      <div className="ind-grade g21">
        <Cartao i={7} titulo="Caixa das próximas 8 semanas" sub="o que vence a receber e a pagar">
          <BarrasTempo
            altura={170}
            pontos={fluxo.map((s: any) => ({ rotulo: data(s.semana).slice(0, 5), valores: { receber: s.receber, pagar: s.pagar, saldo: s.saldo }, extra: `Semana de ${data(s.semana)}` }))}
            series={[['receber', 'A receber', COR.bom], ['pagar', 'A pagar', COR.ruim]]}
            linha={{ chave: 'saldo', nome: 'Saldo previsto', cor: COR.lojas }}
          />
          <p className="ind-nota">Atrasados ficam fora da previsão: {reais(c.receberAtrasado)} a receber e {reais(c.pagarAtrasado)} a pagar já venceram.</p>
        </Cartao>
        <Cartao i={6} titulo="Para onde foi o dinheiro" sub="despesas pagas em 6 meses">
          <BarrasLista itens={categorias.map((cat) => ({ nome: cat, valor: totalDesp(cat) })).sort((a, b) => b.valor - a.valor).slice(0, 9)} vazio="Nenhuma conta paga lançada." />
        </Cartao>
      </div>

      <div className="ind-grade g21">
        <div className="ini-anim" style={{ minWidth: 0 }}>
      <Tabela
        nome="quem-deve"
        titulo="Quem deve"
        sub="Os 50 maiores valores em atraso. “Na maleta” mostra quanto a revendedora ainda tem em peças da empresa."
        linhas={devedores}
        vazio="Ninguém em atraso."
        colunas={[['nome', 'Nome'], ['telefone', 'Telefone', 'tel'], ['titulos', 'Títulos', 'num'], ['valor', 'Valor vencido', 'dinheiro'], ['maior_atraso', 'Maior atraso (dias)', 'num'], ['em_maleta', 'Na maleta', 'dinheiro']]}
        celula={(l, k) => (k === 'nome' ? <Link to={l.tipo === 'representante' ? `/rede/${l.id}` : `/cadastros/${l.id}`}>{l.nome}</Link> : undefined)}
      />
        </div>
        <Cartao i={8} titulo="Vencidos por tempo de atraso" sub="clientes e revendedoras">
          <BarrasLista itens={faixas.map((f: any) => ({ nome: f.faixa, valor: f.valor, extra: `${f.pessoas} pessoa(s)`, cor: /90|61/.test(f.faixa) ? COR.ruim : undefined }))} vazio="Ninguém em atraso. 🎉" />
          <p className="ind-nota">Quanto mais velho o atraso, menor a chance de receber: priorize a cobrança das faixas de cima antes que passem de 60 dias.</p>
        </Cartao>
      </div>
    </>
  );
}
