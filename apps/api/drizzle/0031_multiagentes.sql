CREATE TABLE "ia_agentes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funcao" text NOT NULL,
	"nome" text NOT NULL,
	"quando" text NOT NULL,
	"instrucoes" text DEFAULT '' NOT NULL,
	"conhecimento" text DEFAULT '' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD COLUMN "ia_agente_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD COLUMN "ia_transferencias" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD CONSTRAINT "crm_conversas_ia_agente_id_ia_agentes_id_fk" FOREIGN KEY ("ia_agente_id") REFERENCES "public"."ia_agentes"("id") ON DELETE set null ON UPDATE no action;