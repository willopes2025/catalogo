import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { calcularEncargos, formatarReais, preencherTexto } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { temPermissao, type UsuarioLogado } from '../comum/auth';
import { AuditoriaService } from '../comum/auditoria.service';
import { assistentePedidos, chamadoMensagens, chamados, crmCanais, crmTemplates, empresas, maletas, pessoas, titulos, vendas } from '../db/schema';
import { CanaisService } from '../crm/canais.service';
import { CobrancaService } from '../cobranca/cobranca.service';
import { CobrancaConfigService } from '../cobranca/cobranca-config.service';
import { EmailService } from '../integracoes/email.service';
import { SegredosService } from '../segredos/segredos.service';
import { hoje } from '../maletas/maletas.service';
import type { DefinicaoFerramenta } from '../ia/ia.service';

/**
 * leitura: consulta, executa na hora.
 * acao: muda pouca coisa e é fácil de desfazer (anotação, pedido): executa na hora e fica registrada.
 * confirmar: manda mensagem, emite cobrança ou mexe em muita coisa: o assistente prepara, mostra a prévia e só executa quando a pessoa confirma.
 */
export type Risco = 'leitura' | 'acao' | 'confirmar';

export interface Contexto {
  usuario: UsuarioLogado;
  sessaoId: string;
  /** Avança o progresso das ações em segundo plano (envio em lote). */
  progresso?: (feitos: number, total: number, falhas: number) => Promise<void>;
}

export interface Preparo {
  /** Frase do que vai ser feito, para a pessoa confirmar. */
  resumo: string;
  /** Lista detalhada (ex.: cada mensagem). */
  previa?: unknown;
  /** Problema que impede executar (a ferramenta devolve isso ao assistente sem criar o cartão). */
  impedimento?: string;
}

export interface Ferramenta {
  nome: string;
  /** Explicação para o Claude: o que faz e quando usar. */
  descricao: string;
  schema: z.ZodType;
  risco: Risco;
  /** Quem pode usar (as mesmas permissões das telas). */
  permitido: (u: UsuarioLogado) => boolean;
  /** Ações demoradas rodam em segundo plano depois da confirmação. */
  segundoPlano?: boolean;
  preparar?: (entrada: any, ctx: Contexto) => Promise<Preparo>;
  executar: (entrada: any, ctx: Contexto) => Promise<unknown>;
}

const uuid = z.string().uuid('Use o id (uuid) devolvido pelas consultas.');
const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const pode = (modulo: string, acao: string) => (u: UsuarioLogado) => temPermissao(u.permissoes, modulo, acao);
const algum = (...ps: ((u: UsuarioLogado) => boolean)[]) => (u: UsuarioLogado) => ps.some((p) => p(u));
const dataBR = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null);
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400_000);
/** Dívida: a receber, em aberto ou protestado, que não é de cartão. */
const ehDivida = () => and(eq(titulos.tipo, 'receber'), inArray(titulos.status, ['aberto', 'protestado']), sql`coalesce(${titulos.formaPagamento}, '') not in ('debito', 'credito')`);

/** Variáveis que o envio em lote preenche sozinho em cada mensagem. */
export const VARIAVEIS_LOTE = ['nome', 'primeiro_nome', 'valor_em_aberto', 'valor_atualizado', 'maior_atraso', 'parcelas_vencidas', 'empresa'] as const;

