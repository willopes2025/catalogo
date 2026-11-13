import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Limite simples de tentativas em memória (login e rotas públicas).
 * Ex.: 10 falhas de login em 15 minutos bloqueiam aquele e-mail/IP por 15 minutos.
 */
export class Limitador {
  private readonly mapa = new Map<string, { n: number; ate: number }>();
  constructor(private readonly maximo: number, private readonly janelaMs: number, private readonly mensagem: string) {}

  /** Lança 429 se a chave passou do limite. */
  verificar(chave: string) {
    const r = this.mapa.get(chave);
    if (r && r.ate > Date.now() && r.n >= this.maximo) {
      const min = Math.ceil((r.ate - Date.now()) / 60_000);
      throw new HttpException({ mensagem: `${this.mensagem} Tente de novo em ${min} minuto(s).` }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  registrar(chave: string) {
    const agora = Date.now();
    const r = this.mapa.get(chave);
    if (!r || r.ate <= agora) this.mapa.set(chave, { n: 1, ate: agora + this.janelaMs });
    else r.n++;
    if (this.mapa.size > 10_000) for (const [k, v] of this.mapa) if (v.ate <= agora) this.mapa.delete(k);
  }

  limpar(chave: string) {
    this.mapa.delete(chave);
  }

  /** Conta e verifica numa chamada (para rotas em que todo acesso conta). */
  usar(chave: string) {
    this.verificar(chave);
    this.registrar(chave);
  }
}
