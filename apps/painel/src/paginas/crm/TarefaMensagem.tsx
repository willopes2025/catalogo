import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Erro } from '../../componentes/ui';
import { usarCanais, usarVariaveisCrm, type Template } from './comum';
import { TextoComVariaveis } from '../../componentes/TextoComVariaveis';

/** Mensagem de WhatsApp escolhida ao criar uma tarefa do card. */
export interface EstadoMensagem {
  ativo: boolean;
  tipo: 'texto' | 'resposta' | 'template';
  texto: string;
  respostaId: string;
  templateId: string;
  canalId: string;
  envio: 'automatico' | 'lembrete';
}

export const mensagemVazia = (): EstadoMensagem => ({ ativo: false, tipo: 'texto', texto: '', respostaId: '', templateId: '', canalId: '', envio: 'automatico' });

/** O que vai no corpo do POST da tarefa (null = tarefa sem mensagem). */
export const corpoMensagem = (m: EstadoMensagem) =>
  m.ativo
    ? { tipo: m.tipo, texto: m.tipo === 'texto' ? m.texto : null, respostaId: m.tipo === 'resposta' ? m.respostaId || null : null, templateId: m.tipo === 'template' ? m.templateId || null : null, canalId: m.canalId || null, envio: m.envio }
    : null;

/** A mensagem está completa para criar a tarefa? */
export const mensagemPronta = (m: EstadoMensagem) => !m.ativo || (m.tipo === 'texto' ? m.texto.trim().length > 0 : m.tipo === 'resposta' ? !!m.respostaId : !!m.templateId);

type Resposta = { id: string; atalho: string; texto: string; midiaMime: string | null; midiaNome: string | null };
const icone = (mime: string | null) => (mime?.startsWith('image/') ? '🖼 ' : mime?.startsWith('video/') ? '🎬 ' : mime?.startsWith('audio/') ? '🎤 ' : '');

/** Bloco "Enviar mensagem de WhatsApp" do formulário de tarefa. */
export function EscolherMensagem({ valor: m, mudar }: { valor: EstadoMensagem; mudar: (m: EstadoMensagem) => void }) {
  const variaveis = usarVariaveisCrm();
  const canais = usarCanais();
  const respostas = useQuery({ queryKey: ['crm', 'respostas'], queryFn: () => api<Resposta[]>('/crm/respostas'), staleTime: 60_000, enabled: m.ativo });
  const templates = useQuery({ queryKey: ['crm', 'templates', 'todos'], queryFn: () => api<Template[]>('/crm/templates'), staleTime: 60_000, enabled: m.ativo });
  const campo = { padding: '7px 9px', border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit', background: '#fff', minWidth: 0 } as const;
  const ativos = (canais.data ?? []).filter((c) => c.ativo);
  const canalEscolhido = ativos.find((c) => c.id === m.canalId);
  // Template da Meta só sai pelo número oficial dele; os livres saem por qualquer número.
  const usaveis = (templates.data ?? []).filter((t) => t.tipo === 'livre' || (t.status === 'APPROVED' && (!canalEscolhido || t.canalId === canalEscolhido.id)));
  const nomeCanal = (id: string | null) => ativos.find((c) => c.id === id)?.nome;
  const set = (p: Partial<EstadoMensagem>) => mudar({ ...m, ...p });
  return (
    <div className="coluna" style={{ gap: 8, width: '100%' }}>
      <label className="check"><input type="checkbox" checked={m.ativo} onChange={(e) => set({ ativo: e.target.checked })} /> Enviar mensagem de WhatsApp nesta tarefa</label>
      {m.ativo && (
        <div className="coluna" style={{ gap: 8, padding: 10, borderRadius: 10, border: '1px solid var(--linha)', background: 'var(--creme-2, #f7f2ea)' }}>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {([['texto', 'Escrever a mensagem'], ['resposta', 'Resposta rápida'], ['template', 'Template']] as const).map(([v, r]) => (
              <button key={v} type="button" className={`botao pequeno ${m.tipo === v ? '' : 'claro'}`} onClick={() => set({ tipo: v })}>{r}</button>
            ))}
          </div>
          {m.tipo === 'texto' && (
            <TextoComVariaveis aria-label="Mensagem" linhas={3} maxLength={4096} placeholder="Ex.: Oi {{primeiro_nome}}, passando para lembrar do acerto da sua maleta amanhã! (digite { para as variáveis)" value={m.texto} onChange={(t) => set({ texto: t })} variaveis={variaveis} style={{ ...campo, resize: 'vertical' }} />
          )}
          {m.tipo === 'resposta' && (
            <select aria-label="Resposta rápida" value={m.respostaId} onChange={(e) => set({ respostaId: e.target.value })} style={campo}>
              <option value="">{respostas.data?.length === 0 ? 'Nenhuma resposta rápida cadastrada' : 'Escolha a resposta rápida…'}</option>
              {respostas.data?.map((r) => <option key={r.id} value={r.id}>/{r.atalho} — {icone(r.midiaMime)}{(r.texto || r.midiaNome || '').slice(0, 70)}</option>)}
            </select>
          )}
          {m.tipo === 'template' && (
            <select aria-label="Template" value={m.templateId} onChange={(e) => set({ templateId: e.target.value })} style={campo}>
              <option value="">{usaveis.length ? 'Escolha o template…' : 'Nenhum template disponível'}</option>
              {usaveis.map((t) => <option key={t.id} value={t.id}>{t.nome}{t.tipo === 'meta' ? ` (Meta · ${nomeCanal(t.canalId) ?? 'oficial'})` : ''} — {t.texto.slice(0, 60)}</option>)}
            </select>
          )}
          {m.tipo !== 'template' && <span className="muted" style={{ fontSize: 12 }}>Dá para usar {'{{nome}}'}, {'{{primeiro_nome}}'}, {'{{etapa}}'} e os campos do card.</span>}
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13 }}>Sai pelo número</span>
            <select aria-label="Número que envia" value={m.canalId} onChange={(e) => set({ canalId: e.target.value, templateId: '' })} style={campo}>
              <option value="">O da última conversa com a pessoa</option>
              {ativos.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </div>
          <div className="coluna" style={{ gap: 4 }}>
            <label className="check"><input type="radio" name="envio-tarefa" checked={m.envio === 'automatico'} onChange={() => set({ envio: 'automatico' })} /> Enviar sozinho no horário da tarefa</label>
            <label className="check"><input type="radio" name="envio-tarefa" checked={m.envio === 'lembrete'} onChange={() => set({ envio: 'lembrete' })} /> Só lembrar: eu envio com um clique</label>
          </div>
          {canalEscolhido?.tipo === 'oficial' && m.tipo !== 'template' && <div className="aviso" style={{ fontSize: 12 }}>No número oficial, texto e resposta rápida só saem se a pessoa escreveu nas últimas 24 horas. Para garantir, use um template aprovado pela Meta.</div>}
        </div>
      )}
    </div>
  );
}

