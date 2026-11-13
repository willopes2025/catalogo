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
                  <td>{m.nome}{m.versao === 2 && <span className="muted"> · V2</span>}</td>
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
  const q = useQuery({ queryKey: ['integracoes'], queryFn: () => api<any[]>('/integracoes/status') });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      <table className="tabela">
        <thead><tr><th>Integração</th><th>Versão</th><th>Situação</th></tr></thead>
        <tbody>{q.data!.map((i) => <tr key={i.chave}><td>{i.nome}</td><td>V{i.versao}</td><td>{i.ligada ? <span className="etiqueta ok">Ligada</span> : <span className="etiqueta neutra">Aguardando credenciais</span>}</td></tr>)}</tbody>
      </table>
      <p className="muted">As chaves ficam guardadas no servidor (arquivo .env da VPS), nunca no navegador. A Wide liga cada integração quando a Aritana enviar o acesso.</p>
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
      <p className="muted">Razão social, CNPJ e cidade entram nos contratos e promissórias e, na semana 3, nas notas fiscais.</p>
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
