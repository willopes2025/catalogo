import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { data, reais } from '../formato';
import { apiPortal, salvarSessaoPortal, sessaoPortal } from './api';
import { desligarNotificacoes, ligarNotificacoes, noApp } from './app';
import './portal.css';
import { AgendarAcerto, ChipsCategorias, Clientes, Conteudos, DetalheVenda, Extrato, Garantia, Mais, MeuCatalogo, NovaVenda, OndeEstaMaleta, Perfil, usarVitrinePortal, Vendas } from './Consultora';

const msgErro = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado. Tente de novo.');
const Aviso = ({ erro }: { erro: unknown }) => (erro ? <div className="p-aviso erro">{msgErro(erro)}</div> : null);
const diasAte = (d: string) => Math.round((new Date(d + 'T12:00:00').getTime() - new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00').getTime()) / 86_400_000);

/** Liga o manifesto e o service worker só nas páginas do portal (é o que permite "instalar" no celular). */
function usarApp() {
  useEffect(() => {
    // O sistema da equipe tem o próprio manifesto (Aritana Gestão); no portal vale o da consultora.
    let link = document.querySelector<HTMLLinkElement>('link[rel=manifest]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    link.href = '/portal.webmanifest';
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
  const [login, setLogin] = useState('');
  const [codigo, setCodigo] = useState('');
  const [enviado, setEnviado] = useState<{ mensagem: string; codigoDev?: string } | null>(null);
  const pedir = useMutation({ mutationFn: () => apiPortal('/entrar', { corpo: { login: login.trim() } }), onSuccess: (r) => setEnviado(r) });
  const valido = login.includes('@') ? /.+@.+\..+/.test(login.trim()) : login.replace(/\D/g, '').length === 11;
  const confirmar = useMutation({
    mutationFn: () => apiPortal<{ token: string; nome: string }>('/confirmar', { corpo: { login: login.trim(), codigo } }),
    onSuccess: (s) => { salvarSessaoPortal(s); window.location.replace('/portal'); },
  });
  if (sessaoPortal()) return <Navigate to="/portal" replace />;
  return (
    <div className="p-entrar">
      <img src="/logo-marrom.png" alt="Aritana Semijoias" />
      <h1>App da Consultora</h1>
      <p className="p-suave">Sua maleta, vendas, clientes e comissões, no celular ou no computador.</p>
      {!enviado ? (
        <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); pedir.mutate(); }}>
          <label>Seu e-mail<input type="email" inputMode="email" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="voce@exemplo.com" /></label>
          <button className="p-botao" disabled={!valido || pedir.isPending}>{pedir.isPending ? 'Enviando…' : 'Receber código no WhatsApp'}</button>
          <Aviso erro={pedir.error} />
        </form>
      ) : (
        <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); confirmar.mutate(); }}>
          <p>{enviado.mensagem}</p>
          {enviado.codigoDev && <p className="p-suave">Ambiente de testes: código {enviado.codigoDev}</p>}
          <label>Código de 6 números<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
          <button className="p-botao" disabled={codigo.length !== 6 || confirmar.isPending}>Entrar</button>
          <Aviso erro={confirmar.error} />
          <button type="button" className="p-link" onClick={() => { setEnviado(null); setCodigo(''); }}>Usar outro e-mail ou pedir de novo</button>
        </form>
      )}
      <p className="p-suave p-centro">Também dá para entrar com o CPF. Sem e-mail no cadastro? Peça à Aritana o link de acesso.</p>
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
      {m.error ? <><Aviso erro={m.error} /><Link className="p-botao" to="/portal/entrar">Entrar com o e-mail</Link></> : <p>Entrando…</p>}
    </div>
  );
}

// ───── Área logada ─────

