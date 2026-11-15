CREATE TABLE "rh_documentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"titulo" text NOT NULL,
	"competencia" text,
	"data" date,
	"validade" date,
	"arquivo" text NOT NULL,
	"nome_arquivo" text NOT NULL,
	"mime" text NOT NULL,
	"tamanho" integer NOT NULL,
	"visivel_funcionario" boolean DEFAULT true NOT NULL,
	"ciente_em" timestamp with time zone,
	"ciente_ip" text,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rh_envios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competencia" text NOT NULL,
	"canal" text NOT NULL,
	"destino" text NOT NULL,
	"itens" jsonb NOT NULL,
	"arquivos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mensagem" text,
	"status" text NOT NULL,
	"erro" text,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rh_escalas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"dias" jsonb NOT NULL,
	"tolerancia_marcacao" integer DEFAULT 5 NOT NULL,
	"tolerancia_dia" integer DEFAULT 10 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rh_fechamentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"competencia" text NOT NULL,
	"espelho" jsonb NOT NULL,
	"fechado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"fechado_por" uuid,
	"ciente_em" timestamp with time zone,
	"ciente_ip" text
);
--> statement-breakpoint
CREATE TABLE "rh_feriados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data" date NOT NULL,
	"nome" text NOT NULL,
	CONSTRAINT "rh_feriados_data_unique" UNIQUE("data")
);
--> statement-breakpoint
CREATE TABLE "rh_funcionarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"nome_social" text,
	"cpf" text NOT NULL,
	"pis" text,
	"rg" text,
	"nascimento" date,
	"telefone" text,
	"email" text,
	"cep" text,
	"endereco" text,
	"cidade" text,
	"uf" text,
	"cargo" text,
	"departamento" text,
	"tipo_contrato" text DEFAULT 'clt' NOT NULL,
	"salario" integer,
	"ctps" text,
	"matricula_esocial" text,
	"dados_bancarios" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"escala_id" uuid,
	"data_admissao" date NOT NULL,
	"data_demissao" date,
	"motivo_demissao" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"bate_ponto" boolean DEFAULT true NOT NULL,
	"campos_extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rh_locais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"raio_m" integer DEFAULT 150 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rh_ocorrencias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"de" date NOT NULL,
	"ate" date NOT NULL,
	"abona" boolean DEFAULT true NOT NULL,
	"observacao" text,
	"documento_id" uuid,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rh_ponto_empresas" (
	"empresa_id" uuid PRIMARY KEY NOT NULL,
	"ultimo_nsr" integer DEFAULT 0 NOT NULL,
	"ultimo_hash" text
);
--> statement-breakpoint
CREATE TABLE "rh_registros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nsr" integer NOT NULL,
	"tipo" integer NOT NULL,
	"gravado_em" timestamp with time zone NOT NULL,
	"funcionario_id" uuid,
	"cpf" text,
	"marcado_em" timestamp with time zone,
	"coletor" text,
	"online" boolean DEFAULT true NOT NULL,
	"hash" text,
	"dados" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"precisao_m" integer,
	"local_id" uuid,
	"fora_do_local" boolean,
	"foto" text,
	"ip" text,
	"aparelho" text,
	"usuario_id" uuid
);
--> statement-breakpoint
CREATE TABLE "rh_tratamentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"registro_id" uuid,
	"marcado_em" timestamp with time zone,
	"motivo" text NOT NULL,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rh_documentos" ADD CONSTRAINT "rh_documentos_funcionario_id_rh_funcionarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."rh_funcionarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_documentos" ADD CONSTRAINT "rh_documentos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_envios" ADD CONSTRAINT "rh_envios_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_fechamentos" ADD CONSTRAINT "rh_fechamentos_funcionario_id_rh_funcionarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."rh_funcionarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_fechamentos" ADD CONSTRAINT "rh_fechamentos_fechado_por_usuarios_id_fk" FOREIGN KEY ("fechado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_funcionarios" ADD CONSTRAINT "rh_funcionarios_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_funcionarios" ADD CONSTRAINT "rh_funcionarios_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_funcionarios" ADD CONSTRAINT "rh_funcionarios_escala_id_rh_escalas_id_fk" FOREIGN KEY ("escala_id") REFERENCES "public"."rh_escalas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_ocorrencias" ADD CONSTRAINT "rh_ocorrencias_funcionario_id_rh_funcionarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."rh_funcionarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_ocorrencias" ADD CONSTRAINT "rh_ocorrencias_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_ponto_empresas" ADD CONSTRAINT "rh_ponto_empresas_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_registros" ADD CONSTRAINT "rh_registros_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_registros" ADD CONSTRAINT "rh_registros_funcionario_id_rh_funcionarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."rh_funcionarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_registros" ADD CONSTRAINT "rh_registros_local_id_rh_locais_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."rh_locais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_registros" ADD CONSTRAINT "rh_registros_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_tratamentos" ADD CONSTRAINT "rh_tratamentos_funcionario_id_rh_funcionarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."rh_funcionarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_tratamentos" ADD CONSTRAINT "rh_tratamentos_registro_id_rh_registros_id_fk" FOREIGN KEY ("registro_id") REFERENCES "public"."rh_registros"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rh_tratamentos" ADD CONSTRAINT "rh_tratamentos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rh_documentos_func_idx" ON "rh_documentos" USING btree ("funcionario_id","tipo");--> statement-breakpoint
