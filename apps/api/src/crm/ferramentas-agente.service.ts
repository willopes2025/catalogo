import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { candidaturaNotas, candidaturas, cobrancaComprovantes, cobrancaContatos, crmContatos, crmLeads, crmMensagens, locaisEstoque, pessoas, produtos, saldos, titulos } from '../db/schema';
import { calcularEncargos } from '@aritana/regras';
import { CobrancaService, type Escopo } from '../cobranca/cobranca.service';
import { PixRecebidosService } from '../financeiro/pix-recebidos.service';
import { CobrancaConfigService } from '../cobranca/cobranca-config.service';
import { AsaasService } from '../integracoes/asaas.service';
import { CrmService } from './crm.service';
import { variantesTelefone } from './telefone';

/** O que a empresa deixa a IA do WhatsApp fazer sozinha. */
export interface FerramentasAgente {
  /** Dizer as parcelas em aberto de quem está escrevendo e mandar a 2ª via (Pix ou boleto). */
  segundaVia: boolean;
  /** Anotar a data em que a pessoa promete pagar. */
  promessa: boolean;
  /** Até quantos dias à frente a IA aceita uma promessa. */
  promessaMaxDias: number;
  /** Consultar se a peça existe, o preço e se há em estoque. */
  estoque: boolean;
  /** Registrar quem quer ser revendedora no funil de recrutamento. */
  candidatura: boolean;
  /** Receber o comprovante de pagamento: conferir valor, data e nome e deixar para a equipe dar baixa. */
  comprovante: boolean;
  /** Propor acordo (à vista com o desconto máximo do cobrador ou parcelado até o máximo de parcelas da Cobrança). */
  acordo: boolean;
  /** Fechar sozinha o acordo que a pessoa aceitou (dentro das regras). Desligado: anota a proposta aceita e passa para a equipe. */
  fecharAcordo: boolean;
}
export const FERRAMENTAS_PADRAO: FerramentasAgente = { segundaVia: true, promessa: true, promessaMaxDias: 10, estoque: true, candidatura: true, comprovante: true, acordo: true, fecharAcordo: false };

type Contato = typeof crmContatos.$inferSelect;
export interface ResultadoFerramenta {
  /** O que a IA lê como resultado (fatos para ela usar na resposta). */
  texto: string;
  /** Recado interno na conversa, para a equipe ver o que a IA fez. Vazio = não anota. */
  nota?: string;
}

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Ferramentas do agente de IA do WhatsApp: o que ele pode consultar e fazer sozinho.
 * Tudo é limitado a quem está escrevendo: as parcelas são só as do cadastro ligado àquele número,
 * e nada aqui dá desconto, muda valor ou mexe em estoque.
 */
