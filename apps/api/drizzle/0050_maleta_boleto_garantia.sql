ALTER TABLE "maletas" ADD COLUMN "garantia_cobranca_id" text;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "garantia_url" text;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "garantia_linha" text;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "garantia_valor" integer;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "garantia_vencimento" date;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "garantia_paga_em" date;