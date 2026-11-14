import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACOES, MODULOS } from '@aritana/regras';
import { api, pode } from '../api';
import { dataHora } from '../formato';
import { Campo, Carregando, Erro } from '../componentes/ui';

// ───────────── Usuários ─────────────

export function Usuarios() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['usuarios'], queryFn: () => api<any[]>('/usuarios') });
  const grupos = useQuery({ queryKey: ['grupos'], queryFn: () => api<any[]>('/grupos') });
  const [novo, setNovo] = useState({ nome: '', email: '', grupoId: '' });
  const [senha, setSenha] = useState<{ email: string; senha: string } | null>(null);
  const criar = useMutation({
    mutationFn: () => api<any>('/usuarios', { corpo: novo }),
    onSuccess: (u) => { setSenha({ email: u.email, senha: u.senhaProvisoria }); setNovo({ nome: '', email: '', grupoId: '' }); qc.invalidateQueries({ queryKey: ['usuarios'] }); qc.invalidateQueries({ queryKey: ['grupos'] }); },
  });
  const editar = useMutation({ mutationFn: ({ id, corpo }: { id: string; corpo: any }) => api(`/usuarios/${id}`, { metodo: 'PATCH', corpo }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['usuarios'] }); qc.invalidateQueries({ queryKey: ['grupos'] }); } });
  const nova = useMutation({ mutationFn: (u: any) => api<any>(`/usuarios/${u.id}/nova-senha`, { corpo: {} }).then((r) => ({ ...r, email: u.email })), onSuccess: (r) => setSenha({ email: r.email, senha: r.senhaProvisoria }) });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      {senha && (
        <div className="aviso ok">
          Senha provisória de <b>{senha.email}</b>: <code style={{ fontSize: 16, fontWeight: 700 }}>{senha.senha}</code><br />
          Ela aparece só agora. Repasse à pessoa por um canal seguro e peça para trocar no primeiro acesso.
        </div>
      )}
      {(criar.error || editar.error || nova.error) && <Erro erro={criar.error ?? editar.error ?? nova.error} />}
      <table className="tabela">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Grupo</th><th>Último acesso</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          {q.data!.map((u) => (
            <tr key={u.id}>
              <td><b>{u.nome}</b></td>
              <td>{u.email}</td>
              <td>
                <select value={u.grupoId} disabled={!pode('configuracoes', 'editar')} onChange={(e) => editar.mutate({ id: u.id, corpo: { grupoId: e.target.value } })}>
                  {grupos.data?.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
                </select>
              </td>
              <td>{dataHora(u.ultimoAcesso)}</td>
              <td>{u.ativo ? <span className="etiqueta ok">Ativo</span> : <span className="etiqueta neutra">Inativo</span>}</td>
              <td className="flex">
                {pode('configuracoes', 'editar') && <button className="botao claro pequeno" onClick={() => editar.mutate({ id: u.id, corpo: { ativo: !u.ativo } })}>{u.ativo ? 'Desativar' : 'Reativar'}</button>}
                {pode('configuracoes', 'editar') && <button className="botao claro pequeno" onClick={() => nova.mutate(u)}>Nova senha</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pode('configuracoes', 'criar') && (
        <div className="cartao form">
          <div className="secao">Novo usuário</div>
          <Campo rotulo="Nome"><input value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} /></Campo>
          <Campo rotulo="E-mail"><input type="email" value={novo.email} onChange={(e) => setNovo({ ...novo, email: e.target.value })} /></Campo>
          <Campo rotulo="Grupo"><select value={novo.grupoId} onChange={(e) => setNovo({ ...novo, grupoId: e.target.value })}><option value="">Escolha</option>{grupos.data?.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}</select></Campo>
          <div className="campo"><label>&nbsp;</label><button className="botao" disabled={!novo.nome || !novo.email || !novo.grupoId || criar.isPending} onClick={() => criar.mutate()}>Criar usuário</button></div>
        </div>
      )}
    </div>
  );
}

// ───────────── Grupos e permissões ─────────────

const NOME_ACAO: Record<string, string> = { ver: 'Ver', criar: 'Criar', editar: 'Editar', excluir: 'Excluir', exportar: 'Exportar' };

export function Grupos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['grupos'], queryFn: () => api<any[]>('/grupos') });
  const [selId, setSelId] = useState<string>('');
  const [perm, setPerm] = useState<Record<string, string[]>>({});
  const [novoNome, setNovoNome] = useState('');
  const sel = q.data?.find((g) => g.id === selId) ?? q.data?.[0];
  useEffect(() => { if (sel) { setSelId(sel.id); setPerm(sel.permissoes); } }, [sel?.id, q.data]);
  const total = perm['*']?.includes('*');
  const salvar = useMutation({ mutationFn: () => api(`/grupos/${sel.id}`, { metodo: 'PATCH', corpo: { permissoes: perm } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['grupos'] }) });
  const criar = useMutation({ mutationFn: () => api<any>('/grupos', { corpo: { nome: novoNome, permissoes: { inicio: ['ver'] } } }), onSuccess: (g) => { setNovoNome(''); setSelId(g.id); qc.invalidateQueries({ queryKey: ['grupos'] }); } });
  if (q.isLoading) return <Carregando />;
  const editavel = pode('configuracoes', 'editar');
  const alternar = (mod: string, acao: string) => {
    const atual = new Set(perm[mod] ?? []);
    atual.has(acao) ? atual.delete(acao) : atual.add(acao);
    if (acao !== 'ver' && atual.has(acao)) atual.add('ver');
    if (acao === 'ver' && !atual.has('ver')) atual.clear();
    setPerm({ ...perm, [mod]: [...atual] });
  };
  return (
    <div className="grade" style={{ gridTemplateColumns: '240px 1fr', alignItems: 'start' }}>
      <div className="cartao coluna" style={{ gap: 6 }}>
        {q.data!.map((g) => (
          <button key={g.id} className={`botao ${g.id === sel?.id ? '' : 'claro'}`} style={{ justifyContent: 'space-between' }} onClick={() => setSelId(g.id)}>
            {g.nome} <span style={{ fontWeight: 400 }}>{g.usuarios}</span>
          </button>
        ))}
        {pode('configuracoes', 'criar') && (
          <div className="flex" style={{ marginTop: 8 }}>
            <input placeholder="Novo grupo" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
            <button className="botao pequeno" disabled={novoNome.length < 2} onClick={() => criar.mutate()}>+</button>
          </div>
        )}
      </div>
      <div className="coluna">
        {(salvar.error || criar.error) && <Erro erro={salvar.error ?? criar.error} />}
        {salvar.isSuccess && <div className="aviso ok">Permissões salvas. Valem no próximo login de cada usuário.</div>}
        <div className="flex entre">
          <label className="check"><input type="checkbox" checked={!!total} disabled={!editavel} onChange={(e) => setPerm(e.target.checked ? { '*': ['*'] } : {})} /> Acesso total (diretoria)</label>
          {editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar permissões</button>}
        </div>
        {!total && (
          <table className="tabela">
            <thead><tr><th>Módulo</th>{ACOES.map((a) => <th key={a} style={{ textAlign: 'center' }}>{NOME_ACAO[a]}</th>)}</tr></thead>
            <tbody>
              {MODULOS.map((m) => (
                <tr key={m.chave}>
                  <td>{m.nome}{(m.versao as number) === 2 && <span className="muted"> · V2</span>}</td>
                  {ACOES.map((a) => <td key={a} style={{ textAlign: 'center' }}><input type="checkbox" style={{ width: 'auto' }} disabled={!editavel} checked={(perm[m.chave] ?? []).includes(a)} onChange={() => alternar(m.chave, a)} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ───────────── Modelos de documento ─────────────

const TIPO_DOC: Record<string, string> = { contrato: 'Contrato', promissoria: 'Promissória', aditivo: 'Aditivo' };

export function Modelos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['modelos'], queryFn: () => api<any[]>('/documentos/modelos') });
  const vars = useQuery({ queryKey: ['variaveis'], queryFn: () => api<{ chave: string; descricao: string }[]>('/documentos/variaveis') });
  const [sel, setSel] = useState<any | null>(null);
  const salvar = useMutation({
    mutationFn: () => {
      const { id, tipo, modeloTrabalho, titulo, conteudo, ativo } = sel;
      const corpo = { tipo, modeloTrabalho: modeloTrabalho || null, titulo, conteudo, ativo };
      return id ? api<any>(`/documentos/modelos/${id}`, { metodo: 'PATCH', corpo }) : api<any>('/documentos/modelos', { corpo });
    },
    onSuccess: (m) => { setSel(m); qc.invalidateQueries({ queryKey: ['modelos'] }); },
  });
  if (q.isLoading) return <Carregando />;
  const editavel = pode('configuracoes', 'editar');
  return (
    <div className="grade" style={{ gridTemplateColumns: '300px 1fr', alignItems: 'start' }}>
      <div className="coluna">
        {q.data!.map((m) => (
          <button key={m.id} className="cartao" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', borderColor: sel?.id === m.id ? 'var(--dourado)' : undefined, boxShadow: sel?.id === m.id ? '0 0 0 2px var(--areia)' : undefined }} onClick={() => setSel(m)}>
            <b>{TIPO_DOC[m.tipo]}</b> · v{m.versao} {!m.ativo && <span className="etiqueta neutra">inativo</span>}<div className="muted">{m.titulo}</div>
          </button>
        ))}
        {editavel && <button className="botao claro" onClick={() => setSel({ tipo: 'contrato', modeloTrabalho: 'consignado', titulo: '', conteudo: '', ativo: true })}>Novo modelo</button>}
      </div>
      {!sel ? <div className="cartao vazio">Escolha um modelo para ver ou editar.</div> : (
        <div className="coluna">
          {salvar.error && <Erro erro={salvar.error} />}
          {salvar.isSuccess && <div className="aviso ok">Modelo salvo (versão {sel.versao}). Documentos já gerados mantêm o texto antigo.</div>}
          <div className="cartao form">
            <Campo rotulo="Tipo"><select value={sel.tipo} onChange={(e) => setSel({ ...sel, tipo: e.target.value })} disabled={!editavel || !!sel.id}>{Object.entries(TIPO_DOC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
            <Campo rotulo="Vale para"><select value={sel.modeloTrabalho ?? ''} onChange={(e) => setSel({ ...sel, modeloTrabalho: e.target.value || null })} disabled={!editavel}><option value="">Todos os modelos</option><option value="consignado">Consignado</option><option value="revenda">Revenda</option><option value="afiliado">Afiliada</option></select></Campo>
            <Campo rotulo="Título" className="l2"><input value={sel.titulo} onChange={(e) => setSel({ ...sel, titulo: e.target.value })} disabled={!editavel} /></Campo>
            <Campo rotulo="Texto" className="l4"><textarea rows={22} style={{ fontFamily: 'inherit', lineHeight: 1.5 }} value={sel.conteudo} onChange={(e) => setSel({ ...sel, conteudo: e.target.value })} disabled={!editavel} /></Campo>
            <div className="flex l4 entre">
              <label className="check"><input type="checkbox" checked={sel.ativo} onChange={(e) => setSel({ ...sel, ativo: e.target.checked })} disabled={!editavel} /> Ativo</label>
              {editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar modelo</button>}
            </div>
          </div>
          <div className="cartao">
            <h3 style={{ marginBottom: 8 }}>Variáveis que podem ser usadas no texto</h3>
            <div className="grade g3" style={{ gap: 4 }}>{vars.data?.map((v) => <div key={v.chave} className="muted"><code>{`{{${v.chave}}}`}</code> {v.descricao}</div>)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── Integrações ─────────────

export function Integracoes() {
  const q = useQuery({ queryKey: ['integracoes-campos'], queryFn: () => api<any[]>('/integracoes') });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  return (
    <div className="coluna">
      <p className="muted" style={{ margin: 0 }}>
        Preencha cada integração quando a Aritana tiver o acesso. As senhas e chaves ficam cifradas no servidor e nunca voltam para a tela: depois de salvas, aparecem só os últimos caracteres.
      </p>
      {q.data!.map((i) => <CartaoIntegracao key={i.chave} i={i} />)}
      <div className="cartao">
        <div className="secao" style={{ marginTop: 0 }}>Próximas integrações (Versão 2)</div>
        <p className="muted" style={{ margin: 0 }}>WhatsApp oficial, Serasa, Meta Ads e Google Ads, PagBank e Sicoob.</p>
      </div>
    </div>
  );
}

function CartaoIntegracao({ i }: { i: any }) {
  const qc = useQueryClient();
  const editavel = pode('configuracoes', 'editar');
  const [v, setV] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const salvar = useMutation({
    mutationFn: () => api<{ ligada: boolean }>(`/integracoes/${i.chave}`, { metodo: 'PUT', corpo: { valores: v } }),
    onSuccess: (r) => { setV({}); setMsg(r.ligada ? 'Salvo. Integração ligada.' : 'Salvo.'); qc.invalidateQueries({ queryKey: ['integracoes-campos'] }); qc.invalidateQueries({ queryKey: ['implantacao'] }); },
  });
  const apagar = useMutation({
    mutationFn: (nome: string) => api(`/integracoes/${i.chave}`, { metodo: 'PUT', corpo: { valores: { [nome]: null } } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integracoes-campos'] }),
  });
  const gerar = useMutation({ mutationFn: (nome: string) => api(`/integracoes/${i.chave}/gerar/${nome}`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['integracoes-campos'] }) });
  const testar = useMutation({ mutationFn: () => api<{ mensagem: string }>(`/integracoes/${i.chave}/testar`, { corpo: {} }) });
  const mudou = Object.keys(v).length > 0;
  const copiar = async (t: string) => { try { await navigator.clipboard.writeText(t); } catch { window.prompt('Copie:', t); } };
  return (
    <div className="cartao form">
      <div className="secao flex entre" style={{ gridColumn: 'span 4' }}>
        <span>{i.nome}</span>
        <span>{i.ligada ? <span className="etiqueta ok">Ligada{i.ambiente ? ` · ${i.ambiente}` : ''}</span> : <span className="etiqueta neutra">Aguardando acesso</span>}</span>
      </div>
      <p className="muted" style={{ gridColumn: 'span 4', margin: 0 }}>{i.descricao} <b>Onde conseguir:</b> {i.ondeConseguir}</p>
      {i.campos.map((c: any) => {
        const ajuda = [c.ajuda, c.origem === 'servidor' ? 'Hoje vem do arquivo do servidor; o que for salvo aqui passa a valer.' : null, c.ilegivel ? 'Não foi possível ler o valor salvo; preencha de novo.' : null].filter(Boolean).join(' ');
        return (
          <Campo key={c.nome} rotulo={c.rotulo} ajuda={ajuda || undefined} className={c.nome.includes('REMETENTE') || c.nome.includes('SUPORTE') ? 'l2' : ''}>
            {c.opcoes ? (
              <select disabled={!editavel} value={v[c.nome] ?? c.valor ?? ''} onChange={(e) => setV({ ...v, [c.nome]: e.target.value })}>
                <option value="">{c.origem === 'servidor' ? 'Definido no servidor' : 'Escolha'}</option>
                {c.opcoes.map(([o, r]: [string, string]) => <option key={o} value={o}>{r}</option>)}
              </select>
            ) : c.secreto ? (
              <div className="flex" style={{ gap: 6 }}>
                <input
                  type={c.mostrar && c.valor ? 'text' : 'password'}
                  autoComplete="new-password"
                  disabled={!editavel}
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder={c.preenchido ? `Salvo${c.final ? ` (final ${c.final})` : ''}; em branco mantém` : ''}
                  value={v[c.nome] ?? (c.mostrar ? c.valor ?? '' : '')}
                  onChange={(e) => setV({ ...v, [c.nome]: e.target.value })}
                />
                {c.mostrar && c.valor && <button type="button" className="botao claro pequeno" onClick={() => void copiar(c.valor)}>Copiar</button>}
                {c.gerar && editavel && <button type="button" className="botao claro pequeno" disabled={gerar.isPending} onClick={() => (!c.preenchido || window.confirm('Gerar um token novo? O antigo para de valer e precisa ser trocado no Asaas.')) && gerar.mutate(c.nome)}>Gerar</button>}
                {c.preenchido && c.origem === 'tela' && editavel && !c.gerar && <button type="button" className="botao claro pequeno" onClick={() => window.confirm(`Apagar ${c.rotulo}?`) && apagar.mutate(c.nome)}>Apagar</button>}
              </div>
            ) : (
              <input disabled={!editavel} value={v[c.nome] ?? c.valor ?? ''} onChange={(e) => setV({ ...v, [c.nome]: e.target.value })} />
            )}
          </Campo>
        );
      })}
      {i.extra?.webhookUrl && (
        <Campo rotulo="Endereço do webhook (cole no Asaas)" className="l2">
          <div className="flex" style={{ gap: 6 }}><input readOnly value={i.extra.webhookUrl} style={{ flex: 1, minWidth: 0 }} /><button type="button" className="botao claro pequeno" onClick={() => void copiar(i.extra.webhookUrl)}>Copiar</button></div>
        </Campo>
      )}
      <div className="coluna" style={{ gridColumn: 'span 4', gap: 8 }}>
        {(salvar.error || testar.error || gerar.error || apagar.error) && <Erro erro={salvar.error ?? testar.error ?? gerar.error ?? apagar.error} />}
        {msg && !mudou && <div className="aviso ok">{msg}</div>}
        {testar.data && <div className="aviso ok">{testar.data.mensagem}</div>}
        {editavel && (
          <div className="flex">
            <button className="botao" disabled={!mudou || salvar.isPending} onClick={() => { setMsg(null); testar.reset(); salvar.mutate(); }}>Salvar</button>
            <button className="botao claro" disabled={!i.ligada || mudou || testar.isPending} onClick={() => testar.mutate()}>{testar.isPending ? 'Testando…' : 'Testar conexão'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────── Empresas ─────────────

export function Empresas() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['empresas'], queryFn: () => api<any[]>('/empresas') });
  const [edit, setEdit] = useState<Record<string, any>>({});
  const salvar = useMutation({
    mutationFn: (e: any) => api(`/empresas/${e.id}`, { metodo: 'PATCH', corpo: { nome: e.nome, razaoSocial: e.razaoSocial, cnpj: e.cnpj, inscricaoEstadual: e.inscricaoEstadual, cidade: e.cidade, uf: e.uf } }),
    onSuccess: () => { setEdit({}); qc.invalidateQueries({ queryKey: ['empresas'] }); },
  });
  if (q.isLoading) return <Carregando />;
  const editavel = pode('configuracoes', 'editar');
  return (
    <div className="coluna">
      <p className="muted">Razão social, CNPJ, inscrição estadual e cidade entram nos contratos, nas promissórias e nas notas fiscais.</p>
      {salvar.error && <Erro erro={salvar.error} />}
      {q.data!.map((e0) => {
        const e = edit[e0.id] ?? e0;
        const set = (k: string) => (ev: { target: { value: string } }) => setEdit({ ...edit, [e0.id]: { ...e, [k]: ev.target.value } });
        return (
          <div key={e0.id} className="cartao form">
            <div className="secao">{e0.tipo === 'matriz' ? 'Matriz' : 'Loja'}</div>
            <Campo rotulo="Nome de exibição" className="l2"><input value={e.nome ?? ''} onChange={set('nome')} disabled={!editavel} /></Campo>
            <Campo rotulo="Razão social" className="l2"><input value={e.razaoSocial ?? ''} onChange={set('razaoSocial')} disabled={!editavel} /></Campo>
            <Campo rotulo="CNPJ"><input value={e.cnpj ?? ''} onChange={set('cnpj')} disabled={!editavel} /></Campo>
            <Campo rotulo="Inscrição estadual"><input value={e.inscricaoEstadual ?? ''} onChange={set('inscricaoEstadual')} disabled={!editavel} /></Campo>
            <Campo rotulo="Cidade"><input value={e.cidade ?? ''} onChange={set('cidade')} disabled={!editavel} /></Campo>
            <Campo rotulo="UF"><input value={e.uf ?? ''} maxLength={2} onChange={set('uf')} disabled={!editavel} /></Campo>
            {editavel && <div className="l4"><button className="botao" disabled={!edit[e0.id] || salvar.isPending} onClick={() => salvar.mutate(e)}>Salvar</button></div>}
          </div>
        );
      })}
    </div>
  );
}
