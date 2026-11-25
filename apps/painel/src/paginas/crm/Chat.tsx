import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, lerSessao, pode } from '../../api';
import { Campo, Carregando, Erro } from '../../componentes/ui';
import { EscolherMensagem, MensagemDaTarefa, corpoMensagem, mensagemPronta, mensagemVazia, type TarefaComMensagem } from './TarefaMensagem';
import { ha, ligar, meuId, telefoneBonito, useMidia, useRelogio, usarAtendentes, usarFunis, type Template } from './comum';

interface Mensagem { id: string; direcao: 'entrada' | 'saida' | 'interna'; tipo: string; texto: string | null; midia: string | null; midiaNome: string | null; templateNome: string | null; status: string; erro: string | null; autor: string | null; automatica: boolean; criadoEm: string; ia: boolean; transcricao: string | null; transcricaoStatus: 'pendente' | 'feita' | 'falhou' | null; transcricaoErro: string | null; reacoes: { de: 'contato' | 'equipe'; emoji: string }[]; apagada: boolean; noWhatsApp: boolean; citada: { id: string; direcao: string; tipo: string; texto: string | null } | null }
interface Dados {
  conversa: { id: string; status: 'fila' | 'atendimento' | 'resolvida'; atendenteId: string | null; canalId: string; canal: string; canalTipo: 'oficial' | 'qrcode' | 'evolution'; dentroDaJanela: boolean; filaDesde: string | null; contatoId: string; fixada: boolean };
  contato: { id: string; nome: string; telefone: string; descadastrado: boolean; memoriaIa?: string | null; memoriaIaEm?: string | null };
  mensagens: Mensagem[];
  recursos: { reagir: boolean; apagar: boolean; ia: boolean; transcrever: boolean };
  iaAtendendo: boolean;
}

const REACOES_RAPIDAS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJIS = '😀 😃 😄 😁 😅 😂 🤣 😊 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 🤗 🤔 😐 😴 😢 😭 😤 😡 🤯 😱 🙏 👍 👎 👏 🙌 💪 🤝 👋 ✌️ 🤞 👌 ❤️ 🧡 💛 💚 💙 💜 🤎 💔 💖 ✨ ⭐ 🌟 🔥 🎉 🎁 🎂 💎 💍 📿 👑 🌹 🌸 ☀️ 🌙 ✅ ❌ ⚠️ ❓ ❗ 💬 📞 📱 📍 📦 🚚 💰 💳 🧾 🗓️ ⏰ 📷 🎥 📎 🛍️'.split(' ');
const resumoTipo: Record<string, string> = { imagem: '📷 Foto', audio: '🎤 Áudio', video: '🎥 Vídeo', documento: '📎 Arquivo', localizacao: '📍 Localização' };
const lerArquivo = (f: Blob) =>
  new Promise<string>((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => erro(r.error);
    r.readAsDataURL(f);
  });

const TICKS: Record<string, string> = { pendente: '🕓', enviada: '✓', entregue: '✓✓', lida: '✓✓', falhou: '⚠️' };

function Midia({ m }: { m: Mensagem }) {
  const url = useMidia(m.midia);
  if (!m.midia) return null;
  if (!url) return <div className="muted">Carregando arquivo…</div>;
  if (m.tipo === 'imagem') return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="" /></a>;
  if (m.tipo === 'audio') return <audio controls src={url} />;
  if (m.tipo === 'video') return <video controls src={url} />;
  return <a href={url} download={m.midiaNome ?? 'arquivo'}>📎 {m.midiaNome ?? 'Abrir arquivo'}</a>;
}

/** Texto do áudio (transcrito pela IA), ou o botão para transcrever. */
function Transcricao({ m, conversaId, pode }: { m: Mensagem; conversaId: string; pode: boolean }) {
  const qc = useQueryClient();
  const [aberta, setAberta] = useState(true);
  const t = useMutation({
    mutationFn: () => api(`/crm/conversas/${conversaId}/mensagens/${m.id}/transcrever`, { corpo: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['crm', 'msgs', conversaId] }),
  });
  if (m.tipo !== 'audio' || !m.midia || m.apagada) return null;
  if (m.transcricaoStatus === 'feita' && m.transcricao)
    return (
      <div className="transcricao">
        <button className="link" onClick={() => setAberta(!aberta)} aria-expanded={aberta}>📝 Transcrição {aberta ? '▾' : '▸'}</button>
        {aberta && <div className="texto-transcrito">{m.transcricao}</div>}
      </div>
    );
  if (m.transcricaoStatus === 'pendente' || t.isPending) return <div className="transcricao muted">📝 Transcrevendo…</div>;
  return (
    <div className="transcricao">
      {m.transcricaoStatus === 'falhou' && <div className="muted" title={m.transcricaoErro ?? undefined}>Não deu para transcrever{m.transcricaoErro ? `: ${m.transcricaoErro}` : '.'}</div>}
      {t.error && <div className="muted">{(t.error as Error).message}</div>}
      <button className="link" onClick={() => t.mutate()} title={pode ? undefined : 'A transcrição usa a chave da OpenAI (Configurações › Integrações › Inteligência artificial)'}>📝 {m.transcricaoStatus === 'falhou' ? 'Tentar de novo' : 'Transcrever'}</button>
    </div>
  );
}

