import { useState, type ReactNode } from 'react';
import { ErroApi } from '../api';

export function Topo({ eb, titulo, acoes, sub }: { eb?: string; titulo: string; acoes?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="topo">
      <div>
        {eb && <div className="eb">{eb}</div>}
        <h1>{titulo}</h1>
        {sub && <p className="muted" style={{ marginTop: 4 }}>{sub}</p>}
      </div>
      {acoes && <div className="acoes">{acoes}</div>}
    </div>
  );
}

export function Indicador({ rotulo, valor, detalhe, tipo }: { rotulo: string; valor: ReactNode; detalhe?: ReactNode; tipo?: 'destaque' | 'atencao' }) {
  return (
    <div className={`cartao indicador ${tipo ?? ''}`}>
      <div className="rotulo">{rotulo}</div>
      <div className="valor">{valor}</div>
      {detalhe && <div className="detalhe">{detalhe}</div>}
    </div>
  );
}

export function Abas<T extends string>({ abas, ativa, mudar }: { abas: [T, string][]; ativa: T; mudar: (a: T) => void }) {
  return (
    <div className="abas" role="tablist">
      {abas.map(([chave, nome]) => (
        <button key={chave} role="tab" aria-selected={ativa === chave} className={ativa === chave ? 'ativa' : ''} onClick={() => mudar(chave)}>
          {nome}
        </button>
      ))}
    </div>
  );
}

export function Erro({ erro }: { erro: unknown }) {
  if (!erro) return null;
  const e = erro instanceof ErroApi ? erro : null;
  return (
    <div className="aviso erro" role="alert">
      {e?.dados.mensagem ?? (erro as Error).message ?? 'Erro inesperado'}
      {e?.dados.motivos && (
        <ul>
          {e.dados.motivos.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Campo({ rotulo, erro, ajuda, children, className }: { rotulo: string; erro?: string; ajuda?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`campo ${className ?? ''}`}>
      <label>{rotulo}</label>
      {children}
      {erro ? <span className="erro-campo">{erro}</span> : ajuda ? <span className="ajuda">{ajuda}</span> : null}
    </div>
  );
}

export function Carregando() {
  return <div className="vazio">Carregando…</div>;
}

export function StatusMaleta({ status, diasAtraso }: { status: string; diasAtraso?: number }) {
  if (status === 'aberta' && diasAtraso && diasAtraso > 0) return <span className="etiqueta erro">{diasAtraso} dias de atraso</span>;
  const mapa: Record<string, [string, string]> = { aberta: ['ok', 'Aberta'], acertada: ['neutra', 'Acertada'], cancelada: ['neutra', 'Cancelada'] };
  const [c, t] = mapa[status] ?? ['neutra', status];
  return <span className={`etiqueta ${c}`}>{t}</span>;
}

export function StatusPessoa({ status, bloqueado }: { status: string; bloqueado?: boolean }) {
  if (bloqueado) return <span className="etiqueta erro">Bloqueada</span>;
  const mapa: Record<string, [string, string]> = { ativo: ['ok', 'Ativa'], triagem: ['alerta', 'Em triagem'], inativo: ['neutra', 'Inativa'], recusado: ['erro', 'Recusada'] };
  const [c, t] = mapa[status] ?? ['neutra', status];
  return <span className={`etiqueta ${c}`}>{t}</span>;
}

export function useConfirmar() {
  const [msg, setMsg] = useState<string | null>(null);
  return { msg, setMsg };
}
