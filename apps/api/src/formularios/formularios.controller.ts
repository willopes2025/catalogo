import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PAPEIS, TIPOS_CAMPO, calcularNps, gerarSlug, validarRespostas, type CampoFormulario } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { opcional, validar } from '../comum/validacao';
import { Limitador } from '../comum/limitador';
import { AuditoriaService } from '../comum/auditoria.service';
import { candidaturaNotas, candidaturas, formularioRespostas, formularios, pessoas } from '../db/schema';
import { MODELOS_FORMULARIO } from './modelos';

const envios = new Limitador(20, 60 * 60_000, 'Muitas respostas enviadas deste aparelho.');

const campoSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Identificador do campo inválido'),
    tipo: z.enum(TIPOS_CAMPO),
    rotulo: z.string().trim().min(1, 'Escreva a pergunta').max(300),
    obrigatorio: z.boolean().default(false),
    opcoes: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
    ajuda: opcional(300),
    papel: z.enum(PAPEIS).nullable().optional(),
  })
  .refine((c) => !['escolha', 'multipla'].includes(c.tipo) || (c.opcoes?.length ?? 0) >= 2, { message: 'Perguntas de escolha precisam de ao menos 2 opções', path: ['opcoes'] });

const formSchema = z
  .object({
    titulo: z.string().trim().min(3).max(150),
    descricao: opcional(1000),
    campos: z.array(campoSchema).min(1, 'Coloque ao menos uma pergunta').max(40),
    acao: z.enum(['nenhuma', 'cliente', 'candidata']).default('nenhuma'),
    mensagemFinal: opcional(300),
    consentimento: opcional(500),
    ativo: z.boolean().optional(),
    slug: z.string().regex(/^[a-z0-9-]{3,60}$/, 'Endereço: só letras minúsculas, números e hífen').optional(),
  })
  .refine((f) => new Set(f.campos.map((c) => c.id)).size === f.campos.length, { message: 'Há perguntas com o mesmo identificador', path: ['campos'] })
  .refine((f) => f.acao === 'nenhuma' || (f.campos.some((c) => c.papel === 'nome' && c.obrigatorio) && f.campos.some((c) => c.papel === 'telefone' && c.obrigatorio)), {
    message: 'Para cadastrar cliente ou candidata, marque uma pergunta obrigatória como "nome" e outra como "telefone"',
    path: ['acao'],
  });

