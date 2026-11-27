import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../../api';
import { Campo, Carregando, Erro } from '../../componentes/ui';
import { usarAtendentes, usarCanais, usarFunis, usarVariaveisCrm, type Template } from './comum';
import { TextoComVariaveis } from '../../componentes/TextoComVariaveis';

// ───────────── Tarefas ─────────────

export function Tarefas() {
  const qc = useQueryClient();
  const [todas, setTodas] = useState(false);
  const q = useQuery({ queryKey: ['crm', 'tarefas', todas], queryFn: () => api<any[]>(`/crm/tarefas${todas ? '?todas=1' : ''}`), refetchInterval: 30_000 });
  const marcar = useMutation({ mutationFn: (id: string) => api(`/crm/tarefas/${id}`, { metodo: 'PATCH', corpo: { feita: true } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  if (q.isLoading) return <Carregando />;
  const agora = Date.now();
  return (
    <div>
      {pode('crm', 'excluir') && <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={todas} onChange={(e) => setTodas(e.target.checked)} /> Ver as tarefas de toda a equipe</label>}
      {q.error && <Erro erro={q.error} />}
      {!q.data?.length ? <div className="cartao vazio">Nenhuma tarefa aberta. 🎉</div> : (
        <table className="tabela">
          <thead><tr><th></th><th>Tarefa</th><th>Card</th><th>Prazo</th><th>Responsável</th></tr></thead>
          <tbody>
            {q.data.map((t) => {
              const vencida = new Date(t.vence_em).getTime() < agora;
              return (
                <tr key={t.id}>
                  <td><input type="checkbox" disabled={marcar.isPending} onChange={() => marcar.mutate(t.id)} title="Concluir" /></td>
                  <td>{t.titulo}</td>
                  <td><Link to={`/crm/lead/${t.lead_id}`}>{t.lead}</Link></td>
                  <td style={{ color: vencida ? 'var(--erro)' : undefined, fontWeight: vencida ? 700 : undefined }}>{vencida ? 'Vencida · ' : ''}{new Date(t.vence_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{t.responsavel ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ───────────── Gatilhos ─────────────

const EVENTOS: Record<string, string> = {
  lead_criado: 'Card novo no funil',
  entrou_etapa: 'Card entrou na etapa',
  mensagem_recebida: 'Mensagem recebida',
  sem_resposta: 'Sem resposta do contato há X horas',
  etiqueta_adicionada: 'Etiqueta adicionada',
};
const ACOES: Record<string, string> = {
  enviar_template: 'Enviar template',
  enviar_mensagem: 'Enviar mensagem',
  esperar: 'Esperar',
  mover_etapa: 'Mover para a etapa',
  atribuir: 'Atribuir responsável (rodízio)',
  adicionar_etiqueta: 'Adicionar etiqueta',
  criar_tarefa: 'Criar tarefa',
};
interface Gatilho { id: string; nome: string; funilId: string | null; evento: string; etapaId: string | null; parametro: string | null; acoes: Record<string, any>[]; ativo: boolean; execucoes: number; agendados: number; errosSemana: number }

export function Gatilhos() {
  const qc = useQueryClient();
  const funis = usarFunis();
  const q = useQuery({ queryKey: ['crm', 'gatilhos'], queryFn: () => api<Gatilho[]>('/crm/gatilhos') });
  const [editando, setEditando] = useState<Partial<Gatilho> | null>(null);
  const ligar = useMutation({ mutationFn: (g: Gatilho) => api(`/crm/gatilhos/${g.id}`, { metodo: 'PATCH', corpo: { ativo: !g.ativo } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'gatilhos'] }) });
  const apagar = useMutation({ mutationFn: (id: string) => api(`/crm/gatilhos/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'gatilhos'] }) });
  const gestor = pode('crm', 'excluir');
  if (q.isLoading) return <Carregando />;
  const descrever = (g: Gatilho) => {
    const f = funis.data?.find((x) => x.id === g.funilId);
    const e = f?.etapas.find((x) => x.id === g.etapaId);
    return `${EVENTOS[g.evento]}${e ? ` "${e.nome}"` : ''}${g.parametro ? ` (${g.evento === 'sem_resposta' ? `${g.parametro} h` : g.parametro})` : ''}${f ? ` · ${f.nome}` : ' · qualquer funil'}`;
  };
  return (
    <div>
      {gestor && !editando && <button className="botao" style={{ marginBottom: 12 }} onClick={() => setEditando({ nome: '', evento: 'entrou_etapa', acoes: [{ tipo: 'enviar_template' }], ativo: true })}>+ Novo gatilho</button>}
      {editando && <EditorGatilho inicial={editando} fechar={() => setEditando(null)} />}
      {(q.error || ligar.error) && <Erro erro={q.error ?? ligar.error} />}
      {!q.data?.length && !editando ? <div className="cartao vazio">Nenhum gatilho. Exemplo: quando a candidata entrar em "Primeiro contato", enviar o template de boas-vindas e criar uma tarefa para ligar no dia seguinte.</div> : (
        <div className="coluna" style={{ gap: 8 }}>
          {q.data?.map((g) => (
            <div key={g.id} className="cartao flex entre" style={{ gap: 12, opacity: g.ativo ? 1 : 0.6 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>⚡ {g.nome}</div>
                <div className="muted" style={{ fontSize: 13 }}>Quando: {descrever(g)}</div>
                <div className="muted" style={{ fontSize: 13 }}>Faz: {g.acoes.map((a) => ACOES[a.tipo] + (a.tipo === 'esperar' ? ` ${a.minutos} min` : '')).join(' → ')}</div>
                <div className="muted" style={{ fontSize: 12 }}>{g.execucoes} execução(ões){g.agendados ? ` · ${g.agendados} esperando` : ''}{g.errosSemana ? ` · ` : ''}{g.errosSemana ? <b style={{ color: 'var(--erro)' }}>{g.errosSemana} erro(s) na semana</b> : null}</div>
              </div>
              {gestor && (
                <div className="flex" style={{ gap: 6 }}>
                  <label className="check"><input type="checkbox" checked={g.ativo} onChange={() => ligar.mutate(g)} /> Ligado</label>
                  <button className="botao claro pequeno" onClick={() => setEditando(g)}>Editar</button>
                  <button className="botao perigo pequeno" onClick={() => window.confirm(`Apagar o gatilho "${g.nome}"?`) && apagar.mutate(g.id)}>Apagar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EditorGatilho({ inicial, fechar }: { inicial: Partial<Gatilho>; fechar: () => void }) {
  const variaveis = usarVariaveisCrm();
  const qc = useQueryClient();
  const funis = usarFunis();
  const canais = usarCanais();
  const atendentes = usarAtendentes();
  const templates = useQuery({ queryKey: ['crm', 'templates', 'todos'], queryFn: () => api<Template[]>('/crm/templates') });
  const [g, setG] = useState<Partial<Gatilho>>(inicial);
  const funil = funis.data?.find((f) => f.id === g.funilId);
  const etapasTodas = funil?.etapas ?? funis.data?.flatMap((f) => f.etapas.map((e) => ({ ...e, nome: `${f.nome} › ${e.nome}` }))) ?? [];
  const salvar = useMutation({
    mutationFn: () => (g.id ? api(`/crm/gatilhos/${g.id}`, { metodo: 'PATCH', corpo: corpo() }) : api('/crm/gatilhos', { corpo: corpo() })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'gatilhos'] });
      fechar();
    },
  });
  function corpo() {
    return { nome: g.nome, funilId: g.funilId || null, evento: g.evento, etapaId: g.evento === 'entrou_etapa' ? g.etapaId || null : null, parametro: g.parametro || null, acoes: g.acoes, ativo: g.ativo ?? true };
  }
  const acoes = g.acoes ?? [];
  const setAcao = (i: number, a: Record<string, any>) => setG({ ...g, acoes: acoes.map((x, j) => (j === i ? a : x)) });
  const sel = { padding: 7, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' } as const;
  return (
    <div className="cartao form" style={{ marginBottom: 14 }}>
      <div className="secao" style={{ gridColumn: '1 / -1', marginTop: 0 }}>{g.id ? 'Editar gatilho' : 'Novo gatilho'}</div>
      <Campo rotulo="Nome" className="l2"><input value={g.nome ?? ''} onChange={(e) => setG({ ...g, nome: e.target.value })} placeholder="Ex.: Boas-vindas à candidata" /></Campo>
      <Campo rotulo="Funil" className="l2">
        <select value={g.funilId ?? ''} onChange={(e) => setG({ ...g, funilId: e.target.value || null, etapaId: null })}>
          <option value="">Qualquer funil</option>
          {funis.data?.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Quando" className="l2">
        <select value={g.evento} onChange={(e) => setG({ ...g, evento: e.target.value })}>{Object.entries(EVENTOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </Campo>
      {g.evento === 'entrou_etapa' && (
        <Campo rotulo="Etapa" className="l2">
          <select value={g.etapaId ?? ''} onChange={(e) => setG({ ...g, etapaId: e.target.value })}><option value="">Escolha…</option>{etapasTodas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select>
        </Campo>
      )}
      {g.evento === 'sem_resposta' && <Campo rotulo="Horas sem resposta" className="l2"><input type="number" min={1} value={g.parametro ?? ''} onChange={(e) => setG({ ...g, parametro: e.target.value })} /></Campo>}
      {g.evento === 'mensagem_recebida' && <Campo rotulo="Só se a mensagem contiver (opcional)" className="l2"><input value={g.parametro ?? ''} onChange={(e) => setG({ ...g, parametro: e.target.value })} placeholder="Ex.: catálogo" /></Campo>}
      {g.evento === 'etiqueta_adicionada' && <Campo rotulo="Etiqueta" className="l2"><input value={g.parametro ?? ''} onChange={(e) => setG({ ...g, parametro: e.target.value })} /></Campo>}

      <div className="l4">
        <div className="secao">Ações, em ordem</div>
        {acoes.map((a, i) => (
          <div key={i} className="flex" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0', borderBottom: '1px dashed var(--linha)' }}>
            <b style={{ width: 22 }}>{i + 1}.</b>
            <select value={a.tipo} onChange={(e) => setAcao(i, { tipo: e.target.value })} style={sel}>{Object.entries(ACOES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            {a.tipo === 'esperar' && <><input type="number" min={1} value={a.minutos ?? ''} onChange={(e) => setAcao(i, { ...a, minutos: Number(e.target.value) })} style={{ ...sel, width: 90 }} /> <span className="muted">minutos (1440 = 1 dia)</span></>}
            {a.tipo === 'enviar_template' && (
              <select value={a.templateId ?? ''} onChange={(e) => setAcao(i, { ...a, templateId: e.target.value })} style={sel}>
                <option value="">Template…</option>
                {templates.data?.filter((t) => t.tipo === 'livre' || t.status === 'APPROVED').map((t) => <option key={t.id} value={t.id}>{t.nome}{t.tipo === 'meta' ? ' (Meta)' : ''}</option>)}
              </select>
            )}
            {a.tipo === 'enviar_mensagem' && <div style={{ flex: 1, minWidth: 220 }}><TextoComVariaveis umaLinha value={a.texto ?? ''} onChange={(t) => setAcao(i, { ...a, texto: t })} variaveis={variaveis} placeholder="Oi {{primeiro_nome}}… (digite { para as variáveis)" style={sel} /></div>}
            {(a.tipo === 'enviar_mensagem' || (a.tipo === 'enviar_template' && templates.data?.find((t) => t.id === a.templateId)?.tipo !== 'meta')) && (
              <select value={a.canalId ?? ''} onChange={(e) => setAcao(i, { ...a, canalId: e.target.value || undefined })} style={sel}>
                <option value="">Número da última conversa</option>
                {canais.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            )}
            {a.tipo === 'mover_etapa' && <select value={a.etapaId ?? ''} onChange={(e) => setAcao(i, { ...a, etapaId: e.target.value })} style={sel}><option value="">Etapa…</option>{etapasTodas.filter((e) => e.tipo !== 'perdido').map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select>}
            {a.tipo === 'atribuir' && (
              <span className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                {atendentes.data?.map((u) => (
                  <label key={u.id} className="check" style={{ fontSize: 13 }}>
                    <input type="checkbox" checked={(a.usuarios ?? []).includes(u.id)} onChange={(e) => setAcao(i, { ...a, usuarios: e.target.checked ? [...(a.usuarios ?? []), u.id] : (a.usuarios ?? []).filter((x: string) => x !== u.id) })} /> {u.nome}
                  </label>
                ))}
              </span>
            )}
            {a.tipo === 'adicionar_etiqueta' && <input value={a.etiqueta ?? ''} onChange={(e) => setAcao(i, { ...a, etiqueta: e.target.value })} placeholder="etiqueta" style={sel} />}
            {a.tipo === 'criar_tarefa' && <><input value={a.titulo ?? ''} onChange={(e) => setAcao(i, { ...a, titulo: e.target.value })} placeholder="Ligar para a candidata" style={{ ...sel, flex: 1, minWidth: 180 }} /><input type="number" min={0} value={a.horas ?? 24} onChange={(e) => setAcao(i, { ...a, horas: Number(e.target.value) })} style={{ ...sel, width: 80 }} /> <span className="muted">h de prazo</span></>}
            <span style={{ flex: 1 }} />
            <button className="botao claro pequeno" disabled={i === 0} onClick={() => { const n = [...acoes]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setG({ ...g, acoes: n }); }}>↑</button>
            <button className="botao claro pequeno" onClick={() => setG({ ...g, acoes: acoes.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <button className="botao claro pequeno" style={{ marginTop: 8 }} onClick={() => setG({ ...g, acoes: [...acoes, { tipo: 'esperar', minutos: 60 }] })}>+ Ação</button>
        <p className="muted" style={{ fontSize: 13 }}>Na mensagem: {'{{nome}}'}, {'{{primeiro_nome}}'}, {'{{etapa}}'}, {'{{funil}}'}. Num gatilho de etapa, se o card sair da etapa durante uma espera, o resto não acontece.</p>
      </div>
      {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
      <div className="flex l4">
        <button className="botao" disabled={!g.nome?.trim() || !acoes.length || salvar.isPending} onClick={() => salvar.mutate()}>Salvar gatilho</button>
        <button className="botao claro" onClick={fechar}>Voltar</button>
      </div>
    </div>
  );
}

// ───────────── Disparos em massa ─────────────

const STATUS_D: Record<string, [string, string]> = { rascunho: ['neutra', 'Rascunho'], agendado: ['alerta', 'Agendado'], enviando: ['alerta', 'Enviando'], pausado: ['neutra', 'Pausado'], concluido: ['ok', 'Concluído'], cancelado: ['erro', 'Cancelado'] };

export function Disparos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm', 'disparos'], queryFn: () => api<any[]>('/crm/disparos'), refetchInterval: (x) => (x.state.data?.some((d) => d.status === 'enviando') ? 4000 : 30_000) });
  const [novo, setNovo] = useState(false);
  const [quando, setQuando] = useState<Record<string, string>>({});
  const acao = useMutation({ mutationFn: ({ id, a, corpo }: { id: string; a: string; corpo?: unknown }) => api(`/crm/disparos/${id}/${a}`, { corpo: corpo ?? {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'disparos'] }) });
  const gestor = pode('crm', 'excluir');
  if (q.isLoading) return <Carregando />;
  return (
    <div>
      {gestor && !novo && <button className="botao" style={{ marginBottom: 12 }} onClick={() => setNovo(true)}>+ Novo disparo</button>}
      {novo && <NovoDisparo fechar={() => setNovo(false)} />}
      {(q.error || acao.error) && <Erro erro={q.error ?? acao.error} />}
      {!q.data?.length && !novo ? <div className="cartao vazio">Nenhum disparo ainda.</div> : (
        <div className="coluna" style={{ gap: 8 }}>
          {q.data?.map((d) => {
            const [cls, nome] = STATUS_D[d.status] ?? ['neutra', d.status];
            const feitos = d.enviados + d.falhas;
            const p = d.porStatus ?? {};
            return (
              <div key={d.id} className="cartao">
                <div className="flex entre" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <b>{d.nome}</b> <span className={`etiqueta ${cls}`}>{nome}</span>
                    <div className="muted" style={{ fontSize: 13 }}>{d.canal} · {d.template ? `template "${d.template}"` : 'mensagem livre'} · {d.ritmo}/min{d.agendadoPara ? ` · para ${new Date(d.agendadoPara).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</div>
                  </div>
                  {gestor && (
                    <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {['rascunho', 'pausado'].includes(d.status) && (
                        <>
                          <input type="datetime-local" value={quando[d.id] ?? ''} onChange={(e) => setQuando({ ...quando, [d.id]: e.target.value })} style={{ padding: 5, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }} />
                          <button className="botao pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ id: d.id, a: 'iniciar', corpo: { quando: quando[d.id] ? new Date(quando[d.id]).toISOString() : null } })}>{quando[d.id] ? 'Agendar' : d.status === 'pausado' ? 'Continuar' : 'Enviar agora'}</button>
                        </>
                      )}
                      {['enviando', 'agendado'].includes(d.status) && <button className="botao claro pequeno" onClick={() => acao.mutate({ id: d.id, a: 'pausar' })}>Pausar</button>}
                      {!['concluido', 'cancelado'].includes(d.status) && <button className="botao perigo pequeno" onClick={() => window.confirm('Cancelar este disparo? Quem ainda não recebeu fica sem receber.') && acao.mutate({ id: d.id, a: 'cancelar' })}>Cancelar</button>}
                    </div>
                  )}
                </div>
                <div style={{ height: 8, background: 'var(--creme-2)', borderRadius: 4, marginTop: 10, overflow: 'hidden' }}>
                  <div style={{ width: `${d.total ? (feitos / d.total) * 100 : 0}%`, height: '100%', background: 'var(--marrom)', transition: 'width 0.5s' }} />
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  {d.total} contato(s) · {d.enviados} enviada(s){p.entregue ? ` · ${p.entregue} entregue(s)` : ''}{p.lida ? ` · ${p.lida} lida(s)` : ''}{p.respondeu ? ` · ${p.respondeu} respondeu(ram)` : ''}{d.falhas ? ` · ${d.falhas} sem enviar` : ''}{p.pulado ? ` (${p.pulado} pulado(s))` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NovoDisparo({ fechar }: { fechar: () => void }) {
  const variaveis = usarVariaveisCrm();
  const qc = useQueryClient();
  const funis = usarFunis();
  const canais = usarCanais();
  const [f, setF] = useState({ nome: '', canalId: '', templateId: '', texto: '', funilId: '', etapaIds: [] as string[], etiquetas: '', status: 'aberto', ritmo: 20 });
  const canal = canais.data?.find((c) => c.id === f.canalId);
  const templates = useQuery({ queryKey: ['crm', 'templates', f.canalId], queryFn: () => api<Template[]>(`/crm/templates?canalId=${f.canalId}`), enabled: !!f.canalId });
  const funil = funis.data?.find((x) => x.id === f.funilId);
  const criar = useMutation({
    mutationFn: () =>
      api<{ total: number }>('/crm/disparos', {
        corpo: {
          nome: f.nome,
          canalId: f.canalId,
          templateId: f.templateId || null,
          texto: f.templateId ? null : f.texto || null,
          ritmo: f.ritmo,
          filtro: { funilId: f.funilId || undefined, etapaIds: f.etapaIds.length ? f.etapaIds : undefined, etiquetas: f.etiquetas.trim() ? f.etiquetas.split(',').map((x) => x.trim()).filter(Boolean) : undefined, status: f.status || undefined },
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'disparos'] });
      fechar();
    },
  });
  const usaveis = (templates.data ?? []).filter((t) => (canal?.tipo === 'oficial' ? t.tipo === 'meta' && t.status === 'APPROVED' : t.tipo === 'livre'));
  return (
    <div className="cartao form" style={{ marginBottom: 14 }}>
      <div className="secao" style={{ gridColumn: '1 / -1', marginTop: 0 }}>Novo disparo em massa</div>
      <Campo rotulo="Nome" className="l2"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Lançamento coleção verão" /></Campo>
      <Campo rotulo="Número que envia" className="l2"><select value={f.canalId} onChange={(e) => setF({ ...f, canalId: e.target.value, templateId: '' })}><option value="">Escolha…</option>{canais.data?.map((c) => <option key={c.id} value={c.id}>{c.nome} ({c.tipo === 'oficial' ? 'oficial' : 'QR code'})</option>)}</select></Campo>
      {f.canalId && (
        <Campo rotulo={canal?.tipo === 'oficial' ? 'Template aprovado pela Meta' : 'Template (ou escreva abaixo)'} className="l2">
          <select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">{canal?.tipo === 'oficial' ? 'Escolha…' : 'Mensagem livre'}</option>{usaveis.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}</select>
        </Campo>
      )}
      {f.canalId && canal && canal.tipo !== 'oficial' && !f.templateId && <Campo rotulo="Mensagem" className="l2"><TextoComVariaveis linhas={3} value={f.texto} onChange={(t) => setF({ ...f, texto: t })} variaveis={variaveis} placeholder="Oi {{primeiro_nome}}!… (digite { para ver as variáveis)" /></Campo>}
      <Campo rotulo="Funil" className="l2"><select value={f.funilId} onChange={(e) => setF({ ...f, funilId: e.target.value, etapaIds: [] })}><option value="">Todos os funis</option>{funis.data?.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}</select></Campo>
      <Campo rotulo="Situação dos cards" className="l2"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="aberto">Abertos</option><option value="ganho">Ganhos</option><option value="perdido">Perdidos</option><option value="">Todos</option></select></Campo>
      {funil && (
        <div className="l4">
          <label className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Só estas etapas (vazio = todas)</label>
          <div className="flex" style={{ gap: 10, flexWrap: 'wrap' }}>
            {funil.etapas.map((e) => <label key={e.id} className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={f.etapaIds.includes(e.id)} onChange={(ev) => setF({ ...f, etapaIds: ev.target.checked ? [...f.etapaIds, e.id] : f.etapaIds.filter((x) => x !== e.id) })} /> {e.nome}</label>)}
          </div>
        </div>
      )}
      <Campo rotulo="Com estas etiquetas (opcional)" className="l2" ajuda="Separadas por vírgula"><input value={f.etiquetas} onChange={(e) => setF({ ...f, etiquetas: e.target.value })} /></Campo>
      <Campo rotulo="Mensagens por minuto" className="l2" ajuda={canal && canal.tipo !== 'oficial' ? 'No QR code, até 20 por minuto reduz o risco de bloqueio' : 'Oficial: respeita o limite da conta na Meta'}><input type="number" min={1} max={200} value={f.ritmo} onChange={(e) => setF({ ...f, ritmo: Number(e.target.value) })} /></Campo>
      <p className="muted l4" style={{ fontSize: 13 }}>Quem pediu para não receber (respondeu SAIR) fica de fora sozinho. O disparo é criado como rascunho com a contagem; você confere e manda enviar ou agenda.</p>
      {criar.error && <div className="l4"><Erro erro={criar.error} /></div>}
      <div className="flex l4">
        <button className="botao" disabled={!f.nome.trim() || !f.canalId || (!f.templateId && !f.texto.trim()) || criar.isPending} onClick={() => criar.mutate()}>Criar e contar destinatários</button>
        <button className="botao claro" onClick={fechar}>Voltar</button>
      </div>
    </div>
  );
}
