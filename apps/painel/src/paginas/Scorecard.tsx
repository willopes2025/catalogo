import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, lerSessao, pode } from '../api';
import { centavosParaTexto, data as dataBR, paraCentavos, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Topo } from '../componentes/ui';
import { usarEquipe } from './Mesa';
import './financeiro/financeiro.css';
import './scorecard.css';

type Unidade = 'numero' | 'reais' | 'percentual';
interface Fonte { chave: string; nome: string; unidade: Unidade; sentido: 'maior' | 'menor'; ajuda: string }
interface Regras { teto: number; limiteOcorrencias: number; bonusPadrao: number; bonusPorSetor: Record<string, number>; faixas: { notaMinima: number; percentual: number }[]; mostrarAoFuncionario: boolean }
interface Indicador { id: string; nome: string; descricao: string | null; perspectiva: string; fonte: string; unidade: Unidade; meta: number; sentido: 'maior' | 'menor'; peso: number; grupoId: string | null; usuarioId: string | null; ativo: boolean; setor: string | null; pessoa: string | null }
interface LinhaMes { usuarioId: string; nome: string; setor: string; status: 'nao_iniciada' | 'aberta' | 'fechada'; indicadores: number; semResultado: number; acertos: number; erros: number; nota: number | null; percentualBonus: number; bonus: number }
interface Avaliacao {
  pessoa: { id: string; nome: string; setor: string; grupoId: string };
  mes: string;
  avaliacao: { id: string; status: 'aberta' | 'fechada'; observacao: string | null; fechadaEm: string | null } | null;
  indicadores: { indicadorId: string; nome: string; perspectiva: string; unidade: Unidade; meta: number; sentido: 'maior' | 'menor'; peso: number; fonte: string; automatico: number | null; resultado: number | null; comentario: string | null; nota: number | null }[];
  ocorrencias: { id: string; data: string; tipo: 'acerto' | 'erro'; pontos: number; descricao: string }[];
  conta: { notaIndicadores: number | null; acertos: number; erros: number; ajuste: number; notaFinal: number | null; percentualBonus: number; bonus: number };
  bonusCheio: number;
}

