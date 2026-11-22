import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { Permissao, Usuario, temPermissao, type UsuarioLogado } from '../comum/auth';
import { DB, type Db } from '../comum/db.module';
import { validar } from '../comum/validacao';
import { urlPublica } from '../comum/url';
import { AuditoriaService } from '../comum/auditoria.service';
import { pessoas, titulos } from '../db/schema';
import { AsaasService } from '../integracoes/asaas.service';
import { SegredosService } from '../segredos/segredos.service';
import { ACAO_DO_NIVEL, OPERACOES, POR_CHAVE, type CampoAsaas, type OperacaoAsaas } from './catalogo';

type Valores = Record<string, unknown>;
const EVENTOS_DO_SISTEMA = ['PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED'];

/** Converte um valor da tela para o formato do Asaas. Devolve undefined se veio vazio; lança o texto do erro se veio errado. */
function converter(campo: CampoAsaas, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return undefined;
  switch (campo.tipo) {
    case 'dinheiro':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000_000_00) throw 'Valor inválido';
      return Number((v / 100).toFixed(2));
    case 'numero':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) throw 'Número inválido';
      return v;
    case 'inteiro':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < -3650 || v > 100_000) throw 'Número inteiro inválido';
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw 'Marque sim ou não';
      return v;
    case 'data':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw 'Data inválida';
      return v;
    case 'opcao':
      if (typeof v !== 'string' || !campo.opcoes?.some((o) => o[0] === v)) throw 'Opção inválida';
      return v;
    case 'cliente':
      if (typeof v !== 'string' || !/^cus_[A-Za-z0-9]{1,40}$/.test(v)) throw 'Escolha o cliente';
      return v;
    case 'json':
      if (typeof v !== 'object' || JSON.stringify(v).length > 20_000) throw 'Lista inválida';
      return v;
    default:
      if (typeof v !== 'string' || v.length > 2000) throw 'Texto inválido';
      return v.trim() || undefined;
  }
}

