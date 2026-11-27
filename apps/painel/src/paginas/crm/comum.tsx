import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, lerSessao } from '../../api';
import { paraCentavos, reais } from '../../formato';
import { VARIAVEIS_CRM } from '../../componentes/TextoComVariaveis';

export interface Etapa { id: string; nome: string; cor: string; ordem: number; tipo: 'aberta' | 'ganho' | 'perdido'; chave: string | null; leads?: number; valor?: number }
export interface Funil { id: string; nome: string; tipo: string; ordem: number; ativo: boolean; etapas: Etapa[] }
export interface Atendente { id: string; nome: string }
export type TipoCanal = 'oficial' | 'qrcode' | 'evolution' | 'instagram';
export const NOME_TIPO_CANAL: Record<TipoCanal, string> = { instagram: 'Instagram (Direct)', oficial: 'Oficial (Meta)', evolution: 'QR code (Evolution)', qrcode: 'QR code (Z-API)' };
export interface Canal { id: string; nome: string; tipo: TipoCanal; numero: string | null; ativo: boolean; config?: Record<string, string>; webhook?: string; atendentes?: string[]; usuarioId?: string | null; funilEntradaId?: string | null; ultimoWebhookEm?: string | null; envioIntervaloMinS?: number; envioIntervaloMaxS?: number; envioInicio?: string; envioFim?: string; envioDias?: number[] }
export interface Template { id: string; canalId: string | null; nome: string; tipo: 'meta' | 'livre'; texto: string; status: string; variaveis: string[]; categoria: string | null; idioma: string }
export interface CampoDef { id: string; entidade: 'contato' | 'lead'; nome: string; tipo: string; opcoes: string[]; funilId: string | null; ordem: number; noQuadro?: boolean }

export const usarFunis = () => useQuery({ queryKey: ['crm', 'funis'], queryFn: () => api<Funil[]>('/crm/funis') });
export const usarAtendentes = () => useQuery({ queryKey: ['crm', 'atendentes'], queryFn: () => api<Atendente[]>('/crm/atendentes'), staleTime: 60_000 });
/** Todos os usuários ativos, marcando quem ainda não tem acesso ao CRM (para escolher o dono e quem atende por um número). */
export const usarUsuariosDoCrm = () => useQuery({ queryKey: ['crm', 'atendentes', 'todos'], queryFn: () => api<(Atendente & { grupo: string; semCrm: boolean })[]>('/crm/atendentes?todos=1'), staleTime: 60_000 });
export const usarCanais = () => useQuery({ queryKey: ['crm', 'canais'], queryFn: () => api<Canal[]>('/crm/canais') });
export const usarCampos = () => useQuery({ queryKey: ['crm', 'campos'], queryFn: () => api<CampoDef[]>('/crm/campos'), staleTime: 60_000 });
/** Variáveis das mensagens do CRM com os campos personalizados (para a lista que abre ao digitar "{"). */
export function usarVariaveisCrm() {
  const campos = usarCampos();
  return [...VARIAVEIS_CRM, ...(campos.data ?? []).map((c) => ({ nome: variavelDoCampo(c.nome), rotulo: `Campo: ${c.nome}` }))];
}
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
export const TIPOS_CAMPO: Record<string, string> = {
  texto: 'Texto curto', textao: 'Texto longo', numero: 'Número', moeda: 'Valor (R$)', data: 'Data', lista: 'Lista (uma opção)', multipla: 'Lista (várias opções)',
  telefone: 'Telefone', email: 'E-mail', url: 'Link', sim_nao: 'Sim/Não',
};
const SEP = '; ';

