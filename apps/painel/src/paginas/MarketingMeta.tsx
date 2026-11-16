import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, pode } from '../api';
import { centavosParaTexto, dataHora, paraCentavos, reais } from '../formato';
import { Campo, Carregando, Erro, Indicador } from '../componentes/ui';
import { hoje } from './indicadores/comum';

type Secao = 'campanhas' | 'catalogo' | 'publicos' | 'leads' | 'pagina' | 'configurar';
const SECOES: [Secao, string][] = [['campanhas', 'Anúncios'], ['catalogo', 'Catálogo'], ['publicos', 'Públicos'], ['leads', 'Leads de formulário'], ['pagina', 'Página'], ['configurar', 'Configurar']];
const SITUACAO: Record<string, [string, string]> = {
  ACTIVE: ['ativa', 'ok'], PAUSED: ['pausada', 'neutra'], CAMPAIGN_PAUSED: ['campanha pausada', 'neutra'], ADSET_PAUSED: ['conjunto pausado', 'neutra'],
  WITH_ISSUES: ['com problema', 'erro'], IN_PROCESS: ['processando', 'alerta'], PENDING_REVIEW: ['em análise', 'alerta'], ARCHIVED: ['arquivada', 'neutra'], DISAPPROVED: ['reprovada', 'erro'],
};
const ORIGENS: Record<string, string> = { clientes: 'Clientes', representantes: 'Representantes ativas', candidatas: 'Candidatas' };
const num = (n: number) => n.toLocaleString('pt-BR');

interface Estado { ligado: boolean; conta: string | null; paginaId: string | null; catalogoId: string | null; catalogoLink: string | null; leadsFunilId: string | null; leadsAuto: boolean }

/** Marketing › Meta: o que antes exigia abrir o Gerenciador de Anúncios. */
export function MarketingMeta() {
  const estado = useQuery({ queryKey: ['meta', 'estado'], queryFn: () => api<Estado>('/marketing/meta/estado') });
  const [secao, setSecao] = useState<Secao>('campanhas');
  const editar = pode('marketing', 'editar');
  if (estado.isLoading) return <Carregando />;
  if (estado.error) return <Erro erro={estado.error} />;
  const e = estado.data!;
  if (!e.ligado) {
    return (
      <div className="cartao">
        <p style={{ marginTop: 0 }}><b>O Meta ainda não está ligado.</b> Cole o token do usuário do sistema em Configurações › Integrações › Meta Ads. Depois volte aqui para escolher a conta de anúncios, a página e o catálogo.</p>
        <Link className="botao" to="/configuracoes?aba=integracoes">Abrir integrações</Link>
      </div>
    );
  }
  const atual = !e.conta && secao !== 'configurar' && editar ? 'configurar' : secao;
  return (
    <div className="coluna">
      <div className="flex" style={{ flexWrap: 'wrap', gap: 6 }} role="tablist" aria-label="Meta">
        {SECOES.filter(([s]) => s !== 'configurar' || editar).map(([s, nome]) => (
          <button key={s} role="tab" aria-selected={atual === s} className={`botao pequeno ${atual === s ? '' : 'claro'}`} onClick={() => setSecao(s)}>{nome}</button>
        ))}
      </div>
      {!e.conta && atual !== 'configurar' && <div className="aviso alerta">Falta escolher a conta de anúncios. Peça a quem cuida do marketing para abrir "Configurar".</div>}
      {atual === 'campanhas' && e.conta && <Campanhas editar={editar} />}
      {atual === 'catalogo' && <Catalogo e={e} editar={editar} irConfigurar={() => setSecao('configurar')} />}
      {atual === 'publicos' && e.conta && <Publicos editar={editar} />}
      {atual === 'leads' && <Leads e={e} editar={editar} irConfigurar={() => setSecao('configurar')} />}
      {atual === 'pagina' && <Pagina e={e} irConfigurar={() => setSecao('configurar')} />}
      {atual === 'configurar' && <Configurar e={e} />}
    </div>
  );
}

// ───── Campanhas ─────

