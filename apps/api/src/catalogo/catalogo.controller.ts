import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { centavos, validar } from '../comum/validacao';
import { Limitador } from '../comum/limitador';
import { FORMAS } from '../vendas/vendas.service';
import { PedidosLinkService } from './pedidos.service';

const pedidos = new Limitador(8, 60 * 60_000, 'Muitos pedidos enviados deste aparelho. Tente mais tarde ou fale com a consultora pelo WhatsApp.');

const pedidoSchema = z.object({
  itens: z.array(z.object({ produtoId: z.string().uuid(), quantidade: z.number().int().min(1).max(20) })).min(1, 'Escolha ao menos uma peça').max(40),
  nome: z.string().trim().min(3, 'Informe seu nome').max(120),
  telefone: z.string().transform((v) => v.replace(/\D/g, '')).refine((v) => v.length >= 10 && v.length <= 13, 'WhatsApp com DDD'),
  cidade: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  entrega: z.enum(['retirar', 'entregar', 'combinar']).default('combinar'),
  endereco: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  observacao: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  consentimento: z.literal(true, { message: 'É preciso autorizar o contato para enviar o pedido.' }),
  site: z.string().optional(),
  origem: z.record(z.string(), z.string()).optional(),
});

/**
 * Catálogo público da consultora (substitui nome.aritanaonline.com.br do Jueri), agora com pedido.
 * Nunca mostra custo nem dados pessoais além do nome, cidade, Instagram e WhatsApp dela.
 */
@Controller()
export class CatalogoController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: PedidosLinkService) {}

  @Publico()
  @Get('publico/catalogo/:slug')
  async ver(@Param('slug') slug: string) {
    const rep = await this.svc.consultoraPorSlug(slug);
    const origem = await this.svc.origemDe(rep);
    const regras = await this.svc.regras();
    const pecas = origem ? await this.svc.pecas(rep, origem) : [];
    return {
      representante: { nome: rep.nome, cidade: rep.cidade, uf: rep.uf, whatsapp: rep.telefone1, instagram: rep.instagram },
      origem,
      pedidos: { ativo: regras.ativo && !!origem, entrega: regras.aceitaEntrega },
      pecas,
    };
  }

  @Publico()
  @Post('publico/catalogo/:slug/pedido')
  async pedir(@Param('slug') slug: string, @Body() body: unknown, @Req() req: Request) {
    pedidos.usar(req.ip ?? '?');
    if ((body as { site?: string })?.site) return { ok: true, numero: 0 }; // robô preencheu o campo invisível
    const d = validar(pedidoSchema, body);
    const utm = Object.fromEntries(Object.entries(d.origem ?? {}).filter(([k, v]) => /^(utm_[a-z]+|ref)$/.test(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 200)]));
    const r = await this.svc.criar(slug, d, utm);
    return { ok: true, numero: r.pedido.numero, total: r.pedido.total, origem: r.pedido.origem, mensagem: r.mensagem };
  }

  // ───── Equipe ─────

  @Get('pedidos-link')
  @Permissao('vendas', 'ver')
  listar(@Query('status') status?: string, @Query('origem') origem?: string) {
    const ok = (v: string | undefined, l: string[]) => (v && l.includes(v) ? v : undefined);
    return this.svc.listar({ status: ok(status, ['abertos', 'novo', 'confirmado', 'entregue', 'cancelado']), origem: ok(origem, ['maleta', 'matriz']) });
  }

  @Post('pedidos-link/:id/confirmar')
  @Permissao('vendas', 'editar')
  confirmar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.confirmar(id, { usuarioId: u.id });
  }

  @Post('pedidos-link/:id/faturar')
  @Permissao('vendas', 'criar')
  faturar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ pagamentos: z.array(z.object({ forma: z.enum(FORMAS), valor: centavos.refine((v) => v > 0, 'Valor do pagamento'), parcelas: z.number().int().min(1).max(12).optional() })).min(1, 'Informe como a cliente pagou') }), body);
    return this.svc.faturar(id, d.pagamentos, u.id);
  }

  @Post('pedidos-link/:id/cancelar')
  @Permissao('vendas', 'editar')
  cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ motivo: z.string().trim().max(300).nullable().optional() }), body ?? {});
    return this.svc.cancelar(id, d.motivo ?? null, { usuarioId: u.id });
  }
}
