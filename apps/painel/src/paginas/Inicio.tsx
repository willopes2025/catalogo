import { Tarefas } from './Mesa';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, lerSessao, pode } from '../api';
import { reais, dataHora, pct } from '../formato';
import { Carregando, Erro } from '../componentes/ui';
import { usarImplantacao } from './Implantacao';
import { BarraMeta, type MetasResp } from './indicadores/Metas';
import './inicio.css';
import { comVisao, usarVisao } from '../visao';

interface Atividade { id: string; criadoEm: string; acao: string; entidade: string; entidadeId: string | null; dados: Record<string, any> | null; usuarioId: string | null; usuario: string | null }
interface Pendencia { chave: string; rotulo: string; quantidade: number; link: string; tom: 'erro' | 'alerta' | 'info' }
interface Pessoa { id: string; nome: string; grupo: string; online: boolean; ultimaAtividadeEm: string | null; sessaoInicioEm: string | null; ultimoAcesso: string | null }
interface Vendas {
  rede: { hoje: number; acertosHoje: number };
  lojas: { hoje: number; mes: number };
  eventos: { hoje: number; mes: number };
  outras: { hoje: number; mes: number };
  porLocal: { id: string; nome: string; tipo: string; hoje: number; mes: number; qtdMes: number }[];
  consultoras: { id: string; nome: string; vendido: number; acertos: number }[];
  vendedoras: { id: string; nome: string; vendido: number; vendas: number }[];
  serie: { dia: string; rede: number; lojas: number; eventos: number }[];
}
interface Inicio {
  data: string;
  gestao: boolean;
  maletas: { abertas: number; atrasadas: number; vencendo: number; acertosHoje: number; pecasNaRua: number; valorNaRua: number; prebaixasPendentes: number };
  rede: { ativas: number; triagem: number; novasMes: number; bloqueadas: number; semMaleta: number };
  financeiro: { receberHoje: number; vencido: number; vencidos: number; aReceber: number };
  mes: { acertos: number; vendido: number; recebido: number; percentualMedio: number };
  consignado: Consignado | null;
  minhaCarteira: (Consignado & { consultoras: number }) | null;
  vendas: Vendas | null;
  pendencias: Pendencia[];
  tarefas: { id: string; titulo: string; venceEm: string; leadId: string; lead: string; funil: string }[];
  equipe: Pessoa[] | null;
  atividades: Atividade[];
  porPessoa: { id: string; nome: string; hoje: number; ultima: string }[] | null;
}

const COR = { rede: '#896f4b', lojas: '#5c4a3d', eventos: '#c49a5a', outras: '#b9ad9c' };

const ACOES: Record<string, string> = {
  criar: 'criou', editar: 'editou', excluir: 'apagou', acerto: 'fechou o acerto da', acerto_parcial: 'fez acerto parcial da', prebaixa: 'registrou pré-baixa da',
  cancelar: 'cancelou', entrada: 'deu entrada no', ajuste: 'ajustou o', transferencia: 'transferiu', baixar: 'baixou', incluir_itens: 'incluiu peças na', retirar_itens: 'retirou peças da',
  venda: 'lançou uma', devolucao: 'registrou devolução na', envio: 'enviou a', importar: 'importou', abrir_caixa: 'abriu o', fechar_caixa: 'fechou o', sangria: 'fez sangria no', suprimento: 'fez suprimento no',
  emitir_nota: 'emitiu', estornar: 'estornou', pagar: 'deu baixa no', receber: 'recebeu o', mudar_nivel: 'mudou o nível de', gerar_link_portal: 'gerou link do portal para', decidir: 'decidiu a',
  enviar_assistencia: 'enviou para assistência a', fechar_comissoes: 'fechou as', reabrir_comissoes: 'reabriu as', disparo: 'iniciou um', resgatar: 'aprovou um', aprovar: 'aprovou', trocar_senha: 'trocou a senha', nova_senha: 'gerou nova senha para',
  candidatura: 'recebeu', pedido_pecas: 'recebeu pedido de peças de', entrar_portal: 'entrou no portal', mover: 'moveu o',
};
const ENTIDADES: Record<string, string> = {
  maleta: 'maleta', pessoa: 'cadastro', produto: 'produto', estoque: 'estoque', titulo: 'título', regras_consignado: 'regras do consignado', regras_venda: 'regras de venda', venda: 'venda', caixa: 'caixa',
  nota: 'nota fiscal', usuario: 'usuário', grupo: 'grupo de acesso', nivel: 'nível', ordem_servico: 'garantia', importacao: 'planilha', comissoes: 'comissões', crm_lead: 'card do CRM', crm_disparo: 'disparo em massa',
  crm_gatilho: 'gatilho', crm_canal: 'número de WhatsApp', crm_ramal: 'ramal', campanha: 'campanha', formulario: 'formulário', premio: 'prêmio', resgate: 'resgate de pontos', empresa: 'empresa', candidatura: 'candidatura',
  modelo_documento: 'modelo de documento', documento: 'documento', lote_banho: 'lote de banho', servico: 'serviço', regra_fiscal: 'regra fiscal', avisos: 'avisos automáticos', marketing: 'marketing', comissao_vendedora: 'comissão de vendedora',
};
const LINKS: Record<string, (id: string) => string> = { maleta: (id) => `/maletas/${id}`, venda: (id) => `/vendas/${id}`, produto: (id) => `/produtos/${id}`, crm_lead: (id) => `/crm/lead/${id}` };

