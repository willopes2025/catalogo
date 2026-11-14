/**
 * Score interno da representante (0 a 1000), só para a matriz.
 * Olha os últimos 12 meses:
 *   35% pontualidade nos acertos · 25% pagamento das parcelas · 25% giro (quanto vende da maleta)
 *   10% perdas · 5% tempo de casa.
 * Sem nenhum acerto completo ainda, não há score ("nova").
 */
export interface HistoricoScore {
  acertos: { diasAtraso: number; percentualVendidoPb: number; pecasPerdidas: number; pecasNaMaleta: number }[];
  parcelas: { pagasEmDia: number; pagasComAtraso: number; vencidasEmAberto: number; maiorAtrasoAbertoDias: number };
  mesesDeCasa: number;
}

export type Faixa = 'A' | 'B' | 'C' | 'D' | 'nova';

export interface ResultadoScore {
  score: number | null;
  faixa: Faixa;
  componentes: { pontualidade: number; pagamento: number; giro: number; perdas: number; casa: number };
  /** O que mais puxa o score para baixo, em linguagem simples. */
  pontosDeAtencao: string[];
}

const PESOS = { pontualidade: 0.35, pagamento: 0.25, giro: 0.25, perdas: 0.1, casa: 0.05 } as const;
/** Vender 60% da maleta já é o melhor giro possível. */
const GIRO_IDEAL_PB = 6000;
/** Perder 10% das peças zera o componente de perdas. */
const PERDA_MAXIMA = 0.1;

const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const limitar = (x: number) => Math.max(0, Math.min(1, x));

export function faixaDoScore(score: number | null): Faixa {
  if (score === null) return 'nova';
  return score >= 800 ? 'A' : score >= 600 ? 'B' : score >= 400 ? 'C' : 'D';
}

export function calcularScore(h: HistoricoScore): ResultadoScore {
  const p = h.parcelas;
  const totalParcelas = p.pagasEmDia + p.pagasComAtraso + p.vencidasEmAberto;
  let pagamento = totalParcelas ? (p.pagasEmDia + 0.5 * p.pagasComAtraso) / totalParcelas : 1;
  if (p.maiorAtrasoAbertoDias > 30) pagamento *= 0.5;

  const componentes = {
    pontualidade: limitar(media(h.acertos.map((a) => 1 - a.diasAtraso / 30))),
    pagamento: limitar(pagamento),
    giro: limitar(media(h.acertos.map((a) => a.percentualVendidoPb)) / GIRO_IDEAL_PB),
    perdas: (() => {
      const pecas = h.acertos.reduce((s, a) => s + a.pecasNaMaleta, 0);
      const perdidas = h.acertos.reduce((s, a) => s + a.pecasPerdidas, 0);
      return pecas ? limitar(1 - perdidas / pecas / PERDA_MAXIMA) : 1;
    })(),
    casa: limitar(h.mesesDeCasa / 12),
  };
  const arred = Object.fromEntries(Object.entries(componentes).map(([k, v]) => [k, Math.round(v * 100) / 100])) as ResultadoScore['componentes'];

  const atencao: [number, string][] = [];
  if (componentes.pontualidade < 0.9) atencao.push([PESOS.pontualidade * (1 - componentes.pontualidade), 'Acertos com atraso']);
  if (componentes.pagamento < 0.9) atencao.push([PESOS.pagamento * (1 - componentes.pagamento), p.vencidasEmAberto ? 'Parcelas vencidas em aberto' : 'Parcelas pagas com atraso']);
  if (componentes.giro < 0.6) atencao.push([PESOS.giro * (1 - componentes.giro), 'Vende pouco da maleta']);
  if (componentes.perdas < 0.8) atencao.push([PESOS.perdas * (1 - componentes.perdas), 'Peças perdidas ou quebradas']);

  if (!h.acertos.length) return { score: null, faixa: 'nova', componentes: arred, pontosDeAtencao: p.vencidasEmAberto ? ['Parcelas vencidas em aberto'] : [] };

  const score = Math.round(1000 * Object.entries(PESOS).reduce((s, [k, peso]) => s + peso * componentes[k as keyof typeof PESOS], 0));
  return { score, faixa: faixaDoScore(score), componentes: arred, pontosDeAtencao: atencao.sort((a, b) => b[0] - a[0]).map(([, t]) => t) };
}

/**
 * Sugestão de nível pela média de vendas dos últimos meses completos:
 * o nível mais alto cuja meta mensal a média alcança. Meta 0 = nível de entrada.
 */
export function nivelSugerido<N extends { id: string; ordem: number; metaMensal: number }>(niveis: N[], mediaVendidaMensal: number): N | null {
  const ordenados = [...niveis].sort((a, b) => a.ordem - b.ordem);
  let escolhido: N | null = ordenados[0] ?? null;
  for (const n of ordenados) if (mediaVendidaMensal >= n.metaMensal) escolhido = n;
  return escolhido;
}

/** Pontos de um acerto completo, pelas regras configuradas. */
export interface RegrasPontos {
  ativo: boolean;
  porAcertoEmDia: number;
  porCemReaisVendidos: number;
  porMetaBatida: number;
  porParcelaEmDia: number;
  /** Acertos e parcelas antes desta data não geram pontos (AAAA-MM-DD; vazio = todo o histórico). */
  desde: string;
}

export const REGRAS_PONTOS_PADRAO: RegrasPontos = { ativo: true, porAcertoEmDia: 50, porCemReaisVendidos: 10, porMetaBatida: 100, porParcelaEmDia: 10, desde: '' };

export function pontosDoAcerto(r: RegrasPontos, a: { diasAtraso: number; totalVendido: number; metaDoNivel: number; parcial: boolean }): { regra: string; pontos: number; motivo: string }[] {
  if (!r.ativo || a.parcial) return [];
  const out: { regra: string; pontos: number; motivo: string }[] = [];
  const porVenda = Math.floor(a.totalVendido / 10000) * r.porCemReaisVendidos;
  if (porVenda > 0) out.push({ regra: 'vendas', pontos: porVenda, motivo: `Vendas no acerto` });
  if (a.diasAtraso === 0 && r.porAcertoEmDia > 0) out.push({ regra: 'em_dia', pontos: r.porAcertoEmDia, motivo: 'Acerto em dia' });
  if (a.metaDoNivel > 0 && a.totalVendido >= a.metaDoNivel && r.porMetaBatida > 0) out.push({ regra: 'meta', pontos: r.porMetaBatida, motivo: 'Meta do nível batida' });
  return out;
}
