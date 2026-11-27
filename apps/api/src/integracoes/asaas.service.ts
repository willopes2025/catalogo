import { BadRequestException, Inject, Injectable, Logger, type OnApplicationBootstrap, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { CobrancaConfigService } from '../cobranca/cobranca-config.service';
import { SegredosService } from '../segredos/segredos.service';
import { configuracoes, contas, creditos, eventosIntegracao, maletas, pessoas, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

/**
 * Asaas: boletos e Pix da matriz.
 *   ASAAS_API_KEY        chave da conta (Integrações › Chave de API, no painel do Asaas)
 *   ASAAS_URL            https://api-sandbox.asaas.com/v3 para testes; https://api.asaas.com/v3 em produção
 *   ASAAS_WEBHOOK_TOKEN  token que o Asaas envia no cabeçalho asaas-access-token dos avisos
 * O webhook deve apontar para https://<domínio>/api/webhooks/asaas com os eventos de cobrança.
 */
@Injectable()
export class AsaasService implements OnApplicationBootstrap {
  private readonly log = new Logger('Asaas');
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly config: CobrancaConfigService,
    private readonly segredos: SegredosService,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.desligarNotificacoesDosClientes().catch((e) => this.log.warn(`Notificações do Asaas: ${(e as Error).message}`)), 20_000).unref();
  }

  /**
   * Desliga (uma vez) as notificações automáticas do Asaas (SMS, e-mail, WhatsApp) de todos os clientes já
   * cadastrados lá. Os novos já nascem com elas desligadas.
   */
  async desligarNotificacoesDosClientes(forcar = false) {
    if (!this.configurado) return { atualizados: 0, falhas: 0 };
    const chave = `asaas_notificacoes_desligadas:${this.ambiente}`;
    if (!forcar) {
      const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, chave));
      if (c) return { atualizados: 0, falhas: 0 };
    }
    const lista = await this.db.select({ id: pessoas.asaasClienteId }).from(pessoas).where(sql`${pessoas.asaasClienteId} is not null`);
    let atualizados = 0;
    let falhas = 0;
    for (const p of lista) {
      try {
        await this.chamar('PUT', `/customers/${p.id}`, { notificationDisabled: true });
        atualizados++;
      } catch (e) {
        falhas++;
        this.log.warn(`Cliente ${p.id}: notificações não desligadas: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.db.insert(configuracoes).values({ chave, valor: { em: new Date().toISOString(), atualizados, falhas } }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: { em: new Date().toISOString(), atualizados, falhas }, atualizadoEm: new Date() } });
    this.log.log(`Notificações automáticas do Asaas desligadas em ${atualizados} cliente(s) (${falhas} falha(s)).`);
    return { atualizados, falhas };
  }

  get configurado() {
    return !!this.segredos.v('ASAAS_API_KEY');
  }
  get ambiente() {
    return /\/\/api\.asaas\.com/.test(this.url) ? 'produção' : 'testes (sandbox)';
  }
  private get url() {
    // Ambiente escolhido na tela; sem escolha, o ASAAS_URL do servidor (os testes usam um simulador).
    if (this.segredos.origem('ASAAS_AMBIENTE') === 'tela') return this.segredos.v('ASAAS_AMBIENTE') === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
    return (process.env.ASAAS_URL ?? 'https://api-sandbox.asaas.com/v3').replace(/\/$/, '');
  }

  /** Teste de conexão para a tela de integrações (só lê; não cria nada). */
  async testar() {
    await this.chamar('GET', '/customers?limit=1');
    return { ok: true, mensagem: `Conectado ao Asaas (${this.ambiente}).` };
  }

  async chamar<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    if (!this.configurado) throw new ServiceUnavailableException('O Asaas ainda não foi ligado: falta a chave da API da Aritana.');
    const r = await fetch(this.url + caminho, {
      method: metodo,
      headers: {
        access_token: this.segredos.v('ASAAS_API_KEY')!,
        'content-type': 'application/json',
        'user-agent': 'PlataformaAritana',
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as {
      errors?: { description: string }[];
    } & T;
    if (!r.ok) {
      this.log.error(`${metodo} ${caminho} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
      throw new BadRequestException(`Asaas: ${j.errors?.map((e) => e.description).join(' ') || `erro ${r.status}`}`);
    }
    return j;
  }

  /**
   * Cria (uma vez) a pessoa como cliente no Asaas. Com `atualizar`, manda de novo nome, e-mail, celular e endereço
   * do cadastro (o boleto novo sai com os dados de hoje, e os avisos do Asaas vão para o contato certo).
   */
  async clienteAsaas(pessoaId: string, atualizar = false) {
    const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p) throw new BadRequestException('Pessoa não encontrada.');
    if (!p.documento && !p.asaasClienteId) throw new BadRequestException('Para gerar boleto ou Pix, o cadastro precisa ter CPF ou CNPJ.');
    const dados = {
      name: p.nome,
      cpfCnpj: p.documento ?? undefined,
      email: p.email ?? undefined,
      mobilePhone: p.telefone1 ?? undefined,
      postalCode: p.cep ?? undefined,
      address: p.logradouro ?? undefined,
      addressNumber: p.numero ?? undefined,
      province: p.bairro ?? undefined,
      externalReference: p.id,
      // Sem SMS/e-mail/WhatsApp automáticos do Asaas: quem avisa a cliente é a Aritana.
      notificationDisabled: true,
    };
    if (p.asaasClienteId) {
      if (atualizar) await this.chamar('PUT', `/customers/${p.asaasClienteId}`, dados).catch((e) => this.log.warn(`Cadastro do cliente ${p.asaasClienteId} não atualizado no Asaas: ${(e as Error).message}`));
      return p.asaasClienteId;
    }
    const c = await this.chamar<{ id: string }>('POST', '/customers', dados);
    await this.db.update(pessoas).set({ asaasClienteId: c.id }).where(eq(pessoas.id, p.id));
    return c.id;
  }

  /** Apaga a cobrança no Asaas e diz se conseguiu (já apagada lá conta como apagada). */
  async apagarCobranca(cobrancaId: string): Promise<{ ok: boolean; erro?: string }> {
    if (!this.configurado) return { ok: false, erro: 'Asaas não configurado' };
    try {
      await this.chamar('DELETE', `/payments/${cobrancaId}`);
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      if (/404|not found|não encontrad|removed|removid/i.test(msg)) return { ok: true };
      return { ok: false, erro: msg.slice(0, 200) };
    }
  }

  /** Título cancelado: apaga a cobrança no Asaas para a pessoa não pagar algo que não deve. */
  async cancelarCobranca(cobrancaId: string | null) {
    if (!cobrancaId || !this.configurado) return;
    await this.chamar('DELETE', `/payments/${cobrancaId}`).catch((e) => this.log.warn(`Não apagou a cobrança ${cobrancaId}: ${(e as Error).message}`));
  }

  /** Pago fora do Asaas (dinheiro, maquininha): avisa o Asaas para não cobrar de novo. */
  async informarPagamentoManual(cobrancaId: string | null, data: string, valor: number) {
    if (!cobrancaId || !this.configurado) return;
    await this.chamar('POST', `/payments/${cobrancaId}/receiveInCash`, {
      paymentDate: data,
      value: valor / 100,
      notifyCustomer: false,
    }).catch((e) => this.log.warn(`Não informou o pagamento manual da cobrança ${cobrancaId}: ${(e as Error).message}`));
  }

  /**
   * Gera boleto ou Pix para um título a receber.
   * `nova`: emite outra (segunda via, novo vencimento, valor com encargos) e apaga a anterior no Asaas.
   * O título passa a apontar só para a cobrança nova: é ela que aparece na ficha, no portal e nas mensagens.
   */
  async cobrar(tituloId: string, tipo: 'BOLETO' | 'PIX', usuarioId: string | null, nova?: { valor: number; vencimento: string }) {
    const [t] = await this.db.select().from(titulos).where(eq(titulos.id, tituloId));
    if (!t) throw new BadRequestException('Título não encontrado.');
    if (t.tipo !== 'receber' || (t.status !== 'aberto' && t.status !== 'protestado')) throw new BadRequestException('Só títulos a receber em aberto podem ser cobrados.');
    if (!t.pessoaId) throw new BadRequestException('O título não tem pagador.');
    if (t.formaPagamento === 'debito' || t.formaPagamento === 'credito') throw new BadRequestException('Título de cartão é pago pela maquininha; não gera boleto nem Pix.');
    if (t.cobrancaExternaId && !nova)
      return {
        id: t.cobrancaExternaId,
        url: t.cobrancaUrl,
        pixCopiaCola: t.pixCopiaCola,
        jaExistia: true,
      };
    const customer = await this.clienteAsaas(t.pessoaId, !!nova);
    // Multa e juros da configuração de cobrança: o Asaas calcula se a pessoa pagar depois do vencimento.
    const cfg = await this.config.obter();
    const encargos = cfg.multaPb > 0 || cfg.jurosMesPb > 0 ? cfg : null;
    const venc = nova ? nova.vencimento : t.vencimento < hoje() ? hoje() : t.vencimento;
    const valor = nova ? nova.valor : t.valor;
    const pg = await this.chamar<{
      id: string;
      invoiceUrl?: string;
      bankSlipUrl?: string;
    }>('POST', '/payments', {
      customer,
      billingType: tipo,
      value: valor / 100,
      dueDate: venc,
      description: t.descricao.slice(0, 500),
      externalReference: t.id,
      ...(encargos
        ? {
            fine: { value: encargos.multaPb / 100 },
            interest: { value: encargos.jurosMesPb / 100 },
          }
        : {}),
    });
    let pix: string | null = null;
    if (tipo === 'PIX') {
      const q = await this.chamar<{ payload?: string }>('GET', `/payments/${pg.id}/pixQrCode`).catch(() => ({ payload: undefined }));
      pix = q.payload ?? null;
    }
    const url = pg.invoiceUrl ?? pg.bankSlipUrl ?? null;
    await this.db
      .update(titulos)
      .set({
        cobrancaExternaId: pg.id,
        cobrancaTipo: tipo,
        cobrancaUrl: url,
        pixCopiaCola: pix,
        cobrancaValor: valor,
        cobrancaVencimento: venc,
      })
      .where(eq(titulos.id, t.id));
    // A anterior deixa de valer: apaga no Asaas para ninguém pagar duas vezes.
    if (nova && t.cobrancaExternaId && t.cobrancaExternaId !== pg.id) await this.cancelarCobranca(t.cobrancaExternaId);
    await this.auditoria.registrar({
      usuarioId,
      acao: 'gerar_cobranca',
      entidade: 'titulo',
      entidadeId: t.id,
      dados: { asaas: pg.id, tipo, ...(nova ? { segundaVia: true, anterior: t.cobrancaExternaId, valor, vencimento: venc } : {}) },
    });
    return { id: pg.id, url, pixCopiaCola: pix, jaExistia: false };
  }

  /**
   * Boleto de garantia da maleta (no lugar da promissória): valor da maleta, vence no acerto.
   * Não vira título a receber (não é dívida ainda); é cancelado no acerto. Se ela pagar, vira crédito.
   */
  async boletoGarantiaMaleta(maletaId: string, usuarioId: string) {
    if (!this.configurado) throw new BadRequestException('Asaas não configurado: configure em Configurações › Integrações.');
    const [m] = await this.db.select().from(maletas).where(eq(maletas.id, maletaId));
    if (!m) throw new BadRequestException('Maleta não encontrada.');
    if (m.status !== 'aberta') throw new BadRequestException(`Esta maleta está ${m.status}.`);
    const [{ valor }] = (
      await this.db.execute<{ valor: number }>(sql`
        select coalesce(sum((i.enviada - i.vendida - i.devolvida - i.perdida) * i.preco), 0)::int as valor
        from maleta_itens i where i.maleta_id = ${maletaId}`)
    ).rows;
    if (valor <= 0) throw new BadRequestException('A maleta está sem peças.');
    const venc = m.dataLimite > hoje() ? m.dataLimite : hoje();
    if (m.garantiaCobrancaId && !m.garantiaPagaEm && m.garantiaValor === valor && m.garantiaVencimento === venc)
      return { id: m.garantiaCobrancaId, url: m.garantiaUrl, linha: m.garantiaLinha, valor, vencimento: venc, jaExistia: true };
    const customer = await this.clienteAsaas(m.representanteId, false);
    const pg = await this.chamar<{ id: string; invoiceUrl?: string; bankSlipUrl?: string }>('POST', '/payments', {
      customer,
      billingType: 'BOLETO',
      value: valor / 100,
      dueDate: venc,
      description: `Garantia da maleta nº ${m.numero} (consignado). Será cancelado no acerto.`,
      externalReference: `maleta-garantia:${m.id}`,
    });
    const linha = await this.chamar<{ identificationField?: string }>('GET', `/payments/${pg.id}/identificationField`).then((r) => r.identificationField ?? null).catch(() => null);
    const url = pg.bankSlipUrl ?? pg.invoiceUrl ?? null;
    await this.db.update(maletas).set({ garantiaCobrancaId: pg.id, garantiaUrl: url, garantiaLinha: linha, garantiaValor: valor, garantiaVencimento: venc, garantiaPagaEm: null }).where(eq(maletas.id, m.id));
    if (m.garantiaCobrancaId && !m.garantiaPagaEm && m.garantiaCobrancaId !== pg.id) await this.cancelarCobranca(m.garantiaCobrancaId);
    await this.auditoria.registrar({ usuarioId, acao: 'gerar_cobranca', entidade: 'maleta', entidadeId: m.id, dados: { asaas: pg.id, tipo: 'BOLETO', garantia: true, valor, vencimento: venc } });
    return { id: pg.id, url, linha, valor, vencimento: venc, jaExistia: false };
  }

  /** Acerto ou cancelamento da maleta: o boleto de garantia deixa de valer. */
  async cancelarGarantiaMaleta(maletaId: string) {
    const [m] = await this.db.select({ id: maletas.garantiaCobrancaId, paga: maletas.garantiaPagaEm }).from(maletas).where(eq(maletas.id, maletaId));
    if (!m?.id || m.paga) return;
    await this.cancelarCobranca(m.id);
    await this.db.update(maletas).set({ garantiaCobrancaId: null, garantiaUrl: null, garantiaLinha: null, garantiaValor: null, garantiaVencimento: null }).where(eq(maletas.id, maletaId));
  }

  /**
   * Aviso de pagamento do Asaas. Valida o token, guarda o evento (para não processar duas vezes)
   * e dá baixa no título correspondente.
   */
  async receberWebhook(token: string | undefined, evento: { id?: string; event?: string; payment?: Record<string, unknown> }) {
    const esperado = this.segredos.v('ASAAS_WEBHOOK_TOKEN');
    if (!esperado) throw new ServiceUnavailableException('Webhook do Asaas não configurado.');
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Token inválido.');
    const idEvento = String(evento.id ?? `${evento.event}:${evento.payment?.id}`);
    const inserido = await this.db
      .insert(eventosIntegracao)
      .values({
        id: `asaas:${idEvento}`,
        origem: 'asaas',
        tipo: String(evento.event ?? ''),
        payload: evento,
      })
      .onConflictDoNothing()
      .returning({ id: eventosIntegracao.id });
    if (!inserido.length) return { recebido: true, repetido: true };

    let resultado = 'ignorado';
    try {
      if (evento.event === 'PAYMENT_RECEIVED' || evento.event === 'PAYMENT_CONFIRMED') {
        const p = evento.payment ?? {};
        const ref = String(p.externalReference ?? '');
        if (ref.startsWith('maleta-garantia:')) {
          // Pagou o boleto de garantia: vira crédito dela (usado no acerto) e a maleta registra que foi pago.
          const [m] = await this.db.select().from(maletas).where(eq(maletas.id, ref.slice('maleta-garantia:'.length)));
          if (m && !m.garantiaPagaEm) {
            const data = String(p.paymentDate ?? p.clientPaymentDate ?? p.confirmedDate ?? hoje()).slice(0, 10);
            const valor = Math.round(Number(p.value ?? 0) * 100);
            await this.db.update(maletas).set({ garantiaPagaEm: data }).where(eq(maletas.id, m.id));
            await this.db.insert(creditos).values({ pessoaId: m.representanteId, valor, descricao: `Pagou o boleto de garantia da maleta nº ${m.numero}`, origemTipo: 'garantia_maleta', origemId: m.id, usuarioId: null });
            await this.auditoria.registrar({ usuarioId: null, acao: 'baixa_automatica', entidade: 'maleta', entidadeId: m.id, dados: { asaas: p.id, valor, garantia: true } });
            resultado = 'garantia paga: virou crédito';
          } else resultado = 'garantia já registrada';
        } else {
        const [t] = await this.db
          .select()
          .from(titulos)
          .where(or(eq(titulos.cobrancaExternaId, String(p.id ?? '')), eq(titulos.id, isUuid(p.externalReference) ? String(p.externalReference) : '00000000-0000-0000-0000-000000000000')));
        if (!t) resultado = 'título não encontrado';
        else if (t.status !== 'aberto' && t.status !== 'protestado') resultado = `título já ${t.status}`;
        else {
          const [contaAsaas] = await this.db
            .select({ id: contas.id })
            .from(contas)
            .where(and(eq(contas.empresaId, t.empresaId), ilike(contas.nome, '%asaas%')))
            .limit(1);
          const data = String(p.paymentDate ?? p.clientPaymentDate ?? p.confirmedDate ?? hoje()).slice(0, 10);
          const valor = Math.round(Number(p.value ?? t.valor / 100) * 100);
          await this.db
            .update(titulos)
            .set({
              status: 'pago',
              pagoEm: data,
              valorPago: valor,
              contaId: contaAsaas?.id ?? null,
              formaPagamento: t.cobrancaTipo === 'PIX' ? 'pix' : 'boleto',
            })
            .where(and(eq(titulos.id, t.id), inArray(titulos.status, ['aberto', 'protestado'])));
          await this.auditoria.registrar({
            usuarioId: null,
            acao: 'baixa_automatica',
            entidade: 'titulo',
            entidadeId: t.id,
            dados: { asaas: p.id, valor },
          });
          resultado = 'baixado';
        }
        }
      }
    } catch (e) {
      // Sem registrar o evento como processado: o Asaas tenta de novo e a baixa não se perde.
      await this.db.delete(eventosIntegracao).where(eq(eventosIntegracao.id, `asaas:${idEvento}`));
      throw e;
    }
    await this.db
      .update(eventosIntegracao)
      .set({ resultado })
      .where(eq(eventosIntegracao.id, `asaas:${idEvento}`));
    return { recebido: true, resultado };
  }
}

const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
