import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Representante, RotaPortal, Usuario, type RepresentanteLogada, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { CONFIGS } from '../configuracoes/outras-configuracoes';
import { candidaturas, indicacoes, indicadores, pessoas, titulos, usuarios } from '../db/schema';
import { IndicacoesService } from './indicacoes.service';

const STATUS = ['candidata', 'aprovada', 'liberada', 'paga', 'recusada', 'expirada', 'cancelada'] as const;

/** Indique e ganhe: o link de cada um, o convite público e a gestão dos prêmios. */
@Controller()
export class IndicacoesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly svc: IndicacoesService,
    private readonly config: ConfiguracoesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** O link de indicação de quem está no painel (qualquer pessoa da equipe). */
  @Get('indicacoes/meu')
  @Permissao('inicio', 'ver')
  meu(@Usuario() u: UsuarioLogado) {
    return this.svc.meu({ usuarioId: u.id });
  }

  /** O link de indicação da consultora, no portal/app. */
  @RotaPortal()
  @Get('portal/indicacoes')
  doPortal(@Representante() r: RepresentanteLogada) {
    return this.svc.meu({ pessoaId: r.rep });
  }

  /** Para o formulário de cadastro mostrar quem convidou (só o primeiro nome). */
  @Publico()
  @Get('publico/indicacao/:codigo')
  async convite(@Param('codigo') codigo: string) {
    const regras = await this.svc.regras();
    const d = regras.ativo ? await this.svc.dono(codigo) : null;
    if (!d || !d.ativo) throw new NotFoundException('Convite não encontrado.');
    return { nome: d.nome.trim().split(/\s+/)[0] };
  }

  // ───────── Gestão ─────────

  @Get('indicacoes')
  @Permissao('rede', 'ver')
  async listar(@Query('status') status?: string) {
    const st = sql<string>`case when ${indicacoes.status} = 'liberada' and ${titulos.status} = 'pago' then 'paga' else ${indicacoes.status} end`;
    const filtro = status && (STATUS as readonly string[]).includes(status) ? sql`${st} = ${status}` : undefined;
    const itens = await this.db
      .select({
        id: indicacoes.id,
        status: st,
        criadoEm: indicacoes.criadoEm,
        aprovadaEm: indicacoes.aprovadaEm,
        liberadaEm: indicacoes.liberadaEm,
        valor: indicacoes.valor,
        motivoLiberacao: indicacoes.motivoLiberacao,
        motivoCancelamento: indicacoes.motivoCancelamento,
        tituloId: indicacoes.tituloId,
        candidaturaId: indicacoes.candidaturaId,
        indicada: candidaturas.nome,
        cidade: candidaturas.cidade,
        uf: candidaturas.uf,
        indicadaPessoaId: indicacoes.indicadaPessoaId,
        indicador: sql<string>`coalesce(${pessoas.nome}, ${usuarios.nome})`,
        indicadorTipo: sql<string>`case when ${indicadores.usuarioId} is not null then 'equipe' else 'consultora' end`,
        codigo: indicadores.codigo,
      })
      .from(indicacoes)
      .innerJoin(indicadores, eq(indicadores.id, indicacoes.indicadorId))
      .innerJoin(candidaturas, eq(candidaturas.id, indicacoes.candidaturaId))
      .leftJoin(pessoas, eq(pessoas.id, indicadores.pessoaId))
      .leftJoin(usuarios, eq(usuarios.id, indicadores.usuarioId))
      .leftJoin(titulos, eq(titulos.id, indicacoes.tituloId))
      .where(filtro)
      .orderBy(desc(indicacoes.criadoEm))
      .limit(500);
    const totais = {
      candidatas: itens.filter((i) => i.status === 'candidata').length,
      aguardandoPedido: itens.filter((i) => i.status === 'aprovada').length,
      aPagar: itens.filter((i) => i.status === 'liberada').reduce((a, i) => a + (i.valor ?? 0), 0),
      pago: itens.filter((i) => i.status === 'paga').reduce((a, i) => a + (i.valor ?? 0), 0),
    };
    return { itens, totais };
  }

  @Get('indicacoes/regras')
  @Permissao('rede', 'ver')
  regras() {
    return this.svc.regras();
  }

  @Put('indicacoes/regras')
  @Permissao('rede', 'editar')
  async salvarRegras(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(CONFIGS.indicacao.schema, body);
    await this.config.salvar('indicacao', d as never);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'config:indicacao', dados: d });
    return d;
  }

  /** Confere agora quem já pagou o primeiro pedido (o sistema também confere sozinho a cada 30 minutos). */
  @Post('indicacoes/verificar')
  @Permissao('rede', 'editar')
  verificar() {
    return this.svc.verificar();
  }

  @Post('indicacoes/:id/cancelar')
  @Permissao('rede', 'editar')
  async cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ motivo: z.string().trim().min(5, 'Diga o motivo').max(300) }), body);
    const r = await this.svc.cancelar(id, d.motivo, u.id);
    if ('erro' in r) throw new BadRequestException(r.erro);
    return r;
  }

  /** A gestão liga à mão uma candidata a quem indicou (ex.: indicação feita de boca, ou link esquecido). */
  @Post('indicacoes/ligar')
  @Permissao('rede', 'editar')
  async ligar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ candidaturaId: z.string().uuid(), codigo: z.string().trim().min(5).max(12) }), body);
    const [ja] = await this.db.select({ id: indicacoes.id }).from(indicacoes).where(eq(indicacoes.candidaturaId, d.candidaturaId));
    if (ja) throw new BadRequestException('Esta candidata já tem indicação.');
    const dono = await this.svc.dono(d.codigo);
    if (!dono) throw new BadRequestException('Código de indicação não encontrado.');
    const nova = await this.svc.registrar(d.candidaturaId, d.codigo, u.id);
    if (!nova) throw new BadRequestException('Indicação não aceita: a indicação está desligada, a candidata é a própria pessoa que indicou ou ela já é consultora.');
    // Já aprovada: a indicação já nasce esperando o primeiro pedido.
    const [c] = await this.db.select({ pessoaId: candidaturas.pessoaId }).from(candidaturas).where(and(eq(candidaturas.id, d.candidaturaId), eq(candidaturas.etapa, 'aprovada')));
    if (c?.pessoaId) await this.svc.aoAprovar(d.candidaturaId, c.pessoaId);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'ligar', entidade: 'indicacao', entidadeId: nova.id, dados: { codigo: d.codigo } });
    return { ok: true };
  }
}
