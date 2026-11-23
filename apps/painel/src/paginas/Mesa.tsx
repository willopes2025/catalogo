import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, lerSessao, pode } from '../api';
import { data as dataBR, dataHora, reais } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';
import './financeiro/financeiro.css';
import './mesa.css';

interface Pessoa { id: string; nome: string; setor: string; online: boolean }
interface Conversa { id: string; nome: string; direta: boolean; ultima: string | null; ultimaEm: string; naoLidas: number; participantes: { id: string; nome: string }[] }
interface Mensagem { id: string; usuarioId: string | null; de: string | null; texto: string; criadoEm: string }
interface Tarefa { id: string; titulo: string; descricao: string | null; prioridade: 'baixa' | 'normal' | 'alta'; venceEm: string | null; feitaEm: string | null; responsavelId: string; responsavel: string; criadoPorId: string | null; criadoPor: string | null; atrasada: boolean }
interface Painel { setor: string | null; personalizado: boolean; indicadores: { chave: string; rotulo: string; formato: 'reais' | 'numero'; link: string; valor: number; alerta: boolean }[]; catalogo?: { chave: string; rotulo: string; modulo: string }[]; setores?: { id: string; nome: string; indicadores: string[] | null }[] }

export const usarEquipe = () => useQuery({ queryKey: ['mesa', 'equipe'], queryFn: () => api<Pessoa[]>('/mesa/equipe'), staleTime: 30_000 });

/** Minha mesa: o painel do meu setor, as minhas tarefas e a conversa com a equipe. */
export function Mesa() {
  const [sp, setSp] = useSearchParams();
  const conversaId = sp.get('conversa');
  return (
    <>
      <Topo eb="Equipe" titulo="Minha mesa" sub="O painel do seu setor, as suas tarefas e a conversa interna com a equipe" />
      <PainelDoSetor />
      <div className="mesa-grade">
        <Tarefas />
        <Chat conversaId={conversaId} abrir={(id) => setSp(id ? { conversa: id } : {}, { replace: true })} />
      </div>
    </>
  );
}

function PainelDoSetor() {
  const q = useQuery({ queryKey: ['mesa', 'painel'], queryFn: () => api<Painel>('/mesa/painel'), refetchInterval: 60_000 });
  const [config, setConfig] = useState(false);
  if (q.isLoading) return <Carregando />;
  if (q.error || !q.data) return <Erro erro={q.error} />;
  const p = q.data;
  return (
    <div className="mesa-painel">
      <div className="flex entre" style={{ marginBottom: 8 }}>
        <b>Painel{p.setor ? ` · ${p.setor}` : ''}</b>
        {p.catalogo && <button className="botao claro pequeno" onClick={() => setConfig(true)}>Painel do setor</button>}
      </div>
      {p.indicadores.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhum indicador para o seu setor ainda.</p> : (
        <div className="mesa-indicadores">
          {p.indicadores.map((i) => (
            <Link key={i.chave} to={i.link} className={`cartao mesa-ind ${i.alerta ? 'alerta' : ''}`}>
              <span className="rotulo">{i.rotulo}</span>
              <span className="valor">{i.formato === 'reais' ? reais(i.valor) : i.valor.toLocaleString('pt-BR')}</span>
            </Link>
          ))}
        </div>
      )}
      {config && p.catalogo && p.setores && <ConfigPainel catalogo={p.catalogo} setores={p.setores} fechar={() => setConfig(false)} />}
    </div>
  );
}

