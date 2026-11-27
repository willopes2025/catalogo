import { BadRequestException, Body, Controller, Get, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Limitador } from '../comum/limitador';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Publico, Usuario, esquecerPresenca, invalidarSessoes, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { grupos, usuarios } from '../db/schema';
import { AuditoriaService } from '../comum/auditoria.service';
import { RhService } from '../rh/rh.service';

// Entra com o e-mail ou, para quem não tem e-mail (ex.: motoboy), com o CPF.
const loginSchema = z.object({ email: z.string().trim().toLowerCase().refine((v) => /^\S+@\S+\.\S+$/.test(v) || v.replace(/\D/g, '').length === 11, 'Informe o e-mail ou o CPF'), senha: z.string().min(1, 'Informe a senha') });
const trocaSchema = z.object({ atual: z.string().optional().default(''), nova: z.string().min(8, 'A nova senha precisa de pelo menos 8 caracteres') });

const falhasPorEmail = new Limitador(8, 15 * 60_000, 'Muitas tentativas de login com este e-mail.');
const falhasPorIp = new Limitador(30, 15 * 60_000, 'Muitas tentativas de login deste aparelho.');

@Controller('auth')
export class AuthController {
  constructor(@Inject(DB) private readonly db: Db, private readonly jwt: JwtService, private readonly auditoria: AuditoriaService, private readonly rh: RhService) {}

  @Publico()
  @Post('login')
  async login(@Body() body: unknown, @Req() req: Request) {
    const dados = validar(loginSchema, body);
    const senha = dados.senha;
    const email = dados.email.includes('@') ? dados.email : ((await this.rh.usuarioPorCpf(dados.email)) ?? `${dados.email.replace(/\D/g, '')}@ponto.local`);
    const ip = req.ip ?? '?';
    falhasPorEmail.verificar(email);
    falhasPorIp.verificar(ip);
    const [u] = await this.db
      .select({ u: usuarios, g: grupos })
      .from(usuarios)
      .innerJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .where(eq(usuarios.email, email));
    // Mesma mensagem para e-mail ou senha errados, para não revelar quais e-mails existem.
    if (!u || !u.u.ativo || !(await bcrypt.compare(senha, u.u.senhaHash))) {
      falhasPorEmail.registrar(email);
      falhasPorIp.registrar(ip);
      throw new UnauthorizedException('E-mail ou senha incorretos.');
    }
    falhasPorEmail.limpar(email);
    // Login abre sessão nova para a presença.
    await this.db.update(usuarios).set({ ultimoAcesso: new Date(), sessaoInicioEm: new Date(), ultimaAtividadeEm: new Date() }).where(eq(usuarios.id, u.u.id));
    esquecerPresenca(u.u.id);
    await this.auditoria.registrar({ usuarioId: u.u.id, acao: 'login', entidade: 'usuario', entidadeId: u.u.id });
    const usuario: UsuarioLogado = { id: u.u.id, nome: u.u.nome, email: u.u.email, grupo: u.g.nome, permissoes: u.g.permissoes };
    return { token: this.jwt.sign(usuario), usuario, trocarSenha: u.u.senhaProvisoria };
  }

  @Get('eu')
  async eu(@Usuario() u: UsuarioLogado) {
    const [r] = await this.db.select({ senhaProvisoria: usuarios.senhaProvisoria }).from(usuarios).where(eq(usuarios.id, u.id));
    return { ...u, trocarSenha: !!r?.senhaProvisoria };
  }

  /** Saiu pelo botão: deixa de aparecer como conectado na hora. */
  @Post('sair')
  async sair(@Usuario() u: UsuarioLogado) {
    await this.db.update(usuarios).set({ ultimaAtividadeEm: null, sessaoInicioEm: null }).where(eq(usuarios.id, u.id));
    esquecerPresenca(u.id);
    return { ok: true };
  }

  @Post('trocar-senha')
  async trocarSenha(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const { atual, nova } = validar(trocaSchema, body);
    const [reg] = await this.db.select().from(usuarios).where(eq(usuarios.id, u.id));
    if (!reg) throw new BadRequestException('Usuário não encontrado.');
    // Primeiro acesso (senha provisória): quem acabou de entrar com ela não precisa digitá-la de novo.
    if (!reg.senhaProvisoria && !(await bcrypt.compare(atual, reg.senhaHash))) throw new BadRequestException('Senha atual incorreta.');
    if (await bcrypt.compare(nova, reg.senhaHash)) throw new BadRequestException('A nova senha precisa ser diferente da atual.');
    await this.db.update(usuarios).set({ senhaHash: await bcrypt.hash(nova, 10), senhaProvisoria: false }).where(eq(usuarios.id, u.id));
    invalidarSessoes();
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'trocar_senha', entidade: 'usuario', entidadeId: u.id });
    return { ok: true };
  }
}
