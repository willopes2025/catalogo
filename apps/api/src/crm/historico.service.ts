import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { crmImportacoes } from '../db/schema';
import { CanaisService } from './canais.service';
import { ConexaoEvolution } from './whatsapp/evolution';

/** Rodadas depois que o celular conecta de novo: o WhatsApp manda o histórico aos poucos. */
const RODADAS_MIN = (process.env.HISTORICO_RODADAS_MIN ?? '3,10,20').split(',').map(Number);
const EM_ANDAMENTO = ['aguardando_qr', 'recebendo', 'importando'];
const inicioDoDia = (d: string) => new Date(`${d}T00:00:00-03:00`);
const fimDoDia = (d: string) => new Date(`${d}T23:59:59.999-03:00`);

/**
 * Importa o histórico de conversas de um número Evolution, pelo período escolhido.
 *  - Servidor de fora (token): busca direto o que aquele servidor guardou.
 *  - Servidor próprio: na primeira vez, desconecta e pede para ler o QR de novo, com o pedido de histórico ligado;
 *    o WhatsApp manda as conversas antigas e o sistema grava as do período. Daí em diante o servidor guarda
 *    essa cópia e outros períodos se importam sem QR.
 * As conversas importadas entram resolvidas, sem card, sem IA e sem contar como não lidas.
 */
