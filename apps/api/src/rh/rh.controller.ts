import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, contemPermissoes, invalidarSessoes, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { cpfValido } from '../comum/documentos';
import { AuditoriaService } from '../comum/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { CONFIGS } from '../configuracoes/outras-configuracoes';
import { grupos, rhDocumentos, rhEnvios, rhEscalas, rhFechamentos, rhFeriados, rhFuncionarios, rhLocais, rhOcorrencias, rhRegistros, rhTratamentos, usuarios } from '../db/schema';
import { RhService, TIPOS_DOCUMENTO, TIPOS_OCORRENCIA, diasDaCompetencia } from './rh.service';
import { ContabilidadeService, ITENS_CONTABILIDADE, type ItemContabilidade } from './contabilidade.service';

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const comp = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM');
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora no formato HH:MM');
const so = (s?: string | null) => (s ?? '').replace(/\D/g, '');
const vazioNulo = z.string().trim().max(300).nullable().optional().transform((v) => (v ? v : null));

const funcionarioSchema = z.object({
  empresaId: z.string().uuid('Escolha a empresa'),
  nome: z.string().trim().min(3, 'Informe o nome completo').max(150),
  nomeSocial: vazioNulo,
  cpf: z.string().transform(so).refine((v) => cpfValido(v), 'CPF inválido'),
  pis: vazioNulo,
  rg: vazioNulo,
  nascimento: data.nullable().optional(),
  telefone: vazioNulo,
  email: z.union([z.literal(''), z.string().email('E-mail inválido')]).nullable().optional().transform((v) => v || null),
  cep: vazioNulo,
  endereco: vazioNulo,
  cidade: vazioNulo,
  uf: vazioNulo,
  cargo: vazioNulo,
  departamento: vazioNulo,
  tipoContrato: z.enum(['clt', 'experiencia', 'estagio', 'temporario', 'aprendiz', 'pj', 'autonomo']).default('clt'),
  salario: z.number().int().min(0).nullable().optional(),
  ctps: vazioNulo,
  matriculaEsocial: vazioNulo,
  dadosBancarios: z.record(z.string(), z.string().max(80)).default({}),
  escalaId: z.string().uuid().nullable().optional(),
  dataAdmissao: data,
  batePonto: z.boolean().default(true),
  camposExtras: z.record(z.string(), z.string().max(500)).default({}),
  observacao: z.string().max(2000).nullable().optional(),
});

const turnoSchema = z.object({ entrada: hora, saidaIntervalo: hora.nullable().optional(), voltaIntervalo: hora.nullable().optional(), saida: hora }).nullable();

/**
 * RH e ponto, visão da empresa: cadastro dos funcionários, pasta de documentos, ocorrências,
 * espelho de ponto, ajustes, fechamento do mês, arquivos oficiais e envio para a contabilidade.
 */
