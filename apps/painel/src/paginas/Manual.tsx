import { useState } from 'react';
import { Topo } from '../componentes/ui';

interface Secao { id: string; titulo: string; passos: { t: string; d: string }[]; dicas?: string[] }

/** Manual de uso: um passo a passo curto por rotina, para a equipe consultar no dia a dia. */
const SECOES: Secao[] = [
  {
    id: 'primeiro',
    titulo: 'Primeiro acesso',
    passos: [
      { t: 'Entre com o e-mail e a senha provisória', d: 'A senha provisória é entregue por quem criou o seu usuário. Ela aparece uma única vez para quem cria.' },
      { t: 'Troque a senha', d: 'No menu lateral, embaixo do seu nome, clique em "Trocar senha". Use pelo menos 8 caracteres.' },
      { t: 'Veja só o que é seu', d: 'O menu mostra apenas os módulos que o seu grupo pode ver. Se faltar algo, peça à Diretoria em Configurações → Grupos e permissões.' },
    ],
  },
  {
    id: 'candidatas',
    titulo: 'Candidatas: do anúncio à aprovação',
    passos: [
      { t: 'Divulgue o formulário', d: 'Em Candidatas, "Copiar link do formulário". Nos anúncios, acrescente ?utm_source=instagram&utm_campaign=nome-da-campanha ao link: o sistema mostra de onde vem cada candidata e quantas foram aprovadas.' },
      { t: 'Faça o primeiro contato', d: 'Abra o cartão da candidata, toque em WhatsApp (a mensagem já vem pronta), anote o que combinaram e marque a data de retorno.' },
      { t: 'Mova pelo quadro', d: 'Novas → Em contato → Entrevista → Documentos. Recusa sempre com o motivo.' },
      { t: 'Aprove', d: '"Aprovar e criar representante" cria o cadastro com o limite inicial das regras e abre a ficha para completar CPF, endereço e contrato.' },
    ],
  },
  {
    id: 'portal',
    titulo: 'Portal da representante (app)',
    passos: [
      { t: 'Mande o acesso', d: 'Na ficha da representante, "Acesso ao portal" e depois "Enviar pelo WhatsApp". O link vale 7 dias e funciona uma vez; depois ela entra com o CPF e um código que chega no e-mail.' },
      { t: 'O que ela vê', d: 'A maleta com fotos e preços, a data do acerto, as parcelas com Pix copia e cola, as vendas e a comissão de cada mês, e o botão para compartilhar o catálogo.' },
      { t: 'Pré-baixa', d: 'Ela marca o que já vendeu; no acerto isso aparece para conferência.' },
      { t: 'Pedidos de peças', d: 'Ela escolhe peças do depósito; o pedido chega em Maletas › Pedidos das representantes, onde você monta a maleta ou responde.' },
      { t: 'Instalar no celular', d: 'No Android aparece "Instalar o app"; no iPhone, Compartilhar › Adicionar à Tela de Início.' },
    ],
  },
  {
    id: 'rede',
    titulo: 'Cadastrar uma representante',
    passos: [
      { t: 'Rede → Nova representante', d: 'Preencha CPF, telefone, endereço e duas referências. O CPF é validado e não pode repetir.' },
      { t: 'Consulte o crédito', d: 'Na ficha, use "Consultar na Assertiva" (quando a integração estiver ligada). O resultado fica guardado na ficha.' },
      { t: 'Defina o limite e o nível', d: 'O limite inicial vem das Regras do consignado; dá para mudar na ficha. O nível define a comissão.' },
      { t: 'Contrato', d: 'Na aba Documentos, gere o contrato e envie o link de assinatura pelo WhatsApp. Ela assina pelo celular.' },
    ],
  },
  {
    id: 'maleta',
    titulo: 'Montar e entregar uma maleta',
    passos: [
      { t: 'Maletas → Nova maleta', d: 'Escolha a representante. Se ela estiver bloqueada (atraso, limite, contrato), o sistema mostra o motivo e não deixa seguir.' },
      { t: 'Bipe as peças', d: 'Cada bipe soma uma peça. O valor total aparece ao lado do limite disponível.' },
      { t: 'Imprima', d: 'Na maleta, imprima a lista de separação (sem valores, para o estoque) e o pedido (com valores, para a representante assinar).' },
      { t: 'Promissória e NF-e de remessa', d: 'Gere a promissória para assinatura e, se for o caso, a nota de remessa em consignação.' },
    ],
    dicas: ['A maleta vira um "local" de estoque: as peças saem do depósito e ficam no nome da representante até o acerto.'],
  },
  {
    id: 'acerto',
    titulo: 'Fazer o acerto',
    passos: [
      { t: 'Abra a maleta e clique em "Fazer acerto"', d: 'Bipe as peças que voltaram. O que não voltou conta como vendido.' },
      { t: 'Marque perdas', d: 'Peça perdida ou quebrada pela representante é cobrada conforme a regra (preço de custo ou de venda).' },
      { t: 'Confira o cálculo', d: 'O sistema mostra vendido, comissão, multa e juros de atraso e o valor a pagar. Escolha à vista ou parcelado.' },
      { t: 'Feche', d: 'Ao fechar, o estoque volta para o depósito, as parcelas entram no Financeiro e o limite é revisto automaticamente.' },
    ],
  },
  {
    id: 'loja',
    titulo: 'Vender na loja ou no evento',
    passos: [
      { t: 'Lojas → Abrir o caixa', d: 'Informe o troco inicial. Cada local tem um caixa por vez.' },
      { t: 'Bipe as peças e receba', d: 'Aceita várias formas no mesmo pagamento (Pix + dinheiro, por exemplo). O troco é calculado.' },
      { t: 'Nota da cliente', d: 'Na venda, emita a NFC-e. O recibo pode ser impresso ou enviado.' },
      { t: 'Feche o caixa', d: 'Conte forma por forma. A diferença fica registrada.' },
    ],
    dicas: ['Devolução vira crédito para a cliente e pode pagar outra compra.', 'Cancelar só no mesmo dia; depois disso, use devolução.'],
  },
  {
    id: 'estoque',
    titulo: 'Estoque, inventário e etiquetas',
    passos: [
      { t: 'Entrada de mercadoria', d: 'Estoque → Entrada. Bipe as peças e informe a chave da nota do fornecedor.' },
      { t: 'Transferência', d: 'Do depósito para a loja ou para o evento, e de volta.' },
      { t: 'Inventário', d: 'Estoque → Inventário e ajuste. Escolha o local, bipe tudo o que está lá e clique em "Conferir diferenças". No inventário completo, o que não foi bipado é zerado. Informe o motivo e grave.' },
      { t: 'Etiquetas', d: 'Estoque → Etiquetas. Bipe as peças (ou carregue tudo de um local), ajuste as quantidades e imprima. Tamanho e conteúdo em Configurações → Avisos e regras.' },
      { t: 'Rastreio', d: 'Bipe qualquer peça para ver onde ela está e todo o caminho que fez.' },
    ],
  },
  {
    id: 'garantia',
    titulo: 'Garantia e conserto',
    passos: [
      { t: 'Garantia → Nova ordem', d: 'Bipe a peça e informe o nº da venda ou da maleta: a cliente e a data da compra vêm sozinhas, e o sistema avisa se está fora do prazo.' },
      { t: 'Assistência', d: 'Se precisar, envie para a assistência com a previsão de volta.' },
      { t: 'Decida', d: 'Troca (bipe a peça nova e escolha de onde sai), conserto, devolução ao fornecedor ou recusa com o motivo. A peça com defeito vai para o local "Avarias e garantia".' },
      { t: 'Conserto pago', d: 'Ao concluir, o valor recebido entra no Financeiro.' },
    ],
  },
  {
    id: 'precificacao',
    titulo: 'Precificação',
    passos: [
      { t: 'A fórmula', d: 'Em Produtos › Precificação cada peça mostra a conta da planilha: custo do banho = peso da peça × coeficiente do metal (reais por grama); custo total = custo bruto + banho; preço sugerido = custo total × markup + insumos, arredondado para a terminação escolhida (por exemplo …,90). O sugerido é só o ponto de partida: o preço que vale é o que você põe em "Novo preço".' },
      { t: 'Ajustar e gravar', d: 'Digite o peso, o custo bruto, o metal, o coeficiente (quando a peça foge do padrão) e os insumos direto na linha: a conta refaz na hora. Clique no valor sugerido para usá-lo como novo preço, ou em "Usar o sugerido em todas". Os campos alterados ficam destacados e nada é gravado até clicar em "Gravar". Ao gravar, o custo do produto passa a ser a soma da composição e o preço muda só nas peças em que você informou novo preço.' },
      { t: 'Regras', d: 'O botão "Regras" guarda o coeficiente do ouro e o da prata, o markup por faixa de custo (peça mais barata pode levar markup maior), os insumos por peça e a terminação do preço. Quem tem permissão de editar Configurações pode mudar. Peça já precificada guarda o coeficiente com que foi gravada; mudar a regra vale para as demais.' },
      { t: 'Importar a planilha', d: '"Importar planilha" lê o arquivo .xlsx no formato da planilha de reprecificação (colunas Código de Barras, Referência, Peso, Cor, Custo Compra Bruto, Custo Banho Ouro/Prata, Custo Insumos e Novo Preço). O sistema acha cada peça pelo código de barras ou pela referência, mostra o que vai mudar e avisa quais códigos não encontrou. Só grava depois de você conferir e clicar em "Gravar". "Exportar" gera a planilha da tela atual.' },
    ],
  },
  {
    id: 'financeiro',
    titulo: 'Financeiro',
    passos: [
      { t: 'Plano de contas', d: 'Em Financeiro › Plano de contas ficam as contas em que cada receita e despesa é classificada. Os grupos de 1 a 9 são as linhas da DRE (receita, deduções, custos, despesas com vendas, pessoal, administrativas, financeiro, outras e o que fica fora do resultado). Crie contas e subcontas (até 4 níveis), mude o nome, mova de grupo ou desative. As contas "automáticas" são preenchidas pelo sistema com as vendas, os acertos e o custo das peças.' },
      { t: 'Novo lançamento', d: 'Em Financeiro › Lançamentos, clique em "+ Novo lançamento": despesa ou receita, descrição, conta do plano, valor e vencimento. Dá para parcelar (uma parcela por mês) ou marcar "Já foi paga", escolhendo o dia e a conta bancária. "Editar" corrige a descrição e a conta de qualquer título; valor e vencimento mudam só enquanto está em aberto e sem boleto.' },
      { t: 'Classificar o que está sem conta', d: 'Marque "Só sem conta do plano", selecione os títulos e use "Classificar em…" para pôr todos na conta certa de uma vez. O que o sistema lança sozinho (acertos, vendas, comissões, taxas de cartão, devoluções) já entra classificado.' },
      { t: 'DRE', d: 'Em Financeiro › DRE, escolha o período (até 24 meses), a empresa (todas juntas ou um CNPJ só) e o regime: caixa (pelo dia do pagamento) ou competência (pelo vencimento, incluindo o que está em aberto). Cada grupo abre nas contas e subcontas; embaixo de cada valor aparece o percentual sobre a receita líquida (ou dentro do grupo) e a barrinha mostra o peso da conta. Clique num valor para ver os lançamentos que o formam. "Exportar" gera a planilha.' },
      { t: 'Contas bancárias e caixas', d: 'Em Financeiro › Contas bancárias, cadastre cada banco, caixa ou carteira digital com o saldo inicial e os dados (agência, conta, Pix). "Transferir entre contas" tira de uma e põe na outra sem mexer no resultado. "Extrato" mostra as entradas e saídas do período com o saldo linha a linha. Para desativar uma conta, o saldo precisa estar zerado.' },
      { t: 'Asaas', d: 'Em Financeiro › Asaas fica a conta do Asaas inteira, sem precisar entrar no site: saldo e resumo, cobranças (criar, editar, 2ª via, linha digitável, Pix, estornar), parcelamentos, assinaturas, links de pagamento, clientes, extrato, transferências (Pix, TED ou outra conta Asaas), chaves e QR Codes Pix, pagamento de boletos, antecipação, negativação, consulta Serasa, notas de serviço, recarga, split, subcontas e webhooks. Cada lista tem filtros e um menu "Ações…" por linha. Cobrança que pertence a um título do sistema aparece marcada: editar ou excluir essa cobrança é feito no título; estornar por aqui desfaz a baixa do título. O que tira dinheiro do saldo ou tem custo só aparece para quem tem a permissão "excluir" no Financeiro, pede uma confirmação a mais e fica na auditoria. "Configurar o webhook deste sistema", na Visão geral, liga a baixa automática.' },
      { t: 'Contas a receber', d: 'Parcelas dos acertos e vendas a prazo. Gere Pix ou boleto pelo Asaas; a baixa é automática quando a cliente paga.' },
      { t: 'Contas a pagar', d: 'Fornecedores, despesas e comissões fechadas.' },
      { t: 'Baixa manual', d: 'Para pagamentos fora do Asaas, informe a data e o valor recebido.' },
      { t: 'Cartões (conciliar)', d: 'Com o extrato da maquininha aberto, marque o que caiu (por dia, débito ou crédito e maquininha), digite o valor depositado e escolha a conta. O sistema baixa tudo de uma vez e lança a diferença como despesa "Taxas de cartão", então o saldo da conta bate com o banco.' },
    ],
  },
  {
    id: 'cobranca',
    titulo: 'Cobrança: carteiras, acordos, régua e protesto',
    passos: [
      { t: 'Painel', d: 'Em Cobrança, o painel mostra o vencido com multa e juros, separado por faixa de atraso (clique na faixa para ver os devedores), o recuperado no mês, as promessas de pagamento dos próximos dias, os retornos combinados e o resultado de cada cobrador.' },
      { t: 'Carteira', d: 'Lista quem tem título vencido, do maior valor para o menor. Marque os devedores e use "Passar para…" para entregar à equipe interna ou a uma empresa terceirizada. A carteira guarda desde quando o devedor está com cada cobrador, para contar o recuperado e a comissão.' },
      { t: 'Terceirizada', d: 'Em Cobradores e acessos, cadastre a empresa como Terceirizada e crie o acesso de quem vai trabalhar (nome e e-mail). A senha provisória aparece uma vez só: passe por um canal seguro. Essa pessoa entra direto na Cobrança e vê só os devedores passados para a empresa; não vê Financeiro, cadastros nem outros módulos, não muda carteira e não manda a protesto.' },
      { t: 'Ficha do devedor', d: 'Mostra os títulos com o valor de hoje (multa e juros), o boleto atual, os acordos e todo o histórico. Registre cada ligação, WhatsApp ou visita; marque "Prometeu pagar" com data e valor. A promessa vira "cumprida" sozinha quando o pagamento entra, ou "quebrada" se a data passar.' },
      { t: '2ª via', d: 'Escolha o novo vencimento e se vai com multa e juros. O sistema emite o boleto novo no Asaas, apaga o anterior e atualiza o cadastro da pessoa no Asaas. O título passa a apontar só para o boleto novo, então a baixa automática continua funcionando.' },
      { t: 'Acordo', d: 'Marque os títulos e clique em "Fazer acordo": desconto, entrada, número de parcelas e o primeiro vencimento. A simulação mostra cada parcela antes de confirmar. Os títulos de origem ficam como renegociados e as parcelas novas ganham boleto. O desconto respeita o limite de cada um (cobrador ou gestão), configurado em Cobrança › Configurar.' },
      { t: 'Acordo quebrado', d: 'Se uma parcela passar do prazo configurado (padrão 15 dias), o acordo quebra sozinho: as parcelas em aberto são canceladas e a dívida antiga volta, já descontado o que foi pago (dos títulos mais antigos para os mais novos). A gestão também pode cancelar um acordo pela ficha.' },
      { t: 'Régua', d: 'Mensagens automáticas por WhatsApp ou e-mail em dias fixos em relação ao vencimento (por exemplo, 3 dias antes, no dia, 3, 10 e 30 depois). Títulos da mesma pessoa vão numa mensagem só, com o link do boleto. Use "Ver o que sai hoje" antes de ligar. No WhatsApp oficial, cada passo precisa de um template aprovado pela Meta. Pause a régua de um devedor pela ficha quando estiver negociando.' },
      { t: 'Protesto', d: 'Depende do convênio da Aritana com a CRA do estado. Com o convênio, preencha Configurações › Integrações › Protesto (CRA21) com o endereço de homologação, o usuário, a senha e o código de apresentante. Na ficha, marque os títulos e clique em "Mandar a protesto": o sistema confere CPF/CNPJ, endereço, CEP e o mínimo de dias antes de enviar. A confirmação (protocolo) e o retorno do cartório são buscados a cada 3 horas.' },
      { t: 'Pagou depois do protesto', d: 'Quando o devedor paga à Aritana (boleto, Pix, baixa manual ou acordo quitado), o sistema pede sozinho a desistência, se o título ainda está no cartório, ou autoriza o cancelamento, se já foi protestado. Pago no próprio cartório, o título recebe a baixa pelo retorno da CRA.' },
    ],
    dicas: [
      'Multa, juros e carência ficam em Cobrança › Configurar e valem para todos os títulos: carteira, 2ª via, régua e acordos.',
      'Na homologação, a aba Protesto mostra cada arquivo trocado com a CRA, para conferir com eles antes de liberar a produção.',
      'A comissão da terceirizada é só um relatório: o pagamento é feito fora do sistema.',
    ],
  },
  {
    id: 'comissoes',
    titulo: 'Fechar as comissões do mês',
    passos: [
      { t: 'Comissões → escolha o mês', d: 'A prévia mostra cada vendedora com o vendido menos as devoluções, o percentual e a meta.' },
      { t: 'Feche o mês', d: 'Gera uma conta a pagar por pessoa, com vencimento no dia configurado do mês seguinte.' },
      { t: 'Errou?', d: 'Enquanto nenhuma comissão foi paga, "Reabrir o mês" cancela as contas e permite fechar de novo.' },
    ],
  },
  {
    id: 'avisos',
    titulo: 'Avisos automáticos',
    passos: [
      { t: 'Configurações → Avisos e regras', d: 'Ligue os avisos, escolha a hora e quantos dias antes lembrar o acerto e a parcela.' },
      { t: 'Resumo da equipe', d: 'Informe os e-mails que recebem, toda manhã, o resumo de maletas atrasadas, parcelas vencidas e garantias paradas.' },
      { t: 'Enviar agora', d: 'O botão envia na hora o que estiver pendente. Cada aviso sai uma vez só.' },
    ],
  },
  {
    id: 'pontos',
    titulo: 'Pontos, prêmios, ranking e score',
    passos: [
      { t: 'Regras dos pontos', d: 'Pontos e prêmios › Regras dos pontos: quanto vale cada R$ 100 vendidos, o acerto em dia, a meta do nível batida e a parcela paga no prazo. Os pontos entram sozinhos.' },
      { t: 'Prêmios', d: 'Cadastre os prêmios e quantos há de cada um. Eles aparecem no app da representante, que resgata quando tiver pontos.' },
      { t: 'Resgates', d: 'O pedido chega em Resgates. Marque como entregue ou cancele; no cancelamento, os pontos e o prêmio voltam.' },
      { t: 'Ranking do mês', d: 'Quem mais vendeu nos acertos do mês. No app, cada uma vê a própria posição e as outras só pelo primeiro nome.' },
      { t: 'Score interno', d: 'De 0 a 1000, só a matriz vê: pontualidade, pagamento, giro da maleta, perdas e tempo de casa. Ajuda a decidir limite e quem precisa de acompanhamento.' },
      { t: 'Revisão de níveis', d: 'O sistema sugere subir ou descer de nível pela média de vendas dos 3 últimos meses; você aplica uma a uma.' },
    ],
  },
  {
    id: 'formularios',
    titulo: 'Formulários: pesquisas, cadastros e inscrições',
    passos: [
      { t: 'Comece por um modelo', d: 'Formulários › escolha "Pesquisa de satisfação", "Cadastro de cliente" ou "Inscrição no evento", ou comece em branco. Ajuste as perguntas e salve.' },
      { t: 'Cadastro automático', d: 'Em "Ao receber uma resposta", escolha cadastrar cliente ou abrir candidatura. Marque a pergunta do nome e a do telefone com o papel certo; o mesmo telefone não duplica o cadastro.' },
      { t: 'Divulgue o link', d: '"Copiar link" e mande pelo WhatsApp, Instagram ou QR code no balcão. Para saber de onde veio cada resposta, gere o link em Marketing › Gerar link rastreável.' },
      { t: 'Veja as respostas', d: 'O resumo mostra as escolhas mais marcadas e o NPS (promotores menos detratores). Dá para baixar tudo em planilha.' },
      { t: 'Encerrar', d: 'Em Editar, mude a situação para "Encerrado": o link sai do ar e as respostas ficam guardadas.' },
    ],
  },
  {
    id: 'pedidos-link',
    titulo: 'Venda pelo link (catálogo com pedido)',
    passos: [
      { t: 'O link', d: 'Cada consultora tem o catálogo dela (na ficha, "Link do catálogo"). Ela manda para as clientes ou põe na bio do Instagram.' },
      { t: 'A cliente pede', d: 'Escolhe as peças, monta a sacola e envia com nome, WhatsApp, cidade e se vai retirar, receber em casa ou combinar. O preço e o estoque são sempre os do sistema.' },
      { t: 'Peças da maleta', d: 'Quem tem maleta aberta mostra as peças dela. O pedido aparece no portal, em Clientes: ela confirma, entrega e marca "Entreguei". As peças entram como vendidas na pré-baixa da maleta e a matriz confere no acerto.' },
      { t: 'Afiliada ou sem maleta', d: 'O catálogo mostra o estoque da matriz. O pedido aparece em Vendas › Pedidos pelo link: a equipe confirma, separa e clica em "Faturar". Vira uma venda, sai do estoque e a consultora ganha a comissão no fechamento do mês.' },
      { t: 'Regras', d: 'Em Vendas › Pedidos pelo link › Regras: comissão, estoque que atende, entrega em casa e mensagem final. Desligando, o catálogo volta a ter só o botão do WhatsApp.' },
    ],
    dicas: [
      'Todo pedido também abre um card no funil de clientes do CRM, com a etiqueta "Pedido pelo link", e a consultora recebe o aviso no WhatsApp.',
      'Enquanto o pedido está em aberto, as peças ficam seguradas: outra cliente não consegue pedir a mesma peça. Cancelar libera.',
      'A venda faturada pelo link não conta como comissão de loja de quem faturou.',
    ],
  },
  {
    id: 'scorecard',
    titulo: 'Scorecard da equipe',
    passos: [
      { t: 'Como funciona', d: 'Cada pessoa é avaliada uma vez por mês. A nota de cada indicador é quanto da meta ela atingiu (até o teto); a nota final é a média pelos pesos, mais os acertos e menos os erros registrados no mês (dentro do limite). A faixa em que a nota cai define quanto do bônus cheio ela recebe. Tudo isso é configurado pela gestão no próprio sistema. Quem avalia é quem tem o módulo Scorecard (a Gerência e a Diretoria, de início), e ninguém avalia a si mesmo.' },
      { t: 'Indicadores', d: 'Na aba Indicadores, cadastre cada indicador com nome, perspectiva (financeira, clientes, processos internos, aprendizado e crescimento), meta, peso e se quanto maior ou quanto menor é melhor. Ele pode valer para todos, para um setor ou só para uma pessoa. O resultado pode ser lançado à mão ou vir de uma conta do sistema: vendas de loja (valor ou quantidade), conversas atendidas no CRM, tarefas concluídas, tarefas feitas no prazo e tarefas atrasadas.' },
      { t: 'Acertos e erros', d: 'Na aba Acertos e erros (ou dentro da avaliação), registre na hora em que acontece: quem, quando, se foi acerto ou erro, quantos pontos e o que aconteceu. Ninguém registra acerto ou erro de si mesmo.' },
      { t: 'Avaliar o mês', d: 'Na aba Avaliar o mês aparece toda a equipe, com a nota e o bônus de cada um (prévia enquanto a avaliação está aberta). Clique na pessoa, lance os resultados (o sistema já traz os automáticos), escreva uma observação e use "Guardar". "Fechar a avaliação" grava a nota, o bônus e a foto dos indicadores daquele mês: mudar o indicador ou as regras depois não altera a avaliação fechada. "Reabrir" volta a deixar editar. "Exportar" gera a planilha do mês com o bônus de cada um, para o pagamento.' },
      { t: 'Bônus e regras', d: 'Na aba Bônus e regras ficam o teto da nota (100 ou mais, se quiser premiar quem supera a meta), o limite de pontos dos acertos e erros, o bônus cheio por pessoa e por setor, as faixas (ex.: nota 90 recebe 100% do bônus, 75 recebe 70%) e se cada pessoa vê a própria avaliação na Minha mesa. O bônus não é lançado sozinho no Financeiro: use a planilha exportada para pagar.' },
    ],
  },
  {
    id: 'mesa',
    titulo: 'Minha mesa: conversa interna, tarefas e painel do setor',
    passos: [
      { t: 'O que é', d: 'Minha mesa fica no alto do menu, para todo mundo que usa o painel. Reúne três coisas: o painel com os indicadores do seu setor, as suas tarefas e a conversa interna com a equipe.' },
      { t: 'Conversa interna', d: 'Clique no nome de uma pessoa da equipe para abrir a conversa com ela (a bolinha verde mostra quem está usando o sistema agora). "Novo grupo" cria uma conversa com várias pessoas; dá para marcar um setor inteiro de uma vez. Só quem participa da conversa lê as mensagens. Enter envia; Shift+Enter pula linha. O clipe (📎) anexa foto, PDF, planilha, documento, áudio ou vídeo de até 10 MB; também dá para colar uma imagem direto na caixa de texto. Foto aparece na conversa; os outros arquivos abrem ou baixam com um clique. Só quem participa da conversa abre o anexo.' },
      { t: 'Aviso na tela', d: 'Quando chega uma mensagem ou alguém passa uma tarefa para você, aparece um aviso no canto de baixo da tela, em qualquer página, e o número ao lado de "Minha mesa" no menu mostra as mensagens não lidas e as tarefas atrasadas. Clicar no aviso abre a conversa. O aviso pode levar até 15 segundos para aparecer. Para ser avisado mesmo com o sistema em outra aba, clique em "Ativar avisos do navegador" no alto da Minha mesa e permita no navegador.' },
      { t: 'Tarefas', d: '"Nova tarefa" cria uma tarefa para você ou para outra pessoa, com prazo e prioridade. As suas tarefas aparecem também no Início. Quem recebeu marca como feita; mudar o texto, o prazo ou o responsável é com quem passou a tarefa ou com a gestão. "Que eu passei" mostra o que você delegou e ainda não foi feito; a gestão tem também "Da equipe toda".' },
      { t: 'Painel do setor e de cada pessoa', d: 'Cada pessoa vê os indicadores do painel dela. Quem pode editar Configurações usa o botão "Montar painéis" para escolher até 12 indicadores por setor (grupo de usuários) ou por pessoa: vendas, maletas, acertos atrasados, a receber vencido, a pagar, promessas de pagamento, fila do CRM, candidatas, estoque mínimo, garantias e tarefas atrasadas. O painel da pessoa vale mais que o do setor; sem nenhum, aparecem os dos módulos a que ela tem acesso. Indicador de um módulo que a pessoa não pode ver não aparece para ela.' },
      { t: 'Meu scorecard', d: 'Quando a gestão fecha a sua avaliação do mês no Scorecard da equipe, ela aparece na Minha mesa com a nota e o bônus. Clique no mês para ver cada indicador, os acertos e erros registrados e a observação.' },
    ],
  },
  {
    id: 'ia',
    titulo: 'Inteligência artificial',
    passos: [
      { t: 'Ensinar a IA', d: 'Quando uma resposta da IA no chat não for boa, clique em "Corrigir a IA" embaixo da mensagem e escreva a regra: "quando acontecer isto, responda aquilo". Se você pode editar Configurações, a lição já vale na próxima resposta; senão, fica esperando a gestão aprovar. Em CRM › Configurar › Agente de IA, o bloco "O que a IA aprendeu" mostra as lições esperando aprovação e as que estão valendo; dá para aprovar, recusar, pausar, editar, apagar e escrever uma nova. As lições podem valer para todos os especialistas ou só para um.' },
      { t: 'Revisão semanal', d: 'Toda segunda-feira de manhã a IA relê as conversas que passou para a equipe na semana e em que uma pessoa respondeu, e sugere lições com o que ela poderia ter respondido sozinha. As sugestões ficam esperando aprovação: nada entra nas instruções sem a gestão aprovar. O botão "Revisar a semana agora" faz o mesmo na hora.' },
      { t: 'Memória de cada cliente', d: 'A IA guarda um resumo curto do que conversou com cada pessoa (o que procura, gostos, cidade, pendência combinada) e usa nas próximas conversas, para não perguntar tudo de novo. Ela não guarda saúde, documentos, endereço completo, dados de pagamento nem valor de dívida. No chat, o menu ⋮ › "O que a IA lembra desta pessoa" mostra o resumo; a equipe pode corrigir ou apagar. Para desligar, desmarque "Lembrar de cada cliente" na configuração do agente.' },
      { t: 'O que a IA faz sozinha no WhatsApp', d: 'Em CRM › Configurar › Agente de IA, o bloco "O que ela pode fazer sozinha" liga ou desliga quatro funções: dizer as parcelas em aberto e mandar a 2ª via (Pix ou boleto pelo Asaas); anotar a promessa de pagamento na Cobrança, até o número de dias que você definir; consultar se a peça existe, o preço e se há em estoque (sem dizer a quantidade); e registrar no recrutamento quem quer ser revendedora. Ela só mostra parcelas de quem escreve do telefone que está no cadastro: o sistema reconhece o número sozinho quando ele bate com um único cadastro. Não dá desconto, não muda valor nem vencimento e não fecha venda; contestação de dívida, desconto e parcelamento ela passa para a equipe. Cada coisa que ela faz aparece como recado interno na conversa.' },
      { t: 'Ligar', d: 'Em Configurações › Integrações › Inteligência artificial, cole a chave do Claude (agente, sugestões, maleta e reconhecer peça) e a da OpenAI (foto de catálogo). Cada uma funciona sozinha; sem a chave, os botões daquele recurso não aparecem.' },
      { t: 'Agente no WhatsApp', d: 'Em CRM › Configurar › Agente de IA: ligue, escolha os números, escreva como ela deve atender e o que precisa saber da empresa. Ela responde quem escreve enquanto ninguém pegou a conversa, e passa para a equipe (com um recado interno) quando pedem atendente, em reclamação, pagamento ou troca, e quando não sabe.' },
      { t: 'No chat', d: '"✨ Sugerir" escreve uma resposta para você revisar. No menu ⋮, "Acionar IA" liga a IA só naquela conversa. As mensagens dela aparecem marcadas com "IA". Quando alguém da equipe escreve ou pega a conversa, ela sai.' },
      { t: 'Especialistas (multiagentes)', d: 'Em CRM › Configurar › Agente de IA › Especialistas, clique em "Criar os sugeridos" (Vendas, Quero revender e Revendedora) ou crie os seus. A recepção lê a conversa, faz até uma pergunta se o assunto não estiver claro e passa para o especialista; se a pessoa muda de assunto, ele passa para o outro. Todos se apresentam com o mesmo nome. Cada troca vira um recado interno no chat, e passando do limite de trocas a conversa vai para a equipe. A IA já sabe quando quem escreve é revendedora (maleta, data do acerto, parcelas) e não pergunta de novo.' },
      { t: 'Transcrição de áudio', d: 'Com a chave da OpenAI preenchida, todo áudio que chega no chat é transcrito sozinho: o texto aparece embaixo do player ("📝 Transcrição") e na lista de conversas. O agente de IA lê a transcrição e responde ao que a pessoa falou. Para transcrever só quando quiser, mude em Configurações › Integrações › Inteligência artificial › "Áudios recebidos no chat"; aí aparece o botão "📝 Transcrever" em cada áudio. Se falhar, o motivo aparece e dá para tentar de novo.' },
      { t: 'Buscar a peça pela foto', d: 'Em Produtos, "📷 Buscar por foto": tire ou escolha a foto da peça. A IA descreve, procura no cadastro e compara com as fotos dos produtos, mostrando a mais provável primeiro.' },
      { t: 'Sugerir a maleta', d: 'Em Maletas › Nova, depois de escolher a representante: "Sugerir". A IA propõe as peças pelo que ela vende, pelo que gira na empresa e pelo estoque de saída. Você ajusta e cria a maleta normalmente.' },
      { t: 'Foto de catálogo', d: 'Na ficha do produto, "✨ Gerar foto com IA": escolha a foto de base e o estilo (fundo branco, em uma modelo ou em ambiente). A foto só entra no produto quando você aprova.' },
    ],
    dicas: [
      'A IA só afirma sobre a empresa o que estiver escrito em "O que ela precisa saber". Preencha endereço, horário, pagamento e como funciona a revenda.',
      'Confira a foto gerada com a peça de verdade antes de usar: a IA pode mudar um detalhe.',
      'Na busca por foto, confira a referência na etiqueta: peças muito parecidas podem confundir.',
      'O uso é cobrado pela Anthropic e pela OpenAI, pelo consumo. A aba Agente de IA mostra quantas chamadas foram feitas no mês.',
      'Em "Produtos", agora também dá para enviar e tirar fotos do produto, mesmo sem IA.',
    ],
  },
  {
    id: 'chat',
    titulo: 'Conversas do WhatsApp (chat do CRM)',
    passos: [
      { t: 'Nova conversa', d: 'Em CRM › Conversas, "+ Nova conversa": escolha o número, digite o telefone com DDD e, se quiser, o nome. A conversa abre em "Minhas", pronta para escrever, mesmo que a pessoa não tenha card.' },
      { t: 'Responder citando', d: 'Passe o mouse na mensagem e clique em ↩. A pessoa vê, no WhatsApp dela, a qual mensagem você respondeu.' },
      { t: 'Reagir', d: 'No 😀 da mensagem, escolha o emoji. As reações do contato aparecem embaixo do balão.' },
      { t: 'Áudio, fotos e arquivos', d: '"🎤 Áudio" grava pelo microfone. "📎 Arquivo" anexa; também dá para colar uma imagem (Ctrl+V) ou arrastar o arquivo para a conversa. O que você escrever vai como legenda.' },
      { t: 'Apagar para todos', d: 'Na 🗑 de uma mensagem enviada por vocês (até 2 dias depois do envio). No número oficial da Meta isso não existe.' },
      { t: 'Emojis e formulários', d: '😀 abre os emojis. "📋 Formulário" coloca na mensagem o link de um formulário do sistema.' },
      { t: 'Menu ⋮ da conversa', d: 'Fixar no topo da lista, marcar como não lida, copiar o telefone e exportar a conversa em texto. O lápis ao lado do nome muda o nome do contato. A gestão também pode unificar com outro contato (a mesma pessoa com dois números) e excluir a conversa.' },
      { t: 'Notas e tarefas', d: 'As abas "Notas" e "Tarefas" em cima da conversa são as mesmas do card da pessoa. Se ela ainda não tem card, a própria aba cria.' },
      { t: 'Filtros e seleção', d: '"Filtros" mostra só as conversas de uma etiqueta, de um responsável ou de um período. "Selecionar" marca várias conversas para resolver, transferir, devolver para a fila ou marcar como lidas de uma vez.' },
    ],
    dicas: [
      'Mensagens não chegam? Em CRM › Configurar › Números de WhatsApp, cada número mostra o "último aviso do WhatsApp para o sistema". Se estiver vazio ou antigo, clique em "Reapontar webhook".',
      '"Só não lidas" filtra a lista. A conversa fixada fica sempre em primeiro.',
      'No celular, os botões de cada mensagem ficam sempre visíveis embaixo do balão.',
    ],
  },
  {
    id: 'meta',
    titulo: 'Meta (Facebook e Instagram) dentro do sistema',
    passos: [
      { t: 'Ligar', d: 'Em Configurações › Integrações › Meta Ads, cole o token do usuário do sistema. Depois, em Marketing › Meta › Configurar, escolha na lista a conta de anúncios, a página, o catálogo e o funil que recebe os leads. A mesma tela mostra quais permissões o token tem e quais faltam.' },
      { t: 'Anúncios', d: 'Gasto, alcance, cliques, leads e conversas de cada campanha no período. Clique no nome para abrir os conjuntos e os anúncios. Dá para pausar, ativar e mudar o orçamento por dia.' },
      { t: 'Catálogo', d: '"Enviar produtos para o Meta" manda os produtos ativos do catálogo com foto, preço e estoque. Serve para a loja do Instagram, os anúncios de catálogo e o catálogo do WhatsApp.' },
      { t: 'Públicos', d: 'Cria no Meta um público com os clientes, as representantes ativas ou as candidatas que autorizaram o uso dos dados. A partir dele, crie um público semelhante (pessoas parecidas, no Brasil).' },
      { t: 'Leads de formulário', d: 'Quem preenche um formulário de anúncio vira card no funil escolhido, com a campanha de origem. Pode entrar sozinho a cada 10 minutos ou pelo botão "Trazer agora".' },
      { t: 'Página', d: 'Seguidores e as publicações recentes com curtidas, comentários e compartilhamentos.' },
    ],
    dicas: [
      'Criar campanha e anúncio continua no Gerenciador de Anúncios; o sistema acompanha e ajusta.',
      'Só entra em público quem tem a autorização de uso dos dados (LGPD) marcada no cadastro. Telefone e e-mail saem embaralhados.',
      'Para os leads de formulário, o token precisa também da permissão leads_retrieval.',
      'Toda mudança (pausar, orçamento, público, catálogo) fica registrada na auditoria com quem fez.',
    ],
  },
  {
    id: 'app',
    titulo: 'App da representante (Android e iPhone)',
    passos: [
      { t: 'O que é', d: 'O mesmo portal da representante, instalado como app. Ela entra com o mesmo acesso e vê maleta, clientes, pedidos, agenda e comissões. Tudo que muda no sistema aparece no app sem precisar atualizar a loja.' },
      { t: 'Notificações', d: 'No app, ela recebe aviso no celular quando chega cliente perto dela, quando entra pedido pelo catálogo e quando um compromisso é marcado. Tocando no aviso, abre a tela certa.' },
      { t: 'Ligar as notificações', d: 'Em Configurações › Integrações › Notificações no app: para Android, cole a conta de serviço do Firebase; para iPhone, a chave .p8 da Apple com o Key ID e o Team ID.' },
      { t: 'Publicar', d: 'O passo a passo para colocar na Play Store e na App Store está no arquivo app-representante/PUBLICAR.md do projeto.' },
    ],
    dicas: [
      'Sem as chaves das notificações, o app funciona normalmente, só não avisa no celular.',
      'Quando a representante sai do app (botão Sair), o celular para de receber os avisos dela.',
      'A política de privacidade que as lojas pedem fica em /privacidade no endereço do sistema.',
    ],
  },
  {
    id: 'agenda',
    titulo: 'Agenda e Google Meet',
    passos: [
      { t: 'Marcar', d: 'Agenda › Novo compromisso, ou "Agendar" no card do CRM e na ficha da revendedora. Escolha o tipo (entrevista, acerto por vídeo, retirada de maleta, reunião), o dia, a hora, com quem e o responsável.' },
      { t: 'Horário ocupado', d: 'Se o responsável já tem algo no mesmo horário, o sistema avisa. Dá para escolher outro horário ou marcar mesmo assim.' },
      { t: 'Online com Meet', d: 'Com a conta Google conectada, compromisso online vai para o Google Agenda da Aritana e ganha link do Meet sozinho. Sem o Google, cole qualquer link de chamada.' },
      { t: 'Lembretes', d: 'Quem vem recebe pelo WhatsApp a confirmação na hora, um lembrete na véspera e outro uma hora antes. Remarcar ou cancelar também avisa.' },
      { t: 'Depois', d: 'Abra o compromisso e marque "Realizado" ou "Não compareceu". Tudo fica no histórico do card do CRM.' },
    ],
    dicas: [
      'Conectar o Google (uma vez): em Configurações › Integrações › Google, cole o Client ID e o Client secret criados no Google Cloud da Aritana; depois, na tela Agenda, clique em "Conectar conta Google" e autorize.',
      'A revendedora vê os compromissos dela no portal, confirma a presença e entra na chamada pelo botão que aparece meia hora antes.',
      'O sistema nunca vê a senha do Google: a autorização pode ser removida a qualquer momento em myaccount.google.com › Segurança.',
    ],
  },
  {
    id: 'distribuicao',
    titulo: 'Leads para a consultora mais perto',
    passos: [
      { t: 'Ligue no funil', d: 'CRM › Configurar › Distribuição por localização: escolha o funil (Clientes da loja, Recrutamento…), para quem vai (consultoras ou só líderes), a distância máxima, o prazo para aceitar e quantas pessoas tentar.' },
      { t: 'Formulário do anúncio', d: 'No formulário de cliente, pergunte a cidade (papel Cidade) e escolha "Abrir card no CRM". Cada resposta vira um card que vai sozinho para a consultora mais perto.' },
      { t: 'A consultora aceita no portal', d: 'Ela recebe o aviso no WhatsApp e abre "Clientes" no portal. Antes de aceitar vê só o primeiro nome e a cidade; depois, o telefone e o botão para chamar no WhatsApp. No fim, marca "Vendi" ou "Não deu certo".' },
      { t: 'Sem aceite no prazo', d: 'Passa para a próxima mais perto. Esgotadas as tentativas, ou se ninguém estiver perto, o card fica com a equipe com a etiqueta "Sem consultora".' },
      { t: 'No card', d: 'O bloco "Consultora perto" mostra com quem está e desde quando, e deixa escolher outra na mão, passar para a próxima ou tirar dela.' },
    ],
    dicas: [
      'A distância é medida entre as cidades (centro de cada uma). Sem cidade, vale a região do DDD do telefone.',
      'Só recebe quem está ativa e tem a cidade no cadastro.',
      'No recrutamento, a líder que atendeu e recomendou vira a líder da nova revendedora quando a matriz aprova.',
    ],
  },
  {
    id: 'marketing',
    titulo: 'Marketing: custo e retorno das campanhas',
    passos: [
      { t: 'Cadastre a campanha', d: 'Marketing › Campanhas: nome, canal, código (utm_campaign) e quanto foi investido.' },
      { t: 'Use o link rastreável', d: 'Em "Gerar link rastreável", escolha a campanha e o destino (formulário de revendedoras ou outro). Use esse link no anúncio.' },
      { t: 'Acompanhe', d: 'Resultados mostra, por campanha, as candidatas, as aprovadas, o custo de cada uma e quanto as aprovadas já venderam nos acertos.' },
      { t: 'Meta Ads', d: 'Com a integração ligada (Configurações › Integrações) e o id da campanha do Meta preenchido, "Atualizar gasto do Meta Ads" traz o valor investido sozinho, mês a mês.' },
      { t: 'Mês a mês e gastos', d: 'Lance o que não vem do Meta (agência, Google Ads, influenciadora, brindes), com ou sem campanha. A tela mostra por mês o investido, os leads do CRM, as candidatas, as aprovadas, o custo de cada revendedora aprovada e quanto elas já venderam.' },
    ],
  },
  {
    id: 'rh',
    titulo: 'RH e ponto eletrônico',
    passos: [
      { t: 'Cadastrar o funcionário', d: 'RH e ponto › Novo funcionário. Preencha os dados, o contrato e a escala de horário. Em "Nível de acesso", escolha "Somente ponto" para quem só bate ponto (motoboy, estoque) ou um grupo do sistema para quem também trabalha nele. Sem e-mail, o login é o CPF. A senha provisória aparece uma vez: passe para a pessoa.' },
      { t: 'Bater o ponto', d: 'O funcionário entra pelo celular (ou pelo computador) e toca em "Registrar entrada". O sistema tira uma selfie, confere o GPS e grava com a hora do servidor. Cada batida gera um comprovante com número (NSR) e código de verificação.' },
      { t: 'Ajustar o ponto', d: 'Na ficha do funcionário › Ponto: o "＋" inclui uma batida esquecida e o "✕" desconsidera uma batida errada, sempre com motivo. A marcação original nunca é apagada (Portaria 671). Faltas, atestados e férias ficam em "Faltas e afastamentos".' },
      { t: 'Fechar o mês', d: 'RH e ponto › Ponto do mês › Fechar o mês. Cada funcionário recebe o espelho no celular e confirma. A ciência fica registrada com data e hora.' },
      { t: 'Guardar documentos', d: 'Na ficha › Documentos: contrato, carta de admissão, exames (ASO), contracheques, atestados, advertências, rescisão. Com data de validade, o sistema avisa quando um exame ou contrato de experiência vai vencer. O que for liberado aparece para o funcionário, que confirma o recebimento.' },
      { t: 'Mandar para a contabilidade', d: 'RH e ponto › Enviar à contabilidade: escolha o mês e o que vai (resumo do ponto, espelho diário, faltas e atestados, admissões e desligamentos com documentos, vendas por vendedora, comissões, AFD e AEJ). "Ver o que vai" mostra e baixa cada arquivo; "Enviar agora" manda por e-mail ou WhatsApp e guarda o histórico.' },
    ],
    dicas: [
      'Cadastre os locais de trabalho com "Usar onde estou" (em Configurar) estando na loja: assim a cerca do GPS fica certa.',
      'Para o motoboy, que trabalha na rua, deixe a regra do GPS em "Registrar e sinalizar": a batida fora do local aparece marcada no espelho, sem impedir o registro.',
      'Ajustou uma batida ou lançou atestado num mês que já estava fechado? O fechamento daquele funcionário é desfeito: feche o mês de novo para ele confirmar o espelho corrigido.',
      'Na pasta do funcionário, PDF e foto abrem na tela; Word, Excel e outros tipos são baixados.',
      'Para o ponto valer como registro oficial (REP-P), o programa precisa do registro no INPI. Depois de registrado, preencha o número em Configurar.',
      'Envie o certificado A1 (e-CNPJ, .pfx) de cada empresa em RH › Configurar: o AFD e o AEJ passam a sair assinados (.zip com o arquivo e o .p7s), como pede a Portaria 671.',
      'Contracheque: a contabilidade manda o PDF, você guarda na pasta do funcionário com o mês, e ele recebe no celular.',
    ],
  },
  {
    id: 'indicadores',
    titulo: 'Indicadores: os números para decidir',
    passos: [
      { t: 'Visão do negócio', d: 'Em Relatórios, a primeira aba mostra faturamento, receita da empresa (já sem a comissão das revendedoras), lucro bruto, margem e dinheiro recebido, sempre comparados com o período anterior. No topo ficam os avisos do que pede decisão.' },
      { t: 'Rede', d: 'Cada consultora com vendido, tendência, % das peças vendidas, giro da maleta e o que deve. Use os filtros "Em risco", "Paradas" e "Abaixo da meta" para saber com quem falar primeiro.' },
      { t: 'Produtos', d: 'O que mais fatura e dá margem, a sugestão de reposição (produtos com menos de 30 dias de estoque), o capital parado (90+ dias sem vender) e o que a rede mais devolve.' },
      { t: 'Financeiro', d: 'Resultado mês a mês (vendas, comissão, custo das peças, despesas), o caixa previsto para as próximas 8 semanas e quem deve, por tempo de atraso.' },
      { t: 'CRM', d: 'Conversão de cada funil, de onde vêm os leads que fecham, motivos de perda e tempo de espera na fila.' },
      { t: 'Histórico do Jueri', d: 'Em Configurações › Importar, "Verificar histórico" mostra quantos acertos antigos existem no Jueri, sem gravar nada. Depois marque "Histórico de acertos já baixados", simule e importe. Ele aparece em Relatórios › Rede (venda mês a mês e o que mais vendia) e na aba Maletas de cada consultora. Não mexe em estoque, maletas nem contas.' },
      { t: 'Metas', d: 'Defina no começo do mês o faturamento, a meta da rede, de cada loja ou evento e de novas revendedoras. Todo dia o sistema mostra o realizado, a projeção pelo ritmo e quanto falta vender por dia. "Copiar do mês anterior" agiliza. As metas aparecem também no Início.' },
    ],
    dicas: [
      'Faturamento é sempre líquido: vendas canceladas não entram e devoluções são descontadas.',
      'Margem só fica certa com o custo preenchido no cadastro do produto.',
      'O resultado desconta as despesas que foram lançadas e baixadas no Financeiro. Lance aluguel, folha e fornecedores lá, com categoria.',
      'Venda no cartão não é inadimplência: o repasse da maquininha aparece à parte, como "cartão para conciliar".',
      'Toda tabela ordena ao clicar no título da coluna e vai para o Excel.',
    ],
  },
  {
    id: 'implantacao',
    titulo: 'Implantação: o que falta para começar',
    passos: [
      { t: 'Configurações › Implantação', d: 'Mostra o que falta para entregar o sistema, por grupo: notas fiscais, financeiro (Asaas, plano de contas, contas bancárias), cobrança, regras do negócio (inclusive a precificação), documentos, comunicação, atendimento (WhatsApp, IA, aplicativo), o que a Wide ainda vai desenvolver e a virada (usuários, senhas, importação do Jueri, treinamento).' },
      { t: 'Integrações', d: 'Quando a Aritana tiver os acessos (e-mail, Asaas, Focus NFe, Assertiva), preencha em Configurações › Integrações e use "Testar conexão".' },
      { t: 'Aditivo de cobrança', d: 'Em Configurações › Modelos de documento há o modelo do aditivo "serviço de cobrança", ainda PROVISÓRIO: ele permite que a consultora indique vendas a prazo dela para a Aritana cobrar das clientes, abrindo uma exceção na cláusula 10ª do contrato. Antes de usar, o jurídico precisa revisar o texto e a Aritana definir a taxa do serviço. Depois de aprovado, tire a linha "MODELO PROVISÓRIO" do início do texto.' },
      { t: 'Contrato', d: 'O modelo de contrato instalado é o contrato estimatório que a Aritana já usa, com os dados das partes preenchidos pelo sistema (nome, CPF, estado civil, profissão e endereço da consultora; razão social, CNPJ, endereço, telefone e e-mail da matriz). Preencha endereço, telefone e e-mail da matriz em Configurações › Empresas, senão o contrato sai com linhas em branco. O texto pode ser trocado em Configurações › Modelos de documento.' },
      { t: 'Confirmações', d: 'Itens que só a Aritana pode garantir (certificado A1, CFOPs do contador, jurídico, regras) são marcados como "Feito" por quem confirmou.' },
      { t: 'Apagar os dados de teste', d: 'No dia da virada, a Diretoria apaga os dados de teste (digitando APAGAR) e importa os dados reais.' },
      { t: 'Importar do Jueri', d: 'Em Configurações › Integrações › Jueri, salve o ID do cliente (11566) e o token gerado no Jueri (Configurações › API). Depois, em Configurações › Importar planilhas, escolha as partes e o local do estoque e clique em Simular: nada é gravado e aparece o relatório. Conferido, clique em Importar de verdade. Pode repetir: o que já veio é atualizado, nunca duplicado; maletas já trazidas não se repetem.' },
      { t: 'Regras do Jueri', d: 'Em Configurações › Regras do consignado, o botão "Usar regras do Jueri" preenche comissão fixa de 30%, acerto em 30 dias, meta de 30%, sem multa, sem juros e sem bloqueio (0 = nunca bloqueia, só avisa). Quem tem comissão diferente (ex.: representantes com 10%) recebe a comissão própria no cadastro, em Rede › Modelo e rede.' },
    ],
  },
  {
    id: 'seguranca',
    titulo: 'Segurança e auditoria',
    passos: [
      { t: 'Permissões por grupo', d: 'Cada grupo tem ver, criar, editar e excluir por módulo. Dê só o necessário.' },
      { t: 'Auditoria', d: 'Configurações → Auditoria mostra quem fez o quê e quando: acertos, ajustes de estoque, mudanças de regras, cancelamentos.' },
      { t: 'Quem sai da empresa', d: 'Desative o usuário em Configurações → Usuários. O histórico continua.' },
      { t: 'Cópia de segurança', d: 'O banco é copiado todo dia de madrugada no servidor e as cópias ficam 30 dias.' },
    ],
  },
  {
    id: 'suporte',
    titulo: 'Precisa de ajuda?',
    passos: [
      { t: 'Suporte → Novo chamado', d: 'Descreva o que aconteceu, em qual tela, e anexe um print se puder. A Wide responde pelo próprio chamado.' },
    ],
  },
];

export function Manual() {
  const [ativa, setAtiva] = useState(SECOES[0].id);
  const s = SECOES.find((x) => x.id === ativa)!;
  return (
    <>
      <Topo eb="Ajuda" titulo="Manual de uso" sub="O passo a passo de cada rotina, para consultar no dia a dia" acoes={<button className="botao claro" onClick={() => window.print()}>Imprimir esta parte</button>} />
      <div className="manual">
        <nav className="manual-indice" aria-label="Rotinas">
          {SECOES.map((x) => (
            <button key={x.id} className={x.id === ativa ? 'ativo' : ''} onClick={() => setAtiva(x.id)}>{x.titulo}</button>
          ))}
        </nav>
        <article className="cartao">
          <h2 style={{ marginTop: 0 }}>{s.titulo}</h2>
          <ol className="manual-passos">
            {s.passos.map((p, i) => (
              <li key={i}><b>{p.t}</b><p>{p.d}</p></li>
            ))}
          </ol>
          {s.dicas && (
            <div className="aviso ok" style={{ marginTop: 12 }}>
              {s.dicas.map((d, i) => <div key={i}>{d}</div>)}
            </div>
          )}
        </article>
      </div>
    </>
  );
}
