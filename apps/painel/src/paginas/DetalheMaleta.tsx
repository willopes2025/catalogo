import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, pode } from '../api';
import { data, dataHora, reais, telefone } from '../formato';
import { Carregando, Erro, StatusMaleta, Topo } from '../componentes/ui';
import { Leitor, type ItemLido } from '../componentes/Leitor';
import { type PecaSugerida } from '../componentes/BuscaPeca';
import { FotoPeca, LinhaFiltro, useFiltroColunas } from '../componentes/Peca';

const COLUNAS_ITENS = { codigo: (i: any) => `${i.codigoBarras ?? ''} ${i.referencia}`, descricao: (i: any) => i.descricao };

export function DetalheMaleta() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [modo, setModo] = useState<'ver' | 'incluir' | 'retirar' | 'consignataria' | 'data' | 'estornar'>('ver');
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [copiado, setCopiado] = useState(false);
  const q = useQuery({ queryKey: ['maleta', id], queryFn: () => api<any>(`/maletas/${id}`) });
  const notas = useQuery({ queryKey: ['notas-maleta', id, q.data?.acertos?.length], queryFn: async () => {
    const daMaleta = await api<any[]>(`/fiscal/notas?origemId=${id}`);
    const dosAcertos = (await Promise.all((q.data?.acertos ?? []).map((a: any) => api<any[]>(`/fiscal/notas?origemId=${a.id}`)))).flat();
    return [...daMaleta, ...dosAcertos];
  }, enabled: !!q.data && pode('fiscal', 'ver') });
  const emitir = useMutation({
    mutationFn: (alvo: { url: string; corpo?: any }) => api(alvo.url, { corpo: alvo.corpo ?? {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notas-maleta', id] }),
  });
  const troca = useMutation({
    mutationFn: () => api(`/maletas/${id}/${modo}`, { corpo: { itens: itens.map((i) => ({ codigoBarras: i.codigoBarras, quantidade: i.quantidade })) } }),
    onSuccess: () => { setItens([]); setModo('ver'); qc.invalidateQueries({ queryKey: ['maleta', id] }); },
  });
  const cancelar = useMutation({
    mutationFn: (motivo: string) => api(`/maletas/${id}/cancelar`, { corpo: { motivo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maleta', id] }),
  });
  const tabela = useFiltroColunas<any>(q.data?.itens ?? [], COLUNAS_ITENS);
  const pecasDaMaleta: PecaSugerida[] = useMemo(() => (q.data?.itens ?? []).filter((i: any) => i.naMaleta > 0).map((i: any) => ({ produtoId: i.produtoId, codigoBarras: i.codigoBarras, referencia: i.referencia, descricao: i.descricao, foto: i.foto, preco: i.preco, quantidade: i.naMaleta })), [q.data]);
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const m = q.data;
  const link = `${window.location.origin}/pedido/${m.linkToken}`;
  const whats = m.telefone ? `https://wa.me/55${m.telefone.replace(/\D/g, '')}?text=${encodeURIComponent(`Oi, ${m.representante.split(' ')[0]}! Aqui está a sua maleta nº ${m.numero} da Aritana. Confira as peças e confirme o recebimento: ${link}`)}` : null;
  const aberta = m.status === 'aberta';
  const temPrebaixa = !!m.prebaixaEm;

  return (
    <>
      <Topo
        eb={`Maletas · Nº ${m.numero}`}
        titulo={m.representante}
        sub={<><StatusMaleta status={m.status} diasAtraso={m.diasAtraso} /> &nbsp; Retirada {data(m.dataRetirada)} · Acerto até <b>{data(m.dataLimite)}</b> · {telefone(m.telefone)} · {m.cidade}</>}
        acoes={(
          <>
            <a className="botao claro" href={`/imprimir/maleta/${id}?via=pedido`} target="_blank" rel="noreferrer">Imprimir pedido</a>
            {aberta && <a className="botao claro" href={`/imprimir/maleta/${id}?via=separacao`} target="_blank" rel="noreferrer">Separação</a>}
            {aberta && pode('maletas', 'editar') && <button className="botao claro" onClick={() => { setModo(modo === 'incluir' ? 'ver' : 'incluir'); setItens([]); }}>Incluir peças</button>}
            {aberta && pode('maletas', 'editar') && <button className="botao claro" onClick={() => { setModo(modo === 'retirar' ? 'ver' : 'retirar'); setItens([]); }}>Retirar peças</button>}
            {aberta && pode('maletas', 'editar') && <button className="botao claro" onClick={() => setModo(modo === 'consignataria' ? 'ver' : 'consignataria')}>Trocar consignatária</button>}
            {aberta && pode('maletas', 'editar') && <button className="botao claro" onClick={() => setModo(modo === 'data' ? 'ver' : 'data')}>Mudar data do acerto</button>}
            {m.status !== 'cancelada' && m.acertos.length > 0 && pode('maletas', 'excluir') && <button className="botao claro" onClick={() => setModo(modo === 'estornar' ? 'ver' : 'estornar')}>Estornar acerto</button>}
            {aberta && pode('maletas', 'editar') && <Link className="botao claro" to={`/maletas/${id}/conferencia?tipo=saida`}>Conferir saída</Link>}
            {aberta && pode('maletas', 'editar') && <Link className="botao claro" to={`/maletas/${id}/conferencia?tipo=volta`}>Conferir volta</Link>}
            {aberta && pode('maletas', 'editar') && <Link className="botao" to={`/maletas/${id}/acerto`}>Fazer acerto</Link>}
          </>
        )}
      />
      <div className="grade g4" style={{ marginBottom: 14 }}>
        <div className="cartao indicador destaque"><div className="rotulo">Na maleta agora</div><div className="valor">{reais(m.totais.valor)}</div><div className="detalhe">{m.totais.pecas} peças</div></div>
        <div className="cartao indicador"><div className="rotulo">Enviado no total</div><div className="valor">{reais(m.totais.valorEnviado)}</div><div className="detalhe">{m.totais.pecasEnviadas} peças</div></div>
        <div className="cartao indicador"><div className="rotulo">Recebimento</div><div className="valor" style={{ fontSize: 18 }}>{m.recebidaEm ? `Confirmado ${dataHora(m.recebidaEm)}` : 'Aguardando'}</div><div className="detalhe">{m.entrega === 'envio' ? `Envio ${m.codigoRastreio ?? '(sem rastreio)'}` : 'Retirada presencial'}</div></div>
        <div className="cartao indicador"><div className="rotulo">Pré-baixa</div><div className="valor" style={{ fontSize: 18 }}>{temPrebaixa ? `Informada ${dataHora(m.prebaixaEm)}` : 'Não informada'}</div><div className="detalhe">o que ela diz ter vendido</div></div>
      </div>

      {aberta && (
        <div className="cartao flex entre" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <div>
            <h3>Link do pedido</h3>
            <p className="muted">A representante abre pelo celular, confere as peças, confirma o recebimento e informa o que vendeu.</p>
          </div>
          <div className="flex">
            <button className="botao claro" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopiado(true); } catch { window.prompt('Copie o link:', link); } }}>{copiado ? 'Link copiado' : 'Copiar link'}</button>
            {whats && <a className="botao" href={whats} target="_blank" rel="noreferrer">Enviar no WhatsApp</a>}
          </div>
        </div>
      )}

      {m.documentos?.map((d: any) => (
        <div key={d.id} className="cartao flex entre" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <div>
            <h3>{d.tipo === 'promissoria' ? 'Nota promissória' : d.tipo}</h3>
            <p className="muted">{d.status === 'assinado' ? 'Assinada eletronicamente pela representante.' : 'Aguardando assinatura. Envie o link junto com o do pedido, ou imprima para assinar no papel.'}</p>
          </div>
          <div className="flex">
            <span className={`etiqueta ${d.status === 'assinado' ? 'ok' : 'alerta'}`}>{d.status === 'assinado' ? 'Assinada' : 'Pendente'}</span>
            <a className="botao claro" href={`/imprimir/documento/${d.id}`} target="_blank" rel="noreferrer">Imprimir</a>
            {d.status === 'pendente' && <button className="botao claro" onClick={async () => { const l = `${window.location.origin}/assinar/${d.token}`; try { await navigator.clipboard.writeText(l); } catch { window.prompt('Copie o link:', l); } }}>Copiar link de assinatura</button>}
          </div>
        </div>
      ))}

      <AutorizacoesDaMaleta maletaId={id!} />
      {modo === 'consignataria' && <TrocarConsignataria maletaId={id!} atual={m.representanteId} valor={m.totais.valor} fechar={() => setModo('ver')} />}
      {modo === 'estornar' && <EstornarAcerto maletaId={id!} acerto={m.acertos.at(-1)} fechar={() => setModo('ver')} />}
      {modo === 'data' && <MudarDataAcerto maletaId={id!} atual={m.dataLimite} retirada={m.dataRetirada} fechar={() => setModo('ver')} />}

      {(modo === 'incluir' || modo === 'retirar') && (
        <div className="cartao coluna" style={{ marginBottom: 14 }}>
          <h3>{modo === 'incluir' ? 'Incluir peças (troca no meio do ciclo)' : 'Retirar peças que voltam para a matriz'}</h3>
          <Leitor itens={itens} mudar={setItens} localId={modo === 'incluir' ? m.origemId ?? undefined : undefined} opcoes={modo === 'retirar' ? pecasDaMaleta : undefined} />
          {troca.error && <Erro erro={troca.error} />}
          <div className="flex"><button className="botao" disabled={!itens.length || troca.isPending} onClick={() => troca.mutate()}>Confirmar</button><button className="botao claro" onClick={() => setModo('ver')}>Desistir</button></div>
        </div>
      )}

      <table className="tabela">
        <thead><tr><th></th><th>Código</th><th>Ref.</th><th>Descrição</th><th className="num">Preço</th><th className="num">Enviada</th><th className="num">Vendida</th><th className="num">Devolvida</th><th className="num">Perdida</th><th className="num">Na maleta</th>{temPrebaixa && <th className="num">Pré-baixa: vendeu</th>}</tr>
          {m.itens.length > 1 && <LinhaFiltro celulas={[null, 'codigo', 'codigo', 'descricao', null, null, null, null, null, null, ...(temPrebaixa ? [null] : [])]} filtro={tabela.filtro} setFiltro={tabela.setFiltro} />}
        </thead>
        <tbody>
          {tabela.filtrados.map((i: any) => (
            <tr key={i.id}>
              <td><FotoPeca src={i.foto} alt={i.descricao} /></td>
              <td className="muted">{i.codigoBarras}</td><td>{i.referencia}</td><td>{i.descricao}</td><td className="num">{reais(i.preco)}</td>
              <td className="num">{i.enviada}</td><td className="num">{i.vendida || '—'}</td><td className="num">{i.devolvida || '—'}</td><td className="num">{i.perdida || '—'}</td><td className="num"><b>{i.naMaleta}</b></td>
              {temPrebaixa && <td className="num">{i.prebaixaVendida ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>

      {m.conferencias?.length > 0 && (
        <div className="cartao" style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 8 }}>Conferências</h3>
          {m.conferencias.map((c: any) => (
            <details key={c.id} className="resumo-linha" style={{ display: 'block' }}>
              <summary style={{ cursor: 'pointer' }}>
                {c.tipo === 'saida' ? 'Saída' : 'Volta'} · {dataHora(c.criadoEm)} · conferido por <b>{c.conferidoPor ?? '—'}</b> · {c.conferidas} de {c.esperadas} peças
                {c.faltando > 0 && <> · <span className="etiqueta alerta">faltaram {c.faltando}</span> {c.tratamento === 'retirar' ? '(tiradas da maleta)' : c.tratamento === 'cobrar' ? '(cobrar pelo custo)' : c.tratamento === 'investigar' ? '(investigar)' : ''}</>}
                {c.sobras.length > 0 && <> · <span className="etiqueta neutra">sobraram {c.sobras.reduce((a: number, x: any) => a + x.quantidade, 0)}</span></>}
              </summary>
              {c.observacao && <p style={{ margin: '6px 0' }}><b>Observação:</b> {c.observacao}</p>}
              {c.itens.filter((i: any) => i.conferido < i.esperado).length > 0 && <p style={{ margin: '6px 0' }}><b>Faltou:</b> {c.itens.filter((i: any) => i.conferido < i.esperado).map((i: any) => `${i.esperado - i.conferido}× ${i.descricao}`).join('; ')}</p>}
              {c.sobras.length > 0 && <p style={{ margin: '6px 0' }}><b>Sobrou:</b> {c.sobras.map((x: any) => `${x.quantidade}× ${x.descricao ?? `código ${x.codigo}`}`).join('; ')}</p>}
            </details>
          ))}
        </div>
      )}

      {m.acertos.length > 0 && (
        <div className="cartao" style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 8 }}>Acertos</h3>
          {m.acertos.map((a: any) => (
            <div key={a.id} className="resumo-linha">
              <span>{data(a.data)} · {a.parcial ? 'Parcial' : 'Final'} · {a.forma === 'avista' ? 'à vista' : 'a prazo'} · {a.modalidade} · vendido {reais(a.resultado.totalVendido)} · comissão {reais(a.resultado.comissao)}{a.resultado.multa ? ` · multa e juros ${reais(a.resultado.multa + a.resultado.juros)}` : ''}</span>
              <b>{reais(a.totalAPagar)}{a.parcelas > 1 ? ` em ${a.parcelas}x` : ''}</b>
            </div>
          ))}
        </div>
      )}

      {pode('fiscal', 'ver') && (
        <div className="cartao" style={{ marginTop: 14 }}>
          <div className="flex entre" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <h3>Notas fiscais</h3>
            {pode('fiscal', 'criar') && (
              <div className="flex" style={{ flexWrap: 'wrap', gap: 6 }}>
                {!notas.data?.some((n) => n.operacao === 'remessa_consignacao' && n.status !== 'cancelada') && <button className="botao claro pequeno" disabled={emitir.isPending} onClick={() => emitir.mutate({ url: `/fiscal/nfe/maleta/${id}` })}>Emitir NF-e de remessa</button>}
                {m.acertos.map((a: any) => (
                  <span key={a.id} className="flex" style={{ gap: 6 }}>
                    {a.resultado.pecas.devolvidas > 0 && !notas.data?.some((n) => n.origemId === a.id && n.operacao === 'retorno_consignacao' && n.status !== 'cancelada') && <button className="botao claro pequeno" disabled={emitir.isPending} onClick={() => emitir.mutate({ url: `/fiscal/nfe/acerto/${a.id}`, corpo: { operacao: 'retorno_consignacao' } })}>Nota de retorno ({data(a.data)})</button>}
                    {a.resultado.pecas.vendidas > 0 && !notas.data?.some((n) => n.origemId === a.id && n.operacao === 'venda_consignacao' && n.status !== 'cancelada') && <button className="botao claro pequeno" disabled={emitir.isPending} onClick={() => emitir.mutate({ url: `/fiscal/nfe/acerto/${a.id}`, corpo: { operacao: 'venda_consignacao' } })}>Nota de venda ({data(a.data)})</button>}
                  </span>
                ))}
              </div>
            )}
          </div>
          {emitir.error && <Erro erro={emitir.error} />}
          {notas.data?.length ? notas.data.map((n) => (
            <div key={n.id} className="resumo-linha">
              <span>{n.operacao.replace(/_/g, ' ')} · {n.numero ? `nº ${n.numero}` : 'sem número'} · {reais(n.valor)}{n.mensagem && n.status === 'erro' ? ` · ${n.mensagem}` : ''}</span>
              <span className="flex" style={{ gap: 6 }}>
                <span className={`etiqueta ${n.status === 'autorizada' ? 'ok' : n.status === 'erro' ? 'erro' : 'alerta'}`}>{n.status}</span>
                {n.urlDanfe && <a className="botao claro pequeno" href={n.urlDanfe} target="_blank" rel="noreferrer">DANFE</a>}
              </span>
            </div>
          )) : <p className="muted">Nenhuma nota emitida para esta maleta.</p>}
        </div>
      )}

      {aberta && pode('maletas', 'excluir') && m.acertos.length === 0 && (
        <div style={{ marginTop: 20 }}>
          {cancelar.error && <Erro erro={cancelar.error} />}
          <button className="botao perigo" onClick={() => { const motivo = window.prompt('Motivo do cancelamento (todas as peças voltam ao estoque):'); if (motivo && motivo.trim().length >= 3) cancelar.mutate(motivo.trim()); }}>Cancelar maleta</button>
        </div>
      )}
    </>
  );
}

/** Passa a maleta para outra consignatária: confere o crédito dela e gera a promissória nova para assinar. */
function TrocarConsignataria({ maletaId, atual, valor, fechar }: { maletaId: string; atual: string; valor: number; fechar: () => void }) {
  const qc = useQueryClient();
  const [busca, setBusca] = useState('');
  const [escolhida, setEscolhida] = useState<{ id: string; nome: string } | null>(null);
  const [motivo, setMotivo] = useState('');
  const [excecao, setExcecao] = useState(false);
  const reps = useQuery({ queryKey: ['maleta-troca-reps', busca], enabled: busca.trim().length >= 2 && !escolhida, queryFn: () => api<{ itens: { id: string; nome: string; cidade: string | null; status: string }[] }>(`/pessoas?tipo=representante&busca=${encodeURIComponent(busca.trim())}`) });
  const sit = useQuery({ queryKey: ['maleta-troca-sit', escolhida?.id], enabled: !!escolhida, queryFn: () => api<{ creditoLivre: number; limite: number; emMaletas: number }>(`/maletas/situacao/${escolhida!.id}`) });
  const trocar = useMutation({
    mutationFn: () => api(`/maletas/${maletaId}/consignataria`, { corpo: { representanteId: escolhida!.id, motivo, liberarExcecao: excecao } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maleta', maletaId] }); fechar(); },
  });
  const passa = sit.data && valor > sit.data.creditoLivre;
  return (
    <div className="cartao coluna" style={{ marginBottom: 14 }}>
      <h3>Trocar a consignatária</h3>
      <p className="muted" style={{ margin: 0 }}>A maleta inteira passa para outra consignatária, com as peças que estão nela ({reais(valor)}). O crédito dela é conferido, a promissória da anterior é cancelada e sai uma nova para a nova consignatária assinar.</p>
      {!escolhida ? (
        <div className="coluna" style={{ gap: 6 }}>
          <input id="troca-busca" autoFocus placeholder="Nome, CPF ou telefone da nova consignatária" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {reps.data?.itens.filter((r) => r.id !== atual).slice(0, 8).map((r) => (
            <button key={r.id} className="botao claro" style={{ justifyContent: 'flex-start' }} onClick={() => setEscolhida({ id: r.id, nome: r.nome })}>{r.nome}{r.cidade ? ` · ${r.cidade}` : ''}{r.status !== 'ativo' ? ` (${r.status})` : ''}</button>
          ))}
          {reps.data && !reps.data.itens.filter((r) => r.id !== atual).length && <span className="muted">Ninguém encontrado.</span>}
        </div>
      ) : (
        <div className="coluna" style={{ gap: 8 }}>
          <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{escolhida.nome}</b>
            {sit.data && <span className={`etiqueta ${passa ? 'erro' : 'ok'}`}>Crédito livre {reais(sit.data.creditoLivre)}</span>}
            <button className="botao claro pequeno" onClick={() => { setEscolhida(null); setExcecao(false); }}>Trocar</button>
          </div>
          {passa && <div className="aviso alerta">As peças da maleta ({reais(valor)}) passam do crédito livre dela.{pode('configuracoes', 'editar') ? '' : ' Só a gestão pode liberar.'}</div>}
          {passa && pode('configuracoes', 'editar') && <label className="check"><input type="checkbox" checked={excecao} onChange={(e) => setExcecao(e.target.checked)} /> Liberar mesmo assim (exceção registrada)</label>}
          <textarea id="troca-motivo" rows={2} maxLength={300} placeholder="Motivo da troca (fica no histórico da maleta)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </div>
      )}
      {trocar.error && <Erro erro={trocar.error} />}
      <div className="flex">
        <button className="botao" disabled={!escolhida || motivo.trim().length < 3 || trocar.isPending || (!!passa && !excecao)} onClick={() => trocar.mutate()}>{trocar.isPending ? 'Trocando…' : 'Confirmar a troca'}</button>
        <button className="botao claro" onClick={fechar}>Desistir</button>
      </div>
    </div>
  );
}

/** Data do acerto: a gerência muda direto; os outros mandam o pedido para a gerência autorizar. */
function MudarDataAcerto({ maletaId, atual, retirada, fechar }: { maletaId: string; atual: string; retirada: string; fechar: () => void }) {
  const qc = useQueryClient();
  const gerencia = pode('maletas', 'excluir');
  const [dataNova, setDataNova] = useState(atual);
  const [motivo, setMotivo] = useState('');
  const mudar = useMutation({
    mutationFn: () => api<{ aplicada: boolean }>(`/maletas/${maletaId}/data-acerto`, { corpo: { dataLimite: dataNova, motivo } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['maleta', maletaId] }); qc.invalidateQueries({ queryKey: ['maleta-solicitacoes'] }); if (r.aplicada) fechar(); },
  });
  return (
    <div className="cartao coluna" style={{ marginBottom: 14 }}>
      <h3>Mudar a data do acerto</h3>
      <p className="muted" style={{ margin: 0 }}>{gerencia ? 'Você é da gerência: a data muda na hora e a promissória é refeita.' : 'A mudança vai para a gerência autorizar. Enquanto isso, vale a data atual.'}</p>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="campo">Nova data<input id="data-acerto-nova" type="date" min={retirada} value={dataNova} onChange={(e) => setDataNova(e.target.value)} /></label>
        <span className="muted">hoje: acerto até {data(atual)}</span>
      </div>
      <textarea id="data-acerto-motivo" rows={2} maxLength={300} placeholder="Motivo (ex.: consultora viajou, combinado com a gerência)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      {mudar.error && <Erro erro={mudar.error} />}
      {mudar.data && !mudar.data.aplicada && <div className="aviso ok">Pedido enviado para a gerência autorizar.</div>}
      <div className="flex">
        <button className="botao" disabled={!dataNova || dataNova === atual || motivo.trim().length < 3 || mudar.isPending} onClick={() => mudar.mutate()}>{gerencia ? 'Mudar a data' : 'Pedir autorização'}</button>
        <button className="botao claro" onClick={fechar}>Fechar</button>
      </div>
    </div>
  );
}

type Solicitacao = { id: string; maletaId: string; numero: number; representante: string; tipo: string; dados: { de?: string; para?: string }; motivo: string; status: string; pedidoPor: string | null; criadoEm: string };

/** Pedidos de autorização da maleta (ou de todas): a gerência aprova ou recusa aqui. */
export function AutorizacoesDaMaleta({ maletaId }: { maletaId?: string }) {
  const qc = useQueryClient();
  const gerencia = pode('maletas', 'excluir');
  const q = useQuery({ queryKey: ['maleta-solicitacoes', maletaId ?? 'todas'], queryFn: () => api<Solicitacao[]>(`/maletas/solicitacoes${maletaId ? `?maletaId=${maletaId}` : ''}`), refetchInterval: 60_000 });
  const decidir = useMutation({
    mutationFn: (v: { id: string; aprovar: boolean; observacao?: string | null }) => api(`/maletas/solicitacoes/${v.id}/decidir`, { corpo: { aprovar: v.aprovar, observacao: v.observacao ?? null } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maleta-solicitacoes'] }); qc.invalidateQueries({ queryKey: ['maleta'] }); qc.invalidateQueries({ queryKey: ['maletas'] }); },
  });
  if (!q.data?.length) return null;
  return (
    <div className="cartao coluna" style={{ marginBottom: 14, borderColor: 'var(--dourado)' }}>
      <h3>{gerencia ? 'Pedidos esperando sua autorização' : 'Pedidos esperando a gerência'}</h3>
      {q.data.map((s) => (
        <div key={s.id} className="flex entre" style={{ gap: 10, flexWrap: 'wrap', borderTop: '1px solid var(--linha)', paddingTop: 8 }}>
          <div>
            {!maletaId && <><Link to={`/maletas/${s.maletaId}`}>Maleta nº {s.numero}</Link> · {s.representante} · </>}
            <b>Data do acerto</b> de {data(s.dados.de ?? '')} para <b>{data(s.dados.para ?? '')}</b>
            <div className="muted" style={{ fontSize: 13 }}>{s.pedidoPor ?? 'Alguém'} pediu em {dataHora(s.criadoEm)}: “{s.motivo}”</div>
          </div>
          {gerencia && (
            <div className="flex">
              <button className="botao pequeno" disabled={decidir.isPending} onClick={() => decidir.mutate({ id: s.id, aprovar: true })}>Autorizar</button>
              <button className="botao claro pequeno" disabled={decidir.isPending} onClick={() => { const o = window.prompt('Motivo da recusa (opcional):'); if (o !== null) decidir.mutate({ id: s.id, aprovar: false, observacao: o.trim() || null }); }}>Recusar</button>
            </div>
          )}
        </div>
      ))}
      {decidir.error && <Erro erro={decidir.error} />}
    </div>
  );
}

/** Estorna o último acerto: peças voltam para a maleta, parcelas canceladas, maleta aberta de novo. Só a gerência. */
function EstornarAcerto({ maletaId, acerto, fechar }: { maletaId: string; acerto: any; fechar: () => void }) {
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState('');
  const [certeza, setCerteza] = useState(false);
  const estornar = useMutation({
    mutationFn: () => api<{ parcelasCanceladas: number; viraCredito: number }>(`/maletas/${maletaId}/estornar-acerto`, { corpo: { motivo: motivo.trim() } }),
    onSuccess: () => { qc.invalidateQueries(); },
  });
  if (estornar.data)
    return (
      <div className="cartao coluna aviso ok" style={{ marginBottom: 14 }}>
        <b>Acerto estornado.</b>
        <span>A maleta está aberta de novo com as peças, e {estornar.data.parcelasCanceladas} parcela(s) do acerto foram canceladas (e os boletos apagados no Asaas).{estornar.data.viraCredito > 0 ? ` ${reais(estornar.data.viraCredito)} que já tinham sido pagos viraram crédito da representante.` : ''}</span>
        <div><button className="botao claro" onClick={fechar}>Fechar</button></div>
      </div>
    );
  return (
    <div className="cartao coluna" style={{ marginBottom: 14 }}>
      <h3 style={{ margin: 0 }}>Estornar o acerto{acerto ? ` de ${data(acerto.data)}` : ''}</h3>
      <p className="muted" style={{ margin: 0 }}>
        Desfaz o último acerto: as peças vendidas, devolvidas e perdidas voltam para a maleta, as parcelas do acerto são canceladas (boletos apagados no Asaas),
        o crédito usado volta, os pontos do acerto saem e o limite volta ao de antes. A maleta fica aberta e a representante volta a dever. Parcela marcada como paga no próprio acerto
        só é cancelada; pagamento que entrou de verdade depois vira crédito dela.
      </p>
      <label className="campo"><span>Motivo</span><input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: fecharam o acerto por engano" maxLength={300} /></label>
      <label className="check"><input type="checkbox" checked={certeza} onChange={(e) => setCerteza(e.target.checked)} /> Entendi: o acerto será desfeito</label>
      {estornar.error && <Erro erro={estornar.error} />}
      <div className="flex">
        <button className="botao perigo" disabled={motivo.trim().length < 3 || !certeza || estornar.isPending} onClick={() => estornar.mutate()}>{estornar.isPending ? 'Estornando…' : 'Estornar acerto'}</button>
        <button className="botao claro" onClick={fechar}>Desistir</button>
      </div>
    </div>
  );
}
