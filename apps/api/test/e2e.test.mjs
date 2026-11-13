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
  assert.equal(login.trocarSenha, true);
  const bloq = await chamar('GET', '/financeiro/titulos');
  assert.equal(bloq.status, 403, 'senha provisória bloqueia até trocar');
  assert.equal(bloq.dados.trocarSenha, true);
  await ok('POST', '/auth/trocar-senha', { atual: u.senhaProvisoria, nova: 'SenhaDoFinanceiro2026' });
  ctx.finId = u.id;
  ctx.finToken = token;
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
  await ok('POST', '/auth/trocar-senha', { atual: u.senhaProvisoria, nova: 'SenhaDaLoja20260' });
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

test('inventário: ajuste pela contagem registra só as diferenças', async () => {
  const p = ctx.pv[2];
  const saldo = (await ok('GET', `/estoque/rastreio/${p.codigoBarras}`)).porLocal.find((l) => l.tipo === 'loja').quantidade;
  const r = await ok('POST', '/estoque/ajustes', { localId: ctx.loja.id, motivo: 'Inventário de teste', itens: [{ codigoBarras: p.codigoBarras, quantidadeContada: saldo + 2 }] });
  assert.equal(r.diferencas.length, 1);
  assert.equal(r.diferencas[0].depois, saldo + 2);
  const igual = await ok('POST', '/estoque/ajustes', { localId: ctx.loja.id, motivo: 'Recontagem', itens: [{ codigoBarras: p.codigoBarras, quantidadeContada: saldo + 2 }] });
  assert.equal(igual.diferencas.length, 0);
});

test('lotes de banho', async () => {
  await ok('POST', '/lotes', { codigo: 'LOTE-E2E-01', fabricacao: '2026-10-01' });
  assert.ok((await ok('GET', '/lotes')).some((l) => l.codigo === 'LOTE-E2E-01'));
});

test('garantia: troca da peça da venda, prazo calculado e estoque movido', async () => {
  const [a] = ctx.pv;
  const outra = (await ok('GET', '/produtos')).itens[20];
  const sem = await chamar('POST', '/garantia/ordens', { tipo: 'garantia', codigoProduto: outra.codigoBarras, vendaId: ctx.venda1.id, defeito: 'Fecho quebrou' });
  assert.equal(sem.status, 400, 'peça que não é da venda é recusada');
  const os = await ok('POST', '/garantia/ordens', { tipo: 'garantia', codigoProduto: a.codigoBarras, vendaId: ctx.venda1.id, defeito: 'Banho descascando' });
  assert.equal(os.foraDoPrazo, false);
  assert.ok(os.garantiaAte > os.dataCompra);
  const antes = (await ok('GET', `/estoque/rastreio/${a.codigoBarras}`)).porLocal.find((l) => l.tipo === 'loja').quantidade;
  const semMotivo = await chamar('POST', `/garantia/ordens/${os.id}/decisao`, { decisao: 'recusada' });
  assert.equal(semMotivo.status, 400);
  const d = await ok('POST', `/garantia/ordens/${os.id}/decisao`, { decisao: 'troca', codigoTroca: a.codigoBarras, localId: ctx.loja.id });
  assert.equal(d.status, 'concluida');
  const rastreio = await ok('GET', `/estoque/rastreio/${a.codigoBarras}`);
  assert.equal(rastreio.porLocal.find((l) => l.tipo === 'loja').quantidade, antes - 1, 'peça nova saiu da loja');
  assert.equal(rastreio.porLocal.find((l) => l.local === 'Avarias e garantia').quantidade, 1, 'peça com defeito foi para avarias');
});

test('conserto pago: assistência, conclusão e recebimento no financeiro', async () => {
  const assist = (await ok('GET', '/pessoas?tipo=assistencia')).itens[0];
  const s = await ok('POST', '/garantia/servicos', { descricao: 'Solda de corrente', valor: 3500 });
  const os = await ok('POST', '/garantia/ordens', { tipo: 'conserto', defeito: 'Corrente partida', servicoId: s.id, valor: 3500 });
  await ok('POST', `/garantia/ordens/${os.id}/assistencia`, { prestadorId: assist.id, previsao: '2026-12-31' });
  const fim = await ok('POST', `/garantia/ordens/${os.id}/concluir`, { valorPago: 3500, formaPagamento: 'pix' });
  assert.equal(fim.status, 'concluida');
  const abertas = await ok('GET', '/garantia/ordens?status=abertas');
  assert.ok(!abertas.some((o) => o.id === os.id));
});

