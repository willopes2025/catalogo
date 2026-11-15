import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { crmDistribuicoes, crmFunis, crmLeads } from '../db/schema';
import { DistribuicaoService } from './distribuicao.service';

const configSchema = z.object({
  ativo: z.boolean(),
  destino: z.enum(['consultoras', 'lideres']),
  raioKm: z.number().int().min(1).max(3000),
  prazoMinutos: z.number().int().min(5).max(7 * 24 * 60),
  maxTentativas: z.number().int().min(1).max(10),
  maxAbertos: z.number().int().min(1).max(200),
  soComMaleta: z.boolean().default(false),
  avisarWhatsapp: z.boolean().default(true),
  canalId: z.string().uuid().nullable().optional(),
});

/** CRM › distribuição dos leads por localização (configuração por funil e ações no card). */
@Controller('crm')
export class DistribuicaoController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: DistribuicaoService, private readonly auditoria: AuditoriaService) {}

  @Get('distribuicao')
  @Permissao('crm', 'ver')
  async listar() {
    const funis = await this.db.select({ id: crmFunis.id, nome: crmFunis.nome, tipo: crmFunis.tipo }).from(crmFunis).where(eq(crmFunis.ativo, true));
    const cfgs = await this.db.select().from(crmDistribuicoes);
    const fora = await this.svc.semCidade();
    return { funis: funis.map((f) => ({ funil: f, config: cfgs.find((c) => c.funilId === f.id) ?? null })), semCidade: { total: fora.length, lista: fora.slice(0, 30) } };
  }

  @Put('distribuicao/:funilId')
  @Permissao('crm', 'editar')
  async salvar(@Usuario() u: UsuarioLogado, @Param('funilId', ParseUUIDPipe) funilId: string, @Body() body: unknown) {
    const d = validar(configSchema, body);
    const [f] = await this.db.select({ id: crmFunis.id }).from(crmFunis).where(eq(crmFunis.id, funilId));
    if (!f) throw new NotFoundException('Funil não encontrado.');
    const valores = { ...d, canalId: d.canalId ?? null, atualizadoEm: new Date() };
    const [c] = await this.db.insert(crmDistribuicoes).values({ funilId, ...valores }).onConflictDoUpdate({ target: crmDistribuicoes.funilId, set: valores }).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'crm_distribuicao', entidadeId: funilId, dados: d });
    return c;
  }

  /** Quem está perto do lead (para a equipe escolher na mão), com distância e quantos leads cada uma já tem. */
  @Get('leads/:id/perto')
  @Permissao('crm', 'ver')
  async perto(@Param('id', ParseUUIDPipe) id: string) {
    const [l] = await this.db.select().from(crmLeads).where(eq(crmLeads.id, id));
    if (!l) throw new NotFoundException('Card não encontrado.');
    const ponto = await this.svc.localDoLead(l);
    const cfg = (await this.svc.config(l.funilId)) ?? { destino: 'consultoras' as const, raioKm: 50, maxAbertos: 10, soComMaleta: false };
    const lista = ponto ? (await this.svc.candidatas(l, cfg, ponto, { ignorarLimites: true })).slice(0, 15) : [];
    return { local: ponto, destino: cfg.destino, lista: lista.map(({ telefone: _t, ...x }) => ({ ...x, jaRecebeu: l.jaOferecido.includes(x.id) })) };
  }

  @Post('leads/:id/distribuir')
  @Permissao('crm', 'editar')
  async distribuir(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ pessoaId: z.string().uuid().nullable().optional() }), body ?? {});
    const r = await this.svc.distribuir(id, { pessoaId: d.pessoaId ?? undefined, usuarioId: u.id });
    return { distribuido: !!r, consultora: r ? { id: r.id, nome: r.nome, distanciaKm: r.distanciaKm } : null };
  }

  /** Tira o lead da consultora e devolve para a equipe. */
  @Post('leads/:id/devolver')
  @Permissao('crm', 'editar')
  async devolver(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.devolver(id, u.id);
  }

  /** Para a equipe (e os testes) rodarem a checagem de prazos na hora. */
  @Post('distribuicao/verificar-prazos')
  @Permissao('crm', 'editar')
  verificar() {
    return this.svc.verificarPrazos();
  }
}
