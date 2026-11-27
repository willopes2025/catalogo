-- Busca de nomes sem acento e com erro de digitação (trigramas).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION busca_norm(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT translate(lower(coalesce(t, '')), 'áàâãäåéèêëíìîïóòôõöúùûüçñý', 'aaaaaaeeeeiiiiooooouuuucny') $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pessoas_nome_busca_idx ON pessoas USING gin (busca_norm(nome) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crm_contatos_nome_busca_idx ON crm_contatos USING gin (busca_norm(nome) gin_trgm_ops);
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
--> statement-breakpoint
-- Grafia aproximada do português: Luíza = Luisa, Sheyla = Sheila, Vanessa = Vaneça, Thaís = Tais, Mattos = Matos.
CREATE OR REPLACE FUNCTION busca_fon(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT regexp_replace(regexp_replace(regexp_replace(translate(regexp_replace(regexp_replace(
         translate(lower(coalesce(t, '')), 'áàâãäåéèêëíìîïóòôõöúùûüñýç', 'aaaaaaeeeeiiiiooooouuuunys'),
         'ph', 'f', 'g'), 'c([eiy])', 's\1', 'g'), 'yzwk', 'isvc'), '([^cln]|^)h', '\1', 'g'), '([a-z])\1+', '\1', 'g'), '\s+', ' ', 'g') $$;
