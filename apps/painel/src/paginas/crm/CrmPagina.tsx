import { useSearchParams } from 'react-router-dom';
import { pode } from '../../api';
import { Topo } from '../../componentes/ui';
import { Funil } from './Funil';
import { Conversas } from './Conversas';
import { Disparos, Gatilhos, Tarefas } from './Automacoes';
import { Configurar } from './Configurar';
import { usarContadores } from './comum';
import './crm.css';

type Aba = 'funil' | 'conversas' | 'tarefas' | 'disparos' | 'gatilhos' | 'configurar';

/** CRM: funis em quadro, conversas com fila de espera, tarefas, gatilhos, disparos e configuração. */
export function CrmPagina() {
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) || 'funil';
  const cont = usarContadores();
  const c = cont.data;
  const abas: [Aba, string, number?, boolean?][] = [
    ['funil', 'Funis'],
    ['conversas', 'Conversas', (c?.fila ?? 0) + (c?.naoLidas ?? 0) || undefined],
    ['tarefas', 'Tarefas', c?.tarefasVencidas || undefined, true],
    ['gatilhos', 'Gatilhos'],
    ['disparos', 'Disparos'],
    ...(pode('crm', 'excluir') || pode('configuracoes', 'editar') ? ([['configurar', 'Configurar']] as [Aba, string][]) : []),
  ];
  return (
    <>
      <Topo
        eb="CRM"
        titulo={{ funil: 'Funis', conversas: 'Conversas', tarefas: 'Minhas tarefas', gatilhos: 'Gatilhos', disparos: 'Disparos em massa', configurar: 'Configurar o CRM' }[aba]}
        sub={c ? `${c.fila} na fila de espera · ${c.minhas} conversa(s) com você${c.tarefasVencidas ? ` · ${c.tarefasVencidas} tarefa(s) vencida(s)` : ''}${c.mencoes ? ` · ${c.mencoes} menção(ões) a você` : ''}` : undefined}
      />
      <div className="abas" role="tablist">
        {abas.map(([k, nome, n, alerta]) => (
          <button key={k} role="tab" className={aba === k ? 'ativa' : ''} onClick={() => setParams(k === 'funil' ? {} : { aba: k })}>
            {nome} {n ? <span className="bolha-n" style={alerta ? undefined : { background: 'var(--dourado)' }}>{n}</span> : null}
          </button>
        ))}
      </div>
      {aba === 'funil' && <Funil />}
      {aba === 'conversas' && <Conversas inicial={params.get('conversa')} />}
      {aba === 'tarefas' && <Tarefas />}
      {aba === 'gatilhos' && <Gatilhos />}
      {aba === 'disparos' && <Disparos />}
      {aba === 'configurar' && <Configurar />}
    </>
  );
}
