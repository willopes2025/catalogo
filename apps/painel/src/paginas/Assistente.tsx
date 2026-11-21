import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { dataHora } from '../formato';
import { Abas, Campo, Carregando, Erro, Topo } from '../componentes/ui';
import './assistente.css';

interface Mensagem { id: string; papel: 'user' | 'assistant'; texto: string; origem: string | null; criadoEm: string }
interface Acao { id: string; ferramenta: string; risco: string; status: string; resumo: string | null; previa: any; resultado: any; erro: string | null; progresso: { feitos: number; total: number; falhas: number } | null; criadoEm: string }
interface Sessao { id: string; titulo: string; ocupada: boolean; mensagens: Mensagem[]; acoes: Acao[] }
interface Estado { ligado: boolean; voz: boolean; nome: string; ferramentas: { nome: string; risco: string }[]; podeConfigurar: boolean }

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
};
const SUGESTOES = ['Como foi o mês até agora, comparado ao mês passado?', 'Quem são os inadimplentes acima de 30 dias?', 'Quais maletas estão atrasadas?', 'Manda um WhatsApp cobrando os inadimplentes com a 2ª via'];
const STATUS_PEDIDO: Record<string, [string, string]> = { novo: ['alerta', 'Novo'], em_analise: ['alerta', 'Em análise'], em_andamento: ['marrom', 'Em andamento'], pronto: ['ok', 'Pronto'], recusado: ['neutra', 'Recusado'] };

/** Lê em voz alta (voz do navegador, em português). */
function falar(texto: string) {
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

export function Assistente() {
  const [aba, setAba] = useState<'conversa' | 'pedidos' | 'config'>('conversa');
  const estado = useQuery({ queryKey: ['assistente', 'estado'], queryFn: () => api<Estado>('/assistente/estado') });
  const abas: ['conversa' | 'pedidos' | 'config', string][] = [['conversa', 'Conversa'], ['pedidos', 'Pedidos']];
  if (estado.data?.podeConfigurar) abas.push(['config', 'Configurar']);
  return (
    <>
      <Topo eb="Assistente" titulo={estado.data?.nome ?? 'Assistente'} sub="Fale ou escreva o que precisa: ele consulta o sistema, analisa os resultados com você e executa ações (com a sua confirmação)." />
      <Abas abas={abas} ativa={aba} mudar={setAba} />
      {estado.isLoading ? <Carregando /> : !estado.data?.ligado ? (
        <div className="aviso alerta">A inteligência artificial não está ligada. Cole a chave do Claude em Configurações › Integrações › Inteligência artificial.</div>
      ) : aba === 'conversa' ? <Conversas estado={estado.data} /> : aba === 'pedidos' ? <Pedidos podeMudar={estado.data.podeConfigurar} /> : <Configurar />}
    </>
  );
}

function Conversas({ estado }: { estado: Estado }) {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['assistente', 'sessoes'], queryFn: () => api<{ id: string; titulo: string; ocupada: boolean; atualizadoEm: string }[]>('/assistente/sessoes') });
  const [sel, setSel] = useState<string | null>(null);
  const nova = useMutation({ mutationFn: () => api<{ id: string }>('/assistente/sessoes', { corpo: {} }), onSuccess: (s) => { setSel(s.id); qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); } });
  const atual = sel ?? lista.data?.[0]?.id ?? null;
  return (
    <div className="assistente">
      <aside className="assistente-lista">
        <button className="botao" onClick={() => nova.mutate()} disabled={nova.isPending}>Nova conversa</button>
        {lista.data?.map((s) => (
          <button key={s.id} className={`assistente-item ${s.id === atual ? 'ativo' : ''}`} onClick={() => setSel(s.id)}>
            <span>{s.titulo}</span>
            <small className="muted">{s.ocupada ? 'trabalhando…' : dataHora(s.atualizadoEm)}</small>
          </button>
        ))}
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
    mutationFn: (d: { texto: string; origem: 'texto' | 'voz' }) => api(`/assistente/sessoes/${id}/mensagens`, { corpo: d }),
    onSuccess: () => { setTexto(''); qc.invalidateQueries({ queryKey: ['assistente', 'sessao', id] }); qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); },
  });
  const decidir = useMutation({
    mutationFn: (d: { acaoId: string; confirmar: boolean }) => api(`/assistente/acoes/${d.acaoId}/${d.confirmar ? 'confirmar' : 'cancelar'}`, { corpo: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assistente', 'sessao', id] }),
  });
  const apagar = useMutation({ mutationFn: () => api(`/assistente/sessoes/${id}`, { metodo: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['assistente', 'sessoes'] }); aoApagar(); } });

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
    if (ouvir && novas.length) falar(novas.map((m) => m.texto).join('. '));
  }, [s.data, ouvir]);

  const mandar = (t: string, origem: 'texto' | 'voz') => {
    if (!t.trim() || s.data?.ocupada) return;
    enviar.mutate({ texto: t.trim(), origem });
  };

  if (s.isLoading) return <Carregando />;
  if (!s.data) return <Erro erro={s.error} />;
  return (
    <section className="assistente-chat cartao">
      <div className="assistente-topo">
        <b>{s.data.titulo}</b>
        <span className="espaco" />
        <label className="muted assistente-ouvir">
          <input type="checkbox" checked={ouvir} onChange={(e) => { setOuvir(e.target.checked); localStorage.setItem('aritana.assistente.ouvir', e.target.checked ? '1' : '0'); if (!e.target.checked) window.speechSynthesis?.cancel(); }} /> Ouvir respostas
        </label>
        <button className="botao claro pequeno" onClick={() => apagar.mutate()} disabled={s.data.ocupada}>Apagar</button>
      </div>
      <div className="assistente-mensagens">
        {linha.length === 0 && (
          <div className="assistente-sugestoes">
            {SUGESTOES.map((t) => <button key={t} className="botao claro" onClick={() => mandar(t, 'texto')}>{t}</button>)}
          </div>
        )}
        {linha.map((x) => (x.tipo === 'msg' ? (
          <div key={x.m.id} className={`fala ${x.m.papel === 'user' ? 'minha' : 'dele'}`}>
            {x.m.origem === 'voz' && <span className="muted" title="Falado">🎤 </span>}
            {x.m.texto}
            {x.m.papel === 'assistant' && <button className="assistente-falar" title="Ouvir" onClick={() => falar(x.m.texto)}>🔊</button>}
          </div>
        ) : (
          <CartaoAcao key={x.a.id} a={x.a} decidir={(confirmar) => decidir.mutate({ acaoId: x.a.id, confirmar })} ocupado={decidir.isPending} />
        )))}
        {s.data.ocupada && <div className="fala dele muted">{estado.nome} está trabalhando…</div>}
        {decidir.error && <Erro erro={decidir.error} />}
        <div ref={fim} />
      </div>
      {enviar.error && <Erro erro={enviar.error} />}
      <div className="assistente-entrada">
        <textarea
          rows={2}
          value={texto}
          placeholder={s.data.ocupada ? 'Aguarde terminar…' : 'Escreva ou aperte o microfone e fale'}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mandar(texto, 'texto'); } }}
        />
        {estado.voz && <Microfone desativado={s.data.ocupada || enviar.isPending} aoTranscrever={(t) => mandar(t, 'voz')} />}
        <button className="botao" disabled={!texto.trim() || s.data.ocupada || enviar.isPending} onClick={() => mandar(texto, 'texto')}>Enviar</button>
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
        <span className={`etiqueta ${a.status === 'concluida' ? 'ok' : a.status === 'erro' ? 'erro' : a.status === 'cancelada' ? 'neutra' : 'alerta'}`}>{{ aguardando: 'Esperando sua confirmação', executando: 'Executando', concluida: 'Concluída', cancelada: 'Cancelada', erro: 'Erro' }[a.status] ?? a.status}</span>
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

