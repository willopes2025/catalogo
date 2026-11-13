import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ErroApi } from '../api';
import { data, pct, reais } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';

interface Linha { produtoId: string; codigoBarras: string; referencia: string; descricao: string; preco: number; custo: number; naMaleta: number; vendida: number; devolvida: number; perdida: number }

export function Acerto() {
  const { id } = useParams();
  const navegar = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['maleta', id], queryFn: () => api<any>(`/maletas/${id}`) });
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [bipagem, setBipagem] = useState(true);
  const [codigo, setCodigo] = useState('');
  const [avisoBip, setAvisoBip] = useState<string | null>(null);
  const [op, setOp] = useState({ forma: 'avista' as 'avista' | 'prazo', modalidade: 'presencial', parcial: false, parcelas: 1, primeiroVencimento: '', formaPagamento: 'pix', pagoAgora: true, usarCredito: true });
  const leitor = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!q.data) return;
    const temPre = !!q.data.prebaixaEm;
    setLinhas(
      q.data.itens
        .filter((i: any) => i.naMaleta > 0)
        .map((i: any) => {
          // Com bipagem: começa tudo como vendido e cada peça bipada vira devolvida.
          // Sem bipagem: usa a pré-baixa da representante, se houver.
          const vendida = temPre && i.prebaixaVendida != null ? Math.min(i.prebaixaVendida, i.naMaleta) : i.naMaleta;
          return { ...i, vendida, devolvida: i.naMaleta - vendida, perdida: 0 };
        }),
    );
    if (temPre) setBipagem(false);
  }, [q.data]);

  useEffect(() => {
    if (bipagem) setLinhas((ls) => ls.map((l) => ({ ...l, vendida: l.naMaleta - l.perdida, devolvida: 0 })));
  }, [bipagem]);

  function bipar() {
    const c = codigo.trim();
    setCodigo('');
    if (!c) return;
    const l = linhas.find((x) => x.codigoBarras === c || x.referencia === c);
    if (!l) return setAvisoBip(`Peça ${c} não é desta maleta.`);
    if (l.devolvida + l.perdida >= l.naMaleta) return setAvisoBip(`Todas as unidades de ${l.descricao} já foram conferidas.`);
    setLinhas(linhas.map((x) => (x === l ? { ...x, devolvida: x.devolvida + 1, vendida: x.vendida - 1 } : x)));
    setAvisoBip(`Devolvida: ${l.descricao}`);
    leitor.current?.focus();
  }

  function mudar(l: Linha, campo: 'vendida' | 'devolvida' | 'perdida', valor: number) {
    const v = Math.max(0, Math.min(l.naMaleta, Math.floor(valor) || 0));
    setLinhas(linhas.map((x) => {
      if (x !== l) return x;
      const n = { ...x, [campo]: v };
      // Sem acerto parcial, mantém a soma igual ao que está na maleta, ajustando "vendida".
      if (!op.parcial && campo !== 'vendida') n.vendida = Math.max(0, x.naMaleta - n.devolvida - n.perdida);
      return n;
    }));
  }

  const corpo = useMemo(
    () => ({ ...op, primeiroVencimento: op.primeiroVencimento || undefined, pagoAgora: op.pagoAgora && op.parcelas === 1, itens: linhas.map(({ produtoId, vendida, devolvida, perdida }) => ({ produtoId, vendida, devolvida, perdida })) }),
    [op, linhas],
  );
  const sim = useQuery({ queryKey: ['simular', id, corpo], queryFn: () => api<any>(`/maletas/${id}/simular-acerto`, { corpo }), enabled: linhas.length > 0, placeholderData: (p) => p, retry: false });
  const fechar = useMutation({
    mutationFn: () => api<any>(`/maletas/${id}/acerto`, { corpo }),
    onSuccess: () => {
      // A simulação não vale mais depois de fechar: remove em vez de recalcular.
      qc.removeQueries({ queryKey: ['simular', id] });
      navegar(`/maletas/${id}`);
      qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'simular' });
    },
  });

  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const m = q.data;
  if (m.status !== 'aberta') return <div className="aviso alerta">Esta maleta está {m.status}.</div>;
  const r = sim.data?.resultado;
  const faltando = linhas.reduce((a, l) => a + (l.naMaleta - l.vendida - l.devolvida - l.perdida), 0);

  return (
    <>
      <Topo eb={`Acerto · Maleta nº ${m.numero}`} titulo={m.representante} sub={<>Acerto até {data(m.dataLimite)}{m.diasAtraso > 0 && <> · <span className="etiqueta erro">{m.diasAtraso} dias de atraso</span></>}</>} />
      <div className="grade" style={{ gridTemplateColumns: '1fr 380px', alignItems: 'start' }}>
        <div className="coluna">
          <div className="cartao coluna">
            <div className="flex entre">
              <h3>1. Conferência das peças</h3>
              <label className="check"><input type="checkbox" checked={bipagem} onChange={(e) => setBipagem(e.target.checked)} /> Conferir devolução bipando</label>
            </div>
            {bipagem ? (
              <>
                <p className="muted">Bipe cada peça que a representante devolveu. O que não for bipado conta como vendido. Peça perdida ou quebrada: marque na coluna “Perdida”.</p>
                <div className="leitor">
                  <input ref={leitor} autoFocus placeholder="Bipe a peça devolvida" value={codigo} onChange={(e) => setCodigo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); bipar(); } }} />
                  <button className="botao" onClick={bipar}>Devolver</button>
                </div>
                {avisoBip && <div className="muted">{avisoBip}</div>}
              </>
            ) : m.prebaixaEm ? (
              <div className="aviso alerta">Quantidades preenchidas com a pré-baixa informada pela representante. Confira antes de fechar.</div>
            ) : null}
            <table className="tabela">
              <thead><tr><th>Ref.</th><th>Descrição</th><th className="num">Preço</th><th className="num">Na maleta</th><th className="num">Vendida</th><th className="num">Devolvida</th><th className="num">Perdida</th></tr></thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.produtoId}>
                    <td>{l.referencia}</td>
                    <td>{l.descricao}</td>
                    <td className="num">{reais(l.preco)}</td>
                    <td className="num">{l.naMaleta}</td>
                    <td className="num">{op.parcial ? <input type="number" min={0} value={l.vendida} onChange={(e) => mudar(l, 'vendida', Number(e.target.value))} /> : <b>{l.vendida}</b>}</td>
                    <td className="num"><input type="number" min={0} value={l.devolvida} onChange={(e) => mudar(l, 'devolvida', Number(e.target.value))} /></td>
                    <td className="num"><input type="number" min={0} value={l.perdida} onChange={(e) => mudar(l, 'perdida', Number(e.target.value))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cartao form">
            <div className="secao">2. Pagamento</div>
            <Campo rotulo="Forma" ajuda="Define a comissão (à vista ou a prazo)"><select value={op.forma} onChange={(e) => setOp({ ...op, forma: e.target.value as 'avista', parcelas: e.target.value === 'avista' ? 1 : op.parcelas })}><option value="avista">À vista</option><option value="prazo">A prazo</option></select></Campo>
            <Campo rotulo="Meio"><select value={op.formaPagamento} onChange={(e) => setOp({ ...op, formaPagamento: e.target.value })}><option value="pix">Pix</option><option value="dinheiro">Dinheiro</option><option value="boleto">Boleto</option><option value="cartao">Cartão</option></select></Campo>
            <Campo rotulo="Parcelas"><select value={op.parcelas} disabled={op.forma === 'avista'} onChange={(e) => setOp({ ...op, parcelas: Number(e.target.value) })}>{Array.from({ length: sim.data?.regras?.parcelasMaximas ?? 3 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}x</option>)}</select></Campo>
            <Campo rotulo="1º vencimento"><input type="date" value={op.primeiroVencimento} onChange={(e) => setOp({ ...op, primeiroVencimento: e.target.value })} /></Campo>
            <Campo rotulo="Modalidade"><select value={op.modalidade} onChange={(e) => setOp({ ...op, modalidade: e.target.value })}><option value="presencial">Presencial</option><option value="video">Por vídeo</option><option value="envio">Por envio</option></select></Campo>
            <div className="campo l2"><label>&nbsp;</label>
              <div className="flex" style={{ flexWrap: 'wrap' }}>
                <label className="check"><input type="checkbox" checked={op.pagoAgora && op.parcelas === 1} disabled={op.parcelas > 1} onChange={(e) => setOp({ ...op, pagoAgora: e.target.checked })} /> Pago agora</label>
                <label className="check"><input type="checkbox" checked={op.usarCredito} onChange={(e) => setOp({ ...op, usarCredito: e.target.checked })} /> Usar créditos</label>
                <label className="check"><input type="checkbox" checked={op.parcial} onChange={(e) => setOp({ ...op, parcial: e.target.checked })} /> Acerto parcial</label>
              </div>
            </div>
          </div>
        </div>

        <div className="coluna" style={{ position: 'sticky', top: 20 }}>
          <div className="cartao">
            <h3 style={{ marginBottom: 10 }}>3. Conta do acerto</h3>
            {sim.error ? <Erro erro={sim.error} /> : !r ? <p className="muted">Calculando…</p> : (
              <>
                <div className="resumo-linha"><span>Vendido ({r.pecas.vendidas} peças · {pct(r.percentualVendidoPb)})</span><b>{reais(r.totalVendido)}</b></div>
                <div className="resumo-linha"><span>Comissão {op.forma === 'avista' ? 'à vista' : 'a prazo'} ({pct(r.comissaoPb)})</span><span className="menos">− {reais(r.comissao)}</span></div>
                {r.perdidas > 0 && <div className="resumo-linha"><span>Peças perdidas ({r.pecas.perdidas}) pelo {sim.data.regras.perdidaPeloCusto ? 'custo' : 'preço'}</span><span className="mais">+ {reais(r.perdidas)}</span></div>}
                {r.multa > 0 && <div className="resumo-linha"><span>Multa por atraso ({r.diasAtraso} dias)</span><span className="mais">+ {reais(r.multa)}</span></div>}
                {r.juros > 0 && <div className="resumo-linha"><span>Juros</span><span className="mais">+ {reais(r.juros)}</span></div>}
                {r.creditoUsado > 0 && <div className="resumo-linha"><span>Créditos usados</span><span className="menos">− {reais(r.creditoUsado)}</span></div>}
                <div className="resumo-linha total"><span>A pagar</span><span>{reais(r.totalAPagar)}</span></div>
                {sim.data.parcelas.length > 1 && sim.data.parcelas.map((p: any) => <div key={p.numero} className="resumo-linha"><span className="muted">{p.numero}ª parcela · {data(p.vencimento)}</span><span>{reais(p.valor)}</span></div>)}
                <p className="muted" style={{ marginTop: 10 }}>Devolvidas: {r.pecas.devolvidas} peças{r.pecas.continuam ? ` · continuam na maleta: ${r.pecas.continuam}` : ''}</p>
                <p className="muted">Limite: {reais(sim.data.limiteAtual)} → <b>{reais(sim.data.limiteNovo)}</b>. {sim.data.motivoLimite}</p>
              </>
            )}
          </div>
          {faltando > 0 && !op.parcial && <div className="aviso alerta">{faltando} peça(s) sem destino. Marque como vendida, devolvida ou perdida, ou faça acerto parcial.</div>}
          {fechar.error && <Erro erro={fechar.error} />}
          <button className="botao" disabled={!r || fechar.isPending || (faltando > 0 && !op.parcial) || sim.error instanceof ErroApi} onClick={() => fechar.mutate()}>
            {fechar.isPending ? 'Fechando…' : op.parcial ? 'Registrar acerto parcial' : 'Fechar acerto'}
          </button>
          <p className="muted">Ao fechar: as devolvidas voltam ao estoque, as vendidas e perdidas saem, os títulos são gerados no financeiro e o limite é atualizado.</p>
        </div>
      </div>
    </>
  );
}
