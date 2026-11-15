import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, pode } from '../../api';
import { reais } from '../../formato';
import { Campo, Carregando, Erro } from '../../componentes/ui';
import { ha, iniciais, telefoneBonito, usarAtendentes, usarCampos, usarFunis, useRelogio, valorLegivel, type Etapa, type Funil as TFunil } from './comum';

interface Card { id: string; numero: number; titulo: string; valor: number; funilId: string; etapaId: string; status: string; etiquetas: string[]; responsavelId: string | null; responsavel: string | null; contato: string; telefone: string; entrouNaEtapaEm: string; naoLidas: number; tarefas: number; tarefaVencida: boolean; camposExtras?: Record<string, string>; contatoExtras?: Record<string, string>; distribuicao?: string | null; consultora?: string | null }

const CHAVE_FUNIL = 'aritana.crm.funil';

/** Quadro do funil, com arrastar e soltar entre etapas. */
export function Funil() {
  const qc = useQueryClient();
  const navegar = useNavigate();
  useRelogio(60);
  const funis = usarFunis();
  const camposDefs = usarCampos();
  const atendentes = usarAtendentes();
  const [funilId, setFunilId] = useState(() => {
    try {
      return localStorage.getItem(CHAVE_FUNIL) ?? '';
    } catch {
      return '';
    }
  });
  const [busca, setBusca] = useState('');
  const [resp, setResp] = useState('');
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [sobre, setSobre] = useState<string | null>(null);
  const [novo, setNovo] = useState<string | null>(null);
  const [perda, setPerda] = useState<{ card: Card; etapa: Etapa } | null>(null);
  const [aprovar, setAprovar] = useState<Card | null>(null);
  const funil: TFunil | undefined = funis.data?.find((f) => f.id === funilId) ?? funis.data?.[0];
  /** Campos marcados para aparecer no quadro deste funil. */
  const noQuadro = (camposDefs.data ?? []).filter((c) => c.noQuadro && (c.entidade === 'contato' || !c.funilId || c.funilId === funil?.id));
  useEffect(() => {
    if (funil) {
      try {
        localStorage.setItem(CHAVE_FUNIL, funil.id);
      } catch {
        /* sem armazenamento */
      }
    }
  }, [funil]);
  const filtro = `funilId=${funil?.id ?? ''}${busca.trim() ? `&busca=${encodeURIComponent(busca.trim())}` : ''}${resp ? `&responsavelId=${resp}` : ''}`;
  const cards = useQuery({ queryKey: ['crm', 'leads', filtro], queryFn: () => api<Card[]>(`/crm/leads?${filtro}`), enabled: !!funil, refetchInterval: 20_000 });
  const mover = useMutation({
    mutationFn: ({ id, etapaId, motivoPerda }: { id: string; etapaId: string; motivoPerda?: string }) => api(`/crm/leads/${id}`, { metodo: 'PATCH', corpo: { etapaId, motivoPerda } }),
    onMutate: async ({ id, etapaId }) => {
      // Move na tela na hora; se o servidor recusar, volta.
      await qc.cancelQueries({ queryKey: ['crm', 'leads', filtro] });
      const antes = qc.getQueryData<Card[]>(['crm', 'leads', filtro]);
      qc.setQueryData<Card[]>(['crm', 'leads', filtro], (l) => l?.map((c) => (c.id === id ? { ...c, etapaId, entrouNaEtapaEm: new Date().toISOString() } : c)));
      return { antes };
    },
    onError: (_e, _v, ctx) => ctx?.antes && qc.setQueryData(['crm', 'leads', filtro], ctx.antes),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['crm', 'leads'] });
      qc.invalidateQueries({ queryKey: ['crm', 'funis'] });
    },
  });

  const porEtapa = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const c of cards.data ?? []) m.set(c.etapaId, [...(m.get(c.etapaId) ?? []), c]);
    return m;
  }, [cards.data]);

  if (funis.isLoading) return <Carregando />;
  if (funis.error) return <Erro erro={funis.error} />;
  if (!funil) return <div className="cartao vazio">Nenhum funil ativo. Crie um em Configurar.</div>;

  const soltar = (etapa: Etapa) => {
    const card = cards.data?.find((c) => c.id === arrastando);
    setArrastando(null);
    setSobre(null);
    if (!card || card.etapaId === etapa.id) return;
    if (etapa.chave === 'aprovada' && funil.tipo === 'recrutamento') return setAprovar(card);
    if (etapa.tipo === 'perdido') return setPerda({ card, etapa });
    mover.mutate({ id: card.id, etapaId: etapa.id });
  };

  return (
    <div>
      <div className="crm-barra">
        <div className="crm-chips">
          {funis.data!.map((f) => <button key={f.id} className={`crm-chip ${f.id === funil.id ? 'ativo' : ''}`} onClick={() => setFunilId(f.id)}>{f.nome}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        <input placeholder="Buscar nome, telefone…" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ minWidth: 220 }} />
        <select value={resp} onChange={(e) => setResp(e.target.value)}>
          <option value="">Todos os responsáveis</option>
          <option value="eu">Meus cards</option>
          <option value="ninguem">Sem responsável</option>
          {atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
        </select>
      </div>
      {(mover.error || cards.error) && <Erro erro={mover.error ?? cards.error} />}
      <div className="kanban">
        {funil.etapas.map((e) => {
          const lista = porEtapa.get(e.id) ?? [];
          const soma = lista.reduce((a, c) => a + c.valor, 0);
          return (
            <div
              key={e.id}
              className={`kanban-col ${sobre === e.id ? 'alvo' : ''}`}
              style={{ ['--cor' as string]: e.cor }}
              onDragOver={(ev) => {
                ev.preventDefault();
                if (sobre !== e.id) setSobre(e.id);
              }}
              onDragLeave={() => setSobre((s) => (s === e.id ? null : s))}
              onDrop={() => soltar(e)}
            >
              <div className="kanban-cab">
                <div className="flex entre">
                  <b>{e.nome}</b>
                  {pode('crm', 'criar') && e.tipo === 'aberta' && <button className="botao claro pequeno" title="Novo card nesta etapa" onClick={() => setNovo(e.id)}>+</button>}
                </div>
                <div className="muted">{lista.length} card(s){soma ? ` · ${reais(soma)}` : ''}</div>
              </div>
              <div className="kanban-lista">
                {lista.map((c, i) => (
                  <div
                    key={c.id}
                    className={`kcard ${arrastando === c.id ? 'arrastando' : ''}`}
                    style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
                    draggable={pode('crm', 'editar')}
                    onDragStart={(ev) => {
                      ev.dataTransfer.effectAllowed = 'move';
                      setArrastando(c.id);
                    }}
                    onDragEnd={() => {
                      setArrastando(null);
                      setSobre(null);
                    }}
                    onClick={() => navegar(`/crm/lead/${c.id}`)}
                  >
                    <div className="flex entre" style={{ alignItems: 'flex-start', gap: 6 }}>
                      <div className="titulo">{c.titulo}</div>
                      {c.naoLidas > 0 && <span className="bolha-n" title="Mensagens não lidas">{c.naoLidas}</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>{c.contato !== c.titulo ? `${c.contato} · ` : ''}{telefoneBonito(c.telefone)}</div>
                    {noQuadro.length > 0 && (() => {
                      const vals = noQuadro.map((d) => [d.nome, valorLegivel(d, (d.entidade === 'lead' ? c.camposExtras : c.contatoExtras)?.[d.nome])] as const).filter(([, v]) => v);
                      return vals.length > 0 && <div className="kcampos">{vals.map(([n, v]) => <span key={n}>{n}: <b>{v}</b></span>)}</div>;
                    })()}
                    {c.consultora && <div className="kc-consultora" title={c.distribuicao === 'aguardando' ? 'Esperando ela aceitar' : 'Com a consultora'}>{c.distribuicao === 'aguardando' ? '⏳' : '📍'} {c.consultora}</div>}
                    {c.etiquetas.length > 0 && <div className="tags">{c.etiquetas.slice(0, 4).map((t) => <span key={t} className="tag">{t}</span>)}</div>}
                    <div className="linha2">
                      <span>{c.valor ? <b style={{ color: 'var(--tinta)' }}>{reais(c.valor)}</b> : null} {c.tarefas > 0 && <span title="Tarefas abertas" style={{ color: c.tarefaVencida ? 'var(--erro)' : undefined }}>☑ {c.tarefas}</span>}</span>
                      <span className="flex" style={{ gap: 6 }}>
                        <span title="Tempo nesta etapa">{ha(c.entrouNaEtapaEm)}</span>
                        {c.responsavel ? <span className="avatar" title={c.responsavel}>{iniciais(c.responsavel)}</span> : <span className="avatar" style={{ background: '#c9bba5' }} title="Sem responsável">?</span>}
                      </span>
                    </div>
                  </div>
                ))}
                {!lista.length && <div className="muted" style={{ fontSize: 13, textAlign: 'center', padding: '14px 0' }}>Arraste cards para cá</div>}
              </div>
            </div>
          );
        })}
      </div>
      {novo && <NovoCard funil={funil} etapaId={novo} fechar={() => setNovo(null)} />}
      {perda && (
        <Motivo
          titulo={`Mover "${perda.card.titulo}" para ${perda.etapa.nome}`}
          fechar={() => setPerda(null)}
          confirmar={(motivo) => {
            mover.mutate({ id: perda.card.id, etapaId: perda.etapa.id, motivoPerda: motivo });
            setPerda(null);
          }}
        />
      )}
      {aprovar && <Aprovar leadId={aprovar.id} nome={aprovar.titulo} fechar={() => setAprovar(null)} />}
    </div>
  );
}

export function Motivo({ titulo, confirmar, fechar }: { titulo: string; confirmar: (m: string) => void; fechar: () => void }) {
  const [m, setM] = useState('');
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <h3 style={{ marginTop: 0 }}>{titulo}</h3>
        <Campo rotulo="Motivo"><input autoFocus value={m} onChange={(e) => setM(e.target.value)} placeholder="Ex.: achou caro, sem interesse agora…" onKeyDown={(e) => e.key === 'Enter' && m.trim() && confirmar(m.trim())} /></Campo>
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={!m.trim()} onClick={() => confirmar(m.trim())}>Confirmar</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

/** Aprovar candidata do recrutamento: cria a revendedora e move o card. */
export function Aprovar({ leadId, nome, fechar }: { leadId: string; nome: string; fechar: () => void }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [modelo, setModelo] = useState('consignado');
  const lead = useQuery({ queryKey: ['crm', 'lead', leadId], queryFn: () => api<any>(`/crm/leads/${leadId}`) });
  const m = useMutation({
    mutationFn: () => api<{ pessoaId: string }>(`/crm/candidaturas/${lead.data.candidaturaId}/aprovar`, { corpo: { modeloTrabalho: modelo } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      fechar();
      navegar(`/rede/${r.pessoaId}`);
    },
  });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 style={{ marginTop: 0 }}>Aprovar {nome}</h3>
        {lead.data && !lead.data.candidaturaId ? (
          <p className="muted">Este card não veio do formulário de candidatas. Cadastre a revendedora em Rede › Nova revendedora.</p>
        ) : (
          <>
            <p className="muted">Cria a revendedora com o limite inicial das regras e leva você para a ficha dela.</p>
            <Campo rotulo="Modelo de trabalho">
              <select value={modelo} onChange={(e) => setModelo(e.target.value)}><option value="consignado">Consignado (maleta)</option><option value="revenda">Revenda</option><option value="afiliado">Afiliada</option></select>
            </Campo>
          </>
        )}
        {m.error && <Erro erro={m.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          {lead.data?.candidaturaId && <button className="botao" disabled={m.isPending} onClick={() => m.mutate()}>Aprovar e criar revendedora</button>}
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

export function NovoCard({ funil, etapaId, fechar }: { funil: TFunil; etapaId?: string; fechar: () => void }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [f, setF] = useState({ nome: '', telefone: '', email: '', titulo: '', valor: '' });
  const m = useMutation({
    mutationFn: () => api<{ id: string }>('/crm/leads', { corpo: { funilId: funil.id, etapaId: etapaId ?? null, nome: f.nome, telefone: f.telefone, email: f.email || null, titulo: f.titulo || null, valor: Math.round(Number(f.valor.replace(/\./g, '').replace(',', '.') || 0) * 100) } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      fechar();
      navegar(`/crm/lead/${r.id}`);
    },
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal form" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3 style={{ marginTop: 0, gridColumn: '1 / -1' }}>Novo card em {funil.nome}</h3>
        <Campo rotulo="Nome do contato" className="l2"><input autoFocus value={f.nome} onChange={set('nome')} /></Campo>
        <Campo rotulo="WhatsApp" className="l2"><input inputMode="tel" value={f.telefone} onChange={set('telefone')} placeholder="(27) 99999-9999" /></Campo>
        <Campo rotulo="E-mail" className="l2"><input type="email" value={f.email} onChange={set('email')} /></Campo>
        <Campo rotulo="Valor previsto (R$)" className="l2"><input inputMode="decimal" value={f.valor} onChange={set('valor')} /></Campo>
        <Campo rotulo="Título do card (opcional)" className="l4"><input value={f.titulo} onChange={set('titulo')} placeholder="Igual ao nome se ficar vazio" /></Campo>
        {m.error && <div className="l4"><Erro erro={m.error} /></div>}
        <div className="flex l4">
          <button className="botao" disabled={!f.nome.trim() || !f.telefone.trim() || m.isPending} onClick={() => m.mutate()}>Criar card</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}
