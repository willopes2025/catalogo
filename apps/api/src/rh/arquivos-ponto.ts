import { createHash } from 'node:crypto';

/**
 * Arquivos oficiais do ponto (Portaria MTP 671/2021): AFD (leiaute 004, REP-P) e AEJ (leiaute 002).
 * Texto ISO-8859-1, uma linha por registro terminada em CR LF.
 */

/** CRC-16/KERMIT (CCITT-TRUE), exigido no AFD de REP-A e REP-P. "123456789" → 2189. */
export function crc16(texto: string) {
  let crc = 0x0000;
  for (const b of Buffer.from(texto, 'latin1')) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** "2026-11-15T09:42:00-0300": hora de Brasília (sem horário de verão desde 2019), segundos sempre 00. */
export function dh(d: Date) {
  const local = new Date(d.getTime() - 3 * 3600_000).toISOString();
  return `${local.slice(0, 16)}:00-0300`;
}
export const dia = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);

const so = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
/** Campo alfanumérico: à esquerda, completado com espaços, sem quebrar o leiaute. */
const a = (v: string | null | undefined, n: number) => (v ?? '').replace(/[\r\n|]/g, ' ').normalize('NFC').slice(0, n).padEnd(n, ' ');
/** Campo numérico: zeros à esquerda. */
const n = (v: string | number | null | undefined, tam: number) => so(String(v ?? '')).slice(-tam).padStart(tam, '0');

export interface Empregador {
  cnpj: string;
  razaoSocial: string;
  local: string;
}
export interface Desenvolvedor {
  documento: string;
  nome: string;
  email: string;
  programa: string;
  versao: string;
}

/** Campos 1 a 7 do registro tipo 7, como entram no hash e na linha. */
export function camposMarcacao(r: { nsr: number; marcadoEm: Date; cpf: string; gravadoEm: Date; coletor: string; online: boolean }) {
  return [n(r.nsr, 9), '7', dh(r.marcadoEm), n(r.cpf, 12), dh(r.gravadoEm), n(r.coletor, 2), r.online ? '0' : '1'];
}

/** Hash SHA-256 da marcação: campos 1 a 7 + o hash do registro anterior (encadeado). */
export function hashMarcacao(r: Parameters<typeof camposMarcacao>[0], hashAnterior: string | null) {
  return createHash('sha256').update(camposMarcacao(r).join('') + (hashAnterior ?? ''), 'latin1').digest('hex');
}

export interface RegistroAfd {
  nsr: number;
  tipo: number;
  gravadoEm: Date;
  marcadoEm?: Date | null;
  cpf?: string | null;
  coletor?: string | null;
  online?: boolean;
  hash?: string | null;
  dados: Record<string, any>;
}

/** Arquivo Fonte de Dados do REP-P. */
export function gerarAfd(p: { empregador: Empregador; inpi: string; desenvolvedor: Desenvolvedor; de: string; ate: string; registros: RegistroAfd[]; geradoEm?: Date }) {
  const linhas: string[] = [];
  const comCrc = (l: string) => l + crc16(l);
  const cab = '000000000' + '1' + '1' + a(so(p.empregador.cnpj), 14) + n('', 14) + a(p.empregador.razaoSocial, 150) + n(p.inpi || '0', 17) + p.de + p.ate + dh(p.geradoEm ?? new Date()) + '004' + (so(p.desenvolvedor.documento).length === 11 ? '2' : '1') + a(so(p.desenvolvedor.documento), 14) + a('', 30);
  linhas.push(comCrc(cab));
  const conta: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const r of [...p.registros].sort((x, y) => x.nsr - y.nsr)) {
    conta[r.tipo] = (conta[r.tipo] ?? 0) + 1;
    if (r.tipo === 7) {
      linhas.push(camposMarcacao({ nsr: r.nsr, marcadoEm: r.marcadoEm!, cpf: r.cpf ?? '', gravadoEm: r.gravadoEm, coletor: r.coletor ?? '02', online: r.online ?? true }).join('') + a(r.hash, 64));
    } else if (r.tipo === 5) {
      linhas.push(comCrc(n(r.nsr, 9) + '5' + dh(r.gravadoEm) + a(r.dados.operacao, 1) + n(r.cpf, 12) + a(r.dados.nome, 52) + a('', 4) + n(r.dados.responsavelCpf, 11)));
    } else if (r.tipo === 2) {
      linhas.push(comCrc(n(r.nsr, 9) + '2' + dh(r.gravadoEm) + n(r.dados.responsavelCpf, 14) + '1' + a(so(r.dados.cnpj), 14) + n('', 14) + a(r.dados.razaoSocial, 150) + a(r.dados.local, 100)));
    } else if (r.tipo === 6) {
      linhas.push(n(r.nsr, 9) + '6' + dh(r.gravadoEm) + n(r.dados.evento, 2));
    }
  }
  linhas.push('999999999' + n(conta[2], 9) + n(conta[3], 9) + n(conta[4], 9) + n(conta[5], 9) + n(conta[6], 9) + n(conta[7], 9) + '9');
  linhas.push(a('ASSINATURA_DIGITAL_EM_ARQUIVO_P7S', 100));
  return Buffer.from(linhas.join('\r\n') + '\r\n', 'latin1');
}

