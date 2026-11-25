import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { Carregando, Erro } from '../../componentes/ui';

export interface Envio {
  id: string;
  canalId: string;
  canal: string | null;
  origem: 'assistente' | 'trilha' | 'manual';
  titulo: string;
  status: 'ativo' | 'pausado' | 'cancelado' | 'concluido';
  total: number;
  enviados: number;
  falhas: number;
  pulados: number;
  restantes: number;
  aviso: string | null;
  criador?: string | null;
  criadoEm: string;
  concluidoEm: string | null;
  agoraNoHorario: boolean;
  proximoEnvioEm: string | null;
  previsaoFim: string | null;
  janela: { inicio: string; fim: string; dias: number[]; intervaloMinS: number; intervaloMaxS: number };
  itens?: { id: string; nome: string; telefone: string; status: string; erro: string | null; enviadoEm: string | null; texto: string; pessoaId: string | null }[];
}

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const quando = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const min = (s: number) => (s % 60 ? (s / 60).toFixed(1).replace('.', ',') : String(s / 60));
const STATUS: Record<string, [string, string]> = { ativo: ['Em andamento', 'alerta'], pausado: ['Pausado', 'neutra'], cancelado: ['Cancelado', 'neutra'], concluido: ['Concluído', 'ok'] };
const ITEM: Record<string, [string, string]> = { pendente: ['Na fila', 'neutra'], enviando: ['Enviando', 'alerta'], enviado: ['Enviada', 'ok'], falhou: ['Não saiu', 'erro'], pulado: ['Pulada', 'neutra'], cancelado: ['Cancelada', 'neutra'] };

