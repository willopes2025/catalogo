# Plataforma Aritana

Sistema da Aritana Semijoias: matriz, representantes, lojas e eventos, substituindo o Jueri.
Desenvolvido pela Wide Inteligência Comercial. **O código pertence à Aritana.**

## O que já está pronto (Versão 1 completa)

| Parte | O que faz |
|---|---|
| **Regras do consignado** (`packages/regras`) | Conta do acerto (vendido − comissão à vista/a prazo + peças perdidas + multa e juros − créditos), parcelas, liberação de maleta pelo crédito, aumento automático do limite. 19 testes. |
| **Banco de dados** | Empresas (matriz e loja), locais de estoque, usuários e grupos com permissão por módulo, representantes com líder e supervisor, clientes, fornecedores, produtos, **estoque em livro-caixa**, maletas, acertos, títulos, créditos, regras configuráveis e auditoria. |
| **API** (`apps/api`) | Login, cadastros, produtos, estoque (entrada, ajuste por contagem, transferência, rastreio da peça), maletas (criar com bipagem, troca no meio do ciclo, pré-baixa, simular e fechar acerto, cancelar), link do pedido para a representante, financeiro e painel Início. |
| **Painel** (`apps/painel`) | Login, menu dos 19 módulos, Início, Representantes, Produtos, Estoque, Maletas, Acerto com conferência por bipagem, Financeiro, Regras do consignado e o **link do pedido** para celular. |

**Semana 2**

| Parte | O que faz |
|---|---|
| **Cadastros** | Clientes (com representante vinculada e consentimento LGPD), fornecedores, transportadoras e assistências técnicas. |
| **Níveis e metas** | Bronze, Prata, Ouro, Líder com meta e comissão própria, que substitui a comissão padrão no acerto. |
| **Usuários e grupos** | Criação de usuários com senha provisória, grupos com permissão por módulo e ação, empresas (razão social e CNPJ). |
| **Assertiva** | Botão “Buscar pela Assertiva” no cadastro. Pronto, desligado até a Aritana enviar as credenciais. |
| **Contrato e promissória** | Modelos editáveis com variáveis (comissão, multa, juros e limite vêm das regras). Promissória gerada com cada maleta, com valor por extenso. Assinatura eletrônica por link, com código por e-mail, nome e CPF, e registro de data, IP, aparelho e hash SHA-256. |
| **Impressão** | Pedido da maleta, lista de separação, contrato e promissória, para imprimir ou salvar em PDF. |
| **Catálogo** | `/catalogo/<nome-da-representante>`: peças da maleta, filtros e botão de pedir pelo WhatsApp dela. |

**Semana 3**

| Parte | O que faz |
|---|---|
| **Frente de caixa** | Loja e eventos: abrir caixa, vender com leitor, desconto dentro do limite, várias formas de pagamento na mesma venda (dinheiro com troco, Pix, débito e crédito por maquininha, crédito da cliente, boleto/crediário), sangria, reforço e fechamento conferido forma por forma. |
| **Vendas** | Vendas avulsas da matriz e de revenda para representantes (preço de atacado), cancelamento no mesmo dia, devolução e troca com crédito ou dinheiro, recibo para imprimir. |
| **Asaas** | Gera Pix ou boleto para qualquer título a receber; quando a pessoa paga, o aviso do Asaas baixa o título sozinho (com proteção contra aviso repetido ou falso). |
| **Notas fiscais** | NFC-e das vendas e NF-e de remessa da maleta, retorno e venda do acerto pela Focus NFe, com consulta, reenvio e cancelamento. Regras fiscais editáveis na tela. |
| **Relatórios** | Desempenho da rede, maletas atrasadas, representantes sem maleta, produtos com curva ABC e giro, vendas por dia e por forma, fluxo de caixa e inadimplência por faixa. Tudo exporta para Excel. |
| **Suporte** | Chamados com a Wide, conversa dentro do sistema e status das integrações. |
| **Importação** | Planilhas do Jueri (.xlsx ou .csv) de produtos com estoque, representantes (com líder e nível), clientes e fornecedores. Simula antes de gravar; reimportar atualiza sem duplicar. |

**Fechamento da Versão 1**

