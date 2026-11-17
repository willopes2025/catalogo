import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { data, dataHora, documento, paraCentavos, pct, reais, telefone } from '../../formato';
import { Campo, Carregando, Erro, Indicador, Topo, camposComErro } from '../../componentes/ui';
import { STATUS_ACORDO, STATUS_PROTESTO, useEu } from './Cobranca';
import './cobranca.css';

const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somarDias = (n: number) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const TIPOS_CONTATO: [string, string][] = [['ligacao', 'Ligação'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail'], ['visita', 'Visita'], ['nota', 'Anotação']];

export function Devedor() {
  const { pessoaId } = useParams();
  const qc = useQueryClient();
  const eu = useEu();
  const q = useQuery({ queryKey: ['cobranca', 'ficha', pessoaId], queryFn: () => api<any>(`/cobranca/devedores/${pessoaId}`) });
  const [marcados, setMarcados] = useState<string[]>([]);
  const [modal, setModal] = useState<null | { tipo: 'via'; titulo: any } | { tipo: 'acordo' } | { tipo: 'protesto' } | { tipo: 'cancelar'; acordo: any }>(null);
  const pausar = useMutation({ mutationFn: (pausada: boolean) => api(`/cobranca/devedores/${pessoaId}/pausar`, { corpo: { pausada, motivo: pausada ? window.prompt('Por que pausar a régua? (opcional)') : null } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca'] }) });
  if (q.isLoading || eu.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const f = q.data;
  const p = f.pessoa;
  const e = eu.data!;
  const selecionados = f.titulos.filter((t: any) => marcados.includes(t.id));
  const endereco = [p.logradouro, p.numero, p.complemento, p.bairro, p.cidade && `${p.cidade}/${p.uf}`, p.cep].filter(Boolean).join(', ');
  return (
    <>
      <Topo
        eb={<Link to="/cobranca?aba=carteira">Cobrança › Carteira</Link>}
        titulo={p.nome}
        sub={<>{p.tipo === 'representante' ? 'Revendedora' : 'Cliente'} · {documento(p.documento) || 'sem CPF/CNPJ'} · {telefone(p.telefone) || 'sem telefone'}{p.email ? ` · ${p.email}` : ''}</>}
        acoes={
          <div className="flex">
            {p.telefone && <a className="botao claro" href={`https://wa.me/55${p.telefone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a>}
            {p.telefone && <a className="botao claro" href={`tel:${p.telefone.replace(/\D/g, '')}`}>Ligar</a>}
            <button className="botao claro" disabled={pausar.isPending} onClick={() => pausar.mutate(!f.carteira.pausada)}>{f.carteira.pausada ? 'Retomar a régua' : 'Pausar a régua'}</button>
          </div>
        }
      />
      <div className="coluna">
        <div className="grade g4">
          <Indicador tipo="atencao" rotulo="Vencido com encargos" valor={reais(f.resumo.atualizado)} detalhe={`${f.resumo.vencidos} título(s) · ${reais(f.resumo.original)} sem multa e juros`} />
          <Indicador rotulo="Maior atraso" valor={`${f.resumo.maiorAtraso} dias`} detalhe={`Multa ${pct(f.regras.multaPb)} + juros ${pct(f.regras.jurosMesPb)} ao mês`} />
          <Indicador rotulo="A vencer" valor={reais(f.resumo.aVencer)} />
          <Indicador rotulo="Carteira" valor={f.carteira.cobrador ?? 'Sem cobrador'} detalhe={f.carteira.pausada ? `Régua pausada${f.carteira.motivoPausa ? `: ${f.carteira.motivoPausa}` : ''}` : f.carteira.desde ? `Desde ${dataHora(f.carteira.desde)}` : undefined} />
        </div>
        {pausar.error && <Erro erro={pausar.error} />}
        <div className="cob-ficha">
          <div className="coluna">
            <div className="cartao">
              <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>Títulos em aberto</h3>
                <div className="flex" style={{ flexWrap: 'wrap' }}>
                  <button className="botao pequeno" disabled={!selecionados.length || selecionados.some((t: any) => t.protesto && ['enviado', 'em_cartorio'].includes(t.protesto.status))} onClick={() => setModal({ tipo: 'acordo' })}>Fazer acordo{selecionados.length ? ` (${selecionados.length})` : ''}</button>
                  {e.gestor && <button className="botao claro pequeno" disabled={!selecionados.length} onClick={() => setModal({ tipo: 'protesto' })}>Mandar a protesto</button>}
                </div>
              </div>
              <table className="tabela">
                <thead><tr><th style={{ width: 28 }}></th><th>Título</th><th>Vencimento</th><th className="num">Valor</th><th className="num">Hoje</th><th>Boleto/Pix</th><th></th></tr></thead>
                <tbody>
                  {f.titulos.map((t: any) => (
                    <tr key={t.id}>
                      <td><input type="checkbox" aria-label={`Marcar ${t.descricao}`} checked={marcados.includes(t.id)} onChange={() => setMarcados((m) => (m.includes(t.id) ? m.filter((x) => x !== t.id) : [...m, t.id]))} /></td>
                      <td>
                        {t.descricao}
                        <div className="flex" style={{ gap: 6 }}>
                          {t.dias > 0 ? <span className="muted">{t.dias} dias de atraso</span> : <span className="muted">a vencer</span>}
                          {t.acordoId && <span className="etiqueta neutra">Acordo</span>}
                          {t.protesto && <span className={`etiqueta ${STATUS_PROTESTO[t.protesto.status]?.[1] ?? 'neutra'}`}>{STATUS_PROTESTO[t.protesto.status]?.[0] ?? t.protesto.status}</span>}
                        </div>
                      </td>
                      <td>{data(t.vencimento)}</td>
                      <td className="num">{reais(t.valor)}</td>
                      <td className="num">{t.atualizado !== t.valor ? <><b>{reais(t.atualizado)}</b><div className="muted">+{reais(t.multa)} multa, +{reais(t.juros)} juros</div></> : reais(t.valor)}</td>
                      <td>{t.cobranca ? <><a href={t.cobranca.url} target="_blank" rel="noreferrer">{t.cobranca.tipo === 'PIX' ? 'Pix' : 'Boleto'}</a><div className="muted">{reais(t.cobranca.valor)} para {data(t.cobranca.vencimento)}</div></> : <span className="muted">—</span>}</td>
                      <td>{f.asaas && <button className="botao claro pequeno" onClick={() => setModal({ tipo: 'via', titulo: t })}>2ª via</button>}</td>
                    </tr>
                  ))}
                  {!f.titulos.length && <tr><td colSpan={7} className="vazio">Nada em aberto.</td></tr>}
                </tbody>
              </table>
              {!f.asaas && <p className="muted">Ligue o Asaas em Configurações › Integrações para emitir 2ª via e boletos dos acordos.</p>}
            </div>

            {f.acordos.length > 0 && (
              <div className="cartao">
                <h3 style={{ marginTop: 0 }}>Acordos</h3>
                <table className="tabela">
                  <thead><tr><th>Nº</th><th>Feito em</th><th className="num">Dívida</th><th className="num">Desconto</th><th className="num">Total</th><th>Situação</th><th></th></tr></thead>
                  <tbody>
                    {f.acordos.map((a: any) => (
                      <tr key={a.id}>
                        <td>{a.numero}</td>
                        <td>{dataHora(a.criadoEm)}<div className="muted">{a.usuario}</div></td>
                        <td className="num">{reais(a.original + a.multa + a.juros)}</td>
                        <td className="num">{a.desconto ? reais(a.desconto) : '—'}</td>
                        <td className="num"><b>{reais(a.total)}</b><div className="muted">{a.entrada ? `${reais(a.entrada)} + ` : ''}{a.parcelas}x</div></td>
                        <td><span className={`etiqueta ${STATUS_ACORDO[a.status]?.[1]}`}>{STATUS_ACORDO[a.status]?.[0]}</span>{a.motivoEncerramento && a.status !== 'ativo' && <div className="muted">{a.motivoEncerramento}</div>}</td>
                        <td>{e.gestor && a.status === 'ativo' && <button className="botao perigo pequeno" onClick={() => setModal({ tipo: 'cancelar', acordo: a })}>Cancelar</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {f.pagos.length > 0 && (
              <div className="cartao">
                <h3 style={{ marginTop: 0 }}>Últimos pagamentos</h3>
                <table className="tabela"><tbody>{f.pagos.map((x: any) => <tr key={x.id}><td>{x.descricao}</td><td>{data(x.pagoEm)}</td><td>{x.formaPagamento ?? ''}</td><td className="num">{reais(x.valorPago ?? 0)}</td></tr>)}</tbody></table>
              </div>
            )}
            {endereco && <p className="muted">Endereço: {endereco}</p>}
          </div>

          <div className="coluna">
            <NovoContato pessoaId={pessoaId!} />
            <div className="cartao">
              <h3 style={{ marginTop: 0 }}>Histórico</h3>
              <div className="cob-linha-tempo">
                {f.contatos.map((c: any) => (
                  <div key={c.id} className={`cob-evento ${c.tipo === 'sistema' ? 'sistema' : c.tipo === 'regua' ? 'regua' : c.promessaData ? 'promessa' : ''}`}>
                    <div className="quem">{dataHora(c.criadoEm)} · {c.tipo === 'sistema' ? 'Sistema' : c.tipo === 'regua' ? 'Régua' : (TIPOS_CONTATO.find((x) => x[0] === c.tipo)?.[1] ?? c.tipo)}{c.usuario ? ` · ${c.usuario}` : ''}{c.cobrador ? ` (${c.cobrador})` : ''}</div>
                    {c.texto}
                    {c.promessaData && <div><span className={`etiqueta ${c.promessaStatus === 'cumprida' ? 'ok' : c.promessaStatus === 'quebrada' ? 'erro' : c.promessaStatus === 'aberta' ? 'alerta' : 'neutra'}`}>Promessa {c.promessaStatus}</span> para {data(c.promessaData)}{c.promessaValor ? `, ${reais(c.promessaValor)}` : ''}</div>}
                    {c.retornoEm && <div className="quem">Retornar em {data(c.retornoEm)}</div>}
                  </div>
                ))}
                {!f.contatos.length && <p className="muted">Nenhum contato ainda.</p>}
              </div>
            </div>
          </div>
        </div>
      </div>
      {modal?.tipo === 'via' && <SegundaVia titulo={modal.titulo} fechar={() => setModal(null)} />}
      {modal?.tipo === 'acordo' && <NovoAcordo pessoaId={pessoaId!} titulos={selecionados} regras={f.regras} asaas={f.asaas} fechar={() => setModal(null)} feito={() => { setMarcados([]); setModal(null); }} />}
      {modal?.tipo === 'protesto' && <MandarProtesto titulos={selecionados} ligado={e.protestoLigado} fechar={() => setModal(null)} feito={() => { setMarcados([]); setModal(null); }} />}
      {modal?.tipo === 'cancelar' && <CancelarAcordo acordo={modal.acordo} fechar={() => setModal(null)} />}
    </>
  );
}

function NovoContato({ pessoaId }: { pessoaId: string }) {
  const qc = useQueryClient();
  const vazio = { tipo: 'ligacao', texto: '', promessa: false, promessaData: '', promessaValor: '', retornoEm: '' };
  const [f, setF] = useState(vazio);
  const m = useMutation({
    mutationFn: () => api(`/cobranca/devedores/${pessoaId}/contatos`, { corpo: { tipo: f.tipo, texto: f.texto, promessaData: f.promessa ? f.promessaData || null : null, promessaValor: f.promessa && f.promessaValor ? paraCentavos(f.promessaValor) : null, retornoEm: f.retornoEm || null } }),
    onSuccess: () => { setF(vazio); qc.invalidateQueries({ queryKey: ['cobranca'] }); },
  });
  const erros = camposComErro(m.error);
  return (
    <div className="cartao">
      <h3 style={{ marginTop: 0 }}>Registrar contato</h3>
      <div className="coluna" style={{ gap: 10 }}>
        <select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })} aria-label="Tipo de contato">{TIPOS_CONTATO.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        <Campo rotulo="O que foi conversado" erro={erros.texto}><textarea value={f.texto} onChange={(e) => setF({ ...f, texto: e.target.value })} rows={3} /></Campo>
        <label className="check"><input type="checkbox" checked={f.promessa} onChange={(e) => setF({ ...f, promessa: e.target.checked })} /> Prometeu pagar</label>
        {f.promessa && (
          <div className="grade g2" style={{ gap: 8 }}>
            <Campo rotulo="Em" erro={erros.promessaData}><input type="date" min={hoje()} value={f.promessaData} onChange={(e) => setF({ ...f, promessaData: e.target.value })} /></Campo>
            <Campo rotulo="Valor (R$)" erro={erros.promessaValor}><input inputMode="decimal" value={f.promessaValor} onChange={(e) => setF({ ...f, promessaValor: e.target.value })} /></Campo>
          </div>
        )}
        <Campo rotulo="Retornar em (opcional)"><input type="date" min={hoje()} value={f.retornoEm} onChange={(e) => setF({ ...f, retornoEm: e.target.value })} /></Campo>
        {m.error && <Erro erro={m.error} />}
        <button className="botao" disabled={f.texto.trim().length < 2 || (f.promessa && !f.promessaData) || m.isPending} onClick={() => m.mutate()}>Registrar</button>
      </div>
    </div>
  );
}

function SegundaVia({ titulo, fechar }: { titulo: any; fechar: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ vencimento: somarDias(3), tipo: 'BOLETO', comEncargos: true });
  const m = useMutation({ mutationFn: () => api<any>(`/cobranca/titulos/${titulo.id}/segunda-via`, { corpo: f }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca'] }) });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>2ª via · {titulo.descricao}</h3>
        {m.data ? (
          <>
            <p>Emitido: <b>{reais(m.data.valor)}</b> para {data(m.data.vencimento)}. O boleto anterior foi apagado no Asaas e o título agora aponta para este.</p>
            {m.data.url && <p><a href={m.data.url} target="_blank" rel="noreferrer">Abrir o boleto/Pix</a></p>}
            {m.data.pixCopiaCola && <Campo rotulo="Pix copia e cola"><textarea readOnly rows={3} value={m.data.pixCopiaCola} onFocus={(e) => e.target.select()} /></Campo>}
            <div className="flex" style={{ marginTop: 12 }}><button className="botao" onClick={fechar}>Fechar</button></div>
          </>
        ) : (
          <>
            <div className="coluna" style={{ gap: 10 }}>
              <Campo rotulo="Novo vencimento"><input type="date" min={hoje()} value={f.vencimento} onChange={(e) => setF({ ...f, vencimento: e.target.value })} /></Campo>
              <Campo rotulo="Forma"><select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}><option value="BOLETO">Boleto (com Pix)</option><option value="PIX">Só Pix</option></select></Campo>
              <label className="check"><input type="checkbox" checked={f.comEncargos} onChange={(e) => setF({ ...f, comEncargos: e.target.checked })} /> Com multa e juros até o novo vencimento</label>
              <p className="muted">Valor original {reais(titulo.valor)}. Os dados de cadastro (nome, CPF, endereço, e-mail) são atualizados no Asaas junto.</p>
            </div>
            {m.error && <Erro erro={m.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Emitindo…' : 'Emitir'}</button>
              <button className="botao claro" onClick={fechar}>Voltar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NovoAcordo({ pessoaId, titulos, regras, asaas, fechar, feito }: { pessoaId: string; titulos: any[]; regras: any; asaas: boolean; fechar: () => void; feito: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ desconto: '', entrada: '', vencimentoEntrada: hoje(), parcelas: '3', primeiroVencimento: somarDias(30), cobranca: asaas ? 'BOLETO' : 'nenhuma', observacao: '' });
  const corpo = () => ({ tituloIds: titulos.map((t) => t.id), desconto: f.desconto ? paraCentavos(f.desconto) : 0, entrada: f.entrada ? paraCentavos(f.entrada) : 0, vencimentoEntrada: f.entrada ? f.vencimentoEntrada : undefined, parcelas: Number(f.parcelas) || 1, primeiroVencimento: f.primeiroVencimento });
  const chave = JSON.stringify(corpo());
  const sim = useQuery({ queryKey: ['cobranca', 'simular', pessoaId, chave], queryFn: () => api<any>(`/cobranca/devedores/${pessoaId}/acordos/simular`, { corpo: corpo() }), retry: false, staleTime: 0 });
  const criar = useMutation({ mutationFn: () => api<any>(`/cobranca/devedores/${pessoaId}/acordos`, { corpo: { ...corpo(), cobranca: f.cobranca, observacao: f.observacao || null } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca'] }) });
  const s = sim.data;
  if (criar.data)
    return (
      <div className="modal-fundo" onClick={feito}>
        <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
          <h3 style={{ marginTop: 0 }}>Acordo nº {criar.data.acordo.numero} feito</h3>
          <table className="tabela cob-parcelas"><tbody>{criar.data.parcelas.map((p: any) => <tr key={p.id}><td>{p.descricao}</td><td>{data(p.vencimento)}</td><td className="num">{reais(p.valor)}</td><td>{p.cobrancaUrl ? <a href={p.cobrancaUrl} target="_blank" rel="noreferrer">Boleto</a> : '—'}</td></tr>)}</tbody></table>
          {criar.data.avisos.map((a: string, i: number) => <p key={i} className="muted">⚠ {a}</p>)}
          <div className="flex" style={{ marginTop: 12 }}><button className="botao" onClick={feito}>Fechar</button></div>
        </div>
      </div>
    );
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h3 style={{ marginTop: 0 }}>Acordo com {titulos.length} título(s)</h3>
        <div className="form">
          <Campo rotulo="Desconto (R$)" className="l2" ajuda={`Seu limite: ${pct(regras.descontoMaxPb)} do valor com encargos`}><input inputMode="decimal" value={f.desconto} onChange={(e) => setF({ ...f, desconto: e.target.value })} placeholder="0,00" /></Campo>
          <Campo rotulo="Entrada (R$)"><input inputMode="decimal" value={f.entrada} onChange={(e) => setF({ ...f, entrada: e.target.value })} placeholder="sem entrada" /></Campo>
          <Campo rotulo="Vencimento da entrada"><input type="date" min={hoje()} disabled={!f.entrada} value={f.vencimentoEntrada} onChange={(e) => setF({ ...f, vencimentoEntrada: e.target.value })} /></Campo>
          <Campo rotulo="Parcelas" ajuda={`Até ${regras.parcelasMax}`}><input type="number" min={1} max={regras.parcelasMax} value={f.parcelas} onChange={(e) => setF({ ...f, parcelas: e.target.value })} /></Campo>
          <Campo rotulo="1ª parcela em"><input type="date" min={hoje()} value={f.primeiroVencimento} onChange={(e) => setF({ ...f, primeiroVencimento: e.target.value })} /></Campo>
          <Campo rotulo="Cobrar por" className="l2"><select value={f.cobranca} onChange={(e) => setF({ ...f, cobranca: e.target.value })}>{asaas && <option value="BOLETO">Boleto (com Pix)</option>}{asaas && <option value="PIX">Pix</option>}<option value="nenhuma">Sem boleto (recebe por fora)</option></select></Campo>
          <Campo rotulo="Observação" className="l4"><input value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} /></Campo>
        </div>
        {sim.isFetching && !s ? <Carregando /> : sim.error ? <Erro erro={sim.error} /> : s && (
          <div className="cartao" style={{ marginTop: 12, background: 'var(--creme)' }}>
            <table className="tabela cob-parcelas">
              <tbody>
                <tr><td>Dívida original</td><td className="num">{reais(s.original)}</td></tr>
                <tr><td>Multa + juros até hoje</td><td className="num">{reais(s.multa + s.juros)}</td></tr>
                <tr><td>Desconto</td><td className="num">− {reais(s.desconto)} ({pct(s.descontoPb)})</td></tr>
                <tr><td><b>Total do acordo</b></td><td className="num"><b>{reais(s.total)}</b></td></tr>
                {s.entrada && <tr><td>Entrada em {data(s.entrada.vencimento)}</td><td className="num">{reais(s.entrada.valor)}</td></tr>}
                {s.parcelas.map((p: any) => <tr key={p.numero}><td>Parcela {p.numero} em {data(p.vencimento)}</td><td className="num">{reais(p.valor)}</td></tr>)}
              </tbody>
            </table>
            <p className="muted" style={{ marginBottom: 0 }}>Os títulos escolhidos ficam como renegociados. Se o acordo quebrar, voltam a ser cobrados, já descontado o que foi pago.</p>
          </div>
        )}
        {criar.error && <Erro erro={criar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={!s || sim.isFetching || criar.isPending} onClick={() => criar.mutate()}>{criar.isPending ? 'Fazendo…' : 'Fazer o acordo'}</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

function MandarProtesto({ titulos, ligado, fechar, feito }: { titulos: any[]; ligado: boolean; fechar: () => void; feito: () => void }) {
  const qc = useQueryClient();
  const ids = titulos.map((t) => t.id);
  const conf = useQuery({ queryKey: ['cobranca', 'conferir', ids], queryFn: () => api<any>('/cobranca/protestos/conferir', { corpo: { tituloIds: ids } }), staleTime: 0 });
  const enviar = useMutation({ mutationFn: () => api<any>('/cobranca/protestos', { corpo: { tituloIds: ids } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cobranca'] }) });
  if (enviar.data)
    return (
      <div className="modal-fundo" onClick={feito}>
        <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
          <h3 style={{ marginTop: 0 }}>Enviado à CRA</h3>
          <p>{enviar.data.titulos} título(s), {reais(enviar.data.valor)}, no arquivo {enviar.data.arquivo}. O protocolo do cartório chega na confirmação (o sistema busca sozinho).</p>
          <div className="flex"><button className="botao" onClick={feito}>Fechar</button></div>
        </div>
      </div>
    );
  const c = conf.data;
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <h3 style={{ marginTop: 0 }}>Mandar a protesto</h3>
        {conf.isLoading ? <Carregando /> : conf.error ? <Erro erro={conf.error} /> : (
          <>
            <table className="tabela">
              <tbody>
                {c.itens.map((i: any) => (
                  <tr key={i.tituloId}>
                    <td>{i.descricao}<div className="muted">venceu há {i.dias} dias</div></td>
                    <td className="num">{reais(i.valor)}</td>
                    <td>{i.problemas.length ? i.problemas.map((p: string, k: number) => <div key={k} className="etiqueta alerta" style={{ whiteSpace: 'normal', display: 'block', marginBottom: 2 }}>{p}</div>) : <span className="etiqueta ok">Pronto</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">Espécie {c.especie}. A praça é a cidade do devedor (pelo CEP). Depois de enviado, o título sai da régua e não entra em acordo até a desistência.</p>
            {!ligado && <p className="muted"><b>O protesto ainda não está ligado</b> (falta o convênio com a CRA). A conferência acima já mostra o que precisa ser corrigido no cadastro.</p>}
          </>
        )}
        {enviar.error && <Erro erro={enviar.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao" disabled={!ligado || !c || c.prontos !== c.itens.length || enviar.isPending} onClick={() => window.confirm(`Mandar ${c.itens.length} título(s) a protesto?`) && enviar.mutate()}>Enviar à CRA</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}

function CancelarAcordo({ acordo, fechar }: { acordo: any; fechar: () => void }) {
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState('');
  const m = useMutation({ mutationFn: () => api<any>(`/cobranca/acordos/${acordo.id}/cancelar`, { corpo: { motivo } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['cobranca'] }); fechar(); } });
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>Cancelar o acordo nº {acordo.numero}</h3>
        <p className="muted">As parcelas em aberto são canceladas (e os boletos apagados). Os títulos de origem voltam a ser cobrados, já descontado o que foi pago no acordo.</p>
        <Campo rotulo="Motivo"><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
        {m.error && <Erro erro={m.error} />}
        <div className="flex" style={{ marginTop: 12 }}>
          <button className="botao perigo" disabled={motivo.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Cancelar o acordo</button>
          <button className="botao claro" onClick={fechar}>Voltar</button>
        </div>
      </div>
    </div>
  );
}
