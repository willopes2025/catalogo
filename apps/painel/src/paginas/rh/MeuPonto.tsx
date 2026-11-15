import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { Abas, Carregando, Erro } from '../../componentes/ui';
import { abrirArquivo, competenciaAtual, hm, horaDe, nomeMes, rotuloBatida, SEMANA, ultimasCompetencias } from './comum';
import '../inicio.css';
import './rh.css';

interface Eu {
  eFuncionario: boolean;
  nome: string;
  cargo: string | null;
  batePonto: boolean;
  exigirFoto: boolean;
  cercaGps: 'sinalizar' | 'bloquear';
  turnoHoje: { entrada: string; saidaIntervalo?: string | null; voltaIntervalo?: string | null; saida: string } | null;
  marcacoes: { id: string; marcadoEm: string; nsr: number; foraDoLocal: boolean | null }[];
  espelhosParaConfirmar: string[];
  documentosNovos: number;
}
interface ComprovanteT { id: string; titulo: string; empregador: string; cnpj: string | null; local: string | null; inpi: string | null; trabalhador: string; cpf: string; dataHora: string; nsr: number; hash: string; coletor: string; foraDoLocal: boolean | null }

/** Meu ponto: bater o ponto com foto e localização, ver o espelho e os documentos. Feito primeiro para o celular. */
export function MeuPonto() {
  const eu = useQuery({ queryKey: ['ponto', 'eu'], queryFn: () => api<Eu>('/ponto/eu'), refetchInterval: 60_000 });
  const [aba, setAba] = useState<'hoje' | 'espelho' | 'documentos'>('hoje');
  if (eu.isLoading) return <Carregando />;
  if (eu.error) return <Erro erro={eu.error} />;
  const d = eu.data!;
  if (!d.eFuncionario) return <div className="cartao vazio">Seu acesso ainda não está ligado a um cadastro de funcionário. Peça ao RH para fazer a ligação.</div>;
  return (
    <div className="mp">
      <Abas ativa={aba} mudar={setAba} abas={[['hoje', 'Ponto'], ['espelho', `Espelho${d.espelhosParaConfirmar.length ? ' •' : ''}`], ['documentos', `Documentos${d.documentosNovos ? ` (${d.documentosNovos})` : ''}`]]} />
      {aba === 'hoje' && <Hoje eu={d} />}
      {aba === 'espelho' && <MeuEspelho pendentes={d.espelhosParaConfirmar} />}
      {aba === 'documentos' && <MeusDocumentos />}
    </div>
  );
}

function Relogio({ turno }: { turno: Eu['turnoHoje'] }) {
  const [agora, setAgora] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mp-relogio">
      <div className="h">{agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
      <div className="d">{((t) => t.charAt(0).toUpperCase() + t.slice(1))(agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' }))}</div>
      <div className="t">{turno ? `Seu horário hoje: ${turno.entrada}${turno.saidaIntervalo ? ` · intervalo ${turno.saidaIntervalo}–${turno.voltaIntervalo}` : ''} · até ${turno.saida}` : 'Hoje é folga na sua escala'}</div>
    </div>
  );
}

/** Localização com tempo limite: sem GPS, o servidor decide (avisa ou recusa, conforme a regra da empresa). */
function localizar(): Promise<{ latitude: number; longitude: number; precisao: number } | null> {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ latitude: p.coords.latitude, longitude: p.coords.longitude, precisao: p.coords.accuracy }),
      () => ok(null),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  });
}

