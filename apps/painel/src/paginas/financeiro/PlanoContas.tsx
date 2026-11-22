import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, pode } from '../../api';
import { Campo, Carregando, Erro, camposComErro } from '../../componentes/ui';
import { emArvore, usePlano, type ContaPlano } from './comum';

type Form = { id?: string; nome: string; codigo: string; paiId: string; ativo: boolean; calculada?: boolean; raiz?: boolean; sistema?: boolean };

/** Plano de contas: a árvore em que cada lançamento é classificado. Os grupos de primeiro nível são as linhas da DRE. */
export function PlanoContas({ verLancamentos }: { verLancamentos: (contaId: string) => void }) {
  const qc = useQueryClient();
  const q = usePlano();
  const [form, setForm] = useState<Form | null>(null);
  const [inativas, setInativas] = useState(false);
  const editar = pode('financeiro', 'editar');
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['plano-contas'] }); qc.invalidateQueries({ queryKey: ['dre'] }); qc.invalidateQueries({ queryKey: ['titulos'] }); };
  const salvar = useMutation({
    mutationFn: (f: Form) => api(f.id ? `/financeiro/plano-contas/${f.id}` : '/financeiro/plano-contas', { metodo: f.id ? 'PATCH' : 'POST', corpo: f.id ? { nome: f.nome, ...(f.raiz ? {} : { codigo: f.codigo || undefined, paiId: f.calculada ? undefined : f.paiId, ...(f.sistema ? {} : { ativo: f.ativo }) }) } : { nome: f.nome, paiId: f.paiId, codigo: f.codigo || undefined } }),
    onSuccess: () => { setForm(null); atualizar(); },
  });
  const excluir = useMutation({ mutationFn: (id: string) => api(`/financeiro/plano-contas/${id}`, { metodo: 'DELETE' }), onSuccess: () => { setForm(null); atualizar(); } });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const todas = emArvore(q.data!.contas);
  const visiveis = todas.filter((c) => inativas || c.ativo);
  const erros = camposComErro(salvar.error);
  const destinos = (f: Form) => {
    // Onde a conta pode entrar: qualquer grupo ou conta que não seja calculada, nem ela mesma, nem uma subconta dela.
    const proibidas = new Set<string>();
    const descer = (id: string) => { proibidas.add(id); todas.filter((c) => c.paiId === id).forEach((c) => descer(c.id)); };
    if (f.id) descer(f.id);
    return todas.filter((c) => !c.calculada && !proibidas.has(c.id) && c.nivel < 4 && (c.ativo || c.id === f.paiId));
  };
  const abrir = (c: ContaPlano) => setForm({ id: c.id, nome: c.nome, codigo: c.codigo, paiId: c.paiId ?? '', ativo: c.ativo, calculada: c.calculada, raiz: !c.paiId, sistema: c.calculada || !!c.chave });
  return (
    <div className="coluna">
      <p className="muted" style={{ margin: 0 }}>
        Os grupos numerados de 1 a 9 são as linhas da DRE. Dentro deles ficam as contas em que você classifica cada despesa e receita, com quantas subcontas precisar (até 4 níveis).
        As contas "automáticas" são preenchidas pelo sistema com as vendas, os acertos e o custo das peças. O grupo 9 guarda o que é só movimento de dinheiro e não entra no resultado.
      </p>
      <div className="flex" style={{ flexWrap: 'wrap' }}>
        {editar && <button className="botao" onClick={() => setForm({ nome: '', codigo: '', paiId: todas.find((c) => c.grupo === 'despesas_administrativas' && !c.paiId)?.id ?? '', ativo: true })}>+ Nova conta</button>}
        <label className="check"><input type="checkbox" checked={inativas} onChange={(e) => setInativas(e.target.checked)} /> Mostrar desativadas</label>
      </div>
      <div className="cartao" style={{ padding: 0 }}>
        {visiveis.map((c) => (
          <div key={c.id} className={`plano-linha ${c.paiId ? '' : 'raiz'} ${c.ativo ? '' : 'inativa'}`}>
            <div style={{ paddingLeft: (c.nivel - 1) * 20 }}>
              <span className="cod">{c.codigo}</span>{c.nome}
              {c.calculada && <span className="etiqueta neutra" style={{ marginLeft: 8 }}>automática</span>}
              {!c.calculada && c.chave && <span className="etiqueta neutra" style={{ marginLeft: 8 }} title="O sistema lança nesta conta sozinho">usada pelo sistema</span>}
              {!c.ativo && <span className="etiqueta neutra" style={{ marginLeft: 8 }}>desativada</span>}
            </div>
            <div className="acoes">
              {c.titulos > 0 && <button className="botao claro pequeno" onClick={() => verLancamentos(c.id)}>{c.titulos} lançamento(s)</button>}
              {editar && !c.calculada && c.nivel < 4 && <button className="botao claro pequeno" onClick={() => setForm({ nome: '', codigo: '', paiId: c.id, ativo: true })}>+ Subconta</button>}
              {editar && <button className="botao claro pequeno" onClick={() => abrir(c)}>Editar</button>}
            </div>
          </div>
        ))}
      </div>
      {form && (
        <div className="modal-fundo" onClick={() => setForm(null)}>
          <div className="cartao modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0 }}>{form.id ? (form.raiz ? 'Grupo da DRE' : 'Editar conta') : 'Nova conta'}</h3>
            <div className="coluna" style={{ gap: 10 }}>
              <Campo rotulo="Nome" erro={erros.nome}><input autoFocus maxLength={80} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex.: Aluguel da loja do centro" /></Campo>
              {!form.raiz && !form.calculada && (
                <Campo rotulo="Fica dentro de" erro={erros.paiId} ajuda="Mudar de grupo muda a linha da DRE em que a conta aparece, inclusive nos meses passados.">
                  <select value={form.paiId} onChange={(e) => setForm({ ...form, paiId: e.target.value })}>
                    {destinos(form).map((c) => <option key={c.id} value={c.id}>{'  '.repeat(c.nivel - 1)}{c.codigo} {c.nome}</option>)}
                  </select>
                </Campo>
              )}
              {!form.raiz && <Campo rotulo="Código" erro={erros.codigo} ajuda="Em branco, o sistema numera na sequência."><input value={form.codigo} onChange={(e) => setForm({ ...form, codigo: e.target.value.replace(/[^\d.]/g, '') })} placeholder="automático" /></Campo>}
              {form.id && !form.raiz && !form.sistema && <label className="check"><input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} /> Ativa (desativada, some das listas de escolha; o histórico continua na DRE)</label>}
              {form.sistema && <p className="muted" style={{ margin: 0 }}>Esta conta é usada pelo sistema: dá para mudar o nome{form.calculada ? '' : ' e o grupo'}, mas não desativar nem excluir.</p>}
              {form.raiz && <p className="muted" style={{ margin: 0 }}>Os grupos são as linhas da DRE: dá para mudar o nome, mas não a posição.</p>}
            </div>
            {salvar.error && <Erro erro={salvar.error} />}
            {excluir.error && <Erro erro={excluir.error} />}
            <div className="flex" style={{ marginTop: 12 }}>
              <button className="botao" disabled={salvar.isPending || form.nome.trim().length < 2 || (!form.raiz && !form.calculada && !form.paiId)} onClick={() => salvar.mutate(form)}>Salvar</button>
              <button className="botao claro" onClick={() => setForm(null)}>Voltar</button>
              {form.id && !form.raiz && !form.sistema && pode('financeiro', 'excluir') && <button className="botao perigo" style={{ marginLeft: 'auto' }} disabled={excluir.isPending} onClick={() => window.confirm(`Excluir a conta "${form.nome}"?`) && excluir.mutate(form.id!)}>Excluir</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
