CREATE TABLE "maleta_conferencias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"maleta_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"usuario_id" uuid,
	"itens" jsonb NOT NULL,
	"sobras" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"esperadas" integer NOT NULL,
	"conferidas" integer NOT NULL,
	"faltando" integer NOT NULL,
	"tratamento" text DEFAULT 'nada' NOT NULL,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maleta_conferencias" ADD CONSTRAINT "maleta_conferencias_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maleta_conferencias" ADD CONSTRAINT "maleta_conferencias_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maleta_conferencias_idx" ON "maleta_conferencias" USING btree ("maleta_id","criado_em");