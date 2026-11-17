import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { RegrasEncargos } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { configuracoes } from '../db/schema';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';

export interface PassoRegua {
  /** Dias em relação ao vencimento: negativo = antes, 0 = no dia, positivo = depois. */
  dias: number;
  canal: 'whatsapp' | 'email';
  texto: string;
  /** No WhatsApp oficial (Meta), fora da janela de 24 h só vai com template aprovado. */
  templateId?: string | null;
}

export interface ConfigCobranca extends RegrasEncargos {
  /** Desconto máximo no acordo para quem cobra (sobre o total atualizado). */
  descontoMaxPb: number;
  /** Desconto máximo para a gestão da cobrança. */
  descontoMaxGestorPb: number;
  parcelasMax: number;
  /** Parcela do acordo atrasada há mais que isto: o acordo quebra e a dívida original volta. */
  diasQuebraAcordo: number;
  regua: { ativa: boolean; canalId: string | null; passos: PassoRegua[] };
  protesto: { diasMinimos: number; especie: string };
}

const TEXTO_ANTES = 'Olá, {primeiro_nome}! Passando para lembrar que a parcela de {valor} da Aritana vence em {vencimento}.\n{link}\nSe já pagou, desconsidere.';
const TEXTO_DIA = 'Olá, {primeiro_nome}! Hoje vence a parcela de {valor} da Aritana.\n{link}\nQualquer dúvida, é só responder esta mensagem.';
const TEXTO_DEPOIS = 'Olá, {primeiro_nome}. Não identificamos o pagamento de {valor}, que venceu em {vencimento} ({dias} dias). Com multa e juros, hoje fica em {valor_atualizado}.\n{link}\nSe precisar negociar, responda aqui que a gente ajuda.';

/** Configuração da cobrança (guardada em configuracoes.cobranca). */
@Injectable()
export class CobrancaConfigService {
  constructor(@Inject(DB) private readonly db: Db, private readonly regras: ConfiguracoesService) {}

  async padrao(): Promise<ConfigCobranca> {
    // Multa e juros começam iguais aos das regras do consignado, para nada mudar até alguém configurar.
    const r = await this.regras.regras();
    return {
      multaPb: r.multaAtrasoPb,
      jurosMesPb: r.jurosMesPb,
      diasCarencia: 0,
      descontoMaxPb: 1000,
      descontoMaxGestorPb: 5000,
      parcelasMax: 12,
      diasQuebraAcordo: 15,
      regua: {
        ativa: false,
        canalId: null,
        passos: [
          { dias: -3, canal: 'whatsapp', texto: TEXTO_ANTES },
          { dias: 0, canal: 'whatsapp', texto: TEXTO_DIA },
          { dias: 3, canal: 'whatsapp', texto: TEXTO_DEPOIS },
          { dias: 10, canal: 'whatsapp', texto: TEXTO_DEPOIS },
          { dias: 30, canal: 'whatsapp', texto: TEXTO_DEPOIS },
        ],
      },
      protesto: { diasMinimos: 30, especie: 'DMI' },
    };
  }

  async obter(): Promise<ConfigCobranca> {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, 'cobranca'));
    const p = await this.padrao();
    const v = (c?.valor ?? {}) as Partial<ConfigCobranca>;
    return { ...p, ...v, regua: { ...p.regua, ...(v.regua ?? {}) }, protesto: { ...p.protesto, ...(v.protesto ?? {}) } };
  }

  async salvar(d: ConfigCobranca) {
    await this.db.insert(configuracoes).values({ chave: 'cobranca', valor: d }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: d, atualizadoEm: new Date() } });
    return d;
  }
}