/** Número que conta até o valor quando aparece (e anima a diferença quando atualiza). */
function useContagem(alvo: number, duracao = 900) {
  const [v, setV] = useState(0);
  const de = useRef(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setV(alvo);
      de.current = alvo;
      return;
    }
    const inicio = performance.now();
    const origem = de.current;
    let quadro = 0;
    const passo = (t: number) => {
      const p = Math.min(1, (t - inicio) / duracao);
      const e = 1 - Math.pow(1 - p, 3);
      setV(Math.round(origem + (alvo - origem) * e));
      if (p < 1) quadro = requestAnimationFrame(passo);
      else de.current = alvo;
    };
    quadro = requestAnimationFrame(passo);
    return () => {
      cancelAnimationFrame(quadro);
      de.current = alvo;
    };
  }, [alvo, duracao]);
  return v;
}
function Conta({ valor, dinheiro }: { valor: number; dinheiro?: boolean }) {
  const v = useContagem(Number(valor) || 0);
  return <>{dinheiro ? reais(v) : v.toLocaleString('pt-BR')}</>;
}

interface Consignado { ativos: number; renovacoes: number; churn: number; churnPct: number | null }

/** Pedidos ativos, renovações e churn do mês (meta de equipe em Relatórios › Metas; por pessoa no Scorecard). */
function LinhaConsignado({ c, titulo, i }: { c: Consignado; titulo: string; i: number }) {
  return (
    <>
      <h2 className="ini-titulo-secao" style={{ margin: '4px 0 8px', fontSize: 15 }}>{titulo}</h2>
      <div className="ini-grade k4">
        <Kpi i={i} rotulo="Pedidos ativos" valor={<Conta valor={c.ativos} />} detalhe="com as consultoras agora" />
        <Kpi i={i + 1} rotulo="Renovações no mês" valor={<Conta valor={c.renovacoes} />} detalhe="novo pedido de quem já teve" />
        <Kpi i={i + 2} tipo={c.churn ? 'atencao' : undefined} rotulo="Churn no mês" valor={<Conta valor={c.churn} />} detalhe="baixaram e não pegaram outro pedido" cor={c.churn ? 'var(--erro)' : undefined} />
        <Kpi i={i + 3} rotulo="Churn (%)" valor={c.churnPct === null ? '—' : `${String(c.churnPct).replace('.', ',')}%`} detalhe="das que baixaram no mês" />
      </div>
    </>
  );
}

function Kpi({ i, rotulo, valor, detalhe, tipo, cor }: { i: number; rotulo: string; valor: ReactNode; detalhe?: ReactNode; tipo?: 'escuro' | 'atencao'; cor?: string }) {
  return (
    <div className={`cartao ini-kpi ini-anim ${tipo ?? ''}`} style={{ '--i': i, '--cor': cor } as CSSProperties}>
      <div className="rotulo">{rotulo}</div>
      <div className="valor">{valor}</div>
      {detalhe && <div className="detalhe">{detalhe}</div>}
    </div>
  );
}