export const PERSPECTIVAS: Record<string, string> = { financeira: 'Financeira', clientes: 'Clientes', processos: 'Processos internos', aprendizado: 'Aprendizado e crescimento' };
const STATUS: Record<LinhaMes['status'], [string, string]> = { nao_iniciada: ['Não iniciada', 'neutra'], aberta: ['Em andamento', 'alerta'], fechada: ['Fechada', 'ok'] };
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
export const nomeMes = (m: string) => { const t = new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return t.charAt(0).toUpperCase() + t.slice(1); };
export const valorDe = (v: number | null, u: Unidade) => (v === null ? '—' : u === 'reais' ? reais(Math.round(v)) : u === 'percentual' ? `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }));
const paraTexto = (v: number | null, u: Unidade) => (v === null ? '' : u === 'reais' ? centavosParaTexto(Math.round(v)) : String(v).replace('.', ','));
const doTexto = (t: string, u: Unidade) => (!t.trim() ? null : u === 'reais' ? paraCentavos(t) : Number(t.replace(/\./g, '').replace(',', '.')));
export const nota = (n: number | null) => (n === null ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));

/** Scorecard da equipe: avaliação mensal por indicadores, acertos e erros, e o bônus pela nota. */
export function Scorecard() {
  const [sp, setSp] = useSearchParams();
  const aba = (sp.get('aba') as 'avaliar' | 'ocorrencias' | 'indicadores' | 'regras') ?? 'avaliar';
  const [mes, setMes] = useState(sp.get('mes') ?? mesAtual());
  return (
    <>
      <Topo eb="Equipe" titulo="Scorecard da equipe" sub="Indicadores com meta e peso, acertos e erros do mês, e o bônus pela nota. Quem avalia é a gestão; ninguém avalia a si mesmo." />
      <Abas abas={[['avaliar', 'Avaliar o mês'], ['ocorrencias', 'Acertos e erros'], ['indicadores', 'Indicadores'], ['regras', 'Bônus e regras']]} ativa={aba} mudar={(a) => setSp({ aba: a, mes })} />
      {(aba === 'avaliar' || aba === 'ocorrencias') && (
        <div className="flex" style={{ margin: '12px 0' }}>
          <label className="muted" htmlFor="sc-mes">Mês</label>
          <input id="sc-mes" type="month" value={mes} max={mesAtual()} onChange={(e) => e.target.value && setMes(e.target.value)} style={{ maxWidth: 180 }} />
          <span className="muted">{nomeMes(mes)}</span>
        </div>
      )}
      {aba === 'avaliar' && <Mes mes={mes} />}
      {aba === 'ocorrencias' && <Ocorrencias mes={mes} />}
      {aba === 'indicadores' && <Indicadores />}
      {aba === 'regras' && <RegrasTela />}
    </>
  );
}

function Mes({ mes }: { mes: string }) {
  const q = useQuery({ queryKey: ['scorecard', 'mes', mes], queryFn: () => api<{ itens: LinhaMes[]; totalBonus: number }>(`/scorecard/mes?mes=${mes}`) });
  const [aberta, setAberta] = useState<string | null>(null);
  const eu = lerSessao()?.usuario.id;
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const itens = q.data!.itens;
  const exportar = () => {
    const linhas = [['Pessoa', 'Setor', 'Situação', 'Nota', 'Faixa do bônus (%)', 'Bônus (R$)'], ...itens.map((i) => [i.nome, i.setor, STATUS[i.status][0], i.nota === null ? '' : String(i.nota).replace('.', ','), String(i.percentualBonus), (i.bonus / 100).toFixed(2).replace('.', ',')])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + linhas.map((l) => l.map((v) => `"${v.replace(/"/g, '""')}"`).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `scorecard-${mes}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="tabela">
          <thead><tr><th>Pessoa</th><th>Setor</th><th className="num">Indicadores</th><th className="num">Acertos / erros</th><th className="num">Nota</th><th className="num">Bônus</th><th>Situação</th></tr></thead>
          <tbody>
            {itens.map((i) => (
              <tr key={i.usuarioId} className="clicavel" onClick={() => setAberta(i.usuarioId)}>
                <td><b>{i.nome}</b>{i.usuarioId === eu && <span className="muted"> (você)</span>}</td>
                <td>{i.setor}</td>
                <td className="num">{i.indicadores ? `${i.indicadores - i.semResultado} de ${i.indicadores}` : <span className="muted">nenhum</span>}</td>
                <td className="num"><span className="sc-acerto">+{nota(i.acertos)}</span> / <span className="sc-erro">−{nota(i.erros)}</span></td>
                <td className="num"><b>{nota(i.nota)}</b></td>
                <td className="num">{i.bonus ? reais(i.bonus) : '—'}{i.status !== 'fechada' && i.bonus > 0 && <span className="muted"> (prévia)</span>}</td>
                <td><span className={`etiqueta ${STATUS[i.status][1]}`}>{STATUS[i.status][0]}</span></td>
              </tr>
            ))}
            {!itens.length && <tr><td colSpan={7} className="vazio">Ninguém ativo na equipe.</td></tr>}
          </tbody>
          {itens.length > 0 && <tfoot><tr><td colSpan={5}><b>Bônus das avaliações fechadas</b></td><td className="num"><b>{reais(q.data!.totalBonus)}</b></td><td>{pode('scorecard', 'exportar') && <button className="botao claro pequeno" onClick={exportar}>Exportar</button>}</td></tr></tfoot>}
        </table>
      </div>
      {aberta && <AvaliarPessoa usuarioId={aberta} mes={mes} fechar={() => setAberta(null)} />}
    </>
  );
}

