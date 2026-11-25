CREATE TABLE "maleta_solicitacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"maleta_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"dados" jsonb NOT NULL,
	"motivo" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"pedido_por" uuid,
	"decidido_por" uuid,
	"decidido_em" timestamp with time zone,
	"observacao_decisao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maleta_solicitacoes" ADD CONSTRAINT "maleta_solicitacoes_maleta_id_maletas_id_fk" FOREIGN KEY ("maleta_id") REFERENCES "public"."maletas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maleta_solicitacoes" ADD CONSTRAINT "maleta_solicitacoes_pedido_por_usuarios_id_fk" FOREIGN KEY ("pedido_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maleta_solicitacoes" ADD CONSTRAINT "maleta_solicitacoes_decidido_por_usuarios_id_fk" FOREIGN KEY ("decidido_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maleta_solicitacoes_idx" ON "maleta_solicitacoes" USING btree ("status","maleta_id");--> statement-breakpoint
-- Maletas que vieram abertas do Jueri ficam com o número do pedido de lá (quando o número está livre).
UPDATE "maletas" m SET "numero" = (substring(m."observacao_interna" from 'Pedido nº ([0-9]{1,9}) no Jueri'))::int
WHERE m."id_jueri" LIKE 'ped:%' AND m."observacao_interna" ~ 'Pedido nº [0-9]{1,9} no Jueri'
  AND NOT EXISTS (SELECT 1 FROM "maletas" o WHERE o."id" <> m."id" AND o."numero" = (substring(m."observacao_interna" from 'Pedido nº ([0-9]{1,9}) no Jueri'))::int);
--> statement-breakpoint
UPDATE "locais_estoque" l SET "nome" = regexp_replace(l."nome", '^Maleta nº [0-9]+', 'Maleta nº ' || m."numero") FROM "maletas" m WHERE m."local_id" = l."id" AND l."nome" ~ '^Maleta nº [0-9]+';
--> statement-breakpoint
-- A numeração das maletas novas continua depois do maior pedido do Jueri.
WITH x AS (SELECT GREATEST(
  (SELECT COALESCE(MAX("numero"), 0) FROM "maletas"),
  (SELECT COALESCE(MAX("numero"::bigint), 0) FROM "jueri_historico" WHERE "numero" ~ '^[0-9]{1,9}$')) AS maior)
SELECT setval(pg_get_serial_sequence('maletas', 'numero'), GREATEST(maior, 1), maior > 0) FROM x;
