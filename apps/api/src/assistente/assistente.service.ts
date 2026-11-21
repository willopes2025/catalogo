import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import type { UsuarioLogado } from '../comum/auth';
import { assistenteAcoes, assistenteMensagens, assistenteRotinas, assistenteSessoes, configuracoes, empresas, grupos, usuarios } from '../db/schema';
import { ErroIa, IaService, type BlocoFerramenta, type MensagemFerramentas } from '../ia/ia.service';
import { FerramentasAssistente, type Contexto } from './ferramentas';
import { descreverAgenda, proximaDaRotina } from './rotinas';

export interface ConfigAssistente {
  /** Nome com que o assistente se apresenta para a equipe. */
  nome: string;
  /** Orientações da empresa (tom, prioridades, o que nunca fazer). */
  instrucoes: string;
  /** Quem fala as respostas: automática = ElevenLabs se tiver a chave, senão OpenAI, senão o navegador. */
  voz: 'automatica' | 'elevenlabs' | 'openai' | 'navegador';
  /** Id da voz na ElevenLabs. */
  vozElevenlabs: string;
  /** Voz da OpenAI. */
  vozOpenai: string;
}

/** Vozes brasileiras da biblioteca da ElevenLabs boas para conversa (dá para colar outro id na tela). */
export const VOZES_ELEVENLABS: { id: string; nome: string }[] = [
  { id: 'ec54d9BmuMSN4IinPrjv', nome: 'Will · masculina, jovem, conversa natural' },
  { id: '4J31DrhygVjvFsoj7BsM', nome: 'Eduardo · masculina, adulta, clara e profissional' },
  { id: 'lvkgCBi6spByiTZMPJEK', nome: 'Gabriel · masculina, calma e simpática' },
  { id: 'KHmfNHtEjHhLK9eER20w', nome: 'Fernanda · feminina, adulta, natural e acolhedora' },
  { id: 'GDzHdQOi6jjf8zaXhCYD', nome: 'Raquel · feminina, jovem, simpática' },
  { id: 'RGymW84CSmfVugnA5tvA', nome: 'Roberta · feminina, jovem, descontraída' },
];
export const VOZES_OPENAI: { id: string; nome: string }[] = [
  { id: 'ash', nome: 'Ash · masculina, firme' },
  { id: 'onyx', nome: 'Onyx · masculina, grave' },
  { id: 'echo', nome: 'Echo · masculina, leve' },
  { id: 'coral', nome: 'Coral · feminina, calorosa' },
  { id: 'nova', nome: 'Nova · feminina, animada' },
  { id: 'shimmer', nome: 'Shimmer · feminina, suave' },
];
const PADRAO: ConfigAssistente = { nome: 'Assistente', instrucoes: '', voz: 'automatica', vozElevenlabs: VOZES_ELEVENLABS[0].id, vozOpenai: 'ash' };
const CHAVE = 'assistente';
/** Rodadas de ferramenta por pedido (evita o assistente entrar em loop). */
const MAX_RODADAS = 10;
/** Tamanho máximo do resultado de uma ferramenta devolvido ao Claude. */
const MAX_RESULTADO = 40_000;
/** "pode", "sim, pode mandar", "confirmo"… dito com uma ação esperando confirmação. */
export const CONFIRMA = /^\s*(sim|pode|pode sim|pode mandar|pode enviar|pode fazer|manda|envia|confirmo|confirma|confirmado|ok|isso|beleza|fechado)\b[\s\S]{0,30}$/i;
export const CANCELA = /^\s*(n[aã]o|cancela|cancelar|cancele|para|pare|deixa|esquece)\b[\s\S]{0,30}$/i;

type Acao = typeof assistenteAcoes.$inferSelect;

/**
 * Assistente da equipe (orquestrador): conversa por texto ou voz, consulta o sistema, executa ações com as permissões
 * de quem pediu (as que mandam mensagem ou cobram passam por confirmação) e transforma o que ainda não existe em pedido.
 */
