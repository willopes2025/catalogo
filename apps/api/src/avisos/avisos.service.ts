import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { formatarReais, somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { EmailService } from '../integracoes/email.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { avisosEnviados } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

const br = (d: string) => d.split('-').reverse().join('/');

interface Aviso {
  chave: string;
  para: string;
  assunto: string;
  texto: string;
}

/**
 * Avisos automáticos por e-mail, uma vez por dia a partir da hora configurada:
 *  - à representante: acerto da maleta chegando e acerto em atraso;
 *  - à cliente/representante: parcela vencendo;
 *  - à equipe: resumo do dia (maletas atrasadas, parcelas vencidas, garantias paradas).
 * Cada aviso tem uma chave única: nunca sai duas vezes.
 */
@Injectable()
export class AvisosService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Avisos');
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(@Inject(DB) private readonly db: Db, private readonly email: EmailService, private readonly config: ConfiguracoesService) {}

  onModuleInit() {
    if (process.env.AVISOS_AUTOMATICOS === '0') return;
    this.timer = setInterval(() => void this.tentarAgendado(), 15 * 60_000);
    this.timer.unref();
    setTimeout(() => void this.tentarAgendado(), 60_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private horaBrasilia() {
    return Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
  }

  private async tentarAgendado() {
    try {
      const cfg = await this.config.ler('avisos');
      if (!cfg.ativo || this.horaBrasilia() < cfg.hora) return;
      if (!this.email.configurado && process.env.NODE_ENV === 'production') return;
      await this.executar();
    } catch (e) {
      this.log.error(`Falha nos avisos: ${(e as Error).message}`);
    }
  }

  /** Monta os avisos do dia, sem enviar. */
  async montar(): Promise<Aviso[]> {
    const cfg = await this.config.ler('avisos');
    const dia = hoje();
    const avisos: Aviso[] = [];

    const vencendo = somarDias(dia, cfg.diasAntesMaleta);
    const maletas = await this.db.execute<{ id: string; numero: number; data_limite: string; nome: string; email: string | null }>(sql`
      select m.id, m.numero, m.data_limite::text, p.nome, p.email
      from maletas m join pessoas p on p.id = m.representante_id
      where m.status = 'aberta' and m.data_limite <= ${vencendo}::date`);
    const regras = await this.config.regras();
    const encargos = regras.multaAtrasoPb > 0 || regras.jurosMesPb > 0;
    const consequencia = encargos && regras.diasParaBloquear > 0
      ? 'O atraso gera multa e juros e pode bloquear a próxima maleta. '
      : encargos ? 'O atraso gera multa e juros. ' : regras.diasParaBloquear > 0 ? 'O atraso pode bloquear a próxima maleta. ' : '';
    for (const m of maletas.rows) {
      if (!m.email) continue;
      const primeiro = m.nome.split(' ')[0];
      if (m.data_limite >= dia) {
        avisos.push({
          chave: `maleta-vence:${m.id}:${m.data_limite}`,
          para: m.email,
          assunto: `Acerto da maleta nº ${m.numero} em ${br(m.data_limite)}`,
          texto: `Olá, ${primeiro}!\n\nO acerto da sua maleta nº ${m.numero} está marcado para ${br(m.data_limite)}.\nSepare as peças que voltam e combine o horário com a Aritana.\n\nObrigada!\nAritana Semijoias`,
        });
      } else {
        avisos.push({
          chave: `maleta-atrasada:${m.id}:${m.data_limite}`,
          para: m.email,
          assunto: `Acerto da maleta nº ${m.numero} em atraso`,
          texto: `Olá, ${primeiro}.\n\nO acerto da maleta nº ${m.numero} venceu em ${br(m.data_limite)} e ainda não foi feito.\n${consequencia}Fale com a Aritana para acertar o quanto antes.\n\nAritana Semijoias`,
        });
      }
    }

    const titulosAte = somarDias(dia, cfg.diasAntesTitulo);
    const titulos = await this.db.execute<{ id: string; descricao: string; valor: number; vencimento: string; nome: string; email: string | null; cobranca_url: string | null; pix: string | null }>(sql`
      select t.id, t.descricao, t.valor, t.vencimento::text, p.nome, p.email, t.cobranca_url, t.pix_copia_cola as pix
      from titulos t join pessoas p on p.id = t.pessoa_id
      where t.tipo = 'receber' and t.status = 'aberto' and t.vencimento between ${dia}::date and ${titulosAte}::date`);
    for (const t of titulos.rows) {
      if (!t.email) continue;
      const pagar = t.cobranca_url ? `\nPara pagar: ${t.cobranca_url}` : t.pix ? `\nPix copia e cola:\n${t.pix}` : '';
      avisos.push({
        chave: `titulo-vence:${t.id}:${t.vencimento}`,
        para: t.email,
        assunto: `Parcela de ${formatarReais(t.valor)} vence em ${br(t.vencimento)}`,
        texto: `Olá, ${t.nome.split(' ')[0]}!\n\nLembrete: ${t.descricao}, no valor de ${formatarReais(t.valor)}, vence em ${br(t.vencimento)}.${pagar}\n\nSe já pagou, desconsidere.\nAritana Semijoias`,
      });
    }

    if (cfg.emailsEquipe.length) {
      const [r] = (
        await this.db.execute<{ maletas: number; titulos: number; valor: string; os: number }>(sql`
          select
            (select count(*)::int from maletas where status = 'aberta' and data_limite < ${dia}::date) as maletas,
            (select count(*)::int from titulos where tipo = 'receber' and status = 'aberto' and vencimento < ${dia}::date) as titulos,
            (select coalesce(sum(valor), 0)::bigint from titulos where tipo = 'receber' and status = 'aberto' and vencimento < ${dia}::date) as valor,
            (select count(*)::int from ordens_servico where status in ('aberta', 'na_assistencia') and (previsao < ${dia}::date or criado_em < now() - interval '15 days')) as os`)
      ).rows;
      const linhas = [
        `Maletas com acerto em atraso: ${r.maletas}`,
        `Parcelas vencidas em aberto: ${r.titulos} (${formatarReais(Number(r.valor))})`,
        `Garantias e consertos parados: ${r.os}`,
        `Avisos enviados hoje às representantes e clientes: ${avisos.length}`,
      ];
      for (const para of cfg.emailsEquipe) {
        avisos.push({ chave: `resumo:${dia}:${para}`, para, assunto: `Resumo do dia ${br(dia)} · Aritana`, texto: `Bom dia!\n\n${linhas.join('\n')}\n\nDetalhes no painel: ${process.env.PAINEL_URL ?? 'https://aritana.wideic.com'}` });
      }
    }
    return avisos;
  }

  /** Envia o que ainda não foi enviado. */
  async executar() {
    if (this.rodando) return { enviados: 0, jaEnviados: 0, falhas: 0, emAndamento: true };
    this.rodando = true;
    try {
      const avisos = await this.montar();
      let enviados = 0;
      let jaEnviados = 0;
      let falhas = 0;
      for (const a of avisos) {
        const [reservado] = await this.db.insert(avisosEnviados).values({ chave: a.chave, para: a.para, assunto: a.assunto }).onConflictDoNothing().returning();
        if (!reservado) {
          jaEnviados++;
          continue;
        }
        try {
          await this.email.enviar(a.para, a.assunto, a.texto);
          enviados++;
        } catch (e) {
          falhas++;
          await this.db.delete(avisosEnviados).where(eq(avisosEnviados.chave, a.chave));
          this.log.warn(`Não enviou "${a.assunto}" para ${a.para}: ${(e as Error).message}`);
        }
      }
      if (enviados) this.log.log(`${enviados} aviso(s) enviado(s).`);
      return { enviados, jaEnviados, falhas };
    } finally {
      this.rodando = false;
    }
  }
}