function Area() {
  const navegar = useNavigate();
  // No app do celular: pede para notificar e registra o aparelho (no navegador não faz nada).
  useEffect(() => { void ligarNotificacoes((link) => navegar(link)); }, [navegar]);
  // Contatos esperando o aceite: aparece no menu e faz a lista se atualizar sozinha.
  const leads = useQuery({ queryKey: ['p-leads'], queryFn: () => apiPortal<LeadPortal[]>('/leads'), refetchInterval: 60_000 });
  const pedidosNovos = useQuery({ queryKey: ['p-pedidos'], queryFn: () => apiPortal<PedidoPortal[]>('/pedidos-link'), refetchInterval: 60_000 });
  const esperando = (leads.data?.filter((l) => l.situacao === 'aguardando').length ?? 0) + (pedidosNovos.data?.filter((p) => p.status === 'novo' && p.origem === 'maleta').length ?? 0);
  return (
    <>
      <main className="p-conteudo">
        <Routes>
          <Route index element={<Inicio />} />
          <Route path="maletas" element={<Maletas />} />
          <Route path="maletas/:id" element={<Maleta />} />
          <Route path="pedir" element={<Pedir />} />
          <Route path="meu-catalogo" element={<MeuCatalogo />} />
          <Route path="financeiro" element={<Financeiro />} />
          <Route path="pontos" element={<PontosRep />} />
          <Route path="leads" element={<Leads />} />
          <Route path="clientes" element={<Clientes />} />
          <Route path="vendas" element={<Vendas />} />
          <Route path="vendas/nova" element={<NovaVenda />} />
          <Route path="vendas/:id" element={<DetalheVenda />} />
          <Route path="garantia" element={<Garantia />} />
          <Route path="extrato" element={<Extrato />} />
          <Route path="treinamentos" element={<Conteudos secao="treinamento" />} />
          <Route path="divulgacao" element={<Conteudos secao="divulgacao" />} />
          <Route path="perfil" element={<Perfil />} />
          <Route path="mais" element={<Mais />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </main>
      <nav className="p-menu" aria-label="Menu">
        <NavLink end to="/portal">Início</NavLink>
        <NavLink to="/portal/maletas">Maleta</NavLink>
        <NavLink to="/portal/vendas">Vendas</NavLink>
        <NavLink to="/portal/clientes">Clientes{esperando > 0 && <span className="p-bolha">{esperando}</span>}</NavLink>
        <NavLink to="/portal/mais">Mais</NavLink>
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
      if (navigator.share) await navigator.share({ title: 'Meu catálogo Aritana', text: e.maletas.length ? 'Veja as peças que estão comigo:' : 'Veja as semijoias Aritana no meu catálogo:', url: urlCatalogo });
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
      <AvisoLeads />
      <Compromissos />
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
          <p className="p-suave">Peças com foto e preço para mandar às clientes: as da sua maleta e as que a Aritana envia.</p>
          <button className="p-botao" onClick={() => void compartilhar()}>{copiado ? 'Link copiado!' : 'Compartilhar catálogo'}</button>
          <Link to="/portal/meu-catalogo" className="p-link">Escolher as peças do catálogo</Link>
        </div>
      )}
      <IndiqueGanhe />
      <Instalar />
      <button className="p-link p-centro" onClick={async () => { await desligarNotificacoes(); salvarSessaoPortal(null); window.location.href = '/portal/entrar'; }}>Sair</button>
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
  if (instalado || noApp()) return null;
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
          <span><b>Nº {m.numero}</b><br /><span className="p-suave">{m.status === 'aberta' ? `Acerto até ${data(m.dataLimite)}` : `Baixada`}</span></span>
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
      <Topo voltar="/portal/maletas" titulo={`Maleta nº ${m.numero}`} sub={aberta ? `Acerto até ${data(m.dataLimite)} · ${m.totais.pecas} peças · ${reais(m.totais.valor)}` : 'Baixada'} />
      {aberta && <OndeEstaMaleta etapa={m.etapa} />}
      {aberta && <AgendarAcerto maletaId={m.id} />}
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
  const q = usarVitrinePortal(busca, cat);
  const itens = q.data?.pages.flatMap((p) => p.itens) ?? [];
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
          <ChipsCategorias porCategoria={q.data?.pages[0]?.porCategoria} cat={cat} setCat={setCat} />
          {q.isLoading && <Carregando />}
          <Aviso erro={q.error} />
          <div className="p-vitrine">
            {itens.map((i: any) => {
              const n = carrinho[i.id]?.q ?? 0;
              return (
                <div key={i.id} className="p-cartao p-produto">
                  {i.foto ? <img src={i.foto} alt="" loading="lazy" /> : <div className="p-foto" />}
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
          {q.data && !itens.length && <div className="p-cartao p-suave">Nenhuma peça encontrada.</div>}
          {q.hasNextPage && <button className="p-botao claro" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Carregando…' : 'Ver mais peças'}</button>}
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

// ───── Clientes e candidatas que a Aritana mandou (perto dela) ─────

interface LeadPortal {
  id: string;
  tipo: 'cliente' | 'candidata';
  situacao: 'aguardando' | 'aceito' | 'concluido';
  nome: string;
  telefone: string | null;
  cidade: string | null;
  distanciaKm: number | null;
  recebidoEm: string | null;
  aceitarAte: string | null;
  status: string;
  interesse: [string, string][];
}

const faltam = (ate: string) => {
  const min = Math.max(0, Math.round((new Date(ate).getTime() - Date.now()) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};

interface PedidoPortal {
  id: string; numero: number; origem: 'maleta' | 'matriz'; status: 'novo' | 'confirmado' | 'entregue' | 'cancelado'; clienteNome: string; clienteTelefone: string; clienteCidade: string | null;
  entrega: string; endereco: string | null; observacao: string | null; itens: { produtoId: string; descricao: string; preco: number; quantidade: number }[]; total: number; criadoEm: string; motivoCancelamento: string | null;
}

const ENTREGA: Record<string, string> = { retirar: 'Vai retirar', entregar: 'Quer receber em casa', combinar: 'Combinar' };
const SIT_PEDIDO: Record<PedidoPortal['status'], string> = { novo: 'Novo', confirmado: 'Confirmado', entregue: 'Entregue', cancelado: 'Cancelado' };

/** Pedidos que as clientes fizeram pelo catálogo dela: da maleta (ela confirma e entrega) ou da matriz (só acompanha). */
function PedidosCatalogo() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-pedidos'], queryFn: () => apiPortal<PedidoPortal[]>('/pedidos-link'), refetchInterval: 30_000 });
  const acao = useMutation({
    mutationFn: ({ id, a, corpo }: { id: string; a: 'confirmar' | 'entregue' | 'cancelar'; corpo?: unknown }) => apiPortal(`/pedidos-link/${id}/${a}`, { corpo: corpo ?? {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-pedidos'] }); qc.invalidateQueries({ queryKey: ['p-maletas'] }); qc.invalidateQueries({ queryKey: ['p-maleta'] }); },
  });
  const lista = q.data ?? [];
  if (!lista.length) return null;
  const zap = (p: PedidoPortal) => `https://wa.me/${p.clienteTelefone.replace(/\D/g, '').replace(/^(?!55)/, '55')}?text=${encodeURIComponent(`Oi, ${p.clienteNome.split(' ')[0]}! Recebi seu pedido nº ${p.numero} pelo meu catálogo da Aritana.`)}`;
  return (
    <section className="p-col" style={{ gap: 10 }}>
      <div className="p-rotulo">Pedidos pelo seu catálogo</div>
      <Aviso erro={acao.error} />
      {lista.map((p) => (
        <div key={p.id} className="p-cartao p-col" style={{ opacity: p.status === 'cancelado' ? 0.6 : 1 }}>
          <div className="p-linha" style={{ padding: 0 }}><b>Pedido nº {p.numero} · {p.clienteNome}</b><span className="p-suave">{SIT_PEDIDO[p.status]}</span></div>
          {p.itens.map((i) => <div key={i.produtoId} className="p-linha"><span>{i.quantidade}× {i.descricao}</span><span>{reais(i.preco * i.quantidade)}</span></div>)}
          <div className="p-linha"><b>Total</b><b>{reais(p.total)}</b></div>
          <div className="p-suave">{[p.clienteCidade, ENTREGA[p.entrega], p.endereco].filter(Boolean).join(' · ')}</div>
          {p.observacao && <div className="p-suave">“{p.observacao}”</div>}
          {p.origem === 'matriz' ? (
            <div className="p-suave">{p.status === 'entregue' ? '✓ Faturado pela Aritana: a comissão entra no fechamento do mês.' : p.status === 'cancelado' ? `Cancelado${p.motivoCancelamento ? `: ${p.motivoCancelamento}` : ''}.` : 'A Aritana separa e envia as peças. Você ganha a comissão quando for faturado.'}</div>
          ) : (
            <>
              {['novo', 'confirmado'].includes(p.status) && <a className="p-botao claro" href={zap(p)} target="_blank" rel="noreferrer">Chamar {p.clienteNome.split(' ')[0]} no WhatsApp</a>}
              {p.status === 'novo' && <button className="p-botao" disabled={acao.isPending} onClick={() => acao.mutate({ id: p.id, a: 'confirmar' })}>Confirmar pedido</button>}
              {p.status === 'confirmado' && <button className="p-botao" disabled={acao.isPending} onClick={() => window.confirm('Entregou as peças? Elas entram como vendidas na sua maleta.') && acao.mutate({ id: p.id, a: 'entregue' })}>Entreguei</button>}
              {['novo', 'confirmado'].includes(p.status) && <button className="p-link" onClick={() => { const m = window.prompt('Cancelar este pedido? Motivo (opcional):'); if (m !== null) acao.mutate({ id: p.id, a: 'cancelar', corpo: { motivo: m || null } }); }}>Cancelar pedido</button>}
              {p.status === 'entregue' && <div className="p-suave">✓ Entregue: as peças estão marcadas como vendidas na maleta.</div>}
              {p.status === 'cancelado' && <div className="p-suave">Cancelado{p.motivoCancelamento ? `: ${p.motivoCancelamento}` : ''}.</div>}
            </>
          )}
        </div>
      ))}
    </section>
  );
}

const STATUS_IND: Record<string, string> = { candidata: 'Cadastrou-se', aprovada: 'Aprovada: falta o 1º pedido pago', liberada: 'Prêmio liberado', paga: 'Prêmio pago', recusada: 'Não aprovada', expirada: 'Expirou', cancelada: 'Cancelada' };

/** Indique e ganhe: o link da consultora para convidar novas consultoras, com o prêmio e as indicações dela. */
function IndiqueGanhe() {
  const q = useQuery({ queryKey: ['portal', 'indicacoes'], queryFn: () => apiPortal<{ ativo: boolean; link: string; mensagem: string; premio: number; validadeDias: number; itens: { id: string; nome: string; cidade: string; status: string; valor: number | null }[]; totais: { indicadas: number; aReceber: number; recebido: number } }>('/indicacoes'), retry: false });
  const [copiado, setCopiado] = useState(false);
  const [ver, setVer] = useState(false);
  const d = q.data;
  if (!d || !d.ativo) return null;
  const convidar = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Seja consultora Aritana', text: d.mensagem, url: d.link });
      else { await navigator.clipboard.writeText(`${d.mensagem} ${d.link}`.trim()); setCopiado(true); }
    } catch { /* cancelado */ }
  };
  return (
    <div className="p-cartao p-col">
      <div className="p-rotulo">Indique e ganhe</div>
      <div className="p-grande">{reais(d.premio)} por consultora</div>
      <p className="p-suave">Convide amigas para serem consultoras Aritana. Quando a sua indicada for aprovada e pagar o primeiro pedido (em até {d.validadeDias} dias), você ganha o prêmio.</p>
      <button className="p-botao" onClick={() => void convidar()}>{copiado ? 'Convite copiado!' : 'Convidar pelo meu link'}</button>
      <a className="p-link p-centro" href={`https://wa.me/?text=${encodeURIComponent(`${d.mensagem} ${d.link}`.trim())}`} target="_blank" rel="noreferrer">Mandar no WhatsApp</a>
      {d.totais.indicadas > 0 && (
        <>
          <button className="p-link" onClick={() => setVer(!ver)}>{d.totais.indicadas} indicada(s){d.totais.aReceber ? ` · ${reais(d.totais.aReceber)} a receber` : ''}{d.totais.recebido ? ` · ${reais(d.totais.recebido)} recebido` : ''} {ver ? '▲' : '▼'}</button>
          {ver && d.itens.map((i) => <div key={i.id} className="p-linha"><span>{i.nome}{i.cidade ? ` · ${i.cidade}` : ''}<br /><span className="p-suave">{STATUS_IND[i.status] ?? i.status}</span></span><b>{i.valor ? reais(i.valor) : ''}</b></div>)}
        </>
      )}
    </div>
  );
}

function AvisoLeads() {
  const q = useQuery({ queryKey: ['p-leads'], queryFn: () => apiPortal<LeadPortal[]>('/leads') });
  const n = q.data?.filter((l) => l.situacao === 'aguardando').length ?? 0;
  if (!n) return null;
  return <Link to="/portal/leads" className="p-aviso alerta p-bloco">📍 {n === 1 ? 'Uma pessoa perto de você está' : `${n} pessoas perto de você estão`} esperando atendimento. Toque para aceitar.</Link>;
}

function Leads() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-leads'], queryFn: () => apiPortal<LeadPortal[]>('/leads'), refetchInterval: 30_000 });
  const [resultado, setResultado] = useState<{ id: string; deuCerto: boolean; motivo: string } | null>(null);
  const acao = useMutation({
    mutationFn: ({ id, a, corpo }: { id: string; a: 'aceitar' | 'recusar' | 'resultado'; corpo?: unknown }) => apiPortal(`/leads/${id}/${a}`, { corpo: corpo ?? {} }),
    onSuccess: () => { setResultado(null); qc.invalidateQueries({ queryKey: ['p-leads'] }); },
  });
  const [, atualizar] = useState(0);
  useEffect(() => { const t = setInterval(() => atualizar((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const lista = q.data!;
  const grupos: [string, LeadPortal[]][] = [
    ['Esperando você aceitar', lista.filter((l) => l.situacao === 'aguardando')],
    ['Em atendimento', lista.filter((l) => l.situacao === 'aceito')],
    ['Atendidas nos últimos 30 dias', lista.filter((l) => l.situacao === 'concluido')],
  ];
  const zap = (t: string, nome: string) => `https://wa.me/${t}?text=${encodeURIComponent(`Oi, ${nome.split(' ')[0]}! Aqui é da Aritana Semijoias, recebi seu contato.`)}`;
  return (
    <>
      <Topo titulo="Clientes" sub="Pedidos do seu catálogo e contatos que a Aritana mandou para você." />
      <PedidosCatalogo />
      <div className="p-rotulo" style={{ marginTop: 6 }}>Perto de você</div>
      <Aviso erro={acao.error} />
      {!lista.length && <div className="p-cartao p-suave">Nenhum contato agora. Quando chegar alguém da sua região, você recebe um aviso no WhatsApp.</div>}
      {grupos.map(([titulo, ls]) => ls.length > 0 && (
        <section key={titulo} className="p-col" style={{ gap: 10 }}>
          <div className="p-rotulo">{titulo}</div>
          {ls.map((l) => (
            <div key={l.id} className="p-cartao p-col">
              <div className="p-linha" style={{ padding: 0 }}>
                <b>{l.nome}</b>
                <span className="p-suave">{l.tipo === 'candidata' ? 'Quer ser revendedora' : 'Cliente'}</span>
              </div>
              <div className="p-suave">{[l.cidade, l.distanciaKm == null ? null : l.distanciaKm < 1 ? 'na sua cidade' : `${String(l.distanciaKm).replace('.', ',')} km de você`].filter(Boolean).join(' · ')}</div>
              {l.situacao === 'aguardando' && (
                <>
                  {l.aceitarAte && <div className="p-erro">Aceite em até {faltam(l.aceitarAte)}</div>}
                  <button className="p-botao" disabled={acao.isPending} onClick={() => acao.mutate({ id: l.id, a: 'aceitar' })}>Aceitar e ver o contato</button>
                  <button className="p-botao claro" disabled={acao.isPending} onClick={() => { const m = window.prompt('Por que não pode atender? (opcional)'); if (m !== null) acao.mutate({ id: l.id, a: 'recusar', corpo: { motivo: m || null } }); }}>Não posso atender</button>
                </>
              )}
              {l.situacao !== 'aguardando' && l.interesse.length > 0 && l.interesse.map(([k, v]) => <div key={k} className="p-linha"><span className="p-suave">{k}</span><span>{v}</span></div>)}
              {l.situacao === 'aceito' && l.telefone && (
                <>
                  <a className="p-botao" href={zap(l.telefone, l.nome)} target="_blank" rel="noreferrer">Chamar no WhatsApp</a>
                  {resultado?.id === l.id ? (
                    <div className="p-col">
                      <textarea rows={2} placeholder={resultado.deuCerto ? 'Algo a contar? (opcional)' : 'O que aconteceu? (opcional)'} value={resultado.motivo} onChange={(e) => setResultado({ ...resultado, motivo: e.target.value })} style={{ font: 'inherit', padding: 10, borderRadius: 10, border: '1px solid var(--linha)' }} />
                      <button className="p-botao" disabled={acao.isPending} onClick={() => acao.mutate({ id: l.id, a: 'resultado', corpo: { deuCerto: resultado.deuCerto, motivo: resultado.motivo || null } })}>Confirmar</button>
                    </div>
                  ) : (
                    <div className="p-grade2">
                      <button className="p-botao claro" onClick={() => setResultado({ id: l.id, deuCerto: true, motivo: '' })}>{l.tipo === 'candidata' ? 'Recomendo' : 'Vendi'}</button>
                      <button className="p-botao claro" onClick={() => setResultado({ id: l.id, deuCerto: false, motivo: '' })}>Não deu certo</button>
                    </div>
                  )}
                  <button className="p-link" onClick={() => { const m = window.prompt('Por que vai devolver este contato? (opcional)'); if (m !== null) acao.mutate({ id: l.id, a: 'recusar', corpo: { motivo: m || null } }); }}>Devolver para a Aritana</button>
                </>
              )}
              {l.situacao === 'concluido' && <div className="p-suave">Atendimento encerrado.</div>}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

// ───── Compromissos marcados pela Aritana (acerto por vídeo, retirada, reunião) ─────

function Compromissos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-agenda'], queryFn: () => apiPortal<{ id: string; titulo: string; inicio: string; fim: string; online: boolean; local: string | null; link: string | null; status: string }[]>('/agenda'), refetchInterval: 120_000 });
  const confirmar = useMutation({ mutationFn: (id: string) => apiPortal(`/agenda/${id}/confirmar`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-agenda'] }) });
  const proximos = (q.data ?? []).filter((c) => new Date(c.fim).getTime() > Date.now() && ['marcado', 'confirmado'].includes(c.status)).slice(0, 3);
  if (!proximos.length) return null;
  const quando = (d: string) => {
    const t = new Date(d).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  return (
    <div className="p-cartao p-col">
      <div className="p-rotulo">Seus compromissos</div>
      {proximos.map((c) => {
        const comeca = new Date(c.inicio).getTime() - Date.now();
        return (
          <div key={c.id} className="p-col" style={{ gap: 6, paddingTop: 4 }}>
            <b>{c.titulo}</b>
            <span className="p-suave">{quando(c.inicio)}{c.online ? ' · por vídeo' : c.local ? ` · ${c.local}` : ''}</span>
            {c.online && c.link && comeca < 30 * 60_000 && <a className="p-botao" href={c.link} target="_blank" rel="noreferrer">Entrar na chamada</a>}
            {c.status === 'marcado' ? (
              <button className="p-botao claro" disabled={confirmar.isPending} onClick={() => confirmar.mutate(c.id)}>Confirmar presença</button>
            ) : (
              <span className="p-suave" style={{ color: 'var(--ok)' }}>✓ Presença confirmada{c.online && c.link && comeca >= 30 * 60_000 ? ' · o botão da chamada aparece meia hora antes' : ''}</span>
            )}
          </div>
        );
      })}
      <Aviso erro={confirmar.error} />
    </div>
  );
}