@Controller('rh')
export class RhController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly rh: RhService,
    private readonly contab: ContabilidadeService,
    private readonly arquivos: ArquivosService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get('resumo')
  @Permissao('rh', 'ver')
  async resumo() {
    const [c] = (
      await this.db.execute<{ ativos: number; afastados: number; admissoes: number; desligamentos: number }>(sql`
        select count(*) filter (where status = 'ativo')::int as ativos, count(*) filter (where status = 'afastado')::int as afastados,
          count(*) filter (where data_admissao >= date_trunc('month', current_date))::int as admissoes,
          count(*) filter (where data_demissao >= date_trunc('month', current_date))::int as desligamentos
        from rh_funcionarios`)
    ).rows;
    const hoje = await this.rh.hoje();
    const vencendo = await this.rh.vencimentos(30);
    return { ...c, hoje, vencendo, tiposDocumento: TIPOS_DOCUMENTO, tiposOcorrencia: TIPOS_OCORRENCIA };
  }

  // ───────── Funcionários ─────────

  @Get('funcionarios')
  @Permissao('rh', 'ver')
  listar(@Query('status') status?: string, @Query('busca') busca?: string) {
    const f: SQL[] = [];
    if (status && status !== 'todos') f.push(eq(rhFuncionarios.status, status));
    if (busca?.trim()) f.push(or(ilike(rhFuncionarios.nome, `%${busca.trim()}%`), ilike(rhFuncionarios.cargo, `%${busca.trim()}%`), sql`${rhFuncionarios.cpf} like ${'%' + so(busca) + '%'}`)!);
    return this.db
      .select({ id: rhFuncionarios.id, nome: rhFuncionarios.nome, cpf: rhFuncionarios.cpf, cargo: rhFuncionarios.cargo, departamento: rhFuncionarios.departamento, status: rhFuncionarios.status, dataAdmissao: rhFuncionarios.dataAdmissao, dataDemissao: rhFuncionarios.dataDemissao, telefone: rhFuncionarios.telefone, batePonto: rhFuncionarios.batePonto, escala: rhEscalas.nome, usuarioId: rhFuncionarios.usuarioId, grupo: grupos.nome })
      .from(rhFuncionarios)
      .leftJoin(rhEscalas, eq(rhEscalas.id, rhFuncionarios.escalaId))
      .leftJoin(usuarios, eq(usuarios.id, rhFuncionarios.usuarioId))
      .leftJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .where(f.length ? and(...f) : undefined)
      .orderBy(asc(rhFuncionarios.nome));
  }

  @Get('funcionarios/:id')
  @Permissao('rh', 'ver')
  async obter(@Param('id', ParseUUIDPipe) id: string) {
    const f = await this.rh.obter(id);
    const [acesso] = f.usuarioId ? await this.db.select({ id: usuarios.id, email: usuarios.email, ativo: usuarios.ativo, grupoId: usuarios.grupoId, grupo: grupos.nome, ultimoAcesso: usuarios.ultimoAcesso }).from(usuarios).innerJoin(grupos, eq(grupos.id, usuarios.grupoId)).where(eq(usuarios.id, f.usuarioId)) : [];
    const documentos = await this.db.select().from(rhDocumentos).where(eq(rhDocumentos.funcionarioId, id)).orderBy(desc(rhDocumentos.data), desc(rhDocumentos.criadoEm));
    const ocorrencias = await this.db.select().from(rhOcorrencias).where(eq(rhOcorrencias.funcionarioId, id)).orderBy(desc(rhOcorrencias.de));
    return { ...f, acesso: acesso ? { ...acesso, loginPorCpf: acesso.email.endsWith('@ponto.local') } : null, documentos, ocorrencias };
  }

  @Post('funcionarios')
  @Permissao('rh', 'criar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const { acesso, ...d } = validar(funcionarioSchema.extend({ acesso: z.object({ grupoId: z.string().uuid(), email: z.string().email().nullable().optional() }).nullable().optional() }), body);
    const [dup] = await this.db.select({ nome: rhFuncionarios.nome }).from(rhFuncionarios).where(eq(rhFuncionarios.cpf, d.cpf));
    if (dup) throw new BadRequestException(`Já existe um funcionário com este CPF: ${dup.nome}.`);
    const r = await this.db.transaction(async (tx) => {
      const [f] = await tx.insert(rhFuncionarios).values(d).returning();
      await this.rh.registrarEmpregado(tx, f, 'I', u.id);
      return f;
    });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'rh_funcionario', entidadeId: r.id, dados: { nome: r.nome } });
    const senha = acesso ? await this.criarAcesso(u, r.id, acesso) : null;
    return { ...r, acessoCriado: senha };
  }

  @Patch('funcionarios/:id')
  @Permissao('rh', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const atual = await this.rh.obter(id);
    const d = validar(funcionarioSchema.partial().extend({ status: z.enum(['ativo', 'afastado']).optional() }), body);
    if (d.cpf && d.cpf !== atual.cpf) {
      const [dup] = await this.db.select({ nome: rhFuncionarios.nome }).from(rhFuncionarios).where(eq(rhFuncionarios.cpf, d.cpf));
      if (dup) throw new BadRequestException(`Já existe um funcionário com este CPF: ${dup.nome}.`);
    }
    const r = await this.db.transaction(async (tx) => {
      const [f] = await tx.update(rhFuncionarios).set({ ...d, atualizadoEm: new Date() }).where(eq(rhFuncionarios.id, id)).returning();
      // O REP precisa saber quando muda o nome ou o CPF de quem marca.
      if ((d.nome && d.nome !== atual.nome) || (d.cpf && d.cpf !== atual.cpf)) await this.rh.registrarEmpregado(tx, f, 'A', u.id);
      return f;
    });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'rh_funcionario', entidadeId: id, dados: { campos: Object.keys(d) } });
    return r;
  }

  @Post('funcionarios/:id/desligar')
  @Permissao('rh', 'editar')
  async desligar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ data, motivo: z.string().trim().min(3, 'Informe o motivo').max(300), manterAcesso: z.boolean().default(false) }), body);
    const f = await this.rh.obter(id);
    if (f.status === 'desligado') throw new BadRequestException('Funcionário já desligado.');
    if (d.data < f.dataAdmissao) throw new BadRequestException('Desligamento antes da admissão.');
    await this.db.transaction(async (tx) => {
      const [n] = await tx.update(rhFuncionarios).set({ status: 'desligado', dataDemissao: d.data, motivoDemissao: d.motivo, atualizadoEm: new Date() }).where(eq(rhFuncionarios.id, id)).returning();
      await this.rh.registrarEmpregado(tx, n, 'E', u.id);
      // Sem acesso ao sistema depois de desligado (a não ser que a empresa queira deixar ver contracheques).
      if (f.usuarioId && !d.manterAcesso) await tx.update(usuarios).set({ ativo: false }).where(eq(usuarios.id, f.usuarioId));
    });
    invalidarSessoes();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'desligar', entidade: 'rh_funcionario', entidadeId: id, dados: { data: d.data, motivo: d.motivo } });
    return { ok: true };
  }

  /** Níveis de acesso que esta pessoa pode dar (nunca mais do que ela mesma tem). */
  @Get('grupos')
  @Permissao('rh', 'ver')
  async grupos(@Usuario() u: UsuarioLogado) {
    const gs = await this.db.select({ id: grupos.id, nome: grupos.nome, permissoes: grupos.permissoes }).from(grupos).orderBy(asc(grupos.nome));
    return gs.filter((g) => contemPermissoes(u.permissoes, g.permissoes)).map(({ id, nome }) => ({ id, nome }));
  }

  /** Cria o login do funcionário. Sem e-mail, ele entra com o CPF. Devolve a senha provisória (mostrada uma vez). */
  @Post('funcionarios/:id/acesso')
  @Permissao('rh', 'criar')
  async acesso(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ grupoId: z.string().uuid('Escolha o nível de acesso'), email: z.string().email('E-mail inválido').nullable().optional() }), body);
    return { senhaProvisoria: await this.criarAcesso(u, id, d) };
  }

  private async criarAcesso(u: UsuarioLogado, funcionarioId: string, d: { grupoId: string; email?: string | null }) {
    const f = await this.rh.obter(funcionarioId);
    const [g] = await this.db.select().from(grupos).where(eq(grupos.id, d.grupoId));
    if (!g) throw new BadRequestException('Nível de acesso não encontrado.');
    // Ninguém dá a outro mais acesso do que tem.
    if (!contemPermissoes(u.permissoes, g.permissoes)) throw new ForbiddenException('Você não pode dar um nível de acesso maior que o seu.');
    const senha = randomBytes(6).toString('base64url');
    const email = (d.email || f.email || `${f.cpf}@ponto.local`).toLowerCase();
    if (f.usuarioId) {
      await this.db.update(usuarios).set({ grupoId: g.id, email, ativo: true, senhaHash: await bcrypt.hash(senha, 10), senhaProvisoria: true }).where(eq(usuarios.id, f.usuarioId));
    } else {
      const [ja] = await this.db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, email));
      if (ja) throw new BadRequestException('Este e-mail já é o login de outra pessoa.');
      const [n] = await this.db.insert(usuarios).values({ nome: f.nome, email, grupoId: g.id, senhaHash: await bcrypt.hash(senha, 10), senhaProvisoria: true }).returning();
      await this.db.update(rhFuncionarios).set({ usuarioId: n.id }).where(eq(rhFuncionarios.id, f.id));
    }
    invalidarSessoes();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'nova_senha', entidade: 'rh_funcionario', entidadeId: f.id, dados: { grupo: g.nome } });
    return { login: email.endsWith('@ponto.local') ? f.cpf : email, senha };
  }

  // ───────── Documentos ─────────

  @Post('funcionarios/:id/documentos')
  @Permissao('rh', 'criar')
  async documento(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        tipo: z.string(),
        titulo: z.string().max(150).nullable().optional(),
        competencia: comp.nullable().optional(),
        data: data.nullable().optional(),
        validade: data.nullable().optional(),
        visivelFuncionario: z.boolean().default(true),
        nomeArquivo: z.string().min(1).max(200),
        mime: z.string().max(120),
        base64: z.string().min(10),
      }),
      body,
    );
    const { base64, ...resto } = d;
    return this.rh.salvarDocumento(id, { ...resto, conteudo: Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64') }, u.id);
  }

  @Get('documentos/:id/arquivo')
  @Permissao('rh', 'ver')
  async baixar(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { doc, caminho } = await this.rh.arquivoDocumento(id);
    if (!existsSync(caminho)) throw new NotFoundException('Arquivo não encontrado.');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.nomeArquivo)}`);
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(caminho);
  }

  @Delete('documentos/:id')
  @Permissao('rh', 'excluir')
  async apagarDocumento(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [doc] = await this.db.delete(rhDocumentos).where(eq(rhDocumentos.id, id)).returning();
    if (!doc) throw new NotFoundException('Documento não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'rh_documento', entidadeId: id, dados: { titulo: doc.titulo, funcionarioId: doc.funcionarioId } });
    return { ok: true };
  }

  @Get('vencimentos')
  @Permissao('rh', 'ver')
  vencimentos(@Query('dias') dias?: string) {
    return this.rh.vencimentos(Math.min(365, Number(dias) || 30));
  }

  // ───────── Ocorrências ─────────

  @Post('funcionarios/:id/ocorrencias')
  @Permissao('rh', 'criar')
  async ocorrencia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ tipo: z.string().refine((t) => t in TIPOS_OCORRENCIA, 'Tipo inválido'), de: data, ate: data, observacao: z.string().max(500).nullable().optional(), documentoId: z.string().uuid().nullable().optional() }), body);
    if (d.ate < d.de) throw new BadRequestException('A data final é antes da inicial.');
    await this.rh.obter(id);
    const [o] = await this.db.insert(rhOcorrencias).values({ ...d, funcionarioId: id, abona: TIPOS_OCORRENCIA[d.tipo].abona, usuarioId: u.id }).returning();
    if (d.tipo === 'afastamento') await this.db.update(rhFuncionarios).set({ status: 'afastado' }).where(and(eq(rhFuncionarios.id, id), eq(rhFuncionarios.status, 'ativo')));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'rh_ocorrencia', entidadeId: o.id, dados: d });
    return o;
  }

  @Delete('ocorrencias/:id')
  @Permissao('rh', 'excluir')
  async apagarOcorrencia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [o] = await this.db.delete(rhOcorrencias).where(eq(rhOcorrencias.id, id)).returning();
    if (!o) throw new NotFoundException('Ocorrência não encontrada.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'excluir', entidade: 'rh_ocorrencia', entidadeId: id, dados: o });
    return { ok: true };
  }

  // ───────── Ponto ─────────

  @Get('hoje')
  @Permissao('rh', 'ver')
  hoje() {
    return this.rh.hoje();
  }

  @Get('espelho/:funcionarioId')
  @Permissao('rh', 'ver')
  espelho(@Param('funcionarioId', ParseUUIDPipe) id: string, @Query('competencia') competencia: string) {
    return this.rh.espelho(id, competencia);
  }

  /** Ajuste do ponto: incluir batida esquecida ou desconsiderar uma batida. A marcação original nunca muda. */
  @Post('tratamentos')
  @Permissao('rh', 'editar')
  async tratamento(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.discriminatedUnion('tipo', [
        z.object({ tipo: z.literal('inclusao'), funcionarioId: z.string().uuid(), data, hora, motivo: z.string().trim().min(5, 'Explique o motivo do ajuste').max(150) }),
        z.object({ tipo: z.literal('desconsiderar'), funcionarioId: z.string().uuid(), registroId: z.string().uuid(), motivo: z.string().trim().min(5, 'Explique o motivo do ajuste').max(150) }),
      ]),
      body,
    );
    await this.rh.obter(d.funcionarioId);
    if (d.tipo === 'desconsiderar') {
      const [r] = await this.db.select().from(rhRegistros).where(and(eq(rhRegistros.id, d.registroId), eq(rhRegistros.funcionarioId, d.funcionarioId), eq(rhRegistros.tipo, 7)));
      if (!r) throw new NotFoundException('Marcação não encontrada.');
      const [ja] = await this.db.select({ id: rhTratamentos.id }).from(rhTratamentos).where(and(eq(rhTratamentos.registroId, d.registroId), eq(rhTratamentos.tipo, 'desconsiderar')));
      if (ja) throw new BadRequestException('Esta marcação já foi desconsiderada.');
    }
    const marcadoEm = d.tipo === 'inclusao' ? new Date(`${d.data}T${d.hora}:00-03:00`) : null;
    if (marcadoEm && marcadoEm > new Date()) throw new BadRequestException('Não dá para incluir batida no futuro.');
    const [t] = await this.db.insert(rhTratamentos).values({ funcionarioId: d.funcionarioId, tipo: d.tipo, registroId: d.tipo === 'desconsiderar' ? d.registroId : null, marcadoEm, motivo: d.motivo, usuarioId: u.id }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: d.tipo === 'inclusao' ? 'incluir_batida' : 'desconsiderar_batida', entidade: 'rh_ponto', entidadeId: t.id, dados: d });
    return t;
  }

  /** Desfaz um ajuste feito por engano (a marcação original continua intacta). */
  @Delete('tratamentos/:id')
  @Permissao('rh', 'excluir')
  async desfazerTratamento(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [t] = await this.db.delete(rhTratamentos).where(eq(rhTratamentos.id, id)).returning();
    if (!t) throw new NotFoundException('Ajuste não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'desfazer_ajuste', entidade: 'rh_ponto', entidadeId: id, dados: t });
    return { ok: true };
  }

  @Get('registros/:id/foto')
  @Permissao('rh', 'ver')
  async foto(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const [r] = await this.db.select({ foto: rhRegistros.foto }).from(rhRegistros).where(eq(rhRegistros.id, id));
    const caminho = r?.foto ? this.arquivos.caminhoPrivado(r.foto, 'rh') : null;
    if (!caminho || !existsSync(caminho)) throw new NotFoundException('Foto não encontrada.');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(caminho);
  }

  @Get('fechamentos')
  @Permissao('rh', 'ver')
  async fechamentos(@Query('competencia') competencia: string) {
    diasDaCompetencia(competencia);
    const funcs = await this.listar('todos');
    const fs = await this.db.select().from(rhFechamentos).where(eq(rhFechamentos.competencia, competencia));
    const dias = diasDaCompetencia(competencia);
    return funcs
      .filter((f) => f.batePonto && f.dataAdmissao <= dias[dias.length - 1] && (!f.dataDemissao || f.dataDemissao >= dias[0]))
      .map((f) => {
        const x = fs.find((y) => y.funcionarioId === f.id);
        const e = x?.espelho as { totais?: Record<string, number> } | undefined;
        return { id: f.id, nome: f.nome, cargo: f.cargo, fechadoEm: x?.fechadoEm ?? null, cienteEm: x?.cienteEm ?? null, totais: e?.totais ?? null };
      });
  }

  @Post('fechar')
  @Permissao('rh', 'editar')
  fechar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ competencia: comp, funcionarioIds: z.array(z.string().uuid()).nullable().optional() }), body);
    return this.rh.fechar(d.competencia, d.funcionarioIds ?? null, u.id);
  }

  @Get('afd')
  @Permissao('rh', 'exportar')
  async afd(@Query('empresaId', ParseUUIDPipe) empresaId: string, @Query('de') de: string, @Query('ate') ate: string, @Res() res: Response) {
    validar(z.object({ de: data, ate: data }), { de, ate });
    const a = await this.rh.afd(empresaId, de, ate);
    res.setHeader('Content-Disposition', `attachment; filename="${a.nome}"`);
    res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.end(a.conteudo);
  }

  @Get('aej')
  @Permissao('rh', 'exportar')
  async aej(@Query('empresaId', ParseUUIDPipe) empresaId: string, @Query('de') de: string, @Query('ate') ate: string, @Res() res: Response) {
    validar(z.object({ de: data, ate: data }), { de, ate });
    const a = await this.rh.aej(empresaId, de, ate);
    res.setHeader('Content-Disposition', `attachment; filename="${a.nome}"`);
    res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.end(a.conteudo);
  }

  // ───────── Escalas, locais, feriados, configurações ─────────

  @Get('escalas')
  @Permissao('rh', 'ver')
  escalas() {
    return this.db.select().from(rhEscalas).orderBy(asc(rhEscalas.nome));
  }

  @Post('escalas')
  @Permissao('rh', 'editar')
  async criarEscala(@Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80), dias: z.array(turnoSchema).length(7), toleranciaMarcacao: z.number().int().min(0).max(10).default(5), toleranciaDia: z.number().int().min(0).max(20).default(10) }), body);
    const [e] = await this.db.insert(rhEscalas).values(d).returning();
    return e;
  }

  @Patch('escalas/:id')
  @Permissao('rh', 'editar')
  async editarEscala(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80).optional(), dias: z.array(turnoSchema).length(7).optional(), toleranciaMarcacao: z.number().int().min(0).max(10).optional(), toleranciaDia: z.number().int().min(0).max(20).optional(), ativo: z.boolean().optional() }), body);
    const [e] = await this.db.update(rhEscalas).set(d).where(eq(rhEscalas.id, id)).returning();
    if (!e) throw new NotFoundException('Escala não encontrada.');
    return e;
  }

  @Get('locais')
  @Permissao('rh', 'ver')
  locais() {
    return this.db.select().from(rhLocais).orderBy(asc(rhLocais.nome));
  }

  @Post('locais')
  @Permissao('rh', 'editar')
  async criarLocal(@Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), raioM: z.number().int().min(30).max(5000).default(150) }), body);
    const [l] = await this.db.insert(rhLocais).values(d).returning();
    return l;
  }

  @Patch('locais/:id')
  @Permissao('rh', 'editar')
  async editarLocal(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ nome: z.string().trim().min(2).max(80).optional(), latitude: z.number().optional(), longitude: z.number().optional(), raioM: z.number().int().min(30).max(5000).optional(), ativo: z.boolean().optional() }), body);
    const [l] = await this.db.update(rhLocais).set(d).where(eq(rhLocais.id, id)).returning();
    if (!l) throw new NotFoundException('Local não encontrado.');
    return l;
  }

  @Get('feriados')
  @Permissao('rh', 'ver')
  feriados() {
    return this.db.select().from(rhFeriados).orderBy(asc(rhFeriados.data));
  }

  @Post('feriados')
  @Permissao('rh', 'editar')
  async criarFeriado(@Body() body: unknown) {
    const d = validar(z.object({ data, nome: z.string().trim().min(2).max(100) }), body);
    const [f] = await this.db.insert(rhFeriados).values(d).onConflictDoUpdate({ target: rhFeriados.data, set: { nome: d.nome } }).returning();
    return f;
  }

  @Delete('feriados/:id')
  @Permissao('rh', 'editar')
  async apagarFeriado(@Param('id', ParseUUIDPipe) id: string) {
    await this.db.delete(rhFeriados).where(eq(rhFeriados.id, id));
    return { ok: true };
  }

  @Get('config')
  @Permissao('rh', 'ver')
  configuracao() {
    return this.config.ler('regras_rh');
  }

  @Put('config')
  @Permissao('rh', 'editar')
  async salvarConfig(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(CONFIGS.regras_rh.schema, body);
    await this.config.salvar('regras_rh', d as never);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'config:regras_rh', dados: d });
    return d;
  }

  // ───────── Contabilidade ─────────

  @Get('contabilidade/itens')
  @Permissao('rh', 'ver')
  itens() {
    return ITENS_CONTABILIDADE;
  }

  /** Lista o que vai no pacote (nomes e tamanhos), sem enviar. */
  @Post('contabilidade/previa')
  @Permissao('rh', 'exportar')
  async previa(@Body() body: unknown) {
    const d = validar(z.object({ competencia: comp, itens: z.array(z.enum(Object.keys(ITENS_CONTABILIDADE) as [ItemContabilidade])).min(1, 'Escolha o que enviar') }), body);
    const { arquivos, resumo } = await this.contab.montar(d.competencia, d.itens);
    return { resumo, arquivos: arquivos.map((a) => ({ nome: a.nome, tamanho: a.conteudo.length })) };
  }

  /** Baixa um arquivo do pacote (para conferir antes de mandar). */
  @Post('contabilidade/arquivo')
  @Permissao('rh', 'exportar')
  async arquivoPacote(@Body() body: unknown, @Res() res: Response) {
    const d = validar(z.object({ competencia: comp, itens: z.array(z.enum(Object.keys(ITENS_CONTABILIDADE) as [ItemContabilidade])).min(1), nome: z.string().max(200) }), body);
    const { arquivos } = await this.contab.montar(d.competencia, d.itens);
    const a = arquivos.find((x) => x.nome === d.nome);
    if (!a) throw new NotFoundException('Arquivo não encontrado no pacote.');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
    res.setHeader('Content-Type', a.mime);
    res.end(a.conteudo);
  }

  @Post('contabilidade/enviar')
  @Permissao('rh', 'exportar')
  async enviar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        competencia: comp,
        itens: z.array(z.enum(Object.keys(ITENS_CONTABILIDADE) as [ItemContabilidade])).min(1, 'Escolha o que enviar'),
        canal: z.enum(['email', 'whatsapp']),
        destino: z.string().trim().min(5, 'Informe o destino').max(200),
        mensagem: z.string().max(2000).nullable().optional(),
        canalId: z.string().uuid().nullable().optional(),
      }),
      body,
    );
    if (d.canal === 'email' && !z.string().email().safeParse(d.destino).success) throw new BadRequestException('E-mail da contabilidade inválido.');
    if (d.canal === 'whatsapp' && !temPermissao(u.permissoes, 'crm', 'ver')) throw new ForbiddenException('Envio por WhatsApp usa os números do CRM: peça acesso ao CRM.');
    return this.contab.enviar(d, u.id);
  }

  @Get('envios')
  @Permissao('rh', 'ver')
  envios() {
    return this.db.select({ e: rhEnvios, usuario: usuarios.nome }).from(rhEnvios).leftJoin(usuarios, eq(usuarios.id, rhEnvios.usuarioId)).orderBy(desc(rhEnvios.criadoEm)).limit(100).then((r) => r.map((x) => ({ ...x.e, usuario: x.usuario })));
  }
}

/**
 * Meu ponto: o que todo funcionário vê com o próprio login (mesmo quem só tem acesso ao ponto).
 * Não exige permissão de módulo; cada um só vê o que é seu.
 */
@Controller('ponto')
export class PontoController {
  constructor(@Inject(DB) private readonly db: Db, private readonly rh: RhService) {}

  private async eu(u: UsuarioLogado) {
    const f = await this.rh.doUsuario(u.id);
    if (!f) throw new NotFoundException('Seu acesso não está ligado a um cadastro de funcionário.');
    return f;
  }

  @Get('eu')
  async situacao(@Usuario() u: UsuarioLogado) {
    const f = await this.rh.doUsuario(u.id);
    // Sem cadastro de funcionário (ex.: sócio, contador com login): o menu não mostra "Meu ponto".
    if (!f) return { eFuncionario: false as const };
    const regras = await this.rh.regras();
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const marcacoes = await this.db
      .select({ id: rhRegistros.id, marcadoEm: rhRegistros.marcadoEm, nsr: rhRegistros.nsr, foraDoLocal: rhRegistros.foraDoLocal })
      .from(rhRegistros)
      .where(and(eq(rhRegistros.funcionarioId, f.id), eq(rhRegistros.tipo, 7), sql`${rhRegistros.marcadoEm} >= ${new Date(`${hoje}T00:00:00-03:00`)}`))
      .orderBy(asc(rhRegistros.marcadoEm));
    const [escala] = f.escalaId ? await this.db.select().from(rhEscalas).where(eq(rhEscalas.id, f.escalaId)) : [];
    const pendentesCiencia = await this.db.select({ competencia: rhFechamentos.competencia }).from(rhFechamentos).where(and(eq(rhFechamentos.funcionarioId, f.id), sql`${rhFechamentos.cienteEm} is null`));
    const docsNovos = await this.db.select({ n: sql<number>`count(*)::int` }).from(rhDocumentos).where(and(eq(rhDocumentos.funcionarioId, f.id), eq(rhDocumentos.visivelFuncionario, true), sql`${rhDocumentos.cienteEm} is null`));
    const semana = new Date(`${hoje}T12:00:00Z`).getUTCDay();
    return {
      eFuncionario: true as const,
      nome: f.nome,
      cargo: f.cargo,
      batePonto: f.batePonto && f.status !== 'desligado',
      exigirFoto: regras.exigirFoto,
      cercaGps: regras.cercaGps,
      turnoHoje: escala?.dias[semana] ?? null,
      marcacoes,
      espelhosParaConfirmar: pendentesCiencia.map((p) => p.competencia),
      documentosNovos: docsNovos[0]?.n ?? 0,
    };
  }

  @Post('marcar')
  async marcar(@Usuario() u: UsuarioLogado, @Body() body: unknown, @Req() req: Request) {
    const d = validar(
      z.object({
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
        precisao: z.number().min(0).max(100000).nullable().optional(),
        foto: z.string().max(3_000_000).nullable().optional(),
        app: z.boolean().optional(),
      }),
      body,
    );
    const foto = d.foto ? Buffer.from(d.foto.replace(/^data:[^;]+;base64,/, ''), 'base64') : null;
    if (foto && (foto[0] !== 0xff || foto[1] !== 0xd8)) throw new BadRequestException('A foto precisa ser JPEG.');
    return this.rh.marcar(u.id, { latitude: d.latitude, longitude: d.longitude, precisao: d.precisao, foto: foto ? { conteudo: foto, mime: 'image/jpeg' } : null, ip: req.ip, aparelho: String(req.headers['user-agent'] ?? ''), coletor: d.app ? '01' : '02' });
  }

  @Get('comprovante/:id')
  async comprovante(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.rh.comprovante(id);
    if (c.usuarioId !== u.id && !temPermissao(u.permissoes, 'rh', 'ver')) throw new NotFoundException('Marcação não encontrada.');
    return { ...c, usuarioId: undefined };
  }

  @Get('espelho')
  async espelho(@Usuario() u: UsuarioLogado, @Query('competencia') competencia: string) {
    const f = await this.eu(u);
    return this.rh.espelho(f.id, competencia);
  }

  /** O funcionário confirma o espelho do mês fechado (fica registrado com data, hora e IP). */
  @Post('espelho/:competencia/ciente')
  async ciente(@Usuario() u: UsuarioLogado, @Param('competencia') competencia: string, @Req() req: Request) {
    const f = await this.eu(u);
    const [r] = await this.db.update(rhFechamentos).set({ cienteEm: new Date(), cienteIp: req.ip ?? null }).where(and(eq(rhFechamentos.funcionarioId, f.id), eq(rhFechamentos.competencia, competencia), sql`${rhFechamentos.cienteEm} is null`)).returning();
    if (!r) throw new BadRequestException('Este mês ainda não foi fechado pela empresa ou já foi confirmado.');
    return { ok: true };
  }

  @Get('documentos')
  async documentos(@Usuario() u: UsuarioLogado) {
    const f = await this.eu(u);
    return this.db
      .select({ id: rhDocumentos.id, tipo: rhDocumentos.tipo, titulo: rhDocumentos.titulo, competencia: rhDocumentos.competencia, data: rhDocumentos.data, nomeArquivo: rhDocumentos.nomeArquivo, cienteEm: rhDocumentos.cienteEm })
      .from(rhDocumentos)
      .where(and(eq(rhDocumentos.funcionarioId, f.id), eq(rhDocumentos.visivelFuncionario, true)))
      .orderBy(desc(rhDocumentos.data), desc(rhDocumentos.criadoEm));
  }

  @Get('documentos/:id/arquivo')
  async arquivo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.eu(u);
    const { doc, caminho } = await this.rh.arquivoDocumento(id);
    if (doc.funcionarioId !== f.id || !doc.visivelFuncionario || !existsSync(caminho)) throw new NotFoundException('Documento não encontrado.');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.nomeArquivo)}`);
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(caminho);
  }

  @Post('documentos/:id/ciente')
  async documentoCiente(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const f = await this.eu(u);
    const [r] = await this.db.update(rhDocumentos).set({ cienteEm: new Date(), cienteIp: req.ip ?? null }).where(and(eq(rhDocumentos.id, id), eq(rhDocumentos.funcionarioId, f.id), sql`${rhDocumentos.cienteEm} is null`)).returning();
    if (!r) throw new BadRequestException('Documento não encontrado ou já confirmado.');
    return { ok: true };
  }
}
