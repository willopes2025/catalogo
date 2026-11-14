import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { data, reais } from '../formato';
import { apiPortal, salvarSessaoPortal, sessaoPortal } from './api';
import './portal.css';

const msgErro = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado. Tente de novo.');
const Aviso = ({ erro }: { erro: unknown }) => (erro ? <div className="p-aviso erro">{msgErro(erro)}</div> : null);
const diasAte = (d: string) => Math.round((new Date(d + 'T12:00:00').getTime() - new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00').getTime()) / 86_400_000);

/** Liga o manifesto e o service worker só nas páginas do portal (é o que permite "instalar" no celular). */
function usarApp() {
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel=manifest]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      link.href = '/portal.webmanifest';
      document.head.appendChild(link);
    }
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.href = '/icone-192.png';
    document.head.appendChild(apple);
    document.title = 'Aritana · Portal';
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/portal-sw.js', { scope: '/portal' }).catch(() => undefined);
    return () => apple.remove();
  }, []);
}

export function Portal() {
  usarApp();
  return (
    <div className="p-app">
      <Routes>
        <Route path="entrar" element={<Entrar />} />
        <Route path="entrar/:token" element={<EntrarPorLink />} />
        <Route path="*" element={sessaoPortal() ? <Area /> : <Navigate to="/portal/entrar" replace />} />
      </Routes>
    </div>
  );
}

// ───── Entrada ─────

function Entrar() {
  const navegar = useNavigate();
  const [cpf, setCpf] = useState('');
  const [codigo, setCodigo] = useState('');
  const [enviado, setEnviado] = useState<{ mensagem: string; codigoDev?: string } | null>(null);
  const pedir = useMutation({ mutationFn: () => apiPortal('/entrar', { corpo: { cpf } }), onSuccess: (r) => setEnviado(r) });
  const confirmar = useMutation({
    mutationFn: () => apiPortal<{ token: string; nome: string }>('/confirmar', { corpo: { cpf, codigo } }),
    onSuccess: (s) => { salvarSessaoPortal(s); window.location.replace('/portal'); },
  });
  if (sessaoPortal()) return <Navigate to="/portal" replace />;
  return (
    <div className="p-entrar">
      <img src="/logo-marrom.png" alt="Aritana Semijoias" />
      <h1>Portal da Representante</h1>
      <p className="p-suave">Sua maleta, suas parcelas e o pedido de peças, no celular.</p>
      {!enviado ? (
        <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); pedir.mutate(); }}>
          <label>CPF<input inputMode="numeric" autoComplete="username" value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="000.000.000-00" /></label>
          <button className="p-botao" disabled={cpf.replace(/\D/g, '').length !== 11 || pedir.isPending}>{pedir.isPending ? 'Enviando…' : 'Receber código por e-mail'}</button>
          <Aviso erro={pedir.error} />
        </form>
      ) : (
        <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); confirmar.mutate(); }}>
          <p>{enviado.mensagem}</p>
          {enviado.codigoDev && <p className="p-suave">Ambiente de testes: código {enviado.codigoDev}</p>}
          <label>Código de 6 números<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
          <button className="p-botao" disabled={codigo.length !== 6 || confirmar.isPending}>Entrar</button>
          <Aviso erro={confirmar.error} />
          <button type="button" className="p-link" onClick={() => { setEnviado(null); setCodigo(''); }}>Usar outro CPF ou pedir de novo</button>
        </form>
      )}
      <p className="p-suave p-centro">Sem e-mail no cadastro? Peça à Aritana o link de acesso pelo WhatsApp.</p>
    </div>
  );
}

