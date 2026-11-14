import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ErroApi, pode } from '../api';
import { centavosParaTexto, data, documento, paraCentavos, reais, telefone } from '../formato';
import { Abas, Campo, Carregando, Erro, StatusMaleta, StatusPessoa, Topo } from '../componentes/ui';
import { BotaoAssertiva } from '../componentes/BotaoAssertiva';
import { DocumentosPessoa } from '../componentes/DocumentosPessoa';

interface Linha {
  id: string; nome: string; documento: string | null; telefone1: string | null; cidade: string | null; uf: string | null;
  status: string; modeloTrabalho: string | null; limiteCredito: number; bloqueado: boolean; nivel: string | null; lider: string | null;
  maletaAberta: number; emAberto: number; vencido: number;
}

const MODELOS: Record<string, string> = { consignado: 'Consignado', revenda: 'Revenda', afiliado: 'Afiliada' };

export function Representantes() {
  const [params, setParams] = useSearchParams();
  const [busca, setBusca] = useState(params.get('busca') ?? '');
  const status = params.get('status') ?? '';
  const navegar = useNavigate();
  const q = useQuery({
    queryKey: ['representantes', params.toString()],
    queryFn: () => api<{ itens: Linha[]; total: number }>(`/pessoas?tipo=representante&${params.toString()}`),
  });

  return (
    <>
      <Topo eb="Rede" titulo="Representantes" sub={q.data ? `${q.data.total} cadastros` : undefined} acoes={<><Link className="botao claro" to="/rede/niveis">Níveis e metas</Link>{pode('rede', 'criar') && <Link className="botao" to="/rede/nova">Nova representante</Link>}</>} />
      <form
        className="busca"
        onSubmit={(e) => {
          e.preventDefault();
          const p = new URLSearchParams(params);
          busca ? p.set('busca', busca) : p.delete('busca');
          setParams(p);
        }}
      >
        <input placeholder="Nome, CPF, telefone ou cidade" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select
          value={status}
          onChange={(e) => {
            const p = new URLSearchParams(params);
            e.target.value ? p.set('status', e.target.value) : p.delete('status');
            setParams(p);
          }}
        >
          <option value="">Todas as situações</option>
          <option value="ativo">Ativas</option>
          <option value="triagem">Em triagem</option>
          <option value="inativo">Inativas</option>
          <option value="recusado">Recusadas</option>
        </select>
        <button className="botao claro">Buscar</button>
      </form>
      {q.isLoading ? (
        <Carregando />
      ) : q.error ? (
        <Erro erro={q.error} />
      ) : q.data!.itens.length === 0 ? (
        <div className="cartao vazio">Nenhuma representante encontrada.</div>
      ) : (
        <table className="tabela">
          <thead>
            <tr><th>Nome</th><th>Cidade</th><th>Telefone</th><th>Modelo</th><th>Nível</th><th>Líder</th><th className="num">Limite</th><th>Maleta</th><th>Financeiro</th><th>Situação</th></tr>
          </thead>
          <tbody>
            {q.data!.itens.map((r) => (
              <tr key={r.id} className="clicavel" onClick={() => navegar(`/rede/${r.id}`)}>
                <td><b>{r.nome}</b><div className="muted">{documento(r.documento)}</div></td>
                <td>{[r.cidade, r.uf].filter(Boolean).join(' · ')}</td>
                <td>{telefone(r.telefone1)}</td>
                <td>{r.modeloTrabalho ? MODELOS[r.modeloTrabalho] : '—'}</td>
                <td>{r.nivel ?? '—'}</td>
                <td>{r.lider ?? '—'}</td>
                <td className="num">{reais(r.limiteCredito)}</td>
                <td>{r.maletaAberta ? <span className="etiqueta ok">Aberta</span> : <span className="muted">—</span>}</td>
                <td>{r.vencido ? <span className="etiqueta erro">{reais(r.vencido)} vencido</span> : r.emAberto ? <span className="muted">{reais(r.emAberto)} a vencer</span> : <span className="etiqueta ok">Em dia</span>}</td>
                <td><StatusPessoa status={r.status} bloqueado={r.bloqueado} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

type Pessoa = Record<string, any>;
const VAZIA: Pessoa = { tipo: 'representante', tipoDocumento: 'cpf', status: 'triagem', modeloTrabalho: 'consignado', limiteCredito: 150000, referencias: [] };

export function FichaRepresentante() {
  const { id } = useParams();
  const nova = !id;
  const navegar = useNavigate();
  const qc = useQueryClient();
  type AbaFicha = 'dados' | 'rede' | 'credito' | 'maletas' | 'financeiro' | 'documentos';
  const [busca] = useSearchParams();
  const [aba, setAba] = useState<AbaFicha>(['rede', 'credito', 'maletas', 'financeiro', 'documentos'].includes(busca.get('aba') ?? '') ? (busca.get('aba') as AbaFicha) : 'dados');
  const [f, setF] = useState<Pessoa>(VAZIA);
  const [limiteTexto, setLimiteTexto] = useState(centavosParaTexto(VAZIA.limiteCredito));
  const [metaTexto, setMetaTexto] = useState('');
  const [comissaoTexto, setComissaoTexto] = useState('');

  const q = useQuery({ queryKey: ['pessoa', id], queryFn: () => api<Pessoa>(`/pessoas/${id}`), enabled: !nova });
  const niveis = useQuery({ queryKey: ['niveis'], queryFn: () => api<{ id: string; nome: string }[]>('/niveis') });
  const lideres = useQuery({ queryKey: ['lideres'], queryFn: () => api<{ itens: Linha[] }>('/pessoas?tipo=representante&status=ativo') });
  useEffect(() => {
    if (q.data) {
      setF(q.data);
      setLimiteTexto(centavosParaTexto(q.data.limiteCredito));
      setMetaTexto(q.data.metaMensal ? centavosParaTexto(q.data.metaMensal) : '');
      setComissaoTexto(q.data.comissaoPb != null ? String(q.data.comissaoPb / 100).replace('.', ',') : '');
    }
  }, [q.data]);

  const salvar = useMutation({
    mutationFn: () => {
      const { maletas, titulos, rede, nivel, lider, saldoCredito, documentos, slug, criadoEm, atualizadoEm, id: _id, ...corpo } = f;
      corpo.limiteCredito = paraCentavos(limiteTexto);
      corpo.metaMensal = metaTexto.trim() ? paraCentavos(metaTexto) : 0;
      corpo.comissaoPb = comissaoTexto.trim() ? Math.round(Number(comissaoTexto.replace(',', '.')) * 100) : null;
      corpo.referencias = (f.referencias ?? []).filter((r: any) => r.nome?.trim()).map(({ nome, telefone, relacao }: any) => ({ nome, telefone, relacao }));
      return nova ? api<Pessoa>('/pessoas', { corpo }) : api<Pessoa>(`/pessoas/${id}`, { metodo: 'PATCH', corpo });
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['representantes'] });
      qc.invalidateQueries({ queryKey: ['pessoa', p.id] });
      if (nova) navegar(`/rede/${p.id}`, { replace: true });
    },
  });
  const campos = salvar.error instanceof ErroApi ? salvar.error.dados.campos ?? {} : {};
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const editavel = nova ? pode('rede', 'criar') : pode('rede', 'editar');

  if (!nova && q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;

  const inp = (k: string, rotulo: string, extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {}, classe = '') => (
    <Campo rotulo={rotulo} erro={campos[k]} className={classe}>
      <input value={f[k] ?? ''} onChange={set(k)} className={campos[k] ? 'invalido' : ''} disabled={!editavel} {...extra} />
    </Campo>
  );

  return (
    <>
      <Topo
        eb={nova ? 'Rede · Nova representante' : 'Rede · Ficha da representante'}
        titulo={nova ? 'Nova representante' : f.nome}
        sub={!nova && <><StatusPessoa status={f.status} bloqueado={f.bloqueado} /> &nbsp; {f.nivel ?? 'Sem nível'} · Limite {reais(f.limiteCredito ?? 0)} · Crédito {reais(f.saldoCredito ?? 0)}</>}
        acoes={
          <>
            {!nova && f.slug && f.status === 'ativo' && <a className="botao claro" href={`/catalogo/${f.slug}`} target="_blank" rel="noreferrer">Ver catálogo</a>}
            {!nova && f.status === 'ativo' && pode('maletas', 'criar') && <Link className="botao claro" to={`/maletas/nova?representante=${id}`}>Nova maleta</Link>}
            {!nova && pode('rede', 'editar') && <AcessoPortal id={id!} />}
            {editavel && <button className="botao" onClick={() => salvar.mutate()} disabled={salvar.isPending}>{salvar.isPending ? 'Salvando…' : 'Salvar'}</button>}
          </>
        }
      />
      {salvar.isSuccess && <div className="aviso ok" style={{ marginBottom: 12 }}>Cadastro salvo.</div>}
      {salvar.error && <div style={{ marginBottom: 12 }}><Erro erro={salvar.error} /></div>}
      <Abas
        ativa={aba}
        mudar={setAba}
        abas={nova ? [['dados', 'Dados'], ['rede', 'Modelo e rede']] : [['dados', 'Dados'], ['rede', 'Modelo e rede'], ['credito', 'Crédito'], ['maletas', `Maletas (${f.maletas?.length ?? 0})`], ['financeiro', 'Financeiro'], ['documentos', `Documentos (${f.documentos?.length ?? 0})`]]}
      />
      <div className="cartao">
        {aba === 'dados' && (
          <div className="form">
            <div className="secao">Identificação</div>
            {inp('nome', 'Nome completo', { required: true }, 'l2')}
            {inp('documento', 'CPF', { inputMode: 'numeric', placeholder: '000.000.000-00' })}
            {editavel ? <div className="campo"><label>&nbsp;</label><BotaoAssertiva cpf={f.documento} aplicar={(d) => setF({ ...f, ...d })} /></div> : inp('rg', 'RG')}
            {editavel && inp('rg', 'RG')}
            {inp('nascimento', 'Nascimento', { type: 'date' })}
            <Campo rotulo="Gênero"><select value={f.genero ?? ''} onChange={set('genero')} disabled={!editavel}><option value="">—</option><option>Feminino</option><option>Masculino</option><option>Outro</option></select></Campo>
            <Campo rotulo="Estado civil"><select value={f.estadoCivil ?? ''} onChange={set('estadoCivil')} disabled={!editavel}><option value="">—</option><option>Solteira(o)</option><option>Casada(o)</option><option>Divorciada(o)</option><option>Viúva(o)</option><option>União estável</option></select></Campo>
            {inp('profissao', 'Profissão')}
            <div className="secao">Contato</div>
            {inp('telefone1', 'Telefone / WhatsApp', { inputMode: 'tel' })}
            {inp('telefone2', 'Telefone 2', { inputMode: 'tel' })}
            {inp('telefone3', 'Telefone 3', { inputMode: 'tel' })}
            {inp('email', 'E-mail', { type: 'email' })}
            {inp('instagram', 'Instagram')}
            {inp('redesSociais', 'Outras redes sociais', { placeholder: 'Facebook, TikTok…' })}
            {inp('localTrabalho', 'Onde trabalha')}
            <div className="secao">Endereço</div>
            {inp('cep', 'CEP', { inputMode: 'numeric' })}
            {inp('logradouro', 'Logradouro', {}, 'l2')}
            {inp('numero', 'Número')}
            {inp('complemento', 'Complemento')}
            {inp('bairro', 'Bairro')}
            {inp('cidade', 'Cidade')}
            {inp('uf', 'UF', { maxLength: 2 })}
            <div className="secao">Referências</div>
            {(f.referencias ?? []).map((r: any, i: number) => (
              <div key={i} className="l4 flex">
                <input placeholder="Nome" value={r.nome ?? ''} disabled={!editavel} onChange={(e) => { const refs = [...f.referencias]; refs[i] = { ...r, nome: e.target.value }; setF({ ...f, referencias: refs }); }} />
                <input placeholder="Telefone" value={r.telefone ?? ''} disabled={!editavel} onChange={(e) => { const refs = [...f.referencias]; refs[i] = { ...r, telefone: e.target.value }; setF({ ...f, referencias: refs }); }} />
                <input placeholder="Relação (vizinha, amiga…)" value={r.relacao ?? ''} disabled={!editavel} onChange={(e) => { const refs = [...f.referencias]; refs[i] = { ...r, relacao: e.target.value }; setF({ ...f, referencias: refs }); }} />
                {editavel && <button type="button" className="botao perigo pequeno" onClick={() => setF({ ...f, referencias: f.referencias.filter((_: unknown, j: number) => j !== i) })}>Remover</button>}
              </div>
            ))}
            {editavel && <div className="l4"><button type="button" className="botao claro pequeno" onClick={() => setF({ ...f, referencias: [...(f.referencias ?? []), { nome: '', telefone: '', relacao: '' }] })}>Adicionar referência</button></div>}
            <div className="secao">Observações</div>
            <Campo rotulo="Observação" className="l2"><textarea rows={3} value={f.observacao ?? ''} onChange={set('observacao')} disabled={!editavel} /></Campo>
            <Campo rotulo="Observação interna (só a equipe vê)" className="l2"><textarea rows={3} value={f.observacaoInterna ?? ''} onChange={set('observacaoInterna')} disabled={!editavel} /></Campo>
            {f.camposExtras && Object.keys(f.camposExtras).length > 0 && (
              <div className="l4">
                <div className="secao" style={{ marginBottom: 8 }}>Outros dados (vindos do Jueri)</div>
                <table className="tabela"><tbody>{Object.entries(f.camposExtras as Record<string, string>).map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>)}</tbody></table>
              </div>
            )}
          </div>
        )}
        {aba === 'rede' && (
          <div className="form">
            <Campo rotulo="Situação"><select value={f.status} onChange={set('status')} disabled={!editavel}><option value="triagem">Em triagem</option><option value="ativo">Ativa (aprovada)</option><option value="inativo">Inativa</option><option value="recusado">Recusada</option></select></Campo>
            <Campo rotulo="Modelo de trabalho"><select value={f.modeloTrabalho ?? ''} onChange={set('modeloTrabalho')} disabled={!editavel}><option value="consignado">Consignado (maleta)</option><option value="revenda">Revenda</option><option value="afiliado">Afiliada</option></select></Campo>
            <Campo rotulo="Nível"><select value={f.nivelId ?? ''} onChange={(e) => setF({ ...f, nivelId: e.target.value || null })} disabled={!editavel}><option value="">Sem nível</option>{niveis.data?.map((n) => <option key={n.id} value={n.id}>{n.nome}</option>)}</select></Campo>
            <Campo rotulo="Revendedora líder"><select value={f.liderId ?? ''} onChange={(e) => setF({ ...f, liderId: e.target.value || null })} disabled={!editavel}><option value="">Nenhuma</option>{lideres.data?.itens.filter((l) => l.id !== id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
            <Campo rotulo="Indicada por"><select value={f.indicadoPorId ?? ''} onChange={(e) => setF({ ...f, indicadoPorId: e.target.value || null })} disabled={!editavel}><option value="">—</option>{lideres.data?.itens.filter((l) => l.id !== id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Campo>
            {inp('praca', 'Praça / região')}
            {inp('tipoRevendedor', 'Tipo', { placeholder: 'Revendedora, líder, representante…' })}
            {inp('segmento', 'Segmento')}
            <Campo rotulo="Meta mensal própria (R$)" ajuda="Vazio = usa a meta do nível"><input value={metaTexto} onChange={(e) => setMetaTexto(e.target.value)} inputMode="decimal" disabled={!editavel} /></Campo>
            <Campo rotulo="Comissão própria (%)" ajuda="Vazio = usa a do nível ou a padrão" erro={campos.comissaoPb}><input value={comissaoTexto} onChange={(e) => setComissaoTexto(e.target.value)} inputMode="decimal" disabled={!editavel} /></Campo>
            <Campo rotulo="Limite de crédito (R$)" ajuda="Valor máximo em peças na maleta" erro={campos.limiteCredito}><input value={limiteTexto} onChange={(e) => setLimiteTexto(e.target.value)} inputMode="decimal" disabled={!editavel} /></Campo>
            <div className="campo"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={!!f.bloqueado} onChange={(e) => setF({ ...f, bloqueado: e.target.checked })} disabled={!editavel} /> Bloquear novas maletas</label></div>
            {f.bloqueado && inp('motivoBloqueio', 'Motivo do bloqueio', {}, 'l4')}
            {!nova && f.rede?.length > 0 && (
              <div className="l4">
                <div className="secao" style={{ marginBottom: 8 }}>Rede formada por ela ({f.rede.length})</div>
                {f.rede.map((r: any) => <div key={r.id} className="resumo-linha"><Link to={`/rede/${r.id}`}>{r.nome}</Link><StatusPessoa status={r.status} /></div>)}
              </div>
            )}
          </div>
        )}
        {aba === 'credito' && (
          <div className="grade g3">
            <div><div className="muted">Limite atual</div><div style={{ fontSize: 24, fontWeight: 700 }}>{reais(f.limiteCredito)}</div></div>
            <div><div className="muted">Crédito disponível (devoluções)</div><div style={{ fontSize: 24, fontWeight: 700 }}>{reais(f.saldoCredito ?? 0)}</div></div>
            <ScoreRepresentante id={id!} />
            <p className="muted" style={{ gridColumn: 'span 3' }}>O limite sobe sozinho depois de cada acerto em dia que bate a meta mínima, até o máximo definido nas Configurações. Atraso acima do prazo de bloqueio faz o limite voltar ao inicial.</p>
          </div>
        )}
        {aba === 'maletas' && (
          f.maletas?.length ? (
            <table className="tabela">
              <thead><tr><th>Nº</th><th>Retirada</th><th>Acerto até</th><th>Situação</th></tr></thead>
              <tbody>{f.maletas.map((m: any) => <tr key={m.id} className="clicavel" onClick={() => navegar(`/maletas/${m.id}`)}><td><b>{m.numero}</b></td><td>{data(m.dataRetirada)}</td><td>{data(m.dataLimite)}</td><td><StatusMaleta status={m.status} /></td></tr>)}</tbody>
            </table>
          ) : <p className="muted">Nenhuma maleta ainda.</p>
        )}
        {aba === 'documentos' && !nova && <DocumentosPessoa pessoa={f} />}
        {aba === 'financeiro' && (
          f.titulos?.length ? (
            <table className="tabela">
              <thead><tr><th>Descrição</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th></tr></thead>
              <tbody>{f.titulos.map((t: any) => <tr key={t.id}><td>{t.descricao}</td><td>{data(t.vencimento)}</td><td className="num">{reais(t.valor)}</td><td><span className={`etiqueta ${t.status === 'pago' ? 'ok' : 'alerta'}`}>{t.status}</span></td></tr>)}</tbody>
            </table>
          ) : <p className="muted">Nenhum título.</p>
        )}
      </div>
    </>
  );
}

/** Link de acesso ao portal (vale 7 dias, uso único), para mandar à representante pelo WhatsApp. */
function AcessoPortal({ id }: { id: string }) {
  const [link, setLink] = useState<{ url: string; telefone: string | null; nome: string } | null>(null);
  const gerar = useMutation({
    mutationFn: () => api<{ caminho: string; telefone: string | null; nome: string }>(`/portal/gerar-link/${id}`, { corpo: {} }),
    onSuccess: (r) => setLink({ url: `${window.location.origin}${r.caminho}`, telefone: r.telefone, nome: r.nome }),
  });
  if (!link) return <button className="botao claro" disabled={gerar.isPending} title={gerar.error ? String((gerar.error as Error).message) : 'Gera um link de acesso ao portal da representante'} onClick={() => gerar.mutate()}>Acesso ao portal</button>;
  const texto = `Olá, ${link.nome.split(' ')[0]}! Este é o seu acesso ao portal da Aritana, onde você acompanha a maleta, marca as vendas, paga as parcelas e pede peças: ${link.url}\nO link vale por 7 dias e funciona uma vez; depois, entre com o seu CPF.`;
  const fone = (link.telefone ?? '').replace(/\D/g, '');
  return (
    <>
      {fone && <a className="botao" href={`https://wa.me/55${fone}?text=${encodeURIComponent(texto)}`} target="_blank" rel="noreferrer">Enviar pelo WhatsApp</a>}
      <button className="botao claro" onClick={async () => { try { await navigator.clipboard.writeText(texto); } catch { window.prompt('Copie a mensagem:', texto); } }}>Copiar link</button>
    </>
  );
}

const FAIXA: Record<string, [string, string]> = { A: ['ok', 'Faixa A · excelente'], B: ['ok', 'Faixa B · boa'], C: ['alerta', 'Faixa C · atenção'], D: ['erro', 'Faixa D · risco'], nova: ['neutra', 'Sem histórico'] };

/** Score interno (só a matriz vê): 0 a 1000 pelos últimos 12 meses. */
function ScoreRepresentante({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['score', id], queryFn: () => api<any>(`/rede/${id}/score`) });
  if (!q.data) return <div><div className="muted">Score interno</div><div className="muted">{q.error ? 'Indisponível' : '…'}</div></div>;
  const s = q.data;
  const nomes: Record<string, string> = { pontualidade: 'Pontualidade', pagamento: 'Pagamento', giro: 'Giro da maleta', perdas: 'Cuidado com as peças', casa: 'Tempo de casa' };
  return (
    <div>
      <div className="muted">Score interno</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{s.score ?? '—'} <span className={`etiqueta ${FAIXA[s.faixa][0]}`} style={{ fontSize: 12, verticalAlign: 'middle' }}>{FAIXA[s.faixa][1]}</span></div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
        {s.score === null ? 'Aparece depois do primeiro acerto completo.' : Object.entries(s.componentes).map(([k, v]) => `${nomes[k]} ${Math.round((v as number) * 100)}%`).join(' · ')}
      </div>
      {s.pontosDeAtencao.length > 0 && <div style={{ fontSize: 13, color: 'var(--erro)', marginTop: 4 }}>Atenção: {s.pontosDeAtencao.join(', ')}</div>}
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{s.saldoPontos} ponto(s) no programa de prêmios</div>
    </div>
  );
}
