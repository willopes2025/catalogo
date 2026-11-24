CREATE TABLE "indicacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"indicador_id" uuid NOT NULL,
	"candidatura_id" uuid NOT NULL,
	"indicada_pessoa_id" uuid,
	"status" text DEFAULT 'candidata' NOT NULL,
	"aprovada_em" timestamp with time zone,
	"valor" integer,
	"liberada_em" timestamp with time zone,
	"motivo_liberacao" text,
	"titulo_id" uuid,
	"motivo_cancelamento" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indicacoes_candidatura_id_unique" UNIQUE("candidatura_id")
);
--> statement-breakpoint
CREATE TABLE "indicadores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"pessoa_id" uuid,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indicadores_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "indicadores_pessoa_id_unique" UNIQUE("pessoa_id"),
	CONSTRAINT "indicadores_usuario_id_unique" UNIQUE("usuario_id")
);
--> statement-breakpoint
ALTER TABLE "indicacoes" ADD CONSTRAINT "indicacoes_indicador_id_indicadores_id_fk" FOREIGN KEY ("indicador_id") REFERENCES "public"."indicadores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicacoes" ADD CONSTRAINT "indicacoes_candidatura_id_candidaturas_id_fk" FOREIGN KEY ("candidatura_id") REFERENCES "public"."candidaturas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicacoes" ADD CONSTRAINT "indicacoes_indicada_pessoa_id_pessoas_id_fk" FOREIGN KEY ("indicada_pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicacoes" ADD CONSTRAINT "indicacoes_titulo_id_titulos_id_fk" FOREIGN KEY ("titulo_id") REFERENCES "public"."titulos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicadores" ADD CONSTRAINT "indicadores_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicadores" ADD CONSTRAINT "indicadores_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indicacoes_indicador_idx" ON "indicacoes" USING btree ("indicador_id","status");--> statement-breakpoint
-- Conta do plano para o prêmio de indicação (Despesas com vendas).
INSERT INTO "plano_contas" ("codigo", "nome", "grupo", "pai_id", "chave", "calculada")
SELECT '4.08', 'Prêmios por indicação de consultoras', 'despesas_vendas', id, 'indicacoes', false FROM "plano_contas" WHERE "codigo" = '4'
AND NOT EXISTS (SELECT 1 FROM "plano_contas" WHERE "chave" = 'indicacoes' OR "codigo" = '4.08');
