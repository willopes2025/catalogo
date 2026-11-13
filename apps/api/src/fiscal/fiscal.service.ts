import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { SegredosService } from '../segredos/segredos.service';
import { empresas, maletaItens, maletas, notasFiscais, pessoas, produtos, regrasFiscais, vendaItens, vendaPagamentos, vendas, acertos } from '../db/schema';

/**
 * Emissão de NF-e e NFC-e pela Focus NFe.
 *   FOCUS_NFE_TOKEN     token da empresa na Focus (um por ambiente)
 *   FOCUS_NFE_URL       https://homologacao.focusnfe.com.br (testes) ou https://api.focusnfe.com.br (produção)
 * O certificado A1, a série, a numeração e o CSC da NFC-e ficam cadastrados no painel da Focus.
 * As naturezas e CFOPs abaixo são um PONTO DE PARTIDA para empresa do Simples Nacional e
 * PRECISAM ser validados pelo contador da Aritana antes da produção (tela Fiscal › Regras).
 */
export const REGRAS_FISCAIS_PADRAO = [
  { operacao: 'venda_consumidor', natureza: 'Venda de mercadoria', cfopDentro: '5102', cfopFora: '6102', csosn: '102', base: 'venda', observacao: 'NFC-e da loja e dos eventos.' },
  { operacao: 'remessa_consignacao', natureza: 'Remessa de mercadoria em consignação mercantil', cfopDentro: '5917', cfopFora: '6917', csosn: '400', base: 'venda', observacao: 'Saída da maleta para a representante.' },
  { operacao: 'retorno_consignacao', natureza: 'Retorno de mercadoria remetida em consignação', cfopDentro: '1918', cfopFora: '2918', csosn: '400', base: 'venda', observacao: 'Nota de entrada das peças devolvidas no acerto.' },
  { operacao: 'venda_consignacao', natureza: 'Venda de mercadoria remetida em consignação', cfopDentro: '5114', cfopFora: '6114', csosn: '102', base: 'venda', observacao: 'Peças vendidas pela representante, apuradas no acerto.' },
  { operacao: 'retorno_simbolico', natureza: 'Retorno simbólico de mercadoria remetida em consignação', cfopDentro: '1919', cfopFora: '2919', csosn: '400', base: 'venda', observacao: 'Acompanha a nota de venda em consignação, se o contador exigir.' },
  { operacao: 'venda_revenda', natureza: 'Venda de mercadoria', cfopDentro: '5102', cfopFora: '6102', csosn: '102', base: 'venda', observacao: 'Venda para representante no modelo revenda.' },
];

/** Códigos de forma de pagamento da NF-e. */
const FORMA_SEFAZ: Record<string, string> = { dinheiro: '01', credito: '03', debito: '04', credito_loja: '05', boleto: '15', pix: '17' };

type ItemNota = { codigo: string; descricao: string; ncm: string | null; quantidade: number; valorUnitario: number; desconto?: number };

