import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { urlPublica } from '../comum/url';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { montarMensagemAgenda } from '../agenda/agenda.service';
import { avisosEnviados, crmCanais, pessoas } from '../db/schema';

/** Link fixo do APK do app da consultora (publicado pelo workflow app-representante.yml). */
export const LINK_APK_CONSULTORA = 'https://github.com/willopes2025/catalogo/releases/download/app-representante/aritana.apk';

/** Depois que a consultora assina o contrato: WhatsApp explicando o app e o link para instalar (uma vez só). */
@Injectable()
export class BoasVindasAppService {
  private readonly log = new Logger('BoasVindasApp');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfiguracoesService,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
  ) {}

  async enviar(pessoaId: string) {
    const cfg = await this.config.ler('mensagem_app');
    if (!cfg.ativo) return { enviado: false, motivo: 'desligado' };
    const [p] = await this.db.select({ nome: pessoas.nome, telefone: pessoas.telefone1, tipo: pessoas.tipo }).from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p || p.tipo !== 'representante') return { enviado: false, motivo: 'não é consultora' };
    if (!p.telefone) return { enviado: false, motivo: 'sem telefone' };
    // Uma vez por consultora: a chave trava antes de mandar.
    const [trava] = await this.db.insert(avisosEnviados).values({ chave: `app-boas-vindas:${pessoaId}`, para: p.telefone, assunto: 'App da consultora (WhatsApp)' }).onConflictDoNothing().returning({ chave: avisosEnviados.chave });
    if (!trava) return { enviado: false, motivo: 'já enviado' };
    try {
      const cs = await this.db.select({ id: crmCanais.id, tipo: crmCanais.tipo }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(asc(crmCanais.criadoEm));
      const canalId = cfg.canalId && cs.some((c) => c.id === cfg.canalId) ? cfg.canalId : (cs.find((c) => c.tipo !== 'oficial') ?? cs[0])?.id;
      if (!canalId) throw new Error('nenhum número de WhatsApp ativo no CRM');
      const texto = montarMensagemAgenda(cfg.texto, { primeiro_nome: p.nome.split(' ')[0], nome: p.nome, link_android: LINK_APK_CONSULTORA, link_portal: `${urlPublica()}/portal` });
      const contato = await this.crm.garantirContato({ telefone: p.telefone, nome: p.nome, pessoaId });
      const cv = await this.canais.garantirConversa(contato.id, canalId, 'resolvida');
      await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto });
      return { enviado: true };
    } catch (e) {
      // Não saiu: libera para tentar de novo numa próxima assinatura/reenvio.
      await this.db.delete(avisosEnviados).where(eq(avisosEnviados.chave, `app-boas-vindas:${pessoaId}`));
      this.log.warn(`Mensagem do app para ${p.nome}: ${(e as Error).message}`);
      return { enviado: false, motivo: (e as Error).message };
    }
  }
}
