import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { paraHora } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { EmailService } from '../integracoes/email.service';
import { CrmService } from '../crm/crm.service';
import { CanaisService } from '../crm/canais.service';
import { ComissoesService } from '../comissoes/comissoes.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { empresas, rhDocumentos, rhEnvios, rhFechamentos, rhFuncionarios, rhOcorrencias } from '../db/schema';
import { diasDaCompetencia, RhService, TIPOS_DOCUMENTO, TIPOS_OCORRENCIA } from './rh.service';

/** O que pode ir no pacote do mês para a contabilidade. */
export const ITENS_CONTABILIDADE = {
  ponto_resumo: 'Resumo do ponto por funcionário (horas, extras, faltas)',
  ponto_diario: 'Ponto dia a dia (espelho)',
  ocorrencias: 'Faltas, atestados, férias e afastamentos',
  movimentacoes: 'Admissões e desligamentos do mês (com os dados e documentos)',
  vendas: 'Vendas por vendedora (loja e eventos)',
  comissoes: 'Comissões do mês',
  documentos: 'Documentos lançados no mês (atestados, advertências…)',
  afd: 'Arquivo Fonte de Dados (AFD) do ponto',
  aej: 'Arquivo Eletrônico de Jornada (AEJ)',
} as const;
export type ItemContabilidade = keyof typeof ITENS_CONTABILIDADE;

interface Arquivo {
  nome: string;
  conteudo: Buffer;
  mime: string;
}

/** CSV que o Excel em português abre direto (ponto e vírgula, com BOM). */
function csv(cabecalho: string[], linhas: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from('﻿' + [cabecalho, ...linhas].map((l) => l.map(esc).join(';')).join('\r\n'), 'utf8');
}
const reais = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
const hora = (m: number) => (m ? paraHora(m) : '');
const brData = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const seguro = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(0, 80);

