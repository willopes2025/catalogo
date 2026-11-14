ALTER TABLE "categorias" ADD COLUMN "id_jueri" text;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "id_jueri" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "local_trabalho" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "segmento" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "tipo_revendedor" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "meta_mensal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "comissao_pb" integer;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "redes_sociais" text;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "campos_extras" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "ean" text;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "descricao_completa" text;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "tipo_banho" text;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "estoque_maximo" integer;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "observacao" text;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "custos" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "lucro_varejo_pb" integer;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "lucro_atacado_pb" integer;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "fcp_pb" integer;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "imposto_pb" integer;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "medidas" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "marketplaces" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "produtos" ADD COLUMN "campos_extras" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "titulos" ADD COLUMN "id_jueri" text;