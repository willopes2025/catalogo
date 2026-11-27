import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { dataHora, reais } from '../formato';
import { Abas, Carregando, Erro, Topo } from '../componentes/ui';

const OPERACAO: Record<string, string> = {
  venda_consumidor: 'Venda ao consumidor',
  remessa_consignacao: 'Remessa em consignação',
  retorno_consignacao: 'Retorno de consignação',
  venda_consignacao: 'Venda de consignação',
  retorno_simbolico: 'Retorno simbólico',
  venda_revenda: 'Venda para revenda',
};
const STATUS: Record<string, [string, string]> = { autorizada: ['ok', 'Autorizada'], processando: ['alerta', 'Processando'], pendente: ['alerta', 'Pendente'], erro: ['erro', 'Com erro'], cancelada: ['neutra', 'Cancelada'], denegada: ['erro', 'Denegada'] };

export function Fiscal() {
  const [aba, setAba] = useState<'notas' | 'regras'>('notas');
  const sit = useQuery({ queryKey: ['fiscal-situacao'], queryFn: () => api<{ configurado: boolean; ambiente: string }>('/fiscal/situacao') });
  return (
    <>
      <Topo eb="Fiscal" titulo="Notas fiscais" sub={sit.data && (sit.data.configurado ? <>Emissor ligado · ambiente de <b>{sit.data.ambiente}</b></> : 'Emissor ainda não ligado: falta o token da Focus NFe e o certificado A1 da Aritana.')} />
      <Pendencias />
      <Abas ativa={aba} mudar={setAba} abas={[['notas', 'Notas emitidas'], ['regras', 'Regras fiscais']]} />
      {aba === 'notas' ? <Notas /> : <Regras />}
    </>
  );
}

