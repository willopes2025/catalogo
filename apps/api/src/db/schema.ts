/**
 * Banco de dados da Plataforma Aritana — Versão 1.
 * Dinheiro sempre em centavos (integer/bigint). Percentuais em pontos-base (100 = 1%).
 * Estoque como livro-caixa: cada entrada e saída é uma linha em `movimentos`;
 * `saldos` é o resumo, atualizado na mesma transação.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const criadoEm = () => timestamp('criado_em', { withTimezone: true }).notNull().defaultNow();
const atualizadoEm = () => timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow();

// ───────────────────────── Empresas e locais ─────────────────────────

export const tipoEmpresa = pgEnum('tipo_empresa', ['matriz', 'loja']);

export const empresas = pgTable('empresas', {
  id: id(),
  nome: text('nome').notNull(),
  razaoSocial: text('razao_social'),
  cnpj: text('cnpj'),
  inscricaoEstadual: text('inscricao_estadual'),
  tipo: tipoEmpresa('tipo').notNull().default('matriz'),
  cidade: text('cidade'),
  uf: text('uf'),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

export const tipoLocal = pgEnum('tipo_local', ['deposito', 'loja', 'evento', 'maleta']);

export const locaisEstoque = pgTable('locais_estoque', {
  id: id(),
  empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
  nome: text('nome').notNull(),
  tipo: tipoLocal('tipo').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

// ───────────────────────── Usuários e permissões ─────────────────────────

export const grupos = pgTable('grupos', {
  id: id(),
  nome: text('nome').notNull().unique(),
  /** { "maletas": ["ver","criar",...], ... } ou { "*": ["*"] } para acesso total */
  permissoes: jsonb('permissoes').$type<Record<string, string[]>>().notNull().default({}),
  criadoEm: criadoEm(),
});

export const usuarios = pgTable('usuarios', {
  id: id(),
  nome: text('nome').notNull(),
  email: text('email').notNull().unique(),
  senhaHash: text('senha_hash').notNull(),
  grupoId: uuid('grupo_id').notNull().references(() => grupos.id),
  /** Empresas que o usuário pode acessar; vazio = todas. */
  empresas: jsonb('empresas').$type<string[]>().notNull().default([]),
  ativo: boolean('ativo').notNull().default(true),
  ultimoAcesso: timestamp('ultimo_acesso', { withTimezone: true }),
  /** Vendedora de loja: comissão própria (pontos-base) e meta mensal em centavos. */
  comissaoPb: integer('comissao_pb'),
  metaMensal: integer('meta_mensal'),
  criadoEm: criadoEm(),
});

// ───────────────────────── Pessoas ─────────────────────────

export const tipoPessoa = pgEnum('tipo_pessoa', ['representante', 'cliente', 'fornecedor', 'transportadora', 'assistencia']);
export const modeloTrabalho = pgEnum('modelo_trabalho', ['consignado', 'revenda', 'afiliado']);
export const statusPessoa = pgEnum('status_pessoa', ['triagem', 'ativo', 'inativo', 'recusado']);

export const niveis = pgTable('niveis', {
  id: id(),
  nome: text('nome').notNull(),
  ordem: integer('ordem').notNull().default(0),
  metaMensal: integer('meta_mensal').notNull().default(0),
  /** Se preenchido, substitui a comissão padrão das configurações. */
  comissaoAvistaPb: integer('comissao_avista_pb'),
  comissaoPrazoPb: integer('comissao_prazo_pb'),
});

