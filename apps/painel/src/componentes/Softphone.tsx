import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, pode } from '../api';
import '../paginas/crm/crm.css';

interface Ramal { servidor: string; usuarioSip: string; senha: string; nomeExibicao: string; prefixo: string }
type Estado = 'desligado' | 'conectando' | 'pronto' | 'erro';
type Chamada = { numero: string; nome?: string; leadId?: string | null; direcao: 'saida' | 'entrada'; fase: 'chamando' | 'tocando' | 'falando'; inicio?: number };

/**
 * Telefone no canto da tela, para quem tem ramal: liga pelo navegador (WebRTC + SIP por WebSocket).
 * O card do lead e o chat chamam com o evento "aritana:ligar"; a ligação entra no histórico do card.
 */
export function Softphone() {
  const ramal = useQuery({ queryKey: ['crm', 'ramal'], queryFn: () => api<Ramal | null>('/crm/ramal'), enabled: pode('crm', 'ver'), staleTime: Infinity, retry: false });
  const [estado, setEstado] = useState<Estado>('desligado');
  const [erro, setErro] = useState('');
  const [aberto, setAberto] = useState(false);
  const [numero, setNumero] = useState('');
  const [chamada, setChamada] = useState<Chamada | null>(null);
  const [mudo, setMudo] = useState(false);
  const [, tique] = useState(0);
  const ua = useRef<any>(null);
  const sessao = useRef<any>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const dados = useRef<Chamada | null>(null);

  // Conecta o ramal quando houver um.
  useEffect(() => {
    const r = ramal.data;
    if (!r?.servidor) return;
    let parado = false;
    setEstado('conectando');
    import('jssip')
      .then(({ default: JsSIP }) => {
        if (parado) return;
        const socket = new JsSIP.WebSocketInterface(r.servidor);
        const u = new JsSIP.UA({ sockets: [socket], uri: r.usuarioSip, password: r.senha, display_name: r.nomeExibicao, register: true, session_timers: false });
        u.on('registered', () => { setEstado('pronto'); setErro(''); });
        u.on('unregistered', () => setEstado('desligado'));
        u.on('registrationFailed', (e: any) => { setEstado('erro'); setErro(`Ramal recusado (${e?.cause ?? 'erro'})`); });
        u.on('disconnected', () => setEstado((s) => (s === 'pronto' ? 'conectando' : s)));
        u.on('newRTCSession', (e: any) => {
          if (e.originator !== 'remote') return;
          if (sessao.current) return e.session.terminate({ status_code: 486 }); // ocupado
          const de = e.request?.from?.uri?.user ?? 'desconhecido';
          prender(e.session, { numero: de, direcao: 'entrada', fase: 'tocando', nome: e.request?.from?.display_name });
          setAberto(true);
        });
        u.start();
        ua.current = u;
      })
      .catch(() => { setEstado('erro'); setErro('Não foi possível carregar o telefone.'); });
    return () => {
      parado = true;
      try {
        ua.current?.stop();
      } catch {
        /* já parado */
      }
      ua.current = null;
    };
  }, [ramal.data]);

  // Relógio da ligação.
  useEffect(() => {
    if (chamada?.fase !== 'falando') return;
    const t = setInterval(() => tique((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [chamada?.fase]);

  // Pedidos de ligação vindos do card e do chat.
  useEffect(() => {
    const ouvir = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { numero: string; leadId?: string; nome?: string };
      setAberto(true);
      setNumero(soNumero(d.numero));
      if (estado === 'pronto' && !sessao.current) discar(soNumero(d.numero), d.leadId, d.nome);
    };
    window.addEventListener('aritana:ligar', ouvir);
    return () => window.removeEventListener('aritana:ligar', ouvir);
  });

  function soNumero(n: string) {
    let d = n.replace(/\D/g, '');
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2); // ligação nacional
    return d;
  }

  function prender(s: any, c: Chamada) {
    sessao.current = s;
    dados.current = c;
    setChamada(c);
    s.on('peerconnection', (e: any) => {
      e.peerconnection.addEventListener('track', (t: RTCTrackEvent) => {
        if (audio.current) audio.current.srcObject = t.streams[0];
      });
    });
    s.on('progress', () => setChamada((x) => (x ? { ...x, fase: x.direcao === 'saida' ? 'chamando' : 'tocando' } : x)));
    s.on('confirmed', () => {
      dados.current = { ...dados.current!, fase: 'falando', inicio: Date.now() };
      setChamada(dados.current);
    });
    const fim = (resultado: 'atendida' | 'nao_atendida' | 'ocupado' | 'falhou' | 'cancelada') => {
      const c = dados.current;
      sessao.current = null;
      dados.current = null;
      setChamada(null);
      setMudo(false);
      if (c?.direcao === 'saida' && c.leadId) {
        const dur = c.inicio ? Math.round((Date.now() - c.inicio) / 1000) : 0;
        api(`/crm/leads/${c.leadId}/ligacoes`, { corpo: { numero: c.numero, duracaoSeg: dur, resultado: c.inicio ? 'atendida' : resultado } }).catch(() => undefined);
      }
    };
    s.on('ended', () => fim('atendida'));
    s.on('failed', (e: any) => fim(e?.cause === 'Busy' ? 'ocupado' : e?.cause === 'Canceled' ? 'cancelada' : e?.cause === 'No Answer' || e?.cause === 'Unavailable' ? 'nao_atendida' : 'falhou'));
  }

  function discar(n: string, leadId?: string | null, nome?: string) {
    const r = ramal.data;
    if (!ua.current || !r || !n) return;
    const dominio = r.usuarioSip.split('@')[1];
    const s = ua.current.call(`sip:${r.prefixo}${n}@${dominio}`, { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
    prender(s, { numero: n, leadId, nome, direcao: 'saida', fase: 'chamando' });
  }

  if (!ramal.data?.servidor) return null;
  const dur = chamada?.inicio ? Math.floor((Date.now() - chamada.inicio) / 1000) : 0;
  return (
    <div className="softphone" style={!aberto ? { width: 'auto' } : undefined}>
      <audio ref={audio} autoPlay />
      <div className="cab" onClick={() => setAberto((a) => !a)}>
        <span><span className={`ponto ${estado === 'pronto' ? 'on' : ''}`} />{chamada ? (chamada.fase === 'falando' ? `Em ligação ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}` : chamada.fase === 'tocando' ? '📞 Recebendo ligação' : 'Chamando…') : estado === 'pronto' ? 'Telefone' : estado === 'erro' ? 'Telefone com erro' : 'Conectando…'}</span>
        <span>{aberto ? '▾' : '▴'}</span>
      </div>
      {aberto && (
        <div className="corpo">
          {erro && <div style={{ fontSize: 12, color: '#ffd2cc' }}>{erro}</div>}
          {chamada ? (
            <>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 700 }}>{chamada.nome ?? chamada.numero}</div>
                {chamada.nome && <div style={{ fontSize: 13, opacity: 0.8 }}>{chamada.numero}</div>}
              </div>
              {chamada.fase === 'tocando' && chamada.direcao === 'entrada' ? (
                <div className="flex" style={{ gap: 6 }}>
                  <button className="ligar" style={{ flex: 1 }} onClick={() => sessao.current?.answer({ mediaConstraints: { audio: true, video: false } })}>Atender</button>
                  <button className="ligar desligar" style={{ flex: 1 }} onClick={() => sessao.current?.terminate()}>Recusar</button>
                </div>
              ) : (
                <>
                  {chamada.fase === 'falando' && (
                    <div className="teclado">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => <button key={k} onClick={() => sessao.current?.sendDTMF(k)}>{k}</button>)}
                    </div>
                  )}
                  <div className="flex" style={{ gap: 6 }}>
                    {chamada.fase === 'falando' && <button className="ligar" style={{ flex: 1, background: mudo ? '#8a6d12' : 'rgba(255,255,255,.15)' }} onClick={() => { if (mudo) sessao.current?.unmute(); else sessao.current?.mute(); setMudo(!mudo); }}>{mudo ? 'Sem mudo' : 'Mudo'}</button>}
                    <button className="ligar desligar" style={{ flex: 1 }} onClick={() => sessao.current?.terminate()}>Desligar</button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <input value={numero} onChange={(e) => setNumero(e.target.value.replace(/[^\d*#]/g, ''))} placeholder="DDD + número" onKeyDown={(e) => e.key === 'Enter' && discar(numero)} />
              <div className="teclado">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => <button key={k} onClick={() => setNumero((n) => n + k)}>{k}</button>)}
              </div>
              <div className="flex" style={{ gap: 6 }}>
                <button className="ligar" style={{ flex: 1 }} disabled={estado !== 'pronto' || !numero} onClick={() => discar(numero)}>Ligar</button>
                <button className="ligar" style={{ background: 'rgba(255,255,255,.15)' }} onClick={() => setNumero((n) => n.slice(0, -1))}>⌫</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
