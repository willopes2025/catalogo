CREATE TABLE "pedidos_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"origem" text NOT NULL,
	"cliente_nome" text NOT NULL,
	"cliente_telefone" text NOT NULL,
	"cliente_cidade" text,
	"entrega" text DEFAULT 'combinar' NOT NULL,
	"endereco" text,
	"observacao" text,
	"itens" jsonb NOT NULL,
	"total" integer NOT NULL,
	"status" text DEFAULT 'novo' NOT NULL,
	"venda_id" uuid,
	"lead_id" uuid,
	"motivo_cancelamento" text,
	"origem_utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmado_em" timestamp with time zone,
	"entregue_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pedidos_link" ADD CONSTRAINT "pedidos_link_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_link" ADD CONSTRAINT "pedidos_link_venda_id_vendas_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_link" ADD CONSTRAINT "pedidos_link_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pedidos_link_pessoa_idx" ON "pedidos_link" USING btree ("pessoa_id","status");--> statement-breakpoint
CREATE INDEX "pedidos_link_data_idx" ON "pedidos_link" USING btree ("criado_em");