/** Nome do campo → variável de mensagem ({{campo_cidade}}). Igual ao servidor. */
export const variavelDoCampo = (nome: string) => 'campo_' + nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Valor para leitura rápida (quadro, painel da conversa). */
export function valorLegivel(def: Pick<CampoDef, 'tipo'>, v?: string | null) {
  if (!v) return '';
  if (def.tipo === 'data' && /^\d{4}-\d{2}-\d{2}/.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
  if (def.tipo === 'telefone') return telefoneBonito(v);
  if (def.tipo === 'multipla') return v.split(SEP).filter(Boolean).join(', ');
  return v;
}

export function ValorCampo({ def, valor, mudar, desativado }: { def: CampoDef; valor: string; mudar: (v: string) => void; desativado?: boolean }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  const salvar = (x = v) => x !== valor && mudar(x);
  if (def.tipo === 'lista')
    return (
      <select value={v} disabled={desativado} onChange={(e) => { setV(e.target.value); mudar(e.target.value); }}>
        <option value="">—</option>
        {def.opcoes.map((o) => <option key={o}>{o}</option>)}
        {v && !def.opcoes.includes(v) && <option>{v}</option>}
      </select>
    );
  if (def.tipo === 'sim_nao')
    return (
      <select value={v} disabled={desativado} onChange={(e) => { setV(e.target.value); mudar(e.target.value); }}>
        <option value="">—</option><option>Sim</option><option>Não</option>
      </select>
    );
  if (def.tipo === 'multipla') {
    const marcados = v ? v.split(SEP).filter(Boolean) : [];
    const todas = [...def.opcoes, ...marcados.filter((m) => !def.opcoes.includes(m))];
    return (
      <details className="multipla">
        <summary>{marcados.length ? marcados.join(', ') : '—'}</summary>
        <div>
          {todas.map((o) => (
            <label key={o} className="check">
              <input
                type="checkbox"
                disabled={desativado}
                checked={marcados.includes(o)}
                onChange={(e) => {
                  const novo = (e.target.checked ? [...marcados, o] : marcados.filter((m) => m !== o)).sort((a, b) => todas.indexOf(a) - todas.indexOf(b)).join(SEP);
                  setV(novo);
                  mudar(novo);
                }}
              />
              {o}
            </label>
          ))}
        </div>
      </details>
    );
  }
  if (def.tipo === 'textao')
    return <textarea rows={2} value={v} disabled={desativado} onChange={(e) => setV(e.target.value)} onBlur={() => salvar()} placeholder="—" />;
  if (def.tipo === 'moeda')
    return (
      <input
        inputMode="decimal"
        value={v}
        disabled={desativado}
        placeholder="R$ 0,00"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const x = v.trim() ? reais(paraCentavos(v)) : '';
          setV(x);
          salvar(x);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    );
  const tipo = { data: 'date', numero: 'number', email: 'email', url: 'url', telefone: 'tel' }[def.tipo] ?? 'text';
  return <input type={tipo} value={v} disabled={desativado} onChange={(e) => setV(e.target.value)} onBlur={() => salvar()} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} placeholder="—" />;
}

/** Criar um campo novo sem sair do card (ou da configuração). */
export function NovoCampo({ entidade, funilId, nomeInicial, aoCriar, cancelar }: { entidade: 'contato' | 'lead'; funilId?: string | null; nomeInicial?: string; aoCriar?: (c: CampoDef) => void; cancelar?: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ nome: nomeInicial ?? '', tipo: 'texto', opcoes: '', soEsteFunil: false, noQuadro: false });
  const lista = f.tipo === 'lista' || f.tipo === 'multipla';
  const criar = useMutation({
    mutationFn: () =>
      api<CampoDef>('/crm/campos', {
        corpo: { entidade, nome: f.nome.trim(), tipo: f.tipo, opcoes: lista ? f.opcoes.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) : [], funilId: entidade === 'lead' && f.soEsteFunil ? funilId : null, noQuadro: f.noQuadro },
      }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['crm', 'campos'] });
      setF({ nome: '', tipo: 'texto', opcoes: '', soEsteFunil: false, noQuadro: false });
      aoCriar?.(c);
    },
  });
  return (
    <div className="novo-campo">
      <div className="lin">
        <input autoFocus placeholder="Nome do campo (ex.: Tamanho do anel)" value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && cancelar?.()} />
        <select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{Object.entries(TIPOS_CAMPO).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select>
      </div>
      {lista && <input placeholder="Opções separadas por vírgula (ex.: 14, 16, 18, 20)" value={f.opcoes} onChange={(e) => setF({ ...f, opcoes: e.target.value })} />}
      <div className="lin" style={{ flexWrap: 'wrap', gap: 10 }}>
        {entidade === 'lead' && funilId && <label className="check"><input type="checkbox" checked={f.soEsteFunil} onChange={(e) => setF({ ...f, soEsteFunil: e.target.checked })} /> Só neste funil</label>}
        <label className="check"><input type="checkbox" checked={f.noQuadro} onChange={(e) => setF({ ...f, noQuadro: e.target.checked })} /> Mostrar no quadro</label>
      </div>
      {criar.error && <div style={{ color: 'var(--erro)', fontSize: 13 }}>{(criar.error as Error).message}</div>}
      <div className="lin">
        <button className="botao pequeno" disabled={!f.nome.trim() || (lista && !f.opcoes.trim()) || criar.isPending} onClick={() => criar.mutate()}>Criar campo</button>
        {cancelar && <button className="botao claro pequeno" onClick={cancelar}>Cancelar</button>}
      </div>
    </div>
  );
}

/** Liga pelo softphone (o widget global escuta este evento). */
export function ligar(numero: string, leadId?: string | null, nome?: string) {
  window.dispatchEvent(new CustomEvent('aritana:ligar', { detail: { numero, leadId, nome } }));
}