function useAgora(segundos = 30) {
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), segundos * 1000);
    return () => clearInterval(t);
  }, [segundos]);
  return agora;
}
function duracao(ms: number) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}
function haQuanto(iso: string | null, agora: number) {
  if (!iso) return 'nunca entrou';
  const min = Math.floor((agora - new Date(iso).getTime()) / 60000);
  if (min < 60) return `visto há ${Math.max(1, min)} min`;
  if (min < 24 * 60) return `visto há ${Math.floor(min / 60)} h`;
  const d = Math.floor(min / 1440);
  return d === 1 ? 'visto ontem' : `visto há ${d} dias`;
}
const iniciais = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
const saudacao = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
};

export function Inicio() {
  const visao = usarVisao();
  const q = useQuery({ queryKey: ['inicio', visao], queryFn: () => api<Inicio>(comVisao('/painel/inicio', visao)), refetchInterval: 60_000 });
  if (q.isLoading) return <Carregando />;
  if (q.error) return <Erro erro={q.error} />;
  const d = q.data!;
  const nome = lerSessao()?.usuario.nome.split(' ')[0] ?? '';
  const dataLonga = new Date(d.data + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const verMaletas = pode('maletas', 'ver');
  let i = 0;
  return (
    <>
      <div className="ini-saudacao ini-anim" style={{ '--i': i++ } as CSSProperties}>
        <div>
          <div className="eb">Início · {dataLonga}</div>
          <h1><span>{saudacao()}{nome ? `, ${nome}` : ''}</span></h1>
        </div>
        {pode('maletas', 'criar') && <Link className="botao" to="/maletas/nova">Nova maleta</Link>}
      </div>
      <AvisoImplantacao />

      {verMaletas && (
        <div className="ini-grade k4">
          <Kpi i={i++} tipo="escuro" rotulo="Valor em maletas na rua" valor={<Conta valor={d.maletas.valorNaRua} dinheiro />} detalhe={`${d.maletas.pecasNaRua.toLocaleString('pt-BR')} peças em ${d.maletas.abertas} maletas`} cor="var(--areia)" />
          <Kpi i={i++} tipo={d.maletas.atrasadas ? 'atencao' : undefined} rotulo="Maletas atrasadas" valor={<Conta valor={d.maletas.atrasadas} />} detalhe={<Link to="/maletas?aba=abertas">ver lista</Link>} cor={d.maletas.atrasadas ? 'var(--erro)' : undefined} />
          <Kpi i={i++} rotulo="Vencem nos próximos 7 dias" valor={<Conta valor={d.maletas.vencendo} />} detalhe={`${d.maletas.acertosHoje} com acerto hoje`} />
          <Kpi i={i++} rotulo="Representantes ativas" valor={<Conta valor={d.rede.ativas} />} detalhe={`${d.rede.novasMes} novas no mês · ${d.rede.semMaleta} sem maleta`} cor="var(--ok)" />
        </div>
      )}

      {pode('relatorios', 'ver') && <MetasDoMes i={i++} />}

      <div className="ini-grade dois">
        {d.vendas ? <PainelVendas v={d.vendas} mes={d.mes} i={i++} /> : <div />}
        <div className="cartao ini-cartao ini-anim" style={{ '--i': i++ } as CSSProperties}>
          <h2>Tarefas e pendências <small>{d.pendencias.length ? `${d.pendencias.reduce((s, p) => s + p.quantidade, 0)} itens` : ''}</small></h2>
          {d.pendencias.length === 0 ? (
            <div className="ini-tudo-ok"><b>✓</b>Nada esperando por você agora.</div>
          ) : (
            <div className="ini-pend">
              {d.pendencias.map((p, k) => (
                <Link key={p.chave} to={p.link} className={p.tom} style={{ '--d': k } as CSSProperties}>
                  <span className="n"><Conta valor={p.quantidade} /></span>
                  <span>{p.rotulo}</span>
                  <span className="seta">›</span>
                </Link>
              ))}
            </div>
          )}
          {d.tarefas.length > 0 && <MinhasTarefas tarefas={d.tarefas} />}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--linha)' }}><Tarefas resumida /></div>
        </div>
      </div>

      {d.vendas && (d.vendas.consultoras.length > 0 || d.vendas.porLocal.length > 0 || d.vendas.vendedoras.length > 0) && (
        <div className="ini-grade meio">
          <Ranking i={i++} titulo="Consultoras que mais venderam no mês" sub="pelos acertos" itens={d.vendas.consultoras.map((c) => ({ id: c.id, nome: c.nome, valor: c.vendido, extra: `${c.acertos} acerto(s)` }))} link={(id) => `/rede/${id}`} vazio="Nenhum acerto no mês ainda." />
          <Ranking
            i={i++}
            titulo="Lojas e eventos no mês"
            sub="vendas de balcão"
            itens={d.vendas.porLocal.map((l) => ({ id: l.id, nome: `${l.nome}${l.tipo === 'evento' ? ' (evento)' : ''}`, valor: l.mes, extra: `hoje ${reais(l.hoje)} · ${l.qtdMes} venda(s)` }))}
            vazio="Nenhuma venda de loja ou evento no mês."
            rodape={d.vendas.vendedoras.length > 0 && (
              <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
                Vendedoras: {d.vendas.vendedoras.map((v) => `${v.nome.split(' ')[0]} ${reais(v.vendido)}`).join(' · ')}
              </div>
            )}
          />
        </div>
      )}

      {d.consignado && <LinhaConsignado c={d.consignado} titulo="Consignado do mês (equipe)" i={i++} />}
      {d.minhaCarteira && <LinhaConsignado c={d.minhaCarteira} titulo={`Minha carteira (${d.minhaCarteira.consultoras} consultoras)`} i={i++} />}
      <div className="ini-grade dois">
        <LinhaDoTempo inicial={d.atividades} porPessoa={d.porPessoa} gestao={d.gestao} i={i++} />
        {d.equipe ? <Equipe pessoas={d.equipe} i={i++} /> : <ResumoFinanceiro d={d} i={i++} />}
      </div>
      {d.equipe && pode('financeiro', 'ver') && (
        <div className="ini-grade k4">
          <Kpi i={i++} rotulo="A receber hoje" valor={<Conta valor={d.financeiro.receberHoje} dinheiro />} detalhe={`${reais(d.financeiro.aReceber)} em aberto no total`} />
          <Kpi i={i++} tipo={d.financeiro.vencido ? 'atencao' : undefined} rotulo="Vencido" valor={<Conta valor={d.financeiro.vencido} dinheiro />} detalhe={`${d.financeiro.vencidos} título(s)`} cor={d.financeiro.vencido ? 'var(--erro)' : undefined} />
          <Kpi i={i++} rotulo="Acertos no mês" valor={<Conta valor={d.mes.acertos} />} detalhe={`${pct(d.mes.percentualMedio)} vendido em média`} />
          <Kpi i={i++} rotulo="Devido à matriz nos acertos" valor={<Conta valor={d.mes.recebido} dinheiro />} detalhe="soma do mês" />
        </div>
      )}
    </>
  );
}