| Parte | O que faz |
|---|---|
| **Etiquetas** | Estoque › Etiquetas: bipe as peças (ou carregue tudo de um local), escolha as quantidades e imprima com código de barras (EAN-13 ou Code 128) na impressora térmica. Tamanho, colunas, preço e referência configuráveis. |
| **Inventário** | Contagem parcial ou inventário completo do local, com a lista de diferenças e o valor faltando/sobrando antes de gravar o ajuste. |
| **Lotes de banho** | Cadastro de lotes e vínculo na ficha do produto, para rastrear defeito por banho. |
| **Garantia e consertos** | Ordem de serviço a partir do nº da venda ou da maleta, prazo da garantia calculado, envio para a assistência, troca com baixa da peça nova e entrada da defeituosa em “Avarias e garantia”, conserto pago lançado no financeiro. |
| **Comissões** | Prévia do mês por vendedora (vendido menos devoluções, percentual e meta por pessoa), comissão de líder sobre a rede (opcional), conferência da comissão retida nos acertos, fechamento que gera as contas a pagar e reabertura enquanto nada foi pago. |
| **Avisos automáticos** | E-mail diário à representante (acerto chegando e em atraso), lembrete de parcela com link do boleto ou Pix e resumo do dia para a equipe. Cada aviso sai uma vez só. |
| **Auditoria** | Tela com filtros por usuário, ação, área e período. |
| **Manual de uso** | Passo a passo de cada rotina dentro do sistema (link no menu lateral). |

**Implantação e credenciais pela tela**

| Parte | O que faz |
|---|---|
| **Implantação** | Configurações › Implantação: lista o que falta para usar em produção (CNPJs, integrações, NCM, modelos jurídicos, usuários, senhas provisórias, dados de teste, importação do Jueri) e itens que a Aritana confirma à mão (certificado A1, CFOPs do contador, webhook do Asaas, regras, jurídico, piloto). Aviso no Início enquanto houver pendência. |
| **Integrações** | E-mail (SMTP), Asaas, Focus NFe e Assertiva preenchidos pela tela, com teste de conexão. Senhas cifradas no banco (AES-256-GCM, chave `CHAVE_CRIPTOGRAFIA` do servidor) e nunca devolvidas à tela. O que estiver salvo na tela vale mais que o `.env`. |
| **Apagar dados de teste** | Só a Diretoria, digitando APAGAR: zera movimento (maletas, vendas, títulos, estoque) e, se quiser, cadastros e produtos; mantém configuração, usuários e auditoria. |

**Portal da representante** (`/portal`, instalável no celular como app)

| Parte | O que faz |
|---|---|
| **Entrada** | CPF + código de 6 dígitos no e-mail do cadastro, ou link de acesso (7 dias, uso único) que a matriz manda pelo WhatsApp a partir da ficha. |
| **Maleta** | Peças com foto e preço, confirmação de recebimento, pré-baixa das vendidas, histórico de acertos com a comissão. |
| **Parcelas** | Em aberto e pagas, Pix copia e cola (gera no Asaas na hora), vendas e comissão por mês. |
| **Pedir peças** | Vitrine do que há no depósito (sem custo nem quantidade exata); o pedido aparece em Maletas › Pedidos das representantes. |
| **Catálogo** | Botão para compartilhar o catálogo dela com as clientes. |

**Candidatas (CRM de captação)**

| Parte | O que faz |
|---|---|
| **Formulário público** | `/cadastro` ("Seja uma revendedora"), com origem dos anúncios pelos `utm_*`, consentimento LGPD, proteção contra robô e sem duplicar quem envia de novo. Avisa a equipe por e-mail. |
| **Quadro de triagem** | Novas → Em contato → Entrevista → Documentos → Aprovadas/Recusadas, com responsável, data de retorno, histórico de anotações, WhatsApp com mensagem pronta e números por origem. |
| **Aprovação** | Cria a representante com o limite inicial das regras, sem duplicar CPF. |

**Pontos e prêmios (gamificação da rede)**

| Parte | O que faz |
|---|---|
| **Score interno** | 0 a 1000 pelos últimos 12 meses (35% pontualidade, 25% pagamento, 25% giro da maleta, 10% perdas, 5% tempo de casa), faixas A a D e pontos de atenção. Só a matriz vê: na ficha (aba Crédito) e em Pontos e prêmios › Score da rede. |
| **Pontos automáticos** | Por R$ 100 vendidos no acerto, acerto em dia, meta do nível batida e parcela paga em dia, apurados a partir do histórico sem crédito duplicado. Regras e data de início configuráveis; ajustes manuais com motivo. |
| **Prêmios e resgates** | Catálogo com quantidade; a representante resgata pelo app (débito na hora), a matriz entrega ou cancela (pontos e prêmio voltam). |
| **Ranking do mês** | Pelo vendido nos acertos; no app, a própria posição e as outras só pelo primeiro nome. |
| **Revisão de níveis** | Sugestão pela média dos 3 últimos meses completos contra a meta de cada nível; aplicada uma a uma. |

**Formulários e Marketing**

