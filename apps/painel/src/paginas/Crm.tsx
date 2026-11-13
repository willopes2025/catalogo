import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, pode } from '../api';
import { data, dataHora, telefone } from '../formato';
import { Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

const ETAPAS: [string, string][] = [['nova', 'Novas'], ['contato', 'Em contato'], ['entrevista', 'Entrevista'], ['documentos', 'Documentos'], ['aprovada', 'Aprovadas'], ['recusada', 'Recusadas']];
const MODELO: Record<string, string> = { consignado: 'Consignado', revenda: 'Revenda', afiliado: 'Afiliada', nao_sei: 'Ainda não sabe' };

export function Crm() {
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState<string | null>(null);
  const [nova, setNova] = useState(false);
  const q = useQuery({ queryKey: ['crm', busca], queryFn: () => api<any[]>(`/crm/candidaturas${busca ? `?busca=${encodeURIComponent(busca)}` : ''}`) });
  const resumo = useQuery({ queryKey: ['crm-resumo'], queryFn: () => api<any>('/crm/resumo') });
  const linkForm = `${window.location.origin}/cadastro`;
  const copiar = async (t: string) => { try { await navigator.clipboard.writeText(t); } catch { window.prompt('Copie:', t); } };
  return (
    <>
      <Topo
        eb="Candidatas"
        titulo="Captação e triagem"
        sub="Do formulário até virar representante"
        acoes={<><button className="botao claro" onClick={() => void copiar(linkForm)} title={linkForm}>Copiar link do formulário</button>{pode('crm', 'criar') && <button className="botao" onClick={() => setNova(true)}>Nova candidata</button>}</>}
      />
      {resumo.data && (
        <div className="grade g4" style={{ marginBottom: 14 }}>
          <Indicador rotulo="Novas" valor={resumo.data.porEtapa.nova ?? 0} tipo={(resumo.data.porEtapa.nova ?? 0) > 0 ? 'atencao' : undefined} detalhe="Aguardando o primeiro contato" />
          <Indicador rotulo="Em andamento" valor={(resumo.data.porEtapa.contato ?? 0) + (resumo.data.porEtapa.entrevista ?? 0) + (resumo.data.porEtapa.documentos ?? 0)} />
          <Indicador rotulo="Aprovadas (30 dias)" valor={resumo.data.porEtapa.aprovada ?? 0} tipo="destaque" />
          <Indicador rotulo="De onde vêm (90 dias)" valor={resumo.data.porOrigem[0]?.origem ?? '—'} detalhe={resumo.data.porOrigem.slice(0, 3).map((o: any) => `${o.origem}: ${o.n} (${o.aprovadas} aprov.)`).join(' · ') || undefined} />
        </div>
      )}
      <div className="busca"><input placeholder="Buscar por nome, cidade ou WhatsApp" value={busca} onChange={(e) => setBusca(e.target.value)} /></div>
      {nova && <NovaCandidata fechar={() => setNova(false)} />}
      {aberta && <FichaCandidata id={aberta} fechar={() => setAberta(null)} />}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <div className="kanban">
          {ETAPAS.map(([e, rotulo]) => {
            const lista = q.data!.filter((c) => c.etapa === e);
            return (
              <div key={e} className="kanban-coluna">
                <div className="kanban-titulo">{rotulo} <span>{lista.length}</span></div>
                {lista.map((c) => (
                  <button key={c.id} className={`kanban-cartao ${aberta === c.id ? 'ativo' : ''}`} onClick={() => setAberta(c.id)}>
                    <b>{c.nome}</b>
                    <span className="muted">{c.cidade}/{c.uf} · {MODELO[c.modeloInteresse] ?? '—'}</span>
                    <span className="muted">{telefone(c.telefone)}{c.origem?.utm_source ? ` · ${c.origem.utm_source}` : ''}</span>
                    {c.proximoContato && <span className={`etiqueta ${c.proximoContato <= new Date().toISOString().slice(0, 10) ? 'erro' : 'neutra'}`}>Retornar {data(c.proximoContato)}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function FichaCandidata({ id, fechar }: { id: string; fechar: () => void }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const q = useQuery({ queryKey: ['crm-ficha', id], queryFn: () => api<any>(`/crm/candidaturas/${id}`) });
  const usuarios = useQuery({ queryKey: ['vendedoras'], queryFn: () => api<any[]>('/comissoes/vendedoras').catch(() => []) });
  const [nota, setNota] = useState('');
  const [modelo, setModelo] = useState('consignado');
  const pronto = () => { qc.invalidateQueries({ queryKey: ['crm'] }); qc.invalidateQueries({ queryKey: ['crm-ficha', id] }); qc.invalidateQueries({ queryKey: ['crm-resumo'] }); };
  const mudar = useMutation({ mutationFn: (corpo: any) => api(`/crm/candidaturas/${id}`, { metodo: 'PATCH', corpo }), onSuccess: () => { setNota(''); pronto(); } });
  const aprovar = useMutation({ mutationFn: () => api<{ pessoaId: string }>(`/crm/candidaturas/${id}/aprovar`, { corpo: { modeloTrabalho: modelo } }), onSuccess: (r) => { pronto(); navegar(`/rede/${r.pessoaId}`); } });
  if (q.isLoading) return <div className="cartao"><Carregando /></div>;
  if (q.error) return <Erro erro={q.error} />;
  const c = q.data;
  const fechada = ['aprovada', 'recusada'].includes(c.etapa);
  const fone = c.telefone.replace(/\D/g, '');
  const msg = `Olá, ${c.nome.split(' ')[0]}! Aqui é da Aritana Semijoias. Recebemos seu cadastro para ser revendedora e queremos conversar com você.`;
  return (
    <div className="cartao coluna" style={{ marginBottom: 14, borderColor: 'var(--dourado)' }}>
      <div className="flex entre" style={{ flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{c.nome} <span className="muted">· candidatura nº {c.numero}</span></h2>
        <div className="flex">
          <a className="botao" href={`https://wa.me/55${fone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer">WhatsApp</a>
          <button className="botao claro" onClick={fechar}>Fechar</button>
        </div>
      </div>
      <div className="grade g4">
        <div><div className="muted">WhatsApp</div>{telefone(c.telefone)}</div>
        <div><div className="muted">E-mail</div>{c.email ?? '—'}</div>
        <div><div className="muted">Cidade</div>{c.cidade}/{c.uf}</div>
        <div><div className="muted">Interesse</div>{MODELO[c.modeloInteresse] ?? '—'}</div>
        <div><div className="muted">CPF</div>{c.cpf ?? '—'}</div>
        <div><div className="muted">Instagram</div>{c.instagram ?? '—'}</div>
        <div><div className="muted">Como conheceu</div>{c.comoConheceu ?? '—'}{c.indicadaPor ? ` · indicada por ${c.indicadaPor}` : ''}</div>
        <div><div className="muted">Origem</div>{[c.origem?.utm_source, c.origem?.utm_campaign].filter(Boolean).join(' · ') || 'direto'}</div>
      </div>
      {c.experiencia && <p><b>Experiência:</b> {c.experiencia}</p>}
      {c.conflitos.length > 0 && <div className="aviso alerta">Já existe representante com este CPF ou telefone: {c.conflitos.map((p: any) => <Link key={p.id} to={`/rede/${p.id}`}>{p.nome} ({p.status}) </Link>)}</div>}
      {c.pessoaId && <div className="aviso ok">Aprovada. <Link to={`/rede/${c.pessoaId}`}>Abrir a ficha da representante</Link></div>}
      {c.etapa === 'recusada' && c.motivoRecusa && <div className="aviso alerta">Recusada: {c.motivoRecusa}</div>}
      {(mudar.error || aprovar.error) && <Erro erro={mudar.error ?? aprovar.error} />}
      {!fechada && pode('crm', 'editar') && (
        <div className="form">
          <Campo rotulo="Etapa">
            <select value={c.etapa} onChange={(e) => (e.target.value === 'recusada' ? (() => { const m = window.prompt('Motivo da recusa:'); if (m) mudar.mutate({ etapa: 'recusada', motivoRecusa: m }); })() : mudar.mutate({ etapa: e.target.value }))}>
              {ETAPAS.filter(([e]) => e !== 'aprovada').map(([e, r]) => <option key={e} value={e}>{r}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Responsável">
            <select value={c.responsavelId ?? ''} onChange={(e) => mudar.mutate({ responsavelId: e.target.value || null })}>
              <option value="">—</option>
              {usuarios.data?.filter((u) => u.ativo).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Retornar em"><input type="date" value={c.proximoContato ?? ''} onChange={(e) => mudar.mutate({ proximoContato: e.target.value || null })} /></Campo>
          <div />
          {pode('rede', 'criar') && (
            <>
              <Campo rotulo="Aprovar no modelo">
                <select value={modelo} onChange={(e) => setModelo(e.target.value)}><option value="consignado">Consignado (maleta)</option><option value="revenda">Revenda</option><option value="afiliado">Afiliada</option></select>
              </Campo>
              <div className="campo"><label>&nbsp;</label><button className="botao" disabled={aprovar.isPending} onClick={() => window.confirm(`Aprovar ${c.nome} e criar a representante?`) && aprovar.mutate()}>Aprovar e criar representante</button></div>
            </>
          )}
        </div>
      )}
      <div>
        <div className="secao" style={{ gridColumn: 'auto' }}>Histórico</div>
        {c.notas.map((n: any) => <div key={n.id} className="resumo-linha"><span>{n.texto}</span><span className="muted">{n.autor ?? 'Formulário'} · {dataHora(n.criadoEm)}</span></div>)}
        {!c.notas.length && <p className="muted">Cadastro recebido em {dataHora(c.criadoEm)}.</p>}
        {pode('crm', 'editar') && (
          <div className="flex" style={{ marginTop: 10 }}>
            <input style={{ flex: 1 }} placeholder="Anotar contato, combinado, próximo passo…" value={nota} onChange={(e) => setNota(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && nota.trim() && mudar.mutate({ nota })} />
            <button className="botao claro" disabled={!nota.trim() || mudar.isPending} onClick={() => mudar.mutate({ nota })}>Anotar</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NovaCandidata({ fechar }: { fechar: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ nome: '', telefone: '', email: '', cidade: '', uf: 'ES', modeloInteresse: 'nao_sei', indicadaPor: '' });
  const m = useMutation({ mutationFn: () => api('/crm/candidaturas', { corpo: { ...f, email: f.email || null, indicadaPor: f.indicadaPor || null } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm'] }); fechar(); } });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="cartao form" style={{ marginBottom: 14 }}>
      <div className="secao">Nova candidata (cadastro pela equipe)</div>
      <Campo rotulo="Nome completo" className="l2"><input value={f.nome} onChange={set('nome')} /></Campo>
      <Campo rotulo="WhatsApp"><input value={f.telefone} onChange={set('telefone')} /></Campo>
      <Campo rotulo="E-mail"><input value={f.email} onChange={set('email')} /></Campo>
      <Campo rotulo="Cidade"><input value={f.cidade} onChange={set('cidade')} /></Campo>
      <Campo rotulo="UF"><input maxLength={2} value={f.uf} onChange={set('uf')} /></Campo>
      <Campo rotulo="Interesse"><select value={f.modeloInteresse} onChange={set('modeloInteresse')}>{Object.entries(MODELO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
      <Campo rotulo="Indicada por"><input value={f.indicadaPor} onChange={set('indicadaPor')} /></Campo>
      <div className="coluna" style={{ gridColumn: 'span 4' }}>
        {m.error && <Erro erro={m.error} />}
        <div className="flex"><button className="botao" disabled={m.isPending} onClick={() => m.mutate()}>Cadastrar</button><button className="botao claro" onClick={fechar}>Cancelar</button></div>
      </div>
    </div>
  );
}
