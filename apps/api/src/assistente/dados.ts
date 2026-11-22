import { sql, type SQL } from 'drizzle-orm';

/**
 * Motor de consultas do assistente: conjuntos de dados pré-definidos (o SQL é fixo, escrito aqui), com dimensões
 * para agrupar e filtrar, métricas para somar/contar e colunas para listar. O assistente só escolhe os nomes;
 * os valores dos filtros vão como parâmetros. Nenhum SQL vindo da IA é executado.
 */
export type TipoMetrica = 'reais' | 'numero' | 'pct';
export interface Conjunto {
  descricao: string;
  /** Pode consultar quem tem alguma destas permissões (módulo, ação). */
  permissoes: [string, string][];
  /** FROM … JOIN … (fixo). */
  de: string;
  /** Filtro fixo (ex.: só vendas concluídas). */
  onde?: string;
  /** Coluna de data para o período (timestamp com fuso ou date). */
  data?: { expr: string; tipo: 'timestamp' | 'date'; rotulo: string };
  dimensoes: Record<string, string>;
  metricas: Record<string, { expr: string; tipo: TipoMetrica }>;
  /** Colunas do modo lista. */
  colunas: Record<string, string | { expr: string; tipo?: TipoMetrica | 'data' }>;
}

const SP = "at time zone 'America/Sao_Paulo'";
const tempo = (col: string) => ({
  dia: `to_char((${col} ${SP})::date, 'DD/MM/YYYY')`,
  mes: `to_char((${col} ${SP})::date, 'YYYY-MM')`,
  dia_semana: `(array['domingo','segunda','terça','quarta','quinta','sexta','sábado'])[extract(dow from (${col} ${SP}))::int + 1]`,
});
const tempoData = (col: string) => ({ dia: `to_char(${col}, 'DD/MM/YYYY')`, mes: `to_char(${col}, 'YYYY-MM')`, dia_semana: `(array['domingo','segunda','terça','quarta','quinta','sexta','sábado'])[extract(dow from ${col})::int + 1]` });