test('comissões: prévia, fechamento gera contas a pagar, reabrir cancela', async () => {
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const c = await ok('GET', `/comissoes?mes=${mes}`);
  const minha = c.linhas.find((l) => l.tipo === 'loja');
  assert.ok(minha && minha.base > 0, 'vendas do balcão entram na base');
  assert.equal(minha.valor, Math.round((minha.base * minha.percentualPb) / 10000));
  const f = await ok('POST', '/comissoes/fechar', { mes });
  assert.ok(f.linhas >= 1);
  assert.equal((await chamar('POST', '/comissoes/fechar', { mes })).status, 400);
  assert.equal((await ok('GET', `/comissoes?mes=${mes}`)).fechado, true);
  await ok('POST', '/comissoes/reabrir', { mes });
  assert.equal((await ok('GET', `/comissoes?mes=${mes}`)).fechado, false);
});

test('avisos: resumo para a equipe sai uma vez só', async () => {
  const cfg = await ok('GET', '/configuracoes/chave/avisos');
  await ok('PUT', '/configuracoes/chave/avisos', { ...cfg, emailsEquipe: ['equipe@exemplo.com'] });
  assert.equal((await chamar('PUT', '/configuracoes/chave/avisos', { ...cfg, hora: 30 })).status, 400);
  const r1 = await ok('POST', '/avisos/executar');
  assert.ok(r1.enviados >= 1);
  const r2 = await ok('POST', '/avisos/executar');
  assert.equal(r2.enviados, 0);
  assert.ok((await ok('GET', '/avisos/historico')).some((a) => a.para === 'equipe@exemplo.com'));
});

test('auditoria registra e filtra', async () => {
  const r = await ok('GET', '/auditoria?entidade=ordem_servico');
  assert.ok(r.linhas.length >= 2);
  assert.ok(r.linhas.every((l) => l.entidade === 'ordem_servico'));
  const f = await ok('GET', '/auditoria/filtros');
  assert.ok(f.entidades.includes('comissoes'));
});


test('revisão: usuário desativado perde o acesso na hora', async () => {
  await ok('PATCH', `/usuarios/${ctx.finId}`, { ativo: false });
  const salvo = token;
  token = ctx.finToken;
  assert.equal((await chamar('GET', '/financeiro/titulos')).status, 401);
  token = salvo;
  await ok('PATCH', `/usuarios/${ctx.finId}`, { ativo: true });
});

test('revisão: ninguém se dá mais acesso do que tem', async () => {
  const g = await ok('POST', '/grupos', { nome: 'Gerência teste', permissoes: { configuracoes: ['ver', 'criar', 'editar'], financeiro: ['ver'] } });
  const u = await ok('POST', '/usuarios', { nome: 'Gerente Teste', email: 'gerente.teste@aritana.local', grupoId: g.id });
  const salvo = token;
  token = (await ok('POST', '/auth/login', { email: 'gerente.teste@aritana.local', senha: u.senhaProvisoria })).token;
  await ok('POST', '/auth/trocar-senha', { atual: u.senhaProvisoria, nova: 'SenhaDoGerente2026' });
  const diretoria = (await ok('GET', '/grupos')).find((x) => x.nome === 'Diretoria');
  assert.equal((await chamar('PATCH', `/usuarios/${u.id}`, { grupoId: diretoria.id })).status, 403, 'não se coloca na Diretoria');
  assert.equal((await chamar('POST', '/grupos', { nome: 'Total', permissoes: { '*': ['*'] } })).status, 403, 'não cria grupo com tudo');
  assert.equal((await chamar('PATCH', `/grupos/${g.id}`, { permissoes: { configuracoes: ['*'], maletas: ['*'] } })).status, 403, 'não aumenta o próprio grupo');
  token = salvo;
});

