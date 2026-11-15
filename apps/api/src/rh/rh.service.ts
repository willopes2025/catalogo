import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { calcularDia, feriadosNacionais, previstoDoTurno, somarJornada, type ResultadoDia, type Turno } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import type { Tx } from '../db/client';
import { AuditoriaService } from '../comum/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { SegredosService } from '../segredos/segredos.service';
import { assinarCades, lerCertificado } from './assinatura';
import {
  empresas,
  rhCertificados,
  rhDocumentos,
  rhEscalas,
  rhFechamentos,
  rhFeriados,
  rhFuncionarios,
  rhLocais,
  rhOcorrencias,
  rhPontoEmpresas,
  rhRegistros,
  rhTratamentos,
  usuarios,
} from '../db/schema';
import { dh, dia, gerarAej, gerarAfd, hashMarcacao, nomeAej, nomeAfd, type VinculoAej } from './arquivos-ponto';

export type Funcionario = typeof rhFuncionarios.$inferSelect;

/** Ocorrências e o que fazem no espelho. */
export const TIPOS_OCORRENCIA: Record<string, { nome: string; abona: boolean }> = {
  atestado: { nome: 'Atestado médico', abona: true },
  ferias: { nome: 'Férias', abona: true },
  folga: { nome: 'Folga / compensação', abona: true },
  falta_justificada: { nome: 'Falta justificada (abonada)', abona: true },
  licenca: { nome: 'Licença (maternidade, paternidade, casamento, luto…)', abona: true },
  afastamento: { nome: 'Afastamento (INSS)', abona: true },
  falta: { nome: 'Falta sem justificativa', abona: false },
  suspensao: { nome: 'Suspensão', abona: false },
};

export const TIPOS_DOCUMENTO: Record<string, string> = {
  contrato: 'Contrato de trabalho',
  contrato_experiencia: 'Contrato de experiência',
  carta_admissao: 'Carta de admissão',
  ficha_registro: 'Ficha de registro',
  ctps: 'Carteira de trabalho (CTPS)',
  documento_pessoal: 'Documento pessoal (RG, CPF, CNH)',
  comprovante_endereco: 'Comprovante de endereço',
  aso_admissional: 'Exame admissional (ASO)',
  aso_periodico: 'Exame periódico (ASO)',
  aso_demissional: 'Exame demissional (ASO)',
  contracheque: 'Contracheque',
  ferias: 'Aviso e recibo de férias',
  decimo_terceiro: 'Recibo de 13º',
  atestado: 'Atestado médico',
  advertencia: 'Advertência',
  aviso_previo: 'Aviso prévio',
  carta_demissao: 'Carta de demissão / pedido de desligamento',
  rescisao: 'Termo de rescisão (TRCT)',
  outro: 'Outro',
};

const hoje = () => dia(new Date());
const so = (s?: string | null) => (s ?? '').replace(/\D/g, '');
const ymd = (d: Date) => dia(d);

/** Distância em metros entre dois pontos (haversine). */
function distancia(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Dias de uma competência AAAA-MM. */
export function diasDaCompetencia(comp: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(comp)) throw new BadRequestException('Mês no formato AAAA-MM.');
  const [a, m] = comp.split('-').map(Number);
  const total = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => `${comp}-${String(i + 1).padStart(2, '0')}`);
}

export interface DiaEspelho extends ResultadoDia {
  data: string;
  semana: number;
  marcacoes: { id: string | null; hora: string; origem: 'original' | 'incluida'; desconsiderada?: boolean; motivo?: string | null; foraDoLocal?: boolean | null }[];
  ocorrencia: string | null;
  feriado: string | null;
}