export const CONJUNTOS: Record<string, Conjunto> = {
  vendas_itens: {
    descricao: 'Peças vendidas (loja, eventos, matriz e revenda), já descontando devoluções: o que mais vende, por vendedor, loja, categoria, dia.',
    permissoes: [['vendas', 'ver'], ['relatorios', 'ver']],
    de: 'venda_itens vi join vendas v on v.id = vi.venda_id join produtos p on p.id = vi.produto_id left join categorias c on c.id = p.categoria_id left join locais_estoque l on l.id = v.local_id left join usuarios u on u.id = v.vendedor_id left join pessoas cli on cli.id = v.cliente_id',
    onde: "v.status = 'concluida'",
    data: { expr: 'v.criado_em', tipo: 'timestamp', rotulo: 'data da venda' },
    dimensoes: { produto: 'p.descricao', referencia: 'p.referencia', categoria: "coalesce(c.nome, 'sem categoria')", loja_ou_local: 'l.nome', vendedor: "coalesce(u.nome, '—')", tipo_venda: 'v.tipo', cliente: "coalesce(cli.nome, 'consumidor')", ...tempo('v.criado_em') },
    metricas: {
      pecas: { expr: 'sum(vi.quantidade - vi.devolvida)', tipo: 'numero' },
      faturamento: { expr: 'sum(case when vi.quantidade > 0 then vi.total * (vi.quantidade - vi.devolvida) / vi.quantidade else 0 end)', tipo: 'reais' },
      custo: { expr: 'sum(vi.custo * (vi.quantidade - vi.devolvida))', tipo: 'reais' },
      lucro_bruto: { expr: 'sum(case when vi.quantidade > 0 then vi.total * (vi.quantidade - vi.devolvida) / vi.quantidade else 0 end) - sum(vi.custo * (vi.quantidade - vi.devolvida))', tipo: 'reais' },
      vendas: { expr: 'count(distinct v.id)', tipo: 'numero' },
    },
    colunas: { venda: 'v.numero', data: { expr: 'v.criado_em', tipo: 'data' }, produto: 'p.descricao', referencia: 'p.referencia', quantidade: 'vi.quantidade - vi.devolvida', total: { expr: 'vi.total', tipo: 'reais' }, loja_ou_local: 'l.nome', vendedor: 'u.nome' },
  },
  vendas_pagamentos: {
    descricao: 'Como as vendas foram pagas: forma (dinheiro, Pix, débito, crédito, crediário), maquininha e parcelas.',
    permissoes: [['vendas', 'ver'], ['financeiro', 'ver']],
    de: 'venda_pagamentos vp join vendas v on v.id = vp.venda_id left join locais_estoque l on l.id = v.local_id',
    onde: "v.status = 'concluida'",
    data: { expr: 'v.criado_em', tipo: 'timestamp', rotulo: 'data da venda' },
    dimensoes: { forma: 'vp.forma', maquininha: "coalesce(vp.maquininha, '—')", parcelas: 'vp.parcelas::text', loja_ou_local: 'l.nome', ...tempo('v.criado_em') },
    metricas: { valor: { expr: 'sum(vp.valor)', tipo: 'reais' }, pagamentos: { expr: 'count(*)', tipo: 'numero' } },
    colunas: { venda: 'v.numero', data: { expr: 'v.criado_em', tipo: 'data' }, forma: 'vp.forma', valor: { expr: 'vp.valor', tipo: 'reais' }, parcelas: 'vp.parcelas' },
  },
  estoque: {
    descricao: 'Estoque atual por produto e local (depósito, lojas, maletas), com valor a custo e a preço de venda e o que está abaixo do mínimo.',
    permissoes: [['estoque', 'ver'], ['produtos', 'ver']],
    de: 'saldos s join produtos p on p.id = s.produto_id join locais_estoque l on l.id = s.local_id left join categorias c on c.id = p.categoria_id',
    onde: 's.quantidade <> 0',
    dimensoes: { produto: 'p.descricao', referencia: 'p.referencia', categoria: "coalesce(c.nome, 'sem categoria')", local: 'l.nome', tipo_local: 'l.tipo', abaixo_do_minimo: "case when p.estoque_minimo > 0 and s.quantidade < p.estoque_minimo then 'sim' else 'não' end", produto_ativo: "case when p.ativo then 'sim' else 'não' end" },
    metricas: { quantidade: { expr: 'sum(s.quantidade)', tipo: 'numero' }, valor_custo: { expr: 'sum(s.quantidade * p.custo)', tipo: 'reais' }, valor_venda: { expr: 'sum(s.quantidade * p.preco)', tipo: 'reais' }, produtos: { expr: 'count(distinct p.id)', tipo: 'numero' } },
    colunas: { produto: 'p.descricao', referencia: 'p.referencia', codigo_barras: 'p.codigo_barras', local: 'l.nome', quantidade: 's.quantidade', minimo: 'p.estoque_minimo', preco: { expr: 'p.preco', tipo: 'reais' } },
  },
  movimentos_estoque: {
    descricao: 'Entradas, saídas, ajustes e transferências de estoque no período.',
    permissoes: [['estoque', 'ver']],
    de: 'movimentos mv join produtos p on p.id = mv.produto_id left join locais_estoque o on o.id = mv.origem_id left join locais_estoque d on d.id = mv.destino_id',
    data: { expr: 'mv.criado_em', tipo: 'timestamp', rotulo: 'data do movimento' },
    dimensoes: { tipo: 'mv.tipo', motivo: "coalesce(mv.motivo, '—')", produto: 'p.descricao', origem: "coalesce(o.nome, '—')", destino: "coalesce(d.nome, '—')", ...tempo('mv.criado_em') },
    metricas: { quantidade: { expr: 'sum(mv.quantidade)', tipo: 'numero' }, movimentos: { expr: 'count(*)', tipo: 'numero' } },
    colunas: { data: { expr: 'mv.criado_em', tipo: 'data' }, tipo: 'mv.tipo', produto: 'p.descricao', quantidade: 'mv.quantidade', origem: 'o.nome', destino: 'd.nome', motivo: 'mv.motivo' },
  },
  maletas: {
    descricao: 'Maletas (consignado): abertas, acertadas, atrasadas, por revendedora, nível e cidade, com peças e valor enviado e vendido.',
    permissoes: [['maletas', 'ver']],
    de: "maletas m join pessoas r on r.id = m.representante_id left join niveis n on n.id = r.nivel_id left join lateral (select coalesce(sum(i.enviada), 0) as enviadas, coalesce(sum(i.vendida), 0) as vendidas, coalesce(sum(i.enviada * i.preco), 0) as valor_enviado, coalesce(sum(i.vendida * i.preco), 0) as valor_vendido from maleta_itens i where i.maleta_id = m.id) it on true",
    onde: "m.status <> 'cancelada'",
    data: { expr: 'm.data_retirada', tipo: 'date', rotulo: 'data da retirada' },
    dimensoes: { status: 'm.status', revendedora: 'r.nome', nivel: "coalesce(n.nome, 'sem nível')", cidade: "coalesce(r.cidade, '—')", uf: "coalesce(r.uf, '—')", atrasada: "case when m.status = 'aberta' and m.data_limite < (now() at time zone 'America/Sao_Paulo')::date then 'sim' else 'não' end", entrega: 'm.entrega', ...tempoData('m.data_retirada') },
    metricas: { maletas: { expr: 'count(*)', tipo: 'numero' }, pecas_enviadas: { expr: 'sum(it.enviadas)', tipo: 'numero' }, pecas_vendidas: { expr: 'sum(it.vendidas)', tipo: 'numero' }, valor_enviado: { expr: 'sum(it.valor_enviado)', tipo: 'reais' }, valor_vendido: { expr: 'sum(it.valor_vendido)', tipo: 'reais' }, percentual_vendido: { expr: 'case when sum(it.valor_enviado) > 0 then round(sum(it.valor_vendido) * 10000.0 / sum(it.valor_enviado)) else 0 end', tipo: 'pct' } },
    colunas: { maleta: 'm.numero', revendedora: 'r.nome', telefone: 'r.telefone1', status: 'm.status', retirada: { expr: 'm.data_retirada', tipo: 'data' }, acerto_ate: { expr: 'm.data_limite', tipo: 'data' }, valor_enviado: { expr: 'it.valor_enviado', tipo: 'reais' }, valor_vendido: { expr: 'it.valor_vendido', tipo: 'reais' } },
  },
  acertos: {
    descricao: 'Acertos de maleta feitos: forma (presencial, vídeo, envio), modalidade de pagamento, parcial, total a pagar.',
    permissoes: [['maletas', 'ver']],
    de: 'acertos a join maletas m on m.id = a.maleta_id join pessoas r on r.id = m.representante_id left join niveis n on n.id = r.nivel_id',
    data: { expr: 'a.data', tipo: 'date', rotulo: 'data do acerto' },
    dimensoes: { revendedora: 'r.nome', nivel: "coalesce(n.nome, 'sem nível')", forma: 'a.forma', modalidade: 'a.modalidade', parcial: "case when a.parcial then 'sim' else 'não' end", cidade: "coalesce(r.cidade, '—')", ...tempoData('a.data') },
    metricas: { acertos: { expr: 'count(*)', tipo: 'numero' }, total_a_pagar: { expr: 'sum(a.total_a_pagar)', tipo: 'reais' } },
    colunas: { data: { expr: 'a.data', tipo: 'data' }, maleta: 'm.numero', revendedora: 'r.nome', forma: 'a.forma', modalidade: 'a.modalidade', total_a_pagar: { expr: 'a.total_a_pagar', tipo: 'reais' } },
  },
  rede: {
    descricao: 'Revendedoras: nível, líder, cidade, modelo de trabalho, situação, limite de crédito, pontos e quando entraram.',
    permissoes: [['rede', 'ver']],
    de: "pessoas r left join niveis n on n.id = r.nivel_id left join pessoas lid on lid.id = r.lider_id left join lateral (select coalesce(sum(pt.pontos), 0) as pontos from pontos pt where pt.pessoa_id = r.id) pt on true",
    onde: "r.tipo = 'representante'",
    data: { expr: 'r.criado_em', tipo: 'timestamp', rotulo: 'data do cadastro' },
    dimensoes: { nivel: "coalesce(n.nome, 'sem nível')", lider: "coalesce(lid.nome, 'sem líder')", cidade: "coalesce(r.cidade, '—')", uf: "coalesce(r.uf, '—')", modelo_trabalho: "coalesce(r.modelo_trabalho::text, '—')", situacao: 'r.status::text', bloqueada: "case when r.bloqueado then 'sim' else 'não' end", ...tempo('r.criado_em') },
    metricas: { revendedoras: { expr: 'count(*)', tipo: 'numero' }, limite_total: { expr: 'sum(r.limite_credito)', tipo: 'reais' }, pontos: { expr: 'sum(pt.pontos)', tipo: 'numero' } },
    colunas: { pessoaId: 'r.id', nome: 'r.nome', telefone: 'r.telefone1', cidade: 'r.cidade', nivel: 'n.nome', lider: 'lid.nome', situacao: 'r.status', limite: { expr: 'r.limite_credito', tipo: 'reais' }, pontos: 'pt.pontos', desde: { expr: 'r.criado_em', tipo: 'data' } },
  },
  candidatas: {
    descricao: 'Candidatas a revendedora (captação): etapa da triagem, origem do anúncio, cidade, interesse, responsável.',
    permissoes: [['crm', 'ver'], ['rede', 'ver']],
    de: 'candidaturas ca left join usuarios u on u.id = ca.responsavel_id',
    data: { expr: 'ca.criado_em', tipo: 'timestamp', rotulo: 'data da candidatura' },
    dimensoes: { etapa: 'ca.etapa', origem: "coalesce(nullif(ca.origem->>'utm_source', ''), 'direto')", campanha: "coalesce(nullif(ca.origem->>'utm_campaign', ''), '—')", cidade: "coalesce(ca.cidade, '—')", uf: "coalesce(ca.uf, '—')", interesse: "coalesce(ca.modelo_interesse, '—')", responsavel: "coalesce(u.nome, 'sem responsável')", como_conheceu: "coalesce(ca.como_conheceu, '—')", ...tempo('ca.criado_em') },
    metricas: { candidatas: { expr: 'count(*)', tipo: 'numero' }, aprovadas: { expr: "count(*) filter (where ca.etapa = 'aprovada')", tipo: 'numero' } },
    colunas: { numero: 'ca.numero', nome: 'ca.nome', telefone: 'ca.telefone', cidade: 'ca.cidade', etapa: 'ca.etapa', origem: "ca.origem->>'utm_source'", campanha: "ca.origem->>'utm_campaign'", responsavel: 'u.nome', data: { expr: 'ca.criado_em', tipo: 'data' } },
  },
  crm_leads: {
    descricao: 'Cards dos funis do CRM: funil, etapa, origem, responsável, ganhos e perdidos (com motivo), valor.',
    permissoes: [['crm', 'ver']],
    de: 'crm_leads ld join crm_funis f on f.id = ld.funil_id join crm_etapas e on e.id = ld.etapa_id left join usuarios u on u.id = ld.responsavel_id left join crm_contatos ct on ct.id = ld.contato_id',
    data: { expr: 'ld.criado_em', tipo: 'timestamp', rotulo: 'data de entrada' },
    dimensoes: { funil: 'f.nome', etapa: 'e.nome', origem: "coalesce(nullif(ld.origem->>'utm_source', ''), 'direto')", campanha: "coalesce(nullif(ld.origem->>'utm_campaign', ''), '—')", responsavel: "coalesce(u.nome, 'sem responsável')", situacao: 'ld.status', motivo_perda: "coalesce(ld.motivo_perda, '—')", ...tempo('ld.criado_em') },
    metricas: { leads: { expr: 'count(*)', tipo: 'numero' }, valor: { expr: 'sum(ld.valor)', tipo: 'reais' } },
    colunas: { leadId: 'ld.id', numero: 'ld.numero', titulo: 'ld.titulo', contato: 'ct.nome', telefone: 'ct.telefone', funil: 'f.nome', etapa: 'e.nome', responsavel: 'u.nome', situacao: 'ld.status', ultima_interacao: { expr: 'ld.ultima_interacao_em', tipo: 'data' } },
  },
  crm_tarefas: {
    descricao: 'Tarefas dos cards do CRM: abertas, atrasadas e feitas, por responsável.',
    permissoes: [['crm', 'ver']],
    de: 'crm_tarefas t join crm_leads ld on ld.id = t.lead_id left join usuarios u on u.id = t.responsavel_id left join crm_contatos ct on ct.id = ld.contato_id',
    data: { expr: 't.vence_em', tipo: 'timestamp', rotulo: 'vencimento da tarefa' },
    dimensoes: { responsavel: "coalesce(u.nome, '—')", situacao: "case when t.feita_em is not null then 'feita' when t.vence_em < now() then 'atrasada' else 'aberta' end", ...tempo('t.vence_em') },
    metricas: { tarefas: { expr: 'count(*)', tipo: 'numero' } },
    colunas: { titulo: 't.titulo', vence: { expr: 't.vence_em', tipo: 'data' }, responsavel: 'u.nome', contato: 'ct.nome', leadId: 'ld.id', feita: { expr: 't.feita_em', tipo: 'data' } },
  },
  agenda: {
    descricao: 'Compromissos da agenda (entrevistas, acertos por vídeo, retiradas, reuniões): situação, responsável, tipo.',
    permissoes: [['agenda', 'ver']],
    de: 'agenda_compromissos ac left join usuarios u on u.id = ac.responsavel_id left join pessoas p on p.id = ac.pessoa_id',
    data: { expr: 'ac.inicio', tipo: 'timestamp', rotulo: 'data do compromisso' },
    dimensoes: { tipo: 'ac.tipo', situacao: 'ac.status', responsavel: "coalesce(u.nome, '—')", online: "case when ac.online then 'sim' else 'não' end", ...tempo('ac.inicio') },
    metricas: { compromissos: { expr: 'count(*)', tipo: 'numero' } },
    colunas: { titulo: 'ac.titulo', inicio: { expr: 'ac.inicio', tipo: 'data' }, tipo: 'ac.tipo', situacao: 'ac.status', com: "coalesce(p.nome, ac.convidado_nome)", responsavel: 'u.nome', local: "case when ac.online then coalesce(ac.link, 'online') else ac.local end" },
  },
  comissoes: {
    descricao: 'Comissões fechadas por mês: de vendedoras e de líderes, com base e valor.',
    permissoes: [['comissoes', 'ver']],
    de: 'comissoes co join fechamentos_comissao fc on fc.id = co.fechamento_id',
    dimensoes: { mes: 'fc.mes', tipo: 'co.tipo', pessoa: 'co.nome' },
    metricas: { valor: { expr: 'sum(co.valor)', tipo: 'reais' }, base: { expr: 'sum(co.base)', tipo: 'reais' }, pessoas: { expr: 'count(distinct co.nome)', tipo: 'numero' } },
    colunas: { mes: 'fc.mes', pessoa: 'co.nome', tipo: 'co.tipo', base: { expr: 'co.base', tipo: 'reais' }, valor: { expr: 'co.valor', tipo: 'reais' } },
  },
  garantia: {
    descricao: 'Ordens de serviço de garantia e conserto: tipo, situação, decisão, produto, valor.',
    permissoes: [['garantia', 'ver']],
    de: 'ordens_servico os left join produtos p on p.id = os.produto_id left join pessoas c on c.id = coalesce(os.cliente_id, os.representante_id)',
    data: { expr: 'os.criado_em', tipo: 'timestamp', rotulo: 'data de abertura' },
    dimensoes: { tipo: 'os.tipo', situacao: 'os.status', decisao: "coalesce(os.decisao, '—')", produto: "coalesce(p.descricao, '—')", ...tempo('os.criado_em') },
    metricas: { ordens: { expr: 'count(*)', tipo: 'numero' }, valor: { expr: 'sum(coalesce(os.valor, 0))', tipo: 'reais' } },
    colunas: { numero: 'os.numero', tipo: 'os.tipo', situacao: 'os.status', cliente: 'c.nome', produto: 'p.descricao', defeito: 'os.defeito', aberta: { expr: 'os.criado_em', tipo: 'data' } },
  },
  notas_fiscais: {
    descricao: 'Notas fiscais emitidas (NFC-e e NF-e): operação, situação, valor.',
    permissoes: [['fiscal', 'ver']],
    de: 'notas_fiscais nf',
    data: { expr: 'nf.criado_em', tipo: 'timestamp', rotulo: 'data da emissão' },
    dimensoes: { modelo: 'nf.modelo', operacao: 'nf.operacao', situacao: 'nf.status', ...tempo('nf.criado_em') },
    metricas: { notas: { expr: 'count(*)', tipo: 'numero' }, valor: { expr: 'sum(nf.valor)', tipo: 'reais' } },
    colunas: { numero: 'nf.numero', modelo: 'nf.modelo', operacao: 'nf.operacao', situacao: 'nf.status', valor: { expr: 'nf.valor', tipo: 'reais' }, mensagem: 'nf.mensagem', data: { expr: 'nf.criado_em', tipo: 'data' } },
  },
  marketing_gastos: {
    descricao: 'Investimento em marketing por mês e campanha (lançado ou vindo do Meta).',
    permissoes: [['marketing', 'ver']],
    de: 'marketing_gastos mg left join campanhas cp on cp.id = mg.campanha_id',
    dimensoes: { mes: 'mg.competencia', campanha: "coalesce(cp.nome, mg.descricao, '—')", canal: "coalesce(cp.canal, '—')", origem: 'mg.origem' },
    metricas: { investimento: { expr: 'sum(mg.valor)', tipo: 'reais' } },
    colunas: { mes: 'mg.competencia', campanha: 'cp.nome', descricao: 'mg.descricao', valor: { expr: 'mg.valor', tipo: 'reais' } },
  },
  pontos: {
    descricao: 'Pontos da gamificação lançados para as revendedoras (por motivo e regra).',
    permissoes: [['pontos', 'ver'], ['rede', 'ver']],
    de: 'pontos pt join pessoas r on r.id = pt.pessoa_id',
    data: { expr: 'pt.criado_em', tipo: 'timestamp', rotulo: 'data do lançamento' },
    dimensoes: { revendedora: 'r.nome', motivo: 'pt.motivo', regra: "coalesce(pt.regra, '—')", ...tempo('pt.criado_em') },
    metricas: { pontos: { expr: 'sum(pt.pontos)', tipo: 'numero' }, lancamentos: { expr: 'count(*)', tipo: 'numero' } },
    colunas: { data: { expr: 'pt.criado_em', tipo: 'data' }, revendedora: 'r.nome', pontos: 'pt.pontos', motivo: 'pt.motivo' },
  },
  resgates: {
    descricao: 'Resgates de prêmios com pontos: prêmio, situação.',
    permissoes: [['pontos', 'ver']],
    de: 'resgates rg join premios pr on pr.id = rg.premio_id join pessoas r on r.id = rg.pessoa_id',
    data: { expr: 'rg.criado_em', tipo: 'timestamp', rotulo: 'data do resgate' },
    dimensoes: { premio: 'pr.nome', situacao: 'rg.status', revendedora: 'r.nome', ...tempo('rg.criado_em') },
    metricas: { resgates: { expr: 'count(*)', tipo: 'numero' }, pontos: { expr: 'sum(rg.pontos)', tipo: 'numero' } },
    colunas: { numero: 'rg.numero', revendedora: 'r.nome', premio: 'pr.nome', pontos: 'rg.pontos', situacao: 'rg.status', data: { expr: 'rg.criado_em', tipo: 'data' } },
  },
  pedidos_catalogo: {
    descricao: 'Pedidos que clientes fizeram pelo catálogo/link das revendedoras: situação, origem, cidade, total.',
    permissoes: [['vendas', 'ver'], ['rede', 'ver']],
    de: 'pedidos_link pl left join pessoas r on r.id = pl.pessoa_id',
    data: { expr: 'pl.criado_em', tipo: 'timestamp', rotulo: 'data do pedido' },
    dimensoes: { situacao: 'pl.status', origem: "coalesce(pl.origem, '—')", revendedora: "coalesce(r.nome, 'matriz')", cidade: "coalesce(pl.cliente_cidade, '—')", entrega: "coalesce(pl.entrega, '—')", ...tempo('pl.criado_em') },
    metricas: { pedidos: { expr: 'count(*)', tipo: 'numero' }, total: { expr: 'sum(pl.total)', tipo: 'reais' } },
    colunas: { numero: 'pl.numero', cliente: 'pl.cliente_nome', telefone: 'pl.cliente_telefone', revendedora: 'r.nome', situacao: 'pl.status', total: { expr: 'pl.total', tipo: 'reais' }, data: { expr: 'pl.criado_em', tipo: 'data' } },
  },
  acordos_cobranca: {
    descricao: 'Acordos de renegociação da cobrança: situação, cobrador, valores.',
    permissoes: [['cobranca', 'ver']],
    de: 'cobranca_acordos ag join pessoas p on p.id = ag.pessoa_id left join cobradores cb on cb.id = ag.cobrador_id',
    data: { expr: 'ag.criado_em', tipo: 'timestamp', rotulo: 'data do acordo' },
    dimensoes: { situacao: 'ag.status', cobrador: "coalesce(cb.nome, '—')", ...tempo('ag.criado_em') },
    metricas: { acordos: { expr: 'count(*)', tipo: 'numero' }, total: { expr: 'sum(ag.total)', tipo: 'reais' }, desconto: { expr: 'sum(ag.desconto)', tipo: 'reais' }, original: { expr: 'sum(ag.original)', tipo: 'reais' } },
    colunas: { numero: 'ag.numero', devedor: 'p.nome', situacao: 'ag.status', total: { expr: 'ag.total', tipo: 'reais' }, parcelas: 'ag.parcelas', cobrador: 'cb.nome', data: { expr: 'ag.criado_em', tipo: 'data' } },
  },
  caixas: {
    descricao: 'Caixas das lojas e eventos: abertos, fechados e diferença no fechamento (sobra ou falta).',
    permissoes: [['lojas', 'ver'], ['financeiro', 'ver']],
    de: 'caixas cx join locais_estoque l on l.id = cx.local_id',
    data: { expr: 'cx.aberto_em', tipo: 'timestamp', rotulo: 'abertura do caixa' },
    dimensoes: { loja_ou_local: 'l.nome', situacao: 'cx.status', ...tempo('cx.aberto_em') },
    metricas: { caixas: { expr: 'count(*)', tipo: 'numero' }, diferenca: { expr: 'sum(coalesce(cx.diferenca, 0))', tipo: 'reais' }, com_diferenca: { expr: 'count(*) filter (where coalesce(cx.diferenca, 0) <> 0)', tipo: 'numero' } },
    colunas: { loja_ou_local: 'l.nome', situacao: 'cx.status', aberto: { expr: 'cx.aberto_em', tipo: 'data' }, fechado: { expr: 'cx.fechado_em', tipo: 'data' }, diferenca: { expr: 'cx.diferenca', tipo: 'reais' }, observacao: 'cx.observacao' },
  },
};

