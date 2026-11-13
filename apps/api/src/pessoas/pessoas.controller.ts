import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { centavos, dataISO, opcional, validar } from '../comum/validacao';
import { cnpjValido, cpfValido, soDigitos } from '../comum/documentos';
import { AuditoriaService } from '../comum/auditoria.service';
import { creditos, documentos, maletas, niveis, pessoas, referencias, titulos } from '../db/schema';
import { gerarSlug } from '@aritana/regras';

const TIPOS = ['representante', 'cliente', 'fornecedor', 'transportadora', 'assistencia'] as const;
type TipoPessoa = (typeof TIPOS)[number];
const moduloDo = (tipo: TipoPessoa) => (tipo === 'representante' ? 'rede' : 'cadastros');

const pessoaSchema = z
  .object({
    tipo: z.enum(TIPOS),
    tipoDocumento: z.enum(['cpf', 'cnpj']).default('cpf'),
    documento: opcional(20),
    nome: z.string().trim().min(2, 'Informe o nome').max(150),
    nomeFantasia: opcional(150),
    rg: opcional(30),
    inscricaoEstadual: opcional(30),
    nascimento: dataISO.optional().nullable(),
    genero: opcional(30),
    estadoCivil: opcional(30),
    profissao: opcional(80),
    telefone1: opcional(20),
    telefone2: opcional(20),
    telefone3: opcional(20),
    email: z.string().trim().email('E-mail inválido').optional().nullable().or(z.literal('').transform(() => null)),
    instagram: opcional(80),
    cep: opcional(10),
    logradouro: opcional(150),
    numero: opcional(20),
    complemento: opcional(80),
    bairro: opcional(80),
    cidade: opcional(80),
    uf: opcional(2),
    modeloTrabalho: z.enum(['consignado', 'revenda', 'afiliado']).optional().nullable(),
    nivelId: z.string().uuid().optional().nullable(),
    liderId: z.string().uuid().optional().nullable(),
    supervisorId: z.string().uuid().optional().nullable(),
    indicadoPorId: z.string().uuid().optional().nullable(),
    praca: opcional(80),
    limiteCredito: centavos.optional(),
    representanteId: z.string().uuid().optional().nullable(),
    consentimentoLgpd: z.boolean().optional(),
    status: z.enum(['triagem', 'ativo', 'inativo', 'recusado']).optional(),
    bloqueado: z.boolean().optional(),
    motivoBloqueio: opcional(300),
    observacao: opcional(2000),
    observacaoInterna: opcional(2000),
    referencias: z.array(z.object({ nome: z.string().min(1), telefone: opcional(20), relacao: opcional(50) })).optional(),
  })
  .superRefine((p, ctx) => {
    if (!p.documento) return;
    const ok = p.tipoDocumento === 'cpf' ? cpfValido(p.documento) : cnpjValido(p.documento);
    if (!ok) ctx.addIssue({ code: 'custom', path: ['documento'], message: `${p.tipoDocumento.toUpperCase()} inválido` });
  });

