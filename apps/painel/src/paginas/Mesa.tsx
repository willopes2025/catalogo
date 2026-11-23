import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, lerSessao, pode } from '../api';
import { data as dataBR, dataHora, reais } from '../formato';
import { PERSPECTIVAS, nomeMes, nota as notaTexto, valorDe } from './Scorecard';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';
import './financeiro/financeiro.css';
import './mesa.css';

interface Pessoa { id: string; nome: string; setor: string; online: boolean }
interface Conversa { id: string; nome: string; direta: boolean; ultima: string | null; ultimaEm: string; naoLidas: number; participantes: { id: string; nome: string }[] }
interface Mensagem { id: string; usuarioId: string | null; de: string | null; texto: string; anexoNome?: string | null; anexoMime?: string | null; anexoTamanho?: number | null; criadoEm: string }
interface Tarefa { id: string; titulo: string; descricao: string | null; prioridade: 'baixa' | 'normal' | 'alta'; venceEm: string | null; feitaEm: string | null; responsavelId: string; responsavel: string; criadoPorId: string | null; criadoPor: string | null; atrasada: boolean }
interface Painel { setor: string | null; personalizado: 'pessoa' | 'setor' | null; indicadores: { chave: string; rotulo: string; formato: 'reais' | 'numero'; link: string; valor: number; alerta: boolean }[]; catalogo?: { chave: string; rotulo: string; modulo: string }[]; setores?: { id: string; nome: string; indicadores: string[] | null }[]; pessoas?: { id: string; nome: string; setor: string; indicadores: string[] | null }[] }

export const usarEquipe = () => useQuery({ queryKey: ['mesa', 'equipe'], queryFn: () => api<Pessoa[]>('/mesa/equipe'), staleTime: 30_000 });

/** Minha mesa: o painel do meu setor, as minhas tarefas e a conversa com a equipe. */
export function Mesa() {
  const [sp, setSp] = useSearchParams();
  const conversaId = sp.get('conversa');
  return (
    <>
      <Topo eb="Equipe" titulo="Minha mesa" sub="O seu painel, as suas tarefas e a conversa interna com a equipe" />
      <AtivarAvisos />
      <PainelDoSetor />
      <MeuScorecard />
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
        <b>Painel{p.personalizado === 'pessoa' ? ' · só seu' : p.setor ? ` · ${p.setor}` : ''}</b>
        {p.catalogo && <button className="botao claro pequeno" onClick={() => setConfig(true)}>Montar painéis</button>}
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
      {config && p.catalogo && p.setores && <ConfigPainel catalogo={p.catalogo} setores={p.setores} pessoas={p.pessoas ?? []} fechar={() => setConfig(false)} />}
    </div>
  );
}

