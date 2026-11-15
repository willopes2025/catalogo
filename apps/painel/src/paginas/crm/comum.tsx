import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, lerSessao } from '../../api';

export interface Etapa { id: string; nome: string; cor: string; ordem: number; tipo: 'aberta' | 'ganho' | 'perdido'; chave: string | null; leads?: number; valor?: number }
export interface Funil { id: string; nome: string; tipo: string; ordem: number; ativo: boolean; etapas: Etapa[] }
export interface Atendente { id: string; nome: string }
export interface Canal { id: string; nome: string; tipo: 'oficial' | 'qrcode'; numero: string | null; ativo: boolean; config?: Record<string, string>; webhook?: string; atendentes?: string[]; usuarioId?: string | null; funilEntradaId?: string | null }
export interface Template { id: string; canalId: string | null; nome: string; tipo: 'meta' | 'livre'; texto: string; status: string; variaveis: string[]; categoria: string | null; idioma: string }
export interface CampoDef { id: string; entidade: 'contato' | 'lead'; nome: string; tipo: string; opcoes: string[]; funilId: string | null; ordem: number }

export const usarFunis = () => useQuery({ queryKey: ['crm', 'funis'], queryFn: () => api<Funil[]>('/crm/funis') });
export const usarAtendentes = () => useQuery({ queryKey: ['crm', 'atendentes'], queryFn: () => api<Atendente[]>('/crm/atendentes'), staleTime: 60_000 });
export const usarCanais = () => useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<Canal[]>('/crm/canais') });
export const usarCampos = () => useQuery({ queryKey: ['crm', 'campos'], queryFn: () => api<CampoDef[]>('/crm/campos'), staleTime: 60_000 });
export const usarContadores = (ativo = true) => useQuery({ queryKey: ['crm', 'contadores'], queryFn: () => api<{ fila: number; minhas: number; naoLidas: number; tarefasVencidas: number; mencoes: number }>('/crm/contadores'), refetchInterval: 15_000, enabled: ativo });
export const meuId = () => lerSessao()?.usuario.id ?? '';

export const iniciais = (n?: string | null) => (n ?? '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
export const telefoneBonito = (t?: string | null) => {
  const d = (t ?? '').replace(/\D/g, '');
  const n = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return t ?? '';
};

/** "há 5 min", "há 2 h", "ontem"… */
export function ha(iso?: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return 'ontem';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** Re-renderiza a cada X segundos (para "há 5 min" andar sozinho). */
export function useRelogio(seg = 30) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), seg * 1000);
    return () => clearInterval(t);
  }, [seg]);
}

/** Mídia de conversa: só com login, então baixa com o token e mostra por um link local. */
export function useMidia(nome?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!nome) return;
    let solto: string | null = null;
    const s = lerSessao();
    fetch(`/api/crm/midia/${nome}`, { headers: { authorization: `Bearer ${s?.token ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) {
          solto = URL.createObjectURL(b);
          setUrl(solto);
        }
      })
      .catch(() => undefined);
    return () => {
      if (solto) URL.revokeObjectURL(solto);
    };
  }, [nome]);
  return url;
}

/** Valor de campo personalizado, com o controle certo para o tipo. */
export function ValorCampo({ def, valor, mudar, desativado }: { def: CampoDef; valor: string; mudar: (v: string) => void; desativado?: boolean }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  const salvar = () => v !== valor && mudar(v);
  if (def.tipo === 'lista')
    return (
      <select value={v} disabled={desativado} onChange={(e) => { setV(e.target.value); mudar(e.target.value); }}>
        <option value="">—</option>
        {def.opcoes.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  if (def.tipo === 'sim_nao')
    return (
      <select value={v} disabled={desativado} onChange={(e) => { setV(e.target.value); mudar(e.target.value); }}>
        <option value="">—</option><option>Sim</option><option>Não</option>
      </select>
    );
  const tipo = { data: 'date', numero: 'number', email: 'email', url: 'url', telefone: 'tel' }[def.tipo] ?? 'text';
  return <input type={tipo} value={v} disabled={desativado} onChange={(e) => setV(e.target.value)} onBlur={salvar} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} placeholder="—" />;
}

/** Liga pelo softphone (o widget global escuta este evento). */
export function ligar(numero: string, leadId?: string | null, nome?: string) {
  window.dispatchEvent(new CustomEvent('aritana:ligar', { detail: { numero, leadId, nome } }));
}
