ALTER TABLE "assistente_sessoes" ADD COLUMN "titulo_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assistente_sessoes" ADD COLUMN "fixada_em" timestamp with time zone;