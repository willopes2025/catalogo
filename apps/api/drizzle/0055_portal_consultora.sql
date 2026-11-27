ALTER TYPE "public"."tipo_documento" ADD VALUE 'promissoria_venda';--> statement-breakpoint
CREATE TABLE "consultora_vendas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"consultora_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"itens" jsonb NOT NULL,
	"total" integer NOT NULL,
	"desconto" integer DEFAULT 0 NOT NULL,
	"forma" text NOT NULL,
	"forma_pagamento" text,
	"parcelas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'aberta' NOT NULL,
	"maleta_id" uuid,
	"pedido_matriz_id" uuid,
	"promissoria_id" uuid,
	"cobranca_em" timestamp with time zone,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conteudo_vistos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conteudo_id" uuid NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conteudos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secao" text NOT NULL,
	"categoria" text NOT NULL,
	"titulo" text NOT NULL,
	"descricao" text,
	"arquivo" text NOT NULL,
	"mime" text NOT NULL,
	"tamanho" integer DEFAULT 0 NOT NULL,
	"legenda" text,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD COLUMN "fotos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD COLUMN "origem" text DEFAULT 'sistema' NOT NULL;--> statement-breakpoint
ALTER TABLE "pedidos_pecas" ADD COLUMN "tipo" text DEFAULT 'reposicao' NOT NULL;--> statement-breakpoint
ALTER TABLE "pedidos_pecas" ADD COLUMN "venda_id" uuid;--> statement-breakpoint
ALTER TABLE "pedidos_pecas" ADD COLUMN "entrega" text;--> statement-breakpoint
ALTER TABLE "pedidos_pecas" ADD COLUMN "endereco_entrega" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "asaas_wallet_id" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "chave_pix" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "aceite_cobranca_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consultora_vendas" ADD CONSTRAINT "consultora_vendas_consultora_id_pessoas_id_fk" FOREIGN KEY ("consultora_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultora_vendas" ADD CONSTRAINT "consultora_vendas_cliente_id_pessoas_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultora_vendas" ADD CONSTRAINT "consultora_vendas_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conteudo_vistos" ADD CONSTRAINT "conteudo_vistos_conteudo_id_conteudos_id_fk" FOREIGN KEY ("conteudo_id") REFERENCES "public"."conteudos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conteudo_vistos" ADD CONSTRAINT "conteudo_vistos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conteudos" ADD CONSTRAINT "conteudos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consultora_vendas_consultora_idx" ON "consultora_vendas" USING btree ("consultora_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "conteudo_vistos_uq" ON "conteudo_vistos" USING btree ("conteudo_id","pessoa_id");