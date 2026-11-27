import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { urlPublica } from '../comum/url';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { CanaisService } from '../crm/canais.service';
import { CrmService } from '../crm/crm.service';
import { montarMensagemAgenda } from '../agenda/agenda.service';
import { avisosEnviados, crmCanais, pessoas, portalAcessos } from '../db/schema';
import { createHash, randomBytes } from 'node:crypto';

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
      const canalId = cfg.canalId && cs.some((c) => c.id === cfg.canalId) ? cfg.canalId : (cs.find((c) => c.tipo !== 'oficial' && c.tipo !== 'instagram') ?? cs.find((c) => c.tipo !== 'instagram'))?.id;
      if (!canalId) throw new Error('nenhum número de WhatsApp ativo no CRM');
      // Link de acesso direto (uso único, 7 dias): ela entra sem digitar nada.
      const tokenAcesso = randomBytes(30).toString('base64url');
      await this.db.insert(portalAcessos).values({ pessoaId, tipo: 'link', hash: createHash('sha256').update(tokenAcesso).digest('hex'), expiraEm: new Date(Date.now() + 7 * 86_400_000) });
      const linkAcesso = `${urlPublica()}/portal/entrar/${tokenAcesso}`;
      const base = cfg.texto.includes('{{link_acesso}}') ? cfg.texto : `${cfg.texto}\n\n🔑 *Seu acesso:* {{link_acesso}}\n(link direto, vale 7 dias). Depois, para entrar de novo, digite o seu e-mail e o código chega aqui no WhatsApp.`;
      const texto = montarMensagemAgenda(base, { primeiro_nome: p.nome.split(' ')[0], nome: p.nome, link_android: LINK_APK_CONSULTORA, link_portal: `${urlPublica()}/portal`, link_acesso: linkAcesso });
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
