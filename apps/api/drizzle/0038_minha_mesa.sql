CREATE TABLE "mesa_conversas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text,
	"direta" boolean DEFAULT false NOT NULL,
	"chave" text,
	"criado_por" uuid,
	"ultima_em" timestamp with time zone DEFAULT now() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mesa_conversas_chave_unique" UNIQUE("chave")
);
--> statement-breakpoint
CREATE TABLE "mesa_mensagens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversa_id" uuid NOT NULL,
	"usuario_id" uuid,
	"texto" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mesa_participantes" (
	"conversa_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"lido_ate" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mesa_participantes_conversa_id_usuario_id_pk" PRIMARY KEY("conversa_id","usuario_id")
);
--> statement-breakpoint
CREATE TABLE "mesa_tarefas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"titulo" text NOT NULL,
	"descricao" text,
	"responsavel_id" uuid NOT NULL,
	"criado_por" uuid,
	"vence_em" date,
	"prioridade" text DEFAULT 'normal' NOT NULL,
	"feita_em" timestamp with time zone,
	"feita_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mesa_conversas" ADD CONSTRAINT "mesa_conversas_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ADD CONSTRAINT "mesa_mensagens_conversa_id_mesa_conversas_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."mesa_conversas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ADD CONSTRAINT "mesa_mensagens_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_participantes" ADD CONSTRAINT "mesa_participantes_conversa_id_mesa_conversas_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."mesa_conversas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_participantes" ADD CONSTRAINT "mesa_participantes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_tarefas" ADD CONSTRAINT "mesa_tarefas_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_tarefas" ADD CONSTRAINT "mesa_tarefas_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesa_tarefas" ADD CONSTRAINT "mesa_tarefas_feita_por_usuarios_id_fk" FOREIGN KEY ("feita_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mesa_mensagens_conversa_idx" ON "mesa_mensagens" USING btree ("conversa_id","criado_em");--> statement-breakpoint
CREATE INDEX "mesa_participantes_usuario_idx" ON "mesa_participantes" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "mesa_tarefas_abertas_idx" ON "mesa_tarefas" USING btree ("responsavel_id","feita_em");