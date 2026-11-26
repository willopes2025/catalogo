import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { calcularEncargos, formatarReais, preencherTexto } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { temPermissao, type UsuarioLogado } from '../comum/auth';
import { AuditoriaService } from '../comum/auditoria.service';
import { planoContas, assistenteAnexos, assistentePedidos, assistenteRotinas, cobrancaCarteira, crmContatos, crmConversas, crmEtapas, crmLeads, crmMensagens, crmTarefas, usuarios, chamadoMensagens, iaAgentes, chamados, crmCanais, crmTemplates, empresas, maletas, pessoas, titulos, vendas } from '../db/schema';
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
import { VOZES_ELEVENLABS, VOZES_OPENAI } from '../ia/vozes';
import { ArquivosService } from '../arquivos/arquivos.service';
import { readFile } from 'node:fs/promises';
import type { DefinicaoFerramenta } from '../ia/ia.service';
import { csv, descreverAgenda, proximaDaRotina, type Agenda } from './rotinas';
import { CONJUNTOS, catalogoConjuntos, montarConsulta } from './dados';
import { AgendaService, TIPOS_COMPROMISSO } from '../agenda/agenda.service';
import { CrmService } from '../crm/crm.service';
import { FilaEnvioService, previsaoTermino } from '../crm/fila-envio.service';
import { LancamentosService } from '../financeiro/lancamentos.service';

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
  /** Ação do assistente que está executando (o envio em lote mostra o andamento no cartão dela). */
  acaoId?: string;
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

