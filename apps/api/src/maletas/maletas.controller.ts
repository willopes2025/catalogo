import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, lt, sql, type SQL, or } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { dataISO, validar } from '../comum/validacao';
import { contas, maletaItens, maletas, pessoas, produtos, titulos } from '../db/schema';
import { ETAPAS_MALETA, MaletasService, hoje, type DadosAcerto } from './maletas.service';
import { BoletoPrebaixaService } from './boleto-prebaixa.service';
import { AvisarMaletaService } from './avisar-maleta.service';
import { AsaasService } from '../integracoes/asaas.service';
import { AuditoriaService } from '../comum/auditoria.service';
import { Limitador } from '../comum/limitador';

const acessosLink = new Limitador(120, 10 * 60_000, 'Muitos acessos a este link.');
import { somarDias } from '@aritana/regras';
import { buscaNome } from '../comum/busca-nome';

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
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: MaletasService, private readonly auditoria: AuditoriaService, private readonly asaas: AsaasService, private readonly avisar: AvisarMaletaService, private readonly prebaixaBoleto: BoletoPrebaixaService) {}

  @Get()
  @Permissao('maletas', 'ver')
  async listar(@Query('aba') aba = 'abertas', @Query('busca') busca?: string, @Query('representanteId') representanteId?: string, @Query('de') de?: string, @Query('ate') ate?: string, @Query('campoData') campoData?: string) {
    const h = hoje();
    const f: SQL[] = [];
    // Período: pela data de retirada (padrão), pelo prazo do acerto ou pelo dia em que foi baixado.
    const dia = /^\d{4}-\d{2}-\d{2}$/;
    const col = campoData === 'acerto' ? sql`${maletas.dataLimite}` : campoData === 'baixa' ? sql`(${maletas.acertadaEm} at time zone 'America/Sao_Paulo')::date` : sql`${maletas.dataRetirada}`;
    if (de && dia.test(de)) f.push(sql`${col} >= ${de}::date`);
    if (ate && dia.test(ate)) f.push(sql`${col} <= ${ate}::date`);
    const comPeriodo = !!((de && dia.test(de)) || (ate && dia.test(ate)));
    if (aba === 'abertas') f.push(eq(maletas.status, 'aberta'));
    if (aba === 'vencendo') f.push(eq(maletas.status, 'aberta'), gte(maletas.dataLimite, h), lte(maletas.dataLimite, somarDias(h, 7)));
    if (aba === 'atrasadas') f.push(eq(maletas.status, 'aberta'), lt(maletas.dataLimite, h));
    if (aba === 'acertadas') f.push(eq(maletas.status, 'acertada'));
    if (aba === 'canceladas') f.push(eq(maletas.status, 'cancelada'));
    if (representanteId) f.push(eq(maletas.representanteId, representanteId));
    if (busca?.trim()) {
      const n = Number(busca);
      f.push(or(buscaNome([pessoas.nome], busca), ...(Number.isInteger(n) && n > 0 ? [eq(maletas.numero, n)] : []))!);
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
        etapa: maletas.etapa,
        prebaixa: sql<boolean>`${maletas.prebaixaEm} is not null`,
        pecas: sql<number>`coalesce(sum(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida}),0)::int`,
        valor: sql<number>`coalesce(sum(${maletaItens.preco} * (${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})),0)::int`,
        valorEnviado: sql<number>`coalesce(sum(${maletaItens.preco} * ${maletaItens.enviada}),0)::int`,
        diasAtraso: sql<number>`case when ${maletas.status} = 'aberta' then greatest(${h}::date - ${maletas.dataLimite}, 0) else 0 end`,
        acertadaEm: maletas.acertadaEm,
        prebaixaPagaEm: maletas.prebaixaPagaEm,
        prebaixaBoleto: sql<boolean>`${maletas.prebaixaCobrancaId} is not null`,
      })
      .from(maletas)
      .innerJoin(pessoas, eq(pessoas.id, maletas.representanteId))
      .leftJoin(maletaItens, eq(maletaItens.maletaId, maletas.id))
      .where(f.length ? and(...f) : undefined)
      .groupBy(maletas.id, pessoas.id)
      .orderBy(aba === 'acertadas' || aba === 'canceladas' ? desc(maletas.numero) : maletas.dataLimite)
      .limit(comPeriodo ? 3000 : 300);
  }

  @Get('situacao/:representanteId')
  @Permissao('maletas', 'ver')
  situacao(@Param('representanteId', ParseUUIDPipe) id: string) {
    return this.svc.situacao(id);
  }

  /** Pedidos de autorização das maletas (para a gerência). */
  @Get('solicitacoes')
  @Permissao('maletas', 'ver')
  solicitacoes(@Query('status') status?: string, @Query('maletaId') maletaId?: string) {
    const st = ['pendente', 'aprovada', 'recusada', 'cancelada', 'todas'].includes(status ?? '') ? status! : 'pendente';
    return this.svc.solicitacoes(st, maletaId && /^[0-9a-f-]{36}$/i.test(maletaId) ? maletaId : undefined);
  }

  @Post('solicitacoes/:sid/decidir')
  @Permissao('maletas', 'excluir')
  decidirSolicitacao(@Usuario() u: UsuarioLogado, @Param('sid', ParseUUIDPipe) sid: string, @Body() body: unknown) {
    const d = validar(z.object({ aprovar: z.boolean(), observacao: z.string().trim().max(300).nullable().optional() }), body);
    return this.svc.decidirSolicitacao(sid, d.aprovar, d.observacao ?? null, u.id);
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

  /** Conferência peça por peça, na saída ou na volta (opcional). Fica no nome de quem está logado. */
  @Post(':id/conferencia')
  @Permissao('maletas', 'editar')
  async conferir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(
      z.object({
        tipo: z.enum(['saida', 'volta']),
        itens: z.array(z.object({ produtoId: z.string().uuid(), conferido: z.number().int().min(0).max(10_000) })).max(5000),
        sobras: z.array(z.object({ codigo: z.string().max(60), quantidade: z.number().int().min(1).max(10_000) })).max(500).default([]),
        observacao: z.string().max(1000).nullable().optional(),
        tratamento: z.enum(['nada', 'retirar', 'cobrar', 'investigar']).default('nada'),
      }),
      body,
    );
    const r = await this.svc.conferir(id, d, u.id);
    // Conferiu a saída: espera a retirada. Conferiu a volta: está em conferência.
    await this.svc.mudarEtapa(id, d.tipo === 'saida' ? 'aguardando_retirada' : 'em_conferencia', u.id, true);
    return r;
  }

  /** Onde a maleta está (criada, aguardando retirada, em trânsito, entregue, voltando, em conferência). */
  @Post(':id/etapa')
  @Permissao('maletas', 'editar')
  etapa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { etapa } = validar(z.object({ etapa: z.enum(ETAPAS_MALETA) }), body);
    return this.svc.mudarEtapa(id, etapa, u.id);
  }

  @Post(':id/simular-acerto')
  @Permissao('maletas', 'ver')
  simular(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.simular(id, validar(acertoSchema, body) as DadosAcerto);
  }

  @Post(':id/acerto')
  @Permissao('maletas', 'editar')
  async acertar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(acertoSchema, body) as DadosAcerto;
    const r = await this.svc.acertar(id, d, u.id);
    // O boleto de garantia deixa de valer no acerto (no parcial, o valor da maleta mudou).
    await this.asaas.cancelarGarantiaMaleta(id).catch(() => undefined);
    await this.asaas.cancelarPrebaixaMaleta(id).catch(() => undefined);
    // Acerto a pagar no boleto: já emite o boleto de cada parcela pela diferença (se o Asaas estiver ligado).
    const boletos: { tituloId: string; url?: string | null; erro?: string }[] = [];
    if (d.formaPagamento === 'boleto' && !d.pagoAgora && this.asaas.configurado) {
      const abertos = await this.db.select({ id: titulos.id }).from(titulos).where(and(eq(titulos.origemTipo, 'acerto'), eq(titulos.origemId, r.acerto.id), eq(titulos.status, 'aberto'))).orderBy(asc(titulos.vencimento));
      for (const t of abertos)
        try {
          const b = await this.asaas.cobrar(t.id, 'BOLETO', u.id);
          boletos.push({ tituloId: t.id, url: b.url });
        } catch (e) {
          boletos.push({ tituloId: t.id, erro: (e as Error).message });
        }
    }
    return { ...r, boletos };
  }

  /** Passa a maleta para outra consignatária (crédito conferido; promissória nova). */
  @Post(':id/consignataria')
  @Permissao('maletas', 'editar')
  trocarConsignataria(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ representanteId: z.string().uuid('Escolha a consignatária'), motivo: z.string().trim().min(3, 'Informe o motivo').max(300), liberarExcecao: z.boolean().optional() }), body);
    return this.svc.trocarConsignataria(id, d, u.id, temPermissao(u.permissoes, 'configuracoes', 'editar'));
  }

  /** Muda a data do acerto: a gerência (Maletas › excluir) muda direto; os outros pedem autorização. */
  @Post(':id/data-acerto')
  @Permissao('maletas', 'editar')
  mudarDataAcerto(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ dataLimite: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida'), motivo: z.string().trim().min(3, 'Informe o motivo').max(300) }), body);
    return this.svc.mudarDataAcerto(id, d, u.id, temPermissao(u.permissoes, 'maletas', 'excluir'));
  }

  /** Prévia da mensagem do fim (montagem, alterações, acerto) e para onde dá para mandar. */
  @Get(':id/aviso')
  @Permissao('maletas', 'ver')
  async previaAviso(@Param('id', ParseUUIDPipe) id: string, @Query('momento') momento: string) {
    const mo = validar(z.enum(['montagem', 'alteracao', 'acerto']), momento);
    const m = await this.avisar.montar(id, mo);
    return { assunto: m.assunto, texto: m.texto, email: m.email, telefone: m.telefone };
  }

  /** "Enviar e-mail?": manda a mensagem do fim por e-mail e/ou WhatsApp, uma vez, quando a equipe confirma. */
  @Post(':id/avisar')
  @Permissao('maletas', 'editar')
  enviarAviso(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ momento: z.enum(['montagem', 'alteracao', 'acerto']), email: z.boolean(), whatsapp: z.boolean() }), body);
    return this.avisar.enviar(id, d, u.id);
  }

  /** Boleto de garantia no lugar da promissória: valor atual da maleta, vence no acerto. */
  /** Boleto da pré-baixa: quanto ela deve pelas vendas lançadas (prévia). */
  @Get(':id/boleto-prebaixa')
  @Permissao('maletas', 'ver')
  previaPrebaixa(@Param('id', ParseUUIDPipe) id: string) {
    return this.prebaixaBoleto.calcular(id);
  }

  /** Emite o boleto da pré-baixa e manda no WhatsApp dela agora (sem esperar a rotina). */
  @Post(':id/boleto-prebaixa')
  @Permissao('maletas', 'editar')
  boletoPrebaixa(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.prebaixaBoleto.disparar(id, u.id);
  }

  @Post(':id/boleto-garantia')
  @Permissao('maletas', 'editar')
  boletoGarantia(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.asaas.boletoGarantiaMaleta(id, u.id);
  }

  /** Contas para receber o acerto (onde o dinheiro entrou). */
  @Get('recebimento/contas')
  @Permissao('maletas', 'editar')
  contasRecebimento() {
    return this.db.select({ id: contas.id, nome: contas.nome, tipo: contas.tipo }).from(contas).where(eq(contas.ativo, true)).orderBy(asc(contas.nome));
  }

  /** Dá baixa numa parcela do acerto pela própria maleta. */
  @Post(':id/receber')
  @Permissao('maletas', 'editar')
  async receber(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ tituloId: z.string().uuid(), formaPagamento: z.enum(['pix', 'dinheiro', 'debito', 'credito', 'deposito', 'boleto']), contaId: z.string().uuid().nullable().optional() }), body);
    const r = await this.svc.receberParcela(id, d, u.id);
    if (r.cobrancaAnterior) await this.asaas.informarPagamentoManual(r.cobrancaAnterior, r.pagoEm, r.valor);
    return { ok: true };
  }

  /** Gera Pix ou boleto (Asaas) de uma parcela do acerto. */
  @Post(':id/cobrar')
  @Permissao('maletas', 'editar')
  async cobrar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ tituloId: z.string().uuid(), tipo: z.enum(['PIX', 'BOLETO']) }), body);
    await this.db.transaction((tx) => this.svc.parcelaDoAcerto(tx, id, d.tituloId));
    return this.asaas.cobrar(d.tituloId, d.tipo, u.id);
  }

  /** Estorna o último acerto (só a gerência: quem pode excluir em Maletas). A maleta volta aberta. */
  @Post(':id/estornar-acerto')
  @Permissao('maletas', 'excluir')
  async estornarAcerto(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Informe o motivo') }), body);
    const r = await this.svc.estornarAcerto(id, motivo, u.id);
    for (const c of r.apagarNoAsaas) await this.asaas.cancelarCobranca(c);
    return { ok: true, parcelasCanceladas: r.parcelasCanceladas, viraCredito: r.viraCredito };
  }

  @Post(':id/cancelar')
  @Permissao('maletas', 'excluir')
  async cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().min(3, 'Informe o motivo') }), body);
    const r = await this.svc.cancelar(id, motivo, u.id);
    await this.asaas.cancelarGarantiaMaleta(id).catch(() => undefined);
    await this.asaas.cancelarPrebaixaMaleta(id).catch(() => undefined);
    return r;
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
