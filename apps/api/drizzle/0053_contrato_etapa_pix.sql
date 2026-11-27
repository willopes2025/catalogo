CREATE TABLE "pix_recebidos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origem" text NOT NULL,
	"externo_id" text NOT NULL,
	"data" date NOT NULL,
	"valor" integer NOT NULL,
	"pagador_nome" text,
	"pagador_documento" text,
	"descricao" text,
	"conta_id" uuid,
	"pessoa_id" uuid,
	"status" text DEFAULT 'pendente' NOT NULL,
	"titulo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comprovante_id" uuid,
	"resolvido_por" uuid,
	"resolvido_em" timestamp with time zone,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "contrato_id" uuid;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "etapa" text DEFAULT 'criada' NOT NULL;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "etapa_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pix_recebidos" ADD CONSTRAINT "pix_recebidos_conta_id_contas_id_fk" FOREIGN KEY ("conta_id") REFERENCES "public"."contas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pix_recebidos" ADD CONSTRAINT "pix_recebidos_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pix_recebidos" ADD CONSTRAINT "pix_recebidos_comprovante_id_cobranca_comprovantes_id_fk" FOREIGN KEY ("comprovante_id") REFERENCES "public"."cobranca_comprovantes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pix_recebidos" ADD CONSTRAINT "pix_recebidos_resolvido_por_usuarios_id_fk" FOREIGN KEY ("resolvido_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pix_recebidos_origem_uq" ON "pix_recebidos" USING btree ("origem","externo_id");--> statement-breakpoint
CREATE INDEX "pix_recebidos_status_idx" ON "pix_recebidos" USING btree ("status","data");--> statement-breakpoint
-- Maletas que já existiam: ligadas ao contrato mais recente da consultora (assinado primeiro).
UPDATE "maletas" m SET "contrato_id" = (
  SELECT d."id" FROM "documentos" d
  WHERE d."pessoa_id" = m."representante_id" AND d."tipo" = 'contrato' AND d."status" IN ('assinado', 'pendente')
  ORDER BY (d."status" = 'assinado') DESC, d."criado_em" DESC LIMIT 1
) WHERE m."contrato_id" IS NULL;
