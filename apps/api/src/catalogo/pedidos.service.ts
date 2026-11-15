import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { gerarSlug } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { urlPublica } from '../comum/url';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { categorias, crmCanais, crmFunis, locaisEstoque, maletaItens, maletas, pedidosLink, pessoas, produtos, saldos } from '../db/schema';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { VendasService, type Forma } from '../vendas/vendas.service';

export type PedidoLink = typeof pedidosLink.$inferSelect;
type Origem = 'maleta' | 'matriz';

export interface PecaVitrine {
  id: string;
  referencia: string;
  descricao: string;
  categoria: string | null;
  cor: string | null;
  tamanho: string | null;
  preco: number;
  foto: string | null;
  disponivel: number;
}

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/**
 * Pedidos ainda em aberto. Seguram as peças no catálogo: o confirmado sempre; o novo (sem confirmação)
 * só por 3 dias, para um pedido esquecido ou falso não travar o catálogo.
 */
const RESERVAM = ['novo', 'confirmado'];

/**
 * Venda pelo link: a cliente monta o pedido no catálogo da consultora (ou da afiliada) e envia.
 * As peças vêm da maleta aberta dela; afiliada (ou consultora sem maleta) mostra o estoque da matriz.
 */
@Injectable()
export class PedidosLinkService implements OnModuleInit {
  private readonly log = new Logger('Pedidos pelo link');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfiguracoesService,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
    private readonly vendas: VendasService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Consultora cadastrada sem endereço de catálogo (cadastro antigo ou por planilha) ganha um, para o link funcionar. */
  async onModuleInit() {
    try {
      const sem = await this.db.select({ id: pessoas.id, nome: pessoas.nome }).from(pessoas).where(and(eq(pessoas.tipo, 'representante'), isNull(pessoas.slug)));
      if (!sem.length) return;
      const usados = new Set((await this.db.select({ s: pessoas.slug }).from(pessoas)).map((x) => x.s ?? ''));
      for (const p of sem) {
        const base = gerarSlug(p.nome) || 'representante';
        let slug = base;
        for (let k = 2; usados.has(slug); k++) slug = `${base}-${k}`;
        usados.add(slug);
        await this.db.update(pessoas).set({ slug }).where(and(eq(pessoas.id, p.id), isNull(pessoas.slug)));
      }
      this.log.log(`${sem.length} consultora(s) ganharam o endereço do catálogo.`);
    } catch (e) {
      this.log.warn(`Endereços de catálogo: ${(e as Error).message}`);
    }
  }

  regras() {
    return this.config.ler('regras_link');
  }

  /** Local do estoque da matriz que atende os pedidos (o configurado ou o primeiro depósito ativo). */
  async localMatriz() {
    const r = await this.regras();
    if (r.localId) {
      const [l] = await this.db.select().from(locaisEstoque).where(and(eq(locaisEstoque.id, r.localId), eq(locaisEstoque.ativo, true)));
      if (l) return l;
    }
    const [l] = await this.db.select().from(locaisEstoque).where(and(eq(locaisEstoque.tipo, 'deposito'), eq(locaisEstoque.ativo, true))).orderBy(asc(locaisEstoque.criadoEm)).limit(1);
    return l ?? null;
  }

