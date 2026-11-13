import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { variaveisDoModelo } from '@aritana/regras';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { documentos, modelosDocumento } from '../db/schema';
import { DocumentosService, VARIAVEIS } from './documentos.service';

const TIPOS = ['contrato', 'promissoria', 'aditivo'] as const;
const conhecidas = new Set<string>(VARIAVEIS.map(([k]) => k));

const modeloSchema = z
  .object({
    tipo: z.enum(TIPOS),
    modeloTrabalho: z.enum(['consignado', 'revenda', 'afiliado']).nullable().optional(),
    titulo: z.string().trim().min(3).max(150),
    conteudo: z.string().trim().min(20, 'O texto do modelo está muito curto').max(60_000),
    ativo: z.boolean().default(true),
  })
  .superRefine((m, ctx) => {
    const desconhecidas = variaveisDoModelo(`${m.titulo} ${m.conteudo}`).filter((v) => !conhecidas.has(v));
    if (desconhecidas.length) ctx.addIssue({ code: 'custom', path: ['conteudo'], message: `Variáveis desconhecidas: ${desconhecidas.map((v) => `{{${v}}}`).join(', ')}` });
  });

@Controller('documentos')
export class DocumentosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: DocumentosService, private readonly auditoria: AuditoriaService) {}

  @Get('variaveis')
  variaveis() {
    return VARIAVEIS.map(([chave, descricao]) => ({ chave, descricao }));
  }

  @Get('modelos')
  @Permissao('rede', 'ver')
  modelos() {
    return this.svc.listarModelos();
  }

  /** Editar um modelo cria uma nova versão; documentos já gerados guardam o texto da época. */
  @Post('modelos')
  @Permissao('configuracoes', 'editar')
  async criarModelo(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const [m] = await this.db.insert(modelosDocumento).values(validar(modeloSchema, body)).returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'criar', entidade: 'modelo_documento', entidadeId: m.id });
    return m;
  }

  @Patch('modelos/:id')
  @Permissao('configuracoes', 'editar')
  async editarModelo(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const [atual] = await this.db.select().from(modelosDocumento).where(eq(modelosDocumento.id, id));
    if (!atual) throw new NotFoundException('Modelo não encontrado.');
    const d = validar(modeloSchema, { ...atual, ...(body as object) });
    const mudouTexto = d.conteudo !== atual.conteudo || d.titulo !== atual.titulo;
    const [m] = await this.db
      .update(modelosDocumento)
      .set({ ...d, versao: mudouTexto ? atual.versao + 1 : atual.versao, atualizadoEm: new Date() })
      .where(eq(modelosDocumento.id, id))
      .returning();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'modelo_documento', entidadeId: id, dados: { versao: m.versao } });
    return m;
  }

  @Post()
  @Permissao('rede', 'editar')
  gerar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ pessoaId: z.string().uuid(), tipo: z.enum(TIPOS), maletaId: z.string().uuid().nullable().optional(), modeloId: z.string().uuid().optional() }), body);
    return this.svc.gerar(this.db, d, u.id);
  }

  @Get(':id')
  @Permissao('rede', 'ver')
  obter(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.obter(id);
  }

  @Post(':id/cancelar')
  @Permissao('rede', 'editar')
  async cancelar(@Usuario() u: UsuarioLogado, @Param('id', ParseUUIDPipe) id: string) {
    const [d] = await this.db.update(documentos).set({ status: 'cancelado' }).where(and(eq(documentos.id, id), eq(documentos.status, 'pendente'))).returning({ id: documentos.id });
    if (!d) throw new BadRequestException('Só documentos pendentes podem ser cancelados.');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'cancelar', entidade: 'documento', entidadeId: id });
    return { ok: true };
  }
}

/** Páginas que a representante abre pelo link, sem login. */
@Controller('publico/documentos')
export class DocumentoPublicoController {
  constructor(private readonly svc: DocumentosService) {}

  @Publico()
  @Get(':token')
  ver(@Param('token') token: string) {
    return this.svc.verPublico(token);
  }

  @Publico()
  @Post(':token/codigo')
  codigo(@Param('token') token: string) {
    return this.svc.enviarCodigo(token);
  }

  @Publico()
  @Post(':token/assinar')
  assinar(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const d = validar(z.object({ codigo: z.string().regex(/^\d{6}$/, 'O código tem 6 números'), nome: z.string().min(3), cpf: z.string().optional(), aceite: z.boolean() }), body);
    const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip) ?? null;
    return this.svc.assinar(token, d, ip, String(req.headers['user-agent'] ?? '') || null);
  }
}
