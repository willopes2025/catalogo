import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { MODULOS } from '@aritana/regras';
import { lerSessao, pode, salvarSessao } from '../api';

/** Rotas já construídas nesta etapa; as demais abrem a página "em construção". */
const ROTAS: Record<string, string> = { inicio: '/', rede: '/rede', cadastros: '/cadastros', produtos: '/produtos', estoque: '/estoque', maletas: '/maletas', vendas: '/vendas', lojas: '/lojas', financeiro: '/financeiro', fiscal: '/fiscal', relatorios: '/relatorios', configuracoes: '/configuracoes', suporte: '/suporte' };

export function Layout() {
  const sessao = lerSessao();
  const navegar = useNavigate();
  return (
    <div className="app">
      <aside className="lateral">
        <div className="marca">
          <img src="/logo-creme.png" alt="Aritana Semijoias" />
        </div>
        <nav aria-label="Módulos">
          {MODULOS.filter((m) => m.chave === 'suporte' || pode(m.chave, 'ver')).map((m) =>
            m.versao === 2 ? (
              <span key={m.chave} className="item" title="Entra na Versão 2">
                {m.nome} <span className="v2">V2</span>
              </span>
            ) : (
              <NavLink key={m.chave} to={ROTAS[m.chave] ?? `/${m.chave}`} end={m.chave === 'inicio'} className={({ isActive }) => (isActive ? 'ativo' : '')}>
                {m.nome}
              </NavLink>
            ),
          )}
        </nav>
        <div className="rodape">
          <div style={{ fontWeight: 600, color: '#faf6ef' }}>{sessao?.usuario.nome}</div>
          <div style={{ marginBottom: 8 }}>{sessao?.usuario.grupo}</div>
          <button
            onClick={() => {
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
    </div>
  );
}
