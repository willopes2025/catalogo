CREATE TABLE "assistente_rotinas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"titulo" text NOT NULL,
	"instrucao" text NOT NULL,
	"tipo" text DEFAULT 'horario' NOT NULL,
	"horario" text DEFAULT '08:00' NOT NULL,
	"intervalo_min" integer,
	"janela_inicio" text,
	"janela_fim" text,
	"dias" jsonb DEFAULT '[0,1,2,3,4,5,6]'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"proxima_em" timestamp with time zone NOT NULL,
	"ultima_em" timestamp with time zone,
	"ultima_sessao_id" uuid,
	"ultimo_erro" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistente_rotinas" ADD CONSTRAINT "assistente_rotinas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistente_rotinas" ADD CONSTRAINT "assistente_rotinas_ultima_sessao_id_assistente_sessoes_id_fk" FOREIGN KEY ("ultima_sessao_id") REFERENCES "public"."assistente_sessoes"("id") ON DELETE set null ON UPDATE no action;