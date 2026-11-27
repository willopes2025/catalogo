import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, lerSessao, pode } from '../api';
import { data, reais } from '../formato';
import { Campo, Carregando, Erro } from '../componentes/ui';

interface CfgPortal { whatsappMatriz: string; taxaCobrancaPb: number; termoCobranca: string }
const CATEGORIAS: Record<string, string> = { boas_vindas: 'Boas-vindas', sistema: 'Como usar o app', vendas: 'Vendas', negociacao: 'Negociação', produto: 'Produto', outro: 'Outros' };

/** Configurações › App da consultora: contato, serviço de cobrança, treinamentos e material de divulgação. */
export function AppConsultora() {
  return (
    <div className="coluna">
      <ConfigPortal />
      <Conteudos secao="treinamento" />
      <Conteudos secao="divulgacao" />
      <VendasEmCobranca />
    </div>
  );
}

function ConfigPortal() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'portal_consultora'], queryFn: () => api<CfgPortal>('/configuracoes/chave/portal_consultora') });
  const [v, setV] = useState<CfgPortal | null>(null);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  const salvar = useMutation({ mutationFn: () => api('/configuracoes/chave/portal_consultora', { metodo: 'PUT', corpo: v }), onSuccess: () => qc.invalidateQueries({ queryKey: ['config', 'portal_consultora'] }) });
  if (!v) return <Carregando />;
  return (
    <div className="cartao form">
      <div className="secao">App da consultora</div>
      <Campo rotulo="WhatsApp da equipe (botão Falar com a Aritana)" className="l2" ajuda="Só números, com DDD"><input value={v.whatsappMatriz} onChange={(e) => setV({ ...v, whatsappMatriz: e.target.value.replace(/\D/g, '') })} placeholder="27999990000" /></Campo>
      <Campo rotulo="Taxa do serviço de cobrança (%)" className="l2" ajuda="Quando a consultora passa a cobrança para a Aritana, a Aritana fica com esta parte do que receber; o resto vai para ela (split no Asaas ou crédito no fechamento)."><input inputMode="decimal" value={String(v.taxaCobrancaPb / 100).replace('.', ',')} onChange={(e) => setV({ ...v, taxaCobrancaPb: Math.round(Number(e.target.value.replace(',', '.') || 0) * 100) })} /></Campo>
      <Campo rotulo="Termo que a consultora aceita antes de acionar a cobrança" className="l4"><textarea rows={5} value={v.termoCobranca} onChange={(e) => setV({ ...v, termoCobranca: e.target.value })} /></Campo>
      {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
      <div className="l4 flex"><button className="botao" disabled={!pode('configuracoes', 'editar') || salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button>{salvar.isSuccess && <span className="muted">Salvo.</span>}</div>
    </div>
  );
}

/** Envia o arquivo direto (sem base64), mostrando o andamento: vídeo grande não trava. */
function enviarArquivo(arquivo: File, progresso: (p: number) => void) {
  return new Promise<{ arquivo: string; mime: string; tamanho: number }>((ok, erro) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/conteudos/arquivo');
    x.setRequestHeader('authorization', `Bearer ${lerSessao()?.token ?? ''}`);
    x.setRequestHeader('content-type', arquivo.type || 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && progresso(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      const j = (() => { try { return JSON.parse(x.responseText); } catch { return {}; } })();
      x.status < 300 ? ok(j) : erro(new Error(j.mensagem ?? `Falhou (${x.status})`));
    };
    x.onerror = () => erro(new Error('Falha de conexão no envio.'));
    x.send(arquivo);
  });
}

function Conteudos({ secao }: { secao: 'treinamento' | 'divulgacao' }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['conteudos', secao], queryFn: () => api<any[]>(`/conteudos?secao=${secao}`) });
  const [f, setF] = useState({ categoria: secao === 'treinamento' ? 'boas_vindas' : 'Posts', titulo: '', descricao: '', legenda: '' });
  const [arq, setArq] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const editar = useMutation({ mutationFn: (d: { id: string; corpo: any }) => api(`/conteudos/${d.id}`, { metodo: 'PATCH', corpo: d.corpo }), onSuccess: () => qc.invalidateQueries({ queryKey: ['conteudos', secao] }) });
  const apagar = useMutation({ mutationFn: (id: string) => api(`/conteudos/${id}`, { metodo: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['conteudos', secao] }) });
  const adicionar = async () => {
    if (!arq) return;
    setErro(null);
    try {
      setPct(0);
      const up = await enviarArquivo(arq, setPct);
      await api('/conteudos', { corpo: { secao, ...f, descricao: f.descricao || null, legenda: f.legenda || null, ...up, ordem: (q.data?.length ?? 0) + 1 } });
      setF({ ...f, titulo: '', descricao: '', legenda: '' });
      setArq(null);
      qc.invalidateQueries({ queryKey: ['conteudos', secao] });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setPct(null);
    }
  };
  const editavel = pode('configuracoes', 'editar');
  return (
    <div className="cartao coluna">
      <div className="secao" style={{ marginTop: 0 }}>{secao === 'treinamento' ? 'Treinamentos (vídeos, PDFs e áudios)' : 'Material de divulgação (fotos, vídeos e legendas)'}</div>
      {editavel && (
        <div className="form" style={{ padding: 0 }}>
          <Campo rotulo="Categoria">
            {secao === 'treinamento'
              ? <select value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>{Object.entries(CATEGORIAS).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
              : <input value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })} placeholder="Ex.: Natal, Lançamentos" />}
          </Campo>
          <Campo rotulo="Título" className="l2"><input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} /></Campo>
          <Campo rotulo="Arquivo"><input type="file" accept={secao === 'treinamento' ? 'video/mp4,video/quicktime,video/webm,application/pdf,audio/mpeg' : 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime'} onChange={(e) => setArq(e.target.files?.[0] ?? null)} /></Campo>
          <Campo rotulo="Descrição" className="l2"><input value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} /></Campo>
          {secao === 'divulgacao' && <Campo rotulo="Legenda pronta (a consultora copia)" className="l2"><textarea rows={2} value={f.legenda} onChange={(e) => setF({ ...f, legenda: e.target.value })} /></Campo>}
          <div className="campo l4 flex" style={{ alignItems: 'center' }}>
            <button className="botao" disabled={!arq || f.titulo.trim().length < 2 || pct !== null} onClick={() => void adicionar()}>{pct !== null ? `Enviando… ${pct}%` : 'Adicionar'}</button>
            {arq && <span className="muted">{arq.name} · {(arq.size / 1024 / 1024).toFixed(1)} MB</span>}
          </div>
          {erro && <div className="l4"><Erro erro={new Error(erro)} /></div>}
        </div>
      )}
      {q.isLoading ? <Carregando /> : !q.data?.length ? <p className="muted">Nada ainda.</p> : (
        <table className="tabela">
          <thead><tr><th>Categoria</th><th>Título</th><th>Tipo</th><th className="num">{secao === 'treinamento' ? 'Viram' : ''}</th><th></th></tr></thead>
          <tbody>
            {q.data.map((c) => (
              <tr key={c.id} style={{ opacity: c.ativo ? 1 : 0.5 }}>
                <td>{CATEGORIAS[c.categoria] ?? c.categoria}</td>
                <td><a href={c.url} target="_blank" rel="noreferrer">{c.titulo}</a>{c.descricao && <div className="muted" style={{ fontSize: 12 }}>{c.descricao}</div>}</td>
                <td className="muted">{c.mime.split('/')[1]} · {(c.tamanho / 1024 / 1024).toFixed(1)} MB</td>
                <td className="num">{secao === 'treinamento' ? c.vistos : ''}</td>
                <td>
                  {editavel && (
                    <div className="flex" style={{ gap: 6 }}>
                      <button className="botao claro pequeno" onClick={() => editar.mutate({ id: c.id, corpo: { ativo: !c.ativo } })}>{c.ativo ? 'Ocultar' : 'Mostrar'}</button>
                      <button className="botao perigo pequeno" onClick={() => window.confirm(`Apagar "${c.titulo}"?`) && apagar.mutate(c.id)}>Apagar</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Vendas das consultoras passadas para a Aritana cobrar. */
function VendasEmCobranca() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['consultoras-vendas', 'em_cobranca'], queryFn: () => api<any[]>('/consultoras/vendas?status=em_cobranca'), enabled: pode('cobranca', 'ver') });
  const porFora = useMutation({ mutationFn: (tituloId: string) => api(`/consultoras/cobranca/${tituloId}/recebido-por-fora`, { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['consultoras-vendas'] }) });
  if (!pode('cobranca', 'ver')) return null;
  return (
    <div className="cartao coluna">
      <div className="secao" style={{ marginTop: 0 }}>Cobranças passadas pelas consultoras</div>
      <p className="muted" style={{ margin: 0 }}>Os boletos estão no Financeiro (categoria "Cobrança para consultora"). Se a consultora receber por fora uma parcela que está com a Aritana, use "Recebeu por fora": o boleto é cancelado e o valor é descontado dela.</p>
      {porFora.error && <Erro erro={porFora.error} />}
      {q.isLoading ? <Carregando /> : !q.data?.length ? <p className="muted">Nenhuma.</p> : (
        <table className="tabela">
          <thead><tr><th>Venda</th><th>Consultora</th><th>Cliente</th><th>Parcelas</th></tr></thead>
          <tbody>
            {q.data.map((v) => (
              <tr key={v.id}>
                <td>Nº {v.numero}<div className="muted">{data(String(v.cobrancaEm ?? v.criadoEm).slice(0, 10))}</div></td>
                <td>{v.consultora}</td>
                <td>{v.cliente}</td>
                <td>
                  {v.parcelas.map((p: any) => (
                    <div key={p.numero} className="flex" style={{ gap: 6, alignItems: 'center' }}>
                      <span>{p.numero}ª {reais(p.valor)} · {data(p.vencimento)} · {p.pagoEm ? <span className="etiqueta ok">Paga</span> : <span className="etiqueta alerta">Em aberto</span>}{p.split ? ' · split' : ' · crédito'}</span>
                      {!p.pagoEm && p.tituloId && pode('cobranca', 'excluir') && <button className="botao claro pequeno" disabled={porFora.isPending} onClick={() => window.confirm('A consultora recebeu esta parcela por fora? O boleto é cancelado e o valor é descontado dela.') && porFora.mutate(p.tituloId)}>Recebeu por fora</button>}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
