CREATE TABLE "plano_contas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"nome" text NOT NULL,
	"pai_id" uuid,
	"grupo" text NOT NULL,
	"calculada" boolean DEFAULT false NOT NULL,
	"chave" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contas" ADD COLUMN "banco" text;--> statement-breakpoint
ALTER TABLE "contas" ADD COLUMN "agencia" text;--> statement-breakpoint
ALTER TABLE "contas" ADD COLUMN "numero" text;--> statement-breakpoint
ALTER TABLE "contas" ADD COLUMN "pix" text;--> statement-breakpoint
ALTER TABLE "contas" ADD COLUMN "observacao" text;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "plano_conta_id" uuid;--> statement-breakpoint
ALTER TABLE "plano_contas" ADD CONSTRAINT "plano_contas_pai_id_plano_contas_id_fk" FOREIGN KEY ("pai_id") REFERENCES "public"."plano_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plano_contas_codigo" ON "plano_contas" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "plano_contas_chave" ON "plano_contas" USING btree ("chave");--> statement-breakpoint
ALTER TABLE "titulos" ADD CONSTRAINT "titulos_plano_conta_id_plano_contas_id_fk" FOREIGN KEY ("plano_conta_id") REFERENCES "public"."plano_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('1', 'Receita bruta', 'receita');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '1.01', 'Vendas da rede de revendedoras (acertos)', 'receita', id, 'vendas_rede', true FROM "plano_contas" WHERE "codigo" = '1';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '1.02', 'Vendas nas lojas', 'receita', id, 'vendas_lojas', true FROM "plano_contas" WHERE "codigo" = '1';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '1.03', 'Vendas em eventos', 'receita', id, 'vendas_eventos', true FROM "plano_contas" WHERE "codigo" = '1';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '1.04', 'Vendas avulsas e revenda', 'receita', id, 'vendas_outras', true FROM "plano_contas" WHERE "codigo" = '1';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '1.05', 'Serviços e consertos', 'receita', id, 'consertos', false FROM "plano_contas" WHERE "codigo" = '1';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '1.06', 'Outras receitas de vendas', 'receita', id, NULL, false FROM "plano_contas" WHERE "codigo" = '1';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('2', 'Deduções da receita', 'deducoes');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '2.01', 'Devoluções de vendas', 'deducoes', id, 'devolucoes', true FROM "plano_contas" WHERE "codigo" = '2';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '2.02', 'Comissão das revendedoras (retida no acerto)', 'deducoes', id, 'comissao_rede', true FROM "plano_contas" WHERE "codigo" = '2';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '2.03', 'Impostos sobre vendas (Simples, ICMS)', 'deducoes', id, 'impostos_vendas', false FROM "plano_contas" WHERE "codigo" = '2';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('3', 'Custos', 'custos');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '3.01', 'Custo das peças vendidas', 'custos', id, 'cmv', true FROM "plano_contas" WHERE "codigo" = '3';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '3.02', 'Embalagens e etiquetas', 'custos', id, NULL, false FROM "plano_contas" WHERE "codigo" = '3';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '3.03', 'Fretes de compra', 'custos', id, NULL, false FROM "plano_contas" WHERE "codigo" = '3';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '3.04', 'Banho, conserto e serviços nas peças', 'custos', id, NULL, false FROM "plano_contas" WHERE "codigo" = '3';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('4', 'Despesas com vendas', 'despesas_vendas');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.01', 'Comissões de líderes e afiliadas', 'despesas_vendas', id, 'comissoes', false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.02', 'Taxas de cartão', 'despesas_vendas', id, 'taxas_cartao', false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.03', 'Marketing e anúncios', 'despesas_vendas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.04', 'Fretes e entregas', 'despesas_vendas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.05', 'Prêmios e brindes', 'despesas_vendas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.06', 'Eventos e feiras', 'despesas_vendas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '4.07', 'Cobrança, protesto e taxas de boleto', 'despesas_vendas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '4';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('5', 'Despesas com pessoal', 'despesas_pessoal');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '5.01', 'Salários', 'despesas_pessoal', id, NULL, false FROM "plano_contas" WHERE "codigo" = '5';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '5.02', 'Encargos (FGTS, INSS)', 'despesas_pessoal', id, NULL, false FROM "plano_contas" WHERE "codigo" = '5';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '5.03', 'Benefícios (vale-transporte, alimentação)', 'despesas_pessoal', id, NULL, false FROM "plano_contas" WHERE "codigo" = '5';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '5.04', 'Pró-labore', 'despesas_pessoal', id, NULL, false FROM "plano_contas" WHERE "codigo" = '5';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '5.05', 'Férias e 13º', 'despesas_pessoal', id, NULL, false FROM "plano_contas" WHERE "codigo" = '5';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '5.06', 'Rescisões', 'despesas_pessoal', id, NULL, false FROM "plano_contas" WHERE "codigo" = '5';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('6', 'Despesas administrativas', 'despesas_administrativas');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.01', 'Aluguel e condomínio', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.02', 'Energia, água e internet', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.03', 'Sistemas e assinaturas', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.04', 'Contabilidade e jurídico', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.05', 'Material de escritório e limpeza', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.06', 'Manutenção', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.07', 'Viagens e deslocamento', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.08', 'Seguros', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '6.09', 'Outras despesas administrativas', 'despesas_administrativas', id, NULL, false FROM "plano_contas" WHERE "codigo" = '6';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('7', 'Resultado financeiro', 'financeiro');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '7.01', 'Juros e multas recebidos', 'financeiro', id, NULL, false FROM "plano_contas" WHERE "codigo" = '7';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '7.02', 'Rendimentos de aplicação', 'financeiro', id, NULL, false FROM "plano_contas" WHERE "codigo" = '7';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '7.03', 'Tarifas bancárias', 'financeiro', id, NULL, false FROM "plano_contas" WHERE "codigo" = '7';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '7.04', 'Juros e multas pagos', 'financeiro', id, NULL, false FROM "plano_contas" WHERE "codigo" = '7';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '7.05', 'Juros de empréstimos', 'financeiro', id, NULL, false FROM "plano_contas" WHERE "codigo" = '7';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('8', 'Outras receitas e despesas', 'outras');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '8.01', 'Outras receitas', 'outras', id, NULL, false FROM "plano_contas" WHERE "codigo" = '8';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '8.02', 'Outras despesas', 'outras', id, NULL, false FROM "plano_contas" WHERE "codigo" = '8';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '8.03', 'Receitas a classificar', 'outras', id, 'classificar_receitas', false FROM "plano_contas" WHERE "codigo" = '8';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '8.04', 'Despesas a classificar', 'outras', id, 'classificar_despesas', false FROM "plano_contas" WHERE "codigo" = '8';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo") VALUES ('9', 'Fora do resultado (só movimento de dinheiro)', 'fora');
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.01', 'Recebimento de vendas e acertos', 'fora', id, 'recebimentos', false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.02', 'Compra de mercadorias (vira estoque)', 'fora', id, 'compras', false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.03', 'Transferência entre contas', 'fora', id, 'transferencias', false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.04', 'Devolução de dinheiro a cliente', 'fora', id, 'devolucoes_caixa', false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.05', 'Empréstimos (entrada e pagamento)', 'fora', id, NULL, false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.06', 'Aporte e retirada de sócios', 'fora', id, NULL, false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada") SELECT '9.07', 'Investimentos e imobilizado', 'fora', id, NULL, false FROM "plano_contas" WHERE "codigo" = '9';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "chave" = 'recebimentos') WHERE "tipo" = 'receber' AND "origem_tipo" IN ('venda', 'acerto', 'acordo', 'jueri');
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "chave" = 'recebimentos') WHERE "tipo" = 'receber' AND "plano_conta_id" IS NULL AND "id_jueri" IS NOT NULL;
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "chave" = 'consertos') WHERE "tipo" = 'receber' AND "origem_tipo" = 'ordem_servico';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "chave" = 'comissoes') WHERE "tipo" = 'pagar' AND ("origem_tipo" = 'comissao' OR lower("categoria") = 'comissões');
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "chave" = 'taxas_cartao') WHERE "tipo" = 'pagar' AND ("origem_tipo" = 'conciliacao_cartao' OR lower("categoria") = 'taxas de cartão');
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "chave" = 'devolucoes_caixa') WHERE "tipo" = 'pagar' AND ("origem_tipo" = 'devolucao' OR lower("categoria") = 'devoluções');
--> statement-breakpoint
UPDATE "titulos" t SET "plano_conta_id" = p.id FROM "plano_contas" p WHERE t."plano_conta_id" IS NULL AND p."pai_id" IS NOT NULL AND NOT p."calculada" AND lower(p."nome") = lower(btrim(t."categoria"));
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '6.01') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'aluguel|condom';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '5.01') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'folha|sal[aá]rio';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '5.04') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'pr[oó].?labore';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '5.02') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'fgts|inss|encargo';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '4.03') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'marketing|an[uú]ncio|publicidade|tr[aá]fego';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '6.03') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'sistema|software|assinatura';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '6.02') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'energia|luz|[aá]gua|internet|telefone';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '6.04') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'contab|contador|jur[ií]dic|advog';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '4.04') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'frete|correio|entrega|motoboy';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '2.03') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'simples|\mdas\M|icms|imposto';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '7.03') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'tarifa';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '6.05') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'escrit[oó]rio|limpeza|papelaria';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '3.02') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'embalag|etiqueta';
--> statement-breakpoint
UPDATE "titulos" SET "plano_conta_id" = (SELECT id FROM "plano_contas" WHERE "codigo" = '9.02') WHERE "tipo" = 'pagar' AND "plano_conta_id" IS NULL AND "categoria" ~* 'compra de mercadoria|mercadoria|fornecedor';
--> statement-breakpoint
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id")
SELECT '8.9' || lpad((row_number() OVER (ORDER BY x.tipo, x.nome))::text, 2, '0'), x.nome || CASE WHEN x.tipo = 'receber' THEN ' (receita)' ELSE '' END, 'outras', (SELECT id FROM "plano_contas" WHERE "codigo" = '8')
FROM (SELECT DISTINCT ON (tipo, lower(btrim(categoria))) tipo, btrim(categoria) AS nome FROM "titulos" WHERE "plano_conta_id" IS NULL AND coalesce(btrim("categoria"), '') <> '' ORDER BY tipo, lower(btrim(categoria))) x;
--> statement-breakpoint
UPDATE "titulos" t SET "plano_conta_id" = p.id FROM "plano_contas" p WHERE t."plano_conta_id" IS NULL AND p."codigo" LIKE '8.9%' AND lower(p."nome") = lower(btrim(t."categoria") || CASE WHEN t."tipo" = 'receber' THEN ' (receita)' ELSE '' END);
