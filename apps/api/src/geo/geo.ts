import { MUNICIPIOS, type Municipio } from './municipios';

/**
 * Localização aproximada sem serviço pago: pelo município (centro da cidade, tabela do IBGE)
 * ou, sem cidade, pelo DDD do telefone (cidade principal daquele DDD).
 */

export interface Ponto {
  lat: number;
  lng: number;
  cidade: string;
  uf: string;
  /** cidade = achou a cidade; ddd = só pela região do telefone (menos preciso). */
  origem: 'cidade' | 'ddd';
}

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const NOME_UF: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amazonas: 'AM', amapa: 'AP', bahia: 'BA', ceara: 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA', 'minas gerais': 'MG',
  'mato grosso do sul': 'MS', 'mato grosso': 'MT', para: 'PA', paraiba: 'PB', pernambuco: 'PE', piaui: 'PI', parana: 'PR', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN',
  rondonia: 'RO', roraima: 'RR', 'rio grande do sul': 'RS', 'santa catarina': 'SC', sergipe: 'SE', 'sao paulo': 'SP', tocantins: 'TO',
};

export const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "ES", "es", "Espírito Santo" → "ES". */
export function siglaUf(v?: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  if (UFS.includes(s)) return s;
  return NOME_UF[normalizar(v)] ?? null;
}

const porNome = new Map<string, Municipio[]>();
const capitalDoDdd = new Map<number, Municipio>();
for (const m of MUNICIPIOS) {
  const k = normalizar(m[0]);
  porNome.set(k, [...(porNome.get(k) ?? []), m]);
  // Para o DDD, a capital (ou a primeira cidade da lista) representa a região.
  const atual = capitalDoDdd.get(m[4]);
  if (!atual || (m[5] && !atual[5])) capitalDoDdd.set(m[4], m);
}

const ponto = (m: Municipio, origem: Ponto['origem']): Ponto => ({ lat: m[2], lng: m[3], cidade: m[0], uf: m[1], origem });

/** DDD de um telefone brasileiro (com ou sem 55). */
export function dddDoTelefone(tel?: string | null): number | null {
  const d = (tel ?? '').replace(/\D/g, '');
  const sem55 = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;
  if (sem55.length < 10) return null;
  const ddd = Number(sem55.slice(0, 2));
  return capitalDoDdd.has(ddd) ? ddd : null;
}

/**
 * Acha o ponto de uma cidade. "Vila Velha" + "ES" é direto; cidade sem UF que existe em mais de um estado
 * usa o DDD para desempatar; sem cidade, cai no DDD.
 */
export function localizar(d: { cidade?: string | null; uf?: string | null; telefone?: string | null }): Ponto | null {
  const ddd = dddDoTelefone(d.telefone);
  let cidade = d.cidade?.trim() ?? '';
  let uf = siglaUf(d.uf);
  // "Vila Velha - ES", "Vila Velha/ES"
  const sufixo = cidade.match(/^(.*?)[\s]*[-/,][\s]*([A-Za-z]{2})$/);
  if (sufixo && UFS.includes(sufixo[2].toUpperCase())) {
    cidade = sufixo[1];
    uf = uf ?? sufixo[2].toUpperCase();
  }
  if (cidade) {
    const opcoes = porNome.get(normalizar(cidade)) ?? [];
    // Desempate: mesmo DDD; depois, mesmo estado do DDD.
    const ufDoDdd = ddd ? capitalDoDdd.get(ddd)![1] : null;
    const nota = (m: Municipio) => (m[4] === ddd ? 2 : 0) + (m[1] === ufDoDdd ? 1 : 0);
    const certa = (uf ? opcoes.filter((m) => m[1] === uf) : opcoes).sort((a, b) => nota(b) - nota(a))[0];
    if (certa) return ponto(certa, 'cidade');
  }
  if (ddd) return ponto(capitalDoDdd.get(ddd)!, 'ddd');
  return null;
}

/** Distância em km em linha reta (haversine). */
export function distanciaKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * r * Math.asin(Math.sqrt(h)) * 10) / 10;
}
