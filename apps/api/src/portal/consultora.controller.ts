import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Representante, RotaPortal, Usuario, type RepresentanteLogada, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AgendaService } from '../agenda/agenda.service';
import { MaletasService } from '../maletas/maletas.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { conteudoVistos, conteudos, consultoraVendas, maletas, pedidosPecas, pessoas, produtos, titulos, usuarios } from '../db/schema';
import { ConsultoraService } from './consultora.service';

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
const centavos = z.number().int().min(0);
const TIPOS_ARQUIVO: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/mpeg': 'mp3' };
const NOME_CONTEUDO = /^[0-9a-f]{32}\.(mp4|mov|webm|pdf|jpg|png|webp|mp3)$/;

/** Portal da consultora: clientes, vendas, cobrança, garantia, extrato, treinamentos, divulgação, acerto e perfil. */
@Controller('portal')
export class PortalConsultoraController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly svc: ConsultoraService,
    private readonly agenda: AgendaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  @RotaPortal() @Get('clientes')
  clientes(@Representante() r: RepresentanteLogada) {
    return this.svc.clientes(r.rep);
  }

  @RotaPortal() @Post('clientes')
  salvarCliente(@Representante() r: RepresentanteLogada, @Body() body: unknown) {
    const t = z.string().trim().max(120).nullable().optional();
    const d = validar(z.object({ id: z.string().uuid().optional(), nome: z.string().trim().min(2, 'Informe o nome').max(120), telefone: t, email: z.union([z.literal(''), z.string().email('E-mail inválido')]).nullable().optional(), documento: t, nascimento: data.nullable().optional().or(z.literal('')), cep: t, logradouro: t, numero: t, bairro: t, cidade: t, uf: z.string().max(2).nullable().optional(), observacao: z.string().max(500).nullable().optional() }), body);
    return this.svc.salvarCliente(r.rep, { ...d, nascimento: d.nascimento || null });
  }

  @RotaPortal() @Get('pecas-venda')
  pecas(@Representante() r: RepresentanteLogada, @Query('busca') busca?: string) {
    return this.svc.pecasParaVender(r.rep, busca);
  }

  @RotaPortal() @Get('vendas')
  vendas(@Representante() r: RepresentanteLogada, @Query('clienteId') clienteId?: string) {
    return this.svc.vendas(r.rep, clienteId && /^[0-9a-f-]{36}$/i.test(clienteId) ? clienteId : undefined);
  }

  @RotaPortal() @Post('vendas')
  lancar(@Representante() r: RepresentanteLogada, @Body() body: unknown) {
    const d = validar(
      z.object({
        clienteId: z.string().uuid('Escolha a cliente'),
        itens: z.array(z.object({ produtoId: z.string().uuid(), quantidade: z.number().int().min(1).max(50), origem: z.enum(['maleta', 'matriz']) })).min(1, 'Escolha ao menos uma peça').max(60),
        desconto: centavos.default(0),
        forma: z.enum(['avista', 'prazo']),
        formaPagamento: z.string().max(30).nullable().optional(),
        parcelas: z.array(z.object({ valor: centavos.min(1), vencimento: data })).max(12).default([]),
        entrega: z.enum(['frete', 'retirar']).nullable().optional(),
        enderecoEntrega: z.string().max(300).nullable().optional(),
        observacao: z.string().max(500).nullable().optional(),
      }),
      body,
    );
    return this.svc.lancarVenda(r.rep, d);
  }

  @RotaPortal() @Post('vendas/:id/parcelas/:numero')
  pago(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string, @Param('numero') numero: string, @Body() body: unknown) {
    const { pago } = validar(z.object({ pago: z.boolean() }), body);
    return this.svc.marcarPago(r.rep, id, Number(numero), pago);
  }

  @RotaPortal() @Post('vendas/:id/cancelar')
  cancelar(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.cancelarVenda(r.rep, id);
  }

  @RotaPortal() @Post('vendas/:id/promissoria')
  promissoria(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.promissoria(r.rep, id);
  }

  @RotaPortal() @Post('cobranca/aceite')
  aceite(@Representante() r: RepresentanteLogada) {
    return this.svc.aceitarCobranca(r.rep);
  }

  @RotaPortal() @Post('vendas/:id/cobranca')
  cobranca(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.acionarCobranca(r.rep, id);
  }

  @RotaPortal() @Get('garantias')
  garantias(@Representante() r: RepresentanteLogada) {
    return this.svc.garantias(r.rep);
  }

  @RotaPortal() @Post('garantias')
  abrirGarantia(@Representante() r: RepresentanteLogada, @Body() body: unknown) {
    const d = validar(z.object({ referencia: z.string().trim().min(2, 'Informe o código ou a referência da peça').max(60), defeito: z.string().trim().min(5, 'Conte o que aconteceu').max(1000), clienteId: z.string().uuid().nullable().optional(), dataCompra: data.nullable().optional(), fotos: z.array(z.string().max(6_000_000)).max(4).default([]) }), body);
    return this.svc.abrirGarantia(r.rep, d);
  }

  @RotaPortal() @Get('extrato')
  extrato(@Representante() r: RepresentanteLogada) {
    return this.svc.extrato(r.rep);
  }

  @RotaPortal() @Get('perfil')
  perfil(@Representante() r: RepresentanteLogada) {
    return this.svc.perfil(r.rep);
  }

  @RotaPortal() @Patch('perfil')
  salvarPerfil(@Representante() r: RepresentanteLogada, @Body() body: unknown) {
    const t = z.string().max(160).nullable().optional();
    const d = validar(z.object({ email: z.union([z.literal(''), z.string().email('E-mail inválido')]).nullable().optional(), cep: t, logradouro: t, numero: t, complemento: t, bairro: t, cidade: t, uf: z.string().max(2).nullable().optional(), chavePix: t, asaasWalletId: z.union([z.literal(''), z.string().uuid('O Wallet ID do Asaas tem o formato 0000aaaa-00aa-...')]).nullable().optional() }), body);
    return this.svc.salvarPerfil(r.rep, d);
  }

  /** Treinamentos e divulgação, com o que ela já viu. */
  @RotaPortal() @Get('conteudos')
  async conteudosPortal(@Representante() r: RepresentanteLogada, @Query('secao') secao = 'treinamento') {
    const lista = await this.db.select().from(conteudos).where(and(eq(conteudos.secao, secao === 'divulgacao' ? 'divulgacao' : 'treinamento'), eq(conteudos.ativo, true))).orderBy(asc(conteudos.categoria), asc(conteudos.ordem), desc(conteudos.criadoEm));
    const vistos = new Set((await this.db.select({ id: conteudoVistos.conteudoId }).from(conteudoVistos).where(eq(conteudoVistos.pessoaId, r.rep))).map((v) => v.id));
    return lista.map((c) => ({ ...c, url: `/api/publico/conteudos/${c.arquivo}`, visto: vistos.has(c.id) }));
  }

  @RotaPortal() @Post('conteudos/:id/visto')
  async visto(@Representante() r: RepresentanteLogada, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.insert(conteudoVistos).values({ conteudoId: id, pessoaId: r.rep }).onConflictDoNothing();
    return { ok: true };
  }

  /** Pede um horário para o acerto (presencial, por vídeo) ou avisa que vai mandar a maleta pelo correio. */
  @RotaPortal() @Post('acerto/agendar')
  async agendar(@Representante() r: RepresentanteLogada, @Body() body: unknown) {
    const d = validar(z.object({ maletaId: z.string().uuid(), forma: z.enum(['presencial', 'video', 'envio']), data: data, hora: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida'), observacao: z.string().max(300).nullable().optional() }), body);
    const [m] = await this.db.select().from(maletas).where(and(eq(maletas.id, d.maletaId), eq(maletas.representanteId, r.rep), eq(maletas.status, 'aberta')));
    if (!m) throw new NotFoundException('Maleta não encontrada.');
    // Responsável: quem montou a maleta; sem isso, o primeiro usuário ativo da gestão.
    const [resp] = m.usuarioId ? [{ id: m.usuarioId }] : await this.db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.ativo, true)).orderBy(asc(usuarios.criadoEm)).limit(1);
    const inicio = new Date(`${d.data}T${d.hora}:00-03:00`);
    const nomes = { presencial: 'presencial', video: 'por vídeo', envio: 'pelo correio (envio da maleta)' };
    const c = await this.agenda.criar(
      { tipo: d.forma === 'video' ? 'acerto_video' : 'retirada', titulo: `Acerto ${nomes[d.forma]} · maleta nº ${m.numero} (pedido pela consultora)`, inicio, duracaoMin: 45, online: d.forma === 'video', maletaId: m.id, pessoaId: r.rep, responsavelId: resp?.id ?? null, observacao: `Pedido pela consultora no portal${d.observacao ? `: ${d.observacao}` : ''}. Confirme com ela.`, avisar: false, forcar: true },
      resp?.id ?? '',
    );
    if (d.forma === 'envio') await this.db.update(maletas).set({ etapa: 'voltando', etapaEm: new Date() }).where(eq(maletas.id, m.id));
    return { ok: true, id: c.id };
  }
}

