/**
 * Catálogo das operações do Asaas que o módulo Financeiro › Asaas pode executar.
 * É a fronteira de segurança: só o que está aqui é chamado, com os campos listados aqui.
 * Fora de propósito: dados de cartão digitados (o cliente paga pelo link do Asaas), contas de garantia (escrow),
 * envio de documentos de subconta e as ações que só existem no ambiente de testes.
 */
export type TipoCampo = 'texto' | 'numero' | 'inteiro' | 'data' | 'bool' | 'dinheiro' | 'opcao' | 'cliente' | 'json';
export interface CampoAsaas {
  /** Nome no Asaas; ponto indica objeto dentro de objeto (ex.: fine.value). */
  nome: string;
  rotulo: string;
  tipo: TipoCampo;
  obrigatorio?: boolean;
  opcoes?: [string, string][];
  ajuda?: string;
}
/** ver: consulta · operar: cobranças, links, clientes · dinheiro: sai dinheiro ou tem custo · gestao: configuração da conta */
export type Nivel = 'ver' | 'operar' | 'dinheiro' | 'gestao';
export interface OperacaoAsaas {
  chave: string;
  grupo: string;
  nome: string;
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE';
  caminho: string;
  nivel: Nivel;
  filtros?: CampoAsaas[];
  campos?: CampoAsaas[];
  /** Cobrança ligada a um título do sistema: bloqueia (faça pelo título), solta (tira o boleto do título) ou estorna (desfaz a baixa). */
  titulo?: 'bloqueia' | 'solta' | 'estorna';
  /** Texto do aviso antes de executar. */
  aviso?: string;
}

const c = (nome: string, rotulo: string, tipo: TipoCampo = 'texto', extra: Partial<CampoAsaas> = {}): CampoAsaas => ({ nome, rotulo, tipo, ...extra });
const ob = (nome: string, rotulo: string, tipo: TipoCampo = 'texto', extra: Partial<CampoAsaas> = {}) => c(nome, rotulo, tipo, { ...extra, obrigatorio: true });
const op = (nome: string, rotulo: string, opcoes: [string, string][], extra: Partial<CampoAsaas> = {}) => c(nome, rotulo, 'opcao', { opcoes, ...extra });

const FORMA: [string, string][] = [['BOLETO', 'Boleto (com Pix)'], ['PIX', 'Pix'], ['CREDIT_CARD', 'Cartão de crédito'], ['UNDEFINED', 'O cliente escolhe']];
const STATUS_COBRANCA: [string, string][] = [['PENDING', 'Aguardando'], ['OVERDUE', 'Vencida'], ['RECEIVED', 'Recebida'], ['CONFIRMED', 'Confirmada (cartão)'], ['RECEIVED_IN_CASH', 'Recebida em dinheiro'], ['REFUNDED', 'Estornada'], ['REFUND_REQUESTED', 'Estorno pedido'], ['CHARGEBACK_REQUESTED', 'Chargeback'], ['DUNNING_REQUESTED', 'Em negativação']];
const CICLO: [string, string][] = [['WEEKLY', 'Semanal'], ['BIWEEKLY', 'Quinzenal'], ['MONTHLY', 'Mensal'], ['BIMONTHLY', 'Bimestral'], ['QUARTERLY', 'Trimestral'], ['SEMIANNUALLY', 'Semestral'], ['YEARLY', 'Anual']];
const TIPO_CHAVE: [string, string][] = [['CPF', 'CPF'], ['CNPJ', 'CNPJ'], ['EMAIL', 'E-mail'], ['PHONE', 'Celular'], ['EVP', 'Chave aleatória']];

const ENCARGOS = [
  c('fine.value', 'Multa por atraso (%)', 'numero'),
  c('interest.value', 'Juros ao mês (%)', 'numero'),
  c('discount.value', 'Desconto', 'numero', { ajuda: 'Em reais ou em %, conforme o tipo do desconto.' }),
  op('discount.type', 'Tipo do desconto', [['FIXED', 'Valor fixo (R$)'], ['PERCENTAGE', 'Percentual (%)']]),
  c('discount.dueDateLimitDays', 'Desconto até quantos dias antes do vencimento', 'inteiro'),
];
const CLIENTE = [
  c('email', 'E-mail'), c('mobilePhone', 'Celular'), c('phone', 'Telefone fixo'), c('postalCode', 'CEP'), c('address', 'Rua'), c('addressNumber', 'Número'),
  c('complement', 'Complemento'), c('province', 'Bairro'), c('externalReference', 'Referência no seu sistema'), c('additionalEmails', 'Outros e-mails (separados por vírgula)'),
  c('observations', 'Observações'), c('groupName', 'Grupo'), c('notificationDisabled', 'Não mandar avisos do Asaas para este cliente', 'bool'),
];
const PERIODO = (campo: string, rotulo: string) => [c(`${campo}[ge]`, `${rotulo} a partir de`, 'data'), c(`${campo}[le]`, `${rotulo} até`, 'data')];

