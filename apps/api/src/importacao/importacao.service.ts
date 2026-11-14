import { proximoCodigoInterno } from '../comum/codigos';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, ilike } from 'drizzle-orm';
import { gerarSlug } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { EstoqueService } from '../estoque/estoque.service';
import { cnpjValido, cpfValido, soDigitos } from '../comum/documentos';
import { categorias, importacoes, locaisEstoque, niveis, pessoas, pontos, produtos } from '../db/schema';

/**
 * Importação por planilha (migração do Jueri e cargas futuras).
 * Aceita os nomes de coluna do Jueri e variações comuns; colunas desconhecidas são ignoradas.
 * Reimportar a mesma planilha atualiza em vez de duplicar.
 */
const norm = (k: string) => k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES_PRODUTO: Record<string, string[]> = {
  codigoBarras: ['codigobarras', 'codbarras', 'codigodebarras', 'ean', 'gtin', 'coddebarras'],
  referencia: ['referencia', 'ref', 'codigo', 'cod', 'sku'],
  descricao: ['descricao', 'produto', 'nome', 'nomedoproduto'],
  categoria: ['categoria'],
  subcategoria: ['subcategoria'],
  ean: ['ean', 'gtin', 'eangtin'],
  tipoBanho: ['tipodebanho', 'tipobanho'],
  estoqueMaximo: ['estoquemaximo', 'maximo'],
  observacao: ['observacao', 'obs'],
  descricaoCompleta: ['descricaocompleta'],
  tamanho: ['tamanho', 'n', 'no', 'numero', 'aro'],
  cor: ['cor'],
  preco: ['preco', 'precovarejo', 'valorvarejo', 'varejo', 'valor', 'precovenda', 'precodevenda', 'valordevenda'],
  precoAtacado: ['precoatacado', 'atacado', 'valoratacado'],
  custo: ['custo', 'custototal', 'precocusto', 'precodecusto', 'custobruto', 'valorcusto'],
  quantidade: ['estoque', 'quantidade', 'qtde', 'qtd', 'saldo'],
  estoqueMinimo: ['estoqueminimo', 'minimo'],
  fornecedor: ['fornecedor'],
  codigoFornecedor: ['codigofornecedor', 'codfornecedor', 'codigodofornecedor', 'codbarrasfornecedor'],
  ncm: ['ncm'],
  cfop: ['cfop'],
  pesoBanho: ['pesobanho', 'banho', 'pesodobanho'],
  milesimos: ['milesimos', 'milesimosdebanho'],
  localizacao: ['localizacao', 'local', 'prateleira'],
};

const ALIASES_PESSOA: Record<string, string[]> = {
  idJueri: ['id', 'codigo', 'cod', 'idjueri'],
  nome: ['nome', 'razaosocial', 'nomecompleto', 'consignatario', 'revendedor', 'cliente'],
  nomeFantasia: ['fantasia', 'nomefantasia'],
  documento: ['cpf', 'cnpj', 'cpfcnpj', 'documento', 'doc'],
  rg: ['rg'],
  inscricaoEstadual: ['ie', 'inscricaoestadual'],
  nascimento: ['nascimento', 'datanascimento', 'datadenascimento', 'aniversario'],
  genero: ['genero', 'sexo'],
  estadoCivil: ['estadocivil'],
  profissao: ['profissao'],
  telefone1: ['telefone', 'telefone1', 'celular', 'whatsapp', 'fone'],
  telefone2: ['telefone2', 'fone2'],
  telefone3: ['telefone3'],
  email: ['email', 'e-mail'],
  instagram: ['instagram', 'redessociais'],
  cep: ['cep'],
  logradouro: ['logradouro', 'endereco', 'rua'],
  numero: ['numero', 'n'],
  complemento: ['complemento'],
  bairro: ['bairro'],
  cidade: ['cidade', 'municipio'],
  uf: ['uf', 'estado'],
  nivel: ['nivel'],
  lider: ['revendedorlider', 'lider', 'representantelider'],
  praca: ['praca', 'regiao'],
  localTrabalho: ['local', 'localtrabalho', 'ondetrabalha'],
  segmento: ['segmento'],
  tipoRevendedor: ['tiporevendedor', 'tipoderevendedor'],
  metaMensal: ['metamensal', 'meta'],
  pontos: ['pontosacumulados', 'pontos', 'saldodepontos'],
  status: ['status', 'situacao'],
  limiteCredito: ['limite', 'limitecredito', 'limitedecredito', 'credito'],
  observacao: ['observacao', 'obs'],
  observacaoInterna: ['observacaointerna', 'obsinterna'],
};