@Injectable()
export class HistoricoWhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Histórico do WhatsApp');
  private relogio?: NodeJS.Timeout;
  private readonly rodando = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly canais: CanaisService,
  ) {}

  onModuleInit() {
    if (process.env.AVISOS_AUTOMATICOS === '0') return;
    this.relogio = setInterval(() => void this.acompanhar().catch((e) => this.log.warn((e as Error).message)), 60_000);
    this.relogio.unref?.();
  }

  onModuleDestroy() {
    if (this.relogio) clearInterval(this.relogio);
  }

  listar(canalId: string) {
    return this.db.select().from(crmImportacoes).where(eq(crmImportacoes.canalId, canalId)).orderBy(desc(crmImportacoes.criadoEm)).limit(10);
  }

  private async conexaoEvolution(canalId: string) {
    const c = await this.canais.obter(canalId);
    if (c.tipo !== 'evolution') throw new BadRequestException('Só números ligados pela Evolution API (QR code ou token) importam o histórico. O oficial da Meta e a Z-API não entregam conversas antigas.');
    return { c, con: this.canais.conexao(c) as ConexaoEvolution, proprio: !c.config?.servidor };
  }

  async iniciar(canalId: string, d: { de: string; ate: string; midias: boolean }, usuarioId: string | null) {
    const { c, con, proprio } = await this.conexaoEvolution(canalId);
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    if (d.de > d.ate) throw new BadRequestException('A data inicial precisa ser antes da final.');
    if (d.ate > hoje) throw new BadRequestException('A data final não pode ser depois de hoje.');
    if ((fimDoDia(d.ate).getTime() - inicioDoDia(d.de).getTime()) / 86400_000 > 366) throw new BadRequestException('Escolha um período de até 1 ano.');
    const [andamento] = await this.db.select({ id: crmImportacoes.id }).from(crmImportacoes).where(and(eq(crmImportacoes.canalId, c.id), inArray(crmImportacoes.status, EM_ANDAMENTO))).limit(1);
    if (andamento) throw new BadRequestException('Já tem uma importação em andamento neste número. Espere terminar ou cancele.');
    // Servidor próprio: o histórico só vem ao conectar. Já veio uma vez? Então o servidor guardou e dá para buscar direto.
    const [jaVeio] = proprio
      ? await this.db.select({ id: crmImportacoes.id }).from(crmImportacoes).where(and(eq(crmImportacoes.canalId, c.id), eq(crmImportacoes.status, 'concluida'), isNotNull(crmImportacoes.conectadoEm))).limit(1)
      : [{ id: 'fora' }];
    if (proprio && !jaVeio) {
      await con.pedirHistoricoAoConectar();
      await con.desconectar().catch(() => undefined);
      const [imp] = await this.db.insert(crmImportacoes).values({ canalId: c.id, de: d.de, ate: d.ate, midias: d.midias, status: 'aguardando_qr', criadoPor: usuarioId, detalhe: 'Leia o QR code de novo com o celular deste número para o WhatsApp mandar as conversas antigas.' }).returning();
      return imp;
    }
    const [imp] = await this.db.insert(crmImportacoes).values({ canalId: c.id, de: d.de, ate: d.ate, midias: d.midias, status: 'importando', criadoPor: usuarioId, detalhe: 'Buscando as mensagens do período…' }).returning();
    void this.rodar(imp.id, true);
    return imp;
  }

  async cancelar(id: string) {
    const [imp] = await this.db.select().from(crmImportacoes).where(eq(crmImportacoes.id, id));
    if (!imp) throw new NotFoundException('Importação não encontrada.');
    if (!EM_ANDAMENTO.includes(imp.status)) return imp;
    const [r] = await this.db.update(crmImportacoes).set({ status: 'erro', detalhe: 'Cancelada.', concluidoEm: new Date() }).where(eq(crmImportacoes.id, id)).returning();
    return r;
  }

  /** De minuto em minuto: percebe quando o celular conectou e roda a importação nos minutos seguintes. */
  async acompanhar() {
    const lista = await this.db.select().from(crmImportacoes).where(inArray(crmImportacoes.status, ['aguardando_qr', 'recebendo']));
    for (const imp of lista) {
      try {
        if (imp.status === 'aguardando_qr') {
          if (Date.now() - imp.criadoEm.getTime() > 30 * 60_000) {
            await this.db.update(crmImportacoes).set({ status: 'erro', detalhe: 'O QR code não foi lido em 30 minutos. Clique em "Importar histórico" de novo.', concluidoEm: new Date() }).where(eq(crmImportacoes.id, imp.id));
            continue;
          }
          const { con } = await this.conexaoEvolution(imp.canalId);
          if ((await con.estado()) === 'open') await this.db.update(crmImportacoes).set({ status: 'recebendo', conectadoEm: new Date(), detalhe: 'Celular conectado. O WhatsApp está mandando as conversas antigas; a importação roda nos próximos 20 minutos.' }).where(eq(crmImportacoes.id, imp.id));
          continue;
        }
        const minutos = (Date.now() - (imp.conectadoEm?.getTime() ?? Date.now())) / 60_000;
        const alvo = RODADAS_MIN[imp.rodadas];
        if (alvo !== undefined && minutos >= alvo) await this.rodar(imp.id, imp.rodadas === RODADAS_MIN.length - 1);
      } catch (e) {
        this.log.warn(`Importação ${imp.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Busca as mensagens do período no servidor e grava as que ainda não estão no sistema. */
  async rodar(id: string, final: boolean) {
    if (this.rodando.has(id)) return;
    this.rodando.add(id);
    try {
      const [imp] = await this.db.select().from(crmImportacoes).where(eq(crmImportacoes.id, id));
      if (!imp || !EM_ANDAMENTO.includes(imp.status)) return;
      const { c, con, proprio } = await this.conexaoEvolution(imp.canalId);
      const de = inicioDoDia(imp.de);
      const ate = fimDoDia(imp.ate);
      let novas = 0;
      for await (const lote of con.mensagensGuardadas(de, ate)) {
        for (const m of lote) {
          const r = await this.canais.gravarDoHistorico(c, con, m, imp.midias).catch((e) => {
            this.log.warn(`Mensagem do histórico não gravada: ${(e as Error).message}`);
            return null;
          });
          if (r) novas++;
        }
        // Mostra o andamento enquanto importa.
        if (novas) await this.db.update(crmImportacoes).set({ mensagens: imp.mensagens + novas }).where(eq(crmImportacoes.id, id));
      }
      const [{ conversas }] = (
        await this.db.execute<{ conversas: number }>(sql`
          select count(distinct m.conversa_id)::int as conversas from crm_mensagens m join crm_conversas c on c.id = m.conversa_id
          where c.canal_id = ${c.id} and m.criado_em between ${de} and ${ate}`)
      ).rows;
      const total = imp.mensagens + novas;
      const vazio = proprio
        ? 'O WhatsApp não mandou mensagens desse período. Ele costuma mandar só alguns meses para trás; confira o período.'
        : 'O servidor Evolution não tem mensagens guardadas desse período. Ele precisa estar configurado para guardar o histórico (DATABASE_SAVE_DATA_HISTORIC).';
      await this.db
        .update(crmImportacoes)
        .set({
          mensagens: total,
          conversas,
          rodadas: imp.rodadas + 1,
          ...(final
            ? { status: 'concluida', concluidoEm: new Date(), detalhe: total ? `${total} mensagem(ns) importada(s). As conversas entraram como resolvidas.` : vazio }
            : { detalhe: `${total} mensagem(ns) importada(s) até agora. O WhatsApp ainda pode mandar mais; a próxima busca é em alguns minutos.` }),
        })
        .where(eq(crmImportacoes.id, id));
    } catch (e) {
      await this.db.update(crmImportacoes).set({ status: 'erro', detalhe: `Não foi possível importar: ${(e as Error).message}`, concluidoEm: new Date() }).where(eq(crmImportacoes.id, id));
    } finally {
      this.rodando.delete(id);
    }
  }
}
