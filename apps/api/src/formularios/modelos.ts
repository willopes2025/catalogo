import type { CampoFormulario } from '@aritana/regras';

/** Modelos prontos para começar um formulário (a equipe edita depois). */
export const MODELOS_FORMULARIO: { chave: string; titulo: string; descricao: string; acao: 'nenhuma' | 'cliente' | 'candidata'; mensagemFinal: string; consentimento: string | null; campos: CampoFormulario[] }[] = [
  {
    chave: 'nps',
    titulo: 'Como foi sua experiência com a Aritana?',
    descricao: 'Leva menos de um minuto. Sua opinião ajuda a gente a melhorar.',
    acao: 'nenhuma',
    mensagemFinal: 'Obrigada pela sua opinião!',
    consentimento: null,
    campos: [
      { id: 'nota', tipo: 'nota', rotulo: 'De 0 a 10, quanto você recomendaria a Aritana a uma amiga?', obrigatorio: true },
      { id: 'onde', tipo: 'escolha', rotulo: 'Onde você comprou?', obrigatorio: false, opcoes: ['Na loja', 'Com uma revendedora', 'Em um evento', 'Pelo Instagram'] },
      { id: 'motivo', tipo: 'texto_longo', rotulo: 'O que mais pesou na sua nota?', obrigatorio: false },
      { id: 'telefone', tipo: 'telefone', rotulo: 'WhatsApp (opcional, se quiser retorno)', obrigatorio: false, papel: 'telefone' },
    ],
  },
  {
    chave: 'cliente',
    titulo: 'Cadastro de cliente Aritana',
    descricao: 'Receba novidades, lançamentos e condições especiais.',
    acao: 'cliente',
    mensagemFinal: 'Cadastro feito! Você vai receber nossas novidades.',
    consentimento: 'Autorizo a Aritana a guardar estes dados e me enviar novidades pelo WhatsApp e e-mail (LGPD).',
    campos: [
      { id: 'nome', tipo: 'texto', rotulo: 'Nome completo', obrigatorio: true, papel: 'nome' },
      { id: 'telefone', tipo: 'telefone', rotulo: 'WhatsApp com DDD', obrigatorio: true, papel: 'telefone' },
      { id: 'email', tipo: 'email', rotulo: 'E-mail', obrigatorio: false, papel: 'email' },
      { id: 'cidade', tipo: 'texto', rotulo: 'Cidade', obrigatorio: false, papel: 'cidade' },
      { id: 'aniversario', tipo: 'data', rotulo: 'Aniversário (ganhe um mimo no mês)', obrigatorio: false },
      { id: 'gosta', tipo: 'multipla', rotulo: 'Do que você mais gosta?', obrigatorio: false, opcoes: ['Brincos', 'Colares', 'Anéis', 'Pulseiras', 'Conjuntos'] },
    ],
  },
  {
    chave: 'evento',
    titulo: 'Inscrição no evento',
    descricao: 'Garanta seu lugar e receba as informações pelo WhatsApp.',
    acao: 'cliente',
    mensagemFinal: 'Inscrição confirmada! Mandaremos os detalhes pelo WhatsApp.',
    consentimento: 'Autorizo a Aritana a usar estes dados para falar comigo sobre o evento (LGPD).',
    campos: [
      { id: 'nome', tipo: 'texto', rotulo: 'Nome completo', obrigatorio: true, papel: 'nome' },
      { id: 'telefone', tipo: 'telefone', rotulo: 'WhatsApp com DDD', obrigatorio: true, papel: 'telefone' },
      { id: 'acompanhantes', tipo: 'numero', rotulo: 'Quantas pessoas vão com você?', obrigatorio: false },
      { id: 'revendedora', tipo: 'escolha', rotulo: 'Tem interesse em revender?', obrigatorio: false, opcoes: ['Sim', 'Talvez', 'Não'] },
    ],
  },
];
