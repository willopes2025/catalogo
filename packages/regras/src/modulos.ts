/**
 * Os 19 módulos do painel, na ordem do documento de detalhamento.
 * Usado pelo menu do painel e pelas permissões (cada permissão é por módulo).
 */
export const MODULOS = [
  { chave: 'inicio', nome: 'Início', versao: 1 },
  { chave: 'crm', nome: 'Candidatas', versao: 1 },
  { chave: 'marketing', nome: 'Marketing', versao: 2 },
  { chave: 'rede', nome: 'Rede', versao: 1 },
  { chave: 'cadastros', nome: 'Cadastros', versao: 1 },
  { chave: 'produtos', nome: 'Produtos', versao: 1 },
  { chave: 'estoque', nome: 'Estoque', versao: 1 },
  { chave: 'maletas', nome: 'Maletas', versao: 1 },
  { chave: 'vendas', nome: 'Vendas', versao: 1 },
  { chave: 'lojas', nome: 'Lojas e eventos', versao: 1 },
  { chave: 'garantia', nome: 'Garantia', versao: 1 },
  { chave: 'pontos', nome: 'Pontos e prêmios', versao: 1 },
  { chave: 'financeiro', nome: 'Financeiro', versao: 1 },
  { chave: 'comissoes', nome: 'Comissões', versao: 1 },
  { chave: 'fiscal', nome: 'Fiscal', versao: 1 },
  { chave: 'relatorios', nome: 'Relatórios', versao: 1 },
  { chave: 'formularios', nome: 'Formulários', versao: 2 },
  { chave: 'configuracoes', nome: 'Configurações', versao: 1 },
  { chave: 'suporte', nome: 'Suporte', versao: 1 },
] as const;

export type ChaveModulo = (typeof MODULOS)[number]['chave'];
export type Acao = 'ver' | 'criar' | 'editar' | 'excluir' | 'exportar';
export const ACOES: Acao[] = ['ver', 'criar', 'editar', 'excluir', 'exportar'];
