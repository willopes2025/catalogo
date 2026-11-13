import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, lte, lt, sql, type SQL, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { dataISO, validar } from '../comum/validacao';
import { maletaItens, maletas, pessoas, produtos } from '../db/schema';
import { MaletasService, hoje, type DadosAcerto } from './maletas.service';
import { AuditoriaService } from '../comum/auditoria.service';
import { Limitador } from '../comum/limitador';

const acessosLink = new Limitador(120, 10 * 60_000, 'Muitos acessos a este link.');
import { somarDias } from '@aritana/regras';

const itensSchema = z.array(z.object({ codigoBarras: z.string().trim().min(1), quantidade: z.number().int().positive().default(1) })).min(1, 'Inclua ao menos uma peça');

const criarSchema = z.object({
  representanteId: z.string().uuid('Escolha a representante'),
  origemId: z.string().uuid('Escolha o local de onde as peças saem'),
  dataRetirada: dataISO.optional(),
  entrega: z.enum(['retirada', 'envio']).default('retirada'),
  observacao: z.string().max(1000).optional().nullable(),
  observacaoInterna: z.string().max(1000).optional().nullable(),
  itens: itensSchema,
  liberarExcecao: z.boolean().optional(),
});

const qtd = z.number().int().min(0);
const acertoSchema = z.object({
  forma: z.enum(['avista', 'prazo']),
  modalidade: z.enum(['presencial', 'video', 'envio']).default('presencial'),
  parcial: z.boolean().default(false),
  dataAcerto: dataISO.optional(),
  itens: z.array(z.object({ produtoId: z.string().uuid(), vendida: qtd, devolvida: qtd, perdida: qtd })),
  parcelas: z.number().int().min(1).default(1),
  primeiroVencimento: dataISO.optional(),
  formaPagamento: z.enum(['pix', 'boleto', 'cartao', 'dinheiro']).default('pix'),
  pagoAgora: z.boolean().default(false),
  usarCredito: z.boolean().default(true),
});

const prebaixaSchema = z.object({ itens: z.array(z.object({ produtoId: z.string().uuid(), vendida: qtd, devolvida: qtd })) });

@Controller('maletas')
export class MaletasController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: MaletasService, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('maletas', 'ver')
  async listar(@Query('aba') aba = 'abertas', @Query('busca') busca?: string, @Query('representanteId') representanteId?: string) {
    const h = hoje();
    const f: SQL[] = [];
    if (aba === 'abertas') f.push(eq(maletas.status, 'aberta'));
    if (aba === 'vencendo') f.push(eq(maletas.status, 'aberta'), gte(maletas.dataLimite, h), lte(maletas.dataLimite, somarDias(h, 7)));
    if (aba === 'atrasadas') f.push(eq(maletas.status, 'aberta'), lt(maletas.dataLimite, h));
    if (aba === 'acertadas') f.push(eq(maletas.status, 'acertada'));
    if (aba === 'canceladas') f.push(eq(maletas.status, 'cancelada'));
    if (representanteId) f.push(eq(maletas.representanteId, representanteId));
    if (busca?.trim()) {
      const n = Number(busca);
      f.push(or(ilike(pessoas.nome, `%${busca.trim()}%`), ...(Number.isInteger(n) && n > 0 ? [eq(maletas.numero, n)] : []))!);
    }
    return this.db
      .select({
        id: maletas.id,
        numero: maletas.numero,
        representante: pessoas.nome,
        representanteId: pessoas.id,
        cidade: pessoas.cidade,
        status: maletas.status,
        dataRetirada: maletas.dataRetirada,
        dataLimite: maletas.dataLimite,
        entrega: maletas.entrega,
        conferida: maletas.conferida,
        prebaixa: sql<boolean>`${maletas.prebaixaEm} is not null`,
        pecas: sql<number>`coalesce(sum(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida}),0)::int`,
        valor: sql<number>`coalesce(sum(${maletaItens.preco} * (${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})),0)::int`,
        valorEnviado: sql<number>`coalesce(sum(${maletaItens.preco} * ${maletaItens.enviada}),0)::int`,
        diasAtraso: sql<number>`case when ${maletas.status} = 'aberta' then greatest(${h}::date - ${maletas.dataLimite}, 0) else 0 end`,
      })
      .from(maletas)
      .innerJoin(pessoas, eq(pessoas.id, maletas.representanteId))
      .leftJoin(maletaItens, eq(maletaItens.maletaId, maletas.id))
      .where(f.length ? and(...f) : undefined)
      .groupBy(maletas.id, pessoas.id)
      .orderBy(aba === 'acertadas' || aba === 'canceladas' ? desc(maletas.numero) : maletas.dataLimite)
      .limit(300);
  }

  @Get('situacao/:representanteId')
  @Permissao('maletas', 'ver')
  situacao(@Param('representanteId', ParseUUIDPipe) id: string) {
    return this.svc.situacao(id);
  }

  @Get(':id')
  @Permissao('maletas', 'ver')
  obter(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.obter(id);
  }

  @Post()
  @Permissao('maletas', 'criar')
  criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    return this.svc.criar(validar(criarSchema, body), u.id, temPermissao(u.permissoes, 'configuracoes', 'editar'));
  }

  @Post(':id/incluir')
  @Permissao('maletas', 'editar')
  incluir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ itens: itensSchema, liberarExcecao: z.boolean().optional() }), body);
    return this.svc.incluirItens(id, d.itens, u.id, temPermissao(u.permissoes, 'configuracoes', 'editar'), d.liberarExcecao);
  }

  @Post(':id/retirar')
  @Permissao('maletas', 'editar')
  retirar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.retirarItens(id, validar(z.object({ itens: itensSchema }), body).itens, u.id);
  }

  @Post(':id/prebaixa')
  @Permissao('maletas', 'editar')
  prebaixa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.prebaixa(id, validar(prebaixaSchema, body).itens, u.id);
  }

  @Post(':id/simular-acerto')
  @Permissao('maletas', 'ver')
  simular(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.simular(id, validar(acertoSchema, body) as DadosAcerto);
  }

  @Post(':id/acerto')
  @Permissao('maletas', 'editar')
  acertar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.acertar(id, validar(acertoSchema, body) as DadosAcerto, u.id);
  }

  @Post(':id/cancelar')
  @Permissao('maletas', 'excluir')
  cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().min(3, 'Informe o motivo') }), body);
    return this.svc.cancelar(id, motivo, u.id);
  }

  @Post(':id/envio')
  @Permissao('maletas', 'editar')
  async envio(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { codigoRastreio } = validar(z.object({ codigoRastreio: z.string().trim().min(5).max(40) }), body);
    const [r] = await this.db.update(maletas).set({ codigoRastreio, entrega: 'envio' }).where(and(eq(maletas.id, id), eq(maletas.status, 'aberta'))).returning({ id: maletas.id });
    if (!r) throw new NotFoundException('Maleta aberta não encontrada.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'envio', entidade: 'maleta', entidadeId: id, dados: { codigoRastreio } });
    return { ok: true };
  }
}

