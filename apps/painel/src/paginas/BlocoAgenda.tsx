import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { FormCompromisso, type Compromisso, type DadosForm } from './Agenda';
import './agenda.css';

const quando = (d: string) => new Date(d).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const SIT: Record<string, string> = { marcado: '', confirmado: '✓ confirmado', realizado: 'realizado', faltou: 'não compareceu', cancelado: 'cancelado' };

/** Compromissos de um card do CRM ou de uma revendedora, com o botão para marcar outro. */
export function BlocoAgenda({ filtro, inicial, titulo = 'Agenda' }: { filtro: { leadId?: string; pessoaId?: string }; inicial: Partial<DadosForm>; titulo?: string }) {
  const [novo, setNovo] = useState(false);
  const q = useQuery({
    queryKey: ['agenda', 'de', filtro.leadId ?? filtro.pessoaId],
    queryFn: () => api<Compromisso[]>(`/agenda?de=${new Date(Date.now() - 60 * 86_400_000).toISOString()}&ate=${new Date(Date.now() + 90 * 86_400_000).toISOString()}&${filtro.leadId ? `leadId=${filtro.leadId}` : `pessoaId=${filtro.pessoaId}`}`),
    enabled: pode('agenda', 'ver'),
  });
  if (!pode('agenda', 'ver')) return null;
  const lista = (q.data ?? []).slice().sort((a, b) => b.inicio.localeCompare(a.inicio)).slice(0, 6);
  return (
    <div className="bloco">
      <h3>{titulo}</h3>
      {lista.map((c) => (
        <div key={c.id} className="par" style={{ opacity: ['cancelado', 'faltou', 'realizado'].includes(c.status) ? 0.6 : 1 }}>
          <span style={{ textTransform: 'capitalize' }}>{quando(c.inicio)}</span>
          <span>
            <Link to="/agenda">{c.titulo}</Link>
            {SIT[c.status] && <span className="muted" style={{ fontSize: 12 }}> · {SIT[c.status]}</span>}
            {c.online && c.link && c.status !== 'cancelado' && <> · <a href={c.link} target="_blank" rel="noreferrer">chamada</a></>}
          </span>
        </div>
      ))}
      {!lista.length && !novo && <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>Nada marcado.</p>}
      {pode('agenda', 'criar') && !novo && <button className="botao claro pequeno" style={{ marginTop: 6, width: '100%' }} onClick={() => setNovo(true)}>Agendar</button>}
      {novo && <div style={{ marginTop: 8 }}><FormCompromisso estreito inicial={inicial} fechar={() => setNovo(false)} /></div>}
    </div>
  );
}
