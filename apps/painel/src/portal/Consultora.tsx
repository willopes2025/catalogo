import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { data, reais } from '../formato';
import { apiPortal, ErroPortal } from './api';

const msgErro = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado. Tente de novo.');
const Aviso = ({ erro }: { erro: unknown }) => (erro ? <div className="p-aviso erro">{msgErro(erro)}</div> : null);
const Carregando = () => <div className="p-suave p-centro" style={{ padding: 40 }}>Carregando…</div>;
const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const somarMeses = (d: string, n: number) => { const [a, m, dia] = d.split('-').map(Number); const ult = new Date(Date.UTC(a, m - 1 + n + 1, 0)).getUTCDate(); return new Date(Date.UTC(a, m - 1 + n, Math.min(dia, ult))).toISOString().slice(0, 10); };
const paraCentavos = (t: string) => Math.round(Number((t || '0').replace(/\./g, '').replace(',', '.')) * 100) || 0;
const so = (t?: string | null) => (t ?? '').replace(/\D/g, '');
const zap = (tel: string | null | undefined, texto: string) => {
  const n = so(tel);
  return n ? `https://wa.me/${n.length <= 11 ? `55${n}` : n}?text=${encodeURIComponent(texto)}` : null;
};

function Topo({ titulo, sub, voltar, acao }: { titulo: string; sub?: ReactNode; voltar?: string; acao?: ReactNode }) {
  return (
    <header className="p-topo">
      {voltar && <Link to={voltar} className="p-voltar">←</Link>}
      <div style={{ flex: 1 }}>
        <h1>{titulo}</h1>
        {sub && <p className="p-suave">{sub}</p>}
      </div>
      {acao}
    </header>
  );
}

// ───── Mais (menu) ─────

export function Mais() {
  const perfil = useQuery({ queryKey: ['p-perfil'], queryFn: () => apiPortal('/perfil') });
  const contato = perfil.data?.whatsappMatriz ? zap(perfil.data.whatsappMatriz, `Oi! Aqui é a ${perfil.data.nome.split(' ')[0]}, consultora.`) : null;
  const itens: [string, string, string][] = [
    ['/portal/meu-catalogo', '🛒', 'Meu catálogo online'],
    ['/portal/pedir', '🛍️', 'Pedir peças para a maleta'],
    ['/portal/financeiro', '💳', 'Minhas parcelas com a Aritana'],
    ['/portal/extrato', '📈', 'Comissões e créditos'],
    ['/portal/pontos', '⭐', 'Pontos e prêmios'],
    ['/portal/garantia', '🛠️', 'Garantia de peça'],
    ['/portal/treinamentos', '🎓', 'Treinamentos'],
    ['/portal/divulgacao', '📣', 'Material de divulgação'],
    ['/portal/leads', '🧲', 'Contatos enviados pela Aritana'],
    ['/portal/perfil', '👤', 'Meus dados e documentos'],
  ];
  return (
    <>
      <Topo titulo="Mais" />
      {itens.map(([to, ico, nome]) => (
        <Link key={to} to={to} className="p-cartao p-bloco p-linha"><span>{ico} {nome}</span><span>›</span></Link>
      ))}
      {contato && <a className="p-botao p-bloco" href={contato} target="_blank" rel="noreferrer">💬 Falar com a Aritana no WhatsApp</a>}
    </>
  );
}

// ───── Peças liberadas pela matriz (pedir peças e montar o catálogo) ─────

interface PaginaVitrine { itens: any[]; temMais: boolean; pagina: number; total: number; categorias: string[]; porCategoria: { nome: string; n: number }[]; meuCatalogo: { manual: boolean; escolhidas: number } }

/** Busca com espera de meio segundo depois de digitar, carregando de 60 em 60 peças. */
export function usarVitrinePortal(busca: string, categoria: string, escolhidas = false) {
  const [termo, setTermo] = useState(busca);
  useEffect(() => { const t = setTimeout(() => setTermo(busca), 450); return () => clearTimeout(t); }, [busca]);
  return useInfiniteQuery({
    queryKey: ['p-catalogo', termo, categoria, escolhidas],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => apiPortal<PaginaVitrine>(`/catalogo?${new URLSearchParams({ pagina: String(pageParam), ...(termo.trim() && { busca: termo.trim() }), ...(categoria && { categoria }), ...(escolhidas && { escolhidas: '1' }) })}`),
    getNextPageParam: (ultima) => (ultima.temMais ? ultima.pagina + 1 : undefined),
  });
}

export function ChipsCategorias({ porCategoria, cat, setCat }: { porCategoria?: { nome: string; n: number }[]; cat: string; setCat: (c: string) => void }) {
  if (!porCategoria?.length) return null;
  return (
    <div className="p-chips">
      <button className={!cat ? 'ativo' : ''} onClick={() => setCat('')}>Todas</button>
      {porCategoria.map((c) => <button key={c.nome} className={cat === c.nome ? 'ativo' : ''} onClick={() => setCat(c.nome)}>{c.nome} <span className="p-suave">{c.n}</span></button>)}
    </div>
  );
}

/**
 * Catálogo online da consultora: no padrão entram todas as peças que a matriz liberou; no manual, só as que
 * ela escolher aqui. As peças da maleta dela aparecem sempre, como pronta entrega.
 */
