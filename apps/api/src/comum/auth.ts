import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Acao, ChaveModulo } from '@aritana/regras';

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

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const alvo = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(CHAVE_PUBLICO, alvo)) return true;

    const req = ctx.switchToHttp().getRequest();
    const [tipo, token] = String(req.headers.authorization ?? '').split(' ');
    if (tipo !== 'Bearer' || !token) throw new UnauthorizedException('Faça login para continuar.');
    try {
      req.usuario = this.jwt.verify<UsuarioLogado>(token);
    } catch {
      throw new UnauthorizedException('Sessão expirada. Faça login de novo.');
    }

    const exigida = this.reflector.getAllAndOverride<{ modulo: string; acao: string }>(CHAVE_PERMISSAO, alvo);
    if (exigida && !temPermissao(req.usuario.permissoes, exigida.modulo, exigida.acao)) {
      throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
    return true;
  }
}
