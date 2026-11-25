import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { AuditoriaService } from '../comum/auditoria.service';
import { FilaEnvioService } from './fila-envio.service';

/** Envios em massa pelo WhatsApp (assistente e trilha de cobrança): andamento, pausar, retomar e cancelar. */
@Controller('envios')
export class EnviosController {
  constructor(
    private readonly fila: FilaEnvioService,
    private readonly auditoria: AuditoriaService,
  ) {}

  private exigir(u: UsuarioLogado) {
    if (!temPermissao(u.permissoes, 'crm', 'criar') && !temPermissao(u.permissoes, 'cobranca', 'editar')) throw new ForbiddenException('Você não tem permissão para mexer nos envios.');
  }

  @Get()
  @Permissao('crm', 'ver')
  listar(@Query('status') status?: string, @Query('acaoId') acaoId?: string) {
    return this.fila.listar({ status: status || undefined, acaoId: acaoId || undefined });
  }

  @Get(':id')
  @Permissao('crm', 'ver')
  obter(@Param('id', ParseUUIDPipe) id: string) {
    return this.fila.obter(id);
  }

  @Post(':id/:acao')
  @Permissao('crm', 'ver')
  async mexer(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Param('acao') acao: string) {
    this.exigir(u);
    const r = acao === 'pausar' ? await this.fila.pausar(id) : acao === 'retomar' ? await this.fila.retomar(id) : acao === 'cancelar' ? await this.fila.cancelar(id) : null;
    if (!r) throw new ForbiddenException('Ação desconhecida.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: `envio_${acao}`, entidade: 'envio_lote', entidadeId: id });
    return r;
  }
}
