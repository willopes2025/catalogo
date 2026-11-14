import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { formatarReais, preencherModelo, reaisPorExtenso, type RegrasConsignado } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { EmailService } from '../integracoes/email.service';
import { cpfValido, soDigitos } from '../comum/documentos';
import { documentos, empresas, maletaItens, maletas, modelosDocumento, pessoas } from '../db/schema';

type TipoDoc = 'contrato' | 'promissoria' | 'aditivo';

const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const pctTexto = (pb: number) => `${(pb / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const dataBR = (d: string | Date) => {
  const s = typeof d === 'string' ? d : new Date(d.getTime() - 3 * 3600_000).toISOString();
  const [a, m, dia] = s.slice(0, 10).split('-');
  return `${dia}/${m}/${a}`;
};
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const mascararEmail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');

export const VARIAVEIS = [
  ['nome', 'Nome completo'], ['cpf', 'CPF'], ['rg', 'RG'], ['endereco', 'Endereço (rua, número, bairro)'], ['cidade', 'Cidade'], ['uf', 'UF'], ['cep', 'CEP'],
  ['telefone', 'Telefone'], ['email', 'E-mail'], ['modelo_trabalho', 'Modelo de trabalho'],
  ['empresa_nome', 'Razão social da Aritana'], ['empresa_cnpj', 'CNPJ da Aritana'], ['empresa_cidade', 'Cidade da Aritana'],
  ['data', 'Data de hoje (dd/mm/aaaa)'], ['data_extenso', 'Data de hoje por extenso'],
  ['prazo_acerto', 'Prazo do acerto em dias'], ['comissao', 'Comissão (texto completo)'], ['comissao_avista', 'Comissão à vista'], ['comissao_prazo', 'Comissão a prazo'],
  ['regra_atraso', 'Regra de multa e juros (texto completo)'], ['multa', 'Multa por atraso'], ['juros', 'Juros ao mês'], ['carencia', 'Carência em dias'], ['dias_bloqueio', 'Regra de bloqueio por atraso'],
  ['perdida', 'Como a peça perdida é cobrada'], ['limite', 'Limite de crédito'], ['limite_extenso', 'Limite por extenso'],
  ['maleta_numero', 'Número da maleta'], ['maleta_pecas', 'Peças na maleta'], ['maleta_valor', 'Valor da maleta'], ['maleta_valor_extenso', 'Valor da maleta por extenso'],
  ['maleta_data_retirada', 'Data da retirada'], ['maleta_data_limite', 'Data limite do acerto'],
] as const;

@Injectable()
export class DocumentosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfiguracoesService,
    private readonly email: EmailService,
    private readonly auditoria: AuditoriaService,
  ) {}

  private async valores(tx: Tx | Db, pessoaId: string, maletaId: string | null, regras: RegrasConsignado) {
    const [p] = await tx.select().from(pessoas).where(eq(pessoas.id, pessoaId));
    if (!p) throw new NotFoundException('Pessoa não encontrada.');
    const [emp] = await tx.select().from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    const hoje = new Date(Date.now() - 3 * 3600_000);
    const v: Record<string, string | null> = {
      nome: p.nome,
      cpf: p.documento ? p.documento.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : null,
      rg: p.rg,
      endereco: [p.logradouro, p.numero, p.complemento, p.bairro].filter(Boolean).join(', ') || null,
      cidade: p.cidade,
      uf: p.uf,
      cep: p.cep,
      telefone: p.telefone1,
      email: p.email,
      modelo_trabalho: p.modeloTrabalho === 'consignado' ? 'consignado' : p.modeloTrabalho === 'revenda' ? 'revenda' : p.modeloTrabalho === 'afiliado' ? 'afiliada' : null,
      empresa_nome: emp?.razaoSocial ?? emp?.nome ?? null,
      empresa_cnpj: emp?.cnpj ? emp.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : null,
      empresa_cidade: [emp?.cidade, emp?.uf].filter(Boolean).join('/') || null,
      data: dataBR(hoje),
      data_extenso: `${hoje.getUTCDate()} de ${MESES[hoje.getUTCMonth()]} de ${hoje.getUTCFullYear()}`,
      prazo_acerto: String(regras.prazoAcertoDias),
      comissao: regras.comissaoAvistaPb === regras.comissaoPrazoPb
        ? `${pctTexto(regras.comissaoAvistaPb)} sobre o valor vendido`
        : `${pctTexto(regras.comissaoAvistaPb)} sobre o valor vendido quando o acerto for pago à vista, e de ${pctTexto(regras.comissaoPrazoPb)} quando for pago a prazo`,
      comissao_avista: pctTexto(regras.comissaoAvistaPb),
      comissao_prazo: pctTexto(regras.comissaoPrazoPb),
      regra_atraso: regras.multaAtrasoPb > 0 || regras.jurosMesPb > 0
        ? `O acerto feito depois do prazo, passada a tolerância de ${regras.carenciaDias} dia(s), terá multa de ${pctTexto(regras.multaAtrasoPb)} e juros de ${pctTexto(regras.jurosMesPb)} ao mês, proporcionais aos dias de atraso, sobre o valor devido.`
        : 'O acerto feito depois do prazo não terá multa nem juros, mas a Representante deve regularizá-lo assim que for avisada.',
      multa: pctTexto(regras.multaAtrasoPb),
      juros: pctTexto(regras.jurosMesPb),
      carencia: String(regras.carenciaDias),
      dias_bloqueio: regras.diasParaBloquear > 0 ? `a partir de ${regras.diasParaBloquear} dias de atraso, a Representante não poderá retirar nova maleta até regularizar` : 'não há bloqueio automático; a Consignante avisará a Representante da pendência',
      perdida: regras.perdidaPeloCusto ? 'pelo preço de custo' : 'pelo preço de venda',
      limite: formatarReais(p.limiteCredito),
      limite_extenso: reaisPorExtenso(p.limiteCredito),
    };
    if (maletaId) {
      const [m] = await tx.select().from(maletas).where(eq(maletas.id, maletaId));
      if (!m || m.representanteId !== pessoaId) throw new BadRequestException('Maleta não pertence a esta representante.');
      const [t] = await tx
        .select({ pecas: sql<number>`coalesce(sum(${maletaItens.enviada}),0)::int`, valor: sql<number>`coalesce(sum(${maletaItens.enviada} * ${maletaItens.preco}),0)::int` })
        .from(maletaItens)
        .where(eq(maletaItens.maletaId, maletaId));
      Object.assign(v, {
        maleta_numero: String(m.numero),
        maleta_pecas: String(t.pecas),
        maleta_valor: formatarReais(t.valor),
        maleta_valor_extenso: reaisPorExtenso(t.valor),
        maleta_data_retirada: dataBR(m.dataRetirada),
        maleta_data_limite: dataBR(m.dataLimite),
      });
    }
    return { pessoa: p, valores: v };
  }

  /** Escolhe o modelo ativo do tipo, preferindo o específico do modelo de trabalho da pessoa. */
  private async modeloPara(tx: Tx | Db, tipo: TipoDoc, modeloTrabalho: string | null, modeloId?: string) {
    if (modeloId) {
      const [m] = await tx.select().from(modelosDocumento).where(eq(modelosDocumento.id, modeloId));
      if (!m || !m.ativo) throw new NotFoundException('Modelo de documento não encontrado ou inativo.');
      return m;
    }
    const lista = await tx
      .select()
      .from(modelosDocumento)
      .where(and(eq(modelosDocumento.tipo, tipo), eq(modelosDocumento.ativo, true), modeloTrabalho ? or(eq(modelosDocumento.modeloTrabalho, modeloTrabalho as 'consignado'), isNull(modelosDocumento.modeloTrabalho)) : isNull(modelosDocumento.modeloTrabalho)))
      .orderBy(desc(modelosDocumento.modeloTrabalho), desc(modelosDocumento.versao));
    return lista[0] ?? null;
  }

  async gerar(tx: Tx | Db, d: { pessoaId: string; tipo: TipoDoc; maletaId?: string | null; modeloId?: string }, usuarioId: string | null, exigirModelo = true) {
    const regras = await this.config.regrasDaRepresentante(d.pessoaId, tx as Tx);
    const { pessoa, valores } = await this.valores(tx, d.pessoaId, d.maletaId ?? null, regras);
    const modelo = await this.modeloPara(tx, d.tipo, pessoa.modeloTrabalho, d.modeloId);
    if (!modelo) {
      if (exigirModelo) throw new BadRequestException(`Não há modelo de ${d.tipo} ativo. Cadastre em Configurações › Modelos de documento.`);
      return null;
    }
    const conteudo = preencherModelo(modelo.conteudo, valores);
    const titulo = preencherModelo(modelo.titulo, valores);
    // Um documento pendente do mesmo tipo e maleta é substituído pelo novo.
    await tx
      .update(documentos)
      .set({ status: 'cancelado' })
      .where(and(eq(documentos.pessoaId, d.pessoaId), eq(documentos.tipo, d.tipo), eq(documentos.status, 'pendente'), d.maletaId ? eq(documentos.maletaId, d.maletaId) : isNull(documentos.maletaId)));
    const [doc] = await tx
      .insert(documentos)
      .values({
        tipo: d.tipo,
        pessoaId: d.pessoaId,
        maletaId: d.maletaId ?? null,
        modeloId: modelo.id,
        titulo,
        conteudo,
        hash: sha256(`${titulo}\n\n${conteudo}`),
        token: randomBytes(24).toString('base64url'),
        enviadoPara: pessoa.email,
        usuarioId,
      })
      .returning();
    await this.auditoria.registrar({ usuarioId, acao: 'gerar_documento', entidade: 'documento', entidadeId: doc.id, dados: { tipo: d.tipo, modelo: modelo.id, versao: modelo.versao } }, tx as Tx);
    return doc;
  }

  private async porToken(token: string) {
    if (!/^[A-Za-z0-9_-]{30,40}$/.test(token)) throw new NotFoundException('Link inválido.');
    const [d] = await this.db.select({ d: documentos, nome: pessoas.nome, email: pessoas.email, cpf: pessoas.documento }).from(documentos).innerJoin(pessoas, eq(pessoas.id, documentos.pessoaId)).where(eq(documentos.token, token));
    if (!d) throw new NotFoundException('Link inválido ou expirado.');
    return d;
  }

  async verPublico(token: string) {
    const { d, nome, email, cpf } = await this.porToken(token);
    if (d.status === 'pendente' && !d.visualizadoEm) await this.db.update(documentos).set({ visualizadoEm: new Date() }).where(eq(documentos.id, d.id));
    return {
      titulo: d.titulo,
      conteudo: d.conteudo,
      tipo: d.tipo,
      status: d.status,
      hash: d.hash,
      nome,
      emailMascarado: email ? mascararEmail(email) : null,
      pedeCpf: !!cpf,
      assinadoEm: d.assinadoEm,
      assinaturaNome: d.assinaturaNome,
    };
  }

  async enviarCodigo(token: string) {
    const { d, email, nome } = await this.porToken(token);
    if (d.status !== 'pendente') throw new BadRequestException(`Este documento está ${d.status}.`);
    if (!email) throw new BadRequestException('Não há e-mail no cadastro. Peça à Aritana para atualizar o seu e-mail.');
    if (d.codigoExpiraEm && d.codigoExpiraEm.getTime() - 14 * 60_000 > Date.now()) throw new BadRequestException('Aguarde um minuto para pedir um novo código.');
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.update(documentos).set({ codigoHash: sha256(`${d.token}:${codigo}`), codigoExpiraEm: new Date(Date.now() + 15 * 60_000), tentativas: 0 }).where(eq(documentos.id, d.id));
    const r = await this.email.enviar(email, `Código para assinar: ${d.titulo}`, `Olá, ${nome.split(' ')[0]}!\n\nSeu código para assinar "${d.titulo}" é: ${codigo}\n\nEle vale por 15 minutos. Se você não pediu este código, ignore esta mensagem.\n\nAritana Semijoias`);
    // Sem SMTP em desenvolvimento, devolve o código para permitir testar. Nunca em produção.
    return { enviadoPara: mascararEmail(email), ...(r.simulado && process.env.NODE_ENV !== 'production' ? { codigoDev: codigo } : {}) };
  }

  async assinar(token: string, dados: { codigo: string; nome: string; cpf?: string; aceite: boolean }, ip: string | null, userAgent: string | null) {
    const { d, nome, cpf, email } = await this.porToken(token);
    if (d.status !== 'pendente') throw new BadRequestException(`Este documento está ${d.status}.`);
    if (!dados.aceite) throw new BadRequestException('É preciso marcar que leu e concorda.');
    if (!d.codigoHash || !d.codigoExpiraEm || d.codigoExpiraEm.getTime() < Date.now()) throw new BadRequestException('Código expirado. Peça um novo código.');
    if (d.tentativas >= 5) throw new ForbiddenException('Muitas tentativas. Peça um novo código.');
    const esperado = Buffer.from(d.codigoHash, 'hex');
    const recebido = Buffer.from(sha256(`${d.token}:${dados.codigo.trim()}`), 'hex');
    if (!timingSafeEqual(esperado, recebido)) {
      await this.db.update(documentos).set({ tentativas: d.tentativas + 1 }).where(eq(documentos.id, d.id));
      throw new BadRequestException(`Código incorreto. Restam ${4 - d.tentativas} tentativa(s).`);
    }
    if (cpf) {
      const informado = soDigitos(dados.cpf);
      if (!cpfValido(informado) || informado !== cpf) throw new BadRequestException('O CPF informado não confere com o cadastro.');
    }
    const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (normal(dados.nome) !== normal(nome)) throw new BadRequestException('Digite o seu nome completo, igual ao do cadastro.');

    const assinadoEm = new Date();
    await this.db
      .update(documentos)
      .set({ status: 'assinado', assinadoEm, assinaturaNome: dados.nome.trim(), assinaturaDocumento: cpf ?? null, ip, userAgent: userAgent?.slice(0, 300) ?? null, codigoHash: null })
      .where(eq(documentos.id, d.id));
    await this.auditoria.registrar({ usuarioId: null, acao: 'assinar', entidade: 'documento', entidadeId: d.id, dados: { ip, hash: d.hash } });
    if (email) {
      await this.email
        .enviar(email, `Documento assinado: ${d.titulo}`, `Olá, ${nome.split(' ')[0]}!\n\nVocê assinou "${d.titulo}" em ${assinadoEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.\nCódigo de verificação do documento (SHA-256): ${d.hash}\n\nAritana Semijoias`)
        .catch(() => undefined);
    }
    return { ok: true, assinadoEm, hash: d.hash };
  }

  async obter(id: string) {
    const [d] = await this.db.select({ d: documentos, pessoa: pessoas.nome }).from(documentos).innerJoin(pessoas, eq(pessoas.id, documentos.pessoaId)).where(eq(documentos.id, id));
    if (!d) throw new NotFoundException('Documento não encontrado.');
    const { codigoHash, ...resto } = d.d;
    void codigoHash;
    return { ...resto, pessoa: d.pessoa };
  }

  listarModelos() {
    return this.db.select().from(modelosDocumento).orderBy(asc(modelosDocumento.tipo), asc(modelosDocumento.titulo));
  }
}
