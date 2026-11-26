import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { DB, type Db } from '../comum/db.module';
import { dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { empresas, locaisEstoque } from '../db/schema';

const eventoSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome ao evento').max(80),
  empresaId: z.string().uuid().optional(),
  inicio: dataISO.nullable().optional(),
  fim: dataISO.nullable().optional(),
  cidade: z.string().trim().max(80).nullable().optional(),
  observacao: z.string().trim().max(500).nullable().optional(),
  ativo: z.boolean().optional(),
});

/**
 * Eventos (feiras, bazares, Bioma…): cada um é um ponto de venda com estoque próprio e também o centro de custo
 * do evento. As vendas do caixa do evento e as despesas lançadas com ele formam o resultado do evento.
 */
@Controller('eventos')
export class EventosController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
  ) {}

  @Get()
  listar() {
    return this.db
      .select({ id: locaisEstoque.id, nome: locaisEstoque.nome, empresaId: locaisEstoque.empresaId, empresa: empresas.nome, inicio: locaisEstoque.inicio, fim: locaisEstoque.fim, cidade: locaisEstoque.cidade, observacao: locaisEstoque.observacao, ativo: locaisEstoque.ativo })
      .from(locaisEstoque)
      .innerJoin(empresas, eq(empresas.id, locaisEstoque.empresaId))
      .where(eq(locaisEstoque.tipo, 'evento'))
      .orderBy(desc(locaisEstoque.ativo), sql`${locaisEstoque.inicio} desc nulls last`, locaisEstoque.nome);
  }

  @Post()
  @Permissao('lojas', 'editar')
  async criar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(eventoSchema, body);
    if (d.inicio && d.fim && d.fim < d.inicio) throw new BadRequestException('O fim do evento precisa ser depois do início.');
    // Sem empresa escolhida: os eventos são do CNPJ da matriz.
    const [emp] = d.empresaId ? await this.db.select().from(empresas).where(eq(empresas.id, d.empresaId)) : await this.db.select().from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    if (!emp) throw new BadRequestException('Empresa não encontrada.');
    const [igual] = await this.db.select({ id: locaisEstoque.id }).from(locaisEstoque).where(and(eq(locaisEstoque.tipo, 'evento'), sql`lower(${locaisEstoque.nome}) = lower(${d.nome})`));
    if (igual) throw new BadRequestException('Já existe um evento com esse nome.');
    const [l] = await this.db.insert(locaisEstoque).values({ empresaId: emp.id, nome: d.nome, tipo: 'evento', inicio: d.inicio ?? null, fim: d.fim ?? null, cidade: d.cidade ?? null, observacao: d.observacao ?? null, ativo: d.ativo ?? true }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'evento', entidadeId: l.id, dados: { nome: l.nome } });
    return l;
  }

  @Patch(':id')
  @Permissao('lojas', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(locaisEstoque).where(and(eq(locaisEstoque.id, id), eq(locaisEstoque.tipo, 'evento')));
    if (!atual) throw new NotFoundException('Evento não encontrado.');
    const d = validar(eventoSchema.partial(), body);
    const inicio = d.inicio !== undefined ? d.inicio : atual.inicio;
    const fim = d.fim !== undefined ? d.fim : atual.fim;
    if (inicio && fim && fim < inicio) throw new BadRequestException('O fim do evento precisa ser depois do início.');
    if (d.ativo === false) {
      const [r] = await this.db.execute<{ pecas: number; caixa: boolean }>(sql`
        select coalesce((select sum(quantidade) from saldos where local_id = ${id}::uuid), 0)::int as pecas,
          exists (select 1 from caixas where local_id = ${id}::uuid and status = 'aberto') as caixa`).then((x) => x.rows);
      if (r.caixa) throw new BadRequestException('Feche o caixa do evento antes de encerrar.');
      if (r.pecas > 0) throw new BadRequestException(`Ainda há ${r.pecas} peça(s) no estoque do evento. Transfira de volta antes de encerrar.`);
    }
    const [l] = await this.db.update(locaisEstoque).set({ ...(d.nome ? { nome: d.nome } : {}), ...(d.empresaId ? { empresaId: d.empresaId } : {}), inicio, fim, ...(d.cidade !== undefined ? { cidade: d.cidade } : {}), ...(d.observacao !== undefined ? { observacao: d.observacao } : {}), ...(d.ativo !== undefined ? { ativo: d.ativo } : {}) }).where(eq(locaisEstoque.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'evento', entidadeId: id, dados: d });
    return l;
  }
}
