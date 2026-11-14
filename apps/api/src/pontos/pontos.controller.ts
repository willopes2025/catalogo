import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { opcional, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { pessoas, premios, resgates } from '../db/schema';
import { PontosService } from './pontos.service';
import { hoje } from '../maletas/maletas.service';

const premioSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  descricao: opcional(500),
  pontos: z.number().int().min(1).max(1_000_000),
  estoque: z.number().int().min(0).nullable().optional(),
  foto: z.string().url().max(1000).nullable().optional().or(z.literal('').transform(() => null)),
  ativo: z.boolean().optional(),
});

@Controller()
export class PontosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: PontosService, private readonly auditoria: AuditoriaService) {}

  /** Score interno de toda a rede ativa (só a matriz vê). */
  @Get('rede/score')
  @Permissao('rede', 'ver')
  scores() {
    return this.svc.scores();
  }

  @Get('rede/:id/score')
  @Permissao('rede', 'ver')
  async score(@Param('id', ParseUUIDPipe) id: string) {
    const [s] = await this.svc.scores(id);
    if (!s) throw new NotFoundException('Representante não encontrada.');
    await this.svc.apurar(true);
    return { ...s, saldoPontos: await this.svc.saldo(id) };
  }

  @Get('pontos/ranking')
  @Permissao('pontos', 'ver')
  async ranking(@Query('mes') mes?: string) {
    await this.svc.apurar(true);
    return this.svc.ranking(mes ?? hoje().slice(0, 7));
  }

  @Post('pontos/apurar')
  @Permissao('pontos', 'editar')
  apurar() {
    return this.svc.apurar();
  }

  @Get('pontos/saldos')
  @Permissao('pontos', 'ver')
  async saldos() {
    await this.svc.apurar(true);
    const r = await this.db.execute<{ id: string; nome: string; saldo: number; ganhos: number; resgatados: number }>(sql`
      select p.id, p.nome, coalesce(sum(pt.pontos), 0)::int as saldo,
        coalesce(sum(pt.pontos) filter (where pt.pontos > 0 and pt.regra <> 'estorno'), 0)::int as ganhos,
        coalesce(-sum(pt.pontos) filter (where pt.regra = 'resgate'), 0)::int as resgatados
      from pessoas p join pontos pt on pt.pessoa_id = p.id
      where p.tipo = 'representante' group by p.id having sum(pt.pontos) <> 0 or count(*) > 0 order by saldo desc, p.nome limit 500`);
    return r.rows;
  }

  @Get('pontos/extrato/:pessoaId')
  @Permissao('pontos', 'ver')
  extrato(@Param('pessoaId', ParseUUIDPipe) pessoaId: string) {
    return this.svc.extrato(pessoaId);
  }

  @Post('pontos/ajuste')
  @Permissao('pontos', 'editar')
  ajuste(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ pessoaId: z.string().uuid(), pontos: z.number().int().refine((n) => n !== 0, 'Informe os pontos').refine((n) => Math.abs(n) <= 100_000, 'Valor alto demais'), motivo: z.string().trim().min(3, 'Informe o motivo').max(200) }), body);
    return this.svc.ajustar(d.pessoaId, d.pontos, d.motivo, u.id);
  }

  // ───── Prêmios ─────

  @Get('pontos/premios')
  @Permissao('pontos', 'ver')
  listarPremios() {
    return this.db.select().from(premios).orderBy(premios.pontos);
  }

  @Post('pontos/premios')
  @Permissao('pontos', 'criar')
  async criarPremio(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const [p] = await this.db.insert(premios).values(validar(premioSchema, body)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'premio', entidadeId: p.id });
    return p;
  }

  @Patch('pontos/premios/:id')
  @Permissao('pontos', 'editar')
  async editarPremio(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(premioSchema.partial(), body);
    const [p] = await this.db.update(premios).set(d).where(eq(premios.id, id)).returning();
    if (!p) throw new NotFoundException('Prêmio não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'premio', entidadeId: id, dados: d });
    return p;
  }

  // ───── Resgates ─────

  @Get('pontos/resgates')
  @Permissao('pontos', 'ver')
  listarResgates(@Query('status') status = 'solicitado') {
    return this.db
      .select({ id: resgates.id, numero: resgates.numero, pessoaId: resgates.pessoaId, representante: pessoas.nome, telefone: pessoas.telefone1, premio: premios.nome, pontos: resgates.pontos, status: resgates.status, observacao: resgates.observacao, criadoEm: resgates.criadoEm, atendidoEm: resgates.atendidoEm })
      .from(resgates)
      .innerJoin(pessoas, eq(pessoas.id, resgates.pessoaId))
      .innerJoin(premios, eq(premios.id, resgates.premioId))
      .where(status === 'todos' ? undefined : eq(resgates.status, status))
      .orderBy(desc(resgates.criadoEm))
      .limit(300);
  }

  @Post('pontos/resgates/:id')
  @Permissao('pontos', 'editar')
  atender(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ status: z.enum(['entregue', 'cancelado']), observacao: opcional(300) }), body);
    return this.svc.atenderResgate(id, d.status, d.observacao ?? null, u.id);
  }

  // ───── Níveis ─────

  @Get('pontos/niveis/sugestoes')
  @Permissao('rede', 'ver')
  sugestoes() {
    return this.svc.sugestoesDeNivel();
  }

  @Post('pontos/niveis/aplicar')
  @Permissao('rede', 'editar')
  aplicarNivel(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ pessoaId: z.string().uuid(), nivelId: z.string().uuid() }), body);
    return this.svc.aplicarNivel(d.pessoaId, d.nivelId, u.id);
  }
}