function Configurar() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['assistente', 'config'], queryFn: () => api<{ nome: string; instrucoes: string }>('/assistente/config') });
  const [f, setF] = useState<{ nome: string; instrucoes: string } | null>(null);
  const salvar = useMutation({ mutationFn: (d: { nome: string; instrucoes: string }) => api('/assistente/config', { metodo: 'PUT', corpo: d }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['assistente'] }); } });
  if (cfg.isLoading) return <Carregando />;
  const v = f ?? cfg.data!;
  return (
    <div className="cartao form">
      <Campo rotulo="Nome do assistente" ajuda="Como ele se apresenta para a equipe (ex.: Cláudio)."><input value={v.nome} onChange={(e) => setF({ ...v, nome: e.target.value })} /></Campo>
      <Campo rotulo="Orientações da empresa" className="l4" ajuda="Tom, prioridades e o que ele nunca deve fazer. Ex.: “Em cobrança, sempre ofereça a 2ª via com o vencimento para daqui a 3 dias.”">
        <textarea rows={8} value={v.instrucoes} onChange={(e) => setF({ ...v, instrucoes: e.target.value })} />
      </Campo>
      <div className="l4">
        <p className="muted">Ele só faz o que o usuário logado pode fazer (as mesmas permissões das telas). Mensagens, cobranças e envios em lote sempre passam pela confirmação de quem pediu. Para mudar o espaço entre mensagens do envio em lote, use a chave ASSISTENTE_INTERVALO_LOTE_S (padrão: 20 segundos).</p>
        {salvar.error && <Erro erro={salvar.error} />}
        {salvar.isSuccess && !f && <div className="aviso ok">Salvo.</div>}
        <button className="botao" disabled={salvar.isPending || !v.nome.trim()} onClick={() => salvar.mutate(v, { onSuccess: () => setF(null) })}>Salvar</button>
      </div>
    </div>
  );
}
