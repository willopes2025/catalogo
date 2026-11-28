ALTER TABLE "maletas" ADD COLUMN "prebaixa_cobranca_id" text;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "prebaixa_url" text;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "prebaixa_valor" integer;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "prebaixa_vencimento" date;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "prebaixa_boleto_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maletas" ADD COLUMN "prebaixa_paga_em" date;