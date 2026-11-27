import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { PixRecebidosService } from './pix-recebidos.service';

/** Financeiro › Pix recebidos: o que entrou no Asaas e no Sicoob, com baixa automática ou em um clique. */
@Controller('financeiro/pix')
export class PixController {
  constructor(private readonly svc: PixRecebidosService) {}

  @Get()
  @Permissao('financeiro', 'ver')
  listar(@Query('status') status?: string, @Query('dias') dias?: string) {
    return this.svc.listar(['pendente', 'baixado', 'ignorado', 'todos'].includes(status ?? '') ? status! : 'pendente', Number(dias) || 30);
  }

  /** Traz do Asaas os Pix dos últimos dias (recupera os que ficaram sem baixa). */
  @Post('buscar-asaas')
  @Permissao('financeiro', 'editar')
  buscarAsaas(@Body() body: unknown) {
    const { dias } = validar(z.object({ dias: z.number().int().min(1).max(90).default(15) }), body ?? {});
    return this.svc.buscarAsaas(dias);
  }

  /** Extrato do Sicoob em OFX (texto do arquivo). */
  @Post('importar-ofx')
  @Permissao('financeiro', 'editar')
  importarOfx(@Body() body: unknown) {
    const d = validar(z.object({ texto: z.string().min(20, 'Arquivo vazio').max(5_000_000, 'Arquivo grande demais'), contaId: z.string().uuid().nullable().optional() }), body);
    return this.svc.importarOfx(d.texto, d.contaId ?? null);
  }

  @Post(':id/baixar')
  @Permissao('financeiro', 'editar')
  baixar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { tituloIds } = validar(z.object({ tituloIds: z.array(z.string().uuid()).min(1, 'Escolha o título').max(30) }), body);
    return this.svc.baixarManual(id, tituloIds, u.id);
  }

  @Post(':id/ignorar')
  @Permissao('financeiro', 'editar')
  ignorar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { motivo } = validar(z.object({ motivo: z.string().trim().max(300).nullable().optional() }), body ?? {});
    return this.svc.ignorar(id, motivo ?? null, u.id);
  }
}
