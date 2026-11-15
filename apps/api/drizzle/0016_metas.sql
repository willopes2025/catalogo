CREATE TABLE "metas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competencia" text NOT NULL,
	"tipo" text NOT NULL,
	"local_id" uuid,
	"valor" integer NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metas" ADD CONSTRAINT "metas_local_id_locais_estoque_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metas_mes_idx" ON "metas" USING btree ("competencia");