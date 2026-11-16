import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, pode } from '../../api';
import { centavosParaTexto, paraCentavos } from '../../formato';
import { useConsulta } from '../../componentes/consultas';
import { Abas, Campo, Carregando, Erro, Topo, camposComErro } from '../../componentes/ui';
import { TabelaEspelho } from './MeuPonto';
import { abrirArquivo, competenciaAtual, hojeBR, lerArquivo, nomeMes, ultimasCompetencias } from './comum';
import './rh.css';

type Aba = 'dados' | 'documentos' | 'ponto' | 'ocorrencias' | 'acesso';
const VAZIO = { empresaId: '', nome: '', nomeSocial: '', cpf: '', pis: '', rg: '', nascimento: '', telefone: '', email: '', cep: '', endereco: '', cidade: '', uf: 'ES', cargo: '', departamento: '', tipoContrato: 'clt', salario: '', ctps: '', matriculaEsocial: '', escalaId: '', dataAdmissao: hojeBR(), batePonto: true, observacao: '', banco: '', agencia: '', conta: '', pix: '' };

export function FichaFuncionario() {
  const { id } = useParams();
  const novo = id === 'novo';
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) ?? 'dados';
  const q = useQuery({ queryKey: ['rh', 'funcionario', id], queryFn: () => api<any>(`/rh/funcionarios/${id}`), enabled: !novo });
  const resumo = useQuery({ queryKey: ['rh', 'resumo'], queryFn: () => api<any>('/rh/resumo'), staleTime: 300_000 });
  if (!novo && q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const f = q.data;
  return (
    <>
      <Topo eb={<Link to="/rh?aba=funcionarios">RH › Funcionários</Link>} titulo={novo ? 'Novo funcionário' : f.nome} sub={!novo && <>{f.cargo ?? 'Sem cargo'} · admitido em {new Date(`${f.dataAdmissao}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} {f.status !== 'ativo' && <span className={`etiqueta ${f.status === 'afastado' ? 'alerta' : 'neutra'}`}>{f.status}</span>}</>} />
      {!novo && <Abas ativa={aba} mudar={(a) => setParams({ aba: a })} abas={[['dados', 'Dados'], ['documentos', `Documentos (${f.documentos.length})`], ['ponto', 'Ponto'], ['ocorrencias', 'Faltas e afastamentos'], ['acesso', 'Acesso e desligamento']]} />}
      {(novo || aba === 'dados') && <Dados f={f} />}
      {!novo && aba === 'documentos' && <Documentos f={f} tipos={resumo.data?.tiposDocumento ?? {}} />}
      {!novo && aba === 'ponto' && <Ponto f={f} />}
      {!novo && aba === 'ocorrencias' && <Ocorrencias f={f} tipos={resumo.data?.tiposOcorrencia ?? {}} />}
      {!novo && aba === 'acesso' && <Acesso f={f} />}
    </>
  );
}

function Dados({ f }: { f?: any }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const empresas = useQuery({ queryKey: ['empresas'], queryFn: () => api<any[]>('/empresas') });
  const escalas = useQuery({ queryKey: ['rh', 'escalas'], queryFn: () => api<any[]>('/rh/escalas') });
  const grupos = useQuery({ queryKey: ['rh', 'grupos'], queryFn: () => api<any[]>('/rh/grupos'), enabled: !f });
  const [d, setD] = useState<Record<string, any>>(VAZIO);
  const [acessoGrupo, setAcessoGrupo] = useState('');
  const [criado, setCriado] = useState<{ id: string; login: string; senha: string } | null>(null);
  useEffect(() => {
    if (f) setD({ ...VAZIO, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ?? ''])), salario: f.salario ? centavosParaTexto(f.salario) : '', banco: f.dadosBancarios?.banco ?? '', agencia: f.dadosBancarios?.agencia ?? '', conta: f.dadosBancarios?.conta ?? '', pix: f.dadosBancarios?.pix ?? '' });
    else if (empresas.data?.length && !d.empresaId) setD((x) => ({ ...x, empresaId: empresas.data!.find((e) => e.tipo === 'matriz')?.id ?? empresas.data![0].id }));
  }, [f, empresas.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f && escalas.data?.length && !d.escalaId) setD((x) => ({ ...x, escalaId: escalas.data![0].id }));
    if (!f && grupos.data && !acessoGrupo) setAcessoGrupo(grupos.data.find((g) => g.nome === 'Somente ponto')?.id ?? '');
  }, [escalas.data, grupos.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const salvar = useMutation({
    mutationFn: () => {
      const corpo = {
        empresaId: d.empresaId, nome: d.nome, nomeSocial: d.nomeSocial || null, cpf: d.cpf, pis: d.pis || null, rg: d.rg || null, nascimento: d.nascimento || null, telefone: d.telefone || null, email: d.email || null,
        cep: d.cep || null, endereco: d.endereco || null, cidade: d.cidade || null, uf: d.uf || null, cargo: d.cargo || null, departamento: d.departamento || null, tipoContrato: d.tipoContrato,
        salario: d.salario ? paraCentavos(String(d.salario)) : null, ctps: d.ctps || null, matriculaEsocial: d.matriculaEsocial || null, escalaId: d.escalaId || null, dataAdmissao: d.dataAdmissao, batePonto: !!d.batePonto, observacao: d.observacao || null,
        dadosBancarios: Object.fromEntries((['banco', 'agencia', 'conta', 'pix'] as const).map((k) => [k, d[k] ?? '']).filter(([, v]) => v)),
        ...(f ? {} : { acesso: acessoGrupo ? { grupoId: acessoGrupo, email: d.email || null } : null }),
      };
      return f ? api<any>(`/rh/funcionarios/${f.id}`, { metodo: 'PATCH', corpo }) : api<any>('/rh/funcionarios', { corpo });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['rh'] });
      if (!f && r.acessoCriado) setCriado({ id: r.id, ...r.acessoCriado });
      else if (!f) navegar(`/rh/funcionario/${r.id}?aba=documentos`, { replace: true });
    },
  });
  const editar = f ? pode('rh', 'editar') : pode('rh', 'criar');
  // Campos que o servidor recusou: cada um fica destacado com o motivo embaixo.
  const erros = camposComErro(salvar.error);
  const cep = useConsulta('cep');
  const campo = (k: string, rotulo: string, props: Record<string, unknown> = {}, cls = '') => (
    <Campo rotulo={rotulo} className={cls} erro={erros[k] ?? erros[`dadosBancarios.${k}`] ?? (k === 'cep' && cep.aviso?.erro ? cep.aviso.texto : undefined)} ajuda={k === 'cep' ? cep.aviso?.texto : undefined}>
      <input
        disabled={!editar}
        value={d[k] ?? ''}
        onChange={(e) => {
          setD({ ...d, [k]: e.target.value });
          // CEP completo traz o endereço (o número a pessoa completa).
          if (k === 'cep') cep.buscar(e.target.value, (c) => setD((x) => ({ ...x, endereco: [c.logradouro, c.bairro].filter(Boolean).join(', ') || x.endereco, cidade: c.cidade ?? x.cidade, uf: c.uf ?? x.uf })));
        }}
        {...props}
      />
    </Campo>
  );
  if (criado) {
    return (
      <div className="cartao" style={{ maxWidth: 560 }}>
        <h2>Funcionário cadastrado ✓</h2>
        <p style={{ margin: '10px 0' }}>Passe o acesso para {d.nome.split(' ')[0]}. A senha só aparece agora; no primeiro acesso o sistema pede para trocar.</p>
        <div className="resumo-linha"><span>Endereço</span><b>{window.location.origin}</b></div>
        <div className="resumo-linha"><span>Login</span><b>{criado.login}</b></div>
        <div className="resumo-linha"><span>Senha provisória</span><b style={{ fontFamily: 'monospace', fontSize: 18 }}>{criado.senha}</b></div>
        <div className="flex" style={{ gap: 8, marginTop: 12 }}>
          <button className="botao claro" onClick={() => navigator.clipboard?.writeText(`Seu acesso à Aritana: ${window.location.origin}\nLogin: ${criado.login}\nSenha provisória: ${criado.senha}`)}>Copiar mensagem</button>
          <button className="botao" onClick={() => navegar(`/rh/funcionario/${criado.id}?aba=documentos`, { replace: true })}>Continuar para os documentos</button>
        </div>
      </div>
    );
  }
  return (
    <div className="cartao form">
      <div className="secao" style={{ marginTop: 0 }}>Pessoais</div>
      {campo('nome', 'Nome completo', {}, 'l2')}
      {campo('cpf', 'CPF', { inputMode: 'numeric' })}
      {campo('nascimento', 'Nascimento', { type: 'date' })}
      {campo('rg', 'RG')}
      {campo('pis', 'PIS / NIS')}
      {campo('telefone', 'Celular / WhatsApp', { inputMode: 'tel' })}
      {campo('email', 'E-mail', { type: 'email' })}
      {campo('endereco', 'Endereço', {}, 'l2')}
      {campo('cidade', 'Cidade')}
      {campo('uf', 'UF', { maxLength: 2 })}
      {campo('cep', 'CEP', { inputMode: 'numeric' })}
      {campo('nomeSocial', 'Nome social (se houver)')}
      <div className="secao l4">Contrato</div>
      <Campo rotulo="Empresa (empregador)" className="l2" erro={erros.empresaId}><select disabled={!editar} value={d.empresaId} onChange={(e) => setD({ ...d, empresaId: e.target.value })}>{empresas.data?.map((e) => <option key={e.id} value={e.id}>{e.razaoSocial || e.nome}{e.cnpj ? '' : ' (sem CNPJ)'}</option>)}</select></Campo>
      <Campo rotulo="Tipo de contrato" erro={erros.tipoContrato}><select disabled={!editar} value={d.tipoContrato} onChange={(e) => setD({ ...d, tipoContrato: e.target.value })}>{[['clt', 'CLT'], ['experiencia', 'Experiência'], ['estagio', 'Estágio'], ['temporario', 'Temporário'], ['aprendiz', 'Aprendiz'], ['pj', 'PJ'], ['autonomo', 'Autônomo']].map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Campo>
      {campo('dataAdmissao', 'Admissão', { type: 'date' })}
      {campo('cargo', 'Cargo')}
      {campo('departamento', 'Setor')}
      {campo('salario', 'Salário (R$)', { inputMode: 'decimal' })}
      {campo('ctps', 'CTPS (número e série)')}
      {campo('matriculaEsocial', 'Matrícula no eSocial')}
      <Campo rotulo="Escala de horário" className="l2" erro={erros.escalaId}><select disabled={!editar} value={d.escalaId} onChange={(e) => setD({ ...d, escalaId: e.target.value })}><option value="">Sem escala</option>{escalas.data?.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select></Campo>
      <Campo rotulo="Controle de ponto"><select disabled={!editar} value={d.batePonto ? '1' : '0'} onChange={(e) => setD({ ...d, batePonto: e.target.value === '1' })}><option value="1">Bate ponto</option><option value="0">Não bate (sócio, cargo de confiança, PJ)</option></select></Campo>
      <div className="secao l4">Dados bancários (para a folha)</div>
      {campo('banco', 'Banco')}
      {campo('agencia', 'Agência')}
      {campo('conta', 'Conta')}
      {campo('pix', 'Chave Pix')}
      <Campo rotulo="Observações" className="l4" erro={erros.observacao}><textarea rows={2} disabled={!editar} value={d.observacao} onChange={(e) => setD({ ...d, observacao: e.target.value })} /></Campo>
      {!f && (
        <>
          <div className="secao l4">Acesso ao sistema</div>
          <Campo rotulo="Nível de acesso" className="l2" erro={erros['acesso.grupoId']} ajuda="&quot;Somente ponto&quot; só bate ponto e vê os próprios documentos. Sem e-mail, o login é o CPF.">
            <select value={acessoGrupo} onChange={(e) => setAcessoGrupo(e.target.value)}><option value="">Criar acesso depois</option>{grupos.data?.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}</select>
          </Campo>
        </>
      )}
      {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
      {salvar.isSuccess && f && <div className="aviso ok l4">Salvo.</div>}
      {editar && <div className="l4"><button className="botao" disabled={salvar.isPending || !d.nome || !d.cpf} onClick={() => salvar.mutate()}>{f ? 'Salvar' : 'Cadastrar funcionário'}</button></div>}
    </div>
  );
}

function Documentos({ f, tipos }: { f: any; tipos: Record<string, string> }) {
  const qc = useQueryClient();
  const [n, setN] = useState({ tipo: 'contrato', titulo: '', competencia: '', validade: '', visivel: true });
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [erro, setErro] = useState('');
  const enviar = useMutation({
    mutationFn: async () => api(`/rh/funcionarios/${f.id}/documentos`, { corpo: { tipo: n.tipo, titulo: n.titulo || null, competencia: n.competencia || (['contracheque', 'ferias', 'decimo_terceiro'].includes(n.tipo) ? competenciaAtual() : null), validade: n.validade || null, visivelFuncionario: n.visivel, nomeArquivo: arquivo!.name, mime: arquivo!.type || 'application/octet-stream', base64: await lerArquivo(arquivo!) } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rh'] });
      setArquivo(null);
      setN({ ...n, titulo: '', validade: '' });
      (document.getElementById('rh-arquivo') as HTMLInputElement | null)?.value && ((document.getElementById('rh-arquivo') as HTMLInputElement).value = '');
    },
  });
  const apagar = useMutation({ mutationFn: (id: string) => api(`/rh/documentos/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh'] }) });
  const grupos = new Map<string, any[]>();
  for (const d of f.documentos) grupos.set(d.tipo, [...(grupos.get(d.tipo) ?? []), d]);
  const hoje = hojeBR();
  return (
    <div className="grade g2" style={{ alignItems: 'start' }}>
      <div className="coluna" style={{ gap: 12 }}>
        {!f.documentos.length && <div className="cartao vazio">Pasta vazia. Comece pelo contrato, a carta de admissão e o exame admissional.</div>}
        {[...grupos.entries()].map(([tipo, docs]) => (
          <div key={tipo} className="cartao">
            <h3 style={{ marginBottom: 8 }}>{tipos[tipo] ?? tipo}</h3>
            {docs.map((d) => (
              <div key={d.id} className="rh-doc" style={{ marginBottom: 6 }}>
                <div>
                  <b>{d.titulo}</b>
                  <div><small>{d.nomeArquivo} · {Math.ceil(d.tamanho / 1000)} KB{d.validade ? ` · vence ${new Date(`${d.validade}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}` : ''}{d.visivelFuncionario ? (d.cienteEm ? ' · funcionário recebeu' : ' · liberado ao funcionário') : ' · só RH'}</small></div>
                  {d.validade && d.validade < hoje && <span className="etiqueta erro">vencido</span>}
                </div>
                <div className="flex" style={{ gap: 6 }}>
                  <button className="botao claro pequeno" onClick={() => abrirArquivo(`/rh/documentos/${d.id}/arquivo`).catch((e) => setErro(e.message))}>Abrir</button>
                  {pode('rh', 'excluir') && <button className="botao perigo pequeno" onClick={() => window.confirm(`Apagar "${d.titulo}"?`) && apagar.mutate(d.id)}>Apagar</button>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {erro && <div className="aviso erro">{erro}</div>}
      </div>
      {pode('rh', 'criar') && (
        <div className="cartao form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="secao" style={{ marginTop: 0, gridColumn: 'span 2' }}>Guardar documento</div>
          <Campo rotulo="Tipo" className="l2"><select value={n.tipo} onChange={(e) => setN({ ...n, tipo: e.target.value })}>{Object.entries(tipos).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Campo>
          {n.tipo === 'contracheque' || n.tipo === 'ferias' || n.tipo === 'decimo_terceiro' ? (
            <Campo rotulo="Mês de referência" className="l2"><select value={n.competencia || competenciaAtual()} onChange={(e) => setN({ ...n, competencia: e.target.value })}>{ultimasCompetencias(18).map((c) => <option key={c} value={c}>{nomeMes(c)}</option>)}</select></Campo>
          ) : (
            <Campo rotulo="Título (opcional)" className="l2"><input value={n.titulo} onChange={(e) => setN({ ...n, titulo: e.target.value })} placeholder={tipos[n.tipo]} /></Campo>
          )}
          <Campo rotulo="Vence em (opcional)" ajuda="Exame periódico, experiência, CNH"><input type="date" value={n.validade} onChange={(e) => setN({ ...n, validade: e.target.value })} /></Campo>
          <Campo rotulo="Funcionário vê?"><select value={n.visivel ? '1' : '0'} onChange={(e) => setN({ ...n, visivel: e.target.value === '1' })}><option value="1">Sim, no Meu ponto</option><option value="0">Não, só o RH</option></select></Campo>
          <Campo rotulo="Arquivo (PDF ou foto)" className="l2"><input id="rh-arquivo" type="file" accept="application/pdf,image/*,.doc,.docx" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} /></Campo>
          {enviar.error && <div style={{ gridColumn: 'span 2' }}><Erro erro={enviar.error} /></div>}
          <div style={{ gridColumn: 'span 2' }}><button className="botao" disabled={!arquivo || enviar.isPending} onClick={() => enviar.mutate()}>{enviar.isPending ? 'Enviando…' : 'Guardar na pasta'}</button></div>
        </div>
      )}
    </div>
  );
}

function Ponto({ f }: { f: any }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [comp, setComp] = useState(params.get('competencia') ?? competenciaAtual());
  const q = useQuery({ queryKey: ['rh', 'espelho', f.id, comp], queryFn: () => api<any>(`/rh/espelho/${f.id}?competencia=${comp}`) });
  const trat = useMutation({ mutationFn: (corpo: unknown) => api('/rh/tratamentos', { corpo }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh', 'espelho', f.id] }) });
  const [erro, setErro] = useState('');
  const ajustar = pode('rh', 'editar')
    ? {
        incluir: (data: string) => {
          const hora = window.prompt(`Incluir batida em ${data.slice(8, 10)}/${data.slice(5, 7)}. Hora (HH:MM):`);
          if (!hora) return;
          const motivo = window.prompt('Motivo do ajuste (fica registrado e vai para o AEJ):');
          if (motivo) trat.mutate({ tipo: 'inclusao', funcionarioId: f.id, data, hora: hora.padStart(5, '0'), motivo });
        },
        desconsiderar: (registroId: string, hora: string) => {
          const motivo = window.prompt(`Desconsiderar a batida das ${hora}? A marcação original continua guardada. Motivo:`);
          if (motivo) trat.mutate({ tipo: 'desconsiderar', funcionarioId: f.id, registroId, motivo });
        },
        foto: (id: string) => abrirArquivo(`/rh/registros/${id}/foto`).catch((e) => setErro(e.message)),
      }
    : undefined;
  return (
    <div className="coluna" style={{ gap: 10 }}>
      <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={comp} onChange={(e) => setComp(e.target.value)} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }}>{ultimasCompetencias(13).map((c) => <option key={c} value={c}>{nomeMes(c)}</option>)}</select>
        {q.data?.escala ? <span className="muted">Escala: {q.data.escala.nome}</span> : <span className="etiqueta alerta">sem escala: o espelho não calcula faltas nem extras</span>}
        {q.data?.fechamento && <span className={`etiqueta ${q.data.fechamento.cienteEm ? 'ok' : 'alerta'}`}>{q.data.fechamento.cienteEm ? 'funcionário confirmou' : 'fechado, aguardando confirmação'}</span>}
      </div>
      {(trat.error || erro) && <div className="aviso erro">{(trat.error as Error)?.message ?? erro}</div>}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : <TabelaEspelho e={q.data} ajustar={ajustar} />}
      <p className="muted" style={{ fontSize: 12.5 }}>Azul = batida incluída pela empresa · riscada = desconsiderada · contorno vermelho = fora do local · ² = extra a 100%. Ajustes nunca apagam a marcação original (Portaria 671) e aparecem no AEJ com o motivo.</p>
    </div>
  );
}

function Ocorrencias({ f, tipos }: { f: any; tipos: Record<string, { nome: string; abona: boolean }> }) {
  const qc = useQueryClient();
  const [n, setN] = useState({ tipo: 'atestado', de: hojeBR(), ate: hojeBR(), observacao: '' });
  const criar = useMutation({ mutationFn: () => api(`/rh/funcionarios/${f.id}/ocorrencias`, { corpo: { ...n, observacao: n.observacao || null } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['rh'] }); setN({ ...n, observacao: '' }); } });
  const apagar = useMutation({ mutationFn: (id: string) => api(`/rh/ocorrencias/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh'] }) });
  const br = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  return (
    <div className="grade g2" style={{ alignItems: 'start' }}>
      <div className="cartao">
        {!f.ocorrencias.length ? <p className="muted">Nenhuma ocorrência.</p> : f.ocorrencias.map((o: any) => (
          <div key={o.id} className="resumo-linha">
            <span><b>{tipos[o.tipo]?.nome ?? o.tipo}</b> · {br(o.de)}{o.ate !== o.de ? ` a ${br(o.ate)}` : ''}{o.observacao ? <div className="muted" style={{ fontSize: 12 }}>{o.observacao}</div> : null}</span>
            <span className="flex" style={{ gap: 6 }}><span className={`etiqueta ${o.abona ? 'ok' : 'erro'}`}>{o.abona ? 'abonado' : 'desconta'}</span>{pode('rh', 'excluir') && <button className="botao claro pequeno" onClick={() => window.confirm('Apagar esta ocorrência?') && apagar.mutate(o.id)}>×</button>}</span>
          </div>
        ))}
      </div>
      {pode('rh', 'criar') && (
        <div className="cartao form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="secao" style={{ marginTop: 0, gridColumn: 'span 2' }}>Lançar</div>
          <Campo rotulo="Tipo" className="l2"><select value={n.tipo} onChange={(e) => setN({ ...n, tipo: e.target.value })}>{Object.entries(tipos).map(([k, t]) => <option key={k} value={k}>{t.nome}</option>)}</select></Campo>
          <Campo rotulo="De"><input type="date" value={n.de} onChange={(e) => setN({ ...n, de: e.target.value, ate: e.target.value > n.ate ? e.target.value : n.ate })} /></Campo>
          <Campo rotulo="Até"><input type="date" value={n.ate} onChange={(e) => setN({ ...n, ate: e.target.value })} /></Campo>
          <Campo rotulo="Observação" className="l2" ajuda="Atestado: guarde o arquivo na aba Documentos."><input value={n.observacao} onChange={(e) => setN({ ...n, observacao: e.target.value })} /></Campo>
          {criar.error && <div style={{ gridColumn: 'span 2' }}><Erro erro={criar.error} /></div>}
          <div style={{ gridColumn: 'span 2' }}><button className="botao" disabled={criar.isPending} onClick={() => criar.mutate()}>Lançar</button></div>
        </div>
      )}
    </div>
  );
}

function Acesso({ f }: { f: any }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const grupos = useQuery({ queryKey: ['rh', 'grupos'], queryFn: () => api<any[]>('/rh/grupos') });
  const [grupoId, setGrupoId] = useState(f.acesso?.grupoId ?? '');
  const [email, setEmail] = useState(f.acesso && !f.acesso.loginPorCpf ? f.acesso.email : f.email ?? '');
  useEffect(() => { if (!grupoId && grupos.data) setGrupoId(grupos.data.find((g) => g.nome === 'Somente ponto')?.id ?? ''); }, [grupos.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const acesso = useMutation({ mutationFn: () => api<{ senhaProvisoria: { login: string; senha: string } }>(`/rh/funcionarios/${f.id}/acesso`, { corpo: { grupoId, email: email || null } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh'] }) });
  const [desl, setDesl] = useState({ data: hojeBR(), motivo: '', manterAcesso: false });
  const desligar = useMutation({ mutationFn: () => api(`/rh/funcionarios/${f.id}/desligar`, { corpo: desl }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['rh'] }); navegar('/rh?aba=funcionarios'); } });
  return (
    <div className="grade g2" style={{ alignItems: 'start' }}>
      <div className="cartao form" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="secao" style={{ marginTop: 0, gridColumn: 'span 2' }}>Acesso ao sistema</div>
        {f.acesso ? (
          <div style={{ gridColumn: 'span 2' }}>
            <div className="resumo-linha"><span>Login</span><b>{f.acesso.loginPorCpf ? `CPF ${f.cpf}` : f.acesso.email}</b></div>
            <div className="resumo-linha"><span>Nível</span><b>{f.acesso.grupo}</b></div>
            <div className="resumo-linha"><span>Último acesso</span><b>{f.acesso.ultimoAcesso ? new Date(f.acesso.ultimoAcesso).toLocaleString('pt-BR') : 'nunca entrou'}</b></div>
            {!f.acesso.ativo && <span className="etiqueta erro">acesso desativado</span>}
          </div>
        ) : <p className="muted" style={{ gridColumn: 'span 2' }}>Ainda sem acesso. Crie para a pessoa bater o ponto pelo celular.</p>}
        <Campo rotulo="Nível de acesso" className="l2" ajuda="Somente ponto: bate ponto e vê os próprios documentos. Os outros grupos dão acesso aos módulos do sistema."><select value={grupoId} onChange={(e) => setGrupoId(e.target.value)}>{grupos.data?.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}</select></Campo>
        <Campo rotulo="E-mail de login (opcional)" className="l2" ajuda="Sem e-mail, a pessoa entra com o CPF."><input value={email} onChange={(e) => setEmail(e.target.value)} /></Campo>
        {acesso.data && (
          <div className="aviso ok" style={{ gridColumn: 'span 2' }}>
            Login: <b>{acesso.data.senhaProvisoria.login}</b> · Senha provisória: <b style={{ fontFamily: 'monospace' }}>{acesso.data.senhaProvisoria.senha}</b>
            <div style={{ fontSize: 12 }}>A senha só aparece agora. No primeiro acesso, o sistema pede para trocar.</div>
          </div>
        )}
        {acesso.error && <div style={{ gridColumn: 'span 2' }}><Erro erro={acesso.error} /></div>}
        {pode('rh', 'criar') && <div style={{ gridColumn: 'span 2' }}><button className="botao" disabled={!grupoId || acesso.isPending} onClick={() => (!f.acesso || window.confirm('Gerar uma senha nova? A atual deixa de funcionar.')) && acesso.mutate()}>{f.acesso ? 'Salvar nível e gerar senha nova' : 'Criar acesso'}</button></div>}
      </div>
      {f.status !== 'desligado' && pode('rh', 'editar') && (
        <div className="cartao form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="secao" style={{ marginTop: 0, gridColumn: 'span 2' }}>Desligamento</div>
          <Campo rotulo="Último dia"><input type="date" value={desl.data} onChange={(e) => setDesl({ ...desl, data: e.target.value })} /></Campo>
          <Campo rotulo="Motivo"><select value={desl.motivo} onChange={(e) => setDesl({ ...desl, motivo: e.target.value })}><option value="">Escolha</option>{['Pedido de demissão', 'Dispensa sem justa causa', 'Dispensa com justa causa', 'Término de contrato de experiência', 'Acordo (art. 484-A)', 'Término de contrato', 'Outro'].map((m) => <option key={m}>{m}</option>)}</select></Campo>
          <label className="check" style={{ gridColumn: 'span 2' }}><input type="checkbox" checked={desl.manterAcesso} onChange={(e) => setDesl({ ...desl, manterAcesso: e.target.checked })} /> Manter o acesso (para ver contracheques e a rescisão)</label>
          <p className="muted" style={{ gridColumn: 'span 2', fontSize: 13 }}>Depois de desligar, guarde a carta, o aviso prévio, o exame demissional e o TRCT na aba Documentos. Eles vão juntos no envio à contabilidade.</p>
          {desligar.error && <div style={{ gridColumn: 'span 2' }}><Erro erro={desligar.error} /></div>}
          <div style={{ gridColumn: 'span 2' }}><button className="botao perigo" disabled={!desl.motivo || desligar.isPending} onClick={() => window.confirm(`Desligar ${f.nome} em ${desl.data}?`) && desligar.mutate()}>Desligar</button></div>
        </div>
      )}
    </div>
  );
}