function AvaliarPessoa({ usuarioId, mes, fechar }: { usuarioId: string; mes: string; fechar: () => void }) {
  const qc = useQueryClient();
  const eu = lerSessao()?.usuario.id;
  const q = useQuery({ queryKey: ['scorecard', 'avaliacao', usuarioId, mes], queryFn: () => api<Avaliacao>(`/scorecard/avaliacao?usuarioId=${usuarioId}&mes=${mes}`) });
  const [valores, setValores] = useState<Record<string, { resultado: string; comentario: string }>>({});
  const [obs, setObs] = useState<string | null>(null);
  const [ocorrencia, setOcorrencia] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (!d) return;
    setValores(Object.fromEntries(d.indicadores.map((i) => [i.indicadorId, { resultado: paraTexto(i.resultado, i.unidade), comentario: i.comentario ?? '' }])));
    setObs(d.avaliacao?.observacao ?? '');
  }, [d]);
  const fechada = d?.avaliacao?.status === 'fechada';
  const propria = usuarioId === eu;
  const editavel = pode('scorecard', 'editar') && !fechada && !propria;
  const atualizar = (r: Avaliacao) => { qc.setQueryData(['scorecard', 'avaliacao', usuarioId, mes], r); qc.invalidateQueries({ queryKey: ['scorecard', 'mes'] }); };
  const corpo = () => ({ usuarioId, mes, observacao: obs || null, resultados: d!.indicadores.map((i) => ({ indicadorId: i.indicadorId, resultado: doTexto(valores[i.indicadorId]?.resultado ?? '', i.unidade), comentario: valores[i.indicadorId]?.comentario || null })) });
  const salvar = useMutation({ mutationFn: () => api<Avaliacao>('/scorecard/avaliacao', { metodo: 'PUT', corpo: corpo() }), onSuccess: atualizar });
  const fecharAv = useMutation({ mutationFn: async () => { await api('/scorecard/avaliacao', { metodo: 'PUT', corpo: corpo() }); return api<Avaliacao>('/scorecard/avaliacao/fechar', { corpo: { usuarioId, mes } }); }, onSuccess: atualizar });
  const reabrir = useMutation({ mutationFn: () => api<Avaliacao>('/scorecard/avaliacao/reabrir', { corpo: { usuarioId, mes } }), onSuccess: atualizar });
  const apagarOc = useMutation({ mutationFn: (id: string) => api(`/scorecard/ocorrencias/${id}`, { metodo: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['scorecard'] }); } });
  const porPerspectiva = useMemo(() => {
    const g: Record<string, Avaliacao['indicadores']> = {};
    for (const i of d?.indicadores ?? []) (g[i.perspectiva] ??= []).push(i);
    return g;
  }, [d]);
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal sc-modal" onClick={(e) => e.stopPropagation()}>
        {q.isLoading || !d ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
          <>
            <div className="flex entre" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ margin: 0 }}>{d.pessoa.nome}</h3>
                <span className="muted">{d.pessoa.setor} · {nomeMes(mes)}{fechada && d.avaliacao?.fechadaEm ? ` · fechada em ${dataBR(d.avaliacao.fechadaEm.slice(0, 10))}` : ''}</span>
              </div>
              <div className="sc-placar">
                <div><span className="muted">Indicadores</span><b>{nota(d.conta.notaIndicadores)}</b></div>
                <div><span className="muted">Acertos e erros</span><b className={d.conta.ajuste < 0 ? 'sc-erro' : 'sc-acerto'}>{d.conta.ajuste > 0 ? '+' : ''}{nota(d.conta.ajuste)}</b></div>
                <div className="final"><span className="muted">Nota</span><b>{nota(d.conta.notaFinal)}</b></div>
                <div><span className="muted">Bônus ({d.conta.percentualBonus}% de {reais(d.bonusCheio)})</span><b>{reais(d.conta.bonus)}</b></div>
              </div>
            </div>
            {propria && <div className="aviso alerta" style={{ marginTop: 10 }}>Esta é a sua avaliação: quem fecha é outra pessoa da gestão.</div>}
            {!d.indicadores.length && <div className="aviso alerta" style={{ marginTop: 10 }}>Esta pessoa ainda não tem indicadores. Cadastre na aba Indicadores (para todos, para o setor {d.pessoa.setor} ou só para ela).</div>}
            {Object.entries(porPerspectiva).map(([p, lista]) => (
              <div key={p} style={{ marginTop: 14 }}>
                <div className="secao">{PERSPECTIVAS[p] ?? p}</div>
                <table className="tabela sc-tabela">
                  <thead><tr><th>Indicador</th><th className="num">Meta</th><th className="num">Peso</th><th className="num">Resultado</th><th className="num">Nota</th><th>Comentário</th></tr></thead>
                  <tbody>
                    {lista.map((i) => (
                      <tr key={i.indicadorId}>
                        <td><b>{i.nome}</b><span className="muted sc-dica">{i.sentido === 'menor' ? 'quanto menor, melhor' : 'quanto maior, melhor'}{i.automatico !== null && !fechada ? ` · o sistema calculou ${valorDe(i.automatico, i.unidade)}` : ''}</span></td>
                        <td className="num">{valorDe(i.meta, i.unidade)}</td>
                        <td className="num">{i.peso}</td>
                        <td className="num">{editavel ? <input className="sc-num" inputMode="decimal" value={valores[i.indicadorId]?.resultado ?? ''} placeholder={i.unidade === 'reais' ? '0,00' : '—'} onChange={(e) => setValores({ ...valores, [i.indicadorId]: { ...valores[i.indicadorId], resultado: e.target.value } })} aria-label={`Resultado de ${i.nome}`} /> : valorDe(i.resultado, i.unidade)}</td>
                        <td className="num"><b>{nota(i.nota)}</b></td>
                        <td>{editavel ? <input value={valores[i.indicadorId]?.comentario ?? ''} maxLength={500} onChange={(e) => setValores({ ...valores, [i.indicadorId]: { ...valores[i.indicadorId], comentario: e.target.value } })} aria-label={`Comentário de ${i.nome}`} /> : i.comentario ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="flex entre" style={{ marginTop: 14 }}>
              <div className="secao" style={{ margin: 0 }}>Acertos e erros do mês</div>
              {!fechada && !propria && pode('scorecard', 'criar') && <button className="botao claro pequeno" onClick={() => setOcorrencia(true)}>Registrar</button>}
            </div>
            {d.ocorrencias.length === 0 ? <p className="muted" style={{ margin: '6px 0 0' }}>Nenhum registro no mês.</p> : (
              <div className="sc-ocorrencias">
                {d.ocorrencias.map((o) => (
                  <div key={o.id} className="flex entre">
                    <span><span className={o.tipo === 'acerto' ? 'sc-acerto' : 'sc-erro'}>{o.tipo === 'acerto' ? '+' : '−'}{nota(o.pontos)}</span> <span className="muted">{dataBR(o.data)}</span> {o.descricao}</span>
                    {!fechada && pode('scorecard', 'editar') && !propria && <button className="botao claro pequeno" disabled={apagarOc.isPending} onClick={() => window.confirm('Apagar este registro?') && apagarOc.mutate(o.id)}>Apagar</button>}
                  </div>
                ))}
              </div>
            )}
            <Campo rotulo="Observação da avaliação" ajuda={fechada ? undefined : 'A pessoa vê esta observação quando a avaliação é fechada.'}>
              <textarea rows={2} maxLength={2000} disabled={!editavel} value={obs ?? ''} onChange={(e) => setObs(e.target.value)} />
            </Campo>
            {(salvar.error || fecharAv.error || reabrir.error || apagarOc.error) && <Erro erro={salvar.error ?? fecharAv.error ?? reabrir.error ?? apagarOc.error} />}
            {salvar.isSuccess && !fechada && <div className="aviso ok" style={{ marginTop: 8 }}>Resultados guardados. A avaliação continua aberta.</div>}
            <div className="flex" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              {editavel && <button className="botao claro" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Guardar</button>}
              {editavel && <button className="botao" disabled={fecharAv.isPending || !d.indicadores.length} onClick={() => window.confirm('Fechar a avaliação? A nota e o bônus ficam gravados e a pessoa passa a ver o resultado.') && fecharAv.mutate()}>{fecharAv.isPending ? 'Fechando…' : 'Fechar a avaliação'}</button>}
              {fechada && !propria && pode('scorecard', 'editar') && <button className="botao claro" disabled={reabrir.isPending} onClick={() => window.confirm('Reabrir a avaliação para mudar?') && reabrir.mutate()}>Reabrir</button>}
              <button className="botao claro" onClick={fechar}>Fechar janela</button>
            </div>
            {ocorrencia && <NovaOcorrencia usuarioId={usuarioId} mes={mes} fechar={() => setOcorrencia(false)} />}
          </>
        )}
      </div>
    </div>
  );
}

function NovaOcorrencia({ usuarioId, mes, fechar }: { usuarioId?: string; mes: string; fechar: () => void }) {
  const qc = useQueryClient();
  const equipe = usarEquipe();
  const eu = lerSessao()?.usuario.id;
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ usuarioId: usuarioId ?? '', data: hoje.startsWith(mes) ? hoje : `${mes}-01`, tipo: 'acerto' as 'acerto' | 'erro', pontos: '2', descricao: '' });
  const salvar = useMutation({ mutationFn: () => api('/scorecard/ocorrencias', { corpo: { ...f, pontos: Number(f.pontos.replace(',', '.')) } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['scorecard'] }); fechar(); } });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 10px' }}>Registrar acerto ou erro</h3>
        <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {!usuarioId && <Campo rotulo="Pessoa" className="l2"><select value={f.usuarioId} onChange={(e) => setF({ ...f, usuarioId: e.target.value })}><option value="">Escolha…</option>{equipe.data?.filter((p) => p.id !== eu).map((p) => <option key={p.id} value={p.id}>{p.nome} · {p.setor}</option>)}</select></Campo>}
          <Campo rotulo="Tipo"><select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value as 'acerto' | 'erro' })}><option value="acerto">Acerto (soma pontos)</option><option value="erro">Erro (tira pontos)</option></select></Campo>
          <Campo rotulo="Pontos"><input inputMode="decimal" value={f.pontos} onChange={(e) => setF({ ...f, pontos: e.target.value })} /></Campo>
          <Campo rotulo="Data" className="l2"><input type="date" max={hoje} value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} /></Campo>
          <Campo rotulo="O que aconteceu *" className="l2"><textarea rows={3} maxLength={1000} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder="Ex.: Recuperou a venda de uma cliente que ia desistir." /></Campo>
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={salvar.isPending || !f.usuarioId || f.descricao.trim().length < 5} onClick={() => salvar.mutate()}>Registrar</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

