import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { usuarios } from '../db/schema';
import { ComissoesService } from './comissoes.service';
import { hoje } from '../maletas/maletas.service';

const mesSchema = z.object({ mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM') });

@Controller('comissoes')
export class ComissoesController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: ComissoesService, private readonly auditoria: AuditoriaService) {}

  @Get()
  @Permissao('comissoes', 'ver')
  calcular(@Query('mes') mes?: string) {
    return this.svc.calcular(mes ?? hoje().slice(0, 7));
  }

  @Post('fechar')
  @Permissao('comissoes', 'criar')
  fechar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    return this.svc.fechar(validar(mesSchema, body).mes, u.id);
  }

  @Post('reabrir')
  @Permissao('comissoes', 'excluir')
  reabrir(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    return this.svc.reabrir(validar(mesSchema, body).mes, u.id);
  }

  /** Percentual e meta de cada vendedora (usuário do sistema). */
  @Get('vendedoras')
  @Permissao('comissoes', 'ver')
  vendedoras() {
    return this.db.select({ id: usuarios.id, nome: usuarios.nome, ativo: usuarios.ativo, comissaoPb: usuarios.comissaoPb, metaMensal: usuarios.metaMensal }).from(usuarios).orderBy(asc(usuarios.nome));
  }

  @Patch('vendedoras/:id')
  @Permissao('comissoes', 'editar')
  async editarVendedora(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = validar(z.object({ comissaoPb: z.number().int().min(0).max(10000).nullable(), metaMensal: z.number().int().min(0).nullable() }), body);
    const [r] = await this.db.update(usuarios).set(d).where(eq(usuarios.id, id)).returning({ id: usuarios.id });
    if (!r) throw new NotFoundException('Usuário não encontrado.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'comissao_vendedora', entidadeId: id, dados: d });
    return r;
  }
}