function mapear(linha: Record<string, unknown>, aliases: Record<string, string[]>) {
  const porNorma = new Map(Object.entries(linha).map(([k, v]) => [norm(k), v]));
  const r: Record<string, string> = {};
  for (const [campo, nomes] of Object.entries(aliases)) {
    for (const n of nomes) {
      const v = porNorma.get(norm(n));
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        r[campo] = String(v).trim();
        break;
      }
    }
  }
  return r;
}

/** "R$ 1.234,56", "1234.56", "1234,5" ou número → centavos */
export function dinheiro(v?: string): number | null {
  if (v === undefined || v === '') return null;
  let s = String(v).replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function data(v?: string): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

class Simulacao extends Error {}

export interface Relatorio {
  linhas: number;
  criados: number;
  atualizados: number;
  erros: { linha: number; mensagem: string }[];
  avisos: string[];
  colunasReconhecidas: string[];
}

@Injectable()
export class ImportacaoService {
  constructor(@Inject(DB) private readonly db: Db, private readonly estoque: EstoqueService, private readonly auditoria: AuditoriaService) {}

  private async executar(simular: boolean, fn: (tx: Tx) => Promise<Relatorio>): Promise<Relatorio> {
    let rel: Relatorio | undefined;
    try {
      await this.db.transaction(async (tx) => {
        rel = await fn(tx);
        if (simular) throw new Simulacao();
      });
    } catch (e) {
      if (!(e instanceof Simulacao)) throw e;
    }
    return rel!;
  }

  async produtos(linhas: Record<string, unknown>[], opcoes: { localId?: string | null; simular: boolean; arquivo?: string }, usuarioId: string) {
    if (!linhas.length) throw new BadRequestException('Planilha vazia.');
    const rel = await this.executar(opcoes.simular, async (tx) => {
      const r: Relatorio = { linhas: linhas.length, criados: 0, atualizados: 0, erros: [], avisos: [], colunasReconhecidas: Object.keys(mapear(Object.fromEntries(Object.keys(linhas[0]).map((k) => [k, 'x'])), ALIASES_PRODUTO)) };
      if (opcoes.localId) {
        const [l] = await tx.select().from(locaisEstoque).where(eq(locaisEstoque.id, opcoes.localId));
        if (!l || l.tipo === 'maleta') throw new BadRequestException('Local de estoque inválido.');
      } else if (r.colunasReconhecidas.includes('quantidade')) r.avisos.push('A planilha tem estoque, mas nenhum local foi escolhido: as quantidades foram ignoradas.');
      const todasCats = await tx.select().from(categorias);
      const nomeCat = new Map(todasCats.map((c) => [c.id, c.nome]));
      const cats = new Map(todasCats.map((c) => [c.paiId ? `${norm(nomeCat.get(c.paiId) ?? '')}>${norm(c.nome)}` : norm(c.nome), c.id]));
      const forns = new Map((await tx.select().from(pessoas).where(eq(pessoas.tipo, 'fornecedor'))).map((f) => [norm(f.nome), f.id]));
      const codigosVistos = new Set<string>();

      for (const [i, bruta] of linhas.entries()) {
        const n = i + 2; // linha 1 é o cabeçalho
        const d = mapear(bruta, ALIASES_PRODUTO);
        try {
          if (!d.descricao) throw new Error('sem descrição');
          const preco = dinheiro(d.preco);
          if (!preco || preco <= 0) throw new Error('sem preço de venda');
          const codigo = d.codigoBarras ? d.codigoBarras.replace(/\s/g, '') : null;
          const referencia = d.referencia ?? codigo;
          if (!codigo && !referencia) throw new Error('sem código de barras e sem referência');
          const chave = codigo ?? `ref:${referencia}`;
          if (codigosVistos.has(chave)) throw new Error(`código repetido na planilha (${codigo ?? referencia})`);
          codigosVistos.add(chave);

          let categoriaId: string | null = null;
          if (d.categoria) {
            categoriaId = cats.get(norm(d.categoria)) ?? null;
            if (!categoriaId) {
              const [c] = await tx.insert(categorias).values({ nome: d.categoria }).returning();
              cats.set(norm(d.categoria), c.id);
              categoriaId = c.id;
            }
            // Subcategoria fica "dentro" da categoria; o produto aponta para a mais específica.
            if (d.subcategoria) {
              const chaveSub = `${norm(d.categoria)}>${norm(d.subcategoria)}`;
              let sub = cats.get(chaveSub) ?? null;
              if (!sub) {
                const [c] = await tx.insert(categorias).values({ nome: d.subcategoria, paiId: categoriaId }).returning();
                cats.set(chaveSub, c.id);
                sub = c.id;
              }
              categoriaId = sub;
            }
          }
          let fornecedorId: string | null = null;
          if (d.fornecedor) {
            fornecedorId = forns.get(norm(d.fornecedor)) ?? null;
            if (!fornecedorId) {
              const [f] = await tx.insert(pessoas).values({ tipo: 'fornecedor', tipoDocumento: 'cnpj', nome: d.fornecedor }).returning();
              forns.set(norm(d.fornecedor), f.id);
              fornecedorId = f.id;
            }
          }
          const valores = {
            referencia: referencia!,
            descricao: d.descricao,
            categoriaId,
            tamanho: d.tamanho ?? null,
            cor: d.cor ?? null,
            preco,
            precoAtacado: dinheiro(d.precoAtacado),
            custo: dinheiro(d.custo) ?? 0,
            estoqueMinimo: d.estoqueMinimo ? Math.max(0, Math.floor(Number(d.estoqueMinimo)) || 0) : 0,
            fornecedorId,
            codigoFornecedor: d.codigoFornecedor ?? null,
            ncm: d.ncm ? soDigitos(d.ncm) : null,
            cfop: d.cfop ?? null,
            pesoBanho: d.pesoBanho ?? null,
            milesimos: d.milesimos ?? null,
            localizacao: d.localizacao ?? null,
            ...(d.ean ? { ean: soDigitos(d.ean) || null } : {}),
            ...(d.tipoBanho ? { tipoBanho: d.tipoBanho } : {}),
            ...(d.estoqueMaximo ? { estoqueMaximo: Math.max(0, Math.floor(Number(d.estoqueMaximo)) || 0) } : {}),
            ...(d.observacao ? { observacao: d.observacao } : {}),
            ...(d.descricaoCompleta ? { descricaoCompleta: d.descricaoCompleta } : {}),
          };
          const [existente] = codigo
            ? await tx.select().from(produtos).where(eq(produtos.codigoBarras, codigo))
            : await tx.select().from(produtos).where(eq(produtos.referencia, referencia!));
          let produtoId: string;
          if (existente) {
            await tx.update(produtos).set({ ...valores, atualizadoEm: new Date() }).where(eq(produtos.id, existente.id));
            produtoId = existente.id;
            r.atualizados++;
          } else {
            const [p] = await tx.insert(produtos).values({ ...valores, codigoBarras: codigo ?? (await proximoCodigoInterno(tx)) }).returning();
            produtoId = p.id;
            r.criados++;
          }
          if (opcoes.localId && d.quantidade !== undefined) {
            const qtd = Math.floor(Number(String(d.quantidade).replace(',', '.')));
            if (!Number.isFinite(qtd) || qtd < 0) throw new Error('quantidade inválida');
            const atual = await this.estoque.saldo(tx, produtoId, opcoes.localId);
            const dif = qtd - atual;
            if (dif) await this.estoque.mover(tx, { produtoId, origemId: dif < 0 ? opcoes.localId : null, destinoId: dif > 0 ? opcoes.localId : null, quantidade: Math.abs(dif), tipo: 'ajuste', motivo: 'Importação de planilha', usuarioId });
          }
        } catch (e) {
          r.erros.push({ linha: n, mensagem: (e as Error).message });
        }
      }
      return r;
    });
    if (!opcoes.simular) await this.registrar('produtos', rel, opcoes.arquivo, usuarioId);
    return rel;
  }

  async pessoas(tipo: 'representante' | 'cliente' | 'fornecedor', linhas: Record<string, unknown>[], opcoes: { simular: boolean; arquivo?: string }, usuarioId: string) {
    if (!linhas.length) throw new BadRequestException('Planilha vazia.');
    const rel = await this.executar(opcoes.simular, async (tx) => {
      const r: Relatorio = { linhas: linhas.length, criados: 0, atualizados: 0, erros: [], avisos: [], colunasReconhecidas: Object.keys(mapear(Object.fromEntries(Object.keys(linhas[0]).map((k) => [k, 'x'])), ALIASES_PESSOA)) };
      const nivs = new Map((await tx.select().from(niveis)).map((n) => [norm(n.nome), n.id]));
      const lideresPendentes: { id: string; lider: string; linha: number }[] = [];
      const slugs = new Set((await tx.select({ s: pessoas.slug }).from(pessoas)).map((x) => x.s));

      for (const [i, bruta] of linhas.entries()) {
        const n = i + 2;
        const d = mapear(bruta, ALIASES_PESSOA);
        try {
          if (!d.nome) throw new Error('sem nome');
          const doc = d.documento ? soDigitos(d.documento) : null;
          const tipoDocumento = doc && doc.length === 14 ? 'cnpj' : 'cpf';
          if (doc && !(tipoDocumento === 'cpf' ? cpfValido(doc) : cnpjValido(doc))) throw new Error(`${tipoDocumento.toUpperCase()} inválido (${d.documento})`);
          const status = d.status ? (/inativ|bloque|exclu/i.test(d.status) ? 'inativo' : 'ativo') : 'ativo';
          let nivelId: string | null = null;
          if (d.nivel) {
            nivelId = nivs.get(norm(d.nivel)) ?? null;
            if (!nivelId) {
              const [nv] = await tx.insert(niveis).values({ nome: d.nivel, ordem: nivs.size + 1 }).returning();
              nivs.set(norm(d.nivel), nv.id);
              nivelId = nv.id;
            }
          }
          const valores = {
            tipo,
            tipoDocumento,
            documento: doc,
            nome: d.nome,
            nomeFantasia: d.nomeFantasia ?? null,
            rg: d.rg ?? null,
            inscricaoEstadual: d.inscricaoEstadual ?? null,
            nascimento: data(d.nascimento),
            genero: d.genero ? (/^f/i.test(d.genero) ? 'Feminino' : /^m/i.test(d.genero) ? 'Masculino' : d.genero) : null,
            estadoCivil: d.estadoCivil ?? null,
            profissao: d.profissao ?? null,
            telefone1: d.telefone1 ? soDigitos(d.telefone1) : null,
            telefone2: d.telefone2 ? soDigitos(d.telefone2) : null,
            telefone3: d.telefone3 ? soDigitos(d.telefone3) : null,
            email: d.email && d.email.includes('@') ? d.email.toLowerCase() : null,
            instagram: d.instagram ?? null,
            cep: d.cep ? soDigitos(d.cep) : null,
            logradouro: d.logradouro ?? null,
            numero: d.numero ?? null,
            complemento: d.complemento ?? null,
            bairro: d.bairro ?? null,
            cidade: d.cidade ?? null,
            uf: d.uf ? d.uf.slice(0, 2).toUpperCase() : null,
            praca: d.praca ?? null,
            ...(d.localTrabalho ? { localTrabalho: d.localTrabalho } : {}),
            ...(d.segmento ? { segmento: d.segmento } : {}),
            ...(d.tipoRevendedor ? { tipoRevendedor: d.tipoRevendedor } : {}),
            ...(d.metaMensal ? { metaMensal: dinheiro(d.metaMensal) ?? 0 } : {}),
            status: status as 'ativo',
            observacao: d.observacao ?? null,
            observacaoInterna: d.observacaoInterna ?? null,
            idJueri: d.idJueri ?? null,
            ...(tipo === 'representante' ? { nivelId, modeloTrabalho: 'consignado' as const, ...(d.limiteCredito ? { limiteCredito: dinheiro(d.limiteCredito) ?? 0 } : {}) } : {}),
          };
          const [existente] = d.idJueri
            ? await tx.select().from(pessoas).where(and(eq(pessoas.tipo, tipo), eq(pessoas.idJueri, d.idJueri)))
            : doc
              ? await tx.select().from(pessoas).where(and(eq(pessoas.tipo, tipo), eq(pessoas.documento, doc)))
              : await tx.select().from(pessoas).where(and(eq(pessoas.tipo, tipo), ilike(pessoas.nome, d.nome)));
          let id: string;
          if (existente) {
            await tx.update(pessoas).set({ ...valores, atualizadoEm: new Date() }).where(eq(pessoas.id, existente.id));
            id = existente.id;
            r.atualizados++;
          } else {
            let slug: string | null = null;
            if (tipo === 'representante') {
              const base = gerarSlug(d.nome) || 'representante';
              slug = base;
              for (let k = 2; slugs.has(slug); k++) slug = `${base}-${k}`;
              slugs.add(slug);
            }
            const [p] = await tx.insert(pessoas).values({ ...valores, slug }).returning();
            id = p.id;
            r.criados++;
          }
          if (tipo === 'representante' && d.lider) lideresPendentes.push({ id, lider: d.lider, linha: n });
          if (tipo === 'representante' && d.pontos) {
            // Saldo de pontos do Jueri: um lançamento só por pessoa; reimportar atualiza o valor.
            const qtd = Math.floor(Number(String(d.pontos).replace(/\./g, '').replace(',', '.')));
            if (!Number.isFinite(qtd)) throw new Error(`pontos inválidos (${d.pontos})`);
            await tx
              .insert(pontos)
              .values({ pessoaId: id, pontos: qtd, motivo: 'Saldo de pontos trazido do Jueri', origemTipo: 'jueri', origemId: id, regra: 'saldo_inicial', usuarioId })
              .onConflictDoUpdate({ target: [pontos.origemTipo, pontos.origemId, pontos.regra], set: { pontos: qtd } });
          }
        } catch (e) {
          r.erros.push({ linha: n, mensagem: (e as Error).message });
        }
      }
      // Segunda passada: liga cada representante à líder pelo nome, depois que todas existem.
      for (const l of lideresPendentes) {
        const [lider] = await tx.select({ id: pessoas.id }).from(pessoas).where(and(eq(pessoas.tipo, 'representante'), ilike(pessoas.nome, l.lider)));
        if (lider && lider.id !== l.id) await tx.update(pessoas).set({ liderId: lider.id }).where(eq(pessoas.id, l.id));
        else r.avisos.push(`Linha ${l.linha}: líder "${l.lider}" não encontrada.`);
      }
      return r;
    });
    if (!opcoes.simular) await this.registrar(`pessoas:${tipo}`, rel, opcoes.arquivo, usuarioId);
    return rel;
  }

  private async registrar(tipo: string, r: Relatorio, arquivo: string | undefined, usuarioId: string) {
    const [imp] = await this.db.insert(importacoes).values({ tipo, arquivo: arquivo ?? null, linhas: r.linhas, criados: r.criados, atualizados: r.atualizados, erros: r.erros.slice(0, 500), usuarioId }).returning();
    await this.auditoria.registrar({ usuarioId, acao: 'importar', entidade: 'importacao', entidadeId: imp.id, dados: { tipo, criados: r.criados, atualizados: r.atualizados, erros: r.erros.length } });
  }
}

export { ALIASES_PESSOA, ALIASES_PRODUTO };
