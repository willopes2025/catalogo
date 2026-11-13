CREATE TYPE "public"."status_documento" AS ENUM('pendente', 'assinado', 'cancelado', 'expirado');--> statement-breakpoint
CREATE TYPE "public"."tipo_documento" AS ENUM('contrato', 'promissoria', 'aditivo');--> statement-breakpoint
CREATE TABLE "documentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" "tipo_documento" NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"maleta_id" uuid,
	"modelo_id" uuid,
	"titulo" text NOT NULL,
	"conteudo" text NOT NULL,
	"hash" text NOT NULL,
	"status" "status_documento" DEFAULT 'pendente' NOT NULL,
	"token" text NOT NULL,
	"enviado_para" text,
	"codigo_hash" text,
	"codigo_expira_em" timestamp with time zone,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"visualizado_em" timestamp with time zone,
	"assinado_em" timestamp with time zone,
	"assinatura_nome" text,
	"assinatura_documento" text,
	"ip" text,
	"user_agent" text,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modelos_documento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" "tipo_documento" NOT NULL,
	"modelo_trabalho" "modelo_trabalho",
	"titulo" text NOT NULL,
	"conteudo" text NOT NULL,
	"versao" integer DEFAULT 1 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_modelo_id_modelos_documento_id_fk" FOREIGN KEY ("modelo_id") REFERENCES "public"."modelos_documento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documentos_token_uq" ON "documentos" USING btree ("token");--> statement-breakpoint
CREATE INDEX "documentos_pessoa_idx" ON "documentos" USING btree ("pessoa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pessoas_slug_uq" ON "pessoas" USING btree ("slug");