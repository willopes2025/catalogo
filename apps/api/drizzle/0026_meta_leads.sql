CREATE TABLE "meta_leads" (
	"leadgen_id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"lead_id" uuid,
	"recebido_em" timestamp with time zone NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_leads" ADD CONSTRAINT "meta_leads_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meta_leads_form_idx" ON "meta_leads" USING btree ("form_id");