export function MeuCatalogo() {
  const qc = useQueryClient();
  const eu = useQuery({ queryKey: ['p-eu'], queryFn: () => apiPortal<any>('/eu') });
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [soMinhas, setSoMinhas] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const q = usarVitrinePortal(busca, cat, soMinhas);
  const primeira = q.data?.pages[0];
  const manual = primeira?.meuCatalogo.manual ?? false;
  const atualizar = () => qc.invalidateQueries({ queryKey: ['p-catalogo'] });
  const modo = useMutation({ mutationFn: (m: boolean) => apiPortal('/meu-catalogo/modo', { corpo: { manual: m } }), onSuccess: atualizar });
  const escolher = useMutation({ mutationFn: (corpo: { incluir: boolean; produtoIds?: string[]; categoria?: string; todas?: boolean }) => apiPortal('/meu-catalogo/pecas', { corpo }), onSuccess: atualizar });
  const url = eu.data?.catalogo ? `${window.location.origin}${eu.data.catalogo}` : null;
  const copiar = async () => {
    if (!url) return;
    try {
      if (navigator.share) await navigator.share({ title: 'Meu catálogo Aritana', url });
      else { await navigator.clipboard.writeText(url); setCopiado(true); }
    } catch { /* cancelado */ }
  };
  const itens = q.data?.pages.flatMap((p) => p.itens) ?? [];
  return (
    <>
      <Topo titulo="Meu catálogo online" voltar="/portal/mais" sub="O link que você manda para as clientes escolherem e pedirem." />
      {url && (
        <div className="p-cartao p-col">
          <span className="p-suave" style={{ wordBreak: 'break-all' }}>{url}</span>
          <div className="p-linha" style={{ gap: 8 }}>
            <button className="p-botao" onClick={() => void copiar()}>{copiado ? 'Link copiado!' : 'Compartilhar'}</button>
            <a className="p-botao claro" href={url} target="_blank" rel="noreferrer">Ver como a cliente vê</a>
          </div>
        </div>
      )}
      <div className="p-cartao p-col">
        <div className="p-rotulo">O que aparece no seu catálogo</div>
        <label className="p-check"><input type="radio" checked={!manual} disabled={modo.isPending || !primeira} onChange={() => modo.mutate(false)} /> <span><b>Catálogo padrão</b><br /><span className="p-suave">Todas as peças que a Aritana libera, atualizado sozinho.</span></span></label>
        <label className="p-check"><input type="radio" checked={manual} disabled={modo.isPending || !primeira} onChange={() => modo.mutate(true)} /> <span><b>Escolher as peças</b><br /><span className="p-suave">Só as que você marcar abaixo ({primeira?.meuCatalogo.escolhidas ?? 0} escolhida(s)).</span></span></label>
        <span className="p-suave">As peças da sua maleta aparecem sempre, como pronta entrega. As outras a Aritana envia para a cliente (ou você retira).</span>
        <Aviso erro={modo.error ?? escolher.error} />
      </div>
      <input className="p-busca" placeholder="Buscar por nome ou referência" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <ChipsCategorias porCategoria={primeira?.porCategoria} cat={cat} setCat={setCat} />
      {manual && (
        <div className="p-linha" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="p-check"><input type="checkbox" checked={soMinhas} onChange={(e) => setSoMinhas(e.target.checked)} /> Só as do meu catálogo</label>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="p-botao claro" disabled={escolher.isPending} onClick={() => escolher.mutate(cat ? { incluir: true, categoria: cat } : { incluir: true, todas: true })}>+ {cat ? `Toda ${cat}` : 'Todas'}</button>
            <button className="p-botao claro" disabled={escolher.isPending} onClick={() => escolher.mutate(cat ? { incluir: false, categoria: cat } : { incluir: false, todas: true })}>− {cat ? `Tirar ${cat}` : 'Limpar'}</button>
          </span>
        </div>
      )}
      {q.isLoading && <Carregando />}
      <Aviso erro={q.error} />
      {primeira && <div className="p-suave">{primeira.total} peça(s) {soMinhas ? 'no seu catálogo' : 'liberadas'}{cat ? ` em ${cat}` : ''}</div>}
      <div className="p-vitrine">
        {itens.map((i) => (
          <div key={i.id} className="p-cartao p-produto" style={manual && i.noCatalogo ? { outline: '2px solid var(--dourado, #b0813f)' } : undefined}>
            {i.foto ? <img src={i.foto} alt="" loading="lazy" /> : <div className="p-foto" />}
            <b>{i.descricao}</b>
            <span className="p-suave">ref. {i.referencia}</span>
            <span>{reais(i.preco)}</span>
            {manual && (i.noCatalogo
              ? <button className="p-botao claro" disabled={escolher.isPending} onClick={() => escolher.mutate({ incluir: false, produtoIds: [i.id] })}>✓ No catálogo</button>
              : <button className="p-botao" disabled={escolher.isPending} onClick={() => escolher.mutate({ incluir: true, produtoIds: [i.id] })}>Colocar</button>)}
          </div>
        ))}
      </div>
      {q.data && !itens.length && <div className="p-cartao p-suave">Nenhuma peça encontrada.</div>}
      {q.hasNextPage && <button className="p-botao claro" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Carregando…' : 'Ver mais peças'}</button>}
    </>
  );
}

// ───── Clientes ─────

export function Clientes() {
  const q = useQuery({ queryKey: ['p-clientes'], queryFn: () => apiPortal<any[]>('/clientes') });
  const [busca, setBusca] = useState('');
  const [nova, setNova] = useState<any | null>(null);
  const lista = (q.data ?? []).filter((c) => !busca || `${c.nome} ${c.telefone ?? ''}`.toLowerCase().includes(busca.toLowerCase()));
  const aniversariantes = (q.data ?? []).filter((c) => c.aniversarioHoje);
  if (nova) return <FormCliente c={nova} fechar={() => setNova(null)} />;
  return (
    <>
      <Topo titulo="Minhas clientes" sub={q.data ? `${q.data.length} cliente(s)` : undefined} acao={<button className="p-botao" onClick={() => setNova({})}>+ Cliente</button>} />
      <Link to="/portal/leads" className="p-cartao p-bloco p-linha"><span>🧲 Contatos enviados pela Aritana</span><span>›</span></Link>
      {aniversariantes.map((c) => (
        <div key={c.id} className="p-aviso alerta">🎂 Hoje é aniversário de <b>{c.nome}</b>. {zap(c.telefone, `Feliz aniversário, ${c.nome.split(' ')[0]}! 🎉 Que tal escolher um mimo da Aritana? 💛`) && <a href={zap(c.telefone, `Feliz aniversário, ${c.nome.split(' ')[0]}! 🎉 Que tal escolher um mimo da Aritana? 💛`)!} target="_blank" rel="noreferrer">Mandar parabéns</a>}</div>
      ))}
      <input className="p-busca" placeholder="Buscar cliente" value={busca} onChange={(e) => setBusca(e.target.value)} />
      {q.isLoading ? <Carregando /> : q.error ? <Aviso erro={q.error} /> : !lista.length ? <div className="p-cartao p-suave">Nenhuma cliente ainda. Cadastre a primeira em "+ Cliente".</div> : lista.map((c) => (
        <div key={c.id} className="p-cartao p-col">
          <div className="p-linha"><b>{c.nome}</b><button className="p-link" onClick={() => setNova(c)}>Editar</button></div>
          <span className="p-suave">{c.telefone ?? 'sem telefone'}{c.cidade ? ` · ${c.cidade}` : ''}</span>
          {(c.aberto > 0 || c.emCobranca > 0) && (
            <span>
              {c.aberto > 0 && <>Deve <b>{reais(c.aberto)}</b>{c.vencido > 0 && <span className="p-erro"> ({reais(c.vencido)} vencido)</span>}</>}
              {c.emCobranca > 0 && <span className="p-suave"> · {reais(c.emCobranca)} com a Aritana</span>}
            </span>
          )}
          <div className="p-linha" style={{ gap: 8 }}>
            <Link className="p-botao claro" to={`/portal/vendas/nova?cliente=${c.id}`}>Nova venda</Link>
            <Link className="p-link" to={`/portal/vendas?cliente=${c.id}`}>Compras</Link>
            {c.vencido > 0 && zap(c.telefone, `Oi, ${c.nome.split(' ')[0]}! Tudo bem? Passando para lembrar da parcela de ${reais(c.vencido)} das semijoias que está em aberto. 💛`) && (
              <a className="p-link" href={zap(c.telefone, `Oi, ${c.nome.split(' ')[0]}! Tudo bem? Passando para lembrar da parcela de ${reais(c.vencido)} das semijoias que está em aberto. 💛`)!} target="_blank" rel="noreferrer">Lembrar</a>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function FormCliente({ c, fechar, aoSalvar }: { c: any; fechar: () => void; aoSalvar?: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ nome: c.nome ?? '', telefone: c.telefone ?? '', email: c.email ?? '', documento: c.documento ?? '', nascimento: c.nascimento ?? '', cep: c.cep ?? '', logradouro: c.logradouro ?? '', numero: c.numero ?? '', bairro: c.bairro ?? '', cidade: c.cidade ?? '', uf: c.uf ?? '', observacao: c.observacao ?? '' });
  const salvar = useMutation({
    mutationFn: () => apiPortal<{ id: string }>('/clientes', { corpo: { ...(c.id ? { id: c.id } : {}), ...f } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['p-clientes'] }); aoSalvar ? aoSalvar(r.id) : fechar(); },
  });
  const campo = (k: keyof typeof f, rotulo: string, extra: Record<string, unknown> = {}) => <label>{rotulo}<input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} /></label>;
  return (
    <>
      <Topo titulo={c.id ? 'Editar cliente' : 'Nova cliente'} />
      <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); salvar.mutate(); }}>
        {campo('nome', 'Nome', { autoFocus: true })}
        {campo('telefone', 'WhatsApp', { inputMode: 'tel', placeholder: '27 99999-0000' })}
        {campo('nascimento', 'Aniversário', { type: 'date' })}
        {campo('email', 'E-mail', { type: 'email' })}
        <p className="p-suave" style={{ margin: 0 }}>Para promissória e cobrança pela Aritana: CPF e endereço.</p>
        {campo('documento', 'CPF', { inputMode: 'numeric' })}
        {campo('cep', 'CEP', { inputMode: 'numeric' })}
        {campo('logradouro', 'Rua')}
        <div className="p-grade2">{campo('numero', 'Número')}{campo('bairro', 'Bairro')}</div>
        <div className="p-grade2">{campo('cidade', 'Cidade')}{campo('uf', 'UF', { maxLength: 2 })}</div>
        {campo('observacao', 'Observação')}
        <Aviso erro={salvar.error} />
        <button className="p-botao" disabled={f.nome.trim().length < 2 || salvar.isPending}>{salvar.isPending ? 'Salvando…' : 'Salvar'}</button>
        <button type="button" className="p-link" onClick={fechar}>Voltar</button>
      </form>
    </>
  );
}

// ───── Vendas ─────

const STATUS_VENDA: Record<string, string> = { aberta: 'A receber', quitada: 'Quitada', em_cobranca: 'Com a Aritana (cobrança)', cancelada: 'Cancelada' };

export function Vendas() {
  const cliente = new URLSearchParams(window.location.search).get('cliente');
  const q = useQuery({ queryKey: ['p-vendas', cliente], queryFn: () => apiPortal<any[]>(`/vendas${cliente ? `?clienteId=${cliente}` : ''}`) });
  const h = hoje();
  const aReceber = (q.data ?? []).filter((v) => v.status === 'aberta').reduce((a, v) => a + v.parcelas.filter((p: any) => !p.pagoEm).reduce((b: number, p: any) => b + p.valor, 0), 0);
  return (
    <>
      <Topo titulo="Minhas vendas" sub={aReceber > 0 ? `A receber das clientes: ${reais(aReceber)}` : undefined} acao={<Link className="p-botao" to="/portal/vendas/nova">+ Venda</Link>} />
      {q.isLoading ? <Carregando /> : q.error ? <Aviso erro={q.error} /> : !q.data!.length ? <div className="p-cartao p-suave">Nenhuma venda lançada ainda. Toque em "+ Venda" a cada venda: as peças da maleta já saem marcadas como vendidas para o acerto.</div> : q.data!.map((v) => {
        const vencida = v.status === 'aberta' && v.parcelas.some((p: any) => !p.pagoEm && p.vencimento < h);
        return (
          <Link key={v.id} to={`/portal/vendas/${v.id}`} className="p-cartao p-bloco p-col">
            <div className="p-linha"><b>{v.cliente}</b><b>{reais(v.total)}</b></div>
            <span className="p-suave">Nº {v.numero} · {data(v.criadoEm.slice(0, 10))} · {v.forma === 'avista' ? 'à vista' : `${v.parcelas.length}x`} · <span className={vencida ? 'p-erro' : ''}>{vencida ? 'Parcela vencida' : STATUS_VENDA[v.status]}</span></span>
          </Link>
        );
      })}
    </>
  );
}

export function NovaVenda() {
  const navegar = useNavigate();
  const qc = useQueryClient();
  const clientes = useQuery({ queryKey: ['p-clientes'], queryFn: () => apiPortal<any[]>('/clientes') });
  const [clienteId, setClienteId] = useState(new URLSearchParams(window.location.search).get('cliente') ?? '');
  const [novaCliente, setNovaCliente] = useState(false);
  const [busca, setBusca] = useState('');
  const pecas = useQuery({ queryKey: ['p-pecas-venda', busca], queryFn: () => apiPortal<{ maleta: any[]; matriz: any[] }>(`/pecas-venda?busca=${encodeURIComponent(busca)}`) });
  const [itens, setItens] = useState<{ produtoId: string; descricao: string; preco: number; quantidade: number; origem: 'maleta' | 'matriz'; max: number }[]>([]);
  const [desconto, setDesconto] = useState('');
  const [forma, setForma] = useState<'avista' | 'prazo'>('avista');
  const [formaPagamento, setFormaPagamento] = useState('pix');
  const [nParcelas, setNParcelas] = useState(2);
  const [primeiro, setPrimeiro] = useState(somarDias(hoje(), 30));
  const [intervalo, setIntervalo] = useState(30);
  const [entrega, setEntrega] = useState<'frete' | 'retirar'>('retirar');
  const [endereco, setEndereco] = useState('');
  const bruto = itens.reduce((a, i) => a + i.preco * i.quantidade, 0);
  const total = Math.max(0, bruto - paraCentavos(desconto));
  const parcelas = useMemo(() => {
    if (forma !== 'prazo' || !total) return [];
    const base = Math.floor(total / nParcelas);
    return Array.from({ length: nParcelas }, (_, k) => ({ valor: k === nParcelas - 1 ? total - base * (nParcelas - 1) : base, vencimento: intervalo === 30 ? somarMeses(primeiro, k) : somarDias(primeiro, intervalo * k) }));
  }, [forma, total, nParcelas, primeiro, intervalo]);
  const temMatriz = itens.some((i) => i.origem === 'matriz');
  const add = (p: any, origem: 'maleta' | 'matriz') => setItens((l) => {
    const ja = l.find((x) => x.produtoId === p.produtoId && x.origem === origem);
    if (ja) return l.map((x) => (x === ja ? { ...x, quantidade: Math.min(x.max, x.quantidade + 1) } : x));
    return [...l, { produtoId: p.produtoId, descricao: p.descricao, preco: p.preco, quantidade: 1, origem, max: origem === 'maleta' ? p.disponivel : 20 }];
  });
  const lancar = useMutation({
    mutationFn: () => apiPortal<any>('/vendas', { corpo: { clienteId, itens: itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade, origem: i.origem })), desconto: paraCentavos(desconto), forma, formaPagamento, parcelas, ...(temMatriz ? { entrega, enderecoEntrega: entrega === 'frete' ? endereco : null } : {}) } }),
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ['p-vendas'] }); qc.invalidateQueries({ queryKey: ['p-clientes'] }); navegar(`/portal/vendas/${v.id}`, { replace: true }); },
  });
  if (novaCliente) return <FormCliente c={{}} fechar={() => setNovaCliente(false)} aoSalvar={(id) => { setClienteId(id); setNovaCliente(false); }} />;
  return (
    <>
      <Topo titulo="Nova venda" voltar="/portal/vendas" />
      <div className="p-cartao p-col">
        <label>Cliente
          <select value={clienteId} onChange={(e) => (e.target.value === '__nova' ? setNovaCliente(true) : setClienteId(e.target.value))}>
            <option value="">Escolha…</option>
            <option value="__nova">+ Cadastrar nova cliente</option>
            {clientes.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </label>
      </div>
      <div className="p-cartao p-col">
        <div className="p-rotulo">Peças</div>
        <input className="p-busca" placeholder="Buscar na maleta e no catálogo da Aritana" value={busca} onChange={(e) => setBusca(e.target.value)} />
        {pecas.data?.maleta.slice(0, 30).map((p) => (
          <button key={`m${p.produtoId}`} className="p-linha p-link" style={{ textAlign: 'left' }} onClick={() => add(p, 'maleta')}><span>👜 {p.descricao} <span className="p-suave">({p.disponivel} na maleta)</span></span><b>{reais(p.preco)}</b></button>
        ))}
        {pecas.data?.matriz.map((p) => (
          <button key={`c${p.produtoId}`} className="p-linha p-link" style={{ textAlign: 'left' }} onClick={() => add(p, 'matriz')}><span>🏬 {p.descricao} <span className="p-suave">(catálogo: a Aritana envia)</span></span><b>{reais(p.preco)}</b></button>
        ))}
        {busca.length >= 2 && !pecas.data?.maleta.length && !pecas.data?.matriz.length && <span className="p-suave">Nada encontrado.</span>}
      </div>
      {itens.length > 0 && (
        <div className="p-cartao p-col">
          {itens.map((i, k) => (
            <div key={k} className="p-linha">
              <span>{i.origem === 'maleta' ? '👜' : '🏬'} {i.descricao}<br /><span className="p-suave">{reais(i.preco)}</span></span>
              <div className="p-contador">
                <button onClick={() => setItens((l) => (i.quantidade <= 1 ? l.filter((_, j) => j !== k) : l.map((x, j) => (j === k ? { ...x, quantidade: x.quantidade - 1 } : x))))}>−</button>
                <span>{i.quantidade}</span>
                <button disabled={i.quantidade >= i.max} onClick={() => setItens((l) => l.map((x, j) => (j === k ? { ...x, quantidade: x.quantidade + 1 } : x)))}>+</button>
              </div>
            </div>
          ))}
          <label>Desconto (R$)<input inputMode="decimal" value={desconto} onChange={(e) => setDesconto(e.target.value)} placeholder="0,00" /></label>
          <div className="p-linha"><b>Total</b><b className="p-grande">{reais(total)}</b></div>
        </div>
      )}
      {temMatriz && (
        <div className="p-cartao p-col">
          <div className="p-rotulo">Peças do catálogo da Aritana</div>
          <label className="p-linha"><span><input type="radio" checked={entrega === 'retirar'} onChange={() => setEntrega('retirar')} /> Eu retiro na Aritana e entrego</span></label>
          <label className="p-linha"><span><input type="radio" checked={entrega === 'frete'} onChange={() => setEntrega('frete')} /> A Aritana envia para a cliente (frete por conta dela)</span></label>
          {entrega === 'frete' && <label>Endereço de entrega<input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua, número, bairro, cidade, CEP" /></label>}
          <span className="p-suave">A peça é cobrada de você no acerto, como as da maleta.</span>
        </div>
      )}
      <div className="p-cartao p-col">
        <div className="p-chips">
          <button className={forma === 'avista' ? 'ativo' : ''} onClick={() => setForma('avista')}>À vista</button>
          <button className={forma === 'prazo' ? 'ativo' : ''} onClick={() => setForma('prazo')}>A prazo</button>
        </div>
        {forma === 'avista' ? (
          <label>Como recebeu<select value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)}><option value="pix">Pix</option><option value="dinheiro">Dinheiro</option><option value="cartao">Cartão</option></select></label>
        ) : (
          <>
            <div className="p-grade2">
              <label>Parcelas<select value={nParcelas} onChange={(e) => setNParcelas(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}x</option>)}</select></label>
              <label>1º vencimento<input type="date" value={primeiro} onChange={(e) => setPrimeiro(e.target.value)} /></label>
            </div>
            <label>Parcelas a cada<select value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}><option value={30}>1 mês</option><option value={15}>15 dias</option><option value={7}>1 semana</option></select></label>
            {parcelas.map((p, k) => <div key={k} className="p-linha p-suave"><span>{k + 1}ª · {data(p.vencimento)}</span><span>{reais(p.valor)}</span></div>)}
            <span className="p-suave">Depois de lançar, você pode mandar a promissória para a cliente assinar pelo celular.</span>
          </>
        )}
      </div>
      <Aviso erro={lancar.error} />
      <button className="p-botao p-bloco" disabled={!clienteId || !itens.length || !total || (temMatriz && entrega === 'frete' && endereco.trim().length < 8) || lancar.isPending} onClick={() => lancar.mutate()}>{lancar.isPending ? 'Lançando…' : `Lançar venda de ${reais(total)}`}</button>
    </>
  );
}

