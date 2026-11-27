import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { data, reais } from '../formato';
import { Erro } from './ui';
import { usarCanais } from '../paginas/crm/comum';

const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

/** Antes de emitir: confere (e muda, se quiser) a data de vencimento do boleto ou Pix. */
export function EmitirCobranca({ titulo, tipo, aoEmitir, fechar }: { titulo: { id: string; vencimento: string; valor: number }; tipo: 'BOLETO' | 'PIX'; aoEmitir: (r: any) => void; fechar: () => void }) {
  const qc = useQueryClient();
  const [venc, setVenc] = useState(titulo.vencimento < hoje() ? hoje() : titulo.vencimento);
  const emitir = useMutation({
    mutationFn: () => api<any>(`/financeiro/titulos/${titulo.id}/cobranca`, { corpo: { tipo, vencimento: venc } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['titulos'] });
      qc.invalidateQueries({ queryKey: ['pessoa'] });
      aoEmitir(r);
    },
  });
  return (
    <form className="flex" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); emitir.mutate(); }}>
      <label style={{ fontSize: 12 }}>
        Vencimento do {tipo === 'PIX' ? 'Pix' : 'boleto'}
        <br />
        <input type="date" required min={hoje()} value={venc} onChange={(e) => setVenc(e.target.value)} />
      </label>
      <button className="botao pequeno" disabled={emitir.isPending || !venc}>{emitir.isPending ? 'Emitindo…' : `Emitir ${reais(titulo.valor)}`}</button>
      <button type="button" className="botao claro pequeno" onClick={fechar}>Voltar</button>
      {emitir.error && <div style={{ flexBasis: '100%' }}><Erro erro={emitir.error} /></div>}
    </form>
  );
}

/** Abre a conversa no WhatsApp com a pessoa, com o link já escrito na caixa (você confere e aperta Enviar). */
export function ConversaCobranca({ pessoaId, url, valor, vencimento, tipo }: { pessoaId: string; url: string; valor: number; vencimento: string; tipo?: string | null }) {
  const navegar = useNavigate();
  const canais = usarCanais();
  const ativos = (canais.data ?? []).filter((c: any) => c.ativo !== false && !c.excluidoEm);
  const [canalId, setCanalId] = useState('');
  const pessoa = useQuery({ queryKey: ['pessoa', pessoaId], queryFn: () => api<Record<string, any>>(`/pessoas/${pessoaId}`) });
  const escolhido = canalId || ativos.find((c: any) => c.tipo !== 'oficial')?.id || ativos[0]?.id || '';
  const abrir = useMutation({
    mutationFn: () => api<{ id: string }>('/crm/conversas/nova', { corpo: { canalId: escolhido, telefone: pessoa.data!.telefone1, nome: pessoa.data!.nome } }),
    onSuccess: (r) => {
      const nome = String(pessoa.data!.nome ?? '').split(' ')[0];
      const texto = `Olá, ${nome}! Segue o link ${tipo === 'PIX' ? 'do Pix' : 'do boleto'} de ${reais(valor)}, com vencimento em ${data(vencimento)}:\n${url}`;
      navegar(`/crm?aba=conversas&conversa=${r.id}&texto=${encodeURIComponent(texto)}`);
    },
  });
  if (!pode('crm', 'editar')) return null;
  if (pessoa.data && !pessoa.data.telefone1) return <span className="muted" style={{ fontSize: 12 }}>Sem telefone no cadastro para abrir conversa.</span>;
  return (
    <span className="flex" style={{ gap: 6, flexWrap: 'wrap', display: 'inline-flex' }}>
      {ativos.length > 1 && (
        <select aria-label="Enviar pelo número" value={escolhido} onChange={(e) => setCanalId(e.target.value)} style={{ maxWidth: 180 }}>
          {ativos.map((c: any) => <option key={c.id} value={c.id}>{c.nome}{c.tipo === 'oficial' ? ' (oficial)' : ''}</option>)}
        </select>
      )}
      <button type="button" className="botao pequeno" disabled={!escolhido || !pessoa.data || abrir.isPending} onClick={() => abrir.mutate()}>{abrir.isPending ? 'Abrindo…' : 'Abrir conversa e enviar link'}</button>
      {abrir.error && <Erro erro={abrir.error} />}
    </span>
  );
}

/** Boletos e Pix da pessoa, com o link e a situação; "Ver situação agora" pergunta ao Asaas. */
export function BoletosPessoa({ pessoaId, titulos }: { pessoaId: string; titulos: any[] }) {
  const lista = (titulos ?? []).filter((t) => t.cobrancaUrl);
  const [agora, setAgora] = useState<Record<string, { texto: string; situacao: string } | 'carregando' | { erro: string }>>({});
  const [conversa, setConversa] = useState<string | null>(null);
  if (!lista.length) return null;
  const situacaoLocal = (t: any) => {
    if (t.status === 'pago') return { texto: `Pago ${data(t.pagoEm)}`, cls: 'ok' };
    if (t.status === 'cancelado') return { texto: 'Cancelado', cls: 'neutra' };
    if (t.status === 'renegociado') return { texto: 'Renegociado', cls: 'neutra' };
    if (t.status === 'protestado') return { texto: 'Protestado', cls: 'erro' };
    const venc = t.cobrancaVencimento ?? t.vencimento;
    return venc < hoje() ? { texto: 'Vencido', cls: 'erro' } : { texto: 'Aguardando pagamento', cls: 'alerta' };
  };
  const conferir = async (id: string) => {
    setAgora((a) => ({ ...a, [id]: 'carregando' }));
    try {
      const r = await api<{ texto: string; situacao: string }>(`/financeiro/titulos/${id}/cobranca`);
      setAgora((a) => ({ ...a, [id]: r }));
    } catch (e) {
      setAgora((a) => ({ ...a, [id]: { erro: (e as Error).message } }));
    }
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="secao">Boletos e Pix</div>
      <table className="tabela">
        <thead><tr><th>Descrição</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          {lista.map((t) => {
            const s = situacaoLocal(t);
            const a = agora[t.id];
            return (
              <tr key={t.id}>
                <td>{t.descricao}</td>
                <td>{data(t.cobrancaVencimento ?? t.vencimento)}</td>
                <td className="num">{reais(t.cobrancaValor ?? t.valor)}</td>
                <td>
                  <span className={`etiqueta ${s.cls}`}>{s.texto}</span>
                  {a === 'carregando' ? <span className="muted"> conferindo…</span> : a && 'erro' in a ? <span className="muted"> {a.erro}</span> : a ? <span className="muted" style={{ fontSize: 12 }}> · No Asaas agora: <b>{a.texto}</b></span> : null}
                </td>
                <td>
                  <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <a className="botao claro pequeno" href={t.cobrancaUrl} target="_blank" rel="noreferrer">{t.cobrancaTipo === 'PIX' ? 'Abrir Pix' : 'Abrir boleto'}</a>
                    {pode('financeiro', 'ver') && <button type="button" className="botao claro pequeno" onClick={() => conferir(t.id)}>Ver situação agora</button>}
                    {['aberto', 'protestado'].includes(t.status) && (conversa === t.id ? <ConversaCobranca pessoaId={pessoaId} url={t.cobrancaUrl} valor={t.cobrancaValor ?? t.valor} vencimento={t.cobrancaVencimento ?? t.vencimento} tipo={t.cobrancaTipo} /> : pode('crm', 'editar') && <button type="button" className="botao claro pequeno" onClick={() => setConversa(t.id)}>Enviar pelo WhatsApp</button>)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
