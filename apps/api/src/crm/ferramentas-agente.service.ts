import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { candidaturaNotas, candidaturas, cobrancaContatos, crmContatos, crmLeads, locaisEstoque, pessoas, produtos, saldos, titulos } from '../db/schema';
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
}
export const FERRAMENTAS_PADRAO: FerramentasAgente = { segundaVia: true, promessa: true, promessaMaxDias: 10, estoque: true, candidatura: true };

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
  ) {}

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
    if (cfg.estoque) f.push('- {"ferramenta": "consultar_estoque", "busca": "o que a pessoa procura"}: diz se a peça existe, o preço e se há em estoque. Só fale de preço e disponibilidade com o que esta ferramenta devolver.');
    if (cfg.candidatura) f.push('- {"ferramenta": "registrar_candidatura", "nome": "nome completo", "cidade": "...", "uf": "..", "modelo": "consignado", "revenda", "afiliado" ou "nao_sei", "experiencia": "se já vendeu, em poucas palavras"}: registra quem quer ser revendedora. Só use depois de a pessoa dizer nome completo e cidade e confirmar que quer se candidatar.');
    if (!f.length) return '';
    return [
      'FERRAMENTAS: para consultar ou fazer algo no sistema, devolva no JSON o campo "acao" com a ferramenta (e "resposta" vazia). O sistema executa e devolve o resultado; aí você responde ao cliente. Uma ferramenta por vez.',
      ...f,
      contato.pessoaId && cfg.segundaVia ? 'Pedido de 2ª via, boleto, Pix ou "quanto eu devo" você resolve com as ferramentas, sem passar para a equipe. Passe para a equipe se a pessoa contestar a dívida, pedir desconto, parcelamento ou mudança de vencimento.' : '',
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
    const h = hoje();
    const total = lista.reduce((a, t) => a + t.valor, 0);
    return {
      texto: `Parcelas em aberto (${lista.length}, total ${reais(total)}):\n${lista.map((t, i) => `${i + 1}. ${t.descricao.slice(0, 80)} · vence ${dataBR(t.vencimento)}${t.vencimento < h ? ' (VENCIDA)' : ''} · ${reais(t.valor)}`).join('\n')}\nOs valores são os originais; parcela vencida pode ter multa e juros, que aparecem no link de pagamento.`,
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
    const r = await this.asaas.cobrar(t.id, String(acao.forma).toLowerCase() === 'boleto' ? 'BOLETO' : 'PIX', null);
    if (!r.url) return { texto: 'O link de pagamento não foi gerado. Passe para a equipe.' };
    await this.auditoria.registrar({ acao: 'segunda_via_ia', entidade: 'titulo', entidadeId: t.id });
    return {
      texto: `Link de pagamento da parcela ${n} (${t.descricao.slice(0, 60)}, vence ${dataBR(t.vencimento)}, ${reais(t.valor)}): ${r.url}\nPor esse link a pessoa paga por Pix ou boleto. Mande o link exatamente assim.`,
      nota: `🤖 A IA enviou a 2ª via de "${t.descricao.slice(0, 60)}" (${reais(t.valor)}, vence ${dataBR(t.vencimento)}).`,
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
