/**
 * Modelos PROVISÓRIOS de contrato e promissória, para o sistema funcionar desde o primeiro dia.
 * Devem ser substituídos pelos textos da Aritana, revisados pelo jurídico, em Configurações › Modelos de documento.
 */
export const MODELOS_INICIAIS = [
  {
    tipo: 'contrato' as const,
    modeloTrabalho: 'consignado' as const,
    titulo: 'Contrato de revenda em consignação · {{nome}}',
    conteudo: `MODELO PROVISÓRIO — substituir pelo texto aprovado pelo jurídico da Aritana.

CONTRATO DE REVENDA DE SEMIJOIAS EM CONSIGNAÇÃO

CONSIGNANTE: {{empresa_nome}}, CNPJ {{empresa_cnpj}}, com sede em {{empresa_cidade}}.
CONSIGNATÁRIA (REPRESENTANTE): {{nome}}, CPF {{cpf}}, RG {{rg}}, residente em {{endereco}}, {{cidade}}/{{uf}}, CEP {{cep}}, telefone {{telefone}}, e-mail {{email}}.

1. OBJETO. A Consignante entrega à Representante semijoias em consignação (maleta), para revenda ao consumidor final pelo preço de etiqueta. As peças continuam sendo propriedade da Consignante até o acerto.

2. LIMITE. O valor das peças em poder da Representante não poderá passar do limite de crédito, hoje de {{limite}} ({{limite_extenso}}), que poderá ser revisto a cada acerto conforme o histórico.

3. ACERTO. A cada {{prazo_acerto}} dias contados da retirada, a Representante fará o acerto: devolverá as peças não vendidas e pagará o valor das vendidas, descontada a sua comissão.

4. COMISSÃO. A comissão da Representante é de {{comissao}}.

5. PEÇAS PERDIDAS OU DANIFICADAS. Peças não devolvidas nem vendidas, ou devolvidas danificadas por mau uso, serão cobradas {{perdida}}.

6. ATRASO. {{regra_atraso}} Bloqueio de nova maleta por atraso: {{dias_bloqueio}}.

7. GARANTIA. Reclamações de clientes sobre defeito serão atendidas conforme o Código de Defesa do Consumidor. A Representante recebe a peça da cliente e a encaminha à Consignante para análise.

8. NATUREZA DA RELAÇÃO. Este contrato não cria vínculo de emprego. A Representante atua de forma autônoma, define seus horários e assume os custos da sua atividade.

9. DADOS PESSOAIS. A Representante autoriza o tratamento dos seus dados para a execução deste contrato, cobrança e cumprimento de obrigações legais, nos termos da Lei Geral de Proteção de Dados (Lei 13.709/2018).

10. ASSINATURA ELETRÔNICA. As partes reconhecem como válida a assinatura deste contrato por meio eletrônico, com confirmação por código enviado ao e-mail da Representante, nos termos do art. 10, § 2º, da Medida Provisória 2.200-2/2001.

11. FORO. Fica eleito o foro da comarca de {{empresa_cidade}}.

{{empresa_cidade}}, {{data_extenso}}.`,
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
