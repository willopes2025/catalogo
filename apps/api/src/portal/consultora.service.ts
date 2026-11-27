import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { formatarReais, reaisPorExtenso } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { AsaasService } from '../integracoes/asaas.service';
import { MaletasService, hoje } from '../maletas/maletas.service';
import { PlanoContasService } from '../financeiro/plano.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { consultoraVendas, creditos, documentos, empresas, maletaItens, maletas, ordensServico, pedidosPecas, pessoas, produtos, titulos } from '../db/schema';

type Venda = typeof consultoraVendas.$inferSelect;
export interface NovaVenda {
  clienteId: string;
  itens: { produtoId: string; quantidade: number; origem: 'maleta' | 'matriz' }[];
  desconto: number;
  forma: 'avista' | 'prazo';
  formaPagamento?: string | null;
  parcelas: { valor: number; vencimento: string }[];
  entrega?: 'frete' | 'retirar' | null;
  enderecoEntrega?: string | null;
  observacao?: string | null;
}

const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const dataBR = (d: string) => d.split('-').reverse().join('/');

/**
 * Portal da consultora: carteira de clientes, vendas para a cliente final (da maleta ou do catálogo da matriz),
 * promissória da cliente, cobrança passada à Aritana (boleto com split), garantia e extrato.
 * A venda e a dívida da cliente são da consultora; a Aritana só entra quando ela aciona a cobrança.
 */