/** Abas "Notas" e "Tarefas" da conversa: as mesmas do card, sem sair do chat. */
function NotasTarefas({ modo, leadId, contato }: { modo: 'notas' | 'tarefas'; leadId: string | null; contato: { id: string; nome: string; telefone: string } }) {
  const qc = useQueryClient();
  const editar = pode('crm', 'editar');
  const funis = usarFunis();
  const lead = useQuery({ queryKey: ['crm', 'lead', leadId], queryFn: () => api<{ eventos: { id: string; tipo: string; texto: string; autor: string | null; criadoEm: string }[]; tarefas: (TarefaComMensagem & { titulo: string; responsavel: string | null })[] }>(`/crm/leads/${leadId}`), enabled: !!leadId });
  const recarregar = () => qc.invalidateQueries({ queryKey: ['crm'] });
  const [funilId, setFunilId] = useState('');
  const criarCard = useMutation({ mutationFn: () => api('/crm/leads', { corpo: { funilId: funilId || funis.data?.[0]?.id, nome: contato.nome.length >= 2 ? contato.nome : contato.telefone, telefone: contato.telefone } }), onSuccess: recarregar });
  const [nota, setNota] = useState('');
  const anotar = useMutation({ mutationFn: () => api(`/crm/leads/${leadId}/notas`, { corpo: { texto: nota } }), onSuccess: () => { setNota(''); recarregar(); } });
  const amanha = () => { const d = new Date(Date.now() + 86400_000); d.setHours(9, 0, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const [tarefa, setTarefa] = useState({ titulo: '', venceEm: amanha() });
  const [msgTarefa, setMsgTarefa] = useState(mensagemVazia());
  const criarTarefa = useMutation({ mutationFn: () => api(`/crm/leads/${leadId}/tarefas`, { corpo: { titulo: tarefa.titulo, venceEm: new Date(tarefa.venceEm).toISOString(), mensagem: corpoMensagem(msgTarefa) } }), onSuccess: () => { setTarefa({ titulo: '', venceEm: amanha() }); setMsgTarefa(mensagemVazia()); recarregar(); } });
  const concluir = useMutation({ mutationFn: (v: { id: string; feita: boolean }) => api(`/crm/tarefas/${v.id}`, { metodo: 'PATCH', corpo: { feita: v.feita } }), onSuccess: recarregar });
  const campo = { padding: '7px 9px', border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit', background: '#fff', minWidth: 0 } as const;

  if (!leadId) {
    return (
      <div className="chat-painel">
        <p style={{ marginTop: 0 }}>{modo === 'notas' ? 'As notas' : 'As tarefas'} ficam no card da pessoa, e <b>{contato.nome}</b> ainda não tem card em nenhum funil.</p>
        {pode('crm', 'criar') ? (
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select aria-label="Funil" value={funilId || funis.data?.[0]?.id || ''} onChange={(e) => setFunilId(e.target.value)} style={campo}>{funis.data?.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</select>
            <button className="botao pequeno" disabled={criarCard.isPending || !funis.data?.length} onClick={() => criarCard.mutate()}>Criar card</button>
          </div>
        ) : <span className="muted">Peça a quem pode criar cards.</span>}
        {criarCard.error && <Erro erro={criarCard.error} />}
      </div>
    );
  }
  if (lead.isLoading) return <div className="chat-painel muted">Carregando…</div>;
  if (lead.error) return <div className="chat-painel"><Erro erro={lead.error} /></div>;
  const notas = (lead.data?.eventos ?? []).filter((e) => e.tipo === 'nota');
  const tarefas = lead.data?.tarefas ?? [];
  const quando = (d: string) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="chat-painel">
      {modo === 'notas' ? (
        <>
          {editar && (
            <form className="coluna" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (nota.trim()) anotar.mutate(); }}>
              <textarea aria-label="Nova nota" rows={3} placeholder="Anote algo sobre esta pessoa (o cliente não vê)." value={nota} maxLength={4000} onChange={(e) => setNota(e.target.value)} style={{ ...campo, resize: 'vertical' }} />
              <div><button className="botao pequeno" disabled={!nota.trim() || anotar.isPending}>Salvar nota</button></div>
              {anotar.error && <Erro erro={anotar.error} />}
            </form>
          )}
          {!notas.length && <p className="muted">Nenhuma nota ainda.</p>}
          {notas.map((n) => <div key={n.id} className="nota-chat"><div style={{ whiteSpace: 'pre-wrap' }}>{n.texto}</div><div className="muted" style={{ fontSize: 12 }}>{n.autor ?? 'Sistema'} · {quando(n.criadoEm)}</div></div>)}
        </>
      ) : (
        <>
          {editar && (
            <form className="flex" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (tarefa.titulo.trim().length >= 2 && tarefa.venceEm && mensagemPronta(msgTarefa)) criarTarefa.mutate(); }}>
              <input aria-label="Nova tarefa" placeholder="O que fazer? Ex.: ligar para confirmar" value={tarefa.titulo} maxLength={200} onChange={(e) => setTarefa({ ...tarefa, titulo: e.target.value })} style={{ ...campo, flex: 1, minWidth: 180 }} />
              <input aria-label="Para quando" type="datetime-local" value={tarefa.venceEm} onChange={(e) => setTarefa({ ...tarefa, venceEm: e.target.value })} style={campo} />
              <EscolherMensagem valor={msgTarefa} mudar={setMsgTarefa} />
              <button className="botao pequeno" disabled={tarefa.titulo.trim().length < 2 || !tarefa.venceEm || !mensagemPronta(msgTarefa) || criarTarefa.isPending}>Criar tarefa</button>
            </form>
          )}
          {(criarTarefa.error || concluir.error) && <Erro erro={criarTarefa.error ?? concluir.error} />}
          {!tarefas.length && <p className="muted">Nenhuma tarefa ainda.</p>}
          {tarefas.map((t) => (
            <label key={t.id} className="nota-chat check" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!t.feitaEm} disabled={!editar || concluir.isPending} onChange={(e) => concluir.mutate({ id: t.id, feita: e.target.checked })} />
              <span style={{ flex: 1 }}>
                <span style={{ textDecoration: t.feitaEm ? 'line-through' : undefined }}>{t.titulo}</span>
                <span className="muted" style={{ display: 'block', fontSize: 12, color: !t.feitaEm && new Date(t.venceEm) < new Date() ? 'var(--erro)' : undefined }}>{t.feitaEm ? `feita em ${quando(t.feitaEm)}` : `${new Date(t.venceEm) < new Date() ? 'venceu em' : 'para'} ${quando(t.venceEm)}`}{t.responsavel ? ` · ${t.responsavel}` : ''}</span>
                <MensagemDaTarefa t={t} podeEnviar={editar} />
              </span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

/** Baixa a conversa carregada como texto, no formato de exportação do WhatsApp. */
function exportar(contato: { nome: string; telefone: string }, mensagens: Mensagem[]) {
  const linhas = mensagens.map((m) => {
    const quem = m.direcao === 'entrada' ? contato.nome : m.direcao === 'interna' ? `[interna] ${m.autor ?? ''}` : (m.autor ?? 'Aritana');
    const corpo = m.apagada ? '(mensagem apagada)' : [m.midia ? `<${resumoTipo[m.tipo] ?? 'arquivo'}>` : '', m.texto ?? ''].filter(Boolean).join(' ');
    return `${new Date(m.criadoEm).toLocaleString('pt-BR')} - ${quem}: ${corpo}`;
  });
  const url = URL.createObjectURL(new Blob([`Conversa com ${contato.nome} (${contato.telefone})\n\n${linhas.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversa-${contato.telefone}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Chat de uma conversa: fila, atendimento, mensagens, conversa interna, templates e respostas rápidas. */
export function Chat({ conversaId, leadId, aoMudar, abas, aoSair }: { conversaId: string; leadId?: string | null; aoMudar?: () => void; /** Mostra as abas Notas e Tarefas (caixa de entrada). */ abas?: boolean; /** A conversa deixou de existir (excluída). */ aoSair?: () => void }) {
  const qc = useQueryClient();
  useRelogio(30);
  const eu = meuId();
  const gestor = pode('crm', 'excluir');
  const editar = pode('crm', 'editar');
  const q = useQuery({ queryKey: ['crm', 'msgs', conversaId], queryFn: () => api<Dados>(`/crm/conversas/${conversaId}/mensagens`), refetchInterval: 3000 });
  const respostas = useQuery({ queryKey: ['crm', 'respostas'], queryFn: () => api<{ id: string; atalho: string; texto: string; midia: string | null; midiaMime: string | null; midiaNome: string | null }[]>('/crm/respostas'), staleTime: 60_000 });
  const canalId = q.data?.conversa.canalId;
  const templates = useQuery({ queryKey: ['crm', 'templates', canalId], queryFn: () => api<Template[]>(`/crm/templates?canalId=${canalId}`), enabled: !!canalId, staleTime: 60_000 });
  const atendentes = usarAtendentes();
  const [texto, setTexto] = useState('');
  const [interna, setInterna] = useState(false);
  const [verTemplates, setVerTemplates] = useState(false);
  const [transferir, setTransferir] = useState(false);
  const transferirPara = useQuery({ queryKey: ['crm', 'transferir-para', conversaId], enabled: transferir, queryFn: () => api<{ id: string; nome: string; grupo: string; pode: boolean; motivo: string | null }[]>(`/crm/conversas/${conversaId}/transferir-para`) });
  // Balão aberto: qual mensagem está com o seletor de reação; qual painel do rodapé (emojis, formulários); menu "⋮" do topo.
  const [aba, setAba] = useState<'chat' | 'notas' | 'tarefas'>('chat');
  const [unificando, setUnificando] = useState(false);
  const [buscaUnir, setBuscaUnir] = useState('');
  const outras = useQuery({ queryKey: ['crm', 'conversas', 'unir', buscaUnir], queryFn: () => api<{ id: string; contato: string; telefone: string; canal: string; contatoId: string }[]>(`/crm/conversas?aba=todas&busca=${encodeURIComponent(buscaUnir.trim())}`), enabled: unificando && buscaUnir.trim().length >= 3 });
  const [reagindo, setReagindo] = useState<string | null>(null);
  const [painel, setPainel] = useState<'emoji' | 'form' | null>(null);
  const [menu, setMenu] = useState(false);
  const [citar, setCitar] = useState<Mensagem | null>(null);
  // Arquivo escolhido, colado ou arrastado, esperando o "Enviar" (o texto vira legenda).
  const [pendente, setPendente] = useState<{ arquivo: Blob; nome: string; previa: string | null } | null>(null);
  const [gravando, setGravando] = useState<{ desde: number } | null>(null);
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const [nomeNovo, setNomeNovo] = useState<string | null>(null);
  const [corrigir, setCorrigir] = useState<string | null>(null);
  const [verMemoria, setVerMemoria] = useState(false);
  const gravador = useRef<{ rec: MediaRecorder; cancelado: boolean } | null>(null);
  const campoTexto = useRef<HTMLTextAreaElement>(null);
  const fim = useRef<HTMLDivElement>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  const formularios = useQuery({ queryKey: ['formularios-chat'], queryFn: () => api<{ id: string; slug: string; titulo: string; ativo: boolean }[]>('/formularios'), enabled: painel === 'form', staleTime: 60_000 });
  const ultimo = q.data?.mensagens.at(-1)?.id;

  useEffect(() => {
    fim.current?.scrollIntoView({ block: 'end' });
  }, [ultimo, conversaId]);

  const atualizar = () => {
    qc.invalidateQueries({ queryKey: ['crm', 'msgs', conversaId] });
    qc.invalidateQueries({ queryKey: ['crm', 'conversas'] });
    qc.invalidateQueries({ queryKey: ['crm', 'contadores'] });
    aoMudar?.();
  };
  const acao = useMutation({ mutationFn: ({ rota, corpo }: { rota: string; corpo?: unknown }) => api(`/crm/conversas/${conversaId}/${rota}`, { corpo: corpo ?? {} }), onSuccess: atualizar });
  const enviar = useMutation({
    mutationFn: (c: { tipo: 'texto' | 'template'; texto?: string; templateId?: string }) => api(`/crm/conversas/${conversaId}/${interna && c.tipo === 'texto' ? 'interna' : 'mensagens'}`, { corpo: { ...c, leadId, ...(citar && !interna ? { citarId: citar.id } : {}) } }),
    onSuccess: () => {
      setTexto('');
      setVerTemplates(false);
      setCitar(null);
      setPainel(null);
      atualizar();
    },
  });
  const anexar = useMutation({
    mutationFn: async (a: { arquivo: Blob; nome: string; legenda?: string | null }) => {
      if (a.arquivo.size > 16_000_000) throw new Error('Arquivo maior que 16 MB.');
      const base64 = await lerArquivo(a.arquivo);
      // "audio/webm;codecs=opus" → "audio/webm"
      return api(`/crm/conversas/${conversaId}/midia`, { corpo: { nome: a.nome, mime: (a.arquivo.type || 'application/octet-stream').split(';')[0], base64, texto: a.legenda || null, ...(citar ? { citarId: citar.id } : {}) } });
    },
    onSuccess: () => {
      setTexto('');
      setPendente(null);
      setCitar(null);
      atualizar();
    },
  });
  const reagir = useMutation({ mutationFn: (v: { id: string; emoji: string }) => api(`/crm/conversas/${conversaId}/mensagens/${v.id}/reagir`, { corpo: { emoji: v.emoji } }), onSuccess: atualizar, onSettled: () => setReagindo(null) });
  const apagar = useMutation({ mutationFn: (id: string) => api(`/crm/conversas/${conversaId}/mensagens/${id}/apagar`, { corpo: {} }), onSuccess: atualizar });
  const unificar = useMutation({ mutationFn: (comConversaId: string) => api<{ juntadas: number; cards: number }>(`/crm/conversas/${conversaId}/unificar`, { corpo: { comConversaId } }), onSuccess: () => { setUnificando(false); setBuscaUnir(''); atualizar(); } });
  const excluirConversa = useMutation({ mutationFn: () => api(`/crm/conversas/${conversaId}`, { metodo: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm', 'conversas'] }); qc.invalidateQueries({ queryKey: ['crm', 'contadores'] }); aoSair?.(); } });
  const sugerir = useMutation({ mutationFn: () => api<{ texto: string }>(`/crm/conversas/${conversaId}/sugerir`, { corpo: {} }), onSuccess: (r) => { if (r.texto) setTexto(r.texto); campoTexto.current?.focus(); } });
  const apagarTemplate = useMutation({ mutationFn: (id: string) => api(`/crm/templates/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['crm', 'templates'] }) });
  const renomear = useMutation({ mutationFn: (v: { id: string; nome: string }) => api(`/crm/contatos/${v.id}`, { metodo: 'PATCH', corpo: { nome: v.nome } }), onSuccess: () => { setNomeNovo(null); atualizar(); } });

  /** Arquivo escolhido, colado (Ctrl+V) ou arrastado para a conversa: fica esperando o "Enviar". */
  const escolher = (f: File | Blob, nome?: string) => {
    setErroLocal(null);
    if (f.size > 16_000_000) return setErroLocal('Arquivo maior que 16 MB.');
    setPendente((antes) => {
      if (antes?.previa) URL.revokeObjectURL(antes.previa);
      return { arquivo: f, nome: nome ?? (f as File).name ?? 'arquivo', previa: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
    });
    campoTexto.current?.focus();
  };

  /** Grava um áudio pelo microfone e manda como mensagem de voz. */
  const gravar = async () => {
    setErroLocal(null);
    try {
      const som = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tipo = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(som, tipo ? { mimeType: tipo } : undefined);
      const partes: Blob[] = [];
      const estado = { rec, cancelado: false };
      rec.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
      rec.onstop = () => {
        som.getTracks().forEach((t) => t.stop());
        setGravando(null);
        gravador.current = null;
        if (estado.cancelado || !partes.length) return;
        const audio = new Blob(partes, { type: rec.mimeType || tipo || 'audio/webm' });
        const ext = audio.type.includes('ogg') ? 'ogg' : audio.type.includes('mp4') ? 'm4a' : 'webm';
        anexar.mutate({ arquivo: audio, nome: `audio.${ext}` });
      };
      gravador.current = estado;
      rec.start();
      setGravando({ desde: Date.now() });
    } catch {
      setErroLocal('Não deu para usar o microfone. Libere o microfone para este site no navegador.');
    }
  };
  const pararGravacao = (cancelar: boolean) => {
    if (!gravador.current) return;
    gravador.current.cancelado = cancelar;
    gravador.current.rec.stop();
  };
  // Saiu da conversa no meio da gravação: descarta.
  useEffect(() => () => { if (gravador.current) { gravador.current.cancelado = true; gravador.current.rec.stop(); } }, []);
  // Relógio da gravação.
  const [, tique] = useState(0);
  useEffect(() => {
    if (!gravando) return;
    const t = setInterval(() => tique((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [gravando]);

  const inserir = (pedaco: string) => {
    const el = campoTexto.current;
    const ini = el?.selectionStart ?? texto.length;
    const fimSel = el?.selectionEnd ?? texto.length;
    setTexto(texto.slice(0, ini) + pedaco + texto.slice(fimSel));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(ini + pedaco.length, ini + pedaco.length); });
  };
  const mandar = () => {
    if (pendente) return anexar.mutate({ arquivo: pendente.arquivo, nome: pendente.nome, legenda: texto });
    if (texto.trim() && !enviar.isPending) enviar.mutate({ tipo: 'texto', texto });
  };

  // "/" → respostas rápidas e templates (digitar mais filtra pelo nome); "@nome" na conversa interna → colegas.
  const cv = q.data?.conversa;
  const sugestoes = useMemo((): { rotulo: string; valor: string; etiqueta?: string; templateId?: string; midia?: { nome: string; mime: string | null; arquivo: string } }[] => {
    const barra = texto.match(/^\/(.*)$/);
    if (barra && !interna && !barra[1].includes('\n')) {
      const termo = barra[1].trim().toLowerCase();
      const icone = (mime: string | null) => (mime?.startsWith('image/') ? '🖼 ' : mime?.startsWith('video/') ? '🎬 ' : mime?.startsWith('audio/') ? '🎤 ' : '');
      const rapidas = (respostas.data ?? [])
        .filter((r) => r.atalho.startsWith(termo) || r.texto.toLowerCase().includes(termo))
        .map((r) => ({ rotulo: `/${r.atalho} — ${icone(r.midiaMime)}${r.texto.slice(0, 60) || r.midiaNome || ''}`, valor: r.texto, etiqueta: 'Resposta rápida', ...(r.midia ? { midia: { nome: r.midiaNome ?? 'arquivo', mime: r.midiaMime, arquivo: r.midia } } : {}) }));
      const modelos = (templates.data ?? [])
        .filter((t) => (t.tipo === 'meta' ? t.status === 'APPROVED' && cv?.canalTipo === 'oficial' : cv?.canalTipo !== 'oficial' || cv?.dentroDaJanela))
        .filter((t) => t.nome.toLowerCase().includes(termo) || t.texto.toLowerCase().includes(termo))
        // Modelo livre entra no campo para você ajustar antes de enviar; o da Meta vai como está (é o texto aprovado).
        .map((t) => (t.tipo === 'meta' ? { rotulo: `${t.nome} — ${t.texto.slice(0, 60)}`, valor: '', etiqueta: 'Template da Meta: envia na hora', templateId: t.id } : { rotulo: `${t.nome} — ${t.texto.slice(0, 60)}`, valor: t.texto, etiqueta: 'Template' }));
      return [...rapidas, ...modelos].slice(0, 12);
    }
    const arroba = texto.match(/(^|\s)@(\S*)$/);
    if (arroba && interna) return (atendentes.data ?? []).filter((a) => a.nome.toLowerCase().startsWith(arroba[2].toLowerCase())).slice(0, 6).map((a) => ({ rotulo: `@${a.nome}`, valor: texto.replace(/@(\S*)$/, `@${a.nome.split(' ')[0]} `) }));
    return [];
  }, [texto, interna, respostas.data, atendentes.data, templates.data, cv?.canalTipo, cv?.dentroDaJanela]);
  const usarSugestao = (sg: { valor: string; templateId?: string; midia?: { nome: string; mime: string | null; arquivo: string } }) => {
    if (sg.templateId) enviar.mutate({ tipo: 'template', templateId: sg.templateId });
    else setTexto(sg.valor);
    // Resposta rápida com foto, vídeo ou áudio: o arquivo fica anexado esperando o "Enviar" (o texto vira legenda).
    if (sg.midia) {
      const m = sg.midia;
      fetch(`/api/crm/midia/${m.arquivo}`, { headers: { authorization: `Bearer ${lerSessao()?.token ?? ''}` } })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('O arquivo da resposta rápida não foi encontrado.'))))
        .then((b) => escolher(m.mime ? new Blob([b], { type: m.mime }) : b, m.nome))
        .catch((e) => setErroLocal((e as Error).message));
    }
    campoTexto.current?.focus();
  };
  const semSugestao = !interna && /^\/[^\n]*$/.test(texto) && !sugestoes.length;

  if (q.isLoading) return <div className="chat"><div className="chat-msgs muted">Carregando conversa…</div></div>;
  if (q.error) return <div className="chat"><div style={{ padding: 16 }}><Erro erro={q.error} /></div></div>;
  const { conversa: c, contato, mensagens } = q.data!;
  const minha = c.status === 'atendimento' && c.atendenteId === eu;
  const deOutro = c.status === 'atendimento' && c.atendenteId && c.atendenteId !== eu;
  const nomeAtendente = atendentes.data?.find((a) => a.id === c.atendenteId)?.nome;
  const podeEscrever = editar && (!deOutro || gestor || interna);
  const usaveis = (templates.data ?? []).filter((t) => (t.tipo === 'meta' ? t.status === 'APPROVED' && c.canalTipo === 'oficial' : c.canalTipo !== 'oficial' || c.dentroDaJanela));
  const esperaMin = c.filaDesde ? (Date.now() - new Date(c.filaDesde).getTime()) / 60000 : 0;

  let diaAnterior = '';
  return (
    <div className="chat">
      <div className="chat-topo">
        <div style={{ minWidth: 0 }}>
          {nomeNovo === null ? (
            <div style={{ fontWeight: 700 }}>
              {c.fixada && <span title="Fixada no topo">📌 </span>}{contato.nome}{' '}
              {editar && <button className="icone-chat" title="Mudar o nome do contato" aria-label="Mudar o nome do contato" onClick={() => setNomeNovo(contato.nome)}>✎</button>}
            </div>
          ) : (
            <form className="flex" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (nomeNovo.trim()) renomear.mutate({ id: contato.id, nome: nomeNovo.trim() }); }}>
              <input autoFocus aria-label="Nome do contato" value={nomeNovo} maxLength={150} onChange={(e) => setNomeNovo(e.target.value)} style={{ padding: '4px 8px', border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
              <button className="botao pequeno" disabled={!nomeNovo.trim() || renomear.isPending}>Salvar</button>
              <button type="button" className="botao claro pequeno" onClick={() => setNomeNovo(null)}>Cancelar</button>
            </form>
          )}
          <div className="muted" style={{ fontSize: 13 }}>
            {telefoneBonito(contato.telefone)} · {c.canal} {c.canalTipo === 'oficial' ? '(oficial)' : '(QR code)'}
            {contato.descadastrado && <span className="etiqueta erro" style={{ marginLeft: 6 }}>Não quer disparos</span>}
          </div>
        </div>
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="botao claro pequeno" title="Ligar pelo softphone" onClick={() => ligar(contato.telefone, leadId, contato.nome)}>📞 Ligar</button>
          {editar && c.status !== 'resolvida' && (minha || gestor) && <button className="botao claro pequeno" onClick={() => setTransferir((v) => !v)}>Transferir</button>}
          {editar && c.status !== 'resolvida' && (minha || gestor || c.status === 'fila') && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'resolver' })}>✓ Resolver</button>}
          <div style={{ position: 'relative' }}>
            <button className="botao claro pequeno" aria-label="Mais opções da conversa" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>⋮</button>
            {menu && (
              <div className="menu-chat" role="menu" onClick={() => setMenu(false)}>
                {editar && q.data!.recursos.ia && <button role="menuitem" onClick={() => acao.mutate({ rota: 'ia', corpo: { ativa: !q.data!.iaAtendendo } })}>{q.data!.iaAtendendo ? 'Pausar a IA nesta conversa' : '🤖 Acionar IA nesta conversa'}</button>}
                {editar && <button role="menuitem" onClick={() => acao.mutate({ rota: 'fixar', corpo: { fixada: !c.fixada } })}>{c.fixada ? 'Desafixar do topo' : '📌 Fixar no topo'}</button>}
                {editar && <button role="menuitem" onClick={() => acao.mutate({ rota: 'nao-lida' })}>Marcar como não lida</button>}
                {q.data!.recursos.ia && <button role="menuitem" onClick={() => setVerMemoria(true)}>🧠 O que a IA lembra desta pessoa</button>}
                <button role="menuitem" onClick={() => void navigator.clipboard?.writeText(contato.telefone)}>Copiar o telefone</button>
                <button role="menuitem" onClick={() => exportar(contato, mensagens)}>Exportar a conversa (.txt)</button>
                {gestor && <button role="menuitem" onClick={() => setUnificando(true)}>Unificar com outro contato</button>}
                {gestor && aoSair && <button role="menuitem" style={{ color: 'var(--erro)' }} onClick={() => window.confirm(`Excluir a conversa com ${contato.nome}? As mensagens são apagadas do sistema e não voltam. O contato e os cards continuam.`) && excluirConversa.mutate()}>Excluir a conversa</button>}
              </div>
            )}
          </div>
        </div>
      </div>
      {transferir && (
        <div className="chat-faixa" style={{ background: 'var(--creme-2)', color: 'var(--tinta)' }}>
          <span>Transferir para:</span>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="botao claro pequeno" onClick={() => { acao.mutate({ rota: 'transferir', corpo: { usuarioId: null } }); setTransferir(false); }}>Devolver para a fila</button>
            {transferirPara.isLoading && <span className="muted">Carregando…</span>}
            {transferirPara.data?.filter((a) => a.id !== c.atendenteId).map((a) => (
              <button key={a.id} className="botao claro pequeno" disabled={!a.pode} title={a.motivo ? `${a.motivo}${gestor ? '. Ajuste em Configurações › Grupos e permissões ou no número, em CRM › Configurar.' : ''}` : a.grupo} style={a.pode ? undefined : { opacity: 0.5 }} onClick={() => { acao.mutate({ rota: 'transferir', corpo: { usuarioId: a.id } }); setTransferir(false); }}>
                {a.nome}{!a.pode && <span style={{ fontSize: 11 }}> · {a.motivo === 'Sem acesso ao CRM' ? 'sem acesso' : 'outro número'}</span>}
              </button>
            ))}
          </div>
          {transferirPara.data?.some((a) => !a.pode) && <span className="muted" style={{ fontSize: 12, width: '100%' }}>Os apagados não podem receber: passe o mouse para ver o motivo.</span>}
        </div>
      )}
      {unificando && (
        <div className="chat-faixa" style={{ background: 'var(--creme-2)', color: 'var(--tinta)', flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="flex entre">
            <b>Unificar: qual outra conversa é desta mesma pessoa?</b>
            <button className="icone-chat" aria-label="Fechar" onClick={() => setUnificando(false)}>✕</button>
          </div>
          <span style={{ fontSize: 13 }}>As mensagens e os cards da outra conversa passam para {contato.nome}, e o contato repetido some. Não dá para desfazer.</span>
          <input autoFocus aria-label="Buscar a outra conversa" placeholder="Nome ou telefone (3 letras ou mais)" value={buscaUnir} onChange={(e) => setBuscaUnir(e.target.value)} style={{ padding: '6px 8px', border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
          <div className="sugestoes" style={{ maxHeight: 150 }}>
            {outras.data?.filter((o) => o.contatoId !== contato.id).map((o) => (
              <button key={o.id} disabled={unificar.isPending} onClick={() => window.confirm(`Unificar ${o.contato} (${telefoneBonito(o.telefone)}) com ${contato.nome}? Não dá para desfazer.`) && unificar.mutate(o.id)}>
                <b>{o.contato}</b> · {telefoneBonito(o.telefone)} <span className="muted">· {o.canal}</span>
              </button>
            ))}
            {outras.data && !outras.data.filter((o) => o.contatoId !== contato.id).length && <div className="muted" style={{ padding: 8 }}>Nenhuma outra conversa com esse nome ou telefone.</div>}
          </div>
          {unificar.error && <Erro erro={unificar.error} />}
        </div>
      )}
      {excluirConversa.error && <div style={{ padding: '6px 12px' }}><Erro erro={excluirConversa.error} /></div>}
      {abas && (
        <div className="chat-abas" role="tablist" aria-label="Conversa">
          {([['chat', 'Chat'], ['notas', 'Notas'], ['tarefas', 'Tarefas']] as const).map(([k, nome]) => <button key={k} role="tab" aria-selected={aba === k} className={aba === k ? 'ativa' : ''} onClick={() => setAba(k)}>{nome}</button>)}
        </div>
      )}
      {abas && aba !== 'chat' && <NotasTarefas modo={aba} leadId={leadId ?? null} contato={contato} />}
      {q.data!.iaAtendendo && aba === 'chat' && (
        <div className="chat-faixa" style={{ background: '#e6f0ea', color: '#2c5a41' }}>
          <span>🤖 A IA está atendendo esta conversa. Se você escrever ou pegar a conversa, ela sai.</span>
          {editar && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'ia', corpo: { ativa: false } })}>Pausar IA</button>}
        </div>
      )}
      {c.status === 'fila' && aba === 'chat' && (
        <div className="chat-faixa fila">
          <span>⏳ Na fila de espera {c.filaDesde ? `há ${ha(c.filaDesde)}` : ''}{esperaMin > 15 ? ' — esperando bastante' : ''}.</span>
          {editar && <button className="botao pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'pegar' })}>Pegar conversa</button>}
        </div>
      )}
      {deOutro && (
        <div className="chat-faixa">
          <span>Em atendimento com <b>{nomeAtendente ?? 'outra pessoa'}</b>.{gestor ? '' : ' Você pode deixar uma mensagem interna.'}</span>
          {gestor && <button className="botao claro pequeno" onClick={() => acao.mutate({ rota: 'pegar' })}>Assumir</button>}
        </div>
      )}
      {c.status === 'resolvida' && <div className="chat-faixa" style={{ background: 'var(--ok-fundo)', color: 'var(--ok)' }}><span>Atendimento resolvido. Se o contato escrever, volta para a fila.</span></div>}
      {acao.error && <div style={{ padding: '6px 12px' }}><Erro erro={acao.error} /></div>}

      <div
        className="chat-msgs"
        hidden={aba !== 'chat'}
        onDragOver={(e) => { if (editar && e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (editar && f) { e.preventDefault(); escolher(f); } }}
      >
        {!mensagens.length && <div className="muted" style={{ alignSelf: 'center' }}>Nenhuma mensagem ainda.</div>}
        {mensagens.map((m) => {
          const dia = new Date(m.criadoEm).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const sep = dia !== diaAnterior;
          diaAnterior = dia;
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {sep && <div className="dia">{dia}</div>}
              <div id={`msg-${m.id}`} className={`msg ${m.direcao} ${m.status === 'falhou' ? 'falhou' : ''} ${m.apagada ? 'apagada' : ''}`}>
                {m.direcao === 'interna' && <div style={{ fontSize: 12, fontWeight: 700, color: '#8a6d12' }}>🔒 Interna · {m.ia ? 'IA' : m.autor}</div>}
                {m.templateNome && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dourado-t)' }}>Template: {m.templateNome}</div>}
                {m.citada && !m.apagada && (
                  <button className="citada" title="Ir para a mensagem respondida" onClick={() => document.getElementById(`msg-${m.citada!.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
                    <b>{m.citada.direcao === 'saida' ? 'Vocês' : contato.nome}</b>
                    <span>{m.citada.texto ?? resumoTipo[m.citada.tipo] ?? 'Mensagem apagada'}</span>
                  </button>
                )}
                {m.apagada ? <i className="muted">🚫 Mensagem apagada</i> : <><Midia m={m} /><Transcricao m={m} conversaId={conversaId} pode={q.data!.recursos.transcrever} />{m.texto}</>}
                {/* Ações da mensagem: aparecem ao passar o mouse ou ao focar pelo teclado. */}
                {editar && podeEscrever && !m.apagada && m.direcao !== 'interna' && m.noWhatsApp && (
                  <div className="acoes-msg">
                    <button title="Responder citando" aria-label="Responder citando" onClick={() => { setCitar(m); setInterna(false); campoTexto.current?.focus(); }}>↩</button>
                    {q.data!.recursos.reagir && <button title="Reagir" aria-label="Reagir" aria-expanded={reagindo === m.id} onClick={() => setReagindo(reagindo === m.id ? null : m.id)}>😀</button>}
                    {m.texto && <button title="Copiar o texto" aria-label="Copiar o texto" onClick={() => void navigator.clipboard?.writeText(m.texto!)}>⧉</button>}
                    {m.direcao === 'saida' && q.data!.recursos.apagar && Date.now() - new Date(m.criadoEm).getTime() < 48 * 3600_000 && (
                      <button title="Apagar para todos" aria-label="Apagar para todos" disabled={apagar.isPending} onClick={() => window.confirm('Apagar esta mensagem para todos? O contato também deixa de ver.') && apagar.mutate(m.id)}>🗑</button>
                    )}
                    {reagindo === m.id && (
                      <div className="reacoes-rapidas" role="menu">
                        {REACOES_RAPIDAS.map((e) => <button key={e} role="menuitem" disabled={reagir.isPending} onClick={() => reagir.mutate({ id: m.id, emoji: e })}>{e}</button>)}
                        {m.reacoes.some((r) => r.de === 'equipe') && <button role="menuitem" title="Tirar a reação" disabled={reagir.isPending} onClick={() => reagir.mutate({ id: m.id, emoji: '' })}>✕</button>}
                      </div>
                    )}
                  </div>
                )}
                <div className="rodape-msg">
                  {m.direcao === 'saida' && (m.ia ? '🤖 IA' : m.automatica ? 'automática' : m.autor ?? 'celular')}
                  {m.direcao === 'saida' && m.ia && editar && <button type="button" className="corrigir-ia" title="A resposta da IA não foi boa? Ensine o certo." onClick={() => setCorrigir(m.id)}>Corrigir a IA</button>}
                  <span>{new Date(m.criadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                  {m.direcao === 'saida' && <span style={{ color: m.status === 'lida' ? '#2a7fd4' : undefined }} title={m.erro ?? m.status}>{TICKS[m.status] ?? ''}</span>}
                </div>
                {m.erro && <div style={{ fontSize: 12, color: 'var(--erro)' }}>{m.erro}</div>}
                {m.reacoes.length > 0 && !m.apagada && <div className="reacoes">{m.reacoes.map((r) => <span key={r.de} title={r.de === 'equipe' ? 'Reação de vocês' : `Reação de ${contato.nome}`}>{r.emoji}</span>)}</div>}
              </div>
            </div>
          );
        })}
        <div ref={fim} />
      </div>

      {editar && aba === 'chat' && (
        <div className={`composer ${interna ? 'interna' : ''}`}>
          {c.canalTipo === 'oficial' && !c.dentroDaJanela && !interna && <div className="aviso alerta" style={{ margin: 0, padding: '6px 10px', fontSize: 13 }}>Fora da janela de 24h: no número oficial, só templates aprovados até o contato responder.</div>}
          {sugestoes.length > 0 && <div className="sugestoes">{sugestoes.map((sg) => <button key={`${sg.etiqueta}-${sg.rotulo}`} onClick={() => usarSugestao(sg)}>{sg.etiqueta && <span className="tag" style={{ marginRight: 6 }}>{sg.etiqueta}</span>}{sg.rotulo}</button>)}</div>}
          {semSugestao && <div className="sugestoes"><div className="muted" style={{ padding: 8 }}>{texto === '/' ? 'Nenhuma resposta rápida nem template cadastrado. Crie em CRM › Configurar › Templates ou Respostas rápidas.' : 'Nada com esse nome.'}</div></div>}
          {verTemplates && (
            <div className="sugestoes">
              {!usaveis.length && <div className="muted" style={{ padding: 8 }}>Nenhum template disponível para este número.</div>}
              {usaveis.map((t) => (
                <div key={t.id} className="linha-template">
                  <button onClick={() => enviar.mutate({ tipo: 'template', templateId: t.id })} disabled={enviar.isPending} title="Enviar este template">
                    <b>{t.nome}</b> {t.tipo === 'meta' ? <span className="tag">Meta</span> : null} <span className="muted">— {t.texto.slice(0, 80)}</span>
                  </button>
                  {gestor && t.tipo !== 'meta' && <button className="apagar" title="Apagar este template" aria-label={`Apagar o template ${t.nome}`} disabled={apagarTemplate.isPending} onClick={() => window.confirm(`Apagar o template "${t.nome}"? Ele some para toda a equipe.`) && apagarTemplate.mutate(t.id)}>🗑</button>}
                </div>
              ))}
              {apagarTemplate.error && <Erro erro={apagarTemplate.error} />}
            </div>
          )}
          {(enviar.error || anexar.error || reagir.error || apagar.error || renomear.error || sugerir.error) && <Erro erro={enviar.error ?? anexar.error ?? reagir.error ?? apagar.error ?? renomear.error ?? sugerir.error} />}
          {corrigir && <CorrigirIa mensagemId={corrigir} fechar={() => setCorrigir(null)} />}
          {verMemoria && <MemoriaIa contato={contato} fechar={() => setVerMemoria(false)} aoSalvar={atualizar} />}
          {erroLocal && <div className="aviso erro" role="alert" style={{ margin: 0, padding: '6px 10px', fontSize: 13 }}>{erroLocal}</div>}
          {painel === 'emoji' && (
            <div className="emojis" role="group" aria-label="Emojis">
              {EMOJIS.map((e) => <button key={e} onClick={() => inserir(e)}>{e}</button>)}
            </div>
          )}
          {painel === 'form' && (
            <div className="sugestoes">
              {formularios.isLoading && <div className="muted" style={{ padding: 8 }}>Carregando…</div>}
              {formularios.data && !formularios.data.filter((f) => f.ativo).length && <div className="muted" style={{ padding: 8 }}>Nenhum formulário ativo. Crie um em Formulários.</div>}
              {formularios.data?.filter((f) => f.ativo).map((f) => (
                <button key={f.id} onClick={() => { inserir(`${window.location.origin}/f/${f.slug}`); setPainel(null); }}>
                  <b>{f.titulo}</b> <span className="muted">— coloca o link na mensagem</span>
                </button>
              ))}
            </div>
          )}
          {citar && !interna && (
            <div className="citando">
              <div style={{ minWidth: 0 }}>
                <b>Respondendo a {citar.direcao === 'saida' ? 'vocês' : contato.nome}</b>
                <div className="previa">{citar.texto ?? resumoTipo[citar.tipo] ?? 'Mensagem'}</div>
              </div>
              <button className="icone-chat" aria-label="Cancelar a resposta" onClick={() => setCitar(null)}>✕</button>
            </div>
          )}
          {pendente && (
            <div className="citando">
              {pendente.previa ? <img src={pendente.previa} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} /> : <span aria-hidden="true">📎</span>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{pendente.nome}</b>
                <div className="previa">Pronto para enviar. O que você escrever vai como legenda.</div>
              </div>
              <button className="icone-chat" aria-label="Tirar o arquivo" onClick={() => setPendente(null)}>✕</button>
            </div>
          )}
          <textarea
            ref={campoTexto}
            rows={2}
            value={texto}
            disabled={!podeEscrever}
            placeholder={interna ? 'Mensagem interna (o cliente não vê). Use @ para chamar um colega.' : c.status === 'fila' ? 'Responder pega a conversa para você. "/" para respostas rápidas.' : 'Escreva… "/" para respostas rápidas. Enter envia, Shift+Enter quebra linha.'}
            onChange={(e) => setTexto(e.target.value)}
            onPaste={(e) => {
              // Colar uma imagem (print de tela, foto copiada) anexa em vez de colar texto.
              const img = [...e.clipboardData.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
              if (img && !interna) { e.preventDefault(); escolher(img, `imagem.${img.type.split('/')[1] || 'png'}`); }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && (citar || painel || pendente)) { setCitar(null); setPainel(null); setPendente(null); }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (sugestoes.length === 1) return usarSugestao(sugestoes[0]);
                // "/algo" que não achou nada não vai para o cliente como mensagem.
                if (semSugestao) return;
                if (interna) { if (texto.trim() && !enviar.isPending) enviar.mutate({ tipo: 'texto', texto }); } else mandar();
              }
            }}
          />
          <div className="acoes">
            <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={interna} onChange={(e) => setInterna(e.target.checked)} /> 🔒 Interna</label>
            <button className="botao claro pequeno" title="Emojis" aria-label="Emojis" aria-expanded={painel === 'emoji'} disabled={!podeEscrever} onClick={() => setPainel(painel === 'emoji' ? null : 'emoji')}>😀</button>
            {!interna && <button className="botao claro pequeno" onClick={() => setVerTemplates((v) => !v)}>Templates</button>}
            {!interna && <button className="botao claro pequeno" disabled={!podeEscrever || anexar.isPending || (c.canalTipo === 'oficial' && !c.dentroDaJanela)} onClick={() => arquivo.current?.click()}>{anexar.isPending ? 'Enviando…' : '📎 Arquivo'}</button>}
            {!interna && q.data!.recursos.ia && <button className="botao claro pequeno" title="A IA escreve uma resposta para você revisar antes de enviar" disabled={!podeEscrever || sugerir.isPending} onClick={() => sugerir.mutate()}>{sugerir.isPending ? 'Pensando…' : '✨ Sugerir'}</button>}
            {!interna && pode('formularios', 'ver') && <button className="botao claro pequeno" title="Mandar o link de um formulário" aria-expanded={painel === 'form'} disabled={!podeEscrever} onClick={() => setPainel(painel === 'form' ? null : 'form')}>📋 Formulário</button>}
            <input ref={arquivo} type="file" hidden accept="image/*,audio/*,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) escolher(f); e.target.value = ''; }} />
            <span style={{ flex: 1 }} />
            {gravando ? (
              <>
                <span className="gravando" role="status">● Gravando {Math.floor((Date.now() - gravando.desde) / 60000)}:{String(Math.floor((Date.now() - gravando.desde) / 1000) % 60).padStart(2, '0')}</span>
                <button className="botao claro pequeno" onClick={() => pararGravacao(true)}>Descartar</button>
                <button className="botao pequeno" onClick={() => pararGravacao(false)}>Enviar áudio</button>
              </>
            ) : (
              <>
                {!interna && !texto.trim() && !pendente && typeof MediaRecorder !== 'undefined' && <button className="botao claro pequeno" title="Gravar um áudio" aria-label="Gravar um áudio" disabled={!podeEscrever || anexar.isPending || (c.canalTipo === 'oficial' && !c.dentroDaJanela)} onClick={() => void gravar()}>🎤 Áudio</button>}
                <button className="botao pequeno" disabled={(!texto.trim() && !pendente) || enviar.isPending || anexar.isPending || !podeEscrever} onClick={() => (interna ? enviar.mutate({ tipo: 'texto', texto }) : mandar())}>{interna ? 'Anotar' : anexar.isPending ? 'Enviando…' : 'Enviar'}</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


/** Ensina a IA a partir de uma resposta dela: "quando o cliente disser isto, responda aquilo". */
function CorrigirIa({ mensagemId, fechar }: { mensagemId: string; fechar: () => void }) {
  const q = useQuery({ queryKey: ['crm', 'pergunta', mensagemId], queryFn: () => api<{ pergunta: string; respostaDaIa: string; funcao: string | null }>(`/crm/mensagens/${mensagemId}/pergunta`) });
  const [f, setF] = useState<{ quando: string; resposta: string } | null>(null);
  useEffect(() => { if (q.data && !f) setF({ quando: q.data.pergunta ? `O cliente diz ou pergunta: "${q.data.pergunta}"`.slice(0, 400) : '', resposta: '' }); }, [q.data, f]);
  const salvar = useMutation({ mutationFn: () => api<{ status: string }>('/crm/ia-licoes', { corpo: { mensagemId, funcao: q.data?.funcao ?? null, quando: f!.quando, resposta: f!.resposta } }) });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>Corrigir a IA</h3>
        {salvar.isSuccess ? (
          <>
            <div className="aviso ok">{salvar.data.status === 'ativa' ? 'Lição gravada: já vale para as próximas respostas.' : 'Correção enviada. Ela passa a valer quando a gestão aprovar em CRM › Configurar › Agente de IA.'}</div>
            <div className="flex" style={{ marginTop: 12 }}><button className="botao claro" onClick={fechar}>Fechar</button></div>
          </>
        ) : !f ? <Carregando /> : (
          <>
            {q.data?.respostaDaIa && <p className="muted" style={{ marginTop: 0 }}>A IA respondeu: "{q.data.respostaDaIa.slice(0, 300)}"</p>}
            <Campo rotulo="Quando acontecer isto" ajuda="Descreva a situação de forma geral, sem o nome do cliente."><textarea rows={2} maxLength={400} value={f.quando} onChange={(e) => setF({ ...f, quando: e.target.value })} /></Campo>
            <Campo rotulo="A IA deve responder ou fazer isto" ajuda="A informação certa ou o jeito certo de agir. Ex.: 'O prazo de troca é de 30 dias com a nota.' ou 'Passe para a equipe.'"><textarea rows={4} maxLength={1200} autoFocus value={f.resposta} onChange={(e) => setF({ ...f, resposta: e.target.value })} /></Campo>
            {salvar.error && <Erro erro={salvar.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={salvar.isPending || f.quando.trim().length < 8 || f.resposta.trim().length < 8} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Gravando…' : 'Ensinar'}</button>
              <button className="botao claro" onClick={fechar}>Voltar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** O resumo que a IA guardou sobre a pessoa. A equipe pode corrigir ou apagar. */
function MemoriaIa({ contato, fechar, aoSalvar }: { contato: Dados['contato']; fechar: () => void; aoSalvar: () => void }) {
  const [texto, setTexto] = useState(contato.memoriaIa ?? '');
  const salvar = useMutation({ mutationFn: (v: string | null) => api(`/crm/contatos/${contato.id}`, { metodo: 'PATCH', corpo: { memoriaIa: v } }), onSuccess: () => { aoSalvar(); fechar(); } });
  const editar = pode('crm', 'editar');
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>O que a IA lembra de {contato.nome}</h3>
        <p className="muted" style={{ marginTop: 0 }}>Um resumo curto das conversas anteriores, para ela não perguntar tudo de novo. Ela não guarda saúde, documentos, endereço completo, pagamento nem valor de dívida. {contato.memoriaIaEm ? `Atualizado em ${new Date(contato.memoriaIaEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.` : ''}</p>
        <textarea rows={6} maxLength={700} disabled={!editar} value={texto} placeholder="A IA ainda não guardou nada sobre esta pessoa." onChange={(e) => setTexto(e.target.value)} />
        {salvar.error && <Erro erro={salvar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          {editar && <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate(texto.trim() || null)}>Salvar</button>}
          {editar && contato.memoriaIa && <button className="botao claro" disabled={salvar.isPending} onClick={() => salvar.mutate(null)}>Apagar a memória</button>}
          <button className="botao claro" onClick={fechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
