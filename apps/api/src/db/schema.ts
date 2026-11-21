/**
 * Banco de dados da Plataforma Aritana — Versão 1.
 * Dinheiro sempre em centavos (integer/bigint). Percentuais em pontos-base (100 = 1%).
 * Estoque como livro-caixa: cada entrada e saída é uma linha em `movimentos`;
 * `saldos` é o resumo, atualizado na mesma transação.
 */
import type { CampoFormulario } from '@aritana/regras';
import { sql } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
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
  /** Presença: última vez que o painel falou com o servidor e quando começou a sessão atual (nova após 30 min parado). */
  ultimaAtividadeEm: timestamp('ultima_atividade_em', { withTimezone: true }),
  sessaoInicioEm: timestamp('sessao_inicio_em', { withTimezone: true }),
  /** Senha criada por outra pessoa: precisa ser trocada no primeiro acesso. */
  senhaProvisoria: boolean('senha_provisoria').notNull().default(false),
  /** Cobrador a que este usuário pertence. Terceirizada: só vê a carteira dela. */
  cobradorId: uuid('cobrador_id'),
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
    /** Onde trabalha (ajuda a entender o público dela). */
    localTrabalho: text('local_trabalho'),
    segmento: text('segmento'),
    /** Revendedora, líder, representante… (texto livre, vindo do Jueri ou da Aritana). */
    tipoRevendedor: text('tipo_revendedor'),
    /** Meta de vendas do mês, em centavos (0 = usa a do nível). */
    metaMensal: integer('meta_mensal').notNull().default(0),
    /** Comissão própria desta pessoa; vazio = usa a do nível ou a padrão. */
    comissaoPb: integer('comissao_pb'),
    redesSociais: text('redes_sociais'),
    /** Campos personalizados que não têm coluna própria (ex.: os do Jueri). */
    camposExtras: jsonb('campos_extras').$type<Record<string, string>>().notNull().default({}),
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
  idJueri: text('id_jueri'),
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
    /** EAN/GTIN de fábrica, quando diferente do código de barras usado na etiqueta. */
    ean: text('ean'),
    descricaoCompleta: text('descricao_completa'),
    tipoBanho: text('tipo_banho'),
    estoqueMaximo: integer('estoque_maximo'),
    observacao: text('observacao'),
    /** Composição do custo, em centavos: bruto, insumos, banhoOuro, banhoPrata, banhoRodio, verniz. */
    custos: jsonb('custos').$type<Record<string, number>>().notNull().default({}),
    lucroVarejoPb: integer('lucro_varejo_pb'),
    lucroAtacadoPb: integer('lucro_atacado_pb'),
    fcpPb: integer('fcp_pb'),
    impostoPb: integer('imposto_pb'),
    /** largura, altura, profundidade (mm), peso (g)… */
    medidas: jsonb('medidas').$type<Record<string, number>>().notNull().default({}),
    /** Marketplaces em que o produto é anunciado. */
    marketplaces: jsonb('marketplaces').$type<string[]>().notNull().default([]),
    camposExtras: jsonb('campos_extras').$type<Record<string, string>>().notNull().default({}),
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
    /** Pedido de origem no Jueri (maletas migradas). */
    idJueri: text('id_jueri'),
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

export const statusTitulo = pgEnum('status_titulo', ['aberto', 'pago', 'cancelado', 'protestado', 'renegociado']);

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
    /** Valor e vencimento do boleto/Pix atual (a segunda via pode ter outro vencimento e o valor com encargos). */
    cobrancaValor: integer('cobranca_valor'),
    cobrancaVencimento: date('cobranca_vencimento'),
    /** Parcela de um acordo de cobrança. */
    acordoId: uuid('acordo_id'),
    /** Título que entrou num acordo (fica "renegociado"; volta a aberto se o acordo quebrar). */
    renegociadoAcordoId: uuid('renegociado_acordo_id'),
    idJueri: text('id_jueri'),
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
    /** Quanto desta venda já voltou em devoluções (centavos). Venda líquida = total − devolvido. */
    devolvido: integer('devolvido').notNull().default(0),
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

// ───────────────────────── Formulários e marketing ─────────────────────────

/** Formulário montado pela equipe, com link público /f/<slug>. */
export const formularios = pgTable(
  'formularios',
  {
    id: id(),
    slug: text('slug').notNull(),
    titulo: text('titulo').notNull(),
    descricao: text('descricao'),
    campos: jsonb('campos').$type<CampoFormulario[]>().notNull(),
    /** O que fazer com cada resposta: nada, cadastrar/atualizar cliente ou abrir candidatura. */
    acao: text('acao').notNull().default('nenhuma'), // nenhuma | cliente | candidata
    /** Cliente: abre também um card neste funil do CRM (ex.: "Clientes"), que pode ser distribuído por localização. */
    funilId: uuid('funil_id').references((): AnyPgColumn => crmFunis.id, { onDelete: 'set null' }),
    mensagemFinal: text('mensagem_final'),
    /** Texto de autorização (LGPD) que a pessoa precisa marcar; vazio = não pede. */
    consentimento: text('consentimento'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ slug: uniqueIndex('formularios_slug_uq').on(t.slug) }),
);

export const formularioRespostas = pgTable(
  'formulario_respostas',
  {
    id: id(),
    formularioId: uuid('formulario_id').notNull().references(() => formularios.id, { onDelete: 'cascade' }),
    respostas: jsonb('respostas').$type<Record<string, unknown>>().notNull(),
    origem: jsonb('origem').$type<Record<string, string>>().notNull().default({}),
    pessoaId: uuid('pessoa_id').references(() => pessoas.id, { onDelete: 'set null' }),
    candidaturaId: uuid('candidatura_id').references(() => candidaturas.id, { onDelete: 'set null' }),
    criadoEm: criadoEm(),
  },
  (t) => ({ porFormulario: index('formulario_respostas_form_idx').on(t.formularioId, t.criadoEm) }),
);

/** Campanha de anúncio ou ação de divulgação: o investimento e o código usado nos links (utm_campaign). */
export const campanhas = pgTable(
  'campanhas',
  {
    id: id(),
    nome: text('nome').notNull(),
    canal: text('canal').notNull(), // meta | google | instagram | whatsapp | evento | outro
    utmCampaign: text('utm_campaign').notNull(),
    objetivo: text('objetivo').notNull().default('candidatas'), // candidatas | clientes
    inicio: date('inicio'),
    fim: date('fim'),
    /** Investimento lançado à mão (centavos). */
    investimento: integer('investimento').notNull().default(0),
    /** Investimento trazido do Meta Ads (centavos), quando ligado. */
    investimentoSincronizado: integer('investimento_sincronizado'),
    sincronizadoEm: timestamp('sincronizado_em', { withTimezone: true }),
    /** Id da campanha no Meta Ads, para buscar o gasto automaticamente. */
    metaCampanhaId: text('meta_campanha_id'),
    observacao: text('observacao'),
    ativa: boolean('ativa').notNull().default(true),
    criadoEm: criadoEm(),
  },
  (t) => ({ utm: uniqueIndex('campanhas_utm_uq').on(t.utmCampaign) }),
);

// ───────────────────────── Pontos e prêmios ─────────────────────────

/** Extrato de pontos da representante: créditos automáticos (acertos, parcelas), ajustes e resgates. */
export const pontos = pgTable(
  'pontos',
  {
    id: id(),
    pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id, { onDelete: 'cascade' }),
    pontos: integer('pontos').notNull(),
    motivo: text('motivo').notNull(),
    /** acerto | titulo | resgate | ajuste */
    origemTipo: text('origem_tipo').notNull(),
    origemId: uuid('origem_id'),
    /** Qual regra gerou (vendas, em_dia, meta, parcela, resgate, estorno): impede crédito duplicado. */
    regra: text('regra').notNull(),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => ({ unico: uniqueIndex('pontos_origem_regra_idx').on(t.origemTipo, t.origemId, t.regra), porPessoa: index('pontos_pessoa_idx').on(t.pessoaId) }),
);

