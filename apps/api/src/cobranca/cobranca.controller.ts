import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { existsSync } from 'node:fs';
import type { Response } from 'express';
import { ArquivosService } from '../arquivos/arquivos.service';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { DB, type Db } from '../comum/db.module';
import { dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { cobradores, cobrancaComprovantes, grupos, usuarios } from '../db/schema';
import { CobrancaConfigService } from './cobranca-config.service';
import { CobrancaService } from './cobranca.service';
import { CraService, NOMES_OCORRENCIA } from './cra.service';
import { linhasCsv, linhasXlsx } from '../assistente/anexos';

const uuid = z.string().uuid();
const pb = z.number().int().min(0).max(10000);
const GRUPO_TERCEIRIZADA = 'Cobrança terceirizada';

/** Módulo de Cobrança: carteira, ficha do devedor, contatos, acordos, régua e protesto. */
@Controller('cobranca')
export class CobrancaController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cobranca: CobrancaService,
    private readonly config: CobrancaConfigService,
    private readonly cra: CraService,
    private readonly auditoria: AuditoriaService,
    private readonly arquivosSvc: ArquivosService,
  ) {}

  @Get('eu')
  @Permissao('cobranca', 'ver')
  async eu(@Usuario() u: UsuarioLogado) {
    const e = await this.cobranca.escopo(u);
    const [c] = e.cobradorId ? await this.db.select({ nome: cobradores.nome, tipo: cobradores.tipo }).from(cobradores).where(eq(cobradores.id, e.cobradorId)) : [];
    return { ...e, cobrador: c?.nome ?? null, protestoLigado: this.cra.configurado };
  }

  @Get('painel')
  @Permissao('cobranca', 'ver')
  async painel(@Usuario() u: UsuarioLogado) {
    return this.cobranca.painel(await this.cobranca.escopo(u));
  }

  @Get('carteira')
  @Permissao('cobranca', 'ver')
  async carteira(@Usuario() u: UsuarioLogado, @Query() q: Record<string, string>) {
    return this.cobranca.carteira(await this.cobranca.escopo(u), { busca: q.busca, cobradorId: q.cobradorId, faixa: q.faixa, tipo: q.tipo, pagina: Number(q.pagina) || 1 });
  }

  @Post('carteira/atribuir')
  @Permissao('cobranca', 'editar')
  async atribuir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ pessoaIds: z.array(uuid).min(1).max(500), cobradorId: uuid.nullable() }), body);
    return this.cobranca.atribuir(await this.cobranca.escopo(u), u, d.pessoaIds, d.cobradorId);
  }

  @Get('devedores/:pessoaId')
  @Permissao('cobranca', 'ver')
  async ficha(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string) {
    return this.cobranca.ficha(await this.cobranca.escopo(u), pessoaId);
  }

  @Post('devedores/:pessoaId/contatos')
  @Permissao('cobranca', 'editar')
  async contato(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        tipo: z.enum(['ligacao', 'whatsapp', 'email', 'visita', 'nota']),
        texto: z.string().trim().min(2, 'Escreva o que foi conversado').max(4000),
        promessaData: dataISO.nullable().optional(),
        promessaValor: z.number().int().min(100).max(100_000_000).nullable().optional(),
        retornoEm: dataISO.nullable().optional(),
      }),
      body,
    );
    return this.cobranca.registrarContato(await this.cobranca.escopo(u), u, pessoaId, d);
  }

  @Post('devedores/:pessoaId/pausar')
  @Permissao('cobranca', 'editar')
  async pausar(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string, @Body() body: unknown) {
    const d = validar(z.object({ pausada: z.boolean(), motivo: z.string().trim().max(300).nullable().optional() }), body);
    return this.cobranca.pausar(await this.cobranca.escopo(u), u, pessoaId, d.pausada, d.motivo);
  }

  @Post('titulos/:id/segunda-via')
  @Permissao('cobranca', 'editar')
  async segundaVia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ vencimento: dataISO, tipo: z.enum(['BOLETO', 'PIX']).default('BOLETO'), comEncargos: z.boolean().default(true) }), body);
    return this.cobranca.segundaVia(await this.cobranca.escopo(u), u, id, d);
  }

  // ───── Acordos ─────

  private acordoSchema = z.object({
    tituloIds: z.array(uuid).min(1, 'Escolha os títulos do acordo').max(200),
    desconto: z.number().int().min(0).default(0),
    entrada: z.number().int().min(0).default(0),
    vencimentoEntrada: dataISO.optional(),
    parcelas: z.number().int().min(1).max(60),
    primeiroVencimento: dataISO,
  });

  @Post('devedores/:pessoaId/acordos/simular')
  @Permissao('cobranca', 'editar')
  async simular(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string, @Body() body: unknown) {
    return this.cobranca.simularAcordo(await this.cobranca.escopo(u), pessoaId, validar(this.acordoSchema, body));
  }

  @Post('devedores/:pessoaId/acordos')
  @Permissao('cobranca', 'editar')
  async criarAcordo(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string, @Body() body: unknown) {
    const d = validar(this.acordoSchema.extend({ cobranca: z.enum(['BOLETO', 'PIX', 'nenhuma']).default('BOLETO'), observacao: z.string().trim().max(1000).nullable().optional() }), body);
    return this.cobranca.criarAcordo(await this.cobranca.escopo(u), u, pessoaId, d);
  }

  @Get('acordos')
  @Permissao('cobranca', 'ver')
  async acordos(@Usuario() u: UsuarioLogado, @Query('status') status?: string) {
    return this.cobranca.listarAcordos(await this.cobranca.escopo(u), status || undefined);
  }

  @Get('acordos/:id')
  @Permissao('cobranca', 'ver')
  async acordo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.cobranca.acordo(await this.cobranca.escopo(u), id);
  }

  @Post('acordos/:id/cancelar')
  @Permissao('cobranca', 'excluir')
  async cancelarAcordo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Diga o motivo').max(300) }), body);
    const e = await this.cobranca.escopo(u);
    this.cobranca.exigirGestor(e);
    return this.cobranca.encerrarAcordo(id, 'cancelado', motivo, u.id);
  }

  // ───── Régua ─────

  @Get('regua/previa')
  @Permissao('cobranca', 'ver')
  async previa(@Usuario() u: UsuarioLogado) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    return this.cobranca.rodarRegua(true);
  }

  @Post('regua/rodar')
  @Permissao('cobranca', 'excluir')
  async rodar(@Usuario() u: UsuarioLogado) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const r = await this.cobranca.rodarRegua(false);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'rodar_regua', entidade: 'cobranca', dados: { naFila: r.naFila, tarefas: r.tarefas, enviados: r.enviados, falhas: r.falhas } });
    return r;
  }

  /** Cancela no Asaas os boletos gerados num dia (conferir antes com simular). */
  @Post('boletos/cancelar-do-dia')
  @Permissao('cobranca', 'excluir')
  async cancelarBoletosDoDia(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const d = validar(z.object({ dia: dataISO, simular: z.boolean().default(true) }), body);
    return this.cobranca.cancelarBoletosDoDia(d.dia, d.simular, u.id);
  }

  // ───── Processos judiciais ─────

  @Post('devedores/:pessoaId/processos')
  @Permissao('cobranca', 'editar')
  async salvarProcesso(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string, @Body() body: unknown) {
    const d = validar(z.object({ numero: z.string().trim().min(3, 'Digite o número do processo').max(60), situacao: z.enum(['ativo', 'arquivado']), observacao: z.string().trim().max(500).nullable().optional() }), body);
    return this.cobranca.salvarProcesso(await this.cobranca.escopo(u), u, pessoaId, d);
  }

  @Post('processos/:id/excluir')
  @Permissao('cobranca', 'editar')
  async excluirProcesso(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.cobranca.excluirProcesso(await this.cobranca.escopo(u), u, id);
  }

  /** Planilha da advogada (.xlsx ou .csv): `simular` mostra o que vai acontecer sem gravar. */
  @Post('processos/importar')
  @Permissao('cobranca', 'excluir')
  async importarProcessos(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const d = validar(z.object({ nome: z.string().max(200), base64: z.string().min(4).max(14_000_000), simular: z.boolean().default(false) }), body);
    const conteudo = Buffer.from(d.base64, 'base64');
    const linhas = /\.xlsx$/i.test(d.nome) ? linhasXlsx(conteudo) : /\.(csv|txt)$/i.test(d.nome) ? linhasCsv(conteudo.toString('utf8')) : null;
    if (!linhas) throw new BadRequestException('Mande a planilha em .xlsx ou .csv.');
    const r = await this.cobranca.importarProcessos(u, linhas, d.simular);
    if (!d.simular) await this.auditoria.registrar({ usuarioId: u.id, acao: 'importar_processos', entidade: 'cobranca', dados: { arquivo: d.nome, criados: r.criados, atualizados: r.atualizados, naoEncontrados: r.naoEncontrados.length } });
    return r;
  }

  // ───── Comprovantes recebidos pelo WhatsApp ─────

  @Get('comprovantes')
  @Permissao('cobranca', 'ver')
  async comprovantes(@Usuario() u: UsuarioLogado, @Query('status') status?: string) {
    return this.cobranca.comprovantes(await this.cobranca.escopo(u), status || 'pendente');
  }

  @Get('comprovantes/:id/foto')
  @Permissao('cobranca', 'ver')
  async fotoComprovante(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const [c] = await this.db.select().from(cobrancaComprovantes).where(eq(cobrancaComprovantes.id, id));
    if (!c?.midia) throw new NotFoundException('Comprovante sem foto.');
    await this.cobranca.exigirAcesso(await this.cobranca.escopo(u), c.pessoaId);
    const caminho = this.arquivosSvc.caminhoMidia(c.midia);
    if (!caminho || !existsSync(caminho)) throw new NotFoundException('Arquivo não encontrado.');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(caminho);
  }

  @Post('comprovantes/:id/resolver')
  @Permissao('cobranca', 'editar')
  async resolverComprovante(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ status: z.enum(['baixado', 'recusado']), observacao: z.string().trim().max(500).nullable().optional() }), body);
    return this.cobranca.resolverComprovante(await this.cobranca.escopo(u), u, id, d);
  }

  /** Rotinas do dia na hora (acordos, promessas). */
  @Post('rotina')
  @Permissao('cobranca', 'excluir')
  async rotina(@Usuario() u: UsuarioLogado) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    return { acordos: await this.cobranca.verificarAcordos(), promessas: await this.cobranca.verificarPromessas() };
  }

  // ───── Configuração ─────

  @Get('config')
  @Permissao('cobranca', 'ver')
  configuracao() {
    return this.config.obter();
  }

  @Put('config')
  @Permissao('cobranca', 'excluir')
  async salvarConfig(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const d = validar(
      z.object({
        multaPb: z.number().int().min(0).max(1000, 'A multa máxima aceita é de 10%'),
        jurosMesPb: z.number().int().min(0).max(1000, 'Os juros máximos aceitos são de 10% ao mês'),
        diasCarencia: z.number().int().min(0).max(60),
        descontoMaxPb: pb,
        descontoMaxGestorPb: pb,
        parcelasMax: z.number().int().min(1).max(60),
        diasQuebraAcordo: z.number().int().min(1).max(120),
        regua: z.object({
          ativa: z.boolean(),
          canalId: uuid.nullable(),
          gerarBoleto: z.boolean().default(false),
          aprovarAntes: z.boolean().default(true),
          passos: z
            .array(
              z.object({
                dias: z.number().int().min(-30).max(365),
                acao: z.enum(['mensagem', 'tarefa']).default('mensagem'),
                nome: z.string().trim().max(60).optional(),
                canal: z.enum(['whatsapp', 'email']).default('whatsapp'),
                texto: z.string().trim().min(5, 'Escreva o texto de cada etapa').max(2000),
                templateId: uuid.nullable().optional(),
                responsavelId: uuid.nullable().optional(),
              }),
            )
            .max(15),
        }),
        protesto: z.object({ diasMinimos: z.number().int().min(1).max(3650), especie: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/, 'A espécie tem 2 ou 3 letras (ex.: DMI)') }),
      }),
      body,
    );
    const dias = d.regua.passos.map((p) => p.dias);
    if (new Set(dias).size !== dias.length) throw new BadRequestException('Duas etapas da trilha no mesmo dia: junte numa só.');
    if (d.regua.ativa && d.regua.passos.some((p) => p.acao === 'mensagem' && p.canal === 'whatsapp') && !d.regua.canalId) throw new BadRequestException('Escolha o número de WhatsApp que manda a trilha.');
    if (d.regua.ativa && d.regua.passos.some((p) => p.acao === 'tarefa' && !p.responsavelId)) throw new BadRequestException('Escolha quem recebe a tarefa em cada etapa de tarefa.');
    d.regua.passos.sort((a, b) => a.dias - b.dias);
    await this.config.salvar(d);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'configurar', entidade: 'cobranca', dados: { multaPb: d.multaPb, jurosMesPb: d.jurosMesPb, regua: d.regua.ativa, passos: d.regua.passos.length } });
    return d;
  }

  // ───── Cobradores e acessos ─────

  @Get('cobradores')
  @Permissao('cobranca', 'ver')
  async listarCobradores(@Usuario() u: UsuarioLogado) {
    const e = await this.cobranca.escopo(u);
    const lista = await this.db.select().from(cobradores).where(e.restrito ? eq(cobradores.id, e.cobradorId!) : undefined).orderBy(asc(cobradores.nome));
    const acessos = await this.db.select({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email, ativo: usuarios.ativo, cobradorId: usuarios.cobradorId, ultimoAcesso: usuarios.ultimoAcesso }).from(usuarios).where(sql`${usuarios.cobradorId} is not null`);
    return lista.map((c) => ({ ...c, acessos: e.restrito ? [] : acessos.filter((a) => a.cobradorId === c.id) }));
  }

  private cobradorSchema = z.object({
    nome: z.string().trim().min(2, 'Informe o nome').max(120),
    tipo: z.enum(['interno', 'terceirizada']),
    documento: z.string().trim().max(20).nullable().optional(),
    telefone: z.string().trim().max(30).nullable().optional(),
    email: z.string().trim().toLowerCase().email('E-mail inválido').nullable().optional().or(z.literal('').transform(() => null)),
    comissaoPb: pb.default(0),
    ativo: z.boolean().default(true),
  });

  @Post('cobradores')
  @Permissao('cobranca', 'excluir')
  async criarCobrador(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const [c] = await this.db.insert(cobradores).values(validar(this.cobradorSchema, body)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'cobrador', entidadeId: c.id });
    return c;
  }

  @Patch('cobradores/:id')
  @Permissao('cobranca', 'excluir')
  async editarCobrador(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const d = validar(this.cobradorSchema.partial(), body);
    const [c] = await this.db.update(cobradores).set(d).where(eq(cobradores.id, id)).returning();
    if (!c) throw new NotFoundException('Cobrador não encontrado.');
    // Desativar o cobrador desativa os acessos dele.
    if (d.ativo === false) await this.db.update(usuarios).set({ ativo: false }).where(eq(usuarios.cobradorId, id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'cobrador', entidadeId: id, dados: d });
    return c;
  }

  /**
   * Acesso ao sistema para alguém do cobrador. Terceirizada entra num grupo que só tem a Cobrança e vê só a carteira dela.
   * Funcionário: liga um usuário que já existe ao cobrador (para a carteira e a comissão).
   */
  @Post('cobradores/:id/acessos')
  @Permissao('cobranca', 'excluir')
  async criarAcesso(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const [c] = await this.db.select().from(cobradores).where(eq(cobradores.id, id));
    if (!c || !c.ativo) throw new NotFoundException('Cobrador não encontrado ou inativo.');
    const d = validar(z.object({ usuarioId: uuid.optional(), nome: z.string().trim().min(2).max(120).optional(), email: z.string().trim().toLowerCase().email('E-mail inválido').optional() }), body);
    if (d.usuarioId) {
      const [alvo] = await this.db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.id, d.usuarioId));
      if (!alvo) throw new NotFoundException('Usuário não encontrado.');
      await this.db.update(usuarios).set({ cobradorId: id }).where(eq(usuarios.id, d.usuarioId));
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'ligar_cobrador', entidade: 'usuario', entidadeId: d.usuarioId, dados: { cobradorId: id } });
      return { ok: true };
    }
    if (c.tipo !== 'terceirizada') throw new BadRequestException('Para funcionário, escolha o usuário que já existe.');
    if (!d.nome || !d.email) throw new BadRequestException('Informe o nome e o e-mail de quem vai entrar.');
    const [ja] = await this.db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, d.email));
    if (ja) throw new BadRequestException('Já existe um usuário com este e-mail.');
    // Grupo da terceirizada: só a Cobrança, sem excluir (nem atribuir carteira, nem mandar a protesto).
    let [g] = await this.db.select().from(grupos).where(eq(grupos.nome, GRUPO_TERCEIRIZADA));
    if (!g) [g] = await this.db.insert(grupos).values({ nome: GRUPO_TERCEIRIZADA, permissoes: { cobranca: ['ver', 'criar', 'editar'] } }).returning();
    const senha = randomBytes(9).toString('base64url');
    const [n] = await this.db.insert(usuarios).values({ nome: d.nome, email: d.email, grupoId: g.id, cobradorId: id, senhaHash: await bcrypt.hash(senha, 10), senhaProvisoria: true }).returning({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'usuario', entidadeId: n.id, dados: { cobradorId: id, terceirizada: c.nome } });
    return { ...n, senhaProvisoria: senha };
  }

  @Post('cobradores/:id/acessos/:usuarioId/remover')
  @Permissao('cobranca', 'excluir')
  async removerAcesso(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Param('usuarioId', ParseUUIDPipe) usuarioId: string) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const [alvo] = await this.db.select({ id: usuarios.id, grupo: grupos.nome }).from(usuarios).innerJoin(grupos, eq(grupos.id, usuarios.grupoId)).where(and(eq(usuarios.id, usuarioId), eq(usuarios.cobradorId, id)));
    if (!alvo) throw new NotFoundException('Acesso não encontrado.');
    // Usuário da terceirizada é desativado; funcionário só deixa de ser deste cobrador.
    await this.db.update(usuarios).set(alvo.grupo === GRUPO_TERCEIRIZADA ? { ativo: false, cobradorId: null } : { cobradorId: null }).where(eq(usuarios.id, usuarioId));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'remover_acesso', entidade: 'usuario', entidadeId: usuarioId, dados: { cobradorId: id } });
    return { ok: true };
  }

  // ───── Protesto ─────

  @Post('protestos/conferir')
  @Permissao('cobranca', 'excluir')
  async conferir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const { tituloIds } = validar(z.object({ tituloIds: z.array(uuid).min(1).max(300) }), body);
    return this.cra.conferir(tituloIds);
  }

  @Post('protestos')
  @Permissao('cobranca', 'excluir')
  async protestar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const d = validar(z.object({ tituloIds: z.array(uuid).min(1).max(300), especie: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/).optional() }), body);
    return this.cra.enviar(u.id, d.tituloIds, d.especie);
  }

  @Get('protestos')
  @Permissao('cobranca', 'ver')
  async protestos(@Usuario() u: UsuarioLogado, @Query('status') status?: string) {
    const e = await this.cobranca.escopo(u);
    if (e.restrito) return { itens: [], ocorrencias: NOMES_OCORRENCIA, ligado: this.cra.configurado };
    return { itens: await this.cra.listar(status || undefined), ocorrencias: NOMES_OCORRENCIA, ligado: this.cra.configurado };
  }

  @Post('protestos/sincronizar')
  @Permissao('cobranca', 'excluir')
  async sincronizar(@Usuario() u: UsuarioLogado) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    return this.cra.sincronizar();
  }

  @Post('protestos/:id/pedido')
  @Permissao('cobranca', 'excluir')
  async pedido(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    const d = validar(z.object({ tipo: z.enum(['desistencia', 'autoriza_cancelamento']), motivo: z.string().trim().min(3, 'Diga o motivo').max(300) }), body);
    return this.cra.pedir(id, d.tipo, u.id, d.motivo);
  }

  @Get('protestos/arquivos')
  @Permissao('cobranca', 'excluir')
  async arquivos(@Usuario() u: UsuarioLogado) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    return this.cra.arquivos();
  }

  @Get('protestos/arquivos/:id')
  @Permissao('cobranca', 'excluir')
  async arquivo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    this.cobranca.exigirGestor(await this.cobranca.escopo(u));
    return this.cra.arquivo(id);
  }
}