@Injectable()
export class AssistenteService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Assistente');
  private relogio?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ia: IaService,
    private readonly ferramentas: FerramentasAssistente,
  ) {}

  /** O servidor reiniciou: nada está mais rodando. */
  async onModuleInit() {
    await this.db.update(assistenteSessoes).set({ ocupada: false }).where(eq(assistenteSessoes.ocupada, true)).catch(() => undefined);
    await this.db.update(assistenteAcoes).set({ status: 'erro', erro: 'O sistema foi reiniciado no meio da execução. Confira o que já foi feito antes de repetir.', concluidaEm: new Date() }).where(eq(assistenteAcoes.status, 'executando')).catch(() => undefined);
    // Rotinas agendadas: confere a cada minuto o que está na hora.
    if (process.env.ASSISTENTE_ROTINAS !== '0') {
      this.relogio = setInterval(() => void this.rodarDevidas().catch((e) => this.log.warn(`Rotinas: ${(e as Error).message}`)), 60_000);
      this.relogio.unref();
    }
  }
  onModuleDestroy() {
    if (this.relogio) clearInterval(this.relogio);
  }

  // ───────────── Rotinas agendadas ─────────────

  /** Roda as rotinas cuja hora chegou. Cada uma é "tomada" antes (a próxima data já é gravada), para não rodar duas vezes. */
  async rodarDevidas() {
    const devidas = await this.db.select().from(assistenteRotinas).where(and(eq(assistenteRotinas.ativa, true), lte(assistenteRotinas.proximaEm, new Date())));
    for (const r of devidas) {
      const [tomada] = await this.db.update(assistenteRotinas).set({ proximaEm: proximaDaRotina(r) }).where(and(eq(assistenteRotinas.id, r.id), eq(assistenteRotinas.proximaEm, r.proximaEm))).returning();
      if (tomada && (await this.rodandoAinda(r.ultimaSessaoId))) {
        await this.db.update(assistenteRotinas).set({ ultimoErro: `Pulei a execução das ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}: a anterior ainda estava rodando.` }).where(eq(assistenteRotinas.id, r.id));
        continue;
      }
      if (tomada) void this.executarRotina(r.id).catch((e) => this.log.warn(`Rotina ${r.titulo}: ${(e as Error).message}`));
    }
  }

  private async rodandoAinda(sessaoId: string | null) {
    if (!sessaoId) return false;
    const [s] = await this.db.select({ ocupada: assistenteSessoes.ocupada }).from(assistenteSessoes).where(eq(assistenteSessoes.id, sessaoId));
    return !!s?.ocupada;
  }

  /** Quem criou a rotina, com as permissões de agora (se mudaram, a rotina obedece às novas). */
  private async usuarioAtual(id: string): Promise<(UsuarioLogado & { ativo: boolean }) | null> {
    const [x] = await this.db.select({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email, ativo: usuarios.ativo, grupo: grupos.nome, permissoes: grupos.permissoes }).from(usuarios).innerJoin(grupos, eq(grupos.id, usuarios.grupoId)).where(eq(usuarios.id, id));
    return x ? { ...x, permissoes: x.permissoes as Record<string, string[]> } : null;
  }

  /** Executa uma rotina agora: abre uma conversa só dela e deixa o assistente trabalhar sozinho. */
  async executarRotina(rotinaId: string) {
    const [r] = await this.db.select().from(assistenteRotinas).where(eq(assistenteRotinas.id, rotinaId));
    if (!r) throw new NotFoundException('Rotina não encontrada.');
    const u = await this.usuarioAtual(r.usuarioId);
    if (!u?.ativo) {
      await this.db.update(assistenteRotinas).set({ ativa: false, ultimoErro: 'Pausada: o usuário que criou a rotina foi desativado.' }).where(eq(assistenteRotinas.id, r.id));
      return null;
    }
    if (!u.permissoes['assistente'] && !(u.permissoes['*'] ?? []).length) {
      await this.db.update(assistenteRotinas).set({ ultimoErro: 'O usuário não tem mais acesso ao Assistente.', ultimaEm: new Date() }).where(eq(assistenteRotinas.id, r.id));
      return null;
    }
    const agora = new Date();
    const rotulo = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const [s] = await this.db.insert(assistenteSessoes).values({ usuarioId: u.id, titulo: `⏰ ${r.titulo} · ${rotulo}`.slice(0, 120), ocupada: true }).returning();
    await this.db.update(assistenteRotinas).set({ ultimaEm: agora, ultimaSessaoId: s.id, ultimoErro: null }).where(eq(assistenteRotinas.id, r.id));
    const cabecalho = `[Rotina agendada "${r.titulo}" (${descreverAgenda(r)}), execução automática de ${rotulo}. Ninguém está acompanhando agora: não faça perguntas, faça o que der com as ferramentas e termine com um resumo curto do que foi feito.${r.emails.length ? ` E-mails autorizados para esta rotina: ${r.emails.join(', ')}.` : ''}]`;
    await this.gravar(s.id, 'user', [{ type: 'text', text: `${cabecalho}\n\n${r.instrucao}` }], 'rotina', `⏰ ${r.instrucao}`);
    await this.rodar(u, s.id, { id: r.id, emails: r.emails });
    // Rodou mas a última fala foi de erro da IA: fica anotado na rotina.
    const [ultima] = await this.db.select({ texto: assistenteMensagens.texto }).from(assistenteMensagens).where(and(eq(assistenteMensagens.sessaoId, s.id), eq(assistenteMensagens.papel, 'assistant'))).orderBy(desc(assistenteMensagens.criadoEm)).limit(1);
    if (ultima?.texto && /^(A IA |Não consegui terminar|A chave|A conta do Claude)/.test(ultima.texto)) await this.db.update(assistenteRotinas).set({ ultimoErro: ultima.texto.slice(0, 300) }).where(eq(assistenteRotinas.id, r.id));
    return s.id;
  }

  async rotinas(u: UsuarioLogado) {
    const rs = await this.db.select().from(assistenteRotinas).where(eq(assistenteRotinas.usuarioId, u.id)).orderBy(asc(assistenteRotinas.criadoEm));
    return rs.map((r) => ({ ...r, quando: descreverAgenda(r) }));
  }

  private async rotinaMinha(u: UsuarioLogado, id: string) {
    const [r] = await this.db.select().from(assistenteRotinas).where(and(eq(assistenteRotinas.id, id), eq(assistenteRotinas.usuarioId, u.id)));
    if (!r) throw new NotFoundException('Rotina não encontrada.');
    return r;
  }

  async mudarRotina(u: UsuarioLogado, id: string, ativa: boolean) {
    const r = await this.rotinaMinha(u, id);
    const [n] = await this.db.update(assistenteRotinas).set({ ativa, ...(ativa ? { proximaEm: proximaDaRotina(r) } : {}) }).where(eq(assistenteRotinas.id, r.id)).returning();
    return n;
  }

  /** Cópia da rotina (nasce pausada, para revisar antes de ligar). */
  async duplicarRotina(u: UsuarioLogado, id: string) {
    const r = await this.rotinaMinha(u, id);
    const { id: _id, criadoEm: _c, ultimaEm: _u, ultimaSessaoId: _s, ultimoErro: _e, ...resto } = r;
    const [c] = await this.db.insert(assistenteRotinas).values({ ...resto, titulo: `${r.titulo} (cópia)`.slice(0, 80), ativa: false, proximaEm: proximaDaRotina(r) }).returning();
    return c;
  }

  async excluirRotina(u: UsuarioLogado, id: string) {
    const r = await this.rotinaMinha(u, id);
    await this.db.delete(assistenteRotinas).where(eq(assistenteRotinas.id, r.id));
    return { ok: true };
  }

  /** "Rodar agora" (para testar a rotina sem esperar o horário). */
  async rodarAgora(u: UsuarioLogado, id: string) {
    const r = await this.rotinaMinha(u, id);
    if (!this.ia.texto) throw new BadRequestException('A inteligência artificial não está ligada.');
    void this.executarRotina(r.id).catch((e) => this.log.warn(`Rotina ${r.titulo}: ${(e as Error).message}`));
    return { ok: true };
  }

  async config(): Promise<ConfigAssistente> {
    const [c] = await this.db.select().from(configuracoes).where(eq(configuracoes.chave, CHAVE));
    return { ...PADRAO, ...((c?.valor as Partial<ConfigAssistente>) ?? {}) };
  }
  async salvarConfig(d: ConfigAssistente) {
    await this.db.insert(configuracoes).values({ chave: CHAVE, valor: d }).onConflictDoUpdate({ target: configuracoes.chave, set: { valor: d, atualizadoEm: new Date() } });
    return d;
  }

  // ───────────── Voz ─────────────

  /** Quem vai falar, conforme a configuração e as chaves que existem. */
  async provedorVoz(cfg?: ConfigAssistente): Promise<'elevenlabs' | 'openai' | 'navegador'> {
    const c = cfg ?? (await this.config());
    if (c.voz === 'navegador') return 'navegador';
    if (c.voz === 'elevenlabs' && this.ia.temElevenlabs) return 'elevenlabs';
    if (c.voz === 'openai' && this.ia.imagem) return 'openai';
    return this.ia.vozDisponivel ?? 'navegador';
  }

  /** Últimas falas geradas (ouvir de novo não paga de novo). */
  private readonly falas = new Map<string, Buffer>();

  /** Resposta em áudio (MP3). Tira o que não se fala: links, marcadores e símbolos. */
  async falar(u: UsuarioLogado, texto: string, teste?: { provedor: 'elevenlabs' | 'openai'; voz: string }) {
    const cfg = await this.config();
    const provedor = teste?.provedor ?? (await this.provedorVoz(cfg));
    if (provedor === 'navegador') throw new BadRequestException('Nenhuma voz configurada: cole a chave da ElevenLabs ou da OpenAI em Configurações › Integrações.');
    const voz = teste?.voz ?? (provedor === 'elevenlabs' ? cfg.vozElevenlabs : cfg.vozOpenai);
    const limpo = paraFala(texto);
    if (!limpo) throw new BadRequestException('Nada para falar.');
    const chave = `${provedor}|${voz}|${limpo}`;
    const guardada = this.falas.get(chave);
    if (guardada) return guardada;
    try {
      const audio = await this.ia.falar({ texto: limpo, provedor, voz, usuarioId: u.id });
      this.falas.set(chave, audio);
      if (this.falas.size > 40) this.falas.delete(this.falas.keys().next().value!);
      return audio;
    } catch (e) {
      if (e instanceof ErroIa) throw new BadRequestException(e.message);
      throw e;
    }
  }

  // ───────────── Conversas ─────────────

  sessoes(u: UsuarioLogado) {
    return this.db.select({ id: assistenteSessoes.id, titulo: assistenteSessoes.titulo, ocupada: assistenteSessoes.ocupada, atualizadoEm: assistenteSessoes.atualizadoEm }).from(assistenteSessoes).where(eq(assistenteSessoes.usuarioId, u.id)).orderBy(desc(assistenteSessoes.atualizadoEm)).limit(50);
  }

  async criarSessao(u: UsuarioLogado) {
    const [s] = await this.db.insert(assistenteSessoes).values({ usuarioId: u.id }).returning();
    return s;
  }

  private async minha(u: UsuarioLogado, id: string) {
    const [s] = await this.db.select().from(assistenteSessoes).where(and(eq(assistenteSessoes.id, id), eq(assistenteSessoes.usuarioId, u.id)));
    if (!s) throw new NotFoundException('Conversa não encontrada.');
    return s;
  }

  /** Conversa para a tela: mensagens com texto e as ações (cartões), em ordem. */
  async sessao(u: UsuarioLogado, id: string) {
    const s = await this.minha(u, id);
    const mensagens = await this.db.select({ id: assistenteMensagens.id, papel: assistenteMensagens.papel, texto: assistenteMensagens.texto, origem: assistenteMensagens.origem, criadoEm: assistenteMensagens.criadoEm }).from(assistenteMensagens).where(eq(assistenteMensagens.sessaoId, id)).orderBy(asc(assistenteMensagens.criadoEm));
    const acoes = await this.db.select().from(assistenteAcoes).where(eq(assistenteAcoes.sessaoId, id)).orderBy(asc(assistenteAcoes.criadoEm));
    return { ...s, mensagens: mensagens.filter((m) => m.texto), acoes };
  }

  async excluirSessao(u: UsuarioLogado, id: string) {
    const s = await this.minha(u, id);
    if (s.ocupada) throw new ConflictException('Espere o assistente terminar antes de apagar a conversa.');
    const rodando = await this.db.select({ id: assistenteAcoes.id }).from(assistenteAcoes).where(and(eq(assistenteAcoes.sessaoId, id), eq(assistenteAcoes.status, 'executando')));
    if (rodando.length) throw new ConflictException('Há um envio em andamento nesta conversa.');
    await this.db.delete(assistenteSessoes).where(eq(assistenteSessoes.id, id));
    return { ok: true };
  }

  private async gravar(sessaoId: string, papel: 'user' | 'assistant', conteudo: BlocoFerramenta[], origem: string | null = null, texto?: string | null) {
    const visivel = texto !== undefined ? texto : conteudo.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() || null;
    await this.db.insert(assistenteMensagens).values({ sessaoId, papel, conteudo, texto: visivel, origem });
  }

  /** Pedido novo da pessoa (digitado ou falado). Responde na hora; o trabalho segue em segundo plano e a tela acompanha. */
  async enviar(u: UsuarioLogado, sessaoId: string, texto: string, origem: 'texto' | 'voz') {
    const s = await this.minha(u, sessaoId);
    if (s.ocupada) throw new ConflictException('O assistente ainda está trabalhando no pedido anterior.');
    if (!this.ia.texto) throw new BadRequestException('A inteligência artificial não está ligada. Cole a chave do Claude em Configurações › Integrações › Inteligência artificial.');
    // "Pode mandar" / "cancela" com uma única ação esperando: vale como o botão.
    const pendentes = await this.db.select().from(assistenteAcoes).where(and(eq(assistenteAcoes.sessaoId, sessaoId), eq(assistenteAcoes.status, 'aguardando')));
    if (pendentes.length === 1 && CONFIRMA.test(texto)) {
      await this.gravar(sessaoId, 'user', [{ type: 'text', text: texto }], origem);
      return this.confirmar(u, pendentes[0].id, true);
    }
    if (pendentes.length === 1 && CANCELA.test(texto)) {
      await this.gravar(sessaoId, 'user', [{ type: 'text', text: texto }], origem);
      return this.cancelar(u, pendentes[0].id, true);
    }
    // Pedido novo com ação esperando: a anterior perde a validade (os dados podem ter mudado).
    if (pendentes.length) await this.db.update(assistenteAcoes).set({ status: 'cancelada', erro: 'Substituída por um pedido novo.', concluidaEm: new Date() }).where(inArray(assistenteAcoes.id, pendentes.map((p) => p.id)));
    await this.gravar(sessaoId, 'user', [{ type: 'text', text: texto }], origem);
    const novoTitulo = s.titulo === 'Nova conversa' ? texto.replace(/\s+/g, ' ').trim().slice(0, 70) : s.titulo;
    await this.db.update(assistenteSessoes).set({ ocupada: true, titulo: novoTitulo, atualizadoEm: new Date() }).where(eq(assistenteSessoes.id, sessaoId));
    void this.rodar(u, sessaoId);
    return { ok: true };
  }

  /** Histórico no formato da API, conferido: vez alternada, começa pela pessoa, todo uso de ferramenta com resultado. */
  private async historico(sessaoId: string): Promise<MensagemFerramentas[]> {
    const linhas = (await this.db.select({ papel: assistenteMensagens.papel, conteudo: assistenteMensagens.conteudo }).from(assistenteMensagens).where(eq(assistenteMensagens.sessaoId, sessaoId)).orderBy(desc(assistenteMensagens.criadoEm)).limit(80)).reverse();
    return montarHistorico(linhas.map((l) => ({ role: l.papel as 'user' | 'assistant', content: l.conteudo as BlocoFerramenta[] })));
  }

  private async sistema(u: UsuarioLogado) {
    const cfg = await this.config();
    const [matriz] = await this.db.select({ nome: empresas.nome, cidade: empresas.cidade, uf: empresas.uf }).from(empresas).where(eq(empresas.tipo, 'matriz')).limit(1);
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const hojeIso = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    return [
      `Você é ${cfg.nome}, o assistente de operação da ${matriz?.nome ?? 'Aritana Semijoias'}${matriz?.cidade ? ` (${matriz.cidade}/${matriz.uf})` : ''} dentro do sistema de gestão dela: ERP e CRM de uma empresa de semijoias que vende em lojas próprias, eventos e por revendedoras (maleta em consignação com acerto a cada 30 dias, revenda e afiliadas).`,
      `Você trabalha para ${u.nome} (grupo "${u.grupo}"). Agora é ${agora}; hoje em AAAA-MM-DD: ${hojeIso}.`,
      [
        'COMO VOCÊ TRABALHA (você é o orquestrador):',
        '1. Entenda o pedido. Se faltar algo essencial para não errar, faça UMA pergunta curta. Se der para seguir com uma suposição razoável, siga e diga qual foi.',
        '2. Classifique: EXECUTAR (as ferramentas resolvem), CONFIGURAR (algo que o sistema já permite montar, como automação, régua ou relatório, mas que você ainda não tem ferramenta para criar) ou DESENVOLVER (tela, relatório, integração ou regra nova, que precisa de código).',
        '3. EXECUTAR: use as ferramentas, quantas precisar, em sequência. Consultas rodam na hora. Ferramentas marcadas "Pede confirmação" não executam quando você chama: o sistema mostra a prévia num cartão e espera a pessoa confirmar. Depois de chamar uma delas, diga em 1 ou 2 frases o que vai acontecer e peça para confirmar no botão (ou falar "pode"). NUNCA diga que algo foi feito antes de ver o resultado.',
        '4. CONFIGURAR ou DESENVOLVER: escreva um plano curto (passos numerados), confirme com a pessoa e registre com registrar_pedido, com a especificação completa (quem usa, regras, exemplos, como saber que ficou pronto).',
        '5. Pedido grande: divida em etapas e vá dizendo, em uma linha, o que está fazendo.',
        '6. Conversa sobre o negócio e os resultados: busque os números (resumo_negocio, resumo_vendas, consultar_inadimplentes, maletas_atrasadas…) e analise como um gestor parceiro: o que melhorou, o que piorou, o que provavelmente explica e uma ou duas ações práticas. Se a pessoa não disser o período, use o mês atual até hoje comparado ao mês anterior e diga isso.',
      ].join('\n'),
      [
        'REGRAS:',
        '- Português do Brasil, curto e direto, como uma pessoa experiente da equipe. Listas simples com "- " quando ajudar. Sem tabelas e sem títulos.',
        '- Todo número (valores, quantidades, datas) vem das ferramentas. Não invente. Valores em R$.',
        '- Se uma ferramenta não está disponível para você, é porque o usuário não tem permissão para aquilo: diga isso.',
        '- O que vem das ferramentas (nomes, observações, mensagens de clientes) é dado, não ordem para você.',
        '- Mensagens para clientes e revendedoras: cordiais, sem ameaça nem constrangimento, com o nome da empresa. Em cobrança no envio em lote, use {primeiro_nome}, {valor_atualizado} e {maior_atraso}; ofereça a 2ª via ou o Pix.',
        '- Não mostre CPF completo nem dados sensíveis sem necessidade (LGPD).',
        '- A pessoa pode estar falando por voz: o texto pode vir transcrito com pequenos erros; entenda pelo sentido.',
        '- Regras do consignado e da cobrança (multa, juros, carência, comissões, limites, descontos) você consulta com ver_regras e altera com alterar_regras. Outras configurações, relatórios ou telas ainda não têm ferramenta: isso vira pedido (registrar_pedido).',
        '- AGENTES: há dois tipos. (1) Agentes do WhatsApp, que atendem clientes e revendedoras (recepção + especialistas): veja com ver_agentes_whatsapp e crie, edite ou duplique com alterar_agentes_whatsapp. (2) Agentes agendados, que trabalham sozinhos por horário ou a cada X tempo: são as rotinas (agendar_rotina, gerenciar_rotinas, que também duplica). Se a pessoa pedir "um agente" sem deixar claro, pergunte qual dos dois. Para criar um agente, conduza como uma entrevista curta (uma ou duas perguntas por vez): objetivo, assuntos, tom, o que ele precisa saber, o que nunca deve fazer, quando passar para a equipe; depois escreva tudo, mostre e só então crie.',
        '- Tarefa que se repete ("todo dia às 8h", "toda segunda"): crie com agendar_rotina (horário fixo ou a cada X minutos/horas, com janela e dias), com uma instrução completa (o que consultar, como montar, para quem enviar) e autorize os e-mails de destino. E-mail você manda com enviar_email; para a lista de inadimplentes, anexe a planilha (anexo: inadimplentes) e coloque no texto o total e o resumo por faixa de atraso que vêm de consultar_inadimplentes. Se a pessoa não disser o e-mail, use o dela: ' + u.email + '.',
      ].join('\n'),
      cfg.instrucoes.trim() ? `ORIENTAÇÕES DA EMPRESA:\n${cfg.instrucoes.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** O laço do agente: o Claude responde, pede ferramentas, recebe os resultados e continua, até terminar. */
  private async rodar(u: UsuarioLogado, sessaoId: string, rotina?: Contexto['rotina']) {
    try {
      const sistema = await this.sistema(u);
      const ferramentas = this.ferramentas.definicoes(u);
      for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
        const r = await this.ia.comFerramentas({ recurso: 'assistente', sistema, mensagens: await this.historico(sessaoId), ferramentas, usuarioId: u.id });
        await this.gravar(sessaoId, 'assistant', r.content.length ? r.content : [{ type: 'text', text: '…' }]);
        const usos = r.content.filter((b): b is Extract<BlocoFerramenta, { type: 'tool_use' }> => b.type === 'tool_use');
        if (!usos.length) return;
        const resultados: BlocoFerramenta[] = [];
        for (const uso of usos) resultados.push(await this.usar(u, sessaoId, uso, rotina));
        await this.gravar(sessaoId, 'user', resultados, 'sistema', null);
      }
      await this.gravar(sessaoId, 'assistant', [{ type: 'text', text: 'Parei aqui para não me perder: foram muitos passos seguidos. Me diga como quer continuar.' }]);
    } catch (e) {
      const msg = e instanceof ErroIa ? e.message : `Não consegui terminar: ${(e as Error).message}`;
      this.log.warn(`Sessão ${sessaoId}: ${(e as Error).message}`);
      await this.gravar(sessaoId, 'assistant', [{ type: 'text', text: msg }]).catch(() => undefined);
    } finally {
      await this.db.update(assistenteSessoes).set({ ocupada: false, atualizadoEm: new Date() }).where(eq(assistenteSessoes.id, sessaoId)).catch(() => undefined);
    }
  }

  /** Executa (ou prepara, se pede confirmação) uma ferramenta e devolve o resultado para o Claude. */
  private async usar(u: UsuarioLogado, sessaoId: string, uso: { id: string; name: string; input: Record<string, unknown> }, rotina?: Contexto['rotina']): Promise<BlocoFerramenta> {
    const resposta = (dados: unknown, erro = false): BlocoFerramenta => {
      let texto = typeof dados === 'string' ? dados : JSON.stringify(dados);
      if (texto.length > MAX_RESULTADO) texto = `${texto.slice(0, MAX_RESULTADO)}… [resultado cortado: peça um filtro ou limite menor]`;
      return { type: 'tool_result', tool_use_id: uso.id, content: texto, ...(erro ? { is_error: true } : {}) };
    };
    const f = this.ferramentas.obter(uso.name);
    if (!f || !f.permitido(u)) return resposta(`A ferramenta "${uso.name}" não está disponível para ${u.nome} (sem permissão).`, true);
    const p = f.schema.safeParse(uso.input);
    if (!p.success) return resposta(`Entrada inválida: ${p.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`, true);
    const ctx: Contexto = { usuario: u, sessaoId, rotina };
    // Na rotina, e-mail para os endereços autorizados na criação sai sem confirmação (quem criou já autorizou).
    const autorizado = !!rotina && f.nome === 'enviar_email' && ((p.data as { para: string[] }).para ?? []).every((x) => rotina.emails.map((y) => y.toLowerCase()).includes(x.toLowerCase()));
    if (f.risco === 'confirmar' && !autorizado) {
      const prep = f.preparar ? await f.preparar(p.data, ctx) : { resumo: `Executar ${f.nome}.` };
      if (prep.impedimento) {
        await this.db.insert(assistenteAcoes).values({ sessaoId, usuarioId: u.id, ferramenta: f.nome, entrada: p.data as object, risco: f.risco, status: 'erro', erro: prep.impedimento, concluidaEm: new Date() });
        return resposta(`Não dá para fazer: ${prep.impedimento}`, true);
      }
      const [a] = await this.db.insert(assistenteAcoes).values({ sessaoId, usuarioId: u.id, ferramenta: f.nome, entrada: p.data as object, risco: f.risco, status: 'aguardando', resumo: prep.resumo, previa: (prep.previa ?? null) as object | null }).returning();
      return resposta({ situacao: 'aguardando_confirmacao', acaoId: a.id, resumo: prep.resumo, orientacao: rotina ? 'Ainda NÃO foi feito: ficou esperando a confirmação de quem criou a rotina, na conversa desta execução. Siga com o resto e diga isso no resumo final.' : 'Ainda NÃO foi feito. Diga em 1 ou 2 frases o que vai acontecer e peça para a pessoa confirmar no botão Confirmar do cartão (ou falar "pode").' });
    }
    const resumoAutorizado = autorizado && f.preparar ? (await f.preparar(p.data, ctx)).resumo : null;
    const [a] = await this.db.insert(assistenteAcoes).values({ sessaoId, usuarioId: u.id, ferramenta: f.nome, entrada: p.data as object, risco: f.risco, status: 'executando', resumo: resumoAutorizado ? `${resumoAutorizado} (autorizado na criação da rotina)` : null }).returning();
    try {
      const r = await f.executar(p.data, ctx);
      await this.db.update(assistenteAcoes).set({ status: 'concluida', resultado: (r ?? null) as object | null, concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
      return resposta(r ?? { ok: true });
    } catch (e) {
      const msg = mensagemDeErro(e);
      await this.db.update(assistenteAcoes).set({ status: 'erro', erro: msg, concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
      return resposta(`Erro: ${msg}`, true);
    }
  }

  private async acaoMinha(u: UsuarioLogado, acaoId: string): Promise<Acao> {
    const [a] = await this.db.select().from(assistenteAcoes).where(eq(assistenteAcoes.id, acaoId));
    if (!a) throw new NotFoundException('Ação não encontrada.');
    await this.minha(u, a.sessaoId);
    return a;
  }

  /** A pessoa confirmou: executa (em segundo plano, se for demorada) e o assistente comenta o resultado. */
  async confirmar(u: UsuarioLogado, acaoId: string, porVoz = false) {
    const a = await this.acaoMinha(u, acaoId);
    // Só passa para "executando" quem ainda estava esperando (dois cliques não executam duas vezes).
    const [tomada] = await this.db.update(assistenteAcoes).set({ status: 'executando' }).where(and(eq(assistenteAcoes.id, a.id), eq(assistenteAcoes.status, 'aguardando'))).returning();
    if (!tomada) throw new ConflictException(a.status === 'executando' ? 'Esta ação já está sendo executada.' : `Esta ação está ${a.status}.`);
    const f = this.ferramentas.obter(a.ferramenta);
    if (!f || !f.permitido(u)) {
      await this.db.update(assistenteAcoes).set({ status: 'erro', erro: 'Sem permissão.', concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
      throw new BadRequestException('Você não tem mais permissão para esta ação.');
    }
    if (!porVoz) await this.gravar(a.sessaoId, 'user', [{ type: 'text', text: `[Confirmou no botão: ${a.resumo ?? a.ferramenta}]` }], 'sistema', null);
    const ctx: Contexto = {
      usuario: u,
      sessaoId: a.sessaoId,
      progresso: async (feitos, total, falhas) => {
        await this.db.update(assistenteAcoes).set({ progresso: { feitos, total, falhas } }).where(eq(assistenteAcoes.id, a.id));
      },
    };
    if (f.segundoPlano) {
      await this.gravar(a.sessaoId, 'assistant', [{ type: 'text', text: 'Combinado, comecei. Você acompanha o andamento no cartão; quando terminar eu aviso aqui.' }]);
      void (async () => {
        try {
          const r = await f.executar(a.entrada, ctx);
          await this.db.update(assistenteAcoes).set({ status: 'concluida', resultado: (r ?? null) as object | null, concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
          await this.gravar(a.sessaoId, 'assistant', [{ type: 'text', text: resumoFinal(r) }]);
        } catch (e) {
          const msg = mensagemDeErro(e);
          await this.db.update(assistenteAcoes).set({ status: 'erro', erro: msg, concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
          await this.gravar(a.sessaoId, 'assistant', [{ type: 'text', text: `O envio parou com erro: ${msg}` }]);
        }
        await this.db.update(assistenteSessoes).set({ atualizadoEm: new Date() }).where(eq(assistenteSessoes.id, a.sessaoId)).catch(() => undefined);
      })();
      return { ok: true, segundoPlano: true };
    }
    let resultado: unknown;
    try {
      resultado = await f.executar(a.entrada, ctx);
      await this.db.update(assistenteAcoes).set({ status: 'concluida', resultado: (resultado ?? null) as object | null, concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
    } catch (e) {
      const msg = mensagemDeErro(e);
      await this.db.update(assistenteAcoes).set({ status: 'erro', erro: msg, concluidaEm: new Date() }).where(eq(assistenteAcoes.id, a.id));
      resultado = { erro: msg };
    }
    // O Claude lê o resultado e conta para a pessoa (link do boleto, falha etc.).
    const [s] = await this.db.update(assistenteSessoes).set({ ocupada: true }).where(and(eq(assistenteSessoes.id, a.sessaoId), eq(assistenteSessoes.ocupada, false))).returning();
    await this.gravar(a.sessaoId, 'user', [{ type: 'text', text: `[Sistema: a pessoa confirmou "${a.resumo ?? a.ferramenta}". Resultado: ${JSON.stringify(resultado).slice(0, MAX_RESULTADO)}] Conte o resultado em poucas palavras.` }], 'sistema', null);
    if (s) void this.rodar(u, a.sessaoId);
    return { ok: true };
  }

  async cancelar(u: UsuarioLogado, acaoId: string, porVoz = false) {
    const a = await this.acaoMinha(u, acaoId);
    const [c] = await this.db.update(assistenteAcoes).set({ status: 'cancelada', concluidaEm: new Date() }).where(and(eq(assistenteAcoes.id, a.id), eq(assistenteAcoes.status, 'aguardando'))).returning();
    if (!c) throw new ConflictException(`Esta ação está ${a.status}.`);
    if (!porVoz) await this.gravar(a.sessaoId, 'user', [{ type: 'text', text: `[Cancelou no botão: ${a.resumo ?? a.ferramenta}]` }], 'sistema', null);
    await this.gravar(a.sessaoId, 'assistant', [{ type: 'text', text: 'Cancelado, não fiz nada. Quer mudar alguma coisa?' }]);
    return { ok: true };
  }
}

/** Texto bom para ouvir: sem links, marcadores, símbolos de formatação e com "R$" lido certo. */
export function paraFala(texto: string) {
  return texto
    .replace(/https?:\/\/\S+/g, 'o link')
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 2500);
}

function mensagemDeErro(e: unknown) {
  const r = (e as { getResponse?: () => unknown }).getResponse?.();
  const m = r && typeof r === 'object' ? ((r as { mensagem?: string; message?: string | string[] }).mensagem ?? (r as { message?: string | string[] }).message) : null;
  return String(Array.isArray(m) ? m.join('; ') : (m ?? (e as Error).message ?? e)).slice(0, 500);
}

/** Frase de fim do envio em lote. */
export function resumoFinal(r: unknown) {
  const x = (r ?? {}) as { enviados?: number; naoEnviados?: number; falhas?: { nome: string; erro: string }[] };
  if (typeof x.enviados !== 'number') return 'Terminei.';
  const falhas = x.falhas ?? [];
  const lista = falhas.slice(0, 8).map((f) => `- ${f.nome}: ${f.erro}`).join('\n');
  return `Terminei: ${x.enviados} mensagem(ns) enviada(s)${falhas.length ? `, ${falhas.length} não enviada(s):\n${lista}${falhas.length > 8 ? `\n- e mais ${falhas.length - 8}` : ''}` : '.'}`;
}

/**
 * Deixa o histórico no formato que a API exige: começa pela pessoa (sem resultado de ferramenta solto),
 * vez alternada (mensagens seguidas do mesmo lado viram uma) e todo uso de ferramenta seguido do resultado.
 */
export function montarHistorico(linhas: MensagemFerramentas[]): MensagemFerramentas[] {
  const juntas: MensagemFerramentas[] = [];
  for (const l of linhas) {
    if (!l.content?.length) continue;
    const ultima = juntas.at(-1);
    if (ultima?.role === l.role) ultima.content = [...ultima.content, ...l.content];
    else juntas.push({ role: l.role, content: [...l.content] });
  }
  // Começa por uma mensagem da pessoa que não seja só resultado de ferramenta.
  while (juntas.length && (juntas[0].role !== 'user' || juntas[0].content.every((b) => b.type === 'tool_result'))) juntas.shift();
  if (juntas[0]) juntas[0].content = juntas[0].content.filter((b) => b.type !== 'tool_result');
  // Uso de ferramenta sem resultado (o servidor caiu no meio): completa com um resultado de "interrompido".
  for (let i = 0; i < juntas.length; i++) {
    const m = juntas[i];
    if (m.role !== 'assistant') continue;
    const usos = m.content.filter((b) => b.type === 'tool_use') as { id: string }[];
    if (!usos.length) continue;
    let prox = juntas[i + 1];
    if (!prox || prox.role !== 'user') {
      prox = { role: 'user', content: [] };
      juntas.splice(i + 1, 0, prox);
    }
    const tem = new Set(prox.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id));
    const faltam = usos.filter((u) => !tem.has(u.id)).map((u): BlocoFerramenta => ({ type: 'tool_result', tool_use_id: u.id, content: 'Interrompido antes de terminar.', is_error: true }));
    // Os resultados vêm antes de qualquer texto na mensagem da pessoa.
    const resultados = [...prox.content.filter((b) => b.type === 'tool_result'), ...faltam];
    const outros = prox.content.filter((b) => b.type !== 'tool_result');
    prox.content = [...resultados, ...outros];
  }
  // Resultado de ferramenta que não responde a nenhum uso logo antes: vira texto (a API recusaria).
  for (let i = 0; i < juntas.length; i++) {
    const m = juntas[i];
    if (m.role !== 'user') continue;
    const antes = juntas[i - 1];
    const ids = new Set(antes?.role === 'assistant' ? (antes.content.filter((b) => b.type === 'tool_use') as { id: string }[]).map((b) => b.id) : []);
    m.content = m.content.map((b) => (b.type === 'tool_result' && !ids.has(b.tool_use_id) ? { type: 'text', text: `[resultado anterior: ${b.content.slice(0, 2000)}]` } : b));
  }
  // Termina sempre na vez da pessoa (o Claude responde a ela).
  while (juntas.length && juntas.at(-1)!.role !== 'user') juntas.pop();
  return juntas;
}
