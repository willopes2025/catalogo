import { useEffect, useState } from 'react';
import './vinheta.css';

const CHAVE = 'aritana.vinheta';
// Telas abertas por clientes e representantes, ou de impressão: sem vinheta.
const PUBLICAS = ['/catalogo', '/pedido', '/assinar', '/portal', '/f/', '/cadastro', '/imprimir', '/privacidade', '/ponto/comprovante'];

// Poeira dourada subindo (posições fixas, espalhadas).
const PARTICULAS = Array.from({ length: 16 }, (_, i) => ({
  left: `${(i * 37 + 11) % 100}%`,
  animationDelay: `${0.2 + ((i * 53) % 17) / 10}s`,
  animationDuration: `${2.4 + ((i * 29) % 13) / 10}s`,
  width: `${2 + (i % 3)}px`,
  height: `${2 + (i % 3)}px`,
}));

function deveMostrar() {
  if (PUBLICAS.some((p) => location.pathname.startsWith(p))) return false;
  try {
    if (sessionStorage.getItem(CHAVE)) return false;
    sessionStorage.setItem(CHAVE, '1');
  } catch {
    /* sem armazenamento: mostra mesmo assim */
  }
  return true;
}

/** Vinheta de abertura com a logomarca: aparece uma vez por aba aberta. Clique para pular. */
export function Vinheta() {
  const [fase, setFase] = useState<'rodando' | 'saindo' | 'fim'>(() => (deveMostrar() ? 'rodando' : 'fim'));

  useEffect(() => {
    if (fase !== 'rodando') return;
    const curta = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => setFase('saindo'), curta ? 900 : 3100);
    return () => window.clearTimeout(t);
  }, [fase]);

  useEffect(() => {
    if (fase !== 'saindo') return;
    const t = window.setTimeout(() => setFase('fim'), 700);
    return () => window.clearTimeout(t);
  }, [fase]);

  if (fase === 'fim') return null;
  return (
    <div className={`vinheta ${fase === 'saindo' ? 'saindo' : ''}`} onClick={() => setFase('saindo')} role="presentation" aria-hidden="true">
      <div className="vinheta-brilho-fundo" />
      <div className="vinheta-palco">
        <div className="vinheta-logo">
          <img src="/logo-creme.png" alt="" draggable={false} />
          <div className="vinheta-reflexo" />
          <span className="vinheta-estrela" />
        </div>
        <div className="vinheta-linha" />
      </div>
      <div className="vinheta-particulas">
        {PARTICULAS.map((p, i) => <i key={i} style={p} />)}
      </div>
    </div>
  );
}
