CREATE TABLE "assistente_acoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessao_id" uuid NOT NULL,
	"usuario_id" uuid,
	"ferramenta" text NOT NULL,
	"entrada" jsonb NOT NULL,
	"risco" text NOT NULL,
	"status" text NOT NULL,
	"resumo" text,
	"previa" jsonb,
	"resultado" jsonb,
	"erro" text,
	"progresso" jsonb,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluida_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assistente_mensagens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessao_id" uuid NOT NULL,
	"papel" text NOT NULL,
	"conteudo" jsonb NOT NULL,
	"texto" text,
	"origem" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistente_pedidos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"sessao_id" uuid,
	"usuario_id" uuid,
	"tipo" text NOT NULL,
	"titulo" text NOT NULL,
	"especificacao" text NOT NULL,
	"plano" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"modulo" text,
	"prioridade" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'novo' NOT NULL,
	"chamado_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistente_sessoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"titulo" text DEFAULT 'Nova conversa' NOT NULL,
	"ocupada" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistente_acoes" ADD CONSTRAINT "assistente_acoes_sessao_id_assistente_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."assistente_sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_acoes" ADD CONSTRAINT "assistente_acoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_mensagens" ADD CONSTRAINT "assistente_mensagens_sessao_id_assistente_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."assistente_sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_pedidos" ADD CONSTRAINT "assistente_pedidos_sessao_id_assistente_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."assistente_sessoes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_pedidos" ADD CONSTRAINT "assistente_pedidos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_pedidos" ADD CONSTRAINT "assistente_pedidos_chamado_id_chamados_id_fk" FOREIGN KEY ("chamado_id") REFERENCES "public"."chamados"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_sessoes" ADD CONSTRAINT "assistente_sessoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistente_acoes_sessao_idx" ON "assistente_acoes" USING btree ("sessao_id","criado_em");--> statement-breakpoint
CREATE INDEX "assistente_mensagens_sessao_idx" ON "assistente_mensagens" USING btree ("sessao_id","criado_em");--> statement-breakpoint
CREATE INDEX "assistente_sessoes_usuario_idx" ON "assistente_sessoes" USING btree ("usuario_id","atualizado_em");