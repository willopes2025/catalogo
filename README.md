# Plataforma Aritana

Sistema da Aritana Semijoias: matriz, representantes, lojas e eventos, substituindo o Jueri.
Desenvolvido pela Wide Inteligência Comercial. **O código pertence à Aritana.**

## O que já está pronto (Versão 1 · semana 1)

| Parte | O que faz |
|---|---|
| **Regras do consignado** (`packages/regras`) | Conta do acerto (vendido − comissão à vista/a prazo + peças perdidas + multa e juros − créditos), parcelas, liberação de maleta pelo crédito, aumento automático do limite. 19 testes. |
| **Banco de dados** | Empresas (matriz e loja), locais de estoque, usuários e grupos com permissão por módulo, representantes com líder e supervisor, clientes, fornecedores, produtos, **estoque em livro-caixa**, maletas, acertos, títulos, créditos, regras configuráveis e auditoria. |
| **API** (`apps/api`) | Login, cadastros, produtos, estoque (entrada, ajuste por contagem, transferência, rastreio da peça), maletas (criar com bipagem, troca no meio do ciclo, pré-baixa, simular e fechar acerto, cancelar), link do pedido para a representante, financeiro e painel Início. |
| **Painel** (`apps/painel`) | Login, menu dos 19 módulos, Início, Representantes, Produtos, Estoque, Maletas, Acerto com conferência por bipagem, Financeiro, Regras do consignado e o **link do pedido** para celular. |

Os módulos ainda não construídos aparecem no menu como “em construção” (Versão 1) ou “V2”.

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
pnpm --filter @aritana/regras test     # regras do consignado (19 testes)
pnpm --filter @aritana/api test:e2e    # fluxo completo contra a API (12 etapas, banco de teste)
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

## Próximas etapas da Versão 1

- Semana 2: cadastros de clientes e fornecedores, consulta Assertiva, contrato e promissória com assinatura por link, PDFs da maleta, catálogo simples da representante, níveis com comissão própria.
- Semana 3: frente de caixa da loja, caixas, boletos e Pix pelo Asaas, notas fiscais pelo emissor, relatórios, suporte e migração do Jueri.

## Estrutura

```
apps/api        API (NestJS + Drizzle + PostgreSQL)
apps/painel     Painel web (React + Vite)
packages/regras Cálculos do negócio, usados pela API e pelo painel
infra/          Dockerfiles, Caddy e nginx
```
