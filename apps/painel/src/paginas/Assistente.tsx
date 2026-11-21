import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, lerSessao } from '../api';
import { Link } from 'react-router-dom';
import { dataHora } from '../formato';
import { Abas, Campo, Carregando, Erro, Topo } from '../componentes/ui';
import './assistente.css';

interface AnexoInfo { id: string; nome: string; mime: string }
interface Mensagem { id: string; papel: 'user' | 'assistant'; texto: string; fala: string | null; origem: string | null; criadoEm: string; anexos: AnexoInfo[] }
interface Pendente { chave: string; nome: string; mime: string; tamanho: number; previa: string | null; id?: string; leitura?: string; erro?: string }

const BASE_API = import.meta.env.VITE_API_URL ?? '/api';
const icone = (mime: string) => (mime.startsWith('image/') ? '🖼' : mime === 'application/pdf' ? '📄' : mime.startsWith('video/') ? '🎬' : mime.startsWith('audio/') ? '🎵' : mime.includes('sheet') || mime === 'text/csv' ? '📊' : '📝');
const tamanhoLegivel = (b: number) => (b > 1_000_000 ? `${(b / 1_000_000).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);

/** Anexo só sai com login: baixa com o token e mostra por um link local. */
function useAnexo(id: string, ligado = true) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ligado) return;
    let solto: string | null = null;
    fetch(`${BASE_API}/assistente/anexos/${id}`, { headers: { authorization: `Bearer ${lerSessao()?.token ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) setUrl((solto = URL.createObjectURL(b)));
      })
      .catch(() => undefined);
    return () => {
      if (solto) URL.revokeObjectURL(solto);
    };
  }, [id, ligado]);
  return url;
}

function AnexoNaMensagem({ a }: { a: AnexoInfo }) {
  const imagem = a.mime.startsWith('image/');
  const url = useAnexo(a.id, imagem);
  const abrir = async () => {
    const r = await fetch(`${BASE_API}/assistente/anexos/${a.id}`, { headers: { authorization: `Bearer ${lerSessao()?.token ?? ''}` } });
    if (r.ok) window.open(URL.createObjectURL(await r.blob()), '_blank');
  };
  if (imagem) return url ? <img className="assistente-miniatura" src={url} alt={a.nome} title={a.nome} onClick={() => window.open(url, '_blank')} /> : <span className="assistente-chip">{icone(a.mime)} {a.nome}</span>;
  return <button className="assistente-chip" title="Abrir" onClick={abrir}>{icone(a.mime)} {a.nome}</button>;
}
interface Acao { id: string; ferramenta: string; risco: string; status: string; resumo: string | null; previa: any; resultado: any; erro: string | null; progresso: { feitos: number; total: number; falhas: number } | null; criadoEm: string }
interface Sessao { id: string; titulo: string; ocupada: boolean; aprovacao: 'perguntar' | 'automatico'; mensagens: Mensagem[]; acoes: Acao[] }
interface Estado { ligado: boolean; voz: boolean; vozResposta: 'elevenlabs' | 'openai' | 'navegador'; nome: string; ferramentas: { nome: string; risco: string }[]; podeConfigurar: boolean; podeAutomatico: boolean }

const ROTULO: Record<string, string> = {
  consultar_inadimplentes: 'Consultou os inadimplentes',
  buscar_pessoas: 'Buscou no cadastro',
  ficha_pessoa: 'Abriu a ficha',
  maletas_atrasadas: 'Consultou as maletas atrasadas',
  resumo_negocio: 'Levantou os resultados do negócio',
  resumo_vendas: 'Consultou as vendas',
  numeros_whatsapp: 'Viu os números de WhatsApp',
  enviar_whatsapp: 'Enviar WhatsApp',
  enviar_whatsapp_em_lote: 'Envio de WhatsApp em lote',
  emitir_segunda_via: '2ª via de boleto / Pix',
  registrar_promessa: 'Registrou promessa de pagamento',
  registrar_pedido: 'Registrou pedido para a equipe',
  listar_pedidos: 'Consultou os pedidos',
  ver_regras: 'Consultou as regras',
  enviar_email: 'Enviar e-mail',
  agendar_rotina: 'Criar rotina agendada',
  gerenciar_rotinas: 'Ajustou rotinas',
  ver_agentes_whatsapp: 'Viu os agentes do WhatsApp',
  alterar_agentes_whatsapp: 'Alterar agente do WhatsApp',
  alterar_regras: 'Alterar regras',
};
const SUGESTOES = ['Como foi o mês até agora, comparado ao mês passado?', 'Quem são os inadimplentes acima de 30 dias?', 'Todo dia às 8h me manda por e-mail os inadimplentes', 'Me ajuda a criar um agente de pós-venda no WhatsApp'];
const STATUS_PEDIDO: Record<string, [string, string]> = { novo: ['alerta', 'Novo'], em_analise: ['alerta', 'Em análise'], em_andamento: ['marrom', 'Em andamento'], pronto: ['ok', 'Pronto'], recusado: ['neutra', 'Recusado'] };

/** Voz do navegador: só quando não há ElevenLabs nem OpenAI (ou se a voz do servidor falhar). */
function falarNoNavegador(texto: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(texto.replace(/https?:\/\/\S+/g, 'o link').slice(0, 1500));
    u.lang = 'pt-BR';
    const voz = s.getVoices().find((v) => v.lang?.toLowerCase().startsWith('pt'));
    if (voz) u.voice = voz;
    s.speak(u);
  } catch {
    /* navegador sem voz */
  }
}

let tocando: HTMLAudioElement | null = null;
/** Para o que estiver falando. */
export function calar() {
  tocando?.pause();
  tocando = null;
  window.speechSynthesis?.cancel();
}