export function DetalheVenda() {
  const { id } = useParams();
  const qc = useQueryClient();
  const vendas = useQuery({ queryKey: ['p-vendas', null], queryFn: () => apiPortal<any[]>('/vendas') });
  const perfil = useQuery({ queryKey: ['p-perfil'], queryFn: () => apiPortal('/perfil') });
  const v = vendas.data?.find((x) => x.id === id);
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['p-vendas'] }); qc.invalidateQueries({ queryKey: ['p-clientes'] }); };
  const pago = useMutation({ mutationFn: (d: { numero: number; pago: boolean }) => apiPortal(`/vendas/${id}/parcelas/${d.numero}`, { corpo: { pago: d.pago } }), onSuccess: atualizar });
  const cancelar = useMutation({ mutationFn: () => apiPortal(`/vendas/${id}/cancelar`, { corpo: {} }), onSuccess: atualizar });
  const prom = useMutation({ mutationFn: () => apiPortal<{ token: string; telefone: string | null; nome: string; status: string }>(`/vendas/${id}/promissoria`, { corpo: {} }) });
  const [termo, setTermo] = useState(false);
  const aceite = useMutation({ mutationFn: () => apiPortal('/cobranca/aceite', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-perfil'] }) });
  const cobrar = useMutation({ mutationFn: () => apiPortal<{ split: boolean; parcelas: number }>(`/vendas/${id}/cobranca`, { corpo: {} }), onSuccess: atualizar });
  if (vendas.isLoading) return <Carregando />;
  if (!v) return <><Topo titulo="Venda" voltar="/portal/vendas" /><div className="p-cartao p-suave">Venda não encontrada.</div></>;
  const linkProm = prom.data ? `${window.location.origin}/assinar/${prom.data.token}` : null;
  const abertas = v.parcelas.filter((p: any) => !p.pagoEm);
  const taxa = (perfil.data?.taxaCobrancaPb ?? 0) / 100;
  return (
    <>
      <Topo titulo={`Venda nº ${v.numero}`} voltar="/portal/vendas" sub={`${v.cliente} · ${data(v.criadoEm.slice(0, 10))} · ${STATUS_VENDA[v.status]}`} />
      <div className="p-cartao p-col">
        {v.itens.map((i: any, k: number) => <div key={k} className="p-linha"><span>{i.origem === 'maleta' ? '👜' : '🏬'} {i.quantidade}x {i.descricao}</span><span>{reais(i.preco * i.quantidade)}</span></div>)}
        {v.desconto > 0 && <div className="p-linha p-suave"><span>Desconto</span><span>−{reais(v.desconto)}</span></div>}
        <div className="p-linha"><b>Total</b><b>{reais(v.total)}</b></div>
      </div>
      {v.forma === 'prazo' && (
        <div className="p-cartao p-col">
          <div className="p-rotulo">Parcelas</div>
          {v.parcelas.map((p: any) => (
            <div key={p.numero} className="p-linha">
              <span>{p.numero}ª · {data(p.vencimento)} · {reais(p.valor)}<br /><span className={p.pagoEm ? 'p-suave' : p.vencimento < hoje() ? 'p-erro' : 'p-suave'}>{p.pagoEm ? `Recebida ${data(p.pagoEm)}` : v.status === 'em_cobranca' ? 'Boleto com a Aritana (você ainda pode receber)' : p.vencimento < hoje() ? 'Vencida' : 'Em aberto'}</span></span>
              {v.status === 'aberta' && <button className="p-link" disabled={pago.isPending} onClick={() => pago.mutate({ numero: p.numero, pago: !p.pagoEm })}>{p.pagoEm ? 'Desfazer' : 'Recebi'}</button>}
              {v.status === 'em_cobranca' && !p.pagoEm && <button className="p-link" disabled={pago.isPending} onClick={() => window.confirm(`A cliente pagou esta parcela direto para você? O boleto da Aritana é cancelado e ${taxa}% (${reais(Math.round((p.valor * taxa) / 100))}) da cobrança será descontado das suas comissões no acerto.`) && pago.mutate({ numero: p.numero, pago: true })}>Recebi</button>}
            </div>
          ))}
          <Aviso erro={pago.error} />
        </div>
      )}
      {v.forma === 'prazo' && v.status !== 'cancelada' && (
        <div className="p-cartao p-col">
          <div className="p-rotulo">Promissória da cliente</div>
          {!linkProm ? <button className="p-botao claro" disabled={prom.isPending} onClick={() => prom.mutate()}>{prom.isPending ? 'Gerando…' : 'Gerar promissória para assinar'}</button> : (
            <>
              <span className="p-suave">{prom.data!.status === 'assinado' ? 'Assinada ✓' : 'Mande o link para a cliente assinar pelo celular (ela recebe um código no WhatsApp ou e-mail).'}</span>
              {prom.data!.status !== 'assinado' && zap(prom.data!.telefone, `Oi, ${prom.data!.nome.split(' ')[0]}! Segue a promissória das suas semijoias para assinar pelo celular: ${linkProm}`) && <a className="p-botao" href={zap(prom.data!.telefone, `Oi, ${prom.data!.nome.split(' ')[0]}! Segue a promissória das suas semijoias para assinar pelo celular: ${linkProm}`)!} target="_blank" rel="noreferrer">Enviar pelo WhatsApp</a>}
              <button className="p-link" onClick={() => navigator.clipboard?.writeText(linkProm!)}>Copiar link</button>
            </>
          )}
          <Aviso erro={prom.error} />
        </div>
      )}
      {v.status === 'aberta' && abertas.length > 0 && v.forma === 'prazo' && (
        <div className="p-cartao p-col">
          <div className="p-rotulo">Passar a cobrança para a Aritana</div>
          <span className="p-suave">A Aritana emite o boleto para a cliente e cobra. Quando ela pagar, você recebe {100 - taxa}% ({perfil.data?.asaasWalletId ? 'direto na sua conta Asaas' : 'como crédito no fechamento'}). Você pode continuar cobrando a cliente: se ela pagar direto para você, toque em "Recebi" na parcela e o percentual da cobrança ({taxa}%) será descontado das suas comissões no acerto.</span>
          {!perfil.data?.aceiteCobrancaEm ? (
            !termo ? <button className="p-botao claro" onClick={() => setTermo(true)}>Acionar cobrança</button> : (
              <>
                <div className="p-aviso alerta" style={{ whiteSpace: 'pre-wrap' }}>{perfil.data?.termoCobranca}</div>
                <button className="p-botao" disabled={aceite.isPending} onClick={() => aceite.mutate()}>Li e aceito</button>
              </>
            )
          ) : <button className="p-botao" disabled={cobrar.isPending} onClick={() => cobrar.mutate()}>{cobrar.isPending ? 'Enviando…' : `Acionar cobrança de ${reais(abertas.reduce((a: number, p: any) => a + p.valor, 0))}`}</button>}
          {cobrar.error instanceof ErroPortal && cobrar.error.dados?.mensagem?.includes('cadastro') && <Link className="p-link" to="/portal/clientes">Completar cadastro da cliente</Link>}
          <Aviso erro={cobrar.error ?? aceite.error} />
        </div>
      )}
      {v.status === 'aberta' && <button className="p-link p-centro" disabled={cancelar.isPending} onClick={() => window.confirm('Cancelar esta venda? As peças da maleta voltam a ficar disponíveis.') && cancelar.mutate()}>Cancelar venda</button>}
      <Aviso erro={cancelar.error} />
    </>
  );
}

// ───── Garantia ─────

export function Garantia() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-garantias'], queryFn: () => apiPortal<any[]>('/garantias') });
  const clientes = useQuery({ queryKey: ['p-clientes'], queryFn: () => apiPortal<any[]>('/clientes') });
  const [f, setF] = useState({ referencia: '', defeito: '', clienteId: '', dataCompra: '' });
  const [fotos, setFotos] = useState<string[]>([]);
  const abrir = useMutation({
    mutationFn: () => apiPortal<{ numero: number }>('/garantias', { corpo: { ...f, clienteId: f.clienteId || null, dataCompra: f.dataCompra || null, fotos } }),
    onSuccess: () => { setF({ referencia: '', defeito: '', clienteId: '', dataCompra: '' }); setFotos([]); qc.invalidateQueries({ queryKey: ['p-garantias'] }); },
  });
  const lerFoto = (file: File) => new Promise<string>((ok) => {
    const img = new Image();
    img.onload = () => {
      const esc = Math.min(1, 1280 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = img.width * esc; cv.height = img.height * esc;
      cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
      ok(cv.toDataURL('image/jpeg', 0.82));
    };
    img.src = URL.createObjectURL(file);
  });
  return (
    <>
      <Topo titulo="Garantia" voltar="/portal/mais" />
      <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); abrir.mutate(); }}>
        <label>Código ou referência da peça<input value={f.referencia} onChange={(e) => setF({ ...f, referencia: e.target.value })} placeholder="Está na etiqueta" /></label>
        <label>O que aconteceu<textarea rows={3} value={f.defeito} onChange={(e) => setF({ ...f, defeito: e.target.value })} placeholder="Ex.: a pedra soltou com 10 dias de uso" /></label>
        <label>Cliente (se for de cliente)<select value={f.clienteId} onChange={(e) => setF({ ...f, clienteId: e.target.value })}><option value="">Peça da minha maleta</option>{clientes.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
        <label>Data da compra<input type="date" value={f.dataCompra} onChange={(e) => setF({ ...f, dataCompra: e.target.value })} /></label>
        <label className="p-botao claro" style={{ textAlign: 'center' }}>📷 {fotos.length ? `${fotos.length} foto(s)` : 'Tirar/escolher fotos'}<input type="file" accept="image/*" multiple hidden onChange={async (e) => { const fs = [...(e.target.files ?? [])].slice(0, 4); setFotos(await Promise.all(fs.map(lerFoto))); }} /></label>
        <Aviso erro={abrir.error} />
        {abrir.isSuccess && <div className="p-aviso">Garantia nº {abrir.data.numero} aberta. A Aritana avisa quando decidir (troca ou conserto).</div>}
        <button className="p-botao" disabled={f.referencia.trim().length < 2 || f.defeito.trim().length < 5 || abrir.isPending}>{abrir.isPending ? 'Enviando…' : 'Abrir garantia'}</button>
      </form>
      {q.data?.map((g) => (
        <div key={g.id} className="p-cartao p-col">
          <div className="p-linha"><b>Nº {g.numero}</b><span className="p-selo">{({ aberta: 'Aberta', na_assistencia: 'Na assistência', pronta: 'Pronta', concluida: 'Concluída', cancelada: 'Cancelada' } as Record<string, string>)[g.status] ?? g.status}</span></div>
          <span className="p-suave">{g.produto ?? ''} · {data(g.criadoEm.slice(0, 10))}{g.decisao ? ` · ${g.decisao}` : ''}</span>
        </div>
      ))}
    </>
  );
}

