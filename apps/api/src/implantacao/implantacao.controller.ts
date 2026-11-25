import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { configuracoes, grupos } from '../db/schema';
import { MODULOS } from '@aritana/regras';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { EmailService } from '../integracoes/email.service';
import { AsaasService } from '../integracoes/asaas.service';
import { AssertivaService } from '../integracoes/assertiva.service';
import { FiscalService } from '../fiscal/fiscal.service';
import { SegredosService } from '../segredos/segredos.service';
import { IaService } from '../ia/ia.service';

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
  regras_confirmadas: { grupo: 'Regras do negócio', titulo: 'Comissões, multa, juros e limites confirmados', descricao: 'Use "Usar regras do Jueri" em Regras do consignado, confira com a Aritana e salve.', link: '/configuracoes' },
  regras_loja: { grupo: 'Regras do negócio', titulo: 'Desconto máximo, prazo de troca, garantia e comissão da loja confirmados', descricao: 'Ficam em Configurações › Regras do consignado (regras de venda) e › Avisos e regras.', link: '/configuracoes?aba=avisos' },
  juridico: { grupo: 'Documentos', titulo: 'Contrato e promissória revisados pelo jurídico', descricao: 'O contrato instalado é o que a Aritana já usa; a promissória ainda é provisória. Há pontos do contrato para o jurídico olhar (referências cruzadas de cláusulas, faixas de comissão e assinatura eletrônica). Troque em Configurações › Modelos de documento e marque aqui.', link: '/configuracoes?aba=modelos' },
  piloto: { grupo: 'Virada', titulo: 'Piloto em paralelo com o Jueri concluído', descricao: 'Algumas semanas usando os dois sistemas para comparar acertos, estoque e financeiro antes de desligar o Jueri.' },
  jueri_fechado: { grupo: 'Virada', titulo: 'Jueri fechado e importação final feita', descricao: 'Ninguém lança mais nada no Jueri; a importação final roda com todas as partes marcadas (maletas e contas incluídas).', link: '/configuracoes?aba=importacao' },
  asaas_conta_real: { grupo: 'Financeiro', titulo: 'Módulo Asaas testado na conta real', descricao: 'O módulo foi testado só no simulador. Com a chave de produção, abra cada seção de Financeiro › Asaas e faça uma cobrança de teste; se alguma operação der erro, avise a Wide.', link: '/financeiro?secao=asaas' },
  plano_contas_revisado: { grupo: 'Financeiro', titulo: 'Plano de contas revisado com o contador', descricao: 'O plano instalado é um ponto de partida. Ajuste as contas e confira a DRE de um mês fechado.', link: '/financeiro?secao=plano' },
  cra_real: { grupo: 'Cobrança', titulo: 'Protesto em cartório testado com o CRA21', descricao: 'O envio ao cartório foi testado só no simulador. Faça a primeira remessa acompanhada, com um título de valor baixo.', link: '/cobranca' },
  regua_cobranca: { grupo: 'Cobrança', titulo: 'Régua, carteiras e terceirizadas de cobrança conferidas', descricao: 'Dias e mensagens da régua, quem cobra cada carteira e as empresas de cobrança cadastradas.', link: '/cobranca' },
  clausula_cobranca: { grupo: 'Cobrança', titulo: 'Aditivo de cobrança revisado pelo jurídico', descricao: 'O modelo do aditivo (serviço de cobrança das vendas a prazo das consultoras, que abre exceção na cláusula 10ª) já está em Configurações › Modelos de documento, marcado como provisório. Falta o jurídico revisar o texto e a Aritana definir a taxa do serviço.', link: '/configuracoes?aba=modelos' },
  regras_contrato: { grupo: 'Regras do negócio', titulo: 'Comissões confirmadas em Regras do consignado', descricao: 'Decisão: o sistema mantém a regra de comissão configurada (as comissões podem ser diferentes das faixas do contrato). Confira os percentuais, a multa e os juros em Configurações › Regras e, se o contrato for mudar, alinhe o texto com o jurídico.', link: '/configuracoes' },
  precificacao_regras: { grupo: 'Regras do negócio', titulo: 'Coeficientes e markup da precificação confirmados', descricao: 'Ouro 5,50 e prata 1,50 por grama, markup por faixa e insumos de R$ 5,00 vieram da planilha de colares. Falta a Aritana explicar os coeficientes diferentes (4, 3, 3,5 e 2) e o que é a coluna "Novo Código do Produto".', link: '/produtos/precificacao' },
  precificacao_jueri: { grupo: 'Regras do negócio', titulo: 'Decidido onde o preço é definido até a virada', descricao: 'O preço gravado aqui não volta para o Jueri (acesso só de leitura). Definir se a Aritana mantém os dois ou precifica só neste sistema.' },
  agentes_revisados: { grupo: 'Atendimento', titulo: 'Roteiros dos agentes de IA revisados', descricao: 'Recepção e especialistas (Vendas, Recrutamento, Revendedora): confira o texto de cada um e faça conversas de teste antes de ligar no número principal.', link: '/crm?aba=configurar' },
  app_publicado: { grupo: 'Atendimento', titulo: 'Aplicativo da representante publicado', descricao: 'Publicação na Google Play e na App Store, com as chaves de notificação preenchidas em Integrações.', link: '/configuracoes?aba=integracoes' },
  dev_ferramentas_ia: { grupo: 'Atendimento', titulo: 'Ferramentas da IA testadas em conversa real', descricao: 'A IA já pode mandar 2ª via, anotar promessa de pagamento, consultar estoque e registrar candidatura. Foi testada com a IA simulada: faça conversas de teste com o Claude de verdade antes de ligar no número principal.', link: '/crm?aba=configurar' },
  dev_minha_mesa: { grupo: 'Regras do negócio', titulo: 'Painel de cada setor escolhido', descricao: 'Em Minha mesa › Painel do setor, a gestão escolhe os indicadores que cada grupo de usuários vê. Sem escolha, cada pessoa vê os indicadores dos módulos a que tem acesso.', link: '/mesa' },
  dev_indicacao: { grupo: 'Regras do negócio', titulo: 'Prêmio do Indique e ganhe definido', descricao: 'Em Revendedoras › Indique e ganhe › Prêmio e regras, confirme o valor do prêmio por consultora indicada (padrão R$ 50,00, pago depois do primeiro pedido pago), o valor da equipe, a validade e a mensagem do convite. Avise a equipe e as consultoras que cada uma tem o seu link.', link: '/indicacoes' },
  dev_scorecard: { grupo: 'Regras do negócio', titulo: 'Scorecard da equipe configurado', descricao: 'Em Scorecard da equipe, cadastre os indicadores de cada setor (meta e peso), as faixas e o valor do bônus. Só a gestão avalia, e ninguém fecha a própria avaliação.', link: '/scorecard' },
  dev_aprendizado_ia: { grupo: 'Atendimento', titulo: 'Equipe orientada a corrigir a IA', descricao: 'Quem atende usa "Corrigir a IA" nas respostas erradas, e a gestão aprova as lições e as sugestões da revisão semanal em CRM › Configurar › Agente de IA.', link: '/crm?aba=configurar' },
  dev_precificacao_categorias: { grupo: 'Desenvolvimento (Wide)', titulo: 'Precificação das outras categorias', descricao: 'A fórmula foi montada com a planilha de colares. Falta receber as planilhas (ou a confirmação) de anéis, brincos, pulseiras e demais categorias.', link: '/produtos/precificacao' },
  dev_cobranca_servico: { grupo: 'Desenvolvimento (Wide)', titulo: 'Cobrança como serviço para as consultoras', descricao: 'Com o aditivo assinado, a Wide desenvolve a tela em que a consultora indica a venda a prazo para cobrança, a emissão dos boletos e o repasse no acerto. Depende da taxa do serviço e da forma de repasse definidas pela Aritana.' },
  backup_testado: { grupo: 'Virada', titulo: 'Cópia de segurança restaurada em teste', descricao: 'A cópia diária do banco existe no servidor; falta restaurar uma delas em teste para ter certeza de que volta.' },
  treinamento: { grupo: 'Virada', titulo: 'Equipe treinada', descricao: 'Cada setor passou pelo capítulo dele no Manual e fez as operações do dia a dia no ambiente de teste.', link: '/manual' },
  jueri_token: { grupo: 'Virada', titulo: 'Token do Jueri apagado', descricao: 'Depois da virada, apague o token no Jueri (Configurações › API) e em Integrações › Jueri.', link: '/configuracoes?aba=integracoes' },
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
    private readonly ia: IaService,
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
    const [ultimaJueri] = (await this.db.execute<{ arquivo: string; criado_em: string }>(sql`select arquivo, criado_em from importacoes where tipo = 'jueri:api' order by criado_em desc limit 1`)).rows;
    const [contasSemPessoa, produtosSemPreco] = await Promise.all([
      n(sql`select count(*) as n from titulos where id_jueri is not null and status in ('aberto','protestado') and pessoa_id is null`),
      n(sql`select count(*) as n from produtos where preco = 0 and id_jueri is not null`),
    ]);
    // Grupos criados antes dos módulos novos não enxergam esses módulos até alguém marcar.
    const gruposSemModulos = (await this.db.select().from(grupos))
      .filter((g) => !g.permissoes['*'])
      .map((g) => ({ nome: g.nome, faltam: MODULOS.filter((m) => ['crm', 'marketing', 'pontos', 'formularios'].includes(m.chave) && !g.permissoes[m.chave]).map((m) => m.nome) }))
      .filter((g) => g.faltam.length);
    const [canais, titulosSemPlano, contasAtivas, semPeso] = await Promise.all([
      n(sql`select count(*) as n from crm_canais`),
      n(sql`select count(*) as n from titulos where plano_conta_id is null and status <> 'cancelado'`),
      n(sql`select count(*) as n from contas where ativo`),
      n(sql`select count(*) as n from produtos where ativo and coalesce((medidas->>'peso')::numeric, 0) = 0`),
    ]);
    const v = (nome: string) => !!this.segredos.v(nome);
    const cra = ['CRA_URL', 'CRA_USUARIO', 'CRA_SENHA', 'CRA_CODIGO'].every(v);
    const push = v('FIREBASE_CONTA_SERVICO') || (v('APNS_CHAVE_P8') && v('APNS_KEY_ID') && v('APNS_TEAM_ID'));
    const matrizIncompleta = await n(sql`select count(*) as n from empresas where ativo and tipo = 'matriz' and (coalesce(endereco, '') = '' or coalesce(telefone, '') = '' or coalesce(email, '') = '')`);
    const itens: Item[] = [
      { chave: 'empresa_contrato', grupo: 'Documentos', titulo: 'Endereço, telefone e e-mail da matriz', descricao: 'Entram na qualificação da Aritana no contrato; em branco, o contrato sai com linhas vazias.', status: matrizIncompleta ? 'pendente' : 'ok', link: '/configuracoes?aba=empresas' },
      { chave: 'whatsapp', grupo: 'Atendimento', titulo: 'Número de WhatsApp ligado ao CRM', descricao: 'Sem um número ligado, o chat, os disparos e os agentes de IA não funcionam.', status: canais ? 'ok' : 'pendente', detalhe: canais ? `${canais} número(s)` : undefined, link: '/crm?aba=configurar' },
      { chave: 'ia', grupo: 'Atendimento', titulo: 'Inteligência artificial ligada', descricao: 'Chave do Claude (agentes e assistente) e, se quiser transcrição de áudio e imagens, a da OpenAI.', status: this.ia.texto ? 'ok' : 'pendente', detalhe: this.ia.texto && !this.ia.imagem ? 'Sem a chave da OpenAI: áudio não é transcrito' : undefined, link: '/configuracoes?aba=integracoes' },
      { chave: 'push', grupo: 'Atendimento', titulo: 'Notificações do aplicativo', descricao: 'Opcional: chaves do Firebase (Android) e da Apple para avisar a representante no celular.', status: push ? 'ok' : 'opcional', link: '/configuracoes?aba=integracoes' },
      { chave: 'cra', grupo: 'Cobrança', titulo: 'Acesso ao cartório (CRA21) preenchido', descricao: 'Opcional: só para quem vai protestar títulos pelo sistema.', status: cra ? 'ok' : 'opcional', link: '/configuracoes?aba=integracoes' },
      { chave: 'contas_bancarias', grupo: 'Financeiro', titulo: 'Contas bancárias cadastradas', descricao: 'Caixa, bancos e Asaas, cada conta na empresa certa.', status: contasAtivas ? 'ok' : 'pendente', detalhe: contasAtivas ? `${contasAtivas} conta(s)` : undefined, link: '/financeiro?secao=contas' },
      { chave: 'titulos_sem_plano', grupo: 'Financeiro', titulo: 'Lançamentos classificados no plano de contas', descricao: 'O que não tem conta aparece na DRE como "sem classificação". Em Financeiro, filtre "Sem classificação" e use "Classificar".', status: titulosSemPlano ? 'atencao' : 'ok', detalhe: titulosSemPlano ? `${titulosSemPlano} lançamento(s) sem conta` : undefined, link: '/financeiro' },
      { chave: 'produtos_sem_peso', grupo: 'Regras do negócio', titulo: 'Produtos com peso para precificar', descricao: 'Sem peso, a precificação não calcula o banho nem o preço sugerido.', status: produtosAtivos && semPeso ? 'atencao' : 'ok', detalhe: semPeso ? `${semPeso} de ${produtosAtivos} sem peso` : undefined, link: '/produtos/precificacao' },
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
      {
        chave: 'importacao',
        grupo: 'Virada',
        titulo: 'Dados do Jueri importados',
        descricao: 'Produtos com estoque e fotos, revendedoras, clientes, fornecedores, maletas abertas e contas a receber.',
        status: !importacoes ? 'pendente' : ultimaJueri && !(ultimaJueri.arquivo.includes('maletas') && ultimaJueri.arquivo.includes('financeiro')) ? 'atencao' : 'ok',
        detalhe: ultimaJueri ? `Última importação do Jueri em ${new Date(ultimaJueri.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} (${ultimaJueri.arquivo}). Na virada, importe de novo com todas as partes.` : undefined,
        link: '/configuracoes?aba=importacao',
      },
      { chave: 'contas_sem_pessoa', grupo: 'Financeiro', titulo: 'Contas do Jueri ligadas às pessoas', descricao: 'Contas que vieram só com o nome do contato. No Financeiro, marque "Só sem pessoa ligada" e use "Ligar pessoa".', status: contasSemPessoa ? 'atencao' : 'ok', detalhe: contasSemPessoa ? `${contasSemPessoa} conta(s) sem pessoa` : undefined, link: '/financeiro' },
      { chave: 'produtos_sem_preco', grupo: 'Virada', titulo: 'Produtos do Jueri sem preço', descricao: 'Entraram inativos e fora do catálogo. Defina o preço dos que ainda são vendidos.', status: produtosSemPreco ? 'opcional' : 'ok', detalhe: produtosSemPreco ? `${produtosSemPreco} produto(s) com preço zero` : undefined, link: '/produtos' },
      { chave: 'grupos_modulos', grupo: 'Virada', titulo: 'Grupos com acesso aos módulos novos', descricao: 'Grupos criados antes de Candidatas, Pontos, Formulários e Marketing não enxergam esses módulos até alguém marcar. Se for de propósito, ignore.', status: gruposSemModulos.length ? 'opcional' : 'ok', detalhe: gruposSemModulos.length ? gruposSemModulos.map((g) => `${g.nome}: ${g.faltam.join(', ')}`).join(' · ') : undefined, link: '/configuracoes?aba=grupos' },
    ];
    for (const [chave, m] of Object.entries(MANUAIS)) {
      const c = conf[chave];
      itens.push({ chave, ...m, manual: true, status: c ? 'ok' : 'pendente', confirmadoPor: c?.por ?? null, confirmadoEm: c?.em ?? null });
    }
    const ordem = ['Notas fiscais', 'Financeiro', 'Cobrança', 'Regras do negócio', 'Documentos', 'Comunicação', 'Atendimento', 'Desenvolvimento (Wide)', 'Virada'];
    itens.sort((a, b) => ordem.indexOf(a.grupo) - ordem.indexOf(b.grupo));
    const contam = itens.filter((i) => i.status !== 'opcional');
    return { itens, feitos: contam.filter((i) => i.status === 'ok').length, total: contam.length, importadosJueri: await this.importadosJueri() };
  }

  private async importadosJueri() {
    const r = await this.db.execute<{ n: number }>(sql`select (select count(*) from maletas where id_jueri is not null) + (select count(*) from titulos where id_jueri is not null) + (select count(*) from pessoas where id_jueri is not null) + (select count(*) from produtos where id_jueri is not null) + (select count(*) from jueri_historico) as n`);
    return Number(r.rows[0]?.n ?? 0);
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
    const d = validar(z.object({ confirmacao: z.literal('APAGAR', { message: 'Digite APAGAR para confirmar' }), manterProdutos: z.boolean().default(false), manterPessoas: z.boolean().default(false), apagarImportados: z.boolean().default(false) }), body);
    // Depois da importação do Jueri, "apagar dados de teste" apagaria maletas, estoque e contas reais.
    const importados = await this.importadosJueri();
    if (importados && !d.apagarImportados) throw new BadRequestException(`Há ${importados} registro(s) importados do Jueri (maletas, estoque, contas, cadastros). Isto apagaria os dados reais. Se é isso mesmo (vai importar de novo), marque a opção de apagar também os dados importados.`);
    const contar = async () => {
      const r = await this.db.execute<{ pessoas: number; produtos: number; maletas: number; vendas: number; titulos: number }>(sql`
        select (select count(*)::int from pessoas) as pessoas, (select count(*)::int from produtos) as produtos, (select count(*)::int from maletas) as maletas,
               (select count(*)::int from vendas) as vendas, (select count(*)::int from titulos) as titulos`);
      return r.rows[0];
    };
    const antes = await contar();
    await this.db.transaction(async (tx) => {
      // Movimento: sempre apagado (e a numeração de maletas, vendas e ordens volta para 1).
      const movimento = ['indicacoes', 'bsc_ocorrencias', 'bsc_resultados', 'bsc_avaliacoes', 'mesa_mensagens', 'mesa_participantes', 'mesa_conversas', 'mesa_tarefas', 'cobranca_protestos', 'cobranca_arquivos_cra', 'cobranca_envios', 'cobranca_contatos', 'cobranca_carteira', 'cobranca_acordos', 'ia_usos', 'meta_leads', 'portal_dispositivos', 'pedidos_link', 'agenda_compromissos', 'jueri_historico_itens', 'jueri_historico', 'rh_envios', 'rh_fechamentos', 'rh_tratamentos', 'rh_registros', 'rh_ponto_empresas', 'rh_ocorrencias', 'rh_documentos', 'crm_disparo_destinos', 'crm_disparos', 'crm_fila', 'crm_mensagens', 'crm_conversas', 'crm_eventos', 'crm_tarefas', 'crm_leads', 'crm_contatos', 'comissoes', 'fechamentos_comissao', 'notas_fiscais', 'documentos', 'acertos', 'maleta_solicitacoes', 'maleta_itens', 'maletas', 'caixa_movimentos', 'venda_pagamentos', 'venda_itens', 'vendas', 'caixas', 'titulos', 'creditos', 'ordens_servico', 'movimentos', 'saldos', 'eventos_integracao', 'avisos_enviados', 'importacoes', 'candidatura_notas', 'candidaturas', 'pedidos_pecas', 'portal_acessos', 'pontos', 'resgates', 'formulario_respostas'];
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
