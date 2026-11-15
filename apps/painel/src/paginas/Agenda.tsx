import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, pode } from '../api';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';
import './agenda.css';

export interface Compromisso {
  id: string; tipo: string; titulo: string; inicio: string; fim: string; online: boolean; local: string | null; link: string | null; googleEventoId: string | null;
  responsavelId: string | null; responsavel: string | null; pessoaId: string | null; leadId: string | null; maletaId: string | null; quem: string | null;
  convidadoTelefone: string | null; observacao: string | null; status: 'marcado' | 'confirmado' | 'realizado' | 'faltou' | 'cancelado'; avisar: boolean; confirmadoEm: string | null;
}
interface Tipos { tipos: Record<string, { nome: string; duracao: number; online: boolean }>; google: { configurado: boolean; conectado: boolean; conta: string | null; retorno: string } }

const FUSO = 'America/Sao_Paulo';
const hora = (d: string) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: FUSO });
const diaChave = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: FUSO });
const STATUS: Record<Compromisso['status'], [string, string]> = { marcado: ['Marcado', ''], confirmado: ['Confirmado', 'ok'], realizado: ['Realizado', 'ok'], faltou: ['Não compareceu', 'erro'], cancelado: ['Cancelado', 'erro'] };
const COR_TIPO: Record<string, string> = { entrevista: '#8a6a3b', acerto_video: '#2f6f5e', retirada: '#5b4a8a', reuniao: '#3a5f8a', outro: '#7a7166' };
export const usarTipos = () => useQuery({ queryKey: ['agenda', 'tipos'], queryFn: () => api<Tipos>('/agenda/tipos'), staleTime: 60_000 });

/** Meio-dia (UTC) do dia de Brasília: base estável para somar dias e rotular. */
function diaBase(d: Date) {
  return new Date(`${diaChave(d)}T12:00:00Z`);
}

