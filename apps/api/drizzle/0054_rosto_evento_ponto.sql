CREATE TABLE "rh_conferencias_rosto" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registro_id" uuid NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"resultado" text NOT NULL,
	"motivo" text,
	"revisado_por" uuid,
	"revisado_em" timestamp with time zone,
	"revisao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rh_conferencias_rosto_registro_id_unique" UNIQUE("registro_id")
);
--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD COLUMN "raio_m" integer;--> statement-breakpoint
ALTER TABLE "rh_funcionarios" ADD COLUMN "foto_rosto" text;--> statement-breakpoint
ALTER TABLE "rh_conferencias_rosto" ADD CONSTRAINT "rh_conferencias_rosto_registro_id_rh_registros_id_fk" FOREIGN KEY ("registro_id") REFERENCES "public"."rh_registros"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_conferencias_rosto" ADD CONSTRAINT "rh_conferencias_rosto_funcionario_id_rh_funcionarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."rh_funcionarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_conferencias_rosto" ADD CONSTRAINT "rh_conferencias_rosto_revisado_por_usuarios_id_fk" FOREIGN KEY ("revisado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;