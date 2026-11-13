import { Controller, Get, Inject } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { somarDias } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao } from '../comum/auth';
import { acertos, auditoria, maletaItens, maletas, pessoas, titulos, usuarios } from '../db/schema';
import { hoje } from '../maletas/maletas.service';

/** Tela Início: o que precisa de atenção hoje. */
@Controller('painel')
export class PainelController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('inicio')
  @Permissao('inicio', 'ver')
  async inicio() {
    const h = hoje();
    const em7 = somarDias(h, 7);
    const inicioMes = h.slice(0, 8) + '01';
    const naMaleta = sql`(${maletaItens.enviada} - ${maletaItens.vendida} - ${maletaItens.devolvida} - ${maletaItens.perdida})`;

    const [m] = await this.db
      .select({
        abertas: sql<number>`count(distinct ${maletas.id})::int`,
        atrasadas: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.dataLimite} < ${h})::int`,
        vencendo: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.dataLimite} between ${h} and ${em7})::int`,
        acertosHoje: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.dataLimite} = ${h})::int`,
        pecasNaRua: sql<number>`coalesce(sum(${naMaleta}),0)::int`,
        valorNaRua: sql<number>`coalesce(sum(${maletaItens.preco} * ${naMaleta}),0)::bigint`,
        prebaixasPendentes: sql<number>`count(distinct ${maletas.id}) filter (where ${maletas.prebaixaEm} is not null)::int`,
      })
      .from(maletas)
      .leftJoin(maletaItens, eq(maletaItens.maletaId, maletas.id))
      .where(eq(maletas.status, 'aberta'));

    const [rede] = await this.db
      .select({
        ativas: sql<number>`count(*) filter (where ${pessoas.status} = 'ativo')::int`,
        triagem: sql<number>`count(*) filter (where ${pessoas.status} = 'triagem')::int`,
        novasMes: sql<number>`count(*) filter (where ${pessoas.criadoEm} >= ${inicioMes}::date)::int`,
        bloqueadas: sql<number>`count(*) filter (where ${pessoas.bloqueado})::int`,
        semMaleta: sql<number>`count(*) filter (where ${pessoas.status} = 'ativo' and ${pessoas.modeloTrabalho} = 'consignado' and not exists (select 1 from ${maletas} mm where mm.representante_id = ${pessoas.id} and mm.status = 'aberta'))::int`,
      })
      .from(pessoas)
      .where(eq(pessoas.tipo, 'representante'));

    const [fin] = await this.db
      .select({
        receberHoje: sql<number>`coalesce(sum(${titulos.valor}) filter (where ${titulos.vencimento} = ${h}),0)::bigint`,
        vencido: sql<number>`coalesce(sum(${titulos.valor}) filter (where ${titulos.vencimento} < ${h}),0)::bigint`,
        aReceber: sql<number>`coalesce(sum(${titulos.valor}),0)::bigint`,
      })
      .from(titulos)
      .where(and(eq(titulos.tipo, 'receber'), eq(titulos.status, 'aberto')));

    const [mes] = await this.db
      .select({
        acertos: sql<number>`count(*)::int`,
        vendido: sql<number>`coalesce(sum((${acertos.resultado}->>'totalVendido')::int),0)::bigint`,
        recebido: sql<number>`coalesce(sum(${acertos.totalAPagar}),0)::bigint`,
        percentualMedio: sql<number>`coalesce(avg((${acertos.resultado}->>'percentualVendidoPb')::int),0)::int`,
      })
      .from(acertos)
      .where(sql`${acertos.data} >= ${inicioMes}::date`);

    const atividades = await this.db
      .select({ criadoEm: auditoria.criadoEm, acao: auditoria.acao, entidade: auditoria.entidade, usuario: usuarios.nome })
      .from(auditoria)
      .leftJoin(usuarios, eq(usuarios.id, auditoria.usuarioId))
      .where(sql`${auditoria.acao} <> 'login'`)
      .orderBy(desc(auditoria.criadoEm))
      .limit(12);

    const n = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v]));
    return { data: h, maletas: n(m), rede: n(rede), financeiro: n(fin), mes: n(mes), atividades };
  }
}
