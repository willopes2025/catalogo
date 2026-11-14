import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, asc, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { gerarSlug } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { dataISO, opcional, validar } from '../comum/validacao';
import { cpfValido, soDigitos } from '../comum/documentos';
import { Limitador } from '../comum/limitador';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { EmailService } from '../integracoes/email.service';
import { SegredosService } from '../segredos/segredos.service';
import { candidaturaNotas, candidaturas, pessoas, usuarios } from '../db/schema';

export const ETAPAS = ['nova', 'contato', 'entrevista', 'documentos', 'aprovada', 'recusada'] as const;
const MODELOS = ['consignado', 'revenda', 'afiliado', 'nao_sei'] as const;
const envios = new Limitador(5, 60 * 60_000, 'Muitos cadastros enviados deste aparelho.');

const publicoSchema = z.object({
  nome: z.string().trim().min(5, 'Informe o nome completo').max(150),
  telefone: z.string().trim().transform(soDigitos).refine((t) => t.length >= 10 && t.length <= 11, 'WhatsApp com DDD'),
  email: z.string().trim().email('E-mail inválido').optional().nullable().or(z.literal('').transform(() => null)),
  cpf: z.string().optional().nullable().transform((c) => (c ? soDigitos(c) : null)).refine((c) => !c || cpfValido(c), 'CPF inválido'),
  cidade: z.string().trim().min(2, 'Informe a cidade').max(80),
  uf: z.string().trim().length(2, 'UF').transform((u) => u.toUpperCase()),
  instagram: opcional(80),
  modeloInteresse: z.enum(MODELOS).default('nao_sei'),
  experiencia: opcional(500),
  comoConheceu: opcional(80),
  indicadaPor: opcional(120),
  consentimentoLgpd: z.literal(true, { message: 'É preciso autorizar o contato' }),
  origem: z.record(z.string(), z.string().max(200)).optional(),
  /** Campo invisível no formulário: robôs preenchem, pessoas não. */
  site: z.string().optional(),
});

