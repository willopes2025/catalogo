/**
 * Modelos de documento que vêm instalados.
 * O contrato é o texto que a Aritana usa (contrato estimatório para vendas em consignação com reserva de domínio),
 * com os dados das partes trocados por variáveis. A promissória ainda é PROVISÓRIA.
 * Ambos podem ser trocados em Configurações › Modelos de documento.
 */
export const MODELOS_INICIAIS = [
  {
    tipo: 'contrato' as const,
    modeloTrabalho: 'consignado' as const,
    titulo: 'Contrato estimatório de consignação · {{nome}}',
    conteudo: `CONTRATO ESTIMATÓRIO PARA VENDAS EM CONSIGNAÇÃO COM RESERVA DE DOMÍNIO

{{empresa_nome}}, pessoa jurídica de direito privado, inscrita no CNPJ {{empresa_cnpj}}, com sede na {{empresa_endereco}}, telefone: {{empresa_telefone}}, e-mail: {{empresa_email}}, doravante denominada CONSIGNANTE.

{{nome}}, {{estado_civil}}, {{profissao}}, inscrita no CPF sob o nº {{cpf}}, domiciliada à {{endereco}}, {{cidade}}/{{uf}}, CEP: {{cep}}, telefone: {{telefone}}, e-mail: {{email}}, doravante denominada CONSIGNATÁRIA.

As partes acima identificadas têm, entre si, justo e acertado o presente contrato para vendas em consignação com reserva de domínio, que se regerá pelas normas legais e pelas cláusulas seguintes.

OBJETO
Cláusula 1ª. O presente contrato tem como objeto os produtos colocados à venda originários da CONSIGNANTE, semijoias e acessórios.

OBRIGAÇÕES DA CONSIGNANTE
Cláusula 2ª. São obrigações da CONSIGNANTE:
a) entregar a CONSIGNATÁRIA os produtos nos prazos e nas condições preestabelecidas neste instrumento, juntamente com o termo de entrega de mercadoria e nota promissória assinado pela CONSIGNATÁRIA;
b) garantir o fornecimento de produtos dentro do limite de crédito;
c) descontar, do valor a pagar, a comissão da CONSIGNATÁRIA;
d) entregar as peças à CONSIGNATÁRIA em perfeito estado e etiquetadas;
e) conferir todas as peças devolvidas pela CONSIGNATÁRIA, lavrando termo de entrega juntamente com nova nota promissória, em duas vias, assinados pela CONSIGNATÁRIA;
f) lavrar termo de retirada de mercadoria, acerto das vendas e conserto, quando necessários;
g) repor as mercadorias à CONSIGNATÁRIA de acordo com o limite de crédito pré-estabelecido na análise de crédito;
h) fornecer certificados de garantia, de forma virtual/on-line, de acordo com o índice de vendas.

OBRIGAÇÕES DA CONSIGNATÁRIA
Cláusula 3ª. São obrigações da CONSIGNATÁRIA:
a) conferir todas as peças levadas em consignação no ato de recebimento do mostruário, juntamente com o termo de entrega de mercadorias;
b) manter as peças em perfeito estado, com etiquetas perfeitas e sem rasuras, em todas as peças, bem como, manter as peças limpas;
c) responsabilizar-se por qualquer tipo dano nas peças que estão sob seu domínio, exceto os de fabricação;
d) responsabilizar-se pela entrega e retirada de peças para eventuais consertos, que não forem abrangidos pela garantia, com custo totalmente absorvido pela CONSIGNATÁRIA;
e) efetuar pontualmente a restituição e/ou pagamento das peças, ou seja, prestar contas no máximo a cada 30 (trinta) dias;
f) não remover as etiquetas de preço das peças e efetuar as vendas pelos valores estabelecidos;
g) caberá a CONSIGNATÁRIA zelar pelos produtos relacionados em relatórios de produtos consignados, que desde já passam a fazer parte do presente instrumento, os quais a CONSIGNATÁRIA reconhece como válidos e perfeitos;
h) assinar todos os termos de entrega de mercadoria, devolução, consertos e notas promissórias;
i) responsabiliza-se a CONSIGNATÁRIA a prestar contas mensalmente com a CONSIGNANTE, em datas pré-agendadas;
j) prestar contas mensalmente quanto às mercadorias vendidas;

PRESTAÇÃO DE CONTAS
Cláusula 4ª. A CONSIGNATÁRIA se obriga a comparecer MENSALMENTE às dependências da CONSIGNANTE no prazo máximo de 30 (trinta) dias da retirada das peças, em data pré-agendada, para reunião denominada “acerto”.
Parágrafo primeiro. No dia do acerto as peças serão devolvidas e a CONSIGNATÁRIA efetuará o pagamento das peças vendidas.
Parágrafo segundo. Peças danificadas, sem cobertura da garantia, não poderão ser devolvidas ou trocadas, devendo ser pagas à CONSIGNANTE.
Parágrafo terceiro. Os acertos feitos a distância, poderão ser realizados via internet, com o envio da listagem das peças vendidas, oportunidade em que as peças deverão ser enviadas via SEDEX ou por portador de confiança de ambas as partes.
Parágrafo quarto. Todos os meses é obrigatório a realização de um acerto. O não cumprimento acarreta redução da comissão de 25% (vinte e cinco por cento) a 0% (zero por cento), ou seja, não é permitido ausência de acerto mensal.
Parágrafo quinto. O custo do envio do Sedex ficará a cargo de quem receber os produtos, ou seja, quando a CONSIGNATÁRIA enviar, quem realiza o pagamento é a CONSIGNANTE, e quando a CONSIGNANTE enviar, quem efetua o pagamento é a CONSIGNATÁRIA.
Parágrafo sexto. A CONSIGNANTE poderá requerer a busca e apreensão das peças em poder da CONSIGNATÁRIA, além de perdas e danos, bem como, rescindir o contrato em caso de ausência na reunião de acerto ou inadimplência.

COMISSIONAMENTO
Cláusula 5ª. A comissão será paga no importe variável de 0% (zero por cento) a 40% (quarenta por cento), da seguinte forma:
a) vendas inferiores a R$100,00 (cem reais) terão o percentual de comissão de 0% (zero por cento);
b) vendas de R$101,00 (cento e um reais) a R$299,00 (duzentos e noventa e nove reais) terão comissionamento no percentual de 15% (quinze por cento);
c) vendas de R$300,00 (trezentos reais) a R$500,00 (quinhentos reais) terão comissionamento no percentual de 25% (vinte e cinco por cento);
d) vendas iguais ou superiores a R$500,00 (quinhentos reais) terão como comissão o percentual de 30% (trinta por cento).
e) vendas superiores de 50% do total do pedido (termo de entrega), o comissionamento terá percentual de 40% (quarenta por cento).
Parágrafo primeiro. A ausência injustificada à reunião de acerto, gera imediata faculdade a CONSIGNANTE de cobrá-los por todos os meios jurídicos admitidos, acrescidos de todos os encargos descritos na Cláusula 5ª, parágrafos primeiro e segundo, do valor total das peças que estejam em posse da CONSIGNATÁRIA, ou seja, não haverá pagamento de comissão, ocorrendo a antecipação dos débitos vincendos.

PAGAMENTO
Cláusula 6ª. O pagamento será realizado da seguinte forma: à vista ou a prazo podendo ser dividido da seguinte forma: 2 (duas) parcelas, sendo uma entrada de 50% (cinquenta por cento) em dinheiro, transferência bancária ou pix, e o saldo remanescente em até 30 (trinta) dias, através de cartão de crédito, de débito, boleto, transferência bancária ou pix.
Parágrafo primeiro. A inadimplência no pagamento acarretará em multa de 20% (vinte por cento), juros mensais de 1% (um por cento) e correção monetária IPCA/IBGE, no valor total da mercadoria não devolvida.
Parágrafo segundo. Em caso de atraso superior a 10 (dez) dias, a cobrança se dará por meio de escritório de advocacia, acarretando em pagamentos de honorários advocatícios de 20% (vinte por cento), sem prejuízos dos encargos do parágrafo anterior.
Parágrafo terceiro. Eventuais débitos, superiores a 10 (dez) dias, decorrentes do presente contrato serão comunicados às entidades mantenedoras de banco dados de proteção de crédito (Serasa, SPC, cartório de títulos e protestos, dentre outros), tais débitos incluirão todas as despesas com as medidas administrativas e judiciais: cível e criminal.

GARANTIA
Cláusula 7ª. A garantia das semijoias é de 12 (doze) meses para peças com banho de ouro e 06 (seis) meses para peças com banho de prata, a contar da data da compra.
Parágrafo primeiro. A CONSIGNANTE isenta-se por defeitos ocasionados por contato com cremes, pomadas, suor, loções, ou quaisquer outros produtos químicos, reagentes ou resíduos corporais que causem danos às peças.
Parágrafo segundo. A CONSIGNANTE também não se responsabiliza por danos nas peças causados por tempo de uso, oxidação, arranhões, desgastes, quedas e uso inadequado da peça.
Parágrafo terceiro. Os serviços de consertos serão devidamente anotados em termo próprio, com descrição do estado da peça. No caso de solda, não existe garantia contra eventual rompimento desta.
Parágrafo quarto. Os prazos para consertos serão de 45 (quarenta e cinco) dias úteis.
Parágrafo quinto. A garantia cobre defeitos de fabricação da peça, acabamento e no banho, como pontos escuros em toda a peça. Para que haja reposição de pedras, a CONSIGNATÁRIA deverá fornecer a pedra a ser reposta. A CONSIGNANTE não realiza reposição de pedras sem que a pedra seja entregue junto a peça defeituosa.
Parágrafo sexto. Após análise do setor responsável, não ocorrendo a possibilidade de reparação da peça defeituosa, será concedido crédito de igual valor para a CONSIGNATÁRIA.

RESPONSABILIDADE SOLIDÁRIA
Cláusula 8ª. Ao assinar o presente instrumento em conjunto com outra CONSIGNATÁRIA, reconhecem e concordam, de forma expressa e voluntária, que responderão solidariamente e ilimitadamente, ou seja, responderão em conjunto pelo cumprimento de todas as obrigações, ônus, deveres, encargos e quaisquer outros compromissos, por ação ou omissão, podendo praticar atos relativos a compra e assinatura de notas promissórias, isoladamente.
Parágrafo primeiro. Respondem solidariamente pela execução pela execução do presente instrumento, administrativamente e de forma judicial cível ou criminal referente a este contrato e seus anexos, tais como: termo de entrega de mercadoria e notas promissórias, dentre outros.
Parágrafo segundo. Ambas as partes se comprometem a cumprir integralmente todas as obrigações, ônus, deveres, encargos e quaisquer outros compromissos, responsabilizando-se pelo descumprimento contratual ou inadimplência, mesmo que praticado por somente uma das partes CONSIGNATÁRIA.
Parágrafo terceiro. A falta de comunicação pelo descumprimento contratual ou inadimplemento a uma das partes CONSIGNATÁRIA, não afetará a validade da comunicação realizada à outra.
Parágrafo quarto. A responsabilidade solidária é indivisível, caso uma das partes não cumpra a obrigação, a outra parte ficará obrigada a cumprir a totalidade das obrigações, podendo, posteriormente, buscar reembolso da parte inadimplente.
Parágrafo quinto. Eventuais débitos, superiores a 15 (quinze) dias, decorrentes do presente contrato serão comunicados às entidades mantenedoras de banco dados de proteção de crédito (Serasa, SPC, cartório de títulos e protestos, dentre outros), de ambas CONSIGNATÁRIAS, tais débitos incluirão todas as despesas com as medidas administrativas e judiciais: cível e criminal.

RESCISÃO
Cláusula 9ª. Na hipótese de rescisão deste contrato, independente de quem tenha dado causa, fica a CONSIGNATÁRIA obrigada a interromper as vendas dos produtos consignados, proibida de utilizar a marca ou imagens da CONSIGNANTE, e caso tenha criado a rede social instagram, facebook, deverá excluir e/ou substituir por outro.
Parágrafo primeiro. O presente contrato é firmado por prazo indeterminado, contudo as partes poderão rescindi-lo unilateralmente, com prévia notificação à parte contrária, sem qualquer contraprestação ou multa. Oportunidade em que será efetuado o acerto com devolução e pagamento das peças.
Parágrafo segundo. A rescisão contratual não extingue o presente instrumento, bem como, os débitos em favor da CONSIGNANTE.
Parágrafo terceiro. Em casos de ausência de compra pelo período superior a 30 (trinta) dias, o presente instrumento será rescindido automaticamente, sem ônus para as partes, o que não desobriga o cumprimento das obrigações.

CONSIDERAÇÕES GERAIS
Cláusula 10ª. A CONSIGNANTE não manterá contato com as clientes da CONSIGNATÁRIA, seja para recebimentos ou entrega de consertos, salvo se a CONSIGNATÁRIA estiver inativa.
Cláusula 11ª. Após a retirada das peças das dependências da CONSIGNANTE, estas ficarão sob inteira responsabilidade da CONSIGNATÁRIA, a qual se compromete a mantê-las em perfeito estado e em local apropriado.
Cláusula 12ª. Em caso de extravio, perda, roubo, furto, caso fortuito ou força maior fica a CONSIGNATÁRIA responsável por indenizar a CONSIGNANTE do valor total das peça que estiverem sob sua guarda e cautela.
Cláusula 13ª. A CONSIGNATÁRIA reconhece não possuir qualquer vínculo trabalhista com a CONSIGNANTE, mas tão somente um contrato estimatório de vendas em consignação para exercer suas atividades na modalidade independente, eximindo a CONSIGNANTE de quaisquer obrigações que assumir direta ou indiretamente pelo exercício da atividade.
Parágrafo primeiro. A CONSIGNATÁRIA não está sujeita a nenhum controle de horário, subordinação ou outro poder diretivo por parte CONSIGNANTE, apenas com obrigações relativas a acertos e responsabilidade de guarda e depósito das peças.
Cláusula 14ª. As partes declaram que a demora no exercício de direito de qualquer cláusula aqui prevista, seja por força do contrato ou por força de lei é mera liberalidade, não constituindo novação ou renúncia, e não impedindo que venham a ser exercidos em qualquer tempo na forma ajustada neste contrato.
Cláusula 15ª. O presente contrato é válido entre as partes, resguardado o direito de eventual execução ou cobrança judicial em desfavor de seus sucessores, que ficam responsáveis pelo fiel cumprimento deste.
Cláusula 16ª. A CONSIGNATÁRIA em garantia ao fiel cumprimento das obrigações assumidas no presente instrumento, assina à CONSIGNANTE NOTA PROMISSÓRIA no valor máximo das mercadorias retiradas em consignação, descritas no termo de entrega de mercadorias detalhado, sendo que tal título poderá ser executado em caso de inadimplência, sem prejuízos da cobrança de despesas administrativas e judiciais, bem como todos os encargos descritos na Cláusula 5ª, parágrafos primeiro e segundo.
Parágrafo primeiro. Ao assinar o termo de entrega de mercadorias, parte integrante deste instrumento, a CONSIGNATÁRIA confessa ter recebido na quantidade de mercadorias descritas, em perfeito estado e sem qualquer vício ou defeito aparente.
Cláusula 17ª. Não existe área de atuação previamente delimitada, nem a exigência de exclusividade de vendas de produtos.

TRATAMENTO DE DADOS
Cláusula 18ª. A CONSIGNATÁRIA declara que tem ciência e que não se opõe ao tratamento e processamento dos seus dados pessoais, sensíveis ou não, fornecidos durante a inscrição e notas, em observância aos princípios da publicidade e da transparência e nos termos da Lei nº 13.709/2018 (LGPD), e suas atualizações.
Cláusula 19ª. A CONSIGNANTE se obriga a manter sigilo sobre as operações, dados, estratégias, materiais, informações e documentos da CONSIGNATÁRIA, mesmo após a conclusão dos serviços ou do término da relação contratual, nos termos da Lei nº 13.709/2018 (LGPD) e suas atualizações.

FORO
Cláusula 20ª. As partes elegem o fórum de Vila Velha/ES para dirimir quaisquer dúvidas em relação a esse contrato.

Por estarem assim justos e contratados, firmam o presente instrumento, em duas vias de igual teor, na presença de duas testemunhas.

{{empresa_cidade}}, {{data_extenso}}.

CONSIGNANTE: {{empresa_nome}}

CONSIGNATÁRIA: {{nome}}`,
  },
  {
    tipo: 'promissoria' as const,
    modeloTrabalho: null,
    titulo: 'Nota promissória · Maleta nº {{maleta_numero}}',
    conteudo: `MODELO PROVISÓRIO — substituir pelo texto aprovado pelo jurídico da Aritana.

NOTA PROMISSÓRIA

Valor: {{maleta_valor}}
Vencimento: {{maleta_data_limite}}

No dia {{maleta_data_limite}}, pagarei por esta nota promissória a {{empresa_nome}}, CNPJ {{empresa_cnpj}}, ou à sua ordem, a quantia de {{maleta_valor}} ({{maleta_valor_extenso}}), referente às {{maleta_pecas}} peças recebidas em consignação na maleta nº {{maleta_numero}}, retirada em {{maleta_data_retirada}}.

Do valor acima serão abatidas, no acerto, as peças devolvidas e a comissão a que tenho direito, conforme o contrato de revenda em consignação.

Pagável em {{empresa_cidade}}.

Emitente: {{nome}}
CPF: {{cpf}}
Endereço: {{endereco}}, {{cidade}}/{{uf}}

{{cidade}}, {{data_extenso}}.`,
  },
];
