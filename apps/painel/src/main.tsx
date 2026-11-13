import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/titillium-web/400.css';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import './estilo.css';
import { lerSessao } from './api';
import { Layout } from './componentes/Layout';
import { Entrar } from './paginas/Entrar';
import { Inicio } from './paginas/Inicio';
import { Representantes, FichaRepresentante } from './paginas/Representantes';
import { Produtos, FichaProduto } from './paginas/Produtos';
import { Estoque } from './paginas/Estoque';
import { Maletas } from './paginas/Maletas';
import { NovaMaleta } from './paginas/NovaMaleta';
import { DetalheMaleta } from './paginas/DetalheMaleta';
import { Acerto } from './paginas/Acerto';
import { Financeiro } from './paginas/Financeiro';
import { Configuracoes } from './paginas/Configuracoes';
import { EmConstrucao } from './paginas/EmConstrucao';
import { LinkPedido } from './paginas/LinkPedido';

const cliente = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } });

function Protegido({ children }: { children: React.ReactNode }) {
  return lerSessao() ? <>{children}</> : <Navigate to="/entrar" replace />;
}

ReactDOM.createRoot(document.getElementById('raiz')!).render(
  <React.StrictMode>
    <QueryClientProvider client={cliente}>
      <BrowserRouter>
        <Routes>
          <Route path="/entrar" element={<Entrar />} />
          <Route path="/pedido/:token" element={<LinkPedido />} />
          <Route
            element={
              <Protegido>
                <Layout />
              </Protegido>
            }
          >
            <Route index element={<Inicio />} />
            <Route path="rede" element={<Representantes />} />
            <Route path="rede/nova" element={<FichaRepresentante />} />
            <Route path="rede/:id" element={<FichaRepresentante />} />
            <Route path="produtos" element={<Produtos />} />
            <Route path="produtos/novo" element={<FichaProduto />} />
            <Route path="produtos/:id" element={<FichaProduto />} />
            <Route path="estoque" element={<Estoque />} />
            <Route path="maletas" element={<Maletas />} />
            <Route path="maletas/nova" element={<NovaMaleta />} />
            <Route path="maletas/:id" element={<DetalheMaleta />} />
            <Route path="maletas/:id/acerto" element={<Acerto />} />
            <Route path="financeiro" element={<Financeiro />} />
            <Route path="configuracoes" element={<Configuracoes />} />
            <Route path=":modulo" element={<EmConstrucao />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