/** Catálogo de ferramentas do assistente. Cada uma usa os serviços que as telas já usam (mesmas regras e validações). */
@Injectable()
export class FerramentasAssistente {
  readonly lista: Ferramenta[];

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly canais: CanaisService,
    private readonly cobranca: CobrancaService,
    private readonly cobrancaConfig: CobrancaConfigService,
    private readonly auditoria: AuditoriaService,
    private readonly email: EmailService,
    private readonly segredos: SegredosService,
  ) {
    this.lista = [
      this.consultarInadimplentes(),
      this.buscarPessoas(),
      this.fichaPessoa(),
      this.maletasAtrasadas(),
      this.resumoNegocio(),
      this.resumoVendas(),
      this.numerosWhatsapp(),
      this.enviarWhatsapp(),
      this.enviarWhatsappEmLote(),
      this.emitirSegundaVia(),
      this.registrarPromessa(),
      this.registrarPedido(),
      this.listarPedidos(),
    ];
  }

  obter(nome: string) {
    return this.lista.find((f) => f.nome === nome);
  }

  /** As ferramentas que esta pessoa pode usar, no formato da API do Claude. */
  definicoes(u: UsuarioLogado): DefinicaoFerramenta[] {
    return this.lista
      .filter((f) => f.permitido(u))
      .map((f) => {
        const { $schema: _, ...input_schema } = z.toJSONSchema(f.schema) as Record<string, unknown>;
        const aviso = f.risco === 'confirmar' ? ' [Pede confirmação: o sistema mostra a prévia e só executa quando a pessoa confirmar.]' : '';
        return { name: f.nome, description: f.descricao + aviso, input_schema };
      });
  }

  // ───────────── Consultas ─────────────

  private consultarInadimplentes(): Ferramenta {
    const schema = z.object({
      faixa: z.enum(['1_30', '31_60', '61_90', '91_180', 'mais_180']).optional().describe('Faixa do maior atraso, em dias'),
      tipo: z.enum(['representante', 'cliente']).optional().describe('Só revendedoras ou só clientes'),
      busca: z.string().max(80).optional().describe('Nome, CPF ou telefone'),
      limite: z.number().int().min(1).max(300).optional().describe('Máximo de pessoas (padrão 50)'),
    });
    return {
      nome: 'consultar_inadimplentes',
      descricao: 'Lista quem tem parcelas vencidas (revendedoras e clientes), do maior para o menor valor atualizado com multa e juros. Devolve pessoaId, telefone, quantidade de parcelas, valores e maior atraso. Respeita a carteira de quem pediu (terceirizada vê só a dela).',
      schema,
      risco: 'leitura',
      permitido: pode('cobranca', 'ver'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const escopo = await this.cobranca.escopo(ctx.usuario);
        const limite = e.limite ?? 50;
        const itens: Awaited<ReturnType<CobrancaService['carteira']>>['itens'] = [];
        for (let pagina = 1; itens.length < limite; pagina++) {
          const r = await this.cobranca.carteira(escopo, { faixa: e.faixa, tipo: e.tipo, busca: e.busca, pagina });
          itens.push(...r.itens);
          if (!r.temMais) break;
        }
        const lista = itens.slice(0, limite);
        return {
          quantidade: lista.length,
          haMais: itens.length > limite,
          totalAtualizado: formatarReais(lista.reduce((s, i) => s + Number(i.atualizado), 0)),
          pessoas: lista.map((i) => ({
            pessoaId: i.pessoaId,
            nome: i.nome,
            tipo: i.tipo,
            telefone: i.telefone,
            cidade: i.cidade,
            parcelasVencidas: i.titulos,
            valorOriginal: formatarReais(Number(i.original)),
            valorAtualizado: formatarReais(Number(i.atualizado)),
            maiorAtrasoDias: i.maiorAtraso,
            promessaDePagamento: dataBR(i.promessa),
            cobrancaPausada: i.pausada,
            emProtesto: i.emProtesto > 0,
          })),
        };
      },
    };
  }

  private buscarPessoas(): Ferramenta {
    const schema = z.object({
      busca: z.string().trim().min(2).max(80).describe('Nome, CPF/CNPJ ou telefone'),
      tipo: z.enum(['representante', 'cliente', 'fornecedor']).optional(),
      limite: z.number().int().min(1).max(30).optional(),
    });
    return {
      nome: 'buscar_pessoas',
      descricao: 'Procura revendedoras, clientes ou fornecedores pelo nome, documento ou telefone. Use para achar o pessoaId antes de outras ferramentas.',
      schema,
      risco: 'leitura',
      permitido: algum(pode('rede', 'ver'), pode('cadastros', 'ver'), pode('cobranca', 'ver')),
      executar: async (e: z.infer<typeof schema>) => {
        const b = `%${e.busca}%`;
        const dig = e.busca.replace(/\D/g, '');
        const filtros = [or(sql`${pessoas.nome} ilike ${b}`, sql`${pessoas.nomeFantasia} ilike ${b}`, ...(dig.length >= 4 ? [sql`${pessoas.documento} like ${'%' + dig + '%'}`, sql`regexp_replace(coalesce(${pessoas.telefone1}, ''), '\\D', '', 'g') like ${'%' + dig + '%'}`] : []))!];
        if (e.tipo) filtros.push(eq(pessoas.tipo, e.tipo));
        const r = await this.db
          .select({ pessoaId: pessoas.id, nome: pessoas.nome, tipo: pessoas.tipo, documento: pessoas.documento, telefone: pessoas.telefone1, email: pessoas.email, cidade: pessoas.cidade, uf: pessoas.uf, status: pessoas.status, bloqueado: pessoas.bloqueado })
          .from(pessoas)
          .where(and(...filtros))
          .orderBy(asc(pessoas.nome))
          .limit(e.limite ?? 10);
        return { quantidade: r.length, pessoas: r };
      },
    };
  }

  private fichaPessoa(): Ferramenta {
    const schema = z.object({ pessoaId: uuid });
    return {
      nome: 'ficha_pessoa',
      descricao: 'Ficha de uma pessoa: dados de contato, maletas abertas (com prazo do acerto) e parcelas em aberto (com id do título, valor, vencimento e link do boleto/Pix atual).',
      schema,
      risco: 'leitura',
      permitido: algum(pode('rede', 'ver'), pode('cadastros', 'ver'), pode('cobranca', 'ver')),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, e.pessoaId));
        if (!p) throw new BadRequestException('Pessoa não encontrada.');
        if (temPermissao(ctx.usuario.permissoes, 'cobranca', 'ver') && !temPermissao(ctx.usuario.permissoes, 'cadastros', 'ver') && !temPermissao(ctx.usuario.permissoes, 'rede', 'ver')) await this.cobranca.exigirAcesso(await this.cobranca.escopo(ctx.usuario), p.id);
        const h = hoje();
        const ms = await this.db.select({ numero: maletas.numero, dataLimite: maletas.dataLimite }).from(maletas).where(and(eq(maletas.representanteId, p.id), eq(maletas.status, 'aberta'))).orderBy(asc(maletas.dataLimite));
        const ts = await this.db.select().from(titulos).where(and(eq(titulos.pessoaId, p.id), ehDivida())).orderBy(asc(titulos.vencimento)).limit(60);
        return {
          pessoaId: p.id,
          nome: p.nome,
          tipo: p.tipo,
          status: p.status,
          bloqueado: p.bloqueado,
          documento: p.documento,
          telefone: p.telefone1,
          email: p.email,
          cidade: p.cidade && `${p.cidade}/${p.uf ?? ''}`,
          modeloTrabalho: p.modeloTrabalho,
          limiteCredito: p.tipo === 'representante' ? formatarReais(p.limiteCredito) : undefined,
          maletasAbertas: ms.map((m) => ({ numero: m.numero, acertoAte: dataBR(m.dataLimite), atrasada: m.dataLimite < h })),
          parcelasEmAberto: ts.map((t) => ({ tituloId: t.id, descricao: t.descricao, valor: formatarReais(t.valor), vencimento: dataBR(t.vencimento), vencida: t.vencimento < h, diasAtraso: t.vencimento < h ? diasEntre(t.vencimento, h) : 0, status: t.status, boletoOuPix: t.cobrancaUrl ?? null })),
        };
      },
    };
  }

  private maletasAtrasadas(): Ferramenta {
    const schema = z.object({ limite: z.number().int().min(1).max(200).optional() });
    return {
      nome: 'maletas_atrasadas',
      descricao: 'Maletas abertas com o prazo do acerto vencido: número, revendedora, telefone e dias de atraso.',
      schema,
      risco: 'leitura',
      permitido: pode('maletas', 'ver'),
      executar: async (e: z.infer<typeof schema>) => {
        const h = hoje();
        const r = await this.db
          .select({ numero: maletas.numero, dataLimite: maletas.dataLimite, pessoaId: pessoas.id, nome: pessoas.nome, telefone: pessoas.telefone1 })
          .from(maletas)
          .innerJoin(pessoas, eq(pessoas.id, maletas.representanteId))
          .where(and(eq(maletas.status, 'aberta'), lt(maletas.dataLimite, h)))
          .orderBy(asc(maletas.dataLimite))
          .limit(e.limite ?? 50);
        return { quantidade: r.length, maletas: r.map((m) => ({ ...m, dataLimite: dataBR(m.dataLimite), diasAtraso: diasEntre(m.dataLimite, h) })) };
      },
    };
  }

  private resumoNegocio(): Ferramenta {
    const schema = z.object({
      de: dataIso.describe('Primeiro dia do período'),
      ate: dataIso.describe('Último dia (inclusive)'),
    });
    return {
      nome: 'resumo_negocio',
      descricao:
        'Visão geral do negócio no período, comparada com o período anterior de mesmo tamanho: vendas (líquido, quantidade, ticket médio), recebimentos, maletas retiradas, revendedoras novas e ativas, e a foto atual da inadimplência e das maletas atrasadas. Use para conversar sobre resultados ("como foi o mês?", "estamos melhor que o mês passado?").',
      schema,
      risco: 'leitura',
      permitido: algum(pode('relatorios', 'ver'), pode('inicio', 'ver')),
      executar: async (e: z.infer<typeof schema>) => {
        if (e.ate < e.de) throw new BadRequestException('A data final é antes da inicial.');
        const dias = diasEntre(e.de, e.ate) + 1;
        const desloca = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
        const ant = { de: desloca(e.de, -dias), ate: desloca(e.de, -1) };
        const dia = sql`(${vendas.criadoEm} at time zone 'America/Sao_Paulo')::date`;
        const numeros = async (de: string, ate: string) => {
          const [v] = await this.db.select({ qtd: sql<number>`count(*)::int`, liquido: sql<number>`coalesce(sum(${vendas.total} - ${vendas.devolvido}), 0)::bigint` }).from(vendas).where(and(eq(vendas.status, 'concluida'), gte(dia, de), lte(dia, ate)));
          const [r] = await this.db.select({ valor: sql<number>`coalesce(sum(coalesce(${titulos.valorPago}, ${titulos.valor})), 0)::bigint` }).from(titulos).where(and(eq(titulos.tipo, 'receber'), eq(titulos.status, 'pago'), gte(titulos.pagoEm, de), lte(titulos.pagoEm, ate)));
          const [m] = await this.db.select({ qtd: sql<number>`count(*)::int` }).from(maletas).where(and(sql`${maletas.status} <> 'cancelada'`, gte(maletas.dataRetirada, de), lte(maletas.dataRetirada, ate)));
          const [n] = await this.db.select({ qtd: sql<number>`count(*)::int` }).from(pessoas).where(and(eq(pessoas.tipo, 'representante'), sql`(${pessoas.criadoEm} at time zone 'America/Sao_Paulo')::date between ${de} and ${ate}`));
          return { vendas: v.qtd, liquido: Number(v.liquido), recebido: Number(r.valor), maletas: m.qtd, revendedorasNovas: n.qtd };
        };
        const [atual, anterior] = await Promise.all([numeros(e.de, e.ate), numeros(ant.de, ant.ate)]);
        const variacao = (a: number, b: number) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1).replace('.', ',')}%` : a ? 'sem base de comparação' : '0%');
        const h = hoje();
        const [inad] = await this.db.select({ pessoas: sql<number>`count(distinct ${titulos.pessoaId})::int`, valor: sql<number>`coalesce(sum(${titulos.valor}), 0)::bigint` }).from(titulos).where(and(ehDivida(), lt(titulos.vencimento, h)));
        const [atr] = await this.db.select({ qtd: sql<number>`count(*)::int` }).from(maletas).where(and(eq(maletas.status, 'aberta'), lt(maletas.dataLimite, h)));
        const [abertas] = await this.db.select({ qtd: sql<number>`count(*)::int` }).from(maletas).where(eq(maletas.status, 'aberta'));
        const [ativas] = await this.db.select({ qtd: sql<number>`count(*)::int` }).from(pessoas).where(and(eq(pessoas.tipo, 'representante'), eq(pessoas.status, 'ativo')));
        const ticket = (x: { vendas: number; liquido: number }) => (x.vendas ? Math.round(x.liquido / x.vendas) : 0);
        return {
          periodo: `${dataBR(e.de)} a ${dataBR(e.ate)}`,
          comparadoCom: `${dataBR(ant.de)} a ${dataBR(ant.ate)}`,
          vendas: { liquido: formatarReais(atual.liquido), anterior: formatarReais(anterior.liquido), variacao: variacao(atual.liquido, anterior.liquido), quantidade: atual.vendas, quantidadeAnterior: anterior.vendas, ticketMedio: formatarReais(ticket(atual)), ticketMedioAnterior: formatarReais(ticket(anterior)) },
          recebimentos: { valor: formatarReais(atual.recebido), anterior: formatarReais(anterior.recebido), variacao: variacao(atual.recebido, anterior.recebido) },
          maletasRetiradas: { quantidade: atual.maletas, anterior: anterior.maletas, variacao: variacao(atual.maletas, anterior.maletas) },
          revendedoras: { novas: atual.revendedorasNovas, novasAnterior: anterior.revendedorasNovas, ativasHoje: ativas.qtd },
          hoje: { inadimplencia: formatarReais(Number(inad.valor)), pessoasInadimplentes: inad.pessoas, maletasAbertas: abertas.qtd, maletasAtrasadas: atr.qtd },
          observacao: 'Vendas já descontam devoluções. Inadimplência = parcelas vencidas em aberto, valor original (sem multa e juros).',
        };
      },
    };
  }

  private resumoVendas(): Ferramenta {
    const schema = z.object({ de: dataIso.describe('Primeiro dia'), ate: dataIso.describe('Último dia (inclusive)') });
    return {
      nome: 'resumo_vendas',
      descricao: 'Total vendido (já descontando devoluções) e quantidade de vendas no período, separado por tipo (balcão/loja e evento, avulsa da matriz, revenda para revendedora).',
      schema,
      risco: 'leitura',
      permitido: algum(pode('vendas', 'ver'), pode('relatorios', 'ver')),
      executar: async (e: z.infer<typeof schema>) => {
        if (e.ate < e.de) throw new BadRequestException('A data final é antes da inicial.');
        const dia = sql`(${vendas.criadoEm} at time zone 'America/Sao_Paulo')::date`;
        const r = await this.db
          .select({ tipo: vendas.tipo, quantidade: sql<number>`count(*)::int`, liquido: sql<number>`coalesce(sum(${vendas.total} - ${vendas.devolvido}), 0)::bigint` })
          .from(vendas)
          .where(and(eq(vendas.status, 'concluida'), gte(dia, e.de), lte(dia, e.ate)))
          .groupBy(vendas.tipo);
        const total = r.reduce((s, x) => s + Number(x.liquido), 0);
        const qtd = r.reduce((s, x) => s + x.quantidade, 0);
        return { periodo: `${dataBR(e.de)} a ${dataBR(e.ate)}`, vendas: qtd, totalLiquido: formatarReais(total), ticketMedio: qtd ? formatarReais(Math.round(total / qtd)) : null, porTipo: r.map((x) => ({ tipo: x.tipo, vendas: x.quantidade, total: formatarReais(Number(x.liquido)) })) };
      },
    };
  }

  private numerosWhatsapp(): Ferramenta {
    return {
      nome: 'numeros_whatsapp',
      descricao: 'Números de WhatsApp por onde esta pessoa pode enviar, com o tipo (oficial da Meta ou QR code) e, no oficial, os templates aprovados. Use antes de enviar para escolher o número.',
      schema: z.object({}),
      risco: 'leitura',
      permitido: pode('crm', 'criar'),
      executar: async (_e, ctx) => {
        const lista = (await this.canais.canaisDoUsuario(ctx.usuario.id, temPermissao(ctx.usuario.permissoes, 'crm', 'excluir'))).filter((c) => !c.excluidoEm);
        const ids = lista.map((c) => c.id);
        const tpls = ids.length ? await this.db.select({ id: crmTemplates.id, canalId: crmTemplates.canalId, nome: crmTemplates.nome, texto: crmTemplates.texto }).from(crmTemplates).where(and(inArray(crmTemplates.canalId, ids), eq(crmTemplates.status, 'APPROVED'))) : [];
        return {
          numeros: lista.map((c) => ({
            canalId: c.id,
            nome: c.nome,
            tipo: c.tipo === 'oficial' ? 'oficial (Meta)' : 'QR code',
            observacao: c.tipo === 'oficial' ? 'Texto livre só chega para quem escreveu nas últimas 24h; para os demais, use um template aprovado.' : 'Aceita texto livre. Em envio para muita gente, o sistema espaça as mensagens para o número não ser bloqueado.',
            templates: c.tipo === 'oficial' ? tpls.filter((t) => t.canalId === c.id).map((t) => ({ templateId: t.id, nome: t.nome, texto: t.texto })) : undefined,
          })),
        };
      },
    };
  }

  // ───────────── Ações ─────────────

  /** Número de envio: o escolhido (se a pessoa pode usar) ou o primeiro ativo dela, preferindo QR code. */
  private async escolherCanal(u: UsuarioLogado, canalId?: string) {
    const lista = (await this.canais.canaisDoUsuario(u.id, temPermissao(u.permissoes, 'crm', 'excluir'))).filter((c) => !c.excluidoEm);
    if (canalId) {
      const c = lista.find((x) => x.id === canalId);
      if (!c) throw new BadRequestException('Este número de WhatsApp não existe, está desativado ou você não envia por ele.');
      return c;
    }
    const c = lista.find((x) => x.tipo !== 'oficial') ?? lista[0];
    if (!c) throw new BadRequestException('Nenhum número de WhatsApp ativo para você enviar. Conecte um em CRM › Números.');
    return c;
  }

  private async templateDoCanal(canal: typeof crmCanais.$inferSelect, templateId?: string) {
    if (!templateId) return null;
    const [t] = await this.db.select().from(crmTemplates).where(eq(crmTemplates.id, templateId));
    if (!t || (t.canalId && t.canalId !== canal.id) || !['APPROVED', 'ATIVO'].includes(t.status)) throw new BadRequestException('Template não encontrado, de outro número ou ainda não aprovado.');
    return t;
  }

  private enviarWhatsapp(): Ferramenta {
    const schema = z.object({
      pessoaId: uuid.optional().describe('Pessoa cadastrada (o telefone vem da ficha)'),
      telefone: z.string().max(30).optional().describe('Só se não for pessoa cadastrada'),
      nome: z.string().max(120).optional(),
      texto: z.string().trim().min(1).max(4000).describe('Mensagem, como a pessoa vai receber'),
      canalId: uuid.optional().describe('Número de envio (padrão: o primeiro por QR code)'),
      templateId: uuid.optional().describe('Template aprovado, obrigatório no número oficial fora da janela de 24h'),
    });
    const resolver = async (e: z.infer<typeof schema>, ctx: Contexto) => {
      let telefone = e.telefone ?? null;
      let nome = e.nome ?? null;
      if (e.pessoaId) {
        const [p] = await this.db.select({ nome: pessoas.nome, telefone: pessoas.telefone1 }).from(pessoas).where(eq(pessoas.id, e.pessoaId));
        if (!p) throw new BadRequestException('Pessoa não encontrada.');
        telefone = p.telefone;
        nome = p.nome;
      }
      if (!telefone || telefone.replace(/\D/g, '').length < 10) throw new BadRequestException(`${nome ?? 'Esta pessoa'} não tem um telefone válido no cadastro.`);
      const canal = await this.escolherCanal(ctx.usuario, e.canalId);
      const tpl = await this.templateDoCanal(canal, e.templateId);
      return { telefone, nome, canal, tpl };
    };
    return {
      nome: 'enviar_whatsapp',
      descricao: 'Envia UMA mensagem de WhatsApp para uma pessoa. Para várias pessoas use enviar_whatsapp_em_lote.',
      schema,
      risco: 'confirmar',
      permitido: pode('crm', 'criar'),
      preparar: async (e: z.infer<typeof schema>, ctx) => {
        try {
          const r = await resolver(e, ctx);
          return { resumo: `Enviar WhatsApp para ${r.nome ?? r.telefone} (${r.telefone}) pelo número "${r.canal.nome}"${r.tpl ? ` com o template "${r.tpl.nome}"` : ''}.`, previa: [{ nome: r.nome, telefone: r.telefone, texto: r.tpl ? r.tpl.texto : e.texto }] };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const r = await resolver(e, ctx);
        const m = await this.canais.enviarParaTelefone({ canalId: r.canal.id, telefone: r.telefone, nome: r.nome, texto: e.texto, templateId: r.tpl?.id ?? null });
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: 'assistente_whatsapp', entidade: 'pessoa', entidadeId: e.pessoaId ?? null, dados: { telefone: r.telefone, canal: r.canal.nome } });
        return { enviado: true, status: m?.status ?? 'enviada', para: r.nome ?? r.telefone };
      },
    };
  }

  /** Dívida vencida de cada pessoa, para preencher as variáveis do envio em lote. */
  private async dividas(pessoaIds: string[]) {
    const cfg = await this.cobrancaConfig.obter();
    const h = hoje();
    const ts = pessoaIds.length ? await this.db.select({ pessoaId: titulos.pessoaId, valor: titulos.valor, vencimento: titulos.vencimento }).from(titulos).where(and(inArray(titulos.pessoaId, pessoaIds), ehDivida(), lt(titulos.vencimento, h))) : [];
    const m = new Map<string, { valor: number; atualizado: number; maiorAtraso: number; parcelas: number }>();
    for (const t of ts) {
      const d = m.get(t.pessoaId!) ?? { valor: 0, atualizado: 0, maiorAtraso: 0, parcelas: 0 };
      d.valor += t.valor;
      d.atualizado += calcularEncargos(t.valor, t.vencimento, h, cfg).total;
      d.maiorAtraso = Math.max(d.maiorAtraso, diasEntre(t.vencimento, h));
      d.parcelas++;
      m.set(t.pessoaId!, d);
    }
    return m;
  }

  private loteSchema = z.object({
    pessoaIds: z.array(uuid).min(1).max(500).describe('Quem recebe (ids das consultas)'),
    texto: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe(`Mensagem. O sistema troca sozinho, para cada pessoa: ${VARIAVEIS_LOTE.map((v) => `{${v}}`).join(', ')} (valores vencidos com multa e juros, atraso em dias).`),
    canalId: uuid.optional(),
    templateId: uuid.optional().describe('Template aprovado (número oficial)'),
    registrarNaCobranca: z.boolean().optional().describe('Anota o envio no histórico de cobrança de quem tem parcela vencida (padrão: sim)'),
  });

  private async montarLote(e: z.infer<FerramentasAssistente['loteSchema']>, ctx: Contexto) {
    const canal = await this.escolherCanal(ctx.usuario, e.canalId);
    const tpl = await this.templateDoCanal(canal, e.templateId);
    if (canal.tipo === 'oficial' && !tpl) throw new BadRequestException(`O número "${canal.nome}" é oficial da Meta: texto livre só chega para quem escreveu nas últimas 24h. Escolha um template aprovado (numeros_whatsapp) ou um número por QR code.`);
    const ids = [...new Set(e.pessoaIds)];
    const ps = await this.db.select({ id: pessoas.id, nome: pessoas.nome, telefone: pessoas.telefone1 }).from(pessoas).where(inArray(pessoas.id, ids));
    const escopo = temPermissao(ctx.usuario.permissoes, 'cobranca', 'ver') ? await this.cobranca.escopo(ctx.usuario) : null;
    const dividas = await this.dividas(ids);
    const [empresa] = await this.db.select({ nome: empresas.nome }).from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    const itens: { pessoaId: string; nome: string; telefone: string | null; texto: string; problema: string | null }[] = [];
    for (const p of ps) {
      let problema: string | null = null;
      if (!p.telefone || p.telefone.replace(/\D/g, '').length < 10) problema = 'Sem telefone válido no cadastro.';
      if (!problema && escopo?.restrito) await this.cobranca.exigirAcesso(escopo, p.id).catch(() => (problema = 'Fora da sua carteira de cobrança.'));
      const d = dividas.get(p.id);
      const texto = tpl
        ? tpl.texto
        : preencherTexto(e.texto, {
            nome: p.nome,
            primeiro_nome: p.nome.split(' ')[0],
            valor_em_aberto: d ? formatarReais(d.valor) : formatarReais(0),
            valor_atualizado: d ? formatarReais(d.atualizado) : formatarReais(0),
            maior_atraso: d?.maiorAtraso ?? 0,
            parcelas_vencidas: d?.parcelas ?? 0,
            empresa: empresa?.nome ?? 'Aritana',
          });
      itens.push({ pessoaId: p.id, nome: p.nome, telefone: p.telefone, texto, problema });
    }
    const faltando = ids.length - ps.length;
    return { canal, tpl, itens, faltando, dividas };
  }

  private enviarWhatsappEmLote(): Ferramenta {
    return {
      nome: 'enviar_whatsapp_em_lote',
      descricao:
        'Envia a mesma mensagem (com as variáveis preenchidas por pessoa) para várias pessoas pelo WhatsApp. O envio roda em segundo plano, espaçado para o número não ser bloqueado, e mostra o progresso na tela. Ex.: cobrança de inadimplentes, aviso de acerto, campanha para revendedoras.',
      schema: this.loteSchema,
      risco: 'confirmar',
      segundoPlano: true,
      permitido: pode('crm', 'criar'),
      preparar: async (e, ctx) => {
        try {
          const l = await this.montarLote(e, ctx);
          const validos = l.itens.filter((i) => !i.problema).length;
          if (!validos) return { resumo: '', impedimento: 'Nenhuma das pessoas tem telefone válido (ou estão fora da carteira de quem pediu).' };
          const intervalo = this.intervaloLote();
          const minutos = Math.max(1, Math.round((validos * intervalo) / 60));
          return {
            resumo: `Enviar para ${validos} pessoa(s) pelo número "${l.canal.nome}"${l.tpl ? ` com o template "${l.tpl.nome}"` : ''}. Uma mensagem a cada ~${intervalo}s: leva cerca de ${minutos} min.${l.itens.length - validos ? ` ${l.itens.length - validos} ficam de fora (veja o motivo na lista).` : ''}${l.faltando ? ` ${l.faltando} id(s) não encontrado(s).` : ''}`,
            previa: l.itens,
          };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e, ctx) => {
        const l = await this.montarLote(e, ctx);
        const validos = l.itens.filter((i) => !i.problema);
        const intervalo = this.intervaloLote();
        const falhas: { nome: string; erro: string }[] = l.itens.filter((i) => i.problema).map((i) => ({ nome: i.nome, erro: i.problema! }));
        let enviados = 0;
        await ctx.progresso?.(0, validos.length, 0);
        for (const [n, i] of validos.entries()) {
          if (n > 0) await new Promise((r) => setTimeout(r, Math.round(intervalo * 1000 * (0.75 + Math.random() * 0.5))));
          try {
            await this.canais.enviarParaTelefone({ canalId: l.canal.id, telefone: i.telefone!, nome: i.nome, texto: i.texto, templateId: l.tpl?.id ?? null });
            enviados++;
            if (e.registrarNaCobranca !== false && l.dividas.has(i.pessoaId)) await this.cobranca.registrarContato(await this.cobranca.escopo(ctx.usuario), ctx.usuario, i.pessoaId, { tipo: 'whatsapp', texto: `Mensagem enviada pelo assistente:\n${i.texto}` }).catch(() => undefined);
          } catch (err) {
            falhas.push({ nome: i.nome, erro: (err as Error).message.slice(0, 200) });
          }
          await ctx.progresso?.(n + 1, validos.length, falhas.length - (l.itens.length - validos.length));
        }
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: 'assistente_whatsapp_lote', entidade: 'crm_canal', entidadeId: l.canal.id, dados: { enviados, falhas: falhas.length } });
        return { enviados, naoEnviados: falhas.length, falhas };
      },
    };
  }

  /** Segundos entre uma mensagem e outra no envio em lote. */
  intervaloLote() {
    const n = Number(this.segredos.v('ASSISTENTE_INTERVALO_LOTE_S') ?? 20);
    return Number.isFinite(n) ? Math.min(300, Math.max(3, n)) : 20;
  }

  private emitirSegundaVia(): Ferramenta {
    const schema = z.object({
      tituloId: uuid.describe('Id do título (ficha_pessoa)'),
      vencimento: dataIso.describe('Novo vencimento (hoje ou depois)'),
      tipo: z.enum(['BOLETO', 'PIX']).optional(),
      comEncargos: z.boolean().optional().describe('Cobrar multa e juros até o novo vencimento (padrão: sim)'),
    });
    return {
      nome: 'emitir_segunda_via',
      descricao: 'Emite 2ª via de boleto ou um Pix novo de uma parcela em aberto, pelo Asaas. O boleto anterior é cancelado. Devolve o link e o Pix copia e cola.',
      schema,
      risco: 'confirmar',
      permitido: pode('cobranca', 'editar'),
      preparar: async (e: z.infer<typeof schema>) => {
        const [t] = await this.db.select({ t: titulos, nome: pessoas.nome }).from(titulos).leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId)).where(eq(titulos.id, e.tituloId));
        if (!t) return { resumo: '', impedimento: 'Título não encontrado.' };
        return { resumo: `Emitir ${e.tipo === 'PIX' ? 'Pix' : '2ª via de boleto'} de "${t.t.descricao}" (${formatarReais(t.t.valor)}, venceu ${dataBR(t.t.vencimento)}) de ${t.nome ?? '—'}, com novo vencimento em ${dataBR(e.vencimento)}${e.comEncargos === false ? ', sem multa e juros' : ', com multa e juros'}.` };
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const r = await this.cobranca.segundaVia(await this.cobranca.escopo(ctx.usuario), ctx.usuario, e.tituloId, { vencimento: e.vencimento, tipo: e.tipo ?? 'BOLETO', comEncargos: e.comEncargos !== false });
        return { valor: formatarReais(r.valor), vencimento: dataBR(r.vencimento), link: (r as { url?: string }).url ?? null, pixCopiaCola: (r as { pixCopiaCola?: string }).pixCopiaCola ?? null };
      },
    };
  }

  private registrarPromessa(): Ferramenta {
    const schema = z.object({
      pessoaId: uuid,
      data: dataIso.describe('Dia em que prometeu pagar'),
      valor: z.number().positive().optional().describe('Valor prometido, em reais'),
      observacao: z.string().max(500).optional(),
    });
    return {
      nome: 'registrar_promessa',
      descricao: 'Registra uma promessa de pagamento no histórico de cobrança da pessoa. No dia, o sistema confere sozinho se foi cumprida.',
      schema,
      risco: 'acao',
      permitido: pode('cobranca', 'editar'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const c = await this.cobranca.registrarContato(await this.cobranca.escopo(ctx.usuario), ctx.usuario, e.pessoaId, { tipo: 'nota', texto: `Promessa de pagamento registrada pelo assistente${e.observacao ? `: ${e.observacao}` : '.'}`, promessaData: e.data, promessaValor: e.valor ? Math.round(e.valor * 100) : null });
        return { registrada: true, id: c.id, data: dataBR(e.data), valor: e.valor ? formatarReais(Math.round(e.valor * 100)) : null };
      },
    };
  }

  // ───────────── Orquestração: o que ainda não existe ─────────────

  private registrarPedido(): Ferramenta {
    const schema = z.object({
      tipo: z.enum(['configurar', 'desenvolver']).describe('configurar = dá para montar com as configurações que o sistema já tem; desenvolver = precisa de tela, relatório, integração ou regra nova (código)'),
      titulo: z.string().trim().min(5).max(150),
      especificacao: z.string().trim().min(20).max(6000).describe('O que a pessoa quer, para quem, regras, exemplos e como saber que ficou pronto'),
      plano: z.array(z.string().max(300)).min(1).max(15).describe('Passos para entregar'),
      modulo: z.string().max(40).optional().describe('Módulo do sistema mais ligado ao pedido'),
      prioridade: z.enum(['baixa', 'normal', 'alta', 'urgente']).optional(),
    });
    return {
      nome: 'registrar_pedido',
      descricao:
        'Registra uma necessidade que as ferramentas atuais não resolvem: vira um pedido com especificação e plano, e abre um chamado de melhoria para a equipe da Wide. Use depois de entender bem o pedido (pergunte o que faltar) e de mostrar o plano à pessoa.',
      schema,
      risco: 'acao',
      permitido: () => true,
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const descricao = `${e.especificacao}\n\nPlano sugerido pelo assistente:\n${e.plano.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n(Tipo: ${e.tipo === 'configurar' ? 'configuração' : 'desenvolvimento'}; pedido feito pelo Assistente.)`;
        const r = await this.db.transaction(async (tx) => {
          const [c] = await tx.insert(chamados).values({ titulo: e.titulo.slice(0, 150), tipo: 'melhoria', modulo: e.modulo ?? null, tela: 'Assistente', prioridade: e.prioridade ?? 'normal', usuarioId: ctx.usuario.id }).returning();
          await tx.insert(chamadoMensagens).values({ chamadoId: c.id, usuarioId: ctx.usuario.id, texto: descricao.slice(0, 5000) });
          const [p] = await tx.insert(assistentePedidos).values({ sessaoId: ctx.sessaoId, usuarioId: ctx.usuario.id, tipo: e.tipo, titulo: e.titulo, especificacao: e.especificacao, plano: e.plano, modulo: e.modulo ?? null, prioridade: e.prioridade ?? 'normal', chamadoId: c.id }).returning();
          return { p, c };
        });
        const destino = this.segredos.v('EMAIL_SUPORTE');
        if (destino) await this.email.enviar(destino, `[Aritana] Pedido nº ${r.p.numero} (assistente) · ${e.titulo}`, `${ctx.usuario.nome} pediu pelo Assistente (${e.tipo}).\n\n${descricao}`).catch(() => undefined);
        return { pedido: r.p.numero, chamado: r.c.numero, status: 'novo' };
      },
    };
  }

  private listarPedidos(): Ferramenta {
    const schema = z.object({ status: z.enum(['novo', 'em_analise', 'em_andamento', 'pronto', 'recusado']).optional() });
    return {
      nome: 'listar_pedidos',
      descricao: 'Pedidos de configuração e desenvolvimento já registrados (os da pessoa; quem é da gestão vê todos), com a situação de cada um.',
      schema,
      risco: 'leitura',
      permitido: () => true,
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const todos = temPermissao(ctx.usuario.permissoes, 'configuracoes', 'editar');
        const filtros = [todos ? undefined : eq(assistentePedidos.usuarioId, ctx.usuario.id), e.status ? eq(assistentePedidos.status, e.status) : undefined].filter(Boolean);
        const r = await this.db.select({ numero: assistentePedidos.numero, tipo: assistentePedidos.tipo, titulo: assistentePedidos.titulo, status: assistentePedidos.status, criadoEm: assistentePedidos.criadoEm }).from(assistentePedidos).where(filtros.length ? and(...filtros) : undefined).orderBy(desc(assistentePedidos.criadoEm)).limit(30);
        return { pedidos: r };
      },
    };
  }
}

