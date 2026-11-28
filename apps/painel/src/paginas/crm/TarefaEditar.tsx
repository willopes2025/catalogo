import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api';
import { Erro } from '../../componentes/ui';
import { usarUsuariosDoCrm } from './comum';

/** Data no formato do campo datetime-local, no horário de Brasília. */
const paraCampo = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 16);

/** Botões ✏️ e 🗑 de uma tarefa (no card e na conversa), com a edição na própria linha. */
export function AcoesTarefa({ t, aoMudar }: { t: { id: string; titulo: string; venceEm: string; responsavelId?: string | null }; aoMudar: () => void }) {
  const [editando, setEditando] = useState(false);
  const [f, setF] = useState({ titulo: t.titulo, venceEm: paraCampo(t.venceEm), responsavelId: t.responsavelId ?? '' });
  const usuarios = usarUsuariosDoCrm();
  const salvar = useMutation({
    mutationFn: () => api(`/crm/tarefas/${t.id}`, { metodo: 'PATCH', corpo: { titulo: f.titulo.trim(), venceEm: `${f.venceEm}:00-03:00`, responsavelId: f.responsavelId || null } }),
    onSuccess: () => { setEditando(false); aoMudar(); },
  });
  const excluir = useMutation({ mutationFn: () => api(`/crm/tarefas/${t.id}`, { metodo: 'DELETE' }), onSuccess: aoMudar });
  const parar = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); };
  if (editando) {
    return (
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        <input value={f.titulo} maxLength={200} onChange={(e) => setF({ ...f, titulo: e.target.value })} aria-label="O que fazer" />
        <input type="datetime-local" value={f.venceEm} onChange={(e) => setF({ ...f, venceEm: e.target.value })} aria-label="Para quando" />
        <select value={f.responsavelId} onChange={(e) => setF({ ...f, responsavelId: e.target.value })} aria-label="Responsável">
          <option value="">Sem responsável</option>
          {usuarios.data?.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="botao pequeno" disabled={f.titulo.trim().length < 2 || !f.venceEm || salvar.isPending} onClick={(e) => { parar(e); salvar.mutate(); }}>Salvar</button>
          <button type="button" className="botao claro pequeno" onClick={(e) => { parar(e); setEditando(false); }}>Cancelar</button>
        </div>
        {salvar.error && <Erro erro={salvar.error} />}
      </div>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 2, marginLeft: 4 }}>
      <button type="button" className="botao claro pequeno" title="Editar tarefa" aria-label={`Editar a tarefa ${t.titulo}`} style={{ padding: '2px 6px' }} onClick={(e) => { parar(e); setF({ titulo: t.titulo, venceEm: paraCampo(t.venceEm), responsavelId: t.responsavelId ?? '' }); setEditando(true); }}>✏️</button>
      <button type="button" className="botao claro pequeno" title="Excluir tarefa" aria-label={`Excluir a tarefa ${t.titulo}`} style={{ padding: '2px 6px' }} disabled={excluir.isPending} onClick={(e) => { parar(e); if (window.confirm(`Excluir a tarefa "${t.titulo}"?`)) excluir.mutate(); }}>🗑</button>
      {excluir.error && <Erro erro={excluir.error} />}
    </span>
  );
}