| Parte | O que faz |
|---|---|
| **Formulários** | Montador com 10 tipos de pergunta, modelos prontos (NPS, cadastro de cliente, inscrição em evento), link público `/f/<endereço>`, LGPD e anti-robô, resumo com NPS, planilha CSV. Pode cadastrar/atualizar cliente ou abrir candidatura, sem duplicar pelo telefone. |
| **Marketing** | Campanhas com investimento e código `utm_campaign`; resultados por campanha (candidatas, aprovadas, custo por candidata e por aprovada, vendido pelas aprovadas e retorno); gerador de links rastreáveis; gasto trazido do Meta Ads quando a integração estiver ligada. |

As naturezas de operação e os CFOPs que vêm instalados são um **ponto de partida** para empresa do Simples Nacional e **precisam ser conferidos pelo contador** antes de emitir em produção.

Os modelos de contrato e promissória que vêm instalados são **provisórios** e devem ser trocados pelos textos revisados pelo jurídico da Aritana, em Configurações › Modelos de documento.

Os módulos da Versão 2 aparecem no menu marcados com “V2”.

**Assistente (orquestrador por texto e voz)** (menu › Assistente)

| Parte | O que faz |
|---|---|
| **Conversa** | A equipe escreve ou fala (microfone → transcrição) e o assistente responde; botão “Ouvir respostas” lê em voz alta com voz neural (ElevenLabs, se tiver a chave; senão OpenAI), escolhida em Assistente › Configurar. Cada pessoa vê e exclui só as conversas dela. |
| **Ferramentas** | Consulta inadimplentes, pessoas, ficha, maletas atrasadas, vendas e o **resumo do negócio** comparado ao período anterior; lê e analisa as **conversas do WhatsApp** do CRM (buscar, ler uma conversa, amostra de um período com totais), consulta o **financeiro** (a vencer, vencido, recebido ou pago em qualquer período, a receber e a pagar), consulta e **altera as regras** do consignado e da cobrança (multa, juros, carência, comissões, limites, descontos); envia WhatsApp (um ou em lote, com `{primeiro_nome}`, `{valor_atualizado}`, `{maior_atraso}`…), emite 2ª via pelo Asaas e registra promessa. Usa os mesmos serviços e permissões das telas. |
| **Consulta em qualquer área** | Motor de consultas com 20 conjuntos de dados pré-definidos (vendas por produto/vendedor/loja, pagamentos, estoque, movimentos, maletas, acertos, rede, candidatas, funis do CRM, tarefas, agenda, comissões, garantia, notas fiscais, marketing, pontos, resgates, pedidos do catálogo, acordos e caixas): o assistente escolhe métricas, agrupamento, filtros e período; o SQL é fixo no código, roda só leitura e com tempo máximo, e respeita as permissões de cada área. Também marca compromissos, cria tarefas, anota e move cards do CRM. |
| **Confirmação** | Mensagem, cobrança e envio em lote nunca saem direto: aparece um cartão com a prévia de cada mensagem e quem fica de fora; executa no botão **Confirmar** ou falando “pode”. Envio em lote roda em segundo plano, espaçado (`ASSISTENTE_INTERVALO_LOTE_S`, padrão 20 s), com progresso na tela e registro no histórico de cobrança. |
| **Rotinas (agentes agendados)** | “Todo dia às 8h me manda por e-mail os inadimplentes”, “de hora em hora, das 8h às 18h, em dias úteis…”: o assistente cria a rotina (com confirmação) e executa sozinho com as permissões atuais de quem criou. Cada execução vira uma conversa; e-mail (com planilha anexa) sai sozinho só para os endereços autorizados na criação, o resto espera confirmação. Aba Rotinas: rodar agora, duplicar, pausar e excluir. |
| **Agentes do WhatsApp** | Pela conversa ele entrevista, escreve e cria, edita, duplica, liga ou desliga especialistas do agente de atendimento e configura a resposta em áudio e a voz (com confirmação). O agente entende os áudios (transcrição) e pode responder em áudio: nunca, quando o cliente manda áudio, ou sempre, com voz da ElevenLabs ou da OpenAI e o texto junto se quiser; links vão sempre por escrito. Em CRM › Configurar há também o botão Duplicar. |
| **Pedidos** | O que o sistema ainda não faz vira pedido (configuração ou desenvolvimento) com especificação e plano, e abre um chamado de melhoria para a Wide. Aba Pedidos acompanha a situação. |
| **Aprovação** | Em cada conversa e em cada rotina: **Pedir aprovação** (padrão, cartão de confirmação) ou **Aprovar automaticamente** (executa direto, dentro das permissões). Quem pode usar o automático é regra da empresa em Configurar (padrão: só a gestão). |
| **Anexos** | Fotos, PDFs, Word, Excel, CSV, vídeos e áudios pelo clipe, Ctrl+V ou arrastando. Ele vê fotos e PDFs, lê o texto de planilhas e documentos e a transcrição de vídeos e áudios; pode encaminhar anexos por e-mail. |
| **Agentes** | Aba com todos os agentes: os agendados (horário, o que fazem, aprovação, próxima execução) e os de atendimento no WhatsApp (quando atendem, o que fazem, ligado/desligado), com duplicar e criar com ajuda do assistente. |
| **Conversa falada** | Se a pessoa fala, ele responde no formato de conversa (frases curtas, números por extenso, com emoção na voz pela ElevenLabs v3) e já responde em áudio; se escreve, responde em texto. Título da conversa gerado pelo assunto. |
| **Configurar** | Nome do assistente e orientações da empresa. Modelo: `IA_MODELO_ASSISTENTE` (padrão: o mesmo do agente). Para outros grupos usarem, marque o módulo **Assistente** em Configurações › Grupos. |

