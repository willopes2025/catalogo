import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ErroApi, pode } from '../api';
import { documento, telefone } from '../formato';
import { Abas, Campo, Carregando, Erro, StatusPessoa, Topo } from '../componentes/ui';
import { BotaoAssertiva } from '../componentes/BotaoAssertiva';

type Tipo = 'cliente' | 'fornecedor' | 'transportadora' | 'assistencia';
const NOMES: Record<Tipo, [string, string]> = {
  cliente: ['Clientes', 'cliente'],
  fornecedor: ['Fornecedores', 'fornecedor'],
  transportadora: ['Transportadoras', 'transportadora'],
  assistencia: ['Assistências técnicas', 'assistência técnica'],
};

export function Cadastros() {
  const [params, setParams] = useSearchParams();
  const tipo = (params.get('tipo') as Tipo) ?? 'cliente';
  const [busca, setBusca] = useState('');
  const [ativa, setAtiva] = useState('');
  const navegar = useNavigate();
  const q = useQuery({ queryKey: ['cadastros', tipo, ativa], queryFn: () => api<{ itens: any[]; total: number }>(`/pessoas?tipo=${tipo}&busca=${encodeURIComponent(ativa)}`) });
  return (
    <>
      <Topo eb="Cadastros" titulo={NOMES[tipo][0]} sub={q.data && `${q.data.total} cadastros`} acoes={pode('cadastros', 'criar') && <Link className="botao" to={`/cadastros/novo?tipo=${tipo}`}>Novo {NOMES[tipo][1]}</Link>} />
      <Abas ativa={tipo} mudar={(t) => { setParams({ tipo: t }); setAtiva(''); setBusca(''); }} abas={Object.entries(NOMES).map(([k, v]) => [k as Tipo, v[0]])} />
      <form className="busca" onSubmit={(e) => { e.preventDefault(); setAtiva(busca); }}>
        <input placeholder="Nome, documento, telefone ou cidade" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <button className="botao claro">Buscar</button>
      </form>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : q.data!.itens.length === 0 ? <div className="cartao vazio">Nenhum cadastro.</div> : (
        <table className="tabela">
          <thead><tr><th>Nome</th><th>Documento</th><th>Telefone</th><th>Cidade</th><th>Situação</th></tr></thead>
          <tbody>
            {q.data!.itens.map((p) => (
              <tr key={p.id} className="clicavel" onClick={() => navegar(`/cadastros/${p.id}`)}>
                <td><b>{p.nome}</b>{p.nomeFantasia && <div className="muted">{p.nomeFantasia}</div>}</td>
                <td>{documento(p.documento) || '—'}</td>
                <td>{telefone(p.telefone1) || '—'}</td>
                <td>{[p.cidade, p.uf].filter(Boolean).join(' · ') || '—'}</td>
                <td><StatusPessoa status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function FichaCadastro() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const novo = !id;
  const navegar = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, any>>({ tipo: params.get('tipo') ?? 'cliente', tipoDocumento: 'cpf', status: 'ativo' });
  const q = useQuery({ queryKey: ['pessoa', id], queryFn: () => api<Record<string, any>>(`/pessoas/${id}`), enabled: !novo });
  const reps = useQuery({ queryKey: ['reps-select'], queryFn: () => api<{ itens: any[] }>('/pessoas?tipo=representante&status=ativo'), enabled: f.tipo === 'cliente' });
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const salvar = useMutation({
    mutationFn: () => {
      const { maletas, titulos, rede, nivel, lider, saldoCredito, documentos, criadoEm, atualizadoEm, id: _i, slug, referencias, ...c } = f;
      return novo ? api<any>('/pessoas', { corpo: c }) : api<any>(`/pessoas/${id}`, { metodo: 'PATCH', corpo: c });
    },
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['cadastros'] }); if (novo) navegar(`/cadastros/${p.id}`, { replace: true }); },
  });
  const campos = salvar.error instanceof ErroApi ? salvar.error.dados.campos ?? {} : {};
  if (!novo && q.isLoading) return <Carregando />;
  const tipo = f.tipo as Tipo;
  const editavel = novo ? pode('cadastros', 'criar') : pode('cadastros', 'editar');
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const inp = (k: string, r: string, cls = '', extra = {}) => <Campo rotulo={r} erro={campos[k]} className={cls}><input value={f[k] ?? ''} onChange={set(k)} className={campos[k] ? 'invalido' : ''} disabled={!editavel} {...extra} /></Campo>;
  const pj = f.tipoDocumento === 'cnpj';
  return (
    <>
      <Topo eb={`Cadastros · ${NOMES[tipo]?.[0] ?? ''}`} titulo={novo ? `Novo ${NOMES[tipo]?.[1]}` : f.nome} acoes={editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>Salvar</button>} />
      {salvar.isSuccess && <div className="aviso ok" style={{ marginBottom: 12 }}>Cadastro salvo.</div>}
      {salvar.error && <div style={{ marginBottom: 12 }}><Erro erro={salvar.error} /></div>}
      <div className="cartao form">
        <div className="secao">Identificação</div>
        <Campo rotulo="Pessoa"><select value={f.tipoDocumento} onChange={(e) => setF({ ...f, tipoDocumento: e.target.value })} disabled={!editavel || !novo}><option value="cpf">Física (CPF)</option><option value="cnpj">Jurídica (CNPJ)</option></select></Campo>
        {inp('documento', pj ? 'CNPJ' : 'CPF', '', { inputMode: 'numeric' })}
        {!pj && tipo === 'cliente' && editavel && <div className="campo"><label>&nbsp;</label><BotaoAssertiva cpf={f.documento} aplicar={(d) => setF({ ...f, ...d })} /></div>}
        {inp('nome', pj ? 'Razão social' : 'Nome completo', 'l2')}
        {pj && inp('nomeFantasia', 'Nome fantasia', 'l2')}
        {pj && inp('inscricaoEstadual', 'Inscrição estadual')}
        {!pj && inp('nascimento', 'Nascimento', '', { type: 'date' })}
        <div className="secao">Contato</div>
        {inp('telefone1', 'Telefone / WhatsApp')}
        {inp('telefone2', 'Telefone 2')}
        {inp('email', 'E-mail', '', { type: 'email' })}
        {inp('instagram', 'Instagram')}
        <div className="secao">Endereço</div>
        {inp('cep', 'CEP')}
        {inp('logradouro', 'Logradouro', 'l2')}
        {inp('numero', 'Número')}
        {inp('complemento', 'Complemento')}
        {inp('bairro', 'Bairro')}
        {inp('cidade', 'Cidade')}
        {inp('uf', 'UF', '', { maxLength: 2 })}
        {tipo === 'cliente' && (
          <>
            <div className="secao">Vínculo</div>
            <Campo rotulo="Representante que atende" className="l2"><select value={f.representanteId ?? ''} onChange={(e) => setF({ ...f, representanteId: e.target.value || null })} disabled={!editavel}><option value="">Nenhuma (cliente da matriz ou da loja)</option>{reps.data?.itens.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}</select></Campo>
            <div className="campo l2"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={!!f.consentimentoLgpd} onChange={(e) => setF({ ...f, consentimentoLgpd: e.target.checked })} disabled={!editavel} /> Cliente autorizou o uso dos dados (LGPD)</label></div>
          </>
        )}
        <div className="secao">Outros</div>
        <Campo rotulo="Situação"><select value={f.status} onChange={set('status')} disabled={!editavel}><option value="ativo">Ativo</option><option value="inativo">Inativo</option></select></Campo>
        <Campo rotulo="Observação" className="l2"><input value={f.observacao ?? ''} onChange={set('observacao')} disabled={!editavel} /></Campo>
      </div>
    </>
  );
}
