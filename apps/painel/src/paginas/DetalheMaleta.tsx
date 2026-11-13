import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, pode } from '../api';
import { data, dataHora, reais, telefone } from '../formato';
import { Carregando, Erro, StatusMaleta, Topo } from '../componentes/ui';
import { Leitor, type ItemLido } from '../componentes/Leitor';

export function DetalheMaleta() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [modo, setModo] = useState<'ver' | 'incluir' | 'retirar'>('ver');
  const [itens, setItens] = useState<ItemLido[]>([]);
  const [copiado, setCopiado] = useState(false);
  const q = useQuery({ queryKey: ['maleta', id], queryFn: () => api<any>(`/maletas/${id}`) });
  const troca = useMutation({
    mutationFn: () => api(`/maletas/${id}/${modo}`, { corpo: { itens: itens.map((i) => ({ codigoBarras: i.codigoBarras, quantidade: i.quantidade })) } }),
    onSuccess: () => { setItens([]); setModo('ver'); qc.invalidateQueries({ queryKey: ['maleta', id] }); },
  });
  const cancelar = useMutation({
    mutationFn: (motivo: string) => api(`/maletas/${id}/cancelar`, { corpo: { motivo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maleta', id] }),
  });
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

      {modo !== 'ver' && (
        <div className="cartao coluna" style={{ marginBottom: 14 }}>
          <h3>{modo === 'incluir' ? 'Incluir peças (troca no meio do ciclo)' : 'Retirar peças que voltam para a matriz'}</h3>
          <Leitor itens={itens} mudar={setItens} />
          {troca.error && <Erro erro={troca.error} />}
          <div className="flex"><button className="botao" disabled={!itens.length || troca.isPending} onClick={() => troca.mutate()}>Confirmar</button><button className="botao claro" onClick={() => setModo('ver')}>Desistir</button></div>
        </div>
      )}

      <table className="tabela">
        <thead><tr><th>Código</th><th>Ref.</th><th>Descrição</th><th className="num">Preço</th><th className="num">Enviada</th><th className="num">Vendida</th><th className="num">Devolvida</th><th className="num">Perdida</th><th className="num">Na maleta</th>{temPrebaixa && <th className="num">Pré-baixa: vendeu</th>}</tr></thead>
        <tbody>
          {m.itens.map((i: any) => (
            <tr key={i.id}>
              <td className="muted">{i.codigoBarras}</td><td>{i.referencia}</td><td>{i.descricao}</td><td className="num">{reais(i.preco)}</td>
              <td className="num">{i.enviada}</td><td className="num">{i.vendida || '—'}</td><td className="num">{i.devolvida || '—'}</td><td className="num">{i.perdida || '—'}</td><td className="num"><b>{i.naMaleta}</b></td>
              {temPrebaixa && <td className="num">{i.prebaixaVendida ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>

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

      {aberta && pode('maletas', 'excluir') && m.acertos.length === 0 && (
        <div style={{ marginTop: 20 }}>
          {cancelar.error && <Erro erro={cancelar.error} />}
          <button className="botao perigo" onClick={() => { const motivo = window.prompt('Motivo do cancelamento (todas as peças voltam ao estoque):'); if (motivo && motivo.trim().length >= 3) cancelar.mutate(motivo.trim()); }}>Cancelar maleta</button>
        </div>
      )}
    </>
  );
}
