import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { gerarSlug, somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { SegredosService } from '../segredos/segredos.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { cnpjValido, cpfValido, soDigitos } from '../comum/documentos';
import { proximoCodigoInterno } from '../comum/codigos';
import { acertos, categorias, empresas, importacoes, jueriHistorico, jueriHistoricoItens, locaisEstoque, maletaItens, maletas, movimentos, niveis, pessoas, produtos, referencias, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ativo, centavos, primeiroCampo, extrairLista, umRegistro, contaEmAberto, dataISO, estrutura, inteiro, pb, pedidoAberto, pegar, qtdEmAberto, txt, type Reg } from './mapear';
import { PlanoContasService } from '../financeiro/plano.service';

export const ETAPAS = ['cadastros', 'produtos', 'pessoas', 'maletas', 'financeiro', 'historico', 'fotos'] as const;
export type Etapa = (typeof ETAPAS)[number];

export interface OpcoesJueri {
  simular: boolean;
  etapas: Etapa[];
  /** Local onde fica o estoque que está na empresa (não nas maletas). */
  localId: string;
  atualizarEstoque: boolean;
  /** Comissão dada às pessoas que no Jueri são "Representante" (pontos-base). */
  comissaoRepresentantePb: number;
}

interface Parte {
  lidos: number;
  criados: number;
  atualizados: number;
  ignorados: number;
  /** Total real de registros com problema (a lista de erros é cortada em 300). */
  falhas: number;
  /** Quantos problemas de cada tipo, para ver o quadro geral de uma vez. */
  motivos: Record<string, number>;
  erros: string[];
  avisos: string[];
}

export interface Execucao {
  id: string;
  simular: boolean;
  etapas: Etapa[];
  inicio: string;
  fim: string | null;
  situacao: 'rodando' | 'concluida' | 'falhou' | 'cancelada';
  /** Pedido de cancelamento feito na tela. */
  cancelando: boolean;
  /** A gravação dos dados já terminou (só as fotos ficam depois disso). */
  gravado: boolean;
  fase: string;
  erro: string | null;
  partes: Record<string, Parte>;
  /** Nomes dos campos que o Jueri devolveu (sem valores), para conferir o mapeamento. */
  estruturas: Record<string, string[]>;
}

class Simulacao extends Error {}
class Cancelada extends Error {}
const MAX_ERROS = 300;

const ESTADO_CIVIL: Record<string, string> = { '1': 'Solteira(o)', '2': 'Casada(o)', '3': 'Divorciada(o)', '4': 'Viúva(o)' };
const GENERO: Record<string, string> = { '1': 'Masculino', '2': 'Feminino' };

/**
 * Migração pela API do Jueri: baixa os cadastros, produtos, maletas abertas e contas a receber
 * e grava tudo numa transação só. No modo "simular" nada é gravado: só o relatório.
 * Pode ser repetida: o que já veio do Jueri é atualizado, nunca duplicado.
 */
@Injectable()
export class JueriService {
  private readonly log = new Logger('Jueri');
  private atual: Execucao | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly segredos: SegredosService,
    private readonly estoque: EstoqueService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
    private readonly arquivos: ArquivosService,
    private readonly plano: PlanoContasService,
  ) {}

  get configurado() {
    return !!(this.segredos.v('JUERI_TOKEN') && this.segredos.v('JUERI_CLIENTE_ID'));
  }

  situacao() {
    return this.atual;
  }

  // ───────────── API do Jueri ─────────────

  private async get<T = unknown>(caminho: string, params: Record<string, string | number> = {}): Promise<T> {
    const base = (process.env.JUERI_URL ?? 'https://jueri.com.br/sis').replace(/\/$/, '');
    const cliente = encodeURIComponent(this.segredos.v('JUERI_CLIENTE_ID') ?? '');
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${base}/api/v1/${cliente}/${caminho}${qs ? `?${qs}` : ''}`;
    for (let tentativa = 0; ; tentativa++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${this.segredos.v('JUERI_TOKEN')}`, accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        if (tentativa < 4) {
          await espera(2000 * 2 ** tentativa);
          continue;
        }
        throw new Error(`Não foi possível falar com o Jueri (${(e as Error).message}).`);
      }
      if ((res.status === 429 || res.status >= 500) && tentativa < 6) {
        const depois = Number(res.headers.get('retry-after'));
        await espera(Number.isFinite(depois) && depois > 0 ? depois * 1000 : 2000 * 2 ** Math.min(tentativa, 4));
        continue;
      }
      if (res.status === 401) throw new Error('O Jueri recusou o token. Gere um novo em Jueri › Configurações › API e salve em Integrações.');
      if (!res.ok) throw new Error(`O Jueri respondeu ${res.status} em ${caminho}.`);
      return (await res.json()) as T;
    }
  }

  /** Lista paginada inteira. */
  private async todos(caminho: string, params: Record<string, string | number> = {}): Promise<Reg[]> {
    const out: Reg[] = [];
    for (let pagina = 1; pagina < 5000; pagina++) {
      const j = await this.get<unknown>(caminho, { ...params, page: pagina, per_page: 100 });
      const { itens, proxima } = extrairLista(j);
      out.push(...itens);
      this.checar();
      if (this.atual) this.atual.fase = `Baixando ${caminho} do Jueri… ${out.length}`;
      if (!proxima || !itens.length) break;
    }
    return out;
  }

  /** Completa registros que vieram resumidos na listagem. */
  private async detalhar(caminho: string, regs: Reg[], campoObrigatorio: string): Promise<Reg[]> {
    if (!regs.length || regs.every((r) => pegar(r, campoObrigatorio) !== undefined)) return regs;
    const out: Reg[] = [];
    for (const [i, r] of regs.entries()) {
      this.checar();
      if (this.atual) this.atual.fase = `Baixando detalhes de ${caminho}… ${i + 1}/${regs.length}`;
      out.push(pegar(r, campoObrigatorio) !== undefined ? r : umRegistro(await this.get<unknown>(`${caminho}/${r.id}`)));
    }
    return out;
  }

  async testar() {
    if (!this.configurado) throw new BadRequestException('Preencha o ID do cliente e o token do Jueri.');
    try {
      const cats = await this.todos('produto/categoria');
      const revs = await this.get<Reg>('revendedor', { per_page: 1 });
      const total = (revs?.totals as Reg | undefined)?.total ?? (revs?.total as number | undefined) ?? '?';
      return { ok: true, mensagem: `Conectado ao Jueri: ${cats.length} categoria(s) e ${total} revendedor(es).` };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // ───────────── Execução ─────────────

  iniciar(op: OpcoesJueri, usuarioId: string) {
    if (!this.configurado) throw new BadRequestException('Configure o Jueri em Configurações › Integrações antes de importar.');
    if (this.atual?.situacao === 'rodando') throw new BadRequestException('Já há uma importação do Jueri em andamento.');
    const ex: Execucao = { id: randomBytes(6).toString('hex'), simular: op.simular, etapas: op.etapas, inicio: new Date().toISOString(), fim: null, situacao: 'rodando', cancelando: false, gravado: false, fase: 'Começando…', erro: null, partes: {}, estruturas: {} };
    this.atual = ex;
    void this.rodar(ex, op, usuarioId)
      .then(() => {
        ex.situacao = 'concluida';
        ex.fase = op.simular ? 'Simulação concluída: nada foi gravado.' : 'Importação concluída.';
      })
      .catch((e) => {
        if (e instanceof Cancelada) {
          ex.situacao = 'cancelada';
          ex.fase = ex.gravado
            ? 'Cancelada durante as fotos. Os dados já estavam gravados; as fotos que faltaram vêm na próxima importação.'
            : 'Cancelada. Nada desta execução foi gravado.';
          return;
        }
        ex.situacao = 'falhou';
        ex.erro = (e as Error).message;
        ex.fase = ex.gravado ? 'Parou com erro nas fotos. Os dados já estavam gravados.' : 'Parou com erro. Nada desta execução foi gravado.';
        this.log.error(`Importação do Jueri falhou: ${(e as Error).message}`);
      })
      .finally(() => {
        ex.fim = new Date().toISOString();
      });
    return ex;
  }

  cancelar() {
    if (this.atual?.situacao !== 'rodando') throw new BadRequestException('Não há importação do Jueri em andamento.');
    this.atual.cancelando = true;
    this.atual.fase = 'Cancelando…';
    return this.atual;
  }

  /** Para no próximo ponto seguro se pediram para cancelar. */
  private checar() {
    if (this.atual?.cancelando) throw new Cancelada();
  }

  private parte(ex: Execucao, nome: string): Parte {
    return (ex.partes[nome] ??= { lidos: 0, criados: 0, atualizados: 0, ignorados: 0, falhas: 0, motivos: {}, erros: [], avisos: [] });
  }

  private async rodar(ex: Execucao, op: OpcoesJueri, usuarioId: string) {
    const quer = (e: Etapa) => op.etapas.includes(e);
    // 1) Baixa tudo antes de abrir a transação: a gravação fica curta e não depende da internet.
    const dados: Record<string, Reg[]> = {};
    if (quer('cadastros')) {
      ex.fase = 'Baixando categorias, fornecedores e níveis…';
      dados.categorias = await this.todos('produto/categoria');
      dados.fornecedores = await this.detalhar('fornecedor', await this.todos('fornecedor'), 'cnpj');
      dados.niveis = await this.todos('revendedor/nivel');
    }
    if (quer('produtos') || quer('fotos')) {
      dados.produtos = await this.detalhar('produto', await this.todos('produto'), 'descricao');
      ex.estruturas.produto = estrutura(dados.produtos);
    }
    if (quer('pessoas')) {
      dados.revendedores = await this.detalhar('revendedor', await this.todos('revendedor'), 'nome');
      dados.representantes = await this.todos('representante');
      dados.clientes = await this.todos('cliente');
      ex.estruturas.revendedor = estrutura(dados.revendedores);
      ex.estruturas.representante = estrutura(dados.representantes);
    }
    if (quer('maletas')) {
      const lista = (await this.todos('pedido', { status: 1 })).filter(pedidoAberto);
      dados.pedidos = [];
      for (const [i, p] of lista.entries()) {
        this.checar();
        ex.fase = `Baixando maletas abertas… ${i + 1}/${lista.length}`;
        const itensLista = extrairLista(p.itens).itens;
        dados.pedidos.push(itensLista.length && itensLista.every((it) => Object.keys(it).length > 2) ? p : umRegistro(await this.get<unknown>(`pedido/${p.id}`)));
      }
      ex.estruturas.pedido = estrutura(dados.pedidos);
      ex.estruturas.pedidoItem = estrutura(dados.pedidos.flatMap((p) => extrairLista(p.itens).itens), 10);
    }
    if (quer('financeiro')) {
      const todas = await this.todos('financeiro/contas_receber');
      ex.estruturas.contaReceber = estrutura(todas, 10);
      dados.contas = todas.filter(contaEmAberto);
      dados.contasTotal = [{ n: todas.length }];
    }

    if (quer('historico')) {
      const lista = await this.todos('pedido', { status: 2 });
      dados.historico = [];
      for (const [i, p] of lista.entries()) {
        this.checar();
        ex.fase = `Baixando acertos antigos (histórico)… ${i + 1}/${lista.length}`;
        const itensLista = extrairLista(p.itens).itens;
        dados.historico.push(itensLista.length && itensLista.every((it) => Object.keys(it).length > 2) ? p : umRegistro(await this.get<unknown>(`pedido/${p.id}`)));
      }
      ex.estruturas.pedidoBaixado = estrutura(dados.historico);
      ex.estruturas.pedidoBaixadoItem = estrutura(dados.historico.flatMap((p) => extrairLista(p.itens).itens), 10);
    }

    // 2) Grava (ou simula) numa transação só.
    ex.fase = op.simular ? 'Simulando a gravação…' : 'Gravando…';
    try {
      await this.db.transaction(async (tx) => {
        const [local] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, op.localId));
        if (!local || local.tipo === 'maleta') throw new Error('Escolha um local de estoque válido (loja ou estoque central).');
        if (quer('cadastros')) await rotular('Cadastros', () => this.gravarCadastros(tx, ex, dados));
        if (quer('produtos')) await rotular('Produtos', () => this.gravarProdutos(tx, ex, dados.produtos, op, usuarioId));
        if (quer('pessoas')) await rotular('Pessoas', () => this.gravarPessoas(tx, ex, dados, op));
        if (quer('maletas')) await rotular('Maletas', () => this.gravarMaletas(tx, ex, dados.pedidos, local, usuarioId));
        if (quer('financeiro')) await rotular('Contas a receber', () => this.gravarContas(tx, ex, dados.contas, Number(dados.contasTotal?.[0]?.n ?? 0)));
        if (quer('historico')) await rotular('Histórico', () => this.gravarHistorico(tx, ex, dados.historico));
        // As maletas novas continuam a numeração depois do maior pedido do Jueri.
        if (quer('maletas') || quer('historico')) {
          const numeros = [...(dados.pedidos ?? []), ...(dados.historico ?? [])].map((p) => String(pegar(p, 'codigo_pedido') ?? '').trim()).filter((n) => /^\d{1,9}$/.test(n)).map(Number);
          await this.ajustarNumeracao(tx, numeros.length ? Math.max(...numeros) : 0);
        }
        this.checar();
        if (op.simular) throw new Simulacao();
      });
    } catch (e) {
      if (!(e instanceof Simulacao)) throw e;
    }
    if (!op.simular) ex.gravado = true;
    if (!op.simular) {
      const soma = Object.values(ex.partes).reduce((a, p) => ({ l: a.l + p.lidos, c: a.c + p.criados, u: a.u + p.atualizados }), { l: 0, c: 0, u: 0 });
      const erros = Object.entries(ex.partes).flatMap(([n, p]) => p.erros.map((m) => ({ linha: 0, mensagem: `${n}: ${m}` })));
      const [imp] = await this.db.insert(importacoes).values({ tipo: 'jueri:api', arquivo: op.etapas.join(', '), linhas: soma.l, criados: soma.c, atualizados: soma.u, erros: erros.slice(0, 500), usuarioId }).returning();
      await this.auditoria.registrar({ usuarioId, acao: 'importar', entidade: 'importacao', entidadeId: imp.id, dados: { origem: 'jueri', etapas: op.etapas, criados: soma.c, atualizados: soma.u, erros: erros.length } });
    }
    if (quer('fotos')) await rotular('Fotos', () => this.fotos(ex, dados.produtos ?? [], op.simular));
  }

  // ───────────── Histórico (só relatório) ─────────────

  /**
   * Acertos já baixados no Jueri viram histórico de vendas para os relatórios.
   * Não cria maleta, acerto, movimento de estoque nem conta: só números por acerto e por produto.
   */
  /** Próximo número de maleta = maior número entre as maletas e os pedidos do Jueri, mais um. */
  private async ajustarNumeracao(tx: Tx, maiorPedidoJueri = 0) {
    await tx.execute(sql`
      with x as (select greatest(
        (select coalesce(max(numero), 0) from maletas),
        (select coalesce(max(numero::bigint), 0) from jueri_historico where numero ~ '^[0-9]{1,9}$'),
        ${maiorPedidoJueri}::bigint,
        (select last_value from maletas_numero_seq where is_called)) as maior)
      select setval(pg_get_serial_sequence('maletas', 'numero'), greatest(maior, 1), maior > 0) from x`);
  }

  private async gravarHistorico(tx: Tx, ex: Execucao, pedidos: Reg[] = []) {
    const ph = this.parte(ex, 'Histórico de acertos');
    const revs = await this.mapa(tx, pessoas, 'rev:');
    const reps = await this.mapa(tx, pessoas, 'rep:');
    const prods = await this.mapa(tx, produtos, 'prod:');
    // Só as que tiveram acerto AQUI; maleta encerrada porque o acerto foi feito no Jueri continua valendo pelo histórico.
    const naPlataforma = new Set((await tx.select({ idJueri: maletas.idJueri }).from(maletas).where(sql`${maletas.idJueri} is not null and exists (select 1 from ${acertos} a where a.maleta_id = ${maletas.id})`)).map((m) => m.idJueri!));
    let vendido = 0;
    let semPessoa = 0;
    let menor: string | null = null;
    let maior: string | null = null;
    for (const ped of pedidos) {
      this.checar();
      ph.lidos++;
      const numero = txt(pegar(ped, 'codigo_pedido', 'id'));
      try {
        // Maleta que veio aberta e foi acertada aqui já conta pelos acertos da plataforma: no histórico seria venda em dobro.
        if (naPlataforma.has(`ped:${ped.id}`)) {
          ph.ignorados++;
          continue;
        }
        const data = dataISO(pegar(ped, 'data_baixa', 'data_acerto', 'data_fechamento', 'data_retorno', 'data_devolucao', 'updated_at', 'data_pedido', 'data', 'created_at'));
        if (!data) throw new Error('sem data');
        const revJ = ped.fk_revendedor_id != null ? String(ped.fk_revendedor_id) : null;
        const repJ = ped.fk_representante_id != null ? String(ped.fk_representante_id) : null;
        const pessoaId = (revJ ? revs.get(revJ) : undefined) ?? (repJ ? reps.get(repJ) : undefined) ?? null;
        if (!pessoaId) semPessoa++;
        const itens: (typeof jueriHistoricoItens.$inferInsert)[] = [];
        const t = { enviadas: 0, vendidas: 0, devolvidas: 0, perdidas: 0, valorEnviado: 0, valorVendido: 0 };
        for (const it of extrairLista(ped.itens).itens) {
          const enviadas = inteiro(pegar(it, 'quantidade', 'quantidade_enviada', 'qtd')) ?? 0;
          const vendidas = inteiro(pegar(it, 'quantidade_vendida')) ?? 0;
          const devolvidas = inteiro(pegar(it, 'quantidade_devolvida')) ?? 0;
          const perdidas = inteiro(pegar(it, 'quantidade_perdida')) ?? 0;
          const preco = centavos(pegar(it, 'valor_unitario', 'preco', 'valor', 'preco_unitario'));
          const idProdJ = txt(pegar(it, 'fk_produto_id', 'produto_id', 'produto.id'));
          t.enviadas += enviadas;
          t.vendidas += vendidas;
          t.devolvidas += devolvidas;
          t.perdidas += perdidas;
          t.valorEnviado += enviadas * (preco ?? 0);
          t.valorVendido += vendidas * (preco ?? 0);
          itens.push({ historicoId: '', produtoId: idProdJ ? (prods.get(idProdJ) ?? null) : null, produtoJueri: idProdJ, enviadas, vendidas, devolvidas, precoUnitario: preco });
        }
        // Sem itens detalhados: usa o total do próprio pedido, se vier.
        if (!itens.length) t.valorVendido = centavos(pegar(ped, 'valor_vendido', 'total_vendido', 'valor_venda', 'total_venda')) ?? 0;
        const valores = {
          idJueri: `ped:${ped.id}`,
          pessoaId,
          revendedorJueri: revJ ?? (repJ ? `rep:${repJ}` : null),
          numero,
          data,
          pecasEnviadas: t.enviadas,
          pecasVendidas: t.vendidas,
          pecasDevolvidas: t.devolvidas,
          pecasPerdidas: t.perdidas,
          valorEnviado: t.valorEnviado,
          valorVendido: t.valorVendido,
          comissao: centavos(pegar(ped, 'valor_comissao', 'comissao', 'total_comissao')),
        };
        const [ja] = await tx.select({ id: jueriHistorico.id }).from(jueriHistorico).where(eq(jueriHistorico.idJueri, valores.idJueri));
        let hid: string;
        if (ja) {
          await tx.update(jueriHistorico).set(valores).where(eq(jueriHistorico.id, ja.id));
          await tx.delete(jueriHistoricoItens).where(eq(jueriHistoricoItens.historicoId, ja.id));
          hid = ja.id;
          ph.atualizados++;
        } else {
          [{ id: hid }] = await tx.insert(jueriHistorico).values(valores).returning({ id: jueriHistorico.id });
          ph.criados++;
        }
        for (let i = 0; i < itens.length; i += 500) await tx.insert(jueriHistoricoItens).values(itens.slice(i, i + 500).map((x) => ({ ...x, historicoId: hid })));
        vendido += t.valorVendido;
        if (!menor || data < menor) menor = data;
        if (!maior || data > maior) maior = data;
      } catch (e) {
        this.erro(ph, `Pedido ${numero ?? ped.id}`, (e as Error).message);
      }
    }
    if (ph.lidos) ph.avisos.push(`Histórico de ${menor ?? '?'} a ${maior ?? '?'}: ${(vendido / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} vendidos pela rede. Só entra nos relatórios; estoque, maletas e financeiro não mudam.`);
    if (ph.ignorados && naPlataforma.size) {
      ph.avisos.push(`${ph.ignorados} acerto(s) de maletas que vieram abertas e foram acertadas na plataforma ficaram fora do histórico, para não contar a venda duas vezes.`);
      // Se algum já tinha entrado numa importação anterior, sai agora.
      await tx.delete(jueriHistorico).where(inArray(jueriHistorico.idJueri, [...naPlataforma]));
    }
    if (semPessoa) ph.avisos.push(`${semPessoa} acerto(s) de revendedora que não veio na importação (excluída no Jueri?): entram no total da rede, sem nome.`);
  }

  /**
   * Conferência rápida antes de importar o histórico: pede poucas linhas ao Jueri e mostra
   * quantos acertos e contas antigas existem e os NOMES dos campos (nunca os valores).
   */
  async verificarHistorico() {
    if (!this.configurado) throw new BadRequestException('Configure o Jueri em Configurações › Integrações.');
    try {
      const total = (j: unknown) => {
        const o = (j ?? {}) as Reg;
        const n = (o.totals as Reg | undefined)?.total ?? o.total ?? (o.meta as Reg | undefined)?.total ?? ((o.data as Reg | undefined)?.total as unknown);
        return typeof n === 'number' || (typeof n === 'string' && /^\d+$/.test(n)) ? Number(n) : null;
      };
      const r = await this.get<unknown>('pedido', { status: 2, per_page: 5, page: 1 });
      let amostra = extrairLista(r).itens;
      if (amostra.length && !extrairLista(amostra[0].itens).itens.length) amostra = [umRegistro(await this.get<unknown>(`pedido/${amostra[0].id}`)), ...amostra.slice(1)];
      const datas = amostra.map((p) => dataISO(pegar(p, 'data_baixa', 'data_acerto', 'data_fechamento', 'data_retorno', 'data_devolucao', 'updated_at', 'data_pedido', 'data', 'created_at'))).filter((x): x is string => !!x).sort();
      const itens = amostra.flatMap((p) => extrairLista(p.itens).itens);
      const contas = await this.get<unknown>('financeiro/contas_receber', { per_page: 20, page: 1 });
      const amostraContas = extrairLista(contas).itens;
      const camposItem = estrutura(itens, 10);
      return {
        acertosBaixados: total(r) ?? (amostra.length ? `${amostra.length}+` : 0),
        camposDoAcerto: estrutura(amostra),
        camposDoItem: camposItem,
        datasDaAmostra: datas,
        temQuantidadeVendida: camposItem.includes('quantidade_vendida'),
        temPreco: camposItem.some((c) => ['valor_unitario', 'preco', 'valor', 'preco_unitario'].includes(c)),
        contasReceber: total(contas),
        contasPagasNaAmostra: amostraContas.filter((c) => !contaEmAberto(c)).length,
        amostraContas: amostraContas.length,
      };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Maleta trazida do Jueri que ninguém usou aqui: sem acerto, sem pré-baixa e sem movimento além da migração. */
  private async intocada(tx: Tx, maletaId: string) {
    const [m] = await tx.select({ prebaixa: maletas.prebaixaEm }).from(maletas).where(eq(maletas.id, maletaId));
    if (m?.prebaixa) return false;
    const [a] = await tx.select({ n: sql<number>`count(*)::int` }).from(acertos).where(eq(acertos.maletaId, maletaId));
    if (a.n > 0) return false;
    const [mv] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(movimentos)
      .where(and(eq(movimentos.referenciaId, maletaId), sql`coalesce(${movimentos.motivo}, '') not in ('Migração do Jueri', 'Atualização pelo Jueri')`));
    return mv.n === 0;
  }

  /** Deixa as peças da maleta iguais às do pedido no Jueri. Devolve se algo mudou. */
  private async sincronizarItens(tx: Tx, maletaId: string, localId: string, desejado: Map<string, { qtd: number; preco: number | null; custo: number | null }>, usuarioId: string) {
    const atuais = await tx.select().from(maletaItens).where(eq(maletaItens.maletaId, maletaId));
    const porProduto = new Map(atuais.map((i) => [i.produtoId, i]));
    let mudou = false;
    for (const id of new Set([...porProduto.keys(), ...desejado.keys()])) {
      const atual = porProduto.get(id);
      const quer = desejado.get(id);
      const dif = (quer?.qtd ?? 0) - (atual?.enviada ?? 0);
      if (dif === 0) continue;
      mudou = true;
      const mov = { produtoId: id, quantidade: Math.abs(dif), motivo: 'Atualização pelo Jueri', referenciaTipo: 'maleta', referenciaId: maletaId, usuarioId };
      if (dif > 0) await this.estoque.mover(tx, { ...mov, origemId: null, destinoId: localId, tipo: 'maleta_envio' });
      else await this.estoque.mover(tx, { ...mov, origemId: localId, destinoId: null, tipo: 'ajuste' });
      if (!atual) {
        const [prod] = await tx.select({ preco: produtos.preco, custo: produtos.custo }).from(produtos).where(eq(produtos.id, id));
        await tx.insert(maletaItens).values({ maletaId, produtoId: id, preco: quer!.preco && quer!.preco > 0 ? quer!.preco : prod.preco, custo: quer!.custo && quer!.custo > 0 ? quer!.custo : prod.custo, enviada: quer!.qtd });
      } else if (!quer) await tx.delete(maletaItens).where(eq(maletaItens.id, atual.id));
      else await tx.update(maletaItens).set({ enviada: quer.qtd }).where(eq(maletaItens.id, atual.id));
    }
    return mudou;
  }

  private niveisCache: Map<string, string> | null = null;
  /** Nível pelo nome (o Jueri manda o nível da revendedora por nome); cria se não existir. */
  private async nivelPorNome(tx: Tx, nome: string | null): Promise<string | null> {
    if (!nome) return null;
    this.niveisCache ??= new Map((await tx.select().from(niveis)).map((n) => [n.nome.toLowerCase(), n.id]));
    const ja = this.niveisCache.get(nome.toLowerCase());
    if (ja) return ja;
    const [{ ordem }] = await tx.select({ ordem: sql<number>`coalesce(max(${niveis.ordem}), 0) + 1` }).from(niveis);
    const [n] = await tx.insert(niveis).values({ nome, ordem }).returning();
    this.niveisCache.set(nome.toLowerCase(), n.id);
    return n.id;
  }

  /**
   * Fotos dos produtos: baixa cada imagem do Jueri e guarda no servidor (os links do Jueri
   * deixam de funcionar quando a conta for encerrada). Roda depois da gravação, fora da transação.
   */
  private async fotos(ex: Execucao, lista: Reg[], simular: boolean) {
    const pf = this.parte(ex, 'Fotos');
    const comFoto = lista.map((r) => ({ r, urls: urlsDeFoto(r) })).filter((x) => x.urls.length);
    const total = comFoto.reduce((a, x) => a + x.urls.length, 0);
    const exemplo = comFoto[0]?.urls[0];
    const soPadrao = lista.length - comFoto.length;
    if (soPadrao) pf.avisos.push(`${soPadrao} produto(s) sem foto no Jueri (ou só com a imagem padrão "sem foto", que não é baixada).`);
    pf.avisos.push(`${comFoto.length} produto(s) com foto no Jueri, ${total} foto(s) ao todo.${exemplo ? ` Endereço de exemplo: ${exemplo}` : ''}`);
    const naoEntendidas = lista.filter((r) => {
      if (urlsDeFoto(r).length) return false;
      const img = typeof r.imagem === 'string' ? r.imagem.trim() : '';
      return (img && !IMAGEM_PADRAO.test(img)) || (Array.isArray(r.fotos_adicionais) && r.fotos_adicionais.some((f) => typeof f !== 'string' || !IMAGEM_PADRAO.test(f)));
    });
    if (naoEntendidas.length) pf.avisos.push(`${naoEntendidas.length} produto(s) com foto num formato não reconhecido. Exemplo: ${JSON.stringify(naoEntendidas[0].imagem ?? naoEntendidas[0].fotos_adicionais).slice(0, 150)}`);
    if (simular) {
      pf.lidos = comFoto.length;
      pf.avisos.push('Na simulação as fotos não são baixadas; na importação de verdade elas ficam guardadas no servidor.');
      return;
    }
    const prods = await this.mapa(this.db as unknown as Tx, produtos, 'prod:');
    let feitos = 0;
    const fila = [...comFoto];
    // A mesma foto pode servir a vários produtos: baixa uma vez só, mesmo com downloads em paralelo.
    const baixando = new Map<string, Promise<string>>();
    const trabalhar = async () => {
      for (let x = fila.shift(); x && !ex.cancelando; x = fila.shift()) {
        pf.lidos++;
        ex.fase = `Baixando fotos… ${++feitos}/${comFoto.length} produto(s)`;
        const produtoId = prods.get(String(x.r.id));
        if (!produtoId) {
          this.erro(pf, `Produto ${x.r.id}`, 'produto ainda não importado (marque também Produtos)');
          continue;
        }
        const locais: string[] = [];
        for (const url of x.urls) {
          const ja = this.arquivos.existente(url);
          if (ja) {
            locais.push(ja);
            pf.ignorados++;
            continue;
          }
          try {
            const repetida = baixando.has(url);
            if (!repetida) baixando.set(url, this.baixarFoto(url));
            locais.push(await baixando.get(url)!);
            if (repetida) pf.ignorados++;
            else pf.criados++;
          } catch (e) {
            this.erro(pf, `Produto ${x.r.id}`, `foto não baixada: ${(e as Error).message}`);
          }
        }
        if (locais.length) await this.db.update(produtos).set({ fotos: locais }).where(eq(produtos.id, produtoId));
      }
    };
    await Promise.all(Array.from({ length: 6 }, trabalhar));
    if (ex.cancelando) throw new Cancelada();
  }

  private async baixarFoto(url: string) {
    for (let tentativa = 0; ; tentativa++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((e: Error) => {
        throw new Error(e.message);
      });
      if ((res.status === 429 || res.status >= 500) && tentativa < 4) {
        await espera(1500 * 2 ** tentativa);
        continue;
      }
      if (!res.ok) throw new Error(`o Jueri respondeu ${res.status}`);
      const tamanho = Number(res.headers.get('content-length') ?? 0);
      if (tamanho > 15_000_000) throw new Error('arquivo grande demais');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 15_000_000) throw new Error('arquivo grande demais');
      // O tipo vem do conteúdo do arquivo (cabeçalho do servidor e extensão podem mentir).
      if (!tipoPeloConteudo(buf)) throw new Error('o arquivo não é uma imagem (JPG, PNG, WebP ou GIF)');
      // Reduz para no máximo 1200 px em WebP: ~100 KB por foto, sem perda visível no catálogo.
      const leve = await sharp(buf, { failOn: 'error' })
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
        .catch(() => {
          throw new Error('a imagem está corrompida');
        });
      return this.arquivos.salvarFoto(url, leve, 'image/webp');
    }
  }

  private erro(p: Parte, rotulo: string, motivo: string) {
    p.falhas++;
    // Agrupa pelo motivo sem os números ("código de barras 789… já é de outro" → "código de barras # já é de outro").
    const tipo = motivo.replace(/\d[\d.,/-]*/g, '#').slice(0, 120);
    p.motivos[tipo] = (p.motivos[tipo] ?? 0) + 1;
    if (p.erros.length < MAX_ERROS) p.erros.push(`${rotulo}: ${motivo}`);
    else if (p.erros.length === MAX_ERROS) p.erros.push('… mais erros omitidos.');
  }

  /** Mapa idJueri → id nosso, para um prefixo ("rev:", "prod:"…). */
  private async mapa(tx: Tx, tabela: typeof pessoas | typeof produtos | typeof categorias, prefixo: string) {
    const linhas = await tx.select({ id: tabela.id, j: tabela.idJueri }).from(tabela).where(like(tabela.idJueri, `${prefixo}%`));
    return new Map(linhas.map((l) => [l.j!.slice(prefixo.length), l.id]));
  }

  // ───────────── Cadastros básicos ─────────────

  private async gravarCadastros(tx: Tx, ex: Execucao, d: Record<string, Reg[]>) {
    const pc = this.parte(ex, 'Categorias');
    for (const c of d.categorias ?? []) {
      pc.lidos++;
      const nome = txt(c.nome);
      if (!nome) continue;
      const idj = `cat:${c.id}`;
      const [ja] = await tx.select().from(categorias).where(eq(categorias.idJueri, idj));
      const [mesmoNome] = ja ? [ja] : await tx.select().from(categorias).where(and(isNull(categorias.idJueri), isNull(categorias.paiId), sql`lower(${categorias.nome}) = lower(${nome})`));
      if (mesmoNome) {
        await tx.update(categorias).set({ nome, idJueri: idj }).where(eq(categorias.id, mesmoNome.id));
        pc.atualizados++;
      } else {
        await tx.insert(categorias).values({ nome, idJueri: idj });
        pc.criados++;
      }
    }

    const pf = this.parte(ex, 'Fornecedores');
    for (const f of d.fornecedores ?? []) {
      pf.lidos++;
      const nome = txt(pegar(f, 'nome_fantasia', 'razao_social', 'nome'));
      if (!nome) {
        this.erro(pf, `Fornecedor ${f.id}`, 'sem nome');
        continue;
      }
      const doc = soDigitos(txt(pegar(f, 'cnpj', 'documento')));
      const valores = {
        tipo: 'fornecedor' as const,
        tipoDocumento: doc.length === 11 ? 'cpf' : 'cnpj',
        documento: doc && (doc.length === 14 ? cnpjValido(doc) : cpfValido(doc)) ? doc : null,
        nome,
        nomeFantasia: txt(f.razao_social) && txt(f.nome_fantasia) ? txt(f.razao_social) : null,
        inscricaoEstadual: txt(f.ie),
        ...this.contato(f),
        status: ativo(f) ? ('ativo' as const) : ('inativo' as const),
        observacao: txt(f.observacao),
        camposExtras: limpa({ 'Contato': txt(f.nome_contato), 'Site': txt(f.site), 'Referência': txt(f.referencia) }),
        idJueri: `forn:${f.id}`,
      };
      await this.upsertPessoa(tx, pf, valores);
    }

    const pn = this.parte(ex, 'Níveis');
    for (const n of d.niveis ?? []) {
      pn.lidos++;
      const nome = txt(n.nome);
      if (!nome) continue;
      const faixas = extrairLista(typeof n.comissao_personalizada === 'string' ? jsonOuNada(n.comissao_personalizada) : n.comissao_personalizada).itens;
      const unica = faixas.length === 1 ? pb(faixas[0].comissao_porcentagem) : null;
      if (faixas.length > 1) pn.avisos.push(`Nível ${nome}: comissão por faixas de venda no Jueri; aqui ficou a comissão padrão. Ajuste em Rede › Níveis e metas.`);
      if (Number(n.multiplicar_pontos ?? 1) > 1) pn.avisos.push(`Nível ${nome}: multiplica pontos por ${n.multiplicar_pontos} no Jueri (aqui os pontos seguem as regras de Pontos e prêmios).`);
      const valores = { nome, metaMensal: centavos(n.meta_mensal) ?? 0, ...(unica !== null ? { comissaoAvistaPb: unica, comissaoPrazoPb: unica } : {}) };
      const [ja] = await tx.select().from(niveis).where(sql`lower(${niveis.nome}) = lower(${nome})`);
      if (ja) {
        await tx.update(niveis).set(valores).where(eq(niveis.id, ja.id));
        pn.atualizados++;
      } else {
        const [{ ordem }] = await tx.select({ ordem: sql<number>`coalesce(max(${niveis.ordem}), 0) + 1` }).from(niveis);
        await tx.insert(niveis).values({ ...valores, ordem });
        pn.criados++;
      }
    }
  }

  // ───────────── Produtos ─────────────

  private async gravarProdutos(tx: Tx, ex: Execucao, lista: Reg[] = [], op: OpcoesJueri, usuarioId: string) {
    const p = this.parte(ex, 'Produtos');
    const cats = await this.mapa(tx, categorias, 'cat:');
    const forns = await this.mapa(tx, pessoas, 'forn:');
    let pecas = 0;
    const foraDoTotal: string[] = [];
    let semPrecoN = 0;
    for (const [i, r] of lista.entries()) {
      this.checar();
      p.lidos++;
      if (i % 200 === 0) ex.fase = `${op.simular ? 'Simulando' : 'Gravando'} produtos… ${i}/${lista.length}`;
      try {
        const descricao = txt(r.descricao);
        if (!descricao) throw new Error('sem descrição');
        const tabela = extrairLista(r.tipo_preco).itens;
        const precoDe = (re: RegExp) => centavos(pegar(tabela.find((t) => re.test(String(t.nome ?? ''))) ?? {}, 'pivot.preco', 'preco'));
        const precoAchado =
          precoDe(/varejo/i) ?? centavos(pegar(tabela[0] ?? {}, 'pivot.preco', 'preco', 'valor')) ?? centavos(pegar(r, 'preco_varejo', 'preco_venda', 'valor_venda', 'valor_varejo', 'preco', 'valor'));
        // Sem preço no Jueri: entra inativo e fora do catálogo, para não quebrar maletas que têm a peça.
        const semPreco = !precoAchado || precoAchado <= 0;
        const preco = semPreco ? 0 : precoAchado;
        if (semPreco) semPrecoN++;
        const custos = limpaNum({
          bruto: centavos(r.custo_compra_bruto),
          insumos: centavos(pegar(r, 'custo_total_insumos', 'custo_insumos', 'custo_insumo')),
          banhoOuro: centavos(r.custo_banho_ouro),
          banhoPrata: centavos(r.custo_banho_prata),
          banhoRodio: centavos(r.custo_banho_rodio),
          verniz: centavos(pegar(r, 'custo_verniz', 'custo_banho_verniz')),
        });
        const custo = centavos(pegar(r, 'custo_compra_total', 'custo_total', 'custo')) ?? Object.values(custos).reduce((a, v) => a + v, 0);
        const codigo = soDigitos(txt(r.codigo_barras)) || txt(r.codigo_barras)?.replace(/\s/g, '') || null;
        const codForn = txt(r.codigo_barras_fornecedor);
        const catId = r.fk_categoria_id != null ? (cats.get(String(r.fk_categoria_id)) ?? null) : null;
        const subId = r.fk_subcategoria_id != null ? (cats.get(String(r.fk_subcategoria_id)) ?? null) : null;
        if (subId && catId && subId !== catId) await tx.update(categorias).set({ paiId: catId }).where(and(eq(categorias.id, subId), isNull(categorias.paiId)));
        const valores = {
          referencia: txt(r.referencia) ?? codigo ?? `J${r.id}`,
          descricao,
          descricaoCompleta: txt(r.descricao_completa),
          categoriaId: subId ?? catId,
          cor: txt(r.cor),
          milesimos: txt(r.milesimos_ouro),
          tipoBanho: txt(pegar(r, 'tipo_banho', 'banho')),
          fornecedorId: r.fk_fornecedor_id != null ? (forns.get(String(r.fk_fornecedor_id)) ?? null) : null,
          codigoFornecedor: codForn,
          ean: soDigitos(txt(r.numero_ean)) || (codForn && /^\d{8}$|^\d{12,14}$/.test(codForn) ? codForn : null),
          custo,
          custos,
          preco,
          precoAtacado: precoDe(/atacado/i),
          estoqueMinimo: Math.max(0, inteiro(r.estoque_minimo) ?? 0),
          estoqueMaximo: inteiro(r.estoque_maximo),
          localizacao: txt(r.localizacao),
          ncm: soDigitos(txt(r.numero_ncm)) || null,
          cfop: txt(r.cfop),
          fcpPb: pb(r.fcp),
          impostoPb: pb(pegar(r, 'imposto', 'aliquota_imposto')),
          lucroVarejoPb: pb(pegar(r, 'lucro_varejo', 'lucro_varejo_porcentagem')),
          lucroAtacadoPb: pb(pegar(r, 'lucro_atacado', 'lucro_atacado_porcentagem')),
          medidas: limpaNum({ largura: num(r.largura), altura: num(r.altura), profundidade: num(r.profundidade), peso: num(r.peso) }),
          observacao: txt(r.observacao),
          camposExtras: limpa({ 'Número da peça': txt(r.numero_peca), 'Peso loja': txt(r.peso_loja), 'Cor (código)': txt(r.cor_hexadecimal) }),
          ativo: semPreco ? false : ativo(r),
          ...(semPreco ? { exibeCatalogo: false } : simNao(r.status_catalogo) !== null ? { exibeCatalogo: simNao(r.status_catalogo)! } : {}),
          idJueri: `prod:${r.id}`,
        };
        const [porId] = await tx.select({ id: produtos.id }).from(produtos).where(eq(produtos.idJueri, valores.idJueri));
        const [porCodigo] = !porId && codigo ? await tx.select({ id: produtos.id, j: produtos.idJueri }).from(produtos).where(eq(produtos.codigoBarras, codigo)) : [];
        if (porCodigo?.j && porCodigo.j !== valores.idJueri) throw new Error(`código de barras ${codigo} já é de outro produto do Jueri`);
        let produtoId: string;
        const existente = porId ?? porCodigo;
        if (existente) {
          await tx.update(produtos).set({ ...valores, ...(codigo ? { codigoBarras: codigo } : {}), atualizadoEm: new Date() }).where(eq(produtos.id, existente.id));
          produtoId = existente.id;
          p.atualizados++;
        } else {
          const [novo] = await tx.insert(produtos).values({ ...valores, codigoBarras: codigo ?? (await proximoCodigoInterno(tx)) }).returning({ id: produtos.id });
          produtoId = novo.id;
          p.criados++;
        }
        const qtd = inteiro(r.quantidade);
        if (op.atualizarEstoque && qtd !== null) {
          if (qtd < 0) p.avisos.push(`Produto ${valores.referencia}: estoque negativo no Jueri (${qtd}); ficou 0.`);
          // O Jueri tem um número só por produto. O que já foi separado aqui para a loja e os eventos (transferência,
          // inventário) continua lá: o local escolhido fica só com o resto, e o total da empresa bate com o Jueri.
          const [{ outros }] = (
            await tx.execute<{ outros: number }>(sql`
              select coalesce(sum(s.quantidade), 0)::int as outros from saldos s join locais_estoque l on l.id = s.local_id
              where s.produto_id = ${produtoId} and s.local_id <> ${op.localId} and l.tipo <> 'maleta' and s.quantidade > 0`)
          ).rows;
          const alvo = Math.max(0, Math.max(0, qtd) - outros);
          if (Math.max(0, qtd) < outros) foraDoTotal.push(`${valores.referencia} (Jueri ${Math.max(0, qtd)}, separadas aqui ${outros})`);
          const atual = await this.estoque.saldo(tx, produtoId, op.localId);
          const dif = alvo - atual;
          if (dif) await this.estoque.mover(tx, { produtoId, origemId: dif < 0 ? op.localId : null, destinoId: dif > 0 ? op.localId : null, quantidade: Math.abs(dif), tipo: 'ajuste', motivo: 'Migração do Jueri', usuarioId });
          pecas += alvo;
        }
      } catch (e) {
        this.erro(p, `Produto ${r.id} (${txt(r.referencia) ?? txt(r.descricao) ?? ''})`, (e as Error).message);
      }
    }
    if (op.atualizarEstoque) p.avisos.push(`${pecas} peça(s) no local escolhido; o que já foi separado para loja e eventos ficou onde está, e o total da empresa bate com o Jueri.`);
    if (foraDoTotal.length) p.avisos.push(`${foraDoTotal.length} produto(s) com mais peças separadas na loja/eventos do que o Jueri tem no total (confira no inventário): ${foraDoTotal.slice(0, 15).join('; ')}.`);
    if (semPrecoN) p.avisos.push(`${semPrecoN} produto(s) sem preço de varejo no Jueri: entram inativos e fora do catálogo. Defina o preço antes de usar (Produtos › mostrar inativos).`);
  }

  // ───────────── Revendedoras, representantes e clientes ─────────────

  private contato(r: Reg) {
    const tel = (v: unknown) => soDigitos(txt(v)) || null;
    return {
      telefone1: tel(r.telefone_1),
      telefone2: tel(r.telefone_2),
      telefone3: tel(r.telefone_3),
      email: (() => {
        const e = txt(pegar(r, 'email', 'fisico.email', 'juridico.email'))?.toLowerCase();
        return e && e.includes('@') ? e : null;
      })(),
      cep: soDigitos(txt(r.cep)) || null,
      logradouro: txt(r.logradouro),
      numero: txt(r.numero),
      complemento: txt(r.complemento),
      bairro: txt(r.bairro),
      cidade: txt(r.cidade),
      uf: txt(pegar(r, 'uf', 'estado'))?.slice(0, 2).toUpperCase() ?? null,
    };
  }

  /** Nome, documento e dados pessoais, venham "soltos" (revendedor) ou em fisico/juridico (cliente, representante). */
  private identidade(r: Reg, avisos: string[], rotulo: string) {
    const fis = (r.fisico as Reg | null) ?? null;
    const jur = (r.juridico as Reg | null) ?? null;
    const nome = txt(pegar(r, 'nome', 'fisico.nome', 'juridico.razao_social', 'juridico.nome_fantasia', 'razao_social', 'nome_fantasia'));
    const cnpj = soDigitos(txt(pegar(r, 'juridico.cnpj', 'cnpj')));
    const cpf = soDigitos(txt(pegar(r, 'fisico.cpf', 'cpf')));
    const ehPj = !!jur || (!cpf && !!cnpj) || txt(r.tipo_documento) === 'cnpj';
    let doc: string | null = ehPj ? cnpj || null : cpf || null;
    if (doc && !(ehPj ? cnpjValido(doc) : cpfValido(doc))) {
      avisos.push(`${rotulo}: ${ehPj ? 'CNPJ' : 'CPF'} inválido no Jueri; ficou em branco.`);
      doc = null;
    }
    const base = fis ?? r;
    return {
      nome,
      tipoDocumento: ehPj ? 'cnpj' : 'cpf',
      documento: doc,
      nomeFantasia: txt(pegar(r, 'juridico.nome_fantasia', 'nome_fantasia')),
      rg: txt(pegar(base, 'rg')),
      inscricaoEstadual: txt(pegar(r, 'juridico.ie', 'ie')),
      nascimento: dataISO(pegar(base, 'data_nascimento')),
      genero: GENERO[String(pegar(base, 'fk_genero_id') ?? '')] ?? null,
      estadoCivil: ESTADO_CIVIL[String(pegar(base, 'fk_estado_civil_id') ?? '')] ?? null,
    };
  }

  private slugs: Set<string> | null = null;

  /** Acha pelo id do Jueri; senão pelo documento num cadastro que ainda não veio do Jueri; senão cria. */
  private async upsertPessoa(tx: Tx, p: Parte, valores: Record<string, unknown> & { tipo: 'representante' | 'cliente' | 'fornecedor'; idJueri: string; nome: string; documento: string | null }, soNaCriacao: Record<string, unknown> = {}) {
    const [porId] = await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.idJueri, valores.idJueri));
    const [porDoc] = !porId && valores.documento ? await tx.select({ id: pessoas.id }).from(pessoas).where(and(eq(pessoas.tipo, valores.tipo), eq(pessoas.documento, valores.documento), isNull(pessoas.idJueri))).limit(1) : [];
    const existente = porId ?? porDoc;
    if (existente) {
      await tx.update(pessoas).set({ ...valores, atualizadoEm: new Date() } as never).where(eq(pessoas.id, existente.id));
      p.atualizados++;
      return existente.id;
    }
    let slug: string | null = null;
    if (valores.tipo === 'representante') {
      this.slugs ??= new Set((await tx.select({ s: pessoas.slug }).from(pessoas)).map((x) => x.s ?? ''));
      const base = gerarSlug(valores.nome) || 'representante';
      slug = base;
      for (let k = 2; this.slugs.has(slug); k++) slug = `${base}-${k}`;
      this.slugs.add(slug);
    }
    const [novo] = await tx.insert(pessoas).values({ ...soNaCriacao, ...valores, slug } as never).returning({ id: pessoas.id });
    p.criados++;
    return novo.id;
  }

  private async gravarPessoas(tx: Tx, ex: Execucao, d: Record<string, Reg[]>, op: OpcoesJueri) {
    this.slugs = null;
    this.niveisCache = null;
    const regras = await this.config.regras(tx);

    const pr = this.parte(ex, 'Revendedoras');
    const lideres: [string, string][] = [];
    for (const r of d.revendedores ?? []) {
      this.checar();
      pr.lidos++;
      try {
        const ident = this.identidade(r, pr.avisos, `Revendedor ${r.id}`);
        if (!ident.nome) throw new Error('sem nome');
        const lider = String(pegar(r, 'fk_tipo_revendedor_id') ?? '') === '1';
        const faixasLider = txt(typeof r.comissao_lider === 'string' ? r.comissao_lider : r.comissao_lider ? JSON.stringify(r.comissao_lider) : null);
        const valores = {
          tipo: 'representante' as const,
          ...ident,
          nome: ident.nome,
          ...this.contato(r),
          profissao: txt(r.profissao),
          localTrabalho: txt(r.local),
          tipoRevendedor: lider ? 'Revendedora líder' : 'Revendedora',
          redesSociais: txt(typeof r.redes_sociais === 'object' && r.redes_sociais ? Object.values(r.redes_sociais as Reg).filter(Boolean).join(' · ') : r.redes_sociais),
          metaMensal: centavos(r.meta_mensal) ?? 0,
          nivelId: await this.nivelPorNome(tx, txt(pegar(r, 'level_revendedor.nome', 'level_revendedor.descricao', 'level_revendedor'))),
          modeloTrabalho: 'consignado' as const,
          status: ativo(r) ? ('ativo' as const) : ('inativo' as const),
          observacao: txt(r.observacao),
          observacaoInterna: txt(r.observacao_interna),
          camposExtras: limpa({ 'Supervisor no Jueri': txt(r.supervisor_nome), 'Comissão de líder no Jueri': faixasLider && faixasLider !== '[]' ? faixasLider : null, 'Site': txt(r.website), 'Segmento (código no Jueri)': txt(r.fk_segmento_revendedor_id) }),
          idJueri: `rev:${r.id}`,
        };
        const id = await this.upsertPessoa(tx, pr, valores, { limiteCredito: regras.limiteInicial });
        const gerente = pegar(r, 'gerente', 'fk_revendedor_gerente_id');
        if (gerente != null && String(gerente) !== String(r.id)) lideres.push([id, `rev:${gerente}`]);
        const refNome = txt(r.referencia_nome);
        if (refNome) {
          const [ja] = await tx.select({ id: referencias.id }).from(referencias).where(and(eq(referencias.pessoaId, id), eq(referencias.nome, refNome)));
          if (!ja) await tx.insert(referencias).values({ pessoaId: id, nome: refNome, telefone: soDigitos(txt(pegar(r, 'referencia_celular', 'referencia_telefone'))) || null, relacao: 'Indicação (Jueri)' });
        }
      } catch (e) {
        this.erro(pr, `Revendedor ${r.id}`, (e as Error).message);
      }
    }

    const prep = this.parte(ex, 'Representantes');
    for (const r of d.representantes ?? []) {
      prep.lidos++;
      try {
        const ident = this.identidade(r, prep.avisos, `Representante ${r.id}`);
        if (!ident.nome) throw new Error('sem nome');
        const valores = {
          tipo: 'representante' as const,
          ...ident,
          nome: ident.nome,
          ...this.contato(r),
          tipoRevendedor: 'Representante',
          metaMensal: centavos(r.meta_mensal) ?? 0,
          modeloTrabalho: 'consignado' as const,
          status: ativo(r) ? ('ativo' as const) : ('inativo' as const),
          observacao: txt(r.observacao),
          idJueri: `rep:${r.id}`,
        };
        const id = await this.upsertPessoa(tx, prep, valores, { limiteCredito: regras.limiteInicial, comissaoPb: op.comissaoRepresentantePb });
        // A comissão de representante só é posta se ninguém mudou à mão.
        await tx.update(pessoas).set({ comissaoPb: op.comissaoRepresentantePb }).where(and(eq(pessoas.id, id), isNull(pessoas.comissaoPb)));
        const gerente = pegar(r, 'fk_representante_gerente_id');
        if (gerente != null && String(gerente) !== String(r.id)) lideres.push([id, `rep:${gerente}`]);
      } catch (e) {
        this.erro(prep, `Representante ${r.id}`, (e as Error).message);
      }
    }

    // Líder de cada uma, depois que todas existem.
    for (const [id, liderJ] of lideres) {
      const [l] = await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.idJueri, liderJ));
      if (l && l.id !== id) await tx.update(pessoas).set({ liderId: l.id }).where(eq(pessoas.id, id));
      else pr.avisos.push(`Líder ${liderJ} não encontrada no Jueri.`);
    }

    const pcl = this.parte(ex, 'Clientes');
    const revs = await this.mapa(tx, pessoas, 'rev:');
    const reps = await this.mapa(tx, pessoas, 'rep:');
    for (const r of d.clientes ?? []) {
      pcl.lidos++;
      try {
        const ident = this.identidade(r, pcl.avisos, `Cliente ${r.id}`);
        if (!ident.nome) throw new Error('sem nome');
        const dono = (r.fk_revendedor_id != null ? revs.get(String(r.fk_revendedor_id)) : undefined) ?? (r.fk_representante_id != null ? reps.get(String(r.fk_representante_id)) : undefined) ?? null;
        await this.upsertPessoa(tx, pcl, {
          tipo: 'cliente',
          ...ident,
          nome: ident.nome,
          ...this.contato(r),
          representanteId: dono,
          status: ativo(r) ? 'ativo' : 'inativo',
          observacao: txt(r.observacao),
          observacaoInterna: txt(r.observacao_interna),
          idJueri: `cli:${r.id}`,
        });
      } catch (e) {
        this.erro(pcl, `Cliente ${r.id}`, (e as Error).message);
      }
    }
  }

  // ───────────── Maletas abertas ─────────────

  private async numeroLivre(tx: Tx, numero: unknown) {
    const n = /^\d{1,9}$/.test(String(numero ?? '').trim()) ? Number(String(numero).trim()) : null;
    if (!n) return {};
    const [usado] = await tx.select({ id: maletas.id }).from(maletas).where(eq(maletas.numero, n)).limit(1);
    return usado ? {} : { numero: n };
  }

  private async gravarMaletas(tx: Tx, ex: Execucao, pedidos: Reg[] = [], origem: typeof locaisEstoque.$inferSelect, usuarioId: string) {
    const pm = this.parte(ex, 'Maletas abertas');
    const revs = await this.mapa(tx, pessoas, 'rev:');
    const reps = await this.mapa(tx, pessoas, 'rep:');
    const prods = await this.mapa(tx, produtos, 'prod:');
    const regras = await this.config.regras(tx);
    let pecas = 0;
    let valor = 0;
    let comissaoDiferente = 0;
    const abertosJ = new Set<string>();
    const mexidas: number[] = [];
    for (const ped of pedidos) {
      this.checar();
      pm.lidos++;
      const numero = pegar(ped, 'codigo_pedido', 'id');
      try {
        const idj = `ped:${ped.id}`;
        abertosJ.add(idj); // continua aberto no Jueri (mesmo que dê problema abaixo, não é encerrado aqui)
        const [ja] = await tx.select({ id: maletas.id, numero: maletas.numero, localId: maletas.localId, status: maletas.status }).from(maletas).where(eq(maletas.idJueri, idj));
        const repId = (ped.fk_revendedor_id != null ? revs.get(String(ped.fk_revendedor_id)) : undefined) ?? (ped.fk_representante_id != null ? reps.get(String(ped.fk_representante_id)) : undefined);
        if (!repId) {
          if (ped.fk_revendedor_id != null) throw new Error(`revendedor ${ped.fk_revendedor_id} do Jueri não está entre os importados (pode estar excluído lá, ou rode a etapa Pessoas)`);
          if (ped.fk_representante_id != null) throw new Error(`representante ${ped.fk_representante_id} do Jueri não está entre os importados`);
          throw new Error(ped.fk_cliente_id != null ? 'pedido feito para um cliente, sem revendedora' : 'pedido sem revendedora');
        }

        // Junta itens do mesmo produto: a maleta tem uma linha por produto.
        const itens = new Map<string, { qtd: number; preco: number | null; custo: number | null }>();
        const faltam: string[] = [];
        for (const it of extrairLista(ped.itens).itens) {
          const qtd = qtdEmAberto(it);
          if (qtd <= 0) continue;
          const idProdJ = pegar(it, 'fk_produto_id', 'produto_id', 'produto.id');
          let prodId = idProdJ != null ? prods.get(String(idProdJ)) : undefined;
          if (!prodId) {
            const cod = txt(pegar(it, 'codigo_barras', 'produto.codigo_barras'));
            if (cod) {
              const [achado] = await tx.select({ id: produtos.id }).from(produtos).where(eq(produtos.codigoBarras, soDigitos(cod) || cod));
              prodId = achado?.id;
            }
          }
          if (!prodId) {
            faltam.push(String(idProdJ ?? pegar(it, 'codigo_barras', 'produto.codigo_barras') ?? '?'));
            continue;
          }
          const atual = itens.get(prodId);
          itens.set(prodId, { qtd: (atual?.qtd ?? 0) + qtd, preco: atual?.preco ?? centavos(pegar(it, 'valor_unitario', 'preco', 'valor', 'preco_unitario')), custo: atual?.custo ?? centavos(pegar(it, 'custo_compra')) });
        }
        if (faltam.length) throw new Error(`produto(s) não encontrados: ${faltam.slice(0, 10).join(', ')}`);
        if (!itens.size) {
          pm.ignorados++;
          if (!ja) pm.avisos.push(`Pedido ${numero}: sem peças em aberto; não virou maleta.`);
          continue;
        }
        // Já trazida antes: se ninguém mexeu nela aqui, acompanha o Jueri (trocas, peças incluídas ou retiradas).
        if (ja) {
          if (ja.status !== 'aberta') {
            pm.ignorados++;
            continue;
          }
          if (!(await this.intocada(tx, ja.id))) {
            pm.ignorados++;
            mexidas.push(ja.numero);
            continue;
          }
          const mudou = await this.sincronizarItens(tx, ja.id, ja.localId, itens, usuarioId);
          await tx.update(maletas).set({ dataLimite: dataISO(ped.data_acerto) ?? undefined }).where(eq(maletas.id, ja.id));
          if (mudou) pm.atualizados++;
          else pm.ignorados++;
          for (const [produtoId, it] of itens) {
            pecas += it.qtd;
            const [prod] = it.preco && it.preco > 0 ? [{ preco: it.preco }] : await tx.select({ preco: produtos.preco }).from(produtos).where(eq(produtos.id, produtoId));
            valor += (prod?.preco ?? 0) * it.qtd;
          }
          continue;
        }

        const [rep] = await tx.select({ nome: pessoas.nome, comissaoPb: pessoas.comissaoPb }).from(pessoas).where(eq(pessoas.id, repId));
        const comJ = pb(ped.comissao_porcentagem);
        if (comJ !== null && comJ !== (rep.comissaoPb ?? regras.comissaoAvistaPb)) comissaoDiferente++;
        const dataRetirada = dataISO(ped.data_criacao) ?? hoje();
        const [local] = await tx.insert(locaisEstoque).values({ empresaId: origem.empresaId, nome: `Maleta · ${rep.nome}`, tipo: 'maleta' }).returning();
        const [m] = await tx
          .insert(maletas)
          .values({
            // Mesmo número do pedido no Jueri, quando é um número e está livre.
            ...(await this.numeroLivre(tx, numero)),
            empresaId: origem.empresaId,
            representanteId: repId,
            localId: local.id,
            origemId: origem.id,
            dataRetirada,
            dataLimite: dataISO(ped.data_acerto) ?? somarDias(dataRetirada, regras.prazoAcertoDias),
            linkToken: randomBytes(18).toString('base64url'),
            observacao: txt(ped.observacao),
            observacaoInterna: [`Pedido nº ${numero} no Jueri.`, txt(ped.observacao_interna)].filter(Boolean).join('\n'),
            usuarioId,
            idJueri: idj,
          })
          .returning();
        await tx.update(locaisEstoque).set({ nome: `Maleta nº ${m.numero} · ${rep.nome}` }).where(eq(locaisEstoque.id, local.id));
        for (const [produtoId, it] of itens) {
          const [prod] = await tx.select({ preco: produtos.preco, custo: produtos.custo }).from(produtos).where(eq(produtos.id, produtoId));
          const preco = it.preco && it.preco > 0 ? it.preco : prod.preco;
          await tx.insert(maletaItens).values({ maletaId: m.id, produtoId, preco, custo: it.custo && it.custo > 0 ? it.custo : prod.custo, enviada: it.qtd });
          // As peças já estão com a revendedora: entram direto no local da maleta, sem tirar do estoque da empresa.
          await this.estoque.mover(tx, { produtoId, origemId: null, destinoId: local.id, quantidade: it.qtd, tipo: 'maleta_envio', motivo: 'Migração do Jueri', referenciaTipo: 'maleta', referenciaId: m.id, usuarioId });
          pecas += it.qtd;
          valor += preco * it.qtd;
        }
        pm.criados++;
      } catch (e) {
        this.erro(pm, `Pedido ${numero}`, (e as Error).message);
      }
    }
    // Maletas trazidas antes que não estão mais abertas no Jueri (acertadas ou canceladas lá).
    const antigas = await tx.select({ id: maletas.id, numero: maletas.numero, localId: maletas.localId, obs: maletas.observacaoInterna, j: maletas.idJueri }).from(maletas).where(and(like(maletas.idJueri, 'ped:%'), eq(maletas.status, 'aberta')));
    let encerradas = 0;
    if (!pedidos.length && antigas.length) {
      pm.avisos.push('O Jueri não devolveu nenhuma maleta aberta: por segurança, nenhuma maleta trazida antes foi encerrada.');
    } else {
      for (const m of antigas) {
        if (m.j && abertosJ.has(m.j)) continue;
        if (!(await this.intocada(tx, m.id))) {
          pm.avisos.push(`Maleta nº ${m.numero}: não está mais aberta no Jueri, mas foi usada aqui. Confira e acerte à mão.`);
          continue;
        }
        const its = await tx.select().from(maletaItens).where(eq(maletaItens.maletaId, m.id));
        for (const it of its) {
          if (it.enviada > 0) await this.estoque.mover(tx, { produtoId: it.produtoId, origemId: m.localId, destinoId: null, quantidade: it.enviada, tipo: 'ajuste', motivo: 'Acertada no Jueri antes da virada', referenciaTipo: 'maleta', referenciaId: m.id, usuarioId });
        }
        await tx.update(maletas).set({ status: 'cancelada', observacaoInterna: [m.obs, 'Encerrada: foi acertada ou cancelada no Jueri antes da virada.'].filter(Boolean).join('\n') }).where(eq(maletas.id, m.id));
        encerradas++;
      }
    }
    if (encerradas) pm.avisos.push(`${encerradas} maleta(s) trazidas antes foram acertadas no Jueri desde então: encerradas aqui.`);
    if (mexidas.length) pm.avisos.push(`${mexidas.length} maleta(s) já usadas aqui não foram alteradas pelo Jueri (nº ${mexidas.slice(0, 20).join(', ')}).`);
    pm.avisos.unshift(`${pecas} peça(s) em maletas abertas, R$ ${(valor / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} a preço de etiqueta.`);
    if (comissaoDiferente) pm.avisos.push(`${comissaoDiferente} pedido(s) com comissão no Jueri diferente da regra daqui; no acerto vale a regra daqui (cadastro, nível ou padrão).`);
  }

  // ───────────── Contas a receber ─────────────

  private async gravarContas(tx: Tx, ex: Execucao, contas: Reg[] = [], noJueri = 0) {
    const pc = this.parte(ex, 'Contas a receber');
    pc.avisos.push(`${noJueri} conta(s) a receber no Jueri; ${contas.length} em aberto.`);
    const [matriz] = await tx.select().from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    if (!matriz) throw new Error('Cadastre a empresa matriz antes de importar o financeiro.');
    const revs = await this.mapa(tx, pessoas, 'rev:');
    const reps = await this.mapa(tx, pessoas, 'rep:');
    const clis = await this.mapa(tx, pessoas, 'cli:');
    // Para ligar pelo "contato": documento e nome das pessoas vindas do Jueri.
    const gente = await tx
      .select({ id: pessoas.id, documento: pessoas.documento, nome: pessoas.nome })
      .from(pessoas)
      .where(sql`${pessoas.idJueri} like 'rev:%' or ${pessoas.idJueri} like 'cli:%' or ${pessoas.idJueri} like 'rep:%'`);
    const porDoc = new Map(gente.filter((g) => g.documento).map((g) => [g.documento!, g.id]));
    const porNome = new Map<string, string | null>();
    for (const g of gente) {
      const k = normNome(g.nome);
      porNome.set(k, porNome.has(k) ? null : g.id); // nome repetido não serve para ligar
    }
    const ligacao = { campo: 0, documento: 0, tipo: 0, nome: 0, nenhuma: 0 };
    const vistos = new Set<string>();
    const vigentes = new Set<string>();
    let total = 0;
    let zeradas = 0;
    let repetidas = 0;

    const acharPessoa = (c: Reg): string | null => {
      const direto =
        (c.fk_revendedor_id != null ? revs.get(String(c.fk_revendedor_id)) : undefined) ??
        (c.fk_representante_id != null ? reps.get(String(c.fk_representante_id)) : undefined) ??
        (c.fk_cliente_id != null ? clis.get(String(c.fk_cliente_id)) : undefined);
      if (direto) return (ligacao.campo++, direto);
      const ct = c.contato && typeof c.contato === 'object' ? (c.contato as Reg) : null;
      const doc = soDigitos(txt(pegar(ct ?? {}, 'cpf', 'cnpj', 'cpf_cnpj', 'documento', 'fisico.cpf', 'juridico.cnpj')));
      if (doc && porDoc.has(doc)) return (ligacao.documento++, porDoc.get(doc)!);
      const tipo = String(pegar(ct ?? {}, 'tipo', 'type', 'tipo_contato', 'origem', 'model') ?? pegar(c, 'contato_tipo', 'tipo_contato') ?? '');
      const idC = pegar(ct ?? {}, 'id') ?? pegar(c, 'contato_id', 'fk_contato_id');
      if (idC != null && tipo) {
        const m = /revend/i.test(tipo) ? revs : /client/i.test(tipo) ? clis : /represent/i.test(tipo) ? reps : null;
        const achado = m?.get(String(idC));
        if (achado) return (ligacao.tipo++, achado);
      }
      const nome = txt(ct ? pegar(ct, 'nome', 'razao_social', 'nome_fantasia', 'fisico.nome') : c.contato);
      const porN = nome ? porNome.get(normNome(nome)) : undefined;
      if (porN) return (ligacao.nome++, porN);
      ligacao.nenhuma++;
      return null;
    };

    const planoRecebimentos = await this.plano.daChave('recebimentos');
    for (const c of contas) {
      this.checar();
      pc.lidos++;
      try {
        // O Jueri repete o id da conta em cada parcela: a chave leva a parcela junto.
        const parcelaTxt = txt(pegar(c, 'parcela'));
        const fracao = parcelaTxt?.match(/(\d+)\s*\/\s*(\d+)/);
        const idj = `cr:${c.id}:${txt(c.numero_parcela) ?? ''}:${parcelaTxt ?? ''}:${txt(c.ocorrencia) ?? ''}`;
        if (vistos.has(idj)) {
          repetidas++;
          pc.ignorados++;
          continue;
        }
        vistos.add(idj);
        const cobrado =
          centavos(pegar(c, 'valor_cobrado', 'valor', 'valor_parcela', 'valor_aberto', 'valor_receber', 'valor_a_receber', 'saldo', 'valor_original', 'valor_documento', 'valor_bruto', 'valor_total', 'total')) ??
          primeiroCampo(c, /^(?!.*(pago|desconto|juros|multa|acrescimo|taxa))(valor|vl_|saldo|total)/i, centavos, (v) => v > 0);
        const pago = centavos(pegar(c, 'valor_pago')) ?? 0;
        const valor = cobrado !== null ? cobrado - (pago > 0 && pago < cobrado ? pago : 0) : null;
        const vencimento = dataISO(pegar(c, 'data_vencimento', 'vencimento', 'dt_vencimento')) ?? primeiroCampo(c, /venc/i, dataISO);
        if (valor === null) throw new Error(`sem valor (campos recebidos: ${Object.keys(c).sort().join(', ')})`);
        if (valor <= 0) {
          zeradas++;
          pc.ignorados++;
          continue;
        }
        if (!vencimento) throw new Error(`sem data de vencimento (campos recebidos: ${Object.keys(c).sort().join(', ')})`);
        const pessoaId = acharPessoa(c);
        const contato = txt(c.contato && typeof c.contato === 'object' ? pegar(c.contato as Reg, 'nome', 'razao_social', 'nome_fantasia', 'fisico.nome') : c.contato);
        const protestado = pegar(c, 'status_protestado', 'protestado') === true || String(pegar(c, 'status_protestado', 'protestado')) === '1';
        const valores = {
          empresaId: matriz.id,
          tipo: 'receber',
          pessoaId,
          descricao: [txt(c.descricao) ?? `Conta a receber nº ${pegar(c, 'numero_parcela', 'id')} (Jueri)`, !pessoaId && contato ? `· ${contato}` : null, pago > 0 ? '(saldo após pagamento parcial)' : null].filter(Boolean).join(' '),
          categoria: txt(pegar(c, 'categoria.nome', 'categoria.descricao', 'categoria')) ?? 'Migração Jueri',
          ...planoRecebimentos,
          valor,
          vencimento,
          parcela: (fracao ? Number(fracao[1]) : inteiro(parcelaTxt)) ?? 1,
          totalParcelas: (fracao ? Number(fracao[2]) : inteiro(pegar(c, 'total_parcelas', 'quantidade_parcelas'))) ?? 1,
          formaPagamento: txt(pegar(c, 'forma_pagamento.nome', 'forma_pagamento.descricao', 'forma_pagamento')),
          status: protestado ? ('protestado' as const) : ('aberto' as const),
          origemTipo: 'jueri',
          idJueri: idj,
        };
        vigentes.add(idj);
        const [ja] = await tx.select({ id: titulos.id, status: titulos.status }).from(titulos).where(eq(titulos.idJueri, idj));
        if (ja) {
          if (ja.status === 'aberto' || ja.status === 'protestado') {
            await tx.update(titulos).set(valores).where(eq(titulos.id, ja.id));
            pc.atualizados++;
          } else pc.ignorados++;
        } else {
          await tx.insert(titulos).values(valores);
          pc.criados++;
        }
        total += valor;
      } catch (e) {
        this.erro(pc, `Conta ${c.id}`, (e as Error).message);
      }
    }
    pc.avisos.push(`R$ ${(total / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} a receber em aberto trazidos.`);
    pc.avisos.push(
      `Ligação com a pessoa: ${ligacao.campo + ligacao.documento + ligacao.tipo} pelo cadastro do Jueri, ${ligacao.nome} pelo nome, ${ligacao.nenhuma} sem pessoa (entram só com a descrição e o nome do contato).`,
    );
    // Contas trazidas antes que não estão mais em aberto no Jueri (pagas ou canceladas lá).
    // Depois do dia da virada as baixas são feitas só aqui: o Jueri não encerra mais nada.
    const virada = (await this.config.ler('virada', tx)).data;
    const depoisDaVirada = !!virada && hoje() > virada;
    if (depoisDaVirada) pc.avisos.push(`Depois da virada (${virada.split('-').reverse().join('/')}), as baixas são só no sistema novo: contas pagas ou canceladas no Jueri não foram encerradas aqui.`);
    if (contas.length && !depoisDaVirada) {
      const antigas = await tx
        .select({ id: titulos.id, j: titulos.idJueri, desc: titulos.descricao, pago: titulos.valorPago, cobranca: titulos.cobrancaExternaId })
        .from(titulos)
        .where(and(like(titulos.idJueri, 'cr:%'), eq(titulos.status, 'aberto')));
      let baixadas = 0;
      let conferir = 0;
      for (const t of antigas) {
        if (vigentes.has(t.j!)) continue;
        if (t.pago || t.cobranca) {
          conferir++;
          continue;
        }
        await tx.update(titulos).set({ status: 'cancelado', descricao: `${t.desc} (baixada no Jueri antes da virada)` }).where(eq(titulos.id, t.id));
        baixadas++;
      }
      if (baixadas) pc.avisos.push(`${baixadas} conta(s) trazidas antes foram pagas ou canceladas no Jueri desde então: encerradas aqui.`);
      if (conferir) pc.avisos.push(`${conferir} conta(s) não estão mais em aberto no Jueri, mas já têm pagamento ou cobrança aqui: confira no Financeiro.`);
    }
    if (zeradas) pc.avisos.push(`${zeradas} conta(s) sem saldo a receber (valor zero ou já paga): não entram.`);
    if (repetidas) pc.avisos.push(`${repetidas} linha(s) repetidas na resposta do Jueri: entraram uma vez só.`);
  }
}

