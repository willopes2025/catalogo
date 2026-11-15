CREATE TABLE "portal_dispositivos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"token" text NOT NULL,
	"plataforma" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_uso_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_dispositivos" ADD CONSTRAINT "portal_dispositivos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_dispositivos_token_uq" ON "portal_dispositivos" USING btree ("token");--> statement-breakpoint
CREATE INDEX "portal_dispositivos_pessoa_idx" ON "portal_dispositivos" USING btree ("pessoa_id");