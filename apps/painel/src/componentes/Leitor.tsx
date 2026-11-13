import { useRef, useState } from 'react';
import { api, ErroApi } from '../api';
import { reais } from '../formato';

export interface ItemLido {
  produtoId: string;
  codigoBarras: string;
  referencia: string;
  descricao: string;
  preco: number;
  custo: number;
  quantidade: number;
}

/**
 * Campo do leitor de código de barras: a peça é bipada (o leitor "digita" o código e aperta Enter)
 * e entra na lista. Bipar o mesmo código de novo soma a quantidade.
 */
export function Leitor({ itens, mudar, editavelQtd = true }: { itens: ItemLido[]; mudar: (i: ItemLido[]) => void; editavelQtd?: boolean }) {
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  async function ler() {
    const c = codigo.trim();
    if (!c) return;
    setCodigo('');
    setErro(null);
    try {
      const p = await api<{ id: string; codigoBarras: string; referencia: string; descricao: string; preco: number; custo: number; ativo: boolean }>(`/produtos/codigo/${encodeURIComponent(c)}`);
      if (!p.ativo) throw new Error(`${p.descricao} está inativo.`);
      const existe = itens.find((i) => i.produtoId === p.id);
      mudar(existe ? itens.map((i) => (i.produtoId === p.id ? { ...i, quantidade: i.quantidade + 1 } : i)) : [{ produtoId: p.id, codigoBarras: p.codigoBarras, referencia: p.referencia, descricao: p.descricao, preco: p.preco, custo: p.custo, quantidade: 1 }, ...itens]);
      setUltimo(p.descricao);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.dados.mensagem ?? 'Erro' : (e as Error).message);
    } finally {
      ref.current?.focus();
    }
  }

  const total = itens.reduce((a, i) => a + i.preco * i.quantidade, 0);
  const pecas = itens.reduce((a, i) => a + i.quantidade, 0);

  return (
    <div className="coluna">
      <div className="leitor">
        <input
          ref={ref}
          autoFocus
          placeholder="Bipe a peça ou digite o código e aperte Enter"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ler(); } }}
          aria-label="Código de barras"
        />
        <button type="button" className="botao" onClick={ler}>Incluir</button>
      </div>
      {erro && <div className="aviso erro">{erro}</div>}
      {!erro && ultimo && <div className="muted">Última peça: <b>{ultimo}</b></div>}
      {itens.length > 0 && (
        <table className="tabela">
          <thead><tr><th>Código</th><th>Ref.</th><th>Descrição</th><th className="num">Preço</th><th className="num">Qtd.</th><th className="num">Total</th><th></th></tr></thead>
          <tbody>
            {itens.map((i) => (
              <tr key={i.produtoId}>
                <td className="muted">{i.codigoBarras}</td>
                <td>{i.referencia}</td>
                <td>{i.descricao}</td>
                <td className="num">{reais(i.preco)}</td>
                <td className="num">
                  {editavelQtd ? <input type="number" min={1} value={i.quantidade} onChange={(e) => mudar(itens.map((x) => (x.produtoId === i.produtoId ? { ...x, quantidade: Math.max(1, Number(e.target.value) || 1) } : x)))} /> : i.quantidade}
                </td>
                <td className="num">{reais(i.preco * i.quantidade)}</td>
                <td><button type="button" className="botao perigo pequeno" onClick={() => mudar(itens.filter((x) => x.produtoId !== i.produtoId))}>Tirar</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total</td><td className="num">{pecas}</td><td className="num">{reais(total)}</td><td></td></tr></tfoot>
        </table>
      )}
    </div>
  );
}