/** Fala a resposta na voz configurada (ElevenLabs ou OpenAI, gerada no servidor). */
async function falar(texto: string, modo: Estado['vozResposta'] = 'navegador', exemplo?: { provedor: string; voz: string }) {
  calar();
  if (modo === 'navegador' && !exemplo) return falarNoNavegador(texto);
  try {
    const sessao = lerSessao();
    const r = await fetch(`${import.meta.env.VITE_API_URL ?? '/api'}/assistente/falar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sessao ? { authorization: `Bearer ${sessao.token}` } : {}) },
      body: JSON.stringify({ texto, ...(exemplo ?? {}) }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { mensagem?: string }).mensagem ?? 'Falha na voz');
    const url = URL.createObjectURL(await r.blob());
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    tocando = a;
    await a.play().catch(() => {
      throw new Error('O navegador não conseguiu tocar o áudio. Clique na página e tente de novo.');
    });
  } catch (e) {
    if (exemplo) throw e;
    falarNoNavegador(texto);
  }
}

export function Assistente() {
  const [aba, setAba] = useState<'conversa' | 'agentes' | 'pedidos' | 'config'>('conversa');
  const [sel, setSel] = useState<string | null>(null);
  const estado = useQuery({ queryKey: ['assistente', 'estado'], queryFn: () => api<Estado>('/assistente/estado') });
  const abas: ['conversa' | 'agentes' | 'pedidos' | 'config', string][] = [['conversa', 'Conversa'], ['agentes', 'Agentes'], ['pedidos', 'Pedidos']];
  if (estado.data?.podeConfigurar) abas.push(['config', 'Configurar']);
  return (
    <>
      <Topo eb="Sistema" titulo="Assistente" sub={`${estado.data?.nome && estado.data.nome !== 'Assistente' ? `Você está falando com ${estado.data.nome}. ` : ''}Fale, escreva ou anexe o que precisa: ele consulta o sistema, analisa os resultados com você e executa ações.`} />
      <Abas abas={abas} ativa={aba} mudar={setAba} />
      {estado.isLoading ? <Carregando /> : !estado.data?.ligado ? (
        <div className="aviso alerta">A inteligência artificial não está ligada. Cole a chave do Claude em Configurações › Integrações › Inteligência artificial.</div>
      ) : aba === 'conversa' ? <Conversas estado={estado.data} sel={sel} setSel={setSel} /> : aba === 'agentes' ? <Agentes podeAutomatico={estado.data.podeAutomatico} abrir={(id) => { setSel(id); setAba('conversa'); }} /> : aba === 'pedidos' ? <Pedidos podeMudar={estado.data.podeConfigurar} /> : <Configurar />}
    </>
  );
}

function Conversas({ estado, sel, setSel }: { estado: Estado; sel: string | null; setSel: (id: string | null) => void }) {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['assistente', 'sessoes'], queryFn: () => api<{ id: string; titulo: string; ocupada: boolean; atualizadoEm: string }[]>('/assistente/sessoes') });
  const nova = useMutation({ mutationFn: () => api<{ id: string }>('/assistente/sessoes', { corpo: {} }), onSuccess: (s) => { setSel(s.id); qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); } });
  const atual = sel ?? lista.data?.[0]?.id ?? null;
  const apagar = useMutation({
    mutationFn: (id: string) => api(`/assistente/sessoes/${id}`, { metodo: 'DELETE' }),
    onSuccess: (_r, id) => { if (id === atual) setSel(null); qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); qc.removeQueries({ queryKey: ['assistente', 'sessao', id] }); },
  });
  return (
    <div className="assistente">
      <aside className="assistente-lista">
        <button className="botao" onClick={() => nova.mutate()} disabled={nova.isPending}>Nova conversa</button>
        {lista.data?.map((s) => (
          <div key={s.id} className={`assistente-item ${s.id === atual ? 'ativo' : ''}`} onClick={() => setSel(s.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(s.id)}>
            <span>{s.titulo}</span>
            <small className="muted">{s.ocupada ? 'trabalhando…' : dataHora(s.atualizadoEm)}</small>
            <button
              className="assistente-excluir"
              title="Excluir conversa"
              aria-label={`Excluir a conversa ${s.titulo}`}
              disabled={s.ocupada || apagar.isPending}
              onClick={(e) => { e.stopPropagation(); if (window.confirm(`Excluir a conversa "${s.titulo}"? Não dá para desfazer.`)) apagar.mutate(s.id); }}
            >
              🗑
            </button>
          </div>
        ))}
        {apagar.error && <Erro erro={apagar.error} />}
      </aside>
      {atual ? <Chat key={atual} id={atual} estado={estado} aoApagar={() => setSel(null)} /> : (
        <div className="cartao vazio">
          <p>Comece uma conversa. Por exemplo:</p>
          {SUGESTOES.map((t) => <p key={t} className="muted">“{t}”</p>)}
          <button className="botao" onClick={() => nova.mutate()}>Nova conversa</button>
        </div>
      )}
    </div>
  );
}

function Chat({ id, estado, aoApagar }: { id: string; estado: Estado; aoApagar: () => void }) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState('');
  const [pendentes, setPendentes] = useState<Pendente[]>([]);
  const [arrastando, setArrastando] = useState(false);
  const seletor = useRef<HTMLInputElement>(null);
  const [ouvir, setOuvir] = useState(() => localStorage.getItem('aritana.assistente.ouvir') === '1');
  const fim = useRef<HTMLDivElement>(null);
  const faladas = useRef<Set<string> | null>(null);
  const s = useQuery({
    queryKey: ['assistente', 'sessao', id],
    queryFn: () => api<Sessao>(`/assistente/sessoes/${id}`),
    refetchInterval: (q) => {
      const d = q.state.data as Sessao | undefined;
      return d && (d.ocupada || d.acoes.some((a) => a.status === 'executando')) ? 1200 : false;
    },
  });
  const enviar = useMutation({
    mutationFn: (d: { texto: string; origem: 'texto' | 'voz'; anexos: string[] }) => api(`/assistente/sessoes/${id}/mensagens`, { corpo: d }),
    onSuccess: () => { setTexto(''); setPendentes((p) => { p.forEach((x) => x.previa && URL.revokeObjectURL(x.previa)); return []; }); qc.invalidateQueries({ queryKey: ['assistente', 'sessao', id] }); qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); },
  });
  const decidir = useMutation({
    mutationFn: (d: { acaoId: string; confirmar: boolean }) => api(`/assistente/acoes/${d.acaoId}/${d.confirmar ? 'confirmar' : 'cancelar'}`, { corpo: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assistente', 'sessao', id] }),
  });
  const apagar = useMutation({ mutationFn: () => api(`/assistente/sessoes/${id}`, { metodo: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); aoApagar(); } });
  const aprovacao = useMutation({ mutationFn: (modo: 'perguntar' | 'automatico') => api(`/assistente/sessoes/${id}`, { metodo: 'PATCH', corpo: { aprovacao: modo } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['assistente', 'sessao', id] }) });
  const mudarAprovacao = (modo: 'perguntar' | 'automatico') => {
    if (modo === 'automatico' && !window.confirm('Aprovar automaticamente?\n\nNesta conversa, o assistente vai mandar mensagens, emitir cobranças e alterar configurações SEM pedir sua confirmação (sempre dentro das suas permissões). Você pode voltar para "Pedir aprovação" a qualquer momento.')) return;
    aprovacao.mutate(modo);
  };

  // Mensagens e ações na ordem em que aconteceram.
  const linha = useMemo(() => {
    if (!s.data) return [];
    const itens: ({ tipo: 'msg'; m: Mensagem } | { tipo: 'acao'; a: Acao })[] = [
      ...s.data.mensagens.filter((m) => m.origem !== 'sistema').map((m) => ({ tipo: 'msg' as const, m })),
      ...s.data.acoes.map((a) => ({ tipo: 'acao' as const, a })),
    ];
    return itens.sort((x, y) => (x.tipo === 'msg' ? x.m.criadoEm : x.a.criadoEm).localeCompare(y.tipo === 'msg' ? y.m.criadoEm : y.a.criadoEm));
  }, [s.data]);

  // Terminou de trabalhar: atualiza a lista de conversas (título e situação).
  const ocupada = s.data?.ocupada;
  useEffect(() => {
    if (ocupada === false) qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] });
  }, [ocupada, qc]);

  // Rola para o fim e, com "ouvir" ligado, lê as respostas novas.
  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    if (!s.data) return;
    const respostas = s.data.mensagens.filter((m) => m.papel === 'assistant');
    if (!faladas.current) {
      faladas.current = new Set(respostas.map((m) => m.id));
      return;
    }
    const novas = respostas.filter((m) => !faladas.current!.has(m.id));
    novas.forEach((m) => faladas.current!.add(m.id));
    // Conversa por voz: se a pessoa falou, ele responde falando (mesmo com "Ouvir respostas" desligado).
    const falouPorVoz = s.data.mensagens.filter((m) => m.papel === 'user' && (m.origem === 'voz' || m.origem === 'texto')).at(-1)?.origem === 'voz';
    if ((ouvir || falouPorVoz) && novas.length) void falar(novas.map((m) => m.fala ?? m.texto).join(' '), estado.vozResposta);
  }, [s.data, ouvir, estado.vozResposta]);

  const enviandoAnexo = pendentes.some((p) => !p.id && !p.erro);
  const prontos = pendentes.filter((p) => p.id).map((p) => p.id!);
  const mandar = (t: string, origem: 'texto' | 'voz') => {
    if ((!t.trim() && !prontos.length) || s.data?.ocupada || enviandoAnexo) return;
    enviar.mutate({ texto: t.trim(), origem, anexos: prontos });
  };

  /** Anexa arquivos (clipe, Ctrl+V ou arrastar): sobe na hora e mostra a prévia. */
  const adicionar = (arquivos: File[]) => {
    for (const f of arquivos.slice(0, 10 - pendentes.length)) {
      const chave = `${Date.now()}-${Math.random()}`;
      const nome = f.name && f.name !== 'image.png' ? f.name : `colado-${new Date().toLocaleTimeString('pt-BR').replace(/:/g, '')}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
      const item: Pendente = { chave, nome, mime: f.type, tamanho: f.size, previa: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      if (f.size > 18_000_000) item.erro = 'Grande demais (máximo de 18 MB)';
      setPendentes((p) => [...p, item]);
      if (item.erro) continue;
      const leitor = new FileReader();
      leitor.onload = async () => {
        try {
          const r = await api<{ id: string; leitura: string }>('/assistente/anexos', { corpo: { nome, mime: f.type, conteudo: String(leitor.result).split(',')[1] ?? '' } });
          setPendentes((p) => p.map((x) => (x.chave === chave ? { ...x, id: r.id, leitura: r.leitura } : x)));
        } catch (e) {
          setPendentes((p) => p.map((x) => (x.chave === chave ? { ...x, erro: (e as Error).message } : x)));
        }
      };
      leitor.onerror = () => setPendentes((p) => p.map((x) => (x.chave === chave ? { ...x, erro: 'Não consegui ler o arquivo.' } : x)));
      leitor.readAsDataURL(f);
    }
  };
  const tirar = (chave: string) => setPendentes((p) => p.filter((x) => { if (x.chave === chave && x.previa) URL.revokeObjectURL(x.previa); return x.chave !== chave; }));

  if (s.isLoading) return <Carregando />;
  if (!s.data) return <Erro erro={s.error} />;
  return (
    <section
      className={`assistente-chat cartao ${arrastando ? 'arrastando' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setArrastando(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setArrastando(false); }}
      onDrop={(e) => { e.preventDefault(); setArrastando(false); adicionar([...e.dataTransfer.files]); }}
    >
      <div className="assistente-topo">
        <b>{s.data.titulo}</b>
        <span className="espaco" />
        <select
          className={`assistente-aprovacao ${s.data.aprovacao === 'automatico' ? 'auto' : ''}`}
          value={s.data.aprovacao}
          disabled={aprovacao.isPending}
          title={estado.podeAutomatico ? 'Como as ações que mandam, cobram ou alteram são aprovadas' : 'Só a gestão pode ligar a aprovação automática'}
          onChange={(e) => mudarAprovacao(e.target.value as 'perguntar' | 'automatico')}
        >
          <option value="perguntar">🛡 Pedir aprovação</option>
          <option value="automatico" disabled={!estado.podeAutomatico}>⚡ Aprovar automaticamente{estado.podeAutomatico ? '' : ' (sem permissão)'}</option>
        </select>
        <label className="muted assistente-ouvir">
          <input type="checkbox" checked={ouvir} onChange={(e) => { setOuvir(e.target.checked); localStorage.setItem('aritana.assistente.ouvir', e.target.checked ? '1' : '0'); if (!e.target.checked) calar(); }} /> Ouvir respostas
        </label>
        <button className="botao claro pequeno" onClick={() => window.confirm('Excluir esta conversa? Não dá para desfazer.') && apagar.mutate()} disabled={s.data.ocupada}>Excluir conversa</button>
      </div>
      <div className="assistente-mensagens">
        {linha.length === 0 && (
          <div className="assistente-sugestoes">
            {SUGESTOES.map((t) => <button key={t} className="botao claro" onClick={() => mandar(t, 'texto')}>{t}</button>)}
          </div>
        )}
        {linha.map((x) => (x.tipo === 'msg' ? (
          <div key={x.m.id} className={`fala ${x.m.papel === 'user' ? 'minha' : 'dele'}`}>
            {x.m.anexos?.length > 0 && <div className="assistente-anexos-msg">{x.m.anexos.map((a) => <AnexoNaMensagem key={a.id} a={a} />)}</div>}
            {x.m.origem === 'voz' && <span className="muted" title="Falado">🎤 </span>}
            {x.m.texto}
            {x.m.papel === 'assistant' && <button className="assistente-falar" title="Ouvir" onClick={() => void falar(x.m.fala ?? x.m.texto, estado.vozResposta)}>🔊</button>}
          </div>
        ) : (
          <CartaoAcao key={x.a.id} a={x.a} decidir={(confirmar) => decidir.mutate({ acaoId: x.a.id, confirmar })} ocupado={decidir.isPending} />
        )))}
        {s.data.ocupada && <div className="fala dele muted">{estado.nome} está trabalhando…</div>}
        {decidir.error && <Erro erro={decidir.error} />}
        <div ref={fim} />
      </div>
      {enviar.error && <Erro erro={enviar.error} />}
      {aprovacao.error && <Erro erro={aprovacao.error} />}
      {s.data.aprovacao === 'automatico' && <div className="assistente-faixa-auto">⚡ Aprovação automática ligada: as ações são executadas sem pedir confirmação.</div>}
      {pendentes.length > 0 && (
        <div className="assistente-pendentes">
          {pendentes.map((p) => (
            <div key={p.chave} className={`assistente-pendente ${p.erro ? 'com-erro' : ''}`} title={p.erro ?? p.leitura ?? 'Enviando…'}>
              {p.previa ? <img src={p.previa} alt="" /> : <span className="assistente-pendente-icone">{icone(p.mime)}</span>}
              <div className="assistente-pendente-texto">
                <span>{p.nome}</span>
                <small>{p.erro ? p.erro : p.id ? `${tamanhoLegivel(p.tamanho)} · ${p.leitura}` : 'enviando…'}</small>
              </div>
              <button className="assistente-pendente-tirar" aria-label={`Tirar ${p.nome}`} onClick={() => tirar(p.chave)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="assistente-entrada">
        <input ref={seletor} type="file" multiple hidden accept="image/*,application/pdf,video/*,audio/*,.docx,.xlsx,.csv,.txt" onChange={(e) => { adicionar([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button className="botao claro assistente-clipe" title="Anexar arquivo (ou cole com Ctrl+V, ou arraste para cá)" aria-label="Anexar arquivo" disabled={pendentes.length >= 10} onClick={() => seletor.current?.click()}>📎</button>
        <textarea
          onPaste={(e) => {
            const arquivos = [...e.clipboardData.files];
            if (arquivos.length) {
              e.preventDefault();
              adicionar(arquivos);
            }
          }}
          rows={2}
          value={texto}
          placeholder={s.data.ocupada ? 'Aguarde terminar…' : 'Escreva, fale ou cole/arraste arquivos (Ctrl+V)'}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mandar(texto, 'texto'); } }}
        />
        {estado.voz && <Microfone desativado={s.data.ocupada || enviar.isPending} aoTranscrever={(t) => mandar(t, 'voz')} />}
        <button className="botao" disabled={(!texto.trim() && !prontos.length) || s.data.ocupada || enviar.isPending || enviandoAnexo} onClick={() => mandar(texto, 'texto')}>Enviar</button>
      </div>
    </section>
  );
}

function CartaoAcao({ a, decidir, ocupado }: { a: Acao; decidir: (confirmar: boolean) => void; ocupado: boolean }) {
  const [aberto, setAberto] = useState(false);
  const nome = ROTULO[a.ferramenta] ?? a.ferramenta;
  if (a.risco !== 'confirmar') {
    return (
      <div className={`assistente-passo ${a.status}`}>
        <button className="link" onClick={() => setAberto(!aberto)}>{a.status === 'executando' ? '⏳' : a.status === 'erro' ? '⚠️' : '✓'} {nome}</button>
        {a.erro && <span className="erro-texto"> {a.erro}</span>}
        {aberto && a.resultado && <pre className="assistente-json">{JSON.stringify(a.resultado, null, 2).slice(0, 6000)}</pre>}
      </div>
    );
  }
  const previa: any[] = Array.isArray(a.previa) ? a.previa : [];
  const p = a.progresso;
  return (
    <div className={`cartao assistente-acao ${a.status}`}>
      <div className="assistente-acao-topo">
        <b>{nome}</b>
        <span className={`etiqueta ${a.status === 'concluida' ? 'ok' : a.status === 'erro' ? 'erro' : a.status === 'cancelada' ? 'neutra' : 'alerta'}`}>{{ aguardando: 'Esperando sua confirmação', executando: 'Executando', concluida: a.resumo?.includes('(aprovado automaticamente)') ? 'Concluída · automática' : 'Concluída', cancelada: 'Cancelada', erro: 'Erro' }[a.status] ?? a.status}</span>
      </div>
      {a.resumo && <p>{a.resumo}</p>}
      {previa.length > 0 && (
        <>
          <button className="link" onClick={() => setAberto(!aberto)}>{aberto ? 'Esconder' : 'Ver'} {previa.length === 1 ? 'a mensagem' : `as ${previa.length} mensagens`}</button>
          {aberto && (
            <div className="assistente-previa">
              {previa.slice(0, 100).map((i, n) => (
                <div key={n} className={i.problema ? 'com-problema' : ''}>
                  <b>{i.nome ?? i.telefone}</b> <span className="muted">{i.telefone}</span>
                  {i.problema ? <div className="erro-texto">Fica de fora: {i.problema}</div> : <div className="assistente-texto">{i.texto}</div>}
                </div>
              ))}
              {previa.length > 100 && <p className="muted">e mais {previa.length - 100}…</p>}
            </div>
          )}
        </>
      )}
      {p && p.total > 0 && (
        <div className="assistente-progresso">
          <div className="barra"><div style={{ width: `${Math.round((p.feitos / p.total) * 100)}%` }} /></div>
          <small className="muted">{p.feitos} de {p.total}{p.falhas ? ` · ${p.falhas} falha(s)` : ''}</small>
        </div>
      )}
      {a.status === 'concluida' && a.resultado?.link && <p><a href={a.resultado.link} target="_blank" rel="noreferrer">Abrir boleto/Pix</a></p>}
      {a.erro && <p className="erro-texto">{a.erro}</p>}
      {a.status === 'aguardando' && (
        <div className="acoes-linha">
          <button className="botao" disabled={ocupado} onClick={() => decidir(true)}>Confirmar</button>
          <button className="botao claro" disabled={ocupado} onClick={() => decidir(false)}>Cancelar</button>
          <small className="muted">ou fale “pode” / “cancela”</small>
        </div>
      )}
    </div>
  );
}

/** Grava pelo microfone, transcreve no servidor e entrega o texto. */
function Microfone({ desativado, aoTranscrever }: { desativado: boolean; aoTranscrever: (t: string) => void }) {
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<unknown>(null);
  const [transcrevendo, setTranscrevendo] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const partes = useRef<Blob[]>([]);

  const iniciar = async () => {
    setErro(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tipo = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
      const r = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined);
      partes.current = [];
      r.ondataavailable = (e) => e.data.size && partes.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(partes.current, { type: r.mimeType || 'audio/webm' });
        if (blob.size < 1500) return;
        setTranscrevendo(true);
        try {
          const b64 = await new Promise<string>((ok, falha) => {
            const f = new FileReader();
            f.onload = () => ok(String(f.result).split(',')[1] ?? '');
            f.onerror = () => falha(f.error);
            f.readAsDataURL(blob);
          });
          const { texto } = await api<{ texto: string }>('/assistente/transcrever', { corpo: { audio: b64, mime: blob.type } });
          if (texto.trim()) aoTranscrever(texto);
        } catch (e) {
          setErro(e);
        } finally {
          setTranscrevendo(false);
        }
      };
      r.start();
      rec.current = r;
      setGravando(true);
    } catch {
      setErro(new Error('Não consegui usar o microfone. Libere o acesso no navegador.'));
    }
  };
  const parar = () => {
    rec.current?.stop();
    rec.current = null;
    setGravando(false);
  };
  return (
    <div className="assistente-mic">
      <button className={`botao ${gravando ? 'gravando' : 'claro'}`} disabled={desativado || transcrevendo} onClick={gravando ? parar : iniciar} title={gravando ? 'Parar e enviar' : 'Falar'}>
        {transcrevendo ? '…' : gravando ? '■ Parar' : '🎤 Falar'}
      </button>
      {erro != null && <Erro erro={erro} />}
    </div>
  );
}

interface Especialista { id: string; funcao: string; nome: string; quando: string; instrucoes: string; ativo: boolean; ordem: number }
interface PainelAgentes { rotinas: Rotina[]; whatsapp: { ligado: boolean; nome: string; maxRespostas: number; especialistas: Especialista[] } | null; podeEditarWhatsapp: boolean }

/** Todos os agentes numa lista: os agendados (rotinas) e os que atendem no WhatsApp, com o horário e o que cada um faz. */
function Agentes({ abrir, podeAutomatico }: { abrir: (sessaoId: string) => void; podeAutomatico: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['assistente', 'agentes'], queryFn: () => api<PainelAgentes>('/assistente/agentes'), refetchInterval: 15_000 });
  const criar = useMutation({
    mutationFn: async (pedido: string) => {
      const s = await api<{ id: string }>('/assistente/sessoes', { corpo: {} });
      await api(`/assistente/sessoes/${s.id}/mensagens`, { corpo: { texto: pedido } });
      return s.id;
    },
    onSuccess: (id) => { qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); abrir(id); },
  });
  const especialista = useMutation({
    mutationFn: (d: { e: Especialista; o: 'ligar' | 'duplicar' }) => (d.o === 'duplicar' ? api(`/crm/ia-agentes/${d.e.id}/duplicar`, { corpo: {} }) : api(`/crm/ia-agentes/${d.e.id}`, { metodo: 'PATCH', corpo: { ativo: !d.e.ativo } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['assistente', 'agentes'] }); qc.invalidateQueries({ queryKey: ['crm', 'ia-agente'] }); },
  });
  if (q.isLoading) return <Carregando />;
  const d = q.data!;
  const totalWhats = d.whatsapp?.especialistas.length ?? 0;
  return (
    <div className="coluna" style={{ marginTop: 14 }}>
      <div className="assistente-agentes-topo">
        <span className="muted">{d.rotinas.length} agente(s) agendado(s){d.whatsapp ? ` · ${totalWhats} agente(s) de atendimento no WhatsApp` : ''}</span>
        <span className="espaco" />
        <button className="botao claro" disabled={criar.isPending} onClick={() => criar.mutate('Quero criar um agente agendado (uma rotina que trabalha sozinha). Me ajuda a montar?')}>+ Agente agendado</button>
        {d.whatsapp && d.podeEditarWhatsapp && <button className="botao claro" disabled={criar.isPending} onClick={() => criar.mutate('Quero criar um novo agente de atendimento no WhatsApp. Me ajuda a montar?')}>+ Agente do WhatsApp</button>}
      </div>
      {criar.error && <Erro erro={criar.error} />}

      <div className="secao">Agentes agendados <small className="muted">trabalham sozinhos no horário ou a cada X tempo</small></div>
      <Rotinas podeAutomatico={podeAutomatico} abrir={abrir} />

      {d.whatsapp && (
        <>
          <div className="secao">Agentes de atendimento no WhatsApp <small className="muted">respondem clientes e revendedoras quando chega mensagem</small></div>
          <div className="cartao">
            <div className="assistente-acao-topo">
              <div><b>Recepção{d.whatsapp.nome ? ` · se apresenta como ${d.whatsapp.nome}` : ''}</b><div className="muted">Lê a conversa e passa para o especialista do assunto · até {d.whatsapp.maxRespostas} respostas seguidas, depois chama a equipe</div></div>
              <span className={`etiqueta ${d.whatsapp.ligado ? 'ok' : 'neutra'}`}>{d.whatsapp.ligado ? 'Atendendo' : 'Desligado'}</span>
            </div>
            {totalWhats === 0 ? <p className="muted">Nenhum especialista: um agente só atende tudo com as instruções gerais.</p> : (
              <table className="tabela" style={{ marginTop: 10 }}>
                <thead><tr><th>Agente</th><th>Quando atende</th><th>O que faz</th><th>Situação</th><th></th></tr></thead>
                <tbody>
                  {d.whatsapp.especialistas.map((e) => (
                    <tr key={e.id} style={e.ativo ? undefined : { opacity: 0.6 }}>
                      <td><b>{e.nome}</b><div className="muted" style={{ fontSize: 12 }}>{e.funcao}</div></td>
                      <td style={{ fontSize: 13 }}>{e.quando}</td>
                      <td style={{ fontSize: 13 }}>{e.instrucoes ? `${e.instrucoes.slice(0, 180)}${e.instrucoes.length > 180 ? '…' : ''}` : <span className="muted">usa só as instruções gerais</span>}</td>
                      <td><span className={`etiqueta ${e.ativo ? 'ok' : 'neutra'}`}>{e.ativo ? 'Ligado' : 'Desligado'}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {d.podeEditarWhatsapp && <button className="botao claro pequeno" disabled={especialista.isPending} onClick={() => especialista.mutate({ e, o: 'ligar' })}>{e.ativo ? 'Desligar' : 'Ligar'}</button>}{' '}
                        {d.podeEditarWhatsapp && <button className="botao claro pequeno" disabled={especialista.isPending} onClick={() => especialista.mutate({ e, o: 'duplicar' })}>Duplicar</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {especialista.error && <Erro erro={especialista.error} />}
            <p className="muted" style={{ marginBottom: 0 }}>Para editar as instruções e o conhecimento de cada um: <Link to="/crm?aba=configurar">CRM › Configurar</Link>, ou peça na conversa.</p>
          </div>
        </>
      )}
    </div>
  );
}

interface Rotina { id: string; titulo: string; instrucao: string; quando: string; ativa: boolean; aprovacao: 'perguntar' | 'automatico'; proximaEm: string; ultimaEm: string | null; ultimaSessaoId: string | null; ultimoErro: string | null; emails: string[] }

/** Agentes agendados: rodam sozinhos no horário ou a cada X tempo. Criados pela conversa ("todo dia às 8h…"). */
function Rotinas({ abrir, podeAutomatico }: { abrir: (sessaoId: string) => void; podeAutomatico: boolean }) {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['assistente', 'rotinas'], queryFn: () => api<Rotina[]>('/assistente/rotinas'), refetchInterval: 15_000 });
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['assistente', 'rotinas'] }); qc.invalidateQueries({ queryKey: ['assistente', 'agentes'] }); qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); };
  const acao = useMutation({
    mutationFn: (d: { r: Rotina; o: 'rodar' | 'duplicar' | 'pausar' | 'retomar' | 'excluir' | 'automatico' | 'perguntar' }) =>
      d.o === 'automatico' || d.o === 'perguntar' ? api(`/assistente/rotinas/${d.r.id}`, { metodo: 'PATCH', corpo: { aprovacao: d.o } })
      : d.o === 'rodar' ? api(`/assistente/rotinas/${d.r.id}/executar`, { corpo: {} })
        : d.o === 'duplicar' ? api(`/assistente/rotinas/${d.r.id}/duplicar`, { corpo: {} })
          : d.o === 'excluir' ? api(`/assistente/rotinas/${d.r.id}`, { metodo: 'DELETE' })
            : api(`/assistente/rotinas/${d.r.id}`, { metodo: 'PATCH', corpo: { ativa: d.o === 'retomar' } }),
    onSuccess: atualizar,
  });
  if (lista.isLoading) return <Carregando />;
  if (!lista.data?.length) return <div className="cartao vazio">Nenhum agente agendado ainda. Peça na conversa, por exemplo: “todo dia às 8h me manda por e-mail os inadimplentes” ou “de hora em hora, das 8h às 18h, me avise se entrou candidata nova”.</div>;
  return (
    <div className="coluna">
      {lista.data.map((r) => (
        <div key={r.id} className={`cartao assistente-rotina ${r.ativa ? '' : 'pausada'}`}>
          <div className="assistente-acao-topo">
            <div><b>{r.titulo}</b><div className="muted">{r.quando}{r.emails.length ? ` · e-mail para ${r.emails.join(', ')}` : ''}</div></div>
            <span>
              {r.aprovacao === 'automatico' && <span className="etiqueta alerta" title="Executa tudo sem esperar confirmação">⚡ Automática</span>}{' '}
              <span className={`etiqueta ${r.ativa ? 'ok' : 'neutra'}`}>{r.ativa ? 'Ativa' : 'Pausada'}</span>
            </span>
          </div>
          <p className="assistente-texto">{r.instrucao}</p>
          <div className="muted" style={{ fontSize: 13 }}>
            {r.ativa && <>Próxima: {dataHora(r.proximaEm)} · </>}
            {r.ultimaEm ? <>Última: {dataHora(r.ultimaEm)}{r.ultimaSessaoId && <> · <button className="link-texto" onClick={() => abrir(r.ultimaSessaoId!)}>ver o que ele fez</button></>}</> : 'Ainda não rodou'}
          </div>
          {r.ultimoErro && <div className="aviso alerta" style={{ marginTop: 8 }}>{r.ultimoErro}</div>}
          <div className="acoes-linha">
            <button className="botao pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ r, o: 'rodar' })}>Rodar agora</button>
            <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ r, o: 'duplicar' })}>Duplicar</button>
            <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ r, o: r.ativa ? 'pausar' : 'retomar' })}>{r.ativa ? 'Pausar' : 'Retomar'}</button>
            <select
              className={`assistente-aprovacao ${r.aprovacao === 'automatico' ? 'auto' : ''}`}
              value={r.aprovacao}
              disabled={acao.isPending}
              onChange={(e) => {
                const o = e.target.value as 'perguntar' | 'automatico';
                if (o === 'automatico' && !window.confirm(`Aprovar automaticamente a rotina "${r.titulo}"?\n\nEla vai mandar WhatsApp, emitir cobranças e alterar o que a instrução pedir, sozinha, sem esperar sua confirmação.`)) return;
                acao.mutate({ r, o });
              }}
            >
              <option value="perguntar">🛡 Pedir aprovação</option>
              <option value="automatico" disabled={!podeAutomatico}>⚡ Aprovar automaticamente{podeAutomatico ? '' : ' (sem permissão)'}</option>
            </select>
            <button className="botao perigo pequeno" disabled={acao.isPending} onClick={() => window.confirm(`Excluir a rotina "${r.titulo}"?`) && acao.mutate({ r, o: 'excluir' })}>Excluir</button>
          </div>
        </div>
      ))}
      {acao.error && <Erro erro={acao.error} />}
      <p className="muted">Para mudar horário, intervalo, dias ou o que o agente faz, peça na conversa (ex.: “muda a rotina dos inadimplentes para dias úteis às 7h30”). A cópia nasce pausada para você ajustar.</p>
    </div>
  );
}

function Pedidos({ podeMudar }: { podeMudar: boolean }) {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['assistente', 'pedidos'], queryFn: () => api<any[]>('/assistente/pedidos') });
  const mudar = useMutation({ mutationFn: (d: { id: string; status: string }) => api(`/assistente/pedidos/${d.id}`, { metodo: 'PATCH', corpo: { status: d.status } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['assistente', 'pedidos'] }) });
  const [sel, setSel] = useState<string | null>(null);
  if (lista.isLoading) return <Carregando />;
  if (!lista.data?.length) return <div className="cartao vazio">Nenhum pedido ainda. Quando você pedir algo que o sistema ainda não faz, o assistente monta a especificação e o plano e registra aqui (e abre um chamado de melhoria para a Wide).</div>;
  return (
    <div className="coluna">
      <table className="tabela">
        <thead><tr><th>Nº</th><th>Pedido</th><th>Tipo</th><th>Quem pediu</th><th>Chamado</th><th>Data</th><th>Situação</th></tr></thead>
        <tbody>
          {lista.data.map((p) => {
            const [k, t] = STATUS_PEDIDO[p.status] ?? ['neutra', p.status];
            return (
              <tr key={p.id} className="clicavel" onClick={() => setSel(sel === p.id ? null : p.id)}>
                <td><b>{p.numero}</b></td><td>{p.titulo}</td><td>{p.tipo === 'configurar' ? 'Configuração' : 'Desenvolvimento'}</td><td>{p.autor ?? '—'}</td><td>{p.chamado ? `nº ${p.chamado}` : '—'}</td><td>{dataHora(p.criadoEm)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {podeMudar ? (
                    <select value={p.status} onChange={(e) => mudar.mutate({ id: p.id, status: e.target.value })}>{Object.entries(STATUS_PEDIDO).map(([v, [, r]]) => <option key={v} value={v}>{r}</option>)}</select>
                  ) : <span className={`etiqueta ${k}`}>{t}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sel && (() => {
        const p = lista.data!.find((x) => x.id === sel)!;
        return (
          <div className="cartao">
            <h3>Pedido nº {p.numero}: {p.titulo}</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{p.especificacao}</p>
            <div className="secao">Plano</div>
            <ol>{(p.plano as string[]).map((x, i) => <li key={i}>{x}</li>)}</ol>
          </div>
        );
      })()}
      {mudar.error && <Erro erro={mudar.error} />}
    </div>
  );
}

interface ConfigTela { nome: string; instrucoes: string; aprovacaoAutomatica: 'gestao' | 'todos' | 'ninguem'; voz: 'automatica' | 'elevenlabs' | 'openai' | 'navegador'; vozElevenlabs: string; vozOpenai: string }
interface ConfigResposta extends ConfigTela { opcoes: { elevenlabs: { id: string; nome: string }[]; openai: { id: string; nome: string }[] }; chaves: { elevenlabs: boolean; openai: boolean } }

function Configurar() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['assistente', 'config'], queryFn: () => api<ConfigResposta>('/assistente/config') });
  const [f, setF] = useState<ConfigTela | null>(null);
  const [outra, setOutra] = useState(false);
  const [exemplo, setExemplo] = useState<{ tocando: boolean; erro: unknown }>({ tocando: false, erro: null });
  const salvar = useMutation({ mutationFn: (d: ConfigTela) => api('/assistente/config', { metodo: 'PUT', corpo: d }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['assistente'] }); } });
  if (cfg.isLoading) return <Carregando />;
  const c = cfg.data!;
  const v: ConfigTela = f ?? { nome: c.nome, instrucoes: c.instrucoes, aprovacaoAutomatica: c.aprovacaoAutomatica, voz: c.voz, vozElevenlabs: c.vozElevenlabs, vozOpenai: c.vozOpenai };
  const provedor = v.voz === 'automatica' ? (c.chaves.elevenlabs ? 'elevenlabs' : c.chaves.openai ? 'openai' : 'navegador') : v.voz;
  const personalizada = outra || !c.opcoes.elevenlabs.some((o) => o.id === v.vozElevenlabs);
  const ouvirExemplo = async () => {
    setExemplo({ tocando: true, erro: null });
    try {
      const texto = `Oi! Eu sou ${v.nome || 'o assistente'}. Este mês as vendas subiram doze por cento em relação ao mês passado, e temos vinte e três pessoas com parcelas em atraso. Quer que eu mande uma mensagem para elas?`;
      if (provedor === 'navegador') falarNoNavegador(texto);
      else await falar(texto, provedor, { provedor, voz: provedor === 'elevenlabs' ? v.vozElevenlabs : v.vozOpenai });
      setExemplo({ tocando: false, erro: null });
    } catch (e) {
      setExemplo({ tocando: false, erro: e });
    }
  };
  return (
    <div className="cartao form">
      <div className="l4 aviso">
        Aqui você configura <b>o próprio assistente</b>: o que conversa com a equipe nesta tela. <b>Não é aqui que se criam agentes.</b> Agentes que atendem clientes no WhatsApp ficam em <b>CRM › Configurar › Especialistas</b>; agentes que trabalham sozinhos por horário ficam na aba <b>Rotinas</b>. Os dois você também cria pedindo na conversa (ex.: “me ajuda a criar um agente de pós-venda”).
      </div>
      <div className="secao l4">Identidade</div>
      <Campo rotulo="Nome do assistente" className="l2" ajuda="O nome com que ele se apresenta para a equipe aqui no sistema (ex.: Cláudio). Não muda o nome do agente do WhatsApp, que é configurado no CRM."><input value={v.nome} onChange={(e) => setF({ ...v, nome: e.target.value })} placeholder="Ex.: Cláudio" /></Campo>
      <Campo rotulo="Orientações da empresa" className="l4" ajuda="Tom, prioridades e o que ele nunca deve fazer. Ex.: “Em cobrança, sempre ofereça a 2ª via com o vencimento para daqui a 3 dias.”">
        <textarea rows={6} value={v.instrucoes} onChange={(e) => setF({ ...v, instrucoes: e.target.value })} />
      </Campo>
      <div className="secao l4">Aprovação das ações</div>
      <Campo rotulo="Quem pode usar “Aprovar automaticamente”" className="l2" ajuda="No modo automático, o assistente manda mensagens, emite cobranças e altera configurações sem pedir confirmação (sempre dentro das permissões de quem pediu). Cada pessoa liga ou desliga na conversa e em cada rotina.">
        <select value={v.aprovacaoAutomatica} onChange={(e) => setF({ ...v, aprovacaoAutomatica: e.target.value as ConfigTela['aprovacaoAutomatica'] })}>
          <option value="gestao">Só a gestão (quem edita as Configurações)</option>
          <option value="todos">Todos que usam o Assistente</option>
          <option value="ninguem">Ninguém (sempre pede confirmação)</option>
        </select>
      </Campo>
      <div className="secao l4">Voz das respostas</div>
      <Campo rotulo="Quem fala">
        <select value={v.voz} onChange={(e) => setF({ ...v, voz: e.target.value as ConfigTela['voz'] })}>
          <option value="automatica">Automática (a melhor disponível)</option>
          <option value="elevenlabs" disabled={!c.chaves.elevenlabs}>ElevenLabs (mais natural){c.chaves.elevenlabs ? '' : ' · falta a chave'}</option>
          <option value="openai" disabled={!c.chaves.openai}>OpenAI{c.chaves.openai ? '' : ' · falta a chave'}</option>
          <option value="navegador">Voz do navegador (grátis, robótica)</option>
        </select>
      </Campo>
      {provedor === 'elevenlabs' && (
        <Campo rotulo="Voz da ElevenLabs" className="l2" ajuda={personalizada ? 'Cole o Voice ID (ElevenLabs › Voices › a voz › copiar ID). Se der "voz não disponível", adicione a voz em My Voices na sua conta.' : undefined}>
          {personalizada ? (
            <div className="acoes-linha"><input value={v.vozElevenlabs} onChange={(e) => setF({ ...v, vozElevenlabs: e.target.value.trim() })} placeholder="Voice ID" /><button className="botao claro pequeno" onClick={() => { setOutra(false); setF({ ...v, vozElevenlabs: c.opcoes.elevenlabs[0].id }); }}>Voltar à lista</button></div>
          ) : (
            <select value={v.vozElevenlabs} onChange={(e) => (e.target.value === '__outra' ? setOutra(true) : setF({ ...v, vozElevenlabs: e.target.value }))}>
              {c.opcoes.elevenlabs.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
              <option value="__outra">Outra voz (colar o ID)…</option>
            </select>
          )}
        </Campo>
      )}
      {provedor === 'openai' && (
        <Campo rotulo="Voz da OpenAI" className="l2">
          <select value={v.vozOpenai} onChange={(e) => setF({ ...v, vozOpenai: e.target.value })}>{c.opcoes.openai.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</select>
        </Campo>
      )}
      <div className="l4 acoes-linha">
        <button className="botao claro" disabled={exemplo.tocando} onClick={ouvirExemplo}>{exemplo.tocando ? 'Gerando…' : '🔊 Ouvir exemplo'}</button>
        {!c.chaves.elevenlabs && <small className="muted">Para a voz mais natural, cole a chave da ElevenLabs em Configurações › Integrações › Inteligência artificial.</small>}
      </div>
      {exemplo.erro != null && <div className="l4"><Erro erro={exemplo.erro} /></div>}
      <div className="l4">
        <p className="muted">Ele só faz o que o usuário logado pode fazer (as mesmas permissões das telas). Mensagens, cobranças e envios em lote sempre passam pela confirmação de quem pediu. Para mudar o espaço entre mensagens do envio em lote, use a chave ASSISTENTE_INTERVALO_LOTE_S (padrão: 20 segundos).</p>
        {salvar.error && <Erro erro={salvar.error} />}
        {salvar.isSuccess && !f && <div className="aviso ok">Salvo.</div>}
        <button className="botao" disabled={salvar.isPending || !v.nome.trim()} onClick={() => salvar.mutate(v, { onSuccess: () => { setF(null); setOutra(false); } })}>Salvar</button>
      </div>
    </div>
  );
}