function ConfigPainel({ catalogo, setores, pessoas, fechar }: { catalogo: NonNullable<Painel['catalogo']>; setores: NonNullable<Painel['setores']>; pessoas: NonNullable<Painel['pessoas']>; fechar: () => void }) {
  const qc = useQueryClient();
  const [por, setPor] = useState<'setor' | 'pessoa'>('setor');
  const [alvo, setAlvo] = useState(setores[0]?.id ?? '');
  const [escolha, setEscolha] = useState<Record<string, string[]>>(() => ({ ...Object.fromEntries(setores.map((s) => [s.id, s.indicadores ?? []])), ...Object.fromEntries(pessoas.map((p) => [`u:${p.id}`, p.indicadores ?? []])) }));
  const chave = por === 'setor' ? alvo : `u:${alvo}`;
  const salvar = useMutation({ mutationFn: () => api('/mesa/painel', { metodo: 'PUT', corpo: { ...(por === 'setor' ? { grupoId: alvo } : { usuarioId: alvo }), indicadores: escolha[chave] ?? [] } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mesa', 'painel'] }) });
  const marcados = escolha[chave] ?? [];
  const lista = por === 'setor' ? setores.map((s) => ({ id: s.id, nome: s.nome, n: (escolha[s.id] ?? []).length })) : pessoas.map((p) => ({ id: p.id, nome: `${p.nome} · ${p.setor}`, n: (escolha[`u:${p.id}`] ?? []).length }));
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>Montar painéis</h3>
        <p className="muted" style={{ marginTop: 0 }}>Cada pessoa vê o painel dela, se você montar um; senão, o do setor (grupo de usuários); sem nenhum, os indicadores dos módulos a que tem acesso. Indicador de módulo que a pessoa não pode ver não aparece para ela.</p>
        <div className="form" style={{ gridTemplateColumns: '1fr 2fr' }}>
          <Campo rotulo="Painel de"><select value={por} onChange={(e) => { const v = e.target.value as 'setor' | 'pessoa'; setPor(v); setAlvo(v === 'setor' ? setores[0]?.id ?? '' : pessoas[0]?.id ?? ''); salvar.reset(); }}><option value="setor">Um setor</option><option value="pessoa">Uma pessoa</option></select></Campo>
          <Campo rotulo={por === 'setor' ? 'Setor' : 'Pessoa'}><select value={alvo} onChange={(e) => { setAlvo(e.target.value); salvar.reset(); }}>{lista.map((x) => <option key={x.id} value={x.id}>{x.nome}{x.n ? ` (${x.n})` : ''}</option>)}</select></Campo>
        </div>
        {por === 'pessoa' && <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>Sem nenhum marcado, a pessoa volta a ver o painel do setor dela.</p>}
        <div className="mesa-catalogo">
          {catalogo.map((c) => (
            <label key={c.chave} className="check"><input type="checkbox" checked={marcados.includes(c.chave)} onChange={(e) => setEscolha({ ...escolha, [chave]: e.target.checked ? [...marcados, c.chave] : marcados.filter((k) => k !== c.chave) })} /> {c.rotulo}</label>
          ))}
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
        {salvar.isSuccess && <div className="aviso ok" style={{ marginTop: 8 }}>Painel salvo.</div>}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={salvar.isPending || marcados.length > 12 || !alvo} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : 'Salvar este painel'}</button>
          <button className="botao claro" onClick={fechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

/** Pede ao navegador a permissão de aviso, para a mensagem aparecer mesmo com a aba em segundo plano. */
function AtivarAvisos() {
  const suporta = typeof window !== 'undefined' && 'Notification' in window;
  const [estado, setEstado] = useState(() => (suporta ? Notification.permission : 'denied'));
  const [fechado, setFechado] = useState(() => { try { return localStorage.getItem('aritana.mesa.avisos') === 'nao'; } catch { return false; } });
  if (!suporta || estado !== 'default' || fechado) return null;
  return (
    <div className="aviso alerta flex entre" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
      <span>Quer ser avisado de mensagens e tarefas novas mesmo com o sistema em outra aba?</span>
      <span className="flex" style={{ gap: 6 }}>
        <button className="botao pequeno" onClick={() => void Notification.requestPermission().then(setEstado).catch(() => setEstado('denied'))}>Ativar avisos do navegador</button>
        <button className="botao claro pequeno" onClick={() => { setFechado(true); try { localStorage.setItem('aritana.mesa.avisos', 'nao'); } catch { /* sem armazenamento */ } }}>Agora não</button>
      </span>
    </div>
  );
}

interface MinhaAvaliacao { mes: string; nota: number | null; notaIndicadores: number | null; ajuste: number | null; percentualBonus: number | null; bonus: number | null; observacao: string | null; indicadores: { indicadorId: string; nome: string; perspectiva: string; unidade: 'numero' | 'reais' | 'percentual'; meta: number; sentido: string; peso: number; resultado: number | null; nota: number | null; comentario: string | null }[]; ocorrencias: { data: string; tipo: 'acerto' | 'erro'; pontos: number; descricao: string }[] }

/** As avaliações fechadas da própria pessoa no scorecard. */
function MeuScorecard() {
  const q = useQuery({ queryKey: ['scorecard', 'minhas'], queryFn: () => api<{ liberado: boolean; avaliacoes: MinhaAvaliacao[] }>('/scorecard/minhas'), retry: false });
  const [aberta, setAberta] = useState<MinhaAvaliacao | null>(null);
  const avs = q.data?.avaliacoes ?? [];
  if (!avs.length) return null;
  const mesTexto = nomeMes;
  return (
    <div className="mesa-painel">
      <b style={{ display: 'block', marginBottom: 8 }}>Meu scorecard</b>
      <div className="mesa-meu-sc">
        {avs.slice(0, 6).map((a) => (
          <button key={a.mes} type="button" className="cartao mesa-ind" style={{ textAlign: 'left', font: 'inherit', cursor: 'pointer' }} onClick={() => setAberta(a)}>
            <span className="rotulo">{mesTexto(a.mes)}</span>
            <span className="valor">{notaTexto(a.nota)}</span>
            <span className="rotulo">{a.bonus ? `Bônus ${reais(a.bonus)}` : 'Sem bônus'}</span>
          </button>
        ))}
      </div>
      {aberta && (
        <div className="modal-fundo" onClick={() => setAberta(null)}>
          <div className="cartao modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px' }}>{mesTexto(aberta.mes)}</h3>
            <p className="muted" style={{ marginTop: 0 }}>Nota {notaTexto(aberta.nota)} (indicadores {notaTexto(aberta.notaIndicadores)}, acertos e erros {aberta.ajuste && aberta.ajuste > 0 ? '+' : ''}{notaTexto(aberta.ajuste)}) · {aberta.bonus ? `bônus de ${reais(aberta.bonus)} (${aberta.percentualBonus}%)` : 'sem bônus'}</p>
            <table className="tabela">
              <thead><tr><th>Indicador</th><th className="num">Meta</th><th className="num">Resultado</th><th className="num">Nota</th></tr></thead>
              <tbody>{aberta.indicadores.map((i) => <tr key={i.indicadorId}><td><b>{i.nome}</b><span className="muted" style={{ display: 'block', fontSize: 12 }}>{PERSPECTIVAS[i.perspectiva] ?? i.perspectiva} · peso {i.peso}{i.comentario ? ` · ${i.comentario}` : ''}</span></td><td className="num">{valorDe(i.meta, i.unidade)}</td><td className="num">{valorDe(i.resultado, i.unidade)}</td><td className="num"><b>{notaTexto(i.nota)}</b></td></tr>)}</tbody>
            </table>
            {aberta.ocorrencias.length > 0 && <><div className="secao">Acertos e erros</div>{aberta.ocorrencias.map((o, k) => <div key={k} style={{ padding: '4px 0' }}><b style={{ color: o.tipo === 'acerto' ? '#2f7a46' : '#a23a2a' }}>{o.tipo === 'acerto' ? '+' : '−'}{notaTexto(o.pontos)}</b> <span className="muted">{dataBR(o.data)}</span> {o.descricao}</div>)}</>}
            {aberta.observacao && <><div className="secao">Observação</div><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{aberta.observacao}</p></>}
            <div className="flex" style={{ marginTop: 12 }}><button className="botao claro" onClick={() => setAberta(null)}>Fechar</button></div>
          </div>
        </div>
      )}
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
  const [anexo, setAnexo] = useState<{ nome: string; mime: string; base64: string; tamanho: number } | null>(null);
  const [erroAnexo, setErroAnexo] = useState<string | null>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  const fim = useRef<HTMLDivElement>(null);
  const escolher = (f: File | undefined) => {
    setErroAnexo(null);
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return setErroAnexo('O arquivo pode ter no máximo 10 MB.');
    const leitor = new FileReader();
    leitor.onload = () => setAnexo({ nome: f.name, mime: f.type || 'application/octet-stream', base64: String(leitor.result), tamanho: f.size });
    leitor.onerror = () => setErroAnexo('Não deu para ler o arquivo.');
    leitor.readAsDataURL(f);
  };
  const q = useQuery({ queryKey: ['mesa', 'mensagens', conversaId], queryFn: () => api<{ mensagens: Mensagem[] }>(`/mesa/conversas/${conversaId}/mensagens`), refetchInterval: 4_000 });
  const enviar = useMutation({
    mutationFn: (t: string) => api<Mensagem>(`/mesa/conversas/${conversaId}/mensagens`, { corpo: { texto: t, ...(anexo ? { anexo: { nome: anexo.nome, mime: anexo.mime, base64: anexo.base64 } } : {}) } }),
    onSuccess: (m) => { setTexto(''); setAnexo(null); qc.setQueryData<{ mensagens: Mensagem[] }>(['mesa', 'mensagens', conversaId], (a) => ({ mensagens: [...(a?.mensagens ?? []), m] })); qc.invalidateQueries({ queryKey: ['mesa', 'conversas'] }); },
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
            {m.anexoNome && <AnexoDaMesa mensagemId={m.id} nome={m.anexoNome} mime={m.anexoMime ?? ''} tamanho={m.anexoTamanho ?? 0} />}
            {m.texto && <span className="texto">{m.texto}</span>}
            <span className="hora">{dataHora(m.criadoEm)}</span>
          </div>
        ))}
        <div ref={fim} />
      </div>
      {anexo && <div className="mesa-anexo-pronto"><span>📎 {anexo.nome} <span className="muted">({tamanhoLegivel(anexo.tamanho)})</span></span><button type="button" className="botao claro pequeno" onClick={() => setAnexo(null)}>Tirar</button></div>}
      <form className="mesa-escrever" onSubmit={(e) => { e.preventDefault(); if ((texto.trim() || anexo) && !enviar.isPending) enviar.mutate(texto); }}>
        <input ref={arquivo} type="file" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,audio/*,video/*" onChange={(e) => { escolher(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" className="botao claro" title="Anexar arquivo (até 10 MB)" aria-label="Anexar arquivo" onClick={() => arquivo.current?.click()}>📎</button>
        <textarea rows={1} maxLength={4000} placeholder="Escreva para a equipe…" value={texto} onChange={(e) => setTexto(e.target.value)} onPaste={(e) => { const f = [...e.clipboardData.files][0]; if (f) { e.preventDefault(); escolher(f); } }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if ((texto.trim() || anexo) && !enviar.isPending) enviar.mutate(texto); } }} />
        <button className="botao" disabled={(!texto.trim() && !anexo) || enviar.isPending}>{enviar.isPending && anexo ? 'Enviando…' : 'Enviar'}</button>
      </form>
      {(enviar.error || erroAnexo) && <div style={{ padding: '0 12px 8px' }}>{erroAnexo ? <div className="aviso erro">{erroAnexo}</div> : <Erro erro={enviar.error} />}</div>}
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

const tamanhoLegivel = (b: number) => (b > 1_000_000 ? `${(b / 1_000_000).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);
const BASE_API = import.meta.env.VITE_API_URL ?? '/api';

/** Anexo da conversa interna: só sai com login (e só para quem participa). Foto aparece na conversa. */
function AnexoDaMesa({ mensagemId, nome, mime, tamanho }: { mensagemId: string; nome: string; mime: string; tamanho: number }) {
  const imagem = mime.startsWith('image/');
  const [url, setUrl] = useState<string | null>(null);
  const baixar = () => fetch(`${BASE_API}/mesa/anexos/${mensagemId}`, { headers: { authorization: `Bearer ${lerSessao()?.token ?? ''}` } }).then((r) => (r.ok ? r.blob() : null));
  useEffect(() => {
    if (!imagem) return;
    let solto: string | null = null;
    baixar().then((b) => { if (b) setUrl((solto = URL.createObjectURL(b))); }).catch(() => undefined);
    return () => { if (solto) URL.revokeObjectURL(solto); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mensagemId, imagem]);
  const abrir = async () => {
    const b = await baixar().catch(() => null);
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    if (b.type === 'application/octet-stream') a.download = nome; else a.target = '_blank';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };
  if (imagem && url) return <img className="mesa-foto" src={url} alt={nome} title={nome} onClick={() => window.open(url, '_blank')} />;
  return <button type="button" className="mesa-arquivo" onClick={() => void abrir()}>📎 {nome} <span className="muted">· {tamanhoLegivel(tamanho)}</span></button>;
}
