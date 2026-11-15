ALTER TABLE "vendas" ADD COLUMN "devolvido" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Devoluções já feitas: valor devolvido = itens devolvidos, na proporção do desconto geral da venda.
UPDATE "vendas" v SET "devolvido" = LEAST(v.total, x.dev) FROM (
  SELECT vi.venda_id,
    round(sum(vi.devolvida::numeric * vi.total / NULLIF(vi.quantidade, 0)) * CASE WHEN sum(vi.total) > 0 THEN max(vv.total)::numeric / sum(vi.total) ELSE 1 END)::int AS dev
  FROM "venda_itens" vi JOIN "vendas" vv ON vv.id = vi.venda_id
  WHERE vi.devolvida > 0 GROUP BY vi.venda_id
) x WHERE x.venda_id = v.id;
