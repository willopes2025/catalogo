import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, ilike, or } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { contas, eventosIntegracao, pessoas, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

/**
 * Asaas: boletos e Pix da matriz.
 *   ASAAS_API_KEY        chave da conta (Integrações › Chave de API, no painel do Asaas)
 *   ASAAS_URL            https://api-sandbox.asaas.com/v3 para testes; https://api.asaas.com/v3 em produção
 *   ASAAS_WEBHOOK_TOKEN  token que o Asaas envia no cabeçalho asaas-access-token dos avisos
 * O webhook deve apontar para https://<domínio>/api/webhooks/asaas com os eventos de cobrança.
 */
@Injectable()
export class AsaasService {
  private readonly log = new Logger('Asaas');
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  get configurado() {
    return !!process.env.ASAAS_API_KEY;
  }
  private get url() {
    return (process.env.ASAAS_URL ?? 'https://api-sandbox.asaas.com/v3').replace(/\/$/, '');
  }

  private async chamar<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    if (!this.configurado) throw new ServiceUnavailableException('O Asaas ainda não foi ligado: falta a chave da API da Aritana.');
    const r = await fetch(this.url + caminho, {
      method: metodo,
      headers: { access_token: process.env.ASAAS_API_KEY!, 'content-type': 'application/json', 'user-agent': 'PlataformaAritana' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as { errors?: { description: string }[] } & T;
    if (!r.ok) {
      this.log.error(`${metodo} ${caminho} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
      throw new BadRequestException(`Asaas: ${j.errors?.map((e) => e.description).join(' ') || `erro ${r.status}`}`);
    }
    return j;
  }

  /** Cria (uma vez) a pessoa como cliente no Asaas. */
  private async clienteAsaas(pessoaId: string) {
    const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p) throw new BadRequestException('Pessoa não encontrada.');
    if (p.asaasClienteId) return p.asaasClienteId;
    if (!p.documento) throw new BadRequestException('Para gerar boleto ou Pix, o cadastro precisa ter CPF ou CNPJ.');
    const c = await this.chamar<{ id: string }>('POST', '/customers', {
      name: p.nome,
      cpfCnpj: p.documento,
      email: p.email ?? undefined,
      mobilePhone: p.telefone1 ?? undefined,
      postalCode: p.cep ?? undefined,
      addressNumber: p.numero ?? undefined,
      externalReference: p.id,
      notificationDisabled: false,
    });
    await this.db.update(pessoas).set({ asaasClienteId: c.id }).where(eq(pessoas.id, p.id));
    return c.id;
  }

  /** Gera boleto ou Pix para um título a receber. */
  async cobrar(tituloId: string, tipo: 'BOLETO' | 'PIX', usuarioId: string | null) {
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, tituloId));
    if (!t) throw new BadRequestException('Título não encontrado.');
    if (t.tipo !== 'receber' || t.status !== 'aberto') throw new BadRequestException('Só títulos a receber em aberto podem ser cobrados.');
    if (!t.pessoaId) throw new BadRequestException('O título não tem pagador.');
    if (t.formaPagamento === 'debito' || t.formaPagamento === 'credito') throw new BadRequestException('Título de cartão é pago pela maquininha; não gera boleto nem Pix.');
    if (t.cobrancaExternaId) return { id: t.cobrancaExternaId, url: t.cobrancaUrl, pixCopiaCola: t.pixCopiaCola, jaExistia: true };
    const customer = await this.clienteAsaas(t.pessoaId);
    const venc = t.vencimento < hoje() ? hoje() : t.vencimento;
    const pg = await this.chamar<{ id: string; invoiceUrl?: string; bankSlipUrl?: string }>('POST', '/payments', {
      customer,
      billingType: tipo,
      value: t.valor / 100,
      dueDate: venc,
      description: t.descricao.slice(0, 500),
      externalReference: t.id,
    });
    let pix: string | null = null;
    if (tipo === 'PIX') {
      const q = await this.chamar<{ payload?: string }>('GET', `/payments/${pg.id}/pixQrCode`).catch(() => ({ payload: undefined }));
      pix = q.payload ?? null;
    }
    const url = pg.invoiceUrl ?? pg.bankSlipUrl ?? null;
    await this.db.update(titulos).set({ cobrancaExternaId: pg.id, cobrancaTipo: tipo, cobrancaUrl: url, pixCopiaCola: pix }).where(eq(titulos.id, t.id));
    await this.auditoria.registrar({ usuarioId, acao: 'gerar_cobranca', entidade: 'titulo', entidadeId: t.id, dados: { asaas: pg.id, tipo } });
    return { id: pg.id, url, pixCopiaCola: pix, jaExistia: false };
  }

  /**
   * Aviso de pagamento do Asaas. Valida o token, guarda o evento (para não processar duas vezes)
   * e dá baixa no título correspondente.
   */
  async receberWebhook(token: string | undefined, evento: { id?: string; event?: string; payment?: Record<string, unknown> }) {
    const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
    if (!esperado) throw new ServiceUnavailableException('Webhook do Asaas não configurado.');
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Token inválido.');
    const idEvento = String(evento.id ?? `${evento.event}:${evento.payment?.id}`);
    const inserido = await this.db
      .insert(eventosIntegracao)
      .values({ id: `asaas:${idEvento}`, origem: 'asaas', tipo: String(evento.event ?? ''), payload: evento })
      .onConflictDoNothing()
      .returning({ id: eventosIntegracao.id });
    if (!inserido.length) return { recebido: true, repetido: true };

    let resultado = 'ignorado';
    if (evento.event === 'PAYMENT_RECEIVED' || evento.event === 'PAYMENT_CONFIRMED') {
      const p = evento.payment ?? {};
      const [t] = await this.db
        .select()
        .from(titulos)
        .where(or(eq(titulos.cobrancaExternaId, String(p.id ?? '')), eq(titulos.id, isUuid(p.externalReference) ? String(p.externalReference) : '00000000-0000-0000-0000-000000000000')));
      if (!t) resultado = 'título não encontrado';
      else if (t.status !== 'aberto') resultado = `título já ${t.status}`;
      else {
        const [contaAsaas] = await this.db.select({ id: contas.id }).from(contas).where(and(eq(contas.empresaId, t.empresaId), ilike(contas.nome, '%asaas%'))).limit(1);
        const data = String(p.paymentDate ?? p.clientPaymentDate ?? p.confirmedDate ?? hoje()).slice(0, 10);
        const valor = Math.round(Number(p.value ?? t.valor / 100) * 100);
        await this.db.update(titulos).set({ status: 'pago', pagoEm: data, valorPago: valor, contaId: contaAsaas?.id ?? null, formaPagamento: t.cobrancaTipo === 'PIX' ? 'pix' : 'boleto' }).where(eq(titulos.id, t.id));
        await this.auditoria.registrar({ usuarioId: null, acao: 'baixa_automatica', entidade: 'titulo', entidadeId: t.id, dados: { asaas: p.id, valor } });
        resultado = 'baixado';
      }
    }
    await this.db.update(eventosIntegracao).set({ resultado }).where(eq(eventosIntegracao.id, `asaas:${idEvento}`));
    return { recebido: true, resultado };
  }
}

const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