@Injectable()
export class ConsultoraService {
  private readonly log = new Logger('Consultora');
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfiguracoesService,
    private readonly asaas: AsaasService,
    private readonly maletasSvc: MaletasService,
    private readonly plano: PlanoContasService,
    private readonly arquivos: ArquivosService,
  ) {}

  // ───── Clientes da consultora ─────

  async clientes(rep: string) {
    const lista = await this.db
      .select({ id: pessoas.id, nome: pessoas.nome, telefone: pessoas.telefone1, email: pessoas.email, documento: pessoas.documento, nascimento: pessoas.nascimento, cidade: pessoas.cidade, logradouro: pessoas.logradouro, numero: pessoas.numero, bairro: pessoas.bairro, cep: pessoas.cep, uf: pessoas.uf, observacao: pessoas.observacao })
      .from(pessoas)
      .where(and(eq(pessoas.tipo, 'cliente'), eq(pessoas.representanteId, rep)))
      .orderBy(asc(pessoas.nome))
      .limit(1000);
    const vendas = await this.db.select().from(consultoraVendas).where(and(eq(consultoraVendas.consultoraId, rep), inArray(consultoraVendas.status, ['aberta', 'em_cobranca'])));
    const h = hoje();
    const deve = new Map<string, { aberto: number; vencido: number; emCobranca: number }>();
    for (const v of vendas)
      for (const p of v.parcelas)
        if (!p.pagoEm) {
          const d = deve.get(v.clienteId) ?? { aberto: 0, vencido: 0, emCobranca: 0 };
          if (v.status === 'em_cobranca') d.emCobranca += p.valor;
          else {
            d.aberto += p.valor;
            if (p.vencimento < h) d.vencido += p.valor;
          }
          deve.set(v.clienteId, d);
        }
    const mmdd = h.slice(5);
    return lista.map((c) => ({ ...c, ...(deve.get(c.id) ?? { aberto: 0, vencido: 0, emCobranca: 0 }), aniversarioHoje: !!c.nascimento && c.nascimento.slice(5) === mmdd }));
  }

  private async clienteDela(rep: string, clienteId: string) {
    const [c] = await this.db.select().from(pessoas).where(and(eq(pessoas.id, clienteId), eq(pessoas.tipo, 'cliente'), eq(pessoas.representanteId, rep)));
    if (!c) throw new NotFoundException('Cliente não encontrada na sua carteira.');
    return c;
  }

  async salvarCliente(rep: string, d: { id?: string; nome: string; telefone?: string | null; email?: string | null; documento?: string | null; nascimento?: string | null; cep?: string | null; logradouro?: string | null; numero?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; observacao?: string | null }) {
    const doc = d.documento ? d.documento.replace(/\D/g, '') : null;
    const dados = {
      nome: d.nome.trim(),
      telefone1: d.telefone?.replace(/\D/g, '') || null,
      email: d.email?.trim() || null,
      documento: doc || null,
      tipoDocumento: doc && doc.length === 14 ? 'cnpj' : 'cpf',
      nascimento: d.nascimento || null,
      cep: d.cep?.replace(/\D/g, '') || null,
      logradouro: d.logradouro || null,
      numero: d.numero || null,
      bairro: d.bairro || null,
      cidade: d.cidade || null,
      uf: d.uf?.toUpperCase() || null,
      observacao: d.observacao || null,
    } as const;
    if (d.id) {
      await this.clienteDela(rep, d.id);
      const [c] = await this.db.update(pessoas).set({ ...dados, atualizadoEm: new Date() }).where(eq(pessoas.id, d.id)).returning({ id: pessoas.id });
      return c;
    }
    const [c] = await this.db.insert(pessoas).values({ ...dados, tipo: 'cliente', representanteId: rep, status: 'ativo' }).returning({ id: pessoas.id });
    await this.auditoria.registrar({ acao: 'criar', entidade: 'pessoa', entidadeId: c.id, dados: { tipo: 'cliente', pelaConsultora: rep } });
    return c;
  }

  // ───── Peças para vender (maleta + catálogo da matriz) ─────

  async pecasParaVender(rep: string, busca?: string) {
    const [m] = await this.db.select().from(maletas).where(and(eq(maletas.representanteId, rep), eq(maletas.status, 'aberta'))).orderBy(desc(maletas.criadoEm)).limit(1);
    const naMaleta = m
      ? await this.db
          .select({ produtoId: maletaItens.produtoId, referencia: produtos.referencia, descricao: produtos.descricao, preco: maletaItens.preco, foto: sql<string | null>`${produtos.fotos}->>0`, disponivel: sql<number>`(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida} - coalesce(${maletaItens.prebaixaVendida}, 0))::int` })
          .from(maletaItens)
          .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
          .where(eq(maletaItens.maletaId, m.id))
      : [];
    const termo = busca?.trim();
    const daMaleta = naMaleta.filter((i) => i.disponivel > 0 && (!termo || `${i.referencia} ${i.descricao}`.toLowerCase().includes(termo.toLowerCase())));
    const matriz = termo && termo.length >= 2
      ? await this.db
          .select({ produtoId: produtos.id, referencia: produtos.referencia, descricao: produtos.descricao, preco: produtos.preco, foto: sql<string | null>`${produtos.fotos}->>0` })
          .from(produtos)
          .where(and(eq(produtos.ativo, true), eq(produtos.exibeCatalogo, true), sql`(${produtos.descricao} ilike ${'%' + termo + '%'} or ${produtos.referencia} ilike ${'%' + termo + '%'})`, sql`coalesce((select sum(s.quantidade) from saldos s join locais_estoque l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo = 'deposito'), 0) > 0`))
          .orderBy(asc(produtos.descricao))
          .limit(40)
      : [];
    return { maletaId: m?.id ?? null, maleta: daMaleta, matriz: matriz.filter((x) => !daMaleta.some((d) => d.produtoId === x.produtoId)) };
  }

  // ───── Vendas ─────

  async vendas(rep: string, clienteId?: string) {
    return this.db
      .select({ v: consultoraVendas, cliente: pessoas.nome, telefone: pessoas.telefone1 })
      .from(consultoraVendas)
      .innerJoin(pessoas, eq(pessoas.id, consultoraVendas.clienteId))
      .where(and(eq(consultoraVendas.consultoraId, rep), clienteId ? eq(consultoraVendas.clienteId, clienteId) : undefined))
      .orderBy(desc(consultoraVendas.criadoEm))
      .limit(300)
      .then((r) => r.map((x) => ({ ...x.v, cliente: x.cliente, telefone: x.telefone })));
  }

  private async vendaDela(rep: string, id: string) {
    const [v] = await this.db.select().from(consultoraVendas).where(and(eq(consultoraVendas.id, id), eq(consultoraVendas.consultoraId, rep)));
    if (!v) throw new NotFoundException('Venda não encontrada.');
    return v;
  }

  async lancarVenda(rep: string, d: NovaVenda) {
    await this.clienteDela(rep, d.clienteId);
    const pecas = await this.pecasParaVender(rep);
    const ids = d.itens.map((i) => i.produtoId);
    const prods = await this.db.select({ id: produtos.id, referencia: produtos.referencia, descricao: produtos.descricao, preco: produtos.preco, ativo: produtos.ativo }).from(produtos).where(inArray(produtos.id, ids));
    const itens = d.itens.map((i) => {
      const p = prods.find((x) => x.id === i.produtoId);
      if (!p || !p.ativo) throw new BadRequestException('Peça indisponível.');
      if (i.origem === 'maleta') {
        const m = pecas.maleta.find((x) => x.produtoId === i.produtoId);
        if (!m || m.disponivel < i.quantidade) throw new BadRequestException(`"${p.descricao}" não tem ${i.quantidade} na sua maleta.`);
        return { produtoId: p.id, referencia: p.referencia, descricao: p.descricao, quantidade: i.quantidade, preco: m.preco, origem: 'maleta' as const };
      }
      return { produtoId: p.id, referencia: p.referencia, descricao: p.descricao, quantidade: i.quantidade, preco: p.preco, origem: 'matriz' as const };
    });
    const bruto = itens.reduce((a, i) => a + i.preco * i.quantidade, 0);
    if (d.desconto < 0 || d.desconto > bruto) throw new BadRequestException('Desconto inválido.');
    const total = bruto - d.desconto;
    const doMatriz = itens.filter((i) => i.origem === 'matriz');
    if (doMatriz.length && !d.entrega) throw new BadRequestException('Escolha como a peça da matriz chega: frete para a cliente ou você retira.');
    if (d.entrega === 'frete' && !d.enderecoEntrega?.trim()) throw new BadRequestException('Informe o endereço de entrega da cliente.');
    let parcelas: Venda['parcelas'];
    if (d.forma === 'avista') parcelas = [{ numero: 1, valor: total, vencimento: hoje(), pagoEm: hoje() }];
    else {
      if (!d.parcelas.length) throw new BadRequestException('Informe as parcelas.');
      if (d.parcelas.reduce((a, p) => a + p.valor, 0) !== total) throw new BadRequestException(`A soma das parcelas precisa dar ${formatarReais(total)}.`);
      parcelas = d.parcelas.map((p, i) => ({ numero: i + 1, valor: p.valor, vencimento: p.vencimento, pagoEm: null }));
    }
    return this.db.transaction(async (tx) => {
      const [v] = await tx
        .insert(consultoraVendas)
        .values({ consultoraId: rep, clienteId: d.clienteId, itens, total, desconto: d.desconto, forma: d.forma, formaPagamento: d.formaPagamento ?? null, parcelas, status: d.forma === 'avista' ? 'quitada' : 'aberta', maletaId: pecas.maletaId, observacao: d.observacao ?? null })
        .returning();
      // Peças da maleta: entram como vendidas na pré-baixa (o acerto já vem com elas marcadas).
      for (const i of itens.filter((x) => x.origem === 'maleta'))
        await tx.update(maletaItens).set({ prebaixaVendida: sql`coalesce(${maletaItens.prebaixaVendida}, 0) + ${i.quantidade}` }).where(and(eq(maletaItens.maletaId, pecas.maletaId!), eq(maletaItens.produtoId, i.produtoId)));
      if (itens.some((x) => x.origem === 'maleta')) await tx.update(maletas).set({ prebaixaEm: new Date() }).where(eq(maletas.id, pecas.maletaId!));
      // Peças do catálogo: pedido para a matriz enviar (frete) ou separar para a consultora retirar.
      if (doMatriz.length) {
        const [ped] = await tx
          .insert(pedidosPecas)
          .values({ pessoaId: rep, tipo: 'venda', vendaId: v.id, entrega: d.entrega ?? 'retirar', enderecoEntrega: d.entrega === 'frete' ? d.enderecoEntrega!.trim() : null, itens: doMatriz.map((i) => ({ produtoId: i.produtoId, referencia: i.referencia, descricao: i.descricao, quantidade: i.quantidade })), observacao: `Venda nº ${v.numero} para a cliente${d.observacao ? ` · ${d.observacao}` : ''}` })
          .returning();
        await tx.update(consultoraVendas).set({ pedidoMatrizId: ped.id }).where(eq(consultoraVendas.id, v.id));
      }
      await this.auditoria.registrar({ acao: 'venda_consultora', entidade: 'pessoa', entidadeId: rep, dados: { venda: v.numero, total, pecas: itens.length } }, tx);
      return v;
    });
  }

  async marcarPago(rep: string, id: string, numero: number, pago: boolean) {
    const v = await this.vendaDela(rep, id);
    if (v.status === 'em_cobranca') throw new ForbiddenException('Esta venda está com a Aritana para cobrança: você não pode mais receber da cliente.');
    if (v.status === 'cancelada') throw new BadRequestException('Venda cancelada.');
    const parcelas = v.parcelas.map((p) => (p.numero === numero ? { ...p, pagoEm: pago ? hoje() : null } : p));
    const quitada = parcelas.every((p) => p.pagoEm);
    await this.db.update(consultoraVendas).set({ parcelas, status: quitada ? 'quitada' : 'aberta' }).where(eq(consultoraVendas.id, id));
    return { ok: true };
  }

  async cancelarVenda(rep: string, id: string) {
    const v = await this.vendaDela(rep, id);
    if (v.status === 'em_cobranca') throw new ForbiddenException('Venda em cobrança pela Aritana não pode ser cancelada por aqui. Fale com a Aritana.');
    if (v.status === 'cancelada') return { ok: true };
    await this.db.transaction(async (tx) => {
      if (v.maletaId)
        for (const i of v.itens.filter((x) => x.origem === 'maleta'))
          await tx.update(maletaItens).set({ prebaixaVendida: sql`greatest(coalesce(${maletaItens.prebaixaVendida}, 0) - ${i.quantidade}, 0)` }).where(and(eq(maletaItens.maletaId, v.maletaId), eq(maletaItens.produtoId, i.produtoId)));
      if (v.pedidoMatrizId) await tx.update(pedidosPecas).set({ status: 'recusado', resposta: 'Venda cancelada pela consultora' }).where(and(eq(pedidosPecas.id, v.pedidoMatrizId), eq(pedidosPecas.status, 'novo')));
      await tx.update(consultoraVendas).set({ status: 'cancelada' }).where(eq(consultoraVendas.id, id));
    });
    return { ok: true };
  }

  // ───── Promissória da cliente ─────

  async promissoria(rep: string, id: string) {
    const v = await this.vendaDela(rep, id);
    if (v.forma !== 'prazo') throw new BadRequestException('Promissória é para venda a prazo.');
    const [c] = await this.db.select().from(pessoas).where(eq(pessoas.id, v.clienteId));
    const [cons] = await this.db.select().from(pessoas).where(eq(pessoas.id, rep));
    if (v.promissoriaId) {
      const [d] = await this.db.select().from(documentos).where(eq(documentos.id, v.promissoriaId));
      if (d && d.status !== 'cancelado') return { id: d.id, token: d.token, status: d.status, telefone: c.telefone1, nome: c.nome };
    }
    const abertas = v.parcelas.filter((p) => !p.pagoEm);
    const total = abertas.reduce((a, p) => a + p.valor, 0);
    const titulo = `Nota promissória · venda nº ${v.numero}`;
    const conteudo = [
      `NOTA PROMISSÓRIA`,
      ``,
      `Valor: ${formatarReais(total)} (${reaisPorExtenso(total)}).`,
      ``,
      `Eu, ${c.nome}${c.documento ? `, CPF/CNPJ ${c.documento}` : ''}${c.logradouro ? `, residente em ${[c.logradouro, c.numero, c.bairro, c.cidade, c.uf].filter(Boolean).join(', ')}` : ''}, pagarei a ${cons.nome}${cons.documento ? `, CPF ${cons.documento}` : ''}, ou à sua ordem, a quantia acima, referente à compra de semijoias Aritana (venda nº ${v.numero}), nas seguintes parcelas:`,
      ...abertas.map((p) => `• Parcela ${p.numero}: ${formatarReais(p.valor)} com vencimento em ${dataBR(p.vencimento)}`),
      ``,
      `Peças: ${v.itens.map((i) => `${i.quantidade}x ${i.descricao}`).join('; ')}.`,
      ``,
      `Em caso de atraso, a cobrança poderá ser feita pela Aritana Semijoias, por boleto bancário, em nome da credora.`,
      ``,
      `Data: ${dataBR(hoje())}`,
    ].join('\n');
    const [d] = await this.db.insert(documentos).values({ tipo: 'promissoria_venda', pessoaId: c.id, titulo, conteudo, hash: sha256(`${titulo}\n\n${conteudo}`), token: randomBytes(24).toString('base64url'), enviadoPara: c.email }).returning();
    await this.db.update(consultoraVendas).set({ promissoriaId: d.id }).where(eq(consultoraVendas.id, v.id));
    await this.auditoria.registrar({ acao: 'gerar_documento', entidade: 'documento', entidadeId: d.id, dados: { tipo: 'promissoria_venda', venda: v.numero, consultora: rep } });
    return { id: d.id, token: d.token, status: d.status, telefone: c.telefone1, nome: c.nome };
  }

  // ───── Cobrança passada à Aritana ─────

  async aceitarCobranca(rep: string) {
    await this.db.update(pessoas).set({ aceiteCobrancaEm: new Date() }).where(and(eq(pessoas.id, rep), sql`${pessoas.aceiteCobrancaEm} is null`));
    await this.auditoria.registrar({ acao: 'aceite_cobranca', entidade: 'pessoa', entidadeId: rep });
    return { ok: true };
  }

  /**
   * A consultora passa a cobrança para a Aritana: as parcelas em aberto viram títulos da Aritana com boleto para a
   * cliente. Com Wallet ID, a parte da consultora vai por split; sem, vira crédito quando a cliente pagar.
   */
  async acionarCobranca(rep: string, id: string) {
    const v = await this.vendaDela(rep, id);
    if (v.status !== 'aberta') throw new BadRequestException(v.status === 'em_cobranca' ? 'Esta venda já está com a Aritana.' : `Esta venda está ${v.status}.`);
    const [cons] = await this.db.select().from(pessoas).where(eq(pessoas.id, rep));
    if (!cons.aceiteCobrancaEm) throw new BadRequestException({ mensagem: 'Leia e aceite o termo do serviço de cobrança antes.', precisaAceite: true });
    const c = await this.clienteDela(rep, v.clienteId);
    if (!c.documento || !c.logradouro || !c.cep) throw new BadRequestException('Para a Aritana emitir o boleto, complete o cadastro da cliente: CPF, endereço e CEP.');
    const abertas = v.parcelas.filter((p) => !p.pagoEm);
    if (!abertas.length) throw new BadRequestException('Não há parcela em aberto.');
    const cfg = await this.config.ler('portal_consultora');
    const [emp] = await this.db.select({ id: empresas.id }).from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    const parteConsultora = 10000 - cfg.taxaCobrancaPb;
    const split = cons.asaasWalletId && parteConsultora > 0 ? [{ walletId: cons.asaasWalletId, percentualValue: parteConsultora / 100 }] : undefined;
    const plano = await this.plano.daChave('recebimentos');
    const novas = [...v.parcelas];
    for (const p of abertas) {
      const [t] = await this.db
        .insert(titulos)
        .values({ empresaId: emp.id, tipo: 'receber', pessoaId: c.id, descricao: `Venda nº ${v.numero} de ${cons.nome.split(' ')[0]} (${p.numero}/${v.parcelas.length})`, categoria: 'Cobrança para consultora', ...plano, valor: p.valor, vencimento: p.vencimento < hoje() ? hoje() : p.vencimento, parcela: p.numero, totalParcelas: v.parcelas.length, formaPagamento: 'boleto', status: 'aberto', origemTipo: 'cobranca_consultora', origemId: v.id })
        .returning();
      const i = novas.findIndex((x) => x.numero === p.numero);
      novas[i] = { ...p, tituloId: t.id, split: !!split } as Venda['parcelas'][number];
      if (this.asaas.configurado)
        await this.asaas.cobrar(t.id, 'BOLETO', null, undefined, { split }).catch((e) => this.log.warn(`Boleto da venda ${v.numero}: ${(e as Error).message}`));
    }
    await this.db.update(consultoraVendas).set({ parcelas: novas, status: 'em_cobranca', cobrancaEm: new Date() }).where(eq(consultoraVendas.id, v.id));
    await this.auditoria.registrar({ acao: 'acionar_cobranca', entidade: 'pessoa', entidadeId: rep, dados: { venda: v.numero, parcelas: abertas.length, split: !!split, taxaPb: cfg.taxaCobrancaPb } });
    return { ok: true, split: !!split, parcelas: abertas.length };
  }

  /** A cliente pagou um título de cobrança da consultora: marca a parcela e, sem split, credita a parte dela. */
  async aoPagarTitulo(tituloId: string) {
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, tituloId));
    if (!t || t.origemTipo !== 'cobranca_consultora' || t.status !== 'pago' || !t.origemId) return;
    const [v] = await this.db.select().from(consultoraVendas).where(eq(consultoraVendas.id, t.origemId));
    if (!v) return;
    const p = v.parcelas.find((x) => x.tituloId === t.id) as (Venda['parcelas'][number] & { split?: boolean }) | undefined;
    if (!p || p.pagoEm) return;
    const parcelas = v.parcelas.map((x) => (x.tituloId === t.id ? { ...x, pagoEm: t.pagoEm ?? hoje() } : x));
    await this.db.update(consultoraVendas).set({ parcelas, status: parcelas.every((x) => x.pagoEm) ? 'quitada' : v.status }).where(eq(consultoraVendas.id, v.id));
    if (!p.split) {
      const cfg = await this.config.ler('portal_consultora');
      const parte = Math.round(((t.valorPago ?? t.valor) * (10000 - cfg.taxaCobrancaPb)) / 10000);
      if (parte > 0) await this.db.insert(creditos).values({ pessoaId: v.consultoraId, valor: parte, descricao: `Cobrança recebida: venda nº ${v.numero}, parcela ${p.numero} (já descontada a taxa do serviço)`, origemTipo: 'cobranca_consultora', origemId: t.id });
    }
  }

  /** A matriz descobre que a consultora recebeu por fora uma parcela em cobrança: cancela o boleto e desconta dela. */
  async recebidoPorFora(tituloId: string, usuarioId: string) {
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, tituloId));
    if (!t || t.origemTipo !== 'cobranca_consultora' || !t.origemId) throw new NotFoundException('Título de cobrança de consultora não encontrado.');
    if (t.status !== 'aberto') throw new BadRequestException(`O título está ${t.status}.`);
    const [v] = await this.db.select().from(consultoraVendas).where(eq(consultoraVendas.id, t.origemId));
    await this.db.update(titulos).set({ status: 'cancelado' }).where(eq(titulos.id, t.id));
    await this.asaas.cancelarCobranca(t.cobrancaExternaId);
    await this.db.insert(creditos).values({ pessoaId: v.consultoraId, valor: -t.valor, descricao: `Recebeu da cliente por fora a parcela em cobrança (venda nº ${v.numero}): descontado da comissão`, origemTipo: 'cobranca_consultora', origemId: t.id, usuarioId });
    const parcelas = v.parcelas.map((x) => (x.tituloId === t.id ? { ...x, pagoEm: hoje() } : x));
    await this.db.update(consultoraVendas).set({ parcelas, status: parcelas.every((x) => x.pagoEm) ? 'quitada' : v.status }).where(eq(consultoraVendas.id, v.id));
    await this.auditoria.registrar({ usuarioId, acao: 'recebido_por_fora', entidade: 'titulo', entidadeId: t.id, dados: { venda: v.numero, valor: t.valor } });
    return { ok: true };
  }

  // ───── Garantia ─────

  async abrirGarantia(rep: string, d: { referencia: string; defeito: string; clienteId?: string | null; dataCompra?: string | null; fotos: string[] }) {
    const [p] = await this.db.select({ id: produtos.id }).from(produtos).where(sql`${produtos.referencia} = ${d.referencia.trim()} or ${produtos.codigoBarras} = ${d.referencia.trim()}`).limit(1);
    if (d.clienteId) await this.clienteDela(rep, d.clienteId);
    const fotos: string[] = [];
    for (const f of d.fotos.slice(0, 4)) {
      const b = Buffer.from(f.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (b[0] !== 0xff || b[1] !== 0xd8) throw new BadRequestException('As fotos precisam ser JPEG.');
      fotos.push(await this.arquivos.salvarMidia(b, 'image/jpeg'));
    }
    const [os] = await this.db
      .insert(ordensServico)
      .values({ tipo: 'garantia', status: 'aberta', representanteId: rep, clienteId: d.clienteId ?? null, produtoId: p?.id ?? null, dataCompra: d.dataCompra ?? null, defeito: `${d.defeito.trim()}${p ? '' : ` (peça informada: ${d.referencia.trim()})`}`, fotos, origem: 'portal' })
      .returning({ id: ordensServico.id, numero: ordensServico.numero });
    await this.auditoria.registrar({ acao: 'abrir_garantia', entidade: 'os', entidadeId: os.id, dados: { pelaConsultora: rep } });
    return os;
  }

  async garantias(rep: string) {
    return this.db
      .select({ id: ordensServico.id, numero: ordensServico.numero, status: ordensServico.status, decisao: ordensServico.decisao, defeito: ordensServico.defeito, criadoEm: ordensServico.criadoEm, produto: produtos.descricao })
      .from(ordensServico)
      .leftJoin(produtos, eq(produtos.id, ordensServico.produtoId))
      .where(eq(ordensServico.representanteId, rep))
      .orderBy(desc(ordensServico.criadoEm))
      .limit(50);
  }

  // ───── Extrato: comissões e créditos ─────

  async extrato(rep: string) {
    const acs = await this.db.execute<{ id: string; data: string; numero: number; vendido: string; comissao: string }>(sql`
      select a.id, a.data::text as data, m.numero, (a.resultado->>'totalVendido')::bigint as vendido, (a.resultado->>'comissao')::bigint as comissao
      from acertos a join maletas m on m.id = a.maleta_id
      where m.representante_id = ${rep}
      order by a.data desc limit 60`);
    const cred = await this.db.select().from(creditos).where(eq(creditos.pessoaId, rep)).orderBy(desc(creditos.criadoEm)).limit(100);
    const saldo = cred.reduce((a, c) => a + c.valor, 0);
    return {
      acertos: acs.rows.map((a) => ({ id: a.id, data: a.data, maleta: a.numero, vendido: Number(a.vendido ?? 0), comissao: Number(a.comissao ?? 0) })),
      creditos: cred.map((c) => ({ id: c.id, data: c.criadoEm, valor: c.valor, descricao: c.descricao })),
      saldoCredito: saldo,
    };
  }

  // ───── Perfil ─────

  async perfil(rep: string) {
    const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, rep));
    const docs = await this.db
      .select({ id: documentos.id, tipo: documentos.tipo, titulo: documentos.titulo, status: documentos.status, token: documentos.token, assinadoEm: documentos.assinadoEm, criadoEm: documentos.criadoEm })
      .from(documentos)
      .where(and(eq(documentos.pessoaId, rep), sql`${documentos.status} <> 'cancelado'`))
      .orderBy(desc(documentos.criadoEm))
      .limit(50);
    const cfg = await this.config.ler('portal_consultora');
    return {
      nome: p.nome,
      email: p.email,
      telefone: p.telefone1,
      cep: p.cep,
      logradouro: p.logradouro,
      numero: p.numero,
      complemento: p.complemento,
      bairro: p.bairro,
      cidade: p.cidade,
      uf: p.uf,
      chavePix: p.chavePix,
      asaasWalletId: p.asaasWalletId,
      aceiteCobrancaEm: p.aceiteCobrancaEm,
      documentos: docs,
      whatsappMatriz: cfg.whatsappMatriz || null,
      taxaCobrancaPb: cfg.taxaCobrancaPb,
      termoCobranca: cfg.termoCobranca,
    };
  }

  async salvarPerfil(rep: string, d: { email?: string | null; cep?: string | null; logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; chavePix?: string | null; asaasWalletId?: string | null }) {
    const set = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    if ('uf' in set && set.uf) set.uf = String(set.uf).toUpperCase();
    if ('cep' in set && set.cep) set.cep = String(set.cep).replace(/\D/g, '');
    await this.db.update(pessoas).set({ ...set, atualizadoEm: new Date() }).where(eq(pessoas.id, rep));
    await this.auditoria.registrar({ acao: 'editar_perfil', entidade: 'pessoa', entidadeId: rep, dados: { campos: Object.keys(set) } });
    return this.perfil(rep);
  }
}
