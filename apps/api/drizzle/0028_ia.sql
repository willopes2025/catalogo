CREATE TABLE "ia_usos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurso" text NOT NULL,
	"modelo" text NOT NULL,
	"tokens_entrada" integer DEFAULT 0 NOT NULL,
	"tokens_saida" integer DEFAULT 0 NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD COLUMN "ia_ativa" boolean;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD COLUMN "ia_respostas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_mensagens" ADD COLUMN "ia" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ia_usos" ADD CONSTRAINT "ia_usos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ia_usos_dia_idx" ON "ia_usos" USING btree ("criado_em");