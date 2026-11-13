import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Envio de e-mail por SMTP (ex.: o e-mail da Aritana, Amazon SES ou Brevo).
 * Configure SMTP_URL=smtps://usuario:senha@servidor:465 e EMAIL_REMETENTE="Aritana <naoresponda@...>".
 * Sem SMTP, em desenvolvimento a mensagem só aparece no log.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger('E-mail');
  private transporte: Transporter | null = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

  get configurado() {
    return !!this.transporte;
  }

  async enviar(para: string, assunto: string, texto: string) {
    if (!this.transporte) {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('O envio de e-mail ainda não foi configurado.');
      this.log.warn(`[sem SMTP] Para ${para}: ${assunto}\n${texto}`);
      return { simulado: true };
    }
    await this.transporte.sendMail({ from: process.env.EMAIL_REMETENTE ?? 'Aritana Semijoias <naoresponda@aritanaonline.com.br>', to: para, subject: assunto, text: texto });
    return { simulado: false };
  }
}
