import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { reais } from '../formato';
import { Campo, Erro } from './ui';
import { FotoPeca } from './Peca';

export interface EstadoIa { texto: boolean; imagem: boolean; modelo: string; estilos: { chave: string; nome: string }[] }
/** O que da IA está ligado (chave do Claude e da OpenAI). */
export const usarIa = () => useQuery({ queryKey: ['ia', 'estado'], queryFn: () => api<EstadoIa>('/ia/estado'), staleTime: 5 * 60_000 });

/** Reduz a foto no navegador (lado maior até 1600 px, JPEG): foto de celular fica leve para enviar. */
export async function reduzirFoto(arquivo: Blob, lado = 1600): Promise<{ base64: string; mime: 'image/jpeg'; previa: string }> {
  const url = URL.createObjectURL(arquivo);
  try {
    const img = await new Promise<HTMLImageElement>((ok, erro) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => erro(new Error('Não deu para abrir esta imagem. Use uma foto JPG ou PNG.'));
      i.src = url;
    });
    const escala = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
    const tela = document.createElement('canvas');
    tela.width = Math.max(1, Math.round(img.naturalWidth * escala));
    tela.height = Math.max(1, Math.round(img.naturalHeight * escala));
    const ctx = tela.getContext('2d')!;
    // Fundo branco: PNG transparente não vira preto no JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tela.width, tela.height);
    ctx.drawImage(img, 0, 0, tela.width, tela.height);
    const dados = tela.toDataURL('image/jpeg', 0.88);
    return { base64: dados.split(',')[1], mime: 'image/jpeg', previa: dados };
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Candidato { id: string; referencia: string; codigoBarras: string; descricao: string; categoria: string | null; preco: number; estoque: number; foto: string | null; confianca: number | null; motivo: string | null }

/** Acha o produto no cadastro a partir de uma foto da peça. `escolher` troca o link por um botão (para usar em outras telas). */
export function BuscaPorFoto({ escolher, fechar }: { escolher?: (c: Candidato) => void; fechar: () => void }) {
  const entrada = useRef<HTMLInputElement>(null);
  const [previa, setPrevia] = useState<string | null>(null);
  const buscar = useMutation({
    mutationFn: async (f: File) => {
      const r = await reduzirFoto(f, 1200);
      setPrevia(r.previa);
      return api<{ descricao: string; candidatos: Candidato[]; aviso: string | null }>('/ia/reconhecer-peca', { corpo: { base64: r.base64, mime: r.mime } });
    },
  });
  return (
    <div className="cartao coluna" style={{ gap: 10 }}>
      <div className="flex entre">
        <b>Buscar a peça pela foto</b>
        <button className="botao claro pequeno" onClick={fechar}>Fechar</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>Tire ou escolha uma foto da peça, de perto e com boa luz. A IA descreve a peça, procura no cadastro e compara com as fotos dos produtos.</p>
      <div className="flex" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {previa && <img src={previa} alt="Foto enviada" style={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--linha)' }} />}
        <div className="coluna" style={{ gap: 6 }}>
          <button className="botao" disabled={buscar.isPending} onClick={() => entrada.current?.click()}>{buscar.isPending ? 'Procurando…' : previa ? 'Tentar com outra foto' : '📷 Escolher ou tirar a foto'}</button>
          <input ref={entrada} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) buscar.mutate(f); e.target.value = ''; }} />
          {buscar.data?.descricao && <span className="muted">A IA viu: <b>{buscar.data.descricao}</b></span>}
        </div>
      </div>
      {buscar.error && <Erro erro={buscar.error} />}
      {buscar.data?.aviso && <div className="aviso alerta">{buscar.data.aviso}</div>}
      {buscar.data && buscar.data.candidatos.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tabela">
            <thead><tr><th></th><th>Ref.</th><th>Descrição</th><th className="num">Preço</th><th className="num">Estoque</th><th>Parecida com a foto</th><th></th></tr></thead>
            <tbody>
              {buscar.data.candidatos.map((c) => (
                <tr key={c.id}>
                  <td><FotoPeca src={c.foto} alt={c.descricao ?? ""} /></td>
                  <td>{c.referencia}</td>
                  <td>{c.descricao}{c.categoria && <div className="muted" style={{ fontSize: 12 }}>{c.categoria}</div>}</td>
                  <td className="num">{reais(c.preco)}</td>
                  <td className="num">{c.estoque}</td>
                  <td>{c.confianca == null ? <span className="muted" title="Sem foto no cadastro para comparar: veio só pela descrição">pela descrição</span> : <><span className={`etiqueta ${c.confianca >= 75 ? 'ok' : c.confianca >= 40 ? 'alerta' : 'neutra'}`}>{c.confianca}%</span>{c.motivo && <div className="muted" style={{ fontSize: 12 }}>{c.motivo}</div>}</>}</td>
                  <td className="num">{escolher ? <button className="botao pequeno" onClick={() => escolher(c)}>Usar esta</button> : <Link className="botao claro pequeno" to={`/produtos/${c.id}`}>Abrir</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {buscar.data && buscar.data.candidatos.length > 0 && <span className="muted" style={{ fontSize: 13 }}>Confira sempre a referência na etiqueta: a IA indica a mais provável, mas peças muito parecidas podem confundir.</span>}
    </div>
  );
}

/** Fotos do produto: enviar do computador, tirar, e gerar a foto de catálogo com IA (só entra quando aprovada). */
export function FotosProduto({ produtoId, fotos, mudou }: { produtoId: string; fotos: string[]; mudou: (fotos: string[]) => void }) {
  const qc = useQueryClient();
  const ia = usarIa();
  const editar = pode('produtos', 'editar');
  const envio = useRef<HTMLInputElement>(null);
  const origemArq = useRef<HTMLInputElement>(null);
  const [gerando, setGerando] = useState(false);
  const [estilo, setEstilo] = useState('fundo_branco');
  const [pedido, setPedido] = useState('');
  const [origem, setOrigem] = useState<{ url?: string; base64?: string; mime?: string; previa: string } | null>(null);
  const aplicar = (r: { fotos: string[] }) => { mudou(r.fotos); qc.invalidateQueries({ queryKey: ['produtos'] }); };
  const enviar = useMutation({ mutationFn: async (f: File) => { const r = await reduzirFoto(f); return api<{ fotos: string[] }>('/ia/foto-produto/usar', { corpo: { produtoId, base64: r.base64, mime: r.mime, principal: !fotos.length } }); }, onSuccess: aplicar });
  const tirar = useMutation({ mutationFn: (url: string) => api<{ fotos: string[] }>('/ia/foto-produto/tirar', { corpo: { produtoId, url } }), onSuccess: aplicar });
  const gerar = useMutation({ mutationFn: () => api<{ url: string; estilo: string }>('/ia/foto-produto', { corpo: { produtoId, estilo, pedido: pedido.trim() || undefined, ...(origem?.url ? { fotoAtual: origem.url } : { base64: origem?.base64, mime: origem?.mime }) } }) });
  const usar = useMutation({ mutationFn: (principal: boolean) => api<{ fotos: string[] }>('/ia/foto-produto/usar', { corpo: { produtoId, url: gerar.data!.url, principal } }), onSuccess: (r) => { aplicar(r); gerar.reset(); } });
  // Só as fotos guardadas no sistema servem de origem (as de fora o servidor não lê).
  const doSistema = fotos.filter((f) => f.startsWith('/api/fotos/'));
  return (
    <div className="coluna" style={{ gap: 8, marginBottom: 14 }}>
      {fotos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {fotos.map((u, i) => (
            <div key={u} style={{ position: 'relative' }}>
              <a href={u} target="_blank" rel="noreferrer"><img src={u} alt={i === 0 ? 'Foto principal' : `Foto ${i + 1}`} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, display: 'block' }} /></a>
              {i === 0 && <span className="etiqueta marrom" style={{ position: 'absolute', left: 4, bottom: 4 }}>principal</span>}
              {editar && <button className="botao claro pequeno" style={{ position: 'absolute', top: 4, right: 4, padding: '2px 7px' }} title="Tirar esta foto do produto" aria-label="Tirar esta foto do produto" disabled={tirar.isPending} onClick={() => window.confirm('Tirar esta foto do produto?') && tirar.mutate(u)}>✕</button>}
            </div>
          ))}
        </div>
      )}
      {!fotos.length && <p className="muted" style={{ margin: 0 }}>Este produto ainda não tem foto.</p>}
      {editar && (
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="botao claro pequeno" disabled={enviar.isPending} onClick={() => envio.current?.click()}>{enviar.isPending ? 'Enviando…' : '+ Enviar foto'}</button>
          <input ref={envio} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) enviar.mutate(f); e.target.value = ''; }} />
          {ia.data?.imagem && <button className={`botao pequeno ${gerando ? '' : 'claro'}`} aria-expanded={gerando} onClick={() => setGerando((v) => !v)}>✨ Gerar foto com IA</button>}
        </div>
      )}
      {editar && ia.data && !ia.data.imagem && <span className="muted" style={{ fontSize: 12 }}>Para gerar a foto de catálogo com IA, cole a chave da OpenAI em Configurações › Integrações › Inteligência artificial.</span>}
      {(enviar.error || tirar.error) && <Erro erro={enviar.error ?? tirar.error} />}
      {gerando && (
        <div className="coluna" style={{ gap: 8, border: '1px solid var(--linha)', borderRadius: 8, padding: 10 }}>
          <b style={{ fontSize: 14 }}>Foto de catálogo com IA</b>
          <span className="muted" style={{ fontSize: 13 }}>1. Escolha a foto da peça que serve de base.</span>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {doSistema.map((u) => (
              <button key={u} title="Usar esta foto como base" aria-pressed={origem?.url === u} onClick={() => setOrigem({ url: u, previa: u })} style={{ padding: 0, border: origem?.url === u ? '3px solid var(--dourado)' : '1px solid var(--linha)', borderRadius: 8, background: 'none', cursor: 'pointer' }}>
                <img src={u} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 5, display: 'block' }} />
              </button>
            ))}
            <button className="botao claro pequeno" onClick={() => origemArq.current?.click()}>Outra foto…</button>
            <input ref={origemArq} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const r = await reduzirFoto(f); setOrigem({ base64: r.base64, mime: r.mime, previa: r.previa }); } }} />
            {origem && !origem.url && <img src={origem.previa} alt="Foto de base" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '3px solid var(--dourado)' }} />}
          </div>
          <Campo rotulo="2. Como você quer a foto"><select value={estilo} onChange={(e) => setEstilo(e.target.value)}>{ia.data?.estilos.map((x) => <option key={x.chave} value={x.chave}>{x.nome}</option>)}</select></Campo>
          <Campo rotulo="Pedido extra (opcional)" ajuda="Ex.: fundo bege, modelo de cabelo preso"><input value={pedido} maxLength={300} onChange={(e) => setPedido(e.target.value)} /></Campo>
          <div><button className="botao pequeno" disabled={!origem || gerar.isPending} onClick={() => gerar.mutate()}>{gerar.isPending ? 'Gerando… pode levar até 2 minutos' : gerar.data ? 'Gerar outra' : 'Gerar'}</button></div>
          {gerar.error && <Erro erro={gerar.error} />}
          {gerar.data && (
            <div className="coluna" style={{ gap: 6 }}>
              <a href={gerar.data.url} target="_blank" rel="noreferrer"><img src={gerar.data.url} alt="Foto gerada pela IA" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--linha)' }} /></a>
              <span className="muted" style={{ fontSize: 13 }}>Compare com a peça de verdade antes de usar: a IA pode mudar um detalhe (pedra, formato, cor do banho). Se não ficou fiel, gere outra.</span>
              <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="botao pequeno" disabled={usar.isPending} onClick={() => usar.mutate(true)}>Usar como foto principal</button>
                <button className="botao claro pequeno" disabled={usar.isPending} onClick={() => usar.mutate(false)}>Adicionar às fotos</button>
                <button className="botao claro pequeno" onClick={() => gerar.reset()}>Descartar</button>
              </div>
              {usar.error && <Erro erro={usar.error} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
