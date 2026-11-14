import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ErroAcerto } from '@aritana/regras';

/** Toda resposta de erro sai como { mensagem, campos? }, em português. */
@Catch()
export class ErrosFilter implements ExceptionFilter {
  private readonly log = new Logger('Erro');

  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) {
      const corpo = e.getResponse();
      const status = e.getStatus();
      if (typeof corpo === 'object' && corpo && 'mensagem' in corpo) return res.status(status).json(corpo);
      const msg = typeof corpo === 'string' ? corpo : (corpo as { message?: string | string[] }).message;
      return res.status(status).json({ mensagem: Array.isArray(msg) ? msg.join(' ') : msg ?? 'Erro' });
    }
    if (e instanceof ErroAcerto) return res.status(400).json({ mensagem: e.message });
    // O Drizzle embrulha o erro do Postgres (DrizzleQueryError.cause): procura o código na cadeia.
    let pg = e as { code?: string; cause?: unknown } | undefined;
    for (let i = 0; i < 5 && pg && !pg.code && pg.cause; i++) pg = pg.cause as typeof pg;
    if (pg?.code === '23505') return res.status(409).json({ mensagem: 'Já existe um registro com esse valor (código, documento ou e-mail repetido).' });
    if (pg?.code === '23503') return res.status(400).json({ mensagem: 'Este registro está ligado a outro que não existe mais ou que ainda o usa.' });
    if (pg?.code === '22007' || pg?.code === '22008') return res.status(400).json({ mensagem: 'Data inválida.' });
    if (pg?.code === '22003') return res.status(400).json({ mensagem: 'Valor grande demais.' });
    this.log.error(e);
    return res.status(500).json({ mensagem: 'Erro inesperado. Tente de novo; se continuar, abra um chamado em Suporte.' });
  }
}