function Notas() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['notas', status], queryFn: () => api<any[]>(`/fiscal/notas${status ? `?status=${status}` : ''}`) });
  const acao = useMutation({
    mutationFn: ({ id, tipo, corpo }: { id: string; tipo: string; corpo?: any }) => api(`/fiscal/notas/${id}/${tipo}`, { corpo: corpo ?? {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notas'] }),
  });
  const link = (n: any) => (n.origemTipo === 'venda' ? `/vendas/${n.origemId}` : n.origemTipo === 'maleta' ? `/maletas/${n.origemId}` : null);
  return (
    <>
      <div className="busca"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option>{Object.entries(STATUS).map(([k, [, n]]) => <option key={k} value={k}>{n}</option>)}</select></div>
      {acao.error && <Erro erro={acao.error} />}
      {q.isLoading ? <Carregando /> : q.data!.length === 0 ? <div className="cartao vazio">Nenhuma nota emitida ainda.</div> : (
        <table className="tabela">
          <thead><tr><th>Data</th><th>Modelo</th><th>Operação</th><th>Destinatário</th><th>Nº / série</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {q.data!.map((n) => {
              const [c, t] = STATUS[n.status] ?? ['neutra', n.status];
              return (
                <tr key={n.id}>
                  <td>{dataHora(n.criadoEm)}</td>
                  <td>{n.modelo === 'nfce' ? 'NFC-e' : 'NF-e'}</td>
                  <td>{OPERACAO[n.operacao] ?? n.operacao}{link(n) && <> · <Link to={link(n)!}>origem</Link></>}</td>
                  <td>{n.destinatario ?? 'Consumidor'}</td>
                  <td>{n.numero ? `${n.numero} / ${n.serie}` : '—'}</td>
                  <td className="num">{reais(n.valor)}</td>
                  <td><span className={`etiqueta ${c}`}>{t}</span>{n.mensagem && n.status !== 'autorizada' && <div className="muted" style={{ maxWidth: 260 }}>{n.mensagem}</div>}</td>
                  <td>
                    <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {n.urlDanfe && <a className="botao claro pequeno" href={n.urlDanfe} target="_blank" rel="noreferrer">DANFE</a>}
                      {n.urlXml && <a className="botao claro pequeno" href={n.urlXml} target="_blank" rel="noreferrer">XML</a>}
                      {n.status === 'processando' && <button className="botao claro pequeno" onClick={() => acao.mutate({ id: n.id, tipo: 'consultar' })}>Atualizar</button>}
                      {n.status === 'erro' && pode('fiscal', 'criar') && <button className="botao pequeno" onClick={() => acao.mutate({ id: n.id, tipo: 'reenviar' })}>Reenviar</button>}
                      {n.status === 'autorizada' && pode('fiscal', 'excluir') && <button className="botao perigo pequeno" onClick={() => { const j = window.prompt('Justificativa do cancelamento (mínimo 15 caracteres):'); if (j && j.trim().length >= 15) acao.mutate({ id: n.id, tipo: 'cancelar', corpo: { justificativa: j.trim() } }); }}>Cancelar</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function Regras() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['regras-fiscais'], queryFn: () => api<any[]>('/fiscal/regras') });
  const [edit, setEdit] = useState<Record<string, any>>({});
  useEffect(() => { if (q.data) setEdit(Object.fromEntries(q.data.map((r) => [r.operacao, r]))); }, [q.data]);
  const salvar = useMutation({
    mutationFn: (r: any) => api(`/fiscal/regras/${r.operacao}`, { metodo: 'PUT', corpo: { natureza: r.natureza, cfopDentro: r.cfopDentro, cfopFora: r.cfopFora, csosn: r.csosn, base: r.base, observacao: r.observacao } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regras-fiscais'] }),
  });
  if (q.isLoading) return <Carregando />;
  const editavel = pode('configuracoes', 'editar');
  return (
    <div className="coluna">
      <div className="aviso alerta">Os valores abaixo são um ponto de partida para empresa do Simples Nacional. <b>O contador da Aritana precisa conferir cada linha antes de emitir notas em produção.</b></div>
      {salvar.error && <Erro erro={salvar.error} />}
      <table className="tabela">
        <thead><tr><th>Operação</th><th>Natureza da operação</th><th>CFOP no estado</th><th>CFOP fora</th><th>CSOSN</th><th>Quando usa</th><th></th></tr></thead>
        <tbody>
          {q.data!.map((r0) => {
            const r = edit[r0.operacao] ?? r0;
            const set = (k: string) => (e: { target: { value: string } }) => setEdit({ ...edit, [r0.operacao]: { ...r, [k]: e.target.value } });
            const mudou = JSON.stringify(r) !== JSON.stringify(r0);
            return (
              <tr key={r0.operacao}>
                <td><b>{OPERACAO[r0.operacao]}</b></td>
                <td><input value={r.natureza} onChange={set('natureza')} disabled={!editavel} /></td>
                <td><input value={r.cfopDentro} onChange={set('cfopDentro')} style={{ width: 70 }} disabled={!editavel} /></td>
                <td><input value={r.cfopFora} onChange={set('cfopFora')} style={{ width: 70 }} disabled={!editavel} /></td>
                <td><input value={r.csosn} onChange={set('csosn')} style={{ width: 60 }} disabled={!editavel} /></td>
                <td className="muted">{r0.observacao}</td>
                <td>{editavel && <button className="botao pequeno" disabled={!mudou || salvar.isPending} onClick={() => salvar.mutate(r)}>Salvar</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** O que ainda trava a emissão (peças sem NCM, empresa sem CNPJ), com o preenchimento do NCM em lote. */
function Pendencias() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fiscal-pendencias'], queryFn: () => api<{ produtosSemNcm: number; exemplos: { referencia: string; descricao: string }[]; ncmsMaisUsados: { ncm: string; n: number }[]; empresasSemCnpj: string[] }>('/fiscal/pendencias') });
  const [ncm, setNcm] = useState('');
  const lote = useMutation({ mutationFn: () => api<{ atualizados: number }>('/fiscal/ncm-em-lote', { corpo: { ncm } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['fiscal-pendencias'] }) });
  const p = q.data;
  if (!p || (!p.produtosSemNcm && !p.empresasSemCnpj.length && !lote.data)) return null;
  return (
    <div className="cartao" style={{ marginBottom: 14, borderColor: 'var(--dourado)' }}>
      {lote.data && <div className="aviso ok" style={{ marginBottom: 8 }}>NCM preenchido em {lote.data.atualizados} peça(s).</div>}
      {p.empresasSemCnpj.length > 0 && <p style={{ marginTop: 0 }}><b>Empresa sem CNPJ:</b> {p.empresasSemCnpj.join(', ')}. Preencha em Configurações › Empresas.</p>}
      {p.produtosSemNcm > 0 && (
        <>
          <p style={{ marginTop: 0 }}><b>{p.produtosSemNcm.toLocaleString('pt-BR')} peça(s) ativa(s) sem NCM</b>: a nota dessas peças é recusada. Ex.: {p.exemplos.map((e) => `${e.referencia} ${e.descricao}`).join(' · ')}</p>
          {p.ncmsMaisUsados.length > 0 && <p className="muted" style={{ fontSize: 13 }}>NCM mais usado nas outras peças: {p.ncmsMaisUsados.map((x) => `${x.ncm} (${x.n})`).join(', ')}</p>}
          {pode('configuracoes', 'editar') && (
            <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input placeholder="NCM (8 números) confirmado pelo contador" inputMode="numeric" value={ncm} onChange={(e) => setNcm(e.target.value)} style={{ maxWidth: 280 }} />
              <button className="botao" disabled={ncm.replace(/\D/g, '').length !== 8 || lote.isPending} onClick={() => lote.mutate()}>{lote.isPending ? 'Preenchendo…' : 'Preencher nas peças sem NCM'}</button>
              <span className="muted" style={{ fontSize: 12 }}>Só muda as peças que estão sem NCM. Confirme o código com o contador antes.</span>
            </div>
          )}
          {lote.error && <Erro erro={lote.error} />}
        </>
      )}
    </div>
  );
}
