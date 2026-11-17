ALTER TYPE "public"."status_titulo" ADD VALUE 'renegociado';--> statement-breakpoint
CREATE TABLE "cobradores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"tipo" text DEFAULT 'interno' NOT NULL,
	"documento" text,
	"telefone" text,
	"email" text,
	"comissao_pb" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_acordos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"cobrador_id" uuid,
	"usuario_id" uuid,
	"status" text DEFAULT 'ativo' NOT NULL,
	"original" integer NOT NULL,
	"multa" integer NOT NULL,
	"juros" integer NOT NULL,
	"desconto" integer NOT NULL,
	"total" integer NOT NULL,
	"entrada" integer DEFAULT 0 NOT NULL,
	"parcelas" integer NOT NULL,
	"observacao" text,
	"encerrado_em" timestamp with time zone,
	"motivo_encerramento" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_arquivos_cra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" text NOT NULL,
	"nome" text NOT NULL,
	"conteudo" text NOT NULL,
	"situacao" text NOT NULL,
	"resposta" text,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_carteira" (
	"pessoa_id" uuid PRIMARY KEY NOT NULL,
	"cobrador_id" uuid,
	"desde" timestamp with time zone DEFAULT now() NOT NULL,
	"pausada" boolean DEFAULT false NOT NULL,
	"motivo_pausa" text,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_contatos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"usuario_id" uuid,
	"cobrador_id" uuid,
	"tipo" text NOT NULL,
	"texto" text NOT NULL,
	"promessa_data" date,
	"promessa_valor" integer,
	"promessa_status" text,
	"retorno_em" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_envios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"titulo_id" uuid NOT NULL,
	"passo" integer NOT NULL,
	"canal" text NOT NULL,
	"resultado" text NOT NULL,
	"detalhe" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cobranca_protestos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"titulo_id" uuid NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"valor" integer NOT NULL,
	"especie" text NOT NULL,
	"cod_municipio" text NOT NULL,
	"status" text DEFAULT 'enviado' NOT NULL,
	"cartorio" text,
	"protocolo" text,
	"data_protocolo" text,
	"ocorrencia" text,
	"irregularidade" text,
	"custas" integer,
	"pedido" text,
	"pedido_em" timestamp with time zone,
	"remessa_id" uuid,
	"usuario_id" uuid,
	"historico" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "cobranca_valor" integer;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "cobranca_vencimento" date;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "acordo_id" uuid;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "renegociado_acordo_id" uuid;--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "cobrador_id" uuid;--> statement-breakpoint
ALTER TABLE "cobranca_acordos" ADD CONSTRAINT "cobranca_acordos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_acordos" ADD CONSTRAINT "cobranca_acordos_cobrador_id_cobradores_id_fk" FOREIGN KEY ("cobrador_id") REFERENCES "public"."cobradores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_acordos" ADD CONSTRAINT "cobranca_acordos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_arquivos_cra" ADD CONSTRAINT "cobranca_arquivos_cra_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_carteira" ADD CONSTRAINT "cobranca_carteira_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_carteira" ADD CONSTRAINT "cobranca_carteira_cobrador_id_cobradores_id_fk" FOREIGN KEY ("cobrador_id") REFERENCES "public"."cobradores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_contatos" ADD CONSTRAINT "cobranca_contatos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_contatos" ADD CONSTRAINT "cobranca_contatos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_contatos" ADD CONSTRAINT "cobranca_contatos_cobrador_id_cobradores_id_fk" FOREIGN KEY ("cobrador_id") REFERENCES "public"."cobradores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_envios" ADD CONSTRAINT "cobranca_envios_titulo_id_titulos_id_fk" FOREIGN KEY ("titulo_id") REFERENCES "public"."titulos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_protestos" ADD CONSTRAINT "cobranca_protestos_titulo_id_titulos_id_fk" FOREIGN KEY ("titulo_id") REFERENCES "public"."titulos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_protestos" ADD CONSTRAINT "cobranca_protestos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_protestos" ADD CONSTRAINT "cobranca_protestos_remessa_id_cobranca_arquivos_cra_id_fk" FOREIGN KEY ("remessa_id") REFERENCES "public"."cobranca_arquivos_cra"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca_protestos" ADD CONSTRAINT "cobranca_protestos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cobranca_contatos_pessoa_idx" ON "cobranca_contatos" USING btree ("pessoa_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "cobranca_envios_titulo_passo_idx" ON "cobranca_envios" USING btree ("titulo_id","passo");--> statement-breakpoint
CREATE INDEX "cobranca_protestos_titulo_idx" ON "cobranca_protestos" USING btree ("titulo_id");--> statement-breakpoint
-- Quem já tem o Financeiro ganha o acesso ao módulo de Cobrança.
UPDATE "grupos" SET "permissoes" = "permissoes" || jsonb_build_object('cobranca', "permissoes"->'financeiro') WHERE "permissoes" ? 'financeiro' AND NOT "permissoes" ? 'cobranca';