// ───── Extrato ─────

export function Extrato() {
  const q = useQuery({ queryKey: ['p-extrato'], queryFn: () => apiPortal('/extrato') });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const e = q.data;
  return (
    <>
      <Topo titulo="Comissões e créditos" voltar="/portal/mais" />
      <div className="p-cartao"><div className="p-rotulo">Crédito com a Aritana</div><div className="p-grande">{reais(e.saldoCredito)}</div><div className="p-suave">Usado no próximo acerto</div></div>
      <div className="p-cartao p-col">
        <div className="p-rotulo">Comissão por acerto</div>
        {!e.acertos.length && <span className="p-suave">Nenhum acerto ainda.</span>}
        {e.acertos.map((a: any) => <div key={a.id} className="p-linha"><span>{data(a.data)} · maleta nº {a.maleta}<br /><span className="p-suave">vendido {reais(a.vendido)}</span></span><b>{reais(a.comissao)}</b></div>)}
      </div>
      <div className="p-cartao p-col">
        <div className="p-rotulo">Créditos e descontos</div>
        {!e.creditos.length && <span className="p-suave">Nada por aqui.</span>}
        {e.creditos.map((c: any) => <div key={c.id} className="p-linha"><span>{data(String(c.data).slice(0, 10))}<br /><span className="p-suave">{c.descricao}</span></span><b className={c.valor < 0 ? 'p-erro' : ''}>{reais(c.valor)}</b></div>)}
      </div>
    </>
  );
}

