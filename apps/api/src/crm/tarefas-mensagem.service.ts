import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { ArquivosService } from '../arquivos/arquivos.service';
import { crmCanais, crmContatos, crmConversas, crmLeads, crmRespostasRapidas, crmTarefas, crmTemplates } from '../db/schema';
import { CanaisService } from './canais.service';
import { CrmService } from './crm.service';

export type MensagemTarefa = {
  tipo: 'texto' | 'template' | 'resposta';
  texto?: string | null;
  templateId?: string | null;
  respostaId?: string | null;
  canalId?: string | null;
  envio: 'automatico' | 'lembrete';
};

/**
 * Mensagem de WhatsApp ligada a uma tarefa do card: um template, uma resposta rápida (com foto, vídeo ou áudio)
 * ou um texto escrito na hora. "Automático" manda sozinho no horário da tarefa; "lembrete" fica pronta para
 * a pessoa mandar com um clique. Mandou: a tarefa fica concluída.
 */
@Injectable()
export class TarefasMensagemService {
  private readonly log = new Logger('Tarefas com mensagem');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly canais: CanaisService,
    private readonly crm: CrmService,
    private readonly arquivos: ArquivosService,
  ) {}

  /** Confere a mensagem antes de gravar a tarefa (template, resposta e número existem). */
  async validar(m: MensagemTarefa) {
    if (m.tipo === 'texto' && !m.texto?.trim()) throw new BadRequestException('Escreva a mensagem da tarefa.');
    if (m.tipo === 'template') {
      const [t] = await this.db.select({ id: crmTemplates.id, tipo: crmTemplates.tipo, canalId: crmTemplates.canalId, status: crmTemplates.status }).from(crmTemplates).where(eq(crmTemplates.id, m.templateId ?? '00000000-0000-0000-0000-000000000000'));
      if (!t) throw new BadRequestException('Escolha o template.');
      if (t.tipo === 'meta' && m.canalId && t.canalId !== m.canalId) throw new BadRequestException('Este template da Meta é de outro número.');
    }
    if (m.tipo === 'resposta') {
      const [r] = await this.db.select({ id: crmRespostasRapidas.id }).from(crmRespostasRapidas).where(eq(crmRespostasRapidas.id, m.respostaId ?? '00000000-0000-0000-0000-000000000000'));
      if (!r) throw new BadRequestException('Escolha a resposta rápida.');
    }
    if (m.canalId) {
      const [c] = await this.db.select({ ativo: crmCanais.ativo }).from(crmCanais).where(and(eq(crmCanais.id, m.canalId), isNull(crmCanais.excluidoEm)));
      if (!c?.ativo) throw new BadRequestException('Este número de WhatsApp está desativado.');
    }
  }

  /** Número que manda: o escolhido, ou o da última conversa com a pessoa, ou o primeiro número ativo. */
  private async canalPara(contatoId: string, canalId: string | null) {
    if (canalId) return canalId;
    const [ult] = await this.db
      .select({ canalId: crmConversas.canalId })
      .from(crmConversas)
      .innerJoin(crmCanais, eq(crmCanais.id, crmConversas.canalId))
      .where(and(eq(crmConversas.contatoId, contatoId), eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm)))
      .orderBy(desc(crmConversas.ultimaMensagemEm))
      .limit(1);
    if (ult) return ult.canalId;
    const [primeiro] = await this.db.select({ id: crmCanais.id }).from(crmCanais).where(and(eq(crmCanais.ativo, true), isNull(crmCanais.excluidoEm))).orderBy(crmCanais.criadoEm).limit(1);
    if (!primeiro) throw new BadRequestException('Nenhum número de WhatsApp ligado ao CRM.');
    return primeiro.id;
  }

  /** Manda a mensagem da tarefa agora. `usuarioId` nulo = envio automático (a conversa não passa para ninguém). */
  async enviar(tarefaId: string, usuarioId: string | null) {
    const [t] = await this.db.select().from(crmTarefas).where(eq(crmTarefas.id, tarefaId));
    if (!t) throw new NotFoundException('Tarefa não encontrada.');
    if (!t.mensagemTipo) throw new BadRequestException('Esta tarefa não tem mensagem para mandar.');
    if (t.mensagemStatus === 'enviada') throw new BadRequestException('A mensagem desta tarefa já foi enviada.');
    try {
      const [lead] = await this.db.select({ contatoId: crmLeads.contatoId }).from(crmLeads).where(eq(crmLeads.id, t.leadId));
      if (!lead?.contatoId) throw new BadRequestException('O card não tem contato com telefone.');
      const [contato] = await this.db.select().from(crmContatos).where(eq(crmContatos.id, lead.contatoId));
      if (contato?.descadastrado) throw new BadRequestException('A pessoa pediu para não receber mensagens.');
      const canalId = await this.canalPara(lead.contatoId, t.canalId);
      const cv = await this.canais.garantirConversa(lead.contatoId, canalId, 'resolvida');
      const base = { conversaId: cv.id, leadId: t.leadId, usuarioId };
      if (t.mensagemTipo === 'template') {
        await this.canais.enviar({ ...base, tipo: 'template', templateId: t.templateId });
      } else if (t.mensagemTipo === 'resposta') {
        const [r] = await this.db.select().from(crmRespostasRapidas).where(eq(crmRespostasRapidas.id, t.respostaId ?? '00000000-0000-0000-0000-000000000000'));
        if (!r) throw new BadRequestException('A resposta rápida desta tarefa foi apagada.');
        if (r.midia) {
          const caminho = this.arquivos.caminhoMidia(r.midia);
          if (!caminho) throw new BadRequestException('O arquivo da resposta rápida não foi encontrado.');
          const conteudo = await readFile(caminho);
          const mime = r.midiaMime ?? 'application/octet-stream';
          const tipo = mime.startsWith('image/') ? 'imagem' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'documento';
          // Áudio vai como mensagem de voz, sem legenda: o texto (se houver) segue numa mensagem logo depois.
          await this.canais.enviar({ ...base, tipo, texto: tipo === 'audio' ? null : r.texto || null, midia: { conteudo, mime, nome: r.midiaNome ?? 'arquivo' } });
          if (tipo === 'audio' && r.texto) await this.canais.enviar({ ...base, tipo: 'texto', texto: r.texto });
        } else {
          await this.canais.enviar({ ...base, tipo: 'texto', texto: r.texto });
        }
      } else {
        await this.canais.enviar({ ...base, tipo: 'texto', texto: t.mensagemTexto });
      }
      const agora = new Date();
      await this.db.update(crmTarefas).set({ mensagemStatus: 'enviada', mensagemErro: null, mensagemEnviadaEm: agora, feitaEm: t.feitaEm ?? agora }).where(eq(crmTarefas.id, t.id));
      await this.crm.evento(t.leadId, 'tarefa', `Mensagem da tarefa enviada: ${t.titulo}.`, usuarioId);
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      await this.db.update(crmTarefas).set({ mensagemStatus: 'falhou', mensagemErro: msg.slice(0, 500) }).where(eq(crmTarefas.id, t.id));
      await this.crm.evento(t.leadId, 'tarefa', `Mensagem da tarefa não foi enviada (${t.titulo}): ${msg}`, usuarioId);
      throw e instanceof BadRequestException ? e : new BadRequestException(msg);
    }
  }

  /** Chamado pelo motor do CRM: manda as mensagens automáticas das tarefas que venceram. */
  async processar() {
    const vencidas = await this.db
      .select({ id: crmTarefas.id })
      .from(crmTarefas)
      .where(and(eq(crmTarefas.envio, 'automatico'), eq(crmTarefas.mensagemStatus, 'pendente'), isNull(crmTarefas.feitaEm), lte(crmTarefas.venceEm, new Date())))
      .orderBy(crmTarefas.venceEm)
      .limit(20);
    for (const v of vencidas) {
      // Reserva a tarefa (duas voltas do motor ao mesmo tempo não mandam duas vezes).
      const [reservada] = await this.db.update(crmTarefas).set({ mensagemStatus: 'enviando' }).where(and(eq(crmTarefas.id, v.id), eq(crmTarefas.mensagemStatus, 'pendente'))).returning({ id: crmTarefas.id });
      if (!reservada) continue;
      await this.enviar(v.id, null).catch((e) => this.log.warn(`Tarefa ${v.id}: ${(e as Error).message}`));
    }
  }
}
