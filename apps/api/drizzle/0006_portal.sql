CREATE TABLE "pedidos_pecas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"itens" jsonb NOT NULL,
	"observacao" text,
	"status" text DEFAULT 'novo' NOT NULL,
	"resposta" text,
	"atendido_por" uuid,
	"atendido_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_acessos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"hash" text NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"usado_em" timestamp with time zone,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pedidos_pecas" ADD CONSTRAINT "pedidos_pecas_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_pecas" ADD CONSTRAINT "pedidos_pecas_atendido_por_usuarios_id_fk" FOREIGN KEY ("atendido_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_acessos" ADD CONSTRAINT "portal_acessos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_acessos" ADD CONSTRAINT "portal_acessos_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_acessos_hash_idx" ON "portal_acessos" USING btree ("hash");