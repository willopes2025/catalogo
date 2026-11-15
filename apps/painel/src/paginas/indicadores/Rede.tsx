import { useMemo, useState } from 'react';
import { HistoricoRede } from './Historico';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { pct, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';
import { BarrasLista, Cartao, Kpi, Tabela, type Col } from './comum';

type Filtro = 'todas' | 'risco' | 'curvaA' | 'paradas' | 'abaixo' | 'devendo';

/** Rede: quem carrega a venda, quem está em risco e onde a rede é mais forte. */
export function Rede({ de, ate }: { de: string; ate: string }) {
  const q = useQuery({ queryKey: ['indicadores', 'rede', de, ate], queryFn: () => api<any>(`/indicadores/rede?de=${de}&ate=${ate}`) });
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [busca, setBusca] = useState('');
  const linhas: Record<string, any>[] = q.data?.linhas ?? [];
  const meta = q.data?.metaSellThroughPb ?? 3000;
  const filtradas = useMemo(() => {
    const b = busca.trim().toLowerCase();
    return linhas.filter((l) => {
      if (b && !`${l.nome} ${l.cidade ?? ''} ${l.lider ?? ''}`.toLowerCase().includes(b)) return false;
      if (filtro === 'risco') return l.risco >= 3;
      if (filtro === 'curvaA') return l.curva === 'A';
      if (filtro === 'paradas') return l.status === 'ativo' && !l.maletas_abertas && (l.dias_sem_acerto === null || l.dias_sem_acerto > 60);
      if (filtro === 'abaixo') return l.acertos > 0 && l.sell_through_pb < meta;
      if (filtro === 'devendo') return l.vencido > 0 || l.dias_atraso_maleta > 0;
      return true;
    });
  }, [linhas, filtro, busca, meta]);
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const r = q.data.resumo;
  const colunas: Col[] = [
    ['curva', 'Curva', undefined, 'A = as que somam 80% da venda da rede'], ['nome', 'Consultora'], ['cidade', 'Cidade'], ['lider', 'Líder'], ['acertos', 'Acertos', 'num'], ['vendido', 'Vendido', 'dinheiro'],
    ['tendencia_pb', 'Tendência', 'var', 'Vendido agora contra o período anterior de mesmo tamanho'], ['sell_through_pb', '% vendido', 'pct', 'Peças vendidas sobre peças acertadas'],
    ['ciclo', 'Giro (dias)', 'num', 'Dias entre retirar a maleta e acertar'], ['em_maleta', 'Na maleta hoje', 'dinheiro'], ['vencido', 'Devendo', 'dinheiro'], ['dias_sem_acerto', 'Dias sem acerto', 'num'], ['riscos', 'Atenção'],
  ];
  const chip = (n: number, t: string, f: Filtro) => <button className={filtro === f ? 'ativo' : ''} onClick={() => setFiltro(f)}>{t} ({n})</button>;
  return (
    <>
      <div className="ind-grade k5">
        <Kpi i={0} tom="escuro" rotulo="Vendido pela rede" valor={reais(r.vendido)} detalhe={`${r.acertaram} de ${r.ativas} ativas acertaram`} />
        <Kpi i={1} rotulo="Média por consultora" valor={reais(r.mediaPorRevendedora)} detalhe="entre as que venderam" />
        <Kpi i={2} tom={r.sellThroughPb < meta && r.acertaram ? 'atencao' : undefined} rotulo="% das peças vendidas" valor={pct(r.sellThroughPb)} detalhe={`meta ${pct(meta)}`} />
        <Kpi i={3} rotulo="Voltaram a vender" valor={pct(r.retencaoPb)} detalhe="das que venderam no período anterior" dica="Retenção: das consultoras que venderam no período anterior, quantas venderam de novo neste." />
        <Kpi i={4} tom={r.top10Pb > 6000 ? 'atencao' : undefined} rotulo="Peso das 10 maiores" valor={pct(r.top10Pb)} detalhe={`${r.curvaA} consultora(s) fazem 80% da venda`} dica="Concentração: quanto da venda depende das 10 maiores. Muito alto é risco se uma delas sair." />
      </div>

      <div className="ind-grade k3">
        <Cartao i={5} titulo="Por cidade" sub="vendido no período">
          <BarrasLista itens={q.data.porCidade.slice(0, 8).map((c: any) => ({ nome: c.nome, valor: c.vendido, extra: `${c.acertaram}/${c.revendedoras} venderam · ${pct(c.sell_through_pb)}` }))} />
        </Cartao>
        <Cartao i={6} titulo="Por líder" sub="vendido pela equipe">
          <BarrasLista itens={q.data.porLider.slice(0, 8).map((c: any) => ({ nome: c.nome === '(sem)' ? 'Sem líder' : c.nome, valor: c.vendido, extra: `${c.revendedoras} consultora(s) · média ${reais(c.media)}` }))} />
        </Cartao>
        <Cartao i={7} titulo="Quanto cada uma vende da maleta" sub="nº de consultoras">
          <BarrasLista formato={(n) => String(n)} itens={q.data.faixas.map((f: any) => ({ nome: f.nome, valor: f.revendedoras }))} vazio="Sem acertos no período." />
          <p className="ind-nota">Quem vende pouco da maleta prende capital: vale trocar o mix ou reduzir a maleta. Quem vende quase tudo pode receber mais peças.</p>
        </Cartao>
      </div>

      <div className="ind-filtro">
        {chip(linhas.length, 'Todas', 'todas')}
        {chip(r.emRisco, 'Em risco', 'risco')}
        {chip(linhas.filter((l) => l.vencido > 0 || l.dias_atraso_maleta > 0).length, 'Devendo ou atrasada', 'devendo')}
        {chip(linhas.filter((l) => l.status === 'ativo' && !l.maletas_abertas && (l.dias_sem_acerto === null || l.dias_sem_acerto > 60)).length, 'Paradas', 'paradas')}
        {chip(linhas.filter((l) => l.acertos > 0 && l.sell_through_pb < meta).length, 'Abaixo da meta', 'abaixo')}
        {chip(r.curvaA, 'Curva A', 'curvaA')}
        <input placeholder="Buscar nome, cidade ou líder" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ marginLeft: 'auto', minWidth: 220 }} />
      </div>
      <Tabela
        nome="indicadores-rede"
        colunas={colunas}
        linhas={filtradas}
        ordemInicial={filtro === 'risco' || filtro === 'devendo' ? ['risco', -1] : undefined}
        vazio="Nenhuma consultora neste filtro."
        celula={(l, k) =>
          k === 'nome' ? <Link to={`/rede/${l.id}`}>{l.nome}</Link>
          : k === 'curva' ? <span className={`ind-curva ${l.curva}`}>{l.curva}</span>
          : k === 'riscos' ? (l.riscos.length ? l.riscos.map((x: string) => <span key={x} className={`ind-chip ${/atrasada|deve/.test(x) ? 'erro' : 'alerta'}`}>{x}</span>) : <span className="muted">—</span>)
          : k === 'tendencia_pb' && !l.vendido && !l.vendido_anterior ? <span className="muted">—</span>
          : undefined}
      />
      <div className="ind-grade k2" style={{ marginTop: 14 }}><HistoricoRede i={9} /></div>
    </>
  );
}
