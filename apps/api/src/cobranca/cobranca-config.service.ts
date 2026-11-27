import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { RegrasEncargos } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { configuracoes } from '../db/schema';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';

export interface PassoRegua {
  /**
   * A partir de quantos dias do vencimento a etapa vale: negativo = antes, 0 = no dia, positivo = depois.
   * Vale até a etapa seguinte; cada pessoa recebe a etapa do seu maior atraso, uma vez.
   */
  dias: number;
  /** mensagem: manda WhatsApp ou e-mail | tarefa: vira tarefa na Mesa de quem for escolhido. */
  acao?: 'mensagem' | 'tarefa';
  /** Nome curto da etapa (aparece no histórico e na tela). */
  nome?: string;
  canal: 'whatsapp' | 'email';
  /** Mensagem (ou, na tarefa, o que a pessoa da equipe precisa fazer). */
  texto: string;
  /** No WhatsApp oficial (Meta), fora da janela de 24 h só vai com template aprovado. */
  templateId?: string | null;
  /** Quem recebe a tarefa. */
  responsavelId?: string | null;
}

export interface ConfigCobranca extends RegrasEncargos {
  /** Desconto máximo no acordo para quem cobra (sobre o total atualizado). */
  descontoMaxPb: number;
  /** Desconto máximo para a gestão da cobrança. */
  descontoMaxGestorPb: number;
  parcelasMax: number;
  /** Parcela do acordo atrasada há mais que isto: o acordo quebra e a dívida original volta. */
  diasQuebraAcordo: number;
  /** Trilha de cobrança (versao 2: cada pessoa segue as etapas pelo maior atraso). */
  regua: {
    ativa: boolean;
    canalId: string | null;
    passos: PassoRegua[];
    versao?: number;
    /** Emite boleto/Pix no Asaas automaticamente antes da mensagem (padrão: não). */
    gerarBoleto?: boolean;
    /** A fila do dia fica pausada até alguém conferir e clicar em Retomar (padrão: sim). */
    aprovarAntes?: boolean;
  };
  protesto: { diasMinimos: number; especie: string };
}

/** Etapas sugeridas da trilha (a equipe edita os dias e os textos). */
export const ETAPAS_PADRAO: PassoRegua[] = [
  {
    dias: 1,
    acao: 'mensagem',
    nome: 'Lembrete',
    canal: 'whatsapp',
    texto: 'Oi, {primeiro_nome}! Tudo bem? Passando para lembrar que a parcela de {valor} da {empresa} venceu em {vencimento}. Segue o link para pagar por boleto ou Pix:\n{link}\nSe já pagou, pode desconsiderar.',
  },
  {
    dias: 15,
    acao: 'mensagem',
    nome: 'Segundo aviso',
    canal: 'whatsapp',
    texto: 'Olá, {primeiro_nome}. Ainda não identificamos o pagamento de {valor}, vencido em {vencimento} ({dias} dias). Com multa e juros, hoje fica em {valor_atualizado}.\nSe quiser, mandamos a 2ª via do boleto ou um Pix novo com o valor atualizado: é só responder esta mensagem.',
  },
  {
    dias: 30,
    acao: 'mensagem',
    nome: 'Proposta de acordo',
    canal: 'whatsapp',
    texto: 'Olá, {primeiro_nome}. Sua pendência com a {empresa} está em {valor_atualizado} ({dias} dias de atraso). Queremos te ajudar a regularizar: dá para parcelar em até {parcelas_max}x ou pagar à vista com desconto, por {valor_com_desconto}. Responda esta mensagem que a gente monta o acordo com você.',
  },
  { dias: 60, acao: 'tarefa', nome: 'Contato do Financeiro', canal: 'whatsapp', texto: 'Entrar em contato com {nome}: {dias} dias de atraso, {valor_atualizado} atualizado. Telefone: {telefone}.', responsavelId: null },
  { dias: 90, acao: 'tarefa', nome: 'Decisão da gestão', canal: 'whatsapp', texto: 'Decidir se a dívida de {nome} ({dias} dias de atraso, {valor_atualizado} atualizado) vai para a advogada.', responsavelId: null },
];

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
      regua: { ativa: false, canalId: null, passos: ETAPAS_PADRAO, versao: 2, gerarBoleto: false, aprovarAntes: true },
      protesto: { diasMinimos: 30, especie: 'DMI' },
    };
  }

  async obter(): Promise<ConfigCobranca> {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, 'cobranca'));
    const p = await this.padrao();
    const v = (c?.valor ?? {}) as Partial<ConfigCobranca>;
    const regua = { ...p.regua, ...(v.regua ?? {}) };
    // Régua antiga (por dia exato) que nunca foi ligada: começa com as etapas da trilha.
    if (v.regua && v.regua.versao !== 2 && !v.regua.ativa) regua.passos = ETAPAS_PADRAO;
    regua.passos = regua.passos.map((x) => ({ ...x, acao: x.acao ?? 'mensagem' }));
    regua.versao = 2;
    regua.gerarBoleto = regua.gerarBoleto === true;
    regua.aprovarAntes = regua.aprovarAntes !== false;
    return { ...p, ...v, regua, protesto: { ...p.protesto, ...(v.protesto ?? {}) } };
  }

  async salvar(d: ConfigCobranca) {
    d.regua.versao = 2;
    await this.db.insert(configuracoes).values({ chave: 'cobranca', valor: d }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: d, atualizadoEm: new Date() } });
    return d;
  }
}
