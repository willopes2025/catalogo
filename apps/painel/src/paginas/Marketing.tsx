import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { centavosParaTexto, dataHora, paraCentavos, reais } from '../formato';
import { Abas, Campo, Carregando, Erro, Indicador, Topo } from '../componentes/ui';

const CANAIS: Record<string, string> = { meta: 'Meta Ads (Facebook/Instagram)', google: 'Google Ads', instagram: 'Instagram orgânico', whatsapp: 'WhatsApp', evento: 'Evento', outro: 'Outro' };
const codigo = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function Marketing() {
  const [aba, setAba] = useState<'resultados' | 'campanhas' | 'links'>('resultados');
  return (
    <>
      <Topo eb="Marketing" titulo="Quanto custa cada nova revendedora" sub="Campanhas, custo por candidata e por aprovada, e quanto as aprovadas já venderam" />
      <Abas ativa={aba} mudar={setAba} abas={[['resultados', 'Resultados'], ['campanhas', 'Campanhas'], ['links', 'Gerar link rastreável']]} />
      {aba === 'resultados' && <Resultados />}
      {aba === 'campanhas' && <Campanhas />}
      {aba === 'links' && <Links />}
    </>
  );
}

function Resultados() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['marketing-resultados'], queryFn: () => api<any>('/marketing/resultados') });
  const sinc = useMutation({ mutationFn: () => api<{ atualizadas: number; semDados: number }>('/marketing/sincronizar-meta', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['marketing-resultados'] }) });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const { linhas, totais, metaLigado } = q.data;
  const div = (a: number, b: number) => (b ? reais(Math.round(a / b)) : '—');
  return (
    <div className="coluna">
      <div className="grade g4">
        <Indicador tipo="destaque" rotulo="Investido" valor={reais(totais.investimento)} detalhe={`${totais.candidatas} candidatas · ${totais.aprovadas} aprovadas`} />
        <Indicador rotulo="Custo por candidata" valor={div(totais.investimento, totais.candidatas)} />
        <Indicador rotulo="Custo por aprovada" valor={div(totais.investimento, totais.aprovadas)} />
        <Indicador rotulo="Vendido pelas aprovadas" valor={reais(totais.vendidoPelasAprovadas)} detalhe={totais.investimento ? `${(totais.vendidoPelasAprovadas / totais.investimento).toFixed(1).replace('.', ',')}× o investido` : undefined} />
      </div>
      <div className="flex entre" style={{ flexWrap: 'wrap' }}>
        <span className="muted">
          Os totais acima somam só as campanhas cadastradas. {totais.candidatasSemCampanha} candidata(s) chegaram sem link de campanha (direto, indicação, equipe)
          {totais.candidatasComCodigoSemCampanha ? ` e ${totais.candidatasComCodigoSemCampanha} com um código que ainda não tem campanha cadastrada (marcado abaixo)` : ''}.
        </span>
        {pode('marketing', 'editar') && (metaLigado ? (
          <button className="botao claro" disabled={sinc.isPending} onClick={() => sinc.mutate()}>{sinc.isPending ? 'Buscando…' : 'Atualizar gasto do Meta Ads'}</button>
        ) : (
          <Link className="botao claro" to="/configuracoes?aba=integracoes">Ligar o Meta Ads</Link>
        ))}
      </div>
      {sinc.error && <Erro erro={sinc.error} />}
      {sinc.data && <div className="aviso ok">{sinc.data.atualizadas} campanha(s) atualizada(s){sinc.data.semDados ? `; ${sinc.data.semDados} sem gasto no Meta` : ''}.</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="tabela">
          <thead><tr><th>Campanha</th><th className="num">Investido</th><th className="num">Candidatas</th><th className="num">Aprovadas</th><th className="num">Custo/candidata</th><th className="num">Custo/aprovada</th><th className="num">Respostas</th><th className="num">Vendido pelas aprovadas</th><th className="num">Retorno</th></tr></thead>
          <tbody>
            {linhas.map((l: any) => (
              <tr key={l.utm}>
                <td>{l.campanha ? <><b>{l.campanha.nome}</b><div className="muted">{CANAIS[l.campanha.canal]} · {l.utm}{l.campanha.sincronizado ? ' · gasto do Meta' : ''}</div></> : <><span className="etiqueta alerta">Sem campanha</span> <span className="muted">{l.utm}</span></>}</td>
                <td className="num">{l.campanha ? reais(l.investimento) : '—'}</td>
                <td className="num">{l.candidatas}</td>
                <td className="num">{l.aprovadas}</td>
                <td className="num">{l.custoPorCandidata !== null ? reais(l.custoPorCandidata) : '—'}</td>
                <td className="num">{l.custoPorAprovada !== null ? reais(l.custoPorAprovada) : '—'}</td>
                <td className="num">{l.respostas}{l.clientes ? <div className="muted">{l.clientes} cliente(s)</div> : null}</td>
                <td className="num">{reais(l.vendidoPelasAprovadas)}{l.representantesVendendo ? <div className="muted">{l.representantesVendendo} vendendo</div> : null}</td>
                <td className="num">{l.retorno !== null ? `${String(l.retorno).replace('.', ',')}×` : '—'}</td>
              </tr>
            ))}
            {!linhas.length && <tr><td colSpan={9} className="vazio">Ainda não há campanhas. Cadastre uma e use o link rastreável nos anúncios.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ margin: 0 }}>O resultado de cada campanha vem do código <b>utm_campaign</b> do link que a pessoa usou. "Retorno" é quanto as representantes aprovadas por aquela campanha já venderam nos acertos para cada real investido.</p>
    </div>
  );
}

