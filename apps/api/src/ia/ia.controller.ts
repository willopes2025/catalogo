import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Post } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../comum/db.module';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import { categorias, pessoas, produtos } from '../db/schema';
import { ErroIa, IaService, type Bloco } from './ia.service';

const TIPOS: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const foto64 = z.string().min(40, 'Foto vazia').max(9_000_000, 'Foto grande demais (máximo de 6 MB)');
const mimeFoto = z.enum(['image/jpeg', 'image/png', 'image/webp'], { message: 'Use uma foto JPG, PNG ou WebP.' });
const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ESTILOS: Record<string, { nome: string; prompt: string }> = {
  fundo_branco: {
    nome: 'Fundo branco (catálogo)',
    prompt: 'Foto de catálogo de joalheria: esta mesma peça, sozinha, sobre fundo branco puro e liso, luz de estúdio suave e uniforme, sombra de contato discreta, peça centralizada e em foco nítido.',
  },
  modelo: {
    nome: 'Em uma modelo',
    prompt: 'Foto editorial de joalheria: uma modelo brasileira adulta usando esta mesma peça do jeito certo (brinco na orelha, colar no pescoço, anel no dedo, pulseira no pulso), enquadramento fechado na peça, pele natural, luz suave de estúdio, fundo neutro claro e desfocado.',
  },
  ambiente: {
    nome: 'Em ambiente (vitrine)',
    prompt: 'Foto de produto de joalheria para rede social: esta mesma peça sobre uma superfície elegante de mármore claro ou tecido de linho, com luz natural lateral suave, composição limpa e sofisticada, fundo desfocado.',
  },
};
const REGRA_FIEL = 'MUITO IMPORTANTE: a peça tem de ser exatamente a da foto enviada: mesmo formato, mesmas pedras, mesma cor do banho, mesmas proporções e detalhes. Não invente detalhes, não troque a peça por outra parecida, não acrescente outras joias, texto, logotipo ou marca d\'água.';

/** Usos da IA fora do chat: reconhecer peça pela foto, sugerir a maleta e gerar a foto de catálogo. */
@Controller('ia')
export class IaController {
  constructor(@Inject(DB) private readonly db: Db, private readonly ia: IaService, private readonly arquivos: ArquivosService, private readonly auditoria: AuditoriaService) {}

