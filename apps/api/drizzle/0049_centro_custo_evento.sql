ALTER TABLE "locais_estoque" ADD COLUMN "inicio" date;--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD COLUMN "fim" date;--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD COLUMN "cidade" text;--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD COLUMN "observacao" text;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "centro_custo_id" uuid;--> statement-breakpoint
ALTER TABLE "titulos" ADD CONSTRAINT "titulos_centro_custo_id_locais_estoque_id_fk" FOREIGN KEY ("centro_custo_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "titulos_centro_idx" ON "titulos" USING btree ("centro_custo_id");