/** Módulo Financeiro › Asaas: executa só as operações do catálogo, com a permissão de cada uma, e registra o que muda. */
@Controller('financeiro/asaas')
export class AsaasModuloController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly asaas: AsaasService,
    private readonly segredos: SegredosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  private pode(u: UsuarioLogado, o: OperacaoAsaas) {
    return temPermissao(u.permissoes, 'financeiro', ACAO_DO_NIVEL[o.nivel]);
  }

  /** O que este usuário pode fazer, com os campos de cada operação (a tela monta os formulários a partir disto). */
  @Get('catalogo')
  @Permissao('financeiro', 'ver')
  catalogo(@Usuario() u: UsuarioLogado) {
    return { ligado: this.asaas.configurado, ambiente: this.asaas.ambiente, operacoes: OPERACOES.filter((o) => this.pode(u, o)).map(({ caminho: _c, ...o }) => o) };
  }

  /** Saldo, totais e situação da conta, de uma vez (o que falhar vem nulo, com o motivo). */
  @Get('resumo')
  @Permissao('financeiro', 'ver')
  async resumo() {
    const pedir = async <T>(caminho: string) => this.asaas.chamar<T>('GET', caminho).then((v) => ({ v, erro: null as string | null })).catch((e: Error) => ({ v: null, erro: e.message }));
    const total = (status: string) => pedir<{ quantity: number; value: number; netValue: number }>(`/finance/payment/statistics?status=${status}`);
    const [saldo, aReceber, vencidas, recebidas, situacao, numero] = await Promise.all([pedir<{ balance: number }>('/finance/balance'), total('PENDING'), total('OVERDUE'), total('RECEIVED'), pedir<Valores>('/myAccount/status'), pedir<Valores>('/myAccount/accountNumber')]);
    return { ambiente: this.asaas.ambiente, saldo: saldo.v?.balance ?? null, aReceber: aReceber.v, vencidas: vencidas.v, recebidas: recebidas.v, situacao: situacao.v, numero: numero.v, erro: saldo.erro };
  }

  /** Cliente do Asaas para uma pessoa do cadastro (cria no Asaas se ainda não existe). */
  @Post('cliente')
  @Permissao('financeiro', 'editar')
  async cliente(@Body() body: unknown) {
    const { pessoaId } = validar(z.object({ pessoaId: z.string().uuid() }), body);
    const id = await this.asaas.clienteAsaas(pessoaId);
    const [p] = await this.db.select({ nome: pessoas.nome }).from(pessoas).where(eq(pessoas.id, pessoaId));
    return { id, nome: p?.nome ?? '' };
  }

  /** Garante que o Asaas avisa este sistema dos pagamentos (é o que dá a baixa automática nos títulos). */
  @Post('webhook-sistema')
  @Permissao('financeiro', 'excluir')
  async webhookDoSistema(@Usuario() u: UsuarioLogado) {
    const url = `${urlPublica()}/api/webhooks/asaas`;
    if (!/^https:\/\/|^http:\/\/localhost[:/]/.test(url)) throw new BadRequestException('O endereço público do sistema precisa ser https para o Asaas aceitar o webhook.');
    const lista = await this.asaas.chamar<{ data?: { id: string; url: string; enabled: boolean; interrupted: boolean }[] }>('GET', '/webhooks?limit=100');
    const atual = lista.data?.find((w) => w.url === url);
    let token = this.segredos.v('ASAAS_WEBHOOK_TOKEN');
    // O Asaas exige token de 32 caracteres ou mais: um token curto antigo é trocado por um novo.
    const novoToken = !token || token.length < 32;
    if (novoToken) token = randomBytes(24).toString('hex');
    const dados = { name: 'Plataforma Aritana', url, email: u.email, enabled: true, interrupted: false, authToken: token, sendType: 'SEQUENTIALLY', events: EVENTOS_DO_SISTEMA };
    const w = atual ? await this.asaas.chamar<{ id: string }>('PUT', `/webhooks/${atual.id}`, dados) : await this.asaas.chamar<{ id: string }>('POST', '/webhooks', dados);
    // O token só é gravado depois de o Asaas aceitar: assim os dois lados ficam sempre com o mesmo.
    if (novoToken) await this.segredos.salvar('ASAAS_WEBHOOK_TOKEN', token!, u.id);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'asaas', entidade: 'asaas', entidadeId: w.id, dados: { operacao: 'webhook-sistema', url, criado: !atual } });
    return { id: w.id, url, criado: !atual, mensagem: atual ? 'O webhook deste sistema foi atualizado e religado.' : 'Webhook criado: os pagamentos passam a dar baixa sozinhos nos títulos.' };
  }

  @Post('executar')
  @Permissao('financeiro', 'ver')
  async executar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(
      z.object({ operacao: z.string().max(60), id: z.string().regex(/^[\w-]{1,80}$/, 'Código inválido').optional(), filtros: z.record(z.string(), z.unknown()).default({}), corpo: z.record(z.string(), z.unknown()).default({}), pagina: z.number().int().min(1).max(100_000).default(1), porPagina: z.number().int().min(1).max(100).default(20) }),
      body,
    );
    const o = POR_CHAVE.get(d.operacao);
    if (!o) throw new BadRequestException('Operação desconhecida.');
    if (!this.pode(u, o)) throw new ForbiddenException(o.nivel === 'ver' ? 'Sem permissão.' : 'Esta operação é da gestão do Financeiro (permissão "excluir" no módulo Financeiro).');
    let caminho = o.caminho;
    if (caminho.includes(':id')) {
      if (!d.id) throw new BadRequestException('Falta o código do registro.');
      caminho = caminho.replace(':id', encodeURIComponent(d.id));
    }
    const erros: Record<string, string> = {};
    const ler = (campo: CampoAsaas, origem: Valores) => {
      try {
        const v = converter(campo, origem[campo.nome]);
        if (v === undefined && campo.obrigatorio) erros[campo.nome] = 'Obrigatório';
        return v;
      } catch (e) {
        erros[campo.nome] = String(e);
        return undefined;
      }
    };
    // Consulta: só os filtros do catálogo, mais a paginação.
    const consulta = new URLSearchParams();
    for (const f of o.filtros ?? []) {
      const v = ler({ ...f, obrigatorio: false }, d.filtros);
      if (v !== undefined) consulta.set(f.nome, String(v));
    }
    if (o.metodo === 'GET' && !o.caminho.includes(':id')) {
      consulta.set('offset', String((d.pagina - 1) * d.porPagina));
      consulta.set('limit', String(d.porPagina));
    }
    // Corpo: só os campos do catálogo; nome com ponto vira objeto dentro de objeto.
    let corpo: Valores | undefined;
    if (o.campos) {
      corpo = {};
      for (const cp of o.campos) {
        const v = ler(cp, d.corpo);
        if (v === undefined) continue;
        const partes = cp.nome.split('.');
        let alvo = corpo;
        for (const p of partes.slice(0, -1)) alvo = (alvo[p] ??= {}) as Valores;
        alvo[partes[partes.length - 1]] = v;
      }
    }
    if (Object.keys(erros).length) throw new BadRequestException({ mensagem: 'Confira os campos destacados.', campos: erros });

    // Cobrança que pertence a um título do sistema: o título é quem manda.
    const [titulo] = o.titulo && d.id ? await this.db.select().from(titulos).where(eq(titulos.cobrancaExternaId, d.id)) : [];
    if (titulo && o.titulo === 'bloqueia') throw new BadRequestException(`Esta cobrança é do título "${titulo.descricao}" do sistema. Para mudar valor ou vencimento, emita a 2ª via em Cobrança; para registrar o recebimento, dê baixa no título em Lançamentos.`);
    if (titulo && o.titulo === 'estorna') {
      if (titulo.status !== 'pago') throw new BadRequestException(`O título "${titulo.descricao}" não está pago no sistema.`);
      const pedido = corpo?.value as number | undefined;
      if (pedido !== undefined && Math.round(pedido * 100) < (titulo.valorPago ?? titulo.valor)) throw new BadRequestException('Esta cobrança é de um título do sistema: aqui só o estorno total (deixe o valor em branco). Estorno parcial precisa ser feito no painel do Asaas e ajustado à mão no título.');
    }

    const resposta = await this.asaas.chamar<Valores>(o.metodo, caminho + (consulta.size ? `?${consulta}` : ''), o.metodo === 'GET' || o.metodo === 'DELETE' ? undefined : (corpo ?? {}));

    if (titulo && o.titulo === 'solta') await this.db.update(titulos).set({ cobrancaExternaId: null, cobrancaUrl: null, pixCopiaCola: null, cobrancaTipo: null, cobrancaValor: null, cobrancaVencimento: null }).where(eq(titulos.id, titulo.id));
    if (titulo && o.titulo === 'estorna')
      await this.db.update(titulos).set({ status: 'aberto', pagoEm: null, valorPago: null, contaId: null, formaPagamento: null, cobrancaExternaId: null, cobrancaUrl: null, pixCopiaCola: null, cobrancaTipo: null, cobrancaValor: null, cobrancaVencimento: null }).where(eq(titulos.id, titulo.id));
    if (o.metodo !== 'GET' && o.nivel !== 'ver') {
      const { authToken: _t, ...semToken } = (corpo ?? {}) as Valores;
      await this.auditoria.registrar({ usuarioId: u.id, acao: 'asaas', entidade: 'asaas', entidadeId: titulo?.id ?? null, dados: { operacao: o.chave, nome: o.nome, codigo: d.id ?? (resposta.id as string | undefined) ?? null, dados: semToken, titulo: titulo ? { id: titulo.id, efeito: o.titulo } : undefined } });
    }

    // Na lista de cobranças, mostra a qual título do sistema cada uma pertence.
    if ((o.chave === 'cobrancas' || o.chave.endsWith('.cobrancas') || o.chave === 'parcelamentos.parcelas') && Array.isArray(resposta.data) && resposta.data.length) {
      const ids = (resposta.data as { id?: string }[]).map((p) => String(p.id ?? '')).filter(Boolean);
      const meus = await this.db.select({ id: titulos.id, externo: titulos.cobrancaExternaId, descricao: titulos.descricao, pessoaId: titulos.pessoaId }).from(titulos).where(inArray(titulos.cobrancaExternaId, ids));
      const mapa = new Map(meus.map((t) => [t.externo, t]));
      resposta.data = (resposta.data as { id?: string }[]).map((p) => ({ ...p, _titulo: mapa.get(String(p.id)) ?? null }));
    }
    return { ...resposta, _efeito: titulo && o.titulo === 'estorna' ? `A baixa do título "${titulo.descricao}" foi desfeita: ele voltou para "em aberto", sem boleto.` : titulo && o.titulo === 'solta' ? `O título "${titulo.descricao}" continua em aberto, agora sem boleto.` : undefined };
  }
}