export const nomeAfd = (inpi: string, cnpj: string) => `AFD${so(inpi) || '00000000000000000'}${so(cnpj)}REP_P.txt`;

export interface VinculoAej {
  id: number;
  cpf: string;
  nome: string;
  matriculaEsocial?: string | null;
  horario?: { codigo: string; duracao: number; pares: [string, string][] } | null;
  /** Marcações já tratadas: originais, incluídas (I) e desconsideradas (D). */
  marcacoes: { quando: Date; tipo: 'E' | 'S' | 'D'; seq: number; fonte: 'O' | 'I'; motivo?: string | null; primeiraDoDia?: boolean }[];
  ausencias: { data: string; tipo: 1 | 2 | 3 | 4 }[];
}

/** Arquivo Eletrônico de Jornada (com os tratamentos: inclusões, desconsiderações e ausências). */
export function gerarAej(p: { empregador: Empregador; inpi: string; desenvolvedor: Desenvolvedor; de: string; ate: string; vinculos: VinculoAej[]; geradoEm?: Date }) {
  const L: string[] = [];
  const reg = (...c: (string | number | null | undefined)[]) => L.push(c.map((x) => String(x ?? '').replace(/[|\r\n]/g, ' ')).join('|'));
  reg('01', 1, so(p.empregador.cnpj), '', '', p.empregador.razaoSocial.slice(0, 150), p.de, p.ate, dh(p.geradoEm ?? new Date()), '002');
  reg('02', 1, 3, n(p.inpi || '0', 17));
  for (const v of p.vinculos) reg('03', v.id, n(v.cpf, 11), v.nome.slice(0, 150));
  const horarios = new Map<string, NonNullable<VinculoAej['horario']>>();
  for (const v of p.vinculos) if (v.horario) horarios.set(v.horario.codigo, v.horario);
  for (const h of horarios.values()) reg('04', h.codigo.slice(0, 30), h.duracao, ...h.pares.flatMap(([e, s]) => [e.replace(':', ''), s.replace(':', '')]));
  let qt5 = 0;
  for (const v of p.vinculos) {
    for (const m of v.marcacoes) {
      qt5++;
      reg('05', v.id, dh(m.quando), m.fonte === 'O' ? 1 : '', m.tipo, String(m.seq).padStart(3, '0'), m.fonte, m.tipo === 'E' && m.seq === 1 && v.horario ? v.horario.codigo : '', m.tipo === 'D' || m.fonte === 'I' ? (m.motivo ?? '').slice(0, 150) : '');
    }
  }
  const comMatricula = p.vinculos.filter((v) => v.matriculaEsocial);
  for (const v of comMatricula) reg('06', v.id, v.matriculaEsocial!.slice(0, 30));
  let qt7 = 0;
  for (const v of p.vinculos) for (const au of v.ausencias) {
    qt7++;
    reg('07', v.id, au.tipo, au.data, '', '');
  }
  reg('08', p.desenvolvedor.programa.slice(0, 150), p.desenvolvedor.versao.slice(0, 8), so(p.desenvolvedor.documento).length === 11 ? 2 : 1, so(p.desenvolvedor.documento), p.desenvolvedor.nome.slice(0, 150), p.desenvolvedor.email.slice(0, 50));
  reg('99', 1, 1, p.vinculos.length, horarios.size, qt5, comMatricula.length, qt7, 1);
  L.push(a('ASSINATURA_DIGITAL_EM_ARQUIVO_P7S', 100));
  return Buffer.from(L.join('\r\n') + '\r\n', 'latin1');
}

export const nomeAej = (cnpj: string, de: string, ate: string) => `AEJ_${so(cnpj)}_${de}_${ate}.txt`;
