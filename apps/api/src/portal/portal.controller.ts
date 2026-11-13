import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Representante, RotaPortal, Usuario, type RepresentanteLogada, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { cpfValido, soDigitos } from '../comum/documentos';
import { Limitador } from '../comum/limitador';
import { AuditoriaService } from '../comum/auditoria.service';
import { EmailService } from '../integracoes/email.service';
import { AsaasService } from '../integracoes/asaas.service';
import { MaletasService } from '../maletas/maletas.service';
import { acertos, categorias, documentos, locaisEstoque, maletas, niveis, pedidosPecas, pessoas, portalAcessos, produtos, saldos, titulos } from '../db/schema';

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const mascarar = (e: string) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');
const pedidosDeCodigo = new Limitador(5, 30 * 60_000, 'Muitos pedidos de código.');
const tentativasPorIp = new Limitador(30, 15 * 60_000, 'Muitas tentativas.');

/**
 * Portal da representante (abre no celular e pode ser instalado como app).
 * Entrada: CPF + código de 6 dígitos enviado ao e-mail do cadastro, ou link de acesso que a matriz manda pelo WhatsApp.
 * A representante só enxerga os próprios dados; nunca custo, nem dados de outras pessoas.
 */
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
    private readonly asaas: AsaasService,
    private readonly maletasSvc: MaletasService,
    private readonly auditoria: AuditoriaService,
  ) {}

  private sessao(p: { id: string; nome: string }) {
    return { token: this.jwt.sign({ tipo: 'portal', rep: p.id, nome: p.nome }, { expiresIn: '30d' }), nome: p.nome };
  }

  // ───── Entrada ─────

  @Publico()
  @Post('entrar')
  async entrar(@Body() body: unknown, @Req() req: Request) {
    const cpf = soDigitos(validar(z.object({ cpf: z.string() }), body).cpf);
    if (!cpfValido(cpf)) throw new BadRequestException('CPF inválido.');
    tentativasPorIp.usar(req.ip ?? '?');
    pedidosDeCodigo.usar(cpf);
    const [p] = await this.db.select().from(pessoas).where(and(eq(pessoas.documento, cpf), eq(pessoas.tipo, 'representante')));
    // Mesma resposta exista ou não o CPF, para não revelar quem é representante.
    const generica = { enviado: true, mensagem: 'Se o CPF estiver cadastrado, enviamos um código para o e-mail do cadastro.' };
    if (!p || ['inativo', 'recusado'].includes(p.status) || !p.email) return generica;
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.insert(portalAcessos).values({ pessoaId: p.id, tipo: 'codigo', hash: sha256(`${p.id}:${codigo}`), expiraEm: new Date(Date.now() + 15 * 60_000) });
    const r = await this.email.enviar(p.email, 'Seu código de acesso · Aritana', `Olá, ${p.nome.split(' ')[0]}!\n\nSeu código para entrar no portal da Aritana é: ${codigo}\nEle vale por 15 minutos.\n\nSe não foi você, ignore esta mensagem.\nAritana Semijoias`);
    return { ...generica, mensagem: `Enviamos um código para ${mascarar(p.email)}.`, ...(r.simulado && process.env.NODE_ENV !== 'production' ? { codigoDev: codigo } : {}) };
  }

  @Publico()
  @Post('confirmar')
  async confirmar(@Body() body: unknown, @Req() req: Request) {
    const d = validar(z.object({ cpf: z.string(), codigo: z.string().regex(/^\d{6}$/, 'O código tem 6 números') }), body);
    tentativasPorIp.usar(req.ip ?? '?');
    const cpf = soDigitos(d.cpf);
    const [p] = await this.db.select().from(pessoas).where(and(eq(pessoas.documento, cpf), eq(pessoas.tipo, 'representante')));
    if (!p) throw new BadRequestException('Código incorreto ou vencido.');
    const [a] = await this.db
      .select()
      .from(portalAcessos)
      .where(and(eq(portalAcessos.pessoaId, p.id), eq(portalAcessos.tipo, 'codigo'), isNull(portalAcessos.usadoEm), gt(portalAcessos.expiraEm, new Date())))
      .orderBy(desc(portalAcessos.criadoEm))
      .limit(1);
    if (!a || a.tentativas >= 5) throw new BadRequestException('Código incorreto ou vencido. Peça um novo.');
    const ok = timingSafeEqual(Buffer.from(a.hash, 'hex'), Buffer.from(sha256(`${p.id}:${d.codigo}`), 'hex'));
    if (!ok) {
      await this.db.update(portalAcessos).set({ tentativas: a.tentativas + 1 }).where(eq(portalAcessos.id, a.id));
      throw new BadRequestException('Código incorreto.');
    }
    await this.db.update(portalAcessos).set({ usadoEm: new Date() }).where(eq(portalAcessos.id, a.id));
    await this.auditoria.registrar({ acao: 'entrar_portal', entidade: 'pessoa', entidadeId: p.id, dados: { via: 'codigo', ip: req.ip } });
    return this.sessao(p);
  }

  /** Link de acesso enviado pela matriz (vale 7 dias, uso único). */
  @Publico()
  @Post('link/:token')
  async porLink(@Param('token') token: string, @Req() req: Request) {
    tentativasPorIp.usar(req.ip ?? '?');
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) throw new NotFoundException('Link inválido.');
    const [a] = await this.db.select().from(portalAcessos).where(and(eq(portalAcessos.hash, sha256(token)), eq(portalAcessos.tipo, 'link')));
    if (!a || a.usadoEm || a.expiraEm < new Date()) throw new BadRequestException('Este link já foi usado ou venceu. Entre com o seu CPF ou peça um link novo à Aritana.');
    const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, a.pessoaId));
    if (!p || ['inativo', 'recusado'].includes(p.status)) throw new ForbiddenException('Acesso desativado. Fale com a Aritana.');
    await this.db.update(portalAcessos).set({ usadoEm: new Date() }).where(eq(portalAcessos.id, a.id));
    await this.auditoria.registrar({ acao: 'entrar_portal', entidade: 'pessoa', entidadeId: p.id, dados: { via: 'link', ip: req.ip } });
    return this.sessao(p);
  }

  /** Matriz gera o link de acesso para mandar pelo WhatsApp. */
  @Post('gerar-link/:pessoaId')
  @Permissao('rede', 'editar')
  async gerarLink(@Usuario() u: UsuarioLogado, @Param('pessoaId', ParseUUIDPipe) pessoaId: string) {
    const [p] = await this.db.select().from(pessoas).where(and(eq(pessoas.id, pessoaId), eq(pessoas.tipo, 'representante')));
    if (!p) throw new NotFoundException('Representante não encontrada.');
    const token = randomBytes(30).toString('base64url');
    await this.db.insert(portalAcessos).values({ pessoaId, tipo: 'link', hash: sha256(token), expiraEm: new Date(Date.now() + 7 * 86_400_000), criadoPor: u.id });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'gerar_link_portal', entidade: 'pessoa', entidadeId: pessoaId });
    return { token, caminho: `/portal/entrar/${token}`, telefone: p.telefone1, nome: p.nome };
  }

  // ───── Área da representante ─────

  @RotaPortal()
  @Get('eu')
  async eu(@Representante() r: RepresentanteLogada) {
    const [p] = await this.db.select({ p: pessoas, nivel: niveis.nome }).from(pessoas).leftJoin(niveis, eq(niveis.id, pessoas.nivelId)).where(eq(pessoas.id, r.rep));
    const sit = await this.maletasSvc.situacao(r.rep);
    const proximas = await this.db
      .select({ id: titulos.id, descricao: titulos.descricao, valor: titulos.valor, vencimento: titulos.vencimento })
      .from(titulos)
      .where(and(eq(titulos.pessoaId, r.rep), eq(titulos.tipo, 'receber'), eq(titulos.status, 'aberto')))
      .orderBy(asc(titulos.vencimento))
      .limit(3);
    const docs = await this.db.select({ id: documentos.id, titulo: documentos.titulo, token: documentos.token }).from(documentos).where(and(eq(documentos.pessoaId, r.rep), eq(documentos.status, 'pendente')));
    const abertas = await this.db.select({ id: maletas.id, numero: maletas.numero, dataLimite: maletas.dataLimite }).from(maletas).where(and(eq(maletas.representanteId, r.rep), eq(maletas.status, 'aberta'))).orderBy(asc(maletas.dataLimite));
    return {
      nome: p.p.nome,
      primeiroNome: p.p.nome.split(' ')[0],
      nivel: p.nivel,
      status: p.p.status,
      modeloTrabalho: p.p.modeloTrabalho,
      catalogo: p.p.slug && p.p.status === 'ativo' ? `/catalogo/${p.p.slug}` : null,
      credito: { limite: sit.limite, emMaletas: sit.emMaletas, livre: sit.creditoLivre, saldoCredito: sit.saldoCredito, bloqueado: sit.bloqueado, maiorAtrasoDias: sit.maiorAtrasoDias, vencido: sit.titulosVencidos },
      maletas: abertas,
      proximasParcelas: proximas,
      documentosPendentes: docs,
    };
  }

  @RotaPortal()
  @Get('maletas')
  async maletas(@Representante() r: RepresentanteLogada) {
    return this.db
      .select({
        id: maletas.id,
        numero: maletas.numero,
        status: maletas.status,
        dataRetirada: maletas.dataRetirada,
        dataLimite: maletas.dataLimite,
        acertadaEm: maletas.acertadaEm,
        valor: sql<number>`coalesce((select sum(mi.preco * mi.enviada) from maleta_itens mi where mi.maleta_id = ${maletas.id}),0)::int`,
      })
      .from(maletas)
      .where(and(eq(maletas.representanteId, r.rep), inArray(maletas.status, ['aberta', 'acertada'])))
      .orderBy(desc(maletas.numero))
      .limit(24);
  }

  private async minhaMaleta(r: RepresentanteLogada, id: string) {
    const m = await this.maletasSvc.obter(id);
    if (m.representanteId !== r.rep) throw new NotFoundException('Maleta não encontrada.');
    return m;
  }

  @RotaPortal()
  @Get('maletas/:id')
  async maleta(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    const m = await this.minhaMaleta(r, id);
    return {
      id: m.id,
      numero: m.numero,
      status: m.status,
      dataRetirada: m.dataRetirada,
      dataLimite: m.dataLimite,
      diasAtraso: m.diasAtraso,
      recebidaEm: m.recebidaEm,
      prebaixaEm: m.prebaixaEm,
      codigoRastreio: m.codigoRastreio,
      totais: m.totais,
      // sem custo: a representante vê só o preço de etiqueta
      itens: m.itens.map((i) => ({ produtoId: i.produtoId, referencia: i.referencia, descricao: i.descricao, foto: i.foto, preco: i.preco, enviada: i.enviada, vendida: i.vendida, devolvida: i.devolvida, naMaleta: i.naMaleta, prebaixaVendida: i.prebaixaVendida })),
      acertos: m.acertos.map((a) => ({ data: a.data, forma: a.forma, totalAPagar: a.totalAPagar, parcial: a.parcial, vendido: (a.resultado as { totalVendido?: number }).totalVendido ?? 0, comissao: (a.resultado as { comissao?: number }).comissao ?? 0 })),
    };
  }

  @RotaPortal()
  @Post('maletas/:id/recebida')
  async recebida(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    await this.minhaMaleta(r, id);
    await this.db.update(maletas).set({ recebidaEm: new Date() }).where(and(eq(maletas.id, id), isNull(maletas.recebidaEm)));
    return { ok: true };
  }

  /** Pré-baixa: a representante marca o que vendeu; a matriz confere no acerto. */
  @RotaPortal()
  @Post('maletas/:id/prebaixa')
  async prebaixa(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const m = await this.minhaMaleta(r, id);
    const d = validar(z.object({ itens: z.array(z.object({ produtoId: z.string().uuid(), vendida: z.number().int().min(0) })) }), body);
    const itens = d.itens.map((i) => {
      const it = m.itens.find((x) => x.produtoId === i.produtoId);
      if (!it) throw new NotFoundException('Peça não está nesta maleta.');
      const vendida = Math.min(i.vendida, it.naMaleta);
      return { produtoId: i.produtoId, vendida, devolvida: it.naMaleta - vendida };
    });
    return this.maletasSvc.prebaixa(id, itens, null);
  }

  @RotaPortal()
  @Get('financeiro')
  async financeiro(@Representante() r: RepresentanteLogada) {
    const lista = await this.db
      .select({ id: titulos.id, descricao: titulos.descricao, valor: titulos.valor, vencimento: titulos.vencimento, status: titulos.status, pagoEm: titulos.pagoEm, valorPago: titulos.valorPago, cobrancaTipo: titulos.cobrancaTipo, cobrancaUrl: titulos.cobrancaUrl, pixCopiaCola: titulos.pixCopiaCola })
      .from(titulos)
      .where(and(eq(titulos.pessoaId, r.rep), eq(titulos.tipo, 'receber'), inArray(titulos.status, ['aberto', 'pago'])))
      .orderBy(desc(titulos.vencimento))
      .limit(60);
    const desempenho = await this.db.execute<{ mes: string; acertos: number; vendido: string; comissao: string }>(sql`
      select to_char(a.data, 'YYYY-MM') as mes, count(*)::int as acertos, sum((a.resultado->>'totalVendido')::int)::bigint as vendido, sum((a.resultado->>'comissao')::int)::bigint as comissao
      from acertos a join maletas m on m.id = a.maleta_id
      where m.representante_id = ${r.rep} and a.data >= (current_date - interval '12 months')
      group by 1 order by 1 desc`);
    return { titulos: lista, asaasLigado: this.asaas.configurado, desempenho: desempenho.rows.map((x) => ({ mes: x.mes, acertos: x.acertos, vendido: Number(x.vendido), comissao: Number(x.comissao) })) };
  }

  /** Gera Pix (ou devolve o já gerado) para uma parcela dela. */
  @RotaPortal()
  @Post('financeiro/:id/pix')
  async pix(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    const [t] = await this.db.select().from(titulos).where(and(eq(titulos.id, id), eq(titulos.pessoaId, r.rep)));
    if (!t) throw new NotFoundException('Parcela não encontrada.');
    return this.asaas.cobrar(id, 'PIX', null);
  }

  /** Peças disponíveis na matriz para pedir (sem custo, sem quantidade exata). */
  @RotaPortal()
  @Get('catalogo')
  async catalogo(@Query('busca') busca?: string, @Query('categoria') categoria?: string) {
    const disponivel = sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo = 'deposito' and l.nome <> 'Avarias e garantia'),0)::int`;
    const f = [eq(produtos.ativo, true), eq(produtos.exibeCatalogo, true), sql`${disponivel} > 0`];
    if (busca?.trim()) f.push(sql`(${produtos.descricao} ilike ${'%' + busca.trim() + '%'} or ${produtos.referencia} ilike ${'%' + busca.trim() + '%'})`);
    if (categoria) f.push(eq(categorias.nome, categoria));
    const itens = await this.db
      .select({ id: produtos.id, referencia: produtos.referencia, descricao: produtos.descricao, categoria: categorias.nome, cor: produtos.cor, tamanho: produtos.tamanho, preco: produtos.preco, foto: sql<string | null>`${produtos.fotos}->>0`, poucas: sql<boolean>`${disponivel} <= 2` })
      .from(produtos)
      .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
      .where(and(...f))
      .orderBy(asc(categorias.nome), asc(produtos.descricao))
      .limit(120);
    const cats = await this.db.select({ nome: categorias.nome }).from(categorias).orderBy(asc(categorias.nome));
    return { itens, categorias: cats.map((c) => c.nome) };
  }

  @RotaPortal()
  @Get('pedidos')
  pedidos(@Representante() r: RepresentanteLogada) {
    return this.db.select().from(pedidosPecas).where(eq(pedidosPecas.pessoaId, r.rep)).orderBy(desc(pedidosPecas.criadoEm)).limit(30);
  }

  @RotaPortal()
  @Post('pedidos')
  async pedir(@Representante() r: RepresentanteLogada, @Body() body: unknown) {
    const d = validar(z.object({ itens: z.array(z.object({ produtoId: z.string().uuid(), quantidade: z.number().int().min(1).max(20) })).min(1, 'Escolha ao menos uma peça').max(100), observacao: z.string().max(500).nullable().optional() }), body);
    const abertos = await this.db.select({ n: sql<number>`count(*)::int` }).from(pedidosPecas).where(and(eq(pedidosPecas.pessoaId, r.rep), eq(pedidosPecas.status, 'novo')));
    if (abertos[0].n >= 3) throw new BadRequestException('Você já tem 3 pedidos aguardando a Aritana. Espere o retorno antes de pedir de novo.');
    const ps = await this.db.select({ id: produtos.id, referencia: produtos.referencia, descricao: produtos.descricao }).from(produtos).where(and(inArray(produtos.id, d.itens.map((i) => i.produtoId)), eq(produtos.ativo, true)));
    const itens = d.itens.map((i) => {
      const p = ps.find((x) => x.id === i.produtoId);
      if (!p) throw new BadRequestException('Peça indisponível.');
      return { produtoId: p.id, referencia: p.referencia, descricao: p.descricao, quantidade: i.quantidade };
    });
    const [ped] = await this.db.insert(pedidosPecas).values({ pessoaId: r.rep, itens, observacao: d.observacao ?? null }).returning();
    await this.auditoria.registrar({ acao: 'pedido_pecas', entidade: 'pessoa', entidadeId: r.rep, dados: { pedido: ped.numero, pecas: itens.length } });
    return ped;
  }

  // ───── Matriz: pedidos das representantes ─────

  @Get('admin/pedidos')
  @Permissao('maletas', 'ver')
  listarPedidos(@Query('status') status = 'novo') {
    return this.db
      .select({ id: pedidosPecas.id, numero: pedidosPecas.numero, pessoaId: pedidosPecas.pessoaId, representante: pessoas.nome, telefone: pessoas.telefone1, itens: pedidosPecas.itens, observacao: pedidosPecas.observacao, status: pedidosPecas.status, resposta: pedidosPecas.resposta, criadoEm: pedidosPecas.criadoEm, atendidoEm: pedidosPecas.atendidoEm })
      .from(pedidosPecas)
      .innerJoin(pessoas, eq(pessoas.id, pedidosPecas.pessoaId))
      .where(status === 'todos' ? undefined : eq(pedidosPecas.status, status))
      .orderBy(desc(pedidosPecas.criadoEm))
      .limit(200);
  }

  @Post('admin/pedidos/:id')
  @Permissao('maletas', 'editar')
  async responderPedido(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ status: z.enum(['atendido', 'recusado']), resposta: z.string().max(500).nullable().optional() }), body);
    const [p] = await this.db.update(pedidosPecas).set({ status: d.status, resposta: d.resposta ?? null, atendidoPor: u.id, atendidoEm: new Date() }).where(and(eq(pedidosPecas.id, id), eq(pedidosPecas.status, 'novo'))).returning();
    if (!p) throw new BadRequestException('Pedido não encontrado ou já respondido.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: d.status, entidade: 'pedido_pecas', entidadeId: id });
    return p;
  }
}

export { acertos };