export const OPERACOES: OperacaoAsaas[] = [
  // ───── Visão geral e conta ─────
  { chave: 'saldo', grupo: 'conta', nome: 'Saldo da conta', metodo: 'GET', caminho: '/finance/balance', nivel: 'ver' },
  { chave: 'estatisticas', grupo: 'conta', nome: 'Totais de cobranças', metodo: 'GET', caminho: '/finance/payment/statistics', nivel: 'ver', filtros: [op('status', 'Situação', STATUS_COBRANCA), op('billingType', 'Forma', FORMA), ...PERIODO('dueDate', 'Vencimento'), c('anticipated', 'Só antecipadas', 'bool')] },
  { chave: 'conta.dados', grupo: 'conta', nome: 'Dados comerciais da conta', metodo: 'GET', caminho: '/myAccount/commercialInfo', nivel: 'ver' },
  { chave: 'conta.numero', grupo: 'conta', nome: 'Número da conta Asaas', metodo: 'GET', caminho: '/myAccount/accountNumber', nivel: 'ver' },
  { chave: 'conta.taxas', grupo: 'conta', nome: 'Taxas da conta', metodo: 'GET', caminho: '/myAccount/fees', nivel: 'ver' },
  { chave: 'conta.situacao', grupo: 'conta', nome: 'Situação do cadastro', metodo: 'GET', caminho: '/myAccount/status', nivel: 'ver' },
  { chave: 'conta.carteiras', grupo: 'conta', nome: 'Carteira (walletId, para split)', metodo: 'GET', caminho: '/wallets', nivel: 'ver' },
  { chave: 'conta.checkout', grupo: 'conta', nome: 'Personalização da fatura', metodo: 'GET', caminho: '/myAccount/paymentCheckoutConfig', nivel: 'ver' },
  { chave: 'conta.limites', grupo: 'conta', nome: 'Limites de cobrança', metodo: 'GET', caminho: '/payments/limits', nivel: 'ver' },

  // ───── Extrato ─────
  { chave: 'extrato', grupo: 'extrato', nome: 'Extrato', metodo: 'GET', caminho: '/financialTransactions', nivel: 'ver', filtros: [c('startDate', 'De', 'data'), c('finishDate', 'Até', 'data'), op('order', 'Ordem', [['desc', 'Mais recentes primeiro'], ['asc', 'Mais antigos primeiro']])] },

  // ───── Cobranças ─────
  {
    chave: 'cobrancas', grupo: 'cobrancas', nome: 'Cobranças', metodo: 'GET', caminho: '/payments', nivel: 'ver',
    filtros: [op('status', 'Situação', STATUS_COBRANCA), op('billingType', 'Forma', FORMA), c('customer', 'Cliente', 'cliente'), ...PERIODO('dueDate', 'Vencimento'), ...PERIODO('paymentDate', 'Pagamento'), c('externalReference', 'Referência'), c('subscription', 'Código da assinatura'), c('installment', 'Código do parcelamento')],
  },
  { chave: 'cobrancas.ver', grupo: 'cobrancas', nome: 'Ver cobrança', metodo: 'GET', caminho: '/payments/:id', nivel: 'ver' },
  {
    chave: 'cobrancas.criar', grupo: 'cobrancas', nome: 'Nova cobrança', metodo: 'POST', caminho: '/payments', nivel: 'operar',
    campos: [ob('customer', 'Cliente', 'cliente'), ob('billingType', 'Forma de pagamento', 'opcao', { opcoes: FORMA }), ob('value', 'Valor', 'dinheiro'), ob('dueDate', 'Vencimento', 'data'), c('description', 'Descrição (aparece na fatura)'),
      c('installmentCount', 'Parcelas', 'inteiro', { ajuda: 'Em branco: à vista. Com parcelas, informe o valor de cada uma.' }), c('installmentValue', 'Valor de cada parcela', 'dinheiro'), c('externalReference', 'Referência no seu sistema'), c('postalService', 'Mandar o boleto pelos Correios (tem custo)', 'bool'), ...ENCARGOS],
    aviso: 'Cobrança criada aqui fica só no Asaas. Para cobrar um título do sistema (com baixa automática), use Lançamentos › Gerar boleto ou Pix.',
  },
  { chave: 'cobrancas.editar', grupo: 'cobrancas', nome: 'Editar cobrança', metodo: 'PUT', caminho: '/payments/:id', nivel: 'operar', titulo: 'bloqueia', campos: [c('value', 'Valor', 'dinheiro'), c('dueDate', 'Vencimento', 'data'), c('description', 'Descrição'), op('billingType', 'Forma de pagamento', FORMA), c('externalReference', 'Referência'), ...ENCARGOS] },
  { chave: 'cobrancas.excluir', grupo: 'cobrancas', nome: 'Excluir cobrança', metodo: 'DELETE', caminho: '/payments/:id', nivel: 'operar', titulo: 'solta', aviso: 'A cobrança deixa de poder ser paga.' },
  { chave: 'cobrancas.restaurar', grupo: 'cobrancas', nome: 'Restaurar cobrança excluída', metodo: 'POST', caminho: '/payments/:id/restore', nivel: 'operar' },
  { chave: 'cobrancas.situacao', grupo: 'cobrancas', nome: 'Situação da cobrança', metodo: 'GET', caminho: '/payments/:id/status', nivel: 'ver' },
  { chave: 'cobrancas.linha', grupo: 'cobrancas', nome: 'Linha digitável do boleto', metodo: 'GET', caminho: '/payments/:id/identificationField', nivel: 'ver' },
  { chave: 'cobrancas.pix', grupo: 'cobrancas', nome: 'QR Code Pix', metodo: 'GET', caminho: '/payments/:id/pixQrCode', nivel: 'ver' },
  { chave: 'cobrancas.fatura', grupo: 'cobrancas', nome: 'Dados de pagamento (boleto, Pix e cartão)', metodo: 'GET', caminho: '/payments/:id/billingInfo', nivel: 'ver' },
  { chave: 'cobrancas.visualizacao', grupo: 'cobrancas', nome: 'O cliente abriu a fatura?', metodo: 'GET', caminho: '/payments/:id/viewingInfo', nivel: 'ver' },
  { chave: 'cobrancas.dinheiro', grupo: 'cobrancas', nome: 'Confirmar recebimento em dinheiro', metodo: 'POST', caminho: '/payments/:id/receiveInCash', nivel: 'operar', titulo: 'bloqueia', campos: [ob('paymentDate', 'Recebido em', 'data'), ob('value', 'Valor recebido', 'dinheiro'), c('notifyCustomer', 'Avisar o cliente', 'bool')] },
  { chave: 'cobrancas.desfazerDinheiro', grupo: 'cobrancas', nome: 'Desfazer recebimento em dinheiro', metodo: 'POST', caminho: '/payments/:id/undoReceivedInCash', nivel: 'operar', titulo: 'bloqueia' },
  { chave: 'cobrancas.estornar', grupo: 'cobrancas', nome: 'Estornar (devolver o dinheiro)', metodo: 'POST', caminho: '/payments/:id/refund', nivel: 'dinheiro', titulo: 'estorna', campos: [c('value', 'Valor a devolver', 'dinheiro', { ajuda: 'Em branco: devolve tudo.' }), c('description', 'Motivo')], aviso: 'O dinheiro volta para o cliente e sai do saldo do Asaas.' },
  { chave: 'cobrancas.estornos', grupo: 'cobrancas', nome: 'Estornos da cobrança', metodo: 'GET', caminho: '/payments/:id/refunds', nivel: 'ver' },
  { chave: 'cobrancas.documentos', grupo: 'cobrancas', nome: 'Documentos da cobrança', metodo: 'GET', caminho: '/payments/:id/documents', nivel: 'ver' },
  { chave: 'cobrancas.simular', grupo: 'cobrancas', nome: 'Simular venda (taxas e valor líquido)', metodo: 'POST', caminho: '/payments/simulate', nivel: 'ver', campos: [ob('value', 'Valor', 'dinheiro'), c('installmentCount', 'Parcelas', 'inteiro'), ob('billingTypes', 'Formas (lista)', 'json', { ajuda: 'Ex.: ["BOLETO","PIX","CREDIT_CARD"]' })] },
  { chave: 'chargebacks', grupo: 'cobrancas', nome: 'Chargebacks (contestações de cartão)', metodo: 'GET', caminho: '/chargebacks/', nivel: 'ver' },

  // ───── Parcelamentos ─────
  { chave: 'parcelamentos', grupo: 'parcelamentos', nome: 'Parcelamentos', metodo: 'GET', caminho: '/installments', nivel: 'ver' },
  { chave: 'parcelamentos.ver', grupo: 'parcelamentos', nome: 'Ver parcelamento', metodo: 'GET', caminho: '/installments/:id', nivel: 'ver' },
  {
    chave: 'parcelamentos.criar', grupo: 'parcelamentos', nome: 'Novo parcelamento', metodo: 'POST', caminho: '/installments', nivel: 'operar',
    campos: [ob('customer', 'Cliente', 'cliente'), ob('billingType', 'Forma de pagamento', 'opcao', { opcoes: FORMA }), ob('installmentCount', 'Parcelas', 'inteiro'), c('value', 'Valor de cada parcela', 'dinheiro'), c('totalValue', 'Valor total (o Asaas divide)', 'dinheiro'), ob('dueDate', 'Vencimento da 1ª parcela', 'data'), c('description', 'Descrição'), c('externalReference', 'Referência'), ...ENCARGOS],
  },
  { chave: 'parcelamentos.parcelas', grupo: 'parcelamentos', nome: 'Parcelas', metodo: 'GET', caminho: '/installments/:id/payments', nivel: 'ver' },
  { chave: 'parcelamentos.excluir', grupo: 'parcelamentos', nome: 'Excluir parcelamento', metodo: 'DELETE', caminho: '/installments/:id', nivel: 'operar', aviso: 'Todas as parcelas em aberto deixam de poder ser pagas.' },
  { chave: 'parcelamentos.cancelarAbertas', grupo: 'parcelamentos', nome: 'Cancelar as parcelas em aberto', metodo: 'DELETE', caminho: '/installments/:id/payments', nivel: 'operar' },
  { chave: 'parcelamentos.estornar', grupo: 'parcelamentos', nome: 'Estornar parcelamento', metodo: 'POST', caminho: '/installments/:id/refund', nivel: 'dinheiro', aviso: 'Devolve ao cliente o que já foi pago.' },

  // ───── Assinaturas ─────
  { chave: 'assinaturas', grupo: 'assinaturas', nome: 'Assinaturas', metodo: 'GET', caminho: '/subscriptions', nivel: 'ver', filtros: [c('customer', 'Cliente', 'cliente'), op('billingType', 'Forma', FORMA), op('status', 'Situação', [['ACTIVE', 'Ativa'], ['INACTIVE', 'Parada'], ['EXPIRED', 'Encerrada']]), c('externalReference', 'Referência')] },
  { chave: 'assinaturas.ver', grupo: 'assinaturas', nome: 'Ver assinatura', metodo: 'GET', caminho: '/subscriptions/:id', nivel: 'ver' },
  {
    chave: 'assinaturas.criar', grupo: 'assinaturas', nome: 'Nova assinatura', metodo: 'POST', caminho: '/subscriptions', nivel: 'operar',
    campos: [ob('customer', 'Cliente', 'cliente'), ob('billingType', 'Forma de pagamento', 'opcao', { opcoes: FORMA }), ob('value', 'Valor de cada cobrança', 'dinheiro'), ob('nextDueDate', 'Primeiro vencimento', 'data'), ob('cycle', 'Repete', 'opcao', { opcoes: CICLO }), c('description', 'Descrição'), c('endDate', 'Termina em', 'data'), c('maxPayments', 'Número máximo de cobranças', 'inteiro'), c('externalReference', 'Referência'), ...ENCARGOS],
  },
  { chave: 'assinaturas.editar', grupo: 'assinaturas', nome: 'Editar assinatura', metodo: 'PUT', caminho: '/subscriptions/:id', nivel: 'operar', campos: [c('value', 'Valor', 'dinheiro'), c('nextDueDate', 'Próximo vencimento', 'data'), op('cycle', 'Repete', CICLO), op('billingType', 'Forma de pagamento', FORMA), c('description', 'Descrição'), c('endDate', 'Termina em', 'data'), c('maxPayments', 'Número máximo de cobranças', 'inteiro'), op('status', 'Situação', [['ACTIVE', 'Ativa'], ['INACTIVE', 'Parada']]), c('updatePendingPayments', 'Atualizar também as cobranças já geradas', 'bool'), ...ENCARGOS] },
  { chave: 'assinaturas.excluir', grupo: 'assinaturas', nome: 'Excluir assinatura', metodo: 'DELETE', caminho: '/subscriptions/:id', nivel: 'operar', aviso: 'As cobranças em aberto da assinatura também são excluídas.' },
  { chave: 'assinaturas.cobrancas', grupo: 'assinaturas', nome: 'Cobranças da assinatura', metodo: 'GET', caminho: '/subscriptions/:id/payments', nivel: 'ver' },
  { chave: 'assinaturas.notas', grupo: 'assinaturas', nome: 'Notas fiscais da assinatura', metodo: 'GET', caminho: '/subscriptions/:id/invoices', nivel: 'ver' },

  // ───── Links de pagamento ─────
  { chave: 'links', grupo: 'links', nome: 'Links de pagamento', metodo: 'GET', caminho: '/paymentLinks', nivel: 'ver', filtros: [c('name', 'Nome'), c('active', 'Só ativos', 'bool'), c('includeDeleted', 'Incluir excluídos', 'bool')] },
  { chave: 'links.ver', grupo: 'links', nome: 'Ver link', metodo: 'GET', caminho: '/paymentLinks/:id', nivel: 'ver' },
  {
    chave: 'links.criar', grupo: 'links', nome: 'Novo link de pagamento', metodo: 'POST', caminho: '/paymentLinks', nivel: 'operar',
    campos: [ob('name', 'Nome'), c('description', 'Descrição'), c('value', 'Valor', 'dinheiro', { ajuda: 'Em branco: o cliente digita o valor.' }), ob('billingType', 'Formas aceitas', 'opcao', { opcoes: FORMA }), ob('chargeType', 'Tipo', 'opcao', { opcoes: [['DETACHED', 'Avulso'], ['INSTALLMENT', 'Parcelado'], ['RECURRENT', 'Assinatura']] }),
      c('dueDateLimitDays', 'Dias para pagar o boleto', 'inteiro', { ajuda: 'Obrigatório quando aceita boleto.' }), c('maxInstallmentCount', 'Máximo de parcelas', 'inteiro'), op('subscriptionCycle', 'Repete (assinatura)', CICLO), c('endDate', 'Vale até', 'data'), c('notificationEnabled', 'Asaas avisa o cliente', 'bool'), c('externalReference', 'Referência')],
  },
  { chave: 'links.editar', grupo: 'links', nome: 'Editar link', metodo: 'PUT', caminho: '/paymentLinks/:id', nivel: 'operar', campos: [c('name', 'Nome'), c('description', 'Descrição'), c('value', 'Valor', 'dinheiro'), op('billingType', 'Formas aceitas', FORMA), op('chargeType', 'Tipo', [['DETACHED', 'Avulso'], ['INSTALLMENT', 'Parcelado'], ['RECURRENT', 'Assinatura']]), c('dueDateLimitDays', 'Dias para pagar o boleto', 'inteiro'), c('maxInstallmentCount', 'Máximo de parcelas', 'inteiro'), c('endDate', 'Vale até', 'data'), c('active', 'Ativo', 'bool')] },
  { chave: 'links.excluir', grupo: 'links', nome: 'Excluir link', metodo: 'DELETE', caminho: '/paymentLinks/:id', nivel: 'operar' },
  { chave: 'links.restaurar', grupo: 'links', nome: 'Restaurar link', metodo: 'POST', caminho: '/paymentLinks/:id/restore', nivel: 'operar' },

  // ───── Clientes ─────
  { chave: 'clientes', grupo: 'clientes', nome: 'Clientes no Asaas', metodo: 'GET', caminho: '/customers', nivel: 'ver', filtros: [c('name', 'Nome'), c('cpfCnpj', 'CPF ou CNPJ'), c('email', 'E-mail'), c('externalReference', 'Referência'), c('groupName', 'Grupo')] },
  { chave: 'clientes.ver', grupo: 'clientes', nome: 'Ver cliente', metodo: 'GET', caminho: '/customers/:id', nivel: 'ver' },
  { chave: 'clientes.criar', grupo: 'clientes', nome: 'Novo cliente no Asaas', metodo: 'POST', caminho: '/customers', nivel: 'operar', campos: [ob('name', 'Nome'), ob('cpfCnpj', 'CPF ou CNPJ'), ...CLIENTE], aviso: 'Quem já está no cadastro do sistema entra no Asaas sozinho ao gerar o primeiro boleto.' },
  { chave: 'clientes.editar', grupo: 'clientes', nome: 'Editar cliente', metodo: 'PUT', caminho: '/customers/:id', nivel: 'operar', campos: [c('name', 'Nome'), c('cpfCnpj', 'CPF ou CNPJ'), ...CLIENTE] },
  { chave: 'clientes.excluir', grupo: 'clientes', nome: 'Excluir cliente', metodo: 'DELETE', caminho: '/customers/:id', nivel: 'operar', aviso: 'As cobranças em aberto deste cliente também são excluídas no Asaas.' },
  { chave: 'clientes.restaurar', grupo: 'clientes', nome: 'Restaurar cliente', metodo: 'POST', caminho: '/customers/:id/restore', nivel: 'operar' },
  { chave: 'clientes.avisos', grupo: 'clientes', nome: 'Avisos que o Asaas manda ao cliente', metodo: 'GET', caminho: '/customers/:id/notifications', nivel: 'ver' },
  { chave: 'avisos.editar', grupo: 'clientes', nome: 'Editar um aviso', metodo: 'PUT', caminho: '/notifications/:id', nivel: 'operar', campos: [c('enabled', 'Ligado', 'bool'), c('emailEnabledForCustomer', 'E-mail para o cliente', 'bool'), c('smsEnabledForCustomer', 'SMS para o cliente (tem custo)', 'bool'), c('whatsappEnabledForCustomer', 'WhatsApp para o cliente (tem custo)', 'bool'), c('phoneCallEnabledForCustomer', 'Ligação de voz (tem custo)', 'bool'), c('emailEnabledForProvider', 'E-mail para a empresa', 'bool'), c('smsEnabledForProvider', 'SMS para a empresa', 'bool'), c('scheduleOffset', 'Dias de antecedência ou depois', 'inteiro')] },

  // ───── Transferências ─────
  { chave: 'transferencias', grupo: 'transferencias', nome: 'Transferências', metodo: 'GET', caminho: '/transfers', nivel: 'ver', filtros: [...PERIODO('dateCreated', 'Criada'), ...PERIODO('transferDate', 'Efetivada'), op('type', 'Tipo', [['BANK_ACCOUNT', 'Para banco ou Pix'], ['ASAAS_ACCOUNT', 'Para conta Asaas']])] },
  { chave: 'transferencias.ver', grupo: 'transferencias', nome: 'Ver transferência', metodo: 'GET', caminho: '/transfers/:id', nivel: 'ver' },
  {
    chave: 'transferencias.pix', grupo: 'transferencias', nome: 'Transferir por chave Pix', metodo: 'POST', caminho: '/transfers', nivel: 'dinheiro',
    campos: [ob('value', 'Valor', 'dinheiro'), ob('pixAddressKey', 'Chave Pix de destino'), ob('pixAddressKeyType', 'Tipo da chave', 'opcao', { opcoes: TIPO_CHAVE }), c('description', 'Descrição'), c('scheduleDate', 'Agendar para', 'data'), c('externalReference', 'Referência')],
    aviso: 'O dinheiro sai do saldo do Asaas. Confira a chave e o valor.',
  },
  {
    chave: 'transferencias.banco', grupo: 'transferencias', nome: 'Transferir para conta bancária', metodo: 'POST', caminho: '/transfers', nivel: 'dinheiro',
    campos: [ob('value', 'Valor', 'dinheiro'), ob('bankAccount.ownerName', 'Nome do titular'), ob('bankAccount.cpfCnpj', 'CPF ou CNPJ do titular'), ob('bankAccount.bank.code', 'Código do banco', 'texto', { ajuda: 'Ex.: 756 (Sicoob), 001 (BB), 341 (Itaú).' }), ob('bankAccount.agency', 'Agência (sem dígito)'), ob('bankAccount.account', 'Conta (sem dígito)'), ob('bankAccount.accountDigit', 'Dígito da conta'),
      ob('bankAccount.bankAccountType', 'Tipo de conta', 'opcao', { opcoes: [['CONTA_CORRENTE', 'Corrente'], ['CONTA_POUPANCA', 'Poupança']] }), op('operationType', 'Enviar por', [['PIX', 'Pix'], ['TED', 'TED']]), c('description', 'Descrição'), c('scheduleDate', 'Agendar para', 'data'), c('externalReference', 'Referência')],
    aviso: 'O dinheiro sai do saldo do Asaas. Confira os dados da conta e o valor.',
  },
  { chave: 'transferencias.asaas', grupo: 'transferencias', nome: 'Transferir para outra conta Asaas', metodo: 'POST', caminho: '/transfers', nivel: 'dinheiro', campos: [ob('value', 'Valor', 'dinheiro'), ob('walletId', 'WalletId da conta de destino'), c('externalReference', 'Referência')], aviso: 'O dinheiro sai do saldo do Asaas.' },
  { chave: 'transferencias.cancelar', grupo: 'transferencias', nome: 'Cancelar transferência', metodo: 'DELETE', caminho: '/transfers/:id/cancel', nivel: 'dinheiro' },

  // ───── Pix ─────
  { chave: 'pix.chaves', grupo: 'pix', nome: 'Chaves Pix da conta', metodo: 'GET', caminho: '/pix/addressKeys', nivel: 'ver', filtros: [op('status', 'Situação', [['ACTIVE', 'Ativa'], ['AWAITING_ACTIVATION', 'Aguardando'], ['DELETED', 'Excluída']])] },
  { chave: 'pix.chaves.criar', grupo: 'pix', nome: 'Criar chave aleatória', metodo: 'POST', caminho: '/pix/addressKeys', nivel: 'gestao', campos: [ob('type', 'Tipo', 'opcao', { opcoes: [['EVP', 'Chave aleatória']] })] },
  { chave: 'pix.chaves.excluir', grupo: 'pix', nome: 'Excluir chave', metodo: 'DELETE', caminho: '/pix/addressKeys/:id', nivel: 'gestao', aviso: 'QR Codes feitos com esta chave param de funcionar.' },
  { chave: 'pix.qr.criar', grupo: 'pix', nome: 'Criar QR Code fixo', metodo: 'POST', caminho: '/pix/qrCodes/static', nivel: 'operar', campos: [ob('addressKey', 'Chave Pix da conta'), c('description', 'Descrição'), c('value', 'Valor', 'dinheiro', { ajuda: 'Em branco: quem paga digita o valor.' }), op('format', 'Formato', [['ALL', 'Imagem e copia e cola'], ['IMAGE', 'Só imagem'], ['PAYLOAD', 'Só copia e cola']]), c('expirationDate', 'Vale até', 'data'), c('allowsMultiplePayments', 'Pode ser pago mais de uma vez', 'bool'), c('externalReference', 'Referência')] },
  { chave: 'pix.qr.excluir', grupo: 'pix', nome: 'Excluir QR Code fixo', metodo: 'DELETE', caminho: '/pix/qrCodes/static/:id', nivel: 'operar' },
  { chave: 'pix.transacoes', grupo: 'pix', nome: 'Transações Pix', metodo: 'GET', caminho: '/pix/transactions', nivel: 'ver', filtros: [op('status', 'Situação', [['DONE', 'Concluída'], ['PENDING', 'Pendente'], ['SCHEDULED', 'Agendada'], ['CANCELLED', 'Cancelada'], ['REFUSED', 'Recusada'], ['ERROR', 'Erro']]), op('type', 'Tipo', [['CREDIT', 'Recebida'], ['DEBIT', 'Enviada'], ['CREDIT_REFUND', 'Devolução recebida'], ['DEBIT_REFUND', 'Devolução enviada']]), c('endToEndIdentifier', 'Identificador (E2E)')] },
  { chave: 'pix.transacoes.ver', grupo: 'pix', nome: 'Ver transação', metodo: 'GET', caminho: '/pix/transactions/:id', nivel: 'ver' },
  { chave: 'pix.ler', grupo: 'pix', nome: 'Ler um QR Code (copia e cola)', metodo: 'POST', caminho: '/pix/qrCodes/decode', nivel: 'ver', campos: [ob('payload', 'Copia e cola')] },
  { chave: 'pix.pagar', grupo: 'pix', nome: 'Pagar um QR Code', metodo: 'POST', caminho: '/pix/qrCodes/pay', nivel: 'dinheiro', campos: [ob('qrCode.payload', 'Copia e cola'), ob('value', 'Valor', 'dinheiro'), c('description', 'Descrição'), c('scheduleDate', 'Agendar para', 'data')], aviso: 'O dinheiro sai do saldo do Asaas. Leia o QR Code antes para conferir quem recebe.' },
  { chave: 'pix.transacoes.cancelar', grupo: 'pix', nome: 'Cancelar Pix agendado', metodo: 'POST', caminho: '/pix/transactions/:id/cancel', nivel: 'dinheiro' },
  { chave: 'pix.limite', grupo: 'pix', nome: 'Consultas de chave disponíveis', metodo: 'GET', caminho: '/pix/tokenBucket/addressKey', nivel: 'ver' },

  // ───── Pagamento de contas ─────
  { chave: 'contas', grupo: 'contas', nome: 'Contas pagas pelo Asaas', metodo: 'GET', caminho: '/bill', nivel: 'ver' },
  { chave: 'contas.ver', grupo: 'contas', nome: 'Ver pagamento', metodo: 'GET', caminho: '/bill/:id', nivel: 'ver' },
  { chave: 'contas.simular', grupo: 'contas', nome: 'Conferir um boleto (valor, taxa e vencimento)', metodo: 'POST', caminho: '/bill/simulate', nivel: 'ver', campos: [c('identificationField', 'Linha digitável'), c('barCode', 'Código de barras')] },
  {
    chave: 'contas.pagar', grupo: 'contas', nome: 'Pagar um boleto', metodo: 'POST', caminho: '/bill', nivel: 'dinheiro',
    campos: [ob('identificationField', 'Linha digitável'), c('scheduleDate', 'Pagar em', 'data', { ajuda: 'Em branco: paga no vencimento.' }), c('description', 'Descrição'), c('value', 'Valor', 'dinheiro', { ajuda: 'Só para boleto sem valor ou vencimento registrado.' }), c('dueDate', 'Vencimento', 'data'), c('discount', 'Desconto', 'dinheiro'), c('interest', 'Juros', 'dinheiro'), c('fine', 'Multa', 'dinheiro'), c('externalReference', 'Referência')],
    aviso: 'O dinheiro sai do saldo do Asaas. Confira o boleto antes.',
  },
  { chave: 'contas.cancelar', grupo: 'contas', nome: 'Cancelar pagamento agendado', metodo: 'POST', caminho: '/bill/:id/cancel', nivel: 'dinheiro' },

  // ───── Antecipações ─────
  { chave: 'antecipacoes', grupo: 'antecipacoes', nome: 'Antecipações', metodo: 'GET', caminho: '/anticipations', nivel: 'ver', filtros: [c('payment', 'Código da cobrança'), c('installment', 'Código do parcelamento'), op('status', 'Situação', [['PENDING', 'Em análise'], ['SCHEDULED', 'Agendada'], ['CREDITED', 'Creditada'], ['DEBITED', 'Debitada'], ['DENIED', 'Negada'], ['CANCELLED', 'Cancelada'], ['OVERDUE', 'Vencida']])] },
  { chave: 'antecipacoes.ver', grupo: 'antecipacoes', nome: 'Ver antecipação', metodo: 'GET', caminho: '/anticipations/:id', nivel: 'ver' },
  { chave: 'antecipacoes.limites', grupo: 'antecipacoes', nome: 'Limites de antecipação', metodo: 'GET', caminho: '/anticipations/limits', nivel: 'ver' },
  { chave: 'antecipacoes.simular', grupo: 'antecipacoes', nome: 'Simular antecipação', metodo: 'POST', caminho: '/anticipations/simulate', nivel: 'ver', campos: [c('payment', 'Código da cobrança'), c('installment', 'Código do parcelamento')] },
  { chave: 'antecipacoes.pedir', grupo: 'antecipacoes', nome: 'Pedir antecipação', metodo: 'POST', caminho: '/anticipations', nivel: 'dinheiro', campos: [c('payment', 'Código da cobrança'), c('installment', 'Código do parcelamento')], aviso: 'A antecipação tem taxa: simule antes para ver quanto entra.' },
  { chave: 'antecipacoes.cancelar', grupo: 'antecipacoes', nome: 'Cancelar antecipação', metodo: 'POST', caminho: '/anticipations/:id/cancel', nivel: 'dinheiro' },
  { chave: 'antecipacoes.automatica', grupo: 'antecipacoes', nome: 'Antecipação automática de cartão', metodo: 'GET', caminho: '/anticipations/configurations', nivel: 'ver' },
  { chave: 'antecipacoes.automatica.mudar', grupo: 'antecipacoes', nome: 'Ligar ou desligar a antecipação automática', metodo: 'PUT', caminho: '/anticipations/configurations', nivel: 'gestao', campos: [ob('creditCardAutomaticEnabled', 'Antecipar sozinho as vendas no cartão', 'bool')], aviso: 'Com isso ligado, toda venda no cartão paga a taxa de antecipação.' },

  // ───── Negativação (Serasa) ─────
  { chave: 'negativacoes', grupo: 'negativacao', nome: 'Negativações', metodo: 'GET', caminho: '/paymentDunnings', nivel: 'ver', filtros: [op('status', 'Situação', [['PENDING', 'Pendente'], ['AWAITING_APPROVAL', 'Em análise'], ['PROCESSED', 'Negativado'], ['PAID', 'Pago'], ['PARTIALLY_PAID', 'Pago em parte'], ['DENIED', 'Negada'], ['CANCELLED', 'Cancelada']]), c('payment', 'Código da cobrança')] },
  { chave: 'negativacoes.ver', grupo: 'negativacao', nome: 'Ver negativação', metodo: 'GET', caminho: '/paymentDunnings/:id', nivel: 'ver' },
  { chave: 'negativacoes.historico', grupo: 'negativacao', nome: 'Histórico', metodo: 'GET', caminho: '/paymentDunnings/:id/history', nivel: 'ver' },
  { chave: 'negativacoes.recebimentos', grupo: 'negativacao', nome: 'Recebimentos', metodo: 'GET', caminho: '/paymentDunnings/:id/partialPayments', nivel: 'ver' },
  { chave: 'negativacoes.disponiveis', grupo: 'negativacao', nome: 'Cobranças que podem ser negativadas', metodo: 'GET', caminho: '/paymentDunnings/paymentsAvailableForDunning', nivel: 'ver' },
  { chave: 'negativacoes.simular', grupo: 'negativacao', nome: 'Simular negativação (custo)', metodo: 'POST', caminho: '/paymentDunnings/simulate', nivel: 'ver', campos: [ob('payment', 'Código da cobrança')] },
  {
    chave: 'negativacoes.criar', grupo: 'negativacao', nome: 'Negativar uma cobrança', metodo: 'POST', caminho: '/paymentDunnings', nivel: 'dinheiro',
    campos: [ob('payment', 'Código da cobrança'), ob('type', 'Tipo', 'opcao', { opcoes: [['CREDIT_BUREAU', 'Serasa']] }), c('description', 'O que foi vendido'), ob('customerName', 'Nome do devedor'), ob('customerCpfCnpj', 'CPF ou CNPJ'), ob('customerPrimaryPhone', 'Telefone'), ob('customerPostalCode', 'CEP'), ob('customerAddress', 'Rua'), ob('customerAddressNumber', 'Número'), c('customerComplement', 'Complemento'), ob('customerProvince', 'Bairro')],
    aviso: 'A negativação tem custo e registra o devedor no Serasa. O Asaas pode pedir a nota fiscal ou o contrato pelo painel dele.',
  },
  { chave: 'negativacoes.cancelar', grupo: 'negativacao', nome: 'Cancelar negativação', metodo: 'POST', caminho: '/paymentDunnings/:id/cancel', nivel: 'dinheiro' },

  // ───── Consulta Serasa ─────
  { chave: 'serasa', grupo: 'serasa', nome: 'Consultas feitas', metodo: 'GET', caminho: '/creditBureauReport', nivel: 'ver' },
  { chave: 'serasa.ver', grupo: 'serasa', nome: 'Ver consulta', metodo: 'GET', caminho: '/creditBureauReport/:id', nivel: 'ver' },
  { chave: 'serasa.consultar', grupo: 'serasa', nome: 'Consultar CPF ou CNPJ no Serasa', metodo: 'POST', caminho: '/creditBureauReport', nivel: 'dinheiro', campos: [c('customer', 'Cliente', 'cliente'), c('cpfCnpj', 'ou CPF/CNPJ'), ob('state', 'Estado (UF)')], aviso: 'Cada consulta é cobrada pelo Asaas.' },

  // ───── Notas fiscais de serviço ─────
  { chave: 'notas', grupo: 'notas', nome: 'Notas fiscais de serviço', metodo: 'GET', caminho: '/invoices', nivel: 'ver', filtros: [...PERIODO('effectiveDate', 'Emissão'), c('payment', 'Código da cobrança'), c('customer', 'Cliente', 'cliente'), op('status', 'Situação', [['SCHEDULED', 'Agendada'], ['AUTHORIZED', 'Emitida'], ['PROCESSING_CANCELLATION', 'Cancelando'], ['CANCELED', 'Cancelada'], ['CANCELLATION_DENIED', 'Cancelamento negado'], ['ERROR', 'Erro']])] },
  { chave: 'notas.ver', grupo: 'notas', nome: 'Ver nota', metodo: 'GET', caminho: '/invoices/:id', nivel: 'ver' },
  {
    chave: 'notas.agendar', grupo: 'notas', nome: 'Agendar nota de serviço', metodo: 'POST', caminho: '/invoices', nivel: 'operar',
    campos: [c('payment', 'Código da cobrança'), c('customer', 'ou cliente', 'cliente'), ob('serviceDescription', 'Descrição do serviço'), ob('observations', 'Observações'), ob('value', 'Valor', 'dinheiro'), ob('deductions', 'Deduções', 'dinheiro'), ob('effectiveDate', 'Data de emissão', 'data'), c('municipalServiceId', 'Código do serviço (do Asaas)'), c('municipalServiceCode', 'Código do serviço municipal'), ob('municipalServiceName', 'Nome do serviço'),
      c('taxes.retainIss', 'Reter ISS', 'bool'), c('taxes.iss', 'ISS (%)', 'numero'), c('taxes.cofins', 'COFINS (%)', 'numero'), c('taxes.csll', 'CSLL (%)', 'numero'), c('taxes.inss', 'INSS (%)', 'numero'), c('taxes.ir', 'IR (%)', 'numero'), c('taxes.pis', 'PIS (%)', 'numero')],
    aviso: 'É nota de serviço (NFS-e), emitida pelo Asaas. A nota de venda de mercadoria continua em Fiscal.',
  },
  { chave: 'notas.emitir', grupo: 'notas', nome: 'Emitir agora', metodo: 'POST', caminho: '/invoices/:id/authorize', nivel: 'operar' },
  { chave: 'notas.cancelar', grupo: 'notas', nome: 'Cancelar nota', metodo: 'POST', caminho: '/invoices/:id/cancel', nivel: 'operar' },
  { chave: 'notas.fiscal', grupo: 'notas', nome: 'Dados fiscais cadastrados', metodo: 'GET', caminho: '/fiscalInfo', nivel: 'ver' },
  { chave: 'notas.servicos', grupo: 'notas', nome: 'Serviços do município', metodo: 'GET', caminho: '/fiscalInfo/services', nivel: 'ver', filtros: [c('description', 'Buscar serviço')] },
  { chave: 'notas.municipio', grupo: 'notas', nome: 'O que a prefeitura exige', metodo: 'GET', caminho: '/fiscalInfo/municipalOptions', nivel: 'ver' },

  // ───── Recarga de celular ─────
  { chave: 'recargas', grupo: 'recargas', nome: 'Recargas de celular', metodo: 'GET', caminho: '/mobilePhoneRecharges', nivel: 'ver' },
  { chave: 'recargas.ver', grupo: 'recargas', nome: 'Ver recarga', metodo: 'GET', caminho: '/mobilePhoneRecharges/:id', nivel: 'ver' },
  { chave: 'recargas.operadora', grupo: 'recargas', nome: 'Operadora e valores do número', metodo: 'GET', caminho: '/mobilePhoneRecharges/:id/provider', nivel: 'ver' },
  { chave: 'recargas.pedir', grupo: 'recargas', nome: 'Fazer recarga', metodo: 'POST', caminho: '/mobilePhoneRecharges', nivel: 'dinheiro', campos: [ob('phoneNumber', 'Celular com DDD'), ob('value', 'Valor', 'dinheiro')], aviso: 'O valor sai do saldo do Asaas.' },
  { chave: 'recargas.cancelar', grupo: 'recargas', nome: 'Cancelar recarga', metodo: 'POST', caminho: '/mobilePhoneRecharges/:id/cancel', nivel: 'dinheiro' },

  // ───── Split e subcontas ─────
  { chave: 'splits.pagos', grupo: 'splits', nome: 'Splits pagos (repasses que saíram)', metodo: 'GET', caminho: '/payments/splits/paid', nivel: 'ver', filtros: [c('paymentId', 'Código da cobrança'), op('status', 'Situação', [['PENDING', 'Pendente'], ['AWAITING_CREDIT', 'A creditar'], ['DONE', 'Feito'], ['CANCELLED', 'Cancelado'], ['REFUNDED', 'Estornado']])] },
  { chave: 'splits.recebidos', grupo: 'splits', nome: 'Splits recebidos', metodo: 'GET', caminho: '/payments/splits/received', nivel: 'ver', filtros: [c('paymentId', 'Código da cobrança')] },
  { chave: 'splits.totais', grupo: 'splits', nome: 'Totais de split', metodo: 'GET', caminho: '/finance/split/statistics', nivel: 'ver' },
  { chave: 'subcontas', grupo: 'splits', nome: 'Subcontas', metodo: 'GET', caminho: '/accounts', nivel: 'gestao', filtros: [c('cpfCnpj', 'CPF ou CNPJ'), c('email', 'E-mail'), c('name', 'Nome'), c('walletId', 'WalletId')] },
  { chave: 'subcontas.ver', grupo: 'splits', nome: 'Ver subconta', metodo: 'GET', caminho: '/accounts/:id', nivel: 'gestao' },
  {
    chave: 'subcontas.criar', grupo: 'splits', nome: 'Criar subconta', metodo: 'POST', caminho: '/accounts', nivel: 'gestao',
    campos: [ob('name', 'Nome'), ob('email', 'E-mail'), c('loginEmail', 'E-mail de acesso'), ob('cpfCnpj', 'CPF ou CNPJ'), c('birthDate', 'Nascimento (pessoa física)', 'data'), op('companyType', 'Tipo de empresa', [['MEI', 'MEI'], ['LIMITED', 'Limitada'], ['INDIVIDUAL', 'Individual'], ['ASSOCIATION', 'Associação']]), ob('mobilePhone', 'Celular'), ob('incomeValue', 'Faturamento ou renda mensal', 'dinheiro'), ob('address', 'Rua'), ob('addressNumber', 'Número'), c('complement', 'Complemento'), ob('province', 'Bairro'), ob('postalCode', 'CEP')],
    aviso: 'O Asaas devolve a chave de API da subconta uma única vez: copie e guarde num lugar seguro. Ela não fica salva neste sistema.',
  },

  // ───── Webhooks ─────
  { chave: 'webhooks', grupo: 'webhooks', nome: 'Webhooks (avisos do Asaas para sistemas)', metodo: 'GET', caminho: '/webhooks', nivel: 'gestao' },
  { chave: 'webhooks.ver', grupo: 'webhooks', nome: 'Ver webhook', metodo: 'GET', caminho: '/webhooks/:id', nivel: 'gestao' },
  { chave: 'webhooks.criar', grupo: 'webhooks', nome: 'Novo webhook', metodo: 'POST', caminho: '/webhooks', nivel: 'gestao', campos: [ob('name', 'Nome'), ob('url', 'Endereço (https)'), ob('email', 'E-mail para avisos de falha'), ob('enabled', 'Ligado', 'bool'), ob('interrupted', 'Fila parada', 'bool'), c('authToken', 'Token de autenticação', 'texto', { ajuda: 'De 32 a 255 caracteres. O Asaas manda no cabeçalho asaas-access-token.' }), ob('sendType', 'Envio', 'opcao', { opcoes: [['SEQUENTIALLY', 'Em ordem'], ['NON_SEQUENTIALLY', 'Sem ordem']] }), ob('events', 'Eventos (lista)', 'json', { ajuda: 'Ex.: ["PAYMENT_RECEIVED","PAYMENT_CONFIRMED"]' })] },
  { chave: 'webhooks.editar', grupo: 'webhooks', nome: 'Editar webhook', metodo: 'PUT', caminho: '/webhooks/:id', nivel: 'gestao', campos: [c('name', 'Nome'), c('url', 'Endereço (https)'), c('email', 'E-mail para avisos de falha'), c('enabled', 'Ligado', 'bool'), c('interrupted', 'Fila parada', 'bool'), c('authToken', 'Token de autenticação'), op('sendType', 'Envio', [['SEQUENTIALLY', 'Em ordem'], ['NON_SEQUENTIALLY', 'Sem ordem']]), c('events', 'Eventos (lista)', 'json')] },
  { chave: 'webhooks.excluir', grupo: 'webhooks', nome: 'Excluir webhook', metodo: 'DELETE', caminho: '/webhooks/:id', nivel: 'gestao', aviso: 'Sem o webhook deste sistema, os pagamentos deixam de dar baixa sozinhos.' },
  { chave: 'webhooks.destravar', grupo: 'webhooks', nome: 'Destravar a fila (depois de falhas)', metodo: 'POST', caminho: '/webhooks/:id/removeBackoff', nivel: 'gestao' },
];

export const POR_CHAVE = new Map(OPERACOES.map((o) => [o.chave, o]));
/** Permissão do módulo Financeiro que cada nível exige. */
export const ACAO_DO_NIVEL: Record<Nivel, string> = { ver: 'ver', operar: 'editar', dinheiro: 'excluir', gestao: 'excluir' };
