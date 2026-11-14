CREATE TABLE "campanhas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"canal" text NOT NULL,
	"utm_campaign" text NOT NULL,
	"objetivo" text DEFAULT 'candidatas' NOT NULL,
	"inicio" date,
	"fim" date,
	"investimento" integer DEFAULT 0 NOT NULL,
	"investimento_sincronizado" integer,
	"sincronizado_em" timestamp with time zone,
	"meta_campanha_id" text,
	"observacao" text,
	"ativa" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formulario_respostas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"formulario_id" uuid NOT NULL,
	"respostas" jsonb NOT NULL,
	"origem" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pessoa_id" uuid,
	"candidatura_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formularios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"titulo" text NOT NULL,
	"descricao" text,
	"campos" jsonb NOT NULL,
	"acao" text DEFAULT 'nenhuma' NOT NULL,
	"mensagem_final" text,
	"consentimento" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "formulario_respostas" ADD CONSTRAINT "formulario_respostas_formulario_id_formularios_id_fk" FOREIGN KEY ("formulario_id") REFERENCES "public"."formularios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulario_respostas" ADD CONSTRAINT "formulario_respostas_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulario_respostas" ADD CONSTRAINT "formulario_respostas_candidatura_id_candidaturas_id_fk" FOREIGN KEY ("candidatura_id") REFERENCES "public"."candidaturas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campanhas_utm_uq" ON "campanhas" USING btree ("utm_campaign");--> statement-breakpoint
CREATE INDEX "formulario_respostas_form_idx" ON "formulario_respostas" USING btree ("formulario_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "formularios_slug_uq" ON "formularios" USING btree ("slug");