function PainelVendas({ v, mes, i }: { v: Vendas; mes: Inicio['mes']; i: number }) {
  const max = Math.max(1, ...v.serie.map((s) => s.rede + s.lojas + s.eventos));
  const totalHoje = v.rede.hoje + v.lojas.hoje + v.eventos.hoje + v.outras.hoje;
  const dia = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i } as CSSProperties}>
      <h2>Vendas <small>hoje: <b style={{ color: 'var(--tinta)' }}><Conta valor={totalHoje} dinheiro /></b></small></h2>
      <div className="ini-split">
        <div style={{ '--cor': COR.rede } as CSSProperties}><div className="r">Consultoras (acertos)</div><div className="v"><Conta valor={v.rede.hoje} dinheiro /></div><div className="m">mês {reais(mes.vendido)}</div></div>
        <div style={{ '--cor': COR.lojas } as CSSProperties}><div className="r">Lojas</div><div className="v"><Conta valor={v.lojas.hoje} dinheiro /></div><div className="m">mês {reais(v.lojas.mes)}</div></div>
        <div style={{ '--cor': COR.eventos } as CSSProperties}><div className="r">Eventos</div><div className="v"><Conta valor={v.eventos.hoje} dinheiro /></div><div className="m">mês {reais(v.eventos.mes)}</div></div>
        <div style={{ '--cor': COR.outras } as CSSProperties}><div className="r">Matriz / avulsas</div><div className="v"><Conta valor={v.outras.hoje} dinheiro /></div><div className="m">mês {reais(v.outras.mes)}</div></div>
      </div>
      <div className="ini-legenda">
        <span><i style={{ background: COR.rede }} />Consultoras</span>
        <span><i style={{ background: COR.lojas }} />Lojas e matriz</span>
        <span><i style={{ background: COR.eventos }} />Eventos</span>
        <span style={{ marginLeft: 'auto' }}>últimos 30 dias</span>
      </div>
      <div className="ini-barras" role="img" aria-label="Vendas por dia nos últimos 30 dias">
        {v.serie.map((s, k) => (
          <div key={s.dia} className="col" style={{ '--d': k } as CSSProperties}>
            <span style={{ height: `${(s.rede / max) * 100}%`, background: COR.rede }} />
            <span style={{ height: `${(s.lojas / max) * 100}%`, background: COR.lojas }} />
            <span style={{ height: `${(s.eventos / max) * 100}%`, background: COR.eventos }} />
            <div className="dica">
              <b>{dia(s.dia)}</b> · {reais(s.rede + s.lojas + s.eventos)}
              <br />Consultoras {reais(s.rede)} · Lojas {reais(s.lojas)} · Eventos {reais(s.eventos)}
            </div>
          </div>
        ))}
      </div>
      <div className="ini-eixo"><span>{v.serie[0] && dia(v.serie[0].dia)}</span><span>{v.serie[14] && dia(v.serie[14].dia)}</span><span>hoje</span></div>
    </div>
  );
}

