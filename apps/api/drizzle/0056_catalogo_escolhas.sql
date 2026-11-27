CREATE TABLE "catalogo_escolhas" (
	"pessoa_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogo_escolhas_pessoa_id_produto_id_pk" PRIMARY KEY("pessoa_id","produto_id")
);
--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "catalogo_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalogo_escolhas" ADD CONSTRAINT "catalogo_escolhas_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogo_escolhas" ADD CONSTRAINT "catalogo_escolhas_produto_id_produtos_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE cascade ON UPDATE no action;