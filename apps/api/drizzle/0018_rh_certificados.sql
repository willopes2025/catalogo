CREATE TABLE "rh_certificados" (
	"empresa_id" uuid PRIMARY KEY NOT NULL,
	"pfx_cifrado" text NOT NULL,
	"senha_cifrada" text NOT NULL,
	"titular" text NOT NULL,
	"cnpj" text,
	"emissor" text NOT NULL,
	"serie" text NOT NULL,
	"valido_ate" timestamp with time zone NOT NULL,
	"icp_brasil" boolean NOT NULL,
	"usuario_id" uuid,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rh_certificados" ADD CONSTRAINT "rh_certificados_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_certificados" ADD CONSTRAINT "rh_certificados_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;