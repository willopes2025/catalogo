import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { formatarReais } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { cobrancaComprovantes, cobrancaContatos, contas, maletas, pessoas, pixRecebidos, titulos } from '../db/schema';
import { AsaasService } from '../integracoes/asaas.service';
import { hoje } from '../maletas/maletas.service';
import { baixarTitulo } from './baixa';

type Pix = typeof pixRecebidos.$inferSelect;
export interface NovaLinhaPix {
  origem: 'asaas' | 'sicoob';
  externoId: string;
  data: string;
  valor: number;
  pagadorNome?: string | null;
  pagadorDocumento?: string | null;
  descricao?: string | null;
  contaId?: string | null;
}

const dig = (t: string | null | undefined) => (t ?? '').replace(/\D/g, '');
const primeiroNome = (t: string | null | undefined) =>
  (t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .find((x) => x.length > 2) ?? '';
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/**
 * Pix recebidos: entram pelo Asaas (Pix na chave vira cobrança lá sozinho) e pelo extrato do Sicoob (OFX).
 * Quando a IA recebeu o comprovante e o Pix aparece com o mesmo valor, a baixa (ou amortização) sai sozinha.
 * O que não casa fica numa lista para a equipe dar baixa com um clique.
 */
@Injectable()
export class PixRecebidosService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PixRecebidos');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly asaas: AsaasService,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit() {
    // De hora em hora, traz os Pix dos últimos 3 dias do Asaas (o aviso do Asaas também traz na hora).
    this.timer = setInterval(() => void (this.asaas.configurado ? this.buscarAsaas(3) : Promise.resolve()).catch((e) => this.log.warn(`Pix do Asaas: ${(e as Error).message}`)), 60 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Guarda as linhas novas (as repetidas são ignoradas) e tenta casar cada uma. */
  async registrar(linhas: NovaLinhaPix[]) {
    let novos = 0;
    let baixados = 0;
    for (const l of linhas) {
      if (!(l.valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(l.data)) continue;
      const doc = dig(l.pagadorDocumento);
      const [pessoa] = doc.length === 11 || doc.length === 14 ? await this.db.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.documento, doc)).limit(1) : [];
      const [p] = await this.db
        .insert(pixRecebidos)
        .values({ ...l, pagadorDocumento: doc || null, pessoaId: pessoa?.id ?? null })
        .onConflictDoNothing()
        .returning();
      if (!p) continue;
      novos++;
      if (await this.casarComComprovante(p)) baixados++;
    }
    return { novos, baixados };
  }

  /** Conta onde o dinheiro entrou: a do Asaas (pelo nome) na empresa do título. */
  private async contaAsaas(empresaId: string) {
    const [c] = await this.db.select({ id: contas.id }).from(contas).where(and(eq(contas.empresaId, empresaId), ilike(contas.nome, '%asaas%'))).limit(1);
    return c?.id ?? null;
  }

  /**
   * Baixa os títulos com o valor do Pix, do vencimento mais antigo para o mais novo: o que cobre a parcela inteira
   * quita; o que sobra menor que a parcela amortiza (abre um título com o saldo). O boleto/Pix antigo dos títulos é apagado no Asaas.
   */
  async baixarComValor(tituloIds: string[], valor: number, data: string, contaId: string | null, usuarioId: string | null, origem: Record<string, unknown>) {
    const ts = await this.db.select().from(titulos).where(and(inArray(titulos.id, tituloIds), inArray(titulos.status, ['aberto', 'protestado']))).orderBy(asc(titulos.vencimento));
    if (!ts.length) throw new BadRequestException('Nenhum desses títulos está em aberto.');
    const conta = contaId ?? (await this.contaAsaas(ts[0].empresaId));
    const apagar: string[] = [];
    const baixados: { id: string; valorPago: number; parcial: boolean }[] = [];
    await this.db.transaction(async (tx) => {
      let resta = valor;
      for (let i = 0; i < ts.length && resta > 0; i++) {
        const t = ts[i];
        const ultimo = i === ts.length - 1;
        const pago = ultimo ? resta : Math.min(resta, t.valor);
        const r = await baixarTitulo(tx, t.id, { pagoEm: data, valorPago: pago, contaId: conta, formaPagamento: 'pix' }, usuarioId, this.auditoria, origem);
        if (r.cobrancaAnterior) apagar.push(r.cobrancaAnterior);
        baixados.push({ id: t.id, valorPago: pago, parcial: !!r.saldo });
        resta -= pago;
      }
    });
    for (const c of apagar) await this.asaas.cancelarCobranca(c);
    return baixados;
  }

  /** O Pix casa com um comprovante que a IA recebeu: mesmo valor, data perto e (se os dois têm nome) o mesmo primeiro nome. */
  private async casarComComprovante(p: Pix) {
    const comps = await this.db
      .select()
      .from(cobrancaComprovantes)
      .where(and(eq(cobrancaComprovantes.status, 'pendente'), sql`abs(${cobrancaComprovantes.valor} - ${p.valor}) <= 1`, gte(cobrancaComprovantes.criadoEm, new Date(Date.parse(`${p.data}T00:00:00-03:00`) - 4 * 86400_000))))
      .orderBy(desc(cobrancaComprovantes.criadoEm));
    const c = comps.find(
      (x) =>
        x.tituloIds.length > 0 &&
        (!x.data || (x.data >= somarDias(p.data, -2) && x.data <= somarDias(p.data, 1))) &&
        (!x.pagador || !p.pagadorNome || primeiroNome(x.pagador) === primeiroNome(p.pagadorNome)),
    );
    if (!c) return false;
    return this.baixarPeloComprovante(c, p);
  }

  private async baixarPeloComprovante(c: typeof cobrancaComprovantes.$inferSelect, p: Pix) {
    try {
      const baixados = await this.baixarComValor(c.tituloIds, p.valor, p.data, p.contaId, null, { pix: p.id, comprovante: c.id, automatico: true });
      await this.db.update(pixRecebidos).set({ status: 'baixado', tituloIds: baixados.map((b) => b.id), comprovanteId: c.id, resolvidoEm: new Date(), observacao: 'Baixa automática: comprovante da IA + Pix no extrato' }).where(eq(pixRecebidos.id, p.id));
      await this.db.update(cobrancaComprovantes).set({ status: 'baixado', resolvidoEm: new Date(), observacao: `Baixado sozinho: o Pix de ${formatarReais(p.valor)} apareceu no ${p.origem === 'asaas' ? 'Asaas' : 'extrato do Sicoob'}.` }).where(eq(cobrancaComprovantes.id, c.id));
      const parcial = baixados.some((b) => b.parcial);
      await this.db.insert(cobrancaContatos).values({ pessoaId: c.pessoaId, tipo: 'sistema', texto: `Pix de ${formatarReais(p.valor)} em ${p.data.split('-').reverse().join('/')} conferido no ${p.origem === 'asaas' ? 'Asaas' : 'extrato do Sicoob'} e ${parcial ? 'amortizado (ficou saldo em aberto)' : 'baixado'} sozinho, pelo comprovante que a IA recebeu.` });
      return true;
    } catch (e) {
      this.log.warn(`Pix ${p.id}: baixa automática não saiu: ${(e as Error).message}`);
      return false;
    }
  }

  /** Chamado pela IA logo depois de registrar o comprovante: se o Pix já entrou, baixa na hora. */
  async casarComprovante(comprovanteId: string) {
    const [c] = await this.db.select().from(cobrancaComprovantes).where(eq(cobrancaComprovantes.id, comprovanteId));
    if (!c || c.status !== 'pendente' || !c.valor || !c.tituloIds.length) return { baixado: false };
    const ref = c.data ?? hoje();
    const cands = await this.db
      .select()
      .from(pixRecebidos)
      .where(and(eq(pixRecebidos.status, 'pendente'), sql`abs(${pixRecebidos.valor} - ${c.valor}) <= 1`, gte(pixRecebidos.data, somarDias(ref, -1)), lte(pixRecebidos.data, somarDias(ref, 2))))
      .orderBy(asc(pixRecebidos.data));
    const p = cands.find((x) => !c.pagador || !x.pagadorNome || primeiroNome(c.pagador) === primeiroNome(x.pagadorNome));
    if (!p) return { baixado: false };
    return { baixado: await this.baixarPeloComprovante(c, p), valor: p.valor };
  }

  // ───────────── Asaas ─────────────

  /** Pix recebidos no Asaas nos últimos `dias` que não são de um boleto/Pix gerado pelo sistema (esses já baixam pelo aviso). */
  async buscarAsaas(dias: number) {
    if (!this.asaas.configurado) throw new BadRequestException('Asaas não configurado.');
    const desde = somarDias(hoje(), -Math.max(1, Math.min(dias, 90)));
    const conhecidas = new Set<string>();
    const linhas: NovaLinhaPix[] = [];
    const clientes = new Map<string, { name?: string; cpfCnpj?: string }>();
    for (let offset = 0; offset < 2000; offset += 100) {
      const r = await this.asaas.chamar<{ data: Record<string, any>[]; hasMore: boolean }>('GET', `/payments?billingType=PIX&status=RECEIVED&paymentDate%5Bge%5D=${desde}&limit=100&offset=${offset}`);
      const ids = r.data.map((x) => String(x.id));
      if (ids.length) {
        const deTitulos = await this.db.select({ id: titulos.cobrancaExternaId }).from(titulos).where(inArray(titulos.cobrancaExternaId, ids));
        const deMaletas = await this.db.select({ id: maletas.garantiaCobrancaId }).from(maletas).where(inArray(maletas.garantiaCobrancaId, ids));
        for (const x of [...deTitulos, ...deMaletas]) if (x.id) conhecidas.add(x.id);
      }
      for (const x of r.data) {
        if (conhecidas.has(String(x.id)) || x.externalReference) continue;
        let cli = clientes.get(String(x.customer));
        if (!cli && x.customer) {
          cli = await this.asaas.chamar<{ name?: string; cpfCnpj?: string }>('GET', `/customers/${x.customer}`).catch(() => ({}));
          clientes.set(String(x.customer), cli);
        }
        linhas.push({ origem: 'asaas', externoId: String(x.id), data: String(x.paymentDate ?? x.clientPaymentDate ?? x.dueDate).slice(0, 10), valor: Math.round(Number(x.value) * 100), pagadorNome: cli?.name ?? null, pagadorDocumento: cli?.cpfCnpj ?? null, descricao: x.description ?? null });
      }
      if (!r.hasMore) break;
    }
    const r = await this.registrar(linhas);
    return { ...r, lidos: linhas.length };
  }

  /** Aviso do Asaas de um Pix que não é de título do sistema (Pix direto na chave). */
  async doWebhook(p: Record<string, unknown>) {
    if (String(p.billingType ?? '') !== 'PIX' || p.externalReference) return null;
    let cli: { name?: string; cpfCnpj?: string } = {};
    if (p.customer) cli = await this.asaas.chamar<{ name?: string; cpfCnpj?: string }>('GET', `/customers/${p.customer}`).catch(() => ({}));
    return this.registrar([{ origem: 'asaas', externoId: String(p.id), data: String(p.paymentDate ?? p.clientPaymentDate ?? hoje()).slice(0, 10), valor: Math.round(Number(p.value ?? 0) * 100), pagadorNome: cli.name ?? null, pagadorDocumento: cli.cpfCnpj ?? null, descricao: (p.description as string) ?? null }]);
  }

  // ───────────── Sicoob (extrato OFX) ─────────────

  /** Lê um extrato OFX (o Sicoob exporta nesse formato) e guarda os créditos. */
  async importarOfx(texto: string, contaId: string | null) {
    const blocos = texto.split(/<STMTTRN>/i).slice(1);
    if (!blocos.length) throw new BadRequestException('Não achei lançamentos neste arquivo. Exporte o extrato do Sicoob em OFX (Money).');
    const tag = (b: string, t: string) => (b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i'))?.[1] ?? '').trim();
    const linhas: NovaLinhaPix[] = [];
    for (const b of blocos) {
      const valor = Math.round(Number(tag(b, 'TRNAMT').replace(',', '.')) * 100);
      if (!(valor > 0)) continue;
      const d = tag(b, 'DTPOSTED');
      const memo = [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' · ');
      const doc = memo.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/)?.[0] ?? null;
      const nome = memo.replace(/pix|recebido|receb\.?|transf\.?|cr[eé]d(ito)?|\d[\d./-]*/gi, ' ').replace(/[·:]/g, ' ').replace(/\s+/g, ' ').trim() || null;
      linhas.push({ origem: 'sicoob', externoId: tag(b, 'FITID') || `${d}-${valor}-${memo}`.slice(0, 120), data: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, valor, pagadorNome: nome, pagadorDocumento: doc, descricao: memo || null, contaId });
    }
    const r = await this.registrar(linhas);
    return { ...r, lidos: linhas.length };
  }

  // ───────────── Lista para a equipe ─────────────

  async listar(status: string, dias: number) {
    const desde = somarDias(hoje(), -Math.max(1, Math.min(dias, 365)));
    const lista = await this.db
      .select({ p: pixRecebidos, pessoa: pessoas.nome })
      .from(pixRecebidos)
      .leftJoin(pessoas, eq(pessoas.id, pixRecebidos.pessoaId))
      .where(and(status === 'todos' ? undefined : eq(pixRecebidos.status, status), gte(pixRecebidos.data, desde)))
      .orderBy(desc(pixRecebidos.data), desc(pixRecebidos.criadoEm))
      .limit(300);
    const out = [];
    for (const { p, pessoa } of lista) out.push({ ...p, pessoa, sugestoes: p.status === 'pendente' ? await this.sugestoes(p) : [] });
    return out;
  }

  /** Títulos em aberto que podem ser deste Pix: do mesmo CPF; ou de qualquer um com o mesmo valor (parcela ou boleto emitido). */
  private async sugestoes(p: Pix) {
    const campos = { id: titulos.id, descricao: titulos.descricao, valor: titulos.valor, vencimento: titulos.vencimento, pessoaId: titulos.pessoaId, pessoa: pessoas.nome };
    const base = and(eq(titulos.tipo, 'receber'), inArray(titulos.status, ['aberto', 'protestado']));
    const daPessoa = p.pessoaId ? await this.db.select(campos).from(titulos).leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId)).where(and(base, eq(titulos.pessoaId, p.pessoaId))).orderBy(asc(titulos.vencimento)).limit(8) : [];
    const mesmoValor = await this.db
      .select(campos)
      .from(titulos)
      .leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId))
      .where(and(base, or(sql`abs(${titulos.valor} - ${p.valor}) <= 1`, and(isNotNull(titulos.cobrancaValor), sql`abs(${titulos.cobrancaValor} - ${p.valor}) <= 1`))))
      .orderBy(asc(titulos.vencimento))
      .limit(8);
    const vistos = new Set<string>();
    return [...daPessoa.map((t) => ({ ...t, motivo: 'mesmo CPF' })), ...mesmoValor.map((t) => ({ ...t, motivo: 'mesmo valor' }))].filter((t) => (vistos.has(t.id) ? false : (vistos.add(t.id), true)));
  }

  async baixarManual(pixId: string, tituloIds: string[], usuarioId: string) {
    const [p] = await this.db.select().from(pixRecebidos).where(eq(pixRecebidos.id, pixId));
    if (!p) throw new NotFoundException('Pix não encontrado.');
    if (p.status !== 'pendente') throw new BadRequestException(`Este Pix já está ${p.status}.`);
    const baixados = await this.baixarComValor(tituloIds, p.valor, p.data, p.contaId, usuarioId, { pix: p.id });
    await this.db.update(pixRecebidos).set({ status: 'baixado', tituloIds: baixados.map((b) => b.id), resolvidoPor: usuarioId, resolvidoEm: new Date() }).where(eq(pixRecebidos.id, p.id));
    return { ok: true, baixados };
  }

  async ignorar(pixId: string, motivo: string | null, usuarioId: string) {
    const [p] = await this.db.update(pixRecebidos).set({ status: 'ignorado', observacao: motivo, resolvidoPor: usuarioId, resolvidoEm: new Date() }).where(and(eq(pixRecebidos.id, pixId), eq(pixRecebidos.status, 'pendente'))).returning();
    if (!p) throw new BadRequestException('Este Pix não está pendente.');
    await this.auditoria.registrar({ usuarioId, acao: 'ignorar_pix', entidade: 'pix', entidadeId: pixId, dados: { motivo } });
    return { ok: true };
  }
}
