import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { gerarSlug, somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { SegredosService } from '../segredos/segredos.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { cnpjValido, cpfValido, soDigitos } from '../comum/documentos';
import { proximoCodigoInterno } from '../comum/codigos';
import { categorias, empresas, importacoes, locaisEstoque, maletaItens, maletas, niveis, pessoas, produtos, referencias, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { ativo, centavos, contaEmAberto, dataISO, estrutura, inteiro, pb, pedidoAberto, pegar, qtdEmAberto, txt, type Reg } from './mapear';

export const ETAPAS = ['cadastros', 'produtos', 'pessoas', 'maletas', 'financeiro'] as const;
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
  erros: string[];
  avisos: string[];
}

export interface Execucao {
  id: string;
  simular: boolean;
  etapas: Etapa[];
  inicio: string;
  fim: string | null;
  situacao: 'rodando' | 'concluida' | 'falhou';
  fase: string;
  erro: string | null;
  partes: Record<string, Parte>;
  /** Nomes dos campos que o Jueri devolveu (sem valores), para conferir o mapeamento. */
  estruturas: Record<string, string[]>;
}

class Simulacao extends Error {}
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
      const j = await this.get<Reg | Reg[]>(caminho, { ...params, page: pagina, per_page: 100 });
      if (Array.isArray(j)) return j;
      const dados = (j.data as Reg[] | undefined) ?? [];
      out.push(...dados);
      if (this.atual) this.atual.fase = `Baixando ${caminho} do Jueri… ${out.length}`;
      if (!j.next_page_url || !dados.length) break;
    }
    return out;
  }

  /** Completa registros que vieram resumidos na listagem. */
  private async detalhar(caminho: string, regs: Reg[], campoObrigatorio: string): Promise<Reg[]> {
    if (!regs.length || regs.every((r) => pegar(r, campoObrigatorio) !== undefined)) return regs;
    const out: Reg[] = [];
    for (const [i, r] of regs.entries()) {
      if (this.atual) this.atual.fase = `Baixando detalhes de ${caminho}… ${i + 1}/${regs.length}`;
      out.push(pegar(r, campoObrigatorio) !== undefined ? r : await this.get<Reg>(`${caminho}/${r.id}`));
    }
    return out;
  }

  async testar() {
    if (!this.configurado) throw new BadRequestException('Preencha o ID do cliente e o token do Jueri.');
    try {
      const cats = await this.get<Reg[]>('produto/categoria');
      const revs = await this.get<Reg>('revendedor', { per_page: 1 });
      const total = (revs.totals as Reg | undefined)?.total ?? '?';
      return { ok: true, mensagem: `Conectado ao Jueri: ${Array.isArray(cats) ? cats.length : 0} categoria(s) e ${total} revendedor(es).` };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // ───────────── Execução ─────────────

  iniciar(op: OpcoesJueri, usuarioId: string) {
    if (!this.configurado) throw new BadRequestException('Configure o Jueri em Configurações › Integrações antes de importar.');
    if (this.atual?.situacao === 'rodando') throw new BadRequestException('Já há uma importação do Jueri em andamento.');
    const ex: Execucao = { id: randomBytes(6).toString('hex'), simular: op.simular, etapas: op.etapas, inicio: new Date().toISOString(), fim: null, situacao: 'rodando', fase: 'Começando…', erro: null, partes: {}, estruturas: {} };
    this.atual = ex;
    void this.rodar(ex, op, usuarioId)
      .then(() => {
        ex.situacao = 'concluida';
        ex.fase = op.simular ? 'Simulação concluída: nada foi gravado.' : 'Importação concluída.';
      })
      .catch((e) => {
        ex.situacao = 'falhou';
        ex.erro = (e as Error).message;
        ex.fase = 'Parou com erro. Nada desta execução foi gravado.';
        this.log.error(`Importação do Jueri falhou: ${(e as Error).message}`);
      })
      .finally(() => {
        ex.fim = new Date().toISOString();
      });
    return ex;
  }

  private parte(ex: Execucao, nome: string): Parte {
    return (ex.partes[nome] ??= { lidos: 0, criados: 0, atualizados: 0, ignorados: 0, erros: [], avisos: [] });
  }

  private async rodar(ex: Execucao, op: OpcoesJueri, usuarioId: string) {
    const quer = (e: Etapa) => op.etapas.includes(e);
    // 1) Baixa tudo antes de abrir a transação: a gravação fica curta e não depende da internet.
    const dados: Record<string, Reg[]> = {};
    if (quer('cadastros')) {
      ex.fase = 'Baixando categorias, fornecedores e níveis…';
      dados.categorias = await this.get<Reg[]>('produto/categoria');
      dados.fornecedores = await this.detalhar('fornecedor', await this.todos('fornecedor'), 'cnpj');
      dados.niveis = await this.get<Reg[]>('revendedor/nivel');
    }
    if (quer('produtos')) {
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
        ex.fase = `Baixando maletas abertas… ${i + 1}/${lista.length}`;
        dados.pedidos.push(Array.isArray(p.itens) && (p.itens as Reg[]).every((it) => Object.keys(it).length > 2) ? p : await this.get<Reg>(`pedido/${p.id}`));
      }
      ex.estruturas.pedido = estrutura(dados.pedidos);
      ex.estruturas.pedidoItem = estrutura(dados.pedidos.flatMap((p) => (p.itens as Reg[]) ?? []), 10);
    }
    if (quer('financeiro')) {
      const todas = await this.todos('financeiro/contas_receber');
      ex.estruturas.contaReceber = estrutura(todas, 10);
      dados.contas = todas.filter(contaEmAberto);
      dados.contasTotal = [{ n: todas.length }];
    }

    // 2) Grava (ou simula) numa transação só.
    ex.fase = op.simular ? 'Simulando a gravação…' : 'Gravando…';
    try {
      await this.db.transaction(async (tx) => {
        const [local] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, op.localId));
        if (!local || local.tipo === 'maleta') throw new Error('Escolha um local de estoque válido (loja ou estoque central).');
        if (quer('cadastros')) await this.gravarCadastros(tx, ex, dados);
        if (quer('produtos')) await this.gravarProdutos(tx, ex, dados.produtos, op, usuarioId);
        if (quer('pessoas')) await this.gravarPessoas(tx, ex, dados, op);
        if (quer('maletas')) await this.gravarMaletas(tx, ex, dados.pedidos, local, usuarioId);
        if (quer('financeiro')) await this.gravarContas(tx, ex, dados.contas, Number(dados.contasTotal?.[0]?.n ?? 0));
        if (op.simular) throw new Simulacao();
      });
    } catch (e) {
      if (!(e instanceof Simulacao)) throw e;
    }
    if (!op.simular) {
      const soma = Object.values(ex.partes).reduce((a, p) => ({ l: a.l + p.lidos, c: a.c + p.criados, u: a.u + p.atualizados }), { l: 0, c: 0, u: 0 });
      const erros = Object.entries(ex.partes).flatMap(([n, p]) => p.erros.map((m) => ({ linha: 0, mensagem: `${n}: ${m}` })));
      const [imp] = await this.db.insert(importacoes).values({ tipo: 'jueri:api', arquivo: op.etapas.join(', '), linhas: soma.l, criados: soma.c, atualizados: soma.u, erros: erros.slice(0, 500), usuarioId }).returning();
      await this.auditoria.registrar({ usuarioId, acao: 'importar', entidade: 'importacao', entidadeId: imp.id, dados: { origem: 'jueri', etapas: op.etapas, criados: soma.c, atualizados: soma.u, erros: erros.length } });
    }
  }

  private erro(p: Parte, msg: string) {
    if (p.erros.length < MAX_ERROS) p.erros.push(msg);
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
        this.erro(pf, `Fornecedor ${f.id}: sem nome.`);
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
      const faixas = Array.isArray(n.comissao_personalizada) ? (n.comissao_personalizada as Reg[]) : [];
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
    for (const [i, r] of lista.entries()) {
      p.lidos++;
      if (i % 200 === 0) ex.fase = `${op.simular ? 'Simulando' : 'Gravando'} produtos… ${i}/${lista.length}`;
      try {
        const descricao = txt(r.descricao);
        if (!descricao) throw new Error('sem descrição');
        const tabela = Array.isArray(r.tipo_preco) ? (r.tipo_preco as Reg[]) : [];
        const precoDe = (re: RegExp) => centavos(pegar(tabela.find((t) => re.test(String(t.nome ?? ''))) ?? {}, 'pivot.preco', 'preco'));
        const preco = precoDe(/varejo/i) ?? centavos(pegar(tabela[0] ?? {}, 'pivot.preco', 'preco')) ?? centavos(pegar(r, 'preco', 'preco_varejo'));
        if (!preco || preco <= 0) throw new Error('sem preço de varejo');
        const custos = limpaNum({
          bruto: centavos(r.custo_compra_bruto),
          insumos: centavos(pegar(r, 'custo_insumos', 'custo_insumo')),
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
          ean: codForn && /^\d{8}$|^\d{12,14}$/.test(codForn) ? codForn : null,
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
          camposExtras: limpa({ 'Número da peça': txt(r.numero_peca), 'Peso loja': txt(r.peso_loja) }),
          ativo: ativo(r),
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
          const alvo = Math.max(0, qtd);
          if (qtd < 0) p.avisos.push(`Produto ${valores.referencia}: estoque negativo no Jueri (${qtd}); ficou 0.`);
          const atual = await this.estoque.saldo(tx, produtoId, op.localId);
          const dif = alvo - atual;
          if (dif) await this.estoque.mover(tx, { produtoId, origemId: dif < 0 ? op.localId : null, destinoId: dif > 0 ? op.localId : null, quantidade: Math.abs(dif), tipo: 'ajuste', motivo: 'Migração do Jueri', usuarioId });
          pecas += alvo;
        }
      } catch (e) {
        this.erro(p, `Produto ${r.id} (${txt(r.referencia) ?? txt(r.descricao) ?? ''}): ${(e as Error).message}`);
      }
    }
    if (op.atualizarEstoque) p.avisos.push(`${pecas} peça(s) no estoque da empresa, conforme o Jueri.`);
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
    const regras = await this.config.regras(tx);

    const pr = this.parte(ex, 'Revendedoras');
    const lideres: [string, string][] = [];
    for (const r of d.revendedores ?? []) {
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
          modeloTrabalho: 'consignado' as const,
          status: ativo(r) ? ('ativo' as const) : ('inativo' as const),
          observacao: txt(r.observacao),
          observacaoInterna: txt(r.observacao_interna),
          camposExtras: limpa({ 'Supervisor no Jueri': txt(r.supervisor_nome), 'Comissão de líder no Jueri': faixasLider && faixasLider !== '[]' ? faixasLider : null }),
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
        this.erro(pr, `Revendedor ${r.id}: ${(e as Error).message}`);
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
        this.erro(prep, `Representante ${r.id}: ${(e as Error).message}`);
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
        this.erro(pcl, `Cliente ${r.id}: ${(e as Error).message}`);
      }
    }
  }

  // ───────────── Maletas abertas ─────────────

  private async gravarMaletas(tx: Tx, ex: Execucao, pedidos: Reg[] = [], origem: typeof locaisEstoque.$inferSelect, usuarioId: string) {
    const pm = this.parte(ex, 'Maletas abertas');
    const revs = await this.mapa(tx, pessoas, 'rev:');
    const reps = await this.mapa(tx, pessoas, 'rep:');
    const prods = await this.mapa(tx, produtos, 'prod:');
    const regras = await this.config.regras(tx);
    let pecas = 0;
    let valor = 0;
    let comissaoDiferente = 0;
    for (const ped of pedidos) {
      pm.lidos++;
      const numero = pegar(ped, 'codigo_pedido', 'id');
      try {
        const idj = `ped:${ped.id}`;
        const [ja] = await tx.select({ id: maletas.id }).from(maletas).where(eq(maletas.idJueri, idj));
        if (ja) {
          pm.ignorados++;
          continue;
        }
        const repId = (ped.fk_revendedor_id != null ? revs.get(String(ped.fk_revendedor_id)) : undefined) ?? (ped.fk_representante_id != null ? reps.get(String(ped.fk_representante_id)) : undefined);
        if (!repId) throw new Error('a revendedora deste pedido não foi importada (rode a etapa Pessoas antes)');

        // Junta itens do mesmo produto: a maleta tem uma linha por produto.
        const itens = new Map<string, { qtd: number; preco: number | null }>();
        const faltam: string[] = [];
        for (const it of (ped.itens as Reg[] | undefined) ?? []) {
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
          itens.set(prodId, { qtd: (atual?.qtd ?? 0) + qtd, preco: atual?.preco ?? centavos(pegar(it, 'valor_unitario', 'preco', 'valor', 'preco_unitario')) });
        }
        if (faltam.length) throw new Error(`produto(s) não encontrados: ${faltam.slice(0, 10).join(', ')}`);
        if (!itens.size) {
          pm.ignorados++;
          pm.avisos.push(`Pedido ${numero}: sem peças em aberto; não virou maleta.`);
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
          await tx.insert(maletaItens).values({ maletaId: m.id, produtoId, preco, custo: prod.custo, enviada: it.qtd });
          // As peças já estão com a revendedora: entram direto no local da maleta, sem tirar do estoque da empresa.
          await this.estoque.mover(tx, { produtoId, origemId: null, destinoId: local.id, quantidade: it.qtd, tipo: 'maleta_envio', motivo: 'Migração do Jueri', referenciaTipo: 'maleta', referenciaId: m.id, usuarioId });
          pecas += it.qtd;
          valor += preco * it.qtd;
        }
        pm.criados++;
      } catch (e) {
        this.erro(pm, `Pedido ${numero}: ${(e as Error).message}`);
      }
    }
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
    let total = 0;
    for (const c of contas) {
      pc.lidos++;
      try {
        const idj = `cr:${c.id}`;
        const valor = centavos(pegar(c, 'valor', 'valor_parcela', 'valor_original', 'valor_total'));
        const vencimento = dataISO(pegar(c, 'data_vencimento', 'vencimento'));
        if (!valor || valor <= 0) throw new Error('sem valor');
        if (!vencimento) throw new Error('sem data de vencimento');
        const pessoaId =
          (c.fk_revendedor_id != null ? revs.get(String(c.fk_revendedor_id)) : undefined) ??
          (c.fk_representante_id != null ? reps.get(String(c.fk_representante_id)) : undefined) ??
          (c.fk_cliente_id != null ? clis.get(String(c.fk_cliente_id)) : undefined) ??
          null;
        const contato = txt(pegar(c, 'contato', 'contato.nome', 'nome_contato', 'pessoa.nome'));
        const protestado = pegar(c, 'status_protestado', 'protestado') === true || String(pegar(c, 'status_protestado', 'protestado')) === '1';
        const valores = {
          empresaId: matriz.id,
          tipo: 'receber',
          pessoaId,
          descricao: [txt(c.descricao) ?? `Conta a receber nº ${pegar(c, 'numero_parcela', 'id')} (Jueri)`, !pessoaId && contato ? `· ${contato}` : null].filter(Boolean).join(' '),
          categoria: txt(pegar(c, 'categoria.nome', 'categoria')) ?? 'Migração Jueri',
          valor,
          vencimento,
          parcela: inteiro(pegar(c, 'parcela', 'numero_parcela')) ?? 1,
          totalParcelas: inteiro(pegar(c, 'total_parcelas', 'quantidade_parcelas')) ?? 1,
          formaPagamento: txt(pegar(c, 'forma_pagamento.nome', 'forma_pagamento')),
          status: protestado ? ('protestado' as const) : ('aberto' as const),
          origemTipo: 'jueri',
          idJueri: idj,
        };
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
        if (!pessoaId && pc.avisos.length < 50) pc.avisos.push(`Conta ${c.id}: sem revendedora/cliente ligada; entrou só com a descrição.`);
        total += valor;
      } catch (e) {
        this.erro(pc, `Conta ${c.id}: ${(e as Error).message}`);
      }
    }
    pc.avisos.splice(1, 0, `R$ ${(total / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} a receber em aberto trazidos.`);
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
