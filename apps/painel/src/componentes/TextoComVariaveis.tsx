import { useMemo, useRef, useState, type CSSProperties } from 'react';

export interface Variavel { nome: string; rotulo?: string }

const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Caixa de texto que ajuda com as variáveis: ao digitar "{" abre a lista; continuar digitando filtra
 * (pelo nome ou pela descrição); Enter, Tab ou clique coloca {{variavel}} (ou {variavel} no formato simples).
 */
export function TextoComVariaveis({
  value,
  onChange,
  variaveis,
  formato = 'duplo',
  linhas,
  umaLinha = false,
  placeholder,
  style,
  className,
  maxLength,
  id,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  variaveis: (Variavel | string)[];
  /** duplo = {{nome}} (CRM, avisos); simples = {nome} (régua de cobrança). */
  formato?: 'duplo' | 'simples';
  linhas?: number;
  umaLinha?: boolean;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
  maxLength?: number;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [busca, setBusca] = useState<{ inicio: number; termo: string } | null>(null);
  const [ativa, setAtiva] = useState(0);
  const lista = useMemo(() => variaveis.map((v) => (typeof v === 'string' ? { nome: v } : v)), [variaveis]);
  const opcoes = useMemo(() => {
    if (!busca) return [];
    const t = normal(busca.termo);
    const comeca = lista.filter((v) => normal(v.nome).startsWith(t) || normal(v.rotulo ?? '').startsWith(t));
    const contem = lista.filter((v) => !comeca.includes(v) && (normal(v.nome).includes(t) || normal(v.rotulo ?? '').includes(t)));
    return [...comeca, ...contem].slice(0, 12);
  }, [busca, lista]);

  // Olha o que está antes do cursor: "{", "{{" ou "{{pri" abrem a lista.
  const olhar = (texto: string, cursor: number) => {
    const antes = texto.slice(0, cursor);
    const m = (formato === 'duplo' ? /\{\{?([\p{L}\w]*)$/u : /\{([\p{L}\w]*)$/u).exec(antes);
    if (m && !/\}$/.test(antes)) {
      setBusca({ inicio: m.index, termo: m[1] });
      setAtiva(0);
    } else setBusca(null);
  };

  const escolher = (v: Variavel) => {
    const el = ref.current;
    if (!el || !busca) return;
    const cursor = el.selectionStart ?? value.length;
    const token = formato === 'duplo' ? `{{${v.nome}}}` : `{${v.nome}}`;
    // Se já tinha o fechamento logo depois (ex.: autocompletou "}}"), não duplica.
    let fim = cursor;
    while (value[fim] === '}' && fim - cursor < 2) fim++;
    const novo = value.slice(0, busca.inicio) + token + value.slice(fim);
    onChange(novo);
    setBusca(null);
    const pos = busca.inicio + token.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const comum = {
    ref,
    id,
    value,
    disabled,
    maxLength,
    placeholder,
    className,
    'aria-label': ariaLabel,
    'aria-autocomplete': 'list' as const,
    style: { width: '100%', ...style },
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      onChange(e.target.value);
      olhar(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    onClick: (e: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => olhar(value, (e.target as HTMLTextAreaElement).selectionStart ?? value.length),
    onBlur: () => setTimeout(() => setBusca(null), 150),
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!busca || !opcoes.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtiva((a) => (a + 1) % opcoes.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setAtiva((a) => (a - 1 + opcoes.length) % opcoes.length); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); escolher(opcoes[ativa]); }
      else if (e.key === 'Escape') { e.preventDefault(); setBusca(null); }
    },
  };

  return (
    <div className="texto-variaveis" style={{ position: 'relative', width: '100%' }}>
      {umaLinha ? <input {...comum} /> : <textarea rows={linhas ?? 3} {...comum} />}
      {busca && opcoes.length > 0 && (
        <div className="sugestoes-variaveis" role="listbox">
          <div className="muted" style={{ fontSize: 11, padding: '4px 10px' }}>Variáveis · ↑↓ e Enter para escolher</div>
          {opcoes.map((v, i) => (
            <div
              key={v.nome}
              role="option"
              aria-selected={i === ativa}
              className={`sugestao-variavel ${i === ativa ? 'ativa' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); escolher(v); }}
              onMouseEnter={() => setAtiva(i)}
            >
              <code>{formato === 'duplo' ? `{{${v.nome}}}` : `{${v.nome}}`}</code>
              {v.rotulo && <span className="muted">{v.rotulo}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Variáveis das mensagens do CRM (card/contato), mais os campos personalizados. */
export const VARIAVEIS_CRM: Variavel[] = [
  { nome: 'primeiro_nome', rotulo: 'Primeiro nome' },
  { nome: 'nome', rotulo: 'Nome completo' },
  { nome: 'telefone', rotulo: 'Telefone' },
  { nome: 'etapa', rotulo: 'Etapa do card' },
  { nome: 'funil', rotulo: 'Funil' },
];