@Controller('pessoas')
export class PessoasController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  private exigir(u: UsuarioLogado, tipo: TipoPessoa, acao: string) {
    if (!temPermissao(u.permissoes, moduloDo(tipo), acao)) throw new ForbiddenException('Você não tem permissão para esta ação.');
  }

  @Get()
  async listar(
    @Usuario() u: UsuarioLogado,
    @Query('tipo') tipoQ = 'representante',
    @Query('busca') busca?: string,
    @Query('status') status?: string,
    @Query('liderId') liderId?: string,
    @Query('pagina') paginaQ = '1',
  ) {
    const tipo = (TIPOS as readonly string[]).includes(tipoQ) ? (tipoQ as TipoPessoa) : 'representante';
    this.exigir(u, tipo, 'ver');
    const pagina = Math.max(1, Number(paginaQ) || 1);
    const porPagina = 50;
    const lider = alias(pessoas, 'lider');
    const filtros: SQL[] = [eq(pessoas.tipo, tipo)];
    if (status) filtros.push(eq(pessoas.status, status as 'ativo'));
    if (liderId) filtros.push(eq(pessoas.liderId, liderId));
    if (busca?.trim()) {
      const b = `%${busca.trim()}%`;
      const dig = soDigitos(busca);
      const ors = [ilike(pessoas.nome, b), ilike(pessoas.cidade, b), ilike(pessoas.nomeFantasia, b)];
      if (dig.length >= 3) ors.push(ilike(pessoas.documento, `%${dig}%`), ilike(pessoas.telefone1, `%${dig}%`));
      filtros.push(or(...ors)!);
    }
    const where = and(...filtros);

    const linhas = await this.db
      .select({
        id: pessoas.id,
        nome: pessoas.nome,
        nomeFantasia: pessoas.nomeFantasia,
        documento: pessoas.documento,
        telefone1: pessoas.telefone1,
        cidade: pessoas.cidade,
        uf: pessoas.uf,
        status: pessoas.status,
        modeloTrabalho: pessoas.modeloTrabalho,
        limiteCredito: pessoas.limiteCredito,
        bloqueado: pessoas.bloqueado,
        nivel: niveis.nome,
        lider: lider.nome,
        maletaAberta: sql<number>`(select count(*)::int from ${maletas} m where m.representante_id = ${pessoas.id} and m.status = 'aberta')`,
        emAberto: sql<number>`(select coalesce(sum(t.valor),0)::int from ${titulos} t where t.pessoa_id = ${pessoas.id} and t.status = 'aberto' and t.tipo = 'receber')`,
        vencido: sql<number>`(select coalesce(sum(t.valor),0)::int from ${titulos} t where t.pessoa_id = ${pessoas.id} and t.status = 'aberto' and t.tipo = 'receber' and t.vencimento < current_date)`,
      })
      .from(pessoas)
      .leftJoin(niveis, eq(niveis.id, pessoas.nivelId))
      .leftJoin(lider, eq(lider.id, pessoas.liderId))
      .where(where)
      .orderBy(asc(pessoas.nome))
      .limit(porPagina)
      .offset((pagina - 1) * porPagina);

    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(pessoas).where(where);
    return { itens: linhas, total, pagina, porPagina };
  }

  @Get(':id')
  async obter(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const lider = alias(pessoas, 'lider');
    const [p] = await this.db
      .select({ pessoa: pessoas, nivel: niveis.nome, lider: lider.nome })
      .from(pessoas)
      .leftJoin(niveis, eq(niveis.id, pessoas.nivelId))
      .leftJoin(lider, eq(lider.id, pessoas.liderId))
      .where(eq(pessoas.id, id));
    if (!p) throw new NotFoundException('Cadastro não encontrado.');
    this.exigir(u, p.pessoa.tipo, 'ver');

    const [refs, ms, ts, [cred], rede] = await Promise.all([
      this.db.select().from(referencias).where(eq(referencias.pessoaId, id)),
      this.db
        .select({ id: maletas.id, numero: maletas.numero, status: maletas.status, dataRetirada: maletas.dataRetirada, dataLimite: maletas.dataLimite })
        .from(maletas)
        .where(eq(maletas.representanteId, id))
        .orderBy(desc(maletas.criadoEm))
        .limit(20),
      this.db.select().from(titulos).where(eq(titulos.pessoaId, id)).orderBy(desc(titulos.vencimento)).limit(30),
      this.db.select({ saldo: sql<number>`coalesce(sum(${creditos.valor}),0)::int` }).from(creditos).where(eq(creditos.pessoaId, id)),
      this.db.select({ id: pessoas.id, nome: pessoas.nome, status: pessoas.status }).from(pessoas).where(eq(pessoas.liderId, id)),
    ]);
    const docs = await this.db
      .select({ id: documentos.id, tipo: documentos.tipo, titulo: documentos.titulo, status: documentos.status, token: documentos.token, criadoEm: documentos.criadoEm, visualizadoEm: documentos.visualizadoEm, assinadoEm: documentos.assinadoEm, maletaId: documentos.maletaId })
      .from(documentos)
      .where(eq(documentos.pessoaId, id))
      .orderBy(desc(documentos.criadoEm));
    return { ...p.pessoa, nivel: p.nivel, lider: p.lider, referencias: refs, maletas: ms, titulos: ts, saldoCredito: cred.saldo, rede, documentos: docs };
  }

  @Post()
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const { referencias: refs, ...dados } = validar(pessoaSchema, body);
    this.exigir(u, dados.tipo, 'criar');
    if (dados.documento) dados.documento = soDigitos(dados.documento);
    if (dados.documento) {
      const [dup] = await this.db
        .select({ id: pessoas.id, nome: pessoas.nome })
        .from(pessoas)
        .where(and(eq(pessoas.documento, dados.documento), eq(pessoas.tipo, dados.tipo)));
      if (dup) throw new ForbiddenException({ mensagem: `Já existe um cadastro com esse documento: ${dup.nome}.`, id: dup.id });
    }
    return this.db.transaction(async (tx) => {
      const slug = dados.tipo === 'representante' ? await this.slugLivre(tx, dados.nome) : null;
      const [p] = await tx.insert(pessoas).values({ ...dados, slug }).returning();
      if (refs?.length) await tx.insert(referencias).values(refs.map((r) => ({ ...r, pessoaId: p.id })));
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'pessoa', entidadeId: p.id, dados: { tipo: p.tipo } }, tx);
      return p;
    });
  }

  @Patch(':id')
  async atualizar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(pessoas).where(eq(pessoas.id, id));
    if (!atual) throw new NotFoundException('Cadastro não encontrado.');
    this.exigir(u, atual.tipo, 'editar');
    const { referencias: refs, ...dados } = validar(pessoaSchema, { ...atual, ...(body as object), tipo: atual.tipo });
    if (dados.documento) dados.documento = soDigitos(dados.documento);
    if (dados.liderId === id) throw new ForbiddenException('A representante não pode ser líder dela mesma.');
    // Evita ciclo na rede (A líder de B e B líder de A).
    for (let l = dados.liderId ?? null, passos = 0; l && passos < 50; passos++) {
      if (l === id) throw new ForbiddenException('Essa liderança criaria um ciclo na rede.');
      const [x] = await this.db.select({ liderId: pessoas.liderId }).from(pessoas).where(eq(pessoas.id, l));
      l = x?.liderId ?? null;
    }
    if (dados.documento && dados.documento !== atual.documento) {
      const [dup] = await this.db.select({ id: pessoas.id, nome: pessoas.nome }).from(pessoas).where(and(eq(pessoas.documento, dados.documento), eq(pessoas.tipo, atual.tipo), sql`${pessoas.id} <> ${id}`));
      if (dup) throw new ForbiddenException({ mensagem: `Já existe um cadastro com esse documento: ${dup.nome}.`, id: dup.id });
    }
    return this.db.transaction(async (tx) => {
      const slug = atual.tipo === 'representante' && !atual.slug ? await this.slugLivre(tx, dados.nome) : atual.slug;
      const [p] = await tx.update(pessoas).set({ ...dados, slug, atualizadoEm: new Date() }).where(eq(pessoas.id, id)).returning();
      if (refs) {
        await tx.delete(referencias).where(eq(referencias.pessoaId, id));
        if (refs.length) await tx.insert(referencias).values(refs.map((r) => ({ ...r, pessoaId: id })));
      }
      const mudou = Object.keys(dados).filter((k) => JSON.stringify((atual as Record<string, unknown>)[k]) !== JSON.stringify((dados as Record<string, unknown>)[k]));
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'pessoa', entidadeId: id, dados: { campos: mudou } }, tx);
      return p;
    });
  }

  /** Endereço do catálogo: nome da representante; se já existir, acrescenta um número. */
  private async slugLivre(tx: Pick<Db, 'select'>, nome: string) {
    const base = gerarSlug(nome) || 'representante';
    const usados = await tx.select({ slug: pessoas.slug }).from(pessoas).where(ilike(pessoas.slug, `${base}%`));
    const set = new Set(usados.map((u) => u.slug));
    if (!set.has(base)) return base;
    for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}
