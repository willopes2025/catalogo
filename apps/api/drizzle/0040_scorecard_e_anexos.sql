CREATE TABLE "bsc_avaliacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"mes" text NOT NULL,
	"status" text DEFAULT 'aberta' NOT NULL,
	"nota_indicadores" double precision,
	"ajuste" double precision,
	"nota" double precision,
	"percentual_bonus" double precision,
	"bonus" integer,
	"observacao" text,
	"avaliador_id" uuid,
	"fechada_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bsc_indicadores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"perspectiva" text DEFAULT 'processos' NOT NULL,
	"fonte" text DEFAULT 'manual' NOT NULL,
	"unidade" text DEFAULT 'numero' NOT NULL,
	"meta" double precision NOT NULL,
	"sentido" text DEFAULT 'maior' NOT NULL,
	"peso" integer DEFAULT 1 NOT NULL,
	"grupo_id" uuid,
	"usuario_id" uuid,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bsc_ocorrencias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"data" date NOT NULL,
	"tipo" text NOT NULL,
	"pontos" double precision NOT NULL,
	"descricao" text NOT NULL,
	"registrado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bsc_resultados" (
	"avaliacao_id" uuid NOT NULL,
	"indicador_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"perspectiva" text NOT NULL,
	"unidade" text NOT NULL,
	"meta" double precision NOT NULL,
	"sentido" text NOT NULL,
	"peso" integer NOT NULL,
	"resultado" double precision,
	"nota" double precision,
	"comentario" text,
	CONSTRAINT "bsc_resultados_avaliacao_id_indicador_id_pk" PRIMARY KEY("avaliacao_id","indicador_id")
);
--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ALTER COLUMN "texto" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ADD COLUMN "anexo" text;--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ADD COLUMN "anexo_nome" text;--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ADD COLUMN "anexo_mime" text;--> statement-breakpoint
ALTER TABLE "mesa_mensagens" ADD COLUMN "anexo_tamanho" integer;--> statement-breakpoint
ALTER TABLE "bsc_avaliacoes" ADD CONSTRAINT "bsc_avaliacoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_avaliacoes" ADD CONSTRAINT "bsc_avaliacoes_avaliador_id_usuarios_id_fk" FOREIGN KEY ("avaliador_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_indicadores" ADD CONSTRAINT "bsc_indicadores_grupo_id_grupos_id_fk" FOREIGN KEY ("grupo_id") REFERENCES "public"."grupos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_indicadores" ADD CONSTRAINT "bsc_indicadores_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_ocorrencias" ADD CONSTRAINT "bsc_ocorrencias_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_ocorrencias" ADD CONSTRAINT "bsc_ocorrencias_registrado_por_usuarios_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_resultados" ADD CONSTRAINT "bsc_resultados_avaliacao_id_bsc_avaliacoes_id_fk" FOREIGN KEY ("avaliacao_id") REFERENCES "public"."bsc_avaliacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bsc_avaliacoes_pessoa_mes_idx" ON "bsc_avaliacoes" USING btree ("usuario_id","mes");--> statement-breakpoint
CREATE INDEX "bsc_ocorrencias_pessoa_idx" ON "bsc_ocorrencias" USING btree ("usuario_id","data");--> statement-breakpoint
-- Quem avalia a equipe: a gerência (a diretoria já tem tudo).
UPDATE "grupos" SET "permissoes" = "permissoes" || '{"scorecard": ["ver", "criar", "editar", "exportar"]}'::jsonb WHERE "nome" ILIKE 'Gerência%' AND NOT "permissoes" ? 'scorecard';
--> statement-breakpoint
-- Modelo do aditivo de cobrança (provisório, para o jurídico revisar), se ainda não houver um.
INSERT INTO "modelos_documento" ("tipo", "modelo_trabalho", "titulo", "conteudo")
SELECT 'aditivo', 'consignado', 'Aditivo: serviço de cobrança · {{nome}}', $aditivo$MODELO PROVISÓRIO — revisar com o jurídico da Aritana antes de usar.

TERMO ADITIVO AO CONTRATO ESTIMATÓRIO PARA VENDAS EM CONSIGNAÇÃO COM RESERVA DE DOMÍNIO
SERVIÇO DE COBRANÇA DAS VENDAS A PRAZO DA CONSIGNATÁRIA

{{empresa_nome}}, inscrita no CNPJ {{empresa_cnpj}}, com sede na {{empresa_endereco}}, doravante denominada CONSIGNANTE.

{{nome}}, {{estado_civil}}, {{profissao}}, inscrita no CPF sob o nº {{cpf}}, domiciliada à {{endereco}}, {{cidade}}/{{uf}}, CEP: {{cep}}, doravante denominada CONSIGNATÁRIA.

As partes, já vinculadas pelo Contrato Estimatório para Vendas em Consignação com Reserva de Domínio, resolvem firmar o presente Termo Aditivo, que se regerá pelas cláusulas a seguir.

DO OBJETO
Cláusula 1ª. Por este aditivo, a CONSIGNATÁRIA adere, de forma facultativa, ao serviço de cobrança oferecido pela CONSIGNANTE, pelo qual a CONSIGNANTE poderá emitir boletos e cobranças Pix, enviar lembretes de vencimento e receber os valores das vendas a prazo que a CONSIGNATÁRIA fizer às suas clientes e indicar expressamente para cobrança.
Parágrafo único. Somente as vendas indicadas pela CONSIGNATÁRIA, uma a uma, pelo sistema ou por escrito, entram no serviço. As demais vendas continuam sob a responsabilidade exclusiva da CONSIGNATÁRIA.

DA ALTERAÇÃO DA CLÁUSULA 10ª
Cláusula 2ª. A Cláusula 10ª do contrato passa a vigorar acrescida do seguinte parágrafo: "Parágrafo único. Fica a CONSIGNANTE autorizada a contatar a cliente da CONSIGNATÁRIA exclusivamente para a cobrança das vendas indicadas no serviço de cobrança, pelos meios informados pela CONSIGNATÁRIA, sendo vedado à CONSIGNANTE oferecer produtos, captar ou transferir essa cliente para outra consignatária ou para a loja."

DOS DADOS DAS CLIENTES
Cláusula 3ª. Ao indicar uma venda para cobrança, a CONSIGNATÁRIA informará nome, CPF, telefone e, quando houver, e-mail da cliente, o valor, as parcelas e os vencimentos, e declara que informou a cliente sobre o compartilhamento desses dados com a CONSIGNANTE para essa finalidade, respondendo pela veracidade das informações.
Parágrafo único. A CONSIGNANTE usará esses dados somente para a cobrança, na forma da Lei Geral de Proteção de Dados (Lei nº 13.709/2018), e os eliminará quando não forem mais necessários, ressalvadas as obrigações legais de guarda.

DA FORMA DA COBRANÇA
Cláusula 4ª. A cobrança será amigável: emissão de boleto ou Pix, lembretes antes e depois do vencimento e negociação de nova data dentro dos limites autorizados pela CONSIGNATÁRIA.
Parágrafo único. Protesto, negativação em órgãos de proteção ao crédito ou cobrança judicial da cliente somente serão feitos com autorização expressa e por escrito da CONSIGNATÁRIA para cada débito, correndo por conta dela as despesas dessas medidas.

DOS VALORES RECEBIDOS
Cláusula 5ª. Os valores pagos pela cliente serão creditados à CONSIGNATÁRIA no acerto seguinte, abatidos do valor devido por ela à CONSIGNANTE ou repassados por transferência ou Pix, descontada a taxa do serviço vigente, informada por escrito à CONSIGNATÁRIA antes da adesão e a cada alteração.
Parágrafo único. A CONSIGNANTE prestará contas, pelo sistema, de cada cobrança emitida, paga, vencida ou cancelada.

DO RISCO DO CRÉDITO
Cláusula 6ª. O serviço de cobrança não transfere à CONSIGNANTE o risco da venda: a inadimplência da cliente não altera as obrigações da CONSIGNATÁRIA previstas no contrato, inclusive as da Cláusula 6ª, e o valor não recebido continua devido pela CONSIGNATÁRIA nos prazos do acerto.

DA VIGÊNCIA E DO CANCELAMENTO
Cláusula 7ª. Este aditivo vale enquanto vigorar o contrato e pode ser cancelado por qualquer das partes, a qualquer tempo, mediante aviso por escrito. As cobranças já emitidas seguem até o pagamento, o cancelamento pela CONSIGNATÁRIA ou a devolução do débito a ela.

DAS DISPOSIÇÕES FINAIS
Cláusula 8ª. Permanecem inalteradas e em pleno vigor todas as demais cláusulas do contrato que não conflitarem com este aditivo.

{{empresa_cidade}}, {{data_extenso}}.

CONSIGNANTE: {{empresa_nome}}

CONSIGNATÁRIA: {{nome}}$aditivo$
WHERE NOT EXISTS (SELECT 1 FROM "modelos_documento" WHERE "tipo" = 'aditivo');