/** Foto 480px em JPEG, o suficiente para conferir o rosto sem pesar. */
function paraJpeg(fonte: HTMLVideoElement | HTMLImageElement, largura: number, altura: number) {
  const c = document.createElement('canvas');
  const escala = Math.min(1, 480 / Math.max(largura, altura));
  c.width = Math.round(largura * escala);
  c.height = Math.round(altura * escala);
  c.getContext('2d')!.drawImage(fonte, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

function Hoje({ eu }: { eu: Eu }) {
  const qc = useQueryClient();
  const [etapa, setEtapa] = useState<'parado' | 'camera' | 'enviando'>('parado');
  const [erro, setErro] = useState('');
  const [feito, setFeito] = useState<ComprovanteT | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const fluxo = useRef<MediaStream | null>(null);
  const local = useRef<Promise<Awaited<ReturnType<typeof localizar>>> | null>(null);
  const proxima = rotuloBatida(eu.marcacoes.length);

  const parar = () => {
    fluxo.current?.getTracks().forEach((t) => t.stop());
    fluxo.current = null;
  };
  useEffect(() => parar, []);

  async function enviar(foto: string | null) {
    setEtapa('enviando');
    try {
      const gps = await (local.current ?? localizar());
      const c = await api<ComprovanteT>('/ponto/marcar', { corpo: { ...(gps ?? {}), foto } });
      setFeito(c);
      if (navigator.vibrate) navigator.vibrate(120);
      qc.invalidateQueries({ queryKey: ['ponto'] });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEtapa('parado');
      parar();
    }
  }

  async function comecar() {
    setErro('');
    setFeito(null);
    local.current = localizar(); // pede a localização já, enquanto a câmera abre
    if (!eu.exigirFoto) return enviar(null);
    try {
      fluxo.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false });
      setEtapa('camera');
      setTimeout(() => {
        if (video.current && fluxo.current) video.current.srcObject = fluxo.current;
      }, 0);
    } catch {
      // Sem câmera ao vivo (permissão negada, navegador antigo): usa a câmera do sistema.
      document.getElementById('mp-foto-arquivo')?.click();
    }
  }

  function tirarFoto() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    enviar(paraJpeg(v, v.videoWidth, v.videoHeight));
  }

  function fotoDoArquivo(f?: File) {
    if (!f) return;
    const img = new Image();
    img.onload = () => enviar(paraJpeg(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => setErro('Não foi possível ler a foto.');
    img.src = URL.createObjectURL(f);
  }

  return (
    <>
      <Relogio turno={eu.turnoHoje} />
      {eu.espelhosParaConfirmar.length > 0 && <div className="mp-aviso">O RH fechou o ponto de {eu.espelhosParaConfirmar.map(nomeMes).join(', ')}. Confira e confirme na aba "Espelho".</div>}
      {feito && (
        <div className="mp-ok">
          <div className="v">✓</div>
          <b>Ponto registrado às {feito.dataHora.slice(11, 16)}</b>
          <div style={{ fontSize: 13 }}>NSR {feito.nsr}{feito.foraDoLocal ? ' · fora do local de trabalho' : ''}</div>
          <Link to={`/ponto/comprovante/${feito.id}`} style={{ display: 'inline-block', marginTop: 8 }}>Ver comprovante</Link>
        </div>
      )}
      {erro && <div className="aviso erro" style={{ marginBottom: 12 }}>{erro}</div>}
      {!eu.batePonto ? (
        <div className="cartao vazio">Seu cadastro não usa controle de ponto.</div>
      ) : etapa === 'camera' ? (
        <>
          <div className="mp-camera">
            <video ref={video} autoPlay playsInline muted />
            <div className="moldura" />
          </div>
          <button className="mp-bater" onClick={tirarFoto}>📸 Registrar {proxima.toLowerCase()}<small>Enquadre o rosto e toque aqui</small></button>
          <button className="botao claro" style={{ width: '100%', marginTop: 8 }} onClick={() => { parar(); setEtapa('parado'); }}>Cancelar</button>
        </>
      ) : (
        <button className="mp-bater" disabled={etapa === 'enviando'} onClick={comecar}>
          {etapa === 'enviando' ? 'Registrando…' : `Registrar ${proxima.toLowerCase()}`}
          <small>{eu.exigirFoto ? 'Com foto e localização' : 'Com localização'}</small>
        </button>
      )}
      <input id="mp-foto-arquivo" type="file" accept="image/*" capture="user" hidden onChange={(e) => fotoDoArquivo(e.target.files?.[0])} />
      <div className="mp-batidas">
        {eu.marcacoes.map((m, i) => (
          <div key={m.id}>
            <span>{rotuloBatida(i)}{m.foraDoLocal ? <span className="etiqueta alerta" style={{ marginLeft: 6 }}>fora do local</span> : null}</span>
            <span><b>{horaDe(m.marcadoEm)}</b> <Link to={`/ponto/comprovante/${m.id}`} style={{ fontSize: 12, marginLeft: 6 }}>comprovante</Link></span>
          </div>
        ))}
        {!eu.marcacoes.length && <p className="muted" style={{ textAlign: 'center' }}>Nenhuma batida hoje.</p>}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 14, textAlign: 'center' }}>A hora registrada é a do servidor, não a do celular. A marcação não pode ser apagada; se errar, avise o RH.</p>
    </>
  );
}

