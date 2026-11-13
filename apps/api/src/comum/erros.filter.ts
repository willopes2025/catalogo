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
    const pg = e as { code?: string; detail?: string };
    if (pg?.code === '23505') return res.status(409).json({ mensagem: 'Já existe um registro com esse valor.', detalhe: pg.detail });
    this.log.error(e);
    return res.status(500).json({ mensagem: 'Erro inesperado. A equipe de suporte foi avisada.' });
  }
}