export const pessoas = pgTable(
  'pessoas',
  {
    id: id(),
    tipo: tipoPessoa('tipo').notNull(),
    tipoDocumento: text('tipo_documento').notNull().default('cpf'),
    documento: text('documento'),
    nome: text('nome').notNull(),
    nomeFantasia: text('nome_fantasia'),
    rg: text('rg'),
    inscricaoEstadual: text('inscricao_estadual'),
    nascimento: date('nascimento'),
    genero: text('genero'),
    estadoCivil: text('estado_civil'),
    profissao: text('profissao'),
    telefone1: text('telefone1'),
    telefone2: text('telefone2'),
    telefone3: text('telefone3'),
    email: text('email'),
    instagram: text('instagram'),
    cep: text('cep'),
    logradouro: text('logradouro'),
    numero: text('numero'),
    complemento: text('complemento'),
    bairro: text('bairro'),
    cidade: text('cidade'),
    uf: text('uf'),
    // Representante
    modeloTrabalho: modeloTrabalho('modelo_trabalho'),
    nivelId: uuid('nivel_id').references(() => niveis.id),
    liderId: uuid('lider_id').references((): AnyPgColumn => pessoas.id),
    supervisorId: uuid('supervisor_id').references(() => usuarios.id),
    indicadoPorId: uuid('indicado_por_id').references((): AnyPgColumn => pessoas.id),
    praca: text('praca'),
    limiteCredito: integer('limite_credito').notNull().default(0),
    bloqueado: boolean('bloqueado').notNull().default(false),
    motivoBloqueio: text('motivo_bloqueio'),
    // Cliente final
    representanteId: uuid('representante_id').references((): AnyPgColumn => pessoas.id),
    consentimentoLgpd: boolean('consentimento_lgpd').notNull().default(false),
    status: statusPessoa('status').notNull().default('ativo'),
    observacao: text('observacao'),
    observacaoInterna: text('observacao_interna'),
    /** Endereço do catálogo da representante: /catalogo/<slug> */
    slug: text('slug'),
    /** Cliente correspondente no Asaas, criado na primeira cobrança. */
    asaasClienteId: text('asaas_cliente_id'),
    /** Id no Jueri, para conferência da migração. */
    idJueri: text('id_jueri'),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({
    slug: uniqueIndex('pessoas_slug_uq').on(t.slug),
    porTipo: index('pessoas_tipo_idx').on(t.tipo, t.status),
    porDocumento: index('pessoas_documento_idx').on(t.documento),
    porLider: index('pessoas_lider_idx').on(t.liderId),
  }),
);

export const referencias = pgTable('referencias', {
  id: id(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  telefone: text('telefone'),
  relacao: text('relacao'),
});

// ───────────────────────── Produtos ─────────────────────────

export const categorias = pgTable('categorias', {
  id: id(),
  nome: text('nome').notNull(),
  paiId: uuid('pai_id').references((): AnyPgColumn => categorias.id),
});

export const lotesBanho = pgTable('lotes_banho', {
  id: id(),
  codigo: text('codigo').notNull(),
  fornecedorId: uuid('fornecedor_id').references(() => pessoas.id),
  fabricacao: date('fabricacao'),
  validade: date('validade'),
  observacao: text('observacao'),
  criadoEm: criadoEm(),
});

export const produtos = pgTable(
  'produtos',
  {
    id: id(),
    codigoBarras: text('codigo_barras').notNull(),
    referencia: text('referencia').notNull(),
    descricao: text('descricao').notNull(),
    categoriaId: uuid('categoria_id').references(() => categorias.id),
    tamanho: text('tamanho'),
    cor: text('cor'),
    pesoBanho: text('peso_banho'),
    milesimos: text('milesimos'),
    fornecedorId: uuid('fornecedor_id').references(() => pessoas.id),
    codigoFornecedor: text('codigo_fornecedor'),
    loteBanhoId: uuid('lote_banho_id').references(() => lotesBanho.id),
    custo: integer('custo').notNull().default(0),
    preco: integer('preco').notNull(),
    precoAtacado: integer('preco_atacado'),
    descontoMaximoPb: integer('desconto_maximo_pb').notNull().default(0),
    estoqueMinimo: integer('estoque_minimo').notNull().default(0),
    localizacao: text('localizacao'),
    ncm: text('ncm'),
    cfop: text('cfop'),
    fotos: jsonb('fotos').$type<string[]>().notNull().default([]),
    exibeCatalogo: boolean('exibe_catalogo').notNull().default(true),
    ativo: boolean('ativo').notNull().default(true),
    idJueri: text('id_jueri'),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({
    codigo: uniqueIndex('produtos_codigo_barras_uq').on(t.codigoBarras),
    referencia: index('produtos_referencia_idx').on(t.referencia),
  }),
);

// ───────────────────────── Estoque (livro-caixa) ─────────────────────────

export const tipoMovimento = pgEnum('tipo_movimento', [
  'entrada',
  'ajuste',
  'transferencia',
  'maleta_envio',
  'maleta_devolucao',
  'venda',
  'perda',
  'garantia',
]);

export const movimentos = pgTable(
  'movimentos',
  {
    id: id(),
    produtoId: uuid('produto_id').notNull().references(() => produtos.id),
    origemId: uuid('origem_id').references(() => locaisEstoque.id),
    destinoId: uuid('destino_id').references(() => locaisEstoque.id),
    quantidade: integer('quantidade').notNull(),
    tipo: tipoMovimento('tipo').notNull(),
    motivo: text('motivo'),
    referenciaTipo: text('referencia_tipo'),
    referenciaId: uuid('referencia_id'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => ({
    porProduto: index('movimentos_produto_idx').on(t.produtoId, t.criadoEm),
    porReferencia: index('movimentos_ref_idx').on(t.referenciaTipo, t.referenciaId),
  }),
);

export const saldos = pgTable(
  'saldos',
  {
    produtoId: uuid('produto_id').notNull().references(() => produtos.id),
    localId: uuid('local_id').notNull().references(() => locaisEstoque.id),
    quantidade: integer('quantidade').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.produtoId, t.localId] }) }),
);

// ───────────────────────── Maletas e acertos ─────────────────────────

export const statusMaleta = pgEnum('status_maleta', ['aberta', 'acertada', 'cancelada']);

export const maletas = pgTable(
  'maletas',
  {
    id: id(),
    numero: serial('numero').notNull(),
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    representanteId: uuid('representante_id').notNull().references(() => pessoas.id),
    /** Local de estoque próprio desta maleta: as peças "moram" aqui enquanto estão com ela. */
    localId: uuid('local_id').notNull().references(() => locaisEstoque.id),
    /** Local de onde as peças saíram e para onde voltam. */
    origemId: uuid('origem_id').notNull().references(() => locaisEstoque.id),
    status: statusMaleta('status').notNull().default('aberta'),
    dataRetirada: date('data_retirada').notNull(),
    dataLimite: date('data_limite').notNull(),
    entrega: text('entrega').notNull().default('retirada'),
    codigoRastreio: text('codigo_rastreio'),
    conferida: boolean('conferida').notNull().default(false),
    recebidaEm: timestamp('recebida_em', { withTimezone: true }),
    /** Token do link do pedido que a representante abre pelo WhatsApp. */
    linkToken: text('link_token').notNull(),
    prebaixaEm: timestamp('prebaixa_em', { withTimezone: true }),
    observacao: text('observacao'),
    observacaoInterna: text('observacao_interna'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
    acertadaEm: timestamp('acertada_em', { withTimezone: true }),
  },
  (t) => ({
    porRep: index('maletas_rep_idx').on(t.representanteId, t.status),
    link: uniqueIndex('maletas_link_uq').on(t.linkToken),
  }),
);

export const maletaItens = pgTable(
  'maleta_itens',
  {
    id: id(),
    maletaId: uuid('maleta_id').notNull().references(() => maletas.id, { onDelete: 'cascade' }),
    produtoId: uuid('produto_id').notNull().references(() => produtos.id),
    /** Preço e custo no momento em que a peça entrou na maleta. */
    preco: integer('preco').notNull(),
    custo: integer('custo').notNull(),
    enviada: integer('enviada').notNull().default(0),
    vendida: integer('vendida').notNull().default(0),
    devolvida: integer('devolvida').notNull().default(0),
    perdida: integer('perdida').notNull().default(0),
    /** O que a representante informou na pré-baixa (antes da conferência). */
    prebaixaVendida: integer('prebaixa_vendida'),
    prebaixaDevolvida: integer('prebaixa_devolvida'),
  },
  (t) => ({ uq: uniqueIndex('maleta_itens_uq').on(t.maletaId, t.produtoId) }),
);

export const acertos = pgTable('acertos', {
  id: id(),
  maletaId: uuid('maleta_id').notNull().references(() => maletas.id),
  data: date('data').notNull(),
  forma: text('forma').notNull(),
  modalidade: text('modalidade').notNull().default('presencial'),
  parcial: boolean('parcial').notNull().default(false),
  /** Fotografia completa do cálculo, para auditoria. */
  resultado: jsonb('resultado').notNull(),
  regras: jsonb('regras').notNull(),
  totalAPagar: integer('total_a_pagar').notNull(),
  parcelas: integer('parcelas').notNull().default(1),
  limiteAnterior: integer('limite_anterior'),
  limiteNovo: integer('limite_novo'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

// ───────────────────────── Financeiro ─────────────────────────

export const statusTitulo = pgEnum('status_titulo', ['aberto', 'pago', 'cancelado', 'protestado']);

export const contas = pgTable('contas', {
  id: id(),
  empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
  nome: text('nome').notNull(),
  tipo: text('tipo').notNull().default('banco'),
  saldoInicial: integer('saldo_inicial').notNull().default(0),
  ativo: boolean('ativo').notNull().default(true),
});

export const titulos = pgTable(
  'titulos',
  {
    id: id(),
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    tipo: text('tipo').notNull(), // receber | pagar
    pessoaId: uuid('pessoa_id').references(() => pessoas.id),
    descricao: text('descricao').notNull(),
    categoria: text('categoria'),
    valor: integer('valor').notNull(),
    vencimento: date('vencimento').notNull(),
    parcela: integer('parcela').notNull().default(1),
    totalParcelas: integer('total_parcelas').notNull().default(1),
    formaPagamento: text('forma_pagamento'),
    status: statusTitulo('status').notNull().default('aberto'),
    contaId: uuid('conta_id').references(() => contas.id),
    origemTipo: text('origem_tipo'),
    origemId: uuid('origem_id'),
    pagoEm: date('pago_em'),
    valorPago: integer('valor_pago'),
    /** Id da cobrança no Asaas, quando houver. */
    cobrancaExternaId: text('cobranca_externa_id'),
    cobrancaTipo: text('cobranca_tipo'),
    cobrancaUrl: text('cobranca_url'),
    pixCopiaCola: text('pix_copia_cola'),
    criadoEm: criadoEm(),
  },
  (t) => ({
    porVenc: index('titulos_venc_idx').on(t.tipo, t.status, t.vencimento),
    porPessoa: index('titulos_pessoa_idx').on(t.pessoaId),
  }),
);

/** Créditos da pessoa: positivo gera, negativo usa. O saldo é a soma. */
export const creditos = pgTable('creditos', {
  id: id(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id),
  valor: integer('valor').notNull(),
  descricao: text('descricao').notNull(),
  origemTipo: text('origem_tipo'),
  origemId: uuid('origem_id'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

// ───────────────────────── Loja: caixas e vendas ─────────────────────────

export const statusCaixa = pgEnum('status_caixa', ['aberto', 'fechado']);

/** Caixa de um ponto de venda (loja ou evento), do abrir ao fechar do dia. */
export const caixas = pgTable(
  'caixas',
  {
    id: id(),
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    localId: uuid('local_id').notNull().references(() => locaisEstoque.id),
    status: statusCaixa('status').notNull().default('aberto'),
    valorAbertura: integer('valor_abertura').notNull().default(0),
    abertoEm: timestamp('aberto_em', { withTimezone: true }).notNull().defaultNow(),
    abertoPor: uuid('aberto_por').references(() => usuarios.id),
    fechadoEm: timestamp('fechado_em', { withTimezone: true }),
    fechadoPor: uuid('fechado_por').references(() => usuarios.id),
    /** { dinheiro: 15000, pix: 32000, ... } contado no fechamento */
    contado: jsonb('contado').$type<Record<string, number>>(),
    esperado: jsonb('esperado').$type<Record<string, number>>(),
    diferenca: integer('diferenca'),
    observacao: text('observacao'),
  },
  (t) => ({ porLocal: index('caixas_local_idx').on(t.localId, t.status) }),
);

export const caixaMovimentos = pgTable('caixa_movimentos', {
  id: id(),
  caixaId: uuid('caixa_id').notNull().references(() => caixas.id),
  tipo: text('tipo').notNull(), // abertura | venda | sangria | reforco | devolucao | cancelamento
  forma: text('forma').notNull(),
  valor: integer('valor').notNull(),
  descricao: text('descricao'),
  vendaId: uuid('venda_id'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

export const statusVenda = pgEnum('status_venda', ['concluida', 'cancelada']);

export const vendas = pgTable(
  'vendas',
  {
    id: id(),
    numero: serial('numero').notNull(),
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    localId: uuid('local_id').notNull().references(() => locaisEstoque.id),
    caixaId: uuid('caixa_id').references(() => caixas.id),
    /** balcao (PDV da loja/evento), avulsa (matriz), revenda (representante no modelo revenda) */
    tipo: text('tipo').notNull().default('balcao'),
    clienteId: uuid('cliente_id').references(() => pessoas.id),
    vendedorId: uuid('vendedor_id').references(() => usuarios.id),
    subtotal: integer('subtotal').notNull(),
    desconto: integer('desconto').notNull().default(0),
    total: integer('total').notNull(),
    troco: integer('troco').notNull().default(0),
    status: statusVenda('status').notNull().default('concluida'),
    observacao: text('observacao'),
    motivoCancelamento: text('motivo_cancelamento'),
    canceladaEm: timestamp('cancelada_em', { withTimezone: true }),
    criadoEm: criadoEm(),
  },
  (t) => ({ porData: index('vendas_data_idx').on(t.criadoEm), porCliente: index('vendas_cliente_idx').on(t.clienteId) }),
);

export const vendaItens = pgTable('venda_itens', {
  id: id(),
  vendaId: uuid('venda_id').notNull().references(() => vendas.id, { onDelete: 'cascade' }),
  produtoId: uuid('produto_id').notNull().references(() => produtos.id),
  quantidade: integer('quantidade').notNull(),
  preco: integer('preco').notNull(),
  custo: integer('custo').notNull(),
  desconto: integer('desconto').notNull().default(0),
  total: integer('total').notNull(),
  devolvida: integer('devolvida').notNull().default(0),
});

export const vendaPagamentos = pgTable('venda_pagamentos', {
  id: id(),
  vendaId: uuid('venda_id').notNull().references(() => vendas.id, { onDelete: 'cascade' }),
  /** dinheiro | pix | debito | credito | credito_loja | boleto */
  forma: text('forma').notNull(),
  valor: integer('valor').notNull(),
  parcelas: integer('parcelas').notNull().default(1),
  maquininha: text('maquininha'),
  autorizacao: text('autorizacao'),
});

// ───────────────────────── Fiscal ─────────────────────────

/** Natureza e CFOP de cada operação. Valores iniciais a validar pelo contador da Aritana. */
export const regrasFiscais = pgTable('regras_fiscais', {
  operacao: text('operacao').primaryKey(),
  natureza: text('natureza').notNull(),
  cfopDentro: text('cfop_dentro').notNull(),
  cfopFora: text('cfop_fora').notNull(),
  csosn: text('csosn').notNull().default('102'),
  /** Preço usado na nota: venda (preço de etiqueta) ou custo. */
  base: text('base').notNull().default('venda'),
  observacao: text('observacao'),
  atualizadoEm: atualizadoEm(),
});

export const statusNota = pgEnum('status_nota', ['pendente', 'processando', 'autorizada', 'erro', 'cancelada', 'denegada']);

export const notasFiscais = pgTable(
  'notas_fiscais',
  {
    id: id(),
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    modelo: text('modelo').notNull(), // nfce | nfe
    operacao: text('operacao').notNull(),
    /** Referência única enviada ao emissor (também evita nota duplicada). */
    ref: text('ref').notNull(),
    origemTipo: text('origem_tipo').notNull(),
    origemId: uuid('origem_id').notNull(),
    destinatarioId: uuid('destinatario_id').references(() => pessoas.id),
    valor: integer('valor').notNull(),
    status: statusNota('status').notNull().default('pendente'),
    numero: text('numero'),
    serie: text('serie'),
    chave: text('chave'),
    mensagem: text('mensagem'),
    urlDanfe: text('url_danfe'),
    urlXml: text('url_xml'),
    payload: jsonb('payload'),
    resposta: jsonb('resposta'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ ref: uniqueIndex('notas_ref_uq').on(t.ref), porOrigem: index('notas_origem_idx').on(t.origemTipo, t.origemId) }),
);

// ───────────────────────── Integrações, suporte e importação ─────────────────────────

/** Avisos recebidos de serviços externos (ex.: pagamento no Asaas), guardados para não processar duas vezes. */
export const eventosIntegracao = pgTable('eventos_integracao', {
  id: text('id').primaryKey(),
  origem: text('origem').notNull(),
  tipo: text('tipo').notNull(),
  payload: jsonb('payload').notNull(),
  resultado: text('resultado'),
  criadoEm: criadoEm(),
});

export const chamados = pgTable('chamados', {
  id: id(),
  numero: serial('numero').notNull(),
  titulo: text('titulo').notNull(),
  tipo: text('tipo').notNull().default('duvida'), // duvida | erro | melhoria
  modulo: text('modulo'),
  tela: text('tela'),
  prioridade: text('prioridade').notNull().default('normal'),
  status: text('status').notNull().default('aberto'), // aberto | em_analise | em_desenvolvimento | resolvido
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
});

export const chamadoMensagens = pgTable('chamado_mensagens', {
  id: id(),
  chamadoId: uuid('chamado_id').notNull().references(() => chamados.id, { onDelete: 'cascade' }),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  /** Resposta da equipe da Wide (fora do sistema da Aritana). */
  daWide: boolean('da_wide').notNull().default(false),
  texto: text('texto').notNull(),
  criadoEm: criadoEm(),
});

export const importacoes = pgTable('importacoes', {
  id: id(),
  tipo: text('tipo').notNull(),
  arquivo: text('arquivo'),
  linhas: integer('linhas').notNull(),
  criados: integer('criados').notNull().default(0),
  atualizados: integer('atualizados').notNull().default(0),
  erros: jsonb('erros').$type<{ linha: number; mensagem: string }[]>().notNull().default([]),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

// ───────────────────────── Garantia e ordens de serviço ─────────────────────────

export const servicos = pgTable('servicos', {
  id: id(),
  descricao: text('descricao').notNull(),
  valor: integer('valor').notNull().default(0),
  ativo: boolean('ativo').notNull().default(true),
});

/**
 * Ordem de serviço: garantia (reclamação de defeito no prazo) ou conserto pago.
 * Guarda de onde veio a peça, para onde foi e o que foi decidido.
 */
export const ordensServico = pgTable(
  'ordens_servico',
  {
    id: id(),
    numero: serial('numero').notNull(),
    tipo: text('tipo').notNull(), // garantia | conserto
    status: text('status').notNull().default('aberta'), // aberta | na_assistencia | pronta | concluida | cancelada
    clienteId: uuid('cliente_id').references(() => pessoas.id),
    representanteId: uuid('representante_id').references(() => pessoas.id),
    produtoId: uuid('produto_id').references(() => produtos.id),
    vendaId: uuid('venda_id').references(() => vendas.id),
    maletaId: uuid('maleta_id').references(() => maletas.id),
    dataCompra: date('data_compra'),
    garantiaAte: date('garantia_ate'),
    defeito: text('defeito').notNull(),
    prestadorId: uuid('prestador_id').references(() => pessoas.id),
    servicoId: uuid('servico_id').references(() => servicos.id),
    valor: integer('valor').notNull().default(0),
    valorPago: integer('valor_pago').notNull().default(0),
    previsao: date('previsao'),
    /** troca | conserto | devolucao_fornecedor | recusada */
    decisao: text('decisao'),
    motivoDecisao: text('motivo_decisao'),
    /** Peça entregue no lugar, na troca. */
    produtoTrocaId: uuid('produto_troca_id').references(() => produtos.id),
    observacao: text('observacao'),
    observacaoInterna: text('observacao_interna'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
    concluidaEm: timestamp('concluida_em', { withTimezone: true }),
  },
  (t) => ({ porStatus: index('os_status_idx').on(t.status) }),
);

// ───────────────────────── Comissões ─────────────────────────

export const fechamentosComissao = pgTable('fechamentos_comissao', {
  id: id(),
  mes: text('mes').notNull().unique(), // AAAA-MM
  total: integer('total').notNull(),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

export const comissoes = pgTable('comissoes', {
  id: id(),
  fechamentoId: uuid('fechamento_id').notNull().references(() => fechamentosComissao.id, { onDelete: 'cascade' }),
  tipo: text('tipo').notNull(), // loja | rede
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  pessoaId: uuid('pessoa_id').references(() => pessoas.id),
  nome: text('nome').notNull(),
  base: integer('base').notNull(),
  percentualPb: integer('percentual_pb').notNull(),
  valor: integer('valor').notNull(),
  meta: integer('meta'),
  detalhes: jsonb('detalhes'),
  tituloId: uuid('titulo_id').references(() => titulos.id),
});

// ───────────────────────── Avisos ─────────────────────────

/** Cada aviso enviado, para nunca mandar o mesmo duas vezes. */
export const avisosEnviados = pgTable('avisos_enviados', {
  chave: text('chave').primaryKey(),
  para: text('para').notNull(),
  assunto: text('assunto').notNull(),
  criadoEm: criadoEm(),
});

// ───────────────────────── Contratos e assinatura ─────────────────────────

export const tipoDocumento = pgEnum('tipo_documento', ['contrato', 'promissoria', 'aditivo']);
export const statusDocumento = pgEnum('status_documento', ['pendente', 'assinado', 'cancelado', 'expirado']);

/** Modelo de texto com variáveis {{nome}}, {{comissao_avista}} etc. */
export const modelosDocumento = pgTable('modelos_documento', {
  id: id(),
  tipo: tipoDocumento('tipo').notNull(),
  /** Modelo de trabalho a que se aplica; nulo = todos. */
  modeloTrabalho: modeloTrabalho('modelo_trabalho'),
  titulo: text('titulo').notNull(),
  conteudo: text('conteudo').notNull(),
  versao: integer('versao').notNull().default(1),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
});

/**
 * Documento gerado para uma pessoa e enviado para assinatura eletrônica.
 * O texto final fica congelado em `conteudo`, com o hash SHA-256 que prova que não mudou.
 */
export const documentos = pgTable(
  'documentos',
  {
    id: id(),
    tipo: tipoDocumento('tipo').notNull(),
    pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id),
    maletaId: uuid('maleta_id').references(() => maletas.id),
    modeloId: uuid('modelo_id').references(() => modelosDocumento.id),
    titulo: text('titulo').notNull(),
    conteudo: text('conteudo').notNull(),
    hash: text('hash').notNull(),
    status: statusDocumento('status').notNull().default('pendente'),
    token: text('token').notNull(),
    enviadoPara: text('enviado_para'),
    /** Código de confirmação guardado só como hash. */
    codigoHash: text('codigo_hash'),
    codigoExpiraEm: timestamp('codigo_expira_em', { withTimezone: true }),
    tentativas: integer('tentativas').notNull().default(0),
    visualizadoEm: timestamp('visualizado_em', { withTimezone: true }),
    assinadoEm: timestamp('assinado_em', { withTimezone: true }),
    assinaturaNome: text('assinatura_nome'),
    assinaturaDocumento: text('assinatura_documento'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => ({
    token: uniqueIndex('documentos_token_uq').on(t.token),
    porPessoa: index('documentos_pessoa_idx').on(t.pessoaId),
  }),
);

// ───────────────────────── Configurações e auditoria ─────────────────────────

export const configuracoes = pgTable('configuracoes', {
  chave: text('chave').primaryKey(),
  valor: jsonb('valor').notNull(),
  atualizadoEm: atualizadoEm(),
});

export const auditoria = pgTable(
  'auditoria',
  {
    id: id(),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    acao: text('acao').notNull(),
    entidade: text('entidade').notNull(),
    entidadeId: text('entidade_id'),
    dados: jsonb('dados'),
    criadoEm: criadoEm(),
  },
  (t) => ({ porEntidade: index('auditoria_entidade_idx').on(t.entidade, t.entidadeId) }),
);
