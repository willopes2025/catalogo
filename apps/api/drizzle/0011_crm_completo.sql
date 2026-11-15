CREATE TABLE "crm_campos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entidade" text NOT NULL,
	"nome" text NOT NULL,
	"tipo" text DEFAULT 'texto' NOT NULL,
	"opcoes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"funil_id" uuid,
	"ordem" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_canais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"tipo" text NOT NULL,
	"numero" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_webhook" text NOT NULL,
	"usuario_id" uuid,
	"atendentes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"funil_entrada_id" uuid,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contatos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"telefone" text NOT NULL,
	"email" text,
	"pessoa_id" uuid,
	"etiquetas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"descadastrado" boolean DEFAULT false NOT NULL,
	"campos_extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_conversas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contato_id" uuid NOT NULL,
	"canal_id" uuid NOT NULL,
	"atendente_id" uuid,
	"status" text DEFAULT 'fila' NOT NULL,
	"fila_desde" timestamp with time zone,
	"pega_em" timestamp with time zone,
	"nao_lidas" integer DEFAULT 0 NOT NULL,
	"ultima_mensagem" text,
	"ultima_mensagem_em" timestamp with time zone,
	"ultima_entrada_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_disparo_destinos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"disparo_id" uuid NOT NULL,
	"contato_id" uuid NOT NULL,
	"lead_id" uuid,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"mensagem_id" uuid,
	"enviado_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_disparos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"canal_id" uuid NOT NULL,
	"template_id" uuid,
	"texto" text,
	"filtro" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'rascunho' NOT NULL,
	"agendado_para" timestamp with time zone,
	"ritmo" integer DEFAULT 20 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"enviados" integer DEFAULT 0 NOT NULL,
	"falhas" integer DEFAULT 0 NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_etapas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funil_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"cor" text DEFAULT '#a68a64' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"tipo" text DEFAULT 'aberta' NOT NULL,
	"chave" text
);
--> statement-breakpoint
CREATE TABLE "crm_eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"texto" text NOT NULL,
	"dados" jsonb,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_fila" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gatilho_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"passo" integer DEFAULT 0 NOT NULL,
	"executar_em" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"etapa_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_funis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"tipo" text DEFAULT 'outro' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_gatilhos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"funil_id" uuid,
	"evento" text NOT NULL,
	"etapa_id" uuid,
	"parametro" text,
	"acoes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"execucoes" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" serial NOT NULL,
	"funil_id" uuid NOT NULL,
	"etapa_id" uuid NOT NULL,
	"contato_id" uuid NOT NULL,
	"titulo" text NOT NULL,
	"valor" integer DEFAULT 0 NOT NULL,
	"responsavel_id" uuid,
	"etiquetas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origem" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"campos_extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'aberto' NOT NULL,
	"motivo_perda" text,
	"candidatura_id" uuid,
	"pessoa_id" uuid,
	"entrou_na_etapa_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultima_interacao_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_mensagens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversa_id" uuid NOT NULL,
	"direcao" text NOT NULL,
	"tipo" text DEFAULT 'texto' NOT NULL,
	"texto" text,
	"midia" text,
	"midia_nome" text,
	"template_nome" text,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"id_externo" text,
	"usuario_id" uuid,
	"gatilho_id" uuid,
	"disparo_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_ramais" (
	"usuario_id" uuid PRIMARY KEY NOT NULL,
	"servidor" text NOT NULL,
	"usuario_sip" text NOT NULL,
	"senha_cifrada" text NOT NULL,
	"nome_exibicao" text,
	"prefixo" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_respostas_rapidas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atalho" text NOT NULL,
	"texto" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_respostas_rapidas_atalho_unique" UNIQUE("atalho")
);
--> statement-breakpoint
CREATE TABLE "crm_tarefas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"titulo" text NOT NULL,
	"vence_em" timestamp with time zone NOT NULL,
	"responsavel_id" uuid,
	"feita_em" timestamp with time zone,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canal_id" uuid,
	"nome" text NOT NULL,
	"tipo" text DEFAULT 'livre' NOT NULL,
	"idioma" text DEFAULT 'pt_BR' NOT NULL,
	"categoria" text,
	"texto" text NOT NULL,
	"componentes" jsonb,
	"status" text DEFAULT 'ATIVO' NOT NULL,
	"variaveis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_campos" ADD CONSTRAINT "crm_campos_funil_id_crm_funis_id_fk" FOREIGN KEY ("funil_id") REFERENCES "public"."crm_funis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD CONSTRAINT "crm_canais_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_canais" ADD CONSTRAINT "crm_canais_funil_entrada_id_crm_funis_id_fk" FOREIGN KEY ("funil_entrada_id") REFERENCES "public"."crm_funis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contatos" ADD CONSTRAINT "crm_contatos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD CONSTRAINT "crm_conversas_contato_id_crm_contatos_id_fk" FOREIGN KEY ("contato_id") REFERENCES "public"."crm_contatos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD CONSTRAINT "crm_conversas_canal_id_crm_canais_id_fk" FOREIGN KEY ("canal_id") REFERENCES "public"."crm_canais"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_conversas" ADD CONSTRAINT "crm_conversas_atendente_id_usuarios_id_fk" FOREIGN KEY ("atendente_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparo_destinos" ADD CONSTRAINT "crm_disparo_destinos_disparo_id_crm_disparos_id_fk" FOREIGN KEY ("disparo_id") REFERENCES "public"."crm_disparos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparo_destinos" ADD CONSTRAINT "crm_disparo_destinos_contato_id_crm_contatos_id_fk" FOREIGN KEY ("contato_id") REFERENCES "public"."crm_contatos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparo_destinos" ADD CONSTRAINT "crm_disparo_destinos_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD CONSTRAINT "crm_disparos_canal_id_crm_canais_id_fk" FOREIGN KEY ("canal_id") REFERENCES "public"."crm_canais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD CONSTRAINT "crm_disparos_template_id_crm_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."crm_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_disparos" ADD CONSTRAINT "crm_disparos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_etapas" ADD CONSTRAINT "crm_etapas_funil_id_crm_funis_id_fk" FOREIGN KEY ("funil_id") REFERENCES "public"."crm_funis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_eventos" ADD CONSTRAINT "crm_eventos_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_eventos" ADD CONSTRAINT "crm_eventos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_fila" ADD CONSTRAINT "crm_fila_gatilho_id_crm_gatilhos_id_fk" FOREIGN KEY ("gatilho_id") REFERENCES "public"."crm_gatilhos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_fila" ADD CONSTRAINT "crm_fila_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_gatilhos" ADD CONSTRAINT "crm_gatilhos_funil_id_crm_funis_id_fk" FOREIGN KEY ("funil_id") REFERENCES "public"."crm_funis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_gatilhos" ADD CONSTRAINT "crm_gatilhos_etapa_id_crm_etapas_id_fk" FOREIGN KEY ("etapa_id") REFERENCES "public"."crm_etapas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_funil_id_crm_funis_id_fk" FOREIGN KEY ("funil_id") REFERENCES "public"."crm_funis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_etapa_id_crm_etapas_id_fk" FOREIGN KEY ("etapa_id") REFERENCES "public"."crm_etapas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_contato_id_crm_contatos_id_fk" FOREIGN KEY ("contato_id") REFERENCES "public"."crm_contatos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_candidatura_id_candidaturas_id_fk" FOREIGN KEY ("candidatura_id") REFERENCES "public"."candidaturas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_mensagens" ADD CONSTRAINT "crm_mensagens_conversa_id_crm_conversas_id_fk" FOREIGN KEY ("conversa_id") REFERENCES "public"."crm_conversas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_mensagens" ADD CONSTRAINT "crm_mensagens_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ramais" ADD CONSTRAINT "crm_ramais_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD CONSTRAINT "crm_tarefas_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD CONSTRAINT "crm_tarefas_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tarefas" ADD CONSTRAINT "crm_tarefas_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_templates" ADD CONSTRAINT "crm_templates_canal_id_crm_canais_id_fk" FOREIGN KEY ("canal_id") REFERENCES "public"."crm_canais"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contatos_telefone_idx" ON "crm_contatos" USING btree ("telefone");--> statement-breakpoint
CREATE INDEX "crm_contatos_pessoa_idx" ON "crm_contatos" USING btree ("pessoa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_conversas_contato_canal_idx" ON "crm_conversas" USING btree ("contato_id","canal_id");--> statement-breakpoint
CREATE INDEX "crm_conversas_recentes_idx" ON "crm_conversas" USING btree ("ultima_mensagem_em");--> statement-breakpoint
CREATE INDEX "crm_conversas_status_idx" ON "crm_conversas" USING btree ("status","atendente_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_disparo_destino_idx" ON "crm_disparo_destinos" USING btree ("disparo_id","contato_id");--> statement-breakpoint
CREATE INDEX "crm_disparo_pendentes_idx" ON "crm_disparo_destinos" USING btree ("disparo_id","status");--> statement-breakpoint
CREATE INDEX "crm_etapas_funil_idx" ON "crm_etapas" USING btree ("funil_id","ordem");--> statement-breakpoint
CREATE INDEX "crm_eventos_lead_idx" ON "crm_eventos" USING btree ("lead_id","criado_em");--> statement-breakpoint
CREATE INDEX "crm_fila_pendentes_idx" ON "crm_fila" USING btree ("status","executar_em");--> statement-breakpoint
CREATE INDEX "crm_leads_etapa_idx" ON "crm_leads" USING btree ("funil_id","etapa_id");--> statement-breakpoint
CREATE INDEX "crm_leads_contato_idx" ON "crm_leads" USING btree ("contato_id");--> statement-breakpoint
CREATE INDEX "crm_leads_pessoa_idx" ON "crm_leads" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "crm_mensagens_conversa_idx" ON "crm_mensagens" USING btree ("conversa_id","criado_em");--> statement-breakpoint
CREATE INDEX "crm_mensagens_externo_idx" ON "crm_mensagens" USING btree ("id_externo");--> statement-breakpoint
CREATE INDEX "crm_tarefas_abertas_idx" ON "crm_tarefas" USING btree ("responsavel_id","vence_em");--> statement-breakpoint
-- Funis que vêm instalados (a Aritana pode renomear etapas, criar outras e outros funis).
INSERT INTO "crm_funis" ("id", "nome", "tipo", "ordem") VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Recrutamento de revendedoras', 'recrutamento', 1),
  ('a0000000-0000-4000-8000-000000000002', 'Clientes da loja', 'clientes', 2),
  ('a0000000-0000-4000-8000-000000000003', 'Relacionamento com revendedoras', 'revendedoras', 3);
--> statement-breakpoint
INSERT INTO "crm_etapas" ("funil_id", "nome", "cor", "ordem", "tipo", "chave") VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Nova candidata', '#8a9bb0', 1, 'aberta', 'nova'),
  ('a0000000-0000-4000-8000-000000000001', 'Primeiro contato', '#a68a64', 2, 'aberta', 'contato'),
  ('a0000000-0000-4000-8000-000000000001', 'Entrevista', '#c49a5a', 3, 'aberta', 'entrevista'),
  ('a0000000-0000-4000-8000-000000000001', 'Documentos', '#9c7a4f', 4, 'aberta', 'documentos'),
  ('a0000000-0000-4000-8000-000000000001', 'Aprovada', '#4f8a5b', 5, 'ganho', 'aprovada'),
  ('a0000000-0000-4000-8000-000000000001', 'Recusada', '#b0574f', 6, 'perdido', 'recusada'),
  ('a0000000-0000-4000-8000-000000000002', 'Novo contato', '#8a9bb0', 1, 'aberta', 'novo'),
  ('a0000000-0000-4000-8000-000000000002', 'Em atendimento', '#a68a64', 2, 'aberta', 'atendimento'),
  ('a0000000-0000-4000-8000-000000000002', 'Comprou', '#4f8a5b', 3, 'aberta', 'comprou'),
  ('a0000000-0000-4000-8000-000000000002', 'Pós-venda', '#6f9a7a', 4, 'aberta', 'pos_venda'),
  ('a0000000-0000-4000-8000-000000000002', 'Hora da recompra', '#c49a5a', 5, 'aberta', 'recompra'),
  ('a0000000-0000-4000-8000-000000000002', 'Sem interesse', '#b0574f', 6, 'perdido', 'perdido'),
  ('a0000000-0000-4000-8000-000000000003', 'Nova revendedora', '#8a9bb0', 1, 'aberta', 'nova'),
  ('a0000000-0000-4000-8000-000000000003', 'Ativa', '#4f8a5b', 2, 'aberta', 'ativa'),
  ('a0000000-0000-4000-8000-000000000003', 'Acerto nos próximos 7 dias', '#c49a5a', 3, 'aberta', 'acerto_proximo'),
  ('a0000000-0000-4000-8000-000000000003', 'Acerto atrasado', '#b0574f', 4, 'aberta', 'atrasada'),
  ('a0000000-0000-4000-8000-000000000003', 'Parada (sem maleta)', '#8a7f72', 5, 'aberta', 'parada'),
  ('a0000000-0000-4000-8000-000000000003', 'Inativa', '#5b5b5b', 6, 'perdido', 'inativa');
--> statement-breakpoint
-- Candidatas que já estavam no sistema passam para o funil de recrutamento.
INSERT INTO "crm_contatos" ("nome", "telefone", "email", "pessoa_id", "criado_em", "campos_extras")
SELECT DISTINCT ON (tel) c.nome, tel, c.email, c.pessoa_id, c.criado_em,
  jsonb_strip_nulls(jsonb_build_object('Cidade', c.cidade, 'UF', c.uf, 'Instagram', c.instagram, 'CPF', c.cpf))
FROM (SELECT *, CASE WHEN length(telefone) IN (10, 11) THEN '55' || telefone ELSE telefone END AS tel FROM "candidaturas") c
ORDER BY tel, c.criado_em DESC
ON CONFLICT ("telefone") DO NOTHING;
--> statement-breakpoint
INSERT INTO "crm_leads" ("funil_id", "etapa_id", "contato_id", "titulo", "responsavel_id", "origem", "status", "motivo_perda", "candidatura_id", "pessoa_id", "entrou_na_etapa_em", "criado_em", "atualizado_em", "campos_extras")
SELECT 'a0000000-0000-4000-8000-000000000001', e.id, ct.id, c.nome || ' · ' || coalesce(c.cidade, '') , c.responsavel_id, c.origem,
  CASE e.tipo WHEN 'ganho' THEN 'ganho' WHEN 'perdido' THEN 'perdido' ELSE 'aberto' END, c.motivo_recusa, c.id, c.pessoa_id, c.atualizado_em, c.criado_em, c.atualizado_em,
  jsonb_strip_nulls(jsonb_build_object('Modelo de interesse', c.modelo_interesse, 'Experiência com vendas', c.experiencia, 'Como conheceu', c.como_conheceu, 'Indicada por', c.indicada_por))
FROM "candidaturas" c
JOIN "crm_etapas" e ON e.funil_id = 'a0000000-0000-4000-8000-000000000001' AND e.chave = c.etapa
JOIN "crm_contatos" ct ON ct.telefone = CASE WHEN length(c.telefone) IN (10, 11) THEN '55' || c.telefone ELSE c.telefone END;
--> statement-breakpoint
INSERT INTO "crm_eventos" ("lead_id", "tipo", "texto", "usuario_id", "criado_em")
SELECT l.id, 'nota', n.texto, n.usuario_id, n.criado_em FROM "candidatura_notas" n JOIN "crm_leads" l ON l.candidatura_id = n.candidatura_id;

--> statement-breakpoint
-- Campos personalizados que vêm instalados: da pessoa (contato) e do negócio no recrutamento.
INSERT INTO "crm_campos" ("entidade", "nome", "tipo", "opcoes", "funil_id", "ordem") VALUES
  ('contato', 'CPF', 'texto', '[]', NULL, 1),
  ('contato', 'Cidade', 'texto', '[]', NULL, 2),
  ('contato', 'UF', 'texto', '[]', NULL, 3),
  ('contato', 'Aniversário', 'data', '[]', NULL, 4),
  ('contato', 'Instagram', 'texto', '[]', NULL, 5),
  ('lead', 'Modelo de interesse', 'lista', '["consignado","revenda","afiliado","nao_sei"]', 'a0000000-0000-4000-8000-000000000001', 1),
  ('lead', 'Experiência com vendas', 'texto', '[]', 'a0000000-0000-4000-8000-000000000001', 2),
  ('lead', 'Como conheceu', 'texto', '[]', 'a0000000-0000-4000-8000-000000000001', 3),
  ('lead', 'Indicada por', 'texto', '[]', 'a0000000-0000-4000-8000-000000000001', 4),
  ('lead', 'Interesse em', 'texto', '[]', 'a0000000-0000-4000-8000-000000000002', 1);
