import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { movimentos, saldos, produtos } from '../db/schema';

export type TipoMovimento = (typeof movimentos.$inferInsert)['tipo'];

export interface Movimento {
  produtoId: string;
  origemId?: string | null;
  destinoId?: string | null;
  quantidade: number;
  tipo: TipoMovimento;
  motivo?: string | null;
  referenciaTipo?: string | null;
  referenciaId?: string | null;
  usuarioId?: string | null;
}

/**
 * Único ponto do sistema que mexe no estoque.
 * Grava o movimento (livro-caixa) e atualiza os saldos de origem e destino na mesma transação.
 * Nunca deixa um saldo ficar negativo.
 */
@Injectable()
export class EstoqueService {
  async mover(tx: Tx, m: Movimento) {
    if (!Number.isInteger(m.quantidade) || m.quantidade <= 0) throw new BadRequestException('Quantidade deve ser maior que zero.');
    if (!m.origemId && !m.destinoId) throw new BadRequestException('Movimento sem origem nem destino.');

    await tx.insert(movimentos).values({ ...m });

    if (m.origemId) {
      const [s] = await tx
        .insert(saldos)
        .values({ produtoId: m.produtoId, localId: m.origemId, quantidade: -m.quantidade })
        .onConflictDoUpdate({ target: [saldos.produtoId, saldos.localId], set: { quantidade: sql`${saldos.quantidade} - ${m.quantidade}` } })
        .returning();
      if (s.quantidade < 0) {
        const [p] = await tx.select({ d: produtos.descricao, c: produtos.codigoBarras }).from(produtos).where(eq(produtos.id, m.produtoId));
        throw new BadRequestException(`Estoque insuficiente de ${p?.d ?? 'produto'} (${p?.c ?? ''}): faltam ${-s.quantidade}.`);
      }
    }
    if (m.destinoId) {
      await tx
        .insert(saldos)
        .values({ produtoId: m.produtoId, localId: m.destinoId, quantidade: m.quantidade })
        .onConflictDoUpdate({ target: [saldos.produtoId, saldos.localId], set: { quantidade: sql`${saldos.quantidade} + ${m.quantidade}` } });
    }
  }

  async saldo(tx: Tx, produtoId: string, localId: string) {
    const [s] = await tx.select().from(saldos).where(and(eq(saldos.produtoId, produtoId), eq(saldos.localId, localId)));
    return s?.quantidade ?? 0;
  }
}
