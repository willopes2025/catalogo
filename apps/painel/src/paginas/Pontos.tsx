import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { dataHora, reais, telefone } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

type Aba = 'ranking' | 'score' | 'saldos' | 'premios' | 'resgates' | 'niveis' | 'regras';
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const FAIXA: Record<string, [string, string]> = { A: ['ok', 'A'], B: ['ok', 'B'], C: ['alerta', 'C'], D: ['erro', 'D'], nova: ['neutra', 'Nova'] };

export function Pontos() {
  const [aba, setAba] = useState<Aba>('ranking');
  return (
    <>
      <Topo eb="Pontos e prêmios" titulo="Engajamento da rede" sub="Ranking do mês, score interno, pontos automáticos e prêmios para resgate" />
      <Abas
        ativa={aba}
        mudar={setAba}
        abas={[['ranking', 'Ranking do mês'], ['score', 'Score da rede'], ['saldos', 'Saldos de pontos'], ['premios', 'Prêmios'], ['resgates', 'Resgates'], ['niveis', 'Revisão de níveis'], ['regras', 'Regras dos pontos']]}
      />
      {aba === 'ranking' && <Ranking />}
      {aba === 'score' && <ScoreRede />}
      {aba === 'saldos' && <Saldos />}
      {aba === 'premios' && <Premios />}
      {aba === 'resgates' && <Resgates />}
      {aba === 'niveis' && <Niveis />}
      {aba === 'regras' && <Regras />}
    </>
  );
}