/** Telas da matriz: treinamentos/divulgação, vendas das consultoras em cobrança e pedidos de venda do catálogo. */
@Controller()
export class ConsultoraAdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly svc: ConsultoraService,
    private readonly arquivos: ArquivosService,
    private readonly maletasSvc: MaletasService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  private get dirConteudos() {
    return join(this.arquivos.dir, 'conteudos');
  }

  /** Arquivo dos treinamentos e da divulgação (nome sorteado, sem dado pessoal; o vídeo precisa abrir no player). */
  @Publico()
  @Get('publico/conteudos/:arquivo')
  arquivo(@Param('arquivo') arquivo: string, @Res() res: Response) {
    const c = NOME_CONTEUDO.test(arquivo) ? join(this.dirConteudos, arquivo) : null;
    if (!c || !existsSync(c)) throw new NotFoundException('Arquivo não encontrado.');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(c);
  }

  @Get('conteudos')
  @Permissao('configuracoes', 'ver')
  async lista(@Query('secao') secao?: string) {
    const l = await this.db.select().from(conteudos).where(secao ? eq(conteudos.secao, secao) : undefined).orderBy(asc(conteudos.secao), asc(conteudos.categoria), asc(conteudos.ordem));
    const vistos = await this.db.select({ id: conteudoVistos.conteudoId, n: sql<number>`count(*)::int` }).from(conteudoVistos).groupBy(conteudoVistos.conteudoId);
    return l.map((c) => ({ ...c, url: `/api/publico/conteudos/${c.arquivo}`, vistos: vistos.find((v) => v.id === c.id)?.n ?? 0 }));
  }

  /** Envio do arquivo (vídeo grande vai direto para o disco, sem passar pela memória). Corpo cru; tipo no cabeçalho. */
  @Post('conteudos/arquivo')
  @Permissao('configuracoes', 'editar')
  async subir(@Req() req: Request) {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = TIPOS_ARQUIVO[mime];
    if (!ext) throw new BadRequestException('Tipo de arquivo não aceito. Use vídeo MP4/MOV/WEBM, PDF, imagem JPG/PNG/WEBP ou áudio MP3.');
    await mkdir(this.dirConteudos, { recursive: true });
    const nome = `${randomBytes(16).toString('hex')}.${ext}`;
    const tmp = join(this.dirConteudos, `.${nome}.tmp`);
    const LIMITE = 2 * 1024 * 1024 * 1024;
    let tamanho = 0;
    await new Promise<void>((ok, erro) => {
      const out = createWriteStream(tmp);
      req.on('data', (b: Buffer) => {
        tamanho += b.length;
        if (tamanho > LIMITE) {
          req.destroy();
          erro(new BadRequestException('Arquivo maior que 2 GB.'));
        }
      });
      req.pipe(out);
      out.on('finish', () => ok());
      out.on('error', erro);
      req.on('error', erro);
    }).catch(async (e) => {
      await unlink(tmp).catch(() => undefined);
      throw e;
    });
    if (!tamanho) {
      await unlink(tmp).catch(() => undefined);
      throw new BadRequestException('Arquivo vazio.');
    }
    await rename(tmp, join(this.dirConteudos, nome));
    return { arquivo: nome, mime, tamanho: (await stat(join(this.dirConteudos, nome))).size };
  }

  @Post('conteudos')
  @Permissao('configuracoes', 'editar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ secao: z.enum(['treinamento', 'divulgacao']), categoria: z.string().trim().min(2).max(40), titulo: z.string().trim().min(2, 'Dê um título').max(120), descricao: z.string().max(1000).nullable().optional(), legenda: z.string().max(2200).nullable().optional(), arquivo: z.string().regex(NOME_CONTEUDO, 'Envie o arquivo antes'), mime: z.string().max(60), tamanho: z.number().int().min(0), ordem: z.number().int().default(0) }), body);
    const [c] = await this.db.insert(conteudos).values({ ...d, usuarioId: u.id }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'conteudo', entidadeId: c.id, dados: { secao: d.secao, titulo: d.titulo } });
    return c;
  }

  @Patch('conteudos/:id')
  @Permissao('configuracoes', 'editar')
  async editar(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ categoria: z.string().trim().min(2).max(40).optional(), titulo: z.string().trim().min(2).max(120).optional(), descricao: z.string().max(1000).nullable().optional(), legenda: z.string().max(2200).nullable().optional(), ordem: z.number().int().optional(), ativo: z.boolean().optional() }), body);
    const [c] = await this.db.update(conteudos).set(d).where(eq(conteudos.id, id)).returning();
    if (!c) throw new NotFoundException('Conteúdo não encontrado.');
    return c;
  }

  @Delete('conteudos/:id')
  @Permissao('configuracoes', 'editar')
  async apagar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [c] = await this.db.delete(conteudos).where(eq(conteudos.id, id)).returning();
    if (c) await unlink(join(this.dirConteudos, c.arquivo)).catch(() => undefined);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'apagar', entidade: 'conteudo', entidadeId: id });
    return { ok: true };
  }

  /** Foto que a consultora mandou na garantia (pasta de mídia, só com permissão de garantia). */
  @Get('consultoras/garantia-foto/:nome')
  @Permissao('garantia', 'ver')
  fotoGarantia(@Param('nome') nome: string, @Res() res: Response) {
    const c = this.arquivos.caminhoMidia(nome);
    if (!c || !existsSync(c)) throw new NotFoundException('Foto não encontrada.');
    res.sendFile(c);
  }

  /** Vendas das consultoras (a matriz acompanha as que estão em cobrança). */
  @Get('consultoras/vendas')
  @Permissao('cobranca', 'ver')
  async vendasConsultoras(@Query('status') status?: string) {
    const lista = await this.db
      .select({ v: consultoraVendas, cliente: pessoas.nome })
      .from(consultoraVendas)
      .innerJoin(pessoas, eq(pessoas.id, consultoraVendas.clienteId))
      .where(status ? eq(consultoraVendas.status, status) : undefined)
      .orderBy(desc(consultoraVendas.criadoEm))
      .limit(300);
    const ids = [...new Set(lista.map((x) => x.v.consultoraId))];
    const nomes = ids.length ? await this.db.select({ id: pessoas.id, nome: pessoas.nome }).from(pessoas).where(inArray(pessoas.id, ids)) : [];
    return lista.map((x) => ({ ...x.v, cliente: x.cliente, consultora: nomes.find((n) => n.id === x.v.consultoraId)?.nome ?? '' }));
  }

  @Post('consultoras/cobranca/:tituloId/recebido-por-fora')
  @Permissao('cobranca', 'excluir')
  porFora(@Usuario() u: UsuarioLogado, @Param('tituloId', ParseUUIDPipe) tituloId: string) {
    return this.svc.recebidoPorFora(tituloId, u.id);
  }

  /**
   * Pedido de venda do catálogo (peça que não estava na maleta): ao atender, a peça entra na maleta aberta da
   * consultora já como vendida (é cobrada no acerto). Sem maleta aberta, vira um título para ela pagar em 30 dias.
   */
  @Post('consultoras/pedidos-venda/:id/atender')
  @Permissao('maletas', 'editar')
  async atenderVenda(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { resposta } = validar(z.object({ resposta: z.string().max(500).nullable().optional() }), body ?? {});
    const [ped] = await this.db.select().from(pedidosPecas).where(and(eq(pedidosPecas.id, id), eq(pedidosPecas.tipo, 'venda'), eq(pedidosPecas.status, 'novo')));
    if (!ped) throw new BadRequestException('Pedido não encontrado ou já atendido.');
    const [m] = await this.db.select().from(maletas).where(and(eq(maletas.representanteId, ped.pessoaId), eq(maletas.status, 'aberta'))).orderBy(desc(maletas.criadoEm)).limit(1);
    const prods = await this.db.select({ id: produtos.id, codigoBarras: produtos.codigoBarras, preco: produtos.preco, empresaId: sql<string>`(select id from empresas where tipo = 'matriz' limit 1)` }).from(produtos).where(inArray(produtos.id, ped.itens.map((i) => i.produtoId)));
    let como: string;
    if (m) {
      await this.maletasSvc.incluirItens(m.id, ped.itens.map((i) => ({ codigoBarras: prods.find((p) => p.id === i.produtoId)!.codigoBarras, quantidade: i.quantidade })), u.id, true, true);
      for (const i of ped.itens) await this.db.execute(sql`update maleta_itens set prebaixa_vendida = coalesce(prebaixa_vendida, 0) + ${i.quantidade} where maleta_id = ${m.id} and produto_id = ${i.produtoId}`);
      como = `entrou na maleta nº ${m.numero} como vendida (cobrada no acerto)`;
    } else {
      const regras = await this.config.regrasDaRepresentante(ped.pessoaId);
      const bruto = ped.itens.reduce((a, i) => a + (prods.find((p) => p.id === i.produtoId)?.preco ?? 0) * i.quantidade, 0);
      const valor = Math.round((bruto * (10000 - regras.comissaoAvistaPb)) / 10000);
      const venc = new Date(Date.now() - 3 * 3600_000 + 30 * 86400_000).toISOString().slice(0, 10);
      await this.db.insert(titulos).values({ empresaId: prods[0].empresaId, tipo: 'receber', pessoaId: ped.pessoaId, descricao: `Peças do catálogo vendidas (pedido nº ${ped.numero})`, categoria: 'Venda para consultora', valor, vencimento: venc, status: 'aberto', origemTipo: 'pedido_venda', origemId: ped.id });
      como = `virou um título de ${(valor / 100).toFixed(2)} para a consultora (já com a comissão), vencendo em 30 dias`;
    }
    await this.db.update(pedidosPecas).set({ status: 'atendido', resposta: resposta ?? null, atendidoPor: u.id, atendidoEm: new Date() }).where(eq(pedidosPecas.id, id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'atender_pedido_venda', entidade: 'pedido_pecas', entidadeId: id, dados: { como } });
    return { ok: true, como };
  }
}
