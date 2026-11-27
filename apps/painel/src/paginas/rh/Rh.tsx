import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, pode } from '../../api';
import { Abas, Campo, Carregando, Erro, Topo } from '../../componentes/ui';
import { abrirArquivo, competenciaAtual, hm, nomeMes, SEMANA, ultimasCompetencias } from './comum';
import '../inicio.css';
import './rh.css';
import { ConferirRostos } from './Rosto';

type Aba = 'hoje' | 'funcionarios' | 'mes' | 'rosto' | 'contabilidade' | 'configurar';
const iniciais = (n: string) => n.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');

/** RH e ponto (visão da empresa). */
export function Rh() {
  const [params, setParams] = useSearchParams();
  const aba = (params.get('aba') as Aba) ?? 'hoje';
  return (
    <>
      <Topo eb="RH e ponto" titulo="RH e ponto eletrônico" acoes={pode('rh', 'criar') && <Link className="botao" to="/rh/funcionario/novo">Novo funcionário</Link>} />
      <Abas ativa={aba} mudar={(a) => setParams(a === 'hoje' ? {} : { aba: a })} abas={[['hoje', 'Hoje'], ['funcionarios', 'Funcionários'], ['mes', 'Ponto do mês'], ['rosto', 'Conferir rostos'], ['contabilidade', 'Enviar à contabilidade'], ['configurar', 'Configurar']]} />
      {aba === 'hoje' && <Hoje />}
      {aba === 'funcionarios' && <Funcionarios />}
      {aba === 'mes' && <PontoDoMes />}
      {aba === 'rosto' && <ConferirRostos />}
      {aba === 'contabilidade' && <Contabilidade />}
      {aba === 'configurar' && <Configurar />}
    </>
  );
}

