import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import { api } from '../api';
import { reais } from '../formato';
import { Carregando, Erro } from '../componentes/ui';
import { CHAVE_FILA } from './EstoqueExtra';

interface Item { codigoBarras: string; referencia: string; descricao: string; preco: number; quantidade: number }
interface Impressao { etiquetaLarguraMm: number; etiquetaAlturaMm: number; etiquetaColunas: number; etiquetaMostrarPreco: boolean; etiquetaMostrarRef: boolean; etiquetaTexto: string }

/** EAN-13 válido sai como EAN-13; qualquer outro código sai em Code 128. */
function formato(c: string) {
  if (!/^\d{13}$/.test(c)) return 'CODE128';
  const s = c.split('').map(Number);
  const soma = s.slice(0, 12).reduce((a, d, i) => a + d * (i % 2 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === s[12] ? 'EAN13' : 'CODE128';
}

function Barras({ codigo, alturaMm }: { codigo: string; alturaMm: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, codigo, { format: formato(codigo), displayValue: true, fontSize: 11, height: Math.max(18, alturaMm * 3.2), margin: 0, width: 1.4, textMargin: 1 });
    } catch {
      JsBarcode(ref.current, codigo, { format: 'CODE128', displayValue: true, fontSize: 11, height: Math.max(18, alturaMm * 3.2), margin: 0, width: 1.4 });
    }
  }, [codigo, alturaMm]);
  return <svg ref={ref} style={{ width: '100%', height: 'auto', maxHeight: '100%' }} />;
}

/** Folha de etiquetas: cada linha de etiquetas é uma "página" do rolo da impressora térmica. */
export function ImprimirEtiquetas() {
  const [itens, setItens] = useState<Item[] | null>(null);
  const cfg = useQuery({ queryKey: ['config', 'impressao'], queryFn: () => api<Impressao>('/configuracoes/chave/impressao') });
  useEffect(() => {
    try {
      setItens(JSON.parse(localStorage.getItem(CHAVE_FILA) ?? '[]'));
    } catch {
      setItens([]);
    }
    document.body.style.background = '#fff';
    return () => { document.body.style.background = ''; };
  }, []);
  if (cfg.isLoading || !itens) return <Carregando />;
  if (cfg.error) return <Erro erro={cfg.error} />;
  const c = cfg.data!;
  const etiquetas = itens.flatMap((i) => Array.from({ length: Math.min(i.quantidade, 500) }, () => i));
  const L = c.etiquetaLarguraMm;
  const A = c.etiquetaAlturaMm;
  const cols = c.etiquetaColunas;
  const linhas: Item[][] = [];
  for (let i = 0; i < etiquetas.length; i += cols) linhas.push(etiquetas.slice(i, i + cols));
  const css = `
    html, body { background: #fff !important; }
    @page { size: ${L * cols}mm ${A}mm; margin: 0; }
    @media print { body { margin: 0; } .acoes-impressao, .nota-tela { display: none !important; } .linha-etq { page-break-after: always; break-after: page; margin: 0 !important; box-shadow: none !important; } }
    .linha-etq { display: grid; grid-template-columns: repeat(${cols}, ${L}mm); width: ${L * cols}mm; height: ${A}mm; margin: 0 auto 4px; background: #fff; box-shadow: 0 0 0 1px #ddd; overflow: hidden; }
    .etq { width: ${L}mm; height: ${A}mm; padding: 1.2mm 1.6mm; box-sizing: border-box; display: flex; flex-direction: column; color: #000; font-family: Arial, sans-serif; overflow: hidden; }
    .etq .topo-etq { display: flex; justify-content: space-between; gap: 2mm; font-size: 7.5pt; line-height: 1.15; }
    .etq .marca-etq { font-weight: 700; letter-spacing: .3px; }
    .etq .desc { font-size: 6.5pt; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .etq .preco { font-weight: 700; font-size: 8.5pt; white-space: nowrap; }
    .etq .barras { flex: 1; display: flex; align-items: flex-end; justify-content: center; min-height: 0; }
    .acoes-impressao { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; z-index: 5; }
  `;
  return (
    <>
      <style>{css}</style>
      <div className="acoes-impressao"><button className="botao" onClick={() => window.print()}>Imprimir</button><button className="botao claro" onClick={() => window.close()}>Fechar</button></div>
      <div className="nota-tela" style={{ padding: '16px 16px 10px', maxWidth: 640, margin: '0 auto', fontSize: 14, color: '#555' }}>
        {etiquetas.length} etiqueta(s) de {L} × {A} mm, {cols} por linha. Na janela de impressão, escolha a impressora de etiquetas, tamanho de papel "personalizado" igual ao da etiqueta e margens "nenhuma".
      </div>
      {!etiquetas.length && <div className="vazio">A fila de etiquetas está vazia. Volte ao Estoque → Etiquetas.</div>}
      {linhas.map((linha, i) => (
        <div className="linha-etq" key={i}>
          {linha.map((e, j) => (
            <div className="etq" key={j}>
              <div className="topo-etq">
                <span className="marca-etq">{c.etiquetaTexto}</span>
                {c.etiquetaMostrarPreco && <span className="preco">{reais(e.preco)}</span>}
              </div>
              <div className="desc">{c.etiquetaMostrarRef ? `${e.referencia} · ` : ''}{e.descricao}</div>
              <div className="barras"><Barras codigo={e.codigoBarras} alturaMm={A * 0.45} /></div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
