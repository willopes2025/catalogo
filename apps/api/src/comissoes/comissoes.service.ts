import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { aplicarPercentual } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { comissoes, empresas, fechamentosComissao, titulos } from '../db/schema';

export interface LinhaComissao {
  tipo: 'loja' | 'rede';
  usuarioId: string | null;
  pessoaId: string | null;
  nome: string;
  base: number;
  percentualPb: number;
  valor: number;
  meta: number | null;
  detalhes: Record<string, unknown>;
}

/**
 * Comissões do mês.
 *  - Vendedoras da loja e dos eventos: percentual sobre as vendas (já descontadas devoluções), com meta opcional.
 *  - Revendedora líder: percentual sobre o que a rede dela vendeu nos acertos (regra a confirmar com a Aritana; 0% = desligado).
 *  - Representantes: a comissão já fica com elas no acerto; aparece aqui só para conferência.
 */
@Injectable()
export class ComissoesService {
  constructor(@Inject(DB) private readonly db: Db, private readonly config: ConfiguracoesService, private readonly auditoria: AuditoriaService) {}

  private periodo(mes: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new BadRequestException('Mês no formato AAAA-MM.');
    const [a, m] = mes.split('-').map(Number);
    const fim = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
    return { ini: `${mes}-01`, fim };
  }

  async calcular(mes: string) {
    const { ini, fim } = this.periodo(mes);
    const regras = await this.config.ler('regras_comissao');
    const linhas: LinhaComissao[] = [];

    // Vendas da loja e avulsas por vendedora, descontando o que foi devolvido.
    const loja = await this.db.execute<{ usuario_id: string; nome: string; comissao_pb: number | null; meta_mensal: number | null; vendas: number; vendido: string; devolvido: string }>(sql`
      with v as (
        select v.id, v.vendedor_id, v.total,
          coalesce((select sum(vi.devolvida::numeric * vi.total / vi.quantidade) from venda_itens vi where vi.venda_id = v.id), 0)
            * case when (select sum(vi.total) from venda_itens vi where vi.venda_id = v.id) > 0
                   then v.total::numeric / (select sum(vi.total) from venda_itens vi where vi.venda_id = v.id) else 1 end as devolvido
        from vendas v
        where v.status = 'concluida' and v.tipo in ('balcao', 'avulsa') and v.vendedor_id is not null
          and v.criado_em >= (${ini}::date at time zone 'America/Sao_Paulo') and v.criado_em < (${fim}::date at time zone 'America/Sao_Paulo')
      )
      select u.id as usuario_id, u.nome, u.comissao_pb, u.meta_mensal, count(v.id)::int as vendas, sum(v.total)::bigint as vendido, round(sum(v.devolvido))::bigint as devolvido
      from v join usuarios u on u.id = v.vendedor_id
      group by u.id order by u.nome`);
    for (const r of loja.rows) {
      const base = Number(r.vendido) - Number(r.devolvido);
      const pb = r.comissao_pb ?? regras.lojaPadraoPb;
      linhas.push({
        tipo: 'loja',
        usuarioId: r.usuario_id,
        pessoaId: null,
        nome: r.nome,
        base,
        percentualPb: pb,
        valor: aplicarPercentual(base, pb),
        meta: r.meta_mensal,
        detalhes: { vendas: r.vendas, vendido: Number(r.vendido), devolvido: Number(r.devolvido), bateuMeta: r.meta_mensal ? base >= r.meta_mensal : null },
      });
    }

    // Líder: sobre o vendido pelas representantes ligadas a ela, nos acertos do mês.
    if (regras.redeLiderPb > 0) {
      const rede = await this.db.execute<{ lider_id: string; nome: string; vendido: string; acertos: number; representantes: number }>(sql`
        select l.id as lider_id, l.nome, sum((a.resultado->>'totalVendido')::int)::bigint as vendido, count(a.id)::int as acertos, count(distinct p.id)::int as representantes
        from acertos a
        join maletas m on m.id = a.maleta_id
        join pessoas p on p.id = m.representante_id
        join pessoas l on l.id = p.lider_id
        where a.data >= ${ini}::date and a.data < ${fim}::date
        group by l.id order by l.nome`);
      for (const r of rede.rows) {
        const base = Number(r.vendido);
        linhas.push({ tipo: 'rede', usuarioId: null, pessoaId: r.lider_id, nome: r.nome, base, percentualPb: regras.redeLiderPb, valor: aplicarPercentual(base, regras.redeLiderPb), meta: null, detalhes: { acertos: r.acertos, representantes: r.representantes } });
      }
    }

    // Conferência: comissão que as representantes já reteve nos acertos.
    const retida = await this.db.execute<{ nome: string; acertos: number; vendido: string; comissao: string }>(sql`
      select p.nome, count(a.id)::int as acertos, sum((a.resultado->>'totalVendido')::int)::bigint as vendido, sum((a.resultado->>'comissao')::int)::bigint as comissao
      from acertos a join maletas m on m.id = a.maleta_id join pessoas p on p.id = m.representante_id
      where a.data >= ${ini}::date and a.data < ${fim}::date
      group by p.id order by comissao desc`);

    const [fech] = await this.db.select().from(fechamentosComissao).where(eq(fechamentosComissao.mes, mes));
    return {
      mes,
      regras,
      fechado: !!fech,
      fechadoEm: fech?.criadoEm ?? null,
      linhas,
      total: linhas.reduce((a, l) => a + l.valor, 0),
      representantes: retida.rows.map((r) => ({ nome: r.nome, acertos: r.acertos, vendido: Number(r.vendido), comissao: Number(r.comissao) })),
    };
  }

