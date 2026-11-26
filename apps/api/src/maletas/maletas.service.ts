import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  calcularAcerto,
  diasEntre,
  gerarParcelas,
  novoLimite,
  podeRetirarMaleta,
  somarDias,
  type FormaAcerto,
  type ItemAcerto,
} from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { DocumentosService } from '../documentos/documentos.service';
import { acertos, auditoria as auditoriaTb, creditos, documentos, locaisEstoque, maletaConferencias, maletaItens, maletaSolicitacoes, maletas, movimentos, notasFiscais, pessoas, pontos, produtos, titulos, usuarios } from '../db/schema';
import { PlanoContasService } from '../financeiro/plano.service';

export const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10); // horário de Brasília

export interface ItemCodigo {
  codigoBarras: string;
  quantidade: number;
}

export interface DadosAcerto {
  forma: FormaAcerto;
  modalidade: 'presencial' | 'video' | 'envio';
  parcial: boolean;
  dataAcerto?: string;
  itens: { produtoId: string; vendida: number; devolvida: number; perdida: number }[];
  parcelas: number;
  primeiroVencimento?: string;
  formaPagamento: 'pix' | 'boleto' | 'cartao' | 'dinheiro';
  pagoAgora: boolean;
  usarCredito: boolean;
}

@Injectable()
export class MaletasService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly estoque: EstoqueService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
    private readonly documentos: DocumentosService,
    private readonly plano: PlanoContasService,
  ) {}

  /** Situação de crédito da representante: limite, quanto está usado e pendências. */
  async situacao(representanteId: string, tx?: Tx) {
    const db = tx ?? this.db;
    const [rep] = await db.select().from(pessoas).where(eq(pessoas.id, representanteId));
    if (!rep || rep.tipo !== 'representante') throw new NotFoundException('Representante não encontrada.');
    const [m] = await db
      .select({
        abertas: sql<number>`count(distinct ${maletas.id})::int`,
        emMaletas: sql<number>`coalesce(sum(${maletaItens.preco} * (${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})),0)::int`,
        atrasoMaleta: sql<number>`coalesce(max(greatest(current_date - ${maletas.dataLimite}, 0)),0)::int`,
      })
      .from(maletas)
      .leftJoin(maletaItens, eq(maletaItens.maletaId, maletas.id))
      .where(and(eq(maletas.representanteId, representanteId), eq(maletas.status, 'aberta')));
    const [t] = await db
      .select({
        atraso: sql<number>`coalesce(max(current_date - ${titulos.vencimento}),0)::int`,
        vencido: sql<number>`coalesce(sum(${titulos.valor}),0)::int`,
      })
      .from(titulos)
      .where(and(eq(titulos.pessoaId, representanteId), eq(titulos.status, 'aberto'), eq(titulos.tipo, 'receber'), lt(titulos.vencimento, sql`current_date`)));
    const [c] = await db.select({ saldo: sql<number>`coalesce(sum(${creditos.valor}),0)::int` }).from(creditos).where(eq(creditos.pessoaId, representanteId));
    return {
      representante: { id: rep.id, nome: rep.nome, status: rep.status, modeloTrabalho: rep.modeloTrabalho },
      limite: rep.limiteCredito,
      emMaletas: m.emMaletas,
      creditoLivre: Math.max(0, rep.limiteCredito - m.emMaletas),
      maletasAbertas: m.abertas,
      maiorAtrasoDias: Math.max(m.atrasoMaleta, t.atraso),
      titulosVencidos: t.vencido,
      saldoCredito: c.saldo,
      bloqueado: rep.bloqueado,
      motivoBloqueio: rep.motivoBloqueio,
    };
  }

  private async resolverItens(tx: Tx, itens: ItemCodigo[]) {
    const codigos = [...new Set(itens.map((i) => i.codigoBarras))];
    const ps = await tx.select().from(produtos).where(inArray(produtos.codigoBarras, codigos));
    const mapa = new Map(ps.map((p) => [p.codigoBarras, p]));
    const faltando = codigos.filter((c) => !mapa.has(c));
    if (faltando.length) throw new NotFoundException(`Código(s) não cadastrado(s): ${faltando.join(', ')}`);
    const inativos = ps.filter((p) => !p.ativo).map((p) => p.codigoBarras);
    if (inativos.length) throw new BadRequestException(`Produto(s) inativo(s): ${inativos.join(', ')}`);
    // junta leituras repetidas do mesmo código
    const agrupado = new Map<string, number>();
    for (const i of itens) agrupado.set(i.codigoBarras, (agrupado.get(i.codigoBarras) ?? 0) + i.quantidade);
    return [...agrupado].map(([codigo, quantidade]) => ({ produto: mapa.get(codigo)!, quantidade }));
  }

  async criar(
    d: { representanteId: string; origemId: string; dataRetirada?: string; entrega: 'retirada' | 'envio'; observacao?: string | null; observacaoInterna?: string | null; itens: ItemCodigo[]; liberarExcecao?: boolean },
    usuarioId: string,
    podeLiberarExcecao: boolean,
  ) {
    return this.db.transaction(async (tx) => {
      // Trava a representante: duas maletas montadas ao mesmo tempo não podem furar o limite juntas.
      await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.id, d.representanteId)).for('update');
      const sit = await this.situacao(d.representanteId, tx);
      if (sit.representante.status !== 'ativo') throw new BadRequestException('A representante precisa estar ativa (aprovada na triagem).');
      if (sit.representante.modeloTrabalho && sit.representante.modeloTrabalho !== 'consignado') {
        throw new BadRequestException(`A representante está no modelo ${sit.representante.modeloTrabalho}, não no consignado.`);
      }
      const [origem] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, d.origemId));
      if (!origem || origem.tipo === 'maleta') throw new BadRequestException('Local de origem inválido.');

      const itens = await this.resolverItens(tx, d.itens);
      const valor = itens.reduce((a, i) => a + i.produto.preco * i.quantidade, 0);
      const regras = await this.config.regras(tx);
      const lib = podeRetirarMaleta({ limite: sit.limite, emMaletas: sit.emMaletas, maletasAbertas: sit.maletasAbertas, maiorAtrasoDias: sit.maiorAtrasoDias, bloqueadaManualmente: sit.bloqueado }, valor, regras);
      if (!lib.pode && !(d.liberarExcecao && podeLiberarExcecao)) {
        throw new BadRequestException({ mensagem: 'Maleta não liberada.', motivos: lib.motivos, creditoLivre: lib.creditoLivre, valor });
      }

      const dataRetirada = d.dataRetirada ?? hoje();
      const [local] = await tx.insert(locaisEstoque).values({ empresaId: origem.empresaId, nome: `Maleta · ${sit.representante.nome}`, tipo: 'maleta' }).returning();
      const [maleta] = await tx
        .insert(maletas)
        .values({
          empresaId: origem.empresaId,
          representanteId: d.representanteId,
          localId: local.id,
          origemId: origem.id,
          dataRetirada,
          dataLimite: somarDias(dataRetirada, regras.prazoAcertoDias),
          entrega: d.entrega,
          linkToken: randomBytes(18).toString('base64url'),
          observacao: d.observacao ?? null,
          observacaoInterna: d.observacaoInterna ?? null,
          usuarioId,
        })
        .returning();
      await tx.update(locaisEstoque).set({ nome: `Maleta nº ${maleta.numero} · ${sit.representante.nome}` }).where(eq(locaisEstoque.id, local.id));

      for (const i of itens) {
        await tx.insert(maletaItens).values({ maletaId: maleta.id, produtoId: i.produto.id, preco: i.produto.preco, custo: i.produto.custo, enviada: i.quantidade });
        await this.estoque.mover(tx, { produtoId: i.produto.id, origemId: origem.id, destinoId: local.id, quantidade: i.quantidade, tipo: 'maleta_envio', referenciaTipo: 'maleta', referenciaId: maleta.id, usuarioId });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'criar', entidade: 'maleta', entidadeId: maleta.id, dados: { valor, pecas: itens.reduce((a, i) => a + i.quantidade, 0), excecao: !lib.pode ? lib.motivos : undefined } }, tx);
      // Promissória da maleta, se houver modelo cadastrado (sem modelo, a maleta é criada assim mesmo).
      const promissoria = await this.documentos.gerar(tx, { pessoaId: d.representanteId, tipo: 'promissoria', maletaId: maleta.id }, usuarioId, false);
      return { ...maleta, promissoriaId: promissoria?.id ?? null };
    });
  }

  private async maletaAberta(tx: Tx, id: string) {
    const [m] = await tx.select().from(maletas).where(eq(maletas.id, id)).for('update');
    if (!m) throw new NotFoundException('Maleta não encontrada.');
    if (m.status !== 'aberta') throw new BadRequestException(`A maleta nº ${m.numero} está ${m.status}.`);
    return m;
  }

  /** Troca no meio do ciclo: inclui peças (respeitando o crédito). */
  async incluirItens(id: string, itens: ItemCodigo[], usuarioId: string, podeLiberarExcecao: boolean, liberarExcecao = false) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.id, m.representanteId)).for('update');
      const resolvidos = await this.resolverItens(tx, itens);
      const valor = resolvidos.reduce((a, i) => a + i.produto.preco * i.quantidade, 0);
      const sit = await this.situacao(m.representanteId, tx);
      if (valor > sit.creditoLivre && !(liberarExcecao && podeLiberarExcecao)) {
        throw new BadRequestException({ mensagem: 'Valor passa do crédito livre.', motivos: [`Crédito livre: ${sit.creditoLivre}, peças: ${valor}`] });
      }
      for (const i of resolvidos) {
        await tx
          .insert(maletaItens)
          .values({ maletaId: id, produtoId: i.produto.id, preco: i.produto.preco, custo: i.produto.custo, enviada: i.quantidade })
          .onConflictDoUpdate({ target: [maletaItens.maletaId, maletaItens.produtoId], set: { enviada: sql`${maletaItens.enviada} + ${i.quantidade}` } });
        await this.estoque.mover(tx, { produtoId: i.produto.id, origemId: m.origemId, destinoId: m.localId, quantidade: i.quantidade, tipo: 'maleta_envio', motivo: 'Inclusão durante o ciclo', referenciaTipo: 'maleta', referenciaId: id, usuarioId });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'incluir_itens', entidade: 'maleta', entidadeId: id, dados: { itens } }, tx);
      await this.documentos.gerar(tx, { pessoaId: m.representanteId, tipo: 'promissoria', maletaId: id }, usuarioId, false);
      return { ok: true };
    });
  }

  /** Troca no meio do ciclo: retira peças que voltam à matriz antes do acerto. */
  async retirarItens(id: string, itens: ItemCodigo[], usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      const resolvidos = await this.resolverItens(tx, itens);
      for (const i of resolvidos) {
        const [it] = await tx.select().from(maletaItens).where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produto.id)));
        const naMaleta = it ? it.enviada - it.vendida - it.devolvida - it.perdida : 0;
        if (i.quantidade > naMaleta) throw new BadRequestException(`${i.produto.descricao}: só há ${naMaleta} na maleta.`);
        await tx.update(maletaItens).set({ enviada: it!.enviada - i.quantidade }).where(eq(maletaItens.id, it!.id));
        await this.estoque.mover(tx, { produtoId: i.produto.id, origemId: m.localId, destinoId: m.origemId, quantidade: i.quantidade, tipo: 'maleta_devolucao', motivo: 'Retirada durante o ciclo', referenciaTipo: 'maleta', referenciaId: id, usuarioId });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'retirar_itens', entidade: 'maleta', entidadeId: id, dados: { itens } }, tx);
      // A promissória acompanha o novo valor da maleta.
      await this.documentos.gerar(tx, { pessoaId: m.representanteId, tipo: 'promissoria', maletaId: id }, usuarioId, false);
      return { ok: true };
    });
  }

  async obter(id: string) {
    const [m] = await this.db
      .select({ maleta: maletas, representante: pessoas.nome, telefone: pessoas.telefone1, cidade: pessoas.cidade, origem: locaisEstoque.nome })
      .from(maletas)
      .innerJoin(pessoas, eq(pessoas.id, maletas.representanteId))
      .innerJoin(locaisEstoque, eq(locaisEstoque.id, maletas.origemId))
      .where(eq(maletas.id, id));
    if (!m) throw new NotFoundException('Maleta não encontrada.');
    const itens = await this.db
      .select({
        id: maletaItens.id,
        produtoId: maletaItens.produtoId,
        codigoBarras: produtos.codigoBarras,
        referencia: produtos.referencia,
        descricao: produtos.descricao,
        foto: sql<string | null>`${produtos.fotos}->>0`,
        preco: maletaItens.preco,
        custo: maletaItens.custo,
        enviada: maletaItens.enviada,
        vendida: maletaItens.vendida,
        devolvida: maletaItens.devolvida,
        perdida: maletaItens.perdida,
        prebaixaVendida: maletaItens.prebaixaVendida,
        prebaixaDevolvida: maletaItens.prebaixaDevolvida,
      })
      .from(maletaItens)
      .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
      .where(eq(maletaItens.maletaId, id))
      .orderBy(asc(produtos.descricao));
    const comSaldo = itens.map((i) => ({ ...i, naMaleta: i.enviada - i.vendida - i.devolvida - i.perdida }));
    const historico = await this.db.select().from(acertos).where(eq(acertos.maletaId, id)).orderBy(asc(acertos.criadoEm));
    const conferencias = await this.db
      .select({ c: maletaConferencias, por: usuarios.nome })
      .from(maletaConferencias)
      .leftJoin(usuarios, eq(usuarios.id, maletaConferencias.usuarioId))
      .where(eq(maletaConferencias.maletaId, id))
      .orderBy(asc(maletaConferencias.criadoEm))
      .then((r) => r.map((x) => ({ ...x.c, conferidoPor: x.por })));
    const docs = await this.db
      .select({ id: documentos.id, tipo: documentos.tipo, status: documentos.status, token: documentos.token, assinadoEm: documentos.assinadoEm })
      .from(documentos)
      .where(and(eq(documentos.maletaId, id), sql`${documentos.status} <> 'cancelado'`));
    // Parcelas dos acertos (para receber na própria maleta: baixa ou Pix/boleto).
    const parcelasAcerto = historico.length
      ? await this.db
          .select({ id: titulos.id, acertoId: titulos.origemId, descricao: titulos.descricao, valor: titulos.valor, vencimento: titulos.vencimento, status: titulos.status, pagoEm: titulos.pagoEm, formaPagamento: titulos.formaPagamento, cobrancaUrl: titulos.cobrancaUrl, pixCopiaCola: titulos.pixCopiaCola, cobrancaTipo: titulos.cobrancaTipo })
          .from(titulos)
          .where(and(eq(titulos.origemTipo, 'acerto'), inArray(titulos.origemId, historico.map((a) => a.id)), sql`${titulos.status} <> 'cancelado'`))
          .orderBy(asc(titulos.vencimento), asc(titulos.parcela))
      : [];
    const totais = {
      pecas: comSaldo.reduce((a, i) => a + i.naMaleta, 0),
      valor: comSaldo.reduce((a, i) => a + i.naMaleta * i.preco, 0),
      pecasEnviadas: comSaldo.reduce((a, i) => a + i.enviada, 0),
      valorEnviado: comSaldo.reduce((a, i) => a + i.enviada * i.preco, 0),
    };
    const diasAtraso = m.maleta.status === 'aberta' ? Math.max(0, diasEntre(m.maleta.dataLimite, hoje())) : 0;
    return { ...m.maleta, representante: m.representante, telefone: m.telefone, cidade: m.cidade, origem: m.origem, itens: comSaldo, acertos: historico, parcelasAcerto, conferencias, documentos: docs, totais, diasAtraso };
  }

  /**
   * Conferência peça por peça (opcional). Saída: confere o que vai na maleta; o que faltou pode sair da maleta.
   * Volta: confere o que voltou; com pré-baixa, mostra o que ela disse que devolveria e não veio
   * (o acerto usa a conferência: o que faltou é cobrado pelo custo ou fica pendente para investigar).
   */
  async conferir(
    id: string,
    d: { tipo: 'saida' | 'volta'; itens: { produtoId: string; conferido: number }[]; sobras: { codigo: string; quantidade: number }[]; observacao?: string | null; tratamento: 'nada' | 'retirar' | 'cobrar' | 'investigar' },
    usuarioId: string,
  ) {
    if (d.tipo === 'saida' && !['nada', 'retirar'].includes(d.tratamento)) throw new BadRequestException('Na saída, o que faltou pode só ficar registrado ou sair da maleta.');
    if (d.tipo === 'volta' && !['nada', 'cobrar', 'investigar'].includes(d.tratamento)) throw new BadRequestException('Na volta, o que faltou pode ser cobrado pelo custo ou ficar para investigar.');
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      const doBanco = await tx
        .select({ it: maletaItens, descricao: produtos.descricao, codigoBarras: produtos.codigoBarras })
        .from(maletaItens)
        .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
        .where(eq(maletaItens.maletaId, id))
        .orderBy(asc(produtos.descricao));
      const lidos = new Map(d.itens.map((i) => [i.produtoId, Math.max(0, Math.floor(i.conferido))]));
      const fora = d.itens.filter((i) => !doBanco.some((b) => b.it.produtoId === i.produtoId));
      if (fora.length) throw new BadRequestException('Há peças na conferência que não são desta maleta (mande como "sobra").');
      const comPrebaixa = !!m.prebaixaEm;
      const itens = doBanco
        .map((b) => {
          const naMaleta = b.it.enviada - b.it.vendida - b.it.devolvida - b.it.perdida;
          // Volta com pré-baixa: espera o que ela disse que devolveria. Sem pré-baixa: tudo pode voltar (o que não voltou foi vendido).
          const esperado = d.tipo === 'volta' && comPrebaixa ? Math.min(naMaleta, b.it.prebaixaDevolvida ?? Math.max(0, naMaleta - (b.it.prebaixaVendida ?? 0))) : naMaleta;
          return { produtoId: b.it.produtoId, descricao: b.descricao, codigoBarras: b.codigoBarras, naMaleta, esperado, conferido: Math.min(naMaleta, lidos.get(b.it.produtoId) ?? 0) };
        })
        .filter((i) => i.naMaleta > 0);
      const conta = (f: (i: (typeof itens)[number]) => number) => itens.reduce((a, i) => a + f(i), 0);
      const faltando = d.tipo === 'volta' && !comPrebaixa ? 0 : conta((i) => Math.max(0, i.esperado - i.conferido));
      // Peças bipadas que não são desta maleta: guarda com a descrição, se o código existir.
      const sobras = [];
      for (const s2 of d.sobras.filter((x) => x.codigo.trim() && x.quantidade > 0)) {
        const [p] = await tx.select({ descricao: produtos.descricao }).from(produtos).where(or(eq(produtos.codigoBarras, s2.codigo.trim()), eq(produtos.referencia, s2.codigo.trim()))).limit(1);
        sobras.push({ codigo: s2.codigo.trim(), descricao: p?.descricao ?? null, quantidade: Math.floor(s2.quantidade) });
      }
      const [c] = await tx
        .insert(maletaConferencias)
        .values({
          maletaId: id,
          tipo: d.tipo,
          usuarioId,
          itens: itens.map(({ naMaleta: _n, ...i }) => i),
          sobras,
          esperadas: conta((i) => i.esperado),
          conferidas: conta((i) => i.conferido),
          faltando,
          tratamento: faltando ? d.tratamento : 'nada',
          observacao: d.observacao?.trim() || null,
        })
        .returning();
      // Saída: o que não foi para a maleta volta para o estoque de origem.
      if (d.tipo === 'saida' && faltando && d.tratamento === 'retirar') {
        for (const i of itens.filter((x) => x.esperado > x.conferido)) {
          const q = i.esperado - i.conferido;
          await tx.update(maletaItens).set({ enviada: sql`${maletaItens.enviada} - ${q}` }).where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produtoId)));
          await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, destinoId: m.origemId, quantidade: q, tipo: 'maleta_devolucao', motivo: 'Faltou na conferência de saída', referenciaTipo: 'maleta', referenciaId: id, usuarioId });
        }
        await this.documentos.gerar(tx, { pessoaId: m.representanteId, tipo: 'promissoria', maletaId: id }, usuarioId, false);
      }
      await this.auditoria.registrar({ usuarioId, acao: `conferencia_${d.tipo}`, entidade: 'maleta', entidadeId: id, dados: { conferidas: c.conferidas, esperadas: c.esperadas, faltando, tratamento: c.tratamento } }, tx);
      return c;
    });
  }

  async prebaixa(id: string, itens: { produtoId: string; vendida: number; devolvida: number }[], usuarioId: string | null) {
    return this.db.transaction(async (tx) => {
      await this.maletaAberta(tx, id);
      for (const i of itens) {
        await tx.update(maletaItens).set({ prebaixaVendida: i.vendida, prebaixaDevolvida: i.devolvida }).where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produtoId)));
      }
      await tx.update(maletas).set({ prebaixaEm: new Date() }).where(eq(maletas.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'prebaixa', entidade: 'maleta', entidadeId: id }, tx);
      return { ok: true };
    });
  }

  private async montarCalculo(tx: Tx, id: string, d: DadosAcerto) {
    const m = await this.maletaAberta(tx, id);
    const doBanco = await tx.select().from(maletaItens).where(eq(maletaItens.maletaId, id));
    const porProduto = new Map(d.itens.map((i) => [i.produtoId, i]));
    const desconhecidos = d.itens.filter((i) => !doBanco.some((b) => b.produtoId === i.produtoId));
    if (desconhecidos.length) throw new BadRequestException('Há produtos que não estão nesta maleta.');
    const itens: ItemAcerto[] = doBanco
      .map((b) => {
        const inf = porProduto.get(b.produtoId);
        return {
          produtoId: b.produtoId,
          preco: b.preco,
          custo: b.custo,
          emMaleta: b.enviada - b.vendida - b.devolvida - b.perdida,
          vendida: inf?.vendida ?? 0,
          devolvida: inf?.devolvida ?? 0,
          perdida: inf?.perdida ?? 0,
        };
      })
      .filter((i) => i.emMaleta > 0);
    const regras = await this.config.regrasDaRepresentante(m.representanteId, tx);
    const sit = await this.situacao(m.representanteId, tx);
    const dataAcerto = d.dataAcerto ?? hoje();
    const resultado = calcularAcerto({
      itens,
      forma: d.forma,
      dataLimite: m.dataLimite,
      dataAcerto,
      creditoDisponivel: d.usarCredito ? Math.max(0, sit.saldoCredito) : 0,
      parcial: d.parcial,
      regras,
    });
    if (d.parcelas > regras.parcelasMaximas) throw new BadRequestException(`Máximo de ${regras.parcelasMaximas} parcelas.`);
    if (d.forma === 'avista' && d.parcelas > 1) throw new BadRequestException('Pagamento à vista não pode ser parcelado.');
    const primeiro = d.primeiroVencimento ?? dataAcerto;
    const parcelas = gerarParcelas(resultado.totalAPagar, d.parcelas, primeiro);
    // Desempenho da maleta inteira (somando acertos parciais anteriores): é ele que decide o limite no fechamento,
    // não só o último pedaço acertado.
    const enviado = doBanco.reduce((a, b) => a + b.preco * b.enviada, 0);
    const vendidoAntes = doBanco.reduce((a, b) => a + b.preco * b.vendida, 0);
    const perdidasAntes = doBanco.reduce((a, b) => a + b.perdida, 0);
    const maletaInteira = {
      percentualVendidoPb: enviado > 0 ? Math.round(((vendidoAntes + resultado.totalVendido) * 10000) / enviado) : 0,
      houvePerda: perdidasAntes + resultado.pecas.perdidas > 0,
    };
    return { m, itens, regras, sit, resultado, parcelas, dataAcerto, maletaInteira };
  }

  async simular(id: string, d: DadosAcerto) {
    // Executa numa transação que é sempre desfeita: nada é gravado.
    let saida: unknown;
    await this.db
      .transaction(async (tx) => {
        const c = await this.montarCalculo(tx, id, d);
        const lim = novoLimite(c.sit.limite, { diasAtraso: c.resultado.diasAtraso, ...c.maletaInteira }, c.regras);
        saida = { resultado: c.resultado, parcelas: c.parcelas, regras: c.regras, limiteAtual: c.sit.limite, limiteNovo: d.parcial ? c.sit.limite : lim.limite, motivoLimite: d.parcial ? 'Acerto parcial: limite revisto no fechamento.' : lim.motivo };
        throw new SimulacaoConcluida();
      })
      .catch((e) => {
        if (!(e instanceof SimulacaoConcluida)) throw e;
      });
    return saida;
  }

  async acertar(id: string, d: DadosAcerto, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const { m, regras, sit, resultado, parcelas, dataAcerto, itens, maletaInteira } = await this.montarCalculo(tx, id, d);
      const ref = { referenciaTipo: 'maleta', referenciaId: id, usuarioId };

      for (const i of itens) {
        if (i.devolvida) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, destinoId: m.origemId, quantidade: i.devolvida, tipo: 'maleta_devolucao', motivo: 'Devolução no acerto', ...ref });
        if (i.vendida) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, quantidade: i.vendida, tipo: 'venda', motivo: 'Vendida pela representante', ...ref });
        if (i.perdida) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, quantidade: i.perdida, tipo: 'perda', motivo: 'Perdida ou quebrada (cobrada no acerto)', ...ref });
        if (i.vendida || i.devolvida || i.perdida) {
          await tx
            .update(maletaItens)
            .set({
              vendida: sql`${maletaItens.vendida} + ${i.vendida}`,
              devolvida: sql`${maletaItens.devolvida} + ${i.devolvida}`,
              perdida: sql`${maletaItens.perdida} + ${i.perdida}`,
            })
            .where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, i.produtoId)));
        }
      }

      const fechou = resultado.pecas.continuam === 0;
      const lim = fechou
        ? novoLimite(sit.limite, { diasAtraso: resultado.diasAtraso, ...maletaInteira }, regras)
        : { limite: sit.limite, motivo: 'Acerto parcial.' };

      const [acerto] = await tx
        .insert(acertos)
        .values({
          maletaId: id,
          data: dataAcerto,
          forma: d.forma,
          modalidade: d.modalidade,
          parcial: !fechou,
          resultado,
          regras,
          totalAPagar: resultado.totalAPagar,
          parcelas: parcelas.length,
          limiteAnterior: sit.limite,
          limiteNovo: lim.limite,
          usuarioId,
        })
        .returning();

      if (resultado.creditoUsado > 0) {
        await tx.insert(creditos).values({ pessoaId: m.representanteId, valor: -resultado.creditoUsado, descricao: `Usado no acerto da maleta nº ${m.numero}`, origemTipo: 'acerto', origemId: acerto.id, usuarioId });
      }
      for (const p of parcelas) {
        const pago = d.pagoAgora && parcelas.length === 1;
        await tx.insert(titulos).values({
          empresaId: m.empresaId,
          tipo: 'receber',
          pessoaId: m.representanteId,
          descricao: `Acerto da maleta nº ${m.numero}${parcelas.length > 1 ? ` (${p.numero}/${parcelas.length})` : ''}`,
          categoria: 'Acerto de maleta',
          ...(await this.plano.daChave('recebimentos')),
          valor: p.valor,
          vencimento: p.vencimento,
          parcela: p.numero,
          totalParcelas: parcelas.length,
          formaPagamento: d.formaPagamento,
          status: pago ? 'pago' : 'aberto',
          pagoEm: pago ? dataAcerto : null,
          valorPago: pago ? p.valor : null,
          origemTipo: 'acerto',
          origemId: acerto.id,
        });
      }

      if (lim.limite !== sit.limite) await tx.update(pessoas).set({ limiteCredito: lim.limite, atualizadoEm: new Date() }).where(eq(pessoas.id, m.representanteId));
      if (fechou) await tx.update(maletas).set({ status: 'acertada', acertadaEm: new Date(), conferida: true }).where(eq(maletas.id, id));
      // Acerto parcial: o que a representante tinha marcado na pré-baixa já foi acertado; zera para não contar de novo
      // (no catálogo e no próximo acerto).
      else {
        await tx.update(maletaItens).set({ prebaixaVendida: null, prebaixaDevolvida: null }).where(eq(maletaItens.maletaId, id));
        await tx.update(maletas).set({ prebaixaEm: null }).where(eq(maletas.id, id));
      }

      await this.auditoria.registrar({ usuarioId, acao: fechou ? 'acerto' : 'acerto_parcial', entidade: 'maleta', entidadeId: id, dados: { acertoId: acerto.id, total: resultado.totalAPagar, limite: [sit.limite, lim.limite] } }, tx);
      return { acerto, resultado, parcelas, limiteNovo: lim.limite, motivoLimite: lim.motivo, fechou };
    });
  }

  // ───────────── Alterar o pedido: consignatária e data do acerto ─────────────

  /** Valor (preço de etiqueta) das peças que ainda estão na maleta. */
  private async valorNaMaleta(tx: Tx, id: string) {
    const [r] = await tx.select({ v: sql<number>`coalesce(sum((${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida}) * ${maletaItens.preco}), 0)::bigint` }).from(maletaItens).where(eq(maletaItens.maletaId, id));
    return Number(r?.v ?? 0);
  }

  /**
   * Passa a maleta inteira para outra consignatária (antes ou depois de retirada).
   * Confere o crédito da nova; os documentos da anterior para esta maleta são cancelados e sai uma promissória nova.
   */
  async trocarConsignataria(id: string, d: { representanteId: string; motivo: string; liberarExcecao?: boolean }, usuarioId: string, podeLiberarExcecao: boolean) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      if (m.representanteId === d.representanteId) throw new BadRequestException('A maleta já é desta consignatária.');
      await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.id, d.representanteId)).for('update');
      const sit = await this.situacao(d.representanteId, tx);
      if (sit.representante.status !== 'ativo') throw new BadRequestException('A nova consignatária precisa estar ativa (aprovada na triagem).');
      if (sit.representante.modeloTrabalho && sit.representante.modeloTrabalho !== 'consignado') throw new BadRequestException(`A nova consignatária está no modelo ${sit.representante.modeloTrabalho}, não no consignado.`);
      const valor = await this.valorNaMaleta(tx, id);
      const regras = await this.config.regras(tx);
      const lib = podeRetirarMaleta({ limite: sit.limite, emMaletas: sit.emMaletas, maletasAbertas: sit.maletasAbertas, maiorAtrasoDias: sit.maiorAtrasoDias, bloqueadaManualmente: sit.bloqueado }, valor, regras);
      if (!lib.pode && !(d.liberarExcecao && podeLiberarExcecao)) throw new BadRequestException({ mensagem: `${sit.representante.nome} não pode ficar com esta maleta.`, motivos: lib.motivos, creditoLivre: lib.creditoLivre, valor });
      const [antes] = await tx.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, m.representanteId));
      const nota = `Consignatária trocada de ${antes?.nome ?? '?'} para ${sit.representante.nome} em ${hoje().split('-').reverse().join('/')}: ${d.motivo}`;
      // Link do pedido novo (a anterior perde o acesso) e a nova confirma o recebimento de novo.
      await tx.update(maletas).set({ representanteId: d.representanteId, linkToken: randomBytes(18).toString('base64url'), recebidaEm: null, observacaoInterna: sql`concat_ws(E'\n', ${maletas.observacaoInterna}, ${nota}::text)` }).where(eq(maletas.id, id));
      await tx.update(locaisEstoque).set({ nome: `Maleta nº ${m.numero} · ${sit.representante.nome}` }).where(eq(locaisEstoque.id, m.localId));
      // Termo e promissória da anterior deixam de valer para esta maleta.
      await tx.update(documentos).set({ status: 'cancelado' }).where(and(eq(documentos.maletaId, id), eq(documentos.pessoaId, m.representanteId), inArray(documentos.status, ['pendente', 'assinado'])));
      const promissoria = await this.documentos.gerar(tx, { pessoaId: d.representanteId, tipo: 'promissoria', maletaId: id }, usuarioId, false);
      await this.auditoria.registrar({ usuarioId, acao: 'trocar_consignataria', entidade: 'maleta', entidadeId: id, dados: { de: m.representanteId, para: d.representanteId, motivo: d.motivo, valor, excecao: !lib.pode ? lib.motivos : undefined } }, tx);
      return { ok: true, promissoriaId: promissoria?.id ?? null };
    });
  }

  private async aplicarDataAcerto(tx: Tx, m: typeof maletas.$inferSelect, dataLimite: string, motivo: string, usuarioId: string) {
    const nota = `Data do acerto mudou de ${m.dataLimite.split('-').reverse().join('/')} para ${dataLimite.split('-').reverse().join('/')}: ${motivo}`;
    await tx.update(maletas).set({ dataLimite, observacaoInterna: sql`concat_ws(E'\n', ${maletas.observacaoInterna}, ${nota}::text)` }).where(eq(maletas.id, m.id));
    await this.auditoria.registrar({ usuarioId, acao: 'mudar_data_acerto', entidade: 'maleta', entidadeId: m.id, dados: { de: m.dataLimite, para: dataLimite, motivo } }, tx);
    // A promissória acompanha a data nova.
    await this.documentos.gerar(tx, { pessoaId: m.representanteId, tipo: 'promissoria', maletaId: m.id }, usuarioId, false);
  }

  /** Muda a data do acerto. Gerência muda na hora; os outros pedem autorização. */
  async mudarDataAcerto(id: string, d: { dataLimite: string; motivo: string }, usuarioId: string, gerencia: boolean) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      if (d.dataLimite === m.dataLimite) throw new BadRequestException('A maleta já está com esta data de acerto.');
      if (d.dataLimite < m.dataRetirada) throw new BadRequestException('A data do acerto não pode ser antes da retirada.');
      if (gerencia) {
        await this.aplicarDataAcerto(tx, m, d.dataLimite, d.motivo, usuarioId);
        // Pedido que estava esperando fica sem efeito.
        await tx.update(maletaSolicitacoes).set({ status: 'cancelada', decididoPor: usuarioId, decididoEm: new Date(), observacaoDecisao: 'A gerência mudou a data direto.' }).where(and(eq(maletaSolicitacoes.maletaId, id), eq(maletaSolicitacoes.status, 'pendente')));
        return { aplicada: true };
      }
      await tx.update(maletaSolicitacoes).set({ status: 'cancelada', observacaoDecisao: 'Substituído por um pedido novo.' }).where(and(eq(maletaSolicitacoes.maletaId, id), eq(maletaSolicitacoes.tipo, 'data_acerto'), eq(maletaSolicitacoes.status, 'pendente')));
      const [s] = await tx.insert(maletaSolicitacoes).values({ maletaId: id, tipo: 'data_acerto', dados: { de: m.dataLimite, para: d.dataLimite }, motivo: d.motivo, pedidoPor: usuarioId }).returning();
      await this.auditoria.registrar({ usuarioId, acao: 'pedir_data_acerto', entidade: 'maleta', entidadeId: id, dados: { de: m.dataLimite, para: d.dataLimite, motivo: d.motivo } }, tx);
      return { aplicada: false, solicitacaoId: s.id };
    });
  }

  /** Pedidos de autorização (para a gerência aprovar), com a maleta e quem pediu. */
  async solicitacoes(status = 'pendente', maletaId?: string) {
    return this.db
      .select({ id: maletaSolicitacoes.id, maletaId: maletaSolicitacoes.maletaId, numero: maletas.numero, representante: pessoas.nome, tipo: maletaSolicitacoes.tipo, dados: maletaSolicitacoes.dados, motivo: maletaSolicitacoes.motivo, status: maletaSolicitacoes.status, pedidoPor: usuarios.nome, criadoEm: maletaSolicitacoes.criadoEm, decididoEm: maletaSolicitacoes.decididoEm, observacaoDecisao: maletaSolicitacoes.observacaoDecisao })
      .from(maletaSolicitacoes)
      .innerJoin(maletas, eq(maletas.id, maletaSolicitacoes.maletaId))
      .innerJoin(pessoas, eq(pessoas.id, maletas.representanteId))
      .leftJoin(usuarios, eq(usuarios.id, maletaSolicitacoes.pedidoPor))
      .where(and(status === 'todas' ? undefined : eq(maletaSolicitacoes.status, status), maletaId ? eq(maletaSolicitacoes.maletaId, maletaId) : undefined))
      .orderBy(asc(maletaSolicitacoes.criadoEm))
      .limit(200);
  }

  /** A gerência aprova (aplica a mudança) ou recusa um pedido. */
  async decidirSolicitacao(id: string, aprovar: boolean, observacao: string | null, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(maletaSolicitacoes).where(eq(maletaSolicitacoes.id, id)).for('update');
      if (!s) throw new NotFoundException('Pedido não encontrado.');
      if (s.status !== 'pendente') throw new BadRequestException(`Este pedido já está ${s.status}.`);
      if (aprovar && s.tipo === 'data_acerto') {
        const m = await this.maletaAberta(tx, s.maletaId);
        await this.aplicarDataAcerto(tx, m, String(s.dados.para), `${s.motivo} (autorizado pela gerência)`, usuarioId);
      }
      await tx.update(maletaSolicitacoes).set({ status: aprovar ? 'aprovada' : 'recusada', decididoPor: usuarioId, decididoEm: new Date(), observacaoDecisao: observacao }).where(eq(maletaSolicitacoes.id, id));
      await this.auditoria.registrar({ usuarioId, acao: aprovar ? 'aprovar_solicitacao' : 'recusar_solicitacao', entidade: 'maleta', entidadeId: s.maletaId, dados: { solicitacao: id, tipo: s.tipo, observacao } }, tx);
      return { ok: true };
    });
  }

  /**
   * Estorna o último acerto da maleta (ex.: apertaram "fechar acerto" sem querer): as peças voltam para a maleta,
   * as parcelas do acerto são canceladas (a representante volta a dever a maleta), crédito usado volta,
   * pontos do acerto saem e o limite volta ao de antes. Pagamento que entrou de verdade depois vira crédito.
   * Devolve as cobranças do Asaas a apagar (quem chama apaga fora da transação).
   */
  async estornarAcerto(id: string, motivo: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(maletas).where(eq(maletas.id, id)).for('update');
      if (!m) throw new NotFoundException('Maleta não encontrada.');
      if (m.status === 'cancelada') throw new BadRequestException('Maleta cancelada não tem acerto para estornar.');
      const [a] = await tx.select().from(acertos).where(eq(acertos.maletaId, id)).orderBy(sql`${acertos.criadoEm} desc`).limit(1);
      if (!a) throw new BadRequestException('Esta maleta não tem acerto para estornar.');
      const [nota] = await tx.select({ id: notasFiscais.id }).from(notasFiscais).where(and(eq(notasFiscais.origemTipo, 'acerto'), eq(notasFiscais.origemId, a.id), inArray(notasFiscais.status, ['autorizada', 'processando']))).limit(1);
      if (nota) throw new BadRequestException('Este acerto tem nota fiscal emitida. Cancele a nota no Fiscal antes de estornar.');
      const ref = { referenciaTipo: 'maleta', referenciaId: id, usuarioId, permitirNegativo: true, motivo: `Estorno do acerto: ${motivo}` };

      // Peças: desfaz os movimentos gravados junto com o acerto (mesma transação, mesmo horário).
      const movs = await tx.select().from(movimentos).where(and(eq(movimentos.referenciaTipo, 'maleta'), eq(movimentos.referenciaId, id), sql`${movimentos.criadoEm} = (select ac.criado_em from acertos ac where ac.id = ${a.id})`, inArray(movimentos.tipo, ['maleta_devolucao', 'venda', 'perda'])));
      const porProduto = new Map<string, { vendida: number; devolvida: number; perdida: number }>();
      for (const mv of movs) {
        const q = porProduto.get(mv.produtoId) ?? { vendida: 0, devolvida: 0, perdida: 0 };
        if (mv.tipo === 'maleta_devolucao') {
          await this.estoque.mover(tx, { ...ref, produtoId: mv.produtoId, origemId: mv.destinoId, destinoId: m.localId, quantidade: mv.quantidade, tipo: 'maleta_envio' });
          q.devolvida += mv.quantidade;
        } else {
          await this.estoque.mover(tx, { ...ref, produtoId: mv.produtoId, destinoId: m.localId, quantidade: mv.quantidade, tipo: 'ajuste' });
          if (mv.tipo === 'venda') q.vendida += mv.quantidade;
          else q.perdida += mv.quantidade;
        }
        porProduto.set(mv.produtoId, q);
      }
      for (const [produtoId, q] of porProduto)
        await tx
          .update(maletaItens)
          .set({ vendida: sql`greatest(0, ${maletaItens.vendida} - ${q.vendida})`, devolvida: sql`greatest(0, ${maletaItens.devolvida} - ${q.devolvida})`, perdida: sql`greatest(0, ${maletaItens.perdida} - ${q.perdida})` })
          .where(and(eq(maletaItens.maletaId, id), eq(maletaItens.produtoId, produtoId)));

      // Parcelas: canceladas. A que foi marcada "paga" no próprio acerto (sem dinheiro de verdade) só cancela;
      // pagamento que entrou depois (Asaas, baixa no financeiro) vira crédito para a representante não perder.
      const ts = await tx.select().from(titulos).where(and(eq(titulos.origemTipo, 'acerto'), eq(titulos.origemId, a.id)));
      const apagarNoAsaas: string[] = [];
      let viraCredito = 0;
      for (const t of ts) {
        if (t.status === 'cancelado' || t.status === 'renegociado') continue;
        if (t.status === 'pago') {
          // "Pago agora" do próprio acerto: nasceu pago e ninguém deu baixa depois (sem registro de baixa na auditoria).
          const [baixa] = await tx.select({ id: auditoriaTb.id }).from(auditoriaTb).where(and(eq(auditoriaTb.entidade, 'titulo'), eq(auditoriaTb.entidadeId, t.id))).limit(1);
          const pagoNoAto = !baixa && !t.cobrancaExternaId && t.pagoEm === a.data;
          if (!pagoNoAto) viraCredito += t.valorPago ?? t.valor;
        } else if (t.cobrancaExternaId) apagarNoAsaas.push(t.cobrancaExternaId);
        await tx.update(titulos).set({ status: 'cancelado' }).where(eq(titulos.id, t.id));
      }
      if (viraCredito > 0) await tx.insert(creditos).values({ pessoaId: m.representanteId, valor: viraCredito, descricao: `Pago no acerto estornado da maleta nº ${m.numero}`, origemTipo: 'estorno_acerto', origemId: a.id, usuarioId });
      // Crédito usado no acerto volta para ela.
      const usados = await tx.select().from(creditos).where(and(eq(creditos.origemTipo, 'acerto'), eq(creditos.origemId, a.id)));
      for (const c of usados) await tx.insert(creditos).values({ pessoaId: c.pessoaId, valor: -c.valor, descricao: `Estorno do acerto da maleta nº ${m.numero}`, origemTipo: 'estorno_acerto', origemId: a.id, usuarioId });
      // Pontos do acerto e das parcelas dele.
      await tx.delete(pontos).where(and(eq(pontos.origemTipo, 'acerto'), eq(pontos.origemId, a.id)));
      if (ts.length) await tx.delete(pontos).where(and(eq(pontos.origemTipo, 'titulo'), inArray(pontos.origemId, ts.map((t) => t.id))));
      // Limite: volta ao de antes, se ninguém mexeu depois.
      if (a.limiteNovo != null && a.limiteAnterior != null && a.limiteNovo !== a.limiteAnterior) await tx.update(pessoas).set({ limiteCredito: a.limiteAnterior, atualizadoEm: new Date() }).where(and(eq(pessoas.id, m.representanteId), eq(pessoas.limiteCredito, a.limiteNovo)));

      await tx.delete(acertos).where(eq(acertos.id, a.id));
      const nota2 = `Acerto de ${a.data.split('-').reverse().join('/')} estornado: ${motivo}`;
      await tx.update(maletas).set({ status: 'aberta', acertadaEm: null, observacaoInterna: sql`concat_ws(E'\n', ${maletas.observacaoInterna}, ${nota2}::text)` }).where(eq(maletas.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'estornar_acerto', entidade: 'maleta', entidadeId: id, dados: { motivo, acerto: a, parcelas: ts.map((t) => ({ id: t.id, valor: t.valor, status: t.status })), viraCredito } }, tx);
      return { ok: true, parcelasCanceladas: ts.length, viraCredito, apagarNoAsaas };
    });
  }

  /** Parcela de um acerto desta maleta, travada para mexer. */
  async parcelaDoAcerto(tx: Tx, maletaId: string, tituloId: string) {
    const [t] = await tx.select().from(titulos).where(eq(titulos.id, tituloId)).for('update');
    if (!t || t.origemTipo !== 'acerto' || !t.origemId) throw new NotFoundException('Parcela não encontrada.');
    const [a] = await tx.select({ id: acertos.id }).from(acertos).where(and(eq(acertos.id, t.origemId), eq(acertos.maletaId, maletaId)));
    if (!a) throw new BadRequestException('Esta parcela não é de um acerto desta maleta.');
    return t;
  }

  /** Recebe (dá baixa) uma parcela do acerto pela tela da maleta: Pix, dinheiro, cartão ou depósito. */
  async receberParcela(maletaId: string, d: { tituloId: string; formaPagamento: string; contaId?: string | null }, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const t = await this.parcelaDoAcerto(tx, maletaId, d.tituloId);
      if (t.status !== 'aberto' && t.status !== 'protestado') throw new BadRequestException(`Esta parcela está ${t.status}.`);
      const pagoEm = hoje();
      await tx.update(titulos).set({ status: 'pago', pagoEm, valorPago: t.valor, contaId: d.contaId ?? null, formaPagamento: d.formaPagamento }).where(eq(titulos.id, t.id));
      await this.auditoria.registrar({ usuarioId, acao: 'baixar', entidade: 'titulo', entidadeId: t.id, dados: { origem: 'maleta', maletaId, formaPagamento: d.formaPagamento, contaId: d.contaId ?? null, valorPago: t.valor } }, tx);
      return { ok: true, cobrancaAnterior: t.cobrancaExternaId, pagoEm, valor: t.valor };
    });
  }

  async cancelar(id: string, motivo: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const m = await this.maletaAberta(tx, id);
      const ac = await tx.select({ id: acertos.id }).from(acertos).where(eq(acertos.maletaId, id)).limit(1);
      if (ac.length) throw new BadRequestException('A maleta já teve acerto parcial; finalize pelo acerto.');
      const itens = await tx.select().from(maletaItens).where(eq(maletaItens.maletaId, id));
      for (const i of itens) {
        if (i.enviada > 0) await this.estoque.mover(tx, { produtoId: i.produtoId, origemId: m.localId, destinoId: m.origemId, quantidade: i.enviada, tipo: 'maleta_devolucao', motivo: `Cancelamento: ${motivo}`, referenciaTipo: 'maleta', referenciaId: id, usuarioId });
      }
      await tx.update(maletas).set({ status: 'cancelada', observacaoInterna: sql`concat_ws(E'\n', ${maletas.observacaoInterna}, ${'Cancelada: ' + motivo}::text)` }).where(eq(maletas.id, id));
      await this.auditoria.registrar({ usuarioId, acao: 'cancelar', entidade: 'maleta', entidadeId: id, dados: { motivo } }, tx);
      return { ok: true };
    });
  }
}

class SimulacaoConcluida extends Error {}