// ───── Treinamentos e divulgação ─────

const CATEGORIAS_TREINO: Record<string, string> = { boas_vindas: 'Boas-vindas', sistema: 'Como usar o app', vendas: 'Vendas', negociacao: 'Negociação', produto: 'Produto', outro: 'Outros' };

export function Conteudos({ secao }: { secao: 'treinamento' | 'divulgacao' }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-conteudos', secao], queryFn: () => apiPortal<any[]>(`/conteudos?secao=${secao}`) });
  const visto = useMutation({ mutationFn: (id: string) => apiPortal(`/conteudos/${id}/visto`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-conteudos', secao] }) });
  const [aberto, setAberto] = useState<string | null>(null);
  const grupos = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const c of q.data ?? []) m.set(c.categoria, [...(m.get(c.categoria) ?? []), c]);
    return [...m.entries()];
  }, [q.data]);
  const total = q.data?.length ?? 0;
  const vistos = q.data?.filter((c) => c.visto).length ?? 0;
  const compartilhar = async (c: any) => {
    try {
      const blob = await (await fetch(c.url)).blob();
      const file = new File([blob], `${c.titulo}.${c.arquivo.split('.').pop()}`, { type: c.mime });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: c.legenda ?? '' });
      else window.open(c.url, '_blank');
    } catch { /* cancelado */ }
  };
  return (
    <>
      <Topo titulo={secao === 'treinamento' ? 'Treinamentos' : 'Material de divulgação'} voltar="/portal/mais" sub={secao === 'treinamento' && total ? `${vistos} de ${total} vistos` : undefined} />
      {q.isLoading ? <Carregando /> : q.error ? <Aviso erro={q.error} /> : !total ? <div className="p-cartao p-suave">Em breve.</div> : grupos.map(([cat, itens]) => (
        <div key={cat} className="p-col">
          <div className="p-rotulo" style={{ margin: '10px 4px 4px' }}>{secao === 'treinamento' ? (CATEGORIAS_TREINO[cat] ?? cat) : cat}</div>
          {itens.map((c) => (
            <div key={c.id} className="p-cartao p-col">
              <button className="p-linha p-link" style={{ textAlign: 'left' }} onClick={() => setAberto(aberto === c.id ? null : c.id)}><span>{c.mime.startsWith('video') ? '▶️' : c.mime.startsWith('image') ? '🖼️' : c.mime === 'application/pdf' ? '📄' : '🎧'} <b>{c.titulo}</b></span><span>{c.visto ? '✓' : ''}</span></button>
              {aberto === c.id && (
                <>
                  {c.descricao && <span className="p-suave">{c.descricao}</span>}
                  {c.mime.startsWith('video') && <video src={c.url} controls playsInline style={{ width: '100%', borderRadius: 10 }} onEnded={() => !c.visto && visto.mutate(c.id)} />}
                  {c.mime.startsWith('image') && <img src={c.url} alt={c.titulo} style={{ width: '100%', borderRadius: 10 }} />}
                  {c.mime.startsWith('audio') && <audio src={c.url} controls style={{ width: '100%' }} onEnded={() => !c.visto && visto.mutate(c.id)} />}
                  {c.mime === 'application/pdf' && <a className="p-botao claro" href={c.url} target="_blank" rel="noreferrer" onClick={() => !c.visto && visto.mutate(c.id)}>Abrir PDF</a>}
                  {secao === 'treinamento' && !c.visto && <button className="p-link" onClick={() => visto.mutate(c.id)}>Marcar como visto</button>}
                  {secao === 'divulgacao' && (
                    <>
                      {c.legenda && <div className="p-aviso" style={{ whiteSpace: 'pre-wrap' }}>{c.legenda}</div>}
                      <div className="p-linha" style={{ gap: 8 }}>
                        <button className="p-botao" onClick={() => void compartilhar(c)}>Compartilhar</button>
                        {c.legenda && <button className="p-link" onClick={() => navigator.clipboard?.writeText(c.legenda)}>Copiar legenda</button>}
                        <a className="p-link" href={c.url} download target="_blank" rel="noreferrer">Baixar</a>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ───── Perfil ─────

const NOME_DOC: Record<string, string> = { contrato: 'Contrato', promissoria: 'Promissória', aditivo: 'Aditivo', promissoria_venda: 'Promissória de cliente' };

export function Perfil() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-perfil'], queryFn: () => apiPortal('/perfil') });
  const [f, setF] = useState<Record<string, string> | null>(null);
  const salvar = useMutation({ mutationFn: () => apiPortal('/perfil', { metodo: 'PATCH', corpo: f }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['p-perfil'] }); } });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Aviso erro={q.error} />;
  const p = q.data;
  const v: Record<string, string> = f ?? { email: p.email ?? '', cep: p.cep ?? '', logradouro: p.logradouro ?? '', numero: p.numero ?? '', complemento: p.complemento ?? '', bairro: p.bairro ?? '', cidade: p.cidade ?? '', uf: p.uf ?? '', chavePix: p.chavePix ?? '', asaasWalletId: p.asaasWalletId ?? '' };
  const campo = (k: string, rotulo: string, extra: Record<string, unknown> = {}) => <label>{rotulo}<input value={v[k]} onChange={(e) => setF({ ...v, [k]: e.target.value })} {...extra} /></label>;
  return (
    <>
      <Topo titulo="Meus dados" voltar="/portal/mais" sub={`${p.nome} · WhatsApp ${p.telefone ?? '—'}`} />
      <form className="p-cartao p-col" onSubmit={(e: FormEvent) => { e.preventDefault(); salvar.mutate(); }}>
        {campo('email', 'E-mail (para entrar no app)', { type: 'email' })}
        {campo('cep', 'CEP', { inputMode: 'numeric' })}
        {campo('logradouro', 'Rua')}
        <div className="p-grade2">{campo('numero', 'Número')}{campo('complemento', 'Complemento')}</div>
        {campo('bairro', 'Bairro')}
        <div className="p-grade2">{campo('cidade', 'Cidade')}{campo('uf', 'UF', { maxLength: 2 })}</div>
        <div className="p-rotulo" style={{ marginTop: 8 }}>Para receber</div>
        {campo('chavePix', 'Chave Pix')}
        {campo('asaasWalletId', 'Wallet ID do Asaas (opcional)', { placeholder: 'Para receber direto as cobranças passadas à Aritana' })}
        <span className="p-suave">O Wallet ID fica no app do Asaas em Minha conta › Integrações. Sem ele, o que a Aritana receber das suas clientes vira crédito no fechamento.</span>
        <span className="p-suave">Para mudar o nome ou o WhatsApp, fale com a Aritana.</span>
        <Aviso erro={salvar.error} />
        {f && <button className="p-botao" disabled={salvar.isPending}>{salvar.isPending ? 'Salvando…' : 'Salvar'}</button>}
        {salvar.isSuccess && !f && <div className="p-aviso">Salvo ✓</div>}
      </form>
      <div className="p-cartao p-col">
        <div className="p-rotulo">Documentos</div>
        {!p.documentos.length && <span className="p-suave">Nenhum documento.</span>}
        {p.documentos.map((d: any) => (
          <a key={d.id} className="p-linha" href={`/assinar/${d.token}`}><span>{NOME_DOC[d.tipo] ?? d.tipo}<br /><span className="p-suave">{d.titulo}</span></span><span className={d.status === 'pendente' ? 'p-erro' : 'p-suave'}>{d.status === 'assinado' ? `Assinado ${data(String(d.assinadoEm).slice(0, 10))}` : 'Assinar'}</span></a>
        ))}
      </div>
    </>
  );
}

// ───── Maleta: onde está e agendar o acerto ─────

const ETAPAS: Record<string, string> = { criada: 'Sendo montada', aguardando_retirada: 'Pronta para retirar', em_transito: 'A caminho', entregue: 'Com você', voltando: 'Voltando para a Aritana', em_conferencia: 'Em conferência' };

export function OndeEstaMaleta({ etapa }: { etapa?: string | null }) {
  const ordem = Object.keys(ETAPAS);
  const atual = ordem.indexOf(etapa ?? 'criada');
  return (
    <div className="p-cartao p-col">
      <div className="p-rotulo">Onde está a maleta</div>
      <div className="p-linha" style={{ gap: 4, flexWrap: 'wrap' }}>
        {ordem.map((e, k) => <span key={e} className="p-selo" style={{ opacity: k === atual ? 1 : k < atual ? 0.6 : 0.3, fontWeight: k === atual ? 700 : 400 }}>{ETAPAS[e]}</span>)}
      </div>
    </div>
  );
}

export function AgendarAcerto({ maletaId }: { maletaId: string }) {
  const [abrir, setAbrir] = useState(false);
  const [f, setF] = useState({ forma: 'presencial', data: somarDias(hoje(), 1), hora: '10:00', observacao: '' });
  const m = useMutation({ mutationFn: () => apiPortal('/acerto/agendar', { corpo: { maletaId, ...f } }) });
  if (m.isSuccess) return <div className="p-aviso">Pedido enviado ✓ A Aritana confirma o horário com você.</div>;
  if (!abrir) return <button className="p-botao claro p-bloco" onClick={() => setAbrir(true)}>📅 Agendar o acerto</button>;
  return (
    <div className="p-cartao p-col">
      <div className="p-rotulo">Agendar o acerto</div>
      <div className="p-chips">
        {[['presencial', 'Presencial'], ['video', 'Por vídeo'], ['envio', 'Vou enviar a maleta']].map(([k, n]) => <button key={k} className={f.forma === k ? 'ativo' : ''} onClick={() => setF({ ...f, forma: k })}>{n}</button>)}
      </div>
      <div className="p-grade2">
        <label>{f.forma === 'envio' ? 'Dia do envio' : 'Dia'}<input type="date" min={hoje()} value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} /></label>
        <label>Hora<input type="time" value={f.hora} onChange={(e) => setF({ ...f, hora: e.target.value })} /></label>
      </div>
      <label>Observação<input value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} /></label>
      <Aviso erro={m.error} />
      <button className="p-botao" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Enviando…' : 'Pedir este horário'}</button>
    </div>
  );
}
