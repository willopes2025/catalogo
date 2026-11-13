/**
 * Teste de ponta a ponta do fluxo do consignado, contra a API rodando.
 * Uso: API_URL=http://localhost:3100/api ADMIN_EMAIL=... ADMIN_SENHA=... node --test test/e2e.test.mjs
 * Requer um banco de TESTE com o seed de exemplos (SEED_EXEMPLOS=1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const API = process.env.API_URL ?? 'http://localhost:3100/api';
let token = '';

async function chamar(metodo, rota, corpo) {
  const r = await fetch(API + rota, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  return { status: r.status, dados };
}
const ok = async (...a) => {
  const r = await chamar(...a);
  assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.dados)}`);
  return r.dados;
};

const ctx = {};

test('login errado é recusado e rota protegida exige login', async () => {
  const r = await chamar('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, senha: 'errada' });
  assert.equal(r.status, 401);
  assert.equal((await chamar('GET', '/maletas')).status, 401);
});

test('login', async () => {
  const d = await ok('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, senha: process.env.ADMIN_SENHA });
  token = d.token;
  assert.equal(d.usuario.grupo, 'Diretoria');
});

test('cadastro de representante valida CPF e cria', async () => {
  const ruim = await chamar('POST', '/pessoas', { tipo: 'representante', nome: 'Teste CPF', documento: '111.111.111-11' });
  assert.equal(ruim.status, 400);
  assert.ok(ruim.dados.campos.documento);
  const p = await ok('POST', '/pessoas', {
    tipo: 'representante', nome: 'Representante Teste E2E', documento: '390.533.447-05', telefone1: '27999990000', email: 'teste.e2e@exemplo.com',
    cidade: 'Vitória', uf: 'ES', modeloTrabalho: 'consignado', limiteCredito: 100000,
    referencias: [{ nome: 'Referência 1', telefone: '27988887777', relacao: 'vizinha' }],
  });
  ctx.rep = p;
  assert.equal(p.slug, 'representante-teste-e2e');
  const dup = await chamar('POST', '/pessoas', { tipo: 'representante', nome: 'Duplicada', documento: '39053344705' });
  assert.equal(dup.status, 403);
});

test('maleta acima do crédito é bloqueada com o motivo', async () => {
  const locais = await ok('GET', '/estoque/locais');
  ctx.deposito = locais.find((l) => l.tipo === 'deposito');
  const prods = await ok('GET', '/produtos');
  ctx.prods = prods.itens.slice(0, 3);
  const r = await chamar('POST', '/maletas', {
    representanteId: ctx.rep.id, origemId: ctx.deposito.id,
    itens: [{ codigoBarras: ctx.prods[0].codigoBarras, quantidade: 15 }],
  });
  assert.equal(r.status, 400);
  assert.ok(r.dados.motivos.some((m) => m.includes('crédito')));
});

test('cria maleta: peças saem do depósito e vão para a maleta', async () => {
  const [a, b] = ctx.prods;
  const antes = await ok('GET', `/estoque/rastreio/${a.codigoBarras}`);
  ctx.saldoAntes = antes.porLocal.find((l) => l.tipo === 'deposito').quantidade;
  const m = await ok('POST', '/maletas', {
    representanteId: ctx.rep.id, origemId: ctx.deposito.id,
    dataRetirada: '2026-10-01',
    itens: [{ codigoBarras: a.codigoBarras, quantidade: 2 }, { codigoBarras: b.codigoBarras, quantidade: 1 }, { codigoBarras: a.codigoBarras, quantidade: 1 }],
  });
  ctx.maleta = m;
  assert.equal(m.dataLimite, '2026-10-31');
  assert.ok(m.promissoriaId, 'promissória gerada junto com a maleta');
  const det = await ok('GET', `/maletas/${m.id}`);
  assert.equal(det.totais.pecas, 4);
  assert.equal(det.itens.find((i) => i.codigoBarras === a.codigoBarras).enviada, 3, 'leituras repetidas somam');
  const depois = await ok('GET', `/estoque/rastreio/${a.codigoBarras}`);
  assert.equal(depois.porLocal.find((l) => l.tipo === 'deposito').quantidade, ctx.saldoAntes - 3);
  assert.equal(depois.porLocal.find((l) => l.tipo === 'maleta').quantidade, 3);
});

test('segunda maleta é bloqueada (máximo de 1 aberta)', async () => {
  const r = await chamar('POST', '/maletas', { representanteId: ctx.rep.id, origemId: ctx.deposito.id, itens: [{ codigoBarras: ctx.prods[2].codigoBarras, quantidade: 1 }] });
  assert.equal(r.status, 400);
});

test('troca no meio do ciclo: inclui e retira peças', async () => {
  await ok('POST', `/maletas/${ctx.maleta.id}/incluir`, { itens: [{ codigoBarras: ctx.prods[2].codigoBarras, quantidade: 1 }] });
  await ok('POST', `/maletas/${ctx.maleta.id}/retirar`, { itens: [{ codigoBarras: ctx.prods[1].codigoBarras, quantidade: 1 }] });
  const det = await ok('GET', `/maletas/${ctx.maleta.id}`);
  assert.equal(det.totais.pecas, 4);
  ctx.det = det;
});

test('link do pedido: representante vê a maleta, confirma e faz pré-baixa', async () => {
  const salvo = token;
  token = '';
  const pub = await ok('GET', `/publico/maletas/${ctx.maleta.linkToken}`);
  assert.equal(pub.itens.length, 2);
  assert.ok(!('custo' in pub.itens[0]), 'link público não mostra custo');
  await ok('POST', `/publico/maletas/${ctx.maleta.linkToken}/recebida`);
  const a = ctx.det.itens.find((i) => i.codigoBarras === ctx.prods[0].codigoBarras);
  await ok('POST', `/publico/maletas/${ctx.maleta.linkToken}/prebaixa`, { itens: [{ produtoId: a.produtoId, vendida: 2 }] });
  assert.equal((await chamar('GET', '/publico/maletas/token-invalido-xxxxxxxxxxxx')).status, 404);
  token = salvo;
});

test('acerto com 10 dias de atraso, parcelado em 2, com peça perdida', async () => {
  const a = ctx.det.itens.find((i) => i.codigoBarras === ctx.prods[0].codigoBarras);
  const c = ctx.det.itens.find((i) => i.codigoBarras === ctx.prods[2].codigoBarras);
  const dados = {
    forma: 'prazo', modalidade: 'presencial', dataAcerto: '2026-11-10', parcelas: 2, primeiroVencimento: '2026-11-20', formaPagamento: 'boleto',
    itens: [
      { produtoId: a.produtoId, vendida: 2, devolvida: 1, perdida: 0 },
      { produtoId: c.produtoId, vendida: 0, devolvida: 0, perdida: 1 },
    ],
  };
  const sim = await ok('POST', `/maletas/${ctx.maleta.id}/simular-acerto`, dados);
  const vendido = a.preco * 2;
  const comissao = Math.round(vendido * 0.25);
  const base = vendido - comissao + c.custo;
  assert.equal(sim.resultado.diasAtraso, 10);
  assert.equal(sim.resultado.comissao, comissao);
  assert.equal(sim.resultado.perdidas, c.custo);
  assert.equal(sim.resultado.multa, Math.round(base * 0.02));
  assert.equal(sim.resultado.juros, Math.round((base * 100 * 10) / 300000));
  assert.equal(sim.limiteNovo, 100000, 'com atraso de 10 dias o limite cai para o inicial (R$ 1.500) ou mantém o menor');

  // a simulação não grava nada
  const aindaAberta = await ok('GET', `/maletas/${ctx.maleta.id}`);
  assert.equal(aindaAberta.status, 'aberta');

  const r = await ok('POST', `/maletas/${ctx.maleta.id}/acerto`, dados);
  assert.equal(r.fechou, true);
  assert.equal(r.parcelas.length, 2);
  assert.equal(r.parcelas[0].valor + r.parcelas[1].valor, sim.resultado.totalAPagar);
  ctx.total = sim.resultado.totalAPagar;
  ctx.produtoA = a;
});

test('depois do acerto: estoque, financeiro e maleta conferem', async () => {
  const det = await ok('GET', `/maletas/${ctx.maleta.id}`);
  assert.equal(det.status, 'acertada');
  assert.equal(det.totais.pecas, 0);
  const rast = await ok('GET', `/estoque/rastreio/${ctx.prods[0].codigoBarras}`);
  assert.equal(rast.porLocal.find((l) => l.tipo === 'deposito').quantidade, ctx.saldoAntes - 2, 'só as 2 vendidas saíram do estoque');
  assert.ok(!rast.porLocal.some((l) => l.tipo === 'maleta'), 'nada ficou na maleta');
  const tit = await ok('GET', `/financeiro/titulos?pessoaId=${ctx.rep.id}`);
  assert.equal(tit.itens.length, 2);
  assert.equal(tit.total, ctx.total);
  await ok('POST', `/financeiro/titulos/${tit.itens[0].id}/baixar`, { pagoEm: '2026-11-20' });
  const t2 = await ok('GET', `/financeiro/titulos?pessoaId=${ctx.rep.id}`);
  assert.equal(t2.itens.length, 1);
});

test('acerto completo recusa peça sem destino', async () => {
  const m = await ok('POST', '/maletas', { representanteId: ctx.rep.id, origemId: ctx.deposito.id, itens: [{ codigoBarras: ctx.prods[1].codigoBarras, quantidade: 2 }] });
  const det = await ok('GET', `/maletas/${m.id}`);
  const r = await chamar('POST', `/maletas/${m.id}/acerto`, { forma: 'avista', itens: [{ produtoId: det.itens[0].produtoId, vendida: 1, devolvida: 0, perdida: 0 }] });
  assert.equal(r.status, 400);
  assert.match(r.dados.mensagem, /sem destino/);
  await ok('POST', `/maletas/${m.id}/cancelar`, { motivo: 'teste automático' });
  const c = await ok('GET', `/maletas/${m.id}`);
  assert.equal(c.status, 'cancelada');
});

test('painel Início responde com os indicadores', async () => {
  const d = await ok('GET', '/painel/inicio');
  assert.ok(typeof d.maletas.abertas === 'number');
  assert.ok(d.mes.acertos >= 1);
});

// ───────────── Semana 2 ─────────────

test('promissória da maleta traz valor por extenso e dados da representante', async () => {
  const doc = await ok('GET', `/documentos/${ctx.maleta.promissoriaId}`);
  assert.equal(doc.tipo, 'promissoria');
  assert.match(doc.conteudo, /Maleta|maleta nº/);
  assert.match(doc.conteudo, /reais/);
  assert.match(doc.conteudo, /390\.533\.447-05/);
  assert.equal(doc.hash.length, 64);
});

test('contrato: geração, código por e-mail e assinatura com evidências', async () => {
  const doc = await ok('POST', '/documentos', { pessoaId: ctx.rep.id, tipo: 'contrato' });
  assert.match(doc.conteudo, /30%/, 'comissão à vista das regras entra no texto');
  assert.ok(!doc.conteudo.includes('{{'), 'nenhuma variável sobrando');
  const salvo = token;
  token = '';
  const pub = await ok('GET', `/publico/documentos/${doc.token}`);
  assert.equal(pub.status, 'pendente');
  assert.equal(pub.emailMascarado, 'te***@exemplo.com');
  const c = await ok('POST', `/publico/documentos/${doc.token}/codigo`);
  assert.match(c.codigoDev, /^\d{6}$/);
  const repetido = await chamar('POST', `/publico/documentos/${doc.token}/codigo`);
  assert.equal(repetido.status, 400, 'não deixa pedir código em sequência');
  const errado = await chamar('POST', `/publico/documentos/${doc.token}/assinar`, { codigo: c.codigoDev === '000000' ? '111111' : '000000', nome: 'Representante Teste E2E', cpf: '39053344705', aceite: true });
  assert.equal(errado.status, 400);
  assert.match(errado.dados.mensagem, /incorreto/);
  const nomeErrado = await chamar('POST', `/publico/documentos/${doc.token}/assinar`, { codigo: c.codigoDev, nome: 'Outra Pessoa', cpf: '39053344705', aceite: true });
  assert.match(nomeErrado.dados.mensagem, /nome completo/);
  const cpfErrado = await chamar('POST', `/publico/documentos/${doc.token}/assinar`, { codigo: c.codigoDev, nome: 'representante teste e2e', cpf: '52998224725', aceite: true });
  assert.match(cpfErrado.dados.mensagem, /CPF/);
  const ass = await ok('POST', `/publico/documentos/${doc.token}/assinar`, { codigo: c.codigoDev, nome: 'representante teste E2E', cpf: '390.533.447-05', aceite: true });
  assert.equal(ass.hash, doc.hash);
  const de_novo = await chamar('POST', `/publico/documentos/${doc.token}/assinar`, { codigo: c.codigoDev, nome: 'Representante Teste E2E', cpf: '39053344705', aceite: true });
  assert.equal(de_novo.status, 400);
  token = salvo;
  const final = await ok('GET', `/documentos/${doc.id}`);
  assert.equal(final.status, 'assinado');
  assert.ok(final.ip && final.assinadoEm && final.userAgent !== undefined);
  assert.ok(!('codigoHash' in final), 'hash do código nunca sai da API');
});

test('modelo com variável desconhecida é recusado', async () => {
  const r = await chamar('POST', '/documentos/modelos', { tipo: 'aditivo', titulo: 'Aditivo', conteudo: 'Texto do aditivo com {{variavel_que_nao_existe}} e mais texto.' });
  assert.equal(r.status, 400);
  assert.match(r.dados.campos.conteudo, /variavel_que_nao_existe/);
});

test('catálogo público mostra as peças da maleta, sem custo', async () => {
  const m = await ok('POST', '/maletas', { representanteId: ctx.rep.id, origemId: ctx.deposito.id, itens: [{ codigoBarras: ctx.prods[0].codigoBarras, quantidade: 1 }] });
  ctx.maleta3 = m;
  const salvo = token;
  token = '';
  const cat = await ok('GET', '/publico/catalogo/representante-teste-e2e');
  assert.equal(cat.pecas.length, 1);
  assert.ok(!('custo' in cat.pecas[0]));
  assert.ok(!('documento' in cat.representante) && !('id' in cat.representante));
  assert.equal((await chamar('GET', '/publico/catalogo/nao-existe')).status, 404);
  token = salvo;
});

test('nível com comissão própria muda a conta do acerto', async () => {
  const n = await ok('POST', '/niveis', { nome: 'Diamante E2E', ordem: 9, metaMensal: 0, comissaoAvistaPb: 4000, comissaoPrazoPb: 3500 });
  await ok('PATCH', `/pessoas/${ctx.rep.id}`, { nivelId: n.id });
  const det = await ok('GET', `/maletas/${ctx.maleta3.id}`);
  const sim = await ok('POST', `/maletas/${ctx.maleta3.id}/simular-acerto`, { forma: 'avista', itens: [{ produtoId: det.itens[0].produtoId, vendida: 1, devolvida: 0, perdida: 0 }] });
  assert.equal(sim.resultado.comissaoPb, 4000);
  await ok('POST', `/maletas/${ctx.maleta3.id}/cancelar`, { motivo: 'fim do teste' });
});

test('usuário do Financeiro: senha provisória e permissões por módulo', async () => {
  const grupos = await ok('GET', '/grupos');
  const fin = grupos.find((g) => g.nome === 'Financeiro');
  const u = await ok('POST', '/usuarios', { nome: 'Financeiro Teste', email: 'fin.teste@aritana.local', grupoId: fin.id });
  assert.ok(u.senhaProvisoria.length >= 10);
  const salvo = token;
  const login = await ok('POST', '/auth/login', { email: 'fin.teste@aritana.local', senha: u.senhaProvisoria });
  token = login.token;
  await ok('GET', '/financeiro/titulos');
  assert.equal((await chamar('POST', '/maletas', { representanteId: ctx.rep.id, origemId: ctx.deposito.id, itens: [{ codigoBarras: 'x', quantidade: 1 }] })).status, 403);
  assert.equal((await chamar('GET', '/usuarios')).status, 403);
  token = salvo;
});

test('Assertiva sem credenciais avisa em vez de falhar', async () => {
  const r = await chamar('GET', '/integracoes/assertiva/cpf/39053344705');
  assert.equal(r.status, 503);
  assert.match(r.dados.mensagem, /credenciais/);
  const st = await ok('GET', '/integracoes/status');
  assert.equal(st.find((i) => i.chave === 'assertiva').ligada, false);
});

// ───────────── Semana 3 ─────────────

const SIM = 'http://localhost:3199';
const recebidos = async () => (await fetch(SIM + '/__recebidos')).json();

test('empresas com CNPJ para as notas', async () => {
  const emps = await ok('GET', '/empresas');
  for (const e of emps) await ok('PATCH', `/empresas/${e.id}`, { razaoSocial: `${e.nome} Ltda`, cnpj: '11.222.333/0001-81', cidade: 'Vitória', uf: 'ES' });
  const ruim = await chamar('PATCH', `/empresas/${emps[0].id}`, { cnpj: '11.111.111/1111-11' });
  assert.equal(ruim.status, 400);
});

test('caixa da loja: abrir uma vez só', async () => {
  const locais = await ok('GET', '/estoque/locais');
  ctx.loja = locais.find((l) => l.tipo === 'loja');
  const c = await ok('POST', '/caixas/abrir', { localId: ctx.loja.id, valorAbertura: 10000 });
  ctx.caixa = c;
  assert.equal((await chamar('POST', '/caixas/abrir', { localId: ctx.loja.id, valorAbertura: 0 })).status, 400);
  const atual = await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`);
  assert.equal(atual.porForma.dinheiro, 10000);
});

test('venda no balcão com desconto, dinheiro com troco e Pix', async () => {
  const prods = (await ok('GET', '/produtos')).itens;
  ctx.pv = prods.slice(10, 13);
  const [a, b] = ctx.pv;
  const antesA = (await ok('GET', `/estoque/rastreio/${a.codigoBarras}`)).porLocal.find((l) => l.tipo === 'loja').quantidade;
  const subtotal = a.preco * 2 + b.preco;
  const desconto = Math.round(subtotal * 0.05);
  const total = subtotal - desconto;
  const pix = 5000;
  const v = await ok('POST', '/vendas', {
    localId: ctx.loja.id, tipo: 'balcao', descontoTotal: desconto,
    itens: [{ codigoBarras: a.codigoBarras, quantidade: 1 }, { codigoBarras: b.codigoBarras, quantidade: 1 }, { codigoBarras: a.codigoBarras, quantidade: 1 }],
    pagamentos: [{ forma: 'pix', valor: pix }, { forma: 'dinheiro', valor: total - pix + 1000 }],
  });
  assert.equal(v.total, total);
  assert.equal(v.troco, 1000);
  ctx.venda1 = v;
  const depois = (await ok('GET', `/estoque/rastreio/${a.codigoBarras}`)).porLocal.find((l) => l.tipo === 'loja').quantidade;
  assert.equal(depois, antesA - 2, 'leituras repetidas somam e baixam do estoque da loja');
  const caixa = await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`);
  assert.equal(caixa.porForma.dinheiro, 10000 + total - pix, 'caixa recebe o dinheiro líquido do troco');
  assert.equal(caixa.porForma.pix, pix);
});

test('venda recusada: falta pagamento, troco sem dinheiro e desconto acima do limite', async () => {
  const [a] = ctx.pv;
  const falta = await chamar('POST', '/vendas', { localId: ctx.loja.id, itens: [{ codigoBarras: a.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'pix', valor: a.preco - 1 }] });
  assert.match(falta.dados.mensagem, /Falta receber/);
  const troco = await chamar('POST', '/vendas', { localId: ctx.loja.id, itens: [{ codigoBarras: a.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'debito', valor: a.preco + 500 }] });
  assert.match(troco.dados.mensagem, /troco/);
  const grupos = await ok('GET', '/grupos');
  const u = await ok('POST', '/usuarios', { nome: 'Vendedora Loja', email: 'loja.teste@aritana.local', grupoId: grupos.find((g) => g.nome === 'Loja').id });
  const salvo = token;
  token = (await ok('POST', '/auth/login', { email: 'loja.teste@aritana.local', senha: u.senhaProvisoria })).token;
  const desc = await chamar('POST', '/vendas', { localId: ctx.loja.id, descontoTotal: Math.round(a.preco * 0.5), itens: [{ codigoBarras: a.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'pix', valor: a.preco }] });
  assert.equal(desc.status, 403);
  assert.match(desc.dados.mensagem, /limite/);
  token = salvo;
});

test('NFC-e da venda sai autorizada pelo emissor', async () => {
  const n = await ok('POST', `/fiscal/nfce/venda/${ctx.venda1.id}`);
  assert.equal(n.status, 'autorizada');
  assert.ok(n.chave && n.urlDanfe.startsWith('http'));
  const env = (await recebidos()).filter((r) => r.caminho.startsWith('/focus/v2/nfce')).pop().corpo;
  assert.equal(env.cnpj_emitente, '11222333000181');
  const somaItens = env.items.reduce((a, i) => a + Math.round(Number(i.valor_bruto) * 100) - Math.round(Number(i.valor_desconto ?? 0) * 100), 0);
  assert.equal(somaItens, ctx.venda1.total, 'desconto geral rateado nos itens');
  const somaPag = env.formas_pagamento.reduce((a, p) => a + Math.round(Number(p.valor_pagamento) * 100), 0);
  assert.equal(somaPag, ctx.venda1.total);
  assert.equal((await chamar('POST', `/fiscal/nfce/venda/${ctx.venda1.id}`)).status, 400, 'não emite nota duplicada');
});

test('devolução vira crédito e o crédito paga outra venda', async () => {
  const clientes = (await ok('GET', '/pessoas?tipo=cliente')).itens;
  ctx.cliente = clientes[0];
  const [, , c] = ctx.pv;
  const v = await ok('POST', '/vendas', { localId: ctx.loja.id, clienteId: ctx.cliente.id, itens: [{ codigoBarras: c.codigoBarras, quantidade: 2 }], pagamentos: [{ forma: 'credito', valor: c.preco * 2, parcelas: 2, maquininha: 'Stone' }] });
  const det = await ok('GET', `/vendas/${v.id}`);
  const titCartao = (await ok('GET', '/financeiro/titulos?tipo=receber')).itens.filter((t) => t.descricao.startsWith(`Venda nº ${v.numero}`));
  assert.equal(titCartao.length, 2, 'crédito em 2x vira 2 previsões de recebimento');
  assert.ok(titCartao.every((t) => t.pessoaId === null && /Stone/.test(t.descricao)), 'cartão é cobrado da maquininha, não da cliente');
  assert.equal((await chamar('POST', `/financeiro/titulos/${titCartao[0].id}/cobranca`, { tipo: 'PIX' })).status, 400);
  const d = await ok('POST', `/vendas/${v.id}/devolver`, { itens: [{ produtoId: det.itens[0].produtoId, quantidade: 1 }], destino: 'credito' });
  assert.equal(d.valor, c.preco);
  const mais = await chamar('POST', `/vendas/${v.id}/devolver`, { itens: [{ produtoId: det.itens[0].produtoId, quantidade: 2 }], destino: 'credito' });
  assert.match(mais.dados.mensagem, /Só 1/);
  const v2 = await ok('POST', '/vendas', { localId: ctx.loja.id, clienteId: ctx.cliente.id, itens: [{ codigoBarras: c.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'credito_loja', valor: c.preco }] });
  assert.equal(v2.total, c.preco);
  const semSaldo = await chamar('POST', '/vendas', { localId: ctx.loja.id, clienteId: ctx.cliente.id, itens: [{ codigoBarras: c.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'credito_loja', valor: c.preco }] });
  assert.match(semSaldo.dados.mensagem, /crédito/);
});

test('cancelamento no mesmo dia devolve estoque e estorna o caixa', async () => {
  const [a] = ctx.pv;
  const antes = await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`);
  const v = await ok('POST', '/vendas', { localId: ctx.loja.id, itens: [{ codigoBarras: a.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'dinheiro', valor: a.preco }] });
  await ok('POST', `/vendas/${v.id}/cancelar`, { motivo: 'cliente desistiu' });
  const depois = await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`);
  assert.equal(depois.porForma.dinheiro, antes.porForma.dinheiro);
  assert.equal((await ok('GET', `/vendas/${v.id}`)).status, 'cancelada');
});

test('sangria e fechamento do caixa batem forma por forma', async () => {
  const atual = await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`);
  assert.equal((await chamar('POST', `/caixas/${ctx.caixa.id}/movimento`, { tipo: 'sangria', valor: atual.porForma.dinheiro + 1, descricao: 'teste' })).status, 400);
  await ok('POST', `/caixas/${ctx.caixa.id}/movimento`, { tipo: 'sangria', valor: 5000, descricao: 'Depósito no banco' });
  const fim = await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`);
  const contado = { ...fim.porForma };
  contado.dinheiro -= 200; // faltaram R$ 2,00
  const f = await ok('POST', `/caixas/${ctx.caixa.id}/fechar`, { contado });
  assert.equal(f.status, 'fechado');
  assert.equal(f.diferenca, -200);
  assert.equal((await ok('GET', `/caixas/atual?localId=${ctx.loja.id}`)).aberto, false);
});

test('Asaas: Pix gerado para o título e baixa automática pelo aviso de pagamento', async () => {
  const tit = await ok('GET', `/financeiro/titulos?pessoaId=${ctx.rep.id}`);
  const t = tit.itens[0];
  const c = await ok('POST', `/financeiro/titulos/${t.id}/cobranca`, { tipo: 'PIX' });
  assert.match(c.url, /asaas\.com/);
  assert.match(c.pixCopiaCola, /^00020126/);
  const env = (await recebidos()).filter((r) => r.caminho === '/asaas/payments').pop().corpo;
  assert.equal(env.value, t.valor / 100);
  assert.equal(env.externalReference, t.id);
  const de_novo = await ok('POST', `/financeiro/titulos/${t.id}/cobranca`, { tipo: 'PIX' });
  assert.equal(de_novo.jaExistia, true, 'não cria cobrança duplicada');

  const salvo = token;
  token = '';
  const evento = { id: 'evt_teste_1', event: 'PAYMENT_RECEIVED', payment: { id: c.id, value: t.valor / 100, paymentDate: '2026-11-25', externalReference: t.id } };
  const r0 = await fetch(API + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'errado' }, body: JSON.stringify(evento) });
  assert.equal(r0.status, 401);
  const r1 = await (await fetch(API + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'token-webhook-teste' }, body: JSON.stringify(evento) })).json();
  assert.equal(r1.resultado, 'baixado');
  const r2 = await (await fetch(API + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'token-webhook-teste' }, body: JSON.stringify(evento) })).json();
  assert.equal(r2.repetido, true);
  token = salvo;
  const pagos = await ok('GET', `/financeiro/titulos?pessoaId=${ctx.rep.id}&aba=pagos`);
  assert.ok(pagos.itens.some((x) => x.id === t.id && x.pagoEm === '2026-11-25'));
});

test('NF-e de remessa da maleta: exige endereço, depois processa e autoriza', async () => {
  const m = await ok('POST', '/maletas', { representanteId: ctx.rep.id, origemId: ctx.deposito.id, itens: [{ codigoBarras: ctx.prods[1].codigoBarras, quantidade: 1 }] });
  const sem = await chamar('POST', `/fiscal/nfe/maleta/${m.id}`);
  assert.match(sem.dados.mensagem, /endereço/);
  await ok('PATCH', `/pessoas/${ctx.rep.id}`, { logradouro: 'Rua das Flores', numero: '10', bairro: 'Centro', cidade: 'Vitória', uf: 'ES', cep: '29000000' });
  const n = await ok('POST', `/fiscal/nfe/maleta/${m.id}`);
  assert.equal(n.status, 'processando');
  const env = (await recebidos()).filter((r) => r.caminho.startsWith('/focus/v2/nfe?')).pop().corpo;
  assert.equal(env.items[0].cfop, '5917', 'CFOP de remessa em consignação dentro do estado');
  assert.equal(env.cpf_destinatario, '39053344705');
  const c = await ok('POST', `/fiscal/notas/${n.id}/consultar`);
  assert.equal(c.status, 'autorizada');
  await ok('POST', `/maletas/${m.id}/cancelar`, { motivo: 'fim do teste' });
});

test('relatórios de desempenho, produtos (curva ABC), vendas e financeiro', async () => {
  const d = await ok('GET', '/relatorios/desempenho?de=2026-01-01&ate=2026-12-31');
  const linha = d.linhas.find((l) => l.id === ctx.rep.id);
  assert.ok(linha && linha.vendido > 0 && linha.acertos >= 1);
  const p = await ok('GET', '/relatorios/produtos');
  assert.ok(p.linhas.some((l) => l.curva === 'A'));
  const v = await ok('GET', '/relatorios/vendas');
  assert.ok(v.porForma.some((f) => f.forma === 'pix'));
  const f = await ok('GET', '/relatorios/financeiro');
  assert.ok(Array.isArray(f.fluxo) && Array.isArray(f.faixas));
  const mal = await ok('GET', '/relatorios/maletas');
  assert.ok(Array.isArray(mal.semMaleta));
});

test('suporte: abrir chamado e responder', async () => {
  const c = await ok('POST', '/suporte/chamados', { titulo: 'Dúvida sobre o acerto parcial', tipo: 'duvida', modulo: 'maletas', descricao: 'Como faço acerto parcial por vídeo?' });
  await ok('POST', `/suporte/chamados/${c.id}/mensagens`, { texto: 'Complementando: a representante está em outra cidade.' });
  const det = await ok('GET', `/suporte/chamados/${c.id}`);
  assert.equal(det.mensagens.length, 2);
  const st = await ok('GET', '/suporte/status');
  assert.ok(st.sistema.ok);
});

test('importação do Jueri: simula sem gravar, importa, e reimportar só atualiza', async () => {
  const planilha = [
    { 'Cód. de barras': '7899990000011', 'Referência': 'JU001', 'Descrição': 'Brinco Jueri Teste', 'Categoria': 'Categoria Importada', 'Preço': 'R$ 89,90', 'Custo': '25,00', 'Estoque': '7', 'NCM': '7117.19.00', 'Fornecedor': 'Fornecedor Importado' },
    { 'Cód. de barras': '7899990000028', 'Referência': 'JU002', 'Descrição': 'Colar Jueri Teste', 'Categoria': 'Colares', 'Preço': '149.9', 'Custo': '40', 'Estoque': '3' },
    { 'Cód. de barras': '', 'Referência': '', 'Descrição': 'Linha ruim', 'Preço': '' },
  ];
  const sim = await ok('POST', '/importacao/produtos', { linhas: planilha, localId: ctx.deposito.id, simular: true });
  assert.equal(sim.criados, 2);
  assert.equal(sim.erros.length, 1);
  assert.equal(sim.erros[0].linha, 4);
  assert.equal((await chamar('GET', '/produtos/codigo/7899990000011')).status, 404, 'simulação não grava');
  const real = await ok('POST', '/importacao/produtos', { linhas: planilha, localId: ctx.deposito.id, simular: false, arquivo: 'produtos-jueri.xlsx' });
  assert.equal(real.criados, 2);
  const p = await ok('GET', '/produtos/codigo/7899990000011');
  assert.equal(p.preco, 8990);
  assert.equal(p.ncm, '71171900');
  const rast = await ok('GET', '/estoque/rastreio/7899990000011');
  assert.equal(rast.porLocal.find((l) => l.tipo === 'deposito').quantidade, 7);
  planilha[0]['Preço'] = '99,90';
  planilha[0]['Estoque'] = '5';
  const de_novo = await ok('POST', '/importacao/produtos', { linhas: planilha.slice(0, 2), localId: ctx.deposito.id, simular: false });
  assert.equal(de_novo.criados, 0);
  assert.equal(de_novo.atualizados, 2);
  assert.equal((await ok('GET', '/produtos/codigo/7899990000011')).preco, 9990);
  assert.equal((await ok('GET', '/estoque/rastreio/7899990000011')).porLocal.find((l) => l.tipo === 'deposito').quantidade, 5, 'estoque fica igual à planilha');

  const reps = [
    { Nome: 'Líder Importada', CPF: '153.509.460-56', 'Telefone 1': '(27) 99999-1111', Cidade: 'Vitória', UF: 'ES', 'Nível': 'Ouro', Status: 'Ativo' },
    { Nome: 'Rede Importada', CPF: '', 'Telefone 1': '27999992222', Cidade: 'Serra', UF: 'ES', 'Revendedor líder': 'Líder Importada', 'Nível': 'Nível Novo' },
    { Nome: 'CPF Errado', CPF: '123.456.789-00' },
  ];
  const ir = await ok('POST', '/importacao/pessoas', { tipo: 'representante', linhas: reps, simular: false });
  assert.equal(ir.criados, 2);
  assert.equal(ir.erros.length, 1);
  const lista = await ok('GET', '/pessoas?tipo=representante&busca=Importada');
  const rede = lista.itens.find((x) => x.nome === 'Rede Importada');
  assert.equal(rede.lider, 'Líder Importada');
  assert.equal(rede.nivel, 'Nível Novo');
});
