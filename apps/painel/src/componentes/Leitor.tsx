import { useRef, useState } from 'react';
import { api, ErroApi } from '../api';
import { reais } from '../formato';
import { BuscaPeca, type PecaSugerida } from './BuscaPeca';
import { FotoPeca, LinhaFiltro, useFiltroColunas } from './Peca';

export interface ItemLido {
  produtoId: string;
  precoAtacado?: number | null;
  codigoBarras: string;
  referencia: string;
  descricao: string;
  foto?: string | null;
  preco: number;
  custo: number;
  quantidade: number;
}

const COLUNAS = { codigo: (i: ItemLido) => `${i.codigoBarras} ${i.referencia}`, descricao: (i: ItemLido) => i.descricao };

/**
 * Campo do leitor de código de barras: a peça é bipada (o leitor "digita" o código e aperta Enter)
 * e entra na lista. Bipar o mesmo código de novo soma a quantidade.
 */
export function Leitor({ itens, mudar, editavelQtd = true, usarAtacado = false, localId, opcoes }: { itens: ItemLido[]; mudar: (i: ItemLido[]) => void; editavelQtd?: boolean; usarAtacado?: boolean; /** Procura pela descrição só o que tem saldo neste local. */ localId?: string; /** Procura pela descrição só nesta lista (ex.: peças da maleta). */ opcoes?: PecaSugerida[] }) {
  const precoDe = (i: ItemLido) => (usarAtacado ? i.precoAtacado ?? i.preco : i.preco);
  const [erro, setErro] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const tabela = useFiltroColunas(itens, COLUNAS);

  async function ler(c: string) {
    if (!c) return;
    setErro(null);
    try {
      const p = await api<{ id: string; codigoBarras: string; referencia: string; descricao: string; preco: number; precoAtacado: number | null; custo: number; ativo: boolean; fotos?: string[] | null }>(`/produtos/codigo/${encodeURIComponent(c)}`);
      if (!p.ativo) throw new Error(`${p.descricao} está inativo.`);
      const existe = itens.find((i) => i.produtoId === p.id);
      mudar(existe ? itens.map((i) => (i.produtoId === p.id ? { ...i, quantidade: i.quantidade + 1 } : i)) : [{ produtoId: p.id, codigoBarras: p.codigoBarras, referencia: p.referencia, descricao: p.descricao, foto: p.fotos?.[0] ?? null, preco: p.preco, precoAtacado: p.precoAtacado, custo: p.custo, quantidade: 1 }, ...itens]);
      setUltimo(p.descricao);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.dados.mensagem ?? 'Erro' : (e as Error).message);
    } finally {
      ref.current?.focus();
    }
  }

  const total = itens.reduce((a, i) => a + precoDe(i) * i.quantidade, 0);
  const pecas = itens.reduce((a, i) => a + i.quantidade, 0);

  return (
    <div className="coluna">
      <BuscaPeca entradaRef={ref} aoCodigo={ler} aoEscolher={(p) => ler(p.codigoBarras)} localId={localId} opcoes={opcoes} />
      {erro && <div className="aviso erro">{erro}</div>}
      {!erro && ultimo && <div className="muted">Última peça: <b>{ultimo}</b></div>}
      {itens.length > 0 && (
        <table className="tabela">
          <thead>
            <tr><th></th><th>Código</th><th>Ref.</th><th>Descrição</th><th className="num">Preço</th><th className="num">Qtd.</th><th className="num">Total</th><th></th></tr>
            {itens.length > 1 && <LinhaFiltro celulas={[null, 'codigo', null, 'descricao', null, null, null, null]} filtro={tabela.filtro} setFiltro={tabela.setFiltro} />}
          </thead>
          <tbody>
            {tabela.filtrados.map((i) => (
              <tr key={i.produtoId}>
                <td><FotoPeca src={i.foto} alt={i.descricao} /></td>
                <td className="muted">{i.codigoBarras}</td>
                <td>{i.referencia}</td>
                <td>{i.descricao}</td>
                <td className="num">{reais(precoDe(i))}</td>
                <td className="num">
                  {editavelQtd ? <input type="number" min={1} value={i.quantidade} onChange={(e) => mudar(itens.map((x) => (x.produtoId === i.produtoId ? { ...x, quantidade: Math.max(1, Number(e.target.value) || 1) } : x)))} /> : i.quantidade}
                </td>
                <td className="num">{reais(precoDe(i) * i.quantidade)}</td>
                <td><button type="button" className="botao perigo pequeno" onClick={() => mudar(itens.filter((x) => x.produtoId !== i.produtoId))}>Tirar</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={5}>Total{tabela.ativo ? ` (todas as ${itens.length} linhas, não só as filtradas)` : ''}</td><td className="num">{pecas}</td><td className="num">{reais(total)}</td><td></td></tr></tfoot>
        </table>
      )}
    </div>
  );
}
