import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, pode } from '../api';
import { centavosParaTexto, data as dataBR, paraCentavos, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

export interface MeuIndicacao {
  ativo: boolean;
  codigo: string;
  link: string;
  mensagem: string;
  premio: number;
  validadeDias: number;
  itens: { id: string; nome: string; cidade: string; status: string; valor: number | null; criadoEm: string; liberadaEm: string | null }[];
  totais: { indicadas: number; aprovadas: number; aReceber: number; recebido: number };
}

export const STATUS_IND: Record<string, [string, string]> = {
  candidata: ['Cadastrou-se', 'neutra'],
  aprovada: ['Aprovada: falta o 1º pedido pago', 'alerta'],
  liberada: ['Prêmio liberado', 'ok'],
  paga: ['Prêmio pago', 'ok'],
  recusada: ['Não aprovada', 'neutra'],
  expirada: ['Expirou', 'neutra'],
  cancelada: ['Cancelada', 'erro'],
};

/** /i/CODIGO: o link curto leva ao cadastro de consultora com o código de quem indicou. */
export function LinkIndicacao() {
  const { codigo = '' } = useParams();
  return <Navigate to={`/cadastro?ref=${encodeURIComponent(codigo.toUpperCase())}&utm_source=indicacao&utm_medium=link`} replace />;
}

/** "Meu link de indicação": para qualquer pessoa da equipe, na Minha mesa. */
export function MeuLinkIndicacao() {
  const q = useQuery({ queryKey: ['indicacoes', 'meu'], queryFn: () => api<MeuIndicacao>('/indicacoes/meu'), retry: false });
  const [copiado, setCopiado] = useState(false);
  const [aberto, setAberto] = useState(false);
  const d = q.data;
  if (!d || !d.ativo) return null;
  const texto = `${d.mensagem} ${d.link}`.trim();
  const copiar = async () => { try { await navigator.clipboard.writeText(d.link); setCopiado(true); setTimeout(() => setCopiado(false), 2500); } catch { window.prompt('Copie o link:', d.link); } };
  return (
    <div className="cartao ind-meu">
      <div className="flex entre" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <b>Indique uma consultora e ganhe {reais(d.premio)}</b>
          <div className="muted" style={{ fontSize: 13 }}>O prêmio é liberado quando ela é aprovada e paga o primeiro pedido (em até {d.validadeDias} dias).</div>
        </div>
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
          <code className="ind-link">{d.link.replace(/^https?:\/\//, '')}</code>
          <button className="botao claro pequeno" onClick={() => void copiar()}>{copiado ? 'Copiado!' : 'Copiar link'}</button>
          <a className="botao pequeno" href={`https://wa.me/?text=${encodeURIComponent(texto)}`} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
        </div>
      </div>
      {d.totais.indicadas > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="ind-resumo" onClick={() => setAberto(!aberto)}>
            {d.totais.indicadas} indicada(s) · {d.totais.aprovadas} aprovada(s){d.totais.aReceber ? ` · ${reais(d.totais.aReceber)} a receber` : ''}{d.totais.recebido ? ` · ${reais(d.totais.recebido)} recebido` : ''} {aberto ? '▲' : '▼'}
          </button>
          {aberto && <ListaMinhas itens={d.itens} />}
        </div>
      )}
    </div>
  );
}

function ListaMinhas({ itens }: { itens: MeuIndicacao['itens'] }) {
  return (
    <table className="tabela" style={{ marginTop: 8 }}>
      <thead><tr><th>Quem</th><th>Desde</th><th>Situação</th><th className="num">Prêmio</th></tr></thead>
      <tbody>{itens.map((i) => <tr key={i.id}><td>{i.nome}{i.cidade && <span className="muted"> · {i.cidade}</span>}</td><td>{dataBR(i.criadoEm.slice(0, 10))}</td><td><span className={`etiqueta ${STATUS_IND[i.status]?.[1] ?? 'neutra'}`}>{STATUS_IND[i.status]?.[0] ?? i.status}</span></td><td className="num">{i.valor ? reais(i.valor) : '—'}</td></tr>)}</tbody>
    </table>
  );
}

interface Linha { id: string; status: string; criadoEm: string; aprovadaEm: string | null; liberadaEm: string | null; valor: number | null; motivoLiberacao: string | null; motivoCancelamento: string | null; tituloId: string | null; indicada: string; cidade: string | null; uf: string | null; indicadaPessoaId: string | null; indicador: string; indicadorTipo: 'equipe' | 'consultora'; codigo: string }
interface Regras { ativo: boolean; valor: number; valorEquipe: number | null; validadeDias: number; lancarNoFinanceiro: boolean; prazoPagamentoDias: number; mensagemConvite: string }

/** Gestão do Indique e ganhe: todas as indicações, prêmios e regras. */
export function Indicacoes() {
  const [aba, setAba] = useState<'lista' | 'regras'>('lista');
  return (
    <>
      <Topo eb="Revendedoras" titulo="Indique e ganhe" sub="Cada consultora e cada pessoa da equipe tem um link para convidar novas consultoras. O prêmio sai quando a indicada é aprovada e paga o primeiro pedido." />
      <Abas abas={[['lista', 'Indicações'], ['regras', 'Prêmio e regras']]} ativa={aba} mudar={(a) => setAba(a as typeof aba)} />
      {aba === 'lista' ? <Lista /> : <RegrasTela />}
    </>
  );
}

function Lista() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['indicacoes', 'lista', status], queryFn: () => api<{ itens: Linha[]; totais: { candidatas: number; aguardandoPedido: number; aPagar: number; pago: number } }>(`/indicacoes${status ? `?status=${status}` : ''}`) });
  const verificar = useMutation({ mutationFn: () => api<{ liberadas: number; expiradas: number }>('/indicacoes/verificar', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['indicacoes'] }) });
  const cancelar = useMutation({ mutationFn: ({ id, motivo }: { id: string; motivo: string }) => api(`/indicacoes/${id}/cancelar`, { corpo: { motivo } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['indicacoes'] }) });
  const editar = pode('rede', 'editar');
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { itens, totais } = q.data!;
  return (
    <div className="coluna">
      <MeuLinkIndicacao />
      <div className="grade g4">
        <Indicador rotulo="Candidatas indicadas" valor={String(totais.candidatas)} detalhe="Ainda no recrutamento" />
        <Indicador rotulo="Aprovadas sem 1º pedido pago" valor={String(totais.aguardandoPedido)} />
        <Indicador tipo="atencao" rotulo="Prêmios a pagar" valor={reais(totais.aPagar)} detalhe="Estão no Financeiro, em contas a pagar" />
        <Indicador rotulo="Prêmios pagos" valor={reais(totais.pago)} />
      </div>
      <div className="flex entre" style={{ flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
          <option value="">Todas</option>
          {Object.entries(STATUS_IND).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}
        </select>
        {editar && <button className="botao claro pequeno" disabled={verificar.isPending} title="O sistema também confere sozinho a cada 30 minutos" onClick={() => verificar.mutate()}>{verificar.isPending ? 'Conferindo…' : 'Conferir pagamentos agora'}</button>}
      </div>
      {verificar.isSuccess && <div className="aviso ok">{verificar.data.liberadas} prêmio(s) liberado(s){verificar.data.expiradas ? `, ${verificar.data.expiradas} indicação(ões) expirada(s)` : ''}.</div>}
      {(verificar.error || cancelar.error) && <Erro erro={verificar.error ?? cancelar.error} />}
      <div style={{ overflowX: 'auto' }}>
        <table className="tabela">
          <thead><tr><th>Indicada</th><th>Quem indicou</th><th>Desde</th><th>Situação</th><th className="num">Prêmio</th><th></th></tr></thead>
          <tbody>
            {itens.map((i) => (
              <tr key={i.id}>
                <td>{i.indicadaPessoaId ? <Link to={`/rede/${i.indicadaPessoaId}`}><b>{i.indicada}</b></Link> : <b>{i.indicada}</b>}<span className="muted" style={{ display: 'block', fontSize: 12 }}>{[i.cidade, i.uf].filter(Boolean).join('/')}</span></td>
                <td>{i.indicador}<span className="muted" style={{ display: 'block', fontSize: 12 }}>{i.indicadorTipo === 'equipe' ? 'Equipe' : 'Consultora'} · {i.codigo}</span></td>
                <td>{dataBR(i.criadoEm.slice(0, 10))}</td>
                <td><span className={`etiqueta ${STATUS_IND[i.status]?.[1] ?? 'neutra'}`}>{STATUS_IND[i.status]?.[0] ?? i.status}</span>{(i.motivoLiberacao || i.motivoCancelamento) && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{i.motivoCancelamento ?? i.motivoLiberacao}</span>}</td>
                <td className="num">{i.valor ? reais(i.valor) : '—'}</td>
                <td>{editar && !['cancelada', 'expirada', 'paga'].includes(i.status) && <button className="botao claro pequeno" disabled={cancelar.isPending} onClick={() => { const motivo = window.prompt('Motivo do cancelamento (ex.: cadastro duplicado):'); if (motivo && motivo.trim().length >= 5) cancelar.mutate({ id: i.id, motivo }); }}>Cancelar</button>}</td>
              </tr>
            ))}
            {!itens.length && <tr><td colSpan={6} className="vazio">Nenhuma indicação ainda.</td></tr>}
          </tbody>
        </table>
      </div>
      {editar && <LigarDeBoca />}
    </div>
  );
}

/** Indicação feita de boca: liga uma candidatura (ainda sem indicação) ao código de quem indicou. */
function LigarDeBoca() {
  const qc = useQueryClient();
  const [busca, setBusca] = useState('');
  const [candidaturaId, setCandidaturaId] = useState('');
  const [codigo, setCodigo] = useState('');
  const cands = useQuery({
    queryKey: ['indicacoes', 'candidaturas', busca],
    enabled: busca.trim().length >= 3,
    queryFn: () => api<{ id: string; nome: string; cidade: string | null; uf: string | null; etapa: string }[]>(`/crm/candidaturas?busca=${encodeURIComponent(busca.trim())}`),
  });
  const ligar = useMutation({
    mutationFn: () => api('/indicacoes/ligar', { corpo: { candidaturaId, codigo: codigo.trim().toUpperCase() } }),
    onSuccess: () => { setBusca(''); setCandidaturaId(''); setCodigo(''); qc.invalidateQueries({ queryKey: ['indicacoes'] }); },
  });
  return (
    <details className="cartao">
      <summary><b>Indicação feita de boca</b> <span className="muted">· ligar uma candidata ao código de quem indicou</span></summary>
      <div className="grade g3" style={{ marginTop: 12, alignItems: 'end' }}>
        <Campo rotulo="Candidata (nome, cidade ou telefone)"><input value={busca} onChange={(e) => { setBusca(e.target.value); setCandidaturaId(''); }} placeholder="Digite 3 letras ou mais" /></Campo>
        <Campo rotulo="Escolha a candidatura">
          <select value={candidaturaId} onChange={(e) => setCandidaturaId(e.target.value)} disabled={!cands.data?.length}>
            <option value="">{cands.data ? (cands.data.length ? 'Escolha…' : 'Nenhuma encontrada') : '—'}</option>
            {cands.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.cidade ? ` · ${c.cidade}/${c.uf ?? ''}` : ''} ({c.etapa})</option>)}
          </select>
        </Campo>
        <Campo rotulo="Código de quem indicou"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="Ex.: K7M2QX9" maxLength={12} /></Campo>
      </div>
      <div className="flex" style={{ marginTop: 10 }}>
        <button className="botao pequeno" disabled={!candidaturaId || codigo.trim().length < 4 || ligar.isPending} onClick={() => ligar.mutate()}>{ligar.isPending ? 'Ligando…' : 'Ligar indicação'}</button>
        <span className="muted" style={{ fontSize: 12 }}>O código aparece no link de cada pessoa (…/i/CÓDIGO). Vale para candidaturas que ainda não têm indicação.</span>
      </div>
      {ligar.isSuccess && <div className="aviso ok">Indicação ligada.</div>}
      {ligar.error && <Erro erro={ligar.error} />}
    </details>
  );
}

