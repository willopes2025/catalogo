import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { validar } from '../comum/validacao';
import { SegredosService } from '../segredos/segredos.service';
import { INTEGRACOES, NOMES_PERMITIDOS, SECRETOS } from '../segredos/campos';
import { AsaasService } from './asaas.service';
import { FiscalService } from '../fiscal/fiscal.service';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { cpfValido, soDigitos } from '../comum/documentos';
import { AuditoriaService } from '../comum/auditoria.service';
import { AssertivaService } from './assertiva.service';
import { EmailService } from './email.service';

@Controller('integracoes')
export class IntegracoesController {
  constructor(
    private readonly assertiva: AssertivaService,
    private readonly email: EmailService,
    private readonly auditoria: AuditoriaService,
    private readonly segredos: SegredosService,
    private readonly asaas: AsaasService,
    private readonly fiscal: FiscalService,
  ) {}

  private ligada(chave: string) {
    return chave === 'email' ? this.email.configurado : chave === 'asaas' ? this.asaas.configurado : chave === 'fiscal' ? this.fiscal.configurado : chave === 'assertiva' ? this.assertiva.configurada : false;
  }

  /** Campos de cada integração para a tela. Senhas nunca voltam: só se estão preenchidas e os últimos caracteres. */
  @Get()
  @Permissao('configuracoes', 'ver')
  listar(@Usuario() u: UsuarioLogado) {
    const podeVer = temPermissao(u.permissoes, 'configuracoes', 'editar');
    const dominio = process.env.PAINEL_URL ?? (process.env.DOMINIO ? `https://${process.env.DOMINIO}` : '');
    return INTEGRACOES.map((i) => ({
      ...i,
      ligada: this.ligada(i.chave),
      ambiente: i.chave === 'asaas' ? this.asaas.ambiente : i.chave === 'fiscal' ? this.fiscal.ambiente : null,
      extra: i.chave === 'asaas' ? { webhookUrl: `${dominio}/api/webhooks/asaas` } : null,
      campos: i.campos.map((c) => {
        const v = this.segredos.v(c.nome);
        return {
          ...c,
          preenchido: !!v,
          origem: this.segredos.origem(c.nome),
          ilegivel: this.segredos.ilegivel(c.nome),
          valor: !c.secreto || (c.mostrar && podeVer) ? v ?? '' : null,
          final: c.secreto && v && v.length > 8 ? v.slice(-4) : null,
        };
      }),
    }));
  }

  /** Grava os campos de uma integração. Campo omitido fica como está; null apaga o que foi salvo pela tela. */
  @Put(':chave')
  @Permissao('configuracoes', 'editar')
  async salvar(@Usuario() u: UsuarioLogado, @Param('chave') chave: string, @Body() body: unknown) {
    const integ = INTEGRACOES.find((i) => i.chave === chave);
    if (!integ) throw new NotFoundException('Integração desconhecida.');
    const { valores } = validar(z.object({ valores: z.record(z.string(), z.string().max(2000).nullable()) }), body);
    const mudou: string[] = [];
    for (const [nome, valor] of Object.entries(valores)) {
      if (!NOMES_PERMITIDOS.has(nome) || !integ.campos.some((c) => c.nome === nome)) throw new BadRequestException(`Campo desconhecido: ${nome}`);
      const campo = integ.campos.find((c) => c.nome === nome)!;
      const v = valor === null ? null : valor.trim();
      if (v && campo.opcoes && !campo.opcoes.some(([o]) => o === v)) throw new BadRequestException(`Valor inválido em ${campo.rotulo}.`);
      if (SECRETOS.has(nome) && v === '') continue; // senha em branco = manter a atual
      await this.segredos.salvar(nome, v || null, u.id);
      mudou.push(nome);
    }
    // Nunca registra o valor na auditoria, só quais campos mudaram.
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: `integracao:${chave}`, dados: { campos: mudou } });
    return { ok: true, ligada: this.ligada(chave) };
  }

  /** Gera um token aleatório (ex.: token do webhook do Asaas). */
  @Post(':chave/gerar/:nome')
  @Permissao('configuracoes', 'editar')
  async gerar(@Usuario() u: UsuarioLogado, @Param('chave') chave: string, @Param('nome') nome: string) {
    const campo = INTEGRACOES.find((i) => i.chave === chave)?.campos.find((c) => c.nome === nome);
    if (!campo?.gerar) throw new BadRequestException('Este campo não é gerado pelo sistema.');
    const valor = randomBytes(24).toString('hex');
    await this.segredos.salvar(nome, valor, u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'gerar_token', entidade: `integracao:${chave}`, dados: { campo: nome } });
    return { valor };
  }

  /** Testa a conexão com as credenciais atuais. */
  @Post(':chave/testar')
  @Permissao('configuracoes', 'editar')
  async testar(@Usuario() u: UsuarioLogado, @Param('chave') chave: string) {
    if (chave === 'email') return this.email.testar(u.email);
    if (chave === 'asaas') return this.asaas.testar();
    if (chave === 'fiscal') return this.fiscal.testar();
    if (chave === 'assertiva') return this.assertiva.testar();
    throw new NotFoundException('Integração desconhecida.');
  }

  /** Situação de cada integração, para a tela Configurações › Integrações. */
  @Get('status')
  @Permissao('configuracoes', 'ver')
  status() {
    return [
      { chave: 'assertiva', nome: 'Assertiva (consulta de CPF)', ligada: this.assertiva.configurada, versao: 1 },
      { chave: 'email', nome: 'E-mail (códigos de assinatura e avisos)', ligada: this.email.configurado, versao: 1 },
      { chave: 'asaas', nome: 'Asaas (boletos e Pix)', ligada: this.asaas.configurado, versao: 1 },
      { chave: 'fiscal', nome: 'Emissor fiscal (NF-e e NFC-e)', ligada: this.fiscal.configurado, versao: 1 },
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