/** Imagem genérica que o Jueri mostra quando o produto não tem foto ("foto-padrao.jpg"): não é foto da peça. */
const IMAGEM_PADRAO = /foto[-_]?padr[aã]o|sem[-_]?(foto|imagem)|no[-_]?(image|photo)|placeholder|default[-_.]/i;

/** Endereços das fotos de um produto do Jueri: principal primeiro, depois as adicionais, sem repetir. */
export function urlsDeFoto(r: Reg): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return;
      if (t.startsWith('[') || t.startsWith('{')) return add(jsonOuNada(t));
      const url = /^https?:\/\//i.test(t) ? t : t.startsWith('//') ? `https:${t}` : t.startsWith('/') ? `https://jueri.com.br${t}` : null;
      if (url && !IMAGEM_PADRAO.test(url) && !out.includes(url)) out.push(url);
    } else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') add(pegar(v as Reg, 'url', 'link', 'imagem', 'caminho', 'src', 'arquivo'));
  };
  add(r.imagem);
  add(r.fotos_adicionais);
  add(r.fotos_adicionais_detalhes);
  return out.slice(0, 10);
}

/** 1/true/"sim"/"ativo" → true; 0/2/false/"não"/"inativo" → false; outro → null. */
function simNao(v: unknown): boolean | null {
  if (v === true || v === 1 || /^(1|s|sim|true|ativo|visivel|visível)$/i.test(String(v ?? ''))) return true;
  if (v === false || v === 0 || v === 2 || /^(0|2|n|nao|não|false|inativo|oculto)$/i.test(String(v ?? ''))) return false;
  return null;
}

function tipoPeloConteudo(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

const normNome = (n: string) => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function jsonOuNada(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return [];
  }
}

async function rotular<T>(etapa: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Cancelada) throw e;
    throw new Error(`${etapa}: ${(e as Error).message}`);
  }
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function limpa(o: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Record<string, string>;
}
function limpaNum(o: Record<string, number | null>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== 0)) as Record<string, number>;
}
