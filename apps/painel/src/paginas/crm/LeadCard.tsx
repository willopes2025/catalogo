import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, pode } from '../../api';
import { centavosParaTexto, paraCentavos, reais } from '../../formato';
import { Abas, Carregando, Erro } from '../../componentes/ui';
import { Chat } from './Chat';
import { Aprovar, Motivo } from './Funil';
import { ha, ligar, NovoCampo, telefoneBonito, usarAtendentes, usarCampos, usarCanais, usarFunis, ValorCampo, type Etapa } from './comum';
import './crm.css';

const ICONES: Record<string, string> = { nota: '📝', etapa: '➜', campo: '✎', tarefa: '☑', gatilho: '⚡', sistema: '•', ligacao: '📞' };
const ROTULO_UTM: Record<string, string> = { utm_source: 'Origem', utm_medium: 'Meio', utm_campaign: 'Campanha', utm_content: 'Conteúdo', utm_term: 'Termo', fbclid: 'Clique Meta (fbclid)', gclid: 'Clique Google (gclid)', pagina: 'Página', anuncio_id: 'Anúncio (id)', anuncio_titulo: 'Anúncio', anuncio_texto: 'Texto do anúncio', ctwa_clid: 'Clique para WhatsApp (id)', canal: 'Número', anuncio_tipo: 'Tipo de anúncio' };

