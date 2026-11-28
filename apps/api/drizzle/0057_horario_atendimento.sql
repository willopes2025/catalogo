ALTER TABLE "crm_canais" ADD COLUMN "atendimento_ativo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "atendimento_inicio" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "atendimento_fim" text DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "atendimento_dias" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "aviso_fora_horario" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "mensagem_fora_horario" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD COLUMN "ia_especialistas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD COLUMN "fora_horario_aviso_em" timestamp with time zone;