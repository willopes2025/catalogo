import { Body, Controller, Get, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Publico, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { grupos, usuarios } from '../db/schema';
import { AuditoriaService } from '../comum/auditoria.service';

const loginSchema = z.object({ email: z.string().email('E-mail inválido').toLowerCase(), senha: z.string().min(1, 'Informe a senha') });
const trocaSchema = z.object({ atual: z.string().min(1), nova: z.string().min(10, 'A nova senha precisa de pelo menos 10 caracteres') });

@Controller('auth')
export class AuthController {
  constructor(@Inject(DB) private readonly db: Db, private readonly jwt: JwtService, private readonly auditoria: AuditoriaService) {}

  @Publico()
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, senha } = validar(loginSchema, body);
    const [u] = await this.db
      .select({ u: usuarios, g: grupos })
      .from(usuarios)
      .innerJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .where(eq(usuarios.email, email));
    // Mesma mensagem para e-mail ou senha errados, para não revelar quais e-mails existem.
    if (!u || !u.u.ativo || !(await bcrypt.compare(senha, u.u.senhaHash))) {
      throw new UnauthorizedException('E-mail ou senha incorretos.');
    }
    await this.db.update(usuarios).set({ ultimoAcesso: new Date() }).where(eq(usuarios.id, u.u.id));
    await this.auditoria.registrar({ usuarioId: u.u.id, acao: 'login', entidade: 'usuario', entidadeId: u.u.id });
    const usuario: UsuarioLogado = { id: u.u.id, nome: u.u.nome, email: u.u.email, grupo: u.g.nome, permissoes: u.g.permissoes };
    return { token: this.jwt.sign(usuario), usuario };
  }

  @Get('eu')
  eu(@Usuario() u: UsuarioLogado) {
    return u;
  }

  @Post('trocar-senha')
  async trocarSenha(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const { atual, nova } = validar(trocaSchema, body);
    const [reg] = await this.db.select().from(usuarios).where(eq(usuarios.id, u.id));
    if (!reg || !(await bcrypt.compare(atual, reg.senhaHash))) throw new UnauthorizedException('Senha atual incorreta.');
    await this.db.update(usuarios).set({ senhaHash: await bcrypt.hash(nova, 10) }).where(eq(usuarios.id, u.id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'trocar_senha', entidade: 'usuario', entidadeId: u.id });
    return { ok: true };
  }
}
