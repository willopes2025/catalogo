ALTER TYPE "public"."tipo_movimento" ADD VALUE 'garantia';--> statement-breakpoint
CREATE TABLE "avisos_enviados" (
	"chave" text PRIMARY KEY NOT NULL,
	"para" text NOT NULL,
	"assunto" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comissoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fechamento_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"usuario_id" uuid,
	"pessoa_id" uuid,
	"nome" text NOT NULL,
	"base" integer NOT NULL,
	"percentual_pb" integer NOT NULL,
	"valor" integer NOT NULL,
	"meta" integer,
	"detalhes" jsonb,
	"titulo_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fechamentos_comissao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mes" text NOT NULL,
	"total" integer NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fechamentos_comissao_mes_unique" UNIQUE("mes")
);
--> statement-breakpoint
CREATE TABLE "ordens_servico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"tipo" text NOT NULL,
	"status" text DEFAULT 'aberta' NOT NULL,
	"cliente_id" uuid,
	"representante_id" uuid,
	"produto_id" uuid,
	"venda_id" uuid,
	"maleta_id" uuid,
	"data_compra" date,
	"garantia_ate" date,
	"defeito" text NOT NULL,
	"prestador_id" uuid,
	"servico_id" uuid,
	"valor" integer DEFAULT 0 NOT NULL,
	"valor_pago" integer DEFAULT 0 NOT NULL,
	"previsao" date,
	"decisao" text,
	"motivo_decisao" text,
	"produto_troca_id" uuid,
	"observacao" text,
	"observacao_interna" text,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluida_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "servicos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"descricao" text NOT NULL,
	"valor" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "comissao_pb" integer;--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "meta_mensal" integer;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_fechamento_id_fechamentos_comissao_id_fk" FOREIGN KEY ("fechamento_id") REFERENCES "public"."fechamentos_comissao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_titulo_id_titulos_id_fk" FOREIGN KEY ("titulo_id") REFERENCES "public"."titulos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_comissao" ADD CONSTRAINT "fechamentos_comissao_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_cliente_id_pessoas_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_representante_id_pessoas_id_fk" FOREIGN KEY ("representante_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_venda_id_vendas_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_prestador_id_pessoas_id_fk" FOREIGN KEY ("prestador_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_servico_id_servicos_id_fk" FOREIGN KEY ("servico_id") REFERENCES "public"."servicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_produto_troca_id_produtos_id_fk" FOREIGN KEY ("produto_troca_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordens_servico" ADD CONSTRAINT "ordens_servico_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "os_status_idx" ON "ordens_servico" USING btree ("status");