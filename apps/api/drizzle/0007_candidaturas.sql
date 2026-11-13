CREATE TABLE "candidatura_notas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidatura_id" uuid NOT NULL,
	"usuario_id" uuid,
	"texto" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidaturas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"nome" text NOT NULL,
	"telefone" text NOT NULL,
	"email" text,
	"cpf" text,
	"cidade" text,
	"uf" text,
	"instagram" text,
	"modelo_interesse" text,
	"experiencia" text,
	"como_conheceu" text,
	"indicada_por" text,
	"origem" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"etapa" text DEFAULT 'nova' NOT NULL,
	"responsavel_id" uuid,
	"motivo_recusa" text,
	"pessoa_id" uuid,
	"consentimento_lgpd" boolean DEFAULT false NOT NULL,
	"proximo_contato" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidatura_notas" ADD CONSTRAINT "candidatura_notas_candidatura_id_candidaturas_id_fk" FOREIGN KEY ("candidatura_id") REFERENCES "public"."candidaturas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidatura_notas" ADD CONSTRAINT "candidatura_notas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidaturas" ADD CONSTRAINT "candidaturas_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidaturas" ADD CONSTRAINT "candidaturas_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidaturas_etapa_idx" ON "candidaturas" USING btree ("etapa");