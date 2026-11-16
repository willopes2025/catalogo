ALTER TABLE "crm_canais" ADD COLUMN "ultimo_webhook_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD COLUMN "fixada" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_mensagens" ADD COLUMN "citada_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_mensagens" ADD COLUMN "reacoes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_mensagens" ADD COLUMN "apagada_em" timestamp with time zone;