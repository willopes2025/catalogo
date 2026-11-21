CREATE TABLE "assistente_anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"arquivo" text NOT NULL,
	"nome" text NOT NULL,
	"mime" text NOT NULL,
	"tamanho" integer NOT NULL,
	"extrato" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistente_mensagens" ADD COLUMN "fala" text;--> statement-breakpoint
ALTER TABLE "assistente_rotinas" ADD COLUMN "aprovacao" text DEFAULT 'perguntar' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistente_sessoes" ADD COLUMN "aprovacao" text DEFAULT 'perguntar' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistente_anexos" ADD CONSTRAINT "assistente_anexos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;