CREATE TABLE "crm_distribuicoes" (
	"funil_id" uuid PRIMARY KEY NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"destino" text DEFAULT 'consultoras' NOT NULL,
	"raio_km" integer DEFAULT 50 NOT NULL,
	"prazo_minutos" integer DEFAULT 60 NOT NULL,
	"max_tentativas" integer DEFAULT 3 NOT NULL,
	"max_abertos" integer DEFAULT 10 NOT NULL,
	"so_com_maleta" boolean DEFAULT false NOT NULL,
	"avisar_whatsapp" boolean DEFAULT true NOT NULL,
	"canal_id" uuid,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "consultora_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "distribuicao" text;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "distribuido_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "aceito_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "distancia_km" double precision;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "ja_oferecido" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_distribuicoes" ADD CONSTRAINT "crm_distribuicoes_funil_id_crm_funis_id_fk" FOREIGN KEY ("funil_id") REFERENCES "public"."crm_funis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_distribuicoes" ADD CONSTRAINT "crm_distribuicoes_canal_id_crm_canais_id_fk" FOREIGN KEY ("canal_id") REFERENCES "public"."crm_canais"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_consultora_id_pessoas_id_fk" FOREIGN KEY ("consultora_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_leads_consultora_idx" ON "crm_leads" USING btree ("consultora_id","distribuicao");