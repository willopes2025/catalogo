import type { Centavos } from './dinheiro';

const UNIDADES = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function ate999(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CENTENAS[c]);
  if (resto < 20) {
    if (resto) partes.push(UNIDADES[resto]);
  } else {
    const d = Math.floor(resto / 10);
    const u = resto % 10;
    partes.push(u ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
  }
  return partes.join(' e ');
}

function inteiroPorExtenso(n: number): string {
  if (n === 0) return 'zero';
  const grupos: { valor: number; sing: string; plur: string }[] = [
    { valor: Math.floor(n / 1_000_000_000) % 1000, sing: 'bilhão', plur: 'bilhões' },
    { valor: Math.floor(n / 1_000_000) % 1000, sing: 'milhão', plur: 'milhões' },
    { valor: Math.floor(n / 1000) % 1000, sing: 'mil', plur: 'mil' },
    { valor: n % 1000, sing: '', plur: '' },
  ];
  const partes: string[] = [];
  grupos.forEach((g, i) => {
    if (!g.valor) return;
    let txt = g.sing === 'mil' && g.valor === 1 ? 'mil' : ate999(g.valor);
    if (g.sing && !(g.sing === 'mil' && g.valor === 1)) txt += ` ${g.valor === 1 ? g.sing : g.plur}`;
    partes.push(txt);
    void i;
  });
  // "e" antes do último grupo quando ele é menor que 100 ou centena redonda
  if (partes.length > 1) {
    const ultimo = n % 1000;
    if (ultimo && (ultimo < 100 || ultimo % 100 === 0)) {
      const u = partes.pop()!;
      return `${partes.join(', ')} e ${u}`;
    }
  }
  return partes.join(', ');
}

/** 123456 → "mil, duzentos e trinta e quatro reais e cinquenta e seis centavos" */
export function reaisPorExtenso(c: Centavos): string {
  const reais = Math.floor(Math.abs(c) / 100);
  const cent = Math.abs(c) % 100;
  const partes: string[] = [];
  if (reais) {
    const milhaoRedondo = reais >= 1_000_000 && reais % 1_000_000 === 0;
    partes.push(`${inteiroPorExtenso(reais)}${milhaoRedondo ? ' de' : ''} ${reais === 1 ? 'real' : 'reais'}`);
  }
  if (cent) partes.push(`${inteiroPorExtenso(cent)} ${cent === 1 ? 'centavo' : 'centavos'}`);
  return partes.length ? partes.join(' e ') : 'zero real';
}

/** "Maria José da Silva" → "maria-jose-da-silva" */
export function gerarSlug(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/** Substitui {{variavel}} pelos valores; variável sem valor vira um traço longo para preencher à mão. */
export function preencherModelo(modelo: string, valores: Record<string, string | number | null | undefined>): string {
  return modelo.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => {
    const v = valores[k.toLowerCase()];
    return v === null || v === undefined || v === '' ? '__________' : String(v);
  });
}

/** Lista as variáveis usadas num modelo. */
export function variaveisDoModelo(modelo: string): string[] {
  return [...new Set([...modelo.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}
