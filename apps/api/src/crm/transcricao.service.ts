import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { and, eq, isNull, or } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { crmConversas, crmMensagens } from '../db/schema';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ErroIa, IaService } from '../ia/ia.service';

/**
 * Transcrição dos áudios do chat (OpenAI). Roda sozinha quando um áudio chega (se ligado)
 * ou quando alguém clica em "Transcrever". O agente de IA espera a transcrição antes de responder.
 */
@Injectable()
export class TranscricaoService {
  private readonly log = new Logger('Transcrição');
  /** Transcrições em andamento, por conversa (o agente espera por elas). */
  private readonly andamento = new Map<string, Set<Promise<unknown>>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ia: IaService,
    private readonly arquivos: ArquivosService,
  ) {}

  /** Áudio que acabou de chegar: transcreve em segundo plano, sem segurar o webhook. */
  aoChegar(mensagemId: string, conversaId: string) {
    if (!this.ia.transcreverSozinho) return;
    this.acompanhar(conversaId, this.transcrever(mensagemId, null).catch((e) => this.log.warn(`Mensagem ${mensagemId}: ${(e as Error).message}`)));
  }

  /** Espera as transcrições desta conversa (no máximo o tempo dado). */
  async aguardar(conversaId: string, maxMs = 60_000) {
    const ps = this.andamento.get(conversaId);
    if (!ps?.size) return;
    await Promise.race([Promise.allSettled([...ps]), new Promise((r) => setTimeout(r, maxMs).unref())]);
  }

  private acompanhar(conversaId: string, p: Promise<unknown>) {
    let ps = this.andamento.get(conversaId);
    if (!ps) this.andamento.set(conversaId, (ps = new Set()));
    ps.add(p);
    // O erro é tratado por quem chamou; aqui só tira da lista (sem gerar uma rejeição solta).
    p.finally(() => {
      ps!.delete(p);
      if (!ps!.size) this.andamento.delete(conversaId);
    }).catch(() => undefined);
  }

  /** Transcreve agora (clique no chat). Devolve a mensagem com o texto. */
  async manual(mensagemId: string, usuarioId: string) {
    const [m] = await this.db.select({ conversaId: crmMensagens.conversaId }).from(crmMensagens).where(eq(crmMensagens.id, mensagemId));
    if (!m) throw new NotFoundException('Mensagem não encontrada.');
    const p = this.transcrever(mensagemId, usuarioId, true);
    this.acompanhar(m.conversaId, p);
    try {
      return await p;
    } catch (e) {
      if (e instanceof ErroIa) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private async transcrever(mensagemId: string, usuarioId: string | null, deNovo = false) {
    const [m] = await this.db.select().from(crmMensagens).where(eq(crmMensagens.id, mensagemId));
    if (!m) throw new NotFoundException('Mensagem não encontrada.');
    if (m.tipo !== 'audio' || !m.midia || m.apagadaEm) throw new ErroIa('Só dá para transcrever mensagem de áudio.');
    if (m.transcricaoStatus === 'feita' && m.transcricao) return { id: m.id, transcricao: m.transcricao, transcricaoStatus: 'feita', transcricaoErro: null };
    // Marca como pendente só se ninguém pegou antes (dois cliques, ou o automático e um clique juntos).
    const [pegou] = await this.db
      .update(crmMensagens)
      .set({ transcricaoStatus: 'pendente', transcricaoErro: null })
      .where(and(eq(crmMensagens.id, mensagemId), deNovo ? or(isNull(crmMensagens.transcricaoStatus), eq(crmMensagens.transcricaoStatus, 'falhou')) : isNull(crmMensagens.transcricaoStatus)))
      .returning({ id: crmMensagens.id });
    if (!pegou) throw new ErroIa('A transcrição deste áudio já está em andamento.');
    try {
      const caminho = this.arquivos.caminhoMidia(m.midia);
      const conteudo = caminho ? await readFile(caminho).catch(() => null) : null;
      if (!conteudo) throw new ErroIa('O arquivo do áudio não foi encontrado no servidor.');
      const texto = await this.ia.transcrever({ conteudo, extensao: (m.midia.split('.').pop() ?? '').toLowerCase(), usuarioId });
      const final = texto || '(áudio sem fala)';
      await this.db.update(crmMensagens).set({ transcricao: final, transcricaoStatus: 'feita', transcricaoErro: null }).where(eq(crmMensagens.id, mensagemId));
      // Na lista de conversas, o "[audio]" da última mensagem vira o começo do que foi falado.
      if (texto) await this.db.update(crmConversas).set({ ultimaMensagem: `🎤 ${texto}`.slice(0, 200) }).where(and(eq(crmConversas.id, m.conversaId), eq(crmConversas.ultimaMensagem, '[audio]')));
      return { id: m.id, transcricao: final, transcricaoStatus: 'feita', transcricaoErro: null };
    } catch (e) {
      const erro = e instanceof ErroIa ? e.message : `Não deu para transcrever (${(e as Error).message}).`;
      await this.db.update(crmMensagens).set({ transcricaoStatus: 'falhou', transcricaoErro: erro.slice(0, 300) }).where(eq(crmMensagens.id, mensagemId));
      throw e instanceof ErroIa ? e : new ErroIa(erro);
    }
  }
}