export interface PedidoConsulta {
  conjunto: string;
  modo: 'resumo' | 'lista';
  metricas: string[];
  agruparPor: string[];
  filtros: { campo: string; operador: 'igual' | 'contem' | 'diferente'; valor: string }[];
  de?: string;
  ate?: string;
  ordenarPor?: string;
  ordem: 'asc' | 'desc';
  limite: number;
}

const col = (c: string | { expr: string }) => (typeof c === 'string' ? c : c.expr);

/** Monta a consulta só com pedaços deste arquivo; os valores dos filtros e das datas vão como parâmetros. */
export function montarConsulta(p: PedidoConsulta): { consulta: SQL; tipos: Record<string, TipoMetrica | 'data' | undefined> } {
  // Só nomes que existem de fato no catálogo (um nome como "constructor" acharia uma propriedade herdada do objeto).
  const tem = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const c = tem(CONJUNTOS, p.conjunto) ? CONJUNTOS[p.conjunto] : undefined;
  if (!c) throw new Error(`Conjunto desconhecido: ${p.conjunto}. Use: ${Object.keys(c ?? CONJUNTOS).join(', ')}.`);
  for (const d of p.agruparPor) if (!tem(c.dimensoes, d)) throw new Error(`"${d}" não é dimensão de ${p.conjunto}. Use: ${Object.keys(c.dimensoes).join(', ')}.`);
  for (const m of p.metricas) if (!tem(c.metricas, m)) throw new Error(`"${m}" não é métrica de ${p.conjunto}. Use: ${Object.keys(c.metricas).join(', ')}.`);
  for (const f of p.filtros) if (!tem(c.dimensoes, f.campo)) throw new Error(`Filtro "${f.campo}" não existe em ${p.conjunto}. Use: ${Object.keys(c.dimensoes).join(', ')}.`);
  if ((p.de || p.ate) && !c.data) throw new Error(`${p.conjunto} não tem período; filtre pelas dimensões (ex.: mes).`);
  const condicoes: SQL[] = [];
  if (c.onde) condicoes.push(sql.raw(`(${c.onde})`));
  if (c.data && (p.de || p.ate)) {
    const expr = c.data.tipo === 'timestamp' ? `(${c.data.expr} ${SP})::date` : c.data.expr;
    if (p.de) condicoes.push(sql`${sql.raw(expr)} >= ${p.de}::date`);
    if (p.ate) condicoes.push(sql`${sql.raw(expr)} <= ${p.ate}::date`);
  }
  for (const f of p.filtros) {
    const e = sql.raw(`(${c.dimensoes[f.campo]})::text`);
    if (f.operador === 'igual') condicoes.push(sql`${e} ilike ${f.valor}`);
    else if (f.operador === 'diferente') condicoes.push(sql`${e} not ilike ${f.valor}`);
    else condicoes.push(sql`${e} ilike ${'%' + f.valor.replace(/[%_]/g, (x) => '\\' + x) + '%'}`);
  }
  const onde = condicoes.length ? sql` where ${sql.join(condicoes, sql` and `)}` : sql``;
  const limite = Math.min(Math.max(p.limite, 1), 200);
  if (p.modo === 'lista') {
    const cols = Object.entries(c.colunas);
    const ordem = p.ordenarPor && tem(c.colunas, p.ordenarPor) ? col(c.colunas[p.ordenarPor]) : c.data ? c.data.expr : col(cols[0][1]);
    const consulta = sql`select ${sql.raw(cols.map(([k, v]) => `${col(v)} as "${k}"`).join(', '))} from ${sql.raw(c.de)}${onde} order by ${sql.raw(ordem)} ${sql.raw(p.ordem === 'asc' ? 'asc' : 'desc')} nulls last limit ${limite}`;
    return { consulta, tipos: Object.fromEntries(cols.map(([k, v]) => [k, typeof v === 'string' ? undefined : v.tipo])) };
  }
  const metricas = p.metricas.length ? p.metricas : [Object.keys(c.metricas)[0]];
  const sel = [...p.agruparPor.map((d) => `${c.dimensoes[d]} as "${d}"`), ...metricas.map((m) => `${c.metricas[m].expr} as "${m}"`)].join(', ');
  const grupo = p.agruparPor.length ? ` group by ${p.agruparPor.map((_, i) => i + 1).join(', ')}` : '';
  const ordemPor = p.ordenarPor && (p.agruparPor.includes(p.ordenarPor) || metricas.includes(p.ordenarPor)) ? `"${p.ordenarPor}"` : p.agruparPor.length ? `"${metricas[0]}"` : '1';
  const consulta = sql`select ${sql.raw(sel)} from ${sql.raw(c.de)}${onde}${sql.raw(grupo)} order by ${sql.raw(ordemPor)} ${sql.raw(p.ordem === 'asc' ? 'asc' : 'desc')} nulls last limit ${limite}`;
  return { consulta, tipos: Object.fromEntries(metricas.map((m) => [m, c.metricas[m].tipo])) };
}

/** Lista compacta do catálogo, para a descrição da ferramenta. */
export function catalogoConjuntos(nomes: string[]) {
  return nomes
    .map((n) => {
      const c = CONJUNTOS[n];
      return `- ${n}: ${c.descricao} Dimensões: ${Object.keys(c.dimensoes).join(', ')}. Métricas: ${Object.keys(c.metricas).join(', ')}.${c.data ? ` Período: ${c.data.rotulo}.` : ''}`;
    })
    .join('\n');
}
