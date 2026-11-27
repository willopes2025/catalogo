ALTER TABLE "crm_disparo_destinos" ADD COLUMN "variaveis" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "origem" text DEFAULT 'crm' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "envio" jsonb;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "proximo_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "hoje_data" date;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "hoje_enviados" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "lote_enviados" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "funil_destino_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "etapa_destino_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "ia_ativar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD COLUMN "ia_agente_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD CONSTRAINT "crm_disparos_funil_destino_id_crm_funis_id_fk" FOREIGN KEY ("funil_destino_id") REFERENCES "public"."crm_funis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD CONSTRAINT "crm_disparos_etapa_destino_id_crm_etapas_id_fk" FOREIGN KEY ("etapa_destino_id") REFERENCES "public"."crm_etapas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD CONSTRAINT "crm_disparos_ia_agente_id_ia_agentes_id_fk" FOREIGN KEY ("ia_agente_id") REFERENCES "public"."ia_agentes"("id") ON DELETE set null ON UPDATE no action;