import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { urlPublica } from '../comum/url';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { crmCanais, documentos, pessoas } from '../db/schema';
import { EmailService } from '../integracoes/email.service';

const NOME: Record<string, string> = { contrato: 'contrato', promissoria: 'nota promissória', aditivo: 'aditivo do contrato' };

/** Manda pelo WhatsApp do sistema (ou por e-mail) o link para assinar e o código de assinatura. */
@Injectable()
export class EnvioDocumentoService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
    private readonly email: EmailService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** Texto livre pelo primeiro número ativo que não é o oficial (o oficial só aceita template fora da janela de 24h). */
  async whatsapp(pessoaId: string, telefone: string, nome: string, texto: string) {
    const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(asc(crmCanais.criadoEm));
    const canal = cs.find((c) => c.tipo !== 'oficial') ?? cs[0];
    if (!canal) throw new BadRequestException('Nenhum número de WhatsApp ativo no CRM.');
    const contato = await this.crm.garantirContato({ telefone, nome, pessoaId });
    const cv = await this.canais.garantirConversa(contato.id, canal.id, 'resolvida');
    await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto });
  }

  async enviarLink(documentoId: string, d: { whatsapp: boolean; email: boolean }, usuarioId: string) {
    const [x] = await this.db.select({ d: documentos, nome: pessoas.nome, telefone: pessoas.telefone1, email: pessoas.email }).from(documentos).innerJoin(pessoas, eq(pessoas.id, documentos.pessoaId)).where(eq(documentos.id, documentoId));
    if (!x) throw new BadRequestException('Documento não encontrado.');
    if (x.d.status !== 'pendente') throw new BadRequestException(`Este documento está ${x.d.status}.`);
    const link = `${urlPublica()}/assinar/${x.d.token}`;
    const texto = `Olá, ${x.nome.split(' ')[0]}! Segue o ${NOME[x.d.tipo] ?? 'documento'} da Aritana para você ler e assinar pelo celular:\n${link}\n\nNa página, peça o código de assinatura (chega aqui no WhatsApp ou no seu e-mail).\n\nAritana Semijoias`;
    const r: { whatsapp?: string; email?: string } = {};
    if (d.whatsapp) {
      if (!x.telefone) r.whatsapp = 'sem telefone no cadastro';
      else
        try {
          await this.whatsapp(x.d.pessoaId, x.telefone, x.nome, texto);
          r.whatsapp = 'enviado';
        } catch (e) {
          r.whatsapp = `não foi: ${(e as Error).message}`;
        }
    }
    if (d.email) {
      if (!x.email) r.email = 'sem e-mail no cadastro';
      else
        try {
          await this.email.enviar(x.email, `Para assinar: ${x.d.titulo}`, texto);
          r.email = 'enviado';
        } catch (e) {
          r.email = `não foi: ${(e as Error).message}`;
        }
    }
    await this.auditoria.registrar({ usuarioId, acao: 'enviar_documento', entidade: 'documento', entidadeId: documentoId, dados: r });
    return r;
  }
}