  /** Fecha o mês: grava as comissões e gera as contas a pagar. */
  async fechar(mes: string, usuarioId: string) {
    const c = await this.calcular(mes);
    if (c.fechado) throw new BadRequestException('Este mês já foi fechado.');
    const aPagar = c.linhas.filter((l) => l.valor > 0);
    const [a, m] = mes.split('-').map(Number);
    const venc = m === 12 ? `${a + 1}-01-${String(c.regras.diaPagamento).padStart(2, '0')}` : `${a}-${String(m + 1).padStart(2, '0')}-${String(c.regras.diaPagamento).padStart(2, '0')}`;
    return this.db.transaction(async (tx) => {
      const [matriz] = await tx.select().from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
      const [f] = await tx.insert(fechamentosComissao).values({ mes, total: c.total, usuarioId }).returning();
      for (const l of aPagar) {
        const [t] = await tx
          .insert(titulos)
          .values({ empresaId: matriz.id, tipo: 'pagar', pessoaId: l.pessoaId, descricao: `Comissão ${l.tipo === 'rede' ? 'da rede' : 'de vendas'} · ${l.nome} · ${mes.slice(5)}/${mes.slice(0, 4)}`, categoria: 'Comissões', valor: l.valor, vencimento: venc, origemTipo: 'comissao', origemId: f.id })
          .returning();
        await tx.insert(comissoes).values({ fechamentoId: f.id, tipo: l.tipo, usuarioId: l.usuarioId, pessoaId: l.pessoaId, nome: l.nome, base: l.base, percentualPb: l.percentualPb, valor: l.valor, meta: l.meta, detalhes: l.detalhes, tituloId: t.id });
      }
      await this.auditoria.registrar({ usuarioId, acao: 'fechar_comissoes', entidade: 'comissoes', entidadeId: f.id, dados: { mes, total: c.total, linhas: aPagar.length } }, tx);
      return { ...f, linhas: aPagar.length };
    });
  }

  /** Desfaz o fechamento enquanto nenhuma comissão foi paga. */
  async reabrir(mes: string, usuarioId: string) {
    return this.db.transaction(async (tx) => {
      const [f] = await tx.select().from(fechamentosComissao).where(eq(fechamentosComissao.mes, mes));
      if (!f) throw new BadRequestException('Este mês não está fechado.');
      const ts = await tx.select({ id: titulos.id, status: titulos.status }).from(titulos).where(and(eq(titulos.origemTipo, 'comissao'), eq(titulos.origemId, f.id)));
      if (ts.some((t) => t.status === 'pago')) throw new BadRequestException('Já há comissão paga neste mês; não dá para reabrir.');
      if (ts.length) await tx.update(titulos).set({ status: 'cancelado' }).where(inArray(titulos.id, ts.map((t) => t.id)));
      await tx.update(comissoes).set({ tituloId: null }).where(eq(comissoes.fechamentoId, f.id));
      await tx.delete(fechamentosComissao).where(eq(fechamentosComissao.id, f.id));
      await this.auditoria.registrar({ usuarioId, acao: 'reabrir_comissoes', entidade: 'comissoes', dados: { mes } }, tx);
      return { ok: true };
    });
  }
}
