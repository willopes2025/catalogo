import { Controller, Get, Inject, Post } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { AuditoriaService } from '../comum/auditoria.service';
import { avisosEnviados } from '../db/schema';
import { AvisosService } from './avisos.service';

@Controller('avisos')
export class AvisosController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: AvisosService, private readonly auditoria: AuditoriaService) {}

  /** Prévia do que sairia agora (inclui os já enviados). */
  @Get('previa')
  @Permissao('configuracoes', 'ver')
  async previa() {
    const avisos = await this.svc.montar();
    return avisos.map(({ chave, para, assunto }) => ({ chave, para, assunto }));
  }

  @Post('executar')
  @Permissao('configuracoes', 'editar')
  async executar(@Usuario() u: UsuarioLogado) {
    const r = await this.svc.executar();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'executar', entidade: 'avisos', dados: r });
    return r;
  }

  @Get('historico')
  @Permissao('configuracoes', 'ver')
  historico() {
    return this.db.select().from(avisosEnviados).orderBy(desc(avisosEnviados.criadoEm)).limit(200);
  }
}