  async consultoraPorSlug(slug: string) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new NotFoundException('Catálogo não encontrado.');
    const [rep] = await this.db.select().from(pessoas).where(and(eq(pessoas.slug, slug), eq(pessoas.tipo, 'representante'), eq(pessoas.status, 'ativo')));
    if (!rep) throw new NotFoundException('Catálogo não encontrado.');
    return rep;
  }

  /** De onde saem as peças desta consultora agora. */
  async origemDe(rep: typeof pessoas.$inferSelect): Promise<Origem | null> {
    if (rep.modeloTrabalho === 'afiliado') return 'matriz';
    const [aberta] = await this.db.select({ id: maletas.id }).from(maletas).where(and(eq(maletas.representanteId, rep.id), eq(maletas.status, 'aberta'))).limit(1);
    if (aberta) return 'maleta';
    return (await this.regras()).catalogoMatrizSemMaleta ? 'matriz' : null;
  }

  /** Quantas de cada peça os pedidos em aberto já seguram (mesma consultora para a maleta; todas para a matriz). */
  private async reservado(origem: Origem, pessoaId: string) {
    const r = await this.db.execute<{ produto_id: string; qtd: number }>(sql`
      select (i->>'produtoId')::uuid as produto_id, sum((i->>'quantidade')::int)::int as qtd
      from pedidos_link p, jsonb_array_elements(p.itens) i
      where (p.status = 'confirmado' or (p.status = 'novo' and p.criado_em > now() - interval '3 days')) and p.origem = ${origem} ${origem === 'maleta' ? sql`and p.pessoa_id = ${pessoaId}` : sql``}
      group by 1`);
    return new Map(r.rows.map((x) => [x.produto_id, x.qtd]));
  }

  /** Peças que a cliente pode pedir agora, com o que está livre (já descontado o que outros pedidos seguram). */
  async pecas(rep: typeof pessoas.$inferSelect, origem: Origem): Promise<PecaVitrine[]> {
    const campos = {
      id: produtos.id,
      referencia: produtos.referencia,
      descricao: produtos.descricao,
      categoria: categorias.nome,
      cor: produtos.cor,
      tamanho: produtos.tamanho,
      preco: produtos.preco,
      foto: sql<string | null>`${produtos.fotos}->>0`,
    };
    let lista: (PecaVitrine & { disponivel: number })[];
    if (origem === 'maleta') {
      const disp = sql<number>`sum(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida} - coalesce(${maletaItens.prebaixaVendida}, 0))::int`;
      lista = await this.db
        .select({ ...campos, disponivel: disp })
        .from(maletaItens)
        .innerJoin(maletas, eq(maletas.id, maletaItens.maletaId))
        .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
        .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
        .where(and(eq(maletas.representanteId, rep.id), eq(maletas.status, 'aberta'), eq(produtos.exibeCatalogo, true), eq(produtos.ativo, true)))
        .groupBy(produtos.id, categorias.nome)
        .orderBy(asc(categorias.nome), asc(produtos.descricao));
    } else {
      const local = await this.localMatriz();
      if (!local) return [];
      lista = await this.db
        .select({ ...campos, disponivel: saldos.quantidade })
        .from(saldos)
        .innerJoin(produtos, eq(produtos.id, saldos.produtoId))
        .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
        .where(and(eq(saldos.localId, local.id), sql`${saldos.quantidade} > 0`, eq(produtos.exibeCatalogo, true), eq(produtos.ativo, true)))
        .orderBy(asc(categorias.nome), asc(produtos.descricao))
        .limit(3000);
    }
    const reservas = await this.reservado(origem, rep.id);
    return lista.map((p) => ({ ...p, disponivel: Math.max(0, p.disponivel - (reservas.get(p.id) ?? 0)) })).filter((p) => p.disponivel > 0);
  }

  async criar(
    slug: string,
    d: { itens: { produtoId: string; quantidade: number }[]; nome: string; telefone: string; cidade?: string | null; entrega: 'retirar' | 'entregar' | 'combinar'; endereco?: string | null; observacao?: string | null },
    utm: Record<string, string>,
  ) {
    const regras = await this.regras();
    if (!regras.ativo) throw new BadRequestException('Os pedidos pelo catálogo estão pausados. Fale com a consultora pelo WhatsApp.');
    const rep = await this.consultoraPorSlug(slug);
    const origem = await this.origemDe(rep);
    if (!origem) throw new BadRequestException('Este catálogo não tem peças disponíveis agora.');
    if (d.entrega === 'entregar' && !regras.aceitaEntrega) throw new BadRequestException('Este catálogo não faz entrega: escolha retirar ou combinar.');
    if (d.entrega === 'entregar' && !d.endereco?.trim()) throw new BadRequestException({ mensagem: 'Informe o endereço para a entrega.', campos: { endereco: 'Obrigatório para entrega' } });
    // Preço e estoque sempre do servidor: o que vem do navegador é só a escolha.
    const pecas = new Map((await this.pecas(rep, origem)).map((p) => [p.id, p]));
    const juntos = new Map<string, number>();
    for (const i of d.itens) juntos.set(i.produtoId, (juntos.get(i.produtoId) ?? 0) + i.quantidade);
    const itens = [...juntos].map(([produtoId, quantidade]) => {
      const p = pecas.get(produtoId);
      if (!p) throw new BadRequestException('Uma das peças não está mais disponível. Atualize a página e confira o pedido.');
      if (quantidade > p.disponivel) throw new BadRequestException(`Só há ${p.disponivel} de "${p.descricao}" disponível.`);
      return { produtoId, referencia: p.referencia, descricao: p.descricao, preco: p.preco, quantidade };
    });
    const total = itens.reduce((a, i) => a + i.preco * i.quantidade, 0);
    const [pedido] = await this.db
      .insert(pedidosLink)
      .values({ pessoaId: rep.id, origem, clienteNome: d.nome, clienteTelefone: d.telefone, clienteCidade: d.cidade ?? null, entrega: d.entrega, endereco: d.entrega === 'entregar' ? (d.endereco ?? null) : null, observacao: d.observacao ?? null, itens, total, origemUtm: utm })
      .returning();
    // Card no CRM (funil de clientes) e aviso para a consultora; falha aqui não perde o pedido.
    await this.cardNoCrm(pedido, rep).catch((e) => this.log.warn(`Pedido ${pedido.numero}: card não criado (${(e as Error).message})`));
    await this.avisarConsultora(pedido, rep).catch((e) => this.log.warn(`Pedido ${pedido.numero}: aviso não enviado (${(e as Error).message})`));
    return { pedido, rep, mensagem: regras.mensagemFinal || null };
  }

  private async cardNoCrm(p: PedidoLink, rep: typeof pessoas.$inferSelect) {
    const [funil] = await this.db.select({ id: crmFunis.id }).from(crmFunis).where(and(eq(crmFunis.tipo, 'clientes'), eq(crmFunis.ativo, true))).orderBy(asc(crmFunis.ordem)).limit(1);
    const contato = await this.crm.garantirContato({ telefone: p.clienteTelefone, nome: p.clienteNome });
    if (!funil) return;
    const extras: Record<string, string> = { 'Pedido pelo link': `nº ${p.numero}`, Consultora: rep.nome };
    if (p.clienteCidade) extras.Cidade = p.clienteCidade;
    const lead = (await this.crm.leadAberto(contato.id, funil.id)) ?? (await this.crm.criarLead({ funilId: funil.id, contatoId: contato.id, titulo: p.clienteNome, valor: p.total, origem: { ...p.origemUtm, catalogo: rep.slug ?? '' }, camposExtras: extras }));
    await this.db.update(pedidosLink).set({ leadId: lead.id }).where(eq(pedidosLink.id, p.id));
    await this.crm.adicionarEtiqueta(lead.id, 'Pedido pelo link');
    await this.crm.evento(lead.id, 'sistema', `Pedido nº ${p.numero} pelo catálogo de ${rep.nome} (${p.origem === 'maleta' ? 'peças da maleta dela' : 'estoque da matriz'}): ${p.itens.map((i) => `${i.quantidade}× ${i.descricao}`).join(', ')} · ${reais(p.total)}.`);
  }

  private async canalPadrao() {
    const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(asc(crmCanais.criadoEm));
    return (cs.find((c) => c.tipo !== 'oficial') ?? cs[0])?.id ?? null;
  }

  private async whatsapp(telefone: string, nome: string, texto: string, pessoaId?: string | null) {
    const canalId = await this.canalPadrao();
    if (!canalId) throw new Error('nenhum número de WhatsApp ativo no CRM');
    const contato = await this.crm.garantirContato({ telefone, nome, pessoaId: pessoaId ?? null });
    const cv = await this.canais.garantirConversa(contato.id, canalId, 'resolvida');
    await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto });
  }

  private async avisarConsultora(p: PedidoLink, rep: typeof pessoas.$inferSelect) {
    if (!rep.telefone1) return;
    const primeiro = rep.nome.split(' ')[0];
    const lista = p.itens.map((i) => `• ${i.quantidade}× ${i.descricao} (${reais(i.preco)})`).join('\n');
    const quem = p.origem === 'maleta' ? 'Saem da sua maleta: confirme no portal e combine a entrega com ela.' : 'A Aritana separa e envia; você ganha a comissão quando a venda for faturada.';
    await this.whatsapp(rep.telefone1, rep.nome, `Oi, ${primeiro}! 🛍️ Pedido nº ${p.numero} pelo seu catálogo:\n${lista}\nTotal: ${reais(p.total)}\nCliente: ${p.clienteNome}${p.clienteCidade ? ` (${p.clienteCidade})` : ''}\n${quem}\n${urlPublica()}/portal/leads`, rep.id);
  }

  /** A cliente recebe a confirmação de que o pedido foi aceito e por quem será atendida. */
  private async avisarCliente(p: PedidoLink, texto: string) {
    await this.whatsapp(p.clienteTelefone, p.clienteNome, texto).catch((e) => this.log.warn(`Pedido ${p.numero}: aviso à cliente não foi (${(e as Error).message})`));
  }

  async obter(id: string) {
    const [p] = await this.db.select().from(pedidosLink).where(eq(pedidosLink.id, id));
    if (!p) throw new NotFoundException('Pedido não encontrado.');
    return p;
  }

  // ───── Consultora (portal): pedidos da maleta dela ─────

  async daConsultora(pessoaId: string) {
    return this.db
      .select()
      .from(pedidosLink)
      .where(and(eq(pedidosLink.pessoaId, pessoaId), sql`(${pedidosLink.status} in ('novo', 'confirmado') or ${pedidosLink.atualizadoEm} > now() - interval '30 days')`))
      .orderBy(desc(pedidosLink.criadoEm))
      .limit(100);
  }

  private async daPessoa(id: string, pessoaId: string) {
    const p = await this.obter(id);
    if (p.pessoaId !== pessoaId) throw new NotFoundException('Pedido não encontrado.');
    return p;
  }

  async confirmar(id: string, quem: { pessoaId?: string; usuarioId?: string }) {
    const p = quem.pessoaId ? await this.daPessoa(id, quem.pessoaId) : await this.obter(id);
    if (quem.pessoaId && p.origem !== 'maleta') throw new BadRequestException('Este pedido é atendido pela matriz.');
    if (p.status !== 'novo') throw new BadRequestException(p.status === 'cancelado' ? 'Este pedido foi cancelado.' : 'Este pedido já foi confirmado.');
    const [n] = await this.db.update(pedidosLink).set({ status: 'confirmado', confirmadoEm: new Date(), atualizadoEm: new Date() }).where(and(eq(pedidosLink.id, id), eq(pedidosLink.status, 'novo'))).returning();
    if (!n) throw new BadRequestException('Este pedido já foi atualizado.');
    const [rep] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, p.pessoaId));
    await this.avisarCliente(n, `Oi, ${p.clienteNome.split(' ')[0]}! Seu pedido nº ${p.numero} (${reais(p.total)}) foi confirmado. ${p.origem === 'maleta' ? `${rep?.nome.split(' ')[0] ?? 'A consultora'} vai combinar a entrega com você.` : 'A Aritana vai separar as peças e combinar a entrega.'}`);
    if (n.leadId) await this.crm.evento(n.leadId, 'sistema', `Pedido nº ${n.numero} confirmado.`, quem.usuarioId ?? null);
    return n;
  }

  /**
   * Consultora entregou o pedido da maleta: as peças entram como vendidas na pré-baixa da maleta
   * (a matriz confere no acerto, como qualquer venda dela).
   */
  async entregarDaMaleta(id: string, pessoaId: string) {
    const p = await this.daPessoa(id, pessoaId);
    if (p.origem !== 'maleta') throw new BadRequestException('Este pedido é atendido pela matriz.');
    if (!RESERVAM.includes(p.status)) throw new BadRequestException('Este pedido já foi encerrado.');
    return this.db.transaction(async (tx) => {
      const [trava] = await tx.update(pedidosLink).set({ status: 'entregue', entregueEm: new Date(), confirmadoEm: p.confirmadoEm ?? new Date(), atualizadoEm: new Date() }).where(and(eq(pedidosLink.id, id), inArray(pedidosLink.status, RESERVAM))).returning();
      if (!trava) throw new BadRequestException('Este pedido já foi atualizado.');
      for (const i of p.itens) {
        let falta = i.quantidade;
        const linhas = await tx
          .select({ id: maletaItens.id, maletaId: maletaItens.maletaId, livre: sql<number>`(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida} - coalesce(${maletaItens.prebaixaVendida}, 0))::int`, pv: maletaItens.prebaixaVendida })
          .from(maletaItens)
          .innerJoin(maletas, eq(maletas.id, maletaItens.maletaId))
          .where(and(eq(maletas.representanteId, pessoaId), eq(maletas.status, 'aberta'), eq(maletaItens.produtoId, i.produtoId)))
          .orderBy(asc(maletas.numero))
          .for('update', { of: maletaItens });
        for (const l of linhas) {
          if (falta <= 0) break;
          const usa = Math.min(falta, Math.max(0, l.livre));
          if (!usa) continue;
          await tx.update(maletaItens).set({ prebaixaVendida: (l.pv ?? 0) + usa }).where(eq(maletaItens.id, l.id));
          await tx.update(maletas).set({ prebaixaEm: new Date() }).where(eq(maletas.id, l.maletaId));
          falta -= usa;
        }
        if (falta > 0) throw new BadRequestException(`"${i.descricao}" não está mais na sua maleta (foi acertada ou devolvida). Fale com a Aritana.`);
      }
      await this.auditoria.registrar({ usuarioId: null, acao: 'entregar', entidade: 'pedido_link', entidadeId: id, dados: { pessoaId, itens: p.itens.length } }, tx);
      return trava;
    }).then(async (n) => {
      if (n.leadId) {
        await this.crm.evento(n.leadId, 'sistema', `Pedido nº ${n.numero} entregue pela consultora (peças marcadas como vendidas na maleta).`);
        await this.moverParaComprou(n.leadId);
      }
      return n;
    });
  }

  private async moverParaComprou(leadId: string) {
    const [l] = await this.db.execute<{ etapa_id: string }>(sql`select e.id as etapa_id from crm_leads l join crm_etapas e on e.funil_id = l.funil_id and e.chave = 'comprou' where l.id = ${leadId} and l.status = 'aberto'`).then((r) => r.rows);
    if (l) await this.crm.moverLead(leadId, l.etapa_id, { origem: 'automatico' }).catch(() => undefined);
  }

  async cancelar(id: string, motivo: string | null, quem: { pessoaId?: string; usuarioId?: string }) {
    const p = quem.pessoaId ? await this.daPessoa(id, quem.pessoaId) : await this.obter(id);
    if (quem.pessoaId && p.origem !== 'maleta') throw new BadRequestException('Este pedido é atendido pela matriz: peça para a equipe cancelar.');
    if (!RESERVAM.includes(p.status)) throw new BadRequestException('Este pedido já foi encerrado.');
    const [n] = await this.db.update(pedidosLink).set({ status: 'cancelado', motivoCancelamento: motivo, atualizadoEm: new Date() }).where(and(eq(pedidosLink.id, id), inArray(pedidosLink.status, RESERVAM))).returning();
    if (!n) throw new BadRequestException('Este pedido já foi atualizado.');
    if (n.leadId) await this.crm.evento(n.leadId, 'sistema', `Pedido nº ${n.numero} cancelado${motivo ? `: ${motivo}` : ''}.`, quem.usuarioId ?? null);
    await this.auditoria.registrar({ usuarioId: quem.usuarioId ?? null, acao: 'cancelar', entidade: 'pedido_link', entidadeId: id, dados: { motivo, pela: quem.pessoaId ? 'consultora' : 'equipe' } });
    return n;
  }

  // ───── Equipe: pedidos da matriz ─────

  /** Fatura o pedido da matriz: vira uma venda (sai do estoque) e entra na comissão da consultora no mês. */
  async faturar(id: string, pagamentos: { forma: Forma; valor: number; parcelas?: number }[], usuarioId: string) {
    const p = await this.obter(id);
    if (p.origem !== 'matriz') throw new BadRequestException('Pedido da maleta é entregue pela própria consultora.');
    if (!RESERVAM.includes(p.status)) throw new BadRequestException('Este pedido já foi encerrado.');
    const local = await this.localMatriz();
    if (!local) throw new BadRequestException('Nenhum depósito ativo para tirar as peças. Configure em Vendas › Pedidos pelo link › Regras.');
    const ps = await this.db.select({ id: produtos.id, codigoBarras: produtos.codigoBarras, preco: produtos.preco }).from(produtos).where(inArray(produtos.id, p.itens.map((i) => i.produtoId)));
    const porId = new Map(ps.map((x) => [x.id, x]));
    // Vale o preço que a cliente viu no pedido: se a etiqueta subiu depois, a diferença entra como desconto;
    // se baixou, ela paga o preço novo (menor).
    let esperado = 0;
    const itens = p.itens.map((i) => {
      const x = porId.get(i.produtoId);
      if (!x?.codigoBarras) throw new BadRequestException(`"${i.descricao}" está sem código de barras.`);
      const desconto = Math.max(0, x.preco * i.quantidade - i.preco * i.quantidade);
      esperado += x.preco * i.quantidade - desconto;
      return { codigoBarras: x.codigoBarras, quantidade: i.quantidade, desconto };
    });
    // Um pagamento só, com o total do pedido, mas o preço baixou: ajusta para o valor certo.
    const pagos = pagamentos.length === 1 && pagamentos[0].valor > esperado && pagamentos[0].forma !== 'dinheiro' ? [{ ...pagamentos[0], valor: esperado }] : pagamentos;
    // Trava o pedido antes de vender: dois cliques em "Faturar" não viram duas vendas.
    const [trava] = await this.db.update(pedidosLink).set({ status: 'entregue', atualizadoEm: new Date() }).where(and(eq(pedidosLink.id, id), inArray(pedidosLink.status, RESERVAM))).returning({ id: pedidosLink.id });
    if (!trava) throw new BadRequestException('Este pedido já foi faturado ou cancelado.');
    let venda: Awaited<ReturnType<VendasService['registrar']>>;
    try {
      venda = await this.vendas.registrar({ localId: local.id, tipo: 'avulsa', itens, pagamentos: pagos, observacao: `Pedido pelo link nº ${p.numero}` }, usuarioId, true);
    } catch (e) {
      // Sem estoque, pagamento faltando…: o pedido volta a ficar em aberto.
      await this.db.update(pedidosLink).set({ status: p.status, atualizadoEm: new Date() }).where(eq(pedidosLink.id, id));
      throw e;
    }
    const [n] = await this.db.update(pedidosLink).set({ vendaId: venda.id, confirmadoEm: p.confirmadoEm ?? new Date(), entregueEm: new Date(), atualizadoEm: new Date() }).where(eq(pedidosLink.id, id)).returning();
    if (n.leadId) {
      await this.crm.evento(n.leadId, 'sistema', `Pedido nº ${n.numero} faturado (venda nº ${venda.numero}).`, usuarioId);
      await this.moverParaComprou(n.leadId);
    }
    await this.auditoria.registrar({ usuarioId, acao: 'faturar', entidade: 'pedido_link', entidadeId: id, dados: { vendaId: venda.id } });
    return { ...n, venda: { id: venda.id, numero: venda.numero } };
  }

  async listar(f: { status?: string; origem?: string }) {
    return this.db
      .select({ p: pedidosLink, consultora: pessoas.nome, modelo: pessoas.modeloTrabalho })
      .from(pedidosLink)
      .innerJoin(pessoas, eq(pessoas.id, pedidosLink.pessoaId))
      .where(and(f.status === 'abertos' ? inArray(pedidosLink.status, RESERVAM) : f.status ? eq(pedidosLink.status, f.status) : undefined, f.origem ? eq(pedidosLink.origem, f.origem) : undefined))
      .orderBy(desc(pedidosLink.criadoEm))
      .limit(300)
      .then((r) => r.map(({ p, consultora, modelo }) => ({ ...p, consultora, modelo })));
  }
}