function RegrasTela() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['indicacoes', 'regras'], queryFn: () => api<Regras>('/indicacoes/regras') });
  const [f, setF] = useState<{ ativo: boolean; valor: string; valorEquipe: string; validadeDias: number; lancarNoFinanceiro: boolean; prazoPagamentoDias: number; mensagemConvite: string } | null>(null);
  useEffect(() => { const r = q.data; if (r && !f) setF({ ...r, valor: centavosParaTexto(r.valor), valorEquipe: r.valorEquipe === null ? '' : centavosParaTexto(r.valorEquipe) }); }, [q.data, f]);
  const editar = pode('rede', 'editar');
  const salvar = useMutation({ mutationFn: () => api('/indicacoes/regras', { metodo: 'PUT', corpo: { ...f!, valor: paraCentavos(f!.valor || '0'), valorEquipe: f!.valorEquipe.trim() ? paraCentavos(f!.valorEquipe) : null, validadeDias: Number(f!.validadeDias), prazoPagamentoDias: Number(f!.prazoPagamentoDias) } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['indicacoes'] }) });
  if (q.isLoading || !f) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  return (
    <div className="cartao" style={{ marginTop: 12 }}>
      <label className="check"><input type="checkbox" disabled={!editar} checked={f.ativo} onChange={(e) => setF({ ...f, ativo: e.target.checked })} /> Indique e ganhe ligado (desligado, os links param de registrar indicações novas; as que já existem continuam)</label>
      <div className="form" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 10 }}>
        <Campo rotulo="Prêmio por consultora indicada (R$)" ajuda="Pago a quem indicou, quando a indicada é aprovada e paga o primeiro pedido."><input inputMode="decimal" disabled={!editar} value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} /></Campo>
        <Campo rotulo="Prêmio quando quem indicou é da equipe (R$)" ajuda="Em branco: o mesmo valor."><input inputMode="decimal" disabled={!editar} value={f.valorEquipe} placeholder={f.valor} onChange={(e) => setF({ ...f, valorEquipe: e.target.value })} /></Campo>
        <Campo rotulo="Prazo para o 1º pedido pago (dias)" ajuda="Contado da aprovação. Passou do prazo sem pagamento, a indicação expira."><input type="number" min={7} max={730} disabled={!editar} value={f.validadeDias} onChange={(e) => setF({ ...f, validadeDias: Number(e.target.value) })} /></Campo>
        <label className="check l2"><input type="checkbox" disabled={!editar} checked={f.lancarNoFinanceiro} onChange={(e) => setF({ ...f, lancarNoFinanceiro: e.target.checked })} /> Lançar o prêmio em contas a pagar no Financeiro (conta "Prêmios por indicação de consultoras")</label>
        <Campo rotulo="Vencimento do prêmio (dias depois de liberado)"><input type="number" min={0} max={90} disabled={!editar || !f.lancarNoFinanceiro} value={f.prazoPagamentoDias} onChange={(e) => setF({ ...f, prazoPagamentoDias: Number(e.target.value) })} /></Campo>
        <Campo rotulo="Mensagem do convite" className="l4" ajuda="Vai junto com o link no botão “Mandar no WhatsApp”."><textarea rows={2} maxLength={300} disabled={!editar} value={f.mensagemConvite} onChange={(e) => setF({ ...f, mensagemConvite: e.target.value })} /></Campo>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Conta como primeiro pedido pago: a primeira conta a receber da nova consultora que for paga (acerto da maleta ou compra), ou, para a afiliada, o primeiro pedido pelo link faturado. Não vale indicar a si mesmo nem quem já é (ou já foi) consultora; vale a primeira indicação de cada candidata.</p>
      {salvar.error && <Erro erro={salvar.error} />}
      {salvar.isSuccess && <div className="aviso ok" style={{ marginTop: 8 }}>Regras salvas. O valor vale para os prêmios liberados daqui em diante.</div>}
      {editar && <div style={{ marginTop: 10 }}><button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button></div>}
    </div>
  );
}
