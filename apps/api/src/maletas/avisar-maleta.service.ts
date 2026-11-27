import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { urlPublica } from '../comum/url';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { crmCanais } from '../db/schema';
import { EmailService } from '../integracoes/email.service';
import { MaletasService } from './maletas.service';

export type MomentoAviso = 'montagem' | 'alteracao' | 'acerto';

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '');
const FORMA: Record<string, string> = { pix: 'Pix', boleto: 'boleto', dinheiro: 'dinheiro', debito: 'cartão de débito', credito: 'cartão de crédito', deposito: 'depósito', cartao: 'cartão' };

/** "Enviar e-mail?" no fim: na montagem, ao terminar as alterações e no acerto (e-mail e/ou WhatsApp). */
@Injectable()
export class AvisarMaletaService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly maletas: MaletasService,
    private readonly email: EmailService,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Monta o texto (também usado para mostrar a prévia antes de enviar). */
  async montar(maletaId: string, momento: MomentoAviso) {
    const m = await this.maletas.obter(maletaId);
    const primeiro = m.representante.split(' ')[0];
    const base = urlPublica();
    const linhas: string[] = [];
    let assunto: string;
    if (momento === 'acerto') {
      const a = m.acertos.at(-1);
      if (!a) throw new BadRequestException('Esta maleta ainda não tem acerto.');
      const r = (a.resultado ?? {}) as { pecas?: { vendidas?: number; devolvidas?: number; perdidas?: number }; totalVendido?: number; comissao?: number; totalAPagar?: number; creditoUsado?: number };
      assunto = `Acerto da maleta nº ${m.numero}`;
      linhas.push(`Olá, ${primeiro}! Segue o resumo do acerto da sua maleta nº ${m.numero} (${br(a.data)}):`, '');
      linhas.push(`• Vendidas: ${r.pecas?.vendidas ?? 0} peça(s)${r.totalVendido ? ` (${reais(r.totalVendido)})` : ''}`);
      linhas.push(`• Devolvidas: ${r.pecas?.devolvidas ?? 0}`);
      if (r.pecas?.perdidas) linhas.push(`• Perdidas: ${r.pecas.perdidas}`);
      if (r.comissao) linhas.push(`• Sua comissão: ${reais(r.comissao)}`);
      if (r.creditoUsado) linhas.push(`• Crédito usado: ${reais(r.creditoUsado)}`);
      linhas.push(`• Total a pagar: ${reais(a.totalAPagar)}`);
      const parcelas = (m.parcelasAcerto ?? []).filter((p) => p.acertoId === a.id);
      if (parcelas.length) {
        linhas.push('', parcelas.length > 1 ? 'Parcelas:' : 'Pagamento:');
        for (const p of parcelas)
          linhas.push(`• ${reais(p.valor)} · vence ${br(p.vencimento)} · ${p.status === 'pago' ? `pago${p.formaPagamento ? ` (${FORMA[p.formaPagamento] ?? p.formaPagamento})` : ''}` : (p.cobrancaUrl ? `pague por aqui: ${p.cobrancaUrl}` : 'em aberto')}`);
      }
      if (m.status === 'aberta') linhas.push('', `A maleta continua com você: ${m.totais.pecas} peça(s), acerto até ${br(m.dataLimite)}.`, `Veja o pedido com as fotos: ${base}/pedido/${m.linkToken}`);
    } else {
      assunto = momento === 'montagem' ? `Sua maleta nº ${m.numero} está pronta` : `Sua maleta nº ${m.numero} foi atualizada`;
      linhas.push(momento === 'montagem' ? `Olá, ${primeiro}! Sua maleta nº ${m.numero} está pronta.` : `Olá, ${primeiro}! Sua maleta nº ${m.numero} foi atualizada.`, '');
      linhas.push(`• Peças: ${m.totais.pecas}`, `• Valor: ${reais(m.totais.valor)}`, `• Acerto até: ${br(m.dataLimite)}`, '');
      linhas.push(`Veja o pedido com as fotos das peças: ${base}/pedido/${m.linkToken}`);
      const prom = m.documentos.filter((d) => d.tipo === 'promissoria').at(-1);
      if (prom?.status === 'pendente') linhas.push(`Assine a nota promissória: ${base}/assinar/${prom.token}`);
      else if (prom?.status === 'assinado') linhas.push('Nota promissória: assinada ✔');
      if (m.garantiaUrl && !m.garantiaPagaEm) linhas.push(`Boleto de garantia (${reais(m.garantiaValor ?? 0)}, vence ${br(m.garantiaVencimento)}; cancelado no acerto): ${m.garantiaUrl}`);
    }
    linhas.push('', 'Qualquer dúvida, é só responder.', 'Aritana Semijoias');
    return { assunto, texto: linhas.join('\n'), email: m.email ?? null, telefone: m.telefone ?? null, representanteId: m.representanteId, nome: m.representante };
  }

  async enviar(maletaId: string, d: { momento: MomentoAviso; email: boolean; whatsapp: boolean }, usuarioId: string) {
    const msg = await this.montar(maletaId, d.momento);
    const r: { email?: string; whatsapp?: string } = {};
    if (d.email) {
      if (!msg.email) r.email = 'sem e-mail no cadastro';
      else {
        try {
          await this.email.enviar(msg.email, msg.assunto, msg.texto);
          r.email = 'enviado';
        } catch (e) {
          r.email = `não foi: ${(e as Error).message}`;
        }
      }
    }
    if (d.whatsapp) {
      if (!msg.telefone) r.whatsapp = 'sem telefone no cadastro';
      else {
        try {
          const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(asc(crmCanais.criadoEm));
          const canal = cs.find((c) => c.tipo !== 'oficial') ?? cs[0];
          if (!canal) throw new Error('nenhum número de WhatsApp ativo no CRM');
          const contato = await this.crm.garantirContato({ telefone: msg.telefone, nome: msg.nome, pessoaId: msg.representanteId });
          const cv = await this.canais.garantirConversa(contato.id, canal.id, 'resolvida');
          await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto: msg.texto });
          r.whatsapp = 'enviado';
        } catch (e) {
          r.whatsapp = `não foi: ${(e as Error).message}`;
        }
      }
    }
    await this.auditoria.registrar({ usuarioId, acao: 'avisar', entidade: 'maleta', entidadeId: maletaId, dados: { momento: d.momento, ...r } });
    return r;
  }
}
