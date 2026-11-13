CREATE TYPE "public"."modelo_trabalho" AS ENUM('consignado', 'revenda', 'afiliado');--> statement-breakpoint
CREATE TYPE "public"."status_maleta" AS ENUM('aberta', 'acertada', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."status_pessoa" AS ENUM('triagem', 'ativo', 'inativo', 'recusado');--> statement-breakpoint
CREATE TYPE "public"."status_titulo" AS ENUM('aberto', 'pago', 'cancelado', 'protestado');--> statement-breakpoint
CREATE TYPE "public"."tipo_empresa" AS ENUM('matriz', 'loja');--> statement-breakpoint
CREATE TYPE "public"."tipo_local" AS ENUM('deposito', 'loja', 'evento', 'maleta');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimento" AS ENUM('entrada', 'ajuste', 'transferencia', 'maleta_envio', 'maleta_devolucao', 'venda', 'perda');--> statement-breakpoint
CREATE TYPE "public"."tipo_pessoa" AS ENUM('representante', 'cliente', 'fornecedor', 'transportadora', 'assistencia');--> statement-breakpoint
CREATE TABLE "acertos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"maleta_id" uuid NOT NULL,
	"data" date NOT NULL,
	"forma" text NOT NULL,
	"modalidade" text DEFAULT 'presencial' NOT NULL,
	"parcial" boolean DEFAULT false NOT NULL,
	"resultado" jsonb NOT NULL,
	"regras" jsonb NOT NULL,
	"total_a_pagar" integer NOT NULL,
	"parcelas" integer DEFAULT 1 NOT NULL,
	"limite_anterior" integer,
	"limite_novo" integer,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid,
	"acao" text NOT NULL,
	"entidade" text NOT NULL,
	"entidade_id" text,
	"dados" jsonb,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categorias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"pai_id" uuid
);
--> statement-breakpoint
CREATE TABLE "configuracoes" (
	"chave" text PRIMARY KEY NOT NULL,
	"valor" jsonb NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"tipo" text DEFAULT 'banco' NOT NULL,
	"saldo_inicial" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creditos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"valor" integer NOT NULL,
	"descricao" text NOT NULL,
	"origem_tipo" text,
	"origem_id" uuid,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "empresas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"razao_social" text,
	"cnpj" text,
	"inscricao_estadual" text,
	"tipo" "tipo_empresa" DEFAULT 'matriz' NOT NULL,
	"cidade" text,
	"uf" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grupos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"permissoes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grupos_nome_unique" UNIQUE("nome")
);
--> statement-breakpoint
CREATE TABLE "locais_estoque" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"tipo" "tipo_local" NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotes_banho" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"fornecedor_id" uuid,
	"fabricacao" date,
	"validade" date,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maleta_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"maleta_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"preco" integer NOT NULL,
	"custo" integer NOT NULL,
	"enviada" integer DEFAULT 0 NOT NULL,
	"vendida" integer DEFAULT 0 NOT NULL,
	"devolvida" integer DEFAULT 0 NOT NULL,
	"perdida" integer DEFAULT 0 NOT NULL,
	"prebaixa_vendida" integer,
	"prebaixa_devolvida" integer
);
--> statement-breakpoint
CREATE TABLE "maletas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"empresa_id" uuid NOT NULL,
	"representante_id" uuid NOT NULL,
	"local_id" uuid NOT NULL,
	"origem_id" uuid NOT NULL,
	"status" "status_maleta" DEFAULT 'aberta' NOT NULL,
	"data_retirada" date NOT NULL,
	"data_limite" date NOT NULL,
	"entrega" text DEFAULT 'retirada' NOT NULL,
	"codigo_rastreio" text,
	"conferida" boolean DEFAULT false NOT NULL,
	"recebida_em" timestamp with time zone,
	"link_token" text NOT NULL,
	"prebaixa_em" timestamp with time zone,
	"observacao" text,
	"observacao_interna" text,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"acertada_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "movimentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"produto_id" uuid NOT NULL,
	"origem_id" uuid,
	"destino_id" uuid,
	"quantidade" integer NOT NULL,
	"tipo" "tipo_movimento" NOT NULL,
	"motivo" text,
	"referencia_tipo" text,
	"referencia_id" uuid,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "niveis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"meta_mensal" integer DEFAULT 0 NOT NULL,
	"comissao_avista_pb" integer,
	"comissao_prazo_pb" integer
);
--> statement-breakpoint
CREATE TABLE "pessoas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" "tipo_pessoa" NOT NULL,
	"tipo_documento" text DEFAULT 'cpf' NOT NULL,
	"documento" text,
	"nome" text NOT NULL,
	"nome_fantasia" text,
	"rg" text,
	"inscricao_estadual" text,
	"nascimento" date,
	"genero" text,
	"estado_civil" text,
	"profissao" text,
	"telefone1" text,
	"telefone2" text,
	"telefone3" text,
	"email" text,
	"instagram" text,
	"cep" text,
	"logradouro" text,
	"numero" text,
	"complemento" text,
	"bairro" text,
	"cidade" text,
	"uf" text,
	"modelo_trabalho" "modelo_trabalho",
	"nivel_id" uuid,
	"lider_id" uuid,
	"supervisor_id" uuid,
	"indicado_por_id" uuid,
	"praca" text,
	"limite_credito" integer DEFAULT 0 NOT NULL,
	"bloqueado" boolean DEFAULT false NOT NULL,
	"motivo_bloqueio" text,
	"representante_id" uuid,
	"consentimento_lgpd" boolean DEFAULT false NOT NULL,
	"status" "status_pessoa" DEFAULT 'ativo' NOT NULL,
	"observacao" text,
	"observacao_interna" text,
	"id_jueri" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "produtos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo_barras" text NOT NULL,
	"referencia" text NOT NULL,
	"descricao" text NOT NULL,
	"categoria_id" uuid,
	"tamanho" text,
	"cor" text,
	"peso_banho" text,
	"milesimos" text,
	"fornecedor_id" uuid,
	"codigo_fornecedor" text,
	"lote_banho_id" uuid,
	"custo" integer DEFAULT 0 NOT NULL,
	"preco" integer NOT NULL,
	"preco_atacado" integer,
	"desconto_maximo_pb" integer DEFAULT 0 NOT NULL,
	"estoque_minimo" integer DEFAULT 0 NOT NULL,
	"localizacao" text,
	"ncm" text,
	"cfop" text,
	"fotos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exibe_catalogo" boolean DEFAULT true NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"id_jueri" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referencias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"telefone" text,
	"relacao" text
);
--> statement-breakpoint
CREATE TABLE "saldos" (
	"produto_id" uuid NOT NULL,
	"local_id" uuid NOT NULL,
	"quantidade" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "saldos_produto_id_local_id_pk" PRIMARY KEY("produto_id","local_id")
);
--> statement-breakpoint
CREATE TABLE "titulos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"pessoa_id" uuid,
	"descricao" text NOT NULL,
	"categoria" text,
	"valor" integer NOT NULL,
	"vencimento" date NOT NULL,
	"parcela" integer DEFAULT 1 NOT NULL,
	"total_parcelas" integer DEFAULT 1 NOT NULL,
	"forma_pagamento" text,
	"status" "status_titulo" DEFAULT 'aberto' NOT NULL,
	"conta_id" uuid,
	"origem_tipo" text,
	"origem_id" uuid,
	"pago_em" date,
	"valor_pago" integer,
	"cobranca_externa_id" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"email" text NOT NULL,
	"senha_hash" text NOT NULL,
	"grupo_id" uuid NOT NULL,
	"empresas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_acesso" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "acertos" ADD CONSTRAINT "acertos_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acertos" ADD CONSTRAINT "acertos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorias" ADD CONSTRAINT "categorias_pai_id_categorias_id_fk" FOREIGN KEY ("pai_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas" ADD CONSTRAINT "contas_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditos" ADD CONSTRAINT "creditos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditos" ADD CONSTRAINT "creditos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locais_estoque" ADD CONSTRAINT "locais_estoque_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotes_banho" ADD CONSTRAINT "lotes_banho_fornecedor_id_pessoas_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maleta_itens" ADD CONSTRAINT "maleta_itens_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maleta_itens" ADD CONSTRAINT "maleta_itens_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maletas" ADD CONSTRAINT "maletas_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maletas" ADD CONSTRAINT "maletas_representante_id_pessoas_id_fk" FOREIGN KEY ("representante_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maletas" ADD CONSTRAINT "maletas_local_id_locais_estoque_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maletas" ADD CONSTRAINT "maletas_origem_id_locais_estoque_id_fk" FOREIGN KEY ("origem_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maletas" ADD CONSTRAINT "maletas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos" ADD CONSTRAINT "movimentos_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos" ADD CONSTRAINT "movimentos_origem_id_locais_estoque_id_fk" FOREIGN KEY ("origem_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos" ADD CONSTRAINT "movimentos_destino_id_locais_estoque_id_fk" FOREIGN KEY ("destino_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos" ADD CONSTRAINT "movimentos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_nivel_id_niveis_id_fk" FOREIGN KEY ("nivel_id") REFERENCES "public"."niveis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_lider_id_pessoas_id_fk" FOREIGN KEY ("lider_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_supervisor_id_usuarios_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_indicado_por_id_pessoas_id_fk" FOREIGN KEY ("indicado_por_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_representante_id_pessoas_id_fk" FOREIGN KEY ("representante_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "produtos_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "produtos_fornecedor_id_pessoas_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "produtos_lote_banho_id_lotes_banho_id_fk" FOREIGN KEY ("lote_banho_id") REFERENCES "public"."lotes_banho"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referencias" ADD CONSTRAINT "referencias_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos" ADD CONSTRAINT "saldos_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos" ADD CONSTRAINT "saldos_local_id_locais_estoque_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locais_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titulos" ADD CONSTRAINT "titulos_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titulos" ADD CONSTRAINT "titulos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titulos" ADD CONSTRAINT "titulos_conta_id_contas_id_fk" FOREIGN KEY ("conta_id") REFERENCES "public"."contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_grupo_id_grupos_id_fk" FOREIGN KEY ("grupo_id") REFERENCES "public"."grupos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auditoria_entidade_idx" ON "auditoria" USING btree ("entidade","entidade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maleta_itens_uq" ON "maleta_itens" USING btree ("maleta_id","produto_id");--> statement-breakpoint
CREATE INDEX "maletas_rep_idx" ON "maletas" USING btree ("representante_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "maletas_link_uq" ON "maletas" USING btree ("link_token");--> statement-breakpoint
CREATE INDEX "movimentos_produto_idx" ON "movimentos" USING btree ("produto_id","criado_em");--> statement-breakpoint
CREATE INDEX "movimentos_ref_idx" ON "movimentos" USING btree ("referencia_tipo","referencia_id");--> statement-breakpoint
CREATE INDEX "pessoas_tipo_idx" ON "pessoas" USING btree ("tipo","status");--> statement-breakpoint
CREATE INDEX "pessoas_documento_idx" ON "pessoas" USING btree ("documento");--> statement-breakpoint
CREATE INDEX "pessoas_lider_idx" ON "pessoas" USING btree ("lider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "produtos_codigo_barras_uq" ON "produtos" USING btree ("codigo_barras");--> statement-breakpoint
CREATE INDEX "produtos_referencia_idx" ON "produtos" USING btree ("referencia");--> statement-breakpoint
CREATE INDEX "titulos_venc_idx" ON "titulos" USING btree ("tipo","status","vencimento");--> statement-breakpoint
CREATE INDEX "titulos_pessoa_idx" ON "titulos" USING btree ("pessoa_id");