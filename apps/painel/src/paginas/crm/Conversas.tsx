import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../../api';
import { Carregando, Erro } from '../../componentes/ui';
import { Chat } from './Chat';
import { ha, iniciais, telefoneBonito, usarCanais, usarContadores, usarFunis, useRelogio } from './comum';

interface Conversa { id: string; status: string; naoLidas: number; ultimaMensagem: string | null; ultimaMensagemEm: string | null; filaDesde: string | null; atendente: string | null; canal: string; canalTipo: string; contatoId: string; contato: string; telefone: string; lead: { id: string; titulo: string; etapa: string; funil: string } | null }
type Aba = 'fila' | 'minhas' | 'atendimento' | 'resolvidas';

/** Caixa de entrada: fila de espera, minhas conversas, em atendimento (gestão) e resolvidas. */
export function Conversas({ inicial }: { inicial?: string | null }) {
  useRelogio(30);
  const gestor = pode('crm', 'excluir');
  const cont = usarContadores();
  const canais = usarCanais();
  const [aba, setAba] = useState<Aba>('fila');
  const [canalId, setCanalId] = useState('');
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState<string | null>(inicial ?? null);
  const filtro = `aba=${aba}${canalId ? `&canalId=${canalId}` : ''}${busca.trim() ? `&busca=${encodeURIComponent(busca.trim())}` : ''}`;
  const q = useQuery({ queryKey: ['crm', 'conversas', filtro], queryFn: () => api<Conversa[]>(`/crm/conversas?${filtro}`), refetchInterval: 5000 });
  const atual = q.data?.find((c) => c.id === aberta);

  // Primeira conversa da lista abre sozinha na tela grande.
  useEffect(() => {
    if (!aberta && q.data?.length && window.innerWidth > 1100) setAberta(q.data[0].id);
  }, [q.data, aberta]);

  const abas: [Aba, string, number?][] = [
    ['fila', 'Fila', cont.data?.fila],
    ['minhas', 'Minhas', cont.data?.naoLidas || undefined],
    ...(gestor ? ([['atendimento', 'Em atendimento']] as [Aba, string][]) : []),
    ['resolvidas', 'Resolvidas'],
  ];
  if (canais.data && !canais.data.length) {
    return (
      <div className="cartao vazio">
        Nenhum número de WhatsApp ligado ao CRM ainda (ou você não atende por nenhum).{pode('configuracoes', 'editar') && ' Ligue um em CRM › Configurar › Números de WhatsApp.'}
      </div>
    );
  }
  return (
    <div className="inbox">
      <div className="inbox-lista">
        <div className="inbox-abas">
          {abas.map(([k, nome, n]) => (
            <button key={k} className={aba === k ? 'ativa' : ''} onClick={() => { setAba(k); setAberta(null); }}>
              {nome} {n ? <span className="bolha-n">{n}</span> : null}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--linha)' }}>
          <input placeholder="Buscar…" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ flex: 1, minWidth: 0, padding: '6px 8px', border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
          {(canais.data?.length ?? 0) > 1 && (
            <select value={canalId} onChange={(e) => setCanalId(e.target.value)} style={{ maxWidth: 120, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }}>
              <option value="">Todos os números</option>
              {canais.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          )}
        </div>
        <div className="inbox-itens">
          {q.isLoading && <Carregando />}
          {q.error && <Erro erro={q.error} />}
          {q.data && !q.data.length && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>{aba === 'fila' ? 'Ninguém esperando. 🎉' : 'Nada por aqui.'}</div>}
          {q.data?.map((c) => {
            const espera = aba === 'fila' && c.filaDesde ? (Date.now() - new Date(c.filaDesde).getTime()) / 60000 : 0;
            return (
              <div key={c.id} className={`conv ${c.id === aberta ? 'ativa' : ''}`} onClick={() => setAberta(c.id)}>
                <span className="avatar g">{iniciais(c.contato)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nome">{c.contato}</div>
                  <div className="previa">{c.ultimaMensagem ?? telefoneBonito(c.telefone)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{c.canal}{c.lead ? ` · ${c.lead.etapa}` : ''}{aba !== 'minhas' && c.atendente ? ` · ${c.atendente}` : ''}</div>
                </div>
                <div className="meta">
                  {aba === 'fila' ? <span className={`espera ${espera > 15 ? 'longa' : ''}`} title="Tempo na fila">⏳ {ha(c.filaDesde)}</span> : <span>{ha(c.ultimaMensagemEm)}</span>}
                  {c.naoLidas > 0 && <span className="bolha-n">{c.naoLidas}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ minWidth: 0, minHeight: 0 }}>
        {aberta ? <Chat key={aberta} conversaId={aberta} leadId={atual?.lead?.id} /> : <div className="chat"><div className="chat-msgs muted" style={{ justifyContent: 'center', alignItems: 'center' }}>Escolha uma conversa.</div></div>}
      </div>
      <div className="inbox-lado">{aberta && <Lado conversa={atual} />}</div>
    </div>
  );
}

/** Painel do lado: o card da pessoa, com etapa e atalho para a ficha completa. */
function Lado({ conversa }: { conversa?: Conversa }) {
  const qc = useQueryClient();
  const funis = usarFunis();
  const lead = useQuery({ queryKey: ['crm', 'lead', conversa?.lead?.id], queryFn: () => api<any>(`/crm/leads/${conversa!.lead!.id}`), enabled: !!conversa?.lead?.id });
  const mover = useMutation({ mutationFn: (etapaId: string) => api(`/crm/leads/${conversa!.lead!.id}`, { metodo: 'PATCH', corpo: { etapaId } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  if (!conversa) return null;
  if (!conversa.lead) return <div className="bloco"><h3>Sem card</h3><p className="muted">Este contato ainda não está em nenhum funil. Crie um card pelo quadro do funil.</p></div>;
  const l = lead.data;
  const funil = funis.data?.find((f) => f.id === l?.funilId);
  return (
    <>
      <div className="bloco">
        <h3>Card</h3>
        <div style={{ fontWeight: 700 }}>{conversa.lead.titulo}</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{conversa.lead.funil}</div>
        {funil && l && (
          <select value={l.etapaId} disabled={!pode('crm', 'editar') || mover.isPending} onChange={(e) => mover.mutate(e.target.value)} style={{ width: '100%', padding: 6, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }}>
            {funil.etapas.filter((e) => e.tipo !== 'perdido' && e.chave !== 'aprovada').map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
          </select>
        )}
        {mover.error && <Erro erro={mover.error} />}
        <Link to={`/crm/lead/${conversa.lead.id}`} className="botao claro pequeno" style={{ marginTop: 8, width: '100%' }}>Abrir card completo</Link>
      </div>
      {l && (
        <>
          {l.etiquetas?.length > 0 && <div className="bloco"><h3>Etiquetas</h3><div className="tags" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{l.etiquetas.map((t: string) => <span key={t} className="tag">{t}</span>)}</div></div>}
          {Object.keys(l.origem ?? {}).length > 0 && (
            <div className="bloco">
              <h3>Origem</h3>
              {Object.entries(l.origem).map(([k, v]) => <div key={k} className="par"><span>{k}</span><span style={{ wordBreak: 'break-all' }}>{String(v)}</span></div>)}
            </div>
          )}
          {l.tarefas?.filter((t: any) => !t.feitaEm).length > 0 && (
            <div className="bloco">
              <h3>Tarefas</h3>
              {l.tarefas.filter((t: any) => !t.feitaEm).map((t: any) => <div key={t.id} style={{ fontSize: 14, color: new Date(t.venceEm) < new Date() ? 'var(--erro)' : undefined }}>☐ {t.titulo} · {new Date(t.venceEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>)}
            </div>
          )}
        </>
      )}
    </>
  );
}