export type TarefaComMensagem = { id: string; feitaEm: string | null; venceEm: string; mensagemTipo?: string | null; mensagemTexto?: string | null; mensagemNome?: string | null; envio?: string | null; mensagemStatus?: string | null; mensagemErro?: string | null; canal?: string | null };

/** Linha da mensagem dentro de uma tarefa da lista: o que vai, quando, situação e o botão de enviar. */
export function MensagemDaTarefa({ t, podeEnviar }: { t: TarefaComMensagem; podeEnviar: boolean }) {
  const qc = useQueryClient();
  const enviar = useMutation({ mutationFn: () => api(`/crm/tarefas/${t.id}/enviar`, { corpo: {} }), onSettled: () => qc.invalidateQueries({ queryKey: ['crm'] }) });
  if (!t.mensagemTipo) return null;
  const oque = t.mensagemTipo === 'texto' ? `"${(t.mensagemTexto ?? '').slice(0, 60)}${(t.mensagemTexto ?? '').length > 60 ? '…' : ''}"` : t.mensagemTipo === 'resposta' ? `resposta rápida ${t.mensagemNome ?? '(apagada)'}` : `template ${t.mensagemNome ?? '(apagado)'}`;
  const quando = new Date(t.venceEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const situacao =
    t.mensagemStatus === 'enviada' ? <span className="etiqueta ok">Enviada</span>
    : t.mensagemStatus === 'falhou' ? <span className="etiqueta erro" title={t.mensagemErro ?? undefined}>Não enviada</span>
    : t.mensagemStatus === 'enviando' ? <span className="etiqueta alerta">Enviando…</span>
    : t.envio === 'automatico' ? <span className="etiqueta alerta">Sai sozinha em {quando}</span>
    : <span className="etiqueta neutra">Pronta para enviar</span>;
  const mostrarBotao = podeEnviar && !t.feitaEm && t.mensagemStatus !== 'enviada' && t.mensagemStatus !== 'enviando';
  return (
    <div className="coluna" style={{ gap: 4, marginTop: 4 }} onClick={(e) => e.preventDefault()}>
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
        <span>💬 {oque}{t.canal ? ` · pelo ${t.canal}` : ''}</span>
        {situacao}
        {mostrarBotao && <button type="button" className="botao pequeno" disabled={enviar.isPending} onClick={(e) => { e.stopPropagation(); enviar.mutate(); }}>{enviar.isPending ? 'Enviando…' : t.mensagemStatus === 'falhou' ? 'Tentar de novo' : 'Enviar agora'}</button>}
      </div>
      {t.mensagemStatus === 'falhou' && t.mensagemErro && <span style={{ fontSize: 12, color: 'var(--erro)' }}>{t.mensagemErro}</span>}
      {enviar.error && <Erro erro={enviar.error} />}
    </div>
  );
}