@Injectable()
export class FerramentasAgenteService {
  private readonly log = new Logger('Ferramentas da IA');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly asaas: AsaasService,
    private readonly crm: CrmService,
    private readonly auditoria: AuditoriaService,
    private readonly cobranca: CobrancaService,
    private readonly cobrancaConfig: CobrancaConfigService,
    private readonly pix: PixRecebidosService,
  ) {}

  /** A IA cobra como um cobrador da casa: sem carteira restrita e com o limite de desconto do cobrador. */
  private readonly escopo: Escopo = { cobradorId: null, restrito: false, gestor: false };

  /**
   * Número que ainda não está ligado a um cadastro: liga quando o telefone bate com o de uma única pessoa
   * (revendedora ou cliente). Dois cadastros com o mesmo número ficam para a equipe decidir.
   */
  async reconhecer(contato: Contato): Promise<Contato> {
    if (contato.pessoaId) return contato;
    const locais = [...new Set(variantesTelefone(contato.telefone.replace(/\D/g, '')).map((t) => t.replace(/^55(?=\d{10,11}$)/, '')))];
    const achadas = await this.db
      .select({ id: pessoas.id })
      .from(pessoas)
      .where(and(inArray(pessoas.tipo, ['representante', 'cliente']), or(...[pessoas.telefone1, pessoas.telefone2, pessoas.telefone3].map((c) => sql`regexp_replace(coalesce(${c}, ''), '\\D', '', 'g') in (${sql.join(locais.map((l) => sql`${l}`), sql`, `)})`))))
      .limit(2);
    if (achadas.length !== 1) return contato;
    await this.db.update(crmContatos).set({ pessoaId: achadas[0].id }).where(and(eq(crmContatos.id, contato.id), sql`${crmContatos.pessoaId} is null`));
    return { ...contato, pessoaId: achadas[0].id };
  }

  /** Texto que entra nas instruções da IA: quais ferramentas ela tem nesta conversa e como pedir. */
  descricao(cfg: FerramentasAgente, contato: Contato): string {
    const f: string[] = [];
    if (contato.pessoaId && (cfg.segundaVia || cfg.promessa)) f.push('- {"ferramenta": "consultar_parcelas"}: lista as parcelas em aberto desta pessoa (número, vencimento, valor). Use antes de falar de valor ou de mandar 2ª via.');
    if (contato.pessoaId && cfg.segundaVia && this.asaas.configurado) f.push('- {"ferramenta": "segunda_via", "parcela": número da lista, "forma": "pix" ou "boleto"}: gera o link de pagamento da parcela. Mande o link na resposta, exatamente como veio.');
    if (contato.pessoaId && cfg.promessa) f.push(`- {"ferramenta": "registrar_promessa", "data": "AAAA-MM-DD", "valor": valor em reais ou null}: anota que a pessoa prometeu pagar nessa data (no máximo ${cfg.promessaMaxDias} dias à frente). Só use quando ela disser a data com clareza.`);
    if (contato.pessoaId && cfg.comprovante) f.push('- {"ferramenta": "registrar_comprovante", "valor": valor pago em reais ou null, "data": "AAAA-MM-DD" ou null, "pagador": "nome de quem pagou" ou null}: quando a pessoa mandar foto do comprovante (Pix, boleto, transferência), leia valor, data e nome na imagem. ANTES de registrar, confirme com a pessoa: "Recebi seu comprovante de R$ X do dia DD/MM, é isso mesmo?". Só use a ferramenta depois que ela confirmar. O sistema confere com o Pix na conta e dá a baixa (ou amortiza) sozinho; só diga que foi baixado se a ferramenta disser.');
    if (contato.pessoaId && cfg.acordo) f.push('- {"ferramenta": "simular_acordo", "parcelas": número de parcelas (1 = à vista), "entrada": valor da entrada em reais ou null}: calcula uma proposta dentro das regras da empresa (à vista sai com o desconto máximo permitido; parcelado, sem desconto). Use quando a pessoa pedir para negociar, parcelar ou pagar com desconto. Só ofereça o que a ferramenta devolver.');
    if (contato.pessoaId && cfg.acordo) f.push(`- {"ferramenta": "aceitar_acordo", "parcelas": mesmo número da simulação aceita, "entrada": mesma entrada ou null, "forma": "pix" ou "boleto"}: a pessoa disse com clareza que aceita a proposta simulada. ${cfg.fecharAcordo ? 'O acordo é fechado e os links de pagamento são gerados.' : 'A proposta fica anotada e a equipe fecha o acordo: depois de usar, avise que a equipe vai confirmar e passe a conversa (passar = true).'}`);
    if (cfg.estoque) f.push('- {"ferramenta": "consultar_estoque", "busca": "o que a pessoa procura"}: diz se a peça existe, o preço e se há em estoque. Só fale de preço e disponibilidade com o que esta ferramenta devolver.');
    if (cfg.candidatura) f.push('- {"ferramenta": "registrar_candidatura", "nome": "nome completo", "cidade": "...", "uf": "..", "modelo": "consignado", "revenda", "afiliado" ou "nao_sei", "experiencia": "se já vendeu, em poucas palavras"}: registra quem quer ser revendedora. Só use depois de a pessoa dizer nome completo e cidade e confirmar que quer se candidatar.');
    if (!f.length) return '';
    return [
      'FERRAMENTAS: para consultar ou fazer algo no sistema, devolva no JSON o campo "acao" com a ferramenta (e "resposta" vazia). O sistema executa e devolve o resultado; aí você responde ao cliente. Uma ferramenta por vez.',
      ...f,
      contato.pessoaId && cfg.segundaVia ? `Pedido de 2ª via, boleto, Pix ou "quanto eu devo" você resolve com as ferramentas, sem passar para a equipe. Passe para a equipe se a pessoa contestar a dívida, falar de processo, advogado ou justiça${cfg.acordo ? ', pedir desconto ou prazo fora do que "simular_acordo" devolver' : ', pedir desconto, parcelamento'} ou mudança de vencimento.` : '',
      !contato.pessoaId && (cfg.segundaVia || cfg.promessa) ? 'Este número não está ligado a um cadastro: assuntos de pagamento, boleto ou parcela você passa para a equipe.' : '',
      'O resultado de uma ferramenta é a única fonte de valores, datas, preços e links. Nunca escreva um link ou valor que não veio dela.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async parcelas(pessoaId: string) {
    return this.db
      .select({ id: titulos.id, descricao: titulos.descricao, valor: titulos.valor, vencimento: titulos.vencimento, forma: titulos.formaPagamento })
      .from(titulos)
      .where(and(eq(titulos.pessoaId, pessoaId), eq(titulos.tipo, 'receber'), inArray(titulos.status, ['aberto', 'protestado'])))
      .orderBy(asc(titulos.vencimento), asc(titulos.id))
      .limit(12);
  }

  async executar(cfg: FerramentasAgente, contato: Contato, conversaId: string, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    const nome = txt(acao.ferramenta, 40);
    try {
      if (nome === 'consultar_parcelas' && (cfg.segundaVia || cfg.promessa)) return await this.consultarParcelas(contato);
      if (nome === 'segunda_via' && cfg.segundaVia) return await this.segundaVia(contato, acao);
      if (nome === 'registrar_promessa' && cfg.promessa) return await this.registrarPromessa(cfg, contato, acao);
      if (nome === 'registrar_comprovante' && cfg.comprovante) return await this.registrarComprovante(contato, conversaId, acao);
      if (nome === 'simular_acordo' && cfg.acordo) return await this.simularAcordo(contato, acao);
      if (nome === 'aceitar_acordo' && cfg.acordo) return await this.aceitarAcordo(cfg, contato, acao);
      if (nome === 'consultar_estoque' && cfg.estoque) return await this.consultarEstoque(acao);
      if (nome === 'registrar_candidatura' && cfg.candidatura) return await this.registrarCandidatura(contato, conversaId, acao);
      return { texto: `A ferramenta "${nome}" não existe ou está desligada. Responda sem ela ou passe para a equipe.` };
    } catch (e) {
      this.log.warn(`Conversa ${conversaId}: ferramenta ${nome} falhou: ${(e as Error).message}`);
      return { texto: `Não deu certo: ${(e as Error).message.slice(0, 200)} Não invente o resultado; diga que alguém da equipe vai resolver e passe a conversa.`, nota: `🤖 A IA tentou "${nome}" e não deu certo: ${(e as Error).message.slice(0, 200)}` };
    }
  }

  private async consultarParcelas(contato: Contato): Promise<ResultadoFerramenta> {
    if (!contato.pessoaId) return { texto: 'Este número não está ligado a um cadastro; não há como consultar parcelas. Passe para a equipe.' };
    const lista = await this.parcelas(contato.pessoaId);
    if (!lista.length) return { texto: 'Esta pessoa não tem nenhuma parcela em aberto.' };
    const fora = await this.cobranca.foraDaTrilha(contato.pessoaId);
    if (fora === 'tem processo judicial ativo') return { texto: 'Esta pessoa tem processo judicial ativo: você NÃO fala de valores nem negocia. Diga com educação que o assunto é tratado pela equipe e passe a conversa (passar = true, motivo: processo judicial).', nota: '🤖 Pessoa com processo judicial ativo: a IA não tratou de cobrança.' };
    const cfg = await this.cobrancaConfig.obter();
    const h = hoje();
    const linhas = lista.map((t) => ({ ...t, atualizado: t.vencimento < h ? calcularEncargos(t.valor, t.vencimento, h, cfg).total : t.valor }));
    const total = linhas.reduce((a, t) => a + t.atualizado, 0);
    const vencido = linhas.filter((t) => t.vencimento < h);
    return {
      texto: `Parcelas em aberto (${lista.length}, total hoje ${reais(total)}):\n${linhas.map((t, i) => `${i + 1}. ${t.descricao.slice(0, 80)} · vence ${dataBR(t.vencimento)} · ${reais(t.valor)}${t.vencimento < h ? ` (VENCIDA; com multa e juros hoje: ${reais(t.atualizado)})` : ''}`).join('\n')}${vencido.length ? `\nVencido, atualizado até hoje: ${reais(vencido.reduce((a, t) => a + t.atualizado, 0))}.` : ''}${fora ? `\nObservação: ${fora}. Não cobre de novo o que já foi combinado; ajude no que a pessoa pedir.` : ''}`,
    };
  }

  /** Comprovante que a pessoa mandou: confere valor, data e nome com o que ela deve e deixa para a equipe dar baixa. */
  private async registrarComprovante(contato: Contato, conversaId: string, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    if (!contato.pessoaId) return { texto: 'Este número não está ligado a um cadastro. Passe para a equipe.' };
    const [p] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, contato.pessoaId));
    const [foto] = await this.db
      .select({ midia: crmMensagens.midia })
      .from(crmMensagens)
      .where(and(eq(crmMensagens.conversaId, conversaId), eq(crmMensagens.direcao, 'entrada'), inArray(crmMensagens.tipo, ['imagem', 'documento']), gte(crmMensagens.criadoEm, new Date(Date.now() - 2 * 86400_000))))
      .orderBy(desc(crmMensagens.criadoEm))
      .limit(1);
    const valor = typeof acao.valor === 'number' && acao.valor > 0 ? Math.round(acao.valor * 100) : null;
    const data = /^\d{4}-\d{2}-\d{2}$/.test(txt(acao.data, 10)) ? txt(acao.data, 10) : null;
    const pagador = txt(acao.pagador, 120) || null;
    const h = hoje();
    const cfg = await this.cobrancaConfig.obter();
    const lista = await this.parcelas(contato.pessoaId);
    const perto = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, Math.round(b * 0.01));
    // Bate com uma parcela (valor original, atualizado ou do boleto emitido) ou com a soma das vencidas.
    let tituloIds: string[] = [];
    if (valor) {
      const uma = lista.find((t) => [t.valor, t.vencimento < h ? calcularEncargos(t.valor, t.vencimento, h, cfg).total : t.valor].some((v) => perto(valor, v)));
      if (uma) tituloIds = [uma.id];
      else {
        const vencidas = lista.filter((t) => t.vencimento < h);
        const soma = vencidas.reduce((a, t) => a + t.valor, 0);
        const somaAtual = vencidas.reduce((a, t) => a + calcularEncargos(t.valor, t.vencimento, h, cfg).total, 0);
        if (vencidas.length && (perto(valor, soma) || perto(valor, somaAtual))) tituloIds = vencidas.map((t) => t.id);
      }
    }
    // Pagou menos que a parcela mais antiga: amortiza nela (o resto fica em aberto).
    let amortiza = false;
    if (valor && !tituloIds.length && lista.length && valor < lista[0].valor) {
      tituloIds = [lista[0].id];
      amortiza = true;
    }
    const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter((x) => x.length > 2);
    const nomeCad = norm(p?.nome ?? '');
    const nomePag = pagador ? norm(pagador) : [];
    const conferencia = {
      valor: tituloIds.length > 0 && !amortiza,
      data: !!data && data <= h && data >= new Date(Date.parse(`${h}T12:00:00Z`) - 5 * 86400_000).toISOString().slice(0, 10),
      nome: nomePag.length > 0 && nomePag[0] === nomeCad[0] && nomePag.filter((x) => nomeCad.includes(x)).length >= Math.min(2, nomeCad.length),
      observacao: [!valor ? 'valor não lido' : amortiza ? 'valor menor que a parcela: amortiza a mais antiga' : !tituloIds.length ? 'o valor não bate com nenhuma parcela' : '', !data ? 'data não lida' : '', pagador && nomePag[0] !== nomeCad[0] ? 'pago por outra pessoa' : ''].filter(Boolean).join('; ') || undefined,
    };
    const [comp] = await this.db.insert(cobrancaComprovantes).values({ pessoaId: contato.pessoaId, conversaId, midia: foto?.midia ?? null, valor, data, pagador, tituloIds, conferencia }).returning({ id: cobrancaComprovantes.id });
    const tudoCerto = conferencia.valor && conferencia.data && conferencia.nome;
    // O Pix já entrou no Asaas ou no extrato do Sicoob com o mesmo valor: a baixa (ou amortização) sai agora.
    const casou = tituloIds.length ? await this.pix.casarComprovante(comp.id).catch(() => ({ baixado: false })) : { baixado: false };
    if (casou.baixado) {
      await this.auditoria.registrar({ acao: 'comprovante_ia', entidade: 'pessoa', entidadeId: contato.pessoaId, dados: { valor, data, conferencia, baixado: true } });
      return {
        texto: `O Pix de ${valor ? reais(valor) : ''} foi encontrado na conta e a ${amortiza ? 'parcela foi amortizada (o restante continua em aberto)' : 'baixa foi feita'}. Agradeça e confirme para a pessoa que o pagamento foi recebido${amortiza ? ' e diga quanto ainda falta, usando "consultar_parcelas" se ela perguntar' : ''}.`,
        nota: `🤖 Comprovante de ${valor ? reais(valor) : 'pagamento'} conferido com o Pix na conta: ${amortiza ? 'amortizado' : 'baixado'} sozinho.`,
      };
    }
    await this.db.insert(cobrancaContatos).values({ pessoaId: contato.pessoaId, tipo: 'whatsapp', texto: `Comprovante recebido pela IA no WhatsApp: ${valor ? reais(valor) : 'valor não lido'}${data ? ` em ${dataBR(data)}` : ''}${pagador ? `, pago por ${pagador}` : ''}. ${tudoCerto ? 'Valor, data e nome conferem.' : `Conferir: ${conferencia.observacao ?? 'nome diferente do cadastro'}.`} Aguardando a baixa da equipe.` });
    await this.auditoria.registrar({ acao: 'comprovante_ia', entidade: 'pessoa', entidadeId: contato.pessoaId, dados: { valor, data, conferencia } });
    return {
      texto: tudoCerto
        ? 'Comprovante registrado e conferido (valor, data e nome batem). O Pix ainda não apareceu na conta: a baixa sai sozinha assim que ele aparecer. Agradeça e diga que a confirmação chega em breve. Não diga que já foi baixado.'
        : `Comprovante registrado, mas precisa de conferência da equipe (${conferencia.observacao ?? 'o nome é diferente do cadastro'}). Agradeça, diga que a equipe vai conferir e dar a baixa, e não discuta valores.`,
      nota: `🤖 Comprovante registrado para conferência: ${valor ? reais(valor) : 'valor não lido'}${data ? ` em ${dataBR(data)}` : ''}${pagador ? ` (${pagador})` : ''}. Veja em Cobrança › Comprovantes.`,
    };
  }

  /** Proposta dentro das regras: à vista com o desconto máximo do cobrador, ou parcelado sem desconto. */
  private async proposta(pessoaId: string, acao: Record<string, unknown>) {
    const cfg = await this.cobrancaConfig.obter();
    const h = hoje();
    const vencidas = (await this.parcelas(pessoaId)).filter((t) => t.vencimento < h);
    if (!vencidas.length) throw new Error('Não há parcela vencida para negociar.');
    const parcelas = Math.max(1, Math.min(cfg.parcelasMax, Math.round(Number(acao.parcelas) || 1)));
    const entrada = typeof acao.entrada === 'number' && acao.entrada > 0 ? Math.round(acao.entrada * 100) : 0;
    const atualizado = vencidas.reduce((a, t) => a + calcularEncargos(t.valor, t.vencimento, h, cfg).total, 0);
    const desconto = parcelas === 1 && !entrada ? Math.floor((atualizado * cfg.descontoMaxPb) / 10000) : 0;
    const amanha = new Date(Date.parse(`${h}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    const primeiro = new Date(Date.parse(`${h}T12:00:00Z`) + (entrada ? 30 : 1) * 86400_000).toISOString().slice(0, 10);
    const pedido = { tituloIds: vencidas.map((t) => t.id), desconto, entrada, vencimentoEntrada: entrada ? amanha : undefined, parcelas: entrada && parcelas === 1 ? 1 : parcelas, primeiroVencimento: primeiro };
    const r = await this.cobranca.simularAcordo(this.escopo, pessoaId, pedido);
    return { r, pedido, cfg, pedidoParcelas: parcelas };
  }

  private async simularAcordo(contato: Contato, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    if (!contato.pessoaId) return { texto: 'Este número não está ligado a um cadastro. Passe para a equipe.' };
    if ((await this.cobranca.foraDaTrilha(contato.pessoaId)) === 'tem processo judicial ativo') return { texto: 'Esta pessoa tem processo judicial ativo: não negocie. Passe para a equipe (passar = true).' };
    const { r, cfg, pedidoParcelas } = await this.proposta(contato.pessoaId, acao);
    const linhas = [r.entrada ? `entrada de ${reais(r.entrada.valor)} para ${dataBR(r.entrada.vencimento)}` : '', ...r.parcelas.map((p) => `${p.numero}ª de ${reais(p.valor)} para ${dataBR(p.vencimento)}`)].filter(Boolean);
    return {
      texto: `Proposta (dentro das regras): dívida vencida de ${reais(r.original)}, com multa e juros ${reais(r.atualizado)}${r.desconto ? `, desconto de ${reais(r.desconto)} à vista` : ''}. Total do acordo: ${reais(r.total)} em ${linhas.join('; ')}.\nLimites: até ${cfg.parcelasMax} parcelas; desconto (até ${(cfg.descontoMaxPb / 100).toLocaleString('pt-BR')}%) só à vista.${pedidoParcelas !== Number(acao.parcelas) ? ` A pessoa pediu ${acao.parcelas} parcelas, acima do máximo: ofereça ${pedidoParcelas}.` : ''} Explique a proposta de forma simples e pergunte se ela aceita.`,
    };
  }

  private async aceitarAcordo(cfg: FerramentasAgente, contato: Contato, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    if (!contato.pessoaId) return { texto: 'Este número não está ligado a um cadastro. Passe para a equipe.' };
    if ((await this.cobranca.foraDaTrilha(contato.pessoaId)) === 'tem processo judicial ativo') return { texto: 'Esta pessoa tem processo judicial ativo: não feche acordo. Passe para a equipe (passar = true).' };
    const { r, pedido } = await this.proposta(contato.pessoaId, acao);
    const forma = String(acao.forma).toLowerCase() === 'boleto' ? 'BOLETO' : 'PIX';
    const resumo = `${reais(r.total)}${r.entrada ? ` (entrada de ${reais(r.entrada.valor)} + ${r.parcelas.length}x)` : r.parcelas.length > 1 ? ` em ${r.parcelas.length}x de ${reais(r.parcelas[0].valor)}` : ' à vista'}${r.desconto ? `, com ${reais(r.desconto)} de desconto` : ''}, por ${forma === 'PIX' ? 'Pix' : 'boleto'}`;
    if (!cfg.fecharAcordo) {
      await this.db.insert(cobrancaContatos).values({ pessoaId: contato.pessoaId, tipo: 'whatsapp', texto: `Proposta de acordo aceita pela pessoa no WhatsApp (IA): ${resumo}. A equipe precisa fechar o acordo na ficha.`, retornoEm: hoje() });
      return { texto: `Proposta anotada (${resumo}). Diga que a equipe vai confirmar o acordo e mandar os links de pagamento, e passe a conversa (passar = true, motivo: fechar acordo aceito).`, nota: `🤖 A pessoa aceitou a proposta de acordo: ${resumo}. Feche o acordo na ficha de cobrança.` };
    }
    const feito = await this.cobranca.criarAcordo(this.escopo, null, contato.pessoaId, { ...pedido, cobranca: forma, observacao: 'Fechado pela IA no WhatsApp, dentro das regras da cobrança.' });
    const primeira = feito.parcelas[0];
    const link = primeira?.cobrancaUrl ?? null;
    await this.auditoria.registrar({ acao: 'acordo_ia', entidade: 'cobranca_acordo', entidadeId: feito.acordo.id, dados: { pessoaId: contato.pessoaId, total: r.total } });
    return {
      texto: `Acordo nº ${feito.acordo.numero} fechado: ${resumo}.${link ? ` Link da primeira parcela (${reais(primeira!.valor)}, vence ${dataBR(primeira!.vencimento)}): ${link}` : ' Os links de pagamento serão enviados pela equipe.'}${feito.avisos.length ? ' (A equipe vai conferir a emissão dos boletos.)' : ''} Confirme com a pessoa e mande o link exatamente assim.`,
      nota: `🤖 A IA fechou o acordo nº ${feito.acordo.numero}: ${resumo}.`,
    };
  }

  private async segundaVia(contato: Contato, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    if (!contato.pessoaId) return { texto: 'Este número não está ligado a um cadastro. Passe para a equipe.' };
    if (!this.asaas.configurado) return { texto: 'A emissão de boleto e Pix não está ligada no sistema. Passe para a equipe.' };
    const lista = await this.parcelas(contato.pessoaId);
    const n = Number(acao.parcela);
    const t = Number.isInteger(n) ? lista[n - 1] : undefined;
    if (!t) return { texto: `Parcela inválida. Use "consultar_parcelas" e escolha um número de 1 a ${lista.length}.` };
    if (t.forma === 'debito' || t.forma === 'credito') return { texto: 'Esta parcela é de cartão e não gera boleto nem Pix. Passe para a equipe.' };
    if ((await this.cobranca.foraDaTrilha(contato.pessoaId)) === 'tem processo judicial ativo') return { texto: 'Esta pessoa tem processo judicial ativo: não mande cobrança. Passe para a equipe (passar = true).' };
    const tipo = String(acao.forma).toLowerCase() === 'boleto' ? 'BOLETO' : 'PIX';
    const h = hoje();
    // Vencida: cobrança nova para hoje com multa e juros (o boleto antigo é cancelado). Em dia: o link da própria parcela.
    const r = t.vencimento < h ? await this.cobranca.segundaVia(this.escopo, null, t.id, { vencimento: h, tipo, comEncargos: true }) : { ...(await this.asaas.cobrar(t.id, tipo, null)), valor: t.valor, vencimento: t.vencimento };
    if (!r.url) return { texto: 'O link de pagamento não foi gerado. Passe para a equipe.' };
    await this.auditoria.registrar({ acao: 'segunda_via_ia', entidade: 'titulo', entidadeId: t.id });
    return {
      texto: `Link de pagamento da parcela ${n} (${t.descricao.slice(0, 60)}): ${reais(r.valor)}${r.valor !== t.valor ? ' (já com multa e juros)' : ''}, vence ${dataBR(r.vencimento)}: ${r.url}${tipo === 'PIX' && r.pixCopiaCola ? `\nPix copia e cola: ${r.pixCopiaCola}` : ''}\nMande o link${tipo === 'PIX' && r.pixCopiaCola ? ' e o Pix copia e cola' : ''} exatamente assim.`,
      nota: `🤖 A IA enviou ${tipo === 'PIX' ? 'um Pix' : 'a 2ª via do boleto'} de "${t.descricao.slice(0, 60)}" (${reais(r.valor)}, vence ${dataBR(r.vencimento)}).`,
    };
  }

  private async registrarPromessa(cfg: FerramentasAgente, contato: Contato, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    if (!contato.pessoaId) return { texto: 'Este número não está ligado a um cadastro. Passe para a equipe.' };
    const data = txt(acao.data, 10);
    const h = hoje();
    const limite = new Date(Date.now() - 3 * 3600_000 + Math.max(1, cfg.promessaMaxDias) * 86400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(data))) return { texto: 'Data inválida. Use o formato AAAA-MM-DD.' };
    if (data < h) return { texto: `Essa data já passou (hoje é ${dataBR(h)}). Pergunte de novo a data.` };
    if (data > limite) return { texto: `A promessa pode ser no máximo até ${dataBR(limite)}. Para prazo maior, passe para a equipe.` };
    const lista = await this.parcelas(contato.pessoaId);
    if (!lista.length) return { texto: 'Esta pessoa não tem parcela em aberto; não há o que prometer.' };
    const total = lista.filter((t) => t.vencimento <= data).reduce((a, t) => a + t.valor, 0) || lista[0].valor;
    const pedido = typeof acao.valor === 'number' && acao.valor > 0 ? Math.round(acao.valor * 100) : null;
    const valor = pedido && pedido <= lista.reduce((a, t) => a + t.valor, 0) ? pedido : total;
    await this.db.transaction(async (tx) => {
      // Promessa nova substitui a anterior que ainda estava aberta.
      await tx.update(cobrancaContatos).set({ promessaStatus: 'substituida' }).where(and(eq(cobrancaContatos.pessoaId, contato.pessoaId!), eq(cobrancaContatos.promessaStatus, 'aberta')));
      await tx.insert(cobrancaContatos).values({ pessoaId: contato.pessoaId!, tipo: 'whatsapp', texto: `Promessa registrada pela IA no WhatsApp: pagar ${reais(valor)} até ${dataBR(data)}.`, promessaData: data, promessaValor: valor, promessaStatus: 'aberta' });
    });
    await this.auditoria.registrar({ acao: 'promessa_ia', entidade: 'pessoa', entidadeId: contato.pessoaId, dados: { data, valor } });
    return { texto: `Promessa anotada: ${reais(valor)} até ${dataBR(data)}. Confirme isso com a pessoa e ofereça o link de pagamento.`, nota: `🤖 A IA registrou promessa de pagamento: ${reais(valor)} até ${dataBR(data)}.` };
  }

  private async consultarEstoque(acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    const busca = txt(acao.busca, 80);
    const palavras = busca.split(/\s+/).filter((p) => p.length >= 3).slice(0, 5);
    if (!palavras.length) return { texto: 'Diga o que procurar (por exemplo: "argola dourada").' };
    const itens = await this.db
      .select({
        descricao: produtos.descricao,
        referencia: produtos.referencia,
        cor: produtos.cor,
        preco: produtos.preco,
        estoque: sql<number>`coalesce((select sum(s.quantidade) from ${saldos} s join ${locaisEstoque} l on l.id = s.local_id where s.produto_id = ${produtos.id} and l.tipo <> 'maleta'), 0)::int`,
      })
      .from(produtos)
      .where(and(eq(produtos.ativo, true), eq(produtos.exibeCatalogo, true), sql`${produtos.preco} > 0`, or(eq(produtos.referencia, busca), eq(produtos.codigoBarras, busca), and(...palavras.map((p) => sql`(${produtos.descricao} || ' ' || coalesce(${produtos.cor}, '')) ilike ${`%${p}%`}`)))))
      .orderBy(sql`5 desc`, asc(produtos.descricao))
      .limit(6);
    if (!itens.length) return { texto: `Não achei nenhuma peça para "${busca}". Não diga que não existe: diga que vai confirmar com a equipe, ou peça outro detalhe.` };
    return { texto: `Peças encontradas para "${busca}":\n${itens.map((i) => `- ${i.descricao}${i.cor ? ` (${i.cor})` : ''}, ref. ${i.referencia}: ${reais(i.preco)} · ${i.estoque > 0 ? 'tem em estoque' : 'sem estoque no momento'}`).join('\n')}\nNão diga a quantidade em estoque. Reserva, entrega e fechamento da venda são com a equipe.` };
  }

  private async registrarCandidatura(contato: Contato, conversaId: string, acao: Record<string, unknown>): Promise<ResultadoFerramenta> {
    const nome = txt(acao.nome, 150);
    const cidade = txt(acao.cidade, 80);
    const uf = txt(acao.uf, 2).toUpperCase();
    if (nome.split(/\s+/).length < 2) return { texto: 'Falta o nome completo (nome e sobrenome). Pergunte.' };
    if (cidade.length < 2) return { texto: 'Falta a cidade. Pergunte.' };
    const modelo = ['consignado', 'revenda', 'afiliado'].includes(String(acao.modelo)) ? String(acao.modelo) : 'nao_sei';
    const telefone = contato.telefone.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (contato.pessoaId) {
      const [p] = await this.db.select({ tipo: pessoas.tipo }).from(pessoas).where(eq(pessoas.id, contato.pessoaId));
      if (p?.tipo === 'representante') return { texto: 'Esta pessoa já é revendedora cadastrada. Não registre candidatura; ajude no que ela precisa.' };
    }
    const dados = { nome, cidade, uf: /^[A-Z]{2}$/.test(uf) ? uf : null, modeloInteresse: modelo, experiencia: txt(acao.experiencia, 500) || null };
    const [aberta] = await this.db.select({ id: candidaturas.id }).from(candidaturas).where(and(eq(candidaturas.telefone, telefone), sql`${candidaturas.etapa} not in ('aprovada','recusada')`));
    if (aberta) {
      await this.db.update(candidaturas).set({ ...Object.fromEntries(Object.entries(dados).filter(([, v]) => v)), atualizadoEm: new Date() }).where(eq(candidaturas.id, aberta.id));
      await this.db.insert(candidaturaNotas).values({ candidaturaId: aberta.id, texto: 'Conversou com a IA no WhatsApp e confirmou o interesse.' });
      return { texto: 'Esta pessoa já tinha uma candidatura em andamento; os dados foram atualizados. Diga que a equipe de recrutamento vai entrar em contato.', nota: `🤖 A IA atualizou a candidatura de ${nome}.` };
    }
    // O pedido veio da própria pessoa, pelo WhatsApp dela: é o consentimento para o contato.
    const [c] = await this.db.insert(candidaturas).values({ ...dados, telefone, consentimentoLgpd: true, comoConheceu: 'WhatsApp', origem: { utm_source: 'whatsapp', utm_medium: 'ia' } }).returning();
    await this.auditoria.registrar({ acao: 'candidatura', entidade: 'candidatura', entidadeId: c.id, dados: { origem: 'whatsapp_ia' } });
    // Card no funil de recrutamento, ligado ao mesmo contato da conversa.
    try {
      const alvo = await this.crm.etapaAuto('recrutamento', c.etapa);
      const [ja] = await this.db.select({ id: crmLeads.id }).from(crmLeads).where(eq(crmLeads.candidaturaId, c.id));
      if (alvo && !ja) {
        await this.crm.criarLead({
          funilId: alvo.funilId,
          etapaId: alvo.etapaId,
          contatoId: contato.id,
          titulo: `${nome}${cidade ? ` · ${cidade}` : ''}`,
          origem: c.origem,
          candidaturaId: c.id,
          responsavelId: null,
          camposExtras: Object.fromEntries(Object.entries({ 'Modelo de interesse': modelo, 'Experiência com vendas': dados.experiencia }).filter(([, v]) => v)) as Record<string, string>,
        });
      }
    } catch (e) {
      this.log.warn(`Conversa ${conversaId}: candidatura ${c.numero} ficou sem card: ${(e as Error).message}`);
    }
    return { texto: `Candidatura nº ${c.numero} registrada. Diga que a equipe de recrutamento vai entrar em contato para os próximos passos; não prometa prazo nem aprovação.`, nota: `🤖 A IA registrou a candidatura nº ${c.numero} de ${nome} (${cidade}${dados.uf ? `/${dados.uf}` : ''}).` };
  }
}
