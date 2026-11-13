CREATE TYPE "public"."status_caixa" AS ENUM('aberto', 'fechado');--> statement-breakpoint
CREATE TYPE "public"."status_nota" AS ENUM('pendente', 'processando', 'autorizada', 'erro', 'cancelada', 'denegada');--> statement-breakpoint
CREATE TYPE "public"."status_venda" AS ENUM('concluida', 'cancelada');--> statement-breakpoint
CREATE TABLE "caixa_movimentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caixa_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"forma" text NOT NULL,
	"valor" integer NOT NULL,
	"descricao" text,
	"venda_id" uuid,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caixas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"local_id" uuid NOT NULL,
	"status" "status_caixa" DEFAULT 'aberto' NOT NULL,
	"valor_abertura" integer DEFAULT 0 NOT NULL,
	"aberto_em" timestamp with time zone DEFAULT now() NOT NULL,
	"aberto_por" uuid,
	"fechado_em" timestamp with time zone,
	"fechado_por" uuid,
	"contado" jsonb,
	"esperado" jsonb,
	"diferenca" integer,
	"observacao" text
);
--> statement-breakpoint
CREATE TABLE "chamado_mensagens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chamado_id" uuid NOT NULL,
	"usuario_id" uuid,
	"da_wide" boolean DEFAULT false NOT NULL,
	"texto" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chamados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"titulo" text NOT NULL,
	"tipo" text DEFAULT 'duvida' NOT NULL,
	"modulo" text,
	"tela" text,
	"prioridade" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'aberto' NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventos_integracao" (
	"id" text PRIMARY KEY NOT NULL,
	"origem" text NOT NULL,
	"tipo" text NOT NULL,
	"payload" jsonb NOT NULL,
	"resultado" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "importacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" text NOT NULL,
	"arquivo" text,
	"linhas" integer NOT NULL,
	"criados" integer DEFAULT 0 NOT NULL,
	"atualizados" integer DEFAULT 0 NOT NULL,
	"erros" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notas_fiscais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"modelo" text NOT NULL,
	"operacao" text NOT NULL,
	"ref" text NOT NULL,
	"origem_tipo" text NOT NULL,
	"origem_id" uuid NOT NULL,
	"destinatario_id" uuid,
	"valor" integer NOT NULL,
	"status" "status_nota" DEFAULT 'pendente' NOT NULL,
	"numero" text,
	"serie" text,
	"chave" text,
	"mensagem" text,
	"url_danfe" text,
	"url_xml" text,
	"payload" jsonb,
	"resposta" jsonb,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regras_fiscais" (
	"operacao" text PRIMARY KEY NOT NULL,
	"natureza" text NOT NULL,
	"cfop_dentro" text NOT NULL,
	"cfop_fora" text NOT NULL,
	"csosn" text DEFAULT '102' NOT NULL,
	"base" text DEFAULT 'venda' NOT NULL,
	"observacao" text,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venda_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venda_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"quantidade" integer NOT NULL,
	"preco" integer NOT NULL,
	"custo" integer NOT NULL,
	"desconto" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"devolvida" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venda_pagamentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venda_id" uuid NOT NULL,
	"forma" text NOT NULL,
	"valor" integer NOT NULL,
	"parcelas" integer DEFAULT 1 NOT NULL,
	"maquininha" text,
	"autorizacao" text
);
--> statement-breakpoint
CREATE TABLE "vendas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"empresa_id" uuid NOT NULL,
	"local_id" uuid NOT NULL,
	"caixa_id" uuid,
	"tipo" text DEFAULT 'balcao' NOT NULL,
	"cliente_id" uuid,
	"vendedor_id" uuid,
	"subtotal" integer NOT NULL,
	"desconto" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"troco" integer DEFAULT 0 NOT NULL,
	"status" "status_venda" DEFAULT 'concluida' NOT NULL,
	"observacao" text,
	"motivo_cancelamento" text,
	"cancelada_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "asaas_cliente_id" text;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "cobranca_tipo" text;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "cobranca_url" text;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "pix_copia_cola" text;--> statement-breakpoint
ALTER TABLE "caixa_movimentos" ADD CONSTRAINT "caixa_movimentos_caixa_id_caixas_id_fk" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixa_movimentos" ADD CONSTRAINT "caixa_movimentos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas" ADD CONSTRAINT "caixas_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas" ADD CONSTRAINT "caixas_local_id_locais_estoque_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas" ADD CONSTRAINT "caixas_aberto_por_usuarios_id_fk" FOREIGN KEY ("aberto_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas" ADD CONSTRAINT "caixas_fechado_por_usuarios_id_fk" FOREIGN KEY ("fechado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chamado_mensagens" ADD CONSTRAINT "chamado_mensagens_chamado_id_chamados_id_fk" FOREIGN KEY ("chamado_id") REFERENCES "public"."chamados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chamado_mensagens" ADD CONSTRAINT "chamado_mensagens_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chamados" ADD CONSTRAINT "chamados_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_destinatario_id_pessoas_id_fk" FOREIGN KEY ("destinatario_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venda_itens" ADD CONSTRAINT "venda_itens_venda_id_vendas_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venda_itens" ADD CONSTRAINT "venda_itens_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venda_pagamentos" ADD CONSTRAINT "venda_pagamentos_venda_id_vendas_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_local_id_locais_estoque_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_caixa_id_caixas_id_fk" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_cliente_id_pessoas_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_vendedor_id_usuarios_id_fk" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caixas_local_idx" ON "caixas" USING btree ("local_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notas_ref_uq" ON "notas_fiscais" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "notas_origem_idx" ON "notas_fiscais" USING btree ("origem_tipo","origem_id");--> statement-breakpoint
CREATE INDEX "vendas_data_idx" ON "vendas" USING btree ("criado_em");--> statement-breakpoint
CREATE INDEX "vendas_cliente_idx" ON "vendas" USING btree ("cliente_id");