const hora = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const NOMES_DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const minutos = (s: number) => (s % 60 ? `${(s / 60).toFixed(1).replace('.', ',')}` : String(s / 60));
/** Frase do ritmo do envio em massa do número, com a previsão de término. */
export function ritmoDoNumero(c: { envioIntervaloMinS: number; envioIntervaloMaxS: number; envioInicio: string; envioFim: string; envioDias: number[]; proximoEnvioEm?: Date | null }, quantas: number) {
  const fim = previsaoTermino(c, quantas, c.proximoEnvioEm ?? null);
  const dias = c.envioDias.length === 7 ? 'todos os dias' : c.envioDias.map((d) => NOMES_DIAS[d]).join(', ');
  return `Sai uma mensagem a cada ${minutos(c.envioIntervaloMinS)} a ${minutos(c.envioIntervaloMaxS)} min, das ${c.envioInicio} às ${c.envioFim} (${dias}).${fim ? ` Previsão de término: ${hora(fim)}.` : ''}`;
}

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
    private readonly agenda: AgendaService,
    private readonly crm: CrmService,
    private readonly fila: FilaEnvioService,
    private readonly lancamentos: LancamentosService,
  ) {
    this.lista = [
      this.consultarInadimplentes(),
      this.consultarFinanceiro(),
      this.buscarPessoas(),
      this.fichaPessoa(),
      this.maletasAtrasadas(),
      this.consultarDados(),
      this.resumoNegocio(),
      this.resumoVendas(),
      this.numerosWhatsapp(),
      this.buscarConversas(),
      this.lerConversa(),
      this.amostraConversas(),
      this.enviarWhatsapp(),
      this.enviarWhatsappEmLote(),
      this.emitirSegundaVia(),
      this.registrarPromessa(),
      this.cadastrarPessoa(),
      this.lancarConta(),
      this.criarCompromisso(),
      this.criarTarefaCrm(),
      this.anotarLead(),
      this.moverLead(),
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

  private consultarDados(): Ferramenta {
    const nomes = Object.keys(CONJUNTOS) as [string, ...string[]];
    const schema = z.object({
      conjunto: z.enum(nomes),
      modo: z.enum(['resumo', 'lista']).optional().describe('resumo = métricas agrupadas (padrão); lista = linhas com detalhes (até 200)'),
      metricas: z.array(z.string()).max(6).optional().describe('Nomes das métricas do conjunto (padrão: a primeira)'),
      agruparPor: z.array(z.string()).max(2).optional().describe('Até 2 dimensões do conjunto'),
      filtros: z.array(z.object({ campo: z.string().describe('Uma dimensão do conjunto'), operador: z.enum(['igual', 'contem', 'diferente']), valor: z.string().max(120) })).max(6).optional(),
      de: dataIso.optional().describe('Início do período (quando o conjunto tem período)'),
      ate: dataIso.optional(),
      ordenarPor: z.string().optional().describe('Métrica, dimensão ou coluna'),
      ordem: z.enum(['asc', 'desc']).optional(),
      limite: z.number().int().min(1).max(200).optional(),
    });
    return {
      nome: 'consultar_dados',
      descricao: `Consulta flexível em qualquer área do sistema: escolha o conjunto, as métricas, até 2 dimensões para agrupar, filtros e período (ex.: produtos mais vendidos do mês por loja; estoque abaixo do mínimo; maletas por nível; candidatas por origem; leads perdidos por motivo; comissões do mês). Os valores em R$ já vêm formatados. Conjuntos:\n${catalogoConjuntos(nomes)}`,
      schema,
      risco: 'leitura',
      permitido: (u) => nomes.some((n) => CONJUNTOS[n].permissoes.some(([m, a]) => temPermissao(u.permissoes, m, a))),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const c = CONJUNTOS[e.conjunto];
        if (!c.permissoes.some(([m, a]) => temPermissao(ctx.usuario.permissoes, m, a))) throw new BadRequestException(`Sem acesso a "${e.conjunto}" (precisa de: ${c.permissoes.map(([m]) => m).join(' ou ')}).`);
        let montada: ReturnType<typeof montarConsulta>;
        try {
          montada = montarConsulta({ conjunto: e.conjunto, modo: e.modo ?? 'resumo', metricas: e.metricas ?? [], agruparPor: e.agruparPor ?? [], filtros: e.filtros ?? [], de: e.de, ate: e.ate, ordenarPor: e.ordenarPor, ordem: e.ordem ?? 'desc', limite: e.limite ?? 50 });
        } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
        // Só leitura, com tempo máximo: uma consulta pesada não trava o sistema.
        const linhas = await this.db.transaction(async (tx) => {
          await tx.execute(sql`set transaction read only`);
          await tx.execute(sql`set local statement_timeout = 8000`);
          return (await tx.execute(montada.consulta)).rows as Record<string, unknown>[];
        });
        const fmt = (k: string, v: unknown) => {
          if (v == null) return null;
          const t = montada.tipos[k];
          if (t === 'reais') return formatarReais(Number(v));
          if (t === 'pct') return `${(Number(v) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
          if (t === 'data') return new Date(String(v)).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', ...(String(v).length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}) });
          return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
        };
        return {
          conjunto: e.conjunto,
          ...(e.de || e.ate ? { periodo: `${dataBR(e.de ?? null) ?? 'início'} a ${dataBR(e.ate ?? null) ?? 'hoje'}` } : {}),
          linhas: linhas.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, fmt(k, v)]))),
          ...(linhas.length === (e.limite ?? 50) ? { observacao: 'Chegou no limite de linhas: pode haver mais (aumente o limite ou filtre).' } : {}),
        };
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

  // ───────────── Conversas do WhatsApp (CRM) ─────────────

  /** Números que esta pessoa enxerga no CRM (gestão vê todos). */
  private async canaisVisiveis(u: UsuarioLogado) {
    return (await this.canais.canaisDoUsuario(u.id, temPermissao(u.permissoes, 'crm', 'excluir'))).map((c) => ({ id: c.id, nome: c.nome }));
  }

  /** Mensagem em uma linha para a IA ler: quem falou e o quê (áudio vira a transcrição). */
  private linhaMensagem(m: { direcao: string; tipo: string; texto: string | null; transcricao: string | null; ia: boolean; apagadaEm: Date | null; templateNome: string | null; midiaNome: string | null }, atendente?: string | null) {
    const quem = m.direcao === 'entrada' ? 'Cliente' : m.direcao === 'interna' ? 'Nota interna' : m.ia ? 'IA' : atendente ? `Equipe (${atendente})` : 'Equipe';
    if (m.apagadaEm) return `${quem}: [apagada]`;
    const conteudo = m.tipo === 'audio' ? (m.transcricao ? `[áudio] ${m.transcricao}` : '[áudio sem transcrição]') : m.tipo === 'texto' || m.tipo === 'template' ? (m.texto ?? '') : `[${m.tipo}${m.midiaNome ? `: ${m.midiaNome}` : ''}]${m.texto ? ` ${m.texto}` : ''}`;
    return `${quem}: ${m.templateNome ? `[modelo ${m.templateNome}] ` : ''}${conteudo}`.slice(0, 1500);
  }

  private buscarConversas(): Ferramenta {
    const schema = z.object({
      busca: z.string().trim().max(80).optional().describe('Nome, telefone ou trecho da última mensagem'),
      status: z.enum(['fila', 'atendimento', 'resolvida']).optional().describe('fila = esperando alguém; atendimento = com alguém da equipe; resolvida'),
      canalId: uuid.optional(),
      de: dataIso.optional().describe('Última mensagem a partir deste dia'),
      ate: dataIso.optional(),
      limite: z.number().int().min(1).max(100).optional(),
    });
    return {
      nome: 'buscar_conversas',
      descricao: 'Procura conversas do WhatsApp no CRM (por contato, telefone, texto, situação, número e período) e devolve a última mensagem, quem atende e se a IA está atendendo. Use o conversaId em ler_conversa.',
      schema,
      risco: 'leitura',
      permitido: pode('crm', 'ver'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const canais = await this.canaisVisiveis(ctx.usuario);
        if (!canais.length) return { conversas: [], observacao: 'Você não atende por nenhum número de WhatsApp.' };
        const filtros = [inArray(crmConversas.canalId, e.canalId ? canais.filter((c) => c.id === e.canalId).map((c) => c.id).concat(['00000000-0000-0000-0000-000000000000']) : canais.map((c) => c.id))];
        if (e.status) filtros.push(eq(crmConversas.status, e.status));
        if (e.de) filtros.push(sql`(${crmConversas.ultimaMensagemEm} at time zone 'America/Sao_Paulo')::date >= ${e.de}`);
        if (e.ate) filtros.push(sql`(${crmConversas.ultimaMensagemEm} at time zone 'America/Sao_Paulo')::date <= ${e.ate}`);
        if (e.busca) {
          const b = `%${e.busca}%`;
          const dig = e.busca.replace(/\D/g, '');
          filtros.push(or(sql`${crmContatos.nome} ilike ${b}`, sql`${crmConversas.ultimaMensagem} ilike ${b}`, ...(dig.length >= 4 ? [sql`${crmContatos.telefone} like ${'%' + dig + '%'}`] : []))!);
        }
        const r = await this.db
          .select({ conversaId: crmConversas.id, contato: crmContatos.nome, telefone: crmContatos.telefone, canalId: crmConversas.canalId, status: crmConversas.status, ultimaMensagem: crmConversas.ultimaMensagem, ultimaMensagemEm: crmConversas.ultimaMensagemEm, naoLidas: crmConversas.naoLidas, atendente: usuarios.nome, iaAtiva: crmConversas.iaAtiva, especialista: iaAgentes.nome })
          .from(crmConversas)
          .innerJoin(crmContatos, eq(crmContatos.id, crmConversas.contatoId))
          .leftJoin(usuarios, eq(usuarios.id, crmConversas.atendenteId))
          .leftJoin(iaAgentes, eq(iaAgentes.id, crmConversas.iaAgenteId))
          .where(and(...filtros))
          .orderBy(desc(crmConversas.ultimaMensagemEm))
          .limit(e.limite ?? 30);
        const nomeCanal = new Map(canais.map((c) => [c.id, c.nome]));
        return { quantidade: r.length, conversas: r.map((c) => ({ ...c, canal: nomeCanal.get(c.canalId), canalId: undefined, ultimaMensagemEm: c.ultimaMensagemEm?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? null })) };
      },
    };
  }

  private lerConversa(): Ferramenta {
    const schema = z.object({ conversaId: uuid, limite: z.number().int().min(1).max(200).optional().describe('Últimas N mensagens (padrão 60)') });
    return {
      nome: 'ler_conversa',
      descricao: 'Lê as mensagens de uma conversa do WhatsApp (cliente, equipe, IA e notas internas), com a transcrição dos áudios, em ordem.',
      schema,
      risco: 'leitura',
      permitido: pode('crm', 'ver'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const canais = await this.canaisVisiveis(ctx.usuario);
        const [cv] = await this.db.select({ id: crmConversas.id, canalId: crmConversas.canalId, status: crmConversas.status, contato: crmContatos.nome, telefone: crmContatos.telefone }).from(crmConversas).innerJoin(crmContatos, eq(crmContatos.id, crmConversas.contatoId)).where(eq(crmConversas.id, e.conversaId));
        if (!cv || !canais.some((c) => c.id === cv.canalId)) throw new BadRequestException('Conversa não encontrada (ou é de um número que você não atende).');
        const ms = (await this.db.select({ m: crmMensagens, atendente: usuarios.nome }).from(crmMensagens).leftJoin(usuarios, eq(usuarios.id, crmMensagens.usuarioId)).where(eq(crmMensagens.conversaId, cv.id)).orderBy(desc(crmMensagens.criadoEm)).limit(e.limite ?? 60)).reverse();
        return {
          contato: cv.contato,
          telefone: cv.telefone,
          status: cv.status,
          mensagens: ms.map(({ m, atendente }) => `${m.criadoEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${this.linhaMensagem(m, atendente)}`),
        };
      },
    };
  }

  private amostraConversas(): Ferramenta {
    const schema = z.object({
      de: dataIso.optional().describe('Início do período (padrão: 30 dias atrás)'),
      ate: dataIso.optional().describe('Fim do período (padrão: hoje)'),
      canalId: uuid.optional(),
      quantidade: z.number().int().min(5).max(200).optional().describe('Quantas conversas na amostra (padrão 80)'),
      mensagensPorConversa: z.number().int().min(1).max(10).optional().describe('Quantas mensagens do cliente de cada conversa (padrão 4)'),
    });
    return {
      nome: 'amostra_conversas',
      descricao:
        'Para ANALISAR o atendimento no WhatsApp: pega as conversas do período (as mais recentes primeiro) e devolve, de cada uma, as primeiras mensagens do cliente (com transcrição de áudio), quem atendeu (IA, especialista ou equipe) e a situação, além dos totais por número, situação e especialista. Use para descobrir o que mais perguntam, dúvidas repetidas, gargalos e que especialistas criar.',
      schema,
      risco: 'leitura',
      permitido: pode('crm', 'ver'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const canais = await this.canaisVisiveis(ctx.usuario);
        if (!canais.length) return { observacao: 'Você não atende por nenhum número de WhatsApp.' };
        const h = hoje();
        const de = e.de ?? new Date(Date.parse(`${h}T12:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
        const ate = e.ate ?? h;
        const ids = e.canalId ? canais.filter((c) => c.id === e.canalId).map((c) => c.id) : canais.map((c) => c.id);
        if (!ids.length) throw new BadRequestException('Você não atende por este número.');
        const noPeriodo = and(inArray(crmConversas.canalId, ids), sql`(${crmConversas.ultimaMensagemEm} at time zone 'America/Sao_Paulo')::date between ${de} and ${ate}`);
        const totais = await this.db.select({ canalId: crmConversas.canalId, status: crmConversas.status, especialista: iaAgentes.nome, qtd: sql<number>`count(*)::int` }).from(crmConversas).leftJoin(iaAgentes, eq(iaAgentes.id, crmConversas.iaAgenteId)).where(noPeriodo).groupBy(crmConversas.canalId, crmConversas.status, iaAgentes.nome);
        const somar = (f: (t: (typeof totais)[number]) => string) => Object.entries(totais.reduce<Record<string, number>>((acc, t) => ({ ...acc, [f(t)]: (acc[f(t)] ?? 0) + t.qtd }), {})).map(([k, v]) => ({ [k]: v }));
        const nomeCanal = new Map(canais.map((c) => [c.id, c.nome]));
        const conversas = await this.db.select({ id: crmConversas.id, status: crmConversas.status, especialista: iaAgentes.nome, contato: crmContatos.nome }).from(crmConversas).innerJoin(crmContatos, eq(crmContatos.id, crmConversas.contatoId)).leftJoin(iaAgentes, eq(iaAgentes.id, crmConversas.iaAgenteId)).where(noPeriodo).orderBy(desc(crmConversas.ultimaMensagemEm)).limit(e.quantidade ?? 80);
        const porConversa = e.mensagensPorConversa ?? 4;
        const msgs = conversas.length
          ? await this.db.execute<{ conversa_id: string; direcao: string; tipo: string; texto: string | null; transcricao: string | null; ia: boolean; respondida: boolean }>(sql`
              select conversa_id, direcao, tipo, texto, transcricao, ia, respondida from (
                select m.conversa_id, m.direcao, m.tipo, m.texto, m.transcricao, m.ia,
                  exists (select 1 from crm_mensagens r where r.conversa_id = m.conversa_id and r.direcao = 'saida' and r.criado_em > m.criado_em) as respondida,
                  row_number() over (partition by m.conversa_id order by m.criado_em) as n
                from crm_mensagens m
                where m.conversa_id in (${sql.join(conversas.map((c) => sql`${c.id}`), sql`, `)}) and m.direcao = 'entrada' and m.apagada_em is null
                  and (m.criado_em at time zone 'America/Sao_Paulo')::date between ${de} and ${ate}
              ) x where n <= ${porConversa}`).then((r) => r.rows)
          : [];
        const agrupadas = new Map<string, string[]>();
        const semResposta = new Set<string>();
        for (const m of msgs) {
          const t = m.tipo === 'audio' ? (m.transcricao ? `[áudio] ${m.transcricao}` : '[áudio sem transcrição]') : m.tipo === 'texto' ? (m.texto ?? '') : `[${m.tipo}]${m.texto ? ` ${m.texto}` : ''}`;
          agrupadas.set(m.conversa_id, [...(agrupadas.get(m.conversa_id) ?? []), t.slice(0, 400)]);
          if (!m.respondida) semResposta.add(m.conversa_id);
        }
        return {
          periodo: `${dataBR(de)} a ${dataBR(ate)}`,
          totalDeConversas: totais.reduce((s, t) => s + t.qtd, 0),
          porNumero: somar((t) => nomeCanal.get(t.canalId) ?? '—'),
          porSituacao: somar((t) => t.status),
          porEspecialista: somar((t) => t.especialista ?? 'sem especialista'),
          conversasSemResposta: semResposta.size,
          amostra: conversas.filter((c) => agrupadas.has(c.id)).map((c) => ({ conversaId: c.id, contato: c.contato, situacao: c.status, especialista: c.especialista, cliente: agrupadas.get(c.id), semResposta: semResposta.has(c.id) || undefined })),
          observacao: 'Nomes e telefones são de clientes: use só para a análise, sem expor em relatórios.',
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

  /** Números por onde a pessoa pode enviar (para o cartão de confirmação deixar escolher). */
  async numerosDe(u: UsuarioLogado) {
    const lista = (await this.canais.canaisDoUsuario(u.id, temPermissao(u.permissoes, 'crm', 'excluir'))).filter((c) => !c.excluidoEm);
    return lista.map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo, numero: c.numero }));
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
      canalId: uuid.optional().describe('Número de envio (padrão: o primeiro por QR code; a pessoa pode trocar no cartão antes de confirmar)'),
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
          // Guarda o número escolhido na ação: o cartão mostra e deixa trocar antes de confirmar.
          e.canalId = r.canal.id;
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
        'Envia a mesma mensagem (com as variáveis preenchidas por pessoa) para várias pessoas pelo WhatsApp. Entra na fila de envio do número: sai uma mensagem por vez, com o intervalo e o horário configurados no número (para não ser bloqueado); dá para pausar, retomar e cancelar na tela. Ex.: cobrança de inadimplentes, aviso de acerto, campanha para revendedoras.',
      schema: this.loteSchema,
      risco: 'confirmar',
      segundoPlano: true,
      permitido: pode('crm', 'criar'),
      preparar: async (e, ctx) => {
        try {
          const l = await this.montarLote(e, ctx);
          e.canalId = l.canal.id;
          const validos = l.itens.filter((i) => !i.problema).length;
          if (!validos) return { resumo: '', impedimento: 'Nenhuma das pessoas tem telefone válido (ou estão fora da carteira de quem pediu).' };
          return {
            resumo: `Enviar para ${validos} pessoa(s) pelo número "${l.canal.nome}"${l.tpl ? ` com o template "${l.tpl.nome}"` : ''}. ${ritmoDoNumero(l.canal, validos)}${l.itens.length - validos ? ` ${l.itens.length - validos} ficam de fora (veja o motivo na lista).` : ''}${l.faltando ? ` ${l.faltando} id(s) não encontrado(s).` : ''}`,
            previa: l.itens,
          };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e, ctx) => {
        const l = await this.montarLote(e, ctx);
        const validos = l.itens.filter((i) => !i.problema);
        if (!validos.length) throw new BadRequestException('Nenhuma das pessoas tem telefone válido.');
        const lote = await this.fila.criarLote({
          canalId: l.canal.id,
          origem: 'assistente',
          titulo: `Envio pelo assistente (${validos.length} pessoa(s))`,
          criadoPor: ctx.usuario.id,
          acaoId: ctx.acaoId ?? null,
          itens: validos.map((i) => ({ pessoaId: i.pessoaId, nome: i.nome, telefone: i.telefone!, texto: i.texto, templateId: l.tpl?.id ?? null, dados: { registrarCobranca: e.registrarNaCobranca !== false && l.dividas.has(i.pessoaId), usuarioId: ctx.usuario.id } })),
        });
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: 'assistente_whatsapp_lote', entidade: 'envio_lote', entidadeId: lote.id, dados: { canalId: l.canal.id, pessoas: validos.length } });
        const foraDaLista = l.itens.filter((i) => i.problema).map((i) => ({ nome: i.nome, erro: i.problema! }));
        return { fila: lote.id, naFila: validos.length, ritmo: ritmoDoNumero(l.canal, validos.length), foraDaLista };
      },
    };
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

  // ───────────── Cadastro e contas a pagar/receber ─────────────

  private cadastrarPessoa(): Ferramenta {
    const schema = z.object({
      tipo: z.enum(['fornecedor', 'cliente']).describe('fornecedor = fornecedor ou prestador de serviço (quem a empresa paga); cliente = quem compra'),
      nome: z.string().trim().min(2).max(150),
      documento: z.string().max(20).optional().describe('CPF ou CNPJ, se tiver'),
      telefone: z.string().max(30).optional(),
      email: z.string().email().optional(),
      observacao: z.string().max(500).optional().describe('Ex.: que serviço presta'),
    });
    return {
      nome: 'cadastrar_pessoa',
      descricao: 'Cadastra um fornecedor/prestador de serviço (para lançar contas a pagar) ou um cliente. Antes, use buscar_pessoas para não duplicar. Revendedora se cadastra pela tela de Rede, não por aqui.',
      schema,
      risco: 'confirmar',
      permitido: pode('cadastros', 'criar'),
      preparar: async (e: z.infer<typeof schema>) => {
        const doc = e.documento?.replace(/\D/g, '') || null;
        if (doc && doc.length !== 11 && doc.length !== 14) return { resumo: '', impedimento: 'CPF precisa de 11 números e CNPJ de 14.' };
        const [dup] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(and(eq(pessoas.tipo, e.tipo), doc ? eq(pessoas.documento, doc) : sql`lower(${pessoas.nome}) = lower(${e.nome})`)).limit(1);
        if (dup) return { resumo: '', impedimento: `Já existe ${e.tipo === 'fornecedor' ? 'o fornecedor' : 'o cliente'} "${dup.nome}" cadastrado. Use esse cadastro.` };
        return { resumo: `Cadastrar ${e.tipo === 'fornecedor' ? 'o fornecedor/prestador' : 'o cliente'} "${e.nome}"${doc ? ` (${doc.length === 14 ? 'CNPJ' : 'CPF'} ${doc})` : ''}${e.telefone ? `, telefone ${e.telefone}` : ''}.` };
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const doc = e.documento?.replace(/\D/g, '') || null;
        const [p] = await this.db.insert(pessoas).values({ tipo: e.tipo, nome: e.nome, documento: doc, telefone1: e.telefone ?? null, email: e.email ?? null, observacao: e.observacao ?? null }).returning({ id: pessoas.id, nome: pessoas.nome });
        await this.auditoria.registrar({ usuarioId: ctx.usuario.id, acao: 'criar', entidade: 'pessoa', entidadeId: p.id, dados: { tipo: e.tipo, origem: 'assistente' } });
        return { pessoaId: p.id, nome: p.nome, tipo: e.tipo };
      },
    };
  }

  /** Acha a conta do plano de contas pelo nome (só as que recebem lançamento). */
  private async contaDoPlano(nome: string | undefined, tipo: 'pagar' | 'receber') {
    const todas = await this.db.select({ id: planoContas.id, nome: planoContas.nome, grupo: planoContas.grupo, paiId: planoContas.paiId, calculada: planoContas.calculada }).from(planoContas).where(eq(planoContas.ativo, true));
    const lancaveis = todas.filter((c) => c.paiId && !c.calculada && (tipo === 'receber' ? c.grupo === 'receita' || c.grupo === 'outras' || c.grupo === 'financeiro' : c.grupo !== 'receita'));
    if (!nome?.trim()) return { conta: null, opcoes: lancaveis.map((c) => c.nome) };
    const n = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const exata = lancaveis.filter((c) => n(c.nome) === n(nome));
    const parecidas = exata.length ? exata : lancaveis.filter((c) => n(c.nome).includes(n(nome)) || n(nome).includes(n(c.nome)));
    return { conta: parecidas.length === 1 ? parecidas[0] : null, opcoes: (parecidas.length ? parecidas : lancaveis).map((c) => c.nome) };
  }

  private lancarConta(): Ferramenta {
    const schema = z.object({
      tipo: z.enum(['pagar', 'receber']).describe('pagar = despesa (contas a pagar); receber = receita'),
      descricao: z.string().trim().min(2).max(150).describe('Ex.: "Serviço da Lara (limpeza)"'),
      valor: z.number().positive().describe('Valor em reais (de cada mês, se repetir)'),
      vencimento: dataIso.describe('Primeiro vencimento'),
      pessoaId: uuid.optional().describe('Fornecedor/prestador (pagar) ou cliente (receber), de buscar_pessoas ou cadastrar_pessoa'),
      contaPlano: z.string().max(120).optional().describe('Nome da conta do plano de contas (ex.: "Serviços de terceiros", "Aluguel"). Se não souber, deixe vazio que a ferramenta devolve as opções'),
      repetirMeses: z.number().int().min(2).max(36).optional().describe('Conta fixa: repete o mesmo valor todo mês, por quantos meses (ex.: 12)'),
      parcelas: z.number().int().min(2).max(48).optional().describe('Divide o valor em parcelas mensais (não use junto com repetirMeses)'),
      empresa: z.string().max(80).optional().describe('Nome ou CNPJ da empresa, se houver mais de uma (padrão: a matriz)'),
    });
    const resolver = async (e: z.infer<typeof schema>) => {
      if (e.repetirMeses && e.parcelas) return { impedimento: 'Escolha repetir todo mês ou parcelar, não os dois.' } as const;
      const emps = await this.db.select({ id: empresas.id, nome: empresas.nome, cnpj: empresas.cnpj, tipo: empresas.tipo }).from(empresas);
      const emp = e.empresa ? emps.find((x) => x.nome.toLowerCase().includes(e.empresa!.toLowerCase()) || (x.cnpj ?? '').replace(/\D/g, '') === e.empresa!.replace(/\D/g, '')) : (emps.find((x) => x.tipo === 'matriz') ?? emps[0]);
      if (!emp) return { impedimento: `Não achei a empresa "${e.empresa}". Empresas: ${emps.map((x) => x.nome).join(', ')}.` } as const;
      const { conta, opcoes } = await this.contaDoPlano(e.contaPlano, e.tipo);
      if (e.contaPlano && !conta) return { impedimento: `Não achei uma única conta do plano com "${e.contaPlano}". Opções: ${opcoes.slice(0, 40).join('; ')}. Pergunte qual usar.` } as const;
      let pessoa: { nome: string } | undefined;
      if (e.pessoaId) {
        [pessoa] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, e.pessoaId));
        if (!pessoa) return { impedimento: 'Cadastro (pessoaId) não encontrado.' } as const;
      }
      return { emp, conta, pessoa } as const;
    };
    return {
      nome: 'lancar_conta',
      descricao: 'Lança conta a pagar (despesa) ou a receber no Financeiro: avulsa, parcelada ou fixa todo mês (repetirMeses). Para pagar a alguém, ligue ao fornecedor/prestador (buscar_pessoas; se não existir, cadastrar_pessoa antes). Informe a conta do plano de contas para a DRE.',
      schema,
      risco: 'confirmar',
      permitido: pode('financeiro', 'criar'),
      preparar: async (e: z.infer<typeof schema>) => {
        const r = await resolver(e);
        if ('impedimento' in r) return { resumo: '', impedimento: r.impedimento };
        const v = Math.round(e.valor * 100);
        const quando = e.repetirMeses ? `${formatarReais(v)} por mês, todo dia ${Number(e.vencimento.slice(8))}, por ${e.repetirMeses} meses a partir de ${dataBR(e.vencimento)}` : e.parcelas ? `${formatarReais(v)} em ${e.parcelas} parcelas mensais a partir de ${dataBR(e.vencimento)}` : `${formatarReais(v)}, vencimento ${dataBR(e.vencimento)}`;
        return { resumo: `Lançar conta a ${e.tipo === 'pagar' ? 'pagar' : 'receber'} "${e.descricao}"${r.pessoa ? ` de ${r.pessoa.nome}` : ''}: ${quando}. Empresa ${r.emp.nome}${r.conta ? `, conta do plano "${r.conta.nome}"` : ', sem conta do plano (fica para classificar)'}.` };
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const r = await resolver(e);
        if ('impedimento' in r) throw new BadRequestException(r.impedimento);
        const criados = await this.lancamentos.lancar({ empresaId: r.emp.id, tipo: e.tipo, pessoaId: e.pessoaId ?? null, descricao: e.descricao, planoContaId: r.conta?.id ?? null, valor: Math.round(e.valor * 100), vencimento: e.vencimento, parcelas: e.parcelas ?? 1, repetirMeses: e.repetirMeses ?? null }, ctx.usuario.id);
        return { lancados: criados.length, primeiroVencimento: dataBR(criados[0].vencimento), ultimoVencimento: dataBR(criados.at(-1)!.vencimento), valorCada: formatarReais(criados[0].valor) };
      },
    };
  }

  // ───────────── Agenda e CRM ─────────────

  private quandoBrasilia(t: string) {
    const d = new Date(`${t.length === 16 ? `${t}:00` : t}-03:00`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Data e hora no formato AAAA-MM-DDTHH:MM (horário de Brasília).');
    return d;
  }

  private criarCompromisso(): Ferramenta {
    const schema = z.object({
      tipo: z.enum(Object.keys(TIPOS_COMPROMISSO) as [string, ...string[]]).describe(Object.entries(TIPOS_COMPROMISSO).map(([k, v]) => `${k} = ${v.nome}`).join('; ')),
      inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('AAAA-MM-DDTHH:MM, horário de Brasília'),
      duracaoMin: z.number().int().min(10).max(600).optional(),
      titulo: z.string().max(150).optional(),
      online: z.boolean().optional().describe('Com link do Meet (se o Google estiver conectado)'),
      local: z.string().max(200).optional(),
      pessoaId: uuid.optional().describe('Revendedora ou cliente cadastrada'),
      leadId: uuid.optional().describe('Card do CRM'),
      convidadoNome: z.string().max(120).optional(),
      convidadoTelefone: z.string().max(30).optional(),
      observacao: z.string().max(1000).optional(),
      avisar: z.boolean().optional().describe('Avisa a pessoa pelo WhatsApp (marcação e lembretes)'),
      responsavelId: uuid.optional().describe('Padrão: quem pediu'),
    });
    return {
      nome: 'criar_compromisso',
      descricao: 'Marca um compromisso na agenda (entrevista de candidata, acerto por vídeo, retirada de maleta, reunião), com lembretes e, se pedir, aviso pelo WhatsApp para a pessoa.',
      schema,
      risco: 'confirmar',
      permitido: pode('agenda', 'criar'),
      preparar: async (e: z.infer<typeof schema>) => {
        try {
          const ini = this.quandoBrasilia(e.inicio);
          const t = TIPOS_COMPROMISSO[e.tipo as keyof typeof TIPOS_COMPROMISSO];
          return { resumo: `Marcar "${e.titulo ?? t.nome}" em ${ini.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (${e.duracaoMin ?? t.duracao} min, ${(e.online ?? t.online) ? 'online' : (e.local ?? 'presencial')})${e.avisar ? ', avisando a pessoa pelo WhatsApp' : ''}.` };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const t = TIPOS_COMPROMISSO[e.tipo as keyof typeof TIPOS_COMPROMISSO];
        const c = await this.agenda.criar({ tipo: e.tipo as keyof typeof TIPOS_COMPROMISSO, titulo: e.titulo ?? null, inicio: this.quandoBrasilia(e.inicio), duracaoMin: e.duracaoMin ?? t.duracao, online: e.online ?? t.online, local: e.local ?? null, pessoaId: e.pessoaId ?? null, leadId: e.leadId ?? null, convidadoNome: e.convidadoNome ?? null, convidadoTelefone: e.convidadoTelefone ?? null, observacao: e.observacao ?? null, avisar: !!e.avisar, responsavelId: e.responsavelId ?? ctx.usuario.id }, ctx.usuario.id);
        return { marcado: true, compromissoId: c.id, titulo: c.titulo, link: c.link ?? null, avisos: (c as { avisos?: string[] }).avisos ?? [] };
      },
    };
  }

  private async leadVisivel(leadId: string) {
    const [l] = await this.db.select({ id: crmLeads.id, funilId: crmLeads.funilId, titulo: crmLeads.titulo }).from(crmLeads).where(eq(crmLeads.id, leadId));
    if (!l) throw new BadRequestException('Card do CRM não encontrado (use consultar_dados com o conjunto crm_leads em modo lista para achar o leadId).');
    return l;
  }

  private criarTarefaCrm(): Ferramenta {
    const schema = z.object({ leadId: uuid, titulo: z.string().trim().min(2).max(200), venceEm: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('AAAA-MM-DDTHH:MM, Brasília'), responsavelId: uuid.optional() });
    return {
      nome: 'criar_tarefa_crm',
      descricao: 'Cria uma tarefa num card do CRM (ex.: "ligar para a candidata amanhã às 10h"). Aparece no painel de tarefas do responsável.',
      schema,
      risco: 'acao',
      permitido: pode('crm', 'editar'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const l = await this.leadVisivel(e.leadId);
        const [t] = await this.db.insert(crmTarefas).values({ leadId: l.id, titulo: e.titulo, venceEm: this.quandoBrasilia(e.venceEm), responsavelId: e.responsavelId ?? ctx.usuario.id, criadoPor: ctx.usuario.id }).returning();
        await this.crm.evento(l.id, 'tarefa', `Tarefa (pelo assistente): ${e.titulo}.`, ctx.usuario.id);
        return { criada: true, tarefaId: t.id, card: l.titulo };
      },
    };
  }

  private anotarLead(): Ferramenta {
    const schema = z.object({ leadId: uuid, texto: z.string().trim().min(2).max(2000) });
    return {
      nome: 'anotar_lead',
      descricao: 'Escreve uma anotação no histórico de um card do CRM.',
      schema,
      risco: 'acao',
      permitido: pode('crm', 'editar'),
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const l = await this.leadVisivel(e.leadId);
        await this.crm.evento(l.id, 'nota', e.texto, ctx.usuario.id);
        return { anotado: true, card: l.titulo };
      },
    };
  }

  private moverLead(): Ferramenta {
    const schema = z.object({ leadId: uuid, etapa: z.string().trim().min(2).max(80).describe('Nome da etapa de destino, no mesmo funil'), motivo: z.string().max(300).optional().describe('Obrigatório ao mover para uma etapa de perdido') });
    const resolver = async (e: z.infer<typeof schema>) => {
      const l = await this.leadVisivel(e.leadId);
      const etapas = await this.db.select().from(crmEtapas).where(eq(crmEtapas.funilId, l.funilId)).orderBy(asc(crmEtapas.ordem));
      const alvo = etapas.find((x) => x.nome.toLowerCase() === e.etapa.toLowerCase()) ?? etapas.find((x) => x.nome.toLowerCase().includes(e.etapa.toLowerCase()));
      if (!alvo) throw new BadRequestException(`Etapa "${e.etapa}" não existe neste funil. Etapas: ${etapas.map((x) => x.nome).join(', ')}.`);
      if (alvo.tipo === 'perdido' && !e.motivo) throw new BadRequestException('Para mover para perdido, diga o motivo.');
      return { l, alvo };
    };
    return {
      nome: 'mover_lead',
      descricao: 'Move um card do CRM para outra etapa do mesmo funil (ex.: candidata para "Entrevista", lead para "Perdido" com motivo). Pode disparar os gatilhos automáticos da etapa (mensagens, tarefas).',
      schema,
      risco: 'confirmar',
      permitido: pode('crm', 'editar'),
      preparar: async (e: z.infer<typeof schema>) => {
        try {
          const r = await resolver(e);
          return { resumo: `Mover o card "${r.l.titulo}" para a etapa "${r.alvo.nome}"${e.motivo ? ` (motivo: ${e.motivo})` : ''}. Os gatilhos dessa etapa, se houver, rodam.` };
        } catch (err) {
          return { resumo: '', impedimento: (err as Error).message };
        }
      },
      executar: async (e: z.infer<typeof schema>, ctx) => {
        const r = await resolver(e);
        await this.crm.moverLead(r.l.id, r.alvo.id, { usuarioId: ctx.usuario.id, motivo: e.motivo ?? null, origem: 'assistente' });
        return { movido: true, card: r.l.titulo, etapa: r.alvo.nome };
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
          geral: {
            ligado: cfg.ativo,
            nome: cfg.nome,
            instrucoes: cfg.instrucoes,
            conhecimento: cfg.conhecimento.slice(0, 6000),
            maxRespostas: cfg.maxRespostas,
            maxTransferencias: cfg.maxTransferencias,
            numeros: cfg.canais.length ? `${cfg.canais.length} número(s)` : 'todos',
            respostaEmAudio: { nunca: 'nunca (só texto)', espelhar: 'quando o cliente manda áudio', sempre: 'sempre' }[cfg.respostaAudio],
            voz: cfg.vozProvedor === 'openai' ? `OpenAI · ${VOZES_OPENAI.find((v) => v.id === cfg.vozOpenai)?.nome ?? cfg.vozOpenai}` : `${cfg.vozProvedor === 'elevenlabs' ? 'ElevenLabs' : 'automática (ElevenLabs se tiver a chave)'} · ${VOZES_ELEVENLABS.find((v) => v.id === cfg.vozElevenlabs)?.nome ?? cfg.vozElevenlabs}`,
            textoJuntoComAudio: cfg.audioComTexto,
            vozesDisponiveis: { elevenlabs: this.ia.temElevenlabs ? VOZES_ELEVENLABS : 'sem chave da ElevenLabs', openai: this.ia.imagem ? VOZES_OPENAI : 'sem chave da OpenAI' },
          },
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
      .object({
        ligado: z.boolean().optional().describe('Liga ou desliga o atendimento automático no WhatsApp'),
        nome: z.string().trim().max(40).optional(),
        instrucoes: z.string().max(6000).optional(),
        conhecimento: z.string().max(20000).optional(),
        maxRespostas: z.number().int().min(1).max(50).optional(),
        maxTransferencias: z.number().int().min(0).max(5).optional(),
        respostaAudio: z.enum(['nunca', 'espelhar', 'sempre']).optional().describe('Responder em áudio de WhatsApp: nunca, espelhar (só quando o cliente manda áudio) ou sempre'),
        vozProvedor: z.enum(['automatica', 'elevenlabs', 'openai']).optional(),
        voz: z.string().trim().max(40).optional().describe('Id da voz (lista em ver_agentes_whatsapp: ElevenLabs ou OpenAI)'),
        audioComTexto: z.boolean().optional().describe('Mandar o texto também, depois do áudio'),
      })
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
    if (g.respostaAudio && g.respostaAudio !== 'nunca' && !this.ia.vozDisponivel) throw new BadRequestException('Para responder em áudio, falta a chave da ElevenLabs ou da OpenAI (Configurações › Integrações).');
    if (g.voz && !/^[A-Za-z0-9]{2,40}$/.test(g.voz)) throw new BadRequestException('Id de voz inválido.');
    const audio = g.respostaAudio ? ` Resposta em áudio: ${{ nunca: 'nunca', espelhar: 'quando o cliente manda áudio', sempre: 'sempre' }[g.respostaAudio]}${g.voz ? `, voz ${[...VOZES_ELEVENLABS, ...VOZES_OPENAI].find((v) => v.id === g.voz)?.nome ?? g.voz}` : ''}.` : g.voz ? ` Voz: ${[...VOZES_ELEVENLABS, ...VOZES_OPENAI].find((v) => v.id === g.voz)?.nome ?? g.voz}.` : '';
    return { resumo: `Alterar a configuração geral do agente do WhatsApp${g.ligado === true ? ' e LIGAR o atendimento automático (ele passa a responder clientes)' : g.ligado === false ? ' e DESLIGAR o atendimento automático' : ''}: ${Object.entries(g).filter(([, v]) => v !== undefined).map(([k]) => k).join(', ')}.${audio}`, previa: Object.entries(g).filter(([k, v]) => v !== undefined && typeof v === 'string').map(([k, v]) => ({ nome: k, texto: String(v).slice(0, 3000) })) };
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
          // Voz da OpenAI tem nome curto (ash, coral…); qualquer outro id é da ElevenLabs.
          const vozCampo = g.voz ? (VOZES_OPENAI.some((v) => v.id === g.voz) ? { vozOpenai: g.voz } : { vozElevenlabs: g.voz }) : {};
          await this.agente.salvarConfig({ ...atual, ...vozCampo, ...(g.respostaAudio ? { respostaAudio: g.respostaAudio } : {}), ...(g.vozProvedor ? { vozProvedor: g.vozProvedor } : {}), ...(g.audioComTexto !== undefined ? { audioComTexto: g.audioComTexto } : {}), ...(g.ligado !== undefined ? { ativo: g.ligado } : {}), ...(g.nome !== undefined ? { nome: g.nome } : {}), ...(g.instrucoes !== undefined ? { instrucoes: g.instrucoes } : {}), ...(g.conhecimento !== undefined ? { conhecimento: g.conhecimento } : {}), ...(g.maxRespostas !== undefined ? { maxRespostas: g.maxRespostas } : {}), ...(g.maxTransferencias !== undefined ? { maxTransferencias: g.maxTransferencias } : {}) });
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

