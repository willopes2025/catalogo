CREATE TABLE "segredos" (
	"chave" text PRIMARY KEY NOT NULL,
	"valor_cifrado" text NOT NULL,
	"final" text,
	"usuario_id" uuid,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segredos" ADD CONSTRAINT "segredos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;