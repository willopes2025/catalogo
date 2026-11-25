-- Custom SQL migration file, put your code below! ---- Ata de 25/11: o nome da assistente é "Ária" (estava salvo como "Ari").
UPDATE "configuracoes" SET "valor" = jsonb_set("valor", '{nome}', '"Ária"') WHERE "chave" = 'assistente' AND lower(trim("valor"->>'nome')) IN ('ari', 'aria');
