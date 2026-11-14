import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { calcularScore, nivelSugerido, pontosDoAcerto, type ResultadoScore } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { niveis, pessoas, pontos, premios, resgates } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

/** "2026-11" → primeiro dia do mês e do mês seguinte. */
export function limitesDoMes(mes: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new BadRequestException('Mês no formato AAAA-MM.');
  const [a, m] = mes.split('-').map(Number);
  return { ini: `${mes}-01`, fim: m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01` };
}

/**
 * Gamificação da rede: score interno, pontos automáticos, prêmios, ranking e sugestão de nível.
 * Os pontos são apurados a partir do que já aconteceu (acertos e parcelas), sem depender de cada tela lembrar de dar ponto:
 * apurar() pode rodar quantas vezes for preciso, porque cada crédito tem chave única (origem + regra).
 */
@Injectable()
export class PontosService {
  private readonly log = new Logger('Pontos');
  private ultimaApuracao = 0;

  constructor(@Inject(DB) private readonly db: Db, private readonly config: ConfiguracoesService, private readonly auditoria: AuditoriaService) {}

  /** Credita os pontos que faltam. Com `seRecente`, não repete se já rodou no último minuto. */
  async apurar(seRecente = false) {
    if (seRecente && Date.now() - this.ultimaApuracao < 60_000) return { creditos: 0 };
    this.ultimaApuracao = Date.now();
    const r = await this.config.ler('regras_pontos');
    if (!r.ativo) return { creditos: 0 };
    const desde = r.desde || '2000-01-01';
    let creditos = 0;

    // Acertos completos ainda sem crédito de pontos.
    const pend = await this.db.execute<{ id: string; pessoa_id: string; resultado: { diasAtraso: number; totalVendido: number }; parcial: boolean; meta: number | null; numero: number }>(sql`
      select a.id, m.representante_id as pessoa_id, a.resultado, a.parcial, n.meta_mensal as meta, m.numero
      from acertos a
      join maletas m on m.id = a.maleta_id
      join pessoas p on p.id = m.representante_id
      left join niveis n on n.id = p.nivel_id
      where a.parcial = false and a.data >= ${desde}::date
        and not exists (select 1 from pontos pt where pt.origem_tipo = 'acerto' and pt.origem_id = a.id)
      limit 2000`);
    for (const a of pend.rows) {
      const regras = pontosDoAcerto(r, { diasAtraso: a.resultado.diasAtraso ?? 0, totalVendido: a.resultado.totalVendido ?? 0, metaDoNivel: a.meta ?? 0, parcial: a.parcial });
      // Acerto sem pontos (atrasado, sem venda) ganha uma linha zerada só para não ser olhado de novo.
      const linhas = regras.length ? regras : [{ regra: 'sem_pontos', pontos: 0, motivo: 'Acerto sem pontos' }];
      const ins = await this.db
        .insert(pontos)
        .values(linhas.map((l) => ({ pessoaId: a.pessoa_id, pontos: l.pontos, motivo: `${l.motivo} · maleta nº ${a.numero}`, origemTipo: 'acerto', origemId: a.id, regra: l.regra })))
        .onConflictDoNothing()
        .returning({ id: pontos.id });
      creditos += ins.length;
    }

    // Parcelas da representante pagas até o vencimento.
    if (r.porParcelaEmDia > 0) {
      const ins = await this.db.execute(sql`
        insert into pontos (pessoa_id, pontos, motivo, origem_tipo, origem_id, regra)
        select t.pessoa_id, ${r.porParcelaEmDia}, 'Parcela paga em dia', 'titulo', t.id, 'parcela'
        from titulos t join pessoas p on p.id = t.pessoa_id
        where p.tipo = 'representante' and t.tipo = 'receber' and t.status = 'pago' and t.pago_em <= t.vencimento and t.vencimento >= ${desde}::date
          and not exists (select 1 from pontos pt where pt.origem_tipo = 'titulo' and pt.origem_id = t.id)
        limit 5000
        on conflict do nothing`);
      creditos += ins.rowCount ?? 0;
    }
    if (creditos) this.log.log(`${creditos} crédito(s) de pontos apurado(s).`);
    return { creditos };
  }

  async saldo(pessoaId: string, tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0] = this.db) {
    const [s] = await tx.select({ s: sql<number>`coalesce(sum(${pontos.pontos}),0)::int` }).from(pontos).where(eq(pontos.pessoaId, pessoaId));
    return s.s;
  }

  extrato(pessoaId: string) {
    return this.db.select({ id: pontos.id, pontos: pontos.pontos, motivo: pontos.motivo, criadoEm: pontos.criadoEm }).from(pontos).where(and(eq(pontos.pessoaId, pessoaId), sql`${pontos.pontos} <> 0`)).orderBy(sql`${pontos.criadoEm} desc`).limit(100);
  }

  async ajustar(pessoaId: string, valor: number, motivo: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.id, pessoaId)).for('update');
      if (valor < 0 && (await this.saldo(pessoaId, tx)) + valor < 0) throw new BadRequestException('O ajuste deixaria o saldo negativo.');
      const [p] = await tx.insert(pontos).values({ pessoaId, pontos: valor, motivo, origemTipo: 'ajuste', regra: 'ajuste', usuarioId }).returning();
      await this.auditoria.registrar({ usuarioId, acao: 'ajustar_pontos', entidade: 'pessoa', entidadeId: pessoaId, dados: { valor, motivo } }, tx);
      return p;
    });
  }

  /** Resgate pedido pela representante: debita na hora e reserva o prêmio. */
  async resgatar(pessoaId: string, premioId: string) {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: pessoas.id }).from(pessoas).where(eq(pessoas.id, pessoaId)).for('update');
      const [pr] = await tx.select().from(premios).where(and(eq(premios.id, premioId), eq(premios.ativo, true))).for('update');
      if (!pr) throw new NotFoundException('Prêmio indisponível.');
      if (pr.estoque !== null && pr.estoque <= 0) throw new BadRequestException('Este prêmio acabou.');
      const saldo = await this.saldo(pessoaId, tx);
      if (saldo < pr.pontos) throw new BadRequestException(`Faltam ${pr.pontos - saldo} pontos para este prêmio.`);
      const [r] = await tx.insert(resgates).values({ pessoaId, premioId, pontos: pr.pontos }).returning();
      await tx.insert(pontos).values({ pessoaId, pontos: -pr.pontos, motivo: `Resgate: ${pr.nome}`, origemTipo: 'resgate', origemId: r.id, regra: 'resgate' });
      if (pr.estoque !== null) await tx.update(premios).set({ estoque: pr.estoque - 1 }).where(eq(premios.id, pr.id));
      await this.auditoria.registrar({ acao: 'resgatar', entidade: 'resgate', entidadeId: r.id, dados: { pessoaId, premio: pr.nome, pontos: pr.pontos } }, tx);
      return r;
    });
  }

  /** Entrega ou cancela o resgate; o cancelamento devolve os pontos e o prêmio. */
  async atenderResgate(id: string, status: 'entregue' | 'cancelado', observacao: string | null, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(resgates).where(eq(resgates.id, id)).for('update');
      if (!r) throw new NotFoundException('Resgate não encontrado.');
      if (r.status !== 'solicitado') throw new BadRequestException(`O resgate já está ${r.status}.`);
      if (status === 'cancelado') {
        await tx.insert(pontos).values({ pessoaId: r.pessoaId, pontos: r.pontos, motivo: 'Resgate cancelado: pontos devolvidos', origemTipo: 'resgate', origemId: r.id, regra: 'estorno', usuarioId });
        await tx.update(premios).set({ estoque: sql`case when ${premios.estoque} is null then null else ${premios.estoque} + 1 end` }).where(eq(premios.id, r.premioId));
      }
      const [x] = await tx.update(resgates).set({ status, observacao, atendidoPor: usuarioId, atendidoEm: new Date() }).where(eq(resgates.id, id)).returning();
      await this.auditoria.registrar({ usuarioId, acao: status, entidade: 'resgate', entidadeId: id }, tx);
      return x;
    });
  }

  /** Score de uma ou de todas as representantes ativas (últimos 12 meses). */
  async scores(pessoaId?: string): Promise<({ pessoaId: string; nome: string; cidade: string | null; nivel: string | null } & ResultadoScore)[]> {
    const filtro = pessoaId ? sql`and p.id = ${pessoaId}` : sql`and p.status = 'ativo'`;
    const linhas = await this.db.execute<{
      id: string;
      nome: string;
      cidade: string | null;
      nivel: string | null;
      meses: number;
      acertos: { diasAtraso: number; percentualVendidoPb: number; pecasPerdidas: number; pecasNaMaleta: number }[] | null;
      em_dia: number;
      com_atraso: number;
      vencidas: number;
      maior_atraso: number;
    }>(sql`
      select p.id, p.nome, p.cidade, n.nome as nivel,
        extract(year from age(now(), least(p.criado_em, coalesce((select min(m.criado_em) from maletas m where m.representante_id = p.id), p.criado_em)))) * 12
          + extract(month from age(now(), least(p.criado_em, coalesce((select min(m.criado_em) from maletas m where m.representante_id = p.id), p.criado_em)))) as meses,
        (select json_agg(json_build_object(
            'diasAtraso', coalesce((a.resultado->>'diasAtraso')::int, 0),
            'percentualVendidoPb', coalesce((a.resultado->>'percentualVendidoPb')::int, 0),
            'pecasPerdidas', coalesce((a.resultado->'pecas'->>'perdidas')::int, 0),
            'pecasNaMaleta', coalesce((a.resultado->'pecas'->>'emMaleta')::int, 0)))
          from acertos a join maletas m on m.id = a.maleta_id
          where m.representante_id = p.id and a.parcial = false and a.data >= current_date - interval '12 months') as acertos,
        (select count(*) from titulos t where t.pessoa_id = p.id and t.tipo = 'receber' and t.status = 'pago' and t.pago_em <= t.vencimento and t.vencimento >= current_date - interval '12 months')::int as em_dia,
        (select count(*) from titulos t where t.pessoa_id = p.id and t.tipo = 'receber' and t.status = 'pago' and t.pago_em > t.vencimento and t.vencimento >= current_date - interval '12 months')::int as com_atraso,
        (select count(*) from titulos t where t.pessoa_id = p.id and t.tipo = 'receber' and t.status = 'aberto' and t.vencimento < current_date)::int as vencidas,
        coalesce((select max(current_date - t.vencimento) from titulos t where t.pessoa_id = p.id and t.tipo = 'receber' and t.status = 'aberto' and t.vencimento < current_date), 0)::int as maior_atraso
      from pessoas p left join niveis n on n.id = p.nivel_id
      where p.tipo = 'representante' ${filtro}
      order by p.nome`);
    return linhas.rows.map((l) => ({
      pessoaId: l.id,
      nome: l.nome,
      cidade: l.cidade,
      nivel: l.nivel,
      ...calcularScore({
        acertos: l.acertos ?? [],
        parcelas: { pagasEmDia: l.em_dia, pagasComAtraso: l.com_atraso, vencidasEmAberto: l.vencidas, maiorAtrasoAbertoDias: l.maior_atraso },
        mesesDeCasa: Number(l.meses) || 0,
      }),
    }));
  }

  /** Ranking do mês pelo vendido nos acertos (completos e parciais). */
  async ranking(mes: string) {
    const { ini, fim } = limitesDoMes(mes);
    const r = await this.db.execute<{ pessoa_id: string; nome: string; cidade: string | null; vendido: string; acertos: number; pontos: number }>(sql`
      select p.id as pessoa_id, p.nome, p.cidade, sum((a.resultado->>'totalVendido')::int)::bigint as vendido, count(*)::int as acertos,
        coalesce((select sum(pt.pontos) from pontos pt where pt.pessoa_id = p.id and pt.pontos > 0 and pt.criado_em >= ${ini}::date and pt.criado_em < ${fim}::date), 0)::int as pontos
      from acertos a join maletas m on m.id = a.maleta_id join pessoas p on p.id = m.representante_id
      where a.data >= ${ini}::date and a.data < ${fim}::date
      group by p.id order by vendido desc, p.nome limit 100`);
    return r.rows.map((x, i) => ({ posicao: i + 1, pessoaId: x.pessoa_id, nome: x.nome, cidade: x.cidade, vendido: Number(x.vendido), acertos: x.acertos, pontos: x.pontos }));
  }

  /** Sugestão de nível pela média de vendas dos 3 meses completos anteriores. */
  async sugestoesDeNivel() {
    const ns = await this.db.select().from(niveis);
    if (!ns.length) return [];
    const r = await this.db.execute<{ id: string; nome: string; nivel_id: string | null; media: string; meses: number }>(sql`
      with base as (
        select m.representante_id as pessoa_id, to_char(a.data, 'YYYY-MM') as mes, sum((a.resultado->>'totalVendido')::int) as vendido
        from acertos a join maletas m on m.id = a.maleta_id
        where a.data >= date_trunc('month', current_date) - interval '3 months' and a.data < date_trunc('month', current_date)
        group by 1, 2)
      select p.id, p.nome, p.nivel_id, coalesce(sum(b.vendido), 0) / 3 as media, count(b.mes)::int as meses
      from pessoas p left join base b on b.pessoa_id = p.id
      where p.tipo = 'representante' and p.status = 'ativo'
      group by p.id order by p.nome`);
    return r.rows
      .map((x) => {
        const media = Math.round(Number(x.media));
        const sug = nivelSugerido(ns, media);
        const atual = ns.find((n) => n.id === x.nivel_id) ?? null;
        return { pessoaId: x.id, nome: x.nome, mediaMensal: media, mesesComVenda: x.meses, atual: atual && { id: atual.id, nome: atual.nome }, sugerido: sug && { id: sug.id, nome: sug.nome }, muda: !!sug && sug.id !== atual?.id, sobe: !!sug && (!atual || sug.ordem > atual.ordem) };
      })
      .filter((x) => x.muda);
  }

  async aplicarNivel(pessoaId: string, nivelId: string, usuarioId: string) {
    const [n] = await this.db.select().from(niveis).where(eq(niveis.id, nivelId));
    if (!n) throw new NotFoundException('Nível não encontrado.');
    const [antes] = await this.db.select({ nivelId: pessoas.nivelId }).from(pessoas).where(eq(pessoas.id, pessoaId));
    await this.db.update(pessoas).set({ nivelId }).where(and(eq(pessoas.id, pessoaId), eq(pessoas.tipo, 'representante')));
    await this.auditoria.registrar({ usuarioId, acao: 'mudar_nivel', entidade: 'pessoa', entidadeId: pessoaId, dados: { de: antes?.nivelId ?? null, para: nivelId } });
    return { ok: true };
  }

  hoje = hoje;
}
