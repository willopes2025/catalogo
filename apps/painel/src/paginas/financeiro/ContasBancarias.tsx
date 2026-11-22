import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { centavosParaTexto, data, paraCentavos, reais } from '../../formato';
import { Campo, Carregando, Erro, Indicador, camposComErro } from '../../componentes/ui';

const TIPOS: [string, string][] = [['banco', 'Conta em banco'], ['caixa', 'Caixa (dinheiro)'], ['carteira', 'Carteira digital (Asaas, maquininha)'], ['aplicacao', 'Aplicação']];
const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
type Form = { id?: string; empresaId: string; nome: string; tipo: string; saldoInicial: string; banco: string; agencia: string; numero: string; pix: string; observacao: string; ativo: boolean; lancamentos?: number };

/** Cadastro das contas bancárias e caixas, transferência entre elas e extrato. */
export function ContasBancarias() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contas-cadastro'], queryFn: () => api<any[]>('/financeiro/contas-cadastro') });
  const empresas = useQuery({ queryKey: ['empresas'], queryFn: () => api<any[]>('/empresas') });
  const [form, setForm] = useState<Form | null>(null);
  const [transf, setTransf] = useState<{ origemId: string; destinoId: string; valor: string; data: string; descricao: string } | null>(null);
  const [extrato, setExtrato] = useState<string | null>(null);
  const editar = pode('financeiro', 'editar');
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['contas-cadastro'] }); qc.invalidateQueries({ queryKey: ['contas'] }); qc.invalidateQueries({ queryKey: ['extrato'] }); qc.invalidateQueries({ queryKey: ['dre'] }); };
  const salvar = useMutation({
    mutationFn: (f: Form) => api(f.id ? `/financeiro/contas/${f.id}` : '/financeiro/contas', { metodo: f.id ? 'PATCH' : 'POST', corpo: { ...(f.id ? {} : { empresaId: f.empresaId }), nome: f.nome, tipo: f.tipo, saldoInicial: (f.saldoInicial.trim().startsWith('-') ? -1 : 1) * paraCentavos(f.saldoInicial.replace('-', '') || '0'), banco: f.banco || null, agencia: f.agencia || null, numero: f.numero || null, pix: f.pix || null, observacao: f.observacao || null, ativo: f.ativo } }),
    onSuccess: () => { setForm(null); atualizar(); },
  });
  const transferir = useMutation({
    mutationFn: () => api('/financeiro/transferencias', { corpo: { origemId: transf!.origemId, destinoId: transf!.destinoId, valor: paraCentavos(transf!.valor), data: transf!.data, descricao: transf!.descricao || null } }),
    onSuccess: () => { setTransf(null); atualizar(); },
  });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const lista = q.data!;
  const ativas = lista.filter((c) => c.ativo);
  const erros = camposComErro(salvar.error);
  const errosT = camposComErro(transferir.error);
  const abrir = (c: any) => setForm({ id: c.id, empresaId: c.empresaId, nome: c.nome, tipo: c.tipo, saldoInicial: centavosParaTexto(c.saldoInicial), banco: c.banco ?? '', agencia: c.agencia ?? '', numero: c.numero ?? '', pix: c.pix ?? '', observacao: c.observacao ?? '', ativo: c.ativo, lancamentos: c.lancamentos });
  return (
    <div className="coluna">
      <div className="grade g4">
        <Indicador tipo="destaque" rotulo="Saldo de todas as contas" valor={reais(ativas.reduce((a, c) => a + c.saldo, 0))} detalhe={`${ativas.length} conta(s) ativa(s)`} />
        {ativas.slice(0, 3).map((c) => <Indicador key={c.id} rotulo={c.nome} valor={reais(c.saldo)} detalhe={c.empresa} />)}
      </div>
      {editar && (
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          <button className="botao" onClick={() => setForm({ empresaId: empresas.data?.[0]?.id ?? '', nome: '', tipo: 'banco', saldoInicial: '', banco: '', agencia: '', numero: '', pix: '', observacao: '', ativo: true })}>+ Nova conta</button>
          <button className="botao claro" disabled={ativas.length < 2} onClick={() => setTransf({ origemId: ativas[0].id, destinoId: ativas[1].id, valor: '', data: hoje(), descricao: '' })}>Transferir entre contas</button>
        </div>
      )}
      <table className="tabela">
        <thead><tr><th>Conta</th><th>Tipo</th><th>Empresa</th><th>Dados</th><th className="num">Saldo inicial</th><th className="num">Saldo hoje</th><th></th></tr></thead>
        <tbody>
          {lista.map((c) => (
            <tr key={c.id} style={c.ativo ? undefined : { opacity: 0.55 }}>
              <td><b>{c.nome}</b>{!c.ativo && <span className="etiqueta neutra" style={{ marginLeft: 6 }}>Desativada</span>}{c.observacao && <div className="muted">{c.observacao}</div>}</td>
              <td>{TIPOS.find((t) => t[0] === c.tipo)?.[1] ?? c.tipo}</td>
              <td>{c.empresa}</td>
              <td className="muted">{[c.banco, c.agencia && `ag. ${c.agencia}`, c.numero && `conta ${c.numero}`, c.pix && `Pix ${c.pix}`].filter(Boolean).join(' · ') || '—'}</td>
              <td className="num">{reais(c.saldoInicial)}</td>
              <td className="num"><b>{reais(c.saldo)}</b></td>
              <td>
                <div className="flex" style={{ gap: 6 }}>
                  <button className="botao claro pequeno" onClick={() => setExtrato(c.id)}>Extrato</button>
                  {editar && <button className="botao claro pequeno" onClick={() => abrir(c)}>Editar</button>}
                </div>
              </td>
            </tr>
          ))}
          {!lista.length && <tr><td colSpan={7} className="vazio">Nenhuma conta cadastrada. Cadastre o banco e o caixa para dar baixa nos títulos.</td></tr>}
        </tbody>
      </table>
      <p className="muted" style={{ margin: 0 }}>O saldo de hoje é o saldo inicial mais tudo que foi recebido e menos tudo que foi pago por esta conta. Transferência entre contas não entra na DRE.</p>

      {form && (
        <div className="modal-fundo" onClick={() => setForm(null)}>
          <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <h3 style={{ marginTop: 0 }}>{form.id ? 'Editar conta' : 'Nova conta'}</h3>
            <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Campo rotulo="Nome" erro={erros.nome}><input autoFocus maxLength={60} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex.: Sicoob matriz" /></Campo>
              <Campo rotulo="Tipo"><select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>{TIPOS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Campo>
              <Campo rotulo="Empresa" erro={erros.empresaId}><select value={form.empresaId} disabled={!!form.id} onChange={(e) => setForm({ ...form, empresaId: e.target.value })}>{empresas.data?.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select></Campo>
              <Campo rotulo="Saldo inicial (R$)" erro={erros.saldoInicial} ajuda={form.lancamentos ? 'Mudar o saldo inicial muda o saldo de hoje.' : 'O saldo no dia em que começou a usar o sistema.'}><input inputMode="decimal" value={form.saldoInicial} onChange={(e) => setForm({ ...form, saldoInicial: e.target.value })} placeholder="0,00" /></Campo>
              {form.tipo !== 'caixa' && <>
                <Campo rotulo="Banco ou instituição"><input value={form.banco} onChange={(e) => setForm({ ...form, banco: e.target.value })} /></Campo>
                <Campo rotulo="Agência"><input value={form.agencia} onChange={(e) => setForm({ ...form, agencia: e.target.value })} /></Campo>
                <Campo rotulo="Número da conta"><input value={form.numero} onChange={(e) => setForm({ ...form, numero: e.target.value })} /></Campo>
                <Campo rotulo="Chave Pix"><input value={form.pix} onChange={(e) => setForm({ ...form, pix: e.target.value })} /></Campo>
              </>}
              <Campo rotulo="Observação" className="l2"><input maxLength={300} value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} /></Campo>
              {form.id && <label className="check l2"><input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} /> Ativa (para desativar, o saldo precisa estar zerado)</label>}
            </div>
            {salvar.error && <Erro erro={salvar.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={salvar.isPending || form.nome.trim().length < 2 || !form.empresaId} onClick={() => salvar.mutate(form)}>Salvar</button>
              <button className="botao claro" onClick={() => setForm(null)}>Voltar</button>
            </div>
          </div>
        </div>
      )}

      {transf && (
        <div className="modal-fundo" onClick={() => setTransf(null)}>
          <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h3 style={{ marginTop: 0 }}>Transferir entre contas</h3>
            <div className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Campo rotulo="Sai de" erro={errosT.origemId}><select value={transf.origemId} onChange={(e) => setTransf({ ...transf, origemId: e.target.value })}>{ativas.map((c) => <option key={c.id} value={c.id}>{c.nome} ({reais(c.saldo)})</option>)}</select></Campo>
              <Campo rotulo="Entra em" erro={errosT.destinoId}><select value={transf.destinoId} onChange={(e) => setTransf({ ...transf, destinoId: e.target.value })}>{ativas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Campo>
              <Campo rotulo="Valor (R$)" erro={errosT.valor}><input autoFocus inputMode="decimal" value={transf.valor} onChange={(e) => setTransf({ ...transf, valor: e.target.value })} /></Campo>
              <Campo rotulo="Data" erro={errosT.data}><input type="date" max={hoje()} value={transf.data} onChange={(e) => setTransf({ ...transf, data: e.target.value })} /></Campo>
              <Campo rotulo="Observação (opcional)" className="l2"><input maxLength={120} value={transf.descricao} onChange={(e) => setTransf({ ...transf, descricao: e.target.value })} placeholder="Ex.: sangria do caixa da loja" /></Campo>
            </div>
            {transferir.error && <Erro erro={transferir.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={transferir.isPending || !transf.valor || transf.origemId === transf.destinoId} onClick={() => transferir.mutate()}>Transferir</button>
              <button className="botao claro" onClick={() => setTransf(null)}>Voltar</button>
            </div>
          </div>
        </div>
      )}
      {extrato && <Extrato id={extrato} fechar={() => setExtrato(null)} />}
    </div>
  );
}

function Extrato({ id, fechar }: { id: string; fechar: () => void }) {
  const [de, setDe] = useState(`${hoje().slice(0, 8)}01`);
  const [ate, setAte] = useState(hoje());
  const q = useQuery({ queryKey: ['extrato', id, de, ate], queryFn: () => api<any>(`/financeiro/contas/${id}/extrato?de=${de}&ate=${ate}`), placeholderData: (a) => a });
  const e = q.data;
  return (
    <div className="modal-fundo" onClick={fechar}>
      <div className="cartao modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 980 }}>
        <h3 style={{ marginTop: 0 }}>Extrato{e ? ` · ${e.conta.nome}` : ''}</h3>
        <div className="busca">
          <label className="flex" style={{ gap: 6 }}>De <input type="date" value={de} max={ate} onChange={(ev) => ev.target.value && setDe(ev.target.value)} /></label>
          <label className="flex" style={{ gap: 6 }}>até <input type="date" value={ate} min={de} onChange={(ev) => ev.target.value && setAte(ev.target.value)} /></label>
        </div>
        {q.isLoading || !e ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
          <>
            <div className="grade g4" style={{ marginBottom: 12 }}>
              <Indicador rotulo="Saldo anterior" valor={reais(e.saldoAnterior)} />
              <Indicador rotulo="Entradas" valor={reais(e.entradas)} />
              <Indicador rotulo="Saídas" valor={reais(e.saidas)} />
              <Indicador tipo="destaque" rotulo="Saldo no fim" valor={reais(e.saldoFinal)} />
            </div>
            <table className="tabela">
              <thead><tr><th>Data</th><th>Descrição</th><th>Conta do plano</th><th className="num">Entrada</th><th className="num">Saída</th><th className="num">Saldo</th></tr></thead>
              <tbody>
                {e.linhas.map((l: any) => (
                  <tr key={l.id}>
                    <td>{data(l.data)}</td>
                    <td>{l.descricao}{l.pessoa && <div className="muted">{l.pessoa}</div>}</td>
                    <td>{l.conta ? `${l.codigo} ${l.conta}` : <span className="muted">Sem conta</span>}</td>
                    <td className="num">{l.tipo === 'receber' ? reais(l.valor) : ''}</td>
                    <td className="num">{l.tipo === 'pagar' ? reais(l.valor) : ''}</td>
                    <td className="num">{reais(l.saldo)}</td>
                  </tr>
                ))}
                {!e.linhas.length && <tr><td colSpan={6} className="vazio">Nenhum movimento no período.</td></tr>}
              </tbody>
            </table>
          </>
        )}
        <div className="flex" style={{ marginTop: 12 }}><button className="botao claro" onClick={fechar}>Fechar</button></div>
      </div>
    </div>
  );
}
