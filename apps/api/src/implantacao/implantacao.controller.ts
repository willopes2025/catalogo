import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { configuracoes } from '../db/schema';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { EmailService } from '../integracoes/email.service';
import { AsaasService } from '../integracoes/asaas.service';
import { AssertivaService } from '../integracoes/assertiva.service';
import { FiscalService } from '../fiscal/fiscal.service';
import { SegredosService } from '../segredos/segredos.service';

type Status = 'ok' | 'pendente' | 'atencao' | 'opcional';
interface Item {
  chave: string;
  grupo: string;
  titulo: string;
  descricao: string;
  status: Status;
  detalhe?: string;
  /** Tela onde se resolve. */
  link?: string;
  /** Item que a Aritana confirma à mão (o sistema não tem como verificar sozinho). */
  manual?: boolean;
  confirmadoPor?: string | null;
  confirmadoEm?: string | null;
}

/** Itens que só uma pessoa pode confirmar. */
const MANUAIS: Record<string, { grupo: string; titulo: string; descricao: string; link?: string }> = {
  certificado_a1: { grupo: 'Notas fiscais', titulo: 'Certificado digital A1 enviado à Focus NFe', descricao: 'O certificado, a série das notas e o CSC da NFC-e são cadastrados no painel da Focus, não aqui.', link: '/configuracoes?aba=integracoes' },
  cfop_contador: { grupo: 'Notas fiscais', titulo: 'Naturezas e CFOPs conferidos pelo contador', descricao: 'Os CFOPs que vêm instalados são um ponto de partida para o Simples Nacional.', link: '/fiscal' },
  webhook_asaas: { grupo: 'Financeiro', titulo: 'Webhook cadastrado no Asaas', descricao: 'Sem ele, o boleto pago não baixa sozinho. Endereço e token estão em Integrações › Asaas.', link: '/configuracoes?aba=integracoes' },
  saldos_contas: { grupo: 'Financeiro', titulo: 'Saldos iniciais das contas conferidos', descricao: 'Caixa, bancos e Asaas com o saldo do dia da virada.', link: '/financeiro' },
  regras_confirmadas: { grupo: 'Regras do negócio', titulo: 'Comissões, multa, juros e limites confirmados', descricao: 'Os valores atuais são provisórios até a Aritana confirmar.', link: '/configuracoes' },
  regras_loja: { grupo: 'Regras do negócio', titulo: 'Desconto máximo, prazo de troca, garantia e comissão da loja confirmados', descricao: 'Ficam em Configurações › Regras do consignado (regras de venda) e › Avisos e regras.', link: '/configuracoes?aba=avisos' },
  juridico: { grupo: 'Documentos', titulo: 'Contrato e promissória revisados pelo jurídico', descricao: 'Os textos instalados são provisórios. Troque em Configurações › Modelos de documento e marque aqui.', link: '/configuracoes?aba=modelos' },
  piloto: { grupo: 'Virada', titulo: 'Piloto em paralelo com o Jueri concluído', descricao: 'Algumas semanas usando os dois sistemas para comparar acertos, estoque e financeiro antes de desligar o Jueri.' },
};