/** Captação e triagem de candidatas a representante: formulário público, quadro por etapa e aprovação. */
@Controller()
export class CrmController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfiguracoesService,
    private readonly email: EmailService,
    private readonly segredos: SegredosService,
  ) {}

  /** Formulário "Quero ser revendedora" (link para anúncios, Instagram e WhatsApp). */
  @Publico()
  @Post('publico/candidaturas')
  async publico(@Body() body: unknown, @Req() req: Request) {
    envios.usar(req.ip ?? '?');
    if ((body as { site?: string })?.site) return { ok: true }; // robô preencheu o campo invisível: finge que deu certo
    const d = validar(publicoSchema, body);
    const { site: _s, origem, ...dados } = d;
    // Mesma pessoa enviando de novo: atualiza a candidatura aberta em vez de duplicar.
    const [aberta] = await this.db
      .select({ id: candidaturas.id })
      .from(candidaturas)
      .where(and(or(eq(candidaturas.telefone, d.telefone), d.cpf ? eq(candidaturas.cpf, d.cpf) : sql`false`), sql`${candidaturas.etapa} not in ('aprovada','recusada')`));
    if (aberta) {
      const preenchidos = Object.fromEntries(Object.entries(dados).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      await this.db.update(candidaturas).set({ ...preenchidos, atualizadoEm: new Date() }).where(eq(candidaturas.id, aberta.id));
      await this.db.insert(candidaturaNotas).values({ candidaturaId: aberta.id, texto: 'Preencheu o formulário de novo.' });
      return { ok: true };
    }
    const [c] = await this.db.insert(candidaturas).values({ ...dados, origem: { ...(origem ?? {}) } }).returning();
    await this.auditoria.registrar({ acao: 'candidatura', entidade: 'candidatura', entidadeId: c.id, dados: { origem: origem?.utm_source ?? null } });
    const equipe = (await this.config.ler('avisos')).emailsEquipe;
    for (const para of equipe) {
      await this.email
        .enviar(para, `Nova candidata: ${c.nome} (${c.cidade}/${c.uf})`, `Nova candidata a revendedora.\n\n${c.nome}\nWhatsApp: ${c.telefone}\nCidade: ${c.cidade}/${c.uf}\nInteresse: ${c.modeloInteresse}\n\nVeja em ${process.env.PAINEL_URL ?? ''}/crm`)
        .catch(() => undefined);
    }
    return { ok: true };
  }

  @Get('crm/candidaturas')
  @Permissao('crm', 'ver')
  listar(@Query('busca') busca?: string, @Query('responsavelId') responsavelId?: string, @Query('fechadas') fechadas?: string) {
    const f: SQL[] = [];
    if (!fechadas) f.push(sql`(${candidaturas.etapa} not in ('aprovada','recusada') or ${candidaturas.atualizadoEm} > now() - interval '30 days')`);
    if (responsavelId) f.push(eq(candidaturas.responsavelId, responsavelId));
    if (busca?.trim()) {
      const b = `%${busca.trim()}%`;
      const dig = soDigitos(busca);
      f.push(sql`(${candidaturas.nome} ilike ${b} or ${candidaturas.cidade} ilike ${b}${dig.length >= 3 ? sql` or ${candidaturas.telefone} like ${'%' + dig + '%'}` : sql``})`);
    }
    return this.db
      .select({
        id: candidaturas.id,
        numero: candidaturas.numero,
        nome: candidaturas.nome,
        telefone: candidaturas.telefone,
        cidade: candidaturas.cidade,
        uf: candidaturas.uf,
        modeloInteresse: candidaturas.modeloInteresse,
        etapa: candidaturas.etapa,
        origem: candidaturas.origem,
        responsavel: usuarios.nome,
        proximoContato: candidaturas.proximoContato,
        pessoaId: candidaturas.pessoaId,
        criadoEm: candidaturas.criadoEm,
        atualizadoEm: candidaturas.atualizadoEm,
      })
      .from(candidaturas)
      .leftJoin(usuarios, eq(usuarios.id, candidaturas.responsavelId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(desc(candidaturas.criadoEm))
      .limit(500);
  }

  @Get('crm/candidaturas/:id')
  @Permissao('crm', 'ver')
  async obter(@Param('id', ParseUUIDPipe) id: string) {
    const [c] = await this.db.select().from(candidaturas).where(eq(candidaturas.id, id));
    if (!c) throw new NotFoundException('Candidata não encontrada.');
    const notas = await this.db
      .select({ id: candidaturaNotas.id, texto: candidaturaNotas.texto, autor: usuarios.nome, criadoEm: candidaturaNotas.criadoEm })
      .from(candidaturaNotas)
      .leftJoin(usuarios, eq(usuarios.id, candidaturaNotas.usuarioId))
      .where(eq(candidaturaNotas.candidaturaId, id))
      .orderBy(asc(candidaturaNotas.criadoEm));
    // Já é (ou foi) representante? Evita aprovar duas vezes a mesma pessoa.
    const conflitos = await this.db
      .select({ id: pessoas.id, nome: pessoas.nome, status: pessoas.status })
      .from(pessoas)
      .where(and(eq(pessoas.tipo, 'representante'), or(c.cpf ? eq(pessoas.documento, c.cpf) : sql`false`, eq(pessoas.telefone1, c.telefone))));
    return { ...c, notas, conflitos };
  }

  /** Cadastro feito pela equipe (indicação, contato pelo WhatsApp). */
  @Post('crm/candidaturas')
  @Permissao('crm', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(publicoSchema.omit({ consentimentoLgpd: true, site: true }).extend({ consentimentoLgpd: z.boolean().default(false) }), body);
    const [c] = await this.db.insert(candidaturas).values({ ...d, origem: { utm_source: 'equipe', ...(d.origem ?? {}) }, responsavelId: u.id, etapa: 'contato' }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'candidatura', entidadeId: c.id });
    return c;
  }

  @Patch('crm/candidaturas/:id')
  @Permissao('crm', 'editar')
  async mover(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        etapa: z.enum(ETAPAS).optional(),
        responsavelId: z.string().uuid().nullable().optional(),
        proximoContato: dataISO.nullable().optional(),
        motivoRecusa: opcional(300),
        nota: z.string().trim().max(2000).optional(),
      }),
      body,
    );
    const [atual] = await this.db.select().from(candidaturas).where(eq(candidaturas.id, id));
    if (!atual) throw new NotFoundException('Candidata não encontrada.');
    if (d.etapa === 'aprovada') throw new BadRequestException('Para aprovar, use "Aprovar e criar representante".');
    if (atual.etapa === 'aprovada' && d.etapa) throw new BadRequestException('Candidata já aprovada; acompanhe pela ficha da representante.');
    if (d.etapa === 'recusada' && !d.motivoRecusa) throw new BadRequestException('Informe o motivo da recusa.');
    const { nota, ...campos } = d;
    const mudancas = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined));
    if (Object.keys(mudancas).length) await this.db.update(candidaturas).set({ ...mudancas, atualizadoEm: new Date() }).where(eq(candidaturas.id, id));
    const textos = [d.etapa && d.etapa !== atual.etapa ? `Mudou para "${d.etapa}"${d.motivoRecusa ? `: ${d.motivoRecusa}` : ''}.` : null, nota || null].filter(Boolean) as string[];
    for (const texto of textos) await this.db.insert(candidaturaNotas).values({ candidaturaId: id, usuarioId: u.id, texto });
    return { ok: true };
  }

  /** Aprova: cria a representante com o limite inicial das regras e liga a candidatura a ela. */
  @Post('crm/candidaturas/:id/aprovar')
  @Permissao('rede', 'criar')
  async aprovar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ modeloTrabalho: z.enum(['consignado', 'revenda', 'afiliado']) }), body);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(candidaturas).where(eq(candidaturas.id, id)).for('update');
      if (!c) throw new NotFoundException('Candidata não encontrada.');
      if (c.pessoaId) throw new BadRequestException('Candidata já aprovada.');
      if (c.cpf) {
        const [dup] = await tx.select({ id: pessoas.id, nome: pessoas.nome }).from(pessoas).where(and(eq(pessoas.documento, c.cpf), eq(pessoas.tipo, 'representante')));
        if (dup) throw new BadRequestException(`Já existe representante com este CPF: ${dup.nome}.`);
      }
      const regras = await this.config.regras(tx);
      const base = gerarSlug(c.nome) || 'representante';
      const usados = new Set((await tx.select({ s: pessoas.slug }).from(pessoas).where(sql`${pessoas.slug} like ${base + '%'}`)).map((x) => x.s));
      let slug = base;
      for (let i = 2; usados.has(slug); i++) slug = `${base}-${i}`;
      const [p] = await tx
        .insert(pessoas)
        .values({
          tipo: 'representante',
          tipoDocumento: 'cpf',
          documento: c.cpf,
          nome: c.nome,
          telefone1: c.telefone,
          email: c.email,
          cidade: c.cidade,
          uf: c.uf,
          instagram: c.instagram,
          modeloTrabalho: d.modeloTrabalho,
          limiteCredito: regras.limiteInicial,
          status: 'ativo',
          consentimentoLgpd: c.consentimentoLgpd,
          observacaoInterna: [c.experiencia && `Experiência: ${c.experiencia}`, c.indicadaPor && `Indicada por: ${c.indicadaPor}`, `Candidatura nº ${c.numero}`].filter(Boolean).join('\n'),
          slug,
        })
        .returning();
      await tx.update(candidaturas).set({ etapa: 'aprovada', pessoaId: p.id, atualizadoEm: new Date() }).where(eq(candidaturas.id, id));
      await tx.insert(candidaturaNotas).values({ candidaturaId: id, usuarioId: u.id, texto: `Aprovada no modelo ${d.modeloTrabalho}. Representante criada.` });
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'aprovar', entidade: 'candidatura', entidadeId: id, dados: { pessoaId: p.id } }, tx);
      return { pessoaId: p.id };
    });
  }

  /** Números do funil para o topo do quadro. */
  @Get('crm/resumo')
  @Permissao('crm', 'ver')
  async resumo() {
    const r = await this.db.execute<{ etapa: string; n: number }>(sql`select etapa, count(*)::int as n from candidaturas where etapa not in ('aprovada','recusada') or atualizado_em > now() - interval '30 days' group by etapa`);
    const origem = await this.db.execute<{ origem: string; n: number; aprovadas: number }>(sql`
      select coalesce(nullif(origem->>'utm_source',''), 'direto') as origem, count(*)::int as n, count(*) filter (where etapa = 'aprovada')::int as aprovadas
      from candidaturas where criado_em > now() - interval '90 days' group by 1 order by 2 desc`);
    return { porEtapa: Object.fromEntries(r.rows.map((x) => [x.etapa, x.n])), porOrigem: origem.rows };
  }
}