function Ranking({ i, titulo, sub, itens, link, vazio, rodape }: { i: number; titulo: string; sub: string; itens: { id: string; nome: string; valor: number; extra: string }[]; link?: (id: string) => string; vazio: string; rodape?: ReactNode }) {
  const max = Math.max(1, ...itens.map((x) => Number(x.valor)));
  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i } as CSSProperties}>
      <h2>{titulo} <small>{sub}</small></h2>
      {itens.length === 0 ? <p className="muted">{vazio}</p> : (
        <div className="ini-rank">
          {itens.map((x, k) => (
            <div key={x.id}>
              <div className="lin">
                <span className="pos">{k + 1}</span>
                <span className="nome" title={x.extra}>{link ? <Link to={link(x.id)}>{x.nome}</Link> : x.nome} <span className="muted" style={{ fontSize: 12 }}>· {x.extra}</span></span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{reais(Number(x.valor))}</b>
              </div>
              <div className="lin"><div className="trilho"><span style={{ width: `${(Number(x.valor) / max) * 100}%`, '--d': k } as CSSProperties} /></div></div>
            </div>
          ))}
        </div>
      )}
      {rodape}
    </div>
  );
}

function MinhasTarefas({ tarefas }: { tarefas: Inicio['tarefas'] }) {
  const agora = useAgora(60);
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 6 }}>Minhas próximas tarefas</h3>
      {tarefas.map((t) => {
        const vence = new Date(t.venceEm).getTime();
        return (
          <div key={t.id} className={`ini-tarefa ${vence < agora ? 'atrasada' : ''}`}>
            <span>☐</span>
            <span style={{ minWidth: 0 }}>
              {t.titulo} · <Link to={`/crm/lead/${t.leadId}`}>{t.lead}</Link>
            </span>
            <span className="q">{vence < agora ? 'atrasada · ' : ''}{dataHora(t.venceEm)}</span>
          </div>
        );
      })}
    </div>
  );
}

function descrever(a: Atividade) {
  const acao = ACOES[a.acao] ?? a.acao.replace(/_/g, ' ');
  const ent = ENTIDADES[a.entidade] ?? a.entidade.replace(/_/g, ' ');
  const sem = ['trocar_senha', 'entrar_portal'].includes(a.acao);
  const x = a.dados ?? {};
  const extra =
    a.acao === 'venda' && x.total != null ? reais(Number(x.total)) :
    a.acao === 'importar' && x.criados != null ? `${x.criados} novos, ${x.atualizados ?? 0} atualizados` :
    x.motivo ? `motivo: ${x.motivo}` :
    x.nome ? String(x.nome) :
    x.numero ? `nº ${x.numero}` : '';
  return { texto: sem ? acao : `${acao} ${ent}`, extra };
}