  private async tentar<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ErroIa) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Lê a foto de um produto guardada no sistema (ou baixa, se for de fora). */
  private async lerFoto(url: string): Promise<{ conteudo: Buffer; mime: string } | null> {
    try {
      if (url.startsWith('/api/fotos/')) {
        const nome = url.slice('/api/fotos/'.length);
        const caminho = this.arquivos.caminhoFoto(nome);
        const mime = TIPOS[(nome.split('.').pop() ?? '').toLowerCase()];
        if (!caminho || !mime) return null;
        return { conteudo: await readFile(caminho), mime };
      }
      return null;
    } catch {
      return null;
    }
  }

  @Get('estado')
  estado() {
    return { texto: this.ia.texto, imagem: this.ia.imagem, modelo: this.ia.modelo, estilos: Object.entries(ESTILOS).map(([chave, e]) => ({ chave, nome: e.nome })) };
  }

  /** Confere a chave do Claude com uma pergunta mínima. */
  @Post('testar')
  @Permissao('configuracoes', 'editar')
  async testar(@Usuario() u: UsuarioLogado) {
    const r = await this.tentar(() => this.ia.perguntar({ recurso: 'teste', sistema: 'Responda só com a palavra: ok', mensagens: [{ role: 'user', content: 'Teste de conexão.' }], maxTokens: 10, usuarioId: u.id }));
    return { ok: true, resposta: r.slice(0, 40), modelo: this.ia.modelo };
  }

  /** Chamadas à IA neste mês, por recurso (para acompanhar o consumo). */
  @Get('uso')
  @Permissao('configuracoes', 'ver')
  async uso() {
    const r = await this.db.execute<{ recurso: string; chamadas: number; entrada: number; saida: number }>(sql`
      select recurso, count(*)::int as chamadas, coalesce(sum(tokens_entrada), 0)::int as entrada, coalesce(sum(tokens_saida), 0)::int as saida
      from ia_usos where criado_em >= date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'
      group by recurso order by chamadas desc`);
    return r.rows;
  }

  // ───── Reconhecer a peça pela foto ─────

  @Post('reconhecer-peca')
  @Permissao('produtos', 'ver')
  async reconhecer(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ base64: foto64, mime: mimeFoto }), body);
    const dados = d.base64.replace(/^data:[^,]+,/, '');
    const imagem: Bloco = { type: 'image', source: { type: 'base64', media_type: d.mime, data: dados } };
    // 1) A IA descreve a peça.
    const desc = await this.tentar(() =>
      this.ia.perguntarJson<{ tipo?: string; descricao?: string; palavras?: string[] }>({
        recurso: 'reconhecer_peca',
        usuarioId: u.id,
        maxTokens: 300,
        sistema:
          'Você trabalha no estoque de uma empresa de semijoias. Olhe a foto e descreva a peça para achar no cadastro. RESPONDA SOMENTE com um JSON: {"tipo": "brinco, colar, anel, pulseira, tornozeleira, pingente, conjunto, corrente ou outro", "descricao": "uma frase curta, como num cadastro de produto", "palavras": ["de 3 a 8 palavras soltas, no singular, que apareceriam no nome da peça no cadastro: o tipo, o formato, a pedra ou cor, o banho"]}. Se a foto não mostrar uma joia, devolva {"tipo": "nenhum", "descricao": "", "palavras": []}.',
        mensagens: [{ role: 'user', content: [imagem, { type: 'text', text: 'Qual é esta peça?' }] }],
      }),
    );
    const palavras = [...new Set((desc.palavras ?? []).map((p) => semAcento(String(p)).replace(/[^a-z0-9 ]/g, '').trim()).filter((p) => p.length >= 3))].slice(0, 8);
    if (desc.tipo === 'nenhum' || !palavras.length) return { descricao: desc.descricao ?? '', candidatos: [], aviso: 'Não deu para ver uma peça nesta foto. Tente outra, mais de perto e com boa luz.' };
    // 2) O cadastro acha as candidatas: quantas dessas palavras aparecem no nome, na descrição ou na categoria.
    const texto = sql`translate(lower(coalesce(${produtos.descricao}, '') || ' ' || coalesce(${produtos.descricaoCompleta}, '') || ' ' || coalesce(${categorias.nome}, '') || ' ' || coalesce(${produtos.cor}, '') || ' ' || coalesce(${produtos.tipoBanho}, '')), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
    const pontos = sql<number>`(${sql.join(palavras.map((p) => sql`(case when ${texto} like ${'%' + p + '%'} then 1 else 0 end)`), sql` + `)})`;
    const achados = await this.db
      .select({ id: produtos.id, referencia: produtos.referencia, codigoBarras: produtos.codigoBarras, descricao: produtos.descricao, preco: produtos.preco, fotos: produtos.fotos, categoria: categorias.nome, pontos, estoque: sql<number>`coalesce((select sum(quantidade) from saldos where produto_id = ${produtos.id}), 0)::int` })
      .from(produtos)
      .leftJoin(categorias, eq(categorias.id, produtos.categoriaId))
      .where(and(eq(produtos.ativo, true), sql`${pontos} >= ${Math.min(2, palavras.length)}`))
      .orderBy(sql`${pontos} desc`, sql`(jsonb_array_length(${produtos.fotos}) > 0) desc`)
      .limit(12);
    let candidatos = achados.map((p) => ({ id: p.id, referencia: p.referencia, codigoBarras: p.codigoBarras, descricao: p.descricao, categoria: p.categoria, preco: p.preco, estoque: p.estoque, foto: p.fotos?.[0] ?? null, confianca: null as number | null, motivo: null as string | null }));
    // 3) Havendo fotos no cadastro, a IA compara a foto com as das candidatas e diz qual é a mesma peça.
    const comFoto: { ref: string; foto: { conteudo: Buffer; mime: string } }[] = [];
    for (const c of candidatos.slice(0, 8)) {
      if (comFoto.length >= 6 || !c.foto) continue;
      const f = await this.lerFoto(c.foto);
      if (f && f.conteudo.length < 4_000_000) comFoto.push({ ref: c.referencia, foto: f });
    }
    if (comFoto.length >= 2) {
      try {
        const r = await this.ia.perguntarJson<{ ordem?: { ref: string; confianca: number; motivo?: string }[] }>({
          recurso: 'reconhecer_peca',
          usuarioId: u.id,
          maxTokens: 600,
          sistema:
            'Você confere peças no estoque de uma empresa de semijoias. A primeira imagem é a peça procurada; as seguintes são fotos do cadastro, cada uma com a sua referência. Diga qual delas é a mesma peça (não basta ser parecida: formato, pedras e acabamento têm de bater). RESPONDA SOMENTE com um JSON: {"ordem": [{"ref": "referência", "confianca": número de 0 a 100, "motivo": "poucas palavras"}]}, da mais provável para a menos provável, com todas as candidatas.',
          mensagens: [{ role: 'user', content: [{ type: 'text', text: 'Peça procurada:' }, imagem, ...comFoto.flatMap((c): Bloco[] => [{ type: 'text', text: `Candidata ${c.ref}:` }, { type: 'image', source: { type: 'base64', media_type: c.foto.mime, data: c.foto.conteudo.toString('base64') } }])] }],
        });
        const nota = new Map((r.ordem ?? []).map((o) => [String(o.ref), o]));
        candidatos = candidatos
          .map((c) => ({ ...c, confianca: nota.has(c.referencia) ? Math.max(0, Math.min(100, Math.round(Number(nota.get(c.referencia)!.confianca) || 0))) : null, motivo: nota.get(c.referencia)?.motivo?.slice(0, 120) ?? null }))
          .sort((a, b) => (b.confianca ?? -1) - (a.confianca ?? -1));
      } catch {
        // A comparação é um refinamento: se falhar, ficam as candidatas pela descrição.
      }
    }
    return { descricao: desc.descricao ?? '', candidatos, aviso: candidatos.length ? null : 'Nenhum produto do cadastro bate com esta descrição.' };
  }

  // ───── Sugerir a maleta ─────

  @Post('sugerir-maleta')
  @Permissao('maletas', 'criar')
  async sugerirMaleta(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ representanteId: z.string().uuid(), origemId: z.string().uuid(), valorAlvo: z.number().int().min(10_000, 'O valor mínimo é R$ 100,00').max(50_000_000).optional(), pedido: z.string().trim().max(500).optional() }), body);
    const [rep] = await this.db.select().from(pessoas).where(eq(pessoas.id, d.representanteId));
    if (!rep || rep.tipo !== 'representante') throw new NotFoundException('Representante não encontrada.');
    // O que ela levou e vendeu, por categoria, nas maletas dela.
    const historico = (
      await this.db.execute<{ categoria: string; enviadas: number; vendidas: number; ticket: number }>(sql`
        select coalesce(c.nome, 'Sem categoria') as categoria, sum(mi.enviada)::int as enviadas, sum(mi.vendida)::int as vendidas,
               coalesce(round(sum(mi.vendida * mi.preco)::numeric / nullif(sum(mi.vendida), 0)), 0)::int as ticket
        from maleta_itens mi join maletas m on m.id = mi.maleta_id join produtos p on p.id = mi.produto_id left join categorias c on c.id = p.categoria_id
        where m.representante_id = ${d.representanteId} and m.status <> 'cancelada'
        group by 1 order by 3 desc limit 15`)
    ).rows;
    const [media] = (
      await this.db.execute<{ valor: number; pecas: number; n: number }>(sql`
        select coalesce(avg(t.valor), 0)::int as valor, coalesce(avg(t.pecas), 0)::int as pecas, count(*)::int as n from (
          select sum(mi.enviada * mi.preco) as valor, sum(mi.enviada) as pecas from maleta_itens mi join maletas m on m.id = mi.maleta_id
          where m.representante_id = ${d.representanteId} and m.status <> 'cancelada' group by m.id order by max(m.criado_em) desc limit 3) t`)
    ).rows;
    // Peças disponíveis no local de saída, com o quanto giram na empresa toda (vendas em maletas nos últimos 120 dias).
    const disponiveis = (
      await this.db.execute<{ id: string; referencia: string; codigoBarras: string; descricao: string; categoria: string; preco: number; custo: number; precoAtacado: number | null; estoque: number; giro: number; dela: number }>(sql`
        select p.id, p.referencia, p.codigo_barras as "codigoBarras", p.descricao, coalesce(c.nome, 'Sem categoria') as categoria, p.preco, p.custo, p.preco_atacado as "precoAtacado", s.quantidade::int as estoque,
               coalesce((select sum(mi.vendida) from maleta_itens mi join maletas m on m.id = mi.maleta_id where mi.produto_id = p.id and m.criado_em > now() - interval '120 days'), 0)::int as giro,
               coalesce((select sum(mi.vendida) from maleta_itens mi join maletas m on m.id = mi.maleta_id where mi.produto_id = p.id and m.representante_id = ${d.representanteId}), 0)::int as dela
        from produtos p join saldos s on s.produto_id = p.id and s.local_id = ${d.origemId} left join categorias c on c.id = p.categoria_id
        where p.ativo and s.quantidade > 0 and p.preco > 0
        order by 11 desc, 10 desc, s.quantidade desc limit 160`)
    ).rows;
    if (disponiveis.length < 3) throw new BadRequestException('Há menos de 3 produtos com estoque neste local: não há o que sugerir.');
    const alvo = d.valorAlvo ?? (media.n ? media.valor : Math.min(rep.limiteCredito || 300_000, 300_000));
    const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
    const r = await this.tentar(() =>
      this.ia.perguntarJson<{ itens?: { ref: string; qtd: number }[]; resumo?: string }>({
        recurso: 'maleta',
        usuarioId: u.id,
        maxTokens: 2500,
        sistema: [
          'Você ajuda a montar a maleta de semijoias em consignação de uma revendedora. Escolha as peças e as quantidades entre as disponíveis.',
          'Critérios: priorize as categorias e faixas de preço que ela vende mais; inclua peças de giro alto na empresa; varie os tipos (brinco, colar, anel, pulseira…) para a maleta ficar completa; para quem é nova ou tem pouco histórico, faça um mix equilibrado com preços acessíveis; evite muitas unidades da mesma peça (1 a 3, no máximo o estoque).',
          'O valor total (preço × quantidade) deve ficar perto do valor alvo, sem passar dele.',
          'Use somente referências da lista. RESPONDA SOMENTE com um JSON: {"itens": [{"ref": "referência", "qtd": número}], "resumo": "duas ou três frases explicando a escolha para a equipe"}.',
        ].join('\n'),
        mensagens: [
          {
            role: 'user',
            content: [
              `Revendedora: ${rep.nome}${rep.cidade ? `, de ${rep.cidade}/${rep.uf ?? ''}` : ''}.`,
              media.n ? `Últimas maletas dela: em média R$ ${reais(media.valor)} e ${media.pecas} peças.` : 'Ela ainda não teve maleta.',
              historico.length ? `O que ela levou e vendeu, por categoria:\n${historico.map((h) => `- ${h.categoria}: levou ${h.enviadas}, vendeu ${h.vendidas}${h.vendidas ? `, preço médio vendido R$ ${reais(h.ticket)}` : ''}`).join('\n')}` : '',
              `Valor alvo da maleta: R$ ${reais(alvo)}.`,
              d.pedido ? `Pedido da equipe (considere, sem sair da lista): ${d.pedido}` : '',
              `Peças disponíveis (referência | descrição | categoria | preço | estoque | vendidas na empresa em 120 dias | vendidas por ela):\n${disponiveis.map((p) => `- ${p.referencia} | ${p.descricao.slice(0, 60)} | ${p.categoria} | R$ ${reais(p.preco)} | ${p.estoque} | ${p.giro} | ${p.dela}`).join('\n')}`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      }),
    );
    // Confere a resposta com o estoque de verdade: referência que existe, quantidade que há, sem repetir e sem passar do alvo.
    const porRef = new Map(disponiveis.map((p) => [p.referencia, p]));
    const itens: { produtoId: string; referencia: string; codigoBarras: string; descricao: string; categoria: string; preco: number; custo: number; precoAtacado: number | null; quantidade: number }[] = [];
    let total = 0;
    for (const i of r.itens ?? []) {
      const p = porRef.get(String(i.ref));
      if (!p || itens.some((x) => x.produtoId === p.id)) continue;
      let qtd = Math.max(0, Math.min(Math.floor(Number(i.qtd) || 0), p.estoque, 5));
      while (qtd > 0 && total + qtd * p.preco > alvo * 1.05) qtd--;
      if (!qtd) continue;
      total += qtd * p.preco;
      itens.push({ produtoId: p.id, referencia: p.referencia, codigoBarras: p.codigoBarras, descricao: p.descricao, categoria: p.categoria, preco: p.preco, custo: p.custo, precoAtacado: p.precoAtacado, quantidade: qtd });
    }
    if (!itens.length) throw new BadRequestException('A IA não devolveu uma sugestão aproveitável. Tente de novo.');
    return { itens, total, pecas: itens.reduce((s, i) => s + i.quantidade, 0), alvo, resumo: String(r.resumo ?? '').slice(0, 600), semHistorico: !media.n };
  }

  // ───── Foto de catálogo ─────

  /** Gera a foto e devolve para a pessoa ver. Só entra no produto quando ela aprova (rota "usar"). */
  @Post('foto-produto')
  @Permissao('produtos', 'editar')
  async fotoProduto(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ produtoId: z.string().uuid(), estilo: z.enum(['fundo_branco', 'modelo', 'ambiente']), fotoAtual: z.string().max(300).optional(), base64: foto64.optional(), mime: mimeFoto.optional(), pedido: z.string().trim().max(300).optional() }), body);
    const [p] = await this.db.select().from(produtos).where(eq(produtos.id, d.produtoId));
    if (!p) throw new NotFoundException('Produto não encontrado.');
    let origem: { conteudo: Buffer; mime: string } | null = null;
    if (d.base64 && d.mime) origem = { conteudo: Buffer.from(d.base64.replace(/^data:[^,]+,/, ''), 'base64'), mime: d.mime };
    else if (d.fotoAtual && (p.fotos ?? []).includes(d.fotoAtual)) origem = await this.lerFoto(d.fotoAtual);
    if (!origem) throw new BadRequestException('Envie uma foto da peça (ou escolha uma das fotos do produto).');
    const estilo = ESTILOS[d.estilo];
    const png = await this.tentar(() => this.ia.gerarImagem({ prompt: `${estilo.prompt} ${REGRA_FIEL} A peça é: ${p.descricao}.${d.pedido ? ` Pedido extra: ${d.pedido}` : ''}`, imagens: [origem!], tamanho: d.estilo === 'modelo' ? '1024x1536' : '1024x1024', usuarioId: u.id }));
    const url = await this.arquivos.salvarFoto(`ia:${p.id}:${createHash('sha1').update(png).digest('hex')}`, png, 'image/png');
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'gerar_foto', entidade: 'produto', entidadeId: p.id, dados: { estilo: d.estilo, url } });
    return { url, estilo: estilo.nome };
  }

  /** Põe no produto uma foto gerada (aprovada na tela) ou enviada do computador. */
  @Post('foto-produto/usar')
  @Permissao('produtos', 'editar')
  async usarFoto(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ produtoId: z.string().uuid(), url: z.string().regex(/^\/api\/fotos\/[\w.-]+$/).optional(), base64: foto64.optional(), mime: mimeFoto.optional(), principal: z.boolean().default(false) }), body);
    const [p] = await this.db.select().from(produtos).where(eq(produtos.id, d.produtoId));
    if (!p) throw new NotFoundException('Produto não encontrado.');
    let url = d.url;
    if (!url && d.base64 && d.mime) {
      const conteudo = Buffer.from(d.base64.replace(/^data:[^,]+,/, ''), 'base64');
      url = await this.arquivos.salvarFoto(`envio:${p.id}:${createHash('sha1').update(conteudo).digest('hex')}`, conteudo, d.mime);
    }
    if (!url || !this.arquivos.caminhoFoto(url.slice('/api/fotos/'.length))) throw new BadRequestException('Foto não encontrada.');
    const outras = (p.fotos ?? []).filter((f) => f !== url);
    const fotos = (d.principal ? [url, ...outras] : [...outras, url]).slice(0, 12);
    await this.db.update(produtos).set({ fotos }).where(eq(produtos.id, p.id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'adicionar_foto', entidade: 'produto', entidadeId: p.id, dados: { url, principal: d.principal } });
    return { fotos };
  }

  /** Tira uma foto do produto (o arquivo continua guardado, caso outro produto use). */
  @Post('foto-produto/tirar')
  @Permissao('produtos', 'editar')
  async tirarFoto(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(z.object({ produtoId: z.string().uuid(), url: z.string().max(500) }), body);
    const [p] = await this.db.select().from(produtos).where(eq(produtos.id, d.produtoId));
    if (!p) throw new NotFoundException('Produto não encontrado.');
    const fotos = (p.fotos ?? []).filter((f) => f !== d.url);
    await this.db.update(produtos).set({ fotos }).where(eq(produtos.id, p.id));
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'tirar_foto', entidade: 'produto', entidadeId: p.id, dados: { url: d.url } });
    return { fotos };
  }
}