test('revisão: data impossível e local de maleta são recusados', async () => {
  const r = await chamar('POST', '/financeiro/titulos', { empresaId: (await ok('GET', '/empresas'))[0].id, tipo: 'pagar', descricao: 'Teste', valor: 1000, vencimento: '2026-02-31' });
  assert.equal(r.status, 400);
  const maletaLocal = (await ok('GET', '/estoque/locais?incluirMaletas=1')).find((l) => l.tipo === 'maleta');
  const p = (await ok('GET', '/produtos')).itens[0];
  assert.equal((await chamar('POST', '/estoque/ajustes', { localId: maletaLocal.id, motivo: 'tentativa', itens: [{ codigoBarras: p.codigoBarras, quantidadeContada: 99 }] })).status, 400);
  assert.equal((await chamar('POST', '/estoque/entradas', { destinoId: maletaLocal.id, itens: [{ codigoBarras: p.codigoBarras, quantidade: 1 }] })).status, 400);
});

test('revisão: baixa parcial abre o saldo; cancelamento e estorno', async () => {
  const emp = (await ok('GET', '/empresas'))[0];
  const [t] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', descricao: 'Parcial teste', valor: 10000, vencimento: '2027-01-31', parcelas: 2 });
  const lista = await ok('GET', '/financeiro/titulos?tipo=receber&aba=abertos');
  assert.ok(lista.itens.some((x) => x.descricao === 'Parcial teste (2/2)' && x.vencimento === '2027-02-28'), '31/01 + 1 mês cai em 28/02');
  const b = await ok('POST', `/financeiro/titulos/${t.id}/baixar`, { valorPago: 2000 });
  assert.equal(b.saldo.valor, 3000);
  assert.equal(b.valorPago, 2000);
  await ok('POST', `/financeiro/titulos/${b.saldo.id}/cancelar`, { motivo: 'Renegociado' });
  assert.equal((await chamar('POST', `/financeiro/titulos/${b.saldo.id}/cancelar`, { motivo: 'de novo' })).status, 400);
  const e = await ok('POST', `/financeiro/titulos/${t.id}/estornar`, { motivo: 'Baixa por engano' });
  assert.equal(e.status, 'aberto');
});


test('integrações: senha salva pela tela nunca volta; teste de conexão do Asaas', async () => {
  await ok('PUT', '/integracoes/assertiva', { valores: { ASSERTIVA_CLIENT_ID: 'id-teste', ASSERTIVA_CLIENT_SECRET: 'segredo-muito-secreto-1234' } });
  const lista = await ok('GET', '/integracoes');
  const a = lista.find((i) => i.chave === 'assertiva');
  const sec = a.campos.find((c) => c.nome === 'ASSERTIVA_CLIENT_SECRET');
  assert.equal(sec.valor, null);
  assert.equal(sec.final, '1234');
  assert.equal(sec.origem, 'tela');
  assert.equal(a.ligada, true);
  assert.ok(!JSON.stringify(lista).includes('segredo-muito-secreto'));
  // senha em branco mantém a atual; null apaga
  await ok('PUT', '/integracoes/assertiva', { valores: { ASSERTIVA_CLIENT_SECRET: '' } });
  assert.equal((await ok('GET', '/integracoes')).find((i) => i.chave === 'assertiva').ligada, true);
  await ok('PUT', '/integracoes/assertiva', { valores: { ASSERTIVA_CLIENT_ID: null, ASSERTIVA_CLIENT_SECRET: null } });
  assert.equal((await ok('GET', '/integracoes')).find((i) => i.chave === 'assertiva').ligada, false);
  assert.equal((await chamar('PUT', '/integracoes/asaas', { valores: { ASAAS_AMBIENTE: 'marte' } })).status, 400);
  const t = await ok('POST', '/integracoes/asaas/testar');
  assert.ok(t.ok);
  const aud = await ok('GET', '/auditoria?entidade=integracao:assertiva');
  assert.ok(!JSON.stringify(aud).includes('segredo-muito-secreto'), 'auditoria não guarda a senha');
});

test('implantação: lista o que falta e confirma itens manuais', async () => {
  const i = await ok('GET', '/implantacao');
  assert.ok(i.total > 10);
  assert.equal(i.itens.find((x) => x.chave === 'dados_teste').status, 'pendente');
  await ok('POST', '/implantacao/confirmar', { chave: 'cfop_contador', feito: true });
  const j = await ok('GET', '/implantacao');
  assert.equal(j.itens.find((x) => x.chave === 'cfop_contador').status, 'ok');
  assert.equal(j.feitos, i.feitos + 1);
});