export function TabelaEspelho({ e, ajustar }: { e: any; ajustar?: { incluir: (data: string) => void; desconsiderar: (id: string, hora: string) => void; foto: (id: string) => void } }) {
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%', minWidth: 0 }}>
      <table className="espelho">
        <thead>
          <tr><th>Dia</th><th>Marcações</th><th>Trabalhado</th><th>Extra</th><th>Débito</th><th>Noturno</th><th>Obs.</th></tr>
        </thead>
        <tbody>
          {e.dias.map((d: any) => (
            <tr key={d.data} className={d.faltaDia ? 'falta' : d.pendente ? 'pend' : d.semana === 0 || d.feriado ? 'fim' : ''}>
              <td style={{ whiteSpace: 'nowrap' }}>{d.data.slice(8, 10)}/{d.data.slice(5, 7)} <span className="muted">{SEMANA[d.semana]}</span></td>
              <td>
                <span className="bat">
                  {d.marcacoes.map((m: any, i: number) => (
                    <span key={i} className={`${m.origem === 'incluida' ? 'inc' : ''} ${m.desconsiderada ? 'des' : ''} ${m.foraDoLocal ? 'fora' : ''}`} title={m.motivo ? `Ajuste: ${m.motivo}` : m.foraDoLocal ? 'Fora do local de trabalho' : m.origem === 'incluida' ? 'Incluída pela empresa' : 'Original'}>
                      {m.hora}
                      {ajustar && m.origem === 'original' && !m.desconsiderada && (
                        <>
                          <button title="Ver a foto" onClick={() => ajustar.foto(m.id)}>📷</button>
                          <button title="Desconsiderar esta batida" onClick={() => ajustar.desconsiderar(m.id, m.hora)}>✕</button>
                        </>
                      )}
                    </span>
                  ))}
                  {ajustar && <button title="Incluir batida esquecida" onClick={() => ajustar.incluir(d.data)}>＋</button>}
                </span>
              </td>
              <td>{hm(d.trabalhado)}</td>
              <td>{hm(d.extra50 + d.extra100)}{d.extra100 ? <span className="muted" title="a 100%"> ²</span> : ''}</td>
              <td>{hm(d.atraso + d.saidaAntecipada + d.falta)}</td>
              <td>{hm(d.noturno)}</td>
              <td style={{ fontSize: 12 }}>{[d.faltaDia ? 'Falta' : '', d.ocorrencia, d.feriado, ...d.avisos].filter(Boolean).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}><b>Total do mês</b> <span className="muted">(previsto {hm(e.totais.previsto)})</span></td>
            <td><b>{hm(e.totais.trabalhado)}</b></td>
            <td><b>{hm(e.totais.extra50 + e.totais.extra100)}</b></td>
            <td><b>{hm(e.totais.atraso + e.totais.saidaAntecipada + e.totais.falta)}</b></td>
            <td><b>{hm(e.totais.noturno)}</b></td>
            <td>{e.totais.faltasDias ? `${e.totais.faltasDias} falta(s)` : ''}{e.totais.pendentes ? ` · ${e.totais.pendentes} dia(s) com batida faltando` : ''}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function MeuEspelho({ pendentes }: { pendentes: string[] }) {
  const qc = useQueryClient();
  const [comp, setComp] = useState(pendentes[0] ?? competenciaAtual());
  const q = useQuery({ queryKey: ['ponto', 'espelho', comp], queryFn: () => api<any>(`/ponto/espelho?competencia=${comp}`) });
  const ciente = useMutation({ mutationFn: () => api(`/ponto/espelho/${comp}/ciente`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['ponto'] }) });
  return (
    <div className="coluna" style={{ gap: 10 }}>
      <select value={comp} onChange={(e) => setComp(e.target.value)} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--linha)', font: 'inherit' }}>
        {ultimasCompetencias(12).map((c) => <option key={c} value={c}>{nomeMes(c)}{pendentes.includes(c) ? ' · confirmar' : ''}</option>)}
      </select>
      {q.isLoading ? <Carregando /> : q.error ? <Erro erro={q.error} /> : (
        <>
          {q.data.fechamento && !q.data.fechamento.cienteEm && (
            <div className="mp-aviso">
              O RH fechou este mês. Confira as horas e confirme. Se algo estiver errado, fale com o RH antes de confirmar.
              <button className="botao" style={{ marginTop: 8, width: '100%' }} disabled={ciente.isPending} onClick={() => ciente.mutate()}>Confirmo meu ponto de {nomeMes(comp)}</button>
              {ciente.error && <Erro erro={ciente.error} />}
            </div>
          )}
          {q.data.fechamento?.cienteEm && <div className="aviso ok">Você confirmou este mês em {new Date(q.data.fechamento.cienteEm).toLocaleString('pt-BR')}.</div>}
          <TabelaEspelho e={q.data} />
        </>
      )}
    </div>
  );
}

function MeusDocumentos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ponto', 'documentos'], queryFn: () => api<any[]>('/ponto/documentos') });
  const ciente = useMutation({ mutationFn: (id: string) => api(`/ponto/documentos/${id}/ciente`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['ponto'] }) });
  const [erro, setErro] = useState('');
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  if (!q.data!.length) return <div className="cartao vazio">Nenhum documento ainda. Contracheques e documentos que o RH liberar aparecem aqui.</div>;
  return (
    <div className="coluna" style={{ gap: 8 }}>
      {erro && <div className="aviso erro">{erro}</div>}
      {q.data!.map((d) => (
        <div key={d.id} className="rh-doc">
          <div>
            <b>{d.titulo}</b>
            <div><small>{d.data ? new Date(`${d.data}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : ''}{d.cienteEm ? ' · recebido' : ''}</small></div>
          </div>
          <div className="flex" style={{ gap: 6 }}>
            <button className="botao claro pequeno" onClick={() => abrirArquivo(`/ponto/documentos/${d.id}/arquivo`).catch((e) => setErro(e.message))}>Abrir</button>
            {!d.cienteEm && <button className="botao pequeno" disabled={ciente.isPending} onClick={() => ciente.mutate(d.id)}>Recebi</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Comprovante de registro de ponto (para ver no celular, salvar ou imprimir). */
export function Comprovante() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['ponto', 'comprovante', id], queryFn: () => api<ComprovanteT>(`/ponto/comprovante/${id}`) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const c = q.data!;
  const linha = (r: string, v: React.ReactNode) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px dashed var(--linha)' }}><span className="muted">{r}</span><b style={{ textAlign: 'right', wordBreak: 'break-all' }}>{v}</b></div>;
  return (
    <div style={{ maxWidth: 440, margin: '24px auto', padding: 16, fontFamily: "'Titillium Web', Arial, sans-serif" }}>
      <div className="cartao">
        <h2 style={{ fontSize: 17, marginBottom: 10 }}>{c.titulo}</h2>
        {linha('Empregador', c.empregador)}
        {linha('CNPJ', c.cnpj ?? '—')}
        {c.local && linha('Local', c.local)}
        {linha('Trabalhador', c.trabalhador)}
        {linha('CPF', c.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'))}
        {linha('Data e hora', `${c.dataHora.slice(8, 10)}/${c.dataHora.slice(5, 7)}/${c.dataHora.slice(0, 4)} ${c.dataHora.slice(11, 16)}`)}
        {linha('NSR', String(c.nsr).padStart(9, '0'))}
        {linha('Registro INPI', c.inpi ?? 'em registro')}
        {linha('Coletado por', c.coletor)}
        <div style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 12 }}>Código de verificação (SHA-256)</span><div style={{ fontFamily: 'monospace', fontSize: 11.5, wordBreak: 'break-all', marginTop: 2 }}>{c.hash}</div></div>
      </div>
      <div className="flex nao-imprimir" style={{ gap: 8, marginTop: 12, justifyContent: 'center' }}>
        <button className="botao claro" onClick={() => window.print()}>Imprimir ou salvar PDF</button>
        <Link className="botao claro" to="/meu-ponto">Voltar</Link>
      </div>
    </div>
  );
}
