import { mudarVisao, usarVisao } from '../visao';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { MODULOS } from '@aritana/regras';
import { useQuery } from '@tanstack/react-query';
import { api, atualizarUsuario, lerSessao, pode, salvarSessao } from '../api';
import { Softphone } from './Softphone';
import { AvisosDaMesa, usarAvisosDaMesa } from '../paginas/Mesa';

/** Rotas já construídas nesta etapa; as demais abrem a página "em construção". */
const ROTAS: Record<string, string> = { inicio: '/', assistente: '/assistente', rede: '/rede', cadastros: '/cadastros', produtos: '/produtos', estoque: '/estoque', maletas: '/maletas', vendas: '/vendas', lojas: '/lojas', financeiro: '/financeiro', cobranca: '/cobranca', fiscal: '/fiscal', relatorios: '/relatorios', configuracoes: '/configuracoes', suporte: '/suporte', garantia: '/garantia', comissoes: '/comissoes', crm: '/crm', pontos: '/pontos', formularios: '/formularios', marketing: '/marketing', rh: '/rh', scorecard: '/scorecard' };

/** Menu separado por assunto. Módulo novo que não estiver aqui aparece em "Outros". */
const GRUPOS: { titulo: string; chaves: string[] }[] = [
  { titulo: '', chaves: ['inicio', 'mesa', 'assistente'] },
  { titulo: 'Atendimento', chaves: ['crm', 'agenda', 'marketing', 'formularios'] },
  { titulo: 'Revendedoras', chaves: ['rede', 'indicacoes', 'maletas', 'pontos', 'comissoes'] },
  { titulo: 'Vendas', chaves: ['vendas', 'lojas', 'garantia'] },
  { titulo: 'Produtos', chaves: ['produtos', 'estoque'] },
  { titulo: 'Financeiro', chaves: ['financeiro', 'cobranca', 'fiscal', 'relatorios'] },
  { titulo: 'Equipe', chaves: ['meu-ponto', 'rh', 'scorecard'] },
  { titulo: 'Sistema', chaves: ['cadastros', 'configuracoes', 'suporte'] },
];
const semAcento = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function Layout() {
  const [busca, setBusca] = useState('');
  const local = useLocation();
  // Grupos que a pessoa fechou (fica guardado neste navegador).
  const [fechados, setFechados] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('aritana.menu.fechados') ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const alternar = (titulo: string) =>
    setFechados((f) => {
      const n = f.includes(titulo) ? f.filter((t) => t !== titulo) : [...f, titulo];
      try {
        localStorage.setItem('aritana.menu.fechados', JSON.stringify(n));
      } catch {
        /* sem armazenamento: vale até recarregar */
      }
      return n;
    });
  // Menu lateral recolhido (mais espaço para a tela); fica guardado neste navegador.
  const [recolhido, setRecolhido] = useState(() => {
    try {
      return localStorage.getItem('aritana.menu.recolhido') === '1';
    } catch {
      return false;
    }
  });
  const recolher = (v: boolean) => {
    setRecolhido(v);
    try {
      localStorage.setItem('aritana.menu.recolhido', v ? '1' : '0');
    } catch {
      /* sem armazenamento: vale até recarregar */
    }
  };
  const navegar = useNavigate();
  // Relê as permissões do servidor (a gerência pode ter mudado o grupo desde o login).
  useQuery({ queryKey: ['eu'], queryFn: async () => { const u = await api<any>('/auth/eu'); atualizarUsuario({ id: u.id, nome: u.nome, email: u.email, grupo: u.grupo, permissoes: u.permissoes }); return u; }, staleTime: 60_000 });
  const sessao = lerSessao();
  // Fila do CRM e conversas não lidas no menu.
  const crm = useQuery({ queryKey: ['crm', 'contadores'], queryFn: () => api<{ fila: number; naoLidas: number }>('/crm/contadores'), refetchInterval: 15_000, enabled: pode('crm', 'ver') });
  const avisoCrm = (crm.data?.fila ?? 0) + (crm.data?.naoLidas ?? 0);
  // Quem é funcionário (tem cadastro no RH) vê "Meu ponto", mesmo sem nenhum outro módulo.
  const ponto = useQuery({ queryKey: ['ponto', 'eu'], queryFn: () => api<{ eFuncionario: boolean; espelhosParaConfirmar?: string[]; documentosNovos?: number }>('/ponto/eu'), staleTime: 60_000 });
  const avisoPonto = (ponto.data?.espelhosParaConfirmar?.length ?? 0) + (ponto.data?.documentosNovos ?? 0);
  // O que esta pessoa pode ver, separado por assunto e filtrado pela busca.
  const visiveis: { chave: string; nome: string; versao: number }[] = MODULOS.filter((m) => m.chave === 'suporte' || pode(m.chave, 'ver')).map((m) => ({ chave: m.chave, nome: m.nome, versao: m.versao as number }));
  // Minha mesa (conversa interna, tarefas e painel do setor) é de todo mundo que usa o painel.
  const mesa = usarAvisosDaMesa();
  if (pode('inicio', 'ver')) visiveis.push({ chave: 'mesa', nome: 'Minha mesa', versao: 1 });
  if (pode('rede', 'ver')) visiveis.push({ chave: 'indicacoes', nome: 'Indique e ganhe', versao: 1 });
  if (ponto.data?.eFuncionario) visiveis.push({ chave: 'meu-ponto', nome: 'Meu ponto', versao: 1 });
  const agrupadas = new Set(GRUPOS.flatMap((g) => g.chaves));
  const termo = semAcento(busca.trim());
  const grupos = [...GRUPOS, { titulo: 'Outros', chaves: visiveis.filter((m) => !agrupadas.has(m.chave)).map((m) => m.chave) }]
    .map((g) => ({
      titulo: g.titulo,
      // Buscar pelo título do grupo mostra o grupo inteiro.
      itens: g.chaves.map((c) => visiveis.find((m) => m.chave === c)).filter((m): m is (typeof visiveis)[number] => !!m && (!termo || semAcento(m.nome).includes(termo) || semAcento(g.titulo).includes(termo))),
    }))
    .filter((g) => g.itens.length > 0)
    .map((g) => {
      const rota = (c: string) => (c === 'meu-ponto' ? '/meu-ponto' : (ROTAS[c] ?? `/${c}`));
      const aqui = g.itens.some((m) => rota(m.chave) !== '/' && (local.pathname === rota(m.chave) || local.pathname.startsWith(rota(m.chave) + '/')));
      // Buscando, ou na tela de um item do grupo, o grupo fica aberto mesmo que esteja fechado.
      return { ...g, aberto: !g.titulo || !!termo || aqui || !fechados.includes(g.titulo), aviso: (g.itens.some((m) => m.chave === 'crm') ? avisoCrm : 0) + (g.itens.some((m) => m.chave === 'meu-ponto') ? avisoPonto : 0) };
    });
  return (
    <div className={`app${recolhido ? ' menu-recolhido' : ''}`}>
      {recolhido && (
        <button type="button" className="abrir-menu" onClick={() => recolher(false)} aria-label="Abrir o menu" title="Abrir o menu">
          ☰
        </button>
      )}
      <aside className="lateral" hidden={recolhido}>
        <div className="marca">
          <img src="/logo-creme.png" alt="Aritana Semijoias" />
          <button type="button" className="recolher-menu" onClick={() => recolher(true)} aria-label="Recolher o menu" title="Recolher o menu">
            «
          </button>
        </div>
        <SeletorVisao />
        <input className="busca-menu" type="search" placeholder="Buscar no menu" aria-label="Buscar no menu" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <nav aria-label="Módulos">
          {grupos.map((g) => (
            <div key={g.titulo || 'inicio'} className="grupo-menu" role="group" aria-label={g.titulo || undefined}>
              {g.titulo && (
                <button type="button" className="titulo-menu" aria-expanded={g.aberto} onClick={() => alternar(g.titulo)}>
                  {g.titulo}
                  <span className="seta" aria-hidden="true">{g.aberto ? '▾' : '▸'}</span>
                  {!g.aberto && g.aviso > 0 && <span className="bolha-menu">{g.aviso}</span>}
                </button>
              )}
              {g.aberto && g.itens.map((m) =>
                m.versao === 2 ? (
                  <span key={m.chave} className="item" title="Entra na Versão 2">
                    {m.nome} <span className="v2">V2</span>
                  </span>
                ) : (
                  <NavLink key={m.chave} to={m.chave === 'meu-ponto' ? '/meu-ponto' : (ROTAS[m.chave] ?? `/${m.chave}`)} end={m.chave === 'inicio'} onClick={() => setBusca('')} className={({ isActive }) => (isActive ? 'ativo' : '')}>
                    {m.nome}
                    {m.chave === 'mesa' && mesa.total > 0 && <span className="bolha-menu" title="Mensagens não lidas e tarefas atrasadas">{mesa.total}</span>}
                    {m.chave === 'crm' && avisoCrm > 0 && <span className="bolha-menu" title="Na fila e não lidas">{avisoCrm}</span>}
                    {m.chave === 'meu-ponto' && avisoPonto > 0 && <span className="bolha-menu" title="Espelho para confirmar e documentos novos">{avisoPonto}</span>}
                  </NavLink>
                ),
              )}
            </div>
          ))}
          {grupos.length === 0 && <div className="vazio-menu">Nada encontrado</div>}
        </nav>
        <div className="rodape">
          <div style={{ fontWeight: 600, color: '#faf6ef' }}>{sessao?.usuario.nome}</div>
          <div style={{ marginBottom: 8 }}>{sessao?.usuario.grupo}</div>
          <NavLink to="/manual" style={{ color: 'var(--areia)', display: 'block', marginBottom: 6 }}>Manual de uso</NavLink>
          <NavLink to="/minha-senha" style={{ color: 'var(--areia)', display: 'block', marginBottom: 6 }}>Trocar senha</NavLink>
          <button
            onClick={async () => {
              await api('/auth/sair', { corpo: {} }).catch(() => undefined);
              salvarSessao(null);
              navegar('/entrar');
            }}
          >
            Sair
          </button>
        </div>
      </aside>
      <main className="conteudo">
        <Outlet />
      </main>
      <Softphone />
      <AvisosDaMesa avisos={mesa.avisos} fechar={mesa.fechar} />
    </div>
  );
}

/** Consolidado ou um CNPJ só: vale para Início, Indicadores, Financeiro e DRE. Só aparece com mais de uma empresa. */
function SeletorVisao() {
  const visao = usarVisao();
  const empresas = useQuery({ queryKey: ['empresas'], queryFn: () => api<{ id: string; nome: string; cnpj: string | null; ativo: boolean }[]>('/empresas'), staleTime: 300_000 });
  const lista = (empresas.data ?? []).filter((e) => e.ativo);
  if (lista.length < 2) return null;
  const cnpj = (c: string | null) => (c && c.length === 14 ? ` · ${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : '');
  return (
    <label className="visao-menu" title="Os números do Início, Indicadores, Financeiro e DRE seguem esta visão">
      <span>Visão</span>
      <select value={lista.some((e) => e.id === visao) ? visao : ''} onChange={(e) => mudarVisao(e.target.value)} aria-label="Visão por empresa (CNPJ)">
        <option value="">Consolidado (todos os CNPJs)</option>
        {lista.map((e) => <option key={e.id} value={e.id}>{e.nome}{cnpj(e.cnpj)}</option>)}
      </select>
    </label>
  );
}
