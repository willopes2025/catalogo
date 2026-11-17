import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { SegredosService } from '../segredos/segredos.service';
import { ConsultasController } from '../consultas/consultas.controller';
import { cobrancaArquivosCra, cobrancaContatos, cobrancaProtestos, empresas, pessoas, titulos } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { CobrancaConfigService } from './cobranca-config.service';

/** O que cada código de ocorrência do retorno da CRA significa para o título. */
const OCORRENCIAS: Record<string, { status: string | null; texto: string }> = {
  '1': { status: 'pago', texto: 'Pago no cartório' },
  '2': { status: 'protestado', texto: 'Protestado' },
  '3': { status: 'retirado', texto: 'Retirado (desistência)' },
  '4': { status: 'sustado', texto: 'Sustado' },
  '5': { status: 'devolvido', texto: 'Devolvido pelo cartório por irregularidade, sem custas' },
  '6': { status: 'devolvido', texto: 'Devolvido pelo cartório por irregularidade, com custas' },
  '7': { status: 'pago', texto: 'Liquidação condicional' },
  '8': { status: null, texto: 'Título aceito' },
  '9': { status: 'protestado', texto: 'Edital' },
  A: { status: 'cancelado', texto: 'Protesto do banco cancelado' },
  B: { status: 'protestado', texto: 'Protesto já efetuado' },
  C: { status: 'protestado', texto: 'Protesto por edital' },
  D: { status: 'retirado', texto: 'Retirada por edital' },
  E: { status: 'cancelado', texto: 'Protesto de terceiro cancelado' },
  F: { status: 'retirado', texto: 'Desistência do protesto por liquidação bancária' },
  G: { status: 'sustado', texto: 'Sustado definitivo' },
  I: { status: null, texto: 'Emissão da 2ª via do instrumento de protesto' },
  J: { status: 'cancelado', texto: 'Cancelamento já efetuado anteriormente' },
  X: { status: null, texto: 'Cancelamento não efetuado' },
  Z: { status: 'devolvido', texto: 'Retirada por falta de prazo para repasse da guia' },
  W: { status: 'sustado', texto: 'Suspenso judicialmente' },
};

const ATIVOS = ['enviado', 'em_cartorio', 'protestado'];

/** Texto para os campos da CRA: maiúsculas, sem acento e sem caracteres especiais, cortado no tamanho do campo. */
const campo = (v: string | null | undefined, tam: number) =>
  (v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, tam);