function Hoje() {
  const q = useQuery({ queryKey: ['rh', 'resumo'], queryFn: () => api<any>('/rh/resumo'), refetchInterval: 60_000 });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const r = q.data;
  const hoje: any[] = r.hoje;
  const conta = (s: string) => hoje.filter((x) => x.situacao === s).length;
  return (
    <>
      <div className="grade g4" style={{ marginBottom: 14 }}>
        <div className="cartao ini-kpi ini-anim" style={{ ['--i' as string]: 0 }}><div className="rotulo">Trabalhando agora</div><div className="valor" style={{ color: 'var(--ok)' }}>{conta('trabalhando')}</div><div className="detalhe">de {hoje.length} que batem ponto</div></div>
        <div className="cartao ini-kpi ini-anim" style={{ ['--i' as string]: 1 }}><div className="rotulo">Atrasados</div><div className="valor" style={{ color: conta('atrasado') ? 'var(--erro)' : undefined }}>{conta('atrasado')}</div><div className="detalhe">passou do horário e não bateu</div></div>
        <div className="cartao ini-kpi ini-anim" style={{ ['--i' as string]: 2 }}><div className="rotulo">Funcionários ativos</div><div className="valor">{r.ativos}</div><div className="detalhe">{r.afastados ? `${r.afastados} afastado(s) · ` : ''}{r.admissoes} admissão(ões) no mês</div></div>
        <div className="cartao ini-kpi ini-anim" style={{ ['--i' as string]: 3 }}><div className="rotulo">Documentos vencendo</div><div className="valor" style={{ color: r.vencendo.length ? 'var(--alerta)' : undefined }}>{r.vencendo.length}</div><div className="detalhe">exames e contratos em 30 dias</div></div>
      </div>
      {r.vencendo.length > 0 && (
        <div className="aviso alerta" style={{ marginBottom: 14 }}>
          <b>Vencendo nos próximos 30 dias:</b>
          <ul>{r.vencendo.slice(0, 8).map((v: any) => <li key={v.id}><Link to={`/rh/funcionario/${v.funcionarioId}?aba=documentos`}>{v.nome}</Link>: {v.titulo} vence em {new Date(`${v.validade}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</li>)}</ul>
        </div>
      )}
      {!hoje.length ? (
        <div className="cartao vazio">Ninguém cadastrado para bater ponto ainda. Comece em "Novo funcionário".</div>
      ) : (
        <div className="rh-grade">
          {hoje.map((p) => (
            <Link key={p.id} to={`/rh/funcionario/${p.id}?aba=ponto`} className="rh-pessoa" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="av">{iniciais(p.nome)}</span>
              <div style={{ minWidth: 0 }}>
                <b>{p.nome}</b>
                <div className="muted" style={{ fontSize: 12 }}>{p.marcacoes.length ? p.marcacoes.map((m: any) => `${m.hora}${m.foraDoLocal ? '!' : ''}`).join(' · ') : p.turno ? `entra às ${p.turno.entrada}` : 'sem horário hoje'}</div>
              </div>
              <span className={`sit ${['trabalhando', 'atrasado', 'saiu', 'folga'].includes(p.situacao) ? p.situacao : 'outro'}`}>{p.situacao}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function Funcionarios() {
  const navegar = useNavigate();
  const [status, setStatus] = useState('ativo');
  const [busca, setBusca] = useState('');
  const q = useQuery({ queryKey: ['rh', 'funcionarios', status, busca], queryFn: () => api<any[]>(`/rh/funcionarios?status=${status}&busca=${encodeURIComponent(busca)}`) });
  return (
    <>
      <div className="ind-filtro flex" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {[['ativo', 'Ativos'], ['afastado', 'Afastados'], ['desligado', 'Desligados'], ['todos', 'Todos']].map(([k, n]) => <button key={k} className={`botao ${status === k ? '' : 'claro'} pequeno`} onClick={() => setStatus(k)}>{n}</button>)}
        <input placeholder="Buscar nome, CPF ou cargo" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ marginLeft: 'auto', padding: '6px 10px', border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit', minWidth: 240 }} />
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : !q.data!.length ? <div className="cartao vazio">Ninguém aqui.</div> : (
        <table className="tabela">
          <thead><tr><th>Nome</th><th>Cargo</th><th>Admissão</th><th>Escala</th><th>Acesso</th><th>Situação</th></tr></thead>
          <tbody>
            {q.data!.map((f) => (
              <tr key={f.id} className="clicavel" onClick={() => navegar(`/rh/funcionario/${f.id}`)}>
                <td><b>{f.nome}</b><div className="muted" style={{ fontSize: 12 }}>{f.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')}</div></td>
                <td>{f.cargo ?? '—'}{f.departamento ? <div className="muted" style={{ fontSize: 12 }}>{f.departamento}</div> : null}</td>
                <td>{new Date(`${f.dataAdmissao}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td>
                <td>{f.batePonto ? f.escala ?? <span className="etiqueta alerta">sem escala</span> : <span className="muted">não bate ponto</span>}</td>
                <td>{f.usuarioId ? f.grupo : <span className="etiqueta neutra">sem acesso</span>}</td>
                <td><span className={`etiqueta ${f.status === 'ativo' ? 'ok' : f.status === 'afastado' ? 'alerta' : 'neutra'}`}>{f.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function PontoDoMes() {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [comp, setComp] = useState(ultimasCompetencias(2)[1]);
  const q = useQuery({ queryKey: ['rh', 'fechamentos', comp], queryFn: () => api<any[]>(`/rh/fechamentos?competencia=${comp}`) });
  const empresas = useQuery({ queryKey: ['empresas'], queryFn: () => api<any[]>('/empresas') });
  const fechar = useMutation({ mutationFn: () => api<{ fechados: number; pendencias: { nome: string; dias: number }[] }>('/rh/fechar', { corpo: { competencia: comp } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh'] }) });
  const [erro, setErro] = useState('');
  const [de, ate] = [`${comp}-01`, new Date(Date.UTC(Number(comp.slice(0, 4)), Number(comp.slice(5)), 0)).toISOString().slice(0, 10)];
  return (
    <div className="coluna" style={{ gap: 12 }}>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={comp} onChange={(e) => setComp(e.target.value)} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }}>{ultimasCompetencias(13).map((c) => <option key={c} value={c}>{nomeMes(c)}</option>)}</select>
        {pode('rh', 'editar') && <button className="botao" disabled={fechar.isPending} onClick={() => window.confirm(`Fechar o ponto de ${nomeMes(comp)}? Cada funcionário vai poder conferir e confirmar no celular. Dá para fechar de novo depois de um ajuste.`) && fechar.mutate()}>{fechar.isPending ? 'Fechando…' : 'Fechar o mês'}</button>}
        {pode('rh', 'exportar') && empresas.data?.filter((e) => e.cnpj).map((e) => (
          <span key={e.id} className="flex" style={{ gap: 4 }}>
            <button className="botao claro pequeno" onClick={() => abrirArquivo(`/rh/afd?empresaId=${e.id}&de=${de}&ate=${ate}`, { baixarComo: `AFD-${e.nome}-${comp}.txt` }).catch((x) => setErro(x.message))}>AFD {e.nome}</button>
            <button className="botao claro pequeno" onClick={() => abrirArquivo(`/rh/aej?empresaId=${e.id}&de=${de}&ate=${ate}`, { baixarComo: `AEJ-${e.nome}-${comp}.txt` }).catch((x) => setErro(x.message))}>AEJ {e.nome}</button>
          </span>
        ))}
      </div>
      {erro && <div className="aviso erro">{erro}</div>}
      {fechar.data && <div className={`aviso ${fechar.data.pendencias.length ? 'alerta' : 'ok'}`}>{fechar.data.fechados} espelho(s) fechado(s).{fechar.data.pendencias.length ? ` Com batida faltando: ${fechar.data.pendencias.map((p) => `${p.nome} (${p.dias} dia(s))`).join(', ')}. Ajuste e feche de novo.` : ''}</div>}
      {fechar.error && <Erro erro={fechar.error} />}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : !q.data!.length ? <div className="cartao vazio">Ninguém bateu ponto neste mês.</div> : (
        <table className="tabela">
          <thead><tr><th>Funcionário</th><th className="num">Trabalhado</th><th className="num">Extras</th><th className="num">Débito</th><th className="num">Faltas</th><th>Fechado</th><th>Ciência</th></tr></thead>
          <tbody>
            {q.data!.map((f) => (
              <tr key={f.id} className="clicavel" onClick={() => navegar(`/rh/funcionario/${f.id}?aba=ponto&competencia=${comp}`)}>
                <td><b>{f.nome}</b><div className="muted" style={{ fontSize: 12 }}>{f.cargo}</div></td>
                <td className="num">{f.totais ? hm(f.totais.trabalhado) : '—'}</td>
                <td className="num">{f.totais ? hm(f.totais.extra50 + f.totais.extra100) : '—'}</td>
                <td className="num">{f.totais ? hm(f.totais.atraso + f.totais.saidaAntecipada + f.totais.falta) : '—'}</td>
                <td className="num">{f.totais?.faltasDias || (f.totais ? 0 : '—')}</td>
                <td>{f.fechadoEm ? new Date(f.fechadoEm).toLocaleDateString('pt-BR') : <span className="etiqueta neutra">aberto</span>}</td>
                <td>{f.cienteEm ? <span className="etiqueta ok">confirmou</span> : f.fechadoEm ? <span className="etiqueta alerta">aguardando</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ fontSize: 13 }}>Os totais aparecem depois de fechar o mês. Clique no nome para ver o espelho dia a dia e fazer ajustes. O AFD e o AEJ são os arquivos oficiais da Portaria 671 para a fiscalização e a contabilidade.</p>
    </div>
  );
}

function Contabilidade() {
  const qc = useQueryClient();
  const itens = useQuery({ queryKey: ['rh', 'itens'], queryFn: () => api<Record<string, string>>('/rh/contabilidade/itens') });
  const cfg = useQuery({ queryKey: ['rh', 'config'], queryFn: () => api<any>('/rh/config') });
  const canais = useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<any[]>('/crm/canais'), enabled: pode('crm', 'ver') });
  const envios = useQuery({ queryKey: ['rh', 'envios'], queryFn: () => api<any[]>('/rh/envios') });
  const [comp, setComp] = useState(ultimasCompetencias(2)[1]);
  const [sel, setSel] = useState<string[]>(['ponto_resumo', 'ponto_diario', 'ocorrencias', 'movimentacoes', 'vendas', 'comissoes', 'documentos']);
  const [canal, setCanal] = useState<'email' | 'whatsapp'>('email');
  const [destino, setDestino] = useState('');
  const [canalId, setCanalId] = useState('');
  const [mensagem, setMensagem] = useState('');
  useEffect(() => {
    if (!cfg.data) return;
    setDestino(canal === 'email' ? cfg.data.contabilidadeEmail : cfg.data.contabilidadeWhatsapp);
    if (cfg.data.contabilidadeCanalId) setCanalId(cfg.data.contabilidadeCanalId);
  }, [cfg.data, canal]);
  const previa = useMutation({ mutationFn: () => api<{ resumo: string[]; arquivos: { nome: string; tamanho: number }[] }>('/rh/contabilidade/previa', { corpo: { competencia: comp, itens: sel } }) });
  const enviar = useMutation({ mutationFn: () => api('/rh/contabilidade/enviar', { corpo: { competencia: comp, itens: sel, canal, destino, mensagem: mensagem || null, canalId: canal === 'whatsapp' ? canalId || null : null } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh', 'envios'] }) });
  const [erro, setErro] = useState('');
  useEffect(() => previa.reset(), [comp, sel.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (itens.isLoading || cfg.isLoading) return <Carregando />;
  const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.ceil(n / 1000)} KB`);
  return (
    <div className="grade g2" style={{ alignItems: 'start' }}>
      <div className="cartao form">
        <div className="secao" style={{ marginTop: 0 }}>O que mandar</div>
        <Campo rotulo="Mês" className="l4"><select value={comp} onChange={(e) => setComp(e.target.value)}>{ultimasCompetencias(13).map((c) => <option key={c} value={c}>{nomeMes(c)}</option>)}</select></Campo>
        <div className="l4 coluna" style={{ gap: 6 }}>
          {Object.entries(itens.data ?? {}).map(([k, n]) => <label key={k} className="check"><input type="checkbox" checked={sel.includes(k)} onChange={(e) => setSel(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))} /> {n}</label>)}
        </div>
        <div className="secao">Para quem</div>
        <Campo rotulo="Por onde" className="l2">
          <select value={canal} onChange={(e) => setCanal(e.target.value as 'email' | 'whatsapp')}><option value="email">E-mail (arquivos anexados)</option>{pode('crm', 'ver') && <option value="whatsapp">WhatsApp (arquivos como documento)</option>}</select>
        </Campo>
        <Campo rotulo={canal === 'email' ? 'E-mail da contabilidade' : 'WhatsApp da contabilidade'} className="l2"><input value={destino} onChange={(e) => setDestino(e.target.value)} placeholder={canal === 'email' ? 'dp@contabilidade.com.br' : '(27) 99999-9999'} /></Campo>
        {canal === 'whatsapp' && (
          <Campo rotulo="Enviar pelo número" className="l4" ajuda="No número oficial, o envio só funciona se a contabilidade escreveu nas últimas 24h; o QR code não tem essa limitação.">
            <select value={canalId} onChange={(e) => setCanalId(e.target.value)}><option value="">Escolha</option>{canais.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
          </Campo>
        )}
        <Campo rotulo="Mensagem (opcional)" className="l4"><textarea rows={3} value={mensagem} onChange={(e) => setMensagem(e.target.value)} placeholder={`Segue o material de RH de ${nomeMes(comp)}.`} /></Campo>
        <div className="l4 flex" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="botao claro" disabled={!sel.length || previa.isPending} onClick={() => previa.mutate()}>{previa.isPending ? 'Montando…' : 'Ver o que vai'}</button>
          <button className="botao" disabled={!sel.length || !destino || enviar.isPending || (canal === 'whatsapp' && !canalId)} onClick={() => window.confirm(`Enviar o material de ${nomeMes(comp)} para ${destino}?`) && enviar.mutate()}>{enviar.isPending ? 'Enviando…' : 'Enviar agora'}</button>
        </div>
        {enviar.isSuccess && <div className="aviso ok l4">Enviado para {destino}.</div>}
        {(enviar.error || previa.error) && <div className="l4"><Erro erro={enviar.error ?? previa.error} /></div>}
        {erro && <div className="aviso erro l4">{erro}</div>}
        {previa.data && (
          <div className="l4">
            <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{previa.data.resumo.join(' · ')}</div>
            {previa.data.arquivos.map((a) => (
              <div key={a.nome} className="flex entre" style={{ padding: '5px 0', borderBottom: '1px dashed var(--linha)', fontSize: 14 }}>
                <span>📄 {a.nome} <span className="muted">{kb(a.tamanho)}</span></span>
                <button className="botao claro pequeno" onClick={() => abrirArquivo('/rh/contabilidade/arquivo', { metodo: 'POST', corpo: { competencia: comp, itens: sel, nome: a.nome }, baixarComo: a.nome }).catch((e) => setErro(e.message))}>Baixar</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="cartao">
        <h3 style={{ marginBottom: 8 }}>Envios feitos</h3>
        {!envios.data?.length ? <p className="muted">Nenhum envio ainda.</p> : envios.data.map((e) => (
          <div key={e.id} className="resumo-linha" style={{ alignItems: 'flex-start' }}>
            <span>
              <b>{nomeMes(e.competencia)}</b> · {e.canal === 'email' ? 'e-mail' : 'WhatsApp'} para {e.destino}
              <div className="muted" style={{ fontSize: 12 }}>{e.arquivos.length} arquivo(s) · {e.usuario ?? ''} · {new Date(e.criadoEm).toLocaleString('pt-BR')}</div>
              {e.erro && <div style={{ color: 'var(--erro)', fontSize: 12 }}>{e.erro}</div>}
            </span>
            <span className={`etiqueta ${e.status === 'enviado' ? 'ok' : 'erro'}`}>{e.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const DIAS_PADRAO = [null, ...Array(5).fill({ entrada: '08:00', saidaIntervalo: '12:00', voltaIntervalo: '13:00', saida: '17:48' }), { entrada: '08:00', saidaIntervalo: null, voltaIntervalo: null, saida: '12:00' }];

function Configurar() {
  const qc = useQueryClient();
  const editar = pode('rh', 'editar');
  const escalas = useQuery({ queryKey: ['rh', 'escalas'], queryFn: () => api<any[]>('/rh/escalas') });
  const locais = useQuery({ queryKey: ['rh', 'locais'], queryFn: () => api<any[]>('/rh/locais') });
  const feriados = useQuery({ queryKey: ['rh', 'feriados'], queryFn: () => api<any[]>('/rh/feriados') });
  const cfg = useQuery({ queryKey: ['rh', 'config'], queryFn: () => api<any>('/rh/config') });
  const canais = useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<any[]>('/crm/canais'), enabled: pode('crm', 'ver') });
  const m = useMutation({ mutationFn: ({ rota, metodo, corpo }: { rota: string; metodo?: string; corpo?: unknown }) => api(rota, { metodo, corpo: corpo ?? {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh'] }) });
  const [r, setR] = useState<any>(null);
  useEffect(() => { if (cfg.data) setR(cfg.data); }, [cfg.data]);
  const [escala, setEscala] = useState<{ id?: string; nome: string; dias: any[] } | null>(null);
  const [novoLocal, setNovoLocal] = useState({ nome: '', latitude: '', longitude: '', raioM: '150' });
  const [novoFeriado, setNovoFeriado] = useState({ data: '', nome: '' });
  if (escalas.isLoading || cfg.isLoading || !r) return <Carregando />;
  const turno = (i: number, k: string, v: string) => setEscala((e) => e && { ...e, dias: e.dias.map((d, j) => (j === i ? { ...(d ?? { entrada: '08:00', saida: '17:00' }), [k]: v || null } : d)) });
  return (
    <div className="coluna" style={{ gap: 14 }}>
      {m.error && <Erro erro={m.error} />}
      <div className="cartao form">
        <div className="secao" style={{ marginTop: 0 }}>Regras do ponto</div>
        <Campo rotulo="Batida fora do local (GPS)" className="l2" ajuda="Sinalizar registra e marca no espelho; bloquear não deixa bater fora do raio.">
          <select disabled={!editar} value={r.cercaGps} onChange={(e) => setR({ ...r, cercaGps: e.target.value })}><option value="sinalizar">Registrar e sinalizar</option><option value="bloquear">Não deixar bater</option></select>
        </Campo>
        <Campo rotulo="Conferir o rosto da selfie" className="l2" ajuda="O Claude compara com a foto de referência; o que não confere vai para RH › Conferir rostos (não bloqueia o ponto)."><select disabled={!editar || !r.exigirFoto} value={r.conferirRosto !== false && r.exigirFoto ? '1' : '0'} onChange={(e) => setR({ ...r, conferirRosto: e.target.value === '1' })}><option value="1">Conferir</option><option value="0">Não conferir</option></select></Campo>
        <Campo rotulo="Foto na batida" className="l2"><select disabled={!editar} value={r.exigirFoto ? '1' : '0'} onChange={(e) => setR({ ...r, exigirFoto: e.target.value === '1' })}><option value="1">Exigir selfie</option><option value="0">Sem foto</option></select></Campo>
        <Campo rotulo="Registro do programa no INPI" className="l2" ajuda="Obrigatório para o REP-P valer como registro oficial. Sai no AFD, AEJ e comprovante."><input disabled={!editar} value={r.inpi} onChange={(e) => setR({ ...r, inpi: e.target.value })} placeholder="BR 51 2026 000000-0" /></Campo>
        <Campo rotulo="CNPJ do desenvolvedor do programa" className="l2" ajuda="Identificação exigida no AEJ (Wide Inteligência Comercial)."><input disabled={!editar} value={r.desenvolvedorDocumento} onChange={(e) => setR({ ...r, desenvolvedorDocumento: e.target.value })} /></Campo>
        <div className="secao l4">Contabilidade</div>
        <Campo rotulo="Nome do escritório" className="l2"><input disabled={!editar} value={r.contabilidadeNome} onChange={(e) => setR({ ...r, contabilidadeNome: e.target.value })} /></Campo>
        <Campo rotulo="E-mail do departamento pessoal" className="l2"><input disabled={!editar} value={r.contabilidadeEmail} onChange={(e) => setR({ ...r, contabilidadeEmail: e.target.value })} /></Campo>
        <Campo rotulo="WhatsApp da contabilidade" className="l2"><input disabled={!editar} value={r.contabilidadeWhatsapp} onChange={(e) => setR({ ...r, contabilidadeWhatsapp: e.target.value })} /></Campo>
        <Campo rotulo="Mandar pelo número" className="l2"><select disabled={!editar} value={r.contabilidadeCanalId} onChange={(e) => setR({ ...r, contabilidadeCanalId: e.target.value })}><option value="">Escolher na hora</option>{canais.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Campo>
        {editar && <div className="l4"><button className="botao" disabled={m.isPending} onClick={() => m.mutate({ rota: '/rh/config', metodo: 'PUT', corpo: r })}>Salvar regras</button></div>}
      </div>

      <Certificados />

      <div className="cartao">
        <div className="flex entre"><h3>Escalas (horários)</h3>{editar && !escala && <button className="botao claro pequeno" onClick={() => setEscala({ nome: '', dias: [...DIAS_PADRAO] })}>+ Nova escala</button>}</div>
        {escala ? (
          <div className="coluna" style={{ gap: 8, marginTop: 10 }}>
            <input placeholder="Nome (ex.: Loja 44h, Motoboy, 12x36)" value={escala.nome} onChange={(e) => setEscala({ ...escala, nome: e.target.value })} style={{ padding: 8, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <div className="rh-dias muted" style={{ fontSize: 12 }}><span>Dia</span><span>Entrada</span><span>Saída intervalo</span><span>Volta</span><span>Saída</span><span>Folga</span></div>
            {escala.dias.map((d, i) => (
              <div key={i} className="rh-dias">
                <b>{SEMANA[i]}</b>
                {(['entrada', 'saidaIntervalo', 'voltaIntervalo', 'saida'] as const).map((k) => <input key={k} type="time" disabled={!d} value={d?.[k] ?? ''} onChange={(e) => turno(i, k, e.target.value)} />)}
                <input type="checkbox" checked={!d} onChange={(e) => setEscala({ ...escala, dias: escala.dias.map((x, j) => (j === i ? (e.target.checked ? null : { entrada: '08:00', saidaIntervalo: '12:00', voltaIntervalo: '13:00', saida: '17:48' }) : x)) })} />
              </div>
            ))}
            <div className="flex" style={{ gap: 8 }}>
              <button className="botao" disabled={!escala.nome.trim()} onClick={() => m.mutate({ rota: escala.id ? `/rh/escalas/${escala.id}` : '/rh/escalas', metodo: escala.id ? 'PATCH' : 'POST', corpo: { nome: escala.nome, dias: escala.dias.map((d) => d && { entrada: d.entrada, saidaIntervalo: d.saidaIntervalo || null, voltaIntervalo: d.voltaIntervalo || null, saida: d.saida }) } }, { onSuccess: () => setEscala(null) })}>Salvar escala</button>
              <button className="botao claro" onClick={() => setEscala(null)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <table className="tabela" style={{ marginTop: 10 }}>
            <tbody>
              {escalas.data?.map((e) => (
                <tr key={e.id}>
                  <td><b>{e.nome}</b></td>
                  <td style={{ fontSize: 13 }}>{e.dias.map((d: any, i: number) => (d ? `${SEMANA[i]} ${d.entrada}–${d.saida}` : null)).filter(Boolean).join(' · ')}</td>
                  <td>{editar && <button className="botao claro pequeno" onClick={() => setEscala({ id: e.id, nome: e.nome, dias: e.dias })}>Editar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="cartao">
        <h3>Locais de trabalho (cerca do GPS)</h3>
        <p className="muted" style={{ fontSize: 13 }}>O ponto pelo celular confere se a pessoa está dentro do raio de um destes locais. Sem nenhum local cadastrado, não há conferência. Para o motoboy, que trabalha na rua, use a regra "Registrar e sinalizar".</p>
        <table className="tabela" style={{ margin: '8px 0' }}>
          <tbody>
            {locais.data?.map((l) => (
              <tr key={l.id}>
                <td><b>{l.nome}</b></td>
                <td style={{ fontSize: 13 }}><a href={`https://www.google.com/maps?q=${l.latitude},${l.longitude}`} target="_blank" rel="noreferrer">{l.latitude.toFixed(5)}, {l.longitude.toFixed(5)}</a></td>
                <td>raio {l.raioM} m</td>
                <td>{editar && <label className="check"><input type="checkbox" checked={l.ativo} onChange={(e) => m.mutate({ rota: `/rh/locais/${l.id}`, metodo: 'PATCH', corpo: { ativo: e.target.checked } })} /> ativo</label>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {editar && (
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input placeholder="Nome (ex.: Loja Centro)" value={novoLocal.nome} onChange={(e) => setNovoLocal({ ...novoLocal, nome: e.target.value })} style={{ padding: 7, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <input placeholder="Latitude" value={novoLocal.latitude} onChange={(e) => setNovoLocal({ ...novoLocal, latitude: e.target.value })} style={{ width: 120, padding: 7, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <input placeholder="Longitude" value={novoLocal.longitude} onChange={(e) => setNovoLocal({ ...novoLocal, longitude: e.target.value })} style={{ width: 120, padding: 7, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <input placeholder="Raio (m)" value={novoLocal.raioM} onChange={(e) => setNovoLocal({ ...novoLocal, raioM: e.target.value })} style={{ width: 90, padding: 7, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <button className="botao claro pequeno" onClick={() => navigator.geolocation?.getCurrentPosition((p) => setNovoLocal((n) => ({ ...n, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) })))}>📍 Usar onde estou</button>
            <button className="botao pequeno" disabled={!novoLocal.nome || !novoLocal.latitude || !novoLocal.longitude} onClick={() => m.mutate({ rota: '/rh/locais', corpo: { nome: novoLocal.nome, latitude: Number(novoLocal.latitude.replace(',', '.')), longitude: Number(novoLocal.longitude.replace(',', '.')), raioM: Number(novoLocal.raioM) || 150 } }, { onSuccess: () => setNovoLocal({ nome: '', latitude: '', longitude: '', raioM: '150' }) })}>Adicionar local</button>
          </div>
        )}
      </div>

      <div className="cartao">
        <h3>Feriados estaduais, municipais e da empresa</h3>
        <p className="muted" style={{ fontSize: 13 }}>Os feriados nacionais já entram sozinhos. Cadastre aqui os do Espírito Santo, da cidade e os dias que a empresa não abre.</p>
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
          {feriados.data?.map((f) => <span key={f.id} className="tag">{new Date(`${f.data}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} {f.nome} {editar && <button style={{ border: 'none', background: 'none', cursor: 'pointer' }} onClick={() => m.mutate({ rota: `/rh/feriados/${f.id}`, metodo: 'DELETE' })}>×</button>}</span>)}
        </div>
        {editar && (
          <div className="flex" style={{ gap: 6 }}>
            <input type="date" value={novoFeriado.data} onChange={(e) => setNovoFeriado({ ...novoFeriado, data: e.target.value })} style={{ padding: 7, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <input placeholder="Nome (ex.: Nossa Senhora da Penha)" value={novoFeriado.nome} onChange={(e) => setNovoFeriado({ ...novoFeriado, nome: e.target.value })} style={{ flex: 1, padding: 7, border: '1px solid var(--linha)', borderRadius: 8, font: 'inherit' }} />
            <button className="botao pequeno" disabled={!novoFeriado.data || !novoFeriado.nome} onClick={() => m.mutate({ rota: '/rh/feriados', corpo: novoFeriado }, { onSuccess: () => setNovoFeriado({ data: '', nome: '' }) })}>Adicionar</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Certificado A1 (e-CNPJ) de cada empresa: assina o AFD e o AEJ com .p7s (Portaria 671). */
function Certificados() {
  const qc = useQueryClient();
  const editar = pode('rh', 'editar');
  const q = useQuery({ queryKey: ['rh', 'certificados'], queryFn: () => api<any[]>('/rh/certificados') });
  const [enviando, setEnviando] = useState<{ empresaId: string; base64: string; arquivo: string; senha: string } | null>(null);
  const salvar = useMutation({
    mutationFn: () => api(`/rh/certificados/${enviando!.empresaId}`, { corpo: { base64: enviando!.base64, senha: enviando!.senha } }),
    onSuccess: () => { setEnviando(null); qc.invalidateQueries({ queryKey: ['rh', 'certificados'] }); },
  });
  const remover = useMutation({ mutationFn: (id: string) => api(`/rh/certificados/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rh', 'certificados'] }) });
  const ler = (empresaId: string, f?: File) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setEnviando({ empresaId, base64: String(r.result), arquivo: f.name, senha: '' });
    r.readAsDataURL(f);
  };
  const SIT: Record<string, [string, string]> = { ok: ['Válido', 'ok'], vencendo: ['Vence em menos de 30 dias', 'alerta'], vencido: ['Vencido', 'erro'], sem: ['Sem certificado', 'alerta'] };
  return (
    <div className="cartao">
      <h3>Certificado digital (assinatura do AFD e do AEJ)</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        A Portaria 671 pede que o AFD e o AEJ sejam assinados com o certificado ICP-Brasil da empresa (e-CNPJ A1, arquivo .pfx). Com ele aqui, os arquivos saem num .zip com a assinatura .p7s e vão assim para a contabilidade.
        O arquivo e a senha ficam guardados cifrados e nunca voltam para a tela.
      </p>
      {q.error ? <Erro erro={q.error} /> : (
        <table className="tabela" style={{ marginTop: 8 }}>
          <tbody>
            {q.data?.map((c) => (
              <tr key={c.empresaId}>
                <td><b>{c.empresa}</b>{c.titular && <div className="muted" style={{ fontSize: 12 }}>{c.titular} · {c.emissor}{!c.icpBrasil && ' · não parece ICP-Brasil'}</div>}</td>
                <td><span className={`etiqueta ${SIT[c.situacao][1]}`}>{SIT[c.situacao][0]}</span>{c.validoAte && <div className="muted" style={{ fontSize: 12 }}>até {new Date(c.validoAte).toLocaleDateString('pt-BR')}</div>}</td>
                <td style={{ textAlign: 'right' }}>
                  {editar && (
                    <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <label className="botao claro pequeno" style={{ cursor: 'pointer' }}>
                        {c.titular ? 'Trocar' : 'Enviar .pfx'}
                        <input type="file" accept=".pfx,.p12,application/x-pkcs12" hidden onChange={(e) => ler(c.empresaId, e.target.files?.[0])} />
                      </label>
                      {c.titular && <button className="botao claro pequeno" disabled={remover.isPending} onClick={() => window.confirm(`Remover o certificado de ${c.empresa}? Os arquivos do ponto voltam a sair sem assinatura.`) && remover.mutate(c.empresaId)}>Remover</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {enviando && (
        <div className="form" style={{ marginTop: 10 }}>
          <Campo rotulo={`Senha do certificado (${enviando.arquivo})`} className="l2"><input type="password" autoComplete="off" autoFocus value={enviando.senha} onChange={(e) => setEnviando({ ...enviando, senha: e.target.value })} /></Campo>
          <div className="l2 flex" style={{ gap: 8, alignItems: 'flex-end' }}>
            <button className="botao" disabled={!enviando.senha || salvar.isPending} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Conferindo…' : 'Conferir e guardar'}</button>
            <button className="botao claro" onClick={() => setEnviando(null)}>Cancelar</button>
          </div>
          {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
        </div>
      )}
      {remover.error && <Erro erro={remover.error} />}
    </div>
  );
}
