import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { opcional, validar } from '../comum/validacao';
import { cnpjValido, soDigitos } from '../comum/documentos';
import { AuditoriaService } from '../comum/auditoria.service';
import { empresas } from '../db/schema';

const empresaSchema = z
  .object({
    nome: z.string().trim().min(2).max(150),
    razaoSocial: opcional(200),
    cnpj: opcional(20),
    inscricaoEstadual: opcional(30),
    cidade: opcional(80),
    uf: opcional(2),
    ativo: z.boolean().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.cnpj && !cnpjValido(e.cnpj)) ctx.addIssue({ code: 'custom', path: ['cnpj'], message: 'CNPJ inválido' });
  });

/** Matriz e lojas: os dados entram nos contratos, promissórias e, depois, nas notas fiscais. */
@Controller('empresas')
export class EmpresasController {
  constructor(@Inject(DB) private readonly db: Db, private readonly auditoria: AuditoriaService) {}

  @Get()
  listar() {
    return this.db.select().from(empresas).orderBy(asc(empresas.tipo), asc(empresas.nome));
  }

  @Patch(':id')
  @Permissao('configuracoes', 'editar')
  async editar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(empresas).where(eq(empresas.id, id));
    if (!atual) throw new NotFoundException('Empresa não encontrada.');
    const d = validar(empresaSchema, { ...atual, ...(body as object) });
    const [e] = await this.db.update(empresas).set({ ...d, cnpj: d.cnpj ? soDigitos(d.cnpj) : null }).where(eq(empresas.id, id)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'empresa', entidadeId: id });
    return e;
  }
}