export function Agenda() {
  const [params, setParams] = useSearchParams();
  // Mostra 7 dias a partir de hoje (ou do dia escolhido): domingo à noite ainda vê a semana que vem.
  const [semana, setSemana] = useState(() => diaBase(new Date()));
  const [resp, setResp] = useState('');
  const [aberto, setAberto] = useState<Compromisso | null>(null);
  const [novo, setNovo] = useState<Partial<DadosForm> | null>(null);
  const tipos = usarTipos();
  const fimSemana = new Date(semana.getTime() + 7 * 86_400_000);
  const q = useQuery({
    queryKey: ['agenda', semana.toISOString(), resp],
    queryFn: () => api<Compromisso[]>(`/agenda?de=${new Date(`${semana.toISOString().slice(0, 10)}T00:00:00-03:00`).toISOString()}&ate=${new Date(`${fimSemana.toISOString().slice(0, 10)}T00:00:00-03:00`).toISOString()}${resp ? `&responsavelId=${resp}` : ''}`),
    refetchInterval: 60_000,
  });
  const atendentes = useQuery({ queryKey: ['crm', 'atendentes'], queryFn: () => api<{ id: string; nome: string }[]>('/crm/atendentes'), staleTime: 60_000 });
  const retornoGoogle = params.get('google');
  const dias = Array.from({ length: 7 }, (_, i) => new Date(semana.getTime() + i * 86_400_000));
  const porDia = useMemo(() => {
    const m = new Map<string, Compromisso[]>();
    for (const c of q.data ?? []) {
      const k = diaChave(new Date(c.inicio));
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [q.data]);
  const hoje = diaChave(new Date());
  const rotuloSemana = `${dias[0].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' })} a ${dias[6].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;

  return (
    <>
      <Topo eb="Agenda" titulo="Compromissos" sub="Entrevistas, acertos por vídeo, retiradas de maleta e reuniões, com lembrete pelo WhatsApp." acoes={pode('agenda', 'criar') && <button className="botao" onClick={() => setNovo({})}>+ Novo compromisso</button>} />
      {retornoGoogle && (
        <div className={`aviso ${retornoGoogle === 'ok' ? 'ok' : 'erro'}`} style={{ marginBottom: 12 }}>
          {retornoGoogle === 'ok' ? 'Conta Google conectada: os compromissos online já saem com link do Meet.' : retornoGoogle === 'negado' ? 'A autorização foi negada no Google. Tente de novo e clique em "Permitir".' : 'Não deu para conectar o Google. Confira o Client ID, o Client secret e o endereço de retorno, e tente de novo.'}
          <button className="botao claro pequeno" style={{ marginLeft: 10 }} onClick={() => setParams({})}>Ok</button>
        </div>
      )}
      <ContaGoogle />
      {novo && <FormCompromisso inicial={novo} fechar={() => setNovo(null)} />}

      <div className="ag-barra">
        <button className="botao claro pequeno" onClick={() => setSemana(new Date(semana.getTime() - 7 * 86_400_000))}>‹ 7 dias antes</button>
        <button className="botao claro pequeno" onClick={() => setSemana(diaBase(new Date()))}>Hoje</button>
        <button className="botao claro pequeno" onClick={() => setSemana(new Date(semana.getTime() + 7 * 86_400_000))}>7 dias depois ›</button>
        <b className="ag-rotulo">{rotuloSemana}</b>
        <select value={resp} onChange={(e) => setResp(e.target.value)} className="ag-filtro"><option value="">Todos os responsáveis</option>{atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}</select>
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <div className="ag-semana">
          {dias.map((d) => {
            const k = d.toISOString().slice(0, 10);
            const lista = porDia.get(k) ?? [];
            return (
              <div key={k} className={`ag-dia ${k === hoje ? 'hoje' : ''} ${k < hoje ? 'passado' : ''}`}>
                <div className="ag-dia-topo">
                  <span>{d.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '')}</span>
                  <b>{d.toLocaleDateString('pt-BR', { day: '2-digit', timeZone: 'UTC' })}</b>
                  {pode('agenda', 'criar') && k >= hoje && <button className="ag-mais" title="Marcar neste dia" onClick={() => setNovo({ data: k })}>+</button>}
                </div>
                {lista.map((c) => (
                  <button key={c.id} className={`ag-item s-${c.status}`} style={{ borderLeftColor: COR_TIPO[c.tipo] ?? '#7a7166' }} onClick={() => setAberto(c)}>
                    <span className="ag-hora">{hora(c.inicio)}{c.online ? ' · online' : ''}</span>
                    <span className="ag-titulo">{c.titulo}</span>
                    {c.responsavel && !resp && <span className="ag-quem">{c.responsavel}</span>}
                    {c.status === 'confirmado' && <span className="ag-ok">✓ confirmado</span>}
                  </button>
                ))}
                {!lista.length && <div className="ag-vazio">—</div>}
              </div>
            );
          })}
        </div>
      )}
      {aberto && <Detalhe c={aberto} tipos={tipos.data} fechar={() => setAberto(null)} />}
    </>
  );
}

function ContaGoogle() {
  const qc = useQueryClient();
  const t = usarTipos();
  const gestor = pode('configuracoes', 'editar');
  const conectar = useMutation({ mutationFn: () => api<{ url: string }>('/agenda/google/conectar'), onSuccess: (r) => { window.location.href = r.url; } });
  const sair = useMutation({ mutationFn: () => api('/agenda/google/desconectar', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['agenda', 'tipos'] }) });
  const [copiado, setCopiado] = useState(false);
  if (!t.data) return null;
  const g = t.data.google;
  if (g.conectado) {
    return (
      <div className="ag-google ok">
        <span>📅 Google Agenda conectada{g.conta ? <> como <b>{g.conta}</b></> : ''}: compromissos online saem com link do Meet.</span>
        {gestor && <button className="botao claro pequeno" disabled={sair.isPending} onClick={() => window.confirm('Desconectar a conta Google? Os próximos compromissos online ficam sem link automático.') && sair.mutate()}>Desconectar</button>}
      </div>
    );
  }
  if (!gestor) return <div className="ag-google">Os links do Meet são gerados quando um administrador conectar a conta Google da Aritana. Até lá, cole um link no compromisso.</div>;
  return (
    <div className="ag-google">
      <div>
        <b>Conecte a conta Google da Aritana</b> para os compromissos online irem para o Google Agenda com link do Meet.
        {!g.configurado ? (
          <> Primeiro preencha o Client ID e o Client secret em <Link to="/configuracoes?aba=integracoes">Configurações › Integrações › Google</Link>.</>
        ) : null}
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          No Google Cloud, em "URIs de redirecionamento autorizados", use: <code>{g.retorno}</code>{' '}
          <button className="botao claro pequeno" onClick={() => { void navigator.clipboard.writeText(g.retorno); setCopiado(true); }}>{copiado ? 'Copiado' : 'Copiar'}</button>
        </div>
      </div>
      {g.configurado && <button className="botao pequeno" disabled={conectar.isPending} onClick={() => conectar.mutate()}>Conectar conta Google</button>}
      {conectar.error && <Erro erro={conectar.error} />}
    </div>
  );
}

function Detalhe({ c, tipos, fechar }: { c: Compromisso; tipos?: Tipos; fechar: () => void }) {
  const qc = useQueryClient();
  const [remarcar, setRemarcar] = useState(false);
  const [quando, setQuando] = useState(() => ({ data: diaChave(new Date(c.inicio)), hora: hora(c.inicio) }));
  const acao = useMutation({
    mutationFn: (corpo: { status: string; motivo?: string | null }) => api(`/agenda/${c.id}/situacao`, { corpo }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agenda'] }); fechar(); },
  });
  const mover = useMutation({
    mutationFn: (forcar: boolean) => api<any>(`/agenda/${c.id}`, { metodo: 'PATCH', corpo: { inicio: new Date(`${quando.data}T${quando.hora}:00-03:00`).toISOString(), forcar } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agenda'] }); fechar(); },
  });
  const editar = pode('agenda', 'editar');
  const passou = new Date(c.inicio).getTime() < Date.now();
  const aberto = c.status === 'marcado' || c.status === 'confirmado';
  const conflito = mover.error && /Bate com/.test((mover.error as Error).message);
  return (
    <div className="ag-fundo" onClick={fechar}>
      <div className="ag-painel cartao" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={c.titulo}>
        <div className="flex entre" style={{ alignItems: 'flex-start', gap: 10 }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>{tipos?.tipos[c.tipo]?.nome ?? c.tipo}</div>
            <h3 style={{ margin: '2px 0 6px' }}>{c.titulo}</h3>
          </div>
          <button className="botao claro pequeno" onClick={fechar} aria-label="Fechar">×</button>
        </div>
        <div className="par"><span>Quando</span><span>{new Date(c.inicio).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: FUSO })}, {hora(c.inicio)}–{hora(c.fim)}</span></div>
        <div className="par"><span>Situação</span><span><span className={`etiqueta ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></span></div>
        {c.quem && <div className="par"><span>Com</span><span>{c.pessoaId ? <Link to={`/rede/${c.pessoaId}`}>{c.quem}</Link> : c.leadId ? <Link to={`/crm/lead/${c.leadId}`}>{c.quem}</Link> : c.quem}</span></div>}
        {c.responsavel && <div className="par"><span>Responsável</span><span>{c.responsavel}</span></div>}
        {c.online ? <div className="par"><span>Chamada</span><span>{c.link ? <a href={c.link} target="_blank" rel="noreferrer">Entrar na chamada</a> : <span className="muted">sem link</span>}</span></div> : c.local && <div className="par"><span>Local</span><span>{c.local}</span></div>}
        {c.maletaId && <div className="par"><span>Maleta</span><span><Link to={`/maletas/${c.maletaId}`}>Abrir maleta</Link></span></div>}
        {c.observacao && <p className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{c.observacao}</p>}
        {!c.avisar && <p className="muted" style={{ fontSize: 12 }}>Sem lembrete pelo WhatsApp.</p>}

        {editar && aberto && (
          <>
            {remarcar ? (
              <div className="form" style={{ marginTop: 10 }}>
                <Campo rotulo="Novo dia"><input type="date" value={quando.data} onChange={(e) => setQuando({ ...quando, data: e.target.value })} /></Campo>
                <Campo rotulo="Hora"><input type="time" value={quando.hora} onChange={(e) => setQuando({ ...quando, hora: e.target.value })} /></Campo>
                <div className="l4 flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="botao pequeno" disabled={mover.isPending} onClick={() => mover.mutate(false)}>Remarcar e avisar</button>
                  {conflito && <button className="botao claro pequeno" onClick={() => mover.mutate(true)}>Remarcar mesmo assim</button>}
                  <button className="botao claro pequeno" onClick={() => setRemarcar(false)}>Voltar</button>
                </div>
              </div>
            ) : (
              <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                {passou ? (
                  <>
                    <button className="botao pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ status: 'realizado' })}>Realizado</button>
                    <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ status: 'faltou' })}>Não compareceu</button>
                  </>
                ) : (
                  c.status === 'marcado' && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ status: 'confirmado' })}>Confirmado</button>
                )}
                <button className="botao claro pequeno" onClick={() => setRemarcar(true)}>Remarcar</button>
                <button className="botao claro pequeno perigo" disabled={acao.isPending} onClick={() => { const m = window.prompt('Cancelar este compromisso? Motivo (opcional):'); if (m !== null) acao.mutate({ status: 'cancelado', motivo: m || null }); }}>Cancelar</button>
              </div>
            )}
          </>
        )}
        {(acao.error || (mover.error && !conflito)) && <Erro erro={acao.error ?? mover.error} />}
        {conflito && remarcar && <div className="aviso alerta" style={{ marginTop: 8 }}>{(mover.error as Error).message}</div>}
      </div>
    </div>
  );
}

