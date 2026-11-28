import { BadRequestException, Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { metas } from '../db/schema';
import { hoje } from '../maletas/maletas.service';
import { numeros } from './fontes';
import { sqlAtivos, sqlChurn, sqlRenovacoes } from './consignado';

export const TIPOS_META = {
  faturamento: { nome: 'Faturamento total', dinheiro: true },
  rede: { nome: 'Vendido pela rede (acertos)', dinheiro: true },
  lojas: { nome: 'Lojas', dinheiro: true },
  eventos: { nome: 'Eventos', dinheiro: true },
  local: { nome: 'Por loja ou evento', dinheiro: true },
  novas_revendedoras: { nome: 'Novas revendedoras', dinheiro: false },
  consultoras_ativas: { nome: 'Consultoras que acertaram no mês', dinheiro: false },
  maletas_ativas: { nome: 'Pedidos ativos (com a consultora)', dinheiro: false },
  renovacoes: { nome: 'Renovações (novo pedido de quem já teve)', dinheiro: false },
  churn: { nome: 'Churn: consultoras que não renovaram (máximo)', dinheiro: false, menor: true },
} as const;
const menor = (t: string) => !!(TIPOS_META as Record<string, { menor?: boolean }>)[t]?.menor;
type TipoMeta = keyof typeof TIPOS_META;

const comp = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM');
const pb = (a: number, b: number) => (b > 0 ? Math.round((a * 10000) / b) : 0);

/** Período do mês e quanto dele já passou (para o ritmo e a projeção). */
function mes(c: string) {
  const [a, m] = c.split('-').map(Number);
  const dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const ini = `${c}-01`;
  const fim = `${c}-${String(dias).padStart(2, '0')}`;
  const h = hoje();
  const decorridos = h < ini ? 0 : h > fim ? dias : Number(h.slice(8, 10));
  return { ini, fim, dias, decorridos, restantes: dias - decorridos };
}

/**
 * Metas do mês: a empresa define quanto quer vender por canal e por loja; o sistema mostra o realizado,
 * o ritmo (projeção para o fim do mês) e quanto precisa por dia para chegar lá.
 * Metas de cada consultora e de cada vendedora ficam no cadastro delas; aqui aparecem juntas.
 */
@Controller('metas')
export class MetasController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  private async realizados(ini: string, fim: string) {
    const [r] = numeros<Record<string, number>>(
      await this.db.execute(sql`
        select
          (select coalesce(sum((resultado->>'totalVendido')::bigint), 0) from acertos where data between ${ini}::date and ${fim}::date) as rede,
          (select coalesce(sum(v.total - v.devolvido), 0) from vendas v join locais_estoque l on l.id = v.local_id where v.status = 'concluida' and v.criado_em::date between ${ini}::date and ${fim}::date and l.tipo = 'loja' and v.tipo = 'balcao') as lojas,
          (select coalesce(sum(v.total - v.devolvido), 0) from vendas v join locais_estoque l on l.id = v.local_id where v.status = 'concluida' and v.criado_em::date between ${ini}::date and ${fim}::date and l.tipo = 'evento') as eventos,
          (select coalesce(sum(v.total - v.devolvido), 0) from vendas v where v.status = 'concluida' and v.criado_em::date between ${ini}::date and ${fim}::date) as balcao,
          (select count(*) from pessoas where tipo = 'representante' and id_jueri is null and criado_em::date between ${ini}::date and ${fim}::date)::int as novas_revendedoras,
          (select count(distinct m.representante_id) from acertos a join maletas m on m.id = a.maleta_id where a.data between ${ini}::date and ${fim}::date)::int as consultoras_ativas`),
    );
    const porLocal = numeros<{ id: string; valor: number }>(
      await this.db.execute(sql`select local_id as id, coalesce(sum(total - devolvido), 0) as valor from vendas where status = 'concluida' and criado_em::date between ${ini}::date and ${fim}::date group by local_id`),
    );
    const um = async (q: ReturnType<typeof sqlAtivos>) => Number((await this.db.execute<{ v: number }>(q)).rows[0]?.v ?? 0);
    const fimAte = fim < hoje() ? fim : hoje();
    const [maletas_ativas, renovacoes, churn] = await Promise.all([um(sqlAtivos(fimAte)), um(sqlRenovacoes(ini, fim)), um(sqlChurn(ini, fim))]);
    return { ...r, maletas_ativas, renovacoes, churn, faturamento: r.rede + r.balcao, local: new Map(porLocal.map((x) => [x.id, x.valor])) };
  }

  @Get()
  @Permissao('relatorios', 'ver')
  async ver(@Query('competencia') c?: string) {
    const competencia = validar(comp, c ?? hoje().slice(0, 7));
    const p = mes(competencia);
    const [a, m] = competencia.split('-').map(Number);
    const anterior = new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7);
    const pa = mes(anterior);
    const [real, realAnt] = await Promise.all([this.realizados(p.ini, p.fim), this.realizados(pa.ini, pa.fim)]);
    const definidas = await this.db.execute<{ id: string; tipo: TipoMeta; local_id: string | null; valor: number; local: string | null }>(sql`
      select m.id, m.tipo, m.local_id, m.valor, l.nome as local from metas m left join locais_estoque l on l.id = m.local_id where m.competencia = ${competencia} order by m.tipo, l.nome`);
    const linhas = definidas.rows.map((d) => {
      const realizado = d.tipo === 'local' ? (real.local.get(d.local_id!) ?? 0) : Number((real as Record<string, unknown>)[d.tipo] ?? 0);
      const mesAnterior = d.tipo === 'local' ? (realAnt.local.get(d.local_id!) ?? 0) : Number((realAnt as Record<string, unknown>)[d.tipo] ?? 0);
      // Projeção pelo ritmo do mês até hoje (mês fechado: o próprio realizado). Pedidos ativos é uma foto: não projeta.
      const projecao = p.restantes === 0 || d.tipo === 'maletas_ativas' ? realizado : p.decorridos > 0 ? Math.round((realizado / p.decorridos) * p.dias) : 0;
      if (menor(d.tipo)) {
        // Churn: a meta é um teto (quanto menos, melhor).
        return {
          id: d.id, tipo: d.tipo, nome: TIPOS_META[d.tipo]?.nome ?? d.tipo, localId: d.local_id, dinheiro: false, menor: true,
          meta: d.valor, realizado, atingidoPb: pb(realizado, d.valor), projecao, projecaoPb: pb(projecao, d.valor),
          falta: 0, porDia: 0, mesAnterior,
          situacao: p.restantes === 0 ? (realizado <= d.valor ? 'batida' : 'nao_batida') : projecao <= d.valor ? 'no_ritmo' : realizado <= d.valor ? 'perto' : 'abaixo',
        };
      }
      const falta = Math.max(0, d.valor - realizado);
      return {
        id: d.id,
        tipo: d.tipo,
        nome: d.tipo === 'local' ? (d.local ?? 'Loja') : TIPOS_META[d.tipo]?.nome ?? d.tipo,
        localId: d.local_id,
        dinheiro: TIPOS_META[d.tipo]?.dinheiro ?? true,
        meta: d.valor,
        realizado,
        atingidoPb: pb(realizado, d.valor),
        projecao,
        projecaoPb: pb(projecao, d.valor),
        falta,
        porDia: p.restantes > 0 && falta > 0 ? Math.ceil(falta / p.restantes) : 0,
        mesAnterior,
        situacao: realizado >= d.valor ? 'batida' : p.restantes === 0 ? 'nao_batida' : projecao >= d.valor ? 'no_ritmo' : projecao >= d.valor * 0.9 ? 'perto' : 'abaixo',
      };
    });

    // Consultoras: a meta é a do cadastro; sem ela, a do nível.
    const consultoras = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select p.id, p.nome, coalesce(nullif(p.meta_mensal, 0), n.meta_mensal, 0) as meta, n.nome as nivel,
          coalesce((select sum((a.resultado->>'totalVendido')::bigint) from acertos a join maletas mm on mm.id = a.maleta_id where mm.representante_id = p.id and a.data between ${p.ini}::date and ${p.fim}::date), 0) as vendido,
          exists (select 1 from maletas mm where mm.representante_id = p.id and mm.status = 'aberta') as com_maleta
        from pessoas p left join niveis n on n.id = p.nivel_id
        where p.tipo = 'representante' and p.status = 'ativo' and coalesce(nullif(p.meta_mensal, 0), n.meta_mensal, 0) > 0
        order by p.nome`),
    ).map((x) => ({ ...x, atingidoPb: pb(x.vendido, x.meta) }) as Record<string, any>);
    const vendedoras = numeros<Record<string, any>>(
      await this.db.execute(sql`
        select u.id, u.nome, u.meta_mensal as meta,
          coalesce((select sum(v.total - v.devolvido) from vendas v where v.vendedor_id = u.id and v.status = 'concluida' and v.criado_em::date between ${p.ini}::date and ${p.fim}::date), 0) as vendido
        from usuarios u where u.ativo and u.meta_mensal > 0 order by u.nome`),
    ).map((x) => ({ ...x, atingidoPb: pb(x.vendido, x.meta), projecao: p.decorridos ? Math.round((x.vendido / p.decorridos) * p.dias) : 0 }));
    return {
      competencia,
      dias: p.dias,
      decorridos: p.decorridos,
      restantes: p.restantes,
      tipos: TIPOS_META,
      linhas,
      consultoras: {
        total: consultoras.length,
        bateram: consultoras.filter((x) => x.vendido >= x.meta).length,
        lista: consultoras.sort((x, y) => y.atingidoPb - x.atingidoPb),
      },
      vendedoras,
    };
  }

  /** Grava as metas do mês (substitui as do mês). */
  @Put()
  @Permissao('relatorios', 'editar')
  async salvar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        competencia: comp,
        metas: z.array(z.object({ tipo: z.enum(Object.keys(TIPOS_META) as [TipoMeta]), localId: z.string().uuid().nullable().optional(), valor: z.number().int().min(1, 'Meta precisa ser maior que zero') })).max(60),
      }),
      body,
    );
    const chaves = d.metas.map((x) => `${x.tipo}:${x.localId ?? ''}`);
    if (new Set(chaves).size !== chaves.length) throw new BadRequestException('Meta repetida no mesmo mês.');
    if (d.metas.some((x) => x.tipo === 'local' && !x.localId)) throw new BadRequestException('Escolha a loja ou o evento da meta.');
    await this.db.transaction(async (tx) => {
      await tx.delete(metas).where(eq(metas.competencia, d.competencia));
      if (d.metas.length) await tx.insert(metas).values(d.metas.map((x) => ({ competencia: d.competencia, tipo: x.tipo, localId: x.tipo === 'local' ? x.localId! : null, valor: x.valor })));
    });
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'metas', dados: { competencia: d.competencia, metas: d.metas.length } });
    return this.ver(d.competencia);
  }
}