function Ranking() {
  const [mes, setMes] = useState(mesAtual());
  const q = useQuery({ queryKey: ['ranking', mes], queryFn: () => api<any[]>(`/pontos/ranking?mes=${mes}`) });
  const l = q.data ?? [];
  return (
    <div className="coluna">
      <div className="busca"><input type="month" value={mes} max={mesAtual()} onChange={(e) => e.target.value && setMes(e.target.value)} /><span className="muted" style={{ alignSelf: 'center' }}>Pelo vendido nos acertos do mês. A representante vê a própria posição no app, e as outras só pelo primeiro nome.</span></div>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          <div className="grade g3">
            {l.slice(0, 3).map((x, i) => <Indicador key={x.pessoaId} tipo={i === 0 ? 'destaque' : undefined} rotulo={`${i + 1}º lugar`} valor={x.nome.split(' ').slice(0, 2).join(' ')} detalhe={`${reais(x.vendido)} vendidos · ${x.pontos} pontos`} />)}
          </div>
          <table className="tabela">
            <thead><tr><th>#</th><th>Representante</th><th>Cidade</th><th className="num">Acertos</th><th className="num">Vendido</th><th className="num">Pontos no mês</th></tr></thead>
            <tbody>
              {l.map((x) => <tr key={x.pessoaId}><td><b>{x.posicao}</b></td><td><Link to={`/rede/${x.pessoaId}`}>{x.nome}</Link></td><td>{x.cidade ?? '—'}</td><td className="num">{x.acertos}</td><td className="num">{reais(x.vendido)}</td><td className="num">{x.pontos}</td></tr>)}
              {!l.length && <tr><td colSpan={6} className="vazio">Nenhum acerto neste mês.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ScoreRede() {
  const q = useQuery({ queryKey: ['score-rede'], queryFn: () => api<any[]>('/rede/score') });
  const [faixa, setFaixa] = useState('');
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const l = q.data!;
  const conta = (f: string) => l.filter((x) => x.faixa === f).length;
  const lista = l.filter((x) => !faixa || x.faixa === faixa).sort((a, b) => (a.score ?? 2000) - (b.score ?? 2000));
  return (
    <div className="coluna">
      <p className="muted" style={{ margin: 0 }}>
        De 0 a 1000, pelos últimos 12 meses: 35% pontualidade nos acertos, 25% pagamento das parcelas, 25% giro (quanto vende da maleta), 10% peças perdidas e 5% tempo de casa. Só a matriz vê. Use para decidir limite, tamanho da maleta e quem precisa de acompanhamento.
      </p>
      <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        {(['A', 'B', 'C', 'D', 'nova'] as const).map((f) => (
          <button key={f} className={`cartao indicador ${faixa === f ? 'destaque' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => setFaixa(faixa === f ? '' : f)}>
            <div className="rotulo">{f === 'nova' ? 'Sem histórico' : `Faixa ${f}`}</div>
            <div className="valor">{conta(f)}</div>
            <div className="detalhe">{{ A: '800 ou mais', B: '600 a 799', C: '400 a 599', D: 'abaixo de 400', nova: 'sem acerto completo' }[f]}</div>
          </button>
        ))}
      </div>
      <table className="tabela">
        <thead><tr><th>Representante</th><th>Nível</th><th className="num">Score</th><th>Faixa</th><th>Pontualidade</th><th>Pagamento</th><th>Giro</th><th>Atenção</th></tr></thead>
        <tbody>
          {lista.map((x) => (
            <tr key={x.pessoaId}>
              <td><Link to={`/rede/${x.pessoaId}?aba=credito`}>{x.nome}</Link><div className="muted">{x.cidade}</div></td>
              <td>{x.nivel ?? '—'}</td>
              <td className="num"><b>{x.score ?? '—'}</b></td>
              <td><span className={`etiqueta ${FAIXA[x.faixa][0]}`}>{FAIXA[x.faixa][1]}</span></td>
              {x.score === null ? (
                <td colSpan={3} className="muted">Sem acerto completo ainda</td>
              ) : (
                <>
                  <td>{Math.round(x.componentes.pontualidade * 100)}%</td>
                  <td>{Math.round(x.componentes.pagamento * 100)}%</td>
                  <td>{Math.round(x.componentes.giro * 100)}%</td>
                </>
              )}
              <td className="muted">{x.pontosDeAtencao.join(', ') || '—'}</td>
            </tr>
          ))}
          {!lista.length && <tr><td colSpan={8} className="vazio">Ninguém nesta faixa.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Saldos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pontos-saldos'], queryFn: () => api<any[]>('/pontos/saldos') });
  const [aberto, setAberto] = useState<string | null>(null);
  const extrato = useQuery({ queryKey: ['extrato', aberto], queryFn: () => api<any[]>(`/pontos/extrato/${aberto}`), enabled: !!aberto });
  const [aj, setAj] = useState({ pontos: '', motivo: '' });
  const ajustar = useMutation({
    mutationFn: () => api('/pontos/ajuste', { corpo: { pessoaId: aberto, pontos: Number(aj.pontos), motivo: aj.motivo } }),
    onSuccess: () => { setAj({ pontos: '', motivo: '' }); qc.invalidateQueries({ queryKey: ['pontos-saldos'] }); qc.invalidateQueries({ queryKey: ['extrato', aberto] }); },
  });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      {q.error && <Erro erro={q.error} />}
      <table className="tabela">
        <thead><tr><th>Representante</th><th className="num">Saldo</th><th className="num">Ganhos</th><th className="num">Resgatados</th><th></th></tr></thead>
        <tbody>
          {q.data?.map((x) => (
            <tr key={x.id} className={aberto === x.id ? 'selecionada' : ''}><td>{x.nome}</td><td className="num"><b>{x.saldo}</b></td><td className="num">{x.ganhos}</td><td className="num">{x.resgatados}</td><td><button className="botao claro pequeno" onClick={() => setAberto(aberto === x.id ? null : x.id)}>Extrato</button></td></tr>
          ))}
          {!q.data?.length && <tr><td colSpan={5} className="vazio">Ninguém tem pontos ainda. Eles entram sozinhos depois dos acertos e das parcelas pagas em dia.</td></tr>}
        </tbody>
      </table>
      {aberto && (
        <div className="cartao coluna">
          <div className="secao" style={{ marginTop: 0 }}>Extrato</div>
          {extrato.data?.map((e) => <div key={e.id} className="resumo-linha"><span>{e.motivo}<div className="muted">{dataHora(e.criadoEm)}</div></span><b style={{ color: e.pontos < 0 ? 'var(--erro)' : undefined }}>{e.pontos > 0 ? '+' : ''}{e.pontos}</b></div>)}
          {pode('pontos', 'editar') && (
            <div className="form">
              <Campo rotulo="Ajuste (+ ou −)"><input inputMode="numeric" value={aj.pontos} onChange={(e) => setAj({ ...aj, pontos: e.target.value.replace(/[^\d-]/g, '') })} placeholder="ex.: 100 ou -50" /></Campo>
              <Campo rotulo="Motivo" className="l2"><input value={aj.motivo} onChange={(e) => setAj({ ...aj, motivo: e.target.value })} placeholder="Ex.: campanha de Natal, correção" /></Campo>
              <div className="campo"><label>&nbsp;</label><button className="botao" disabled={!Number(aj.pontos) || aj.motivo.trim().length < 3 || ajustar.isPending} onClick={() => ajustar.mutate()}>Lançar</button></div>
            </div>
          )}
          {ajustar.error && <Erro erro={ajustar.error} />}
        </div>
      )}
    </div>
  );
}

function Premios() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['premios'], queryFn: () => api<any[]>('/pontos/premios') });
  const vazio = { nome: '', descricao: '', pontos: '', estoque: '', foto: '' };
  const [n, setN] = useState(vazio);
  const criar = useMutation({
    mutationFn: () => api('/pontos/premios', { corpo: { nome: n.nome, descricao: n.descricao || null, pontos: Number(n.pontos), estoque: n.estoque === '' ? null : Number(n.estoque), foto: n.foto || null } }),
    onSuccess: () => { setN(vazio); qc.invalidateQueries({ queryKey: ['premios'] }); },
  });
  const editar = useMutation({ mutationFn: ({ id, corpo }: { id: string; corpo: any }) => api(`/pontos/premios/${id}`, { metodo: 'PATCH', corpo }), onSuccess: () => qc.invalidateQueries({ queryKey: ['premios'] }) });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      {(criar.error || editar.error) && <Erro erro={criar.error ?? editar.error} />}
      <table className="tabela">
        <thead><tr><th>Prêmio</th><th className="num">Pontos</th><th className="num">Disponíveis</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          {q.data!.map((p) => (
            <tr key={p.id}>
              <td><b>{p.nome}</b>{p.descricao && <div className="muted">{p.descricao}</div>}</td>
              <td className="num">{p.pontos}</td>
              <td className="num">{p.estoque ?? 'sem limite'}</td>
              <td>{p.ativo ? <span className="etiqueta ok">No app</span> : <span className="etiqueta neutra">Oculto</span>}</td>
              <td>
                {pode('pontos', 'editar') && (
                  <div className="flex">
                    <button className="botao claro pequeno" onClick={() => editar.mutate({ id: p.id, corpo: { ativo: !p.ativo } })}>{p.ativo ? 'Ocultar' : 'Mostrar'}</button>
                    <button className="botao claro pequeno" onClick={() => { const v = window.prompt('Quantos disponíveis? (em branco = sem limite)', p.estoque ?? ''); if (v !== null) editar.mutate({ id: p.id, corpo: { estoque: v.trim() === '' ? null : Number(v) } }); }}>Estoque</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
          {!q.data!.length && <tr><td colSpan={5} className="vazio">Cadastre os prêmios que a rede pode trocar por pontos (vale-compra, kit, viagem, peça da coleção).</td></tr>}
        </tbody>
      </table>
      {pode('pontos', 'criar') && (
        <div className="cartao form">
          <div className="secao">Novo prêmio</div>
          <Campo rotulo="Nome" className="l2"><input value={n.nome} onChange={(e) => setN({ ...n, nome: e.target.value })} /></Campo>
          <Campo rotulo="Pontos"><input inputMode="numeric" value={n.pontos} onChange={(e) => setN({ ...n, pontos: e.target.value.replace(/\D/g, '') })} /></Campo>
          <Campo rotulo="Quantidade" ajuda="Em branco = sem limite"><input inputMode="numeric" value={n.estoque} onChange={(e) => setN({ ...n, estoque: e.target.value.replace(/\D/g, '') })} /></Campo>
          <Campo rotulo="Descrição" className="l2"><input value={n.descricao} onChange={(e) => setN({ ...n, descricao: e.target.value })} /></Campo>
          <Campo rotulo="Foto (endereço da imagem)" className="l2"><input value={n.foto} onChange={(e) => setN({ ...n, foto: e.target.value })} placeholder="https://..." /></Campo>
          <div className="campo"><label>&nbsp;</label><button className="botao" disabled={n.nome.trim().length < 2 || !Number(n.pontos) || criar.isPending} onClick={() => criar.mutate()}>Cadastrar</button></div>
        </div>
      )}
    </div>
  );
}

function Resgates() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('solicitado');
  const q = useQuery({ queryKey: ['resgates', status], queryFn: () => api<any[]>(`/pontos/resgates?status=${status}`) });
  const atender = useMutation({ mutationFn: (d: { id: string; status: string; observacao: string | null }) => api(`/pontos/resgates/${d.id}`, { corpo: { status: d.status, observacao: d.observacao } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['resgates'] }); qc.invalidateQueries({ queryKey: ['premios'] }); } });
  return (
    <div className="coluna">
      <div className="busca"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="solicitado">Aguardando entrega</option><option value="entregue">Entregues</option><option value="cancelado">Cancelados</option><option value="todos">Todos</option></select></div>
      {atender.error && <Erro erro={atender.error} />}
      {q.isLoading ? <Carregando /> : (
        <table className="tabela">
          <thead><tr><th>Nº</th><th>Representante</th><th>Prêmio</th><th className="num">Pontos</th><th>Pedido em</th><th></th></tr></thead>
          <tbody>
            {q.data?.map((r) => (
              <tr key={r.id}>
                <td>{r.numero}</td>
                <td><Link to={`/rede/${r.pessoaId}`}>{r.representante}</Link>{r.telefone && <div className="muted">{telefone(r.telefone)}</div>}</td>
                <td>{r.premio}{r.observacao && <div className="muted">{r.observacao}</div>}</td>
                <td className="num">{r.pontos}</td>
                <td>{dataHora(r.criadoEm)}</td>
                <td>
                  {r.status === 'solicitado' && pode('pontos', 'editar') ? (
                    <div className="flex">
                      <button className="botao pequeno" onClick={() => atender.mutate({ id: r.id, status: 'entregue', observacao: null })}>Entregue</button>
                      <button className="botao claro pequeno" onClick={() => { const m = window.prompt('Motivo do cancelamento (os pontos voltam para ela):'); if (m) atender.mutate({ id: r.id, status: 'cancelado', observacao: m }); }}>Cancelar</button>
                    </div>
                  ) : <span className={`etiqueta ${r.status === 'entregue' ? 'ok' : r.status === 'cancelado' ? 'neutra' : 'alerta'}`}>{r.status}</span>}
                </td>
              </tr>
            ))}
            {!q.data?.length && <tr><td colSpan={6} className="vazio">Nenhum resgate.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Niveis() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sugestoes-nivel'], queryFn: () => api<any[]>('/pontos/niveis/sugestoes') });
  const aplicar = useMutation({ mutationFn: (d: { pessoaId: string; nivelId: string }) => api('/pontos/niveis/aplicar', { corpo: d }), onSuccess: () => qc.invalidateQueries({ queryKey: ['sugestoes-nivel'] }) });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      <p className="muted" style={{ margin: 0 }}>Pela média vendida nos 3 últimos meses completos, comparada com a meta mensal de cada nível (Configurações › Níveis). Nada muda sozinho: você aplica uma a uma.</p>
      {(q.error || aplicar.error) && <Erro erro={q.error ?? aplicar.error} />}
      <table className="tabela">
        <thead><tr><th>Representante</th><th className="num">Média mensal</th><th>Nível atual</th><th>Sugerido</th><th></th></tr></thead>
        <tbody>
          {q.data?.map((x) => (
            <tr key={x.pessoaId}>
              <td><Link to={`/rede/${x.pessoaId}`}>{x.nome}</Link><div className="muted">{x.mesesComVenda} de 3 meses com acerto</div></td>
              <td className="num">{reais(x.mediaMensal)}</td>
              <td>{x.atual?.nome ?? '—'}</td>
              <td><span className={`etiqueta ${x.sobe ? 'ok' : 'alerta'}`}>{x.sobe ? '↑' : '↓'} {x.sugerido.nome}</span></td>
              <td>{pode('rede', 'editar') && <button className="botao claro pequeno" disabled={aplicar.isPending} onClick={() => aplicar.mutate({ pessoaId: x.pessoaId, nivelId: x.sugerido.id })}>Aplicar</button>}</td>
            </tr>
          ))}
          {!q.data?.length && <tr><td colSpan={5} className="vazio">Todas as representantes estão no nível que a média de vendas indica.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Regras() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'regras_pontos'], queryFn: () => api<any>('/configuracoes/chave/regras_pontos') });
  const [v, setV] = useState<any>(null);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  const salvar = useMutation({ mutationFn: () => api('/configuracoes/chave/regras_pontos', { metodo: 'PUT', corpo: v }), onSuccess: () => qc.invalidateQueries({ queryKey: ['config', 'regras_pontos'] }) });
  const apurar = useMutation({ mutationFn: () => api<{ creditos: number }>('/pontos/apurar', { corpo: {} }) });
  if (!v) return <Carregando />;
  const num = (k: string, rotulo: string, ajuda?: string) => <Campo rotulo={rotulo} ajuda={ajuda}><input type="number" min={0} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} /></Campo>;
  const editavel = pode('configuracoes', 'editar');
  return (
    <div className="cartao form">
      <div className="secao">Como a representante ganha pontos</div>
      <label className="check l2"><input type="checkbox" checked={v.ativo} disabled={!editavel} onChange={(e) => setV({ ...v, ativo: e.target.checked })} /> Programa de pontos ligado</label>
      <Campo rotulo="Contar a partir de" ajuda="Em branco = todo o histórico"><input type="date" value={v.desde} disabled={!editavel} onChange={(e) => setV({ ...v, desde: e.target.value })} /></Campo>
      <div />
      {num('porCemReaisVendidos', 'A cada R$ 100 vendidos no acerto')}
      {num('porAcertoEmDia', 'Acerto em dia', 'Sem nenhum dia de atraso')}
      {num('porMetaBatida', 'Meta do nível batida', 'Vendido no acerto ≥ meta mensal do nível')}
      {num('porParcelaEmDia', 'Parcela paga até o vencimento')}
      <p className="muted" style={{ gridColumn: 'span 4', margin: 0 }}>Os pontos entram sozinhos depois de cada acerto completo e de cada parcela paga em dia. Mudar as regras vale para o que ainda não foi pontuado. Validade dos pontos: a definir com a Aritana.</p>
      <div className="coluna" style={{ gridColumn: 'span 4' }}>
        {(salvar.error || apurar.error) && <Erro erro={salvar.error ?? apurar.error} />}
        {salvar.isSuccess && <div className="aviso ok">Regras salvas.</div>}
        {apurar.data && <div className="aviso ok">{apurar.data.creditos} lançamento(s) novo(s).</div>}
        <div className="flex">
          {editavel && <button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button>}
          {pode('pontos', 'editar') && <button className="botao claro" disabled={apurar.isPending} onClick={() => apurar.mutate()}>Apurar pontos agora</button>}
        </div>
      </div>
    </div>
  );
}