## Decisões técnicas

- **Dinheiro em centavos** (números inteiros) e **percentuais em pontos-base** (100 = 1%): sem erro de arredondamento.
- **A maleta é um local de estoque.** Ao criar a maleta, as peças saem do depósito e passam a “morar” na maleta da representante. A matriz sabe a qualquer momento quantas peças e quantos reais estão na rua.
- **Estoque como livro-caixa.** Toda entrada, saída, venda, perda e transferência é uma linha em `movimentos`. O saldo nunca fica negativo. Qualquer peça pode ser rastreada do começo ao fim.
- **O acerto é uma única transação**: estoque, títulos, créditos, limite e auditoria são gravados juntos, ou nada é gravado.
- **Regras configuráveis** na tela Configurações: prazo, comissões, multa, juros, carência, bloqueio, limites e parcelas. Os valores atuais são **provisórios** até a Aritana confirmar.
- **Auditoria**: quem fez o quê e quando, em cada operação.

## Rodar no computador de desenvolvimento

Requisitos: Node 22, pnpm 10 e PostgreSQL 16 (ou Docker).

```bash
pnpm install
docker compose up -d db redis          # ou um PostgreSQL local
cp .env.example apps/api/.env          # ajuste JWT_SECRET
pnpm --filter @aritana/regras build
pnpm db:migrate
ADMIN_EMAIL=voce@aritana.com.br ADMIN_SENHA='uma-senha-forte' SEED_EXEMPLOS=1 pnpm db:seed
pnpm dev:api                           # http://localhost:3000/api
pnpm dev:painel                        # http://localhost:5173
```

`SEED_EXEMPLOS=1` cria produtos e representantes **fictícios** para testar. Em produção, rode o seed sem essa variável: os dados reais vêm da migração do Jueri.

## Testes

```bash
pnpm --filter @aritana/regras test     # regras do consignado e textos (34 testes)
pnpm --filter @aritana/api test:e2e    # fluxo completo contra a API (32 etapas, banco de teste e simuladores do Asaas e da Focus)
```

## Publicar na VPS

1. VPS Ubuntu com Docker instalado e o domínio (ex.: `sistema.aritanaonline.com.br`) apontando para ela.
2. Clonar o repositório e criar o `.env` na raiz:
   ```
   DOMINIO=sistema.aritanaonline.com.br
   DB_PASSWORD=<senha longa>
   JWT_SECRET=<texto aleatório com 64 caracteres>
   ```
3. Subir:
   ```bash
   docker compose --profile prod up -d --build
   docker compose exec api node dist/db/seed.js     # só na primeira vez
   ```
   O Caddy emite o certificado HTTPS sozinho. Atualizações: `git pull && docker compose --profile prod up -d --build`.

## Para colocar no ar

1. VPS e domínio (ver “Publicar na VPS”).
2. Credenciais no `.env` da VPS: e-mail (SMTP), Asaas, Focus NFe e Assertiva.
3. Dados da Aritana: razão social e CNPJ das empresas, modelos de contrato e promissória do jurídico, regras fiscais validadas pelo contador, percentuais de comissão, multa e juros.
4. Migração: exportar as listas do Jueri em Excel e importar em Configurações › Importar planilhas (primeiro simular).
5. Um ciclo de acerto (30 dias) em paralelo com o Jueri, com um grupo piloto.

## Estrutura

```
apps/api        API (NestJS + Drizzle + PostgreSQL)
apps/painel     Painel web (React + Vite)
packages/regras Cálculos do negócio, usados pela API e pelo painel
infra/          Dockerfiles, Caddy e nginx
```
