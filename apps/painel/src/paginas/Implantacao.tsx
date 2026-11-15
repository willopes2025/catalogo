import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { dataHora } from '../formato';
import { Carregando, Erro } from '../componentes/ui';

interface Item {
  chave: string;
  grupo: string;
  titulo: string;
  descricao: string;
  status: 'ok' | 'pendente' | 'atencao' | 'opcional';
  detalhe?: string;
  link?: string;
  manual?: boolean;
  confirmadoPor?: string | null;
  confirmadoEm?: string | null;
}

const ROTULO: Record<Item['status'], [string, string]> = { ok: ['ok', 'Pronto'], pendente: ['erro', 'Falta'], atencao: ['alerta', 'Em teste'], opcional: ['neutra', 'Opcional'] };

export const usarImplantacao = () => useQuery({ queryKey: ['implantacao'], queryFn: () => api<{ itens: Item[]; feitos: number; total: number; importadosJueri: number }>('/implantacao'), enabled: pode('configuracoes', 'ver') });

/** O que falta para a Aritana começar a usar de verdade. */
export function Implantacao() {
  const qc = useQueryClient();
  const q = usarImplantacao();
  const confirmar = useMutation({ mutationFn: (d: { chave: string; feito: boolean }) => api('/implantacao/confirmar', { corpo: d }), onSuccess: () => qc.invalidateQueries({ queryKey: ['implantacao'] }) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { itens, feitos, total } = q.data!;
  const grupos = [...new Set(itens.map((i) => i.grupo))];
  const pct = Math.round((feitos / total) * 100);
  return (
    <div className="coluna">
      <div className="cartao">
        <div className="flex entre" style={{ flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>{feitos} de {total} itens prontos</h2>
            <p className="muted" style={{ margin: '4px 0 0' }}>O sistema já funciona. Estes são os acessos, textos e confirmações que faltam para usar de verdade, em produção.</p>
          </div>
          <b style={{ fontSize: 28 }}>{pct}%</b>
        </div>
        <div style={{ height: 8, background: 'var(--creme-2)', borderRadius: 4, marginTop: 12, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--marrom)' }} />
        </div>
      </div>
      {confirmar.error && <Erro erro={confirmar.error} />}
      <details className="cartao">
        <summary style={{ fontWeight: 600, cursor: 'pointer' }}>Roteiro do dia da virada (saída do Jueri)</summary>
        <ol style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
          <li>Combine a data com a equipe e avise as revendedoras: a partir dela, acertos e pedidos são pelo sistema novo.</li>
          <li>No Jueri, termine os lançamentos do dia e peça para ninguém lançar mais nada.</li>
          <li>Aqui, em <Link to="/configuracoes?aba=importacao">Importar planilhas</Link>, marque <b>todas as partes</b>, clique em <b>Simular</b> e confira o relatório.</li>
          <li>Clique em <b>Importar de verdade</b>. Maletas e contas que já tinham vindo acompanham o Jueri: as acertadas ou pagas lá são encerradas aqui.</li>
          <li>Confira três maletas e três revendedoras por amostragem (peças, valores e saldo) comparando com o Jueri.</li>
          <li>No <Link to="/financeiro">Financeiro</Link>, ligue as contas que ficaram sem pessoa e confira o total a receber.</li>
          <li>Apague o token no Jueri e em <Link to="/configuracoes?aba=integracoes">Integrações</Link>, e marque os itens da Virada abaixo.</li>
        </ol>
      </details>
      {grupos.map((g) => (
        <div key={g} className="cartao">
          <div className="secao" style={{ marginTop: 0 }}>{g}</div>
          {itens.filter((i) => i.grupo === g).map((i) => (
            <div key={i.chave} className="flex entre" style={{ padding: '10px 0', borderBottom: '1px dashed var(--linha)', alignItems: 'flex-start', gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{i.titulo}</div>
                <div className="muted">{i.descricao}</div>
                {i.detalhe && <div className="muted" style={{ color: i.status === 'ok' ? undefined : 'var(--erro)' }}>{i.detalhe}</div>}
                {i.manual && i.confirmadoPor && <div className="muted">Confirmado por {i.confirmadoPor} em {dataHora(i.confirmadoEm)}</div>}
              </div>
              <div className="flex" style={{ gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {i.link && i.status !== 'ok' && <Link className="botao claro pequeno" to={i.link}>Resolver</Link>}
                {i.manual && pode('configuracoes', 'editar') && (
                  <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={i.status === 'ok'} disabled={confirmar.isPending} onChange={(e) => confirmar.mutate({ chave: i.chave, feito: e.target.checked })} /> Feito</label>
                )}
                <span className={`etiqueta ${ROTULO[i.status][0]}`}>{ROTULO[i.status][1]}</span>
              </div>
            </div>
          ))}
          {g === 'Virada' && <ApagarDadosDeTeste pendente={itens.find((i) => i.chave === 'dados_teste')?.status !== 'ok'} />}
        </div>
      ))}
    </div>
  );
}

function ApagarDadosDeTeste({ pendente }: { pendente: boolean }) {
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [f, setF] = useState({ confirmacao: '', manterProdutos: false, manterPessoas: false, apagarImportados: false });
  const importados = usarImplantacao().data?.importadosJueri ?? 0;
  const m = useMutation({ mutationFn: () => api<{ antes: any; depois: any }>('/implantacao/apagar-dados-de-teste', { corpo: f }), onSuccess: () => { qc.invalidateQueries(); setAberto(false); } });
  if (!pode('configuracoes', 'excluir')) return null;
  return (
    <div style={{ marginTop: 14 }}>
      {m.data && <div className="aviso ok">Dados apagados: {m.data.antes.maletas} maleta(s), {m.data.antes.vendas} venda(s), {m.data.antes.titulos} título(s){m.data.depois.pessoas === 0 ? `, ${m.data.antes.pessoas} cadastro(s)` : ''}{m.data.depois.produtos === 0 ? `, ${m.data.antes.produtos} produto(s)` : ''}.</div>}
      {!aberto ? (
        <button className={`botao ${pendente ? '' : 'claro'}`} onClick={() => setAberto(true)}>Apagar dados de teste…</button>
      ) : (
        <div className="aviso alerta coluna" style={{ gap: 10 }}>
          <b>Isto apaga de vez: maletas, acertos, vendas, caixas, títulos, créditos, notas, garantias, comissões e todo o histórico de estoque.</b>
          <span>Ficam: empresas, locais, usuários e grupos, níveis, categorias, contas, regras, modelos de documento, integrações e a auditoria. A numeração de maletas e vendas volta para 1. O servidor guarda uma cópia do banco toda madrugada.</span>
          <label className="check"><input type="checkbox" checked={f.manterProdutos} onChange={(e) => setF({ ...f, manterProdutos: e.target.checked })} /> Manter os produtos cadastrados (o estoque fica zerado)</label>
          <label className="check"><input type="checkbox" checked={f.manterPessoas} onChange={(e) => setF({ ...f, manterPessoas: e.target.checked })} /> Manter representantes, clientes e fornecedores</label>
          {importados > 0 && (
            <>
              <b style={{ color: 'var(--erro)' }}>Atenção: o sistema já tem {importados.toLocaleString('pt-BR')} registros importados do Jueri. Apagar agora apaga também as maletas, o estoque e as contas reais. Na virada não é preciso apagar: a importação atualiza tudo.</b>
              <label className="check"><input type="checkbox" checked={f.apagarImportados} onChange={(e) => setF({ ...f, apagarImportados: e.target.checked })} /> Entendo e quero apagar também os dados do Jueri (vou importar de novo)</label>
            </>
          )}
          <div className="flex" style={{ flexWrap: 'wrap' }}>
            <input placeholder="Digite APAGAR" value={f.confirmacao} onChange={(e) => setF({ ...f, confirmacao: e.target.value })} style={{ maxWidth: 180 }} />
            <button className="botao" disabled={f.confirmacao !== 'APAGAR' || (importados > 0 && !f.apagarImportados) || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Apagando…' : 'Apagar agora'}</button>
            <button className="botao claro" onClick={() => setAberto(false)}>Desistir</button>
          </div>
          {m.error && <Erro erro={m.error} />}
        </div>
      )}
    </div>
  );
}
