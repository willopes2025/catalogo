import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { data, reais } from '../../formato';
import { Carregando, Erro } from '../../componentes/ui';

const ORIGEM: Record<string, string> = { asaas: 'Asaas', sicoob: 'Sicoob' };
const STATUS: Record<string, [string, string]> = { pendente: ['alerta', 'Sem baixa'], baixado: ['ok', 'Baixado'], ignorado: ['neutra', 'Ignorado'] };

/**
 * Pix que entraram no Asaas e no Sicoob. Com comprovante da IA e o mesmo valor, a baixa sai sozinha;
 * os outros ficam aqui com sugestões de título para baixar em um clique.
 */
export function PixRecebidos({ contas }: { contas: any[] }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pendente');
  const [dias, setDias] = useState(30);
  const q = useQuery({ queryKey: ['pix', status, dias], queryFn: () => api<any[]>(`/financeiro/pix?status=${status}&dias=${dias}`) });
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['pix'] }); qc.invalidateQueries({ queryKey: ['titulos'] }); };
  const [diasAsaas, setDiasAsaas] = useState(15);
  const asaas = useMutation({ mutationFn: () => api<{ lidos: number; novos: number; baixados: number }>('/financeiro/pix/buscar-asaas', { corpo: { dias: diasAsaas } }), onSuccess: atualizar });
  const [contaSicoob, setContaSicoob] = useState(contas.find((c) => /sicoob/i.test(c.nome))?.id ?? '');
  const ofx = useMutation({
    mutationFn: async (f: File) => api<{ lidos: number; novos: number; baixados: number }>('/financeiro/pix/importar-ofx', { corpo: { texto: await f.text(), contaId: contaSicoob || null } }),
    onSuccess: atualizar,
  });
  const [escolha, setEscolha] = useState<Record<string, string[]>>({});
  const baixar = useMutation({ mutationFn: (id: string) => api(`/financeiro/pix/${id}/baixar`, { corpo: { tituloIds: escolha[id] ?? [] } }), onSuccess: atualizar });
  const ignorar = useMutation({ mutationFn: (id: string) => api(`/financeiro/pix/${id}/ignorar`, { corpo: { motivo: 'Não é pagamento de título' } }), onSuccess: atualizar });
  const editar = pode('financeiro', 'editar');
  const resumo = (r?: { lidos: number; novos: number; baixados: number }) => r && `${r.lidos} Pix lido(s), ${r.novos} novo(s), ${r.baixados} baixado(s) sozinho(s) pelo comprovante da IA.`;
  return (
    <div className="coluna">
      <p className="muted" style={{ margin: 0 }}>
        Quando a cliente manda o comprovante no WhatsApp e o Pix aparece aqui com o mesmo valor, a IA dá a baixa (ou amortiza) sozinha. Os Pix sem baixa ficam nesta lista, com os títulos que podem ser deles.
      </p>
      {editar && (
        <div className="cartao flex" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="flex" style={{ gap: 6, alignItems: 'end' }}>
            <label style={{ fontSize: 12 }}>Asaas: últimos<br /><input type="number" min={1} max={90} value={diasAsaas} onChange={(e) => setDiasAsaas(Number(e.target.value) || 15)} style={{ width: 70 }} /> dias</label>
            <button className="botao claro" disabled={asaas.isPending} onClick={() => asaas.mutate()}>{asaas.isPending ? 'Buscando…' : 'Buscar Pix do Asaas'}</button>
          </div>
          <div className="flex" style={{ gap: 6, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12 }}>Conta do Sicoob<br />
              <select value={contaSicoob} onChange={(e) => setContaSicoob(e.target.value)} style={{ maxWidth: 200 }}>
                <option value="">Escolha…</option>
                {contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </label>
            <label className="botao claro" style={{ cursor: 'pointer' }}>
              {ofx.isPending ? 'Lendo…' : 'Importar extrato do Sicoob (OFX)'}
              <input type="file" accept=".ofx,.OFX,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) ofx.mutate(f); e.target.value = ''; }} />
            </label>
          </div>
          {(asaas.data || ofx.data) && <span className="muted" style={{ flexBasis: '100%' }}>{resumo(asaas.data ?? ofx.data)}</span>}
          {(asaas.error || ofx.error) && <div style={{ flexBasis: '100%' }}><Erro erro={asaas.error ?? ofx.error} /></div>}
        </div>
      )}
      <div className="busca">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
          <option value="pendente">Sem baixa</option>
          <option value="baixado">Baixados</option>
          <option value="ignorado">Ignorados</option>
          <option value="todos">Todos</option>
        </select>
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Período">
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={365}>Último ano</option>
        </select>
      </div>
      {(baixar.error || ignorar.error) && <Erro erro={baixar.error ?? ignorar.error} />}
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : !q.data!.length ? <div className="cartao vazio">Nenhum Pix nesta lista.</div> : (
        <table className="tabela">
          <thead><tr><th>Data</th><th>De quem</th><th className="num">Valor</th><th>Situação</th><th>Títulos</th></tr></thead>
          <tbody>
            {q.data!.map((p) => {
              const [cls, txt] = STATUS[p.status] ?? ['neutra', p.status];
              const sel = escolha[p.id] ?? [];
              return (
                <tr key={p.id}>
                  <td>{data(p.data)}<div className="muted" style={{ fontSize: 12 }}>{ORIGEM[p.origem] ?? p.origem}</div></td>
                  <td>{p.pagadorNome ?? '—'}{p.pessoa && <div className="muted" style={{ fontSize: 12 }}>Cadastro: {p.pessoa}</div>}{p.descricao && p.descricao !== p.pagadorNome && <div className="muted" style={{ fontSize: 12 }}>{p.descricao.slice(0, 80)}</div>}</td>
                  <td className="num"><b>{reais(p.valor)}</b></td>
                  <td><span className={`etiqueta ${cls}`}>{txt}</span>{p.observacao && <div className="muted" style={{ fontSize: 12 }}>{p.observacao}</div>}</td>
                  <td>
                    {p.status === 'pendente' && editar ? (
                      <div className="coluna" style={{ gap: 4 }}>
                        {p.sugestoes.length ? p.sugestoes.map((t: any) => (
                          <label key={t.id} className="check" style={{ fontSize: 13 }}>
                            <input type="checkbox" checked={sel.includes(t.id)} onChange={() => setEscolha((e) => ({ ...e, [p.id]: sel.includes(t.id) ? sel.filter((x) => x !== t.id) : [...sel, t.id] }))} />
                            {t.pessoa ?? 'Sem pessoa'} · {t.descricao.slice(0, 50)} · vence {data(t.vencimento)} · {reais(t.valor)} <span className="muted">({t.motivo})</span>
                          </label>
                        )) : <span className="muted" style={{ fontSize: 13 }}>Nenhum título com o mesmo CPF ou valor. Baixe pelo título em "A receber" ou ignore.</span>}
                        <div className="flex" style={{ gap: 6 }}>
                          {p.sugestoes.length > 0 && <button className="botao pequeno" disabled={!sel.length || baixar.isPending} onClick={() => baixar.mutate(p.id)}>Dar baixa{sel.length > 1 ? ` (${sel.length})` : ''}</button>}
                          <button className="botao claro pequeno" disabled={ignorar.isPending} onClick={() => ignorar.mutate(p.id)}>Ignorar</button>
                        </div>
                        {sel.length > 0 && <span className="muted" style={{ fontSize: 12 }}>Se o Pix for menor que o título, amortiza (o resto fica em aberto).</span>}
                      </div>
                    ) : <span className="muted">{p.tituloIds?.length ? `${p.tituloIds.length} título(s)` : '—'}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
