import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { Erro } from '../../componentes/ui';
import { ha, ligar, meuId, telefoneBonito, useMidia, useRelogio, usarAtendentes, type Template } from './comum';

interface Mensagem { id: string; direcao: 'entrada' | 'saida' | 'interna'; tipo: string; texto: string | null; midia: string | null; midiaNome: string | null; templateNome: string | null; status: string; erro: string | null; autor: string | null; automatica: boolean; criadoEm: string }
interface Dados {
  conversa: { id: string; status: 'fila' | 'atendimento' | 'resolvida'; atendenteId: string | null; canalId: string; canal: string; canalTipo: 'oficial' | 'qrcode' | 'evolution'; dentroDaJanela: boolean; filaDesde: string | null; contatoId: string };
  contato: { id: string; nome: string; telefone: string; descadastrado: boolean };
  mensagens: Mensagem[];
}

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

/** Chat de uma conversa: fila, atendimento, mensagens, conversa interna, templates e respostas rápidas. */
export function Chat({ conversaId, leadId, aoMudar }: { conversaId: string; leadId?: string | null; aoMudar?: () => void }) {
  const qc = useQueryClient();
  useRelogio(30);
  const eu = meuId();
  const gestor = pode('crm', 'excluir');
  const editar = pode('crm', 'editar');
  const q = useQuery({ queryKey: ['crm', 'msgs', conversaId], queryFn: () => api<Dados>(`/crm/conversas/${conversaId}/mensagens`), refetchInterval: 3000 });
  const respostas = useQuery({ queryKey: ['crm', 'respostas'], queryFn: () => api<{ id: string; atalho: string; texto: string }[]>('/crm/respostas'), staleTime: 60_000 });
  const canalId = q.data?.conversa.canalId;
  const templates = useQuery({ queryKey: ['crm', 'templates', canalId], queryFn: () => api<Template[]>(`/crm/templates?canalId=${canalId}`), enabled: !!canalId, staleTime: 60_000 });
  const atendentes = usarAtendentes();
  const [texto, setTexto] = useState('');
  const [interna, setInterna] = useState(false);
  const [verTemplates, setVerTemplates] = useState(false);
  const [transferir, setTransferir] = useState(false);
  const fim = useRef<HTMLDivElement>(null);
  const arquivo = useRef<HTMLInputElement>(null);
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
    mutationFn: (c: { tipo: 'texto' | 'template'; texto?: string; templateId?: string }) => api(`/crm/conversas/${conversaId}/${interna && c.tipo === 'texto' ? 'interna' : 'mensagens'}`, { corpo: { ...c, leadId } }),
    onSuccess: () => {
      setTexto('');
      setVerTemplates(false);
      atualizar();
    },
  });
  const anexar = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 16_000_000) throw new Error('Arquivo maior que 16 MB.');
      const base64 = await new Promise<string>((ok, erro) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result));
        r.onerror = () => erro(r.error);
        r.readAsDataURL(f);
      });
      return api(`/crm/conversas/${conversaId}/midia`, { corpo: { nome: f.name, mime: f.type || 'application/octet-stream', base64, texto: texto || null } });
    },
    onSuccess: () => {
      setTexto('');
      atualizar();
    },
  });

  // "/atalho" → respostas rápidas; "@nome" na conversa interna → colegas.
  const sugestoes = useMemo(() => {
    const barra = texto.match(/^\/(\S*)$/);
    if (barra && !interna) return (respostas.data ?? []).filter((r) => r.atalho.startsWith(barra[1].toLowerCase())).slice(0, 8).map((r) => ({ rotulo: `/${r.atalho} — ${r.texto.slice(0, 60)}`, valor: r.texto }));
    const arroba = texto.match(/(^|\s)@(\S*)$/);
    if (arroba && interna) return (atendentes.data ?? []).filter((a) => a.nome.toLowerCase().startsWith(arroba[2].toLowerCase())).slice(0, 6).map((a) => ({ rotulo: `@${a.nome}`, valor: texto.replace(/@(\S*)$/, `@${a.nome.split(' ')[0]} `) }));
    return [];
  }, [texto, interna, respostas.data, atendentes.data]);

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
          <div style={{ fontWeight: 700 }}>{contato.nome}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {telefoneBonito(contato.telefone)} · {c.canal} {c.canalTipo === 'oficial' ? '(oficial)' : '(QR code)'}
            {contato.descadastrado && <span className="etiqueta erro" style={{ marginLeft: 6 }}>Não quer disparos</span>}
          </div>
        </div>
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="botao claro pequeno" title="Ligar pelo softphone" onClick={() => ligar(contato.telefone, leadId, contato.nome)}>📞 Ligar</button>
          {editar && c.status !== 'resolvida' && (minha || gestor) && <button className="botao claro pequeno" onClick={() => setTransferir((v) => !v)}>Transferir</button>}
          {editar && c.status !== 'resolvida' && (minha || gestor || c.status === 'fila') && <button className="botao claro pequeno" disabled={acao.isPending} onClick={() => acao.mutate({ rota: 'resolver' })}>✓ Resolver</button>}
        </div>
      </div>
      {transferir && (
        <div className="chat-faixa" style={{ background: 'var(--creme-2)', color: 'var(--tinta)' }}>
          <span>Transferir para:</span>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="botao claro pequeno" onClick={() => { acao.mutate({ rota: 'transferir', corpo: { usuarioId: null } }); setTransferir(false); }}>Devolver para a fila</button>
            {atendentes.data?.filter((a) => a.id !== c.atendenteId).map((a) => <button key={a.id} className="botao claro pequeno" onClick={() => { acao.mutate({ rota: 'transferir', corpo: { usuarioId: a.id } }); setTransferir(false); }}>{a.nome}</button>)}
          </div>
        </div>
      )}
      {c.status === 'fila' && (
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

      <div className="chat-msgs">
        {!mensagens.length && <div className="muted" style={{ alignSelf: 'center' }}>Nenhuma mensagem ainda.</div>}
        {mensagens.map((m) => {
          const dia = new Date(m.criadoEm).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const sep = dia !== diaAnterior;
          diaAnterior = dia;
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {sep && <div className="dia">{dia}</div>}
              <div className={`msg ${m.direcao} ${m.status === 'falhou' ? 'falhou' : ''}`}>
                {m.direcao === 'interna' && <div style={{ fontSize: 12, fontWeight: 700, color: '#8a6d12' }}>🔒 Interna · {m.autor}</div>}
                {m.templateNome && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--dourado-t)' }}>Template: {m.templateNome}</div>}
                <Midia m={m} />
                {m.texto}
                <div className="rodape-msg">
                  {m.direcao === 'saida' && (m.automatica ? 'automática' : m.autor ?? 'celular')}
                  <span>{new Date(m.criadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                  {m.direcao === 'saida' && <span style={{ color: m.status === 'lida' ? '#2a7fd4' : undefined }} title={m.erro ?? m.status}>{TICKS[m.status] ?? ''}</span>}
                </div>
                {m.erro && <div style={{ fontSize: 12, color: 'var(--erro)' }}>{m.erro}</div>}
              </div>
            </div>
          );
        })}
        <div ref={fim} />
      </div>

      {editar && (
        <div className={`composer ${interna ? 'interna' : ''}`}>
          {c.canalTipo === 'oficial' && !c.dentroDaJanela && !interna && <div className="aviso alerta" style={{ margin: 0, padding: '6px 10px', fontSize: 13 }}>Fora da janela de 24h: no número oficial, só templates aprovados até o contato responder.</div>}
          {sugestoes.length > 0 && <div className="sugestoes">{sugestoes.map((s) => <button key={s.rotulo} onClick={() => setTexto(s.valor)}>{s.rotulo}</button>)}</div>}
          {verTemplates && (
            <div className="sugestoes">
              {!usaveis.length && <div className="muted" style={{ padding: 8 }}>Nenhum template disponível para este número.</div>}
              {usaveis.map((t) => (
                <button key={t.id} onClick={() => enviar.mutate({ tipo: 'template', templateId: t.id })} disabled={enviar.isPending}>
                  <b>{t.nome}</b> {t.tipo === 'meta' ? <span className="tag">Meta</span> : null} <span className="muted">— {t.texto.slice(0, 80)}</span>
                </button>
              ))}
            </div>
          )}
          {(enviar.error || anexar.error) && <Erro erro={enviar.error ?? anexar.error} />}
          <textarea
            rows={2}
            value={texto}
            disabled={!podeEscrever}
            placeholder={interna ? 'Mensagem interna (o cliente não vê). Use @ para chamar um colega.' : c.status === 'fila' ? 'Responder pega a conversa para você. "/" para respostas rápidas.' : 'Escreva… "/" para respostas rápidas. Enter envia, Shift+Enter quebra linha.'}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (sugestoes.length === 1) return setTexto(sugestoes[0].valor);
                if (texto.trim() && !enviar.isPending) enviar.mutate({ tipo: 'texto', texto });
              }
            }}
          />
          <div className="acoes">
            <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={interna} onChange={(e) => setInterna(e.target.checked)} /> 🔒 Interna</label>
            {!interna && <button className="botao claro pequeno" onClick={() => setVerTemplates((v) => !v)}>Templates</button>}
            {!interna && <button className="botao claro pequeno" disabled={anexar.isPending || (c.canalTipo === 'oficial' && !c.dentroDaJanela)} onClick={() => arquivo.current?.click()}>{anexar.isPending ? 'Enviando…' : '📎 Arquivo'}</button>}
            <input ref={arquivo} type="file" hidden accept="image/*,audio/*,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) anexar.mutate(f); e.target.value = ''; }} />
            <span style={{ flex: 1 }} />
            <button className="botao pequeno" disabled={!texto.trim() || enviar.isPending || !podeEscrever} onClick={() => enviar.mutate({ tipo: 'texto', texto })}>{interna ? 'Anotar' : 'Enviar'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