function ConfigPainel({ catalogo, setores, fechar }: { catalogo: NonNullable<Painel['catalogo']>; setores: NonNullable<Painel['setores']>; fechar: () => void }) {
  const qc = useQueryClient();
  const [grupoId, setGrupoId] = useState(setores[0]?.id ?? '');
  const [escolha, setEscolha] = useState<Record<string, string[]>>(() => Object.fromEntries(setores.map((s) => [s.id, s.indicadores ?? []])));
  const salvar = useMutation({ mutationFn: () => api('/mesa/painel', { metodo: 'PUT', corpo: { grupoId, indicadores: escolha[grupoId] ?? [] } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mesa', 'painel'] }) });
  const marcados = escolha[grupoId] ?? [];
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>Painel do setor</h3>
        <p className="muted" style={{ marginTop: 0 }}>Escolha os indicadores que cada setor (grupo de usuários) vê na Minha mesa. Sem nenhum marcado, cada pessoa vê os dos módulos a que tem acesso. Indicador de módulo que a pessoa não pode ver não aparece para ela.</p>
        <Campo rotulo="Setor"><select value={grupoId} onChange={(e) => { setGrupoId(e.target.value); salvar.reset(); }}>{setores.map((s) => <option key={s.id} value={s.id}>{s.nome}{(escolha[s.id] ?? []).length ? ` (${escolha[s.id].length})` : ''}</option>)}</select></Campo>
        <div className="mesa-catalogo">
          {catalogo.map((c) => (
            <label key={c.chave} className="check"><input type="checkbox" checked={marcados.includes(c.chave)} onChange={(e) => setEscolha({ ...escolha, [grupoId]: e.target.checked ? [...marcados, c.chave] : marcados.filter((k) => k !== c.chave) })} /> {c.rotulo}</label>
          ))}
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
        {salvar.isSuccess && <div className="aviso ok" style={{ marginTop: 8 }}>Painel do setor salvo.</div>}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={salvar.isPending || marcados.length > 12} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : 'Salvar este setor'}</button>
          <button className="botao claro" onClick={fechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

const PRIORIDADE = { alta: 'Alta', normal: 'Normal', baixa: 'Baixa' } as const;

export function Tarefas({ resumida }: { resumida?: boolean }) {
  const qc = useQueryClient();
  const eu = lerSessao()?.usuario.id;
  const gestao = pode('configuracoes', 'ver');
  const [filtro, setFiltro] = useState<'minhas' | 'criadas' | 'equipe'>('minhas');
  const [feitas, setFeitas] = useState(false);
  const [nova, setNova] = useState(false);
  const q = useQuery({ queryKey: ['mesa', 'tarefas', filtro, feitas], queryFn: () => api<Tarefa[]>(`/mesa/tarefas?filtro=${filtro}${feitas ? '&feitas=1' : ''}`), refetchInterval: 60_000 });
  const mudar = useMutation({ mutationFn: ({ id, ...corpo }: { id: string; feita: boolean }) => api(`/mesa/tarefas/${id}`, { metodo: 'PATCH', corpo }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mesa'] }) });
  const lista = resumida ? (q.data ?? []).slice(0, 6) : q.data ?? [];
  return (
    <div className={resumida ? '' : 'cartao'}>
      <div className="flex entre" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <b>{resumida ? 'Minhas tarefas' : 'Tarefas'}</b>
        <span className="flex" style={{ gap: 6 }}>
          {!resumida && (
            <select value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)} aria-label="Quais tarefas">
              <option value="minhas">Minhas</option>
              <option value="criadas">Que eu passei</option>
              {gestao && <option value="equipe">Da equipe toda</option>}
            </select>
          )}
          {!resumida && <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={feitas} onChange={(e) => setFeitas(e.target.checked)} /> Feitas</label>}
          {resumida ? <Link className="botao claro pequeno" to="/mesa">Abrir a mesa</Link> : <button className="botao pequeno" onClick={() => setNova(true)}>Nova tarefa</button>}
        </span>
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : lista.length === 0 ? <p className="muted" style={{ margin: 0 }}>{feitas ? 'Nenhuma tarefa concluída nos últimos 30 dias.' : 'Nenhuma tarefa aberta.'}</p> : (
        <div className="mesa-tarefas">
          {lista.map((t) => (
            <label key={t.id} className={`mesa-tarefa ${t.atrasada ? 'atrasada' : ''} ${t.feitaEm ? 'feita' : ''}`}>
              <input type="checkbox" checked={!!t.feitaEm} disabled={mudar.isPending || (t.responsavelId !== eu && t.criadoPorId !== eu && !gestao)} onChange={(e) => mudar.mutate({ id: t.id, feita: e.target.checked })} />
              <span>
                <b>{t.titulo}</b>{t.prioridade !== 'normal' && <span className={`etiqueta ${t.prioridade === 'alta' ? 'erro' : 'neutra'}`} style={{ marginLeft: 6 }}>{PRIORIDADE[t.prioridade]}</span>}
                {t.descricao && <span className="descricao">{t.descricao}</span>}
                <span className="muted">
                  {t.venceEm ? `${t.atrasada ? 'Venceu em' : 'Até'} ${dataBR(t.venceEm)}` : 'Sem prazo'}
                  {t.responsavelId !== eu && ` · com ${t.responsavel}`}
                  {t.criadoPorId && t.criadoPorId !== t.responsavelId && ` · passada por ${t.criadoPorId === eu ? 'você' : t.criadoPor}`}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {mudar.error && <Erro erro={mudar.error} />}
      {nova && <NovaTarefa fechar={() => setNova(false)} />}
    </div>
  );
}

function NovaTarefa({ fechar }: { fechar: () => void }) {
  const qc = useQueryClient();
  const equipe = usarEquipe();
  const eu = lerSessao()?.usuario.id ?? '';
  const [f, setF] = useState({ titulo: '', descricao: '', responsavelId: eu, venceEm: '', prioridade: 'normal' });
  const salvar = useMutation({ mutationFn: () => api('/mesa/tarefas', { corpo: { titulo: f.titulo, descricao: f.descricao || null, responsavelId: f.responsavelId || undefined, venceEm: f.venceEm || null, prioridade: f.prioridade } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['mesa'] }); fechar(); } });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <form className="cartao modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); salvar.mutate(); }}>
        <h3 style={{ margin: '0 0 10px' }}>Nova tarefa</h3>
        <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Campo rotulo="O que precisa ser feito *" className="l2"><input autoFocus maxLength={200} value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} /></Campo>
          <Campo rotulo="Detalhes" className="l2"><textarea rows={3} maxLength={2000} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} /></Campo>
          <Campo rotulo="Responsável"><select value={f.responsavelId} onChange={(e) => setF({ ...f, responsavelId: e.target.value })}>{equipe.data?.map((p) => <option key={p.id} value={p.id}>{p.id === eu ? `${p.nome} (eu)` : `${p.nome} · ${p.setor}`}</option>)}</select></Campo>
          <Campo rotulo="Prazo"><input type="date" value={f.venceEm} onChange={(e) => setF({ ...f, venceEm: e.target.value })} /></Campo>
          <Campo rotulo="Prioridade"><select value={f.prioridade} onChange={(e) => setF({ ...f, prioridade: e.target.value })}><option value="alta">Alta</option><option value="normal">Normal</option><option value="baixa">Baixa</option></select></Campo>
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={salvar.isPending || f.titulo.trim().length < 3}>{salvar.isPending ? 'Salvando…' : 'Criar tarefa'}</button>
          <button type="button" className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </form>
    </div>
  );
}

function Chat({ conversaId, abrir }: { conversaId: string | null; abrir: (id: string | null) => void }) {
  const qc = useQueryClient();
  const eu = lerSessao()?.usuario.id;
  const equipe = usarEquipe();
  const conversas = useQuery({ queryKey: ['mesa', 'conversas'], queryFn: () => api<Conversa[]>('/mesa/conversas'), refetchInterval: 10_000 });
  const [grupo, setGrupo] = useState(false);
  const iniciar = useMutation({ mutationFn: (usuarioId: string) => api<{ id: string }>('/mesa/conversas', { corpo: { usuarioIds: [usuarioId] } }), onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['mesa', 'conversas'] }); abrir(r.id); } });
  const atual = conversas.data?.find((c) => c.id === conversaId);
  const comConversa = new Set((conversas.data ?? []).filter((c) => c.direta).flatMap((c) => c.participantes.map((p) => p.id)));
  return (
    <div className="cartao mesa-chat">
      <div className="mesa-lista">
        <div className="flex entre" style={{ marginBottom: 6 }}><b>Conversas</b><button className="botao claro pequeno" onClick={() => setGrupo(true)}>Novo grupo</button></div>
        {conversas.data?.map((c) => (
          <button key={c.id} type="button" className={`mesa-conversa ${c.id === conversaId ? 'ativa' : ''}`} onClick={() => abrir(c.id)}>
            <span className="nome">{c.direta ? '' : '👥 '}{c.nome}{c.naoLidas > 0 && <span className="bolha-menu">{c.naoLidas}</span>}</span>
            <span className="muted">{c.ultima ?? 'Sem mensagens'}</span>
          </button>
        ))}
        <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>Equipe</div>
        {equipe.data?.filter((p) => p.id !== eu && !comConversa.has(p.id)).map((p) => (
          <button key={p.id} type="button" className="mesa-conversa" disabled={iniciar.isPending} onClick={() => iniciar.mutate(p.id)}>
            <span className="nome"><span className={`mesa-ponto ${p.online ? 'on' : ''}`} />{p.nome}</span>
            <span className="muted">{p.setor}</span>
          </button>
        ))}
        {iniciar.error && <Erro erro={iniciar.error} />}
      </div>
      {conversaId ? <Mensagens key={conversaId} conversaId={conversaId} titulo={atual?.nome ?? 'Conversa'} participantes={atual && !atual.direta ? atual.participantes.map((p) => p.nome).join(', ') : ''} voltar={() => abrir(null)} /> : <div className="mesa-vazio muted">Escolha uma conversa ou uma pessoa da equipe para começar.</div>}
      {grupo && <NovoGrupo fechar={() => setGrupo(false)} abrir={abrir} />}
    </div>
  );
}

function Mensagens({ conversaId, titulo, participantes, voltar }: { conversaId: string; titulo: string; participantes: string; voltar: () => void }) {
  const qc = useQueryClient();
  const eu = lerSessao()?.usuario.id;
  const [texto, setTexto] = useState('');
  const fim = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['mesa', 'mensagens', conversaId], queryFn: () => api<{ mensagens: Mensagem[] }>(`/mesa/conversas/${conversaId}/mensagens`), refetchInterval: 4_000 });
  const enviar = useMutation({
    mutationFn: (t: string) => api<Mensagem>(`/mesa/conversas/${conversaId}/mensagens`, { corpo: { texto: t } }),
    onSuccess: (m) => { setTexto(''); qc.setQueryData<{ mensagens: Mensagem[] }>(['mesa', 'mensagens', conversaId], (a) => ({ mensagens: [...(a?.mensagens ?? []), m] })); qc.invalidateQueries({ queryKey: ['mesa', 'conversas'] }); },
  });
  const n = q.data?.mensagens.length ?? 0;
  useEffect(() => { fim.current?.scrollIntoView({ block: 'end' }); }, [n]);
  // Abrir a conversa marca como lida: o aviso do menu acompanha.
  useEffect(() => { if (n) { qc.invalidateQueries({ queryKey: ['mesa', 'resumo'] }); qc.invalidateQueries({ queryKey: ['mesa', 'conversas'] }); } }, [n, qc]);
  return (
    <div className="mesa-conversa-aberta">
      <div className="mesa-cabecalho"><button type="button" className="botao claro pequeno mesa-voltar" onClick={voltar}>‹</button><span><b>{titulo}</b>{participantes && <span className="muted"> · {participantes}</span>}</span></div>
      <div className="mesa-mensagens">
        {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.mensagens.length === 0 ? <p className="muted">Nenhuma mensagem ainda.</p> : q.data!.mensagens.map((m) => (
          <div key={m.id} className={`mesa-msg ${m.usuarioId === eu ? 'minha' : ''}`}>
            {m.usuarioId !== eu && <span className="de">{m.de ?? 'Saiu da equipe'}</span>}
            <span className="texto">{m.texto}</span>
            <span className="hora">{dataHora(m.criadoEm)}</span>
          </div>
        ))}
        <div ref={fim} />
      </div>
      <form className="mesa-escrever" onSubmit={(e) => { e.preventDefault(); if (texto.trim() && !enviar.isPending) enviar.mutate(texto); }}>
        <textarea rows={1} maxLength={4000} placeholder="Escreva para a equipe…" value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (texto.trim() && !enviar.isPending) enviar.mutate(texto); } }} />
        <button className="botao" disabled={!texto.trim() || enviar.isPending}>Enviar</button>
      </form>
      {enviar.error && <Erro erro={enviar.error} />}
    </div>
  );
}

