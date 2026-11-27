import { Body, Controller, Headers, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AsaasService } from './asaas.service';
import { PixRecebidosService } from '../financeiro/pix-recebidos.service';
import { ConsultoraService } from '../portal/consultora.service';

@Controller()
export class WebhooksController {
  constructor(private readonly asaas: AsaasService, private readonly pix: PixRecebidosService, private readonly consultora: ConsultoraService) {}

  /** Endereço cadastrado no Asaas para avisar pagamentos. */
  @Publico()
  @Post('webhooks/asaas')
  @HttpCode(200)
  async asaasWebhook(@Headers('asaas-access-token') token: string | undefined, @Body() body: Record<string, unknown>) {
    const r = await this.asaas.receberWebhook(token, body as never);
    // Pix direto na chave (não é de título do sistema): entra na lista de Pix recebidos e casa com o comprovante da IA.
    const ev = String(body.event ?? '');
    if (r.resultado === 'título não encontrado' && (ev === 'PAYMENT_RECEIVED' || ev === 'PAYMENT_CONFIRMED') && body.payment)
      await this.pix.doWebhook(body.payment as Record<string, unknown>).catch(() => undefined);
    // Boleto de cobrança passada pela consultora: marca a parcela e, sem split, credita a parte dela.
    const ref = String((body.payment as Record<string, unknown> | undefined)?.externalReference ?? '');
    if (r.resultado === 'baixado' && /^[0-9a-f-]{36}$/i.test(ref)) await this.consultora.aoPagarTitulo(ref).catch(() => undefined);
    return r;
  }

  /** Gera boleto ou Pix de um título a receber. */
  @Post('financeiro/titulos/:id/cobranca')
  @Permissao('financeiro', 'editar')
  cobrar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { tipo, vencimento } = validar(z.object({ tipo: z.enum(['BOLETO', 'PIX']), vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de vencimento inválida').optional() }), body);
    return this.asaas.cobrar(id, tipo, u.id, undefined, { vencimento });
  }

  /** Situação do boleto/Pix no Asaas agora. */
  @Get('financeiro/titulos/:id/cobranca')
  @Permissao('financeiro', 'ver')
  situacao(@Param('id', ParseUUIDPipe) id: string) {
    return this.asaas.situacaoCobranca(id);
  }
}
