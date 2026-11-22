import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { calcularEncargos, formatarReais, preencherTexto } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { temPermissao, type UsuarioLogado } from '../comum/auth';
import { AuditoriaService } from '../comum/auditoria.service';
import { assistenteAnexos, assistentePedidos, assistenteRotinas, cobrancaCarteira, chamadoMensagens, iaAgentes, chamados, crmCanais, crmTemplates, empresas, maletas, pessoas, titulos, vendas } from '../db/schema';
import { CanaisService } from '../crm/canais.service';
import { CobrancaService } from '../cobranca/cobranca.service';
import { CobrancaConfigService } from '../cobranca/cobranca-config.service';
import { EmailService } from '../integracoes/email.service';
import { SegredosService } from '../segredos/segredos.service';
import { hoje } from '../maletas/maletas.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { regrasSchema } from '../configuracoes/configuracoes.controller';
import { AgenteService } from '../crm/agente.service';
import { duplicarEspecialista } from '../crm/especialistas';
import { IaService } from '../ia/ia.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { readFile } from 'node:fs/promises';
import type { DefinicaoFerramenta } from '../ia/ia.service';
import { csv, descreverAgenda, proximaDaRotina, type Agenda } from './rotinas';

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
  /** Execução automática de uma rotina (ninguém acompanhando): e-mails para os endereços autorizados saem sem confirmação. */
  rotina?: { id: string; emails: string[]; aprovacao?: string };
  /** Quem está falando pode ligar a aprovação automática (regra da empresa em Assistente › Configurar). */
  podeAutomatico?: boolean;
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
    private readonly configuracoes: ConfiguracoesService,
    private readonly agente: AgenteService,
    private readonly ia: IaService,
    private readonly arquivos: ArquivosService,
  ) {
    this.lista = [
      this.consultarInadimplentes(),
      this.consultarFinanceiro(),
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
      this.verRegras(),
      this.alterarRegras(),
      this.verAgentesWhatsapp(),
      this.alterarAgentesWhatsapp(),
      this.enviarEmail(),
      this.agendarRotina(),
      this.gerenciarRotinas(),
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
        const limite = e.limite ?? 50;
        const todos = await this.todosInadimplentes(ctx.usuario, e);
        const lista = todos.slice(0, limite);
        return {
          quantidadeTotal: todos.length,
          mostrando: lista.length,
          totalAtualizado: formatarReais(todos.reduce((s, i) => s + Number(i.atualizado), 0)),
          totalOriginal: formatarReais(todos.reduce((s, i) => s + Number(i.original), 0)),
          porFaixaDeAtraso: this.faixas(todos),
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

  private consultarFinanceiro(): Ferramenta {
    const schema = z.object({
      tipo: z.enum(['receber', 'pagar']).optional().describe('Contas a receber (padrão) ou a pagar'),
      situacao: z.enum(['a_vencer', 'vencido', 'em_aberto', 'pago', 'todos']).optional().describe('a_vencer = vence de hoje em diante e não foi paga; vencido = venceu e não foi paga; em_aberto = as duas; pago = recebido/pago no período; todos. Padrão: em_aberto'),
      de: dataIso.optional().describe('Início do período (vencimento; para "pago", a data do pagamento). Padrão: hoje'),
      ate: dataIso.optional().describe('Fim do período, inclusive. Padrão: igual ao início'),
      pessoaId: uuid.optional(),
      agruparPor: z.enum(['dia', 'pessoa', 'forma', 'nenhum']).optional().describe('Padrão: dia'),
      limite: z.number().int().min(1).max(300).optional().describe('Quantas parcelas listar (padrão 50); os totais consideram todas'),
    });
    return {
      nome: 'consultar_financeiro',
      descricao:
        'Parcelas a receber ou a pagar por período e situação: o que vence hoje, nesta semana ou no mês, o que venceu e não foi pago, o que foi recebido ou pago num período. Devolve total, quantidade, agrupamento (por dia, pessoa ou forma de pagamento) e a lista com boleto/Pix. Ex.: "quanto vence hoje?", "o que recebi ontem?", "contas a pagar da semana".',
      schema,
      risco: 'leitura',
      permitido: algum(pode('financeiro', 'ver'), pode('cobranca', 'ver')),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const tipo = e.tipo ?? 'receber';
        const fin = temPermissao(ctx.usuario.permissoes, 'financeiro', 'ver');
        if (tipo === 'pagar' && !fin) throw new BadRequestException('Contas a pagar exigem acesso ao Financeiro.');
        const situacao = e.situacao ?? 'em_aberto';
        const h = hoje();
        const de = e.de ?? h;
        const ate = e.ate ?? de;
        if (ate < de) throw new BadRequestException('A data final é antes da inicial.');
        const filtros = [eq(titulos.tipo, tipo), e.pessoaId ? eq(titulos.pessoaId, e.pessoaId) : undefined];
        if (situacao === 'pago') filtros.push(eq(titulos.status, 'pago'), gte(titulos.pagoEm, de), lte(titulos.pagoEm, ate));
        else {
          filtros.push(gte(titulos.vencimento, de), lte(titulos.vencimento, ate));
          if (situacao === 'a_vencer') filtros.push(eq(titulos.status, 'aberto'), gte(titulos.vencimento, h));
          else if (situacao === 'vencido') filtros.push(inArray(titulos.status, ['aberto', 'protestado']), lt(titulos.vencimento, h));
          else if (situacao === 'em_aberto') filtros.push(inArray(titulos.status, ['aberto', 'protestado']));
          else filtros.push(sql`${titulos.status} not in ('cancelado', 'renegociado')`);
        }
        // Sem acesso ao Financeiro e terceirizada da cobrança: só a carteira dela.
        if (!fin && tipo === 'receber') {
          const escopo = await this.cobranca.escopo(ctx.usuario);
          if (escopo.restrito) filtros.push(inArray(titulos.pessoaId, this.db.select({ id: cobrancaCarteira.pessoaId }).from(cobrancaCarteira).where(eq(cobrancaCarteira.cobradorId, escopo.cobradorId!))));
        }
        const linhas = await this.db
          .select({ t: titulos, nome: pessoas.nome, telefone: pessoas.telefone1 })
          .from(titulos)
          .leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId))
          .where(and(...filtros))
          .orderBy(asc(situacao === 'pago' ? titulos.pagoEm : titulos.vencimento), desc(titulos.valor))
          .limit(5000);
        const valorDe = (x: (typeof linhas)[number]) => (situacao === 'pago' ? (x.t.valorPago ?? x.t.valor) : x.t.valor);
        const total = linhas.reduce((s, x) => s + valorDe(x), 0);
        const agrupar = e.agruparPor ?? 'dia';
        const grupos = new Map<string, { quantidade: number; total: number }>();
        if (agrupar !== 'nenhum')
          for (const x of linhas) {
            const chave = agrupar === 'dia' ? (dataBR(situacao === 'pago' ? x.t.pagoEm : x.t.vencimento) ?? '—') : agrupar === 'pessoa' ? (x.nome ?? '—') : (x.t.formaPagamento ?? 'não informada');
            const g = grupos.get(chave) ?? { quantidade: 0, total: 0 };
            g.quantidade++;
            g.total += valorDe(x);
            grupos.set(chave, g);
          }
        const limite = e.limite ?? 50;
        return {
          tipo: tipo === 'receber' ? 'a receber' : 'a pagar',
          situacao,
          periodo: de === ate ? dataBR(de) : `${dataBR(de)} a ${dataBR(ate)}`,
          quantidade: linhas.length,
          total: formatarReais(total),
          ...(agrupar !== 'nenhum' ? { [`por${agrupar[0].toUpperCase()}${agrupar.slice(1)}`]: [...grupos].map(([chave, g]) => ({ [agrupar]: chave, quantidade: g.quantidade, total: formatarReais(g.total) })).slice(0, 100) } : {}),
          parcelas: linhas.slice(0, limite).map((x) => ({ tituloId: x.t.id, pessoa: x.nome, telefone: x.telefone, descricao: x.t.descricao, valor: formatarReais(valorDe(x)), vencimento: dataBR(x.t.vencimento), pagoEm: dataBR(x.t.pagoEm), status: x.t.status, forma: x.t.formaPagamento, boletoOuPix: x.t.cobrancaUrl ?? null })),
          ...(linhas.length > limite ? { observacao: `Mostrando ${limite} de ${linhas.length}; os totais consideram todas.` } : {}),
          ...(tipo === 'receber' ? { lembrete: 'Parcelas de cartão (débito/crédito) são recebidas pela maquininha, não por boleto.' } : {}),
        };
      },
    };
  }

  /** Toda a carteira de inadimplentes que esta pessoa enxerga (até 3.000), do maior para o menor valor atualizado. */
  private async todosInadimplentes(u: UsuarioLogado, f: { faixa?: string; tipo?: string; busca?: string } = {}) {
    const escopo = await this.cobranca.escopo(u);
    const itens: Awaited<ReturnType<CobrancaService['carteira']>>['itens'] = [];
    for (let pagina = 1; pagina <= 60; pagina++) {
      const r = await this.cobranca.carteira(escopo, { faixa: f.faixa, tipo: f.tipo, busca: f.busca, pagina });
      itens.push(...r.itens);
      if (!r.temMais) break;
    }
    return itens;
  }

  /** Quanto está em cada faixa de atraso (pelo maior atraso de cada pessoa). */
  private faixas(itens: { atualizado: number; maiorAtraso: number }[]) {
    const f = [
      { faixa: '1 a 30 dias', de: 1, ate: 30 },
      { faixa: '31 a 60 dias', de: 31, ate: 60 },
      { faixa: '61 a 90 dias', de: 61, ate: 90 },
      { faixa: '91 a 180 dias', de: 91, ate: 180 },
      { faixa: 'mais de 180 dias', de: 181, ate: Infinity },
    ];
    return f.map((x) => {
      const dentro = itens.filter((i) => i.maiorAtraso >= x.de && i.maiorAtraso <= x.ate);
      return { faixa: x.faixa, pessoas: dentro.length, valorAtualizado: formatarReais(dentro.reduce((s, i) => s + Number(i.atualizado), 0)) };
    });
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

  // ───────────── Configurações (regras do consignado e da cobrança) ─────────────

  /** Campos que o assistente pode mudar, em unidades de gente (% e R$), com onde ficam guardados. */
  private static readonly CAMPOS_REGRAS: Record<'consignado' | 'cobranca', Record<string, { rotulo: string; chave: string; unidade: 'pct' | 'reais' | 'dias' | 'numero' | 'simnao' }>> = {
    consignado: {
      multa: { rotulo: 'Multa por atraso no acerto', chave: 'multaAtrasoPb', unidade: 'pct' },
      jurosMes: { rotulo: 'Juros ao mês no acerto', chave: 'jurosMesPb', unidade: 'pct' },
      carenciaDias: { rotulo: 'Carência antes de multa e juros (acerto)', chave: 'carenciaDias', unidade: 'dias' },
      comissaoAvista: { rotulo: 'Comissão da revendedora à vista', chave: 'comissaoAvistaPb', unidade: 'pct' },
      comissaoPrazo: { rotulo: 'Comissão da revendedora a prazo', chave: 'comissaoPrazoPb', unidade: 'pct' },
      prazoAcertoDias: { rotulo: 'Prazo do acerto', chave: 'prazoAcertoDias', unidade: 'dias' },
      diasParaBloquear: { rotulo: 'Dias de atraso para bloquear nova maleta (0 = só avisa)', chave: 'diasParaBloquear', unidade: 'dias' },
      limiteInicial: { rotulo: 'Limite de crédito da primeira maleta', chave: 'limiteInicial', unidade: 'reais' },
      limiteMaximo: { rotulo: 'Limite de crédito máximo', chave: 'limiteMaximo', unidade: 'reais' },
      aumentoLimite: { rotulo: 'Aumento do limite após acerto em dia com meta batida', chave: 'aumentoLimitePb', unidade: 'pct' },
      metaMinimaVendida: { rotulo: 'Mínimo vendido da maleta para contar como meta batida', chave: 'metaMinimaVendidaPb', unidade: 'pct' },
      maletasSimultaneas: { rotulo: 'Maletas abertas ao mesmo tempo', chave: 'maletasSimultaneas', unidade: 'numero' },
      parcelasMaximas: { rotulo: 'Parcelas máximas no acerto', chave: 'parcelasMaximas', unidade: 'numero' },
      perdidaPeloCusto: { rotulo: 'Peça perdida cobrada pelo custo (não = pelo preço de venda)', chave: 'perdidaPeloCusto', unidade: 'simnao' },
    },
    cobranca: {
      multa: { rotulo: 'Multa das parcelas vencidas (cobrança)', chave: 'multaPb', unidade: 'pct' },
      jurosMes: { rotulo: 'Juros ao mês das parcelas vencidas (cobrança)', chave: 'jurosMesPb', unidade: 'pct' },
      carenciaDias: { rotulo: 'Carência antes de multa e juros (cobrança)', chave: 'diasCarencia', unidade: 'dias' },
      descontoMax: { rotulo: 'Desconto máximo no acordo (quem cobra)', chave: 'descontoMaxPb', unidade: 'pct' },
      descontoMaxGestor: { rotulo: 'Desconto máximo no acordo (gestão)', chave: 'descontoMaxGestorPb', unidade: 'pct' },
      parcelasMax: { rotulo: 'Parcelas máximas no acordo', chave: 'parcelasMax', unidade: 'numero' },
      diasQuebraAcordo: { rotulo: 'Dias de atraso de parcela que quebram o acordo', chave: 'diasQuebraAcordo', unidade: 'dias' },
    },
  };

  private mostrarValor(unidade: string, v: unknown) {
    if (unidade === 'pct') return `${(Number(v) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
    if (unidade === 'reais') return formatarReais(Number(v));
    if (unidade === 'dias') return `${v} dia(s)`;
    if (unidade === 'simnao') return v ? 'sim' : 'não';
    return String(v);
  }
  private paraGuardar(unidade: string, v: number | boolean) {
    if (unidade === 'pct') return Math.round(Number(v) * 100);
    if (unidade === 'reais') return Math.round(Number(v) * 100);
    if (unidade === 'simnao') return !!v;
    return Math.round(Number(v));
  }
  private podeArea(u: UsuarioLogado, area: 'consignado' | 'cobranca') {
    return area === 'consignado' ? temPermissao(u.permissoes, 'configuracoes', 'editar') : temPermissao(u.permissoes, 'cobranca', 'excluir');
  }

  private verRegras(): Ferramenta {
    return {
      nome: 'ver_regras',
      descricao: 'Mostra as regras configuradas: do consignado (acerto da maleta: multa, juros, carência, comissões, prazo, limites de crédito, bloqueio) e da cobrança das parcelas vencidas (multa, juros, carência, descontos e parcelas do acordo). Use antes de alterar.',
      schema: z.object({}),
      risco: 'leitura',
      permitido: algum(pode('configuracoes', 'ver'), pode('cobranca', 'ver')),
      executar: async () => {
        const consignado = (await this.configuracoes.regras()) as unknown as Record<string, unknown>;
        const cobranca = (await this.cobrancaConfig.obter()) as unknown as Record<string, unknown>;
        const listar = (area: 'consignado' | 'cobranca', v: Record<string, unknown>) => Object.entries(FerramentasAssistente.CAMPOS_REGRAS[area]).map(([campo, c]) => ({ campo, rotulo: c.rotulo, valor: this.mostrarValor(c.unidade, v[c.chave]) }));
        return { consignado: listar('consignado', consignado), cobranca: listar('cobranca', cobranca), observacao: 'Multa e juros existem nos dois lugares: no acerto da maleta (consignado) e nas parcelas em cobrança.' };
      },
    };
  }

  private alterarRegras(): Ferramenta {
    const schema = z.object({
      area: z.enum(['consignado', 'cobranca']).describe('consignado = acerto da maleta; cobranca = parcelas vencidas'),
      mudancas: z
        .record(z.string(), z.union([z.number(), z.boolean()]))
        .describe('Campo → novo valor, em unidades de gente: percentuais em % (2 = 2%), valores em reais (500 = R$ 500,00), dias e quantidades em número, sim/não em true/false. Campos de ver_regras.'),
    });
    const montar = async (e: z.infer<typeof schema>) => {
      const campos = FerramentasAssistente.CAMPOS_REGRAS[e.area];
      const desconhecidos = Object.keys(e.mudancas).filter((k) => !campos[k]);
      if (desconhecidos.length) throw new BadRequestException(`Campo(s) que não existem em ${e.area}: ${desconhecidos.join(', ')}. Use: ${Object.keys(campos).join(', ')}.`);
      if (!Object.keys(e.mudancas).length) throw new BadRequestException('Diga o que mudar.');
      const atual = (e.area === 'consignado' ? await this.configuracoes.regras() : await this.cobrancaConfig.obter()) as unknown as Record<string, unknown>;
      const novo: Record<string, unknown> = { ...atual };
      const linhas: { rotulo: string; antes: string; depois: string }[] = [];
      for (const [k, v] of Object.entries(e.mudancas)) {
        const c = campos[k];
        if (c.unidade === 'simnao' ? typeof v !== 'boolean' : typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BadRequestException(`Valor inválido para ${c.rotulo}.`);
        novo[c.chave] = this.paraGuardar(c.unidade, v);
        linhas.push({ rotulo: c.rotulo, antes: this.mostrarValor(c.unidade, atual[c.chave]), depois: this.mostrarValor(c.unidade, novo[c.chave]) });
      }
      // Mesmas validações das telas de configuração.
      if (e.area === 'consignado') {
        const r = regrasSchema.safeParse(novo);
        if (!r.success) throw new BadRequestException(`Valor fora do permitido: ${r.error.issues.map((i) => i.path.join('.')).join(', ')}.`);
        if (Number(novo.limiteInicial) > Number(novo.limiteMaximo)) throw new BadRequestException('O limite inicial não pode ser maior que o máximo.');
      } else {
        if (Number(novo.multaPb) > 1000) throw new BadRequestException('A multa máxima aceita na cobrança é de 10%.');
        if (Number(novo.jurosMesPb) > 1000) throw new BadRequestException('Os juros máximos aceitos na cobrança são de 10% ao mês.');
        if (Number(novo.diasCarencia) > 60 || Number(novo.parcelasMax) < 1 || Number(novo.parcelasMax) > 60 || Number(novo.diasQuebraAcordo) < 1 || Number(novo.diasQuebraAcordo) > 120 || Number(novo.descontoMaxPb) > 10000 || Number(novo.descontoMaxGestorPb) > 10000) throw new BadRequestException('Valor fora do permitido na configuração da cobrança.');
      }
      return { atual, novo, linhas };
    };
    return {
      nome: 'alterar_regras',
      descricao: 'Altera regras do consignado (acerto da maleta) ou da cobrança (parcelas vencidas): multa, juros, carência, comissões, prazo, limites, descontos e parcelas. Se a pessoa falar de multa ou juros sem dizer onde, pergunte se é no acerto da maleta, na cobrança das parcelas ou nos dois (aí chame uma vez para cada área). Vale para os cálculos daqui em diante.',
      schema,
      risco: 'confirmar',
      permitido: algum(pode('configuracoes', 'editar'), pode('cobranca', 'excluir')),
      preparar: async (e: z.infer<typeof schema>, ctx) => {
        if (!this.podeArea(ctx.usuario, e.area)) return { resumo: '', impedimento: e.area === 'consignado' ? 'Só quem edita as Configurações muda as regras do consignado.' : 'Só a gestão da cobrança muda as regras da cobrança.' };
        try {
          const m = await montar(e);
          return { resumo: `Alterar as regras ${e.area === 'consignado' ? 'do consignado (acerto da maleta)' : 'da cobrança (parcelas vencidas)'}: ${m.linhas.map((l) => `${l.rotulo}: ${l.antes} → ${l.depois}`).join('; ')}. Vale daqui em diante.`, previa: m.linhas.map((l) => ({ nome: l.rotulo, texto: `${l.antes} → ${l.depois}` })) };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        if (!this.podeArea(ctx.usuario, e.area)) throw new BadRequestException('Sem permissão para estas regras.');
        if (e.area === 'cobranca') this.cobranca.exigirGestor(await this.cobranca.escopo(ctx.usuario));
        const m = await montar(e);
        if (e.area === 'consignado') await this.configuracoes.salvarRegras(m.novo as never);
        else await this.cobrancaConfig.salvar(m.novo as never);
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: 'editar_pelo_assistente', entidade: e.area === 'consignado' ? 'regras_consignado' : 'cobranca', dados: { mudancas: m.linhas } });
        return { alterado: true, mudancas: m.linhas };
      },
    };
  }

  // ───────────── Agentes do WhatsApp (atendimento) ─────────────

  private verAgentesWhatsapp(): Ferramenta {
    return {
      nome: 'ver_agentes_whatsapp',
      descricao: 'Mostra o agente de IA que atende no WhatsApp: se está ligado, o nome com que se apresenta, as instruções e o conhecimento gerais, e cada especialista (vendas, quero revender, revendedora…) com quando atende, instruções e conhecimento próprios.',
      schema: z.object({}),
      risco: 'leitura',
      permitido: pode('crm', 'ver'),
      executar: async () => {
        const cfg = await this.agente.config();
        const lista = await this.agente.especialistas(true);
        return {
          geral: { ligado: cfg.ativo, nome: cfg.nome, instrucoes: cfg.instrucoes, conhecimento: cfg.conhecimento.slice(0, 6000), maxRespostas: cfg.maxRespostas, maxTransferencias: cfg.maxTransferencias, numeros: cfg.canais.length ? `${cfg.canais.length} número(s)` : 'todos' },
          especialistas: lista.map((e) => ({ especialistaId: e.id, chave: e.funcao, nome: e.nome, ligado: e.ativo, atendeQuando: e.quando, instrucoes: e.instrucoes, conhecimento: e.conhecimento.slice(0, 4000), ordem: e.ordem })),
        };
      },
    };
  }

  private especialistaCampos = z.object({
    chave: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,29}$/, 'Chave só com letras minúsculas, números e _ (ex.: posvenda)').optional(),
    nome: z.string().trim().min(2).max(60).optional(),
    atendeQuando: z.string().trim().min(10).max(600).optional().describe('Assuntos que este especialista atende (a recepção usa isto para escolher)'),
    instrucoes: z.string().max(6000).optional().describe('Como atender: tom, o que perguntar, o que nunca fazer, quando passar para a equipe'),
    conhecimento: z.string().max(20000).optional().describe('Fatos que ele pode usar: preços, regras, endereços, links'),
    ordem: z.number().int().min(0).max(100).optional(),
  });

  private alterarAgentesWhatsappSchema = z.object({
    acao: z.enum(['criar', 'editar', 'duplicar', 'ligar', 'desligar', 'excluir', 'editar_geral']),
    especialistaId: uuid.optional().describe('Para editar, duplicar, ligar, desligar ou excluir um especialista'),
    especialista: this.especialistaCampos.optional().describe('criar: chave, nome, atendeQuando e instrucoes obrigatórios; editar/duplicar: só o que muda'),
    geral: z
      .object({ ligado: z.boolean().optional().describe('Liga ou desliga o atendimento automático no WhatsApp'), nome: z.string().trim().max(40).optional(), instrucoes: z.string().max(6000).optional(), conhecimento: z.string().max(20000).optional(), maxRespostas: z.number().int().min(1).max(50).optional(), maxTransferencias: z.number().int().min(0).max(5).optional() })
      .optional()
      .describe('editar_geral: configurações que valem para todos os especialistas'),
  });

  private async planoAgente(e: z.infer<FerramentasAssistente['alterarAgentesWhatsappSchema']>) {
    const lista = await this.agente.especialistas(true);
    const alvo = e.especialistaId ? lista.find((x) => x.id === e.especialistaId) : null;
    if (['editar', 'duplicar', 'ligar', 'desligar', 'excluir'].includes(e.acao) && !alvo) throw new BadRequestException('Especialista não encontrado (use ver_agentes_whatsapp para pegar o especialistaId).');
    const d = e.especialista ?? {};
    if (d.chave && lista.some((x) => x.funcao === d.chave && x.id !== (e.acao === 'editar' ? alvo?.id : undefined))) throw new BadRequestException(`Já existe um especialista com a chave "${d.chave}".`);
    if (e.acao === 'criar') {
      if (!d.chave || !d.nome || !d.atendeQuando || !d.instrucoes?.trim()) throw new BadRequestException('Para criar, preciso de chave, nome, atendeQuando e instrucoes.');
      return { resumo: `Criar o especialista "${d.nome}" (chave ${d.chave}) no agente do WhatsApp, já ligado. Atende quando: ${d.atendeQuando}`, previa: [{ nome: 'Instruções', texto: d.instrucoes }, ...(d.conhecimento ? [{ nome: 'Conhecimento', texto: d.conhecimento.slice(0, 3000) }] : [])] };
    }
    if (e.acao === 'editar') {
      const mud = Object.entries(d).filter(([, v]) => v !== undefined);
      if (!mud.length) throw new BadRequestException('Diga o que mudar.');
      return { resumo: `Alterar o especialista "${alvo!.nome}": ${mud.map(([k]) => ({ chave: 'chave', nome: 'nome', atendeQuando: 'quando atende', instrucoes: 'instruções', conhecimento: 'conhecimento', ordem: 'ordem' })[k] ?? k).join(', ')}.`, previa: mud.map(([k, v]) => ({ nome: k, texto: String(v).slice(0, 3000) })) };
    }
    if (e.acao === 'duplicar') return { resumo: `Duplicar o especialista "${alvo!.nome}" como "${d.nome ?? `${alvo!.nome} (cópia)`}"${d.chave ? ` (chave ${d.chave})` : ''}. A cópia nasce desligada${Object.keys(d).some((k) => !['nome', 'chave'].includes(k)) ? ', já com os ajustes pedidos' : ''}.` };
    if (e.acao === 'ligar' || e.acao === 'desligar') return { resumo: `${e.acao === 'ligar' ? 'Ligar' : 'Desligar'} o especialista "${alvo!.nome}".` };
    if (e.acao === 'excluir') return { resumo: `Excluir o especialista "${alvo!.nome}" (as conversas com ele voltam para a recepção). Não dá para desfazer.` };
    const g = e.geral ?? {};
    if (!Object.values(g).some((v) => v !== undefined)) throw new BadRequestException('Diga o que mudar nas configurações gerais.');
    if (g.ligado && !this.ia.texto) throw new BadRequestException('A chave do Claude não está configurada: não dá para ligar o agente.');
    return { resumo: `Alterar a configuração geral do agente do WhatsApp${g.ligado === true ? ' e LIGAR o atendimento automático (ele passa a responder clientes)' : g.ligado === false ? ' e DESLIGAR o atendimento automático' : ''}: ${Object.entries(g).filter(([, v]) => v !== undefined).map(([k]) => k).join(', ')}.`, previa: Object.entries(g).filter(([k, v]) => v !== undefined && typeof v === 'string').map(([k, v]) => ({ nome: k, texto: String(v).slice(0, 3000) })) };
  }

  private alterarAgentesWhatsapp(): Ferramenta {
    return {
      nome: 'alterar_agentes_whatsapp',
      descricao:
        'Cria, edita, duplica, liga, desliga ou exclui especialistas do agente que atende no WhatsApp, ou muda a configuração geral dele (nome, instruções, conhecimento, ligar/desligar). Para criar um agente bom, antes entreviste a pessoa: objetivo, assuntos que ele atende, tom, o que ele precisa saber, o que nunca deve fazer e quando passar para a equipe; escreva instruções completas e mostre antes.',
      schema: this.alterarAgentesWhatsappSchema,
      risco: 'confirmar',
      permitido: pode('configuracoes', 'editar'),
      preparar: async (e) => {
        try {
          return await this.planoAgente(e);
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e: z.infer<FerramentasAssistente['alterarAgentesWhatsappSchema']>, ctx) => {
        await this.planoAgente(e);
        const d = e.especialista ?? {};
        const campos = { ...(d.chave ? { funcao: d.chave } : {}), ...(d.nome ? { nome: d.nome } : {}), ...(d.atendeQuando ? { quando: d.atendeQuando } : {}), ...(d.instrucoes !== undefined ? { instrucoes: d.instrucoes } : {}), ...(d.conhecimento !== undefined ? { conhecimento: d.conhecimento } : {}), ...(d.ordem !== undefined ? { ordem: d.ordem } : {}) };
        let r: unknown;
        if (e.acao === 'criar') {
          const lista = await this.agente.especialistas(true);
          const [a] = await this.db.insert(iaAgentes).values({ funcao: d.chave!, nome: d.nome!, quando: d.atendeQuando!, instrucoes: d.instrucoes ?? '', conhecimento: d.conhecimento ?? '', ordem: d.ordem ?? lista.length + 1, ativo: true }).returning();
          r = { criado: true, especialistaId: a.id, nome: a.nome };
        } else if (e.acao === 'duplicar') {
          const [o] = await this.db.select().from(iaAgentes).where(eq(iaAgentes.id, e.especialistaId!));
          const c = await duplicarEspecialista(this.db, o, { funcao: d.chave, nome: d.nome }).catch((err: Error) => {
            throw new BadRequestException(err.message);
          });
          const ajustes = { ...campos, funcao: undefined, nome: undefined };
          if (Object.values(ajustes).some((v) => v !== undefined)) await this.db.update(iaAgentes).set({ ...Object.fromEntries(Object.entries(ajustes).filter(([, v]) => v !== undefined)), atualizadoEm: new Date() }).where(eq(iaAgentes.id, c.id));
          r = { duplicado: true, especialistaId: c.id, nome: c.nome, chave: c.funcao, ligado: false };
        } else if (e.acao === 'editar') {
          await this.db.update(iaAgentes).set({ ...campos, atualizadoEm: new Date() }).where(eq(iaAgentes.id, e.especialistaId!));
          r = { editado: true };
        } else if (e.acao === 'ligar' || e.acao === 'desligar') {
          await this.db.update(iaAgentes).set({ ativo: e.acao === 'ligar', atualizadoEm: new Date() }).where(eq(iaAgentes.id, e.especialistaId!));
          r = { ok: true, ligado: e.acao === 'ligar' };
        } else if (e.acao === 'excluir') {
          await this.db.delete(iaAgentes).where(eq(iaAgentes.id, e.especialistaId!));
          r = { excluido: true };
        } else {
          const g = e.geral ?? {};
          const atual = await this.agente.config();
          await this.agente.salvarConfig({ ...atual, ...(g.ligado !== undefined ? { ativo: g.ligado } : {}), ...(g.nome !== undefined ? { nome: g.nome } : {}), ...(g.instrucoes !== undefined ? { instrucoes: g.instrucoes } : {}), ...(g.conhecimento !== undefined ? { conhecimento: g.conhecimento } : {}), ...(g.maxRespostas !== undefined ? { maxRespostas: g.maxRespostas } : {}), ...(g.maxTransferencias !== undefined ? { maxTransferencias: g.maxTransferencias } : {}) });
          r = { alterado: true };
        }
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: `assistente_agente_${e.acao}`, entidade: 'ia_agente', entidadeId: e.especialistaId ?? null, dados: { especialista: e.especialista ? { ...e.especialista, conhecimento: undefined } : undefined, geral: e.geral ? { ...e.geral, conhecimento: undefined } : undefined } });
        return r;
      },
    };
  }

  // ───────────── E-mail e rotinas agendadas ─────────────

  private emailSchema = z.object({
    para: z.array(z.string().trim().toLowerCase().email('E-mail inválido')).min(1).max(10),
    assunto: z.string().trim().min(3).max(200),
    texto: z.string().trim().min(1).max(20000).describe('Corpo do e-mail em texto simples (pode ter quebras de linha e listas com "- ")'),
    anexo: z.enum(['inadimplentes']).optional().describe('Planilha gerada pelo sistema com a lista completa (CSV que abre no Excel)'),
    tabela: z
      .object({ nome: z.string().trim().min(1).max(60), colunas: z.array(z.string().max(60)).min(1).max(20), linhas: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(500) })
      .optional()
      .describe('Outra tabela pequena para anexar como planilha'),
    anexosDaConversa: z.array(uuid).max(5).optional().describe('Arquivos que a pessoa anexou na conversa (anexoId) para encaminhar'),
  });

  private enviarEmail(): Ferramenta {
    return {
      nome: 'enviar_email',
      descricao:
        'Envia um e-mail pelo servidor de e-mail do sistema, com anexo opcional em planilha (ex.: a lista completa de inadimplentes). Em rotina agendada, sai sem confirmação só para os e-mails autorizados na criação da rotina.',
      schema: this.emailSchema,
      risco: 'confirmar',
      permitido: pode('assistente', 'ver'),
      preparar: async (e: z.infer<FerramentasAssistente['emailSchema']>, ctx) => {
        if (e.anexo === 'inadimplentes' && !temPermissao(ctx.usuario.permissoes, 'cobranca', 'ver')) return { resumo: '', impedimento: 'Anexar a lista de inadimplentes exige acesso à Cobrança.' };
        const daConversa = e.anexosDaConversa?.length ? await this.db.select({ nome: assistenteAnexos.nome }).from(assistenteAnexos).where(and(inArray(assistenteAnexos.id, e.anexosDaConversa), eq(assistenteAnexos.usuarioId, ctx.usuario.id))) : [];
        if (daConversa.length !== (e.anexosDaConversa?.length ?? 0)) return { resumo: '', impedimento: 'Algum anexo da conversa não foi encontrado.' };
        const anexos = [e.anexo === 'inadimplentes' ? 'planilha de inadimplentes' : null, e.tabela ? `planilha "${e.tabela.nome}"` : null, ...daConversa.map((a) => `"${a.nome}"`)].filter(Boolean);
        return { resumo: `Enviar e-mail para ${e.para.join(', ')}: "${e.assunto}"${anexos.length ? `, com ${anexos.join(' e ')}` : ''}.`, previa: [{ nome: e.assunto, telefone: e.para.join(', '), texto: e.texto.slice(0, 3000) }] };
      },
      executar: async (e: z.infer<FerramentasAssistente['emailSchema']>, ctx) => {
        const anexos: { nome: string; conteudo: Buffer; mime: string }[] = [];
        const dia = hoje();
        if (e.anexo === 'inadimplentes') {
          if (!temPermissao(ctx.usuario.permissoes, 'cobranca', 'ver')) throw new BadRequestException('Anexar a lista de inadimplentes exige acesso à Cobrança.');
          const todos = await this.todosInadimplentes(ctx.usuario);
          anexos.push({
            nome: `inadimplentes-${dia}.csv`,
            mime: 'text/csv',
            conteudo: csv(
              ['Nome', 'Tipo', 'Telefone', 'Cidade', 'Parcelas vencidas', 'Valor original', 'Valor atualizado', 'Maior atraso (dias)', 'Promessa de pagamento', 'Cobrador', 'Em protesto'],
              todos.map((i) => [i.nome, i.tipo === 'representante' ? 'Revendedora' : 'Cliente', i.telefone, [i.cidade, i.uf].filter(Boolean).join('/'), i.titulos, formatarReais(Number(i.original)), formatarReais(Number(i.atualizado)), i.maiorAtraso, dataBR(i.promessa), i.cobrador, i.emProtesto > 0 ? 'sim' : '']),
            ),
          });
        }
        if (e.tabela) anexos.push({ nome: `${e.tabela.nome.replace(/[^\w\- ]+/g, '').trim() || 'planilha'}-${dia}.csv`, mime: 'text/csv', conteudo: csv(e.tabela.colunas, e.tabela.linhas) });
        if (e.anexosDaConversa?.length) {
          const linhas = await this.db.select().from(assistenteAnexos).where(and(inArray(assistenteAnexos.id, e.anexosDaConversa), eq(assistenteAnexos.usuarioId, ctx.usuario.id)));
          for (const a of linhas) {
            const caminho = this.arquivos.caminhoMidia(a.arquivo);
            if (caminho) anexos.push({ nome: a.nome, mime: a.mime, conteudo: await readFile(caminho) });
          }
        }
        if (anexos.reduce((t, a) => t + a.conteudo.length, 0) > 20_000_000) throw new BadRequestException('Os anexos passam de 20 MB: o e-mail seria recusado.');
        const r = await this.email.enviar(e.para.join(', '), e.assunto, e.texto, anexos);
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: ctx.rotina ? 'assistente_email_rotina' : 'assistente_email', entidade: 'email', entidadeId: null, dados: { para: e.para, assunto: e.assunto, anexos: anexos.map((a) => a.nome), rotinaId: ctx.rotina?.id ?? null } });
        return { enviado: true, para: e.para, anexos: anexos.map((a) => a.nome), ...((r as { simulado?: boolean }).simulado ? { aviso: 'O servidor de e-mail (SMTP) não está configurado: o envio foi só simulado. Configure em Configurações › Integrações › E-mail.' } : {}) };
      },
    };
  }

  /** Agenda pedida pelo assistente → como fica gravada. */
  private montarAgenda(e: { horario?: string; intervaloMinutos?: number; janela?: { inicio: string; fim: string }; dias?: number[] }): Agenda {
    const dias = e.dias?.length ? [...new Set(e.dias)].sort() : [0, 1, 2, 3, 4, 5, 6];
    if (e.intervaloMinutos) return { tipo: 'intervalo', horario: e.janela?.inicio?.padStart(5, '0') ?? '00:00', dias, intervaloMin: e.intervaloMinutos, janelaInicio: e.janela?.inicio?.padStart(5, '0') ?? null, janelaFim: e.janela?.fim?.padStart(5, '0') ?? null };
    if (!e.horario) throw new BadRequestException('Diga o horário (HH:MM) ou o intervalo em minutos.');
    return { tipo: 'horario', horario: e.horario.padStart(5, '0'), dias, intervaloMin: null, janelaInicio: null, janelaFim: null };
  }

  private agendaSchema = {
    horario: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Horário no formato HH:MM').optional().describe('Uma vez por dia neste horário (Brasília). Use isto OU intervaloMinutos.'),
    intervaloMinutos: z.number().int().min(15, 'O intervalo mínimo é de 15 minutos').max(10080).optional().describe('A cada quantos minutos (ex.: 60 = de hora em hora, 120 = a cada 2 h). Mínimo 15.'),
    janela: z
      .object({ inicio: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/), fim: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/) })
      .optional()
      .describe('Só com intervalo: horário do dia em que pode rodar (ex.: 08:00 às 18:00)'),
    dias: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('Dias da semana: 0 = domingo … 6 = sábado. Padrão: todos'),
  };

  private agendarRotina(): Ferramenta {
    const schema = z.object({
      titulo: z.string().trim().min(3).max(80).describe('Nome curto, ex.: "Inadimplentes por e-mail"'),
      instrucao: z.string().trim().min(20).max(4000).describe('O que fazer em CADA execução, completo e sem depender desta conversa: o que consultar, como montar e para quem enviar (com os e-mails).'),
      ...this.agendaSchema,
      emails: z.array(z.string().trim().toLowerCase().email()).max(10).optional().describe('E-mails que podem receber o que a rotina mandar, sem pedir confirmação a cada execução'),
      aprovarAutomaticamente: z.boolean().optional().describe('true = a rotina executa tudo sozinha (WhatsApp, cobrança, alterações) sem esperar confirmação. Só se a pessoa pedir.'),
    });
    const quando = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return {
      nome: 'agendar_rotina',
      descricao:
        'Cria uma rotina (agente agendado) que você executa sozinho: uma vez por dia num horário, ou a cada X minutos/horas (com janela do dia e dias da semana opcionais). Ex.: "todo dia às 8h, me mande por e-mail os inadimplentes", "de hora em hora, das 8h às 18h, veja se entrou candidata nova e me avise". Roda com as permissões de quem pediu; cada execução vira uma conversa. WhatsApp, cobranças e alterações não saem sozinhos: ficam esperando confirmação na conversa da rotina. E-mail sai sozinho só para os endereços autorizados aqui.',
      schema,
      risco: 'confirmar',
      permitido: pode('assistente', 'ver'),
      preparar: async (e: z.infer<typeof schema>, ctx) => {
        if (e.aprovarAutomaticamente && !ctx.podeAutomatico) return { resumo: '', impedimento: 'Você não pode ligar a aprovação automática (regra da empresa em Assistente › Configurar).' };
        try {
          const a = this.montarAgenda(e);
          return {
            resumo: `Criar a rotina "${e.titulo}": ${descreverAgenda(a)} (primeira: ${quando(proximaDaRotina(a))}).${e.emails?.length ? ` E-mails autorizados: ${e.emails.join(', ')}.` : ''}${e.aprovarAutomaticamente ? ' Aprovação AUTOMÁTICA: executa tudo sozinha, sem esperar confirmação.' : ' Ações que mandam mensagem, cobram ou alteram vão esperar sua confirmação.'}`,
            previa: [{ nome: 'O que vai fazer em cada execução', texto: e.instrucao }],
          };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const a = this.montarAgenda(e);
        if (e.aprovarAutomaticamente && !ctx.podeAutomatico) throw new BadRequestException('Sem permissão para aprovação automática.');
        const [r] = await this.db.insert(assistenteRotinas).values({ usuarioId: ctx.usuario.id, titulo: e.titulo, instrucao: e.instrucao, ...a, emails: e.emails ?? [], aprovacao: e.aprovarAutomaticamente ? 'automatico' : 'perguntar', proximaEm: proximaDaRotina(a) }).returning();
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: 'criar_rotina', entidade: 'assistente_rotina', entidadeId: r.id, dados: { titulo: e.titulo, agenda: descreverAgenda(a), emails: e.emails ?? [] } });
        return { criada: true, rotinaId: r.id, quando: descreverAgenda(a), primeiraExecucao: quando(r.proximaEm), observacao: 'A pessoa acompanha, duplica e pausa na aba Rotinas do Assistente.' };
      },
    };
  }

  private gerenciarRotinas(): Ferramenta {
    const schema = z.object({
      acao: z.enum(['listar', 'pausar', 'retomar', 'excluir', 'duplicar', 'editar']),
      rotinaId: uuid.optional().describe('Obrigatório exceto em listar (use listar antes)'),
      titulo: z.string().trim().min(3).max(80).optional().describe('duplicar/editar: novo título'),
      instrucao: z.string().trim().min(20).max(4000).optional().describe('duplicar/editar: nova instrução'),
      ...this.agendaSchema,
      emails: z.array(z.string().trim().toLowerCase().email()).max(10).optional(),
      aprovarAutomaticamente: z.boolean().optional().describe('editar/duplicar: liga (true) ou desliga (false) a aprovação automática da rotina'),
    });
    return {
      nome: 'gerenciar_rotinas',
      descricao: 'Lista, pausa, retoma, exclui, duplica (com ajustes opcionais: título, instrução, horário/intervalo, dias, e-mails) ou edita as rotinas agendadas de quem está falando com você. A cópia nasce pausada para revisar.',
      schema,
      risco: 'acao',
      permitido: pode('assistente', 'ver'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const fmt = (d: Date | null) => d?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? null;
        if (e.acao === 'listar') {
          const rs = await this.db.select().from(assistenteRotinas).where(eq(assistenteRotinas.usuarioId, ctx.usuario.id)).orderBy(asc(assistenteRotinas.criadoEm));
          return { rotinas: rs.map((r) => ({ rotinaId: r.id, titulo: r.titulo, quando: descreverAgenda(r), ativa: r.ativa, aprovacao: r.aprovacao === 'automatico' ? 'automática' : 'pede confirmação', proxima: r.ativa ? fmt(r.proximaEm) : null, ultima: fmt(r.ultimaEm), emails: r.emails, instrucao: r.instrucao })) };
        }
        if (!e.rotinaId) throw new BadRequestException('Diga qual rotina (rotinaId).');
        const [r] = await this.db.select().from(assistenteRotinas).where(and(eq(assistenteRotinas.id, e.rotinaId), eq(assistenteRotinas.usuarioId, ctx.usuario.id)));
        if (!r) throw new BadRequestException('Rotina não encontrada.');
        const mudouAgenda = e.horario || e.intervaloMinutos || e.janela || e.dias;
        const agenda: Agenda = mudouAgenda ? this.montarAgenda({ horario: e.horario ?? (e.intervaloMinutos ? undefined : r.horario), intervaloMinutos: e.intervaloMinutos ?? (e.horario ? undefined : (r.intervaloMin ?? undefined)), janela: e.janela ?? (r.janelaInicio && r.janelaFim ? { inicio: r.janelaInicio, fim: r.janelaFim } : undefined), dias: e.dias ?? r.dias }) : r;
        if (e.aprovarAutomaticamente && !ctx.podeAutomatico) throw new BadRequestException('Você não pode ligar a aprovação automática (regra da empresa em Assistente › Configurar).');
        const campos = { aprovacao: e.aprovarAutomaticamente === undefined ? r.aprovacao : e.aprovarAutomaticamente ? 'automatico' : 'perguntar', titulo: e.titulo ?? r.titulo, instrucao: e.instrucao ?? r.instrucao, tipo: agenda.tipo, horario: agenda.horario, intervaloMin: agenda.intervaloMin ?? null, janelaInicio: agenda.janelaInicio ?? null, janelaFim: agenda.janelaFim ?? null, dias: agenda.dias, emails: e.emails ?? r.emails };
        if (e.acao === 'duplicar') {
          const [c] = await this.db.insert(assistenteRotinas).values({ usuarioId: ctx.usuario.id, ...campos, titulo: e.titulo ?? `${r.titulo} (cópia)`, ativa: false, proximaEm: proximaDaRotina(agenda) }).returning();
          return { duplicada: true, rotinaId: c.id, titulo: c.titulo, quando: descreverAgenda(c), ativa: false, observacao: 'A cópia nasce pausada: retome quando estiver certa.' };
        }
        if (e.acao === 'editar') {
          const [c] = await this.db.update(assistenteRotinas).set({ ...campos, proximaEm: proximaDaRotina(agenda) }).where(eq(assistenteRotinas.id, r.id)).returning();
          return { editada: true, titulo: c.titulo, quando: descreverAgenda(c), proxima: fmt(c.proximaEm) };
        }
        if (e.acao === 'excluir') await this.db.delete(assistenteRotinas).where(eq(assistenteRotinas.id, r.id));
        else await this.db.update(assistenteRotinas).set({ ativa: e.acao === 'retomar', ...(e.acao === 'retomar' ? { proximaEm: proximaDaRotina(r) } : {}) }).where(eq(assistenteRotinas.id, r.id));
        return { ok: true, rotina: r.titulo, acao: e.acao };
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

