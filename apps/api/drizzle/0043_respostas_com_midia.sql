ALTER TABLE "crm_respostas_rapidas" ALTER COLUMN "texto" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "crm_respostas_rapidas" ADD COLUMN "midia" text;--> statement-breakpoint
ALTER TABLE "crm_respostas_rapidas" ADD COLUMN "midia_mime" text;--> statement-breakpoint
ALTER TABLE "crm_respostas_rapidas" ADD COLUMN "midia_nome" text;