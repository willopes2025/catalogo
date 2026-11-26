import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api } from '../api';
import { reais } from '../formato';
import { casa, FotoPeca } from './Peca';

export interface PecaSugerida { produtoId: string; codigoBarras: string; referencia: string; descricao: string; foto?: string | null; preco?: number; categoria?: string | null; quantidade?: number | null }

/** Parece código de barras/referência (sem espaço e com algum número), e não uma descrição. */
const pareceCodigo = (t: string) => !/\s/.test(t.trim()) && /\d/.test(t);

/**
 * Campo único para bipar a peça OU procurar pela descrição (anel, brinco ouro…), para peça sem etiqueta.
 * Bipou (código + Enter): `aoCodigo`. Digitou palavras: mostra as peças com foto para escolher (`aoEscolher`).
 * `opcoes` limita às peças de uma lista (ex.: as da maleta); sem ela, procura no cadastro (só as com saldo no `localId`, se vier).
 */
export function BuscaPeca({
  aoCodigo,
  aoEscolher,
  opcoes,
  localId,
  placeholder = 'Bipe a peça ou digite o nome (ex.: anel ouro)',
  botao = 'Incluir',
  entradaRef,
  depois,
}: {
  aoCodigo: (codigo: string) => void;
  aoEscolher: (p: PecaSugerida) => void;
  opcoes?: PecaSugerida[];
  localId?: string;
  placeholder?: string;
  botao?: string;
  entradaRef?: RefObject<HTMLInputElement>;
  depois?: ReactNode;
}) {
  const [texto, setTexto] = useState('');
  const [lista, setLista] = useState<PecaSugerida[]>([]);
  const [ativa, setAtiva] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const proprioRef = useRef<HTMLInputElement>(null);
  const ref = entradaRef ?? proprioRef;
  const termo = texto.trim();
  const procurar = termo.length >= 2 && !pareceCodigo(termo);

  useEffect(() => {
    if (!procurar) return setLista([]);
    if (opcoes) {
      setLista(opcoes.filter((o) => casa(`${o.descricao} ${o.referencia} ${o.codigoBarras} ${o.categoria ?? ''}`, termo)).slice(0, 30));
      setAtiva(0);
      return;
    }
    let vivo = true;
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await api<{ itens: any[] }>(`/produtos?${new URLSearchParams({ busca: termo, ...(localId ? { localId, comSaldo: '1' } : {}) })}`);
        if (vivo) {
          setLista(r.itens.slice(0, 30).map((p) => ({ produtoId: p.id, codigoBarras: p.codigoBarras, referencia: p.referencia, descricao: p.descricao, foto: p.foto, preco: p.preco, categoria: p.categoria, quantidade: localId ? p.saldoLocal : p.estoque })));
          setAtiva(0);
        }
      } catch {
        if (vivo) setLista([]);
      } finally {
        if (vivo) setBuscando(false);
      }
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [termo, procurar, opcoes, localId]);

  const escolher = (p: PecaSugerida) => {
    setTexto('');
    setLista([]);
    aoEscolher(p);
    ref.current?.focus();
  };
  const confirmar = () => {
    if (procurar && lista[ativa]) return escolher(lista[ativa]);
    if (!termo) return;
    setTexto('');
    aoCodigo(termo);
    ref.current?.focus();
  };

  return (
    <div className="busca-peca">
      <div className="leitor">
        <input
          ref={ref}
          autoFocus
          placeholder={placeholder}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirmar(); }
            else if (e.key === 'ArrowDown' && lista.length) { e.preventDefault(); setAtiva((a) => Math.min(lista.length - 1, a + 1)); }
            else if (e.key === 'ArrowUp' && lista.length) { e.preventDefault(); setAtiva((a) => Math.max(0, a - 1)); }
            else if (e.key === 'Escape') setTexto('');
          }}
          aria-label="Código de barras ou nome da peça"
          aria-autocomplete="list"
        />
        <button type="button" className="botao" onClick={confirmar}>{botao}</button>
      </div>
      {procurar && (lista.length > 0 || !buscando) && (
        <div className="sugestoes" role="listbox">
          {lista.map((p, i) => (
            <div key={p.produtoId} role="option" aria-selected={i === ativa} className={`sugestao ${i === ativa ? 'ativa' : ''}`} onMouseEnter={() => setAtiva(i)} onClick={() => escolher(p)}>
              <FotoPeca src={p.foto} alt={p.descricao} tamanho={44} />
              <div className="info">
                <b>{p.descricao}</b>
                <small>{p.referencia} · {p.codigoBarras}{p.categoria ? ` · ${p.categoria}` : ''}</small>
              </div>
              <div style={{ textAlign: 'right', fontSize: 13 }}>
                {p.preco !== undefined && <div>{reais(p.preco)}</div>}
                {p.quantidade !== undefined && p.quantidade !== null && <small className="muted">{p.quantidade} {opcoes ? 'na lista' : localId ? 'aqui' : 'em estoque'}</small>}
              </div>
            </div>
          ))}
          {!lista.length && <div className="sugestao muted" style={{ cursor: 'default' }}>Nenhuma peça com “{termo}”{localId ? ' com saldo neste local' : opcoes ? ' nesta lista' : ''}.</div>}
        </div>
      )}
      {depois}
    </div>
  );
}
