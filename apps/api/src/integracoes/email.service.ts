import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { SegredosService } from '../segredos/segredos.service';

/**
 * Envio de e-mail por SMTP (e-mail da Aritana, Google Workspace, Brevo, Amazon SES...).
 * Preenchido em Configurações › Integrações; na falta, vale o SMTP_URL do servidor
 * (smtps://usuario:senha@servidor:465). Sem nenhum, em desenvolvimento a mensagem só aparece no log.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger('E-mail');
  private transporte: Transporter | null = null;
  private versaoMontada = -1;

  constructor(private readonly segredos: SegredosService) {}

  /** Monta (ou remonta, se as credenciais mudaram) a conexão SMTP. */
  private conexao(): Transporter | null {
    if (this.versaoMontada === this.segredos.versao) return this.transporte;
    this.versaoMontada = this.segredos.versao;
    const host = this.segredos.v('SMTP_SERVIDOR');
    if (host) {
      const port = Number(this.segredos.v('SMTP_PORTA') ?? 465);
      const user = this.segredos.v('SMTP_USUARIO');
      this.transporte = nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass: this.segredos.v('SMTP_SENHA') ?? '' } : undefined });
    } else if (process.env.SMTP_URL) this.transporte = nodemailer.createTransport(process.env.SMTP_URL);
    else this.transporte = null;
    return this.transporte;
  }

  get configurado() {
    return !!this.conexao();
  }

  get remetente() {
    return this.segredos.v('EMAIL_REMETENTE') ?? 'Aritana Semijoias <naoresponda@aritanaonline.com.br>';
  }

  async testar(para: string) {
    const t = this.conexao();
    if (!t) throw new ServiceUnavailableException('Preencha o servidor SMTP.');
    await t.verify().catch((e: Error) => {
      throw new ServiceUnavailableException(`O servidor de e-mail recusou: ${e.message}`);
    });
    await this.enviar(para, 'Teste de e-mail · Plataforma Aritana', 'Se você recebeu esta mensagem, o e-mail do sistema está funcionando.');
    return { ok: true, mensagem: `Conectado. Enviamos um e-mail de teste para ${para}.` };
  }

  async enviar(para: string, assunto: string, texto: string) {
    const t = this.conexao();
    if (!t) {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('O envio de e-mail ainda não foi configurado.');
      this.log.warn(`[sem SMTP] Para ${para}: ${assunto}\n${texto}`);
      return { simulado: true };
    }
    await t.sendMail({ from: this.remetente, to: para, subject: assunto, text: texto });
    return { simulado: false };
  }
}