/** Andamento de um envio em massa: quantas foram, quantas faltam, previsão, e pausar/retomar/cancelar. */
export function CartaoEnvio({ id, inicial, semTitulo }: { id: string; inicial?: Envio; semTitulo?: boolean }) {
  const qc = useQueryClient();
  const [verItens, setVerItens] = useState(false);
  const q = useQuery({
    queryKey: ['envios', id],
    queryFn: () => api<Envio>(`/envios/${id}`),
    initialData: inicial,
    refetchInterval: (x) => (x.state.data && ['ativo', 'pausado'].includes(x.state.data.status) ? 15_000 : false),
  });
  const mexer = useMutation({
    mutationFn: (acao: 'pausar' | 'retomar' | 'cancelar') => api<Envio>(`/envios/${id}/${acao}`, { corpo: {} }),
    onSuccess: (r) => {
      qc.setQueryData(['envios', id], r);
      qc.invalidateQueries({ queryKey: ['envios', 'lista'] });
      qc.invalidateQueries({ queryKey: ['assistente', 'sessao'] });
    },
  });
  if (!q.data) return q.error ? <Erro erro={q.error} /> : <Carregando />;
  const e = q.data;
  const feitos = e.enviados + e.falhas + e.pulados;
  const podeMexer = pode('crm', 'criar') || pode('cobranca', 'editar');
  const [rot, cor] = STATUS[e.status] ?? [e.status, 'neutra'];
  const dias = e.janela.dias.length === 7 ? 'todos os dias' : e.janela.dias.map((d) => DIAS[d]).join(', ');
  return (
    <div className="envio-lote">
      <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        {!semTitulo && <b>{e.titulo}</b>}
        <span className={`etiqueta ${cor}`}>{rot}</span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Pelo número <b>{e.canal ?? '?'}</b> · uma a cada {min(e.janela.intervaloMinS)} a {min(e.janela.intervaloMaxS)} min, das {e.janela.inicio} às {e.janela.fim} ({dias})
      </div>
      <div className="assistente-progresso" style={{ marginTop: 6 }}>
        <div className="barra"><div style={{ width: `${e.total ? Math.round((feitos / e.total) * 100) : 0}%` }} /></div>
        <small className="muted">
          {e.enviados} enviada(s) de {e.total} · faltam {e.restantes}
          {e.falhas ? ` · ${e.falhas} não saíram` : ''}
          {e.pulados ? ` · ${e.pulados} pulada(s)` : ''}
        </small>
      </div>
      {e.status === 'ativo' && e.restantes > 0 && (
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {e.agoraNoHorario ? `Próxima: ${quando(e.proximoEnvioEm)}` : `Fora do horário: volta ${quando(e.proximoEnvioEm)}`} · <b>Previsão de término: {quando(e.previsaoFim)}</b>
        </div>
      )}
      {e.status === 'concluido' && e.concluidoEm && <div className="muted" style={{ fontSize: 13 }}>Terminou {quando(e.concluidoEm)}</div>}
      {e.aviso && <div className="aviso alerta" style={{ marginTop: 6 }}>{e.aviso}</div>}
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {podeMexer && e.status === 'ativo' && <button className="botao claro pequeno" disabled={mexer.isPending} onClick={() => mexer.mutate('pausar')}>Pausar</button>}
        {podeMexer && e.status === 'pausado' && <button className="botao pequeno" disabled={mexer.isPending} onClick={() => mexer.mutate('retomar')}>Retomar</button>}
        {podeMexer && ['ativo', 'pausado'].includes(e.status) && <button className="botao perigo pequeno" disabled={mexer.isPending} onClick={() => window.confirm(`Cancelar o envio? As ${e.restantes} mensagem(ns) que faltam não serão enviadas.`) && mexer.mutate('cancelar')}>Cancelar envio</button>}
        <button className="botao claro pequeno" onClick={() => setVerItens(!verItens)}>{verItens ? 'Esconder a lista' : 'Ver a lista'}</button>
      </div>
      {mexer.error && <Erro erro={mexer.error} />}
      {verItens && (
        <div className="assistente-previa" style={{ marginTop: 8 }}>
          {(e.itens ?? []).map((i) => (
            <div key={i.id}>
              <b>{i.nome}</b> <span className="muted">{i.telefone}</span> <span className={`etiqueta ${ITEM[i.status]?.[1] ?? 'neutra'}`}>{ITEM[i.status]?.[0] ?? i.status}</span>
              {i.enviadoEm && <span className="muted" style={{ fontSize: 12 }}> {quando(i.enviadoEm)}</span>}
              {i.erro && <div className="erro-texto" style={{ fontSize: 12 }}>{i.erro}</div>}
            </div>
          ))}
          {!e.itens && <Carregando />}
        </div>
      )}
    </div>
  );
}

/** Lista dos envios em massa (em andamento primeiro). */
export function ListaEnvios({ origem }: { origem?: Envio['origem'] }) {
  const [todos, setTodos] = useState(false);
  const q = useQuery({ queryKey: ['envios', 'lista', todos], queryFn: () => api<Envio[]>(`/envios${todos ? '' : '?status=andamento'}`), refetchInterval: 30_000 });
  const lista = (q.data ?? []).filter((e) => !origem || e.origem === origem);
  return (
    <div className="coluna" style={{ gap: 10 }}>
      <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <p className="muted" style={{ margin: 0 }}>Mensagens do envio em lote (assistente) e da trilha de cobrança. Cada número manda uma por vez, no intervalo e horário configurados em CRM › Configurar › Números.</p>
        <label className="check"><input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} /> Mostrar os que já terminaram</label>
      </div>
      {q.isLoading && <Carregando />}
      {q.error && <Erro erro={q.error} />}
      {!q.isLoading && !lista.length && <div className="cartao vazio">{todos ? 'Nenhum envio ainda.' : 'Nenhum envio em andamento.'}</div>}
      {lista.map((e) => (
        <div key={e.id} className="cartao">
          <CartaoEnvio id={e.id} inicial={e} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{e.origem === 'trilha' ? 'Trilha de cobrança' : e.origem === 'assistente' ? `Assistente${e.criador ? ` · pedido por ${e.criador}` : ''}` : 'Manual'} · criado {quando(e.criadoEm)}</div>
        </div>
      ))}
    </div>
  );
}
