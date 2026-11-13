import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { reais } from '../formato';
import { Carregando, Erro } from '../componentes/ui';

interface Peca { id: string; referencia: string; descricao: string; categoria: string | null; cor: string | null; tamanho: string | null; preco: number; foto: string | null; disponivel: number }

/** Catálogo público da representante (sem login), com botão de pedir pelo WhatsApp dela. */
export function Catalogo() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ['catalogo', slug], queryFn: () => api<{ representante: { nome: string; cidade: string | null; uf: string | null; whatsapp: string | null; instagram: string | null }; pecas: Peca[] }>(`/publico/catalogo/${slug}`) });
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [faixa, setFaixa] = useState('');
  const pecas = useMemo(() => {
    const lista = q.data?.pecas ?? [];
    const b = busca.trim().toLowerCase();
    const [min, max] = faixa ? faixa.split('-').map(Number) : [0, Infinity];
    return lista.filter((p) => (!cat || p.categoria === cat) && (!b || `${p.descricao} ${p.referencia}`.toLowerCase().includes(b)) && p.preco >= min * 100 && p.preco <= (max || Infinity) * 100);
  }, [q.data, busca, cat, faixa]);
  if (q.isLoading) return <Carregando />;
  if (q.error) return <div className="publico"><Erro erro={q.error} /></div>;
  const { representante: r } = q.data!;
  const categorias = [...new Set(q.data!.pecas.map((p) => p.categoria).filter(Boolean))] as string[];
  const zap = (p?: Peca) => {
    const num = (r.whatsapp ?? '').replace(/\D/g, '');
    if (!num) return null;
    const txt = p ? `Oi, ${r.nome.split(' ')[0]}! Vi no seu catálogo e quero: ${p.descricao} (ref. ${p.referencia}) · ${reais(p.preco)}` : `Oi, ${r.nome.split(' ')[0]}! Vi o seu catálogo da Aritana.`;
    return `https://wa.me/55${num}?text=${encodeURIComponent(txt)}`;
  };
  return (
    <div className="publico" style={{ maxWidth: 960 }}>
      <div className="cab">
        <img src="/logo-creme.png" alt="Aritana Semijoias" />
        <div>
          <div style={{ fontSize: 13, color: '#e0cba6', letterSpacing: 2, textTransform: 'uppercase' }}>Catálogo</div>
          <h1 style={{ fontSize: 26 }}>{r.nome}</h1>
          <p style={{ color: '#d9cfc1' }}>{[r.cidade, r.uf].filter(Boolean).join(' · ')}{r.instagram ? ` · @${r.instagram.replace(/^@/, '')}` : ''}</p>
        </div>
        {zap() && <a className="botao" style={{ background: '#e0cba6', color: '#4e3f34', borderColor: '#e0cba6', alignSelf: 'flex-start' }} href={zap()!} target="_blank" rel="noreferrer">Falar no WhatsApp</a>}
      </div>
      <div className="busca" style={{ marginTop: 14 }}>
        <input placeholder="Buscar peça" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Todas as categorias</option>{categorias.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={faixa} onChange={(e) => setFaixa(e.target.value)}><option value="">Qualquer preço</option><option value="0-100">Até R$ 100</option><option value="100-200">R$ 100 a 200</option><option value="200-0">Acima de R$ 200</option></select>
      </div>
      {pecas.length === 0 ? <div className="cartao vazio">Nenhuma peça disponível agora. Fale com {r.nome.split(' ')[0]} pelo WhatsApp.</div> : (
        <div className="grade" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {pecas.map((p) => (
            <div key={p.id} className="cartao coluna" style={{ gap: 6, padding: 12, minWidth: 0 }}>
              {p.foto ? <img src={p.foto} alt={p.descricao} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }} /> : <div style={{ width: '100%', aspectRatio: '1', background: 'var(--creme-2)', borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--suave)', fontSize: 13 }}>{p.categoria ?? 'Semijoia'}</div>}
              <b>{p.descricao}</b>
              <span className="muted">ref. {p.referencia}{p.tamanho ? ` · tam. ${p.tamanho}` : ''}</span>
              <span style={{ fontSize: 20, fontWeight: 700 }}>{reais(p.preco)}</span>
              {zap(p) && <a className="botao pequeno" style={{ marginTop: 'auto' }} href={zap(p)!} target="_blank" rel="noreferrer">Quero esta</a>}
            </div>
          ))}
        </div>
      )}
      <p className="muted" style={{ marginTop: 24, textAlign: 'center' }}>Aritana Semijoias · as peças mostradas estão com a representante</p>
    </div>
  );
}