/** O card do lead: dados do negócio, dados do contato, origem, conversa, histórico e tarefas. */
export function LeadCard() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const q = useQuery({ queryKey: ['crm', 'lead', id], queryFn: () => api<any>(`/crm/leads/${id}`), refetchInterval: 15_000 });
  const funis = usarFunis();
  const atendentes = usarAtendentes();
  const campos = usarCampos();
  const canais = usarCanais();
  const [aba, setAba] = useState<'conversa' | 'historico' | 'tarefas'>('conversa');
  const [conversaId, setConversaId] = useState<string | null>(null);
  const [perda, setPerda] = useState<Etapa | null>(null);
  const [aprovar, setAprovar] = useState(false);
  const [titulo, setTitulo] = useState('');
  const [valor, setValor] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const [nota, setNota] = useState('');
  const [tarefa, setTarefa] = useState({ titulo: '', venceEm: '', responsavelId: '' });
  const [canalNovo, setCanalNovo] = useState('');
  const editar = pode('crm', 'editar');
  const gestor = pode('crm', 'excluir');
  const [novoCampo, setNovoCampo] = useState<{ entidade: 'lead' | 'contato'; nome?: string } | null>(null);
  const l = q.data;
  useEffect(() => {
    if (l) {
      setTitulo(l.titulo);
      setValor(l.valor ? centavosParaTexto(l.valor) : '');
      if (!conversaId && l.conversas?.length) setConversaId(l.conversas[0].id);
    }
  }, [l?.id, l?.titulo, l?.valor, l?.conversas?.length]);

  const atualizar = () => {
    qc.invalidateQueries({ queryKey: ['crm', 'lead', id] });
    qc.invalidateQueries({ queryKey: ['crm', 'leads'] });
    qc.invalidateQueries({ queryKey: ['crm', 'funis'] });
  };
  const patch = useMutation({ mutationFn: (corpo: Record<string, unknown>) => api(`/crm/leads/${id}`, { metodo: 'PATCH', corpo }), onSuccess: atualizar });
  const patchContato = useMutation({ mutationFn: (corpo: Record<string, unknown>) => api(`/crm/contatos/${l.contatoId}`, { metodo: 'PATCH', corpo }), onSuccess: atualizar });
  const anotar = useMutation({ mutationFn: () => api(`/crm/leads/${id}/notas`, { corpo: { texto: nota } }), onSuccess: () => { setNota(''); atualizar(); } });
  const criarTarefa = useMutation({
    mutationFn: () => api(`/crm/leads/${id}/tarefas`, { corpo: { titulo: tarefa.titulo, venceEm: new Date(tarefa.venceEm).toISOString(), responsavelId: tarefa.responsavelId || null } }),
    onSuccess: () => { setTarefa({ titulo: '', venceEm: '', responsavelId: '' }); atualizar(); },
  });
  const marcar = useMutation({ mutationFn: ({ tid, feita }: { tid: string; feita: boolean }) => api(`/crm/tarefas/${tid}`, { metodo: 'PATCH', corpo: { feita } }), onSuccess: atualizar });
  const iniciar = useMutation({
    mutationFn: () => api<{ id: string }>(`/crm/contatos/${l.contatoId}/conversa`, { corpo: { canalId: canalNovo || canais.data?.[0]?.id } }),
    onSuccess: (c) => { setConversaId(c.id); atualizar(); },
  });
  const apagar = useMutation({ mutationFn: () => api(`/crm/leads/${id}`, { metodo: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm'] }); navegar('/crm'); } });

  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const funil = funis.data?.find((f) => f.id === l.funilId);
  const etapa = funil?.etapas.find((e) => e.id === l.etapaId);
  const idxAtual = funil?.etapas.findIndex((e) => e.id === l.etapaId) ?? -1;
  const camposLead = (campos.data ?? []).filter((c) => c.entidade === 'lead' && (!c.funilId || c.funilId === l.funilId));
  const camposContato = (campos.data ?? []).filter((c) => c.entidade === 'contato');
  const extrasLeadSemDef = Object.keys(l.camposExtras ?? {}).filter((k) => !camposLead.some((c) => c.nome === k));
  const extrasContatoSemDef = Object.keys(l.contato.camposExtras ?? {}).filter((k) => !camposContato.some((c) => c.nome === k));
  const pendentes = l.tarefas.filter((t: any) => !t.feitaEm);

  const irPara = (e: Etapa) => {
    if (!editar || e.id === l.etapaId) return;
    if (e.chave === 'aprovada' && funil?.tipo === 'recrutamento') return setAprovar(true);
    if (e.tipo === 'perdido') return setPerda(e);
    patch.mutate({ etapaId: e.id });
  };

  return (
    <div>
      <div className="lead-topo">
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="eb"><Link to="/crm">CRM</Link> › {funil?.nome} · card nº {l.numero}</div>
          <input
            value={titulo}
            disabled={!editar}
            onChange={(e) => setTitulo(e.target.value)}
            onBlur={() => titulo.trim() && titulo !== l.titulo && patch.mutate({ titulo: titulo.trim() })}
            style={{ fontSize: 24, fontWeight: 700, border: '1px solid transparent', background: 'transparent', font: 'inherit', width: '100%', padding: '2px 4px', borderRadius: 6 }}
          />
          <div className="muted">
            {l.status === 'ganho' ? <span className="etiqueta ok">Ganho</span> : l.status === 'perdido' ? <span className="etiqueta erro">Perdido{l.motivoPerda ? `: ${l.motivoPerda}` : ''}</span> : <span className="etiqueta neutra">Aberto</span>} · na etapa há {ha(l.entrouNaEtapaEm)} · criado {new Date(l.criadoEm).toLocaleDateString('pt-BR')}
          </div>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          <button className="botao" onClick={() => ligar(l.contato.telefone, l.id, l.contato.nome)}>📞 Ligar</button>
          {pode('crm', 'excluir') && <button className="botao perigo" onClick={() => window.confirm(`Apagar o card "${l.titulo}"? O contato e as conversas continuam.`) && apagar.mutate()}>Apagar</button>}
        </div>
      </div>
      {funil && (
        <div className="pipeline">
          {funil.etapas.map((e, i) => (
            <button key={e.id} className={e.id === l.etapaId ? 'atual' : i < idxAtual && e.tipo === 'aberta' ? 'feito' : ''} style={{ ['--cor' as string]: e.cor }} title={e.nome} onClick={() => irPara(e)} disabled={!editar}>
              {e.nome}
            </button>
          ))}
        </div>
      )}
      {(patch.error || patchContato.error || apagar.error) && <Erro erro={patch.error ?? patchContato.error ?? apagar.error} />}

      <div className="lead-grade">
        <div className="coluna" style={{ gap: 12 }}>
          <div className="bloco">
            <h3>Negócio (card)</h3>
            <div className="par"><span>Etapa</span><span style={{ color: etapa?.cor, fontWeight: 700 }}>{etapa?.nome}</span></div>
            <div className="par">
              <span>Responsável</span>
              <select value={l.responsavelId ?? ''} disabled={!editar} onChange={(e) => patch.mutate({ responsavelId: e.target.value || null })}>
                <option value="">Ninguém</option>
                {atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
              </select>
            </div>
            <div className="par"><span>Valor (R$)</span><input inputMode="decimal" value={valor} disabled={!editar} placeholder="0,00" onChange={(e) => setValor(e.target.value)} onBlur={() => { const c = valor ? paraCentavos(valor) : 0; if (c !== l.valor) patch.mutate({ valor: c }); }} /></div>
            {camposLead.map((c) => (
              <div key={c.id} className="par"><span>{c.nome}</span><ValorCampo def={c} valor={l.camposExtras?.[c.nome] ?? ''} desativado={!editar} mudar={(v) => patch.mutate({ camposExtras: { ...l.camposExtras, [c.nome]: v } })} /></div>
            ))}
            {extrasLeadSemDef.map((k) => (
              <ExtraSemCampo key={k} nome={k} valor={l.camposExtras[k]} editar={editar} gestor={gestor}
                mudar={(v) => patch.mutate({ camposExtras: { ...l.camposExtras, [k]: v } })}
                tirar={() => { const { [k]: _, ...resto } = l.camposExtras; patch.mutate({ camposExtras: resto }); }}
                fixar={() => setNovoCampo({ entidade: 'lead', nome: k })} />
            ))}
            {novoCampo?.entidade === 'lead' ? (
              <NovoCampo key={novoCampo.nome ?? 'novo'} entidade="lead" funilId={l.funilId} nomeInicial={novoCampo.nome} cancelar={() => setNovoCampo(null)} aoCriar={() => setNovoCampo(null)} />
            ) : gestor && <button className="mais-campo" onClick={() => setNovoCampo({ entidade: 'lead' })}>+ Adicionar campo ao card</button>}
            <div style={{ marginTop: 8 }}>
              <div className="tags" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {l.etiquetas.map((t: string) => (
                  <span key={t} className="tag">{t} {editar && <button style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} onClick={() => patch.mutate({ etiquetas: l.etiquetas.filter((x: string) => x !== t) })}>×</button>}</span>
                ))}
              </div>
              {editar && (
                <input
                  value={etiqueta}
                  placeholder="+ etiqueta (Enter)"
                  onChange={(e) => setEtiqueta(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && etiqueta.trim()) {
                      if (!l.etiquetas.includes(etiqueta.trim())) patch.mutate({ etiquetas: [...l.etiquetas, etiqueta.trim()] });
                      setEtiqueta('');
                    }
                  }}
                  style={{ marginTop: 6, width: '100%', padding: '5px 8px', border: '1px dashed var(--linha)', borderRadius: 6, font: 'inherit', fontSize: 13 }}
                />
              )}
            </div>
          </div>

          <div className="bloco">
            <h3>Contato (a pessoa)</h3>
            <div className="par"><span>Nome</span><ValorCampo def={{ id: 'n', entidade: 'contato', nome: 'Nome', tipo: 'texto', opcoes: [], funilId: null, ordem: 0 }} valor={l.contato.nome} desativado={!editar} mudar={(v) => v.trim() && patchContato.mutate({ nome: v.trim() })} /></div>
            <div className="par"><span>WhatsApp</span><span>{telefoneBonito(l.contato.telefone)} <button className="botao claro pequeno" onClick={() => ligar(l.contato.telefone, l.id, l.contato.nome)}>📞</button></span></div>
            <div className="par"><span>E-mail</span><ValorCampo def={{ id: 'e', entidade: 'contato', nome: 'E-mail', tipo: 'email', opcoes: [], funilId: null, ordem: 0 }} valor={l.contato.email ?? ''} desativado={!editar} mudar={(v) => patchContato.mutate({ email: v || null })} /></div>
            {camposContato.map((c) => (
              <div key={c.id} className="par"><span>{c.nome}</span><ValorCampo def={c} valor={l.contato.camposExtras?.[c.nome] ?? ''} desativado={!editar} mudar={(v) => patchContato.mutate({ camposExtras: { ...l.contato.camposExtras, [c.nome]: v } })} /></div>
            ))}
            {extrasContatoSemDef.map((k) => (
              <ExtraSemCampo key={k} nome={k} valor={l.contato.camposExtras[k]} editar={editar} gestor={gestor}
                mudar={(v) => patchContato.mutate({ camposExtras: { ...l.contato.camposExtras, [k]: v } })}
                tirar={() => { const { [k]: _, ...resto } = l.contato.camposExtras; patchContato.mutate({ camposExtras: resto }); }}
                fixar={() => setNovoCampo({ entidade: 'contato', nome: k })} />
            ))}
            {novoCampo?.entidade === 'contato' ? (
              <NovoCampo key={novoCampo.nome ?? 'novo'} entidade="contato" nomeInicial={novoCampo.nome} cancelar={() => setNovoCampo(null)} aoCriar={() => setNovoCampo(null)} />
            ) : gestor && <button className="mais-campo" onClick={() => setNovoCampo({ entidade: 'contato' })}>+ Adicionar campo ao contato</button>}
            <label className="check" style={{ fontSize: 13, marginTop: 6 }}><input type="checkbox" checked={l.contato.descadastrado} disabled={!editar} onChange={(e) => patchContato.mutate({ descadastrado: e.target.checked })} /> Não quer receber disparos</label>
            {l.pessoa && <Link className="botao claro pequeno" style={{ marginTop: 8, width: '100%' }} to={l.pessoa.tipo === 'representante' ? `/rede/${l.pessoa.id}` : `/cadastros/${l.pessoa.id}`}>Abrir ficha de {l.pessoa.tipo === 'representante' ? 'revendedora' : l.pessoa.tipo}</Link>}
          </div>

          {Object.keys(l.origem ?? {}).length > 0 && (
            <div className="bloco">
              <h3>Origem e rastreamento</h3>
              {Object.entries(l.origem).map(([k, v]) => <div key={k} className="par"><span>{ROTULO_UTM[k] ?? k}</span><span style={{ wordBreak: 'break-all' }}>{String(v)}</span></div>)}
            </div>
          )}

          {l.candidatura && (
            <div className="bloco">
              <h3>Candidatura nº {l.candidatura.numero}</h3>
              <div className="par"><span>Interesse</span><span>{l.candidatura.modeloInteresse}</span></div>
              {l.candidatura.experiencia && <div className="par"><span>Experiência</span><span>{l.candidatura.experiencia}</span></div>}
              {!l.candidatura.pessoaId && pode('rede', 'criar') && <button className="botao pequeno" style={{ marginTop: 8, width: '100%' }} onClick={() => setAprovar(true)}>Aprovar e criar revendedora</button>}
            </div>
          )}

          {l.outrosCards.length > 0 && (
            <div className="bloco">
              <h3>Outros cards deste contato</h3>
              {l.outrosCards.map((o: any) => <div key={o.id} style={{ fontSize: 14, padding: '3px 0' }}><Link to={`/crm/lead/${o.id}`}>{o.titulo}</Link> <span className="muted">· {o.funil} › {o.etapa}</span></div>)}
            </div>
          )}
        </div>

        <div className="coluna" style={{ gap: 10, minWidth: 0 }}>
          <Abas ativa={aba} mudar={setAba} abas={[['conversa', 'Conversa'], ['historico', `Histórico (${l.eventos.length})`], ['tarefas', `Tarefas${pendentes.length ? ` (${pendentes.length})` : ''}`]]} />
          {aba === 'conversa' && (
            <>
              {l.conversas.length > 1 && (
                <div className="crm-chips">
                  {l.conversas.map((c: any) => <button key={c.id} className={`crm-chip ${c.id === conversaId ? 'ativo' : ''}`} onClick={() => setConversaId(c.id)}>{c.canal}{c.naoLidas ? ` (${c.naoLidas})` : ''}</button>)}
                </div>
              )}
              {conversaId ? (
                <Chat key={conversaId} conversaId={conversaId} leadId={l.id} aoMudar={atualizar} />
              ) : (
                <div className="bloco">
                  <p className="muted">Ainda não há conversa com este contato.</p>
                  {canais.data?.length ? (
                    <div className="flex" style={{ gap: 6 }}>
                      <select value={canalNovo} onChange={(e) => setCanalNovo(e.target.value)} style={{ padding: 7, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }}>
                        {canais.data.map((c) => <option key={c.id} value={c.id}>{c.nome} ({c.tipo === 'oficial' ? 'oficial' : 'QR code'})</option>)}
                      </select>
                      <button className="botao" disabled={!editar || iniciar.isPending} onClick={() => iniciar.mutate()}>Iniciar conversa</button>
                    </div>
                  ) : <p className="muted">Nenhum número de WhatsApp disponível para você.</p>}
                  {iniciar.error && <Erro erro={iniciar.error} />}
                </div>
              )}
            </>
          )}
          {aba === 'historico' && (
            <div className="bloco">
              {editar && (
                <div className="coluna" style={{ gap: 6, marginBottom: 10 }}>
                  <textarea rows={2} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Escrever uma nota (só a equipe vê)…" style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }} />
                  <div><button className="botao pequeno" disabled={!nota.trim() || anotar.isPending} onClick={() => anotar.mutate()}>Salvar nota</button></div>
                </div>
              )}
              {l.eventos.map((e: any) => (
                <div key={e.id} className={`evento ${e.tipo}`}>
                  <span className="ic">{ICONES[e.tipo] ?? '•'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{e.texto}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{e.autor ?? 'Sistema'} · {new Date(e.criadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {aba === 'tarefas' && (
            <div className="bloco">
              {editar && (
                <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  <input placeholder="O que fazer" value={tarefa.titulo} onChange={(e) => setTarefa({ ...tarefa, titulo: e.target.value })} style={{ flex: 2, minWidth: 160, padding: 7, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }} />
                  <input type="datetime-local" value={tarefa.venceEm} onChange={(e) => setTarefa({ ...tarefa, venceEm: e.target.value })} style={{ padding: 7, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }} />
                  <select value={tarefa.responsavelId} onChange={(e) => setTarefa({ ...tarefa, responsavelId: e.target.value })} style={{ padding: 7, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }}>
                    <option value="">Eu</option>
                    {atendentes.data?.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
                  </select>
                  <button className="botao pequeno" disabled={!tarefa.titulo.trim() || !tarefa.venceEm || criarTarefa.isPending} onClick={() => criarTarefa.mutate()}>Adicionar</button>
                </div>
              )}
              {criarTarefa.error && <Erro erro={criarTarefa.error} />}
              {!l.tarefas.length && <p className="muted">Nenhuma tarefa.</p>}
              {l.tarefas.map((t: any) => {
                const vencida = !t.feitaEm && new Date(t.venceEm) < new Date();
                return (
                  <label key={t.id} className="evento" style={{ cursor: 'pointer', textDecoration: t.feitaEm ? 'line-through' : undefined, opacity: t.feitaEm ? 0.6 : 1 }}>
                    <input type="checkbox" checked={!!t.feitaEm} disabled={!editar} onChange={(e) => marcar.mutate({ tid: t.id, feita: e.target.checked })} />
                    <div style={{ flex: 1 }}>
                      <div>{t.titulo}</div>
                      <div className="muted" style={{ fontSize: 12, color: vencida ? 'var(--erro)' : undefined }}>{vencida ? 'Vencida · ' : ''}{new Date(t.venceEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · {t.responsavel ?? 'sem responsável'}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
          {l.valor > 0 && <div className="muted" style={{ textAlign: 'right' }}>Valor do card: {reais(l.valor)}</div>}
        </div>
      </div>
      {perda && <Motivo titulo={`Mover para ${perda.nome}`} fechar={() => setPerda(null)} confirmar={(m) => { patch.mutate({ etapaId: perda.id, motivoPerda: m }); setPerda(null); }} />}
      {aprovar && <Aprovar leadId={l.id} nome={l.titulo} fechar={() => { setAprovar(false); atualizar(); }} />}
    </div>
  );
}

/** Informação que veio de fora (importação, formulário) sem campo cadastrado: dá para editar, apagar ou transformar em campo. */
function ExtraSemCampo({ nome, valor, editar, gestor, mudar, tirar, fixar }: { nome: string; valor: string; editar: boolean; gestor: boolean; mudar: (v: string) => void; tirar: () => void; fixar: () => void }) {
  const [v, setV] = useState(valor ?? '');
  useEffect(() => setV(valor ?? ''), [valor]);
  return (
    <div className="par">
      <span title="Informação sem campo cadastrado">{nome}</span>
      <span className="sem-def">
        <input value={v} disabled={!editar} onChange={(e) => setV(e.target.value)} onBlur={() => v !== valor && mudar(v)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        {gestor && <button className="botao claro pequeno" title="Cadastrar como campo (aparece em todos os cards)" onClick={fixar}>fixar</button>}
        {editar && <button className="botao claro pequeno" title="Apagar esta informação" onClick={() => window.confirm(`Apagar "${nome}" deste cadastro?`) && tirar()}>×</button>}
      </span>
    </div>
  );
}
