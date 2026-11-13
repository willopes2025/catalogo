import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { reais, data, dataHora, pct } from '../formato';
import { Carregando, Erro, Indicador, Topo } from '../componentes/ui';
import { usarImplantacao } from './Implantacao';

interface Inicio {
  data: string;
  maletas: { abertas: number; atrasadas: number; vencendo: number; acertosHoje: number; pecasNaRua: number; valorNaRua: number; prebaixasPendentes: number };
  rede: { ativas: number; triagem: number; novasMes: number; bloqueadas: number; semMaleta: number };
  financeiro: { receberHoje: number; vencido: number; aReceber: number };
  mes: { acertos: number; vendido: number; recebido: number; percentualMedio: number };
  atividades: { criadoEm: string; acao: string; entidade: string; usuario: string | null }[];
}

const ACOES: Record<string, string> = {
  criar: 'criou', editar: 'editou', acerto: 'fechou o acerto de', acerto_parcial: 'fez acerto parcial de', prebaixa: 'registrou pré-baixa de',
  cancelar: 'cancelou', entrada: 'deu entrada no', ajuste: 'ajustou o', transferencia: 'transferiu', baixar: 'baixou', incluir_itens: 'incluiu peças em', retirar_itens: 'retirou peças de',
};
const ENTIDADES: Record<string, string> = { maleta: 'maleta', pessoa: 'cadastro', produto: 'produto', estoque: 'estoque', titulo: 'título', regras_consignado: 'regras do consignado' };

export function Inicio() {
  const q = useQuery({ queryKey: ['inicio'], queryFn: () => api<Inicio>('/painel/inicio'), refetchInterval: 60_000 });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const d = q.data!;
  return (
    <>
      <Topo eb={`Início · ${data(d.data)}`} titulo="O que precisa de atenção hoje" acoes={<Link className="botao" to="/maletas/nova">Nova maleta</Link>} />
      <AvisoImplantacao />
      <div className="grade g4" style={{ marginBottom: 14 }}>
        <Indicador tipo="destaque" rotulo="Valor em maletas na rua" valor={reais(d.maletas.valorNaRua)} detalhe={`${d.maletas.pecasNaRua} peças em ${d.maletas.abertas} maletas`} />
        <Indicador tipo={d.maletas.atrasadas ? 'atencao' : undefined} rotulo="Maletas atrasadas" valor={d.maletas.atrasadas} detalhe={<Link to="/maletas?aba=atrasadas">ver lista</Link>} />
        <Indicador rotulo="Vencem nos próximos 7 dias" valor={d.maletas.vencendo} detalhe={`${d.maletas.acertosHoje} com acerto hoje`} />
        <Indicador rotulo="Pré-baixas para conferir" valor={d.maletas.prebaixasPendentes} detalhe="informadas pelas representantes" />
      </div>
      <div className="grade g4" style={{ marginBottom: 14 }}>
        <Indicador rotulo="Representantes ativas" valor={d.rede.ativas} detalhe={`${d.rede.novasMes} novas no mês`} />
        <Indicador rotulo="Ativas sem maleta" valor={d.rede.semMaleta} detalhe="consignado, sem maleta aberta" />
        <Indicador rotulo="Candidatas em triagem" valor={d.rede.triagem} detalhe={<Link to="/rede?status=triagem">analisar</Link>} />
        <Indicador tipo={d.financeiro.vencido ? 'atencao' : undefined} rotulo="Títulos vencidos" valor={reais(d.financeiro.vencido)} detalhe={`${reais(d.financeiro.aReceber)} a receber no total`} />
      </div>
      <div className="grade g2">
        <div className="cartao">
          <h2 style={{ marginBottom: 12 }}>Acertos do mês</h2>
          <div className="grade g3">
            <div><div className="muted">Acertos</div><div style={{ fontSize: 24, fontWeight: 700 }}>{d.mes.acertos}</div></div>
            <div><div className="muted">Vendido pela rede</div><div style={{ fontSize: 24, fontWeight: 700 }}>{reais(d.mes.vendido)}</div></div>
            <div><div className="muted">% vendido médio</div><div style={{ fontSize: 24, fontWeight: 700 }}>{pct(d.mes.percentualMedio)}</div></div>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>Valor devido à matriz nos acertos do mês: {reais(d.mes.recebido)}</p>
        </div>
        <div className="cartao">
          <h2 style={{ marginBottom: 8 }}>Atividades recentes</h2>
          {d.atividades.length === 0 && <p className="muted">Nenhuma atividade ainda.</p>}
          {d.atividades.map((a, i) => (
            <div key={i} className="resumo-linha">
              <span>
                <b>{a.usuario ?? 'Representante (link)'}</b> {ACOES[a.acao] ?? a.acao} {ENTIDADES[a.entidade] ?? a.entidade}
              </span>
              <span className="muted">{dataHora(a.criadoEm)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Enquanto houver pendência de implantação, lembra a gerência no Início. */
function AvisoImplantacao() {
  const q = usarImplantacao();
  if (!q.data || q.data.feitos >= q.data.total) return null;
  const faltam = q.data.itens.filter((i) => i.status === 'pendente').length;
  return (
    <div className="aviso alerta flex entre" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
      <span><b>Implantação: {q.data.feitos} de {q.data.total} itens prontos.</b> Faltam {faltam} item(ns), como acessos das integrações, CNPJs e confirmações do contador e do jurídico.</span>
      <Link className="botao claro pequeno" to="/configuracoes?aba=implantacao">Ver o que falta</Link>
    </div>
  );
}