function Ocorrencias({ mes }: { mes: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['scorecard', 'ocorrencias', mes], queryFn: () => api<{ id: string; usuarioId: string; pessoa: string; data: string; tipo: 'acerto' | 'erro'; pontos: number; descricao: string; registradoPor: string | null }[]>(`/scorecard/ocorrencias?mes=${mes}`) });
  const [nova, setNova] = useState(false);
  const apagar = useMutation({ mutationFn: (id: string) => api(`/scorecard/ocorrencias/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['scorecard'] }) });
  return (
    <>
      <div className="flex entre" style={{ marginBottom: 8 }}>
        <p className="muted" style={{ margin: 0 }}>Registre na hora em que acontece: cada acerto soma e cada erro tira pontos da nota do mês, até o limite definido em "Bônus e regras".</p>
        {pode('scorecard', 'criar') && <button className="botao" onClick={() => setNova(true)}>Registrar</button>}
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th>Data</th><th>Pessoa</th><th className="num">Pontos</th><th>O que aconteceu</th><th>Registrado por</th><th></th></tr></thead>
          <tbody>
            {q.data!.map((o) => (
              <tr key={o.id}>
                <td>{dataBR(o.data)}</td><td>{o.pessoa}</td>
                <td className="num"><span className={o.tipo === 'acerto' ? 'sc-acerto' : 'sc-erro'}>{o.tipo === 'acerto' ? '+' : '−'}{nota(o.pontos)}</span></td>
                <td style={{ whiteSpace: 'pre-wrap' }}>{o.descricao}</td><td>{o.registradoPor ?? '—'}</td>
                <td>{pode('scorecard', 'editar') && <button className="botao claro pequeno" disabled={apagar.isPending} onClick={() => window.confirm('Apagar este registro?') && apagar.mutate(o.id)}>Apagar</button>}</td>
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={6} className="vazio">Nenhum acerto ou erro registrado no mês.</td></tr>}
          </tbody>
        </table>
      )}
      {apagar.error && <Erro erro={apagar.error} />}
      {nova && <NovaOcorrencia mes={mes} fechar={() => setNova(false)} />}
    </>
  );
}

function Indicadores() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['scorecard', 'indicadores'], queryFn: () => api<Indicador[]>('/scorecard/indicadores') });
  const regras = useQuery({ queryKey: ['scorecard', 'regras'], queryFn: () => api<{ regras: Regras; fontes: Fonte[] }>('/scorecard/regras') });
  const [editando, setEditando] = useState<Partial<Indicador> | null>(null);
  const fontes = regras.data?.fontes ?? [];
  return (
    <>
      <div className="flex entre" style={{ margin: '12px 0 8px' }}>
        <p className="muted" style={{ margin: 0 }}>Cada indicador tem meta e peso e vale para todos, para um setor (grupo de usuários) ou para uma pessoa. O resultado é lançado na avaliação; nos automáticos o sistema já traz a conta do mês.</p>
        {pode('scorecard', 'editar') && <button className="botao" onClick={() => setEditando({ perspectiva: 'processos', fonte: 'manual', unidade: 'numero', sentido: 'maior', peso: 1, ativo: true, meta: 0 })}>Novo indicador</button>}
      </div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <table className="tabela">
          <thead><tr><th>Indicador</th><th>Perspectiva</th><th>Vale para</th><th>Resultado</th><th className="num">Meta</th><th className="num">Peso</th><th></th></tr></thead>
          <tbody>
            {q.data!.map((i) => (
              <tr key={i.id} style={i.ativo ? undefined : { opacity: 0.5 }}>
                <td><b>{i.nome}</b>{i.descricao && <span className="muted sc-dica">{i.descricao}</span>}</td>
                <td>{PERSPECTIVAS[i.perspectiva]}</td>
                <td>{i.pessoa ? `Só ${i.pessoa}` : i.setor ? `Setor ${i.setor}` : 'Todos'}</td>
                <td>{i.fonte === 'manual' ? 'Lançado à mão' : `Automático: ${fontes.find((f) => f.chave === i.fonte)?.nome ?? i.fonte}`}</td>
                <td className="num">{i.sentido === 'menor' ? 'até ' : ''}{valorDe(i.meta, i.unidade)}</td>
                <td className="num">{i.peso}</td>
                <td>{pode('scorecard', 'editar') && <button className="botao claro pequeno" onClick={() => setEditando(i)}>Editar</button>}</td>
              </tr>
            ))}
            {!q.data!.length && <tr><td colSpan={7} className="vazio">Nenhum indicador ainda. Comece pelos que valem para todos e depois os de cada setor.</td></tr>}
          </tbody>
        </table>
      )}
      {editando && <EditarIndicador ind={editando} fontes={fontes} fechar={() => setEditando(null)} salvo={() => { setEditando(null); qc.invalidateQueries({ queryKey: ['scorecard'] }); }} />}
    </>
  );
}

function EditarIndicador({ ind, fontes, fechar, salvo }: { ind: Partial<Indicador>; fontes: Fonte[]; fechar: () => void; salvo: () => void }) {
  const equipe = usarEquipe();
  const grupos = useQuery({ queryKey: ['scorecard', 'regras'], queryFn: () => api<{ regras: Regras; fontes: Fonte[]; setores: { id: string; nome: string }[] }>('/scorecard/regras'), select: (d) => d.setores });
  const [f, setF] = useState({ ...ind, metaTexto: paraTexto(ind.meta ?? null, ind.unidade ?? 'numero'), alcance: ind.usuarioId ? 'pessoa' : ind.grupoId ? 'setor' : 'todos' });
  const fonte = fontes.find((x) => x.chave === f.fonte);
  const corpo = () => ({ nome: f.nome, descricao: f.descricao || null, perspectiva: f.perspectiva, fonte: f.fonte, unidade: f.unidade, meta: doTexto(f.metaTexto, f.unidade ?? 'numero') ?? 0, sentido: f.sentido, peso: Number(f.peso) || 1, grupoId: f.alcance === 'setor' ? f.grupoId : null, usuarioId: f.alcance === 'pessoa' ? f.usuarioId : null, ativo: f.ativo });
  const salvar = useMutation({ mutationFn: () => (ind.id ? api(`/scorecard/indicadores/${ind.id}`, { metodo: 'PATCH', corpo: corpo() }) : api('/scorecard/indicadores', { corpo: corpo() })), onSuccess: salvo });
  const apagar = useMutation({ mutationFn: () => api(`/scorecard/indicadores/${ind.id}`, { metodo: 'DELETE' }), onSuccess: salvo });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 10px' }}>{ind.id ? 'Editar indicador' : 'Novo indicador'}</h3>
        <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Campo rotulo="Nome *" className="l2"><input maxLength={120} value={f.nome ?? ''} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Vendas da loja, Acertos no prazo, Satisfação das revendedoras" /></Campo>
          <Campo rotulo="Como medir" className="l2"><input maxLength={500} value={f.descricao ?? ''} onChange={(e) => setF({ ...f, descricao: e.target.value })} /></Campo>
          <Campo rotulo="Perspectiva"><select value={f.perspectiva} onChange={(e) => setF({ ...f, perspectiva: e.target.value })}>{Object.entries(PERSPECTIVAS).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Campo>
          <Campo rotulo="Resultado" ajuda={fonte?.ajuda}>
            <select value={f.fonte} onChange={(e) => { const x = fontes.find((y) => y.chave === e.target.value); setF({ ...f, fonte: e.target.value, ...(x ? { unidade: x.unidade, sentido: x.sentido } : {}) }); }}>
              <option value="manual">Lançado à mão pela gestão</option>
              {fontes.map((x) => <option key={x.chave} value={x.chave}>Automático: {x.nome}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Unidade"><select disabled={!!fonte} value={f.unidade} onChange={(e) => setF({ ...f, unidade: e.target.value as Unidade })}><option value="numero">Número</option><option value="reais">Reais (R$)</option><option value="percentual">Percentual (%)</option></select></Campo>
          <Campo rotulo="Sentido"><select disabled={!!fonte} value={f.sentido} onChange={(e) => setF({ ...f, sentido: e.target.value as 'maior' | 'menor' })}><option value="maior">Quanto maior, melhor</option><option value="menor">Quanto menor, melhor</option></select></Campo>
          <Campo rotulo={f.sentido === 'menor' ? 'Meta (no máximo)' : 'Meta'}><input inputMode="decimal" value={f.metaTexto} onChange={(e) => setF({ ...f, metaTexto: e.target.value })} placeholder={f.unidade === 'reais' ? '0,00' : '0'} /></Campo>
          <Campo rotulo="Peso" ajuda="Quanto este indicador conta na nota, perto dos outros."><input type="number" min={1} max={100} value={f.peso ?? 1} onChange={(e) => setF({ ...f, peso: Number(e.target.value) })} /></Campo>
          <Campo rotulo="Vale para"><select value={f.alcance} onChange={(e) => setF({ ...f, alcance: e.target.value })}><option value="todos">Todos</option><option value="setor">Um setor</option><option value="pessoa">Uma pessoa</option></select></Campo>
          {f.alcance === 'setor' && <Campo rotulo="Setor"><select value={f.grupoId ?? ''} onChange={(e) => setF({ ...f, grupoId: e.target.value })}><option value="">Escolha…</option>{(grupos.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}</select></Campo>}
          {f.alcance === 'pessoa' && <Campo rotulo="Pessoa"><select value={f.usuarioId ?? ''} onChange={(e) => setF({ ...f, usuarioId: e.target.value })}><option value="">Escolha…</option>{equipe.data?.map((p) => <option key={p.id} value={p.id}>{p.nome} · {p.setor}</option>)}</select></Campo>}
          <label className="check l2"><input type="checkbox" checked={f.ativo ?? true} onChange={(e) => setF({ ...f, ativo: e.target.checked })} /> Ativo (desmarcado, não entra nas avaliações novas)</label>
        </div>
        {(salvar.error || apagar.error) && <Erro erro={salvar.error ?? apagar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={salvar.isPending || !(f.nome ?? '').trim() || (f.alcance === 'setor' && !f.grupoId) || (f.alcance === 'pessoa' && !f.usuarioId)} onClick={() => salvar.mutate()}>Salvar</button>
          {ind.id && pode('scorecard', 'excluir') && <button className="botao claro" disabled={apagar.isPending} onClick={() => window.confirm('Apagar o indicador? As avaliações já fechadas não mudam.') && apagar.mutate()}>Apagar</button>}
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

function RegrasTela() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['scorecard', 'regras'], queryFn: () => api<{ regras: Regras; fontes: Fonte[] }>('/scorecard/regras') });
  const grupos = { data: (q.data as { setores?: { id: string; nome: string }[] } | undefined)?.setores };
  const [f, setF] = useState<(Omit<Regras, 'bonusPadrao' | 'bonusPorSetor' | 'faixas'> & { bonusPadrao: string; bonusPorSetor: Record<string, string>; faixas: { notaMinima: string; percentual: string }[] }) | null>(null);
  useEffect(() => {
    const r = q.data?.regras;
    if (r && !f) setF({ ...r, bonusPadrao: centavosParaTexto(r.bonusPadrao), bonusPorSetor: Object.fromEntries(Object.entries(r.bonusPorSetor).map(([k, v]) => [k, centavosParaTexto(v)])), faixas: r.faixas.map((x) => ({ notaMinima: String(x.notaMinima), percentual: String(x.percentual) })) });
  }, [q.data, f]);
  const editavel = pode('scorecard', 'editar');
  const salvar = useMutation({
    mutationFn: () => api('/scorecard/regras', { metodo: 'PUT', corpo: { teto: Number(f!.teto), limiteOcorrencias: Number(f!.limiteOcorrencias), bonusPadrao: paraCentavos(f!.bonusPadrao || '0'), bonusPorSetor: Object.fromEntries(Object.entries(f!.bonusPorSetor).filter(([, v]) => v.trim()).map(([k, v]) => [k, paraCentavos(v)])), faixas: f!.faixas.filter((x) => x.notaMinima.trim()).map((x) => ({ notaMinima: Number(x.notaMinima.replace(',', '.')), percentual: Number(x.percentual.replace(',', '.')) || 0 })), mostrarAoFuncionario: f!.mostrarAoFuncionario } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scorecard'] }),
  });
  if (q.isLoading || !f) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  return (
    <div className="cartao" style={{ marginTop: 12 }}>
      <p className="muted" style={{ marginTop: 0 }}>A nota de cada indicador é quanto da meta foi atingido (até o teto). A nota final é a média pelos pesos, mais os acertos e menos os erros do mês (dentro do limite). A faixa em que a nota cai define a parte do bônus cheio que a pessoa recebe.</p>
      <div className="form" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <Campo rotulo="Teto da nota" ajuda="100: bater a meta é o máximo. 120: superar a meta rende até 120."><input type="number" min={100} max={200} disabled={!editavel} value={f.teto} onChange={(e) => setF({ ...f, teto: Number(e.target.value) })} /></Campo>
        <Campo rotulo="Limite dos acertos e erros" ajuda="Quantos pontos os registros do mês podem somar ou tirar."><input type="number" min={0} max={100} disabled={!editavel} value={f.limiteOcorrencias} onChange={(e) => setF({ ...f, limiteOcorrencias: Number(e.target.value) })} /></Campo>
        <Campo rotulo="Bônus cheio por pessoa (R$)" ajuda="Vale para quem não tem valor do setor abaixo."><input inputMode="decimal" disabled={!editavel} value={f.bonusPadrao} onChange={(e) => setF({ ...f, bonusPadrao: e.target.value })} /></Campo>
      </div>
      <div className="secao">Bônus cheio por setor</div>
      <div className="form" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {grupos.data?.map((g) => <Campo key={g.id} rotulo={g.nome}><input inputMode="decimal" disabled={!editavel} placeholder={`padrão: ${f.bonusPadrao || '0,00'}`} value={f.bonusPorSetor[g.id] ?? ''} onChange={(e) => setF({ ...f, bonusPorSetor: { ...f.bonusPorSetor, [g.id]: e.target.value } })} /></Campo>)}
      </div>
      <div className="secao">Faixas do bônus</div>
      {f.faixas.map((x, i) => (
        <div key={i} className="flex" style={{ marginBottom: 6 }}>
          <span className="muted">Nota a partir de</span>
          <input style={{ width: 80 }} inputMode="decimal" disabled={!editavel} value={x.notaMinima} onChange={(e) => setF({ ...f, faixas: f.faixas.map((y, j) => (j === i ? { ...y, notaMinima: e.target.value } : y)) })} aria-label="Nota mínima" />
          <span className="muted">recebe</span>
          <input style={{ width: 80 }} inputMode="decimal" disabled={!editavel} value={x.percentual} onChange={(e) => setF({ ...f, faixas: f.faixas.map((y, j) => (j === i ? { ...y, percentual: e.target.value } : y)) })} aria-label="Percentual do bônus" />
          <span className="muted">% do bônus</span>
          {editavel && <button className="botao claro pequeno" onClick={() => setF({ ...f, faixas: f.faixas.filter((_, j) => j !== i) })}>Tirar</button>}
        </div>
      ))}
      {editavel && f.faixas.length < 10 && <button className="botao claro pequeno" onClick={() => setF({ ...f, faixas: [...f.faixas, { notaMinima: '', percentual: '' }] })}>+ Faixa</button>}
      <p className="muted" style={{ fontSize: 13 }}>Nota abaixo da menor faixa não recebe bônus.</p>
      <label className="check"><input type="checkbox" disabled={!editavel} checked={f.mostrarAoFuncionario} onChange={(e) => setF({ ...f, mostrarAoFuncionario: e.target.checked })} /> Cada pessoa vê a própria avaliação fechada na Minha mesa</label>
      {salvar.error && <Erro erro={salvar.error} />}
      {salvar.isSuccess && <div className="aviso ok" style={{ marginTop: 8 }}>Regras salvas. Valem para as avaliações ainda abertas; as fechadas não mudam.</div>}
      {editavel && <div style={{ marginTop: 12 }}><button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar regras</button></div>}
    </div>
  );
}