/** Formulários montados pela equipe: pesquisa de satisfação, cadastro de cliente, inscrição em evento… */
@Controller()
export class FormulariosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  private async slugLivre(base: string, id?: string) {
    const raiz = (gerarSlug(base) || 'formulario').slice(0, 50);
    let slug = raiz;
    for (let i = 2; ; i++) {
      const [x] = await this.db.select({ id: formularios.id }).from(formularios).where(eq(formularios.slug, slug));
      if (!x || x.id === id) return slug;
      slug = `${raiz}-${i}`;
    }
  }

  @Get('formularios/modelos')
  @Permissao('formularios', 'ver')
  modelos() {
    return MODELOS_FORMULARIO;
  }

  @Get('formularios')
  @Permissao('formularios', 'ver')
  listar() {
    return this.db
      .select({
        id: formularios.id,
        slug: formularios.slug,
        titulo: formularios.titulo,
        acao: formularios.acao,
        ativo: formularios.ativo,
        criadoEm: formularios.criadoEm,
        respostas: sql<number>`(select count(*)::int from formulario_respostas r where r.formulario_id = ${formularios.id})`,
        ultima: sql<string | null>`(select max(r.criado_em) from formulario_respostas r where r.formulario_id = ${formularios.id})`,
      })
      .from(formularios)
      .orderBy(desc(formularios.criadoEm));
  }

  @Get('formularios/:id')
  @Permissao('formularios', 'ver')
  async obter(@Param('id', ParseUUIDPipe) id: string) {
    const [f] = await this.db.select().from(formularios).where(eq(formularios.id, id));
    if (!f) throw new NotFoundException('Formulário não encontrado.');
    return f;
  }

  @Post('formularios')
  @Permissao('formularios', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(formSchema, body);
    const slug = d.slug ? await this.slugLivre(d.slug) : await this.slugLivre(d.titulo);
    const [f] = await this.db.insert(formularios).values({ ...d, slug }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'formulario', entidadeId: f.id });
    return f;
  }

  @Patch('formularios/:id')
  @Permissao('formularios', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(formularios).where(eq(formularios.id, id));
    if (!atual) throw new NotFoundException('Formulário não encontrado.');
    const d = validar(formSchema, { ...atual, descricao: atual.descricao ?? null, mensagemFinal: atual.mensagemFinal ?? null, consentimento: atual.consentimento ?? null, ...(body as object) });
    const slug = d.slug && d.slug !== atual.slug ? await this.slugLivre(d.slug, id) : atual.slug;
    const [f] = await this.db.update(formularios).set({ ...d, slug, atualizadoEm: new Date() }).where(eq(formularios.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'formulario', entidadeId: id });
    return f;
  }

  /** Respostas com o resumo das perguntas de escolha e de nota (NPS). */
  @Get('formularios/:id/respostas')
  @Permissao('formularios', 'ver')
  async respostas(@Param('id', ParseUUIDPipe) id: string, @Query('de') de?: string, @Query('ate') ate?: string) {
    const f = await this.obter(id);
    const filtro = [eq(formularioRespostas.formularioId, id)];
    if (de && /^\d{4}-\d{2}-\d{2}$/.test(de)) filtro.push(sql`${formularioRespostas.criadoEm} >= ${de}::date`);
    if (ate && /^\d{4}-\d{2}-\d{2}$/.test(ate)) filtro.push(sql`${formularioRespostas.criadoEm} < ${ate}::date + 1`);
    const linhas = await this.db.select().from(formularioRespostas).where(and(...filtro)).orderBy(desc(formularioRespostas.criadoEm)).limit(5000);
    const resumo = f.campos
      .filter((c) => ['escolha', 'multipla', 'nota'].includes(c.tipo))
      .map((c) => {
        const vals = linhas.map((l) => l.respostas[c.id]).filter((v) => v !== null && v !== undefined);
        if (c.tipo === 'nota') return { campo: c.id, rotulo: c.rotulo, tipo: c.tipo, respostas: vals.length, media: vals.length ? Math.round((vals.reduce((a: number, b) => a + Number(b), 0) / vals.length) * 10) / 10 : null, ...calcularNps(vals.map(Number)) };
        const contagem: Record<string, number> = Object.fromEntries((c.opcoes ?? []).map((o) => [o, 0]));
        for (const v of vals) for (const o of Array.isArray(v) ? v : [v]) contagem[String(o)] = (contagem[String(o)] ?? 0) + 1;
        return { campo: c.id, rotulo: c.rotulo, tipo: c.tipo, respostas: vals.length, contagem };
      });
    return { formulario: f, total: linhas.length, resumo, linhas };
  }

  // ───── Público ─────

  @Publico()
  @Get('publico/formularios/:slug')
  async publico(@Param('slug') slug: string) {
    const [f] = await this.db.select().from(formularios).where(and(eq(formularios.slug, slug), eq(formularios.ativo, true)));
    if (!f) throw new NotFoundException('Formulário não encontrado ou encerrado.');
    const { id: _i, acao: _a, criadoEm: _c, atualizadoEm: _u, ...publico } = f;
    return publico;
  }

  @Publico()
  @Post('publico/formularios/:slug')
  async responder(@Param('slug') slug: string, @Body() body: unknown, @Req() req: Request) {
    envios.usar(req.ip ?? '?');
    const corpo = (body ?? {}) as { respostas?: Record<string, unknown>; consentimento?: boolean; origem?: Record<string, string>; site?: string };
    if (corpo.site) return { ok: true }; // robô preencheu o campo invisível
    const [f] = await this.db.select().from(formularios).where(and(eq(formularios.slug, slug), eq(formularios.ativo, true)));
    if (!f) throw new NotFoundException('Formulário não encontrado ou encerrado.');
    if (f.consentimento && corpo.consentimento !== true) throw new BadRequestException({ mensagem: 'É preciso marcar a autorização para enviar.', campos: { consentimento: 'Obrigatório' } });
    const r = validarRespostas(f.campos, corpo.respostas ?? {});
    if (!r.ok) throw new BadRequestException({ mensagem: 'Confira as respostas destacadas.', campos: r.erros });
    const origem = Object.fromEntries(Object.entries(corpo.origem ?? {}).filter(([k, v]) => /^(utm_[a-z]+|ref|pagina)$/.test(k) && typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 200)]));
    const porPapel = (p: string) => {
      const c = f.campos.find((x) => x.papel === p);
      const v = c ? r.valores[c.id] : null;
      return typeof v === 'string' && v ? v : null;
    };

    return this.db.transaction(async (tx) => {
      let pessoaId: string | null = null;
      let candidaturaId: string | null = null;
      const nome = porPapel('nome');
      const telefone = porPapel('telefone');
      if (f.acao === 'cliente' && nome && telefone) {
        const cpf = porPapel('cpf');
        const [existe] = await tx
          .select({ id: pessoas.id })
          .from(pessoas)
          .where(and(eq(pessoas.tipo, 'cliente'), or(eq(pessoas.telefone1, telefone), cpf ? eq(pessoas.documento, cpf) : sql`false`)))
          .limit(1);
        const dados = Object.fromEntries(Object.entries({ email: porPapel('email'), cidade: porPapel('cidade'), uf: porPapel('uf')?.toUpperCase().slice(0, 2) ?? null }).filter(([, v]) => v));
        if (existe) {
          await tx.update(pessoas).set({ ...dados, consentimentoLgpd: !!f.consentimento || undefined }).where(eq(pessoas.id, existe.id));
          pessoaId = existe.id;
        } else {
          const [p] = await tx
            .insert(pessoas)
            .values({ tipo: 'cliente', tipoDocumento: 'cpf', documento: cpf, nome, telefone1: telefone, ...dados, consentimentoLgpd: !!f.consentimento, observacaoInterna: `Cadastro pelo formulário "${f.titulo}"` })
            .returning({ id: pessoas.id });
          pessoaId = p.id;
        }
      }
      if (f.acao === 'candidata' && nome && telefone) {
        const [aberta] = await tx.select({ id: candidaturas.id }).from(candidaturas).where(and(eq(candidaturas.telefone, telefone), sql`${candidaturas.etapa} not in ('aprovada','recusada')`));
        if (aberta) candidaturaId = aberta.id;
        else {
          const [c] = await tx
            .insert(candidaturas)
            .values({ nome, telefone, email: porPapel('email'), cpf: porPapel('cpf'), cidade: porPapel('cidade'), uf: porPapel('uf')?.toUpperCase().slice(0, 2) ?? null, origem: { ...origem, formulario: f.slug }, consentimentoLgpd: !!f.consentimento })
            .returning({ id: candidaturas.id });
          candidaturaId = c.id;
        }
        await tx.insert(candidaturaNotas).values({ candidaturaId, texto: `Respondeu o formulário "${f.titulo}".` });
      }
      await tx.insert(formularioRespostas).values({ formularioId: f.id, respostas: r.valores, origem, pessoaId, candidaturaId });
      return { ok: true, mensagem: f.mensagemFinal || 'Resposta enviada. Obrigada!' };
    });
  }
}

export type { CampoFormulario };
