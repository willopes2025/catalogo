import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { pct, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';
import { Alertas, BarrasLista, BarrasTempo, Cartao, COR, Kpi, mesCurto, type Alerta } from './comum';

interface Resultado {
  faturamento: number; rede: number; lojas: number; eventos: number; outras: number; devolucoes: number; comissaoRede: number; receitaLiquida: number; cmv: number; lucroBruto: number; margemPb: number;
  perdas: number; acertos: number; acertoMedio: number; revendedorasAcertaram: number; vendaPorRevendedora: number; sellThroughPb: number; acertosAtrasadosPb: number; atrasoMedio: number;
  vendas: number; ticketMedio: number; pecasVendidas: number; recebido: number; pago: number; novasRevendedoras: number;
}
interface Geral {
  periodo: { ini: string; fim: string; dias: number; antIni: string; antFim: string };
  atual: Resultado; anterior: Resultado; variacoes: Record<string, number | null>; metaSellThroughPb: number; alertas: Alerta[];
  foto: {
    maletasAbertas: number; ruaPreco: number; ruaCusto: number; ruaPecas: number; maletasAtrasadas: number; ruaAtrasado: number; idadeMediaMaletas: number; cicloMedio: number;
    estoqueCusto: number; estoquePreco: number; estoquePecas: number; capitalEmPecas: number; coberturaDias: number | null; aReceber: number; vencido: number; devedores: number; inadimplenciaPb: number;
    cartaoAReceber: number; cartaoAConciliar: number; aPagar: number; aPagarVencido: number; saldoContas: number;
    revendedoras: { ativas: number; comMaleta: number; semMaleta: number; paradas: number; triagem: number };
  };
  serie: { mes: string; rede: number; lojas: number; eventos: number; outras: number; faturamento: number; lucroBruto: number; margemPb: number; cmv: number; comissao: number; recebido: number }[];
}

/** Visão do negócio: o resultado do período, a comparação com o anterior e o que pede decisão. */
export function Geral({ de, ate }: { de: string; ate: string }) {
  const q = useQuery({ queryKey: ['indicadores', 'geral', de, ate], queryFn: () => api<Geral>(`/indicadores/geral?de=${de}&ate=${ate}`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { atual: a, anterior: ant, variacoes: v, foto: f, serie, alertas } = q.data!;
  const canais = [
    { nome: 'Consultoras (acertos)', valor: a.rede, cor: COR.rede },
    { nome: 'Lojas', valor: a.lojas, cor: COR.lojas },
    { nome: 'Eventos', valor: a.eventos, cor: COR.eventos },
    { nome: 'Matriz / avulsas / revenda', valor: a.outras, cor: COR.outras },
  ].filter((c) => c.valor > 0);
  return (
    <>
      <Alertas alertas={alertas} />

      <div className="ind-secao">Resultado do período · comparado com os {q.data!.periodo.dias} dias anteriores</div>
      <div className="ind-grade k5">
        <Kpi i={0} tom="escuro" rotulo="Faturamento" valor={reais(a.faturamento)} variacao={v.faturamento} detalhe={`antes ${reais(ant.faturamento)}`} dica="Tudo que foi vendido: acertos da rede + lojas + eventos + avulsas. Já sem devoluções e sem vendas canceladas." />
        <Kpi i={1} rotulo="Receita da empresa" valor={reais(a.receitaLiquida)} variacao={v.receitaLiquida} detalhe={`comissão da rede ${reais(a.comissaoRede)}`} dica="Faturamento menos a comissão que fica com as revendedoras nos acertos." />
        <Kpi i={2} tom={a.lucroBruto > 0 ? 'bom' : 'atencao'} rotulo="Lucro bruto" valor={reais(a.lucroBruto)} variacao={v.lucroBruto} detalhe={`margem ${pct(a.margemPb)} · custo ${reais(a.cmv)}`} dica="Receita da empresa menos o custo das peças vendidas. Ainda não desconta despesas fixas (veja a aba Financeiro)." />
        <Kpi i={3} rotulo="Recebido no caixa" valor={reais(a.recebido)} variacao={v.recebido} detalhe={`pago ${reais(a.pago)}`} dica="Dinheiro que entrou de fato no período (títulos baixados), independente de quando foi vendido." />
        <Kpi i={4} rotulo="Peças vendidas" valor={a.pecasVendidas.toLocaleString('pt-BR')} variacao={v.pecasVendidas} detalhe={a.perdas ? `perdas cobradas ${reais(a.perdas)}` : `${a.vendas} vendas de balcão`} />
      </div>

      <div className="ind-grade g21">
        <Cartao i={5} titulo="Faturamento e lucro bruto, mês a mês" sub="últimos 12 meses">
          <BarrasTempo
            pontos={serie.map((s) => ({ rotulo: mesCurto(s.mes), valores: { rede: s.rede, lojas: s.lojas, eventos: s.eventos, outras: s.outras, lucro: s.lucroBruto }, extra: `Total ${reais(s.faturamento)} · margem ${pct(s.margemPb)}` }))}
            series={[['rede', 'Consultoras', COR.rede], ['lojas', 'Lojas', COR.lojas], ['eventos', 'Eventos', COR.eventos], ['outras', 'Outras', COR.outras]]}
            linha={{ chave: 'lucro', nome: 'Lucro bruto', cor: COR.bom }}
          />
        </Cartao>
        <Cartao i={6} titulo="De onde veio a venda" sub="no período">
          <BarrasLista itens={canais.map((c) => ({ nome: c.nome, valor: c.valor, cor: c.cor, extra: pct(a.faturamento ? Math.round((c.valor * 10000) / a.faturamento) : 0) }))} />
          {a.devolucoes > 0 && <p className="ind-nota">Devoluções no período: {reais(a.devolucoes)} (já descontadas).</p>}
        </Cartao>
      </div>

      <div className="ind-secao">Rede de consultoras</div>
      <div className="ind-grade k5">
        <Kpi i={7} rotulo="Vendido pela rede" valor={reais(a.rede)} variacao={v.rede} detalhe={`${a.acertos} acerto(s)`} />
        <Kpi i={8} tom={a.acertos > 0 && a.sellThroughPb < q.data!.metaSellThroughPb ? 'atencao' : undefined} rotulo="% das peças vendidas" valor={pct(a.sellThroughPb)} detalhe={`meta ${pct(q.data!.metaSellThroughPb)} · antes ${pct(ant.sellThroughPb)}`} dica="Das peças que estavam nas maletas acertadas, quantas foram vendidas. É o termômetro da rede e do mix de produtos." />
        <Kpi i={9} rotulo="Venda por consultora" valor={reais(a.vendaPorRevendedora)} variacao={v.vendaPorRevendedora} detalhe={`${a.revendedorasAcertaram} acertaram no período`} />
        <Kpi i={10} rotulo="Consultoras ativas" valor={f.revendedoras.ativas} detalhe={`${f.revendedoras.comMaleta} com maleta · ${f.revendedoras.semMaleta} sem`} />
        <Kpi i={11} tom={f.revendedoras.paradas ? 'atencao' : undefined} rotulo="Paradas há 60+ dias" valor={f.revendedoras.paradas} detalhe={a.acertosAtrasadosPb ? `${pct(a.acertosAtrasadosPb)} dos acertos com atraso` : 'acertos em dia'} dica="Ativas, sem maleta aberta e sem acerto há mais de 60 dias." />
      </div>

      <div className="ind-secao">Dinheiro parado em peças e a receber · posição de hoje</div>
      <div className="ind-grade k5">
        <Kpi i={12} rotulo="Em maletas na rua" valor={reais(f.ruaPreco)} detalhe={`${f.ruaPecas.toLocaleString('pt-BR')} peças · custo ${reais(f.ruaCusto)}`} dica="A preço de venda. O custo é o capital da empresa que está com as revendedoras." />
        <Kpi i={13} rotulo="Giro da maleta" valor={`${f.cicloMedio || '—'} dias`} detalhe={`maletas abertas há ${f.idadeMediaMaletas} dias em média`} dica="Média de dias entre a retirada e o acerto, nos acertos dos últimos 90 dias." />
        <Kpi i={14} rotulo="Estoque em casa (custo)" valor={reais(f.estoqueCusto)} detalhe={`${f.estoquePecas.toLocaleString('pt-BR')} peças · a preço ${reais(f.estoquePreco)}`} />
        <Kpi i={15} tom={f.coberturaDias !== null && (f.coberturaDias > 240 || f.coberturaDias < 45) ? 'atencao' : undefined} rotulo="Estoque dura" valor={f.coberturaDias === null ? '—' : `${f.coberturaDias} dias`} detalhe="casa + rua, no ritmo dos últimos 90 dias" dica="Capital em peças dividido pelo custo vendido por dia. Muito alto = dinheiro parado; muito baixo = vai faltar peça." />
        <Kpi i={16} tom={f.inadimplenciaPb >= 1000 ? 'atencao' : undefined} rotulo="Inadimplência" valor={pct(f.inadimplenciaPb)} detalhe={`${reais(f.vencido)} vencidos de ${f.devedores} pessoa(s)`} dica="Vencido sobre o total a receber de clientes e revendedoras. Repasses de cartão não entram." />
      </div>
      <div className="ind-grade k4">
        <Kpi i={17} rotulo="A receber (clientes e rede)" valor={reais(f.aReceber)} detalhe={`cartão a cair ${reais(f.cartaoAReceber)}`} />
        <Kpi i={18} rotulo="A pagar" valor={reais(f.aPagar)} detalhe={f.aPagarVencido ? `${reais(f.aPagarVencido)} vencidos` : 'nada vencido'} tom={f.aPagarVencido ? 'atencao' : undefined} />
        <Kpi i={19} rotulo="Saldo nas contas" valor={reais(f.saldoContas)} detalhe="contas cadastradas no Financeiro" />
        <Kpi i={20} rotulo="Ticket médio do balcão" valor={reais(a.ticketMedio)} variacao={v.ticketMedio} detalhe={`${a.vendas} vendas`} />
      </div>
    </>
  );
}
