CREATE TABLE "ia_licoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funcao" text,
	"quando" text NOT NULL,
	"resposta" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"origem" text DEFAULT 'manual' NOT NULL,
	"conversa_id" uuid,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_contatos" ADD COLUMN "memoria_ia" text;--> statement-breakpoint
ALTER TABLE "crm_contatos" ADD COLUMN "memoria_ia_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ia_licoes" ADD CONSTRAINT "ia_licoes_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ia_licoes_status_idx" ON "ia_licoes" USING btree ("status","criado_em");