interface Linha { id: string; nome: string; status: string; situacao: string; objetivo: string | null; orcamentoDiario: number | null; orcamentoTotal: number | null; gasto: number; impressoes: number; alcance: number; cliques: number; leads: number; conversas: number; ctr: number | null; custoPorClique: number | null; custoPorLead: number | null; custoPorConversa: number | null }
interface Painel { linhas: Linha[]; totais: { gasto: number; impressoes: number; cliques: number; leads: number; conversas: number; ativas: number } }
const NIVEIS = ['campaign', 'adset', 'ad'] as const;
const NOME_NIVEL = { campaign: 'Campanha', adset: 'Conjunto de anúncios', ad: 'Anúncio' } as const;

function Campanhas({ editar }: { editar: boolean }) {
  const qc = useQueryClient();
  const fim = hoje();
  const [de, setDe] = useState(`${fim.slice(0, 8)}01`);
  const [ate, setAte] = useState(fim);
  // Caminho aberto: campanha › conjunto. Vazio = lista de campanhas.
  const [caminho, setCaminho] = useState<{ id: string; nome: string }[]>([]);
  const nivel = NIVEIS[caminho.length];
  const pai = caminho[caminho.length - 1];
  const q = useQuery({ queryKey: ['meta', 'painel', de, ate, nivel, pai?.id ?? ''], queryFn: () => api<Painel>(`/marketing/meta/painel?de=${de}&ate=${ate}&nivel=${nivel}${pai ? `&pai=${pai.id}` : ''}`), enabled: de <= ate });
  const [orc, setOrc] = useState<{ id: string; valor: string } | null>(null);
  const recarregar = () => qc.invalidateQueries({ queryKey: ['meta', 'painel'] });
  const status = useMutation({ mutationFn: (v: { id: string; status: 'ACTIVE' | 'PAUSED' }) => api(`/marketing/meta/itens/${v.id}/status`, { corpo: { status: v.status } }), onSuccess: recarregar });
  const orcamento = useMutation({ mutationFn: (v: { id: string; diario: number }) => api(`/marketing/meta/itens/${v.id}/orcamento`, { corpo: { diario: v.diario } }), onSuccess: () => { setOrc(null); recarregar(); } });
  const periodo = (dias: number | 'mes') => { setAte(fim); setDe(dias === 'mes' ? `${fim.slice(0, 8)}01` : new Date(Date.parse(fim) - (dias - 1) * 86400_000).toISOString().slice(0, 10)); };
  const t = q.data?.totais;
  return (
    <div className="coluna">
      <div className="flex" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Campo rotulo="De"><input type="date" value={de} max={ate} onChange={(e) => setDe(e.target.value)} /></Campo>
        <Campo rotulo="Até"><input type="date" value={ate} min={de} max={fim} onChange={(e) => setAte(e.target.value)} /></Campo>
        <button className="botao claro pequeno" onClick={() => periodo(7)}>7 dias</button>
        <button className="botao claro pequeno" onClick={() => periodo(30)}>30 dias</button>
        <button className="botao claro pequeno" onClick={() => periodo('mes')}>Este mês</button>
      </div>
      {t && caminho.length === 0 && (
        <div className="grade g4">
          <Indicador tipo="destaque" rotulo="Gasto no período" valor={reais(t.gasto)} detalhe={`${t.ativas} campanha(s) ativa(s)`} />
          <Indicador rotulo="Cliques no link" valor={num(t.cliques)} detalhe={t.cliques ? `${reais(Math.round(t.gasto / t.cliques))} por clique` : undefined} />
          <Indicador rotulo="Leads de formulário" valor={num(t.leads)} detalhe={t.leads ? `${reais(Math.round(t.gasto / t.leads))} por lead` : undefined} />
          <Indicador rotulo="Conversas iniciadas" valor={num(t.conversas)} detalhe={t.conversas ? `${reais(Math.round(t.gasto / t.conversas))} por conversa` : undefined} />
        </div>
      )}
      {caminho.length > 0 && (
        <nav className="flex" style={{ flexWrap: 'wrap', gap: 6 }} aria-label="Onde estou">
          <button className="botao claro pequeno" onClick={() => setCaminho([])}>Todas as campanhas</button>
          {caminho.map((c, i) => (
            <span key={c.id} className="flex" style={{ gap: 6 }}>›{i < caminho.length - 1 ? <button className="botao claro pequeno" onClick={() => setCaminho(caminho.slice(0, i + 1))}>{c.nome}</button> : <b>{c.nome}</b>}</span>
          ))}
        </nav>
      )}
      {status.error && <Erro erro={status.error} />}
      {orcamento.error && <Erro erro={orcamento.error} />}
      {q.isLoading && <Carregando />}
      {q.error && <Erro erro={q.error} />}
      {q.data && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tabela">
            <thead><tr><th>{NOME_NIVEL[nivel]}</th><th>Situação</th><th className="num">Orçamento/dia</th><th className="num">Gasto</th><th className="num">Alcance</th><th className="num">Cliques</th><th className="num">CTR</th><th className="num">Custo/clique</th><th className="num">Leads</th><th className="num">Custo/lead</th><th className="num">Conversas</th>{editar && <th></th>}</tr></thead>
            <tbody>
              {q.data.linhas.map((l) => {
                const [rotulo, cor] = SITUACAO[l.situacao] ?? [l.situacao.toLowerCase().replace(/_/g, ' '), 'neutra'];
                const mexe = editar && l.situacao !== 'ARCHIVED';
                return (
                  <tr key={l.id}>
                    <td>{nivel !== 'ad' && l.situacao !== 'ARCHIVED' ? <button className="link" style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--marrom)', textDecoration: 'underline', cursor: 'pointer', textAlign: 'left' }} title={nivel === 'campaign' ? 'Ver os conjuntos de anúncios' : 'Ver os anúncios'} onClick={() => setCaminho([...caminho, { id: l.id, nome: l.nome }])}>{l.nome}</button> : l.nome}</td>
                    <td><span className={`etiqueta ${cor}`}>{rotulo}</span></td>
                    <td className="num">
                      {orc?.id === l.id ? (
                        <span className="flex" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <input aria-label="Orçamento por dia em reais" inputMode="decimal" style={{ width: 90, textAlign: 'right' }} value={orc.valor} onChange={(e) => setOrc({ id: l.id, valor: e.target.value })} autoFocus />
                          <button className="botao pequeno" disabled={orcamento.isPending || paraCentavos(orc.valor) < 100} onClick={() => orcamento.mutate({ id: l.id, diario: paraCentavos(orc.valor) })}>Salvar</button>
                          <button className="botao claro pequeno" onClick={() => setOrc(null)}>Cancelar</button>
                        </span>
                      ) : l.orcamentoDiario != null ? (
                        mexe ? <button className="botao claro pequeno" title="Mudar o orçamento por dia" onClick={() => setOrc({ id: l.id, valor: centavosParaTexto(l.orcamentoDiario) })}>{reais(l.orcamentoDiario)}</button> : reais(l.orcamentoDiario)
                      ) : l.orcamentoTotal != null ? <span title="Orçamento total da campanha (muda só no Gerenciador)">{reais(l.orcamentoTotal)} total</span> : <span className="muted" title={nivel === 'campaign' ? 'O orçamento fica nos conjuntos: clique no nome da campanha' : undefined}>{nivel === 'campaign' ? 'nos conjuntos' : '—'}</span>}
                    </td>
                    <td className="num">{reais(l.gasto)}</td>
                    <td className="num">{num(l.alcance)}</td>
                    <td className="num">{num(l.cliques)}</td>
                    <td className="num">{l.ctr != null ? `${l.ctr.toLocaleString('pt-BR')}%` : '—'}</td>
                    <td className="num">{l.custoPorClique != null ? reais(l.custoPorClique) : '—'}</td>
                    <td className="num">{num(l.leads)}</td>
                    <td className="num">{l.custoPorLead != null ? reais(l.custoPorLead) : '—'}</td>
                    <td className="num">{num(l.conversas)}</td>
                    {editar && <td className="num">{mexe && (l.status === 'ACTIVE' ? <button className="botao claro pequeno" disabled={status.isPending} onClick={() => window.confirm(`Pausar "${l.nome}"? Os anúncios param de rodar agora.`) && status.mutate({ id: l.id, status: 'PAUSED' })}>Pausar</button> : <button className="botao pequeno" disabled={status.isPending} onClick={() => window.confirm(`Ativar "${l.nome}"? Os anúncios voltam a rodar e a gastar.`) && status.mutate({ id: l.id, status: 'ACTIVE' })}>Ativar</button>)}</td>}
                  </tr>
                );
              })}
              {q.data.linhas.length === 0 && <tr><td colSpan={editar ? 12 : 11} className="muted">Nada neste período.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ margin: 0 }}>Os números vêm do Meta na hora. Criar campanha e anúncio continua sendo feito no Gerenciador de Anúncios; aqui dá para acompanhar, pausar, ativar e mudar o orçamento por dia.</p>
    </div>
  );
}