function LinhaDoTempo({ inicial, porPessoa, gestao, i }: { inicial: Atividade[]; porPessoa: Inicio['porPessoa']; gestao: boolean; i: number }) {
  const [quem, setQuem] = useState<string | null>(null);
  const filtrada = useQuery({ queryKey: ['inicio', 'atividades', quem], queryFn: () => api<Atividade[]>(`/painel/atividades?usuarioId=${quem}`), enabled: !!quem });
  const [mais, setMais] = useState<Atividade[]>([]);
  const [carregando, setCarregando] = useState(false);
  useEffect(() => setMais([]), [quem]);
  const lista = [...(quem ? filtrada.data ?? [] : inicial), ...mais];
  const navegar = useNavigate();

  async function verMais() {
    const ultima = lista[lista.length - 1];
    if (!ultima) return;
    setCarregando(true);
    try {
      const r = await api<Atividade[]>(`/painel/atividades?antes=${encodeURIComponent(ultima.criadoEm)}${quem ? `&usuarioId=${quem}` : ''}`);
      setMais((m) => [...m, ...r]);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i } as CSSProperties}>
      <h2>{gestao ? 'Últimas alterações da equipe' : 'Minhas últimas alterações'} {gestao && <Link to="/auditoria" style={{ fontSize: 13, fontWeight: 400 }}>auditoria completa</Link>}</h2>
      {gestao && porPessoa && porPessoa.length > 0 && (
        <div className="ini-filtro">
          <button className={!quem ? 'ativo' : ''} onClick={() => setQuem(null)}>Todos</button>
          {porPessoa.map((p) => (
            <button key={p.id} className={quem === p.id ? 'ativo' : ''} onClick={() => setQuem(p.id)} title={`Última às ${dataHora(p.ultima)}`}>
              {p.nome.split(' ')[0]}<span className="c">{p.hoje} hoje</span>
            </button>
          ))}
        </div>
      )}
      {quem && filtrada.isLoading ? <Carregando /> : lista.length === 0 ? <p className="muted">Nenhuma alteração ainda.</p> : (
        <div className="ini-tempo" key={quem ?? 'todos'}>
          {lista.map((a, k) => {
            const { texto, extra } = descrever(a);
            const link = a.entidadeId && LINKS[a.entidade]?.(a.entidadeId);
            return (
              <div key={a.id} className={`ini-ev ${a.acao === 'venda' || a.acao === 'acerto' ? 'venda' : a.acao === 'cancelar' || a.acao === 'excluir' ? 'cancel' : ''}`} style={{ '--d': Math.min(k, 20) } as CSSProperties}>
                <div>
                  <b>{a.usuario ?? (a.acao === 'candidatura' ? 'Formulário do site' : a.acao === 'pedido_pecas' || a.acao === 'entrar_portal' || a.acao === 'prebaixa' ? 'Portal da representante' : 'Sistema')}</b> {link ? <a href={link} onClick={(e) => { e.preventDefault(); navegar(link); }}>{texto}</a> : texto}
                  {extra && <span className="extra"> · {extra}</span>}
                </div>
                <div className="q">{dataHora(a.criadoEm)}</div>
              </div>
            );
          })}
        </div>
      )}
      {lista.length >= 20 && (
        <button className="botao claro pequeno" style={{ marginTop: 8 }} disabled={carregando} onClick={verMais}>{carregando ? 'Carregando…' : 'Ver mais antigas'}</button>
      )}
    </div>
  );
}