function NovoGrupo({ fechar, abrir }: { fechar: () => void; abrir: (id: string) => void }) {
  const qc = useQueryClient();
  const equipe = usarEquipe();
  const eu = lerSessao()?.usuario.id;
  const [nome, setNome] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const criar = useMutation({ mutationFn: () => api<{ id: string }>('/mesa/conversas', { corpo: { usuarioIds: ids, nome } }), onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['mesa', 'conversas'] }); abrir(r.id); fechar(); } });
  const setores = [...new Set((equipe.data ?? []).map((p) => p.setor))];
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 10px' }}>Novo grupo</h3>
        <Campo rotulo="Nome do grupo *"><input autoFocus maxLength={60} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Financeiro, Loja Centro" /></Campo>
        <div className="flex" style={{ flexWrap: 'wrap', gap: 6, margin: '10px 0 6px' }}>
          <span className="muted" style={{ fontSize: 13 }}>Marcar o setor:</span>
          {setores.map((s) => <button key={s} type="button" className="botao claro pequeno" onClick={() => setIds([...new Set([...ids, ...(equipe.data ?? []).filter((p) => p.setor === s && p.id !== eu).map((p) => p.id)])])}>{s}</button>)}
        </div>
        <div className="mesa-catalogo">
          {equipe.data?.filter((p) => p.id !== eu).map((p) => <label key={p.id} className="check"><input type="checkbox" checked={ids.includes(p.id)} onChange={(e) => setIds(e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id))} /> {p.nome} <span className="muted">· {p.setor}</span></label>)}
        </div>
        {criar.error && <Erro erro={criar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={criar.isPending || nome.trim().length < 2 || ids.length === 0} onClick={() => criar.mutate()}>{criar.isPending ? 'Criando…' : 'Criar grupo'}</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

interface Resumo { agora: string; naoLidas: number; tarefasAbertas: number; tarefasAtrasadas: number; novas: { mensagens: { id: string; conversaId: string; de: string; texto: string }[]; tarefas: { id: string; de: string; titulo: string }[] } }
interface Aviso { id: string; titulo: string; texto: string; link: string }

/** Consulta o resumo a cada 15 s: alimenta a bolha do menu e mostra na tela o que chegou (mensagem ou tarefa nova). */
export function usarAvisosDaMesa() {
  const desde = useRef(new Date().toISOString());
  const vistos = useRef(new Set<string>());
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const q = useQuery({ queryKey: ['mesa', 'resumo'], queryFn: () => api<Resumo>(`/mesa/resumo?desde=${encodeURIComponent(desde.current)}`), refetchInterval: 15_000, enabled: pode('inicio', 'ver') });
  useEffect(() => {
    const r = q.data;
    if (!r) return;
    const naConversa = new URLSearchParams(window.location.search).get('conversa');
    const novos: Aviso[] = [
      ...r.novas.mensagens.filter((m) => !(window.location.pathname === '/mesa' && naConversa === m.conversaId)).map((m) => ({ id: `m${m.id}`, titulo: m.de, texto: m.texto, link: `/mesa?conversa=${m.conversaId}` })),
      ...r.novas.tarefas.map((t) => ({ id: `t${t.id}`, titulo: `Nova tarefa de ${t.de}`, texto: t.titulo, link: '/mesa' })),
    ].filter((a) => !vistos.current.has(a.id));
    if (!novos.length) return;
    for (const a of novos) vistos.current.add(a.id);
    setAvisos((a) => [...a, ...novos].slice(-4));
    try {
      // Com a aba em segundo plano, usa o aviso do sistema (se a pessoa já permitiu).
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') for (const a of novos) new Notification(a.titulo, { body: a.texto, tag: a.id });
    } catch { /* navegador sem aviso do sistema */ }
    const t = setTimeout(() => setAvisos((a) => a.filter((x) => !novos.includes(x))), 12_000);
    return () => clearTimeout(t);
  }, [q.data]);
  return { total: (q.data?.naoLidas ?? 0) + (q.data?.tarefasAtrasadas ?? 0), avisos, fechar: (id: string) => setAvisos((a) => a.filter((x) => x.id !== id)) };
}

export function AvisosDaMesa({ avisos, fechar }: { avisos: Aviso[]; fechar: (id: string) => void }) {
  if (!avisos.length) return null;
  return (
    <div className="mesa-avisos" role="status" aria-live="polite">
      {avisos.map((a) => (
        <div key={a.id} className="mesa-aviso">
          <Link to={a.link} onClick={() => fechar(a.id)}><b>{a.titulo}</b><span>{a.texto}</span></Link>
          <button type="button" aria-label="Fechar aviso" onClick={() => fechar(a.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
