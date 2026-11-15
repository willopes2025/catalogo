CREATE TABLE "marketing_gastos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competencia" text NOT NULL,
	"campanha_id" uuid,
	"descricao" text NOT NULL,
	"valor" integer NOT NULL,
	"origem" text DEFAULT 'manual' NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_gastos" ADD CONSTRAINT "marketing_gastos_campanha_id_campanhas_id_fk" FOREIGN KEY ("campanha_id") REFERENCES "public"."campanhas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_gastos" ADD CONSTRAINT "marketing_gastos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_gastos_mes_idx" ON "marketing_gastos" USING btree ("competencia");--> statement-breakpoint
CREATE INDEX "marketing_gastos_campanha_idx" ON "marketing_gastos" USING btree ("campanha_id");