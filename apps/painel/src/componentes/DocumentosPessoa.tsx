import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { dataHora } from '../formato';
import { Erro } from './ui';

const TIPO: Record<string, string> = { contrato: 'Contrato', promissoria: 'Promissória', aditivo: 'Aditivo' };
const STATUS: Record<string, [string, string]> = { pendente: ['alerta', 'Aguardando assinatura'], assinado: ['ok', 'Assinado'], cancelado: ['neutra', 'Cancelado'], expirado: ['neutra', 'Expirado'] };

/** Aba Documentos da ficha: gerar contrato, mandar o link de assinatura e acompanhar. */
export function DocumentosPessoa({ pessoa }: { pessoa: any }) {
  const qc = useQueryClient();
  const [copiado, setCopiado] = useState<string | null>(null);
  const atualizar = () => qc.invalidateQueries({ queryKey: ['pessoa', pessoa.id] });
  const gerar = useMutation({ mutationFn: (tipo: string) => api('/documentos', { corpo: { pessoaId: pessoa.id, tipo } }), onSuccess: atualizar });
  const cancelar = useMutation({ mutationFn: (id: string) => api(`/documentos/${id}/cancelar`, { corpo: {} }), onSuccess: atualizar });
  const link = (token: string) => `${window.location.origin}/assinar/${token}`;
  const [enviado, setEnviado] = useState<Record<string, string>>({});
  const enviar = useMutation({
    mutationFn: ({ id, via }: { id: string; via: 'whatsapp' | 'email' }) => api<{ whatsapp?: string; email?: string }>(`/documentos/${id}/enviar`, { corpo: { whatsapp: via === 'whatsapp', email: via === 'email' } }),
    onSuccess: (r, v) => setEnviado((e) => ({ ...e, [v.id]: v.via === 'whatsapp' ? `WhatsApp: ${r.whatsapp}` : `E-mail: ${r.email}` })),
  });
  const editavel = pode('rede', 'editar');
  return (
    <div className="coluna">
      <div className="flex entre">
        <p className="muted">O contrato é assinado uma vez e vale para as próximas maletas. Na página de assinatura, a consultora pede o código pelo WhatsApp ou pelo e-mail do cadastro.</p>
        {editavel && <button className="botao" onClick={() => gerar.mutate('contrato')} disabled={gerar.isPending}>Gerar contrato</button>}
      </div>
      {(gerar.error || cancelar.error || enviar.error) && <Erro erro={gerar.error ?? cancelar.error ?? enviar.error} />}
      {pessoa.documentos?.length ? (
        <table className="tabela">
          <thead><tr><th>Documento</th><th>Gerado</th><th>Visto pela representante</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {pessoa.documentos.map((d: any) => {
              const [c, t] = STATUS[d.status] ?? ['neutra', d.status];
              return (
                <tr key={d.id}>
                  <td><b>{TIPO[d.tipo]}</b><div className="muted">{d.titulo}</div></td>
                  <td>{dataHora(d.criadoEm)}</td>
                  <td>{d.visualizadoEm ? dataHora(d.visualizadoEm) : '—'}</td>
                  <td><span className={`etiqueta ${c}`}>{t}</span>{d.assinadoEm && <div className="muted">{dataHora(d.assinadoEm)}</div>}</td>
                  <td>
                    <div className="flex" style={{ flexWrap: 'wrap', gap: 6 }}>
                      <a className="botao claro pequeno" href={`/imprimir/documento/${d.id}`} target="_blank" rel="noreferrer">Ver / imprimir</a>
                      {d.status === 'pendente' && (
                        <>
                          <button className="botao claro pequeno" onClick={async () => { try { await navigator.clipboard.writeText(link(d.token)); setCopiado(d.id); } catch { window.prompt('Copie o link:', link(d.token)); } }}>{copiado === d.id ? 'Copiado' : 'Copiar link'}</button>
                          {editavel && <button className="botao pequeno" disabled={enviar.isPending || !pessoa.telefone1} title={pessoa.telefone1 ? '' : 'Sem telefone no cadastro'} onClick={() => enviar.mutate({ id: d.id, via: 'whatsapp' })}>Enviar pelo WhatsApp</button>}
                          {editavel && pessoa.email && <button className="botao claro pequeno" disabled={enviar.isPending} onClick={() => enviar.mutate({ id: d.id, via: 'email' })}>Por e-mail</button>}
                          {enviado[d.id] && <span className="muted" style={{ fontSize: 12 }}>{enviado[d.id]}</span>}
                          {editavel && <button className="botao perigo pequeno" onClick={() => cancelar.mutate(d.id)}>Cancelar</button>}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="muted">Nenhum documento ainda. A promissória de cada maleta é gerada sozinha quando a maleta é criada.</p>}
    </div>
  );
}