@Injectable()
export class RhService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly arquivos: ArquivosService,
    private readonly config: ConfiguracoesService,
    private readonly segredos: SegredosService,
  ) {}

  regras() {
    return this.config.ler('regras_rh');
  }

  // ───────── Funcionários ─────────

  async obter(id: string) {
    const [f] = await this.db.select().from(rhFuncionarios).where(eq(rhFuncionarios.id, id));
    if (!f) throw new NotFoundException('Funcionário não encontrado.');
    return f;
  }

  async doUsuario(usuarioId: string) {
    const [f] = await this.db.select().from(rhFuncionarios).where(eq(rhFuncionarios.usuarioId, usuarioId));
    return f ?? null;
  }

  /** CPF de quem fez a mudança (o AFD pede); se o usuário não for funcionário, fica zerado. */
  private async cpfDoResponsavel(tx: Tx | Db, usuarioId: string | null) {
    if (!usuarioId) return '';
    const [f] = await tx.select({ cpf: rhFuncionarios.cpf }).from(rhFuncionarios).where(eq(rhFuncionarios.usuarioId, usuarioId));
    return f?.cpf ?? '';
  }

  /** Próximo NSR do empregador, com trava (dois registros ao mesmo tempo não pegam o mesmo número). */
  private async proximoNsr(tx: Tx, empresaId: string) {
    await tx.insert(rhPontoEmpresas).values({ empresaId }).onConflictDoNothing();
    const [s] = await tx.select().from(rhPontoEmpresas).where(eq(rhPontoEmpresas.empresaId, empresaId)).for('update');
    return { nsr: s.ultimoNsr + 1, hashAnterior: s.ultimoHash };
  }

  /** Registro tipo 5 do AFD: inclusão, alteração ou exclusão do empregado no REP. */
  async registrarEmpregado(tx: Tx, f: Funcionario, operacao: 'I' | 'A' | 'E', usuarioId: string | null) {
    const { nsr } = await this.proximoNsr(tx, f.empresaId);
    await tx.insert(rhRegistros).values({ empresaId: f.empresaId, nsr, tipo: 5, gravadoEm: new Date(), funcionarioId: f.id, cpf: f.cpf, dados: { operacao, nome: f.nome, responsavelCpf: await this.cpfDoResponsavel(tx, usuarioId) }, usuarioId });
    await tx.update(rhPontoEmpresas).set({ ultimoNsr: nsr }).where(eq(rhPontoEmpresas.empresaId, f.empresaId));
  }

  // ───────── Bater o ponto ─────────

  /**
   * Marcação do REP-P: hora do servidor, NSR sequencial, hash SHA-256 encadeado, foto e GPS.
   * Uma vez gravada, não muda mais (o banco recusa).
   */
  async marcar(usuarioId: string, d: { latitude?: number | null; longitude?: number | null; precisao?: number | null; foto?: { conteudo: Buffer; mime: string } | null; ip?: string; aparelho?: string; coletor: '01' | '02' }) {
    const f = await this.doUsuario(usuarioId);
    if (!f) throw new ForbiddenException('Seu acesso não está ligado a um cadastro de funcionário. Fale com o RH.');
    if (f.status === 'desligado') throw new ForbiddenException('Cadastro desligado: o ponto não pode mais ser batido.');
    if (!f.batePonto) throw new BadRequestException('Seu cadastro está marcado como sem controle de ponto.');
    const regras = await this.regras();
    if (regras.exigirFoto && !d.foto) throw new BadRequestException('Tire a foto para bater o ponto.');

    // Cerca pelo GPS: em qual local cadastrado a pessoa está.
    const locais = await this.db.select().from(rhLocais).where(eq(rhLocais.ativo, true));
    let localId: string | null = null;
    let foraDoLocal: boolean | null = null;
    if (locais.length) {
      if (d.latitude == null || d.longitude == null) {
        if (regras.cercaGps === 'bloquear') throw new BadRequestException('Ative a localização do celular para bater o ponto.');
      } else {
        const perto = locais.map((l) => ({ l, dist: distancia({ lat: d.latitude!, lng: d.longitude! }, { lat: l.latitude, lng: l.longitude }) })).sort((a, b) => a.dist - b.dist)[0];
        // A precisão do GPS conta a favor (celular dentro de prédio erra dezenas de metros).
        foraDoLocal = perto.dist - Math.min(d.precisao ?? 0, 200) > perto.l.raioM;
        localId = foraDoLocal ? null : perto.l.id;
        if (foraDoLocal && regras.cercaGps === 'bloquear') throw new BadRequestException(`Você está a ${perto.dist} m de ${perto.l.nome}. O ponto só pode ser batido no local de trabalho.`);
      }
    }
    const foto = d.foto ? await this.arquivos.salvarPrivado(d.foto.conteudo, d.foto.mime, 'rh') : null;

    return this.db.transaction(async (tx) => {
      // Duas batidas no mesmo minuto (toque duplo, internet lenta): a segunda é recusada.
      const [ultima] = await tx.select({ m: rhRegistros.marcadoEm }).from(rhRegistros).where(and(eq(rhRegistros.funcionarioId, f.id), eq(rhRegistros.tipo, 7))).orderBy(desc(rhRegistros.marcadoEm)).limit(1);
      const agora = new Date();
      if (ultima?.m && agora.getTime() - ultima.m.getTime() < 60_000) throw new BadRequestException('Ponto já registrado agora há pouco. Aguarde um minuto para bater de novo.');
      const { nsr, hashAnterior } = await this.proximoNsr(tx, f.empresaId);
      const base = { nsr, marcadoEm: agora, cpf: f.cpf, gravadoEm: agora, coletor: d.coletor, online: true };
      const hash = hashMarcacao(base, hashAnterior);
      const [r] = await tx
        .insert(rhRegistros)
        .values({ empresaId: f.empresaId, tipo: 7, ...base, funcionarioId: f.id, hash, latitude: d.latitude ?? null, longitude: d.longitude ?? null, precisaoM: d.precisao ? Math.round(d.precisao) : null, localId, foraDoLocal, foto, ip: d.ip ?? null, aparelho: d.aparelho?.slice(0, 300) ?? null, usuarioId })
        .returning();
      await tx.update(rhPontoEmpresas).set({ ultimoNsr: nsr, ultimoHash: hash }).where(eq(rhPontoEmpresas.empresaId, f.empresaId));
      return this.comprovante(r.id, tx);
    });
  }

  /** Comprovante de registro de ponto do trabalhador (Portaria 671, art. 79/81). */
  async comprovante(registroId: string, tx: Tx | Db = this.db) {
    const [r] = await tx
      .select({ r: rhRegistros, nome: rhFuncionarios.nome, cpf: rhFuncionarios.cpf, usuarioId: rhFuncionarios.usuarioId, empresa: empresas.razaoSocial, fantasia: empresas.nome, cnpj: empresas.cnpj, cidade: empresas.cidade, uf: empresas.uf, local: rhLocais.nome })
      .from(rhRegistros)
      .innerJoin(rhFuncionarios, eq(rhFuncionarios.id, rhRegistros.funcionarioId))
      .innerJoin(empresas, eq(empresas.id, rhRegistros.empresaId))
      .leftJoin(rhLocais, eq(rhLocais.id, rhRegistros.localId))
      .where(and(eq(rhRegistros.id, registroId), eq(rhRegistros.tipo, 7)));
    if (!r) throw new NotFoundException('Marcação não encontrada.');
    const regras = await this.regras();
    return {
      id: r.r.id,
      titulo: 'Comprovante de Registro de Ponto do Trabalhador',
      empregador: r.empresa || r.fantasia,
      cnpj: r.cnpj,
      local: r.local ?? ([r.cidade, r.uf].filter(Boolean).join(' / ') || null),
      inpi: regras.inpi || null,
      trabalhador: r.nome,
      cpf: r.cpf,
      dataHora: dh(r.r.marcadoEm!),
      nsr: r.r.nsr,
      hash: r.r.hash,
      coletor: r.r.coletor === '01' ? 'aplicativo' : 'navegador',
      foraDoLocal: r.r.foraDoLocal,
      usuarioId: r.usuarioId,
    };
  }

  // ───────── Espelho de ponto ─────────

  private async feriadosEntre(de: string, ate: string) {
    const extras = await this.db.select().from(rhFeriados).where(and(gte(rhFeriados.data, de), lte(rhFeriados.data, ate)));
    const anos = [...new Set([de.slice(0, 4), ate.slice(0, 4)])].map(Number);
    const mapa = new Map<string, string>();
    for (const a of anos) for (const f of feriadosNacionais(a)) if (!/facultativo/.test(f.nome)) mapa.set(f.data, f.nome);
    for (const f of extras) mapa.set(f.data, f.nome);
    return mapa;
  }

  /** Marcações válidas por dia (originais não desconsideradas + incluídas), com virada de meia-noite. */
  private async marcacoesDoPeriodo(funcionarioId: string, de: string, ate: string) {
    const ini = new Date(`${de}T00:00:00-03:00`);
    const fim = new Date(new Date(`${ate}T00:00:00-03:00`).getTime() + 86_400_000 + 6 * 3600_000); // madrugada do dia seguinte
    const originais = await this.db.select().from(rhRegistros).where(and(eq(rhRegistros.funcionarioId, funcionarioId), eq(rhRegistros.tipo, 7), gte(rhRegistros.marcadoEm, ini), lt(rhRegistros.marcadoEm, fim))).orderBy(asc(rhRegistros.marcadoEm));
    const trats = await this.db.select().from(rhTratamentos).where(eq(rhTratamentos.funcionarioId, funcionarioId));
    const desconsideradas = new Map(trats.filter((t) => t.tipo === 'desconsiderar' && t.registroId).map((t) => [t.registroId!, t.motivo]));
    const lista = [
      ...originais.map((o) => ({ id: o.id, quando: o.marcadoEm!, origem: 'original' as const, desconsiderada: desconsideradas.has(o.id), motivo: desconsideradas.get(o.id) ?? null, foraDoLocal: o.foraDoLocal, nsr: o.nsr })),
      ...trats.filter((t) => t.tipo === 'inclusao' && t.marcadoEm && t.marcadoEm >= ini && t.marcadoEm < fim).map((t) => ({ id: t.id, quando: t.marcadoEm!, origem: 'incluida' as const, desconsiderada: false, motivo: t.motivo, foraDoLocal: null, nsr: null })),
    ].sort((a, b) => a.quando.getTime() - b.quando.getTime());
    // Agrupa por dia; batida de madrugada que fecha um turno ímpar da véspera fica na véspera.
    const porDia = new Map<string, typeof lista>();
    for (const m of lista) {
      let d = ymd(m.quando);
      const hora = Number(dh(m.quando).slice(11, 13));
      const vespera = ymd(new Date(m.quando.getTime() - 86_400_000));
      const daVespera = (porDia.get(vespera) ?? []).filter((x) => !x.desconsiderada);
      if (hora < 6 && daVespera.length % 2 === 1 && !m.desconsiderada) d = vespera;
      porDia.set(d, [...(porDia.get(d) ?? []), m]);
    }
    return porDia;
  }

  async espelho(funcionarioId: string, competencia: string) {
    const f = await this.obter(funcionarioId);
    const dias = diasDaCompetencia(competencia);
    const [de, ate] = [dias[0], dias[dias.length - 1]];
    const [escala] = f.escalaId ? await this.db.select().from(rhEscalas).where(eq(rhEscalas.id, f.escalaId)) : [];
    const feriados = await this.feriadosEntre(de, ate);
    const ocorrencias = await this.db.select().from(rhOcorrencias).where(and(eq(rhOcorrencias.funcionarioId, funcionarioId), lte(rhOcorrencias.de, ate), gte(rhOcorrencias.ate, de)));
    const porDia = await this.marcacoesDoPeriodo(funcionarioId, de, ate);
    const h = hoje();
    const linhas: DiaEspelho[] = [];
    for (const data of dias) {
      const semana = new Date(`${data}T12:00:00Z`).getUTCDay();
      const fora = data < f.dataAdmissao || (f.dataDemissao && data > f.dataDemissao) || data > h;
      const turno: Turno | null = fora ? null : (escala?.dias[semana] ?? null);
      const oc = ocorrencias.find((o) => o.de <= data && o.ate >= data);
      const brutas = porDia.get(data) ?? [];
      const validas = brutas.filter((m) => !m.desconsiderada);
      const meiaNoite = new Date(`${data}T00:00:00-03:00`).getTime();
      const r = calcularDia({
        marcacoes: validas.map((m) => Math.round((m.quando.getTime() - meiaNoite) / 60000)),
        turno: data === h && validas.length < 2 ? null : turno, // hoje ainda está em andamento
        domingo: semana === 0,
        feriado: feriados.has(data),
        abonado: !!oc && oc.abona,
        toleranciaMarcacao: escala?.toleranciaMarcacao,
        toleranciaDia: escala?.toleranciaDia,
      });
      if (oc && !oc.abona && turno) {
        r.falta = r.previsto;
        r.faltaDia = true;
      }
      if (brutas.some((m) => m.foraDoLocal)) r.avisos.push('Batida fora do local de trabalho.');
      linhas.push({
        ...r,
        data,
        semana,
        marcacoes: brutas.map((m) => ({ id: m.id, hora: dh(m.quando).slice(11, 16), origem: m.origem, desconsiderada: m.desconsiderada, motivo: m.motivo, foraDoLocal: m.foraDoLocal })),
        ocorrencia: oc ? TIPOS_OCORRENCIA[oc.tipo]?.nome ?? oc.tipo : null,
        feriado: feriados.get(data) ?? null,
      });
    }
    const [fech] = await this.db.select().from(rhFechamentos).where(and(eq(rhFechamentos.funcionarioId, funcionarioId), eq(rhFechamentos.competencia, competencia)));
    return {
      funcionario: { id: f.id, nome: f.nome, cpf: f.cpf, cargo: f.cargo, dataAdmissao: f.dataAdmissao },
      escala: escala ? { id: escala.id, nome: escala.nome } : null,
      competencia,
      dias: linhas,
      totais: somarJornada(linhas),
      fechamento: fech ? { fechadoEm: fech.fechadoEm, cienteEm: fech.cienteEm } : null,
    };
  }

  /** Fecha o mês: guarda a foto do espelho de cada um (o funcionário dá ciência no portal). */
  async fechar(competencia: string, funcionarioIds: string[] | null, usuarioId: string) {
    const fs = await this.db.select().from(rhFuncionarios).where(funcionarioIds?.length ? inArray(rhFuncionarios.id, funcionarioIds) : eq(rhFuncionarios.batePonto, true));
    const dias = diasDaCompetencia(competencia);
    const alvo = fs.filter((f) => f.dataAdmissao <= dias[dias.length - 1] && (!f.dataDemissao || f.dataDemissao >= dias[0]));
    const pendencias: { nome: string; dias: number }[] = [];
    for (const f of alvo) {
      const e = await this.espelho(f.id, competencia);
      if (e.totais.pendentes) pendencias.push({ nome: f.nome, dias: e.totais.pendentes });
      await this.db
        .insert(rhFechamentos)
        .values({ funcionarioId: f.id, competencia, espelho: e, fechadoPor: usuarioId })
        .onConflictDoUpdate({ target: [rhFechamentos.funcionarioId, rhFechamentos.competencia], set: { espelho: e, fechadoEm: new Date(), fechadoPor: usuarioId, cienteEm: null, cienteIp: null } });
    }
    await this.auditoria.registrar({ usuarioId, acao: 'fechar_ponto', entidade: 'rh_ponto', dados: { competencia, funcionarios: alvo.length } });
    return { fechados: alvo.length, pendencias };
  }

  // ───────── Certificado A1 (assinatura do AFD/AEJ) ─────────

  async certificados() {
    const linhas = await this.db
      .select({ empresaId: empresas.id, empresa: empresas.nome, cnpjEmpresa: empresas.cnpj, titular: rhCertificados.titular, cnpj: rhCertificados.cnpj, emissor: rhCertificados.emissor, validoAte: rhCertificados.validoAte, icpBrasil: rhCertificados.icpBrasil, atualizadoEm: rhCertificados.atualizadoEm })
      .from(empresas)
      .leftJoin(rhCertificados, eq(rhCertificados.empresaId, empresas.id))
      .orderBy(asc(empresas.nome));
    const agora = Date.now();
    return linhas.map((l) => ({ ...l, situacao: !l.titular ? 'sem' : l.validoAte!.getTime() < agora ? 'vencido' : l.validoAte!.getTime() - agora < 30 * 86_400_000 ? 'vencendo' : 'ok' }));
  }

  async salvarCertificado(empresaId: string, pfx: Buffer, senha: string, usuarioId: string) {
    const emp = await this.empregador(empresaId);
    if (pfx.length > 200_000) throw new BadRequestException('Arquivo grande demais para um certificado A1 (.pfx).');
    let c: ReturnType<typeof lerCertificado>;
    try {
      c = lerCertificado(pfx, senha);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    if (c.validoAte.getTime() < Date.now()) throw new BadRequestException(`Este certificado venceu em ${c.validoAte.toLocaleDateString('pt-BR')}.`);
    // e-CNPJ da matriz assina pelas filiais: basta a mesma raiz (8 primeiros dígitos).
    if (c.cnpj && c.cnpj.slice(0, 8) !== so(emp.cnpj).slice(0, 8)) throw new BadRequestException(`O certificado é do CNPJ ${c.cnpj}, de outra empresa que não ${emp.razaoSocial}.`);
    // Confere que assina de verdade antes de guardar.
    assinarCades(Buffer.from('teste'), c);
    const valores = { pfxCifrado: this.segredos.cifrar(pfx.toString('base64')), senhaCifrada: this.segredos.cifrar(senha), titular: c.titular, cnpj: c.cnpj, emissor: c.emissor, serie: c.serie, validoAte: c.validoAte, icpBrasil: c.icpBrasil, usuarioId, atualizadoEm: new Date() };
    await this.db.insert(rhCertificados).values({ empresaId, ...valores }).onConflictDoUpdate({ target: rhCertificados.empresaId, set: valores });
    await this.auditoria.registrar({ usuarioId, acao: 'editar', entidade: 'rh_certificado', entidadeId: empresaId, dados: { titular: c.titular, validoAte: c.validoAte, emissor: c.emissor } });
    return { titular: c.titular, cnpj: c.cnpj, emissor: c.emissor, validoAte: c.validoAte, icpBrasil: c.icpBrasil };
  }

  async removerCertificado(empresaId: string, usuarioId: string) {
    await this.db.delete(rhCertificados).where(eq(rhCertificados.empresaId, empresaId));
    await this.auditoria.registrar({ usuarioId, acao: 'excluir', entidade: 'rh_certificado', entidadeId: empresaId });
    return { ok: true };
  }

  /** Assinatura .p7s de um arquivo do ponto, se a empresa tiver certificado válido. */
  async assinar(empresaId: string, arquivo: { nome: string; conteudo: Buffer }) {
    const [r] = await this.db.select().from(rhCertificados).where(eq(rhCertificados.empresaId, empresaId));
    if (!r) return null;
    if (r.validoAte.getTime() < Date.now()) throw new BadRequestException(`O certificado da empresa venceu em ${r.validoAte.toLocaleDateString('pt-BR')}. Envie o novo em RH › Configurar.`);
    const c = lerCertificado(Buffer.from(this.segredos.decifrar(r.pfxCifrado), 'base64'), this.segredos.decifrar(r.senhaCifrada));
    return { nome: `${arquivo.nome}.p7s`, conteudo: assinarCades(arquivo.conteudo, c) };
  }

  // ───────── Arquivos oficiais ─────────

  private async empregador(empresaId: string) {
    const [e] = await this.db.select().from(empresas).where(eq(empresas.id, empresaId));
    if (!e) throw new NotFoundException('Empresa não encontrada.');
    if (so(e.cnpj).length !== 14) throw new BadRequestException(`Cadastre o CNPJ da empresa ${e.nome} em Configurações › Empresas para gerar os arquivos do ponto.`);
    return { cnpj: e.cnpj!, razaoSocial: e.razaoSocial || e.nome, local: [e.cidade, e.uf].filter(Boolean).join(' / ') };
  }

  private async desenvolvedor() {
    const r = await this.regras();
    return { documento: r.desenvolvedorDocumento || '0', nome: r.desenvolvedorNome, email: r.desenvolvedorEmail, programa: 'Plataforma Aritana', versao: '1.0' };
  }

  async afd(empresaId: string, de: string, ate: string) {
    const emp = await this.empregador(empresaId);
    const regs = await this.db
      .select()
      .from(rhRegistros)
      .where(and(eq(rhRegistros.empresaId, empresaId), gte(rhRegistros.gravadoEm, new Date(`${de}T00:00:00-03:00`)), lt(rhRegistros.gravadoEm, new Date(new Date(`${ate}T00:00:00-03:00`).getTime() + 86_400_000))))
      .orderBy(asc(rhRegistros.nsr));
    const r = await this.regras();
    const conteudo = gerarAfd({ empregador: emp, inpi: r.inpi, desenvolvedor: await this.desenvolvedor(), de, ate, registros: regs.map((x) => ({ ...x, dados: x.dados as Record<string, any> })) });
    return { nome: nomeAfd(r.inpi, emp.cnpj), conteudo };
  }

  async aej(empresaId: string, de: string, ate: string) {
    const emp = await this.empregador(empresaId);
    const fs = await this.db.select().from(rhFuncionarios).where(and(eq(rhFuncionarios.empresaId, empresaId), lte(rhFuncionarios.dataAdmissao, ate)));
    const escalas = new Map((await this.db.select().from(rhEscalas)).map((e) => [e.id, e]));
    const vinculos: VinculoAej[] = [];
    let idv = 0;
    for (const f of fs.filter((x) => !x.dataDemissao || x.dataDemissao >= de)) {
      const esc = f.escalaId ? escalas.get(f.escalaId) : undefined;
      const turno = esc?.dias.find((x) => x) ?? null;
      const porDia = await this.marcacoesDoPeriodo(f.id, de, ate);
      const marcacoes: VinculoAej['marcacoes'] = [];
      for (const [, ms] of [...porDia.entries()].sort()) {
        let seq = 0, i = 0;
        for (const m of ms) {
          if (m.desconsiderada) {
            marcacoes.push({ quando: m.quando, tipo: 'D', seq: 0, fonte: 'O', motivo: m.motivo });
            continue;
          }
          const tipo = i % 2 === 0 ? 'E' : 'S';
          if (tipo === 'E') seq++;
          i++;
          marcacoes.push({ quando: m.quando, tipo, seq, fonte: m.origem === 'incluida' ? 'I' : 'O', motivo: m.motivo });
        }
      }
      const faltas = await this.db.select().from(rhOcorrencias).where(and(eq(rhOcorrencias.funcionarioId, f.id), eq(rhOcorrencias.tipo, 'falta'), lte(rhOcorrencias.de, ate), gte(rhOcorrencias.ate, de)));
      const ausencias: VinculoAej['ausencias'] = [];
      for (const o of faltas) for (let d = o.de; d <= o.ate && d <= ate; d = ymd(new Date(new Date(`${d}T12:00:00Z`).getTime() + 86_400_000))) if (d >= de) ausencias.push({ data: d, tipo: 2 });
      vinculos.push({
        id: ++idv,
        cpf: f.cpf,
        nome: f.nome,
        matriculaEsocial: f.matriculaEsocial,
        horario: esc && turno ? { codigo: esc.nome, duracao: previstoDoTurno(turno), pares: ([[turno.entrada, turno.saidaIntervalo ?? turno.saida], ...(turno.saidaIntervalo && turno.voltaIntervalo ? [[turno.voltaIntervalo, turno.saida]] : [])] as [string, string][]) } : null,
        marcacoes,
        ausencias,
      });
    }
    const r = await this.regras();
    return { nome: nomeAej(emp.cnpj, de, ate), conteudo: gerarAej({ empregador: emp, inpi: r.inpi, desenvolvedor: await this.desenvolvedor(), de, ate, vinculos }) };
  }

  // ───────── Quem está trabalhando agora ─────────

  async hoje() {
    const h = hoje();
    const ini = new Date(`${h}T00:00:00-03:00`);
    const fs = await this.db.select({ f: rhFuncionarios, escala: rhEscalas }).from(rhFuncionarios).leftJoin(rhEscalas, eq(rhEscalas.id, rhFuncionarios.escalaId)).where(and(eq(rhFuncionarios.batePonto, true), sql`${rhFuncionarios.status} <> 'desligado'`)).orderBy(asc(rhFuncionarios.nome));
    const regs = await this.db
      .select({ funcionarioId: rhRegistros.funcionarioId, marcadoEm: rhRegistros.marcadoEm, foraDoLocal: rhRegistros.foraDoLocal, local: rhLocais.nome })
      .from(rhRegistros)
      .leftJoin(rhLocais, eq(rhLocais.id, rhRegistros.localId))
      .where(and(eq(rhRegistros.tipo, 7), gte(rhRegistros.marcadoEm, ini)))
      .orderBy(asc(rhRegistros.marcadoEm));
    const ocs = await this.db.select().from(rhOcorrencias).where(and(lte(rhOcorrencias.de, h), gte(rhOcorrencias.ate, h)));
    const semana = new Date(`${h}T12:00:00Z`).getUTCDay();
    const agoraMin = Number(dh(new Date()).slice(11, 13)) * 60 + Number(dh(new Date()).slice(14, 16));
    return fs.map(({ f, escala }) => {
      const minhas = regs.filter((r) => r.funcionarioId === f.id);
      const turno = escala?.dias[semana] ?? null;
      const oc = ocs.find((o) => o.funcionarioId === f.id);
      const entradaPrevista = turno ? Number(turno.entrada.slice(0, 2)) * 60 + Number(turno.entrada.slice(3)) : null;
      const situacao = oc ? (TIPOS_OCORRENCIA[oc.tipo]?.nome ?? oc.tipo) : minhas.length ? (minhas.length % 2 === 1 ? 'trabalhando' : 'saiu') : turno && entradaPrevista !== null && agoraMin > entradaPrevista + 10 ? 'atrasado' : turno ? 'ainda não chegou' : 'folga';
      return { id: f.id, nome: f.nome, cargo: f.cargo, turno, situacao, marcacoes: minhas.map((m) => ({ hora: dh(m.marcadoEm!).slice(11, 16), foraDoLocal: m.foraDoLocal, local: m.local })) };
    });
  }

  // ───────── Documentos ─────────

  async salvarDocumento(funcionarioId: string, d: { tipo: string; titulo?: string | null; competencia?: string | null; data?: string | null; validade?: string | null; visivelFuncionario?: boolean; nomeArquivo: string; mime: string; conteudo: Buffer }, usuarioId: string) {
    await this.obter(funcionarioId);
    if (!(d.tipo in TIPOS_DOCUMENTO)) throw new BadRequestException('Tipo de documento inválido.');
    if (d.conteudo.length > 20_000_000) throw new BadRequestException('Arquivo maior que 20 MB.');
    const arquivo = await this.arquivos.salvarPrivado(d.conteudo, d.mime, 'rh');
    const [doc] = await this.db
      .insert(rhDocumentos)
      .values({
        funcionarioId,
        tipo: d.tipo,
        titulo: d.titulo?.trim() || `${TIPOS_DOCUMENTO[d.tipo]}${d.competencia ? ` ${d.competencia.slice(5)}/${d.competencia.slice(0, 4)}` : ''}`,
        competencia: d.competencia ?? null,
        data: d.data ?? hoje(),
        validade: d.validade ?? null,
        arquivo,
        nomeArquivo: d.nomeArquivo.slice(0, 200),
        mime: d.mime,
        tamanho: d.conteudo.length,
        visivelFuncionario: d.visivelFuncionario ?? true,
        usuarioId,
      })
      .returning();
    await this.auditoria.registrar({ usuarioId, acao: 'criar', entidade: 'rh_documento', entidadeId: doc.id, dados: { funcionarioId, tipo: d.tipo } });
    return doc;
  }

  async arquivoDocumento(id: string) {
    const [doc] = await this.db.select().from(rhDocumentos).where(eq(rhDocumentos.id, id));
    if (!doc) throw new NotFoundException('Documento não encontrado.');
    const caminho = this.arquivos.caminhoPrivado(doc.arquivo, 'rh');
    if (!caminho) throw new NotFoundException('Arquivo não encontrado.');
    return { doc, caminho };
  }

  /** Documentos com validade vencendo (exames periódicos, contratos de experiência, CNH). */
  async vencimentos(dias = 30) {
    const limite = ymd(new Date(Date.now() + dias * 86_400_000));
    return this.db
      .select({ id: rhDocumentos.id, titulo: rhDocumentos.titulo, tipo: rhDocumentos.tipo, validade: rhDocumentos.validade, funcionarioId: rhFuncionarios.id, nome: rhFuncionarios.nome })
      .from(rhDocumentos)
      .innerJoin(rhFuncionarios, eq(rhFuncionarios.id, rhDocumentos.funcionarioId))
      .where(and(lte(rhDocumentos.validade, limite), sql`${rhFuncionarios.status} <> 'desligado'`))
      .orderBy(asc(rhDocumentos.validade));
  }

  // ───────── Usuário de acesso ─────────

  /** Login pelo CPF (quem não tem e-mail, como motoboy, entra com o CPF). */
  async usuarioPorCpf(cpf: string) {
    const [r] = await this.db.select({ usuarioId: rhFuncionarios.usuarioId }).from(rhFuncionarios).where(and(eq(rhFuncionarios.cpf, so(cpf)), isNull(rhFuncionarios.dataDemissao)));
    if (!r?.usuarioId) return null;
    const [u] = await this.db.select({ email: usuarios.email }).from(usuarios).where(eq(usuarios.id, r.usuarioId));
    return u?.email ?? null;
  }
}