function Campanhas() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['campanhas'], queryFn: () => api<any[]>('/marketing/campanhas') });
  const vazio = { nome: '', canal: 'meta', utmCampaign: '', objetivo: 'candidatas', inicio: '', fim: '', investimento: '', metaCampanhaId: '', observacao: '' };
  const [n, setN] = useState(vazio);
  const [editando, setEditando] = useState<string | null>(null);
  const corpo = () => ({ nome: n.nome, canal: n.canal, utmCampaign: n.utmCampaign || codigo(n.nome), objetivo: n.objetivo, inicio: n.inicio || null, fim: n.fim || null, investimento: paraCentavos(n.investimento || '0'), metaCampanhaId: n.metaCampanhaId || null, observacao: n.observacao || null });
  const salvar = useMutation({
    mutationFn: () => (editando ? api(`/marketing/campanhas/${editando}`, { metodo: 'PATCH', corpo: corpo() }) : api('/marketing/campanhas', { corpo: corpo() })),
    onSuccess: () => { setN(vazio); setEditando(null); qc.invalidateQueries({ queryKey: ['campanhas'] }); qc.invalidateQueries({ queryKey: ['marketing-resultados'] }); },
  });
  const set = (k: keyof typeof n) => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  if (q.isLoading) return <Carregando />;
  return (
    <div className="coluna">
      <table className="tabela">
        <thead><tr><th>Campanha</th><th>Canal</th><th>Código</th><th>Período</th><th className="num">Investimento</th><th></th></tr></thead>
        <tbody>
          {q.data?.map((c) => (
            <tr key={c.id}>
              <td><b>{c.nome}</b>{c.observacao && <div className="muted">{c.observacao}</div>}</td>
              <td>{CANAIS[c.canal]}</td>
              <td className="muted">{c.utmCampaign}</td>
              <td>{c.inicio ? c.inicio.split('-').reverse().join('/') : '—'}{c.fim ? ` a ${c.fim.split('-').reverse().join('/')}` : ''}</td>
              <td className="num">{reais(c.investimentoSincronizado ?? c.investimento)}{c.sincronizadoEm && <div className="muted">Meta · {dataHora(c.sincronizadoEm)}</div>}</td>
              <td>{pode('marketing', 'editar') && <button className="botao claro pequeno" onClick={() => { setEditando(c.id); setN({ nome: c.nome, canal: c.canal, utmCampaign: c.utmCampaign, objetivo: c.objetivo, inicio: c.inicio ?? '', fim: c.fim ?? '', investimento: centavosParaTexto(c.investimento), metaCampanhaId: c.metaCampanhaId ?? '', observacao: c.observacao ?? '' }); window.scrollTo(0, document.body.scrollHeight); }}>Editar</button>}</td>
            </tr>
          ))}
          {!q.data?.length && <tr><td colSpan={6} className="vazio">Nenhuma campanha.</td></tr>}
        </tbody>
      </table>
      {pode('marketing', editando ? 'editar' : 'criar') && (
        <div className="cartao form">
          <div className="secao">{editando ? 'Editar campanha' : 'Nova campanha'}</div>
          <Campo rotulo="Nome" className="l2"><input value={n.nome} onChange={set('nome')} placeholder="Ex.: Revendedoras dezembro" /></Campo>
          <Campo rotulo="Canal"><select value={n.canal} onChange={set('canal')}>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
          <Campo rotulo="Objetivo"><select value={n.objetivo} onChange={set('objetivo')}><option value="candidatas">Trazer revendedoras</option><option value="clientes">Trazer clientes</option></select></Campo>
          <Campo rotulo="Código nos links (utm_campaign)" ajuda={!n.utmCampaign && n.nome ? `Automático: ${codigo(n.nome)}` : 'Igual ao usado nos anúncios'}><input value={n.utmCampaign} onChange={(e) => setN({ ...n, utmCampaign: codigo(e.target.value) })} /></Campo>
          <Campo rotulo="Investimento (R$)" ajuda="Se ligar ao Meta, o gasto vem de lá"><input inputMode="decimal" value={n.investimento} onChange={set('investimento')} /></Campo>
          <Campo rotulo="Início"><input type="date" value={n.inicio} onChange={set('inicio')} /></Campo>
          <Campo rotulo="Fim"><input type="date" value={n.fim} onChange={set('fim')} /></Campo>
          <Campo rotulo="Id da campanha no Meta" ajuda="Opcional: no Gerenciador de Anúncios, coluna Identificação"><input inputMode="numeric" value={n.metaCampanhaId} onChange={(e) => setN({ ...n, metaCampanhaId: e.target.value.replace(/\D/g, '') })} /></Campo>
          <Campo rotulo="Observação" className="l2"><input value={n.observacao} onChange={set('observacao')} /></Campo>
          <div className="coluna" style={{ gridColumn: 'span 4' }}>
            {salvar.error && <Erro erro={salvar.error} />}
            <div className="flex">
              <button className="botao" disabled={n.nome.trim().length < 2 || salvar.isPending} onClick={() => salvar.mutate()}>{editando ? 'Salvar' : 'Cadastrar'}</button>
              {editando && <button className="botao claro" onClick={() => { setEditando(null); setN(vazio); }}>Cancelar</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Links() {
  const campanhas = useQuery({ queryKey: ['campanhas'], queryFn: () => api<any[]>('/marketing/campanhas') });
  const formularios = useQuery({ queryKey: ['formularios'], queryFn: () => api<any[]>('/formularios').catch(() => []) });
  const [d, setD] = useState({ destino: '/cadastro', campanha: '', fonte: 'instagram', meio: 'pago', conteudo: '' });
  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (d.fonte) p.set('utm_source', d.fonte);
    if (d.meio) p.set('utm_medium', d.meio);
    if (d.campanha) p.set('utm_campaign', d.campanha);
    if (d.conteudo) p.set('utm_content', codigo(d.conteudo));
    return `${window.location.origin}${d.destino}?${p}`;
  }, [d]);
  const copiar = async () => { try { await navigator.clipboard.writeText(url); } catch { window.prompt('Copie:', url); } };
  return (
    <div className="cartao form">
      <Campo rotulo="Para onde o link leva" className="l2">
        <select value={d.destino} onChange={(e) => setD({ ...d, destino: e.target.value })}>
          <option value="/cadastro">Formulário "Seja uma revendedora"</option>
          {formularios.data?.filter((f) => f.ativo).map((f) => <option key={f.id} value={`/f/${f.slug}`}>Formulário: {f.titulo}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Campanha" className="l2">
        <select value={d.campanha} onChange={(e) => setD({ ...d, campanha: e.target.value })}>
          <option value="">Escolha</option>
          {campanhas.data?.filter((c) => c.ativa).map((c) => <option key={c.id} value={c.utmCampaign}>{c.nome}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Fonte (utm_source)"><select value={d.fonte} onChange={(e) => setD({ ...d, fonte: e.target.value })}><option value="instagram">Instagram</option><option value="facebook">Facebook</option><option value="google">Google</option><option value="whatsapp">WhatsApp</option><option value="indicacao">Indicação</option><option value="evento">Evento</option></select></Campo>
      <Campo rotulo="Meio (utm_medium)"><select value={d.meio} onChange={(e) => setD({ ...d, meio: e.target.value })}><option value="pago">Anúncio pago</option><option value="organico">Orgânico</option><option value="bio">Link da bio</option><option value="story">Story</option><option value="grupo">Grupo</option></select></Campo>
      <Campo rotulo="Qual anúncio (opcional)" className="l2" ajuda="Para comparar criativos: ex. video-depoimento, carrossel-maleta"><input value={d.conteudo} onChange={(e) => setD({ ...d, conteudo: e.target.value })} /></Campo>
      <div className="coluna" style={{ gridColumn: 'span 4' }}>
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
        <div className="flex"><button className="botao" disabled={!d.campanha} onClick={() => void copiar()}>Copiar link</button>{!d.campanha && <span className="muted">Escolha a campanha (cadastre em Campanhas).</span>}</div>
      </div>
    </div>
  );
}
