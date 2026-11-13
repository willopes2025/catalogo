import { BadRequestException, Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { cpfValido, soDigitos } from '../comum/documentos';
import { AuditoriaService } from '../comum/auditoria.service';
import { AssertivaService } from './assertiva.service';
import { EmailService } from './email.service';

@Controller('integracoes')
export class IntegracoesController {
  constructor(private readonly assertiva: AssertivaService, private readonly email: EmailService, private readonly auditoria: AuditoriaService) {}

  /** Situação de cada integração, para a tela Configurações › Integrações. */
  @Get('status')
  @Permissao('configuracoes', 'ver')
  status() {
    return [
      { chave: 'assertiva', nome: 'Assertiva (consulta de CPF)', ligada: this.assertiva.configurada, versao: 1 },
      { chave: 'email', nome: 'E-mail (códigos de assinatura e avisos)', ligada: this.email.configurado, versao: 1 },
      { chave: 'asaas', nome: 'Asaas (boletos e Pix)', ligada: !!process.env.ASAAS_API_KEY, versao: 1 },
      { chave: 'fiscal', nome: 'Emissor fiscal (NF-e e NFC-e)', ligada: !!process.env.FOCUS_NFE_TOKEN, versao: 1 },
      { chave: 'whatsapp', nome: 'WhatsApp oficial', ligada: false, versao: 2 },
      { chave: 'serasa', nome: 'Serasa', ligada: false, versao: 2 },
    ];
  }

  /** Cada consulta custa dinheiro e envolve dado pessoal: exige permissão de cadastro e fica registrada. */
  @Get('assertiva/cpf/:cpf')
  async consultarCpf(@Usuario() u: UsuarioLogado, @Param('cpf') cpfBruto: string) {
    if (!temPermissao(u.permissoes, 'rede', 'criar') && !temPermissao(u.permissoes, 'cadastros', 'criar')) {
      throw new ForbiddenException('Você não tem permissão para consultar CPF.');
    }
    const cpf = soDigitos(cpfBruto);
    if (!cpfValido(cpf)) throw new BadRequestException('CPF inválido.');
    const dados = await this.assertiva.consultarCpf(cpf);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'consulta_cpf', entidade: 'assertiva', entidadeId: cpf.slice(0, 3) + '*****' + cpf.slice(-3) });
    return dados;
  }
}
