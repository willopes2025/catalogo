import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../api';
import { centavosParaTexto, paraCentavos, reais } from '../formato';
import { Erro, Topo } from '../componentes/ui';

interface Nivel { id: string; nome: string; ordem: number; metaMensal: number; comissaoAvistaPb: number | null; comissaoPrazoPb: number | null }
const pctParaTexto = (pb: number | null) => (pb == null ? '' : String(pb / 100).replace('.', ','));
const textoParaPb = (t: string) => (t.trim() === '' ? null : Math.round(Number(t.replace(',', '.')) * 100));

export function Niveis() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['niveis'], queryFn: () => api<Nivel[]>('/niveis') });
  const regras = useQuery({ queryKey: ['regras'], queryFn: () => api<any>('/configuracoes/regras-consignado') });
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({});
  const salvar = useMutation({
    mutationFn: ({ id, v }: { id: string | null; v: Record<string, string> }) => {
      const corpo = { nome: v.nome, ordem: Number(v.ordem) || 0, metaMensal: paraCentavos(v.metaMensal || '0'), comissaoAvistaPb: textoParaPb(v.comissaoAvistaPb ?? ''), comissaoPrazoPb: textoParaPb(v.comissaoPrazoPb ?? '') };
      return id ? api(`/niveis/${id}`, { metodo: 'PATCH', corpo }) : api('/niveis', { corpo });
    },
    onSuccess: () => { setEdit({}); qc.invalidateQueries({ queryKey: ['niveis'] }); },
  });
  const linha = (n: Nivel | null) => {
    const chave = n?.id ?? 'novo';
    const v = edit[chave] ?? (n ? { nome: n.nome, ordem: String(n.ordem), metaMensal: centavosParaTexto(n.metaMensal), comissaoAvistaPb: pctParaTexto(n.comissaoAvistaPb), comissaoPrazoPb: pctParaTexto(n.comissaoPrazoPb) } : { nome: '', ordem: '', metaMensal: '', comissaoAvistaPb: '', comissaoPrazoPb: '' });
    const mudou = !!edit[chave];
    const set = (k: string) => (e: { target: { value: string } }) => setEdit({ ...edit, [chave]: { ...v, [k]: e.target.value } });
    const editavel = pode('rede', n ? 'editar' : 'criar');
    return (
      <tr key={chave}>
        <td><input value={v.ordem} onChange={set('ordem')} style={{ width: 60 }} disabled={!editavel} /></td>
        <td><input value={v.nome} onChange={set('nome')} placeholder={n ? '' : 'Novo nível'} disabled={!editavel} /></td>
        <td><input value={v.metaMensal} onChange={set('metaMensal')} inputMode="decimal" disabled={!editavel} /></td>
        <td><input value={v.comissaoAvistaPb} onChange={set('comissaoAvistaPb')} placeholder={`padrão ${pctParaTexto(regras.data?.comissaoAvistaPb ?? null)}`} disabled={!editavel} /></td>
        <td><input value={v.comissaoPrazoPb} onChange={set('comissaoPrazoPb')} placeholder={`padrão ${pctParaTexto(regras.data?.comissaoPrazoPb ?? null)}`} disabled={!editavel} /></td>
        <td>{editavel && <button className="botao pequeno" disabled={!mudou || !v.nome || salvar.isPending} onClick={() => salvar.mutate({ id: n?.id ?? null, v })}>{n ? 'Salvar' : 'Incluir'}</button>}</td>
      </tr>
    );
  };
  return (
    <>
      <Topo eb="Rede" titulo="Níveis e metas" sub="A comissão do nível substitui a comissão padrão das Configurações. Deixe em branco para usar a padrão." />
      {salvar.error && <Erro erro={salvar.error} />}
      <table className="tabela">
        <thead><tr><th>Ordem</th><th>Nível</th><th>Meta mensal (R$)</th><th>Comissão à vista (%)</th><th>Comissão a prazo (%)</th><th></th></tr></thead>
        <tbody>{q.data?.map(linha)}{linha(null)}</tbody>
      </table>
      <p className="muted" style={{ marginTop: 10 }}>Metas atuais: {q.data?.map((n) => `${n.nome} ${reais(n.metaMensal)}`).join(' · ')}</p>
    </>
  );
}