CREATE UNIQUE INDEX "rh_fechamentos_uq" ON "rh_fechamentos" USING btree ("funcionario_id","competencia");--> statement-breakpoint
CREATE UNIQUE INDEX "rh_funcionarios_cpf_idx" ON "rh_funcionarios" USING btree ("cpf");--> statement-breakpoint
CREATE UNIQUE INDEX "rh_funcionarios_usuario_idx" ON "rh_funcionarios" USING btree ("usuario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rh_registros_nsr_idx" ON "rh_registros" USING btree ("empresa_id","nsr");--> statement-breakpoint
CREATE INDEX "rh_registros_func_idx" ON "rh_registros" USING btree ("funcionario_id","marcado_em");--> statement-breakpoint
-- Marcação de ponto é imutável (Portaria 671): o banco recusa alterar ou apagar registros do REP-P.
CREATE OR REPLACE FUNCTION rh_registros_imutaveis() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registros de ponto não podem ser alterados nem apagados. Use um tratamento (inclusão ou desconsideração) com motivo.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rh_registros_imutaveis BEFORE UPDATE OR DELETE ON "rh_registros" FOR EACH ROW EXECUTE FUNCTION rh_registros_imutaveis();
--> statement-breakpoint
-- Grupo de acesso para quem só bate ponto (motoboy, estoquista…): sem nenhum módulo; vê só "Meu ponto".
INSERT INTO "grupos" ("nome", "permissoes") VALUES ('Somente ponto', '{}'::jsonb) ON CONFLICT ("nome") DO NOTHING;
--> statement-breakpoint
-- Horário comercial de exemplo (segunda a sexta 8h–17h48, sábado 8h–12h); pode ser editado ou apagado.
INSERT INTO "rh_escalas" ("nome", "dias") VALUES ('Comercial 44h', '[null,{"entrada":"08:00","saidaIntervalo":"12:00","voltaIntervalo":"13:00","saida":"17:48"},{"entrada":"08:00","saidaIntervalo":"12:00","voltaIntervalo":"13:00","saida":"17:48"},{"entrada":"08:00","saidaIntervalo":"12:00","voltaIntervalo":"13:00","saida":"17:48"},{"entrada":"08:00","saidaIntervalo":"12:00","voltaIntervalo":"13:00","saida":"17:48"},{"entrada":"08:00","saidaIntervalo":"12:00","voltaIntervalo":"13:00","saida":"17:48"},{"entrada":"08:00","saida":"12:00"}]'::jsonb);
