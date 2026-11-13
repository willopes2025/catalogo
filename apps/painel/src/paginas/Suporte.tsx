import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULOS } from '@aritana/regras';
import { api } from '../api';
import { dataHora } from '../formato';
import { Campo, Carregando, Erro, Topo } from '../componentes/ui';

const STATUS: Record<string, [string, string]> = { aberto: ['alerta', 'Aberto'], em_analise: ['alerta', 'Em análise'], em_desenvolvimento: ['marrom', 'Em desenvolvimento'], resolvido: ['ok', 'Resolvido'] };
const TIPO: Record<string, string> = { duvida: 'Dúvida', erro: 'Erro', melhoria: 'Melhoria' };

export function Suporte() {
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ['chamados'], queryFn: () => api<any[]>('/suporte/chamados') });
  const status = useQuery({ queryKey: ['suporte-status'], queryFn: () => api<any>('/suporte/status') });
  const [sel, setSel] = useState<string | null>(null);
  const [novo, setNovo] = useState(false);
  return (
    <>
      <Topo eb="Suporte" titulo="Fale com a Wide" sub="12 meses de suporte, correções e ajustes incluídos." acoes={<button className="botao" onClick={() => { setNovo(true); setSel(null); }}>Abrir chamado</button>} />
      <div className="grade" style={{ gridTemplateColumns: '1fr 320px', alignItems: 'start' }}>
        <div className="coluna">
          {novo && <NovoChamado aoCriar={(id) => { setNovo(false); setSel(id); qc.invalidateQueries({ queryKey: ['chamados'] }); }} />}
          {sel && <Chamado id={sel} />}
          {lista.isLoading ? <Carregando /> : lista.data!.length === 0 ? <div className="cartao vazio">Nenhum chamado ainda.</div> : (
            <table className="tabela">
              <thead><tr><th>Nº</th><th>Assunto</th><th>Tipo</th><th>Quem abriu</th><th>Atualizado</th><th>Situação</th></tr></thead>
              <tbody>{lista.data!.map((c) => { const [k, t] = STATUS[c.status] ?? ['neutra', c.status]; return <tr key={c.id} className="clicavel" onClick={() => { setSel(c.id); setNovo(false); }}><td><b>{c.numero}</b></td><td>{c.titulo}</td><td>{TIPO[c.tipo]}</td><td>{c.autor}</td><td>{dataHora(c.atualizadoEm)}</td><td><span className={`etiqueta ${k}`}>{t}</span></td></tr>; })}</tbody>
            </table>
          )}
        </div>
        <div className="cartao coluna">
          <h3>Status do sistema</h3>
          {status.data && (
            <>
              <div className="resumo-linha"><span>Sistema</span><span className="etiqueta ok">No ar</span></div>
              <div className="resumo-linha"><span>Banco de dados</span><span>{status.data.sistema.banco}</span></div>
              {status.data.integracoes.map((i: any) => <div key={i.nome} className="resumo-linha"><span>{i.nome}</span>{i.ligada ? <span className="etiqueta ok">Ligada</span> : <span className="etiqueta neutra">Desligada</span>}</div>)}
              <div className="resumo-linha"><span>Último backup</span><span className="muted">{status.data.ultimoBackup ?? 'configurado na VPS'}</span></div>
              <p className="muted">Versão {status.data.sistema.versao}</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function NovoChamado({ aoCriar }: { aoCriar: (id: string) => void }) {
  const [f, setF] = useState({ titulo: '', tipo: 'duvida', modulo: '', prioridade: 'normal', descricao: '' });
  const criar = useMutation({ mutationFn: () => api<any>('/suporte/chamados', { corpo: { ...f, modulo: f.modulo || null, tela: document.referrer || null } }), onSuccess: (c) => aoCriar(c.id) });
  return (
    <div className="cartao form">
      <div className="secao">Novo chamado</div>
      <Campo rotulo="Assunto" className="l2"><input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} placeholder="Em poucas palavras" /></Campo>
      <Campo rotulo="Tipo"><select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{Object.entries(TIPO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
      <Campo rotulo="Prioridade"><select value={f.prioridade} onChange={(e) => setF({ ...f, prioridade: e.target.value })}><option value="baixa">Baixa</option><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente (parou a operação)</option></select></Campo>
      <Campo rotulo="Módulo"><select value={f.modulo} onChange={(e) => setF({ ...f, modulo: e.target.value })}><option value="">—</option>{MODULOS.map((m) => <option key={m.chave} value={m.chave}>{m.nome}</option>)}</select></Campo>
      <Campo rotulo="O que aconteceu" className="l4"><textarea rows={5} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder="O que você fez, o que esperava e o que apareceu" /></Campo>
      <div className="l4">{criar.error && <Erro erro={criar.error} />}<button className="botao" disabled={f.titulo.length < 5 || f.descricao.length < 10 || criar.isPending} onClick={() => criar.mutate()}>Enviar chamado</button></div>
    </div>
  );
}

function Chamado({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['chamado', id], queryFn: () => api<any>(`/suporte/chamados/${id}`) });
  const [texto, setTexto] = useState('');
  const responder = useMutation({ mutationFn: () => api(`/suporte/chamados/${id}/mensagens`, { corpo: { texto } }), onSuccess: () => { setTexto(''); qc.invalidateQueries({ queryKey: ['chamado', id] }); qc.invalidateQueries({ queryKey: ['chamados'] }); } });
  if (q.isLoading) return <Carregando />;
  const c = q.data;
  const [k, t] = STATUS[c.status] ?? ['neutra', c.status];
  return (
    <div className="cartao coluna">
      <div className="flex entre"><h3>Chamado nº {c.numero} · {c.titulo}</h3><span className={`etiqueta ${k}`}>{t}</span></div>
      {c.mensagens.map((m: any) => (
        <div key={m.id} style={{ background: m.daWide ? 'var(--creme-2)' : 'var(--papel)', border: '1px solid var(--linha)', borderRadius: 8, padding: 10 }}>
          <div className="muted">{m.daWide ? 'Wide' : m.autor} · {dataHora(m.criadoEm)}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{m.texto}</div>
        </div>
      ))}
      <textarea rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva uma mensagem" />
      {responder.error && <Erro erro={responder.error} />}
      <div><button className="botao claro" disabled={texto.trim().length < 2 || responder.isPending} onClick={() => responder.mutate()}>Enviar</button></div>
    </div>
  );
}
