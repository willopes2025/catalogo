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
    descricao: 'Liga a área Marketing › Meta: campanhas e resultados, pausar e orçamento, catálogo de produtos, públicos, leads de formulário e a página. Depois de salvar o token, escolha a conta, a página e o catálogo em Marketing › Meta › Configurar.',
    ondeConseguir: 'No Gerenciador de Negócios da Aritana: crie um usuário do sistema, atribua a ele a conta de anúncios, a página e o catálogo, e gere o token com as permissões ads_read, ads_management, business_management, catalog_management, pages_show_list, pages_read_engagement e pages_manage_ads (e leads_retrieval, para os leads de formulário). Só com ads_read o sistema mostra os gastos, sem as outras funções.',
    campos: [
      { nome: 'META_ADS_CONTA', rotulo: 'Conta de anúncios', ajuda: 'Ex.: act_1234567890. Também dá para escolher numa lista em Marketing › Meta › Configurar.' },
      { nome: 'META_ADS_TOKEN', rotulo: 'Token de acesso', secreto: true },
    ],
  },
  {
    chave: 'google',
    nome: 'Google Agenda e Meet',
    descricao: 'Compromissos online da Agenda vão para o Google da Aritana com link do Meet. Depois de salvar, clique em "Conectar conta Google" na tela Agenda.',
    ondeConseguir: 'No Google Cloud Console da Aritana: crie um projeto, ative a "Google Calendar API", configure a tela de consentimento e crie uma credencial "ID do cliente OAuth" do tipo Aplicativo da Web. Em "URIs de redirecionamento autorizados", cole o endereço mostrado na tela Agenda (termina em /api/agenda/google/retorno).',
    campos: [
      { nome: 'GOOGLE_CLIENT_ID', rotulo: 'Client ID', ajuda: 'Termina em .apps.googleusercontent.com' },
      { nome: 'GOOGLE_CLIENT_SECRET', rotulo: 'Client secret', secreto: true },
      { nome: 'GOOGLE_AGENDA_ID', rotulo: 'Agenda (opcional)', ajuda: 'Vazio = agenda principal da conta conectada. Para outra, cole o ID dela (Configurações da agenda › Integrar agenda).' },
    ],
  },
  {
    chave: 'push',
    nome: 'Notificações do app da representante',
    descricao: 'Avisa no celular da representante (app da Play Store e da App Store): cliente perto, pedido pelo catálogo e compromisso marcado.',
    ondeConseguir: 'Android: no Firebase da Aritana, Configurações do projeto › Contas de serviço › Gerar nova chave privada (arquivo .json); cole o conteúdo inteiro. iPhone: no Apple Developer da Aritana, Keys › criar chave com "Apple Push Notifications service (APNs)", baixe o .p8 e copie o Key ID e o Team ID.',
    campos: [
      { nome: 'FIREBASE_CONTA_SERVICO', rotulo: 'Firebase: conta de serviço (JSON inteiro)', secreto: true },
      { nome: 'APNS_CHAVE_P8', rotulo: 'Apple: chave .p8 (conteúdo inteiro)', secreto: true },
      { nome: 'APNS_KEY_ID', rotulo: 'Apple: Key ID' },
      { nome: 'APNS_TEAM_ID', rotulo: 'Apple: Team ID' },
      { nome: 'APNS_AMBIENTE', rotulo: 'Apple: ambiente', opcoes: [['producao', 'Produção (App Store e TestFlight)'], ['sandbox', 'Testes (app instalado pelo Xcode)']] },
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