@Injectable()
export class FiscalService {
  private readonly log = new Logger('Fiscal');
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService, private readonly segredos: SegredosService) {}

  get configurado() {
    return !!this.segredos.v('FOCUS_NFE_TOKEN');
  }
  get ambiente() {
    return /\/\/api\.focusnfe\.com\.br/.test(this.url) ? 'produção' : 'homologação';
  }
  private get url() {
    if (this.segredos.origem('FOCUS_NFE_AMBIENTE') === 'tela') return this.segredos.v('FOCUS_NFE_AMBIENTE') === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br';
    return (process.env.FOCUS_NFE_URL ?? 'https://homologacao.focusnfe.com.br').replace(/\/$/, '');
  }

  /** Teste de conexão: consulta uma nota inexistente; 404 = token aceito, 401/403 = token recusado. */
  async testar() {
    const { status } = await this.focus('GET', '/v2/nfce/teste-de-conexao-aritana');
    if (status === 401 || status === 403) throw new BadRequestException('A Focus NFe recusou o token. Confira se é o token do ambiente escolhido.');
    return { ok: true, mensagem: `Token aceito pela Focus NFe (${this.ambiente}). Lembre de enviar o certificado A1 no painel da Focus.` };
  }

  private async focus(metodo: string, caminho: string, corpo?: unknown) {
    if (!this.configurado) throw new ServiceUnavailableException('O emissor fiscal ainda não foi ligado: falta o token da Focus NFe e o certificado digital da Aritana.');
    const r = await fetch(this.url + caminho, {
      method: metodo,
      headers: { authorization: `Basic ${Buffer.from(`${this.segredos.v('FOCUS_NFE_TOKEN')}:`).toString('base64')}`, 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, j };
  }

  async regras() {
    const salvas = await this.db.select().from(regrasFiscais);
    return REGRAS_FISCAIS_PADRAO.map((p) => ({ ...p, ...(salvas.find((s) => s.operacao === p.operacao) ?? {}), salva: salvas.some((s) => s.operacao === p.operacao) }));
  }

  private async regra(operacao: string) {
    const r = (await this.regras()).find((x) => x.operacao === operacao);
    if (!r) throw new BadRequestException(`Operação fiscal desconhecida: ${operacao}`);
    return r;
  }

  private async empresa(id: string) {
    const [e] = await this.db.select().from(empresas).where(eq(empresas.id, id));
    if (!e?.cnpj) throw new BadRequestException('Cadastre o CNPJ da empresa em Configurações › Empresas antes de emitir notas.');
    return e;
  }

  private itensFocus(itens: ItemNota[], cfop: string, csosn: string) {
    const semNcm = itens.filter((i) => !i.ncm).map((i) => i.codigo);
    if (semNcm.length) throw new BadRequestException(`Produtos sem NCM: ${semNcm.join(', ')}. Preencha o NCM no cadastro do produto.`);
    return itens.map((i, n) => ({
      numero_item: n + 1,
      codigo_produto: i.codigo,
      descricao: i.descricao.slice(0, 120),
      cfop,
      codigo_ncm: i.ncm,
      unidade_comercial: 'UN',
      quantidade_comercial: i.quantidade,
      valor_unitario_comercial: (i.valorUnitario / 100).toFixed(2),
      valor_bruto: ((i.valorUnitario * i.quantidade) / 100).toFixed(2),
      unidade_tributavel: 'UN',
      quantidade_tributavel: i.quantidade,
      valor_unitario_tributavel: (i.valorUnitario / 100).toFixed(2),
      ...(i.desconto ? { valor_desconto: (i.desconto / 100).toFixed(2) } : {}),
      icms_origem: 0,
      icms_situacao_tributaria: csosn,
      pis_situacao_tributaria: '07',
      cofins_situacao_tributaria: '07',
    }));
  }

  private destinatario(p: typeof pessoas.$inferSelect) {
    const pj = p.tipoDocumento === 'cnpj';
    return {
      nome_destinatario: p.nome,
      ...(pj ? { cnpj_destinatario: p.documento } : { cpf_destinatario: p.documento }),
      logradouro_destinatario: p.logradouro,
      numero_destinatario: p.numero ?? 'S/N',
      bairro_destinatario: p.bairro,
      municipio_destinatario: p.cidade,
      uf_destinatario: p.uf,
      cep_destinatario: p.cep,
      indicador_inscricao_estadual_destinatario: pj && p.inscricaoEstadual ? 1 : 9,
      ...(pj && p.inscricaoEstadual ? { inscricao_estadual_destinatario: p.inscricaoEstadual } : {}),
      email_destinatario: p.email ?? undefined,
    };
  }

  private async registrar(n: { empresaId: string; modelo: 'nfce' | 'nfe'; operacao: string; origemTipo: string; origemId: string; destinatarioId?: string | null; valor: number; payload: Record<string, unknown> }, usuarioId: string | null) {
    const ativas = await this.db
      .select({ id: notasFiscais.id, status: notasFiscais.status })
      .from(notasFiscais)
      .where(and(eq(notasFiscais.origemTipo, n.origemTipo), eq(notasFiscais.origemId, n.origemId), eq(notasFiscais.operacao, n.operacao), inArray(notasFiscais.status, ['pendente', 'processando', 'autorizada'])));
    if (ativas.length) throw new BadRequestException('Já existe uma nota desta operação para este documento.');
    const ref = `ari-${n.operacao.slice(0, 6)}-${randomBytes(6).toString('hex')}`;
    const [nota] = await this.db.insert(notasFiscais).values({ ...n, ref, usuarioId }).returning();
    return nota;
  }

  private async enviar(notaId: string) {
    const [nota] = await this.db.select().from(notasFiscais).where(eq(notasFiscais.id, notaId));
    const { status, j } = await this.focus('POST', `/v2/${nota.modelo}?ref=${nota.ref}`, nota.payload);
    return this.aplicarResposta(nota.id, status, j);
  }

  private async aplicarResposta(notaId: string, http: number, j: Record<string, unknown>) {
    const s = String(j.status ?? '');
    const mapa: Record<string, (typeof notasFiscais.$inferSelect)['status']> = {
      autorizado: 'autorizada',
      processando_autorizacao: 'processando',
      erro_autorizacao: 'erro',
      cancelado: 'cancelada',
      denegado: 'denegada',
    };
    const status = mapa[s] ?? (http >= 400 ? 'erro' : 'processando');
    const caminho = (v: unknown) => (typeof v === 'string' && v ? (v.startsWith('http') ? v : this.url + v) : null);
    const [r] = await this.db
      .update(notasFiscais)
      .set({
        status,
        numero: (j.numero as string) ?? undefined,
        serie: (j.serie as string) ?? undefined,
        chave: ((j.chave_nfe ?? j.chave_nfce) as string) ?? undefined,
        mensagem: String(j.mensagem_sefaz ?? j.mensagem ?? (status === 'erro' ? JSON.stringify(j.erros ?? j).slice(0, 500) : '')) || null,
        urlDanfe: caminho(j.caminho_danfe) ?? undefined,
        urlXml: caminho(j.caminho_xml_nota_fiscal) ?? undefined,
        resposta: j,
        atualizadoEm: new Date(),
      })
      .where(eq(notasFiscais.id, notaId))
      .returning();
    return r;
  }

  /** NFC-e de uma venda do caixa. */
  async emitirNfce(vendaId: string, usuarioId: string | null) {
    const [v] = await this.db.select().from(vendas).where(eq(vendas.id, vendaId));
    if (!v || v.status !== 'concluida') throw new NotFoundException('Venda não encontrada.');
    const emp = await this.empresa(v.empresaId);
    const regra = await this.regra(v.tipo === 'revenda' ? 'venda_revenda' : 'venda_consumidor');
    const itens = await this.db
      .select({ codigo: produtos.referencia, descricao: produtos.descricao, ncm: produtos.ncm, quantidade: vendaItens.quantidade, valorUnitario: vendaItens.preco, desconto: vendaItens.desconto })
      .from(vendaItens)
      .innerJoin(produtos, eq(produtos.id, vendaItens.produtoId))
      .where(eq(vendaItens.vendaId, vendaId));
    // Rateia o desconto geral nos itens, para a soma bater com o total.
    const descontoGeral = v.desconto - itens.reduce((a, i) => a + i.desconto, 0);
    if (descontoGeral > 0) {
      let resto = descontoGeral;
      itens.forEach((i, n) => {
        const parte = n === itens.length - 1 ? resto : Math.round((descontoGeral * (i.valorUnitario * i.quantidade - i.desconto)) / (v.subtotal - (v.desconto - descontoGeral)));
        i.desconto += parte;
        resto -= parte;
      });
    }
    const pags = await this.db.select().from(vendaPagamentos).where(eq(vendaPagamentos.vendaId, vendaId));
    let cliente: typeof pessoas.$inferSelect | undefined;
    if (v.clienteId) [cliente] = await this.db.select().from(pessoas).where(eq(pessoas.id, v.clienteId));
    const payload = {
      cnpj_emitente: emp.cnpj,
      data_emissao: new Date().toISOString(),
      natureza_operacao: regra.natureza,
      presenca_comprador: 1,
      modalidade_frete: 9,
      local_destino: 1,
      ...(cliente?.documento && cliente.tipoDocumento === 'cpf' ? { cpf_destinatario: cliente.documento, nome_destinatario: cliente.nome } : {}),
      items: this.itensFocus(itens, regra.cfopDentro, regra.csosn),
      formas_pagamento: pags.map((p) => ({ forma_pagamento: FORMA_SEFAZ[p.forma] ?? '99', valor_pagamento: (p.valor / 100).toFixed(2) })),
    };
    const nota = await this.registrar({ empresaId: v.empresaId, modelo: 'nfce', operacao: regra.operacao, origemTipo: 'venda', origemId: v.id, destinatarioId: v.clienteId, valor: v.total, payload }, usuarioId);
    await this.auditoria.registrar({ usuarioId, acao: 'emitir_nota', entidade: 'nota', entidadeId: nota.id, dados: { modelo: 'nfce', venda: v.numero } });
    return this.enviar(nota.id);
  }

  /** NF-e de remessa da maleta para a representante. */
  async emitirRemessaMaleta(maletaId: string, usuarioId: string | null) {
    const [m] = await this.db.select().from(maletas).where(eq(maletas.id, maletaId));
    if (!m) throw new NotFoundException('Maleta não encontrada.');
    const itens = await this.db
      .select({ codigo: produtos.referencia, descricao: produtos.descricao, ncm: produtos.ncm, quantidade: maletaItens.enviada, valorUnitario: maletaItens.preco })
      .from(maletaItens)
      .innerJoin(produtos, eq(produtos.id, maletaItens.produtoId))
      .where(and(eq(maletaItens.maletaId, maletaId), sql`${maletaItens.enviada} > 0`));
    return this.emitirNfe(m.empresaId, m.representanteId, 'remessa_consignacao', 'maleta', m.id, itens, usuarioId, `Maleta nº ${m.numero}`);
  }

  /** Notas do acerto: retorno das devolvidas e venda das vendidas pela representante. */
  async emitirAcerto(acertoId: string, operacao: 'retorno_consignacao' | 'venda_consignacao', usuarioId: string | null) {
    const [a] = await this.db.select().from(acertos).where(eq(acertos.id, acertoId));
    if (!a) throw new NotFoundException('Acerto não encontrado.');
    const [m] = await this.db.select().from(maletas).where(eq(maletas.id, a.maletaId));
    // Quantidades vêm do registro do estoque deste acerto (movimentos ligados à maleta na data do acerto).
    const tipoMov = operacao === 'retorno_consignacao' ? 'maleta_devolucao' : 'venda';
    const linhas = await this.db.execute<{ codigo: string; descricao: string; ncm: string | null; quantidade: number; valor_unitario: number }>(sql`
      select p.referencia as codigo, p.descricao, p.ncm, sum(mv.quantidade)::int as quantidade, mi.preco as valor_unitario
      from movimentos mv
      join produtos p on p.id = mv.produto_id
      join maleta_itens mi on mi.maleta_id = ${m.id} and mi.produto_id = mv.produto_id
      where mv.referencia_tipo = 'maleta' and mv.referencia_id = ${m.id} and mv.tipo = ${tipoMov}
        -- o acerto e os movimentos dele são gravados na mesma transação, com o mesmo horário
        and mv.criado_em = (select ac.criado_em from acertos ac where ac.id = ${a.id})
      group by p.referencia, p.descricao, p.ncm, mi.preco`);
    const itens: ItemNota[] = linhas.rows.map((r) => ({ codigo: r.codigo, descricao: r.descricao, ncm: r.ncm, quantidade: r.quantidade, valorUnitario: r.valor_unitario }));
    if (!itens.length) throw new BadRequestException(operacao === 'retorno_consignacao' ? 'Nenhuma peça devolvida neste acerto.' : 'Nenhuma peça vendida neste acerto.');
    return this.emitirNfe(m.empresaId, m.representanteId, operacao, 'acerto', a.id, itens, usuarioId, `Acerto da maleta nº ${m.numero}`);
  }

  private async emitirNfe(empresaId: string, pessoaId: string, operacao: string, origemTipo: string, origemId: string, itens: ItemNota[], usuarioId: string | null, info: string) {
    const emp = await this.empresa(empresaId);
    const regra = await this.regra(operacao);
    const [p] = await this.db.select().from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p?.documento || !p.logradouro || !p.cidade || !p.uf || !p.cep) throw new BadRequestException('O cadastro da representante precisa de CPF e endereço completo (rua, cidade, UF e CEP) para a nota.');
    const cfop = (p.uf ?? '').toUpperCase() === (emp.uf ?? '').toUpperCase() ? regra.cfopDentro : regra.cfopFora;
    const entrada = cfop.startsWith('1') || cfop.startsWith('2');
    const valor = itens.reduce((a, i) => a + i.valorUnitario * i.quantidade, 0);
    const payload = {
      cnpj_emitente: emp.cnpj,
      data_emissao: new Date().toISOString(),
      natureza_operacao: regra.natureza,
      tipo_documento: entrada ? 0 : 1,
      finalidade_emissao: 1,
      local_destino: cfop.startsWith('6') || cfop.startsWith('2') ? 2 : 1,
      consumidor_final: 1,
      presenca_comprador: 1,
      modalidade_frete: 9,
      ...this.destinatario(p),
      informacoes_adicionais_contribuinte: `${info}. ${regra.observacao ?? ''}`.trim(),
      items: this.itensFocus(itens, cfop, regra.csosn),
    };
    const nota = await this.registrar({ empresaId, modelo: 'nfe', operacao, origemTipo, origemId, destinatarioId: pessoaId, valor, payload }, usuarioId);
    await this.auditoria.registrar({ usuarioId, acao: 'emitir_nota', entidade: 'nota', entidadeId: nota.id, dados: { modelo: 'nfe', operacao } });
    return this.enviar(nota.id);
  }

  /** NF-e é processada de forma assíncrona: consulta a situação no emissor. */
  async consultar(notaId: string) {
    const [n] = await this.db.select().from(notasFiscais).where(eq(notasFiscais.id, notaId));
    if (!n) throw new NotFoundException('Nota não encontrada.');
    const { status, j } = await this.focus('GET', `/v2/${n.modelo}/${n.ref}`);
    return this.aplicarResposta(n.id, status, j);
  }

  async cancelar(notaId: string, justificativa: string, usuarioId: string) {
    const [n] = await this.db.select().from(notasFiscais).where(eq(notasFiscais.id, notaId));
    if (!n) throw new NotFoundException('Nota não encontrada.');
    if (n.status !== 'autorizada') throw new BadRequestException('Só notas autorizadas podem ser canceladas.');
    const { status, j } = await this.focus('DELETE', `/v2/${n.modelo}/${n.ref}`, { justificativa });
    const r = await this.aplicarResposta(n.id, status, { ...(n.resposta as object), ...j });
    await this.auditoria.registrar({ usuarioId, acao: 'cancelar_nota', entidade: 'nota', entidadeId: n.id, dados: { justificativa } });
    return r;
  }

  /** Tenta de novo uma nota com erro (depois de corrigir o cadastro), com nova referência. */
  async reenviar(notaId: string, usuarioId: string) {
    const [n] = await this.db.select().from(notasFiscais).where(eq(notasFiscais.id, notaId));
    if (!n || n.status !== 'erro') throw new BadRequestException('Só notas com erro podem ser reenviadas.');
    await this.db.update(notasFiscais).set({ status: 'cancelada', mensagem: `Substituída. ${n.mensagem ?? ''}` }).where(eq(notasFiscais.id, n.id));
    if (n.origemTipo === 'venda') return this.emitirNfce(n.origemId, usuarioId);
    if (n.origemTipo === 'maleta') return this.emitirRemessaMaleta(n.origemId, usuarioId);
    return this.emitirAcerto(n.origemId, n.operacao as 'retorno_consignacao', usuarioId);
  }
}
