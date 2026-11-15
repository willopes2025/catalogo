import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { reais } from '../formato';
import { Carregando, Erro } from '../componentes/ui';
import './catalogo.css';

interface Peca { id: string; referencia: string; descricao: string; categoria: string | null; cor: string | null; tamanho: string | null; preco: number; foto: string | null; disponivel: number }
interface Vitrine {
  representante: { nome: string; cidade: string | null; uf: string | null; whatsapp: string | null; instagram: string | null };
  origem: 'maleta' | 'matriz' | null;
  pedidos: { ativo: boolean; entrega: boolean };
  pecas: Peca[];
}

/** Guarda a sacola no aparelho da cliente (some sozinha se o armazenamento não estiver disponível). */
function usarSacola(slug: string) {
  const chave = `aritana.sacola.${slug}`;
  const [itens, setItens] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(chave) ?? '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(chave, JSON.stringify(itens));
    } catch {
      /* sem armazenamento: a sacola dura até fechar a página */
    }
  }, [chave, itens]);
  return [itens, setItens] as const;
}

/** UTM do anúncio que trouxe a cliente, para o pedido saber de onde veio. */
const utmDaUrl = () => Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([k]) => /^(utm_[a-z]+|ref)$/.test(k)));

/** Catálogo público da consultora (sem login): escolhe as peças, monta a sacola e envia o pedido. */
export function Catalogo() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['catalogo', slug], queryFn: () => api<Vitrine>(`/publico/catalogo/${slug}`) });
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [faixa, setFaixa] = useState('');
  const [sacola, setSacola] = usarSacola(slug);
  const [fechando, setFechando] = useState(false);
  const [feito, setFeito] = useState<{ numero: number; total: number; origem: string; mensagem: string | null } | null>(null);
  const [f, setF] = useState({ nome: '', telefone: '', cidade: '', entrega: 'combinar', endereco: '', observacao: '', consentimento: false, site: '' });
  const pecas = useMemo(() => {
    const lista = q.data?.pecas ?? [];
    const b = busca.trim().toLowerCase();
    const [min, max] = faixa ? faixa.split('-').map(Number) : [0, Infinity];
    return lista.filter((p) => (!cat || p.categoria === cat) && (!b || `${p.descricao} ${p.referencia}`.toLowerCase().includes(b)) && p.preco >= min * 100 && p.preco <= (max || Infinity) * 100);
  }, [q.data, busca, cat, faixa]);
  const porId = useMemo(() => new Map((q.data?.pecas ?? []).map((p) => [p.id, p])), [q.data]);
  // Peça que acabou (vendida por outra cliente) sai da sacola sozinha.
  const naSacola = Object.entries(sacola).map(([id, qtd]) => ({ peca: porId.get(id), qtd })).filter((x): x is { peca: Peca; qtd: number } => !!x.peca && x.qtd > 0).map((x) => ({ ...x, qtd: Math.min(x.qtd, x.peca.disponivel) }));
  const total = naSacola.reduce((a, x) => a + x.peca.preco * x.qtd, 0);
  const qtdTotal = naSacola.reduce((a, x) => a + x.qtd, 0);
  const enviar = useMutation({
    mutationFn: () =>
      api<{ numero: number; total: number; origem: string; mensagem: string | null }>(`/publico/catalogo/${slug}/pedido`, {
        corpo: { itens: naSacola.map((x) => ({ produtoId: x.peca.id, quantidade: x.qtd })), nome: f.nome, telefone: f.telefone, cidade: f.cidade || null, entrega: f.entrega, endereco: f.entrega === 'entregar' ? f.endereco : null, observacao: f.observacao || null, consentimento: f.consentimento, site: f.site, origem: utmDaUrl() },
      }),
    onSuccess: (r) => { setFeito(r); setSacola({}); setFechando(false); },
  });

  if (q.isLoading) return <Carregando />;
  if (q.error) return <div className="publico"><Erro erro={q.error} /></div>;
  const { representante: r, pedidos } = q.data!;
  const primeiro = r.nome.split(' ')[0];
  const categorias = [...new Set(q.data!.pecas.map((p) => p.categoria).filter(Boolean))] as string[];
  const num = (r.whatsapp ?? '').replace(/\D/g, '');
  const zap = (txt: string) => (num ? `https://wa.me/55${num}?text=${encodeURIComponent(txt)}` : null);
  const mudar = (id: string, qtd: number) => setSacola((s) => { const n = { ...s }; if (qtd <= 0) delete n[id]; else n[id] = qtd; return n; });

  if (feito) {
    return (
      <div className="publico cat-feito">
        <img src="/logo-creme.png" alt="Aritana Semijoias" className="cat-logo-escuro" />
        <h1>Pedido nº {feito.numero} enviado!</h1>
        <p>{feito.mensagem || `${primeiro} recebeu o seu pedido de ${reais(feito.total)} e vai falar com você pelo WhatsApp para combinar o pagamento e a entrega.`}</p>
        {zap(`Oi, ${primeiro}! Acabei de fazer o pedido nº ${feito.numero} pelo seu catálogo.`) && <a className="botao" href={zap(`Oi, ${primeiro}! Acabei de fazer o pedido nº ${feito.numero} pelo seu catálogo.`)!} target="_blank" rel="noreferrer">Avisar {primeiro} no WhatsApp</a>}
        <button className="botao claro" onClick={() => setFeito(null)}>Voltar ao catálogo</button>
      </div>
    );
  }

  return (
    <div className="publico" style={{ maxWidth: 960, paddingBottom: qtdTotal ? 96 : undefined }}>
      <div className="cab">
        <img src="/logo-creme.png" alt="Aritana Semijoias" />
        <div>
          <div style={{ fontSize: 13, color: '#e0cba6', letterSpacing: 2, textTransform: 'uppercase' }}>Catálogo</div>
          <h1 style={{ fontSize: 26 }}>{r.nome}</h1>
          <p style={{ color: '#d9cfc1' }}>{[r.cidade, r.uf].filter(Boolean).join(' · ')}{r.instagram ? ` · @${r.instagram.replace(/^@/, '')}` : ''}</p>
        </div>
        {zap(`Oi, ${primeiro}! Vi o seu catálogo da Aritana.`) && <a className="botao" style={{ background: '#e0cba6', color: '#4e3f34', borderColor: '#e0cba6', alignSelf: 'flex-start' }} href={zap(`Oi, ${primeiro}! Vi o seu catálogo da Aritana.`)!} target="_blank" rel="noreferrer">Falar no WhatsApp</a>}
      </div>
      <div className="busca" style={{ marginTop: 14 }}>
        <input placeholder="Buscar peça" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Todas as categorias</option>{categorias.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={faixa} onChange={(e) => setFaixa(e.target.value)}><option value="">Qualquer preço</option><option value="0-100">Até R$ 100</option><option value="100-200">R$ 100 a 200</option><option value="200-0">Acima de R$ 200</option></select>
      </div>
      {pecas.length === 0 ? <div className="cartao vazio">Nenhuma peça disponível agora. Fale com {primeiro} pelo WhatsApp.</div> : (
        <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {pecas.map((p) => {
            const qtd = sacola[p.id] ?? 0;
            return (
              <div key={p.id} className="cartao coluna" style={{ gap: 6, padding: 12, minWidth: 0 }}>
                {p.foto ? <img src={p.foto} alt={p.descricao} loading="lazy" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }} /> : <div style={{ width: '100%', aspectRatio: '1', background: 'var(--creme-2)', borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--suave)', fontSize: 13 }}>{p.categoria ?? 'Semijoia'}</div>}
                <b>{p.descricao}</b>
                <span className="muted">ref. {p.referencia}{p.tamanho ? ` · tam. ${p.tamanho}` : ''}</span>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{reais(p.preco)}</span>
                {pedidos.ativo ? (
                  qtd ? (
                    <div className="cat-qtd" style={{ marginTop: 'auto' }}>
                      <button onClick={() => mudar(p.id, qtd - 1)} aria-label="Menos">−</button>
                      <b>{qtd}</b>
                      <button disabled={qtd >= p.disponivel} onClick={() => mudar(p.id, qtd + 1)} aria-label="Mais">+</button>
                    </div>
                  ) : (
                    <button className="botao pequeno" style={{ marginTop: 'auto' }} onClick={() => mudar(p.id, 1)}>Quero esta</button>
                  )
                ) : (
                  zap(`Oi, ${primeiro}! Vi no seu catálogo e quero: ${p.descricao} (ref. ${p.referencia}) · ${reais(p.preco)}`) && <a className="botao pequeno" style={{ marginTop: 'auto' }} href={zap(`Oi, ${primeiro}! Vi no seu catálogo e quero: ${p.descricao} (ref. ${p.referencia}) · ${reais(p.preco)}`)!} target="_blank" rel="noreferrer">Quero esta</a>
                )}
                {p.disponivel <= 2 && <span className="muted" style={{ fontSize: 12 }}>{p.disponivel === 1 ? 'Última peça' : 'Últimas 2 peças'}</span>}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted" style={{ marginTop: 24, textAlign: 'center' }}>Aritana Semijoias · {q.data!.origem === 'matriz' ? 'peças enviadas pela Aritana' : `as peças mostradas estão com ${primeiro}`}</p>

      {qtdTotal > 0 && !fechando && (
        <div className="cat-barra">
          <span><b>{qtdTotal}</b> peça{qtdTotal > 1 ? 's' : ''} · <b>{reais(total)}</b></span>
          <button className="botao" onClick={() => setFechando(true)}>Fazer pedido</button>
        </div>
      )}

      {fechando && (
        <div className="cat-fundo" onClick={() => setFechando(false)}>
          <form className="cat-painel" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); enviar.mutate(); }}>
            <div className="flex entre"><h2 style={{ margin: 0 }}>Seu pedido</h2><button type="button" className="botao claro pequeno" onClick={() => setFechando(false)} aria-label="Fechar">×</button></div>
            {naSacola.map(({ peca, qtd }) => (
              <div key={peca.id} className="cat-linha">
                <span>{peca.descricao}</span>
                <div className="cat-qtd">
                  <button type="button" onClick={() => mudar(peca.id, qtd - 1)} aria-label="Menos">−</button><b>{qtd}</b><button type="button" disabled={qtd >= peca.disponivel} onClick={() => mudar(peca.id, qtd + 1)} aria-label="Mais">+</button>
                </div>
                <b>{reais(peca.preco * qtd)}</b>
              </div>
            ))}
            <div className="cat-linha"><span>Total</span><b style={{ fontSize: 20 }}>{reais(total)}</b></div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>O pagamento é combinado com {primeiro} pelo WhatsApp depois do envio.</p>
            <label>Seu nome<input required value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} autoComplete="name" /></label>
            <label>WhatsApp com DDD<input required inputMode="tel" value={f.telefone} onChange={(e) => setF({ ...f, telefone: e.target.value })} autoComplete="tel" placeholder="(27) 99999-0000" /></label>
            <label>Cidade<input value={f.cidade} onChange={(e) => setF({ ...f, cidade: e.target.value })} autoComplete="address-level2" /></label>
            <label>Entrega
              <select value={f.entrega} onChange={(e) => setF({ ...f, entrega: e.target.value })}>
                <option value="combinar">Combinar com {primeiro}</option>
                <option value="retirar">Vou retirar</option>
                {pedidos.entrega && <option value="entregar">Quero receber em casa</option>}
              </select>
            </label>
            {f.entrega === 'entregar' && <label>Endereço<input required value={f.endereco} onChange={(e) => setF({ ...f, endereco: e.target.value })} autoComplete="street-address" /></label>}
            <label>Observação<input value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} placeholder="Tamanho, cor, presente…" /></label>
            {/* Campo invisível: só robô preenche. */}
            <input className="cat-mel" tabIndex={-1} autoComplete="off" value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} aria-hidden="true" />
            <label className="check"><input type="checkbox" checked={f.consentimento} onChange={(e) => setF({ ...f, consentimento: e.target.checked })} /> Autorizo a Aritana e {primeiro} a falarem comigo pelo WhatsApp sobre este pedido.</label>
            {enviar.error && <Erro erro={enviar.error} />}
            <button className="botao" disabled={enviar.isPending || !f.consentimento || !naSacola.length}>{enviar.isPending ? 'Enviando…' : `Enviar pedido · ${reais(total)}`}</button>
          </form>
        </div>
      )}
    </div>
  );
}