const num = (v: string | number | null | undefined, tam: number) => String(v ?? '').replace(/\D/g, '').slice(-tam).padStart(tam, '0');
const valorCra = (c: number) => (c / 100).toFixed(2);
const ddmmaaaa = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(0, 4)}`;
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const desescapar = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/** Lê os atributos de cada <tr .../> de um arquivo de confirmação ou retorno. */
function lerRegistros(xml: string): Record<string, string>[] {
  const regs: Record<string, string>[] = [];
  for (const m of xml.matchAll(/<tr\b([^>]*)\/?>/gi)) {
    const r: Record<string, string> = {};
    for (const a of m[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) r[a[1].toLowerCase()] = desescapar(a[2]).trim();
    regs.push(r);
  }
  return regs;
}

/**
 * Protesto de títulos pela CRA21 (Central de Remessa de Arquivos), pelo webservice SOAP do manual do apresentante.
 * Envia a remessa, busca a confirmação (protocolo) e o retorno (protestado, pago, retirado…), e, quando o devedor
 * paga a Aritana, pede sozinho a desistência (antes do protesto) ou autoriza o cancelamento (depois).
 * Credenciais em Integrações › Protesto (CRA21); a CRA fornece usuário, senha e o código de apresentante.
 */
@Injectable()
export class CraService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Protesto');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly segredos: SegredosService,
    private readonly config: CobrancaConfigService,
    private readonly consultas: ConsultasController,
    private readonly auditoria: AuditoriaService,
  ) {}

  onModuleInit() {
    if (process.env.COBRANCA_AUTOMATICA === '0') return;
    this.timer = setInterval(() => void this.sincronizar().catch((e) => this.log.warn(`Sincronização: ${(e as Error).message}`)), 3 * 60 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  get configurado() {
    return !!(this.segredos.v('CRA_URL') && this.segredos.v('CRA_USUARIO') && this.segredos.v('CRA_SENHA') && this.segredos.v('CRA_CODIGO'));
  }
  private get codigo() {
    return (this.segredos.v('CRA_CODIGO') ?? '').trim();
  }

  /** Nome do arquivo no padrão da CRA: PREFIXO + código + DDMM + . + AA + sequencial. */
  private nomeArquivo(prefixo: string, data: string, seq: number) {
    return `${prefixo}${this.codigo}${data.slice(8, 10)}${data.slice(5, 7)}.${data.slice(2, 4)}${seq}`;
  }

  /** Chamada SOAP (rpc/encoded, como no serviço da CRA21). Devolve o texto do retorno. */
  private async soap(metodo: string, params: Record<string, string>): Promise<string> {
    if (!this.configurado) throw new ServiceUnavailableException({ mensagem: 'O protesto ainda não está ligado. Preencha os dados da CRA em Configurações › Integrações › Protesto (CRA21), depois do convênio.' });
    const url = this.segredos.v('CRA_URL')!.trim().replace(/\?wsdl$/i, '');
    const ns = `urn:${new URL(url).hostname}`;
    const corpo = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:ns1="${ns}" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><SOAP-ENV:Body><ns1:${metodo}>${Object.entries(params)
      .map(([k, v]) => `<${k} xsi:type="xsd:string">${attr(v)}</${k}>`)
      .join('')}</ns1:${metodo}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${ns}#${metodo}"`, authorization: `Basic ${Buffer.from(`${this.segredos.v('CRA_USUARIO')}:${this.segredos.v('CRA_SENHA')}`).toString('base64')}` },
        body: corpo,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ServiceUnavailableException({ mensagem: `A CRA não respondeu (${(e as Error).message}).` });
    }
    const texto = await res.text();
    if (res.status === 401) throw new ServiceUnavailableException({ mensagem: 'A CRA recusou o usuário e a senha. Confira em Configurações › Integrações › Protesto (CRA21).' });
    const falha = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(texto);
    if (falha || !res.ok) throw new BadRequestException({ mensagem: `A CRA recusou: ${desescapar(falha?.[1] ?? `erro ${res.status}`).slice(0, 300)}` });
    const ret = /<return\b[^>]*>([\s\S]*?)<\/return>/i.exec(texto);
    return ret ? desescapar(ret[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')) : '';
  }

  /** A resposta da CRA indica erro? (as mensagens vêm em texto; sucesso costuma vir com código 0000) */
  private recusou(resposta: string) {
    if (/codigo\s*=\s*"0+"|sucesso|recebid[oa]/i.test(resposta)) return null;
    const msg = /<(?:mensagem|descricao|erro)[^>]*>([\s\S]*?)</i.exec(resposta)?.[1] ?? (/(erro|inv[aá]lid|rejeitad|n[aã]o autorizad)/i.test(resposta) ? resposta : null);
    return msg ? desescapar(msg).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : null;
  }

  // ───────────── Conferência e envio ─────────────

  /** Confere se cada título pode ir a protesto e devolve o que falta. Não envia nada. */
  async conferir(tituloIds: string[]) {
    const cfg = await this.config.obter();
    const h = hoje();
    const linhas = await this.db.select({ t: titulos, p: pessoas }).from(titulos).leftJoin(pessoas, eq(pessoas.id, titulos.pessoaId)).where(inArray(titulos.id, tituloIds));
    const ativos = await this.db.select({ tituloId: cobrancaProtestos.tituloId }).from(cobrancaProtestos).where(and(inArray(cobrancaProtestos.tituloId, tituloIds), inArray(cobrancaProtestos.status, ATIVOS)));
    const itens = [];
    for (const { t, p } of linhas) {
      const problemas: string[] = [];
      const dias = Math.round((Date.parse(h) - Date.parse(t.vencimento)) / 86400_000);
      if (t.tipo !== 'receber' || t.status !== 'aberto') problemas.push(`O título está ${t.status}.`);
      if (dias < cfg.protesto.diasMinimos) problemas.push(`Venceu há ${Math.max(0, dias)} dias; o mínimo configurado é ${cfg.protesto.diasMinimos}.`);
      if (ativos.some((a) => a.tituloId === t.id)) problemas.push('Já está em protesto.');
      if (!p) problemas.push('O título não tem devedor.');
      else {
        const doc = (p.documento ?? '').replace(/\D/g, '');
        if (doc.length !== 11 && doc.length !== 14) problemas.push('O devedor está sem CPF ou CNPJ.');
        if (!p.logradouro?.trim()) problemas.push('Falta o endereço (rua) do devedor.');
        if (!p.cidade?.trim() || !p.uf?.trim()) problemas.push('Falta a cidade ou a UF do devedor.');
        if ((p.cep ?? '').replace(/\D/g, '').length !== 8) problemas.push('Falta o CEP do devedor.');
      }
      itens.push({ tituloId: t.id, descricao: t.descricao, valor: t.valor, vencimento: t.vencimento, dias, devedor: p?.nome ?? null, pessoaId: p?.id ?? null, problemas });
    }
    return { itens, prontos: itens.filter((i) => !i.problemas.length).length, configurado: this.configurado, especie: cfg.protesto.especie };
  }

  /** Monta a remessa (layout de remessa da CRA, em XML) com os títulos prontos e envia. */
  async enviar(usuarioId: string, tituloIds: string[], especie?: string) {
    const conf = await this.conferir(tituloIds);
    const comProblema = conf.itens.filter((i) => i.problemas.length);
    if (comProblema.length) throw new BadRequestException({ mensagem: `${comProblema.length} título(s) não podem ir a protesto. Confira a lista antes de enviar.`, itens: comProblema });
    if (!this.configurado) throw new ServiceUnavailableException({ mensagem: 'O protesto ainda não está ligado: falta o convênio com a CRA (usuário, senha e código de apresentante).' });
    const cfg = await this.config.obter();
    const esp = campo(especie || cfg.protesto.especie, 3);
    if (esp.length !== 3) throw new BadRequestException('A espécie do título tem 3 letras (ex.: DMI).');
    const linhas = await this.db.select({ t: titulos, p: pessoas, e: empresas }).from(titulos).innerJoin(pessoas, eq(pessoas.id, titulos.pessoaId)).innerJoin(empresas, eq(empresas.id, titulos.empresaId)).where(inArray(titulos.id, tituloIds));
    // A praça de pagamento é o município do devedor (código IBGE, pelo CEP).
    const porMunicipio = new Map<string, typeof linhas>();
    for (const l of linhas) {
      const ibge = await this.consultas.ibgeDoCep(l.p.cep ?? '');
      if (!ibge) throw new BadRequestException(`Não achei o município pelo CEP de ${l.p.nome} (${l.p.cep}). Confira o CEP no cadastro.`);
      porMunicipio.set(ibge, [...(porMunicipio.get(ibge) ?? []), l]);
    }
    const h = hoje();
    const [{ n }] = (await this.db.execute<{ n: number }>(sql`select count(*)::int as n from cobranca_arquivos_cra where tipo = 'remessa' and criado_em::date = ${h}::date`)).rows;
    if (n >= 9) throw new BadRequestException('A CRA aceita até 9 remessas por dia. Tente amanhã.');
    const nome = this.nomeArquivo('B', h, n + 1);
    const cod3 = this.codigo.length > 3 ? '999' : this.codigo.padStart(3, '0');
    // Os registros de protesto (para o número do título e o nosso número) são criados antes, numa transação com a remessa.
    const r = await this.db.transaction(async (tx) => {
      const [arq] = await tx.insert(cobrancaArquivosCra).values({ tipo: 'remessa', nome, conteudo: '', situacao: 'enviado', usuarioId }).returning();
      const comarcas: string[] = [];
      const criados: (typeof cobrancaProtestos.$inferSelect)[] = [];
      let somaTotal = 0;
      for (const [ibge, ls] of porMunicipio) {
        const trs: string[] = [];
        let seq = 1;
        let soma = 0;
        const hd = { h01: '0', h02: cod3, h03: campo(ls[0].e.razaoSocial ?? ls[0].e.nome, 40), h04: ddmmaaaa(h), h05: 'BFO', h06: 'SDT', h07: 'TPR', h08: num(n + 1, 6), h09: num(ls.length + 2, 4), h10: num(ls.length, 4), h11: num(esp.endsWith('I') ? ls.length : 0, 4), h12: num(esp.endsWith('I') ? 0 : ls.length, 4), h13: this.codigo.length > 3 ? campo(this.codigo, 6) : '', h14: '043', h15: num(ibge, 7), h16: this.codigo.length > 3 ? campo(this.codigo, 497) : '', h17: num(seq++, 4) };
        for (const { t, p, e } of ls) {
          const [pr] = await tx.insert(cobrancaProtestos).values({ tituloId: t.id, pessoaId: p.id, valor: t.valor, especie: esp, codMunicipio: ibge, remessaId: arq.id, usuarioId, historico: [{ em: new Date().toISOString(), texto: `Enviado à CRA no arquivo ${nome}.` }] }).returning();
          criados.push(pr);
          const doc = (p.documento ?? '').replace(/\D/g, '');
          const endereco = [p.logradouro, p.numero, p.complemento].filter(Boolean).join(' ');
          soma += t.valor;
          trs.push(
            `<tr ${Object.entries({
              t01: '1', t02: cod3, t03: campo(num(e.cnpj, 14), 15), t04: campo(e.razaoSocial ?? e.nome, 45), t05: campo(e.razaoSocial ?? e.nome, 45), t06: num(e.cnpj, 14), t07: '', t08: '00000000', t09: campo(e.cidade, 20), t10: campo(e.uf, 2),
              t11: num(pr.numero, 15), t12: esp, t13: num(pr.numero, 11), t14: ddmmaaaa((t.criadoEm ?? new Date()).toISOString().slice(0, 10)), t15: ddmmaaaa(t.vencimento), t16: '001', t17: valorCra(t.valor), t18: valorCra(t.valor), t19: campo(p.cidade, 20), t20: '', t21: 'N', t22: '1',
              t23: campo(p.nome, 45), t24: doc.length === 14 ? '001' : '002', t25: num(doc, 14), t26: '', t27: campo(endereco, 45), t28: num(p.cep, 8), t29: campo(p.cidade, 20), t30: campo(p.uf, 2),
              t31: '00', t32: '', t33: '', t34: '00000000', t35: '0.00', t36: '', t37: '00000000', t38: '', t39: campo(p.bairro, 20), t40: '0.00', t41: '000000', t42: '0.00', t43: '0', t44: '0', t45: '0', t46: '0', t47: '', t48: '', t49: '', t50: '0.00', t52: num(seq++, 4),
              ...(p.telefone1 ? { t53: (p.telefone1 ?? '').replace(/\D/g, '') } : {}),
              ...(p.email ? { t54: campo(p.email, 60).toLowerCase() } : {}),
            })
              .map(([k, v]) => `${k}="${attr(v)}"`)
              .join(' ')}/>`,
          );
        }
        somaTotal += soma;
        const tl = { t01: '9', t02: cod3, t03: hd.h03, t04: hd.h04, t05: num(Number(hd.h09) + Number(hd.h10) + Number(hd.h11) + Number(hd.h12), 5), t06: valorCra(soma), t07: '', t08: num(seq, 4) };
        comarcas.push(`<comarca CodMun="${ibge}"><hd ${Object.entries(hd).map(([k, v]) => `${k}="${attr(v)}"`).join(' ')}/>${trs.join('')}<tl ${Object.entries(tl).map(([k, v]) => `${k}="${attr(v)}"`).join(' ')}/></comarca>`);
      }
      const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><remessa><nome_arquivo>${nome}</nome_arquivo>${comarcas.join('')}</remessa>`;
      await tx.update(cobrancaArquivosCra).set({ conteudo: xml }).where(eq(cobrancaArquivosCra.id, arq.id));
      return { arq, xml, criados, somaTotal };
    });
    let resposta = '';
    let erro: string | null = null;
    try {
      resposta = await this.soap('Remessa', { userArq: nome, userDados: r.xml });
      erro = this.recusou(resposta);
    } catch (e) {
      erro = ((e as { response?: { mensagem?: string } }).response?.mensagem ?? (e as Error).message).slice(0, 400);
    }
    await this.db.update(cobrancaArquivosCra).set({ situacao: erro ? 'recusado' : 'enviado', resposta: resposta || erro }).where(eq(cobrancaArquivosCra.id, r.arq.id));
    if (erro) {
      await this.db.update(cobrancaProtestos).set({ status: 'recusado', historico: sql`${cobrancaProtestos.historico} || ${JSON.stringify([{ em: new Date().toISOString(), texto: `A CRA recusou a remessa: ${erro}` }])}::jsonb`, atualizadoEm: new Date() }).where(eq(cobrancaProtestos.remessaId, r.arq.id));
      throw new BadRequestException({ mensagem: `A CRA recusou a remessa: ${erro}` });
    }
    for (const pr of r.criados) await this.db.insert(cobrancaContatos).values({ pessoaId: pr.pessoaId, usuarioId, tipo: 'sistema', texto: `Título enviado a protesto (nº ${pr.numero}, arquivo ${nome}).` });
    await this.auditoria.registrar({ usuarioId, acao: 'enviar_protesto', entidade: 'cobranca', dados: { arquivo: nome, titulos: tituloIds.length, valor: r.somaTotal } });
    return { arquivo: nome, titulos: r.criados.length, valor: r.somaTotal, resposta: resposta.slice(0, 500) };
  }

  // ───────────── Confirmação, retorno e pedidos ─────────────

  private async registrar(pr: typeof cobrancaProtestos.$inferSelect, mudanca: Partial<typeof cobrancaProtestos.$inferInsert>, texto: string) {
    await this.db
      .update(cobrancaProtestos)
      .set({ ...mudanca, historico: sql`${cobrancaProtestos.historico} || ${JSON.stringify([{ em: new Date().toISOString(), texto }])}::jsonb`, atualizadoEm: new Date() })
      .where(eq(cobrancaProtestos.id, pr.id));
    await this.db.insert(cobrancaContatos).values({ pessoaId: pr.pessoaId, tipo: 'sistema', texto: `Protesto nº ${pr.numero}: ${texto}` });
  }

  /** Aplica os registros de um arquivo de confirmação ou de retorno. */
  private async aplicar(tipo: 'confirmacao' | 'retorno', xml: string) {
    let atualizados = 0;
    for (const r of lerRegistros(xml)) {
      const numero = Number((r.t11 || r.t13 || '').replace(/\D/g, ''));
      if (!numero) continue;
      const [pr] = await this.db.select().from(cobrancaProtestos).where(eq(cobrancaProtestos.numero, numero));
      if (!pr) continue;
      const base = { cartorio: r.t31 && r.t31 !== '00' ? r.t31 : pr.cartorio, protocolo: r.t32 || pr.protocolo, dataProtocolo: r.t34 && r.t34 !== '00000000' ? r.t34 : pr.dataProtocolo, custas: r.t35 ? Math.round(Number(r.t35) * 100) || pr.custas : pr.custas };
      const irregular = (r.t38 ?? '').trim();
      const ocorrencia = (r.t33 ?? '').trim().toUpperCase();
      if (tipo === 'confirmacao') {
        if (irregular) {
          if (pr.status === 'devolvido') continue;
          await this.registrar(pr, { ...base, status: 'devolvido', irregularidade: irregular }, `Devolvido pela CRA/cartório por irregularidade (código ${irregular}).`);
        } else if (pr.status === 'enviado' && base.protocolo) {
          await this.registrar(pr, { ...base, status: 'em_cartorio' }, `Protocolado no cartório ${base.cartorio ?? ''} (protocolo ${base.protocolo}).`);
        } else continue;
        atualizados++;
        continue;
      }
      const o = OCORRENCIAS[ocorrencia];
      if (!o || pr.ocorrencia === ocorrencia) continue;
      await this.registrar(pr, { ...base, ocorrencia, ...(o.status ? { status: o.status } : {}), ...(irregular ? { irregularidade: irregular } : {}) }, `${o.texto}${irregular ? ` (irregularidade ${irregular})` : ''}.`);
      // O título acompanha: protestado continua devido; pago no cartório dá baixa; retirado/devolvido volta a aberto.
      const dataOc = r.t37 && /^\d{8}$/.test(r.t37) && r.t37 !== '00000000' ? `${r.t37.slice(4, 8)}-${r.t37.slice(2, 4)}-${r.t37.slice(0, 2)}` : hoje();
      if (o.status === 'protestado') await this.db.update(titulos).set({ status: 'protestado' }).where(and(eq(titulos.id, pr.tituloId), eq(titulos.status, 'aberto')));
      else if (o.status === 'pago') await this.db.update(titulos).set({ status: 'pago', pagoEm: dataOc, valorPago: pr.valor, formaPagamento: 'cartorio' }).where(and(eq(titulos.id, pr.tituloId), inArray(titulos.status, ['aberto', 'protestado'])));
      else if (o.status === 'cancelado' || o.status === 'retirado' || o.status === 'devolvido' || o.status === 'sustado') await this.db.update(titulos).set({ status: 'aberto' }).where(and(eq(titulos.id, pr.tituloId), eq(titulos.status, 'protestado')));
      atualizados++;
    }
    return atualizados;
  }

  /** Busca confirmações e retornos dos dias com protesto em andamento e faz os pedidos automáticos. */
  async sincronizar() {
    if (!this.configurado) return { buscados: 0, atualizados: 0, pedidos: 0 };
    const [mais] = await this.db.select({ d: sql<string | null>`min(${cobrancaProtestos.criadoEm})::date::text` }).from(cobrancaProtestos).where(inArray(cobrancaProtestos.status, ['enviado', 'em_cartorio', 'protestado']));
    let buscados = 0;
    let atualizados = 0;
    if (mais?.d) {
      const h = hoje();
      // Os arquivos são por data: busca de 1 dia antes do envio mais antigo em andamento até hoje (no máximo 60 dias).
      let d = new Date(Math.max(Date.parse(mais.d) - 86400_000, Date.now() - 60 * 86400_000)).toISOString().slice(0, 10);
      while (d <= h) {
        for (const [tipo, prefixo] of [['confirmacao', 'C'], ['retorno', 'R']] as const) {
          const nome = this.nomeArquivo(prefixo, d, 1);
          let xml = '';
          try {
            xml = await this.soap(tipo === 'confirmacao' ? 'Confirmacao' : 'Retorno', { userArq: nome });
          } catch (e) {
            this.log.warn(`${nome}: ${(e as Error).message}`);
            continue;
          }
          buscados++;
          if (!/<tr\b/i.test(xml)) continue;
          const n = await this.aplicar(tipo, xml);
          if (n) {
            atualizados += n;
            await this.db.insert(cobrancaArquivosCra).values({ tipo, nome, conteudo: xml, situacao: 'recebido' });
          }
        }
        d = new Date(Date.parse(d) + 86400_000).toISOString().slice(0, 10);
      }
    }
    const pedidos = await this.pedidosAutomaticos();
    return { buscados, atualizados, pedidos };
  }

  /**
   * Devedor pagou a Aritana (boleto, acordo quitado ou baixa manual): se o título ainda está no cartório, pede a desistência;
   * se já foi protestado, autoriza o cancelamento do protesto.
   */
  async pedidosAutomaticos() {
    const pendentes = await this.db
      .select({ pr: cobrancaProtestos, t: titulos })
      .from(cobrancaProtestos)
      .innerJoin(titulos, eq(titulos.id, cobrancaProtestos.tituloId))
      .where(
        and(
          inArray(cobrancaProtestos.status, ['em_cartorio', 'protestado']),
          isNull(cobrancaProtestos.pedido),
          sql`(${titulos.status} = 'pago' and coalesce(${titulos.formaPagamento}, '') <> 'cartorio' and ${titulos.valor} >= ${cobrancaProtestos.valor}) or (${titulos.status} = 'renegociado' and exists (select 1 from cobranca_acordos a where a.id = ${titulos.renegociadoAcordoId} and a.status = 'quitado'))`,
        ),
      );
    let feitos = 0;
    for (const { pr } of pendentes) {
      try {
        await this.pedir(pr.id, pr.status === 'protestado' ? 'autoriza_cancelamento' : 'desistencia', null, 'O devedor pagou à Aritana.');
        feitos++;
      } catch (e) {
        this.log.warn(`Pedido do protesto nº ${pr.numero}: ${(e as Error).message}`);
      }
    }
    return feitos;
  }

  /** Desistência (título ainda no cartório) ou autorização de cancelamento (já protestado). */
  async pedir(protestoId: string, tipo: 'desistencia' | 'autoriza_cancelamento', usuarioId: string | null, motivo: string) {
    const [pr] = await this.db.select({ pr: cobrancaProtestos, p: pessoas }).from(cobrancaProtestos).innerJoin(pessoas, eq(pessoas.id, cobrancaProtestos.pessoaId)).where(eq(cobrancaProtestos.id, protestoId));
    if (!pr) throw new BadRequestException('Protesto não encontrado.');
    if (pr.pr.pedido) throw new BadRequestException('Este pedido já foi feito.');
    if (tipo === 'desistencia' && pr.pr.status !== 'em_cartorio') throw new BadRequestException('A desistência é para título que está no cartório e ainda não foi protestado.');
    if (tipo === 'autoriza_cancelamento' && pr.pr.status !== 'protestado') throw new BadRequestException('A autorização de cancelamento é para título já protestado.');
    if (!pr.pr.protocolo || !pr.pr.dataProtocolo) throw new BadRequestException('A CRA ainda não informou o protocolo deste título.');
    const h = hoje();
    const prefixo = tipo === 'desistencia' ? 'DP' : 'AC';
    const [{ n }] = (await this.db.execute<{ n: number }>(sql`select count(*)::int as n from cobranca_arquivos_cra where tipo = ${tipo} and criado_em::date = ${h}::date`)).rows;
    const nome = this.nomeArquivo(prefixo, h, n + 1);
    const raiz = tipo === 'desistencia' ? 'desistencia' : 'autoriza_cancelamento';
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><${raiz}><comarca><CodMun>${num(pr.pr.codMunicipio, 7)}</CodMun><cartorio><numero_cartorio>${num(pr.pr.cartorio, 2)}</numero_cartorio><titulo><numero_protocolo>${num(pr.pr.protocolo, 10)}</numero_protocolo><data_protocolo>${num(pr.pr.dataProtocolo, 8)}</data_protocolo><numero_titulo>${num(pr.pr.numero, 11)}</numero_titulo><nome_devedor>${attr(campo(pr.p.nome, 45))}</nome_devedor><valor_titulo>${valorCra(pr.pr.valor)}</valor_titulo></titulo></cartorio></comarca></${raiz}>`;
    const resposta = await this.soap(tipo === 'desistencia' ? 'Desistencia' : 'Autoriza_Cancelamento', { userArq: nome, userDados: xml });
    const erro = this.recusou(resposta);
    await this.db.insert(cobrancaArquivosCra).values({ tipo, nome, conteudo: xml, situacao: erro ? 'recusado' : 'enviado', resposta, usuarioId });
    if (erro) throw new BadRequestException({ mensagem: `A CRA recusou o pedido: ${erro}` });
    await this.registrar(pr.pr, { pedido: tipo, pedidoEm: new Date() }, `${tipo === 'desistencia' ? 'Desistência pedida' : 'Cancelamento autorizado'} (arquivo ${nome}). ${motivo}`);
    await this.auditoria.registrar({ usuarioId, acao: tipo, entidade: 'cobranca_protesto', entidadeId: pr.pr.id, dados: { arquivo: nome, motivo } });
    return { ok: true, arquivo: nome };
  }

  async listar(status?: string) {
    return this.db
      .select({
        id: cobrancaProtestos.id, numero: cobrancaProtestos.numero, status: cobrancaProtestos.status, valor: cobrancaProtestos.valor, especie: cobrancaProtestos.especie,
        cartorio: cobrancaProtestos.cartorio, protocolo: cobrancaProtestos.protocolo, ocorrencia: cobrancaProtestos.ocorrencia, irregularidade: cobrancaProtestos.irregularidade, custas: cobrancaProtestos.custas,
        pedido: cobrancaProtestos.pedido, criadoEm: cobrancaProtestos.criadoEm, atualizadoEm: cobrancaProtestos.atualizadoEm, historico: cobrancaProtestos.historico,
        tituloId: titulos.id, descricao: titulos.descricao, vencimento: titulos.vencimento, tituloStatus: titulos.status, pessoaId: pessoas.id, nome: pessoas.nome,
      })
      .from(cobrancaProtestos)
      .innerJoin(titulos, eq(titulos.id, cobrancaProtestos.tituloId))
      .innerJoin(pessoas, eq(pessoas.id, cobrancaProtestos.pessoaId))
      .where(status ? eq(cobrancaProtestos.status, status) : undefined)
      .orderBy(sql`${cobrancaProtestos.atualizadoEm} desc`)
      .limit(300);
  }

  async arquivos() {
    return this.db.select({ id: cobrancaArquivosCra.id, tipo: cobrancaArquivosCra.tipo, nome: cobrancaArquivosCra.nome, situacao: cobrancaArquivosCra.situacao, resposta: cobrancaArquivosCra.resposta, criadoEm: cobrancaArquivosCra.criadoEm }).from(cobrancaArquivosCra).orderBy(sql`${cobrancaArquivosCra.criadoEm} desc`).limit(100);
  }

  /** XML de um arquivo, para conferir na homologação. */
  async arquivo(id: string) {
    const [a] = await this.db.select().from(cobrancaArquivosCra).where(eq(cobrancaArquivosCra.id, id));
    if (!a) throw new BadRequestException('Arquivo não encontrado.');
    return a;
  }
}

export const NOMES_OCORRENCIA = Object.fromEntries(Object.entries(OCORRENCIAS).map(([k, v]) => [k, v.texto]));
