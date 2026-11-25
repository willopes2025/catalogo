CREATE TABLE "cobranca_comprovantes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"conversa_id" uuid,
	"midia" text,
	"valor" integer,
	"data" date,
	"pagador" text,
	"titulo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conferencia" jsonb DEFAULT '{"valor":false,"data":false,"nome":false}'::jsonb NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"resolvido_por" uuid,
	"resolvido_em" timestamp with time zone,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "envio_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lote_id" uuid NOT NULL,
	"ordem" integer NOT NULL,
	"pessoa_id" uuid,
	"nome" text NOT NULL,
	"telefone" text NOT NULL,
	"texto" text NOT NULL,
	"template_id" uuid,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"dados" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enviado_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "envio_lotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canal_id" uuid NOT NULL,
	"origem" text NOT NULL,
	"titulo" text NOT NULL,
	"status" text DEFAULT 'ativo' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"enviados" integer DEFAULT 0 NOT NULL,
	"falhas" integer DEFAULT 0 NOT NULL,
	"pulados" integer DEFAULT 0 NOT NULL,
	"criado_por" uuid,
	"acao_id" uuid,
	"aviso" text,
	"ultimo_envio_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processos_judiciais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"numero" text NOT NULL,
	"situacao" text DEFAULT 'ativo' NOT NULL,
	"observacao" text,
	"origem" text DEFAULT 'manual' NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "envio_intervalo_min_s" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "envio_intervalo_max_s" integer DEFAULT 360 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "envio_inicio" text DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "envio_fim" text DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "envio_dias" jsonb DEFAULT '[1,2,3,4,5,6]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "proximo_envio_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ia_agentes" ADD COLUMN "canais" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cobranca_comprovantes" ADD CONSTRAINT "cobranca_comprovantes_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_comprovantes" ADD CONSTRAINT "cobranca_comprovantes_conversa_id_crm_conversas_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."crm_conversas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_comprovantes" ADD CONSTRAINT "cobranca_comprovantes_resolvido_por_usuarios_id_fk" FOREIGN KEY ("resolvido_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_itens" ADD CONSTRAINT "envio_itens_lote_id_envio_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "public"."envio_lotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_itens" ADD CONSTRAINT "envio_itens_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_lotes" ADD CONSTRAINT "envio_lotes_canal_id_crm_canais_id_fk" FOREIGN KEY ("canal_id") REFERENCES "public"."crm_canais"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_lotes" ADD CONSTRAINT "envio_lotes_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processos_judiciais" ADD CONSTRAINT "processos_judiciais_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processos_judiciais" ADD CONSTRAINT "processos_judiciais_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cobranca_comprovantes_status_idx" ON "cobranca_comprovantes" USING btree ("status","criado_em");--> statement-breakpoint
CREATE INDEX "envio_itens_fila_idx" ON "envio_itens" USING btree ("lote_id","status","ordem");--> statement-breakpoint
CREATE INDEX "envio_lotes_status_idx" ON "envio_lotes" USING btree ("status","canal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processos_judiciais_numero_idx" ON "processos_judiciais" USING btree ("pessoa_id","numero");--> statement-breakpoint
CREATE INDEX "processos_judiciais_pessoa_idx" ON "processos_judiciais" USING btree ("pessoa_id","situacao");
--> statement-breakpoint
-- Especialista de Cobrança: já nasce só no(s) número(s) do Financeiro (ligado se houver um número com "financ" no nome).
INSERT INTO "ia_agentes" ("funcao", "nome", "quando", "instrucoes", "conhecimento", "ativo", "ordem", "canais")
SELECT 'cobranca', 'Cobrança', 'Quem responde a uma mensagem de cobrança ou fala de parcela em aberto, boleto, Pix, 2ª via, comprovante de pagamento, atraso, promessa de pagamento ou acordo.', 'Você dá continuidade à cobrança com educação e firmeza, sem ameaçar e sem constranger. O objetivo é a pessoa pagar ou combinar uma data.
1. Antes de falar de valores, use "consultar_parcelas". Diga o valor atualizado (com multa e juros) e quais parcelas estão vencidas, sem despejar tudo de uma vez.
2. Para pagar, ofereça o Pix (mais rápido) ou o boleto com "segunda_via" e mande o link do jeito que vier.
3. Se a pessoa disser quando vai pagar, registre com "registrar_promessa" e confirme a data com ela.
4. Se mandar o comprovante, leia valor, data e nome na foto e use "registrar_comprovante". Agradeça e diga que a equipe dá a baixa; nunca diga que já foi baixado.
5. Se pedir para negociar, parcelar ou desconto, use "simular_acordo" e ofereça só o que voltar. Se ela aceitar, use "aceitar_acordo".
6. Passe para a equipe quando a pessoa contestar a dívida, disser que já pagou sem comprovante, falar de processo, advogado ou justiça, ficar irritada, pedir para falar com alguém, ou pedir algo fora das regras.
Nunca fale da dívida com outra pessoa que não seja a dona do cadastro: se quem escreve disser que não é ela, peça desculpas e passe para a equipe.', '',
  EXISTS (SELECT 1 FROM "crm_canais" WHERE "nome" ILIKE '%financ%' AND "excluido_em" IS NULL),
  4,
  COALESCE((SELECT jsonb_agg("id") FROM "crm_canais" WHERE "nome" ILIKE '%financ%' AND "excluido_em" IS NULL), '[]'::jsonb)
WHERE NOT EXISTS (SELECT 1 FROM "ia_agentes" WHERE "funcao" = 'cobranca');
