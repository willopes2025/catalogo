import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import type { Acao, ChaveModulo } from '@aritana/regras';
import { DB, type Db } from './db.module';
import { grupos, usuarios } from '../db/schema';

export interface UsuarioLogado {
  id: string;
  nome: string;
  email: string;
  grupo: string;
  permissoes: Record<string, string[]>;
}

const CHAVE_PUBLICO = 'publico';
const CHAVE_PERMISSAO = 'permissao';

/** Rota aberta, sem login (ex.: link do pedido da representante). */
export const Publico = () => SetMetadata(CHAVE_PUBLICO, true);
/** Exige permissão no módulo para a ação. */
export const Permissao = (modulo: ChaveModulo, acao: Acao) => SetMetadata(CHAVE_PERMISSAO, { modulo, acao });

export const Usuario = createParamDecorator((_: unknown, ctx: ExecutionContext): UsuarioLogado => ctx.switchToHttp().getRequest().usuario);

export function temPermissao(p: Record<string, string[]>, modulo: string, acao: string): boolean {
  const todos = p['*'] ?? [];
  const doModulo = p[modulo] ?? [];
  return todos.includes('*') || todos.includes(acao) || doModulo.includes('*') || doModulo.includes(acao);
}

/** `quem` tem todas as permissões de `pedidas`? (para ninguém dar a outro mais do que tem) */
export function contemPermissoes(quem: Record<string, string[]>, pedidas: Record<string, string[]>): boolean {
  for (const [modulo, acoes] of Object.entries(pedidas)) {
    for (const a of acoes) {
      if (modulo === '*' || a === '*') {
        if (!(quem['*'] ?? []).includes('*') && !(modulo !== '*' && (quem[modulo] ?? []).includes('*'))) return false;
      } else if (!temPermissao(quem, modulo, a)) return false;
    }
  }
  return true;
}

interface Atual {
  ativo: boolean;
  senhaProvisoria: boolean;
  nome: string;
  grupo: string;
  permissoes: Record<string, string[]>;
  lidoEm: number;
}
/** Situação atual de cada usuário, relida do banco a cada 30 s (ou na hora, quando um usuário ou grupo muda). */
const cache = new Map<string, Atual>();
export const invalidarSessoes = () => cache.clear();

/** Rotas liberadas enquanto a senha provisória não é trocada. */
const LIVRES_COM_SENHA_PROVISORIA = ['/api/auth/eu', '/api/auth/trocar-senha'];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector, @Inject(DB) private readonly db: Db) {}

  private async atual(id: string): Promise<Atual | null> {
    const c = cache.get(id);
    if (c && Date.now() - c.lidoEm < 30_000) return c;
    const [r] = await this.db
      .select({ ativo: usuarios.ativo, senhaProvisoria: usuarios.senhaProvisoria, nome: usuarios.nome, grupo: grupos.nome, permissoes: grupos.permissoes })
      .from(usuarios)
      .innerJoin(grupos, eq(grupos.id, usuarios.grupoId))
      .where(eq(usuarios.id, id));
    if (!r) {
      cache.delete(id);
      return null;
    }
    const v = { ...r, lidoEm: Date.now() };
    cache.set(id, v);
    return v;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const alvo = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(CHAVE_PUBLICO, alvo)) return true;

    const req = ctx.switchToHttp().getRequest();
    const [tipo, token] = String(req.headers.authorization ?? '').split(' ');
    if (tipo !== 'Bearer' || !token) throw new UnauthorizedException('Faça login para continuar.');
    let doToken: UsuarioLogado;
    try {
      doToken = this.jwt.verify<UsuarioLogado>(token);
    } catch {
      throw new UnauthorizedException('Sessão expirada. Faça login de novo.');
    }
    // Usuário desativado perde o acesso na hora; mudança de grupo vale sem precisar sair e entrar.
    const a = await this.atual(doToken.id);
    if (!a || !a.ativo) throw new UnauthorizedException('Seu acesso foi desativado. Fale com a gerência.');
    req.usuario = { id: doToken.id, email: doToken.email, nome: a.nome, grupo: a.grupo, permissoes: a.permissoes } satisfies UsuarioLogado;

    const caminho = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    if (a.senhaProvisoria && !LIVRES_COM_SENHA_PROVISORIA.includes(caminho)) {
      throw new ForbiddenException({ mensagem: 'Troque a senha provisória antes de continuar.', trocarSenha: true });
    }

    const exigida = this.reflector.getAllAndOverride<{ modulo: string; acao: string }>(CHAVE_PERMISSAO, alvo);
    if (exigida && !temPermissao(req.usuario.permissoes, exigida.modulo, exigida.acao)) {
      throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
    return true;
  }
}