export const premios = pgTable('premios', {
  id: id(),
  nome: text('nome').notNull(),
  descricao: text('descricao'),
  pontos: integer('pontos').notNull(),
  /** Quantos ainda há para resgatar (vazio = sem limite). */
  estoque: integer('estoque'),
  foto: text('foto'),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

export const resgates = pgTable('resgates', {
  id: id(),
  numero: serial('numero').notNull(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id, { onDelete: 'cascade' }),
  premioId: uuid('premio_id').notNull().references(() => premios.id),
  pontos: integer('pontos').notNull(),
  status: text('status').notNull().default('solicitado'), // solicitado | entregue | cancelado
  observacao: text('observacao'),
  atendidoPor: uuid('atendido_por').references(() => usuarios.id),
  atendidoEm: timestamp('atendido_em', { withTimezone: true }),
  criadoEm: criadoEm(),
});

// ───────────────────────── CRM: candidatas a representante ─────────────────────────

/** Quem preencheu o formulário "Quero ser revendedora" (ou foi cadastrada pela equipe), antes de virar representante. */
export const candidaturas = pgTable(
  'candidaturas',
  {
    id: id(),
    numero: serial('numero').notNull(),
    nome: text('nome').notNull(),
    telefone: text('telefone').notNull(),
    email: text('email'),
    cpf: text('cpf'),
    cidade: text('cidade'),
    uf: text('uf'),
    instagram: text('instagram'),
    modeloInteresse: text('modelo_interesse'), // consignado | revenda | afiliado | nao_sei
    experiencia: text('experiencia'),
    comoConheceu: text('como_conheceu'),
    indicadaPor: text('indicada_por'),
    /** utm_source, utm_medium, utm_campaign, utm_content, página de origem. */
    origem: jsonb('origem').$type<Record<string, string>>().notNull().default({}),
    etapa: text('etapa').notNull().default('nova'), // nova | contato | entrevista | documentos | aprovada | recusada
    responsavelId: uuid('responsavel_id').references(() => usuarios.id),
    motivoRecusa: text('motivo_recusa'),
    pessoaId: uuid('pessoa_id').references(() => pessoas.id, { onDelete: 'set null' }),
    consentimentoLgpd: boolean('consentimento_lgpd').notNull().default(false),
    proximoContato: date('proximo_contato'),
    criadoEm: criadoEm(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ porEtapa: index('candidaturas_etapa_idx').on(t.etapa) }),
);

export const candidaturaNotas = pgTable('candidatura_notas', {
  id: id(),
  candidaturaId: uuid('candidatura_id').notNull().references(() => candidaturas.id, { onDelete: 'cascade' }),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  texto: text('texto').notNull(),
  criadoEm: criadoEm(),
});

// ───────────────────────── Portal da representante ─────────────────────────

/** Código de acesso (6 dígitos por e-mail) ou link de acesso gerado pela matriz. Só o hash fica guardado. */
export const portalAcessos = pgTable(
  'portal_acessos',
  {
    id: id(),
    pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id, { onDelete: 'cascade' }),
    tipo: text('tipo').notNull(), // codigo | link
    hash: text('hash').notNull(),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    tentativas: integer('tentativas').notNull().default(0),
    usadoEm: timestamp('usado_em', { withTimezone: true }),
    criadoPor: uuid('criado_por').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => ({ porHash: index('portal_acessos_hash_idx').on(t.hash) }),
);

/** Peças que a representante pede pelo portal para a próxima maleta ou para incluir na atual. */
export const pedidosPecas = pgTable('pedidos_pecas', {
  id: id(),
  numero: serial('numero').notNull(),
  pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id, { onDelete: 'cascade' }),
  itens: jsonb('itens').$type<{ produtoId: string; referencia: string; descricao: string; quantidade: number }[]>().notNull(),
  observacao: text('observacao'),
  status: text('status').notNull().default('novo'), // novo | atendido | recusado
  resposta: text('resposta'),
  atendidoPor: uuid('atendido_por').references(() => usuarios.id),
  atendidoEm: timestamp('atendido_em', { withTimezone: true }),
  criadoEm: criadoEm(),
});

/** Credenciais das integrações preenchidas pela tela, cifradas (AES-256-GCM) com a CHAVE_CRIPTOGRAFIA do servidor. */
export const segredos = pgTable('segredos', {
  chave: text('chave').primaryKey(),
  valorCifrado: text('valor_cifrado').notNull(),
  /** Últimos caracteres, para a tela mostrar "••••1234" sem revelar o resto. */
  final: text('final'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
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
  (t) => ({ porEntidade: index('auditoria_entidade_idx').on(t.entidade, t.entidadeId), porData: index('auditoria_data_idx').on(t.criadoEm), porUsuario: index('auditoria_usuario_idx').on(t.usuarioId, t.criadoEm) }),
);

// ───────────────────────── CRM (funis, leads, WhatsApp) ─────────────────────────

/** Funis do CRM: recrutamento de revendedoras, clientes da loja, relacionamento com revendedoras e outros que a Aritana criar. */
export const crmFunis = pgTable('crm_funis', {
  id: id(),
  nome: text('nome').notNull(),
  /** recrutamento | clientes | revendedoras | outro — os três primeiros são alimentados sozinhos pelo sistema. */
  tipo: text('tipo').notNull().default('outro'),
  ordem: integer('ordem').notNull().default(0),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

export const crmEtapas = pgTable(
  'crm_etapas',
  {
    id: id(),
    funilId: uuid('funil_id').notNull().references(() => crmFunis.id, { onDelete: 'cascade' }),
    nome: text('nome').notNull(),
    cor: text('cor').notNull().default('#a68a64'),
    ordem: integer('ordem').notNull().default(0),
    /** aberta | ganho | perdido */
    tipo: text('tipo').notNull().default('aberta'),
    /** Chave fixa usada pelos funis automáticos (ex.: "atrasada"); vazia nas etapas criadas pela equipe. */
    chave: text('chave'),
  },
  (t) => ({ porFunil: index('crm_etapas_funil_idx').on(t.funilId, t.ordem) }),
);

/** Uma pessoa com quem se conversa (pelo telefone). Pode estar em vários funis. */
export const crmContatos = pgTable(
  'crm_contatos',
  {
    id: id(),
    nome: text('nome').notNull(),
    /** Só dígitos, com DDI (5527999998888). */
    telefone: text('telefone').notNull(),
    email: text('email'),
    pessoaId: uuid('pessoa_id').references(() => pessoas.id, { onDelete: 'set null' }),
    etiquetas: jsonb('etiquetas').$type<string[]>().notNull().default([]),
    /** Pediu para não receber disparos (respondeu SAIR ou foi marcado). */
    descadastrado: boolean('descadastrado').notNull().default(false),
    camposExtras: jsonb('campos_extras').$type<Record<string, string>>().notNull().default({}),
    criadoEm: criadoEm(),
  },
  (t) => ({ porTelefone: uniqueIndex('crm_contatos_telefone_idx').on(t.telefone), porPessoa: index('crm_contatos_pessoa_idx').on(t.pessoaId) }),
);

/** O card do lead (negócio) dentro de um funil. */
export const crmLeads = pgTable(
  'crm_leads',
  {
    id: id(),
    numero: serial('numero').notNull(),
    funilId: uuid('funil_id').notNull().references(() => crmFunis.id),
    etapaId: uuid('etapa_id').notNull().references(() => crmEtapas.id),
    contatoId: uuid('contato_id').notNull().references(() => crmContatos.id, { onDelete: 'cascade' }),
    titulo: text('titulo').notNull(),
    /** Valor previsto, em centavos. */
    valor: integer('valor').notNull().default(0),
    responsavelId: uuid('responsavel_id').references(() => usuarios.id, { onDelete: 'set null' }),
    etiquetas: jsonb('etiquetas').$type<string[]>().notNull().default([]),
    /** utm_source, utm_campaign, página… */
    origem: jsonb('origem').$type<Record<string, string>>().notNull().default({}),
    camposExtras: jsonb('campos_extras').$type<Record<string, string>>().notNull().default({}),
    /** aberto | ganho | perdido (segue o tipo da etapa). */
    status: text('status').notNull().default('aberto'),
    motivoPerda: text('motivo_perda'),
    candidaturaId: uuid('candidatura_id').references(() => candidaturas.id, { onDelete: 'set null' }),
    pessoaId: uuid('pessoa_id').references(() => pessoas.id, { onDelete: 'set null' }),
    /** Distribuição por localização: a consultora (ou líder) que recebeu o lead. */
    consultoraId: uuid('consultora_id').references(() => pessoas.id, { onDelete: 'set null' }),
    /** aguardando (ela ainda não aceitou) | aceito | sem_consultora | devolvido (voltou para a equipe) | concluido */
    distribuicao: text('distribuicao'),
    distribuidoEm: timestamp('distribuido_em', { withTimezone: true }),
    aceitoEm: timestamp('aceito_em', { withTimezone: true }),
    distanciaKm: doublePrecision('distancia_km'),
    /** Quem já recebeu e não aceitou a tempo (ou recusou): não recebe de novo. */
    jaOferecido: jsonb('ja_oferecido').$type<string[]>().notNull().default([]),
    entrouNaEtapaEm: timestamp('entrou_na_etapa_em', { withTimezone: true }).notNull().defaultNow(),
    ultimaInteracaoEm: timestamp('ultima_interacao_em', { withTimezone: true }),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({
    porEtapa: index('crm_leads_etapa_idx').on(t.funilId, t.etapaId),
    porContato: index('crm_leads_contato_idx').on(t.contatoId),
    porPessoa: index('crm_leads_pessoa_idx').on(t.pessoaId),
    porConsultora: index('crm_leads_consultora_idx').on(t.consultoraId, t.distribuicao),
  }),
);

/** Linha do tempo do card: notas, mudanças de etapa, gatilhos executados. */
export const crmEventos = pgTable(
  'crm_eventos',
  {
    id: id(),
    leadId: uuid('lead_id').notNull().references(() => crmLeads.id, { onDelete: 'cascade' }),
    /** nota | etapa | campo | tarefa | gatilho | sistema */
    tipo: text('tipo').notNull(),
    texto: text('texto').notNull(),
    dados: jsonb('dados'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    criadoEm: criadoEm(),
  },
  (t) => ({ porLead: index('crm_eventos_lead_idx').on(t.leadId, t.criadoEm) }),
);

export const crmTarefas = pgTable(
  'crm_tarefas',
  {
    id: id(),
    leadId: uuid('lead_id').notNull().references(() => crmLeads.id, { onDelete: 'cascade' }),
    titulo: text('titulo').notNull(),
    venceEm: timestamp('vence_em', { withTimezone: true }).notNull(),
    responsavelId: uuid('responsavel_id').references(() => usuarios.id, { onDelete: 'set null' }),
    feitaEm: timestamp('feita_em', { withTimezone: true }),
    criadoPor: uuid('criado_por').references(() => usuarios.id, { onDelete: 'set null' }),
    criadoEm: criadoEm(),
  },
  (t) => ({ abertas: index('crm_tarefas_abertas_idx').on(t.responsavelId, t.venceEm) }),
);

/** Números de WhatsApp ligados ao CRM: oficial (API Cloud da Meta) ou por QR code (Z-API). */
export const crmCanais = pgTable('crm_canais', {
  id: id(),
  nome: text('nome').notNull(),
  /** oficial | qrcode */
  tipo: text('tipo').notNull(),
  /** Número em dígitos, quando conhecido. */
  numero: text('numero'),
  /** Credenciais, com os campos secretos cifrados (AES-256-GCM). */
  config: jsonb('config').$type<Record<string, string>>().notNull().default({}),
  /** Segredo do endereço de webhook (Z-API não assina as chamadas). */
  tokenWebhook: text('token_webhook').notNull(),
  /** Atendente dono do número (QR code de uma pessoa da equipe); vazio = número da empresa. */
  usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  /** Quem pode atender por este número (vazio = toda a equipe com acesso ao CRM). */
  atendentes: jsonb('atendentes').$type<string[]>().notNull().default([]),
  /** Funil onde entra o card de quem escreve pela primeira vez (vazio = não cria card). */
  funilEntradaId: uuid('funil_entrada_id').references(() => crmFunis.id, { onDelete: 'set null' }),
  ativo: boolean('ativo').notNull().default(true),
  /** Excluído pela equipe: some da tela e não manda nem recebe mais; as conversas antigas continuam no histórico. */
  excluidoEm: timestamp('excluido_em', { withTimezone: true }),
  /** Última vez que o WhatsApp avisou o sistema de alguma coisa por este número (para conferir se as mensagens estão chegando). */
  ultimoWebhookEm: timestamp('ultimo_webhook_em', { withTimezone: true }),
  criadoEm: criadoEm(),
});

export const crmConversas = pgTable(
  'crm_conversas',
  {
    id: id(),
    contatoId: uuid('contato_id').notNull().references(() => crmContatos.id, { onDelete: 'cascade' }),
    canalId: uuid('canal_id').notNull().references(() => crmCanais.id, { onDelete: 'cascade' }),
    atendenteId: uuid('atendente_id').references(() => usuarios.id, { onDelete: 'set null' }),
    /** fila (esperando alguém pegar) | atendimento (com um atendente) | resolvida */
    status: text('status').notNull().default('fila'),
    /** Desde quando está esperando na fila. */
    filaDesde: timestamp('fila_desde', { withTimezone: true }),
    pegaEm: timestamp('pega_em', { withTimezone: true }),
    naoLidas: integer('nao_lidas').notNull().default(0),
    ultimaMensagem: text('ultima_mensagem'),
    ultimaMensagemEm: timestamp('ultima_mensagem_em', { withTimezone: true }),
    /** Última mensagem recebida do contato: abre a janela de 24h do WhatsApp oficial. */
    ultimaEntradaEm: timestamp('ultima_entrada_em', { withTimezone: true }),
    /** Fixada no topo da lista de conversas. */
    fixada: boolean('fixada').notNull().default(false),
    /** Agente de IA nesta conversa: vazio = segue a configuração (atende enquanto está na fila); true = ligado à mão; false = desligado (alguém da equipe assumiu ou a IA passou a vez). */
    iaAtiva: boolean('ia_ativa'),
    /** Quantas respostas a IA já deu desde que a conversa entrou na fila (limite para não ficar em círculo). */
    iaRespostas: integer('ia_respostas').notNull().default(0),
    /** Especialista de IA que está atendendo (a recepção escolhe; troca quando o assunto muda). */
    iaAgenteId: uuid('ia_agente_id').references((): AnyPgColumn => iaAgentes.id, { onDelete: 'set null' }),
    /** Quantas vezes a conversa passou de um especialista para outro neste atendimento. */
    iaTransferencias: integer('ia_transferencias').notNull().default(0),
    criadoEm: criadoEm(),
  },
  (t) => ({ unica: uniqueIndex('crm_conversas_contato_canal_idx').on(t.contatoId, t.canalId), recentes: index('crm_conversas_recentes_idx').on(t.ultimaMensagemEm), porStatus: index('crm_conversas_status_idx').on(t.status, t.atendenteId) }),
);

export const crmMensagens = pgTable(
  'crm_mensagens',
  {
    id: id(),
    conversaId: uuid('conversa_id').notNull().references(() => crmConversas.id, { onDelete: 'cascade' }),
    /** entrada | saida */
    direcao: text('direcao').notNull(),
    /** texto | imagem | audio | video | documento | template | localizacao | outro */
    tipo: text('tipo').notNull().default('texto'),
    texto: text('texto'),
    /** Arquivo guardado no servidor (/api/crm/midia/...) e o nome original. */
    midia: text('midia'),
    midiaNome: text('midia_nome'),
    templateNome: text('template_nome'),
    /** pendente | enviada | entregue | lida | falhou | recebida */
    status: text('status').notNull().default('pendente'),
    erro: text('erro'),
    idExterno: text('id_externo'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    /** Origem automática: gatilho ou disparo em massa. */
    gatilhoId: uuid('gatilho_id'),
    disparoId: uuid('disparo_id'),
    /** Mensagem da mesma conversa que esta responde (citação). */
    citadaId: uuid('citada_id'),
    /** Reações: de quem ('contato' ou 'equipe') e o emoji. Uma por lado. */
    reacoes: jsonb('reacoes').$type<{ de: 'contato' | 'equipe'; emoji: string }[]>().notNull().default([]),
    /** Apagada para todos (o texto e a mídia somem da tela). */
    apagadaEm: timestamp('apagada_em', { withTimezone: true }),
    /** Escrita pelo agente de IA. */
    ia: boolean('ia').notNull().default(false),
    /** Áudio transcrito pela IA: o texto, a situação (pendente | feita | falhou) e o motivo da falha. */
    transcricao: text('transcricao'),
    transcricaoStatus: text('transcricao_status'),
    transcricaoErro: text('transcricao_erro'),
    criadoEm: criadoEm(),
  },
  (t) => ({ porConversa: index('crm_mensagens_conversa_idx').on(t.conversaId, t.criadoEm), porExterno: index('crm_mensagens_externo_idx').on(t.idExterno) }),
);

/** Templates aprovados na Meta (sincronizados) e modelos de mensagem livres (usados no QR code e dentro das 24h). */
export const crmTemplates = pgTable('crm_templates', {
  id: id(),
  /** Vazio = modelo livre, serve para qualquer canal. */
  canalId: uuid('canal_id').references(() => crmCanais.id, { onDelete: 'cascade' }),
  nome: text('nome').notNull(),
  /** meta | livre */
  tipo: text('tipo').notNull().default('livre'),
  idioma: text('idioma').notNull().default('pt_BR'),
  categoria: text('categoria'),
  /** Texto com {{1}}, {{2}}… (Meta) ou {{nome}}, {{primeiro_nome}}… (livre). */
  texto: text('texto').notNull(),
  componentes: jsonb('componentes'),
  /** APPROVED | PENDING | REJECTED (Meta) ou ATIVO (livre). */
  status: text('status').notNull().default('ATIVO'),
  /** Para cada {{n}} do template da Meta, de onde vem o valor: "nome", "primeiro_nome", "telefone", "etapa" ou texto fixo. */
  variaveis: jsonb('variaveis').$type<string[]>().notNull().default([]),
  atualizadoEm: atualizadoEm(),
});

export const crmRespostasRapidas = pgTable('crm_respostas_rapidas', {
  id: id(),
  atalho: text('atalho').notNull().unique(),
  texto: text('texto').notNull(),
  criadoEm: criadoEm(),
});

/** Automação: quando acontece X (no funil/etapa), faz as ações em ordem, com esperas. */
export const crmGatilhos = pgTable('crm_gatilhos', {
  id: id(),
  nome: text('nome').notNull(),
  funilId: uuid('funil_id').references(() => crmFunis.id, { onDelete: 'cascade' }),
  /** lead_criado | entrou_etapa | mensagem_recebida | sem_resposta | etiqueta_adicionada */
  evento: text('evento').notNull(),
  etapaId: uuid('etapa_id').references(() => crmEtapas.id, { onDelete: 'cascade' }),
  /** Horas sem resposta (sem_resposta) ou a etiqueta (etiqueta_adicionada) ou palavra-chave (mensagem_recebida). */
  parametro: text('parametro'),
  /** [{ tipo: 'esperar' | 'enviar_template' | 'enviar_mensagem' | 'mover_etapa' | 'atribuir' | 'adicionar_etiqueta' | 'criar_tarefa', ... }] */
  acoes: jsonb('acoes').$type<Record<string, unknown>[]>().notNull().default([]),
  ativo: boolean('ativo').notNull().default(true),
  execucoes: integer('execucoes').notNull().default(0),
  criadoEm: criadoEm(),
});

/** Fila das ações de gatilho (as que têm espera ficam agendadas aqui). */
export const crmFila = pgTable(
  'crm_fila',
  {
    id: id(),
    gatilhoId: uuid('gatilho_id').notNull().references(() => crmGatilhos.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').notNull().references(() => crmLeads.id, { onDelete: 'cascade' }),
    /** Índice da próxima ação a executar. */
    passo: integer('passo').notNull().default(0),
    executarEm: timestamp('executar_em', { withTimezone: true }).notNull().defaultNow(),
    /** pendente | feito | cancelado | erro */
    status: text('status').notNull().default('pendente'),
    erro: text('erro'),
    /** Etapa em que o lead estava quando o gatilho começou (gatilho de etapa para se o lead sair dela). */
    etapaId: uuid('etapa_id'),
    criadoEm: criadoEm(),
  },
  (t) => ({ pendentes: index('crm_fila_pendentes_idx').on(t.status, t.executarEm) }),
);

/** Disparo em massa para uma lista filtrada de contatos. */
export const crmDisparos = pgTable('crm_disparos', {
  id: id(),
  nome: text('nome').notNull(),
  canalId: uuid('canal_id').notNull().references(() => crmCanais.id),
  templateId: uuid('template_id').references(() => crmTemplates.id, { onDelete: 'set null' }),
  /** Texto livre (só no QR code). */
  texto: text('texto'),
  /** { funilId, etapaIds, etiquetas, somenteAbertos } */
  filtro: jsonb('filtro').$type<Record<string, unknown>>().notNull().default({}),
  /** rascunho | agendado | enviando | pausado | concluido | cancelado */
  status: text('status').notNull().default('rascunho'),
  agendadoPara: timestamp('agendado_para', { withTimezone: true }),
  /** Mensagens por minuto (protege o número de bloqueio). */
  ritmo: integer('ritmo').notNull().default(20),
  total: integer('total').notNull().default(0),
  enviados: integer('enviados').notNull().default(0),
  falhas: integer('falhas').notNull().default(0),
  usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  criadoEm: criadoEm(),
  concluidoEm: timestamp('concluido_em', { withTimezone: true }),
});

export const crmDisparoDestinos = pgTable(
  'crm_disparo_destinos',
  {
    id: id(),
    disparoId: uuid('disparo_id').notNull().references(() => crmDisparos.id, { onDelete: 'cascade' }),
    contatoId: uuid('contato_id').notNull().references(() => crmContatos.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => crmLeads.id, { onDelete: 'set null' }),
    /** pendente | enviada | entregue | lida | respondeu | falhou | pulado */
    status: text('status').notNull().default('pendente'),
    erro: text('erro'),
    mensagemId: uuid('mensagem_id'),
    enviadoEm: timestamp('enviado_em', { withTimezone: true }),
  },
  (t) => ({ unico: uniqueIndex('crm_disparo_destino_idx').on(t.disparoId, t.contatoId), pendentes: index('crm_disparo_pendentes_idx').on(t.disparoId, t.status) }),
);

/** Campos personalizados (como no Kommo): do contato (a pessoa) ou do card (o negócio, opcionalmente só de um funil). */
export const crmCampos = pgTable('crm_campos', {
  id: id(),
  /** contato | lead */
  entidade: text('entidade').notNull(),
  nome: text('nome').notNull(),
  /** texto | textao | numero | moeda | data | lista | multipla | telefone | email | url | sim_nao */
  tipo: text('tipo').notNull().default('texto'),
  opcoes: jsonb('opcoes').$type<string[]>().notNull().default([]),
  /** Só para cards deste funil (vazio = todos). */
  funilId: uuid('funil_id').references(() => crmFunis.id, { onDelete: 'cascade' }),
  ordem: integer('ordem').notNull().default(0),
  /** Aparece no cartãozinho do quadro (kanban). */
  noQuadro: boolean('no_quadro').notNull().default(false),
  criadoEm: criadoEm(),
});

/** Ramal do softphone de cada atendente (SIP por WebSocket, ligação pelo navegador). */
export const crmRamais = pgTable('crm_ramais', {
  usuarioId: uuid('usuario_id').primaryKey().references(() => usuarios.id, { onDelete: 'cascade' }),
  /** wss://servidor:7443 */
  servidor: text('servidor').notNull(),
  /** sip:1001@dominio */
  usuarioSip: text('usuario_sip').notNull(),
  /** Senha do ramal, cifrada. */
  senhaCifrada: text('senha_cifrada').notNull(),
  /** Nome que aparece para quem recebe (opcional). */
  nomeExibicao: text('nome_exibicao'),
  /** Prefixo para ligar para fora (ex.: 0). */
  prefixo: text('prefixo'),
  ativo: boolean('ativo').notNull().default(true),
  atualizadoEm: atualizadoEm(),
});

// ───────────── RH e ponto eletrônico (Portaria MTP 671/2021, REP-P) ─────────────

/** Horários de trabalho. `dias` tem 7 posições (0 = domingo); null = folga. */
export const rhEscalas = pgTable('rh_escalas', {
  id: id(),
  nome: text('nome').notNull(),
  dias: jsonb('dias').$type<({ entrada: string; saidaIntervalo?: string | null; voltaIntervalo?: string | null; saida: string } | null)[]>().notNull(),
  toleranciaMarcacao: integer('tolerancia_marcacao').notNull().default(5),
  toleranciaDia: integer('tolerancia_dia').notNull().default(10),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

/** Locais onde o ponto pode ser batido pelo celular (cerca pelo GPS). */
export const rhLocais = pgTable('rh_locais', {
  id: id(),
  nome: text('nome').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  raioM: integer('raio_m').notNull().default(150),
  ativo: boolean('ativo').notNull().default(true),
});

export const rhFuncionarios = pgTable(
  'rh_funcionarios',
  {
    id: id(),
    /** Acesso ao sistema (o mesmo login para bater ponto e, se o grupo permitir, usar o resto). */
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    /** Empregador (CNPJ que assina a carteira). */
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    nome: text('nome').notNull(),
    nomeSocial: text('nome_social'),
    cpf: text('cpf').notNull(),
    pis: text('pis'),
    rg: text('rg'),
    nascimento: date('nascimento'),
    telefone: text('telefone'),
    email: text('email'),
    cep: text('cep'),
    endereco: text('endereco'),
    cidade: text('cidade'),
    uf: text('uf'),
    cargo: text('cargo'),
    departamento: text('departamento'),
    /** clt | experiencia | estagio | temporario | aprendiz | pj | autonomo */
    tipoContrato: text('tipo_contrato').notNull().default('clt'),
    salario: integer('salario'),
    ctps: text('ctps'),
    matriculaEsocial: text('matricula_esocial'),
    dadosBancarios: jsonb('dados_bancarios').$type<Record<string, string>>().notNull().default({}),
    escalaId: uuid('escala_id').references(() => rhEscalas.id),
    dataAdmissao: date('data_admissao').notNull(),
    dataDemissao: date('data_demissao'),
    motivoDemissao: text('motivo_demissao'),
    /** ativo | afastado | desligado */
    status: text('status').notNull().default('ativo'),
    /** Quem não bate ponto (sócio, cargo de confiança do art. 62, PJ). */
    batePonto: boolean('bate_ponto').notNull().default(true),
    camposExtras: jsonb('campos_extras').$type<Record<string, string>>().notNull().default({}),
    observacao: text('observacao'),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ cpf: uniqueIndex('rh_funcionarios_cpf_idx').on(t.cpf), usuario: uniqueIndex('rh_funcionarios_usuario_idx').on(t.usuarioId) }),
);

/** Sequência do REP-P por empregador: último NSR e o hash encadeado. */
export const rhPontoEmpresas = pgTable('rh_ponto_empresas', {
  empresaId: uuid('empresa_id').primaryKey().references(() => empresas.id),
  ultimoNsr: integer('ultimo_nsr').notNull().default(0),
  ultimoHash: text('ultimo_hash'),
});

/**
 * Registros do REP-P, um por NSR (tipos do AFD): 7 = marcação, 5 = inclusão/alteração/exclusão de empregado,
 * 2 = mudança do empregador, 6 = evento. NUNCA são alterados nem apagados (o banco recusa).
 * Correções viram tratamentos (rh_tratamentos), que entram no AEJ e no espelho.
 */
export const rhRegistros = pgTable(
  'rh_registros',
  {
    id: id(),
    empresaId: uuid('empresa_id').notNull().references(() => empresas.id),
    nsr: integer('nsr').notNull(),
    tipo: integer('tipo').notNull(),
    gravadoEm: timestamp('gravado_em', { withTimezone: true }).notNull(),
    funcionarioId: uuid('funcionario_id').references(() => rhFuncionarios.id),
    cpf: text('cpf'),
    /** Marcação: data e hora (do servidor, não do aparelho). */
    marcadoEm: timestamp('marcado_em', { withTimezone: true }),
    /** 01 aplicativo, 02 navegador, 03 desktop… */
    coletor: text('coletor'),
    online: boolean('online').notNull().default(true),
    hash: text('hash'),
    dados: jsonb('dados').$type<Record<string, unknown>>().notNull().default({}),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    precisaoM: integer('precisao_m'),
    localId: uuid('local_id').references(() => rhLocais.id),
    foraDoLocal: boolean('fora_do_local'),
    foto: text('foto'),
    ip: text('ip'),
    aparelho: text('aparelho'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
  },
  (t) => ({ nsr: uniqueIndex('rh_registros_nsr_idx').on(t.empresaId, t.nsr), porFunc: index('rh_registros_func_idx').on(t.funcionarioId, t.marcadoEm) }),
);

/** Ajustes do ponto feitos pela empresa: incluir uma batida esquecida ou desconsiderar uma batida, sempre com motivo. */
export const rhTratamentos = pgTable('rh_tratamentos', {
  id: id(),
  funcionarioId: uuid('funcionario_id').notNull().references(() => rhFuncionarios.id),
  /** inclusao | desconsiderar */
  tipo: text('tipo').notNull(),
  registroId: uuid('registro_id').references(() => rhRegistros.id),
  marcadoEm: timestamp('marcado_em', { withTimezone: true }),
  motivo: text('motivo').notNull(),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

/** Faltas, atestados, férias, folgas, afastamentos. */
export const rhOcorrencias = pgTable('rh_ocorrencias', {
  id: id(),
  funcionarioId: uuid('funcionario_id').notNull().references(() => rhFuncionarios.id),
  tipo: text('tipo').notNull(),
  de: date('de').notNull(),
  ate: date('ate').notNull(),
  /** O dia conta como trabalhado (atestado, férias, folga compensada…). */
  abona: boolean('abona').notNull().default(true),
  observacao: text('observacao'),
  documentoId: uuid('documento_id'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

/** Pasta do funcionário: contrato, contracheques, cartas, exames, atestados… */
export const rhDocumentos = pgTable(
  'rh_documentos',
  {
    id: id(),
    funcionarioId: uuid('funcionario_id').notNull().references(() => rhFuncionarios.id),
    tipo: text('tipo').notNull(),
    titulo: text('titulo').notNull(),
    /** Mês de referência (contracheque, folha): AAAA-MM. */
    competencia: text('competencia'),
    data: date('data'),
    /** Exame periódico, CNH do motoboy, contrato de experiência: quando vence. */
    validade: date('validade'),
    arquivo: text('arquivo').notNull(),
    nomeArquivo: text('nome_arquivo').notNull(),
    mime: text('mime').notNull(),
    tamanho: integer('tamanho').notNull(),
    /** O funcionário vê no portal dele. */
    visivelFuncionario: boolean('visivel_funcionario').notNull().default(true),
    /** Ciência do funcionário (recebi/li), com IP. */
    cienteEm: timestamp('ciente_em', { withTimezone: true }),
    cienteIp: text('ciente_ip'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => ({ porFunc: index('rh_documentos_func_idx').on(t.funcionarioId, t.tipo) }),
);

export const rhFeriados = pgTable('rh_feriados', {
  id: id(),
  data: date('data').notNull().unique(),
  nome: text('nome').notNull(),
});

/** Fechamento do mês: a foto do espelho de ponto, com a ciência do funcionário. */
export const rhFechamentos = pgTable(
  'rh_fechamentos',
  {
    id: id(),
    funcionarioId: uuid('funcionario_id').notNull().references(() => rhFuncionarios.id),
    competencia: text('competencia').notNull(),
    espelho: jsonb('espelho').notNull(),
    fechadoEm: timestamp('fechado_em', { withTimezone: true }).notNull().defaultNow(),
    fechadoPor: uuid('fechado_por').references(() => usuarios.id),
    cienteEm: timestamp('ciente_em', { withTimezone: true }),
    cienteIp: text('ciente_ip'),
  },
  (t) => ({ uq: uniqueIndex('rh_fechamentos_uq').on(t.funcionarioId, t.competencia) }),
);

/** O que foi mandado para a contabilidade, por onde e quando. */
export const rhEnvios = pgTable('rh_envios', {
  id: id(),
  competencia: text('competencia').notNull(),
  canal: text('canal').notNull(),
  destino: text('destino').notNull(),
  itens: jsonb('itens').$type<string[]>().notNull(),
  arquivos: jsonb('arquivos').$type<{ nome: string; tamanho: number }[]>().notNull().default([]),
  mensagem: text('mensagem'),
  status: text('status').notNull(),
  erro: text('erro'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  criadoEm: criadoEm(),
});

/**
 * Metas do mês da empresa. tipo: faturamento | rede | lojas | eventos | local (com localId) | novas_revendedoras | consultoras_ativas.
 * Valores em centavos (contagens para novas_revendedoras e consultoras_ativas).
 */
export const metas = pgTable(
  'metas',
  {
    id: id(),
    competencia: text('competencia').notNull(),
    tipo: text('tipo').notNull(),
    localId: uuid('local_id').references(() => locaisEstoque.id),
    valor: integer('valor').notNull(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ porMes: index('metas_mes_idx').on(t.competencia) }),
);

/**
 * Histórico do Jueri (só para relatórios): acertos já baixados lá antes da virada.
 * Não mexe em estoque, maletas nem financeiro; guarda só números por acerto e por produto.
 */
export const jueriHistorico = pgTable(
  'jueri_historico',
  {
    id: id(),
    /** "ped:123" (pedido baixado no Jueri). */
    idJueri: text('id_jueri').notNull(),
    pessoaId: uuid('pessoa_id').references(() => pessoas.id, { onDelete: 'set null' }),
    revendedorJueri: text('revendedor_jueri'),
    numero: text('numero'),
    data: date('data').notNull(),
    pecasEnviadas: integer('pecas_enviadas').notNull().default(0),
    pecasVendidas: integer('pecas_vendidas').notNull().default(0),
    pecasDevolvidas: integer('pecas_devolvidas').notNull().default(0),
    pecasPerdidas: integer('pecas_perdidas').notNull().default(0),
    valorEnviado: bigint('valor_enviado', { mode: 'number' }).notNull().default(0),
    valorVendido: bigint('valor_vendido', { mode: 'number' }).notNull().default(0),
    comissao: bigint('comissao', { mode: 'number' }),
    importadoEm: criadoEm(),
  },
  (t) => ({ uq: uniqueIndex('jueri_historico_uq').on(t.idJueri), porData: index('jueri_historico_data_idx').on(t.data), porPessoa: index('jueri_historico_pessoa_idx').on(t.pessoaId) }),
);

export const jueriHistoricoItens = pgTable(
  'jueri_historico_itens',
  {
    id: id(),
    historicoId: uuid('historico_id').notNull().references(() => jueriHistorico.id, { onDelete: 'cascade' }),
    produtoId: uuid('produto_id').references(() => produtos.id, { onDelete: 'set null' }),
    produtoJueri: text('produto_jueri'),
    enviadas: integer('enviadas').notNull().default(0),
    vendidas: integer('vendidas').notNull().default(0),
    devolvidas: integer('devolvidas').notNull().default(0),
    precoUnitario: integer('preco_unitario'),
  },
  (t) => ({ porHist: index('jueri_hist_itens_idx').on(t.historicoId), porProduto: index('jueri_hist_itens_prod_idx').on(t.produtoId) }),
);

/** Certificado A1 (e-CNPJ) de cada empresa para assinar o AFD e o AEJ. Arquivo e senha guardados cifrados. */
export const rhCertificados = pgTable('rh_certificados', {
  empresaId: uuid('empresa_id').primaryKey().references(() => empresas.id),
  pfxCifrado: text('pfx_cifrado').notNull(),
  senhaCifrada: text('senha_cifrada').notNull(),
  titular: text('titular').notNull(),
  cnpj: text('cnpj'),
  emissor: text('emissor').notNull(),
  serie: text('serie').notNull(),
  validoAte: timestamp('valido_ate', { withTimezone: true }).notNull(),
  icpBrasil: boolean('icp_brasil').notNull(),
  usuarioId: uuid('usuario_id').references(() => usuarios.id),
  atualizadoEm: atualizadoEm(),
});

/**
 * Investimento em marketing por mês: lançado à mão (agência, impulsionamento, influenciadora, brindes)
 * ou trazido do Meta Ads mês a mês. Com campanha, entra no custo dela; sem campanha, só no custo geral do mês.
 */
export const marketingGastos = pgTable(
  'marketing_gastos',
  {
    id: id(),
    competencia: text('competencia').notNull(),
    campanhaId: uuid('campanha_id').references(() => campanhas.id, { onDelete: 'cascade' }),
    descricao: text('descricao').notNull(),
    valor: integer('valor').notNull(),
    origem: text('origem').notNull().default('manual'), // manual | meta
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => ({ porMes: index('marketing_gastos_mes_idx').on(t.competencia), porCampanha: index('marketing_gastos_campanha_idx').on(t.campanhaId) }),
);

/**
 * Distribuição por localização, por funil: o lead novo vai para a consultora (ou líder) ativa mais perto,
 * que tem um prazo para aceitar; sem aceite, passa para a próxima; esgotadas as tentativas, volta para a equipe.
 */
export const crmDistribuicoes = pgTable('crm_distribuicoes', {
  funilId: uuid('funil_id').primaryKey().references(() => crmFunis.id, { onDelete: 'cascade' }),
  ativo: boolean('ativo').notNull().default(true),
  /** consultoras | lideres */
  destino: text('destino').notNull().default('consultoras'),
  raioKm: integer('raio_km').notNull().default(50),
  prazoMinutos: integer('prazo_minutos').notNull().default(60),
  maxTentativas: integer('max_tentativas').notNull().default(3),
  /** Cada uma recebe até isto de leads em aberto ao mesmo tempo. */
  maxAbertos: integer('max_abertos').notNull().default(10),
  /** Só quem está com maleta aberta (está trabalhando agora). */
  soComMaleta: boolean('so_com_maleta').notNull().default(false),
  avisarWhatsapp: boolean('avisar_whatsapp').notNull().default(true),
  canalId: uuid('canal_id').references(() => crmCanais.id, { onDelete: 'set null' }),
  atualizadoEm: atualizadoEm(),
});

/**
 * Agenda: entrevistas de candidatas, acertos por vídeo, retiradas de maleta e reuniões.
 * Online com o Google conectado: o evento vai para a agenda do Google da Aritana com link do Meet.
 */
export const agendaCompromissos = pgTable(
  'agenda_compromissos',
  {
    id: id(),
    /** entrevista | acerto_video | retirada | reuniao | outro */
    tipo: text('tipo').notNull(),
    titulo: text('titulo').notNull(),
    inicio: timestamp('inicio', { withTimezone: true }).notNull(),
    fim: timestamp('fim', { withTimezone: true }).notNull(),
    online: boolean('online').notNull().default(false),
    local: text('local'),
    /** Link do Meet (gerado pelo Google) ou colado à mão (Zoom, Meet de outra conta). */
    link: text('link'),
    googleEventoId: text('google_evento_id'),
    responsavelId: uuid('responsavel_id').references(() => usuarios.id, { onDelete: 'set null' }),
    pessoaId: uuid('pessoa_id').references(() => pessoas.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => crmLeads.id, { onDelete: 'set null' }),
    maletaId: uuid('maleta_id').references(() => maletas.id, { onDelete: 'set null' }),
    /** Para quem vai o lembrete quando não há pessoa cadastrada (candidata, cliente do CRM). */
    convidadoNome: text('convidado_nome'),
    convidadoTelefone: text('convidado_telefone'),
    observacao: text('observacao'),
    /** marcado | confirmado | realizado | faltou | cancelado */
    status: text('status').notNull().default('marcado'),
    avisar: boolean('avisar').notNull().default(true),
    lembreteDiaEm: timestamp('lembrete_dia_em', { withTimezone: true }),
    lembreteHoraEm: timestamp('lembrete_hora_em', { withTimezone: true }),
    confirmadoEm: timestamp('confirmado_em', { withTimezone: true }),
    criadoPor: uuid('criado_por').references(() => usuarios.id),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ porInicio: index('agenda_inicio_idx').on(t.inicio), porResp: index('agenda_resp_idx').on(t.responsavelId, t.inicio), porPessoa: index('agenda_pessoa_idx').on(t.pessoaId), porLead: index('agenda_lead_idx').on(t.leadId) }),
);

/**
 * Pedido feito pela cliente no catálogo (link) da consultora ou da afiliada.
 * origem "maleta": sai da maleta dela, ela entrega e as peças ficam pré-baixadas como vendidas.
 * origem "matriz": sai do estoque da matriz; a equipe fatura (vira venda) e a consultora ganha comissão no mês.
 */
export const pedidosLink = pgTable(
  'pedidos_link',
  {
    id: id(),
    numero: serial('numero').notNull(),
    pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id),
    origem: text('origem').notNull(), // maleta | matriz
    clienteNome: text('cliente_nome').notNull(),
    clienteTelefone: text('cliente_telefone').notNull(),
    clienteCidade: text('cliente_cidade'),
    entrega: text('entrega').notNull().default('combinar'), // retirar | entregar | combinar
    endereco: text('endereco'),
    observacao: text('observacao'),
    itens: jsonb('itens').$type<{ produtoId: string; referencia: string; descricao: string; preco: number; quantidade: number }[]>().notNull(),
    total: integer('total').notNull(),
    /** novo | confirmado | entregue | cancelado */
    status: text('status').notNull().default('novo'),
    vendaId: uuid('venda_id').references(() => vendas.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => crmLeads.id, { onDelete: 'set null' }),
    motivoCancelamento: text('motivo_cancelamento'),
    origemUtm: jsonb('origem_utm').$type<Record<string, string>>().notNull().default({}),
    confirmadoEm: timestamp('confirmado_em', { withTimezone: true }),
    entregueEm: timestamp('entregue_em', { withTimezone: true }),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ porPessoa: index('pedidos_link_pessoa_idx').on(t.pessoaId, t.status), porData: index('pedidos_link_data_idx').on(t.criadoEm) }),
);

/** Celulares da representante com o app instalado (token de notificação do Firebase/Android ou da Apple/iOS). */
export const portalDispositivos = pgTable(
  'portal_dispositivos',
  {
    id: id(),
    pessoaId: uuid('pessoa_id').notNull().references(() => pessoas.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    plataforma: text('plataforma').notNull(), // android | ios
    criadoEm: criadoEm(),
    ultimoUsoEm: timestamp('ultimo_uso_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uq: uniqueIndex('portal_dispositivos_token_uq').on(t.token), porPessoa: index('portal_dispositivos_pessoa_idx').on(t.pessoaId) }),
);

/** Leads de formulário do Meta já trazidos para o CRM (cada um entra uma vez só). */
export const metaLeads = pgTable(
  'meta_leads',
  {
    leadgenId: text('leadgen_id').primaryKey(),
    formId: text('form_id').notNull(),
    leadId: uuid('lead_id').references(() => crmLeads.id, { onDelete: 'set null' }),
    recebidoEm: timestamp('recebido_em', { withTimezone: true }).notNull(),
    criadoEm: criadoEm(),
  },
  (t) => ({ porForm: index('meta_leads_form_idx').on(t.formId) }),
);

/** Cada chamada à IA: para acompanhar o uso (e o custo) por recurso. */
export const iaUsos = pgTable(
  'ia_usos',
  {
    id: id(),
    /** agente | sugestao | reconhecer_peca | maleta | foto | transcricao | teste */
    recurso: text('recurso').notNull(),
    modelo: text('modelo').notNull(),
    tokensEntrada: integer('tokens_entrada').notNull().default(0),
    tokensSaida: integer('tokens_saida').notNull().default(0),
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    criadoEm: criadoEm(),
  },
  (t) => ({ porDia: index('ia_usos_dia_idx').on(t.criadoEm) }),
);

// ───────────────────────── Cobrança ─────────────────────────

/** Quem cobra: funcionário da Aritana ou empresa terceirizada. */
export const cobradores = pgTable('cobradores', {
  id: id(),
  nome: text('nome').notNull(),
  /** interno | terceirizada */
  tipo: text('tipo').notNull().default('interno'),
  documento: text('documento'),
  telefone: text('telefone'),
  email: text('email'),
  /** Comissão sobre o que for recuperado (pontos-base; 1000 = 10%). */
  comissaoPb: integer('comissao_pb').notNull().default(0),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: criadoEm(),
});

/** Devedor na carteira de um cobrador (a carteira é por pessoa, com todos os títulos dela). */
export const cobrancaCarteira = pgTable('cobranca_carteira', {
  pessoaId: uuid('pessoa_id')
    .primaryKey()
    .references(() => pessoas.id, { onDelete: 'cascade' }),
  cobradorId: uuid('cobrador_id').references(() => cobradores.id, { onDelete: 'set null' }),
  /** Desde quando está com este cobrador (a comissão conta o que foi pago depois). */
  desde: timestamp('desde', { withTimezone: true }).notNull().defaultNow(),
  /** Régua pausada (em negociação, ação judicial…). */
  pausada: boolean('pausada').notNull().default(false),
  motivoPausa: text('motivo_pausa'),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Histórico de contatos com o devedor e promessas de pagamento. */
export const cobrancaContatos = pgTable(
  'cobranca_contatos',
  {
    id: id(),
    pessoaId: uuid('pessoa_id')
      .notNull()
      .references(() => pessoas.id, { onDelete: 'cascade' }),
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    cobradorId: uuid('cobrador_id').references(() => cobradores.id, { onDelete: 'set null' }),
    /** ligacao | whatsapp | email | visita | nota | regua | sistema */
    tipo: text('tipo').notNull(),
    texto: text('texto').notNull(),
    promessaData: date('promessa_data'),
    promessaValor: integer('promessa_valor'),
    /** aberta | cumprida | quebrada */
    promessaStatus: text('promessa_status'),
    retornoEm: date('retorno_em'),
    criadoEm: criadoEm(),
  },
  (t) => ({ porPessoa: index('cobranca_contatos_pessoa_idx').on(t.pessoaId, t.criadoEm) }),
);

/** Acordo (renegociação): os títulos originais ficam "renegociados" e nascem as parcelas. */
export const cobrancaAcordos = pgTable('cobranca_acordos', {
  id: id(),
  numero: serial('numero').notNull(),
  pessoaId: uuid('pessoa_id')
    .notNull()
    .references(() => pessoas.id),
  cobradorId: uuid('cobrador_id').references(() => cobradores.id, { onDelete: 'set null' }),
  usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  /** ativo | quitado | quebrado | cancelado */
  status: text('status').notNull().default('ativo'),
  original: integer('original').notNull(),
  multa: integer('multa').notNull(),
  juros: integer('juros').notNull(),
  desconto: integer('desconto').notNull(),
  total: integer('total').notNull(),
  entrada: integer('entrada').notNull().default(0),
  parcelas: integer('parcelas').notNull(),
  observacao: text('observacao'),
  encerradoEm: timestamp('encerrado_em', { withTimezone: true }),
  motivoEncerramento: text('motivo_encerramento'),
  criadoEm: criadoEm(),
});

/** Mensagens da régua já enviadas (uma por título e passo). */
export const cobrancaEnvios = pgTable(
  'cobranca_envios',
  {
    id: id(),
    tituloId: uuid('titulo_id')
      .notNull()
      .references(() => titulos.id, { onDelete: 'cascade' }),
    /** Dias em relação ao vencimento do passo da régua (-3, 0, 5…). */
    passo: integer('passo').notNull(),
    canal: text('canal').notNull(),
    /** enviado | falhou | sem_contato */
    resultado: text('resultado').notNull(),
    detalhe: text('detalhe'),
    criadoEm: criadoEm(),
  },
  (t) => ({ unico: uniqueIndex('cobranca_envios_titulo_passo_idx').on(t.tituloId, t.passo) }),
);

/** Arquivos trocados com a CRA (remessa, desistência, autorização de cancelamento, confirmação, retorno). */
export const cobrancaArquivosCra = pgTable('cobranca_arquivos_cra', {
  id: id(),
  /** remessa | desistencia | autoriza_cancelamento | confirmacao | retorno */
  tipo: text('tipo').notNull(),
  nome: text('nome').notNull(),
  conteudo: text('conteudo').notNull(),
  /** enviado | recusado | recebido */
  situacao: text('situacao').notNull(),
  resposta: text('resposta'),
  usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  criadoEm: criadoEm(),
});

/** Um título enviado a protesto e o que aconteceu com ele no cartório. */
export const cobrancaProtestos = pgTable(
  'cobranca_protestos',
  {
    id: id(),
    /** Número do título e nosso número enviados à CRA. */
    numero: serial('numero').notNull(),
    tituloId: uuid('titulo_id')
      .notNull()
      .references(() => titulos.id),
    pessoaId: uuid('pessoa_id')
      .notNull()
      .references(() => pessoas.id),
    /** Valor enviado (saldo a protestar). */
    valor: integer('valor').notNull(),
    especie: text('especie').notNull(),
    codMunicipio: text('cod_municipio').notNull(),
    /**
     * enviado (aguardando o cartório) | em_cartorio (protocolado) | protestado | pago (pago no cartório) |
     * retirado (desistência aceita) | sustado | devolvido (irregularidade) | cancelado (protesto cancelado) | recusado (a CRA recusou o arquivo)
     */
    status: text('status').notNull().default('enviado'),
    cartorio: text('cartorio'),
    protocolo: text('protocolo'),
    dataProtocolo: text('data_protocolo'),
    ocorrencia: text('ocorrencia'),
    irregularidade: text('irregularidade'),
    custas: integer('custas'),
    /** Pedido feito à CRA depois do pagamento: desistencia | autoriza_cancelamento. */
    pedido: text('pedido'),
    pedidoEm: timestamp('pedido_em', { withTimezone: true }),
    remessaId: uuid('remessa_id').references(() => cobrancaArquivosCra.id),
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    historico: jsonb('historico').$type<{ em: string; texto: string }[]>().notNull().default([]),
    criadoEm: criadoEm(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ porTitulo: index('cobranca_protestos_titulo_idx').on(t.tituloId) }),
);

/**
 * Especialistas do agente de IA no WhatsApp. A recepção lê a conversa e passa para o especialista do assunto;
 * todos falam com o mesmo nome. Sem especialistas, o agente único continua atendendo como antes.
 */
export const iaAgentes = pgTable('ia_agentes', {
  id: id(),
  /** vendas | recrutamento | revendedora | cobranca | posvenda | outro */
  funcao: text('funcao').notNull(),
  nome: text('nome').notNull(),
  /** Quando a recepção deve passar para este especialista (o assunto dele). */
  quando: text('quando').notNull(),
  instrucoes: text('instrucoes').notNull().default(''),
  conhecimento: text('conhecimento').notNull().default(''),
  ativo: boolean('ativo').notNull().default(true),
  ordem: integer('ordem').notNull().default(0),
  criadoEm: criadoEm(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

// ───────────────────────── Assistente (orquestrador) ─────────────────────────

/**
 * Conversa de alguém da equipe com o assistente do sistema (por texto ou voz).
 * O assistente consulta, executa ações com as permissões de quem pediu e registra pedidos de configuração/desenvolvimento.
 */
export const assistenteSessoes = pgTable(
  'assistente_sessoes',
  {
    id: id(),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    titulo: text('titulo').notNull().default('Nova conversa'),
    /** O assistente está trabalhando nesta conversa agora (a tela acompanha). */
    ocupada: boolean('ocupada').notNull().default(false),
    criadoEm: criadoEm(),
    atualizadoEm: atualizadoEm(),
  },
  (t) => ({ porUsuario: index('assistente_sessoes_usuario_idx').on(t.usuarioId, t.atualizadoEm) }),
);

/** Mensagens no formato da API do Claude (texto, uso de ferramenta e resultado), para retomar a conversa. */
export const assistenteMensagens = pgTable(
  'assistente_mensagens',
  {
    id: id(),
    sessaoId: uuid('sessao_id')
      .notNull()
      .references(() => assistenteSessoes.id, { onDelete: 'cascade' }),
    /** user | assistant */
    papel: text('papel').notNull(),
    conteudo: jsonb('conteudo').$type<unknown[]>().notNull(),
    /** O que aparece na tela (vazio quando a mensagem é só uso/resultado de ferramenta). */
    texto: text('texto'),
    /** texto | voz | sistema */
    origem: text('origem'),
    criadoEm: criadoEm(),
  },
  (t) => ({ porSessao: index('assistente_mensagens_sessao_idx').on(t.sessaoId, t.criadoEm) }),
);

/** Cada ferramenta que o assistente usou: consulta, ação direta ou ação que espera a confirmação de quem pediu. */
export const assistenteAcoes = pgTable(
  'assistente_acoes',
  {
    id: id(),
    sessaoId: uuid('sessao_id')
      .notNull()
      .references(() => assistenteSessoes.id, { onDelete: 'cascade' }),
    usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
    ferramenta: text('ferramenta').notNull(),
    entrada: jsonb('entrada').notNull(),
    /** leitura | acao | confirmar */
    risco: text('risco').notNull(),
    /** concluida | aguardando | executando | cancelada | erro */
    status: text('status').notNull(),
    /** Frase do que vai ser feito (mostrada no cartão de confirmação). */
    resumo: text('resumo'),
    /** Lista do que vai acontecer (ex.: cada mensagem do envio em lote). */
    previa: jsonb('previa'),
    resultado: jsonb('resultado'),
    erro: text('erro'),
    progresso: jsonb('progresso').$type<{ feitos: number; total: number; falhas: number }>(),
    criadoEm: criadoEm(),
    concluidaEm: timestamp('concluida_em', { withTimezone: true }),
  },
  (t) => ({ porSessao: index('assistente_acoes_sessao_idx').on(t.sessaoId, t.criadoEm) }),
);

/**
 * Necessidade que o assistente não resolve com o que já existe: vira um pedido com especificação e plano.
 * "configurar" = dá para montar com as configurações do sistema; "desenvolver" = precisa de código novo (vai para a Wide).
 */
export const assistentePedidos = pgTable('assistente_pedidos', {
  id: id(),
  numero: serial('numero').notNull(),
  sessaoId: uuid('sessao_id').references(() => assistenteSessoes.id, { onDelete: 'set null' }),
  usuarioId: uuid('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  /** configurar | desenvolver */
  tipo: text('tipo').notNull(),
  titulo: text('titulo').notNull(),
  especificacao: text('especificacao').notNull(),
  plano: jsonb('plano').$type<string[]>().notNull().default([]),
  modulo: text('modulo'),
  prioridade: text('prioridade').notNull().default('normal'),
  /** novo | em_analise | em_andamento | pronto | recusado */
  status: text('status').notNull().default('novo'),
  chamadoId: uuid('chamado_id').references(() => chamados.id, { onDelete: 'set null' }),
  criadoEm: criadoEm(),
  atualizadoEm: atualizadoEm(),
});