function Equipe({ pessoas, i }: { pessoas: Pessoa[]; i: number }) {
  const agora = useAgora(30);
  const online = pessoas.filter((p) => p.online);
  const fora = pessoas.filter((p) => !p.online);
  const [todos, setTodos] = useState(false);
  const mostrar = todos ? fora : fora.slice(0, Math.max(0, 8 - online.length));
  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i } as CSSProperties}>
      <h2>Quem está no sistema <small><b style={{ color: 'var(--ok)' }}>{online.length}</b> conectado(s) agora</small></h2>
      <div className="ini-equipe">
        {online.map((p, k) => (
          <div key={p.id} className="ini-pessoa" style={{ '--d': k } as CSSProperties}>
            <span className="ini-av">{iniciais(p.nome)}<span className="st on" /></span>
            <div style={{ minWidth: 0 }}><div className="nm">{p.nome}</div><div className="sub">{p.grupo}</div></div>
            <div className="tempo"><b>{p.sessaoInicioEm ? duracao(agora - new Date(p.sessaoInicioEm).getTime()) : 'agora'}</b>{p.sessaoInicioEm ? `desde ${new Date(p.sessaoInicioEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'conectado'}</div>
          </div>
        ))}
        {online.length > 0 && mostrar.length > 0 && <div style={{ borderTop: '1px solid var(--linha)', margin: '6px 0' }} />}
        {mostrar.map((p, k) => (
          <div key={p.id} className="ini-pessoa" style={{ '--d': online.length + k } as CSSProperties}>
            <span className="ini-av" style={{ opacity: 0.7 }}>{iniciais(p.nome)}<span className="st" /></span>
            <div style={{ minWidth: 0 }}><div className="nm" style={{ fontWeight: 500 }}>{p.nome}</div><div className="sub">{p.grupo}</div></div>
            <div className="tempo">{haQuanto(p.ultimaAtividadeEm ?? p.ultimoAcesso, agora)}</div>
          </div>
        ))}
      </div>
      {fora.length > mostrar.length && <button className="botao claro pequeno" style={{ marginTop: 8 }} onClick={() => setTodos(true)}>Ver todos ({fora.length} fora)</button>}
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Conectado = painel aberto nos últimos 5 minutos. O tempo conta desde a entrada; 30 minutos sem uso começam uma sessão nova.</p>
    </div>
  );
}

function ResumoFinanceiro({ d, i }: { d: Inicio; i: number }) {
  if (!pode('financeiro', 'ver') && !pode('maletas', 'ver')) return <div />;
  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i } as CSSProperties}>
      <h2>Resumo do mês</h2>
      <div className="resumo-linha"><span>Acertos</span><b>{d.mes.acertos}</b></div>
      <div className="resumo-linha"><span>Vendido pela rede</span><b>{reais(d.mes.vendido)}</b></div>
      <div className="resumo-linha"><span>% vendido médio</span><b>{pct(d.mes.percentualMedio)}</b></div>
      {pode('financeiro', 'ver') && <div className="resumo-linha"><span>Títulos vencidos</span><b style={{ color: d.financeiro.vencido ? 'var(--erro)' : undefined }}>{reais(d.financeiro.vencido)}</b></div>}
    </div>
  );
}

/** Enquanto houver pendência de implantação, lembra a gerência no Início. */
function AvisoImplantacao() {
  const q = usarImplantacao();
  if (!q.data || q.data.feitos >= q.data.total) return null;
  const faltam = q.data.itens.filter((i) => i.status === 'pendente').length;
  return (
    <div className="aviso alerta flex entre ini-anim" style={{ marginBottom: 16, flexWrap: 'wrap', '--i': 1 } as CSSProperties}>
      <span><b>Implantação: {q.data.feitos} de {q.data.total} itens prontos.</b> Faltam {faltam} item(ns), como acessos das integrações, CNPJs e confirmações do contador e do jurídico.</span>
      <Link className="botao claro pequeno" to="/configuracoes?aba=implantacao">Ver o que falta</Link>
    </div>
  );
}

/** As metas do mês com o ritmo de hoje (só aparece quando há metas definidas). */
function MetasDoMes({ i }: { i: number }) {
  const q = useQuery({ queryKey: ['metas', 'inicio'], queryFn: () => api<MetasResp>('/metas'), refetchInterval: 300_000 });
  const linhas = q.data?.linhas ?? [];
  if (!linhas.length) return null;
  return (
    <div className="cartao ini-cartao ini-anim" style={{ '--i': i, marginBottom: 14 } as CSSProperties}>
      <h2>Metas do mês <small><Link to="/relatorios?aba=metas">{q.data!.restantes ? `faltam ${q.data!.restantes} dia(s)` : 'mês encerrado'} · ver tudo</Link></small></h2>
      <div className="ind-grade k2" style={{ marginBottom: 0 }}>{linhas.slice(0, 4).map((l, k) => <BarraMeta key={l.id} l={l} i={k} />)}</div>
    </div>
  );
}
