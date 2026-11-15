CREATE TABLE "agenda_compromissos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" text NOT NULL,
	"titulo" text NOT NULL,
	"inicio" timestamp with time zone NOT NULL,
	"fim" timestamp with time zone NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"local" text,
	"link" text,
	"google_evento_id" text,
	"responsavel_id" uuid,
	"pessoa_id" uuid,
	"lead_id" uuid,
	"maleta_id" uuid,
	"convidado_nome" text,
	"convidado_telefone" text,
	"observacao" text,
	"status" text DEFAULT 'marcado' NOT NULL,
	"avisar" boolean DEFAULT true NOT NULL,
	"lembrete_dia_em" timestamp with time zone,
	"lembrete_hora_em" timestamp with time zone,
	"confirmado_em" timestamp with time zone,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agenda_compromissos" ADD CONSTRAINT "agenda_compromissos_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_compromissos" ADD CONSTRAINT "agenda_compromissos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_compromissos" ADD CONSTRAINT "agenda_compromissos_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_compromissos" ADD CONSTRAINT "agenda_compromissos_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_compromissos" ADD CONSTRAINT "agenda_compromissos_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_inicio_idx" ON "agenda_compromissos" USING btree ("inicio");--> statement-breakpoint
CREATE INDEX "agenda_resp_idx" ON "agenda_compromissos" USING btree ("responsavel_id","inicio");--> statement-breakpoint
CREATE INDEX "agenda_pessoa_idx" ON "agenda_compromissos" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "agenda_lead_idx" ON "agenda_compromissos" USING btree ("lead_id");--> statement-breakpoint
-- Quem já usa o CRM passa a ver e marcar compromissos (a Diretoria já tem tudo).
UPDATE "grupos" SET "permissoes" = "permissoes" || '{"agenda": ["ver", "criar", "editar"]}'::jsonb WHERE "permissoes" ? 'crm' AND NOT "permissoes" ? 'agenda';