// ───── Catálogo ─────

function Catalogo({ e, editar, irConfigurar }: { e: Estado; editar: boolean; irConfigurar: () => void }) {
  const sinc = useMutation({ mutationFn: () => api<{ enviados: number; semEstoque: number; retirados: number; semFoto: number; erros: string[] }>('/marketing/meta/catalogo/sincronizar', { corpo: {} }) });
  if (!e.catalogoId || !e.catalogoLink) return <Falta texto="Escolha o catálogo do Meta e o endereço para onde o produto leva quem clica." editar={editar} ir={irConfigurar} />;
  return (
    <div className="cartao coluna">
      <p style={{ margin: 0 }}>Manda para o catálogo do Meta os produtos ativos marcados para aparecer no catálogo, com foto, preço e estoque. Esse catálogo alimenta a loja do Instagram, os anúncios de catálogo e o catálogo do WhatsApp.</p>
      <ul className="muted" style={{ margin: 0, paddingLeft: 20 }}>
        <li>Produto sem foto ou sem preço não é enviado.</li>
        <li>Produto sem estoque vai como "esgotado".</li>
        <li>Produto desativado ou tirado do catálogo some do Meta também.</li>
        <li>Quem clica no produto vai para: <b>{e.catalogoLink}</b></li>
      </ul>
      {editar && <div><button className="botao" disabled={sinc.isPending} onClick={() => sinc.mutate()}>{sinc.isPending ? 'Enviando…' : 'Enviar produtos para o Meta'}</button></div>}
      {sinc.error && <Erro erro={sinc.error} />}
      {sinc.data && (
        <div className={`aviso ${sinc.data.erros.length ? 'alerta' : 'ok'}`}>
          {sinc.data.enviados} produto(s) enviado(s){sinc.data.semEstoque ? ` (${sinc.data.semEstoque} como esgotado)` : ''}; {sinc.data.retirados} retirado(s).
          {sinc.data.semFoto > 0 && ` ${sinc.data.semFoto} ficaram de fora por não ter foto.`}
          {sinc.data.erros.length > 0 && <ul>{sinc.data.erros.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      )}
      <p className="muted" style={{ margin: 0 }}>O Meta leva alguns minutos para mostrar as mudanças. Rode de novo sempre que mudar preço, foto ou estoque.</p>
    </div>
  );
}

function Falta({ texto, editar, ir }: { texto: string; editar: boolean; ir: () => void }) {
  return <div className="aviso alerta">{texto} {editar ? <button className="botao claro pequeno" onClick={ir}>Configurar</button> : 'Peça a quem cuida do marketing.'}</div>;
}

// ───── Públicos ─────

interface Publico { id: string; nome: string; tipo: 'sistema' | 'semelhante' | 'outro'; origem: string | null; tamanhoDe: number | null; tamanhoAte: number | null; atualizadoEm: string | null; situacao: string | null }

function Publicos({ editar }: { editar: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['meta', 'publicos'], queryFn: () => api<Publico[]>('/marketing/meta/publicos') });
  const [origem, setOrigem] = useState('clientes');
  const previa = useQuery({ queryKey: ['meta', 'previa', origem], queryFn: () => api<{ comAutorizacao: number; semAutorizacao: number }>(`/marketing/meta/publicos/previa?origem=${origem}`) });
  const recarregar = () => qc.invalidateQueries({ queryKey: ['meta', 'publicos'] });
  const criar = useMutation({ mutationFn: () => api<{ enviados: number; recebidos: number }>('/marketing/meta/publicos', { corpo: { origem } }), onSuccess: recarregar });
  const atualizar = useMutation({ mutationFn: (id: string) => api<{ enviados: number }>(`/marketing/meta/publicos/${id}/atualizar`, { corpo: {} }), onSuccess: recarregar });
  const [pct, setPct] = useState(1);
  const semelhante = useMutation({ mutationFn: (id: string) => api(`/marketing/meta/publicos/${id}/semelhante`, { corpo: { percentual: pct } }), onSuccess: recarregar });
  const jaExiste = q.data?.some((p) => p.origem === origem);
  return (
    <div className="coluna">
      {editar && (
        <div className="cartao coluna">
          <b>Criar público com quem já está no sistema</b>
          <div className="flex" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Campo rotulo="Quem entra"><select value={origem} onChange={(e) => setOrigem(e.target.value)}>{Object.entries(ORIGENS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
            <button className="botao" disabled={criar.isPending || !previa.data || previa.data.comAutorizacao < 100 || jaExiste} onClick={() => criar.mutate()}>{criar.isPending ? 'Enviando…' : 'Criar público no Meta'}</button>
          </div>
          {previa.data && (
            <span className="muted">
              {num(previa.data.comAutorizacao)} contato(s) com autorização de uso dos dados (LGPD){previa.data.semAutorizacao ? `; ${num(previa.data.semAutorizacao)} sem autorização ficam de fora` : ''}.
              {previa.data.comAutorizacao < 100 && ' O Meta só aceita público com 100 ou mais.'}
              {jaExiste && ' Este público já existe: use "Atualizar" na lista abaixo.'}
            </span>
          )}
          <span className="muted">Telefone e e-mail saem do sistema embaralhados (SHA-256): o Meta só consegue casar com quem já tem conta lá, sem ver os dados.</span>
          {criar.error && <Erro erro={criar.error} />}
          {criar.data && <div className="aviso ok">Público criado com {num(criar.data.enviados)} contato(s). O Meta leva algumas horas para casar com as contas e mostrar o tamanho.</div>}
        </div>
      )}
      {atualizar.error && <Erro erro={atualizar.error} />}
      {atualizar.data && <div className="aviso ok">{num(atualizar.data.enviados)} contato(s) enviado(s) de novo.</div>}
      {semelhante.error && <Erro erro={semelhante.error} />}
      {semelhante.isSuccess && <div className="aviso ok">Público semelhante criado. Ele aparece na lista e fica pronto em algumas horas.</div>}
      {q.isLoading && <Carregando />}
      {q.error && <Erro erro={q.error} />}
      {q.data && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tabela">
            <thead><tr><th>Público</th><th>Tipo</th><th className="num">Tamanho aproximado</th><th>Atualizado</th>{editar && <th></th>}</tr></thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.nome}{p.situacao && p.situacao !== 'Normal' && <div className="muted" style={{ fontSize: 12 }}>{p.situacao}</div>}</td>
                  <td><span className={`etiqueta ${p.tipo === 'sistema' ? 'marrom' : 'neutra'}`}>{p.tipo === 'sistema' ? `do sistema · ${ORIGENS[p.origem!] ?? ''}` : p.tipo === 'semelhante' ? 'semelhante' : 'criado no Meta'}</span></td>
                  <td className="num">{p.tamanhoDe != null && p.tamanhoDe >= 0 ? `${num(p.tamanhoDe)} a ${num(p.tamanhoAte ?? p.tamanhoDe)}` : '—'}</td>
                  <td>{p.atualizadoEm ? dataHora(p.atualizadoEm) : '—'}</td>
                  {editar && (
                    <td className="num">
                      {p.tipo === 'sistema' && (
                        <span className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <button className="botao claro pequeno" disabled={atualizar.isPending} title="Manda de novo quem está no sistema hoje" onClick={() => atualizar.mutate(p.id)}>Atualizar</button>
                          <select aria-label="Tamanho do público semelhante" value={pct} onChange={(e) => setPct(Number(e.target.value))} style={{ width: 70 }}>{[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}%</option>)}</select>
                          <button className="botao claro pequeno" disabled={semelhante.isPending} title="Pessoas no Brasil parecidas com as deste público" onClick={() => semelhante.mutate(p.id)}>Criar semelhante</button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {q.data.length === 0 && <tr><td colSpan={editar ? 5 : 4} className="muted">Nenhum público nesta conta ainda.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ margin: 0 }}>Público semelhante: 1% é o mais parecido com a sua base; 10% alcança mais gente, menos parecida. Use os públicos ao montar o anúncio no Gerenciador.</p>
    </div>
  );
}

// ───── Leads de formulário ─────

function Leads({ e, editar, irConfigurar }: { e: Estado; editar: boolean; irConfigurar: () => void }) {
  const qc = useQueryClient();
  const pronto = !!(e.paginaId && e.leadsFunilId);
  const q = useQuery({ queryKey: ['meta', 'formularios'], queryFn: () => api<{ id: string; nome: string; ativo: boolean; leadsNoMeta: number; importados: number }[]>('/marketing/meta/leads/formularios'), enabled: !!e.paginaId });
  const importar = useMutation({ mutationFn: () => api<{ novos: number; repetidos: number; semTelefone: number }>('/marketing/meta/leads/importar', { corpo: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['meta', 'formularios'] }) });
  if (!pronto) return <Falta texto="Escolha a página e o funil do CRM que recebe os leads." editar={editar} ir={irConfigurar} />;
  return (
    <div className="coluna">
      <div className="cartao coluna">
        <p style={{ margin: 0 }}>Quem preenche um formulário de anúncio no Facebook ou no Instagram vira card no CRM, com a campanha e o anúncio de origem. {e.leadsAuto ? 'Está ligado para entrar sozinho, a cada 10 minutos.' : 'A entrada automática está desligada: os leads só entram quando alguém clica em "Trazer agora".'}</p>
        {editar && <div><button className="botao" disabled={importar.isPending} onClick={() => importar.mutate()}>{importar.isPending ? 'Buscando…' : 'Trazer agora'}</button></div>}
        {importar.error && <Erro erro={importar.error} />}
        {importar.data && <div className="aviso ok">{importar.data.novos} lead(s) novo(s) no CRM{importar.data.repetidos ? `; ${importar.data.repetidos} já tinham card aberto` : ''}{importar.data.semTelefone ? `; ${importar.data.semTelefone} sem telefone válido ficaram de fora` : ''}.</div>}
      </div>
      {q.isLoading && <Carregando />}
      {q.error && <Erro erro={q.error} />}
      {q.data && (
        <table className="tabela">
          <thead><tr><th>Formulário</th><th>Situação</th><th className="num">Leads no Meta</th><th className="num">Já trazidos</th></tr></thead>
          <tbody>
            {q.data.map((f) => <tr key={f.id}><td>{f.nome}</td><td><span className={`etiqueta ${f.ativo ? 'ok' : 'neutra'}`}>{f.ativo ? 'ativo' : 'arquivado'}</span></td><td className="num">{num(f.leadsNoMeta)}</td><td className="num">{num(f.importados)}</td></tr>)}
            {q.data.length === 0 && <tr><td colSpan={4} className="muted">Esta página ainda não tem formulário de anúncio.</td></tr>}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ margin: 0 }}>O Meta guarda os leads de formulário por 90 dias. Para ler os leads, o token precisa também da permissão "leads_retrieval".</p>
    </div>
  );
}

// ───── Página ─────

function Pagina({ e, irConfigurar }: { e: Estado; irConfigurar: () => void }) {
  const q = useQuery({ queryKey: ['meta', 'pagina'], queryFn: () => api<{ nome: string; curtidas: number; seguidores: number; link: string | null; publicacoes: { id: string; texto: string; em: string; link: string | null; curtidas: number; comentarios: number; compartilhamentos: number }[] }>('/marketing/meta/pagina'), enabled: !!e.paginaId });
  if (!e.paginaId) return <Falta texto="Escolha a página da Aritana." editar={pode('marketing', 'editar')} ir={irConfigurar} />;
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const p = q.data!;
  return (
    <div className="coluna">
      <div className="grade g4">
        <Indicador tipo="destaque" rotulo={p.nome} valor={num(p.seguidores)} detalhe="seguidores" />
        <Indicador rotulo="Curtidas na página" valor={num(p.curtidas)} />
        <Indicador rotulo="Publicações recentes" valor={num(p.publicacoes.length)} />
        <Indicador rotulo="Reações nas recentes" valor={num(p.publicacoes.reduce((s, x) => s + x.curtidas + x.comentarios + x.compartilhamentos, 0))} detalhe="curtidas, comentários e compartilhamentos" />
      </div>
      <table className="tabela">
        <thead><tr><th>Publicação</th><th>Quando</th><th className="num">Curtidas</th><th className="num">Comentários</th><th className="num">Compartilhamentos</th></tr></thead>
        <tbody>
          {p.publicacoes.map((x) => <tr key={x.id}><td>{x.link ? <a href={x.link} target="_blank" rel="noreferrer">{x.texto || '(sem texto)'}</a> : x.texto || '(sem texto)'}</td><td>{dataHora(x.em)}</td><td className="num">{num(x.curtidas)}</td><td className="num">{num(x.comentarios)}</td><td className="num">{num(x.compartilhamentos)}</td></tr>)}
          {p.publicacoes.length === 0 && <tr><td colSpan={5} className="muted">Sem publicações recentes.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ───── Configurar ─────

interface Opcoes { permissoes: string[]; contas: { id: string; nome: string; moeda: string; ativa: boolean }[]; paginas: { id: string; nome: string }[]; catalogos: { id: string; nome: string; negocio: string }[]; funis: { id: string; nome: string }[]; avisos: string[] }
const PERMISSOES: [string, string][] = [['ads_read', 'ver campanhas e resultados'], ['ads_management', 'pausar, orçamento e públicos'], ['business_management', 'listar contas e catálogos'], ['catalog_management', 'enviar produtos ao catálogo'], ['pages_show_list', 'listar as páginas'], ['pages_read_engagement', 'ver publicações da página'], ['pages_manage_ads', 'formulários de anúncio'], ['leads_retrieval', 'ler os leads de formulário']];

function Configurar({ e }: { e: Estado }) {
  const qc = useQueryClient();
  const op = useQuery({ queryKey: ['meta', 'opcoes'], queryFn: () => api<Opcoes>('/marketing/meta/opcoes'), staleTime: 60_000 });
  const [f, setF] = useState({ conta: e.conta ?? '', paginaId: e.paginaId ?? '', catalogoId: e.catalogoId ?? '', catalogoLink: e.catalogoLink ?? '', leadsFunilId: e.leadsFunilId ?? '', leadsAuto: e.leadsAuto });
  // Só uma opção disponível: já vem escolhida.
  useEffect(() => {
    if (!op.data) return;
    setF((x) => ({ ...x, conta: x.conta || (op.data.contas.length === 1 ? op.data.contas[0].id : ''), paginaId: x.paginaId || (op.data.paginas.length === 1 ? op.data.paginas[0].id : ''), catalogoId: x.catalogoId || (op.data.catalogos.length === 1 ? op.data.catalogos[0].id : '') }));
  }, [op.data]);
  const salvar = useMutation({
    mutationFn: () => api('/marketing/meta/config', { metodo: 'PUT', corpo: { conta: f.conta || null, paginaId: f.paginaId || null, catalogoId: f.catalogoId || null, catalogoLink: f.catalogoLink.trim() || null, leadsFunilId: f.leadsFunilId || null, leadsAuto: f.leadsAuto } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta'] }),
  });
  if (op.isLoading) return <Carregando />;
  if (op.error) return <Erro erro={op.error} />;
  const o = op.data!;
  // Valor salvo que o token não lista mais continua aparecendo, para não sumir da tela.
  const com = <T extends { id: string }>(lista: T[], atual: string, nome: (id: string) => T) => (atual && !lista.some((x) => x.id === atual) ? [...lista, nome(atual)] : lista);
  return (
    <div className="coluna">
      <div className="cartao form">
        <div className="secao" style={{ marginTop: 0 }}>O que o sistema usa no Meta</div>
        <Campo rotulo="Conta de anúncios" className="l2"><select value={f.conta} onChange={(x) => setF({ ...f, conta: x.target.value })}><option value="">Escolha…</option>{com(o.contas, f.conta, (id) => ({ id, nome: id, moeda: '', ativa: true })).map((c) => <option key={c.id} value={c.id}>{c.nome} ({c.id}){c.ativa ? '' : ' · desativada'}</option>)}</select></Campo>
        <Campo rotulo="Página" className="l2"><select value={f.paginaId} onChange={(x) => setF({ ...f, paginaId: x.target.value })}><option value="">Nenhuma</option>{com(o.paginas, f.paginaId, (id) => ({ id, nome: id })).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select></Campo>
        <Campo rotulo="Catálogo de produtos" className="l2"><select value={f.catalogoId} onChange={(x) => setF({ ...f, catalogoId: x.target.value })}><option value="">Nenhum</option>{com(o.catalogos, f.catalogoId, (id) => ({ id, nome: id, negocio: '' })).map((c) => <option key={c.id} value={c.id}>{c.nome}{c.negocio ? ` · ${c.negocio}` : ''}</option>)}</select></Campo>
        <Campo rotulo="Para onde o produto leva quem clica" className="l2" ajuda="O site ou o link do catálogo da Aritana. Começa com https://" erro={salvar.error ? (salvar.error as any)?.dados?.campos?.catalogoLink : undefined}><input value={f.catalogoLink} placeholder="https://" onChange={(x) => setF({ ...f, catalogoLink: x.target.value })} /></Campo>
        <div className="secao l4">Leads de formulário</div>
        <Campo rotulo="Funil do CRM que recebe os leads" className="l2"><select value={f.leadsFunilId} onChange={(x) => setF({ ...f, leadsFunilId: x.target.value })}><option value="">Nenhum</option>{o.funis.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></Campo>
        <div className="campo l2"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={f.leadsAuto} onChange={(x) => setF({ ...f, leadsAuto: x.target.checked })} /> Trazer os leads sozinho, a cada 10 minutos</label></div>
        {salvar.error && <div className="l4"><Erro erro={salvar.error} /></div>}
        {salvar.isSuccess && <div className="aviso ok l4">Salvo.</div>}
        <div className="l4"><button className="botao" disabled={salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button></div>
      </div>
      {o.avisos.length > 0 && <div className="aviso alerta">O Meta não deixou listar tudo:<ul>{o.avisos.map((a) => <li key={a}>{a}</li>)}</ul></div>}
      {o.contas.length + o.paginas.length + o.catalogos.length === 0 && <div className="aviso alerta">O token não enxerga nenhuma conta, página ou catálogo. No Gerenciador de Negócios, atribua esses itens ao usuário do sistema e gere o token de novo.</div>}
      <div className="cartao">
        <b>Permissões do token</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          {PERMISSOES.map(([p, para]) => <li key={p}><span className={`etiqueta ${o.permissoes.includes(p) ? 'ok' : 'alerta'}`}>{o.permissoes.includes(p) ? 'tem' : 'falta'}</span> <code>{p}</code>: {para}</li>)}
        </ul>
      </div>
    </div>
  );
}
