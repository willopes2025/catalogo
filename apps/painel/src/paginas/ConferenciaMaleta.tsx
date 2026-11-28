import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, lerSessao } from '../api';
import { dataHora } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';
import { BuscaPeca, type PecaSugerida } from '../componentes/BuscaPeca';
import { FotoPeca, LinhaFiltro, useFiltroColunas } from '../componentes/Peca';

const COLUNAS = { codigo: (l: Linha) => `${l.codigoBarras ?? ''} ${l.referencia}`, descricao: (l: Linha) => l.descricao };

interface Linha { produtoId: string; codigoBarras: string | null; referencia: string; descricao: string; foto: string | null; naMaleta: number; esperado: number; conferido: number }

/**
 * Conferência da maleta peça por peça, bipando: na saída (antes de entregar) ou na volta (antes do acerto).
 * Mostra o que faltou e o que sobrou, e fica no nome de quem está logado.
 */
export function ConferenciaMaleta() {
  const { id } = useParams();
  const [qs] = useSearchParams();
  const tipo = qs.get('tipo') === 'volta' ? 'volta' : 'saida';
  const navegar = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['maleta', id], queryFn: () => api<any>(`/maletas/${id}`) });
  const [lidos, setLidos] = useState<Record<string, number>>({});
  const [sobras, setSobras] = useState<Record<string, number>>({});
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean } | null>(null);
  const [observacao, setObservacao] = useState('');
  const [tratamento, setTratamento] = useState<'nada' | 'retirar' | 'cobrar' | 'investigar'>('nada');
  const leitor = useRef<HTMLInputElement>(null);

  const comPrebaixa = !!q.data?.prebaixaEm;
  const linhas: Linha[] = useMemo(
    () =>
      (q.data?.itens ?? [])
        .filter((i: any) => i.naMaleta > 0)
        .map((i: any) => ({
          ...i,
          esperado: tipo === 'volta' && comPrebaixa ? Math.min(i.naMaleta, i.prebaixaDevolvida ?? Math.max(0, i.naMaleta - (i.prebaixaVendida ?? 0))) : i.naMaleta,
          conferido: lidos[i.produtoId] ?? 0,
        })),
    [q.data, lidos, tipo, comPrebaixa],
  );
  const salvar = useMutation({
    mutationFn: () => api<any>(`/maletas/${id}/conferencia`, { corpo: { tipo, itens: linhas.map((l) => ({ produtoId: l.produtoId, conferido: l.conferido })), sobras: Object.entries(sobras).map(([c, n]) => ({ codigo: c, quantidade: n })), observacao: observacao || null, tratamento } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maleta', id] });
      navegar(tipo === 'volta' ? `/maletas/${id}/acerto` : `/maletas/${id}`);
    },
  });

  const tabela = useFiltroColunas(linhas, COLUNAS);
  const opcoes: PecaSugerida[] = useMemo(() => linhas.map((l) => ({ produtoId: l.produtoId, codigoBarras: l.codigoBarras ?? l.referencia, referencia: l.referencia, descricao: l.descricao, foto: l.foto, quantidade: l.naMaleta - l.conferido })), [linhas]);

  function bipar(c: string) {
    if (!c) return;
    const l = linhas.find((x) => x.codigoBarras === c || x.referencia === c);
    if (!l) {
      setSobras({ ...sobras, [c]: (sobras[c] ?? 0) + 1 });
      return setAviso({ texto: `${c} não é desta maleta: ficou em "Sobrou".`, ok: false });
    }
    if (l.conferido >= l.naMaleta) return setAviso({ texto: `Todas as ${l.naMaleta} unidade(s) de ${l.descricao} já foram conferidas.`, ok: false });
    setLidos({ ...lidos, [l.produtoId]: l.conferido + 1 });
    setAviso({ texto: `✓ ${l.descricao} (${l.conferido + 1} de ${l.esperado})`, ok: true });
  }
  const mudar = (l: Linha, n: number) => setLidos({ ...lidos, [l.produtoId]: Math.max(0, Math.min(l.naMaleta, n)) });

  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const m = q.data;
  if (m.status !== 'aberta') return <div className="aviso alerta">Esta maleta está {m.status}.</div>;
  const esperadas = linhas.reduce((a, l) => a + l.esperado, 0);
  const conferidas = linhas.reduce((a, l) => a + l.conferido, 0);
  const faltaram = linhas.filter((l) => l.conferido < l.esperado);
  const qtdFalta = tipo === 'volta' && !comPrebaixa ? 0 : faltaram.reduce((a, l) => a + l.esperado - l.conferido, 0);
  const naoVoltaram = tipo === 'volta' && !comPrebaixa ? linhas.reduce((a, l) => a + l.naMaleta - l.conferido, 0) : 0;
  const qtdSobra = Object.values(sobras).reduce((a, n) => a + n, 0);
  const eu = lerSessao()?.usuario?.nome ?? 'você';

  return (
    <>
      <Topo
        eb={`Pedido nº ${m.numero} · ${tipo === 'saida' ? 'Conferência de saída' : 'Conferência de volta'}`}
        titulo={m.representante}
        sub={tipo === 'saida' ? 'Bipe cada peça que vai na maleta antes de entregar.' : comPrebaixa ? `Bipe cada peça que voltou. A pré-baixa (${dataHora(m.prebaixaEm)}) diz quais deviam voltar.` : 'Bipe cada peça que voltou. Sem pré-baixa, o que não voltar conta como vendido no acerto.'}
        acoes={<Link className="botao claro" to={`/maletas/${id}`}>Voltar para o pedido</Link>}
      />
      <div className="grade" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px', alignItems: 'start' }}>
        <div className="cartao coluna" style={{ minWidth: 0 }}>
          <BuscaPeca entradaRef={leitor} botao="Conferir" placeholder="Bipe a peça ou digite o nome (peça sem etiqueta)" opcoes={opcoes} aoCodigo={bipar} aoEscolher={(p) => bipar(p.codigoBarras)} />
          {aviso && <div className={aviso.ok ? 'muted' : 'aviso alerta'}>{aviso.texto}</div>}
          <div style={{ overflowX: 'auto' }}>
            <table className="tabela">
              <thead><tr><th></th><th>Código</th><th>Descrição</th><th className="num">{tipo === 'volta' && comPrebaixa ? 'Devia voltar' : tipo === 'volta' ? 'Na maleta' : 'Esperado'}</th><th className="num">Conferido</th><th></th></tr>
                <LinhaFiltro celulas={[null, 'codigo', 'descricao', null, null, null]} filtro={tabela.filtro} setFiltro={tabela.setFiltro} />
              </thead>
              <tbody>
                {tabela.filtrados.map((l) => {
                  const ok = l.conferido >= l.esperado && l.esperado > 0;
                  return (
                    <tr key={l.produtoId} className={ok ? 'linha-ok' : ''}>
                      <td><FotoPeca src={l.foto} alt={l.descricao} /></td>
                      <td className="muted">{l.codigoBarras ?? l.referencia}</td>
                      <td>{l.descricao}</td>
                      <td className="num">{l.esperado}</td>
                      <td className="num">
                        <span className="flex" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <button className="botao claro pequeno" aria-label="Menos" onClick={() => mudar(l, l.conferido - 1)}>−</button>
                          <b style={{ minWidth: 22, textAlign: 'center' }}>{l.conferido}</b>
                          <button className="botao claro pequeno" aria-label="Mais" onClick={() => mudar(l, l.conferido + 1)}>+</button>
                        </span>
                      </td>
                      <td>{ok ? <span className="etiqueta ok">✓</span> : l.conferido < l.esperado ? <span className="etiqueta alerta">falta {l.esperado - l.conferido}</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="coluna" style={{ position: 'sticky', top: 20 }}>
          <div className="cartao">
            <h3 style={{ marginBottom: 8 }}>Resumo</h3>
            <div className="resumo-linha"><span>Conferidas</span><b>{conferidas} de {esperadas}</b></div>
            {tipo === 'volta' && !comPrebaixa ? (
              <div className="resumo-linha"><span>Não voltaram (vendidas ou faltando)</span><b>{naoVoltaram}</b></div>
            ) : (
              <div className="resumo-linha"><span>Faltaram</span><b style={{ color: qtdFalta ? 'var(--erro)' : undefined }}>{qtdFalta}</b></div>
            )}
            <div className="resumo-linha"><span>Sobrou (não é desta maleta)</span><b>{qtdSobra}</b></div>
            {qtdFalta > 0 && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <b>O que faltou:</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{faltaram.map((l) => <li key={l.produtoId}>{l.esperado - l.conferido}× {l.descricao}</li>)}</ul>
              </div>
            )}
            {qtdSobra > 0 && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <b>Sobrou:</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{Object.entries(sobras).map(([c, n]) => <li key={c}>{n}× código {c} <button className="link" onClick={() => { const { [c]: _x, ...r } = sobras; setSobras(r); }}>tirar</button></li>)}</ul>
              </div>
            )}
          </div>
          {qtdFalta > 0 && (
            <div className="cartao coluna">
              <h3 style={{ margin: 0 }}>O que fazer com o que faltou</h3>
              <label className="check"><input type="radio" name="trat" checked={tratamento === 'nada'} onChange={() => setTratamento('nada')} /> Só registrar</label>
              {tipo === 'saida' ? (
                <label className="check"><input type="radio" name="trat" checked={tratamento === 'retirar'} onChange={() => setTratamento('retirar')} /> Tirar da maleta (volta para o estoque e a promissória é refeita)</label>
              ) : (
                <>
                  <label className="check"><input type="radio" name="trat" checked={tratamento === 'cobrar'} onChange={() => setTratamento('cobrar')} /> Cobrar pelo custo no acerto (peça perdida)</label>
                  <label className="check"><input type="radio" name="trat" checked={tratamento === 'investigar'} onChange={() => setTratamento('investigar')} /> Deixar como faltando para investigar (acerto parcial; a peça continua na maleta)</label>
                </>
              )}
            </div>
          )}
          <div className="cartao coluna">
            <Campo rotulo="Observação"><textarea maxLength={1000} value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Ex.: brinco com a tarraxa solta, embalagem rasgada" /></Campo>
            <div className="muted" style={{ fontSize: 13 }}>Conferido por: <b>{eu}</b></div>
            {salvar.error && <Erro erro={salvar.error} />}
            <button className="botao" disabled={salvar.isPending || !linhas.length} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : tipo === 'volta' ? 'Salvar e ir para o acerto' : 'Salvar conferência'}</button>
          </div>
        </div>
      </div>
    </>
  );
}
