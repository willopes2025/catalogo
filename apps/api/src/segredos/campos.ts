/** Campos que cada integração pede, na ordem em que aparecem na tela Configurações › Integrações. */
export interface CampoIntegracao {
  nome: string;
  rotulo: string;
  /** Senha/chave: nunca volta para a tela, só os últimos caracteres. */
  secreto?: boolean;
  opcoes?: [string, string][];
  ajuda?: string;
  /** O sistema pode gerar o valor (token do webhook). */
  gerar?: boolean;
  /** Pode ser mostrado por inteiro a quem edita configurações (é preciso copiar para outro sistema). */
  mostrar?: boolean;
}

export interface Integracao {
  chave: string;
  nome: string;
  descricao: string;
  campos: CampoIntegracao[];
  ondeConseguir: string;
}

export const INTEGRACOES: Integracao[] = [
  {
    chave: 'email',
    nome: 'E-mail',
    descricao: 'Código para assinar contrato e promissória, avisos automáticos e resumo da equipe.',
    ondeConseguir: 'Dados do servidor de e-mail da Aritana (o provedor do domínio, Google Workspace, Brevo ou Amazon SES).',
    campos: [
      { nome: 'SMTP_SERVIDOR', rotulo: 'Servidor SMTP', ajuda: 'Ex.: smtp.gmail.com, smtp-relay.brevo.com' },
      { nome: 'SMTP_PORTA', rotulo: 'Porta', opcoes: [['465', '465 (SSL)'], ['587', '587 (STARTTLS)'], ['25', '25']] },
      { nome: 'SMTP_USUARIO', rotulo: 'Usuário' },
      { nome: 'SMTP_SENHA', rotulo: 'Senha', secreto: true, ajuda: 'No Google, use uma "senha de app".' },
      { nome: 'EMAIL_REMETENTE', rotulo: 'Remetente', ajuda: 'Ex.: Aritana Semijoias <naoresponda@aritanaonline.com.br>' },
      { nome: 'EMAIL_SUPORTE', rotulo: 'E-mail que recebe os chamados de suporte' },
    ],
  },
  {
    chave: 'asaas',
    nome: 'Asaas',
    descricao: 'Boleto e Pix das parcelas, com baixa automática quando a pessoa paga.',
    ondeConseguir: 'No painel do Asaas da Aritana: Integrações › Chave de API. No mesmo lugar, cadastre o webhook com o endereço e o token abaixo.',
    campos: [
      { nome: 'ASAAS_AMBIENTE', rotulo: 'Ambiente', opcoes: [['sandbox', 'Testes (sandbox)'], ['producao', 'Produção']] },
      { nome: 'ASAAS_API_KEY', rotulo: 'Chave da API', secreto: true, ajuda: 'Começa com $aact_' },
      { nome: 'ASAAS_WEBHOOK_TOKEN', rotulo: 'Token do webhook', secreto: true, gerar: true, mostrar: true, ajuda: 'Copie para o campo "Token de autenticação" do webhook no Asaas.' },
    ],
  },
  {
    chave: 'fiscal',
    nome: 'Focus NFe (notas fiscais)',
    descricao: 'NFC-e da loja e dos eventos, NF-e de remessa da maleta e notas do acerto.',
    ondeConseguir: 'Conta da Aritana na Focus NFe: cadastre a empresa, envie o certificado A1, a série e o CSC da NFC-e no painel deles e copie o token aqui.',
    campos: [
      { nome: 'FOCUS_NFE_AMBIENTE', rotulo: 'Ambiente', opcoes: [['homologacao', 'Homologação (testes, sem valor fiscal)'], ['producao', 'Produção']] },
      { nome: 'FOCUS_NFE_TOKEN', rotulo: 'Token da empresa', secreto: true, ajuda: 'Um token por ambiente: use o de homologação para testar.' },
    ],
  },
  {
    chave: 'meta_ads',
    nome: 'Meta Ads (Facebook e Instagram)',
    descricao: 'Traz o valor gasto em cada campanha para calcular o custo por candidata em Marketing.',
    ondeConseguir: 'No Gerenciador de Negócios da Aritana: crie um usuário do sistema com permissão de leitura de anúncios (ads_read), gere o token e copie o número da conta de anúncios (act_...).',
    campos: [
      { nome: 'META_ADS_CONTA', rotulo: 'Conta de anúncios', ajuda: 'Ex.: act_1234567890' },
      { nome: 'META_ADS_TOKEN', rotulo: 'Token de acesso', secreto: true },
    ],
  },
  {
    chave: 'assertiva',
    nome: 'Assertiva (consulta de CPF)',
    descricao: 'Preenche o cadastro da representante pelo CPF.',
    ondeConseguir: 'Credenciais de API pedidas ao gerente de conta da Assertiva (a Aritana já usa no Jueri).',
    campos: [
      { nome: 'ASSERTIVA_CLIENT_ID', rotulo: 'Client ID' },
      { nome: 'ASSERTIVA_CLIENT_SECRET', rotulo: 'Client secret', secreto: true },
    ],
  },
  {
    chave: 'jueri',
    nome: 'Jueri (migração)',
    descricao: 'Traz do Jueri produtos, revendedoras, clientes, maletas abertas e contas a receber, em Configurações › Importar.',
    ondeConseguir: 'No Jueri: Configurações › API › Gerar token. O ID do cliente da Aritana no Jueri é 11566. Depois da virada, apague o token no Jueri.',
    campos: [
      { nome: 'JUERI_CLIENTE_ID', rotulo: 'ID do cliente no Jueri', ajuda: 'Da Aritana: 11566' },
      { nome: 'JUERI_TOKEN', rotulo: 'Token da API', secreto: true },
    ],
  },
];

export const NOMES_PERMITIDOS = new Set(INTEGRACOES.flatMap((i) => i.campos.map((c) => c.nome)));
export const SECRETOS = new Set(INTEGRACOES.flatMap((i) => i.campos.filter((c) => c.secreto).map((c) => c.nome)));
