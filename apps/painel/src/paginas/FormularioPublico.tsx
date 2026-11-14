import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ErroApi } from '../api';
import '../portal/portal.css';

/** Página pública de um formulário: /f/<slug> (guarda a origem dos links com utm_*). */
export function FormularioPublico() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ['form-publico', slug], queryFn: () => api<any>(`/publico/formularios/${slug}`), retry: false });
  const origem = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const o: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref']) if (p.get(k)) o[k] = p.get(k)!.slice(0, 200);
    return o;
  }, []);
  const [r, setR] = useState<Record<string, any>>({});
  const [aceite, setAceite] = useState(false);
  const [site, setSite] = useState('');
  const m = useMutation({ mutationFn: () => api<{ mensagem: string }>(`/publico/formularios/${slug}`, { corpo: { respostas: r, consentimento: aceite, origem, site } }) });
  const erros = m.error instanceof ErroApi ? m.error.dados.campos ?? {} : {};
  const casca = (filho: React.ReactNode) => <div className="p-app"><div className="p-entrar"><img src="/logo-marrom.png" alt="Aritana Semijoias" />{filho}</div></div>;
  if (q.isLoading) return casca(<p className="p-suave p-centro">Carregando…</p>);
  if (q.error) return casca(<><h1>Formulário indisponível</h1><p className="p-suave p-centro">Este formulário foi encerrado ou o endereço está errado.</p></>);
  if (m.isSuccess) return casca(<><h1>Enviado!</h1><p className="p-suave p-centro">{m.data.mensagem}</p></>);
  const f = q.data;
  const erro = (k: string) => (erros[k] ? <span className="p-erro">{erros[k]}</span> : null);
  return (
    <div className="p-app">
      <form className="p-entrar" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <img src="/logo-marrom.png" alt="Aritana Semijoias" />
        <h1>{f.titulo}</h1>
        {f.descricao && <p className="p-suave">{f.descricao}</p>}
        <div className="p-cartao p-col">
          {f.campos.map((c: any) => (
            <div key={c.id} className="p-col" style={{ gap: 6 }}>
              {c.tipo === 'nota' ? (
                <>
                  <b style={{ fontSize: 14 }}>{c.rotulo}{c.obrigatorio && ' *'}</b>
                  <div className="p-notas">{Array.from({ length: 11 }, (_, n) => <button type="button" key={n} className={r[c.id] === n ? 'ativo' : ''} onClick={() => setR({ ...r, [c.id]: n })}>{n}</button>)}</div>
                  <div className="flex entre p-suave" style={{ fontSize: 12 }}><span>Nada provável</span><span>Muito provável</span></div>
                </>
              ) : c.tipo === 'escolha' ? (
                <>
                  <b style={{ fontSize: 14 }}>{c.rotulo}{c.obrigatorio && ' *'}</b>
                  {c.opcoes.map((o: string) => <label key={o} className="p-check"><input type="radio" name={c.id} checked={r[c.id] === o} onChange={() => setR({ ...r, [c.id]: o })} /> {o}</label>)}
                </>
              ) : c.tipo === 'multipla' ? (
                <>
                  <b style={{ fontSize: 14 }}>{c.rotulo}{c.obrigatorio && ' *'}</b>
                  {c.opcoes.map((o: string) => {
                    const lista: string[] = r[c.id] ?? [];
                    return <label key={o} className="p-check"><input type="checkbox" checked={lista.includes(o)} onChange={(e) => setR({ ...r, [c.id]: e.target.checked ? [...lista, o] : lista.filter((x) => x !== o) })} /> {o}</label>;
                  })}
                </>
              ) : (
                <label>{c.rotulo}{c.obrigatorio && ' *'}
                  {c.tipo === 'texto_longo' ? (
                    <textarea rows={4} value={r[c.id] ?? ''} onChange={(e) => setR({ ...r, [c.id]: e.target.value })} />
                  ) : (
                    <input
                      type={c.tipo === 'email' ? 'email' : c.tipo === 'data' ? 'date' : 'text'}
                      inputMode={c.tipo === 'telefone' ? 'tel' : c.tipo === 'numero' || c.tipo === 'cpf' ? 'numeric' : undefined}
                      autoComplete={c.papel === 'nome' ? 'name' : c.papel === 'telefone' ? 'tel' : c.papel === 'email' ? 'email' : undefined}
                      value={r[c.id] ?? ''}
                      onChange={(e) => setR({ ...r, [c.id]: e.target.value })}
                    />
                  )}
                </label>
              )}
              {c.ajuda && <span className="p-suave" style={{ fontSize: 12.5 }}>{c.ajuda}</span>}
              {erro(c.id)}
            </div>
          ))}
          <input className="campo-oculto" tabIndex={-1} autoComplete="off" aria-hidden="true" value={site} onChange={(e) => setSite(e.target.value)} />
          {f.consentimento && <label className="p-check"><input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} /> {f.consentimento}</label>}
          {erro('consentimento')}
          <button className="p-botao" disabled={m.isPending}>{m.isPending ? 'Enviando…' : 'Enviar'}</button>
          {m.error && !Object.keys(erros).length && <div className="p-aviso erro">{(m.error as Error).message}</div>}
          {m.error && Object.keys(erros).length > 0 && <div className="p-aviso erro">Confira as respostas destacadas.</div>}
        </div>
      </form>
    </div>
  );
}