test('portal da representante: entra por CPF e código, vê só o que é dela', async () => {
  const salvo = token;
  token = '';
  const nada = await ok('POST', '/portal/entrar', { cpf: '111.444.777-35' });
  assert.equal(nada.codigoDev, undefined, 'CPF não cadastrado não recebe código, mas a resposta não denuncia');
  const e = await ok('POST', '/portal/entrar', { cpf: '390.533.447-05' });
  assert.ok(e.codigoDev);
  assert.equal((await chamar('POST', '/portal/confirmar', { cpf: '39053344705', codigo: e.codigoDev === '000000' ? '000001' : '000000' })).status, 400);
  const s = await ok('POST', '/portal/confirmar', { cpf: '39053344705', codigo: e.codigoDev });
  assert.equal((await chamar('POST', '/portal/confirmar', { cpf: '39053344705', codigo: e.codigoDev })).status, 400, 'código de uso único');
  token = s.token;
  assert.equal((await chamar('GET', '/maletas')).status, 401, 'token do portal não abre a área da equipe');
  const eu = await ok('GET', '/portal/eu');
  assert.equal(eu.nome, 'Representante Teste E2E');
  const ms = await ok('GET', '/portal/maletas');
  assert.ok(ms.length >= 1);
  const m = await ok('GET', `/portal/maletas/${ms[0].id}`);
  assert.ok(!JSON.stringify(m).includes('"custo"'), 'sem custo');
  const outra = (await (async () => { const t = token; token = salvo; const l = await ok('GET', '/maletas?aba=todas'); token = t; return l; })()).find((x) => x.representanteId !== ctx.rep.id);
  if (outra) assert.equal((await chamar('GET', `/portal/maletas/${outra.id}`)).status, 404, 'maleta de outra representante');
  const fin = await ok('GET', '/portal/financeiro');
  assert.ok(Array.isArray(fin.titulos));
  const cat = await ok('GET', '/portal/catalogo');
  assert.ok(cat.itens.length > 0);
  assert.ok(!('custo' in cat.itens[0]));
  const ped = await ok('POST', '/portal/pedidos', { itens: [{ produtoId: cat.itens[0].id, quantidade: 2 }], observacao: 'Para o evento de sábado' });
  assert.equal(ped.status, 'novo');
  token = salvo;
  const lista = await ok('GET', '/portal/admin/pedidos');
  assert.ok(lista.some((p) => p.id === ped.id));
  await ok('POST', `/portal/admin/pedidos/${ped.id}`, { status: 'atendido', resposta: 'Vai na próxima maleta' });
  const link = await ok('POST', `/portal/gerar-link/${ctx.rep.id}`);
  token = '';
  const s2 = await ok('POST', `/portal/link/${link.token}`);
  assert.ok(s2.token);
  assert.equal((await chamar('POST', `/portal/link/${link.token}`)).status, 400, 'link de uso único');
  token = salvo;
});

// Este fica por último: apaga os dados de teste.
test('implantação: apagar dados de teste exige APAGAR e mantém o que é configuração', async () => {
  assert.equal((await chamar('POST', '/implantacao/apagar-dados-de-teste', { confirmacao: 'apagar' })).status, 400);
  const r = await ok('POST', '/implantacao/apagar-dados-de-teste', { confirmacao: 'APAGAR', manterProdutos: true });
  assert.ok(r.antes.maletas > 0);
  assert.equal(r.depois.maletas, 0);
  assert.equal(r.depois.pessoas, 0);
  assert.equal(r.depois.produtos, r.antes.produtos, 'produtos mantidos');
  assert.equal((await ok('GET', '/implantacao')).itens.find((x) => x.chave === 'dados_teste').status, 'ok');
  assert.ok((await ok('GET', '/usuarios')).length > 1, 'usuários mantidos');
  assert.ok((await ok('GET', '/estoque/locais')).length >= 3, 'locais mantidos');
  // e o sistema continua funcionando depois: nova entrada de estoque e venda começam do nº 1
  const p = (await ok('GET', '/produtos')).itens[0];
  const loja = (await ok('GET', '/estoque/locais')).find((l) => l.tipo === 'loja');
  await ok('POST', '/estoque/entradas', { destinoId: loja.id, itens: [{ codigoBarras: p.codigoBarras, quantidade: 2 }] });
  const v = await ok('POST', '/vendas', { localId: loja.id, tipo: 'avulsa', itens: [{ codigoBarras: p.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'pix', valor: p.preco }] });
  assert.equal(v.numero, 1);
});
