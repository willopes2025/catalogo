CREATE TABLE "pontos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"pontos" integer NOT NULL,
	"motivo" text NOT NULL,
	"origem_tipo" text NOT NULL,
	"origem_id" uuid,
	"regra" text NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "premios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"pontos" integer NOT NULL,
	"estoque" integer,
	"foto" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resgates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"premio_id" uuid NOT NULL,
	"pontos" integer NOT NULL,
	"status" text DEFAULT 'solicitado' NOT NULL,
	"observacao" text,
	"atendido_por" uuid,
	"atendido_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pontos" ADD CONSTRAINT "pontos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pontos" ADD CONSTRAINT "pontos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resgates" ADD CONSTRAINT "resgates_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resgates" ADD CONSTRAINT "resgates_premio_id_premios_id_fk" FOREIGN KEY ("premio_id") REFERENCES "public"."premios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resgates" ADD CONSTRAINT "resgates_atendido_por_usuarios_id_fk" FOREIGN KEY ("atendido_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pontos_origem_regra_idx" ON "pontos" USING btree ("origem_tipo","origem_id","regra");--> statement-breakpoint
CREATE INDEX "pontos_pessoa_idx" ON "pontos" USING btree ("pessoa_id");