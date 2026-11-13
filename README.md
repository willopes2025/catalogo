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

As naturezas de operação e os CFOPs que vêm instalados são um **ponto de partida** para empresa do Simples Nacional e **precisam ser conferidos pelo contador** antes de emitir em produção.

Os modelos de contrato e promissória que vêm instalados são **provisórios** e devem ser trocados pelos textos revisados pelo jurídico da Aritana, em Configurações › Modelos de documento.

Os módulos da Versão 2 aparecem no menu marcados com “V2”.

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
