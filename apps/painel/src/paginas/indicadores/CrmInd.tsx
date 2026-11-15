import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { pct, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';
import { BarrasLista, Cartao, Kpi, Tabela } from './comum';

const ORIGEM: Record<string, string> = { sistema: 'automático (revendedoras e vendas)', equipe: 'criado pela equipe', whatsapp: 'WhatsApp (escreveu direto)', meta_ads: 'anúncio da Meta (clique para WhatsApp)', site: 'formulário do site' };
const minutos = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} dia(s)`);

/** CRM: quanto os funis convertem, de onde vêm os leads que fecham e a velocidade do atendimento. */
export function CrmInd({ de, ate }: { de: string; ate: string }) {
  const q = useQuery({ queryKey: ['indicadores', 'crm', de, ate], queryFn: () => api<any>(`/indicadores/crm?de=${de}&ate=${ate}`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { funis, etapas, origens, motivos, atendimento: a, atendentes, disparos } = q.data;
  return (
    <>
      <div className="ind-grade k5">
        <Kpi i={0} tom="escuro" rotulo="Leads novos" valor={funis.reduce((s: number, f: any) => s + f.criados, 0)} detalhe="em todos os funis, no período" />
        <Kpi i={1} tom={a.fila ? 'atencao' : 'bom'} rotulo="Na fila agora" valor={a.fila} detalhe={a.fila ? `esperando há ${minutos(a.espera_agora_min)} em média` : 'ninguém esperando'} />
        <Kpi i={2} tom={a.espera_media_min > 30 ? 'atencao' : undefined} rotulo="Espera até ser atendido" valor={a.espera_media_min ? minutos(a.espera_media_min) : '—'} detalhe="média do período" dica="Tempo entre a pessoa entrar na fila e alguém pegar a conversa. Quanto menor, maior a conversão." />
        <Kpi i={3} rotulo="Mensagens" valor={(a.recebidas + a.enviadas).toLocaleString('pt-BR')} detalhe={`${a.recebidas} recebidas · ${a.enviadas} enviadas`} />
        <Kpi i={4} tom={a.tarefas_vencidas ? 'atencao' : undefined} rotulo="Tarefas atrasadas" valor={a.tarefas_vencidas} detalhe="de toda a equipe" />
      </div>

      <div className="ind-grade k3">
        {funis.map((f: any, i: number) => {
          const ets = etapas.filter((e: any) => e.funil_id === f.id);
          const max = Math.max(1, ...ets.map((e: any) => e.cards));
          return (
            <Cartao key={f.id} i={5 + i} titulo={f.nome} sub={`${f.abertos} em aberto`}>
              <div className="resumo-linha"><span>Entraram no período</span><b>{f.criados}</b></div>
              <div className="resumo-linha"><span>Ganhos / perdidos</span><b>{f.ganhos} / {f.perdidos}</b></div>
              <div className="resumo-linha"><span>Conversão</span><b>{f.ganhos + f.perdidos ? pct(f.conversao_pb) : '—'}</b></div>
              {f.valor_ganho > 0 && <div className="resumo-linha"><span>Valor ganho</span><b>{reais(f.valor_ganho)}</b></div>}
              {f.dias_ate_ganhar > 0 && <div className="resumo-linha"><span>Tempo até fechar</span><b>{f.dias_ate_ganhar} dia(s)</b></div>}
              <div className="ind-funil" style={{ marginTop: 10 }}>
                {ets.map((e: any) => (
                  <div key={e.nome} className="et" title={`Há ${e.dias_na_etapa} dia(s) em média nesta etapa`}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.nome}</span>
                    <div><div className="b" style={{ width: `${(e.cards / max) * 100}%`, background: e.cor }} /></div>
                    <b>{e.cards}</b>
                  </div>
                ))}
              </div>
            </Cartao>
          );
        })}
      </div>

      <div className="ind-grade k2">
        <Cartao i={9} titulo="De onde vêm os leads" sub="e quantos fecham">
          <BarrasLista formato={(n) => `${n} lead(s)`} itens={origens.slice(0, 8).map((o: any) => ({ nome: `${ORIGEM[o.origem] ?? o.origem}${o.campanha !== '—' ? ` · ${o.campanha}` : ''}`, valor: o.leads, extra: `${o.ganhos} ganho(s) · ${pct(o.conversao_pb)}` }))} vazio="Nenhum lead novo no período." />
          <p className="ind-nota">A origem vem do rastreamento (UTM) dos anúncios e formulários. Invista mais no que traz lead que fecha, não só no que traz volume.</p>
        </Cartao>
        <Cartao i={10} titulo="Por que perdemos" sub="motivos informados">
          <BarrasLista formato={(n) => `${n} card(s)`} itens={motivos.map((m: any) => ({ nome: m.motivo, valor: m.cards }))} vazio="Nenhum card perdido no período." />
        </Cartao>
      </div>

      <div className="coluna" style={{ gap: 18 }}>
        <Tabela nome="crm-equipe" titulo="Equipe de atendimento" linhas={atendentes} vazio="Ninguém atendeu no período." colunas={[['nome', 'Atendente'], ['mensagens', 'Mensagens enviadas', 'num'], ['em_atendimento', 'Conversas abertas', 'num'], ['cards_abertos', 'Cards em aberto', 'num'], ['ganhos', 'Ganhos no período', 'num'], ['tarefas_vencidas', 'Tarefas atrasadas', 'num']]} />
        {disparos.length > 0 && <Tabela nome="crm-disparos" titulo="Disparos em massa" linhas={disparos} colunas={[['nome', 'Disparo'], ['status', 'Situação'], ['total', 'Destinatários', 'num'], ['enviados', 'Enviados', 'num'], ['falhas', 'Falhas', 'num'], ['responderam', 'Responderam', 'num'], ['resposta_pb', 'Taxa de resposta', 'pct']]} />}
      </div>
    </>
  );
}
