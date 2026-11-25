CREATE TABLE "crm_importacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canal_id" uuid NOT NULL,
	"de" date NOT NULL,
	"ate" date NOT NULL,
	"midias" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'importando' NOT NULL,
	"conectado_em" timestamp with time zone,
	"rodadas" integer DEFAULT 0 NOT NULL,
	"conversas" integer DEFAULT 0 NOT NULL,
	"mensagens" integer DEFAULT 0 NOT NULL,
	"detalhe" text,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluido_em" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crm_importacoes" ADD CONSTRAINT "crm_importacoes_canal_id_crm_canais_id_fk" FOREIGN KEY ("canal_id") REFERENCES "public"."crm_canais"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_importacoes" ADD CONSTRAINT "crm_importacoes_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_importacoes_canal_idx" ON "crm_importacoes" USING btree ("canal_id","status");