@Controller('implantacao')
export class ImplantacaoController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfiguracoesService,
    private readonly email: EmailService,
    private readonly asaas: AsaasService,
    private readonly assertiva: AssertivaService,
    private readonly fiscal: FiscalService,
    private readonly segredos: SegredosService,
  ) {}

  private async confirmacoes(): Promise<Record<string, { por: string; em: string }>> {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, 'implantacao'));
    return ((c?.valor as { confirmacoes?: Record<string, { por: string; em: string }> })?.confirmacoes ?? {}) as Record<string, { por: string; em: string }>;
  }

  @Get()
  @Permissao('configuracoes', 'ver')
  async listar() {
    const conf = await this.confirmacoes();
    const n = async (q: ReturnType<typeof sql>) => Number((await this.db.execute<{ n: string }>(q)).rows[0]?.n ?? 0);
    const [empresasSemCnpj, produtosSemNcm, produtosAtivos, usuariosAtivos, importacoes, exemplos, adminProvisorio, contratos] = await Promise.all([
      n(sql`select count(*) as n from empresas where ativo and (cnpj is null or cnpj = '' or razao_social is null or inscricao_estadual is null)`),
      n(sql`select count(*) as n from produtos where ativo and (ncm is null or ncm = '')`),
      n(sql`select count(*) as n from produtos where ativo`),
      n(sql`select count(*) as n from usuarios where ativo`),
      n(sql`select count(*) as n from importacoes`),
      n(sql`select count(*) as n from pessoas where nome ilike '%exemplo%'`),
      n(sql`select count(*) as n from usuarios where ativo and senha_provisoria`),
      n(sql`select count(*) as n from modelos_documento where ativo and conteudo ilike '%MODELO PROVISÓRIO%'`),
    ]);
    const avisos = await this.config.ler('avisos');
    const itens: Item[] = [
      { chave: 'empresas', grupo: 'Notas fiscais', titulo: 'Empresas com razão social, CNPJ e inscrição estadual', descricao: 'Matriz (representantes) e loja, cada uma com o seu CNPJ.', status: empresasSemCnpj ? 'pendente' : 'ok', detalhe: empresasSemCnpj ? `${empresasSemCnpj} empresa(s) com dados faltando` : undefined, link: '/configuracoes?aba=empresas' },
      {
        chave: 'focus',
        grupo: 'Notas fiscais',
        titulo: 'Emissor de notas (Focus NFe) ligado',
        descricao: 'Token da Focus preenchido em Integrações.',
        status: !this.fiscal.configurado ? 'pendente' : this.fiscal.ambiente === 'produção' ? 'ok' : 'atencao',
        detalhe: this.fiscal.configurado ? `Ambiente: ${this.fiscal.ambiente}${this.fiscal.ambiente !== 'produção' ? ' (notas sem valor fiscal)' : ''}` : undefined,
        link: '/configuracoes?aba=integracoes',
      },
      { chave: 'ncm', grupo: 'Notas fiscais', titulo: 'Produtos com NCM', descricao: 'Sem NCM o produto não sai em nota.', status: produtosAtivos === 0 ? 'pendente' : produtosSemNcm ? 'pendente' : 'ok', detalhe: produtosAtivos === 0 ? 'Nenhum produto cadastrado' : produtosSemNcm ? `${produtosSemNcm} de ${produtosAtivos} sem NCM` : undefined, link: '/produtos' },
      {
        chave: 'asaas',
        grupo: 'Financeiro',
        titulo: 'Asaas ligado (boleto e Pix)',
        descricao: 'Chave da API e token do webhook em Integrações.',
        status: !this.asaas.configurado ? 'pendente' : this.asaas.ambiente === 'produção' ? 'ok' : 'atencao',
        detalhe: this.asaas.configurado ? `Ambiente: ${this.asaas.ambiente}${this.segredos.v('ASAAS_WEBHOOK_TOKEN') ? '' : ' · falta o token do webhook'}` : undefined,
        link: '/configuracoes?aba=integracoes',
      },
      { chave: 'email', grupo: 'Comunicação', titulo: 'E-mail do sistema ligado', descricao: 'Código de assinatura, lembretes de acerto e parcela, resumo da equipe.', status: this.email.configurado ? 'ok' : 'pendente', link: '/configuracoes?aba=integracoes' },
      { chave: 'avisos', grupo: 'Comunicação', titulo: 'Avisos automáticos com e-mails da equipe', descricao: 'Quem recebe o resumo da manhã.', status: avisos.ativo && avisos.emailsEquipe.length ? 'ok' : 'pendente', link: '/configuracoes?aba=avisos' },
      { chave: 'assertiva', grupo: 'Comunicação', titulo: 'Consulta de CPF pela Assertiva', descricao: 'Opcional: sem ela, o cadastro é preenchido à mão.', status: this.assertiva.configurada ? 'ok' : 'opcional', link: '/configuracoes?aba=integracoes' },
      { chave: 'modelos', grupo: 'Documentos', titulo: 'Modelos de contrato e promissória trocados', descricao: 'Ainda há texto marcado como provisório?', status: contratos ? 'pendente' : 'ok', detalhe: contratos ? `${contratos} modelo(s) com texto provisório` : undefined, link: '/configuracoes?aba=modelos' },
      { chave: 'usuarios', grupo: 'Virada', titulo: 'Usuários da equipe criados', descricao: 'Cada pessoa com o seu login e o grupo certo.', status: usuariosAtivos > 1 ? 'ok' : 'pendente', detalhe: `${usuariosAtivos} usuário(s) ativo(s)`, link: '/configuracoes?aba=usuarios' },
      { chave: 'senhas', grupo: 'Virada', titulo: 'Senhas provisórias trocadas', descricao: 'Inclusive a do administrador criado na instalação.', status: adminProvisorio ? 'pendente' : 'ok', detalhe: adminProvisorio ? `${adminProvisorio} usuário(s) ainda com senha provisória` : undefined, link: '/configuracoes?aba=usuarios' },
      { chave: 'dados_teste', grupo: 'Virada', titulo: 'Dados de teste apagados', descricao: 'Antes de começar de verdade, apague os cadastros e movimentos de exemplo.', status: exemplos ? 'pendente' : 'ok', detalhe: exemplos ? `${exemplos} cadastro(s) "Exemplo" ainda no sistema` : undefined },
      { chave: 'importacao', grupo: 'Virada', titulo: 'Dados do Jueri importados', descricao: 'Produtos com estoque, representantes, clientes e fornecedores.', status: importacoes ? 'ok' : 'pendente', link: '/configuracoes?aba=importacao' },
    ];
    for (const [chave, m] of Object.entries(MANUAIS)) {
      const c = conf[chave];
      itens.push({ chave, ...m, manual: true, status: c ? 'ok' : 'pendente', confirmadoPor: c?.por ?? null, confirmadoEm: c?.em ?? null });
    }
    const ordem = ['Notas fiscais', 'Financeiro', 'Regras do negócio', 'Documentos', 'Comunicação', 'Virada'];
    itens.sort((a, b) => ordem.indexOf(a.grupo) - ordem.indexOf(b.grupo));
    const contam = itens.filter((i) => i.status !== 'opcional');
    return { itens, feitos: contam.filter((i) => i.status === 'ok').length, total: contam.length };
  }

  /** Marca (ou desmarca) um item que só a Aritana pode confirmar. */
  @Post('confirmar')
  @Permissao('configuracoes', 'editar')
  async confirmar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ chave: z.string(), feito: z.boolean() }), body);
    if (!MANUAIS[d.chave]) throw new BadRequestException('Item desconhecido.');
    const conf = await this.confirmacoes();
    if (d.feito) conf[d.chave] = { por: u.nome, em: new Date().toISOString() };
    else delete conf[d.chave];
    const valor = { confirmacoes: conf };
    await this.db.insert(configuracoes).values({ chave: 'implantacao', valor }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor, atualizadoEm: new Date() } });
    await this.auditoria.registrar({ usuarioId: u.id, acao: d.feito ? 'confirmar' : 'desmarcar', entidade: 'implantacao', entidadeId: d.chave });
    return { ok: true };
  }

  /**
   * Apaga os dados de teste para começar a usar de verdade.
   * Mantém: empresas, locais, usuários, grupos, níveis, categorias, contas, regras, modelos, integrações e auditoria.
   * Só a Diretoria (acesso total), digitando APAGAR. Antes, o servidor já guarda a cópia diária do banco.
   */
  @Post('apagar-dados-de-teste')
  @Permissao('configuracoes', 'excluir')
  async apagar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    if (!temPermissao(u.permissoes, '*', '*')) throw new ForbiddenException('Só a Diretoria (acesso total) pode apagar os dados.');
    const d = validar(z.object({ confirmacao: z.literal('APAGAR', { message: 'Digite APAGAR para confirmar' }), manterProdutos: z.boolean().default(false), manterPessoas: z.boolean().default(false) }), body);
    const contar = async () => {
      const r = await this.db.execute<{ pessoas: number; produtos: number; maletas: number; vendas: number; titulos: number }>(sql`
        select (select count(*)::int from pessoas) as pessoas, (select count(*)::int from produtos) as produtos, (select count(*)::int from maletas) as maletas,
               (select count(*)::int from vendas) as vendas, (select count(*)::int from titulos) as titulos`);
      return r.rows[0];
    };
    const antes = await contar();
    await this.db.transaction(async (tx) => {
      // Movimento: sempre apagado (e a numeração de maletas, vendas e ordens volta para 1).
      const movimento = ['comissoes', 'fechamentos_comissao', 'notas_fiscais', 'documentos', 'acertos', 'maleta_itens', 'maletas', 'caixa_movimentos', 'venda_pagamentos', 'venda_itens', 'vendas', 'caixas', 'titulos', 'creditos', 'ordens_servico', 'movimentos', 'saldos', 'eventos_integracao', 'avisos_enviados', 'importacoes', 'candidatura_notas', 'candidaturas', 'pedidos_pecas', 'portal_acessos', 'pontos', 'resgates', 'formulario_respostas'];
      await tx.execute(sql.raw(`truncate table ${movimento.join(', ')} restart identity`));
      await tx.execute(sql`delete from locais_estoque where tipo = 'maleta'`);
      if (!d.manterProdutos) await tx.execute(sql`delete from produtos`).then(() => tx.execute(sql`delete from lotes_banho`));
      if (!d.manterPessoas) {
        await tx.execute(sql`update produtos set fornecedor_id = null`);
        await tx.execute(sql`update lotes_banho set fornecedor_id = null`);
        await tx.execute(sql`delete from referencias`);
        await tx.execute(sql`update pessoas set lider_id = null, supervisor_id = null, indicado_por_id = null, representante_id = null`);
        await tx.execute(sql`delete from pessoas`);
      }
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'apagar_dados_de_teste', entidade: 'implantacao', dados: { antes, manterProdutos: d.manterProdutos, manterPessoas: d.manterPessoas } }, tx);
    });
    return { ok: true, antes, depois: await contar() };
  }
}
