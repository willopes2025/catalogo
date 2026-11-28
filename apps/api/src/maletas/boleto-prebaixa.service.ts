import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { crmCanais, maletaItens, maletas, pessoas } from '../db/schema';
import { AsaasService } from '../integracoes/asaas.service';
import { MaletasService, hoje } from './maletas.service';

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (d: string) => d.split('-').reverse().join('/');
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Boleto da pré-baixa: X dias antes do acerto, quem lançou vendas no sistema (pré-baixa) recebe pelo WhatsApp
 * o boleto do que deve (vendidas menos a comissão). Pago, vira crédito: a equipe dá a baixa e manda o novo pedido.
 */
@Injectable()
export class BoletoPrebaixaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('BoletoPrebaixa');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly maletasSvc: MaletasService,
    private readonly asaas: AsaasService,
    private readonly config: ConfiguracoesService,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.PREBAIXA_AUTOMATICA === '0') return;
    this.timer = setInterval(() => void this.rotina().catch((e) => this.log.warn(`Rotina: ${(e as Error).message}`)), 60 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Quanto ela deve pelas vendas lançadas (com a comissão à vista, no prazo do acerto). */
  async calcular(maletaId: string) {
    const itens = await this.db.select({ produtoId: maletaItens.produtoId, vendida: maletaItens.prebaixaVendida }).from(maletaItens).where(and(eq(maletaItens.maletaId, maletaId), sql`coalesce(${maletaItens.prebaixaVendida}, 0) > 0`));
    if (!itens.length) return { pecas: 0, valor: 0 };
    const [m] = await this.db.select({ dataLimite: maletas.dataLimite }).from(maletas).where(eq(maletas.id, maletaId));
    const sim = (await this.maletasSvc.simular(maletaId, {
      forma: 'avista',
      modalidade: 'presencial',
      parcial: true,
      dataAcerto: m.dataLimite > hoje() ? m.dataLimite : hoje(),
      itens: itens.map((i) => ({ produtoId: i.produtoId, vendida: i.vendida ?? 0, devolvida: 0, perdida: 0 })),
      parcelas: 1,
      formaPagamento: 'boleto',
      pagoAgora: false,
      usarCredito: true,
    })) as { resultado: { totalAPagar: number } };
    return { pecas: itens.reduce((a, i) => a + (i.vendida ?? 0), 0), valor: sim.resultado.totalAPagar };
  }

  /** Emite (ou reaproveita) o boleto e manda no WhatsApp da consultora. */
  async disparar(maletaId: string, usuarioId: string | null) {
    const [m] = await this.db.select({ id: maletas.id, numero: maletas.numero, dataLimite: maletas.dataLimite, status: maletas.status, pessoaId: pessoas.id, nome: pessoas.nome, telefone: pessoas.telefone1 }).from(maletas).innerJoin(pessoas, eq(pessoas.id, maletas.representanteId)).where(eq(maletas.id, maletaId));
    if (!m) throw new BadRequestException('Pedido não encontrado.');
    if (m.status !== 'aberta') throw new BadRequestException('Este pedido não está aberto.');
    const { pecas, valor } = await this.calcular(maletaId);
    if (!pecas) throw new BadRequestException('A consultora ainda não lançou vendas neste pedido.');
    if (valor <= 0) throw new BadRequestException('Pelas vendas lançadas não há valor a pagar (o crédito dela cobre).');
    const b = await this.asaas.boletoPrebaixaMaleta(maletaId, valor, usuarioId);
    const cfg = await this.config.ler('boleto_prebaixa');
    const dias = Math.max(0, Math.round((Date.parse(`${m.dataLimite}T12:00:00Z`) - Date.parse(`${hoje()}T12:00:00Z`)) / 86_400_000));
    const texto = cfg.texto
      .replace(/\{\{\s*primeiro_nome\s*\}\}/g, m.nome.split(' ')[0])
      .replace(/\{\{\s*nome\s*\}\}/g, m.nome)
      .replace(/\{\{\s*numero\s*\}\}/g, String(m.numero))
      .replace(/\{\{\s*dias\s*\}\}/g, String(dias))
      .replace(/\{\{\s*data_acerto\s*\}\}/g, br(m.dataLimite))
      .replace(/\{\{\s*pecas\s*\}\}/g, String(pecas))
      .replace(/\{\{\s*valor\s*\}\}/g, reais(valor))
      .replace(/\{\{\s*link\s*\}\}/g, b.url ?? '');
    let whatsapp = 'sem telefone no cadastro';
    if (m.telefone) {
      try {
        const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(asc(crmCanais.criadoEm));
        const canal = cs.find((c) => c.tipo !== 'oficial' && c.tipo !== 'instagram') ?? cs.find((c) => c.tipo !== 'instagram');
        if (!canal) throw new Error('nenhum número de WhatsApp ativo no CRM');
        const contato = await this.crm.garantirContato({ telefone: m.telefone, nome: m.nome, pessoaId: m.pessoaId });
        const cv = await this.canais.garantirConversa(contato.id, canal.id, 'resolvida');
        await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto: texto + (b.url && !cfg.texto.includes('{{link}}') ? `\n\n${b.url}` : '') });
        whatsapp = 'enviado';
      } catch (e) {
        whatsapp = `não foi: ${(e as Error).message}`;
      }
    }
    return { ...b, pecas, whatsapp };
  }

  /** De hora em hora (das 8h às 20h): pedidos com acerto em até X dias, com vendas lançadas e sem boleto ainda. */
  async rotina() {
    const cfg = await this.config.ler('boleto_prebaixa');
    if (!cfg.ativo || !this.asaas.configurado) return;
    const hora = new Date(Date.now() - 3 * 3600_000).getUTCHours();
    if (hora < 8 || hora >= 20) return;
    const h = hoje();
    const lista = await this.db
      .select({ id: maletas.id, numero: maletas.numero })
      .from(maletas)
      .where(and(
        eq(maletas.status, 'aberta'),
        isNull(maletas.prebaixaBoletoEm),
        sql`${maletas.dataLimite} > ${h}::date`,
        sql`${maletas.dataLimite} <= ${somarDias(h, cfg.diasAntes)}::date`,
        sql`exists (select 1 from ${maletaItens} i where i.maleta_id = ${maletas.id} and coalesce(i.prebaixa_vendida, 0) > 0)`,
      ))
      .limit(100);
    for (const m of lista) {
      try {
        const r = await this.disparar(m.id, null);
        this.log.log(`Pedido ${m.numero}: boleto da pré-baixa ${r.jaExistia ? 'reenviado' : 'emitido'} (WhatsApp ${r.whatsapp}).`);
      } catch (e) {
        // Não tenta de novo a cada hora: marca e a equipe vê o motivo na auditoria / dispara à mão.
        await this.db.update(maletas).set({ prebaixaBoletoEm: new Date() }).where(eq(maletas.id, m.id));
        this.log.warn(`Pedido ${m.numero}: boleto da pré-baixa não saiu (${(e as Error).message})`);
      }
    }
  }
}
