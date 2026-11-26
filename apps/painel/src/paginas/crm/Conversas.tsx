import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../../api';
import { Carregando, Erro } from '../../componentes/ui';
import { Chat } from './Chat';
import { ha, iniciais, telefoneBonito, usarAtendentes, usarCampos, usarCanais, usarContadores, usarFunis, useRelogio, ValorCampo } from './comum';

interface Conversa { id: string; status: string; naoLidas: number; fixada: boolean; iaAtiva: boolean | null; ultimaMensagem: string | null; ultimaMensagemEm: string | null; filaDesde: string | null; atendente: string | null; canal: string; canalTipo: string; contatoId: string; contato: string; telefone: string; lead: { id: string; titulo: string; etapa: string; funil: string } | null }
type Aba = 'fila' | 'minhas' | 'atendimento' | 'resolvidas';

/** Caixa de entrada: fila de espera, minhas conversas, em atendimento (gestão) e resolvidas. */
export function Conversas({ inicial }: { inicial?: string | null }) {
  useRelogio(30);
  const gestor = pode('crm', 'excluir');
  const cont = usarContadores();
  const canais = usarCanais();
  const [aba, setAba] = useState<Aba>('fila');
  const [canalId, setCanalId] = useState('');
  // Card do lead ao lado da conversa: dá para ocultar (mais espaço para o chat); fica guardado neste navegador.
  const [semCard, setSemCard] = useState(() => {
    try {
      return localStorage.getItem('aritana.crm.semCard') === '1';
    } catch {
      return false;
    }
  });
  const mostrarCard = (v: boolean) => {
    setSemCard(!v);
    try {
      localStorage.setItem('aritana.crm.semCard', v ? '0' : '1');
    } catch {
      /* sem armazenamento */
    }
  };
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState<string | null>(inicial ?? null);
  const [soNaoLidas, setSoNaoLidas] = useState(false);
  // Conversa avulsa: escrever para um telefone que ainda não tem conversa (nem card).
  const qc = useQueryClient();
  const [nova, setNova] = useState<{ canalId: string; telefone: string; nome: string } | null>(null);
  const criar = useMutation({
    mutationFn: () => api<{ id: string; comOutro: boolean }>('/crm/conversas/nova', { corpo: { canalId: nova!.canalId, telefone: nova!.telefone, nome: nova!.nome.trim() || null } }),
    onSuccess: (r) => {
      setNova(null);
      setBusca('');
      setSoNaoLidas(false);
      setAba(r.comOutro ? 'atendimento' : 'minhas');
      setAberta(r.id);
      qc.invalidateQueries({ queryKey: ['crm', 'conversas'] });
    },
  });
  // Filtros avançados: etiqueta, responsável (gestão) e período da última mensagem.
  const [verFiltros, setVerFiltros] = useState(false);
  const [fl, setFl] = useState({ etiqueta: '', atendenteId: '', de: '', ate: '' });
  const filtrosAtivos = Object.values(fl).filter(Boolean).length;
  const etiquetas = useQuery({ queryKey: ['crm', 'etiquetas'], queryFn: () => api<string[]>('/crm/etiquetas'), enabled: verFiltros, staleTime: 60_000 });
  const atendentes = usarAtendentes();
  // Seleção de várias conversas para agir de uma vez.
  const [sel, setSel] = useState<string[] | null>(null);
  const [paraQuem, setParaQuem] = useState('');
  const lote = useMutation({
    mutationFn: (v: { acao: string; usuarioId?: string }) => api<{ feitas: number; falhas: number; motivos: string[] }>('/crm/conversas/lote', { corpo: { ids: sel, ...v } }),
    onSuccess: () => { setSel(null); qc.invalidateQueries({ queryKey: ['crm'] }); },
  });
  const filtro = `aba=${aba}${canalId ? `&canalId=${canalId}` : ''}${busca.trim() ? `&busca=${encodeURIComponent(busca.trim())}` : ''}${soNaoLidas ? '&naoLidas=1' : ''}${fl.etiqueta ? `&etiqueta=${encodeURIComponent(fl.etiqueta)}` : ''}${fl.atendenteId ? `&atendenteId=${fl.atendenteId}` : ''}${fl.de ? `&de=${fl.de}` : ''}${fl.ate ? `&ate=${fl.ate}` : ''}`;
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
    <div className={`inbox${semCard ? ' sem-card' : ''}`}>
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
        <div style={{ display: 'flex', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--linha)', alignItems: 'center', justifyContent: 'space-between' }}>
          <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={soNaoLidas} onChange={(e) => setSoNaoLidas(e.target.checked)} /> Só não lidas</label>
          <span className="flex" style={{ gap: 6 }}>
            <button className={`botao pequeno ${verFiltros || filtrosAtivos ? '' : 'claro'}`} aria-expanded={verFiltros} onClick={() => setVerFiltros((v) => !v)}>Filtros{filtrosAtivos ? ` (${filtrosAtivos})` : ''}</button>
            {pode('crm', 'editar') && <button className={`botao pequeno ${sel ? '' : 'claro'}`} aria-pressed={!!sel} onClick={() => setSel(sel ? null : [])}>{sel ? 'Cancelar seleção' : 'Selecionar'}</button>}
          </span>
        </div>
        {verFiltros && (
          <div className="nova-conversa">
            <select aria-label="Etiqueta" value={fl.etiqueta} onChange={(e) => setFl({ ...fl, etiqueta: e.target.value })}>
              <option value="">Todas as etiquetas</option>
              {etiquetas.data?.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            {gestor && (
              <select aria-label="Responsável" value={fl.atendenteId} onChange={(e) => setFl({ ...fl, atendenteId: e.target.value })}>
                <option value="">Qualquer responsável</option>
                {atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
              </select>
            )}
            <div className="flex" style={{ gap: 6 }}>
              <label style={{ flex: 1, fontSize: 12 }} className="muted">Última mensagem de<input type="date" value={fl.de} max={fl.ate || undefined} onChange={(e) => setFl({ ...fl, de: e.target.value })} style={{ width: '100%' }} /></label>
              <label style={{ flex: 1, fontSize: 12 }} className="muted">até<input type="date" value={fl.ate} min={fl.de || undefined} onChange={(e) => setFl({ ...fl, ate: e.target.value })} style={{ width: '100%' }} /></label>
            </div>
            {fl.atendenteId && (aba === 'fila' || aba === 'minhas') && <span className="muted" style={{ fontSize: 12 }}>O filtro por responsável vale nas abas "Em atendimento" e "Resolvidas".</span>}
            {filtrosAtivos > 0 && <div><button className="botao claro pequeno" onClick={() => setFl({ etiqueta: '', atendenteId: '', de: '', ate: '' })}>Limpar filtros</button></div>}
          </div>
        )}
        {sel && (
          <div className="nova-conversa">
            <b style={{ fontSize: 13 }}>{sel.length} selecionada(s)</b>
            <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="botao claro pequeno" disabled={!q.data?.length} onClick={() => setSel(sel.length === q.data?.length ? [] : (q.data ?? []).map((c) => c.id))}>{sel.length && sel.length === q.data?.length ? 'Desmarcar todas' : 'Marcar todas'}</button>
              <button className="botao claro pequeno" disabled={!sel.length || lote.isPending} onClick={() => lote.mutate({ acao: 'lida' })}>Marcar como lidas</button>
              <button className="botao claro pequeno" disabled={!sel.length || lote.isPending} onClick={() => lote.mutate({ acao: 'nao_lida' })}>Não lidas</button>
              <button className="botao claro pequeno" disabled={!sel.length || lote.isPending} onClick={() => window.confirm(`Resolver ${sel.length} conversa(s)?`) && lote.mutate({ acao: 'resolver' })}>✓ Resolver</button>
              <button className="botao claro pequeno" disabled={!sel.length || lote.isPending} onClick={() => lote.mutate({ acao: 'fila' })}>Devolver para a fila</button>
            </div>
            <div className="flex" style={{ gap: 6 }}>
              <select aria-label="Transferir para" value={paraQuem} onChange={(e) => setParaQuem(e.target.value)} style={{ flex: 1 }}>
                <option value="">Transferir para…</option>
                {atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
              </select>
              <button className="botao pequeno" disabled={!sel.length || !paraQuem || lote.isPending} onClick={() => lote.mutate({ acao: 'transferir', usuarioId: paraQuem })}>Transferir</button>
            </div>
            {lote.error && <Erro erro={lote.error} />}
          </div>
        )}
        {lote.data && !sel && (
          <div className={`aviso ${lote.data.falhas ? 'alerta' : 'ok'}`} style={{ margin: 8, padding: '6px 10px', fontSize: 13 }}>
            {lote.data.feitas} conversa(s) atualizada(s){lote.data.falhas ? `; ${lote.data.falhas} ficaram de fora: ${lote.data.motivos.join(' ')}` : ''}.
          </div>
        )}
        <div style={{ display: 'flex', padding: '0 8px 6px', justifyContent: 'flex-end', borderBottom: '1px solid var(--linha)' }}>
          {pode('crm', 'editar') && !nova && <button className="botao pequeno" onClick={() => setNova({ canalId: canalId || canais.data?.find((c) => c.ativo !== false && c.tipo !== 'oficial')?.id || canais.data?.[0]?.id || '', telefone: '', nome: '' })}>+ Nova conversa</button>}
        </div>
        {nova && (
          <form className="nova-conversa" onSubmit={(e) => { e.preventDefault(); if (nova.canalId && nova.telefone.replace(/\D/g, '').length >= 10) criar.mutate(); }}>
            <b style={{ fontSize: 13 }}>Nova conversa</b>
            {(canais.data?.length ?? 0) > 1 && (
              <select aria-label="Enviar pelo número" value={nova.canalId} onChange={(e) => setNova({ ...nova, canalId: e.target.value })}>
                {canais.data?.map((c) => <option key={c.id} value={c.id}>Enviar por: {c.nome}</option>)}
              </select>
            )}
            <input autoFocus aria-label="Telefone com DDD" inputMode="tel" placeholder="Telefone com DDD. Ex.: 27 99999-0000" value={nova.telefone} onChange={(e) => setNova({ ...nova, telefone: e.target.value })} />
            <input aria-label="Nome (opcional)" placeholder="Nome (opcional)" maxLength={120} value={nova.nome} onChange={(e) => setNova({ ...nova, nome: e.target.value })} />
            {canais.data?.find((c) => c.id === nova.canalId)?.tipo === 'oficial' && <span className="muted" style={{ fontSize: 12 }}>Número oficial: a primeira mensagem precisa ser um template aprovado pela Meta.</span>}
            <span className="muted" style={{ fontSize: 12 }}>Número de fora do Brasil: escreva com o código do país (ex.: 351 912 345 678).</span>
            {criar.error && <Erro erro={criar.error} />}
            <div className="flex" style={{ gap: 6 }}>
              <button className="botao pequeno" disabled={criar.isPending || !nova.canalId || nova.telefone.replace(/\D/g, '').length < 10}>{criar.isPending ? 'Abrindo…' : 'Abrir conversa'}</button>
              <button type="button" className="botao claro pequeno" onClick={() => setNova(null)}>Cancelar</button>
            </div>
          </form>
        )}
        <div className="inbox-itens">
          {q.isLoading && <Carregando />}
          {q.error && <Erro erro={q.error} />}
          {q.data && !q.data.length && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>{aba === 'fila' ? 'Ninguém esperando. 🎉' : 'Nada por aqui.'}</div>}
          {q.data?.map((c) => {
            const espera = aba === 'fila' && c.filaDesde ? (Date.now() - new Date(c.filaDesde).getTime()) / 60000 : 0;
            return (
              <div key={c.id} className={`conv ${c.id === aberta ? 'ativa' : ''}`} onClick={() => (sel ? setSel(sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id]) : setAberta(c.id))}>
                {sel && <input type="checkbox" aria-label={`Selecionar a conversa com ${c.contato}`} checked={sel.includes(c.id)} readOnly style={{ marginTop: 10, width: 'auto', flex: 'none' }} />}
                <span className="avatar g">{iniciais(c.contato)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nome">{c.fixada && <span title="Fixada no topo">📌 </span>}{c.iaAtiva === true && <span title="IA ligada nesta conversa">🤖 </span>}{c.contato}</div>
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
        {aberta ? <Chat key={aberta} conversaId={aberta} leadId={atual?.lead?.id} abas aoSair={() => setAberta(null)} /> : <div className="chat"><div className="chat-msgs muted" style={{ justifyContent: 'center', alignItems: 'center' }}>Escolha uma conversa.</div></div>}
      </div>
      {semCard ? (
        <button type="button" className="inbox-mostrar-card" onClick={() => mostrarCard(true)} title="Mostrar o card do lead" aria-label="Mostrar o card do lead">
          ‹ <span>Card</span>
        </button>
      ) : (
        <div className="inbox-lado">
          <button type="button" className="botao claro pequeno inbox-ocultar-card" onClick={() => mostrarCard(false)} title="Ocultar o card do lead">Ocultar card ›</button>
          {aberta && <Lado conversa={atual} />}
        </div>
      )}
    </div>
  );
}

/** Painel do lado: o card da pessoa, com etapa e atalho para a ficha completa. */
function Lado({ conversa }: { conversa?: Conversa }) {
  const qc = useQueryClient();
  const funis = usarFunis();
  const lead = useQuery({ queryKey: ['crm', 'lead', conversa?.lead?.id], queryFn: () => api<any>(`/crm/leads/${conversa!.lead!.id}`), enabled: !!conversa?.lead?.id });
  const mover = useMutation({ mutationFn: (etapaId: string) => api(`/crm/leads/${conversa!.lead!.id}`, { metodo: 'PATCH', corpo: { etapaId } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  const campos = usarCampos();
  const salvarLead = useMutation({ mutationFn: (camposExtras: Record<string, string>) => api(`/crm/leads/${conversa!.lead!.id}`, { metodo: 'PATCH', corpo: { camposExtras } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'lead'] }) });
  const salvarContato = useMutation({ mutationFn: (camposExtras: Record<string, string>) => api(`/crm/contatos/${conversa!.contatoId}`, { metodo: 'PATCH', corpo: { camposExtras } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'lead'] }) });
  if (!conversa) return null;
  if (!conversa.lead) return <div className="bloco"><h3>Sem card</h3><p className="muted">Este contato ainda não está em nenhum funil. Para criar o card, abra a aba "Notas" ou "Tarefas" da conversa.</p></div>;
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
          {(() => {
            const defs = (campos.data ?? []).filter((c) => c.entidade === 'contato' || !c.funilId || c.funilId === l.funilId);
            if (!defs.length) return null;
            const editar = pode('crm', 'editar');
            return (
              <div className="bloco">
                <h3>Dados</h3>
                {defs.map((c) => {
                  const fonte = c.entidade === 'lead' ? l.camposExtras ?? {} : l.contato?.camposExtras ?? {};
                  return (
                    <div key={c.id} className="par">
                      <span>{c.nome}</span>
                      <ValorCampo def={c} valor={fonte[c.nome] ?? ''} desativado={!editar} mudar={(v) => (c.entidade === 'lead' ? salvarLead : salvarContato).mutate({ ...fonte, [c.nome]: v })} />
                    </div>
                  );
                })}
                {(salvarLead.error || salvarContato.error) && <Erro erro={salvarLead.error ?? salvarContato.error} />}
              </div>
            );
          })()}
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