@Injectable()
export class ContabilidadeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly rh: RhService,
    private readonly email: EmailService,
    private readonly crm: CrmService,
    private readonly canais: CanaisService,
    private readonly comissoes: ComissoesService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async montar(competencia: string, itens: ItemContabilidade[]) {
    const dias = diasDaCompetencia(competencia);
    const [de, ate] = [dias[0], dias[dias.length - 1]];
    const mm = `${competencia.slice(5)}-${competencia.slice(0, 4)}`;
    const arquivos: Arquivo[] = [];
    const resumo: string[] = [];
    const funcs = await this.db.select().from(rhFuncionarios).where(and(lte(rhFuncionarios.dataAdmissao, ate), sql`(${rhFuncionarios.dataDemissao} is null or ${rhFuncionarios.dataDemissao} >= ${de})`));
    funcs.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    if (itens.includes('ponto_resumo') || itens.includes('ponto_diario')) {
      // Usa o espelho fechado (o que o funcionário confirmou); sem fechamento, calcula agora.
      const fechados = new Map((await this.db.select().from(rhFechamentos).where(eq(rhFechamentos.competencia, competencia))).map((f) => [f.funcionarioId, f]));
      const espelhos = [];
      for (const f of funcs.filter((x) => x.batePonto)) {
        const fech = fechados.get(f.id);
        espelhos.push({ f, e: (fech?.espelho ?? (await this.rh.espelho(f.id, competencia))) as Awaited<ReturnType<RhService['espelho']>>, fechado: !!fech, ciente: fech?.cienteEm ?? null });
      }
      if (itens.includes('ponto_resumo')) {
        arquivos.push({
          nome: `ponto-resumo-${mm}.csv`,
          mime: 'text/csv',
          conteudo: csv(
            ['Funcionário', 'CPF', 'Cargo', 'Horas previstas', 'Horas trabalhadas', 'Extras 50%', 'Extras 100%', 'Adicional noturno (horas reais)', 'Atrasos', 'Saídas antecipadas', 'Faltas (horas)', 'Faltas (dias)', 'Saldo', 'Dias com batida faltando', 'Mês fechado', 'Ciência do funcionário'],
            espelhos.map(({ f, e, fechado, ciente }) => [f.nome, f.cpf, f.cargo, hora(e.totais.previsto), hora(e.totais.trabalhado), hora(e.totais.extra50), hora(e.totais.extra100), hora(e.totais.noturno), hora(e.totais.atraso), hora(e.totais.saidaAntecipada), hora(e.totais.falta), e.totais.faltasDias, paraHora(e.totais.saldo), e.totais.pendentes, fechado ? 'sim' : 'não', ciente ? new Date(ciente).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '']),
          ),
        });
        const pend = espelhos.filter((x) => x.e.totais.pendentes).length;
        resumo.push(`Ponto de ${espelhos.length} funcionário(s)${pend ? ` (${pend} com batida faltando)` : ''}`);
      }
      if (itens.includes('ponto_diario')) {
        const linhas: (string | number)[][] = [];
        for (const { f, e } of espelhos)
          for (const d of e.dias)
            linhas.push([f.nome, f.cpf, brData(d.data), ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.semana], d.marcacoes.filter((m) => !m.desconsiderada).map((m) => `${m.hora}${m.origem === 'incluida' ? '*' : ''}`).join(' '), hora(d.previsto), hora(d.trabalhado), hora(d.extra50), hora(d.extra100), hora(d.noturno), hora(d.atraso + d.saidaAntecipada + d.falta), d.faltaDia ? 'falta' : '', d.ocorrencia ?? d.feriado ?? '', d.avisos.join(' ')]);
        arquivos.push({ nome: `ponto-diario-${mm}.csv`, mime: 'text/csv', conteudo: csv(['Funcionário', 'CPF', 'Data', 'Dia', 'Marcações (* = incluída pela empresa)', 'Previsto', 'Trabalhado', 'Extra 50%', 'Extra 100%', 'Noturno', 'Débito', 'Falta', 'Ocorrência / feriado', 'Avisos'], linhas) });
      }
    }

    if (itens.includes('ocorrencias')) {
      const ocs = await this.db
        .select({ o: rhOcorrencias, nome: rhFuncionarios.nome, cpf: rhFuncionarios.cpf })
        .from(rhOcorrencias)
        .innerJoin(rhFuncionarios, eq(rhFuncionarios.id, rhOcorrencias.funcionarioId))
        .where(and(lte(rhOcorrencias.de, ate), gte(rhOcorrencias.ate, de)));
      arquivos.push({ nome: `ocorrencias-${mm}.csv`, mime: 'text/csv', conteudo: csv(['Funcionário', 'CPF', 'Tipo', 'De', 'Até', 'Abonada', 'Observação'], ocs.map(({ o, nome, cpf }) => [nome, cpf, TIPOS_OCORRENCIA[o.tipo]?.nome ?? o.tipo, brData(o.de), brData(o.ate), o.abona ? 'sim' : 'não', o.observacao])) });
      resumo.push(`${ocs.length} ocorrência(s)`);
    }

    if (itens.includes('movimentacoes')) {
      const mov = funcs.filter((f) => (f.dataAdmissao >= de && f.dataAdmissao <= ate) || (f.dataDemissao && f.dataDemissao >= de && f.dataDemissao <= ate));
      const emp = new Map((await this.db.select().from(empresas)).map((e) => [e.id, e]));
      arquivos.push({
        nome: `admissoes-e-desligamentos-${mm}.csv`,
        mime: 'text/csv',
        conteudo: csv(
          ['Movimento', 'Nome', 'CPF', 'PIS', 'RG', 'Nascimento', 'Telefone', 'E-mail', 'Endereço', 'Cidade', 'UF', 'CEP', 'Empresa', 'CNPJ', 'Cargo', 'Departamento', 'Tipo de contrato', 'Salário', 'Admissão', 'Desligamento', 'Motivo do desligamento', 'CTPS', 'Banco / agência / conta / Pix'],
          mov.map((f) => [f.dataDemissao && f.dataDemissao >= de && f.dataDemissao <= ate ? 'Desligamento' : 'Admissão', f.nome, f.cpf, f.pis, f.rg, brData(f.nascimento), f.telefone, f.email, f.endereco, f.cidade, f.uf, f.cep, emp.get(f.empresaId)?.razaoSocial ?? emp.get(f.empresaId)?.nome, emp.get(f.empresaId)?.cnpj, f.cargo, f.departamento, f.tipoContrato, reais(f.salario), brData(f.dataAdmissao), brData(f.dataDemissao), f.motivoDemissao, f.ctps, Object.values(f.dadosBancarios ?? {}).filter(Boolean).join(' / ')]),
        ),
      });
      // Junta os documentos de admissão e desligamento dessas pessoas.
      const tipos = ['contrato', 'contrato_experiencia', 'carta_admissao', 'ficha_registro', 'ctps', 'documento_pessoal', 'comprovante_endereco', 'aso_admissional', 'aso_demissional', 'carta_demissao', 'aviso_previo', 'rescisao'];
      for (const f of mov) {
        const docs = await this.db.select().from(rhDocumentos).where(eq(rhDocumentos.funcionarioId, f.id));
        for (const d of docs.filter((x) => tipos.includes(x.tipo))) await this.anexar(arquivos, d, f.nome);
      }
      resumo.push(`${mov.length} admissão(ões)/desligamento(s)`);
    }

    if (itens.includes('vendas')) {
      const r = await this.db.execute<{ nome: string; cpf: string | null; vendas: number; bruto: string; devolvido: string; liquido: string }>(sql`
        select u.nome, f.cpf, count(v.id)::int as vendas, sum(v.total) as bruto, sum(v.devolvido) as devolvido, sum(v.total - v.devolvido) as liquido
        from vendas v join usuarios u on u.id = v.vendedor_id left join rh_funcionarios f on f.usuario_id = u.id
        where v.status = 'concluida' and v.criado_em::date between ${de}::date and ${ate}::date
        group by u.id, u.nome, f.cpf order by u.nome`);
      arquivos.push({ nome: `vendas-por-vendedora-${mm}.csv`, mime: 'text/csv', conteudo: csv(['Vendedora', 'CPF', 'Vendas', 'Vendido', 'Devolvido', 'Líquido'], r.rows.map((x) => [x.nome, x.cpf, x.vendas, reais(Number(x.bruto)), reais(Number(x.devolvido)), reais(Number(x.liquido))])) });
      resumo.push(`Vendas de ${r.rows.length} vendedora(s)`);
    }

    if (itens.includes('comissoes')) {
      const c = await this.comissoes.calcular(competencia);
      const cpfs = new Map(funcs.filter((f) => f.usuarioId).map((f) => [f.usuarioId!, f.cpf]));
      arquivos.push({
        nome: `comissoes-${mm}.csv`,
        mime: 'text/csv',
        conteudo: csv(['Nome', 'CPF', 'Tipo', 'Base', 'Percentual', 'Comissão', 'Meta', 'Bateu a meta'], c.linhas.map((l) => [l.nome, l.usuarioId ? cpfs.get(l.usuarioId) : '', l.tipo === 'loja' ? 'Vendas (loja/eventos)' : 'Líder da rede', reais(l.base), `${(l.percentualPb / 100).toFixed(2).replace('.', ',')}%`, reais(l.valor), reais(l.meta), l.detalhes.bateuMeta === true ? 'sim' : l.detalhes.bateuMeta === false ? 'não' : ''])),
      });
      resumo.push(`Comissões: ${reais(c.total)}${c.fechado ? ' (mês fechado)' : ' (prévia: mês ainda não fechado)'}`);
    }

    if (itens.includes('documentos')) {
      const docs = await this.db
        .select({ d: rhDocumentos, nome: rhFuncionarios.nome })
        .from(rhDocumentos)
        .innerJoin(rhFuncionarios, eq(rhFuncionarios.id, rhDocumentos.funcionarioId))
        .where(and(gte(rhDocumentos.data, de), lte(rhDocumentos.data, ate), sql`${rhDocumentos.tipo} <> 'contracheque'`));
      for (const { d, nome } of docs) await this.anexar(arquivos, d, nome);
      resumo.push(`${docs.length} documento(s)`);
    }

    const empresasComFunc = [...new Set(funcs.map((f) => f.empresaId))];
    for (const [chave, gerar] of [['afd', (e: string) => this.rh.afd(e, de, ate)], ['aej', (e: string) => this.rh.aej(e, de, ate)]] as const) {
      if (!itens.includes(chave)) continue;
      for (const empresaId of empresasComFunc) {
        const a = await gerar(empresaId);
        arquivos.push({ ...a, mime: 'text/plain' });
        // Assinatura .p7s dos mesmos bytes, quando a empresa tem certificado.
        const s = await this.rh.assinar(empresaId, a);
        if (s) arquivos.push({ ...s, mime: 'application/pkcs7-signature' });
      }
    }
    if (itens.includes('afd') || itens.includes('aej')) resumo.push('Arquivos oficiais do ponto (AFD/AEJ)');

    // Nomes repetidos ganham número.
    const vistos = new Map<string, number>();
    for (const a of arquivos) {
      const n = (vistos.get(a.nome) ?? 0) + 1;
      vistos.set(a.nome, n);
      if (n > 1) a.nome = a.nome.replace(/(\.[^.]+)$/, `-${n}$1`);
    }
    return { arquivos, resumo };
  }

  private async anexar(arquivos: Arquivo[], d: typeof rhDocumentos.$inferSelect, nome: string) {
    const caminho = this.arquivos.caminhoPrivado(d.arquivo, 'rh');
    if (!caminho) return;
    const conteudo = await readFile(caminho).catch(() => null);
    if (!conteudo) return;
    const ext = d.nomeArquivo.includes('.') ? d.nomeArquivo.slice(d.nomeArquivo.lastIndexOf('.')) : '';
    arquivos.push({ nome: seguro(`${nome}-${TIPOS_DOCUMENTO[d.tipo] ?? d.tipo}`) + ext, conteudo, mime: d.mime });
  }

  async enviar(d: { competencia: string; itens: ItemContabilidade[]; canal: 'email' | 'whatsapp'; destino: string; mensagem?: string | null; canalId?: string | null }, usuarioId: string) {
    const { arquivos, resumo } = await this.montar(d.competencia, d.itens);
    if (!arquivos.length) throw new BadRequestException('Nada para enviar com os itens escolhidos.');
    const total = arquivos.reduce((a, x) => a + x.conteudo.length, 0);
    if (d.canal === 'email' && total > 20_000_000) throw new BadRequestException('Os arquivos passam de 20 MB, o limite da maioria dos e-mails. Separe em mais de um envio.');
    const mm = `${d.competencia.slice(5)}/${d.competencia.slice(0, 4)}`;
    const texto = [d.mensagem?.trim() || `Segue o material de RH de ${mm}.`, '', ...resumo.map((r) => `• ${r}`), '', 'Enviado pela Plataforma Aritana.'].join('\n');
    let status = 'enviado';
    let erro: string | null = null;
    try {
      if (d.canal === 'email') {
        await this.email.enviar(d.destino, `Aritana · RH ${mm}`, texto, arquivos);
      } else {
        if (!d.canalId) throw new BadRequestException('Escolha por qual número de WhatsApp enviar.');
        const contato = await this.crm.garantirContato({ telefone: d.destino, nome: 'Contabilidade' });
        const cv = await this.canais.garantirConversa(contato.id, d.canalId, 'resolvida');
        await this.canais.enviar({ conversaId: cv.id, tipo: 'texto', texto, usuarioId });
        for (const a of arquivos) await this.canais.enviar({ conversaId: cv.id, tipo: 'documento', midia: { conteudo: a.conteudo, mime: a.mime, nome: a.nome }, usuarioId });
      }
    } catch (e) {
      status = 'falhou';
      erro = (e as Error).message;
    }
    const [env] = await this.db
      .insert(rhEnvios)
      .values({ competencia: d.competencia, canal: d.canal, destino: d.destino, itens: d.itens, arquivos: arquivos.map((a) => ({ nome: a.nome, tamanho: a.conteudo.length })), mensagem: d.mensagem ?? null, status, erro, usuarioId })
      .returning();
    await this.auditoria.registrar({ usuarioId, acao: 'enviar_contabilidade', entidade: 'rh_envio', entidadeId: env.id, dados: { competencia: d.competencia, canal: d.canal, arquivos: arquivos.length, status } });
    if (status === 'falhou') throw new BadRequestException(`Não foi enviado: ${erro}`);
    return env;
  }
}
