CREATE TABLE "jueri_historico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id_jueri" text NOT NULL,
	"pessoa_id" uuid,
	"revendedor_jueri" text,
	"numero" text,
	"data" date NOT NULL,
	"pecas_enviadas" integer DEFAULT 0 NOT NULL,
	"pecas_vendidas" integer DEFAULT 0 NOT NULL,
	"pecas_devolvidas" integer DEFAULT 0 NOT NULL,
	"pecas_perdidas" integer DEFAULT 0 NOT NULL,
	"valor_enviado" bigint DEFAULT 0 NOT NULL,
	"valor_vendido" bigint DEFAULT 0 NOT NULL,
	"comissao" bigint,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jueri_historico_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"historico_id" uuid NOT NULL,
	"produto_id" uuid,
	"produto_jueri" text,
	"enviadas" integer DEFAULT 0 NOT NULL,
	"vendidas" integer DEFAULT 0 NOT NULL,
	"devolvidas" integer DEFAULT 0 NOT NULL,
	"preco_unitario" integer
);
--> statement-breakpoint
ALTER TABLE "jueri_historico" ADD CONSTRAINT "jueri_historico_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jueri_historico_itens" ADD CONSTRAINT "jueri_historico_itens_historico_id_jueri_historico_id_fk" FOREIGN KEY ("historico_id") REFERENCES "public"."jueri_historico"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jueri_historico_itens" ADD CONSTRAINT "jueri_historico_itens_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jueri_historico_uq" ON "jueri_historico" USING btree ("id_jueri");--> statement-breakpoint
CREATE INDEX "jueri_historico_data_idx" ON "jueri_historico" USING btree ("data");--> statement-breakpoint
CREATE INDEX "jueri_historico_pessoa_idx" ON "jueri_historico" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "jueri_hist_itens_idx" ON "jueri_historico_itens" USING btree ("historico_id");--> statement-breakpoint
CREATE INDEX "jueri_hist_itens_prod_idx" ON "jueri_historico_itens" USING btree ("produto_id");