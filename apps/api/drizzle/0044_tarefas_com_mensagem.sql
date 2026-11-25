ALTER TABLE "crm_tarefas" ADD COLUMN "mensagem_tipo" text;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "mensagem_texto" text;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "resposta_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "canal_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "envio" text;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "mensagem_status" text;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "mensagem_erro" text;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD COLUMN "mensagem_enviada_em" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "crm_tarefas_envio_idx" ON "crm_tarefas" USING btree ("mensagem_status","vence_em");