// ───── Formulário (usado aqui, no card do CRM e na ficha da revendedora) ─────

export interface DadosForm {
  tipo: string; titulo: string; data: string; hora: string; duracaoMin: number; online: boolean; local: string; link: string; responsavelId: string;
  pessoaId: string | null; pessoaNome: string | null; leadId: string | null; maletaId: string | null; convidadoNome: string; convidadoTelefone: string; observacao: string; avisar: boolean;
}

export function FormCompromisso({ inicial, fechar, aoSalvar }: { inicial: Partial<DadosForm>; fechar: () => void; aoSalvar?: () => void }) {
  const qc = useQueryClient();
  const tipos = usarTipos();
  const atendentes = useQuery({ queryKey: ['crm', 'atendentes'], queryFn: () => api<{ id: string; nome: string }[]>('/crm/atendentes'), staleTime: 60_000 });
  const amanha = diaChave(new Date(Date.now() + 86_400_000));
  const [f, setF] = useState<DadosForm>(() => ({ tipo: 'entrevista', titulo: '', data: amanha, hora: '10:00', duracaoMin: 30, online: true, local: '', link: '', responsavelId: '', pessoaId: null, pessoaNome: null, leadId: null, maletaId: null, convidadoNome: '', convidadoTelefone: '', observacao: '', avisar: true, ...inicial }));
  const [busca, setBusca] = useState('');
  const reps = useQuery({ queryKey: ['agenda', 'reps', busca], queryFn: () => api<{ itens: { id: string; nome: string; cidade: string | null }[] }>(`/pessoas?tipo=representante&busca=${encodeURIComponent(busca)}`), enabled: busca.trim().length >= 2 && !f.pessoaId });
  // Ao trocar o tipo, sugere a duração e se é online.
  const mudarTipo = (tipo: string) => {
    const t = tipos.data?.tipos[tipo];
    setF({ ...f, tipo, ...(t ? { duracaoMin: t.duracao, online: t.online } : {}) });
  };
  useEffect(() => {
    if (inicial.tipo && tipos.data && !inicial.duracaoMin) {
      const t = tipos.data.tipos[inicial.tipo];
      if (t) setF((x) => ({ ...x, duracaoMin: t.duracao, online: t.online }));
    }
  }, [tipos.data, inicial.tipo, inicial.duracaoMin]);
  const salvar = useMutation({
    mutationFn: (forcar: boolean) =>
      api<{ avisos: string[] }>('/agenda', {
        corpo: {
          tipo: f.tipo, titulo: f.titulo || null, inicio: new Date(`${f.data}T${f.hora}:00-03:00`).toISOString(), duracaoMin: Number(f.duracaoMin) || 30, online: f.online,
          local: f.online ? null : f.local || null, link: f.online ? f.link || null : null, responsavelId: f.responsavelId || null, pessoaId: f.pessoaId, leadId: f.leadId, maletaId: f.maletaId,
          convidadoNome: !f.pessoaId && !f.leadId ? f.convidadoNome || null : null, convidadoTelefone: !f.pessoaId && !f.leadId ? f.convidadoTelefone || null : null, observacao: f.observacao || null, avisar: f.avisar, forcar,
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['agenda'] });
      qc.invalidateQueries({ queryKey: ['crm', 'lead'] });
      if (r.avisos?.length) window.alert(r.avisos.join('\n'));
      aoSalvar?.();
      fechar();
    },
  });
  const conflito = salvar.error && /Bate com/.test((salvar.error as Error).message);
  const g = tipos.data?.google;
  return (
    <div className="cartao form ag-form">
      <div className="secao l4" style={{ marginTop: 0 }}>Novo compromisso</div>
      <Campo rotulo="Tipo"><select value={f.tipo} onChange={(e) => mudarTipo(e.target.value)}>{Object.entries(tipos.data?.tipos ?? {}).map(([k, t]) => <option key={k} value={k}>{t.nome}</option>)}</select></Campo>
      <Campo rotulo="Título (opcional)" ajuda="Vazio: tipo + nome de quem vem."><input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} /></Campo>
      <Campo rotulo="Dia"><input type="date" value={f.data} min={diaChave(new Date())} onChange={(e) => setF({ ...f, data: e.target.value })} /></Campo>
      <div className="flex" style={{ gap: 8 }}>
        <Campo rotulo="Hora"><input type="time" value={f.hora} onChange={(e) => setF({ ...f, hora: e.target.value })} /></Campo>
        <Campo rotulo="Duração (min)"><input inputMode="numeric" value={f.duracaoMin} onChange={(e) => setF({ ...f, duracaoMin: Number(e.target.value.replace(/\D/g, '')) || 0 })} style={{ width: 80 }} /></Campo>
      </div>

      <Campo rotulo="Com quem" className="l2">
        {f.pessoaId || f.leadId ? (
          <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
            <b>{f.pessoaNome ?? 'Contato do card'}</b>
            {!inicial.pessoaId && !inicial.leadId && <button className="botao claro pequeno" onClick={() => setF({ ...f, pessoaId: null, pessoaNome: null })}>Trocar</button>}
          </div>
        ) : (
          <>
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar revendedora pelo nome ou CPF…" />
            {reps.data?.itens.slice(0, 6).map((p) => <button key={p.id} className="ag-opcao" onClick={() => { setF({ ...f, pessoaId: p.id, pessoaNome: p.nome }); setBusca(''); }}>{p.nome}{p.cidade ? <span className="muted"> · {p.cidade}</span> : null}</button>)}
          </>
        )}
      </Campo>
      {!f.pessoaId && !f.leadId && (
        <>
          <Campo rotulo="Ou: nome de quem vem"><input value={f.convidadoNome} onChange={(e) => setF({ ...f, convidadoNome: e.target.value })} placeholder="Candidata, cliente…" /></Campo>
          <Campo rotulo="WhatsApp dela" ajuda="Para o lembrete."><input inputMode="tel" value={f.convidadoTelefone} onChange={(e) => setF({ ...f, convidadoTelefone: e.target.value })} placeholder="(27) 99999-0000" /></Campo>
        </>
      )}
      <Campo rotulo="Responsável" className="l2"><select value={f.responsavelId} onChange={(e) => setF({ ...f, responsavelId: e.target.value })}><option value="">Eu</option>{atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}</select></Campo>

      <div className="l4 flex" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label className="check"><input type="radio" checked={f.online} onChange={() => setF({ ...f, online: true })} /> Online (vídeo)</label>
        <label className="check"><input type="radio" checked={!f.online} onChange={() => setF({ ...f, online: false })} /> Presencial</label>
      </div>
      {f.online ? (
        <Campo rotulo="Link da chamada" className="l4" ajuda={g?.conectado ? 'Vazio: o sistema cria um Meet no Google da Aritana.' : 'Com a conta Google conectada, o Meet é criado sozinho. Até lá, cole um link (Meet, Zoom…).'}>
          <input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder={g?.conectado ? 'Gerado automaticamente' : 'https://meet.google.com/…'} />
        </Campo>
      ) : (
        <Campo rotulo="Local" className="l4"><input value={f.local} onChange={(e) => setF({ ...f, local: e.target.value })} placeholder="Matriz, loja, endereço…" /></Campo>
      )}
      <Campo rotulo="Observação" className="l4"><input value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} /></Campo>
      <label className="check l4"><input type="checkbox" checked={f.avisar} onChange={(e) => setF({ ...f, avisar: e.target.checked })} /> Avisar pelo WhatsApp agora, na véspera e uma hora antes</label>

      {salvar.error && (conflito ? <div className="l4 aviso alerta">{(salvar.error as Error).message}</div> : <div className="l4"><Erro erro={salvar.error} /></div>)}
      <div className="l4 flex" style={{ gap: 8 }}>
        <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate(false)}>Marcar</button>
        {conflito && <button className="botao claro" disabled={salvar.isPending} onClick={() => salvar.mutate(true)}>Marcar mesmo assim</button>}
        <button className="botao claro" onClick={fechar}>Cancelar</button>
      </div>
    </div>
  );
}