/**
 * Link do pedido: a representante abre pelo WhatsApp, sem login.
 * Mostra só os dados da própria maleta e permite confirmar o recebimento e informar a pré-baixa.
 */
@Controller('publico/maletas')
export class MaletaPublicaController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: MaletasService) {}

  private async porToken(token: string) {
    acessosLink.usar(token.slice(0, 40));
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new NotFoundException('Link inválido.');
    const [m] = await this.db.select({ id: maletas.id }).from(maletas).where(eq(maletas.linkToken, token));
    if (!m) throw new NotFoundException('Link inválido ou expirado.');
    return m.id;
  }

  @Publico()
  @Get(':token')
  async ver(@Param('token') token: string) {
    const m = await this.svc.obter(await this.porToken(token));
    return {
      numero: m.numero,
      representante: m.representante,
      status: m.status,
      dataRetirada: m.dataRetirada,
      dataLimite: m.dataLimite,
      diasAtraso: m.diasAtraso,
      recebidaEm: m.recebidaEm,
      codigoRastreio: m.codigoRastreio,
      prebaixaEm: m.prebaixaEm,
      totais: m.totais,
      itens: m.itens.filter((i) => i.naMaleta > 0).map((i) => ({ produtoId: i.produtoId, referencia: i.referencia, descricao: i.descricao, foto: i.foto, preco: i.preco, quantidade: i.naMaleta, prebaixaVendida: i.prebaixaVendida })),
    };
  }

  @Publico()
  @Post(':token/recebida')
  async recebida(@Param('token') token: string) {
    const id = await this.porToken(token);
    await this.db.update(maletas).set({ recebidaEm: new Date() }).where(and(eq(maletas.id, id), sql`${maletas.recebidaEm} is null`));
    return { ok: true };
  }

  @Publico()
  @Post(':token/prebaixa')
  async prebaixa(@Param('token') token: string, @Body() body: unknown) {
    const id = await this.porToken(token);
    const d = validar(z.object({ itens: z.array(z.object({ produtoId: z.string().uuid(), vendida: qtd })) }), body);
    const m = await this.svc.obter(id);
    const itens = d.itens.map((i) => {
      const it = m.itens.find((x) => x.produtoId === i.produtoId);
      if (!it) throw new NotFoundException('Peça não está nesta maleta.');
      const vendida = Math.min(i.vendida, it.naMaleta);
      return { produtoId: i.produtoId, vendida, devolvida: it.naMaleta - vendida };
    });
    return this.svc.prebaixa(id, itens, null);
  }
}

export { produtos };
