import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AsaasService } from './asaas.service';

@Controller()
export class WebhooksController {
  constructor(private readonly asaas: AsaasService) {}

  /** Endereço cadastrado no Asaas para avisar pagamentos. */
  @Publico()
  @Post('webhooks/asaas')
  @HttpCode(200)
  asaasWebhook(@Headers('asaas-access-token') token: string | undefined, @Body() body: Record<string, unknown>) {
    return this.asaas.receberWebhook(token, body as never);
  }

  /** Gera boleto ou Pix de um título a receber. */
  @Post('financeiro/titulos/:id/cobranca')
  @Permissao('financeiro', 'editar')
  cobrar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { tipo } = validar(z.object({ tipo: z.enum(['BOLETO', 'PIX']) }), body);
    return this.asaas.cobrar(id, tipo, u.id);
  }
}