function EntrarPorLink() {
  const { token } = useParams();
  const navegar = useNavigate();
  const m = useMutation({ mutationFn: () => apiPortal<{ token: string; nome: string }>(`/link/${token}`, { corpo: {} }), onSuccess: (s) => { salvarSessaoPortal(s); window.location.replace('/portal'); } });
  // O link é de uso único: garante uma chamada só (o React de desenvolvimento roda efeitos duas vezes).
  const feito = useRef(false);
  useEffect(() => {
    if (feito.current) return;
    feito.current = true;
    m.mutate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="p-entrar">
      <img src="/logo-marrom.png" alt="Aritana Semijoias" />
      {m.error ? <><Aviso erro={m.error} /><Link className="p-botao" to="/portal/entrar">Entrar com o CPF</Link></> : <p>Entrando…</p>}
    </div>
  );
}

// ───── Área logada ─────

function Area() {
  return (
    <>
      <main className="p-conteudo">
        <Routes>
          <Route index element={<Inicio />} />
          <Route path="maletas" element={<Maletas />} />
          <Route path="maletas/:id" element={<Maleta />} />
          <Route path="pedir" element={<Pedir />} />
          <Route path="financeiro" element={<Financeiro />} />
          <Route path="pontos" element={<PontosRep />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </main>
      <nav className="p-menu" aria-label="Menu">
        <NavLink end to="/portal">Início</NavLink>
        <NavLink to="/portal/maletas">Maleta</NavLink>
        <NavLink to="/portal/pedir">Pedir peças</NavLink>
        <NavLink to="/portal/financeiro">Parcelas</NavLink>
        <NavLink to="/portal/pontos">Pontos</NavLink>
      </nav>
    </>
  );
}

function Carregando() {
  return <div className="p-suave p-centro" style={{ padding: 40 }}>Carregando…</div>;
}

function Topo({ titulo, sub, voltar }: { titulo: string; sub?: ReactNode; voltar?: string }) {
  return (
    <header className="p-topo">
      {voltar && <Link to={voltar} className="p-voltar">←</Link>}
      <div>
        <h1>{titulo}</h1>
        {sub && <p className="p-suave">{sub}</p>}
      </div>
    </header>
  );
}

function Inicio() {
  const q = useQuery({ queryKey: ['p-eu'], queryFn: () => apiPortal('/eu') });
  const [copiado, setCopiado] = useState(false);
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const e = q.data;
  const urlCatalogo = e.catalogo ? `${window.location.origin}${e.catalogo}` : null;
  const compartilhar = async () => {
    if (!urlCatalogo) return;
    try {
      if (navigator.share) await navigator.share({ title: 'Meu catálogo Aritana', text: 'Veja as peças que estão comigo:', url: urlCatalogo });
      else { await navigator.clipboard.writeText(urlCatalogo); setCopiado(true); }
    } catch { /* cancelado */ }
  };
  return (
    <>
      <Topo titulo={`Olá, ${e.primeiroNome}!`} sub={[e.nivel, e.modeloTrabalho].filter(Boolean).join(' · ') || undefined} />
      {e.credito.bloqueado && <div className="p-aviso erro">Seu cadastro está bloqueado para novas maletas. Fale com a Aritana.</div>}
      {e.documentosPendentes.map((d: any) => (
        <a key={d.id} className="p-aviso alerta p-bloco" href={`/assinar/${d.token}`}>✍️ Assinatura pendente: <b>{d.titulo}</b> · toque para assinar</a>
      ))}
      {e.maletas.map((m: any) => {
        const dias = diasAte(m.dataLimite);
        return (
          <Link key={m.id} to={`/portal/maletas/${m.id}`} className="p-cartao p-bloco">
            <div className="p-rotulo">Maleta nº {m.numero}</div>
            <div className="p-grande">{dias > 0 ? `Acerto em ${dias} dia${dias === 1 ? '' : 's'}` : dias === 0 ? 'Acerto é hoje' : `Acerto atrasado ${-dias} dia${dias === -1 ? '' : 's'}`}</div>
            <div className="p-suave">Data limite {data(m.dataLimite)} · ver peças e marcar vendidas</div>
          </Link>
        );
      })}
      {!e.maletas.length && <div className="p-cartao p-suave">Você não tem maleta aberta agora. Peça peças em "Pedir peças".</div>}
      <div className="p-grade2">
        <div className="p-cartao"><div className="p-rotulo">Crédito livre</div><div className="p-grande">{reais(e.credito.livre)}</div><div className="p-suave">de {reais(e.credito.limite)}</div></div>
        <div className="p-cartao"><div className="p-rotulo">Em maleta</div><div className="p-grande">{reais(e.credito.emMaletas)}</div>{e.credito.saldoCredito > 0 && <div className="p-suave">Crédito a usar: {reais(e.credito.saldoCredito)}</div>}</div>
      </div>
      {e.proximasParcelas.length > 0 && (
        <Link to="/portal/financeiro" className="p-cartao p-bloco">
          <div className="p-rotulo">Próximas parcelas</div>
          {e.proximasParcelas.map((t: any) => <div key={t.id} className="p-linha"><span>{data(t.vencimento)}</span><b>{reais(t.valor)}</b></div>)}
          {e.credito.vencido > 0 && <div className="p-erro">Vencido: {reais(e.credito.vencido)}</div>}
        </Link>
      )}
      {urlCatalogo && (
        <div className="p-cartao p-col">
          <div className="p-rotulo">Seu catálogo</div>
          <p className="p-suave">As peças da sua maleta, com foto e preço, para mandar às clientes.</p>
          <button className="p-botao" onClick={() => void compartilhar()}>{copiado ? 'Link copiado!' : 'Compartilhar catálogo'}</button>
        </div>
      )}
      <Instalar />
      <button className="p-link p-centro" onClick={() => { salvarSessaoPortal(null); window.location.href = '/portal/entrar'; }}>Sair</button>
    </>
  );
}

/** Convite para instalar na tela inicial (Android/Chrome mostra o botão; no iPhone, explica o caminho). */
function Instalar() {
  const [evento, setEvento] = useState<any>(null);
  const instalado = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
  useEffect(() => {
    const f = (e: Event) => { e.preventDefault(); setEvento(e); };
    window.addEventListener('beforeinstallprompt', f);
    return () => window.removeEventListener('beforeinstallprompt', f);
  }, []);
  if (instalado) return null;
  const ios = /iphone|ipad/i.test(navigator.userAgent);
  if (!evento && !ios) return null;
  return (
    <div className="p-cartao p-col">
      <div className="p-rotulo">Ter o app no celular</div>
      {evento ? <button className="p-botao claro" onClick={() => { evento.prompt(); setEvento(null); }}>Instalar o app da Aritana</button> : <p className="p-suave">No iPhone: toque em Compartilhar e depois em "Adicionar à Tela de Início".</p>}
    </div>
  );
}

function Maletas() {
  const q = useQuery({ queryKey: ['p-maletas'], queryFn: () => apiPortal<any[]>('/maletas') });
  if (q.isLoading) return <Carregando />;
  return (
    <>
      <Topo titulo="Minhas maletas" />
      {q.error && <Aviso erro={q.error} />}
      {q.data?.map((m) => (
        <Link key={m.id} to={`/portal/maletas/${m.id}`} className="p-cartao p-bloco p-linha">
          <span><b>Nº {m.numero}</b><br /><span className="p-suave">{m.status === 'aberta' ? `Acerto até ${data(m.dataLimite)}` : `Acertada`}</span></span>
          <b>{reais(m.valor)}</b>
        </Link>
      ))}
      {q.data && !q.data.length && <div className="p-cartao p-suave">Nenhuma maleta ainda.</div>}
    </>
  );
}

function Maleta() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-maleta', id], queryFn: () => apiPortal(`/maletas/${id}`) });
  const [vendidas, setVendidas] = useState<Record<string, number>>({});
  const [busca, setBusca] = useState('');
  useEffect(() => {
    if (q.data) setVendidas(Object.fromEntries(q.data.itens.filter((i: any) => i.naMaleta > 0).map((i: any) => [i.produtoId, i.prebaixaVendida ?? 0])));
  }, [q.data]);
  const salvar = useMutation({ mutationFn: () => apiPortal(`/maletas/${id}/prebaixa`, { corpo: { itens: Object.entries(vendidas).map(([produtoId, vendida]) => ({ produtoId, vendida })) } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-maleta', id] }) });
  const recebi = useMutation({ mutationFn: () => apiPortal(`/maletas/${id}/recebida`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-maleta', id] }) });
  const itens = useMemo(() => (q.data?.itens ?? []).filter((i: any) => i.naMaleta > 0 && (!busca || `${i.referencia} ${i.descricao}`.toLowerCase().includes(busca.toLowerCase()))), [q.data, busca]);
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const m = q.data;
  const aberta = m.status === 'aberta';
  const totalVendido = m.itens.reduce((a: number, i: any) => a + (vendidas[i.produtoId] ?? 0) * i.preco, 0);
  const pecasVendidas = Object.values(vendidas).reduce((a, b) => a + b, 0);
  return (
    <>
      <Topo voltar="/portal/maletas" titulo={`Maleta nº ${m.numero}`} sub={aberta ? `Acerto até ${data(m.dataLimite)} · ${m.totais.pecas} peças · ${reais(m.totais.valor)}` : 'Acertada'} />
      {aberta && !m.recebidaEm && <button className="p-botao claro p-bloco" disabled={recebi.isPending} onClick={() => recebi.mutate()}>Confirmar que recebi a maleta</button>}
      {m.codigoRastreio && <div className="p-cartao">Rastreio dos Correios: <b>{m.codigoRastreio}</b></div>}
      {aberta && (
        <>
          <div className="p-aviso alerta">Marque as peças que você já vendeu. Isso adianta o acerto; a Aritana confere tudo na hora de acertar.</div>
          <input className="p-busca" placeholder="Buscar peça" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {itens.map((i: any) => {
            const v = vendidas[i.produtoId] ?? 0;
            return (
              <div key={i.produtoId} className="p-cartao p-peca">
                {i.foto ? <img src={i.foto} alt="" /> : <div className="p-foto" />}
                <div className="p-peca-info">
                  <b>{i.descricao}</b>
                  <span className="p-suave">ref. {i.referencia} · {reais(i.preco)} · {i.naMaleta} na maleta</span>
                </div>
                <div className="p-contador">
                  <button aria-label="menos" disabled={v <= 0} onClick={() => setVendidas({ ...vendidas, [i.produtoId]: v - 1 })}>−</button>
                  <span>{v}</span>
                  <button aria-label="mais" disabled={v >= i.naMaleta} onClick={() => setVendidas({ ...vendidas, [i.produtoId]: v + 1 })}>+</button>
                </div>
              </div>
            );
          })}
          <div className="p-rodape-fixo">
            <div><b>{pecasVendidas} vendida(s)</b> · {reais(totalVendido)}</div>
            <button className="p-botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>{salvar.isSuccess && !salvar.isPending ? 'Salvo ✓' : 'Salvar vendas'}</button>
          </div>
          <Aviso erro={salvar.error} />
        </>
      )}
      {m.acertos.length > 0 && (
        <div className="p-cartao">
          <div className="p-rotulo">Acertos</div>
          {m.acertos.map((a: any, k: number) => (
            <div key={k} className="p-linha"><span>{data(a.data)}{a.parcial ? ' (parcial)' : ''}<br /><span className="p-suave">vendido {reais(a.vendido)} · sua comissão {reais(a.comissao)}</span></span><b>{reais(a.totalAPagar)}</b></div>
          ))}
        </div>
      )}
    </>
  );
}

function Pedir() {
  const qc = useQueryClient();
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [carrinho, setCarrinho] = useState<Record<string, { item: any; q: number }>>({});
  const [obs, setObs] = useState('');
  const [verCarrinho, setVerCarrinho] = useState(false);
  const q = useQuery({ queryKey: ['p-catalogo', busca, cat], queryFn: () => apiPortal(`/catalogo?${new URLSearchParams({ ...(busca && { busca }), ...(cat && { categoria: cat }) })}`) });
  const pedidos = useQuery({ queryKey: ['p-pedidos'], queryFn: () => apiPortal<any[]>('/pedidos') });
  const enviar = useMutation({
    mutationFn: () => apiPortal('/pedidos', { corpo: { itens: Object.values(carrinho).map((c) => ({ produtoId: c.item.id, quantidade: c.q })), observacao: obs || null } }),
    onSuccess: () => { setCarrinho({}); setObs(''); setVerCarrinho(false); qc.invalidateQueries({ queryKey: ['p-pedidos'] }); },
  });
  const qtd = Object.values(carrinho).reduce((a, c) => a + c.q, 0);
  const mudar = (item: any, d: number) => {
    const atual = carrinho[item.id]?.q ?? 0;
    const n = Math.max(0, Math.min(20, atual + d));
    const novo = { ...carrinho };
    if (n === 0) delete novo[item.id];
    else novo[item.id] = { item, q: n };
    setCarrinho(novo);
  };
  return (
    <>
      <Topo titulo="Pedir peças" sub="Escolha o que quer na próxima maleta. A Aritana confirma pelo WhatsApp." />
      {enviar.isSuccess && <div className="p-aviso ok">Pedido enviado! Acompanhe a resposta aqui embaixo.</div>}
      {!verCarrinho ? (
        <>
          <input className="p-busca" placeholder="Buscar por nome ou referência" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {q.data?.categorias?.length > 0 && (
            <div className="p-chips">
              <button className={!cat ? 'ativo' : ''} onClick={() => setCat('')}>Todas</button>
              {q.data.categorias.map((c: string) => <button key={c} className={cat === c ? 'ativo' : ''} onClick={() => setCat(c)}>{c}</button>)}
            </div>
          )}
          {q.isLoading && <Carregando />}
          <Aviso erro={q.error} />
          <div className="p-vitrine">
            {q.data?.itens.map((i: any) => {
              const n = carrinho[i.id]?.q ?? 0;
              return (
                <div key={i.id} className="p-cartao p-produto">
                  {i.foto ? <img src={i.foto} alt="" /> : <div className="p-foto" />}
                  <b>{i.descricao}</b>
                  <span className="p-suave">ref. {i.referencia}{i.poucas ? ' · últimas peças' : ''}</span>
                  <span>{reais(i.preco)}</span>
                  {n ? (
                    <div className="p-contador"><button onClick={() => mudar(i, -1)}>−</button><span>{n}</span><button onClick={() => mudar(i, 1)}>+</button></div>
                  ) : (
                    <button className="p-botao claro" onClick={() => mudar(i, 1)}>Quero</button>
                  )}
                </div>
              );
            })}
          </div>
          {q.data && !q.data.itens.length && <div className="p-cartao p-suave">Nenhuma peça encontrada.</div>}
          {qtd > 0 && <div className="p-rodape-fixo"><b>{qtd} peça(s) escolhida(s)</b><button className="p-botao" onClick={() => setVerCarrinho(true)}>Revisar pedido</button></div>}
        </>
      ) : (
        <div className="p-col">
          {Object.values(carrinho).map(({ item, q: n }) => (
            <div key={item.id} className="p-cartao p-linha"><span>{item.descricao}<br /><span className="p-suave">ref. {item.referencia}</span></span><div className="p-contador"><button onClick={() => mudar(item, -1)}>−</button><span>{n}</span><button onClick={() => mudar(item, 1)}>+</button></div></div>
          ))}
          <textarea className="p-busca" rows={3} placeholder="Observação (ex.: tamanho do anel, para um evento)" value={obs} onChange={(e) => setObs(e.target.value)} />
          <button className="p-botao" disabled={!qtd || enviar.isPending} onClick={() => enviar.mutate()}>Enviar pedido</button>
          <button className="p-link" onClick={() => setVerCarrinho(false)}>Continuar escolhendo</button>
          <Aviso erro={enviar.error} />
        </div>
      )}
      {!!pedidos.data?.length && (
        <div className="p-cartao" style={{ marginTop: 16 }}>
          <div className="p-rotulo">Meus pedidos</div>
          {pedidos.data.map((p) => (
            <div key={p.id} className="p-linha">
              <span>Pedido nº {p.numero} · {p.itens.reduce((a: number, i: any) => a + i.quantidade, 0)} peça(s){p.resposta && <><br /><span className="p-suave">{p.resposta}</span></>}</span>
              <span className={`p-selo ${p.status}`}>{p.status === 'novo' ? 'Aguardando' : p.status === 'atendido' ? 'Atendido' : 'Recusado'}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Financeiro() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-financeiro'], queryFn: () => apiPortal('/financeiro') });
  const [copiado, setCopiado] = useState<string | null>(null);
  const pix = useMutation({ mutationFn: (id: string) => apiPortal(`/financeiro/${id}/pix`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-financeiro'] }) });
  const copiar = async (id: string, t: string) => { try { await navigator.clipboard.writeText(t); setCopiado(id); } catch { window.prompt('Pix copia e cola:', t); } };
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const abertos = q.data.titulos.filter((t: any) => t.status === 'aberto').sort((a: any, b: any) => a.vencimento.localeCompare(b.vencimento));
  const pagos = q.data.titulos.filter((t: any) => t.status === 'pago');
  return (
    <>
      <Topo titulo="Parcelas" sub={abertos.length ? `${abertos.length} em aberto · ${reais(abertos.reduce((a: number, t: any) => a + t.valor, 0))}` : 'Tudo em dia'} />
      <Aviso erro={pix.error} />
      {abertos.map((t: any) => {
        const dias = diasAte(t.vencimento);
        return (
          <div key={t.id} className="p-cartao p-col">
            <div className="p-linha"><span>{t.descricao}<br /><span className={dias < 0 ? 'p-erro' : 'p-suave'}>{dias < 0 ? `Venceu em ${data(t.vencimento)}` : `Vence em ${data(t.vencimento)}`}</span></span><b>{reais(t.valor)}</b></div>
            {t.pixCopiaCola ? (
              <button className="p-botao" onClick={() => void copiar(t.id, t.pixCopiaCola)}>{copiado === t.id ? 'Pix copiado! Cole no app do banco' : 'Copiar Pix copia e cola'}</button>
            ) : t.cobrancaUrl ? (
              <a className="p-botao" href={t.cobrancaUrl} target="_blank" rel="noreferrer">{t.cobrancaTipo === 'BOLETO' ? 'Abrir boleto' : 'Pagar'}</a>
            ) : q.data.asaasLigado ? (
              <button className="p-botao claro" disabled={pix.isPending} onClick={() => pix.mutate(t.id)}>Gerar Pix</button>
            ) : null}
          </div>
        );
      })}
      {q.data.desempenho.length > 0 && (
        <div className="p-cartao">
          <div className="p-rotulo">Minhas vendas</div>
          {q.data.desempenho.map((d: any) => <div key={d.mes} className="p-linha"><span>{d.mes.slice(5)}/{d.mes.slice(0, 4)}<br /><span className="p-suave">comissão {reais(d.comissao)}</span></span><b>{reais(d.vendido)}</b></div>)}
        </div>
      )}
      {pagos.length > 0 && (
        <details className="p-cartao">
          <summary className="p-rotulo">Pagas ({pagos.length})</summary>
          {pagos.map((t: any) => <div key={t.id} className="p-linha"><span>{t.descricao}<br /><span className="p-suave">paga em {data(t.pagoEm)}</span></span><span>{reais(t.valorPago ?? t.valor)}</span></div>)}
        </details>
      )}
    </>
  );
}

function PontosRep() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-pontos'], queryFn: () => apiPortal('/pontos') });
  const resgatar = useMutation({ mutationFn: (premioId: string) => apiPortal('/pontos/resgatar', { corpo: { premioId } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-pontos'] }) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const d = q.data;
  return (
    <>
      <Topo titulo="Meus pontos" sub="Ganhe pontos com acerto em dia, vendas e parcelas pagas no prazo, e troque por prêmios." />
      <div className="p-cartao p-centro">
        <div className="p-rotulo">Saldo</div>
        <div className="p-grande" style={{ fontSize: 36 }}>{d.saldo}</div>
        <div className="p-suave">pontos</div>
      </div>
      <div className="p-cartao">
        <div className="p-rotulo">Ranking do mês</div>
        {d.ranking.minhaPosicao ? <div className="p-grande">Você está em {d.ranking.minhaPosicao}º de {d.ranking.participantes}</div> : <div className="p-suave">Faça um acerto este mês para entrar no ranking.</div>}
        {d.ranking.top.map((x: any) => (
          <div key={x.posicao} className="p-linha" style={x.eu ? { fontWeight: 700 } : undefined}><span>{x.posicao}º · {x.nome}</span><span className="p-suave">{x.cidade ?? ''}</span></div>
        ))}
      </div>
      {resgatar.isSuccess && <div className="p-aviso ok">Pedido de resgate enviado! A Aritana avisa quando o prêmio estiver pronto.</div>}
      <Aviso erro={resgatar.error} />
      {d.premios.length > 0 && <div className="p-rotulo" style={{ marginTop: 8 }}>Prêmios</div>}
      <div className="p-vitrine">
        {d.premios.map((p: any) => {
          const falta = p.pontos - d.saldo;
          return (
            <div key={p.id} className="p-cartao p-produto">
              {p.foto ? <img src={p.foto} alt="" /> : <div className="p-foto" />}
              <b>{p.nome}</b>
              {p.descricao && <span className="p-suave">{p.descricao}</span>}
              <span>{p.pontos} pontos</span>
              {p.esgotado ? (
                <span className="p-suave">Esgotado</span>
              ) : falta > 0 ? (
                <span className="p-suave">Faltam {falta}</span>
              ) : (
                <button className="p-botao" disabled={resgatar.isPending} onClick={() => window.confirm(`Trocar ${p.pontos} pontos por ${p.nome}?`) && resgatar.mutate(p.id)}>Resgatar</button>
              )}
            </div>
          );
        })}
      </div>
      {!!d.resgates.length && (
        <div className="p-cartao">
          <div className="p-rotulo">Meus resgates</div>
          {d.resgates.map((r: any) => (
            <div key={r.id} className="p-linha"><span>{r.premio}{r.observacao && <><br /><span className="p-suave">{r.observacao}</span></>}</span><span className={`p-selo ${r.status === 'entregue' ? 'atendido' : r.status === 'cancelado' ? 'recusado' : 'novo'}`}>{r.status === 'solicitado' ? 'Aguardando' : r.status === 'entregue' ? 'Entregue' : 'Cancelado'}</span></div>
          ))}
        </div>
      )}
      {!!d.extrato.length && (
        <details className="p-cartao">
          <summary className="p-rotulo">Extrato</summary>
          {d.extrato.map((e: any) => <div key={e.id} className="p-linha"><span>{e.motivo}<br /><span className="p-suave">{data(e.criadoEm.slice(0, 10))}</span></span><b className={e.pontos < 0 ? 'p-erro' : ''}>{e.pontos > 0 ? '+' : ''}{e.pontos}</b></div>)}
        </details>
      )}
    </>
  );
}
