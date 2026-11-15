ALTER TABLE "usuarios" ADD COLUMN "ultima_atividade_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "sessao_inicio_em" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "auditoria_data_idx" ON "auditoria" USING btree ("criado_em");--> statement-breakpoint
CREATE INDEX "auditoria_usuario_idx" ON "auditoria" USING btree ("usuario_id","criado_em");