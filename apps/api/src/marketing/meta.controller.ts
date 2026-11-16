import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { dataISO, validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { SegredosService } from '../segredos/segredos.service';
import { hoje } from '../maletas/maletas.service';
import { ErroMeta, MetaService } from './meta.service';

const idMeta = z.string().regex(/^\d{5,30}$/, 'Id inválido');
const origem = z.enum(['clientes', 'representantes', 'candidatas']);

/** Marketing › Meta: campanhas, catálogo, públicos, leads de formulário e a página, sem abrir o Gerenciador. */
@Controller('marketing/meta')
export class MetaController {
  constructor(private readonly meta: MetaService, private readonly segredos: SegredosService, private readonly auditoria: AuditoriaService) {}

  /** Erro do Meta vira mensagem na tela (503 quando é token ou permissão; 400 quando o Meta recusou o pedido). */
  private async m<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ErroMeta) {
        const corpo = { mensagem: e.message, permissaoFaltando: e.permissao ?? null };
        throw e.status === 400 ? new BadRequestException(corpo) : new ServiceUnavailableException(corpo);
      }
      throw e;
    }
  }

  @Get('estado')
  @Permissao('marketing', 'ver')
  estado() {
    return { ligado: !!this.meta.token, ...this.meta.config };
  }

  @Get('opcoes')
  @Permissao('marketing', 'editar')
  async opcoes() {
    return { ...(await this.m(() => this.meta.opcoes())), funis: await this.meta.funis() };
  }

  @Put('config')
  @Permissao('marketing', 'editar')
  async salvar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({
        conta: z.string().regex(/^(act_)?\d{3,30}$/, 'Conta de anúncios inválida').nullable().optional(),
        paginaId: idMeta.nullable().optional(),
        catalogoId: idMeta.nullable().optional(),
        catalogoLink: z.string().trim().url('Endereço inválido').startsWith('https://', 'O endereço precisa começar com https://').max(300).nullable().optional().or(z.literal('').transform(() => null)),
        leadsFunilId: z.string().uuid().nullable().optional(),
        leadsAuto: z.boolean().optional(),
      }),
      body,
    );
    const campos: [string, string | null | undefined][] = [
      ['META_ADS_CONTA', d.conta === undefined ? undefined : d.conta ? `act_${d.conta.replace(/^act_/, '')}` : null],
      ['META_PAGINA_ID', d.paginaId],
      ['META_CATALOGO_ID', d.catalogoId],
      ['META_CATALOGO_LINK', d.catalogoLink],
      ['META_LEADS_FUNIL', d.leadsFunilId],
      ['META_LEADS_AUTO', d.leadsAuto === undefined ? undefined : d.leadsAuto ? '1' : null],
    ];
    for (const [nome, valor] of campos) if (valor !== undefined) await this.segredos.salvar(nome, valor, u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'configurar', entidade: 'meta', dados: d });
    return this.estado();
  }

  // ───── Campanhas ─────

  @Get('painel')
  @Permissao('marketing', 'ver')
  painel(@Query() q: Record<string, string>) {
    const fim = hoje();
    const d = validar(z.object({ de: dataISO.default(`${fim.slice(0, 8)}01`), ate: dataISO.default(fim), nivel: z.enum(['campaign', 'adset', 'ad']).default('campaign'), pai: idMeta.optional() }), q);
    if (d.de > d.ate) throw new BadRequestException({ mensagem: 'A data inicial é depois da final.' });
    return this.m(() => this.meta.painel(d.de, d.ate, d.nivel, d.pai));
  }

  @Post('itens/:id/status')
  @Permissao('marketing', 'editar')
  async status(@Usuario() u: UsuarioLogado, @Param('id') id: string, @Body() body: unknown) {
    validar(idMeta, id);
    const d = validar(z.object({ status: z.enum(['ACTIVE', 'PAUSED']) }), body);
    const r = await this.m(() => this.meta.mudarStatus(id, d.status));
    await this.auditoria.registrar({ usuarioId: u.id, acao: d.status === 'PAUSED' ? 'pausar' : 'ativar', entidade: 'meta_campanha', dados: r });
    return r;
  }

  @Post('itens/:id/orcamento')
  @Permissao('marketing', 'editar')
  async orcamento(@Usuario() u: UsuarioLogado, @Param('id') id: string, @Body() body: unknown) {
    validar(idMeta, id);
    // Em centavos. Teto alto de propósito, só para barrar erro de digitação (R$ 50.000 por dia).
    const d = validar(z.object({ diario: z.number().int().min(100, 'O mínimo é R$ 1,00 por dia').max(5_000_000, 'Valor muito alto: confira') }), body);
    const r = await this.m(() => this.meta.mudarOrcamento(id, d.diario));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'orcamento', entidade: 'meta_campanha', dados: r });
    return r;
  }

  // ───── Catálogo ─────

  @Post('catalogo/sincronizar')
  @Permissao('marketing', 'editar')
  async catalogo(@Usuario() u: UsuarioLogado) {
    const r = await this.m(() => this.meta.sincronizarCatalogo());
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'sincronizar_catalogo', entidade: 'meta', dados: { ...r, erros: r.erros.length } });
    return r;
  }

  // ───── Públicos ─────

  @Get('publicos')
  @Permissao('marketing', 'ver')
  publicos() {
    return this.m(() => this.meta.publicos());
  }

  @Get('publicos/previa')
  @Permissao('marketing', 'ver')
  previa(@Query('origem') o: string) {
    return this.meta.previaPublico(validar(origem, o));
  }

  @Post('publicos')
  @Permissao('marketing', 'editar')
  async criarPublico(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ origem, nome: z.string().trim().max(100).optional() }), body);
    const r = await this.m(() => this.meta.criarPublico(d.origem, d.nome));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar_publico', entidade: 'meta', dados: { origem: d.origem, ...r } });
    return r;
  }

  @Post('publicos/:id/atualizar')
  @Permissao('marketing', 'editar')
  async atualizarPublico(@Usuario() u: UsuarioLogado, @Param('id') id: string) {
    validar(idMeta, id);
    const r = await this.m(() => this.meta.atualizarPublico(id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'atualizar_publico', entidade: 'meta', dados: r });
    return r;
  }

  @Post('publicos/:id/semelhante')
  @Permissao('marketing', 'editar')
  async semelhante(@Usuario() u: UsuarioLogado, @Param('id') id: string, @Body() body: unknown) {
    validar(idMeta, id);
    const d = validar(z.object({ percentual: z.number().int().min(1).max(10) }), body);
    const r = await this.m(() => this.meta.criarSemelhante(id, d.percentual));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar_publico_semelhante', entidade: 'meta', dados: { origemId: id, ...d, ...r } });
    return r;
  }

  // ───── Leads de formulário e página ─────

  @Get('leads/formularios')
  @Permissao('marketing', 'ver')
  formularios() {
    return this.m(() => this.meta.formularios());
  }

  @Post('leads/importar')
  @Permissao('marketing', 'editar')
  async importar(@Usuario() u: UsuarioLogado) {
    const r = await this.m(() => this.meta.importarLeads());
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'importar_leads', entidade: 'meta', dados: r });
    return r;
  }

  @Get('pagina')
  @Permissao('marketing', 'ver')
  pagina() {
    return this.m(() => this.meta.pagina());
  }
}
