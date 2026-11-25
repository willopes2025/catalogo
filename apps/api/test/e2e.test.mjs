/**
 * Teste de ponta a ponta do fluxo do consignado, contra a API rodando.
 * Uso: API_URL=http://localhost:3100/api ADMIN_EMAIL=... ADMIN_SENHA=... node --test test/e2e.test.mjs
 * Requer um banco de TESTE com o seed de exemplos (SEED_EXEMPLOS=1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const regras = createRequire(import.meta.url)('../../../packages/regras/dist/index.js');

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

test('regras padrão são as do Jueri; os testes seguintes ligam multa, juros e bloqueio para exercitar os cálculos', async () => {
  const r = await ok('GET', '/configuracoes/regras-consignado');
  assert.equal(r.comissaoAvistaPb, 3000);
  assert.equal(r.comissaoPrazoPb, 3000, 'comissão fixa');
  assert.equal(r.multaAtrasoPb, 0);
  assert.equal(r.jurosMesPb, 0);
  assert.equal(r.diasParaBloquear, 0, 'não bloqueia');
  await ok('PUT', '/configuracoes/regras-consignado', { ...r, comissaoPrazoPb: 2500, multaAtrasoPb: 200, jurosMesPb: 100, diasParaBloquear: 5 });
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
  assert.match(doc.conteudo, /^CONTRATO ESTIMATÓRIO PARA VENDAS EM CONSIGNAÇÃO/, 'o contrato instalado é o da Aritana');
  assert.match(doc.conteudo, /Cláusula 20ª/);
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

test('revisão: valor repetido onde o banco não aceita vira 409 com mensagem, não erro inesperado', async () => {
  const p = (await ok('GET', '/produtos')).itens[0];
  const r = await chamar('POST', '/produtos', { referencia: 'DUP-1', descricao: 'Duplicado', codigoBarras: p.codigoBarras, preco: 1000, custo: 500 });
  assert.equal(r.status, 409);
  assert.match(r.dados.mensagem, /Já existe/);
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

test('CRM: formulário público, quadro, recusa e aprovação que vira representante', async () => {
  const salvo = token;
  token = '';
  const ruim = await chamar('POST', '/publico/candidaturas', { nome: 'Ana', telefone: '27', cidade: 'Serra', uf: 'ES' });
  assert.equal(ruim.status, 400);
  assert.ok(ruim.dados.campos.consentimentoLgpd);
  await ok('POST', '/publico/candidaturas', { nome: 'Candidata Formulário Teste', telefone: '(27) 99888-1234', email: 'cand@exemplo.com', cidade: 'Serra', uf: 'es', modeloInteresse: 'consignado', consentimentoLgpd: true, origem: { utm_source: 'instagram', utm_campaign: 'novembro' } });
  await ok('POST', '/publico/candidaturas', { nome: 'Candidata Formulário Teste', telefone: '27998881234', cidade: 'Serra', uf: 'ES', consentimentoLgpd: true, experiencia: 'Vendo roupas' });
  await ok('POST', '/publico/candidaturas', { nome: 'Robô Preenchendo', telefone: '27911112222', cidade: 'X', uf: 'ES', consentimentoLgpd: true, site: 'http://spam' });
  token = salvo;
  const lista = await ok('GET', '/crm/candidaturas?busca=Formulário');
  assert.equal(lista.length, 1, 'reenvio não duplica');
  assert.equal(lista[0].origem.utm_source, 'instagram');
  assert.ok(!(await ok('GET', '/crm/candidaturas?busca=Robô')).length, 'robô ignorado');
  const id = lista[0].id;
  await ok('PATCH', `/crm/candidaturas/${id}`, { etapa: 'entrevista', nota: 'Conversamos pelo WhatsApp' });
  assert.equal((await chamar('PATCH', `/crm/candidaturas/${id}`, { etapa: 'recusada' })).status, 400, 'recusa exige motivo');
  const c = await ok('GET', `/crm/candidaturas/${id}`);
  assert.equal(c.etapa, 'entrevista');
  assert.ok(c.notas.length >= 2);
  const r = await ok('POST', `/crm/candidaturas/${id}/aprovar`, { modeloTrabalho: 'consignado' });
  const p = await ok('GET', `/pessoas/${r.pessoaId}`);
  assert.equal(p.status, 'ativo');
  assert.equal(p.telefone1, '27998881234');
  // Card arrastado de volta sem querer: "aprovar" de novo só devolve o card para Aprovada, sem criar outra revendedora.
  const funilRec = (await ok('GET', '/crm/funis')).find((f) => f.tipo === 'recrutamento');
  const etapa = (ch) => funilRec.etapas.find((e) => e.chave === ch).id;
  let card = null;
  for (const l of await ok('GET', `/crm/leads?funilId=${funilRec.id}&busca=Formulário`)) if ((await ok('GET', `/crm/leads/${l.id}`)).candidaturaId === id) card = l;
  assert.ok(card, 'card da candidata no recrutamento');
  assert.equal((await ok('GET', `/crm/leads/${card.id}`)).etapaId, etapa('aprovada'));
  await ok('PATCH', `/crm/leads/${card.id}`, { etapaId: etapa('documentos') });
  const r2 = await ok('POST', `/crm/candidaturas/${id}/aprovar`, { modeloTrabalho: 'consignado' });
  assert.deepEqual([r2.pessoaId, r2.jaAprovada], [r.pessoaId, true]);
  assert.equal((await ok('GET', `/crm/leads/${card.id}`)).etapaId, etapa('aprovada'), 'card voltou para Aprovada');
  assert.equal((await ok('GET', `/crm/candidaturas/${id}`)).pessoaId, r.pessoaId, 'continua ligada à mesma revendedora');
  const res = await ok('GET', '/crm/resumo');
  assert.ok(res.porOrigem.some((o) => o.origem === 'instagram' && o.aprovadas === 1));
});

test('gamificação: score, pontos automáticos sem duplicar, prêmio, resgate e cancelamento', async () => {
  const sc = await ok('GET', `/rede/${ctx.rep.id}/score`);
  assert.ok(['A', 'B', 'C', 'D', 'nova'].includes(sc.faixa));
  assert.ok(sc.score === null || (sc.score >= 0 && sc.score <= 1000));
  const rede = await ok('GET', '/rede/score');
  assert.ok(rede.some((x) => x.pessoaId === ctx.rep.id));

  await ok('POST', '/pontos/apurar');
  const s1 = (await ok('GET', `/rede/${ctx.rep.id}/score`)).saldoPontos;
  await ok('POST', '/pontos/apurar');
  assert.equal((await ok('GET', `/rede/${ctx.rep.id}/score`)).saldoPontos, s1, 'apurar de novo não duplica');

  await ok('POST', '/pontos/ajuste', { pessoaId: ctx.rep.id, pontos: 500, motivo: 'Bônus de boas-vindas' });
  assert.equal((await chamar('POST', '/pontos/ajuste', { pessoaId: ctx.rep.id, pontos: -999999, motivo: 'Erro' })).status, 400, 'não fica negativo');
  const premio = await ok('POST', '/pontos/premios', { nome: 'Kit de vitrine', pontos: 300, estoque: 1 });

  const salvo = token;
  const link = await ok('POST', `/portal/gerar-link/${ctx.rep.id}`);
  token = '';
  token = (await ok('POST', `/portal/link/${link.token}`)).token;
  const antes = await ok('GET', '/portal/pontos');
  assert.equal(antes.saldo, s1 + 500);
  assert.ok(antes.premios.some((p) => p.id === premio.id));
  const r = await ok('POST', '/portal/pontos/resgatar', { premioId: premio.id });
  assert.equal((await ok('GET', '/portal/pontos')).saldo, s1 + 200);
  assert.equal((await chamar('POST', '/portal/pontos/resgatar', { premioId: premio.id })).status, 400, 'estoque acabou');
  token = salvo;

  const pend = await ok('GET', '/pontos/resgates');
  assert.ok(pend.some((x) => x.id === r.id));
  await ok('POST', `/pontos/resgates/${r.id}`, { status: 'cancelado', observacao: 'Sem estoque físico' });
  assert.equal((await chamar('POST', `/pontos/resgates/${r.id}`, { status: 'entregue' })).status, 400);
  assert.equal((await ok('GET', `/rede/${ctx.rep.id}/score`)).saldoPontos, s1 + 500, 'cancelamento devolve os pontos');
  assert.equal((await ok('GET', '/pontos/premios')).find((p) => p.id === premio.id).estoque, 1, 'e o prêmio volta');

  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const rk = await ok('GET', `/pontos/ranking?mes=${mes}`);
  assert.ok(Array.isArray(rk));
  assert.ok(Array.isArray(await ok('GET', '/pontos/niveis/sugestoes')));
  assert.equal((await chamar('GET', '/pontos/ranking?mes=2026-13')).status, 400);
});

test('formulários: monta, publica, valida, resume o NPS e cadastra cliente sem duplicar', async () => {
  const modelos = await ok('GET', '/formularios/modelos');
  const nps = modelos.find((m) => m.chave === 'nps');
  const semNome = await chamar('POST', '/formularios', { ...modelos.find((m) => m.chave === 'cliente'), campos: [{ id: 'a', tipo: 'texto', rotulo: 'A', obrigatorio: true }] });
  assert.equal(semNome.status, 400, 'cadastrar cliente exige pergunta de nome e de telefone');
  assert.equal((await chamar('POST', '/formularios', { titulo: 'Ruim', campos: [{ id: 'x', tipo: 'escolha', rotulo: 'X', opcoes: ['só uma'] }] })).status, 400);
  const f = await ok('POST', '/formularios', { ...nps, slug: 'pesquisa-loja' });
  assert.equal(f.slug, 'pesquisa-loja');
  const f2 = await ok('POST', '/formularios', { ...nps, slug: 'pesquisa-loja' });
  assert.equal(f2.slug, 'pesquisa-loja-2', 'endereço repetido ganha sufixo');
  const cad = await ok('POST', '/formularios', modelos.find((m) => m.chave === 'cliente'));

  const salvo = token;
  token = '';
  const pub = await ok('GET', '/publico/formularios/pesquisa-loja');
  assert.equal(pub.acao, undefined, 'a página pública não mostra o que acontece por trás');
  const erro = await chamar('POST', '/publico/formularios/pesquisa-loja', { respostas: { nota: 11 } });
  assert.equal(erro.status, 400);
  assert.ok(erro.dados.campos.nota);
  for (const n of [10, 9, 8, 3]) await ok('POST', '/publico/formularios/pesquisa-loja', { respostas: { nota: n, onde: 'Na loja' }, origem: { utm_campaign: 'novembro', hack: 'x' } });
  assert.equal((await chamar('POST', `/publico/formularios/${cad.slug}`, { respostas: { nome: 'Cliente Form', telefone: '27988887777' } })).status, 400, 'sem a autorização LGPD');
  await ok('POST', `/publico/formularios/${cad.slug}`, { respostas: { nome: 'Cliente Formulário', telefone: '(27) 98888-7777', gosta: ['Anéis'] }, consentimento: true });
  await ok('POST', `/publico/formularios/${cad.slug}`, { respostas: { nome: 'Cliente Formulário', telefone: '27988887777', email: 'cli@exemplo.com' }, consentimento: true });
  token = salvo;

  const r = await ok('GET', `/formularios/${f.id}/respostas`);
  assert.equal(r.total, 4);
  const notas = r.resumo.find((x) => x.campo === 'nota');
  assert.equal(notas.nps, 25, '2 promotores, 1 neutro, 1 detrator');
  assert.equal(r.resumo.find((x) => x.campo === 'onde').contagem['Na loja'], 4);
  assert.deepEqual(Object.keys(r.linhas[0].origem), ['utm_campaign'], 'só guarda utm conhecidos');
  const clientes = (await ok('GET', '/pessoas?tipo=cliente&busca=Cliente Formulário')).itens;
  assert.equal(clientes.length, 1, 'mesmo telefone não duplica o cliente');
  assert.equal((await ok('GET', `/pessoas/${clientes[0].id}`)).email, 'cli@exemplo.com', 'segunda resposta completa o cadastro');

  await ok('PATCH', `/formularios/${f.id}`, { ativo: false });
  token = '';
  assert.equal((await chamar('GET', '/publico/formularios/pesquisa-loja')).status, 404, 'encerrado sai do ar');
  token = salvo;
});

test('marketing: custo por candidata e por aprovada, retorno e investimento vindo do Meta', async () => {
  const c = await ok('POST', '/marketing/campanhas', { nome: 'Revendedoras novembro', canal: 'meta', utmCampaign: 'Novembro', investimento: 50000, metaCampanhaId: '120000001' });
  assert.equal(c.utmCampaign, 'novembro');
  assert.equal((await chamar('POST', '/marketing/campanhas', { nome: 'Outra', canal: 'meta', utmCampaign: 'novembro' })).status, 409, 'código repetido');
  let res = await ok('GET', '/marketing/resultados');
  let l = res.linhas.find((x) => x.utm === 'novembro');
  assert.equal(l.candidatas, 1);
  assert.equal(l.aprovadas, 1);
  assert.equal(l.respostas, 4);
  assert.equal(l.custoPorCandidata, 50000);
  assert.equal(l.custoPorAprovada, 50000);
  await ok('POST', '/publico/candidaturas', { nome: 'Candidata Sem Campanha', telefone: '27911223344', cidade: 'Serra', uf: 'ES', consentimentoLgpd: true, origem: { utm_campaign: 'codigo-solto' } });
  const r2 = await ok('GET', '/marketing/resultados');
  const solto = r2.linhas.find((x) => x.utm === 'codigo-solto');
  assert.equal(solto.campanha, null);
  assert.equal(solto.custoPorCandidata, null, 'sem campanha não tem custo');
  assert.equal(r2.totais.candidatas, 1, 'totais contam só campanhas cadastradas');
  assert.equal(r2.totais.candidatasComCodigoSemCampanha, 1);

  assert.equal((await chamar('POST', '/marketing/sincronizar-meta')).status, 503, 'sem a integração ligada');
  await ok('PUT', '/integracoes/meta_ads', { valores: { META_ADS_CONTA: 'act_999', META_ADS_TOKEN: 'token-meta-teste' } });
  assert.ok((await ok('POST', '/integracoes/meta_ads/testar')).mensagem.includes('Aritana Semijoias'));
  const s = await ok('POST', '/marketing/sincronizar-meta');
  assert.equal(s.atualizadas, 1);
  res = await ok('GET', '/marketing/resultados');
  l = res.linhas.find((x) => x.utm === 'novembro');
  assert.equal(l.investimento, 12345, 'soma das duas páginas do Meta');
  assert.equal(l.campanha.sincronizado, true);
  // Meta mês a mês vira lançamento por mês; gastos à mão somam (com campanha) ou entram só no custo geral (sem).
  const gs = await ok('GET', '/marketing/gastos');
  assert.deepEqual(gs.filter((g) => g.origem === 'meta').map((g) => [g.competencia, g.valor]).sort(), [['2026-10', 10000], ['2026-11', 2345]]);
  const mesAtual = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
  const g1 = await ok('POST', '/marketing/gastos', { competencia: mesAtual, campanhaId: c.id, descricao: 'Impulsionamento extra', valor: 5000 });
  await ok('POST', '/marketing/gastos', { competencia: mesAtual, descricao: 'Influenciadora', valor: 3000 });
  assert.equal((await chamar('POST', '/marketing/gastos', { competencia: '2026-13', descricao: 'x', valor: 1 })).status, 400);
  assert.equal((await ok('GET', '/marketing/resultados')).linhas.find((x) => x.utm === 'novembro').investimento, 12345 + 5000, 'gasto à mão soma na campanha');
  assert.equal(typeof (await ok('GET', '/marketing/resultados')).linhas.find((x) => x.utm === 'novembro').leads, 'number');
  const mensal = await ok('GET', '/marketing/mensal');
  assert.equal(mensal.linhas.length, 12);
  const atual = mensal.linhas.find((x) => x.mes === mesAtual);
  const esperado = (await ok('GET', `/marketing/gastos?competencia=${mesAtual}`)).reduce((a, g) => a + g.valor, 0);
  assert.equal(atual.investimento, esperado, 'mês = gastos lançados + Meta do mês (campanha com meses do Meta não é rateada)');
  assert.ok(mensal.totais.investimento >= esperado);
  assert.equal((await chamar('DELETE', `/marketing/gastos/${gs.find((g) => g.origem === 'meta').id}`)).status, 400, 'gasto do Meta só muda sincronizando');
  await ok('DELETE', `/marketing/gastos/${g1.id}`);
  // sincronizar de novo não duplica os meses do Meta
  await ok('POST', '/marketing/sincronizar-meta');
  assert.equal((await ok('GET', '/marketing/gastos')).filter((g) => g.origem === 'meta').length, 2);
  await ok('PUT', '/integracoes/meta_ads', { valores: { META_ADS_TOKEN: 'token-errado-123456' } });
  assert.equal((await chamar('POST', '/marketing/sincronizar-meta')).status, 503);
});

test('Marketing › Meta: configurar pela lista, campanhas, pausar, orçamento, catálogo, públicos, leads e página', async () => {
  const sim = async (corpo) => (await fetch('http://localhost:3199/__meta', corpo ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) } : undefined)).json();
  await ok('PUT', '/integracoes/meta_ads', { valores: { META_ADS_CONTA: '', META_ADS_TOKEN: 'token-meta-teste' } });
  // Sem conta escolhida, o painel pede para configurar.
  assert.equal((await chamar('GET', '/marketing/meta/painel')).status, 400);
  // Configuração guiada: o sistema lista o que o token enxerga.
  const op = await ok('GET', '/marketing/meta/opcoes');
  assert.deepEqual(op.contas, [{ id: 'act_999', nome: 'Aritana Semijoias', moeda: 'BRL', ativa: true }]);
  assert.deepEqual(op.paginas, [{ id: '700001', nome: 'Aritana Semijoias' }]);
  assert.deepEqual(op.catalogos, [{ id: '880001', nome: 'Catálogo Aritana', negocio: 'Aritana' }], 'acha o catálogo pelo portfólio da conta de anúncios');
  assert.ok(op.permissoes.includes('catalog_management'));
  const funil = op.funis.find((f) => /client/i.test(f.nome)) ?? op.funis[0];
  assert.equal((await chamar('PUT', '/marketing/meta/config', { catalogoLink: 'http://sem-https.com' })).status, 400);
  const est = await ok('PUT', '/marketing/meta/config', { conta: 'act_999', paginaId: '700001', catalogoId: '880001', catalogoLink: 'https://aritanaonline.com.br/loja', leadsFunilId: funil.id, leadsAuto: true });
  assert.equal(est.conta, 'act_999');
  assert.equal(est.leadsAuto, true);

  // Painel: resultados do período com status e orçamento.
  const p = await ok('GET', '/marketing/meta/painel?de=2026-11-01&ate=2026-11-15');
  assert.equal((await sim()).ultimoPeriodo, '{"since":"2026-11-01","until":"2026-11-15"}');
  const c1 = p.linhas.find((l) => l.id === '120000001');
  assert.deepEqual([c1.gasto, c1.cliques, c1.leads, c1.conversas, c1.custoPorLead, c1.custoPorClique, c1.ctr, c1.orcamentoDiario, c1.situacao], [15000, 200, 10, 5, 1500, 75, 2, 5000, 'ACTIVE']);
  assert.equal(p.linhas.find((l) => l.id === '120000002').gasto, 0, 'pausada sem gasto aparece');
  assert.equal(p.linhas.find((l) => l.id === '120000009').situacao, 'ARCHIVED', 'apagada que gastou no período entra só com os números');
  assert.equal(p.totais.gasto, 17000);
  assert.equal((await ok('GET', '/marketing/meta/painel?nivel=adset&pai=120000001')).linhas[0].nome, 'Mulheres 25-45 ES');
  // Anúncios do conjunto, com a imagem de cada criativo (foto ou miniatura do vídeo) e o link da prévia.
  const ads = (await ok('GET', '/marketing/meta/painel?nivel=ad&pai=130000001')).linhas;
  assert.deepEqual(ads.map((a) => [a.nome, a.imagem, a.previa]), [['Anúncio foto maleta', 'https://scontent.example/criativo-maleta.jpg', 'https://fb.me/previa-140000001'], ['Anúncio vídeo', 'https://scontent.example/mini-video.jpg', null]]);
  assert.equal((await chamar('GET', '/marketing/meta/painel?de=2026-11-20&ate=2026-11-01')).status, 400);

  // Pausar, ativar e orçamento: só na conta escolhida.
  assert.equal((await ok('POST', '/marketing/meta/itens/120000001/status', { status: 'PAUSED' })).para, 'PAUSED');
  assert.equal((await sim()).campanhas[0].status, 'PAUSED');
  await ok('POST', '/marketing/meta/itens/120000001/status', { status: 'ACTIVE' });
  assert.equal((await ok('POST', '/marketing/meta/itens/120000001/orcamento', { diario: 8000 })).de, 5000);
  assert.equal((await sim()).campanhas[0].daily_budget, '8000');
  assert.equal((await chamar('POST', '/marketing/meta/itens/120000002/orcamento', { diario: 8000 })).status, 400, 'orçamento total não muda por aqui');
  assert.equal((await chamar('POST', '/marketing/meta/itens/120000777/status', { status: 'PAUSED' })).status, 400, 'item de outra conta');
  assert.equal((await chamar('POST', '/marketing/meta/itens/120000001/orcamento', { diario: 50 })).status, 400);
  assert.equal((await chamar('POST', '/marketing/meta/itens/abc/status', { status: 'PAUSED' })).status, 400);

  // Catálogo: só produto ativo, do catálogo, com foto https.
  const prods = (await ok('GET', '/produtos?busca=')).itens ?? [];
  const alvo = prods[0];
  {
    const pg = createRequire(import.meta.url)('pg');
    const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
    await banco.connect();
    // Como o sistema guarda (foto enviada pela tela) e uma foto de fora.
    await banco.query(`update produtos set fotos = '["/api/fotos/peca.jpg","https://cdn.exemplo.com/peca-2.jpg"]'::jsonb, ativo = true, exibe_catalogo = true where id = $1`, [alvo.id]);
    await banco.end();
  }
  const cat = await ok('POST', '/marketing/meta/catalogo/sincronizar');
  assert.ok(cat.enviados >= 1);
  const item = (await sim()).catalogo.find((x) => x.data.id === alvo.referencia);
  assert.equal(item.method, 'UPDATE');
  assert.equal(item.data.price, `${(alvo.preco / 100).toFixed(2)} BRL`);
  assert.equal(item.data.link, `https://aritanaonline.com.br/loja?produto=${encodeURIComponent(alvo.referencia)}`);
  assert.equal(item.data.image_link, 'http://localhost:3100/api/fotos/peca.jpg', 'foto do sistema vai com o endereço completo');
  assert.deepEqual(item.data.additional_image_link, ['https://cdn.exemplo.com/peca-2.jpg']);
  assert.ok(['in stock', 'out of stock'].includes(item.data.availability));

  // Públicos: só quem autorizou (LGPD), em SHA-256; menos de 100 o Meta não aceita.
  const antes = await ok('GET', '/marketing/meta/publicos/previa?origem=clientes');
  assert.equal((await chamar('POST', '/marketing/meta/publicos', { origem: 'clientes' })).status, 400);
  for (let i = 0; i < 110; i += 22) await Promise.all(Array.from({ length: 22 }, (_, k) => ok('POST', '/pessoas', { tipo: 'cliente', nome: `Cliente Publico ${i + k}`, telefone1: `2799700${String(1000 + i + k)}`, email: i + k < 5 ? `Publico${i + k}@Exemplo.com ` : null, consentimentoLgpd: i + k < 105 })));
  const previa = await ok('GET', '/marketing/meta/publicos/previa?origem=clientes');
  assert.equal(previa.comAutorizacao - antes.comAutorizacao, 105);
  assert.equal(previa.semAutorizacao - antes.semAutorizacao, 5, 'sem autorização fica de fora');
  const pub = await ok('POST', '/marketing/meta/publicos', { origem: 'clientes' });
  assert.equal(pub.enviados, previa.comAutorizacao);
  const carga = (await sim()).enviados[pub.id];
  assert.deepEqual(carga.schema, ['PHONE', 'EMAIL']);
  const { createHash } = await import('node:crypto');
  const sha = (t) => createHash('sha256').update(t).digest('hex');
  assert.ok(carga.data.some((l) => l[0] === sha('5527997001000') && l[1] === sha('publico0@exemplo.com')), 'telefone com 55 e e-mail minúsculo, embaralhados');
  assert.ok(!JSON.stringify(carga).includes('2799700'), 'nenhum telefone sai em claro');
  const lista = await ok('GET', '/marketing/meta/publicos');
  assert.equal(lista.find((x) => x.id === pub.id).origem, 'clientes');
  assert.equal(lista.find((x) => x.id === '600000').tipo, 'outro');
  assert.equal((await ok('POST', `/marketing/meta/publicos/${pub.id}/atualizar`)).enviados, previa.comAutorizacao);
  assert.equal((await chamar('POST', '/marketing/meta/publicos/600000/atualizar')).status, 400, 'público que não é do sistema');
  const sem = await ok('POST', `/marketing/meta/publicos/${pub.id}/semelhante`, { percentual: 2 });
  assert.equal((await sim()).publicos.find((x) => x.id === sem.id).spec, '{"type":"similarity","ratio":0.02,"country":"BR"}');

  // Leads de formulário: entram no CRM uma vez só; sem telefone não vira card.
  await sim({ semLeadsRetrieval: true });
  const negado = await chamar('POST', '/marketing/meta/leads/importar');
  assert.equal(negado.status, 503);
  assert.equal(negado.dados.permissaoFaltando, 'leads_retrieval', 'diz qual permissão falta');
  await sim({ semLeadsRetrieval: false });
  const imp = await ok('POST', '/marketing/meta/leads/importar');
  assert.deepEqual([imp.novos, imp.semTelefone, imp.repetidos], [2, 1, 0]);
  assert.deepEqual(await ok('POST', '/marketing/meta/leads/importar').then((r) => [r.novos, r.semTelefone]), [0, 0], 'repetir não duplica');
  assert.equal((await ok('GET', '/marketing/meta/leads/formularios'))[0].importados, 3);
  const quadro = await ok('GET', `/crm/funis/${funil.id}/quadro`).catch(() => null);
  if (quadro) assert.ok(JSON.stringify(quadro).includes('Lead Do Instagram'));

  // Página.
  const pg = await ok('GET', '/marketing/meta/pagina');
  assert.deepEqual([pg.seguidores, pg.publicacoes[0].curtidas, pg.publicacoes[0].comentarios, pg.publicacoes[0].compartilhamentos], [5400, 42, 7, 3]);

  // Token vencido: mensagem clara, sem derrubar a tela.
  await ok('PUT', '/integracoes/meta_ads', { valores: { META_ADS_TOKEN: 'token-errado-123456' } });
  const venc = await chamar('GET', '/marketing/meta/painel');
  assert.equal(venc.status, 503);
  assert.match(venc.dados.mensagem, /venceu ou foi revogado/);
});

test('Jueri pela API: testa a conexão, simula sem gravar, importa tudo e repetir não duplica', async () => {
  assert.equal((await ok('GET', '/jueri')).configurado, false);
  const local = (await ok('GET', '/estoque/locais')).find((l) => l.tipo === 'deposito');
  assert.equal((await chamar('POST', '/jueri/importar', { simular: true, etapas: ['produtos'], localId: local.id })).status, 400, 'sem token');
  await ok('PUT', '/integracoes/jueri', { valores: { JUERI_CLIENTE_ID: '11566', JUERI_TOKEN: 'token-jueri-teste' } });
  assert.match((await ok('POST', '/integracoes/jueri/testar')).mensagem, /2 categoria/);

  const esperar = async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await ok('GET', '/jueri')).execucao;
      if (s.situacao !== 'rodando') return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('importação não terminou');
  };
  const todas = ['cadastros', 'produtos', 'pessoas', 'maletas', 'financeiro', 'historico', 'fotos'];
  await ok('POST', '/jueri/importar', { simular: true, etapas: todas, localId: local.id });
  assert.equal((await chamar('POST', '/jueri/importar', { simular: true, etapas: todas, localId: local.id })).status, 400, 'uma de cada vez');
  let ex = await esperar();
  assert.equal(ex.situacao, 'concluida', ex.erro);
  assert.equal(ex.partes['Produtos'].criados, 3, 'o sem preço entra inativo');
  assert.equal(ex.partes['Produtos'].falhas, 0);
  assert.ok(ex.partes['Produtos'].avisos.some((a) => a.startsWith('1 produto(s) sem preço')));
  assert.equal(ex.partes['Revendedoras'].criados, 2);
  assert.equal(ex.partes['Maletas abertas'].criados, 1);
  assert.match(ex.partes['Maletas abertas'].erros[0], /9999/);
  assert.equal(ex.partes['Contas a receber'].criados, 4, 'só as contas em aberto, inclusive com nomes de campo fora da documentação e uma por parcela');
  assert.equal(ex.partes['Contas a receber'].ignorados, 2, 'linha repetida e conta zerada');
  assert.ok(ex.partes['Maletas abertas'].motivos['produto(s) não encontrados: #'] === 1, 'problemas agrupados por motivo');
  assert.ok(ex.estruturas.pedidoItem.includes('fk_produto_id'));
  assert.equal((await chamar('GET', '/produtos/codigo/7899990090010')).status, 404, 'simulação não grava');
  assert.equal(ex.partes['Histórico de acertos'].criados, 3, JSON.stringify(ex.partes['Histórico de acertos']));
  assert.ok(ex.estruturas.pedidoBaixadoItem.includes('quantidade_vendida'));
  // Conferência do histórico: contagem e nomes de campos, sem gravar e sem valores pessoais.
  const ver = await ok('POST', '/jueri/historico/verificar');
  assert.equal(ver.acertosBaixados, 3);
  assert.ok(ver.camposDoItem.includes('quantidade_vendida') && ver.temQuantidadeVendida && ver.temPreco);
  assert.ok(!JSON.stringify(ver).includes('Revendedora API Jueri'), 'não mostra nomes');
  assert.equal((await ok('GET', '/indicadores/historico')).jueri.acertos, 0, 'simulação não grava o histórico');

  await ok('POST', '/jueri/importar', { simular: false, etapas: todas, localId: local.id, comissaoRepresentantePb: 1000 });
  ex = await esperar();
  assert.equal(ex.situacao, 'concluida', ex.erro);
  const p = await ok('GET', '/produtos/codigo/7899990090010');
  assert.equal(p.preco, 5990);
  assert.equal(p.precoAtacado, 3990);
  assert.equal(p.custo, 1650, 'sem custo_total: soma bruto + banho + insumos');
  assert.deepEqual(p.custos, { bruto: 1000, insumos: 150, banhoOuro: 500 });
  assert.equal(p.fcpPb, 200);
  assert.equal(p.ean, '7891112223334', 'numero_ean do Jueri');
  assert.equal(p.custos.insumos, 150);
  // Fotos: as duas imagens de verdade foram baixadas e guardadas; a "foto" que é HTML foi recusada.
  assert.equal(p.fotos.length, 2);
  assert.ok(p.fotos.every((f) => /^\/api\/fotos\/[a-f0-9]{40}\.webp$/.test(f)), 'convertidas para WebP leve');
  const img = await fetch(API.replace(/\/api$/, '') + p.fotos[0]);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.equal((await fetch(API + '/fotos/..%2F..%2Fetc%2Fpasswd')).status, 404, 'só nomes de foto válidos');
  assert.equal(ex.partes['Fotos'].criados, 2);
  assert.equal((await ok('GET', '/produtos/codigo/7899990090027')).fotos.length, 0, 'imagem padrão "sem foto" do Jueri não vira foto');
  assert.equal(ex.partes['Fotos'].falhas, 1);
  assert.equal(p.camposExtras['Número da peça'], 'P-77');
  const cat = (await ok('GET', '/produtos/categorias')).find((c) => c.id === p.categoriaId);
  assert.equal(cat.caminho, 'Anel API › Solitário API');
  assert.equal((await ok('GET', '/estoque/rastreio/7899990090010')).porLocal.find((l) => l.tipo === 'deposito').quantidade, 7);

  const reps = (await ok('GET', '/pessoas?tipo=representante&busca=API Jueri')).itens;
  const rev = reps.find((x) => x.nome === 'Revendedora API Jueri');
  assert.equal(rev.lider, 'Líder API Jueri');
  const ficha = await ok('GET', `/pessoas/${rev.id}`);
  assert.equal(ficha.telefone3, '2733334444');
  assert.equal(ficha.genero, 'Feminino');
  assert.equal(ficha.maletas.length, 1);
  const lider = await ok('GET', `/pessoas/${reps.find((x) => x.nome === 'Líder API Jueri').id}`);
  assert.equal(lider.tipoRevendedor, 'Revendedora líder');
  assert.equal(lider.localTrabalho, 'Escola Estadual');
  assert.equal(lider.referencias[0].nome, 'Maria Referência');
  const repJ = await ok('GET', `/pessoas/${reps.find((x) => x.nome === 'Representante API Jueri').id}`);
  assert.equal(repJ.comissaoPb, 1000);
  assert.equal(repJ.metaMensal, 250000);

  const m = await ok('GET', `/maletas/${ficha.maletas[0].id}`);
  assert.equal(m.dataLimite, '2026-12-01');
  const pecas = m.itens.reduce((a, i) => a + i.enviada, 0);
  assert.equal(pecas, 3, 'só o que ainda está com ela; a peça vendida no Jueri não entra');
  assert.equal((await ok('GET', '/estoque/rastreio/7899990090010')).porLocal.find((l) => l.tipo === 'deposito').quantidade, 7, 'maleta não tira do estoque da empresa');

  const fin = await ok('GET', `/pessoas/${rev.id}`);
  assert.ok(fin.titulos.some((t) => t.valor === 15000 && t.status === 'aberto'));
  const finLider = await ok('GET', `/pessoas/${lider.id}`);
  assert.ok(finLider.titulos.some((t) => t.valor === 4500 && t.vencimento === '2026-12-20'), 'valor e vencimento achados por nome parecido');
  assert.ok(finLider.titulos.some((t) => t.valor === 10000 && t.vencimento === '2027-01-05'), 'parcela 2/2 ligada pelo nome do contato');
  assert.ok(fin.titulos.some((t) => t.valor === 6000), 'parcela 1/2 ligada pelo id e tipo do contato, com o saldo após pagamento parcial');

  // Histórico: só relatório. Soma por mês, por consultora e por produto; não mexe em estoque nem maletas.
  const h = await ok('GET', '/indicadores/historico');
  assert.equal(h.jueri.acertos, 3);
  assert.equal(h.jueri.vendido, 2 * 5990 + 3 * 3000 + 1000);
  assert.equal(h.jueri.de, '2026-09-02');
  assert.equal(h.linhas.find((l) => l.mes === '2026-09').jueri, 2 * 5990);
  assert.equal(h.linhas.find((l) => l.mes === '2026-09').sell_through_pb, 4000, '2 de 5 peças');
  assert.equal(h.linhas.find((l) => l.mes === '2026-10').jueri, 3 * 3000 + 1000);
  assert.equal(h.produtos.find((x) => x.referencia === 'API-01').vendidas, 2);
  const hp = await ok('GET', `/indicadores/historico/pessoa/${rev.id}`);
  assert.equal(hp.jueri.acertos, 2, 'o pedido de revendedora não importada fica só no total');
  assert.equal(hp.linhas.find((l) => l.mes === '2026-10').jueri, 9000);
  assert.equal((await ok('GET', `/pessoas/${rev.id}`)).maletas.length, 1, 'acerto antigo não vira maleta');

  // Repetir: atualiza, não duplica.
  await ok('POST', '/jueri/importar', { simular: false, etapas: todas, localId: local.id });
  ex = await esperar();
  assert.equal(ex.partes['Produtos'].criados, 0);
  assert.equal(ex.partes['Produtos'].atualizados, 3);
  assert.equal(ex.partes['Fotos'].ignorados, 2, 'fotos já baixadas não baixam de novo');
  const semPreco = await ok('GET', '/produtos/codigo/7899990090034');
  assert.equal(semPreco.ativo, false);
  assert.equal(semPreco.exibeCatalogo, false);
  assert.equal(ex.partes['Revendedoras'].criados, 0);
  assert.equal(ex.partes['Maletas abertas'].ignorados, 1);
  assert.equal(ex.partes['Contas a receber'].criados, 0);
  assert.equal(ex.partes['Histórico de acertos'].criados, 0);
  assert.equal(ex.partes['Histórico de acertos'].atualizados, 3);
  assert.equal((await ok('GET', '/indicadores/historico')).jueri.acertos, 3, 'repetir não duplica o histórico');
  assert.equal((await ok('GET', `/pessoas/${rev.id}`)).maletas.length, 1);
  const hist = await ok('GET', '/importacao/historico');
  assert.ok(hist.some((h) => h.tipo === 'jueri:api'));
});

test('Jueri: cancelar no meio não grava nada', async () => {
  const local = (await ok('GET', '/estoque/locais')).find((l) => l.tipo === 'deposito');
  await fetch('http://localhost:3199/__jueri/lento?ms=300', { method: 'POST' });
  try {
    await ok('POST', '/jueri/importar', { simular: false, etapas: ['cadastros', 'produtos', 'pessoas'], localId: local.id });
    await new Promise((r) => setTimeout(r, 400));
    const c = await ok('POST', '/jueri/cancelar', {});
    assert.equal(c.cancelando, true);
    let s;
    for (let i = 0; i < 100; i++) {
      s = (await ok('GET', '/jueri')).execucao;
      if (s.situacao !== 'rodando') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(s.situacao, 'cancelada');
    assert.match(s.fase, /Nada desta execução foi gravado/);
    assert.equal((await chamar('POST', '/jueri/cancelar', {})).status, 400, 'nada para cancelar');
  } finally {
    await fetch('http://localhost:3199/__jueri/lento?ms=0', { method: 'POST' });
  }
});

test('Jueri na virada: maletas e contas trazidas antes acompanham o que mudou no Jueri', async () => {
  const local = (await ok('GET', '/estoque/locais')).find((l) => l.tipo === 'deposito');
  const todas = ['cadastros', 'produtos', 'pessoas', 'maletas', 'financeiro'];
  const esperar = async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await ok('GET', '/jueri')).execucao;
      if (s.situacao !== 'rodando') return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('importação não terminou');
  };
  const rev = (await ok('GET', '/pessoas?tipo=representante&busca=Revendedora API Jueri')).itens[0];
  const maletaId = (await ok('GET', `/pessoas/${rev.id}`)).maletas[0].id;

  await fetch('http://localhost:3199/__jueri/virada?passo=1', { method: 'POST' });
  await ok('POST', '/jueri/importar', { simular: false, etapas: todas, localId: local.id });
  let ex = await esperar();
  assert.equal(ex.situacao, 'concluida', ex.erro);
  assert.equal(ex.partes['Maletas abertas'].atualizados, 1, 'troca feita no Jueri chega na maleta');
  assert.equal(ex.partes['Maletas abertas'].criados, 1, 'maleta nova do Jueri');
  let m = await ok('GET', `/maletas/${maletaId}`);
  assert.equal(m.itens.reduce((a, i) => a + i.enviada, 0), 4);
  const fin = await ok('GET', `/pessoas/${rev.id}`);
  assert.ok(fin.titulos.some((t) => t.valor === 15000 && t.status === 'cancelado'), 'parcela paga no Jueri encerrada aqui');
  assert.ok(ex.partes['Contas a receber'].avisos.some((a) => a.startsWith('1 conta(s) trazidas antes foram pagas')));

  await fetch('http://localhost:3199/__jueri/virada?passo=2', { method: 'POST' });
  await ok('POST', '/jueri/importar', { simular: false, etapas: ['maletas'], localId: local.id });
  ex = await esperar();
  m = await ok('GET', `/maletas/${maletaId}`);
  assert.equal(m.status, 'cancelada', 'maleta acertada no Jueri é encerrada aqui');
  const rast = await ok('GET', '/estoque/rastreio/7899990090027');
  assert.ok(!rast.porLocal.some((l) => l.tipo === 'maleta' && l.quantidade > 0 && l.nome.includes(`nº ${m.numero} `)), 'peças saem do local da maleta');
  // Contas que vieram só com o nome: filtrar e ligar à pessoa.
  const sem = await ok('GET', '/financeiro/titulos?tipo=receber&aba=abertos&semPessoa=1');
  assert.ok(sem.itens.every((t) => !t.pessoaId));
  assert.equal(sem.quantidade, sem.itens.length);
  const implant = await ok('GET', '/implantacao');
  assert.ok(implant.importadosJueri > 0);
  assert.ok(implant.itens.find((i) => i.chave === 'importacao').detalhe.includes('Última importação do Jueri'));
  const busca = await ok('GET', '/financeiro/titulos?tipo=receber&aba=abertos&busca=Revendedora API');
  assert.ok(busca.itens.length >= 1, 'busca pelo nome da pessoa');
  const aberto = busca.itens.find((t) => !t.cobrancaUrl);
  const outra = (await ok('GET', '/pessoas?tipo=cliente&busca=Cliente API Jueri')).itens[0];
  await ok('POST', `/financeiro/titulos/${aberto.id}/pessoa`, { pessoaId: outra.id });
  const depois = await ok('GET', `/pessoas/${outra.id}`);
  assert.ok(depois.titulos.some((t) => t.id === aberto.id), 'título ligado à pessoa escolhida');
});

// Este fica por último: apaga os dados de teste.
test('CRM: funis, números de WhatsApp, fila de atendimento, chat, conversa interna, gatilhos, disparos e campos', async () => {
  const { createHmac } = await import('node:crypto');
  const sim = async () => (await (await fetch('http://localhost:3199/__recebidos')).json()).filter((r) => !r.caminho.startsWith('/__'));
  const funis = await ok('GET', '/crm/funis');
  const rec = funis.find((f) => f.tipo === 'recrutamento');
  const cli = funis.find((f) => f.tipo === 'clientes');
  const revF = funis.find((f) => f.tipo === 'revendedoras');
  assert.ok(rec && cli && revF, 'três funis instalados');

  // Recrutamento: a candidata do formulário virou card, foi aprovada e o card acompanhou.
  const cards = await ok('GET', `/crm/leads?funilId=${rec.id}&busca=Formulário`);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'ganho', 'aprovada no recrutamento');
  const card = await ok('GET', `/crm/leads/${cards[0].id}`);
  assert.equal(card.origem.utm_source, 'instagram', 'UTM do formulário no card');
  assert.equal(card.contato.camposExtras.Cidade, 'Serra', 'cidade é dado do contato');
  assert.ok(card.pessoa, 'card ligado à revendedora criada');

  // Números: um oficial (Meta) e um por QR code (Z-API).
  const oficial = await ok('POST', '/crm/canais', { nome: 'Matriz oficial', tipo: 'oficial', config: { phoneNumberId: 'PN1', wabaId: 'WABA1', token: 'token-meta-wa', appSecret: 'segredo-app' }, funilEntradaId: cli.id });
  assert.ok(oficial.config.token.startsWith('••••'), 'token nunca volta para a tela');
  const qr = await ok('POST', '/crm/canais', { nome: 'Celular da Ana', tipo: 'qrcode', config: { instancia: 'I1', token: 'T1', clientToken: 'CT1' } });
  assert.ok((await sim()).some((r) => r.caminho.endsWith('update-every-webhooks') && r.corpo.value.includes(`/api/webhooks/whatsapp/${qr.id}/`)), 'webhook da Z-API apontado sozinho');
  assert.equal((await ok('GET', `/crm/canais/${qr.id}/situacao`)).conectado, true);
  assert.match((await ok('GET', `/crm/canais/${oficial.id}/situacao`)).detalhe, /Aritana/);
  const sinc = await ok('POST', `/crm/canais/${oficial.id}/templates`);
  assert.equal(sinc.aprovados, 1);
  const tpl = (await ok('GET', `/crm/templates?canalId=${oficial.id}`)).find((t) => t.nome === 'boas_vindas');
  await ok('PATCH', `/crm/templates/${tpl.id}`, { variaveis: ['primeiro_nome', 'etapa'] });

  // Mensagem chegando pelo oficial, vinda de anúncio "clique para WhatsApp", com assinatura da Meta.
  const hook = oficial.webhook.replace('http://localhost:3100', '');
  const corpoMeta = { entry: [{ changes: [{ value: { contacts: [{ wa_id: '5527911112222', profile: { name: 'Maria Cliente' } }], messages: [{ from: '5527911112222', id: 'wamid.ENTRADA1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi, vi o anúncio dos brincos' }, referral: { source_id: 'AD123', source_type: 'ad', headline: 'Brincos dourados', ctwa_clid: 'CLID9' } }] } }] }] };
  const bruto = JSON.stringify(corpoMeta);
  const assinar = (b) => 'sha256=' + createHmac('sha256', 'segredo-app').update(b).digest('hex');
  assert.equal((await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=errada' }, body: bruto })).status, 403, 'assinatura errada recusada');
  assert.equal((await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(bruto) }, body: bruto })).status, 200);
  const verif = await fetch(API.replace(/\/api$/, '') + hook + `?hub.mode=subscribe&hub.verify_token=${hook.split('/').pop()}&hub.challenge=XYZ`);
  assert.equal(await verif.text(), 'XYZ', 'verificação do webhook pela Meta');

  // Fila de espera: chegou, ninguém pegou.
  let fila = await ok('GET', '/crm/conversas?aba=fila');
  const conv = fila.find((c) => c.telefone === '5527911112222');
  assert.ok(conv, 'conversa nova cai na fila');
  assert.equal(conv.lead.funil, cli.nome, 'card criado no funil de entrada do número');
  const leadMaria = await ok('GET', `/crm/leads/${conv.lead.id}`);
  assert.equal(leadMaria.origem.anuncio_id, 'AD123', 'anúncio de origem no card');
  assert.equal(leadMaria.origem.ctwa_clid, 'CLID9');
  assert.ok((await ok('GET', '/crm/contadores')).fila >= 1);
  await ok('POST', `/crm/conversas/${conv.id}/pegar`);
  assert.ok(!(await ok('GET', '/crm/conversas?aba=fila')).some((c) => c.id === conv.id), 'saiu da fila');
  assert.ok((await ok('GET', '/crm/conversas?aba=minhas')).some((c) => c.id === conv.id), 'agora é minha');

  // Responder dentro da janela de 24h; status de entregue/lida vem pelo webhook.
  const enviada = await ok('POST', `/crm/conversas/${conv.id}/mensagens`, { texto: 'Olá {{primeiro_nome}}! Temos sim.' });
  assert.equal(enviada.texto, 'Olá Maria! Temos sim.');
  const envioMeta = (await sim()).filter((r) => r.caminho === '/meta-wa/PN1/messages').pop();
  assert.equal(envioMeta.corpo.text.body, 'Olá Maria! Temos sim.');
  const st = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: enviada.idExterno, status: 'delivered' }, { id: enviada.idExterno, status: 'read' }] } }] }] });
  await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(st) }, body: st });
  let msgs = await ok('GET', `/crm/conversas/${conv.id}/mensagens`);
  assert.equal(msgs.mensagens.find((m) => m.id === enviada.id).status, 'lida');
  assert.equal(msgs.conversa.dentroDaJanela, true);

  // Conversa interna: não vai para o WhatsApp.
  const antes = (await sim()).length;
  await ok('POST', `/crm/conversas/${conv.id}/interna`, { texto: 'Cliente quer o brinco da vitrine, separar' });
  assert.equal((await sim()).length, antes, 'interna não sai para o cliente');
  msgs = await ok('GET', `/crm/conversas/${conv.id}/mensagens`);
  assert.ok(msgs.mensagens.some((m) => m.direcao === 'interna'));

  // Resolver; o cliente escreve de novo e volta para a fila.
  await ok('POST', `/crm/conversas/${conv.id}/resolver`);
  const volta = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '5527911112222', profile: { name: 'Maria Cliente' } }], messages: [{ from: '5527911112222', id: 'wamid.ENTRADA2', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'midia-recebida-1', mime_type: 'image/png', caption: 'Este aqui' } }] } }] }] });
  await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(volta) }, body: volta });
  fila = await ok('GET', '/crm/conversas?aba=fila');
  assert.ok(fila.some((c) => c.id === conv.id), 'resolvida + mensagem nova = volta para a fila');
  msgs = await ok('GET', `/crm/conversas/${conv.id}/mensagens`);
  const foto = msgs.mensagens.find((m) => m.tipo === 'imagem');
  assert.ok(foto.midia, 'foto recebida guardada');
  assert.equal((await chamar('GET', `/crm/midia/${foto.midia}`)).status, 200);
  assert.equal((await fetch(API + `/crm/midia/${foto.midia}`)).status, 401, 'mídia de conversa só com login');
  await ok('POST', `/crm/conversas/${conv.id}/transferir`, { usuarioId: null });

  // Fora da janela de 24h no oficial: texto livre recusado, template aprovado sai.
  const novo = await ok('POST', '/crm/leads', { funilId: cli.id, nome: 'João Sem Conversa', telefone: '(27) 93333-4444', valor: 15000 });
  const lj = await ok('GET', `/crm/leads/${novo.id}`);
  const cvJ = await ok('POST', `/crm/contatos/${lj.contatoId}/conversa`, { canalId: oficial.id });
  const fora = await chamar('POST', `/crm/conversas/${cvJ.id}/mensagens`, { texto: 'Oi' });
  assert.equal(fora.status, 400);
  assert.match(fora.dados.mensagem, /24h/);
  const t = await ok('POST', `/crm/conversas/${cvJ.id}/mensagens`, { tipo: 'template', templateId: tpl.id, leadId: novo.id });
  assert.equal(t.texto, 'Olá João, bem-vinda à Aritana! Sua etapa: Novo contato.');
  const envioT = (await sim()).filter((r) => r.caminho === '/meta-wa/PN1/messages').pop();
  assert.deepEqual(envioT.corpo.template.components[0].parameters.map((p) => p.text), ['João', 'Novo contato']);
  assert.ok(!(await ok('GET', '/crm/conversas?aba=fila')).some((c) => c.id === cvJ.id), 'conversa aberta pela equipe não entra na fila');

  // Gatilho: entrou em "Em atendimento" → mensagem pelo QR, etiqueta, espera e tarefa.
  const etAtend = cli.etapas.find((e) => e.chave === 'atendimento');
  const g = await ok('POST', '/crm/gatilhos', { nome: 'Boas-vindas atendimento', funilId: cli.id, evento: 'entrou_etapa', etapaId: etAtend.id, acoes: [{ tipo: 'enviar_mensagem', texto: 'Oi {{primeiro_nome}}, já vou te atender!', canalId: qr.id }, { tipo: 'adicionar_etiqueta', etiqueta: 'quente' }, { tipo: 'esperar', minutos: 60 }, { tipo: 'criar_tarefa', titulo: 'Ligar para o João' }] });
  assert.equal((await chamar('POST', '/crm/gatilhos', { nome: 'x', evento: 'entrou_etapa', acoes: [{ tipo: 'enviar_template' }] })).status, 400, 'ação incompleta recusada');
  await ok('PATCH', `/crm/leads/${novo.id}`, { etapaId: etAtend.id });
  await new Promise((r) => setTimeout(r, 400));
  await ok('POST', '/crm/processar');
  const envioZ = (await sim()).filter((r) => r.caminho.endsWith('/send-text')).pop();
  assert.equal(envioZ.corpo.message, 'Oi João, já vou te atender!');
  assert.equal(envioZ.corpo.phone, '5527933334444');
  let lj2 = await ok('GET', `/crm/leads/${novo.id}`);
  assert.ok(lj2.etiquetas.includes('quente'));
  assert.equal(lj2.tarefas.length, 0, 'tarefa só depois da espera');
  assert.equal((await ok('GET', '/crm/gatilhos')).find((x) => x.id === g.id).agendados, 1);

  // Respostas rápidas, templates livres, campos personalizados.
  await ok('POST', '/crm/respostas', { atalho: 'pix', texto: 'Nossa chave Pix é o CNPJ.' });
  const livre = await ok('POST', '/crm/templates', { nome: 'Lembrete de acerto', texto: 'Oi {{primeiro_nome}}, seu acerto vence em breve.' });
  const campo = await ok('POST', '/crm/campos', { entidade: 'lead', nome: 'Peça desejada', tipo: 'texto', funilId: cli.id });
  await ok('PATCH', `/crm/leads/${novo.id}`, { camposExtras: { 'Peça desejada': 'Brinco argola' } });
  await ok('PATCH', `/crm/campos/${campo.id}`, { nome: 'Peça de interesse' });
  assert.equal((await ok('GET', `/crm/leads/${novo.id}`)).camposExtras['Peça de interesse'], 'Brinco argola', 'renomear leva o valor junto');
  await ok('PATCH', `/crm/contatos/${lj.contatoId}`, { camposExtras: { Aniversário: '1990-05-10' } });
  // Campo novo criado pelo card: nome repetido é recusado, ordem muda, aparece no quadro e a busca acha pelo valor.
  assert.equal((await chamar('POST', '/crm/campos', { entidade: 'lead', nome: 'peça de INTERESSE' })).status, 400, 'nome repetido');
  assert.equal((await chamar('POST', '/crm/campos', { entidade: 'lead', nome: 'Tamanhos', tipo: 'multipla' })).status, 400, 'lista sem opções');
  const tam = await ok('POST', '/crm/campos', { entidade: 'lead', nome: 'Tamanhos', tipo: 'multipla', opcoes: ['14', '16', '18'], noQuadro: true });
  assert.equal(tam.noQuadro, true);
  await ok('POST', '/crm/campos/ordem', { ids: [tam.id, campo.id] });
  const defs = (await ok('GET', '/crm/campos')).filter((c) => c.entidade === 'lead');
  assert.ok(defs.findIndex((c) => c.id === tam.id) < defs.findIndex((c) => c.id === campo.id), 'ordem nova');
  await ok('PATCH', `/crm/campos/${tam.id}`, { noQuadro: false, opcoes: ['14', '16', '18', '20'] });
  await ok('PATCH', `/crm/leads/${novo.id}`, { camposExtras: { 'Peça de interesse': 'Brinco argola', Tamanhos: '16; 18' } });
  const achados = await ok('GET', `/crm/leads?funilId=${cli.id}&busca=argola`);
  assert.ok(achados.some((x) => x.id === novo.id && x.camposExtras.Tamanhos === '16; 18'), 'busca pelo valor do campo e lista traz os campos');
  assert.equal(achados.find((x) => x.id === novo.id).contatoExtras['Aniversário'], '1990-05-10');

  // Descadastro: respondeu SAIR pelo QR code.
  const hookQr = qr.webhook.replace('http://localhost:3100', '');
  await fetch(API.replace(/\/api$/, '') + hookQr, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ReceivedCallback', phone: '5527933334444', messageId: 'ZIN1', momment: Date.now(), senderName: 'João', text: { message: 'SAIR' } }) });
  assert.equal((await ok('GET', `/crm/leads/${novo.id}`)).contato.descadastrado, true);
  assert.equal((await fetch(API.replace(/\/api$/, '') + `/api/webhooks/whatsapp/${qr.id}/token-errado`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);

  // Disparo em massa pelo QR code, para o funil de clientes: quem pediu para sair fica de fora.
  // As vendas da loja com cliente identificada (testes de venda acima) já criaram cards em "Comprou".
  const comprou = cli.etapas.find((e) => e.chave === 'comprou');
  const daLoja = await ok('GET', `/crm/leads?funilId=${cli.id}`);
  assert.ok(daLoja.some((l) => l.etapaId === comprou.id), 'venda da loja move a cliente para Comprou');
  const disp = await ok('POST', '/crm/disparos', { nome: 'Novidades de novembro', canalId: qr.id, templateId: livre.id, filtro: { funilId: cli.id, contatoIds: [leadMaria.contatoId, lj.contatoId] }, ritmo: 60 });
  assert.equal(disp.total, 1, 'só a Maria (o João pediu para sair)');
  assert.equal((await chamar('POST', '/crm/disparos', { nome: 'x', canalId: oficial.id, texto: 'oi', filtro: {} })).status, 400, 'oficial só com template');
  await ok('POST', `/crm/disparos/${disp.id}/iniciar`, {});
  await ok('POST', '/crm/processar');
  await ok('POST', '/crm/processar');
  const fim = await ok('GET', `/crm/disparos/${disp.id}`);
  assert.equal(fim.status, 'concluido');
  assert.equal(fim.enviados, 1);
  assert.equal((await sim()).filter((r) => r.caminho.endsWith('/send-text')).pop().corpo.message, 'Oi Maria, seu acerto vence em breve.');

  // Revendedoras: cada uma num card, na etapa conforme as maletas.
  await ok('POST', '/crm/revendedoras/sincronizar'); // (a sincronização diária pode já ter rodado no ciclo)
  const doFunil = await ok('GET', `/crm/leads?funilId=${revF.id}`);
  assert.ok(doFunil.length >= 1);
  assert.equal((await ok('POST', '/crm/revendedoras/sincronizar')).criados, 0, 'de novo não duplica');

  // Softphone: ramal do atendente e ligação no histórico.
  const eu = await ok('GET', '/auth/eu');
  await ok('POST', '/crm/ramais', { usuarioId: eu.id, servidor: 'wss://voz.exemplo.com:7443', usuarioSip: 'sip:1001@voz.exemplo.com', senha: 'senha-ramal' });
  const ramal = await ok('GET', '/crm/ramal');
  assert.equal(ramal.senha, 'senha-ramal');
  assert.ok(!JSON.stringify(await ok('GET', '/crm/ramais')).includes('senha-ramal'), 'lista de ramais não mostra a senha');
  await ok('POST', `/crm/leads/${novo.id}/ligacoes`, { numero: '27933334444', duracaoSeg: 95, resultado: 'atendida' });
  assert.ok((await ok('GET', `/crm/leads/${novo.id}`)).eventos.some((e) => e.tipo === 'ligacao' && e.texto.includes('1min35s')));

  // Etapa de perda exige motivo.
  const perdido = cli.etapas.find((e) => e.tipo === 'perdido');
  assert.equal((await chamar('PATCH', `/crm/leads/${novo.id}`, { etapaId: perdido.id })).status, 400);
  await ok('PATCH', `/crm/leads/${novo.id}`, { etapaId: perdido.id, motivoPerda: 'Achou caro' });
  assert.equal((await ok('GET', `/crm/leads/${novo.id}`)).status, 'perdido');
  // Gatilho de etapa: o card saiu da etapa durante a espera → a tarefa não é criada.
  await ok('POST', '/crm/processar');
  assert.equal((await ok('GET', `/crm/leads/${novo.id}`)).tarefas.length, 0);
});

test('WhatsApp por QR code no servidor próprio: só o nome, QR na tela, recebe e responde', async () => {
  assert.equal((await ok('GET', '/crm/canais-opcoes')).qrcodeProprio, true);
  const c = await ok('POST', '/crm/canais', { nome: 'Celular da vitrine', tipo: 'evolution' });
  assert.ok(c.qrcode?.startsWith('data:image/png;base64,'), 'QR já vem na criação');
  assert.equal(c.config.instancia, `aritana-${c.id}`, 'instância criada pelo sistema, sem nada digitado');
  let sit = await ok('GET', `/crm/canais/${c.id}/situacao`);
  assert.equal(sit.conectado, false);
  assert.ok(sit.qrcode);
  // Leu o QR no celular.
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  sit = await ok('GET', `/crm/canais/${c.id}/situacao`);
  assert.equal(sit.conectado, true);
  assert.equal(sit.numero, '5527977776666');
  // O webhook foi apontado pela rede interna, com o token do canal.
  const criacao = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop();
  assert.ok(criacao.corpo.webhook.url.startsWith(`http://localhost:3100/api/webhooks/whatsapp/${c.id}/`));
  assert.deepEqual(criacao.corpo.webhook.events.sort(), ['CONNECTION_UPDATE', 'MESSAGES_DELETE', 'MESSAGES_UPDATE', 'MESSAGES_UPSERT']);
  const hook = criacao.corpo.webhook.url.replace('http://localhost:3100', '');
  const postar = (b) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  // Mensagem de conta nova (@lid): o número vem no campo alternativo. Grupo é ignorado.
  await postar({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: '123456789@lid', remoteJidAlt: '5527966665555@s.whatsapp.net', fromMe: false, id: 'EVIN1' }, pushName: 'Simone Prado', message: { conversation: 'Oi, vi a vitrine. Tem brinco de pérola?' }, messageType: 'conversation', messageTimestamp: Math.floor(Date.now() / 1000) } });
  await postar({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: '120363@g.us', fromMe: false, id: 'EVGRUPO' }, message: { conversation: 'grupo' }, messageTimestamp: 1 } });
  await postar({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: '5527966665555@s.whatsapp.net', fromMe: false, id: 'EVIN2' }, pushName: 'Simone Prado', message: { imageMessage: { mimetype: 'image/jpeg', caption: 'este aqui' } }, messageTimestamp: Math.floor(Date.now() / 1000) } });
  const fila = await ok('GET', '/crm/conversas?aba=fila');
  const cv = fila.find((x) => x.telefone === '5527966665555');
  assert.ok(cv, 'conversa entrou na fila');
  assert.equal(cv.canal, 'Celular da vitrine');
  const msgs = await ok('GET', `/crm/conversas/${cv.id}/mensagens`);
  const lista = msgs.mensagens ?? msgs;
  assert.ok(lista.some((m) => m.texto === 'Oi, vi a vitrine. Tem brinco de pérola?'));
  const foto = lista.find((m) => m.tipo === 'imagem');
  assert.ok(foto?.midia, 'foto baixada mandando a mensagem inteira de volta ao servidor');
  assert.ok(!lista.some((m) => m.texto === 'grupo'));
  // Responde pelo sistema: sai pelo servidor próprio, e o "entregue" volta pelo webhook.
  await ok('POST', `/crm/conversas/${cv.id}/pegar`);
  const enviada = await ok('POST', `/crm/conversas/${cv.id}/mensagens`, { texto: 'Tem sim, Simone! Te mando as fotos.' });
  const envio = (await recebidos()).filter((r) => r.caminho.startsWith('/evo/message/sendText/')).pop();
  assert.equal(envio.corpo.number, '5527966665555');
  assert.equal(envio.headers.apikey, 'chave-evo-teste');
  await postar({ event: 'messages.update', instance: c.config.instancia, data: { keyId: enviada.idExterno, remoteJid: '5527966665555@s.whatsapp.net', fromMe: true, status: 'DELIVERY_ACK' } });
  const depois = await ok('GET', `/crm/conversas/${cv.id}/mensagens`);
  assert.ok(enviada.idExterno?.startsWith('EVO'), 'id da mensagem veio do servidor');
  assert.equal((depois.mensagens ?? depois).find((m) => m.texto === 'Tem sim, Simone! Te mando as fotos.')?.status, 'entregue');
  // Webhook com token errado é recusado.
  assert.equal((await fetch(API.replace(/\/api$/, '') + `/api/webhooks/whatsapp/${c.id}/errado`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  // Instância sumiu do servidor (reinstalação): o sistema recria sozinho e mostra o QR de novo.
  await fetch(`${SIM}/__evo/apagar?i=${encodeURIComponent(c.config.instancia)}`);
  sit = await ok('GET', `/crm/canais/${c.id}/situacao`);
  assert.equal(sit.conectado, false);
  assert.ok(sit.qrcode, 'recriou a instância');
  // Desconectar pelo sistema.
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  await ok('POST', `/crm/canais/${c.id}/desconectar`, {});
  assert.equal((await ok('GET', `/crm/canais/${c.id}/situacao`)).conectado, false);
  // A Z-API (ID da instância e token) continua disponível como antes.
  assert.equal((await chamar('POST', '/crm/canais', { nome: 'Sem dados', tipo: 'qrcode', config: {} })).status, 400);
});

test('Evolution pelo token: liga uma instância que já existe em outro servidor, sem criar nem apagar nada lá', async () => {
  const fora = `${SIM}/evofora`;
  const ver = async () => (await fetch(`${SIM}/__evo/ver?i=loja-centro`)).json();
  // Faltando dado, token errado, instância que não existe e endereço inválido: recusa com o motivo.
  assert.equal((await chamar('POST', '/crm/canais', { nome: 'Loja', tipo: 'evolution', config: { servidor: fora, instancia: 'loja-centro' } })).status, 400);
  const errado = await chamar('POST', '/crm/canais', { nome: 'Loja', tipo: 'evolution', config: { servidor: fora, instancia: 'loja-centro', token: 'token-errado' } });
  assert.equal(errado.status, 400);
  assert.match(errado.dados.mensagem ?? errado.dados.message, /recusou o token/);
  const semInst = await chamar('POST', '/crm/canais', { nome: 'Loja', tipo: 'evolution', config: { servidor: fora, instancia: 'nao-existe', token: 'token-da-instancia-fora' } });
  assert.match(semInst.dados.mensagem ?? semInst.dados.message, /não existe nesse servidor/);
  assert.equal((await chamar('POST', '/crm/canais', { nome: 'Loja', tipo: 'evolution', config: { servidor: 'ftp://x', instancia: 'loja-centro', token: 'token-da-instancia-fora' } })).status, 400);
  const antes = (await ok('GET', '/crm/canais')).length;

  const c = await ok('POST', '/crm/canais', { nome: 'Loja Centro', tipo: 'evolution', config: { servidor: `${fora}/`, instancia: 'loja-centro', token: 'token-da-instancia-fora' } });
  assert.equal((await ok('GET', '/crm/canais')).length, antes + 1, 'as tentativas recusadas não deixaram número pela metade');
  assert.equal(c.conectado, true, 'a instância já estava conectada: não precisa de QR');
  assert.equal(c.config.servidor, fora);
  assert.equal(c.config.token, '••••fora', 'o token não volta para a tela');
  // O webhook da instância foi apontado para o endereço público do sistema.
  const hookUrl = (await ver()).webhook.url;
  assert.ok(hookUrl.includes(`/api/webhooks/whatsapp/${c.id}/`));
  assert.equal((await ver()).webhook.enabled, true);
  const sit = await ok('GET', `/crm/canais/${c.id}/situacao`);
  assert.deepEqual([sit.conectado, sit.numero], [true, '5527977776666']);
  // Recebe e responde por essa instância, com o token dela.
  const hook = new URL(hookUrl).pathname;
  await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: 'loja-centro', data: { key: { remoteJid: '5527955554444@s.whatsapp.net', fromMe: false, id: 'FORA1' }, pushName: 'Cliente Da Loja', message: { conversation: 'Vocês abrem sábado?' }, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const cv = (await ok('GET', '/crm/conversas?aba=fila')).find((x) => x.telefone === '5527955554444');
  assert.equal(cv?.canal, 'Loja Centro');
  await ok('POST', `/crm/conversas/${cv.id}/pegar`);
  await ok('POST', `/crm/conversas/${cv.id}/mensagens`, { texto: 'Abrimos sim, das 9h às 13h.' });
  const envio = (await recebidos()).filter((r) => r.caminho === '/evofora/message/sendText/loja-centro').pop();
  assert.equal(envio.headers.apikey, 'token-da-instancia-fora');
  // Editar sem mexer no token mantém o token; trocar por um errado é recusado e nada muda.
  await ok('PATCH', `/crm/canais/${c.id}`, { nome: 'Loja Centro 2', config: { servidor: fora, instancia: 'loja-centro', token: '••••fora' } });
  assert.equal((await chamar('PATCH', `/crm/canais/${c.id}`, { config: { servidor: fora, instancia: 'loja-centro', token: 'outro-errado' } })).status, 400);
  assert.equal((await ok('GET', `/crm/canais/${c.id}/situacao`)).conectado, true);
  // Excluir: o sistema para de receber, mas a instância continua existindo no servidor dela.
  await ok('DELETE', `/crm/canais/${c.id}`);
  const depois = await ver();
  assert.ok(depois, 'a instância não foi apagada do servidor de fora');
  assert.equal(depois.webhook.enabled, false);
  assert.equal(depois.estado, 'open', 'nem desconectada');
});

test('chat do CRM: conversa avulsa, responder citando, reagir, apagar para todos, fixar e não lidas', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Chat completo', tipo: 'evolution' });
  const inst = c.config.instancia;
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(inst)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  const postar = (b) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const jid = '5527944443333@s.whatsapp.net';
  const mensagens = async (id) => (await ok('GET', `/crm/conversas/${id}/mensagens`)).mensagens;

  // Conversa avulsa: telefone que nunca falou com a empresa. Já fica com quem abriu, pronta para escrever.
  assert.equal((await chamar('POST', '/crm/conversas/nova', { canalId: c.id, telefone: '123' })).status, 400);
  const nova = await ok('POST', '/crm/conversas/nova', { canalId: c.id, telefone: '(27) 94444-3333', nome: 'Cliente Avulso' });
  assert.equal(nova.status, 'atendimento');
  assert.ok((await ok('GET', '/crm/conversas?aba=minhas')).some((x) => x.id === nova.id && x.contato === 'Cliente Avulso'), 'aparece em "Minhas", sem precisar ter card');
  assert.equal((await ok('POST', '/crm/conversas/nova', { canalId: c.id, telefone: '27944443333' })).id, nova.id, 'o mesmo telefone abre a mesma conversa');
  const primeira = await ok('POST', `/crm/conversas/${nova.id}/mensagens`, { texto: 'Oi! Aqui é da Aritana.' });

  // O contato responde citando a mensagem; a equipe responde citando a dele.
  await postar({ event: 'messages.upsert', instance: inst, data: { key: { remoteJid: jid, fromMe: false, id: 'CIT1' }, pushName: 'Cliente Avulso', message: { extendedTextMessage: { text: 'Quero ver o catálogo', contextInfo: { stanzaId: primeira.idExterno } } }, messageTimestamp: Math.floor(Date.now() / 1000) } });
  let ms = await mensagens(nova.id);
  const dele = ms.find((m) => m.texto === 'Quero ver o catálogo');
  assert.equal(dele.citada.texto, 'Oi! Aqui é da Aritana.', 'a resposta mostra a mensagem citada');
  await ok('POST', `/crm/conversas/${nova.id}/mensagens`, { texto: 'Segue o link!', citarId: dele.id });
  const envio = (await recebidos()).filter((r) => r.caminho.startsWith('/evo/message/sendText/')).pop();
  assert.deepEqual(envio.corpo.quoted, { key: { id: 'CIT1', fromMe: false, remoteJid: jid }, message: { conversation: 'Quero ver o catálogo' } });
  ms = await mensagens(nova.id);
  assert.equal(ms.find((m) => m.texto === 'Segue o link!').citada.id, dele.id);

  // Reações: a equipe reage, o contato reage, e tirar a reação some.
  assert.equal((await chamar('POST', `/crm/conversas/${nova.id}/mensagens/${dele.id}/reagir`, { emoji: 'texto' })).status, 400);
  await ok('POST', `/crm/conversas/${nova.id}/mensagens/${dele.id}/reagir`, { emoji: '❤️' });
  const reacao = (await recebidos()).filter((r) => r.caminho.startsWith('/evo/message/sendReaction/')).pop();
  assert.deepEqual(reacao.corpo, { key: { remoteJid: jid, fromMe: false, id: 'CIT1' }, reaction: '❤️' });
  await postar({ event: 'messages.upsert', instance: inst, data: { key: { remoteJid: jid, fromMe: false, id: 'REAC1' }, message: { reactionMessage: { key: { id: primeira.idExterno, fromMe: true }, text: '👍' } }, messageTimestamp: 1 } });
  ms = await mensagens(nova.id);
  assert.deepEqual(ms.find((m) => m.id === dele.id).reacoes, [{ de: 'equipe', emoji: '❤️' }]);
  assert.deepEqual(ms.find((m) => m.id === primeira.id).reacoes, [{ de: 'contato', emoji: '👍' }]);
  assert.ok(!ms.some((m) => m.texto?.includes('não suportada')), 'reação não vira mensagem');
  await ok('POST', `/crm/conversas/${nova.id}/mensagens/${dele.id}/reagir`, { emoji: '' });
  await postar({ event: 'messages.upsert', instance: inst, data: { key: { remoteJid: jid, fromMe: false, id: 'REAC2' }, message: { reactionMessage: { key: { id: primeira.idExterno, fromMe: true }, text: '' } }, messageTimestamp: 1 } });
  ms = await mensagens(nova.id);
  assert.deepEqual([ms.find((m) => m.id === dele.id).reacoes, ms.find((m) => m.id === primeira.id).reacoes], [[], []]);

  // Apagar para todos: só o que a equipe mandou; o contato apagando a dele também some.
  assert.equal((await chamar('POST', `/crm/conversas/${nova.id}/mensagens/${dele.id}/apagar`)).status, 400);
  await ok('POST', `/crm/conversas/${nova.id}/mensagens/${primeira.id}/apagar`);
  const apagar = (await recebidos()).filter((r) => r.caminho.startsWith('/evo/chat/deleteMessageForEveryone/')).pop();
  assert.equal(apagar.metodo, 'DELETE');
  assert.deepEqual(apagar.corpo, { id: primeira.idExterno, remoteJid: jid, fromMe: true });
  await postar({ event: 'messages.upsert', instance: inst, data: { key: { remoteJid: jid, fromMe: false, id: 'REV1' }, message: { protocolMessage: { type: 'REVOKE', key: { id: 'CIT1' } } }, messageTimestamp: 1 } });
  ms = await mensagens(nova.id);
  for (const id of [primeira.id, dele.id]) assert.deepEqual([ms.find((m) => m.id === id).apagada, ms.find((m) => m.id === id).texto], [true, null]);
  assert.equal((await chamar('POST', `/crm/conversas/${nova.id}/mensagens/${primeira.id}/reagir`, { emoji: '👍' })).status, 400, 'apagada não recebe reação');

  // Cartão de contato recebido vira texto legível.
  await postar({ event: 'messages.upsert', instance: inst, data: { key: { remoteJid: jid, fromMe: false, id: 'CONT1' }, message: { contactMessage: { displayName: 'Maria Vizinha', vcard: 'BEGIN:VCARD\nTEL;waid=5527911112222:+55 27 91111-2222\nEND:VCARD' } }, messageTimestamp: Math.floor(Date.now() / 1000) } });
  assert.ok((await mensagens(nova.id)).some((m) => m.texto === '👤 Maria Vizinha · +5527911112222'));

  // Fixar no topo, marcar como não lida e filtrar só as não lidas.
  await ok('POST', `/crm/conversas/${nova.id}/fixar`, { fixada: true });
  assert.equal((await ok('GET', '/crm/conversas?aba=minhas'))[0].id, nova.id, 'fixada fica em primeiro');
  assert.ok(!(await ok('GET', '/crm/conversas?aba=minhas&naoLidas=1')).some((x) => x.id === nova.id), 'quem está atendendo já leu');
  await ok('POST', `/crm/conversas/${nova.id}/nao-lida`);
  assert.ok((await ok('GET', '/crm/conversas?aba=minhas&naoLidas=1')).some((x) => x.id === nova.id));
  await ok('POST', `/crm/conversas/${nova.id}/fixar`, { fixada: false });

  // A tela de configuração mostra quando o WhatsApp falou com o sistema pela última vez.
  const canal = (await ok('GET', '/crm/canais')).find((x) => x.id === c.id);
  assert.ok(Date.now() - new Date(canal.ultimoWebhookEm).getTime() < 60_000);
  assert.ok(/^https?:\/\/[^/]+\/api\/webhooks\/whatsapp\//.test(canal.webhook), 'o endereço do webhook sempre tem o domínio');
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('conversas: filtros (etiqueta, período, responsável), ações em lote, excluir e unificar contatos repetidos', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Lote e filtros', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  const chegar = (tel, id, texto) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id }, pushName: `Contato ${id}`, message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  await chegar('5527933331111', 'LT1', 'Oi, sou a primeira');
  await chegar('5527933332222', 'LT2', 'Oi, sou a segunda');
  await chegar('5521988887777', 'LT3', 'Mesmo cliente, outro número');
  const lista = async (q) => ok('GET', `/crm/conversas?canalId=${c.id}&${q}`);
  const fila = await lista('aba=fila');
  assert.equal(fila.length, 3);
  const de = (tel) => fila.find((x) => x.telefone === tel);
  const [c1, c2, c3] = [de('5527933331111'), de('5527933332222'), de('5521988887777')];

  // Filtros: etiqueta do contato, período e todas as abas juntas.
  await ok('PATCH', `/crm/contatos/${c1.contatoId}`, { etiquetas: ['vip'] });
  assert.ok((await ok('GET', '/crm/etiquetas')).includes('vip'));
  assert.deepEqual((await lista('aba=fila&etiqueta=vip')).map((x) => x.id), [c1.id]);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  assert.equal((await lista(`aba=fila&de=${hoje}&ate=${hoje}`)).length, 3);
  assert.equal((await lista('aba=fila&ate=2020-01-01')).length, 0);
  assert.equal((await lista('aba=todas')).length, 3);

  // Em lote: pegar não existe, mas marcar lida, resolver e transferir sim; o que não pode fica de fora com o motivo.
  assert.equal((await ok('POST', '/crm/conversas/lote', { ids: [c1.id, c2.id], acao: 'lida' })).feitas, 2);
  assert.equal((await lista('aba=fila&naoLidas=1')).length, 1);
  const eu = (await ok('GET', '/auth/eu')).id ?? (await ok('GET', '/crm/atendentes'))[0].id;
  const tr = await ok('POST', '/crm/conversas/lote', { ids: [c1.id, c2.id], acao: 'transferir', usuarioId: eu });
  assert.equal(tr.feitas, 2);
  assert.equal((await lista(`aba=atendimento&atendenteId=${eu}`)).length, 2, 'filtro por responsável');
  assert.equal((await chamar('POST', '/crm/conversas/lote', { ids: [c1.id], acao: 'transferir' })).status, 400);
  const rs = await ok('POST', '/crm/conversas/lote', { ids: [c2.id, '00000000-0000-4000-8000-000000000000'], acao: 'resolver' });
  assert.deepEqual([rs.feitas, rs.falhas], [1, 1]);
  assert.equal((await lista('aba=resolvidas')).length, 1);
  assert.equal((await ok('POST', '/crm/conversas/lote', { ids: [c1.id], acao: 'fila' })).feitas, 1);

  // Unificar: o outro número é da mesma pessoa. Mensagens e cards passam para o contato principal; o repetido some.
  const funil = (await ok('GET', '/crm/funis'))[0];
  const card = await ok('POST', '/crm/leads', { funilId: funil.id, nome: 'Contato LT3', telefone: '21988887777' });
  const un = await ok('POST', `/crm/conversas/${c1.id}/unificar`, { comConversaId: c3.id });
  assert.deepEqual([un.juntadas, un.cards], [1, 1]);
  const msgs = (await ok('GET', `/crm/conversas/${c1.id}/mensagens`));
  assert.deepEqual(msgs.mensagens.map((m) => m.texto).sort(), ['Mesmo cliente, outro número', 'Oi, sou a primeira']);
  assert.equal(msgs.contato.camposExtras['Outro telefone'], '5521988887777');
  assert.equal((await ok('GET', `/crm/leads/${card.id}`)).contato.id, c1.contatoId, 'o card foi para o contato principal');
  assert.equal((await lista('aba=todas')).length, 2, 'a conversa repetida sumiu');
  assert.equal((await chamar('POST', `/crm/conversas/${c1.id}/unificar`, { comConversaId: c1.id })).status, 400);

  // Excluir a conversa: somem as mensagens, o contato e o card continuam.
  const ex = await ok('DELETE', `/crm/conversas/${c1.id}`);
  assert.equal(ex.mensagens, 2);
  assert.equal((await chamar('GET', `/crm/conversas/${c1.id}/mensagens`)).status, 404);
  assert.equal((await ok('GET', `/crm/leads/${card.id}`)).contato.id, c1.contatoId);
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('agente de IA no WhatsApp: atende a fila, passa para a equipe, sai quando alguém assume, e sugere resposta', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Com IA', tipo: 'evolution' });
  const c2 = await ok('POST', '/crm/canais', { nome: 'Sem IA', tipo: 'evolution' });
  for (const x of [c, c2]) await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(x.config.instancia)}`);
  const hooks = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').slice(-2).map((r) => r.corpo.webhook.url.replace('http://localhost:3100', ''));
  let n = 0;
  const chegar = (hook, inst, tel, message) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: inst, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: `IA${++n}` }, pushName: 'Cliente Da IA', message, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
  const conversa = async (canalId, tel) => (await ok('GET', `/crm/conversas?aba=todas&canalId=${canalId}`)).find((x) => x.telefone === tel);
  const msgs = async (id) => ok('GET', `/crm/conversas/${id}/mensagens`);

  // Sem a chave, não liga; com a chave, liga só no primeiro número.
  assert.equal((await chamar('PUT', '/crm/ia-agente', { ativo: true, canais: [c.id], instrucoes: '', conhecimento: '', maxRespostas: 3 })).status, 400);
  await ok('PUT', '/integracoes/ia', { valores: { ANTHROPIC_API_KEY: 'chave-claude-teste' } });
  // A tela de integrações mostra a IA como ligada e o teste fala com o Claude.
  const ia = (await ok('GET', '/integracoes')).find((i) => i.chave === 'ia');
  assert.deepEqual([ia.ligada, ia.ambiente], [true, 'Claude']);
  assert.match((await ok('POST', '/integracoes/ia/testar', {})).mensagem, /O Claude respondeu/);
  const cfg = await ok('PUT', '/crm/ia-agente', { ativo: true, canais: [c.id], instrucoes: 'Trate por você.', conhecimento: 'Loja em Vila Velha, aberta das 9h às 18h.', maxRespostas: 3 });
  assert.equal(cfg.ligada, true);

  // Duas mensagens seguidas viram uma resposta só, marcada como da IA; a conversa continua na fila.
  await chegar(hooks[0], c.config.instancia, '5527922221111', { conversation: 'Oi' });
  await chegar(hooks[0], c.config.instancia, '5527922221111', { conversation: 'Vocês abrem sábado?' });
  await espera();
  const cv = await conversa(c.id, '5527922221111');
  let d = await msgs(cv.id);
  const daIa = d.mensagens.filter((m) => m.ia && m.direcao === 'saida');
  assert.equal(daIa.length, 1);
  assert.equal(daIa[0].texto, 'Oi! Como posso ajudar?', 'aceita o JSON dentro de bloco de código');
  assert.equal(d.conversa.status, 'fila');
  assert.equal(d.iaAtendendo, true);
  const pedido = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages').pop().corpo;
  assert.equal(pedido.model, 'claude-sonnet-5-5');
  assert.ok(pedido.system.includes('Loja em Vila Velha') && pedido.system.includes('Trate por você.'));
  assert.deepEqual(pedido.messages.map((m) => m.role), ['user'], 'as duas mensagens do cliente foram juntas');
  // No outro número a IA não atende.
  await chegar(hooks[1], c2.config.instancia, '5527922223333', { conversation: 'Oi' });
  await espera();
  assert.equal((await msgs((await conversa(c2.id, '5527922223333')).id)).mensagens.filter((m) => m.ia).length, 0);

  // Pediu atendente: a IA avisa o cliente, deixa o recado para a equipe e sai da conversa.
  await chegar(hooks[0], c.config.instancia, '5527922221111', { conversation: 'Quero falar com um atendente' });
  await espera();
  d = await msgs(cv.id);
  assert.ok(d.mensagens.some((m) => m.ia && m.texto?.startsWith('Claro! Vou chamar alguém')));
  assert.ok(d.mensagens.some((m) => m.direcao === 'interna' && m.texto?.includes('Pediu para falar com atendente.')));
  assert.equal(d.iaAtendendo, false);
  const antes = d.mensagens.filter((m) => m.ia && m.direcao === 'saida').length;
  await chegar(hooks[0], c.config.instancia, '5527922221111', { conversation: 'Alô?' });
  await espera();
  assert.equal((await msgs(cv.id)).mensagens.filter((m) => m.ia && m.direcao === 'saida').length, antes, 'depois de passar, não responde mais');

  // Sugestão de resposta: volta o texto, não envia nada.
  const sug = await ok('POST', `/crm/conversas/${cv.id}/sugerir`);
  assert.equal(sug.texto, 'Oi! Posso te ajudar com mais alguma coisa?', 'sem as aspas');
  assert.equal((await msgs(cv.id)).mensagens.filter((m) => m.direcao === 'saida').length, antes);

  // "Acionar IA" à mão: responde na hora ao cliente que está esperando; a equipe escrevendo desliga.
  await ok('POST', `/crm/conversas/${cv.id}/ia`, { ativa: true });
  await espera();
  assert.equal((await msgs(cv.id)).mensagens.filter((m) => m.ia && m.direcao === 'saida').length, antes + 1);
  await ok('POST', `/crm/conversas/${cv.id}/mensagens`, { texto: 'Oi, aqui é a Ana, da equipe.' });
  assert.equal((await msgs(cv.id)).iaAtendendo, false);
  await chegar(hooks[0], c.config.instancia, '5527922221111', { conversation: 'Oi Ana' });
  await espera();
  assert.equal((await msgs(cv.id)).mensagens.filter((m) => m.ia && m.direcao === 'saida').length, antes + 1, 'com a equipe na conversa, a IA fica quieta');

  // Limite de respostas seguidas e IA fora do ar: a conversa fica na fila com o motivo anotado.
  for (const t of ['um', 'dois', 'três', 'quatro', 'cinco']) { await chegar(hooks[0], c.config.instancia, '5527922224444', { conversation: t }); await espera(900); }
  const lim = await msgs((await conversa(c.id, '5527922224444')).id);
  assert.equal(lim.mensagens.filter((m) => m.ia && m.direcao === 'saida').length, 3);
  assert.ok(lim.mensagens.some((m) => m.direcao === 'interna' && m.texto?.includes('limite de 3 respostas')));
  await chegar(hooks[0], c.config.instancia, '5527922225555', { conversation: 'teste de sobrecarga' });
  await espera();
  const fora = await msgs((await conversa(c.id, '5527922225555')).id);
  assert.ok(fora.mensagens.some((m) => m.direcao === 'interna' && m.texto?.includes('sobrecarregada')));
  assert.equal(fora.conversa.status, 'fila');

  // Foto mandada pelo cliente vai para a IA como imagem.
  await chegar(hooks[0], c.config.instancia, '5527922226666', { imageMessage: { mimetype: 'image/jpeg', caption: 'Tem essa?' } });
  await espera(900);
  const comFoto = await msgs((await conversa(c.id, '5527922226666')).id);
  if (comFoto.mensagens.some((m) => m.midia)) assert.ok(comFoto.mensagens.some((m) => m.ia && m.texto?.includes('Que peça linda na foto!')));

  await ok('PUT', '/crm/ia-agente', { ativo: false, canais: [], instrucoes: '', conhecimento: '', maxRespostas: 10 });
  for (const x of [c, c2]) await ok('DELETE', `/crm/canais/${x.id}`);
});

test('IA fora do chat: reconhecer peça pela foto, sugerir maleta e gerar foto de catálogo', async (t) => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const estado = await ok('GET', '/ia/estado');
  assert.deepEqual([estado.texto, estado.imagem], [true, false], 'Claude ligado no teste anterior; OpenAI ainda não');
  assert.equal((await ok('POST', '/ia/testar')).ok, true);

  // Reconhecer: a IA descreve, o cadastro acha as candidatas, e a IA compara com as fotos do cadastro.
  const pg = createRequire(import.meta.url)('pg');
  const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
  await banco.connect();
  t.after(() => banco.end());
  const locais = await ok('GET', '/estoque/locais');
  const origem = locais.find((l) => l.tipo === 'deposito') ?? locais[0];
  const cat = (await banco.query(`insert into categorias (nome) values ('Brincos IA') returning id`)).rows[0].id;
  const ids = [];
  for (const [ref, desc] of [['IA-ARG-1', 'Brinco argola dourado liso'], ['IA-ARG-2', 'Brinco argola dourado torcido'], ['IA-COL-1', 'Colar ponto de luz']]) {
    const p = (await banco.query(`insert into produtos (codigo_barras, referencia, descricao, categoria_id, preco, custo) values ($1, $1, $2, $3, 8990, 3000) returning id`, [ref, desc, cat])).rows[0].id;
    await banco.query(`insert into saldos (produto_id, local_id, quantidade) values ($1, $2, 4)`, [p, origem.id]);
    ids.push(p);
  }
  // As duas argolas ganham foto (enviada do computador), para a comparação.
  for (const id of ids.slice(0, 2)) assert.equal((await ok('POST', '/ia/foto-produto/usar', { produtoId: id, base64: PNG + (id === ids[0] ? '' : 'AA'), mime: 'image/png' })).fotos.length, 1);
  const rec = await ok('POST', '/ia/reconhecer-peca', { base64: `data:image/png;base64,${PNG}`, mime: 'image/png' });
  assert.equal(rec.descricao, 'Brinco de argola dourado, liso');
  const refs = rec.candidatos.map((c) => c.referencia);
  assert.ok(refs.includes('IA-ARG-1') && refs.includes('IA-ARG-2'));
  assert.ok(!refs.includes('IA-COL-1'), 'o colar não entra: não bate com a descrição');
  assert.equal(rec.candidatos[0].confianca, 92, 'a mais provável vem primeiro, com a confiança');
  assert.ok(rec.candidatos[0].referencia.startsWith('IA-ARG') && rec.candidatos[0].foto, 'as comparadas são as que têm foto');
  assert.equal(rec.candidatos[1].confianca, 20);
  assert.equal(rec.candidatos[0].estoque, 4);
  const comparacao = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages').pop().corpo;
  assert.equal(comparacao.messages[0].content.filter((b) => b.type === 'image').length, 3, 'a foto procurada e as duas do cadastro');
  assert.equal((await chamar('POST', '/ia/reconhecer-peca', { base64: 'x', mime: 'image/png' })).status, 400);

  // Maleta: a sugestão só usa o que existe e o que tem estoque, sem passar do valor alvo.
  const rep = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Revendedora Da IA', telefone1: '27991239999', cidade: 'Vitória', uf: 'ES', limiteCredito: 500000 });
  const sug = await ok('POST', '/ia/sugerir-maleta', { representanteId: rep.id, origemId: origem.id, valorAlvo: 40000 });
  assert.ok(sug.itens.length >= 1 && sug.itens.length <= 3);
  assert.ok(sug.itens.every((i) => i.quantidade >= 1 && i.quantidade <= 4 && i.codigoBarras && i.preco > 0), 'quantidade dentro do estoque');
  assert.ok(!sug.itens.some((i) => i.referencia === 'NAO-EXISTE'), 'referência inventada pela IA é descartada');
  assert.equal(new Set(sug.itens.map((i) => i.produtoId)).size, sug.itens.length, 'sem repetir a peça');
  assert.ok(sug.total <= 40000 * 1.05, 'não passa do valor alvo');
  assert.equal(sug.total, sug.itens.reduce((t, i) => t + i.preco * i.quantidade, 0));
  assert.equal(sug.semHistorico, true);
  assert.equal(sug.resumo, 'Mais brincos, que é o que ela mais vende.');
  assert.equal((await chamar('POST', '/ia/sugerir-maleta', { representanteId: rep.id, origemId: origem.id, valorAlvo: 500 })).status, 400);

  // Foto de catálogo: sem a chave da OpenAI avisa; com a chave gera, e só entra no produto quando aprovada.
  const semChave = await chamar('POST', '/ia/foto-produto', { produtoId: ids[2], estilo: 'fundo_branco', base64: PNG, mime: 'image/png' });
  assert.equal(semChave.status, 503);
  await ok('PUT', '/integracoes/ia', { valores: { OPENAI_API_KEY: 'chave-openai-teste' } });
  assert.equal((await chamar('POST', '/ia/foto-produto', { produtoId: ids[2], estilo: 'fundo_branco' })).status, 400, 'sem foto de origem');
  const gerada = await ok('POST', '/ia/foto-produto', { produtoId: ids[2], estilo: 'modelo', base64: PNG, mime: 'image/png', pedido: 'cabelo preso' });
  assert.match(gerada.url, /^\/api\/fotos\/[a-f0-9]{40}\.png$/);
  const pedidoImg = (await recebidos()).filter((r) => r.caminho === '/openai/v1/images/edits').pop().corpo;
  assert.equal(pedidoImg.size, '1024x1536');
  assert.ok(pedidoImg.prompt.includes('Colar ponto de luz') && pedidoImg.prompt.includes('cabelo preso') && pedidoImg.prompt.includes('exatamente a da foto'));
  assert.ok(pedidoImg.images[0].image_url.startsWith('data:image/png;base64,'));
  assert.equal(pedidoImg.model, undefined, 'sem modelo escolhido, usa o padrão da OpenAI');
  assert.equal((await fetch(API.replace(/\/api$/, '') + gerada.url)).status, 200, 'a foto gerada abre');
  assert.deepEqual((await banco.query('select fotos from produtos where id = $1', [ids[2]])).rows[0].fotos, [], 'ainda não entrou no produto');
  assert.deepEqual((await ok('POST', '/ia/foto-produto/usar', { produtoId: ids[2], url: gerada.url, principal: true })).fotos, [gerada.url]);
  // Gerar a partir de uma foto que já é do produto, e tirar uma foto.
  const outra = await ok('POST', '/ia/foto-produto', { produtoId: ids[2], estilo: 'ambiente', fotoAtual: gerada.url });
  assert.ok(outra.url);
  assert.equal((await chamar('POST', '/ia/foto-produto', { produtoId: ids[2], estilo: 'ambiente', fotoAtual: '/api/fotos/de-outro-produto.png' })).status, 400);
  assert.deepEqual((await ok('POST', '/ia/foto-produto/tirar', { produtoId: ids[2], url: gerada.url })).fotos, []);

  // O consumo do mês aparece por recurso.
  const uso = await ok('GET', '/ia/uso');
  for (const r of ['agente', 'sugestao', 'reconhecer_peca', 'maleta', 'foto', 'teste']) assert.ok(uso.find((x) => x.recurso === r)?.chamadas >= 1, r);
});

test('transcrição de áudio no chat: sozinha quando chega, o agente responde ao que foi falado, botão para tentar de novo', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Áudios', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  let n = 0;
  const chegar = (tel, message) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: `AUD${++n}` }, pushName: 'Cliente do Áudio', message, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const espera = (ms = 900) => new Promise((r) => setTimeout(r, ms));
  const conversa = async (tel) => (await ok('GET', `/crm/conversas?aba=todas&canalId=${c.id}`)).find((x) => x.telefone === tel);
  const ia = (await ok('GET', '/integracoes')).find((i) => i.chave === 'ia');
  assert.equal(ia.ambiente, 'Claude e OpenAI');
  assert.ok(ia.campos.some((x) => x.nome === 'IA_TRANSCREVER_AUTO'));

  // O agente atende este número: espera a transcrição e responde ao que foi falado.
  await ok('PUT', '/crm/ia-agente', { ativo: true, canais: [c.id], instrucoes: '', conhecimento: 'Vendemos brincos, colares e anéis.', maxRespostas: 3 });
  await chegar('5527933331111', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 6, ptt: true, url: 'https://mmg.whatsapp.net/audio-1' } });
  await espera(1500);
  let d = await ok('GET', `/crm/conversas/${(await conversa('5527933331111')).id}/mensagens`);
  assert.equal(d.recursos.transcrever, true);
  const audio = d.mensagens.find((m) => m.tipo === 'audio');
  assert.deepEqual([audio.transcricaoStatus, audio.transcricao], ['feita', 'Oi, vocês têm brinco de argola dourado? Queria ver o preço.']);
  assert.ok(d.mensagens.some((m) => m.ia && m.direcao === 'saida' && m.texto.startsWith('Temos sim!')), 'a IA respondeu ao conteúdo do áudio');
  const chamada = (await recebidos()).filter((r) => r.caminho === '/openai/v1/audio/transcriptions').pop();
  assert.ok(chamada, 'mandou o áudio para a OpenAI');
  assert.match((await conversa('5527933331111')).ultimaMensagem ?? '', /^(🎤 Oi, vocês têm brinco|Temos sim)/, 'a lista mostra o que foi falado (ou a resposta da IA, que veio depois)');
  await ok('PUT', '/crm/ia-agente', { ativo: false, canais: [], instrucoes: '', conhecimento: '', maxRespostas: 10 });

  // Falha: fica marcado com o motivo, e o botão tenta de novo. Transcrição feita não chama a OpenAI outra vez.
  await chegar('5527933332222', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', url: 'https://mmg.whatsapp.net/audio-falha' } });
  await espera();
  const cv2 = (await conversa('5527933332222')).id;
  const ruim = (await ok('GET', `/crm/conversas/${cv2}/mensagens`)).mensagens.find((m) => m.tipo === 'audio');
  assert.equal(ruim.transcricaoStatus, 'falhou');
  assert.match(ruim.transcricaoErro, /corrupted/);
  const r2 = await chamar('POST', `/crm/conversas/${cv2}/mensagens/${ruim.id}/transcrever`);
  assert.equal(r2.status, 400);
  const antes = (await recebidos()).filter((r) => r.caminho === '/openai/v1/audio/transcriptions').length;
  const r3 = await ok('POST', `/crm/conversas/${(await conversa('5527933331111')).id}/mensagens/${audio.id}/transcrever`);
  assert.equal(r3.transcricao, audio.transcricao);
  assert.equal((await recebidos()).filter((r) => r.caminho === '/openai/v1/audio/transcriptions').length, antes, 'não pagou de novo');
  assert.equal((await chamar('POST', `/crm/conversas/${cv2}/mensagens/${audio.id}/transcrever`)).status, 404, 'mensagem de outra conversa');
  const texto = (await ok('GET', `/crm/conversas/${cv2}/mensagens`)).mensagens.find((m) => m.tipo !== 'audio');
  if (texto) assert.equal((await chamar('POST', `/crm/conversas/${cv2}/mensagens/${texto.id}/transcrever`)).status, 400);

  // Desligado o automático: o áudio chega sem transcrição e só transcreve no clique.
  await ok('PUT', '/integracoes/ia', { valores: { IA_TRANSCREVER_AUTO: 'nao' } });
  await chegar('5527933333333', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', url: 'https://mmg.whatsapp.net/audio-3' } });
  await espera();
  const cv3 = (await conversa('5527933333333')).id;
  const manual = (await ok('GET', `/crm/conversas/${cv3}/mensagens`)).mensagens.find((m) => m.tipo === 'audio');
  assert.equal(manual.transcricaoStatus, null);
  assert.match((await ok('POST', `/crm/conversas/${cv3}/mensagens/${manual.id}/transcrever`)).transcricao, /argola/);
  assert.ok((await ok('GET', '/ia/uso')).some((u) => u.recurso === 'transcricao'), 'aparece no consumo da IA');
  await ok('PUT', '/integracoes/ia', { valores: { IA_TRANSCREVER_AUTO: 'sim' } });
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('agente responde em áudio: espelha o áudio do cliente, voz escolhida, sempre com texto junto, exemplo para ouvir', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Áudio de volta', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  let n = 0;
  const chegar = (tel, message) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: `VOZ${++n}` }, pushName: 'Cliente da Voz', message, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const espera = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
  const msgs = async (tel) => (await ok('GET', `/crm/conversas/${(await ok('GET', `/crm/conversas?aba=todas&canalId=${c.id}`)).find((x) => x.telefone === tel).id}/mensagens`)).mensagens.filter((m) => m.ia && m.direcao === 'saida');

  await ok('PUT', '/crm/ia-agente', { ativo: true, canais: [c.id], instrucoes: '', conhecimento: 'Vendemos brincos, colares e anéis.', maxRespostas: 5, respostaAudio: 'espelhar', vozProvedor: 'openai', vozOpenai: 'coral' });
  const cfg = await ok('GET', '/crm/ia-agente');
  assert.equal(cfg.respostaAudio, 'espelhar');
  assert.equal(cfg.voz.disponivel, 'openai');
  // Cliente escreveu: resposta em texto.
  await chegar('5527944441111', { conversation: 'Oi' });
  await espera(900);
  assert.equal((await msgs('5527944441111')).at(-1).tipo, 'texto');
  // Cliente mandou áudio: resposta em áudio, com a voz escolhida; o texto fica guardado para a equipe ler.
  await chegar('5527944441111', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 5, ptt: true, url: 'https://mmg.whatsapp.net/audio-1' } });
  await espera();
  const resposta = (await msgs('5527944441111')).at(-1);
  assert.equal(resposta.tipo, 'audio');
  assert.match(resposta.texto, /^Temos sim!/);
  const tts = (await recebidos()).filter((r) => r.caminho === '/openai/v1/audio/speech').pop();
  assert.equal(tts.corpo.voice, 'coral');
  assert.match(tts.corpo.input, /^Temos sim!/);
  assert.ok((await recebidos()).some((r) => r.caminho.includes('message/sendWhatsAppAudio')), 'saiu como áudio de WhatsApp');
  // "Sempre", com o texto junto.
  await ok('PUT', '/crm/ia-agente', { ativo: true, canais: [c.id], instrucoes: '', conhecimento: 'Vendemos brincos.', maxRespostas: 5, respostaAudio: 'sempre', audioComTexto: true });
  await chegar('5527944442222', { conversation: 'Oi' });
  await espera();
  assert.deepEqual((await msgs('5527944442222')).map((m) => m.tipo), ['audio', 'texto']);
  // Exemplo da voz.
  const ex = await fetch(API + '/crm/ia-agente/ouvir', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ texto: 'Oi!', provedor: 'openai', voz: 'nova' }) });
  assert.equal(ex.headers.get('content-type'), 'audio/mpeg');
  await ok('PUT', '/crm/ia-agente', { ativo: false, canais: [], instrucoes: '', conhecimento: '', maxRespostas: 10, respostaAudio: 'nunca', audioComTexto: false });
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('multiagentes: recepção pergunta e escolhe o especialista, troca quando o assunto muda, limite de trocas, mesmo nome', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Multiagentes', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  let n = 0;
  const tel = '5527944445555';
  const chegar = (texto) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: `MULTI${++n}` }, pushName: 'Cliente Multi', message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const espera = (ms = 700) => new Promise((r) => setTimeout(r, ms));
  const msgs = async () => {
    const cv = (await ok('GET', `/crm/conversas?aba=todas&canalId=${c.id}`)).find((x) => x.telefone === tel);
    return (await ok('GET', `/crm/conversas/${cv.id}/mensagens`)).mensagens;
  };

  // Especialistas sugeridos; não duplica se pedir de novo.
  const lista = await ok('POST', '/crm/ia-agentes/sugeridos');
  assert.deepEqual(lista.map((a) => a.funcao), ['vendas', 'recrutamento', 'revendedora']);
  assert.equal((await ok('POST', '/crm/ia-agentes/sugeridos')).length, 3);
  assert.equal((await chamar('POST', '/crm/ia-agentes', { funcao: 'vendas', nome: 'Outro', quando: 'Duplicado de propósito' })).status, 400);
  assert.equal((await chamar('POST', '/crm/ia-agentes', { funcao: 'Pós Venda', nome: 'Pós', quando: 'Chave com espaço e maiúscula' })).status, 400);
  const pos = await ok('POST', '/crm/ia-agentes', { funcao: 'posvenda', nome: 'Pós-venda', quando: 'Troca, defeito ou garantia de peça comprada.', ativo: false });
  assert.equal((await ok('GET', '/crm/ia-agente')).especialistas.length, 4);
  await ok('PUT', '/crm/ia-agente', { ativo: true, canais: [c.id], instrucoes: '', conhecimento: 'Vendemos semijoias.', maxRespostas: 8, nome: 'Ari', maxTransferencias: 2 });

  // 1) Só "oi": a recepção pergunta (com o modelo barato).
  await chegar('Oi');
  await espera();
  let m = await msgs();
  assert.equal(m.at(-1).texto, 'Oi! Me conta o que você está procurando? 😊');
  const triagem = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages' && r.corpo.system.includes('recepção do WhatsApp')).pop();
  assert.equal(triagem.corpo.model, 'claude-haiku-5-5', 'recepção usa o modelo da triagem');
  assert.ok(!triagem.corpo.system.includes('"posvenda"'), 'especialista desligado não entra na triagem');

  // 2) Fala de peça: vai para Vendas, com recado interno, e Vendas responde.
  await chegar('Queria ver brinco de argola');
  await espera();
  m = await msgs();
  assert.ok(m.some((x) => x.direcao === 'interna' && x.texto.startsWith('🤖 Recepção → Vendas')));
  assert.match(m.at(-1).texto, /^Temos várias argolas!/);

  // 3) Muda de assunto: Vendas passa para "Quero revender" sem mandar nada, e ela responde com o mesmo nome.
  await chegar('Na verdade eu quero revender');
  await espera();
  m = await msgs();
  assert.ok(m.some((x) => x.direcao === 'interna' && x.texto.startsWith('🤖 Vendas → Quero revender')));
  assert.equal(m.filter((x) => x.direcao === 'saida' && x.texto === '').length, 0, 'a troca não manda mensagem vazia');
  assert.match(m.at(-1).texto, /aqui é a Ari! Em qual cidade/);

  // 4) Pula de assunto de novo: passa do limite de 2 trocas e vai para a equipe.
  await chegar('E a maleta, como funciona?');
  await espera(1000);
  m = await msgs();
  assert.ok(m.some((x) => x.direcao === 'interna' && x.texto.startsWith('🤖 Quero revender → Vendas')));
  assert.match(m.filter((x) => x.direcao === 'interna').at(-1).texto, /A IA passou esta conversa para a equipe\. Mudou de assunto mais de 2 vez/);

  // A equipe assume e devolve para a fila: começa de novo pela recepção.
  const cv = (await ok('GET', `/crm/conversas?aba=todas&canalId=${c.id}`)).find((x) => x.telefone === tel);
  await ok('POST', `/crm/conversas/${cv.id}/ia`, { ativa: true });
  await espera();
  m = await msgs();
  assert.ok(m.filter((x) => x.direcao === 'interna' && x.texto.startsWith('🤖 Recepção →')).length >= 2, 'religada, a IA começa de novo pela recepção (trocas zeradas)');
  assert.equal(m.at(-1).direcao, 'saida', 'e responde quem estava esperando');

  await ok('PATCH', `/crm/ia-agentes/${pos.id}`, { ativo: true, quando: 'Troca, defeito ou garantia de peça já comprada.' });
  await ok('DELETE', `/crm/ia-agentes/${pos.id}`);
  assert.equal((await ok('GET', '/crm/ia-agente')).especialistas.length, 3);
  await ok('PUT', '/crm/ia-agente', { ativo: false, canais: [], instrucoes: '', conhecimento: '', maxRespostas: 10 });
  for (const a of lista) await ok('DELETE', `/crm/ia-agentes/${a.id}`);
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('RH e ponto: cadastro, login pelo CPF, batida com foto e GPS, ajustes, espelho, ciência, documentos, AFD/AEJ e contabilidade', async () => {
  const gestor = token;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const menos = (n) => new Date(Date.now() - 3 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
  const empresas = await ok('GET', '/empresas');
  const emp = empresas.find((e) => e.cnpj) ?? empresas[0];
  const escala = (await ok('GET', '/rh/escalas')).find((e) => e.nome === 'Comercial 44h');
  assert.ok(escala, 'escala de exemplo criada pela migração');
  await ok('POST', '/rh/locais', { nome: 'Loja Centro', latitude: -20.3297, longitude: -40.2925, raioM: 150 });
  const cfg = await ok('GET', '/rh/config');
  await ok('PUT', '/rh/config', { ...cfg, cercaGps: 'bloquear', exigirFoto: true, contabilidadeEmail: 'dp@contabil.exemplo' });
  const grupos = await ok('GET', '/rh/grupos');
  const soPonto = grupos.find((g) => g.nome === 'Somente ponto');
  assert.ok(soPonto, 'grupo "Somente ponto" criado pela migração');

  const base = { empresaId: emp.id, nome: 'Carlos Motoboy da Silva', cpf: '529.982.247-25', cargo: 'Motoboy', escalaId: escala.id, dataAdmissao: menos(70), salario: 180000 };
  assert.equal((await chamar('POST', '/rh/funcionarios', { ...base, cpf: '111.111.111-11' })).status, 400, 'CPF inválido');
  const f = await ok('POST', '/rh/funcionarios', { ...base, acesso: { grupoId: soPonto.id } });
  assert.equal(f.acessoCriado.login, '52998224725', 'sem e-mail, o login é o CPF');
  assert.equal((await chamar('POST', '/rh/funcionarios', base)).status, 400, 'CPF repetido');

  // O motoboy entra com o CPF, troca a senha provisória e só enxerga o ponto.
  token = '';
  const login = await ok('POST', '/auth/login', { email: '529.982.247-25', senha: f.acessoCriado.senha });
  assert.equal(login.trocarSenha, true);
  token = login.token;
  await ok('POST', '/auth/trocar-senha', { atual: f.acessoCriado.senha, nova: 'MotoboySenha2026' });
  const eu = await ok('GET', '/ponto/eu');
  assert.equal(eu.eFuncionario, true);
  assert.equal(eu.exigirFoto, true);
  assert.equal((await chamar('GET', '/rh/resumo')).status, 403, 'sem acesso ao RH');
  assert.equal((await chamar('GET', '/maletas')).status, 403, 'sem acesso a nada além do ponto');

  // Batida: sem foto recusa; longe da loja recusa (cerca em "bloquear"); na loja grava com NSR e hash.
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
  assert.equal((await chamar('POST', '/ponto/marcar', { latitude: -20.3297, longitude: -40.2925, precisao: 10 })).status, 400, 'foto obrigatória');
  const longe = await chamar('POST', '/ponto/marcar', { latitude: -20.5, longitude: -40.5, precisao: 10, foto: jpeg });
  assert.equal(longe.status, 400);
  assert.match(longe.dados.mensagem, /local de trabalho/);
  const c1 = await ok('POST', '/ponto/marcar', { latitude: -20.3298, longitude: -40.2926, precisao: 15, foto: jpeg });
  assert.equal(c1.titulo, 'Comprovante de Registro de Ponto do Trabalhador');
  assert.match(c1.hash, /^[0-9a-f]{64}$/);
  assert.ok(c1.nsr >= 2, 'o NSR 1 é a inclusão do empregado (registro tipo 5)');
  assert.match(c1.dataHora, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-0300$/);
  assert.equal((await chamar('POST', '/ponto/marcar', { latitude: -20.3298, longitude: -40.2926, foto: jpeg })).status, 400, 'segunda batida no mesmo minuto é recusada');
  assert.equal((await ok('GET', '/ponto/eu')).marcacoes.length, 1);
  assert.equal((await ok('GET', `/ponto/comprovante/${c1.id}`)).nsr, c1.nsr);

  // Gestor ajusta um dia útil do mês passado (o motoboy esqueceu de bater): inclusões com motivo.
  token = gestor;
  const feriados = new Set([...regras.feriadosNacionais(Number(menos(40).slice(0, 4))).map((x) => x.data)]);
  const mesPassado = (() => { const [a, m] = hoje.split('-').map(Number); return new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7); })();
  let dia = `${mesPassado}-08`;
  while ([0, 6].includes(new Date(`${dia}T12:00:00Z`).getUTCDay()) || feriados.has(dia)) dia = new Date(new Date(`${dia}T12:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
  for (const hora of ['07:45', '12:00', '13:00', '18:20']) await ok('POST', '/rh/tratamentos', { tipo: 'inclusao', funcionarioId: f.id, data: dia, hora, motivo: 'Esqueceu de bater, confirmado pela gerente' });
  assert.equal((await chamar('POST', '/rh/tratamentos', { tipo: 'inclusao', funcionarioId: f.id, data: dia, hora: '09:00', motivo: 'x' })).status, 400, 'motivo curto demais');
  // Atestado no dia seguinte útil: não é falta.
  let diaAtestado = new Date(new Date(`${dia}T12:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
  while ([0, 6].includes(new Date(`${diaAtestado}T12:00:00Z`).getUTCDay()) || feriados.has(diaAtestado)) diaAtestado = new Date(new Date(`${diaAtestado}T12:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
  await ok('POST', `/rh/funcionarios/${f.id}/ocorrencias`, { tipo: 'atestado', de: diaAtestado, ate: diaAtestado, observacao: 'Atestado de 1 dia' });
  const esp = await ok('GET', `/rh/espelho/${f.id}?competencia=${mesPassado}`);
  const d1 = esp.dias.find((x) => x.data === dia);
  assert.equal(d1.marcacoes.length, 4);
  assert.ok(d1.marcacoes.every((m) => m.origem === 'incluida'));
  assert.equal(d1.extra50, 47, 'chegou 15 min antes e saiu 32 min depois');
  const d2 = esp.dias.find((x) => x.data === diaAtestado);
  assert.equal(d2.faltaDia, false);
  assert.equal(d2.ocorrencia, 'Atestado médico');
  assert.ok(esp.totais.faltasDias > 0, 'os outros dias úteis sem batida são falta');

  // Hoje: desconsidera a batida real (fica guardada, só não conta).
  await ok('POST', '/rh/tratamentos', { tipo: 'desconsiderar', funcionarioId: f.id, registroId: c1.id, motivo: 'Bateu por engano antes de sair de casa' });
  const espHoje = await ok('GET', `/rh/espelho/${f.id}?competencia=${hoje.slice(0, 7)}`);
  assert.equal(espHoje.dias.find((x) => x.data === hoje).marcacoes[0].desconsiderada, true);

  // Fecha o mês passado; o funcionário confirma pelo celular.
  const fech = await ok('POST', '/rh/fechar', { competencia: mesPassado });
  assert.ok(fech.fechados >= 1);
  token = (await ok('POST', '/auth/login', { email: '52998224725', senha: 'MotoboySenha2026' })).token;
  assert.ok((await ok('GET', '/ponto/eu')).espelhosParaConfirmar.includes(mesPassado));
  await ok('POST', `/ponto/espelho/${mesPassado}/ciente`, {});
  assert.equal((await chamar('POST', `/ponto/espelho/${mesPassado}/ciente`, {})).status, 400, 'confirma uma vez só');

  // Contracheque na pasta: o funcionário vê, baixa e confirma o recebimento; o que é só do RH ele não vê.
  token = gestor;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  const cc = await ok('POST', `/rh/funcionarios/${f.id}/documentos`, { tipo: 'contracheque', competencia: mesPassado, nomeArquivo: 'holerite.pdf', mime: 'application/pdf', base64: pdf });
  assert.match(cc.titulo, /^Contracheque \d{2}\/\d{4}$/);
  await ok('POST', `/rh/funcionarios/${f.id}/documentos`, { tipo: 'aso_admissional', validade: menos(-20), nomeArquivo: 'aso.pdf', mime: 'application/pdf', base64: pdf, visivelFuncionario: false });
  assert.ok((await ok('GET', '/rh/vencimentos')).some((v) => v.funcionarioId === f.id), 'exame vencendo em 20 dias aparece no alerta');
  token = (await ok('POST', '/auth/login', { email: '52998224725', senha: 'MotoboySenha2026' })).token;
  const meus = await ok('GET', '/ponto/documentos');
  assert.equal(meus.length, 1, 'só o que foi liberado');
  const arq = await fetch(`${API}/ponto/documentos/${meus[0].id}/arquivo`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(arq.status, 200);
  assert.match(await arq.text(), /^%PDF/);
  await ok('POST', `/ponto/documentos/${meus[0].id}/ciente`, {});

  // Arquivos oficiais e pacote para a contabilidade.
  token = gestor;
  const de = `${mesPassado}-01`;
  const afd = await fetch(`${API}/rh/afd?empresaId=${emp.id}&de=${menos(80)}&ate=${hoje}`, { headers: { authorization: `Bearer ${token}` } });
  if (emp.cnpj) {
    assert.equal(afd.status, 200);
    const linhas = Buffer.from(await afd.arrayBuffer()).toString('latin1').split('\r\n').filter(Boolean);
    assert.equal(linhas[0].length, 302);
    assert.ok(linhas.some((l) => l[9] === '5' && l.includes('Carlos Motoboy')), 'registro de inclusão do empregado');
    const m7 = linhas.find((l) => l[9] === '7');
    assert.equal(m7.length, 137);
    assert.equal(m7.slice(73), c1.hash, 'marcação com o mesmo hash do comprovante');
    const aej = await fetch(`${API}/rh/aej?empresaId=${emp.id}&de=${de}&ate=${hoje}`, { headers: { authorization: `Bearer ${token}` } });
    const txt = Buffer.from(await aej.arrayBuffer()).toString('latin1');
    assert.match(txt, /^01\|1\|/);
    assert.match(txt, /\|I\|[^|]*\|Esqueceu de bater/, 'inclusões com motivo no AEJ');
    assert.match(txt, /\|D\|000\|O\|\|Bateu por engano/, 'desconsideração com motivo');

    // Certificado A1 da empresa: o AFD sai num .zip com a assinatura .p7s, conferida pelo OpenSSL.
    const forge = createRequire(import.meta.url)('node-forge');
    const pfx = (cnpj, validade = '2030-01-01') => {
      const k = forge.pki.rsa.generateKeyPair(1024);
      const c = forge.pki.createCertificate();
      c.publicKey = k.publicKey; c.serialNumber = '0a0b';
      c.validity.notBefore = new Date('2026-01-01'); c.validity.notAfter = new Date(validade);
      const n = [{ shortName: 'CN', value: `EMPRESA TESTE:${cnpj}` }];
      c.setSubject(n); c.setIssuer(n); c.sign(k.privateKey, forge.md.sha256.create());
      return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(k.privateKey, [c], 'senha-cert', { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
    };
    const cnpjEmp = emp.cnpj.replace(/\D/g, '');
    assert.equal((await chamar('POST', `/rh/certificados/${emp.id}`, { base64: pfx(cnpjEmp), senha: 'errada' })).status, 400, 'senha errada');
    assert.match((await chamar('POST', `/rh/certificados/${emp.id}`, { base64: pfx('99888777000166'), senha: 'senha-cert' })).dados.mensagem, /outra empresa/);
    assert.match((await chamar('POST', `/rh/certificados/${emp.id}`, { base64: pfx(cnpjEmp, '2026-02-01'), senha: 'senha-cert' })).dados.mensagem, /venceu/);
    const cert = await ok('POST', `/rh/certificados/${emp.id}`, { base64: pfx(cnpjEmp), senha: 'senha-cert' });
    assert.equal(cert.cnpj, cnpjEmp);
    const lista = await ok('GET', '/rh/certificados');
    assert.equal(lista.find((x) => x.empresaId === emp.id).situacao, 'ok');
    assert.ok(!JSON.stringify(lista).includes('senha-cert') && !JSON.stringify(lista).includes('pfx'), 'nem arquivo nem senha voltam');
    const zip = await fetch(`${API}/rh/afd?empresaId=${emp.id}&de=${menos(80)}&ate=${hoje}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    const { unzipSync } = createRequire(import.meta.url)('fflate');
    const arqs = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const nomeAfd = Object.keys(arqs).find((n) => !n.endsWith('.p7s'));
    assert.ok(arqs[`${nomeAfd}.p7s`], 'assinatura com o mesmo nome + .p7s');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync('/tmp/afd-');
    writeFileSync(`${dir}/a.txt`, arqs[nomeAfd]);
    writeFileSync(`${dir}/a.p7s`, arqs[`${nomeAfd}.p7s`]);
    execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', `${dir}/a.p7s`, '-content', `${dir}/a.txt`, '-noverify', '-out', '/dev/null'], { stdio: 'pipe' });
    const prevAfd = await ok('POST', '/rh/contabilidade/previa', { competencia: mesPassado, itens: ['afd'] });
    assert.ok(prevAfd.arquivos.some((a) => a.nome.endsWith('.p7s')), 'pacote da contabilidade leva a assinatura');
    await ok('DELETE', `/rh/certificados/${emp.id}`);
    assert.equal((await fetch(`${API}/rh/afd?empresaId=${emp.id}&de=${menos(80)}&ate=${hoje}`, { headers: { authorization: `Bearer ${token}` } })).headers.get('content-type'), 'text/plain; charset=ISO-8859-1');
  }
  const previa = await ok('POST', '/rh/contabilidade/previa', { competencia: mesPassado, itens: ['ponto_resumo', 'ponto_diario', 'ocorrencias', 'movimentacoes', 'vendas', 'comissoes', 'documentos'] });
  const nomes = previa.arquivos.map((a) => a.nome);
  assert.ok(nomes.some((n) => n.startsWith('ponto-resumo-')));
  assert.ok(nomes.some((n) => n.startsWith('comissoes-')));
  const resumoCsv = await fetch(`${API}/rh/contabilidade/arquivo`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ competencia: mesPassado, itens: ['ponto_resumo'], nome: nomes.find((n) => n.startsWith('ponto-resumo-')) }) });
  const csvTxt = await resumoCsv.text();
  assert.match(csvTxt, /Carlos Motoboy da Silva;52998224725;Motoboy;/);
  assert.match(csvTxt, /;sim;\d{2}\/\d{2}\/\d{4}/, 'mês fechado e confirmado pelo funcionário');
  const env = await ok('POST', '/rh/contabilidade/enviar', { competencia: mesPassado, itens: ['ponto_resumo', 'ocorrencias'], canal: 'email', destino: 'dp@contabil.exemplo' });
  assert.equal(env.status, 'enviado');
  const zapi = (await ok('GET', '/crm/canais')).find((c) => c.tipo === 'qrcode');
  if (zapi) {
    const envW = await ok('POST', '/rh/contabilidade/enviar', { competencia: mesPassado, itens: ['ponto_resumo'], canal: 'whatsapp', destino: '27999112233', canalId: zapi.id });
    assert.equal(envW.status, 'enviado');
    assert.ok((await recebidos()).some((r) => r.caminho.includes('/send-document/csv')), 'arquivo foi como documento no WhatsApp');
  }
  assert.ok((await ok('GET', '/rh/envios')).length >= 1);

  // Arquivo que não é PDF nem imagem (ou diz ser HTML) nunca abre dentro do sistema: sai como download.
  const html = await ok('POST', `/rh/funcionarios/${f.id}/documentos`, { tipo: 'outro', nomeArquivo: 'pagina.html', mime: 'text/html', base64: Buffer.from('<script>alert(1)</script>').toString('base64') });
  const baixado = await fetch(`${API}/rh/documentos/${html.id}/arquivo`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(baixado.headers.get('content-type'), 'application/octet-stream');
  assert.match(baixado.headers.get('content-disposition'), /^attachment/);
  const pdfAberto = await fetch(`${API}/rh/documentos/${cc.id}/arquivo`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(pdfAberto.headers.get('content-type'), 'application/pdf');
  assert.match(pdfAberto.headers.get('content-disposition'), /^inline/);

  // Ajuste em mês já fechado e confirmado: o fechamento deixa de valer (fecha de novo, confirma de novo).
  assert.ok((await ok('GET', `/rh/espelho/${f.id}?competencia=${mesPassado}`)).fechamento?.cienteEm, 'estava fechado e confirmado');
  const aj = await ok('POST', '/rh/tratamentos', { tipo: 'inclusao', funcionarioId: f.id, data: `${mesPassado}-10`, hora: '08:00', motivo: 'Batida esquecida, achada depois do fechamento' });
  assert.equal((await ok('GET', `/rh/espelho/${f.id}?competencia=${mesPassado}`)).fechamento, null, 'mês reaberto pelo ajuste');
  await ok('DELETE', `/rh/tratamentos/${aj.id}`);
  await ok('POST', '/rh/fechar', { competencia: mesPassado, funcionarioIds: [f.id] });
  assert.equal((await ok('GET', `/rh/espelho/${f.id}?competencia=${mesPassado}`)).fechamento.cienteEm, null, 'precisa confirmar de novo');

  // Quem cuida do RH não troca a senha nem rebaixa o acesso de quem tem mais acesso que ele.
  const chefe = await ok('POST', '/rh/funcionarios', { ...base, nome: 'Diretora Teste', cpf: '111.444.777-35', cargo: 'Diretora', acesso: { grupoId: grupos.find((g) => g.nome === 'Diretoria').id, email: 'diretora.rh@aritana.local' } });
  const gRh = await ok('POST', '/grupos', { nome: 'RH teste', permissoes: { rh: ['ver', 'criar', 'editar'] } });
  const uRh = await ok('POST', '/usuarios', { nome: 'Analista RH', email: 'rh.teste@aritana.local', grupoId: gRh.id });
  token = (await ok('POST', '/auth/login', { email: 'rh.teste@aritana.local', senha: uRh.senhaProvisoria })).token;
  await ok('POST', '/auth/trocar-senha', { atual: uRh.senhaProvisoria, nova: 'AnalistaRh2026x' });
  assert.equal((await chamar('POST', `/rh/funcionarios/${chefe.id}/acesso`, { grupoId: soPonto.id })).status, 403, 'não toma a conta da diretora');
  assert.equal((await chamar('POST', `/rh/funcionarios/${f.id}/acesso`, { grupoId: soPonto.id, email: 'diretora.rh@aritana.local' })).status, 400, 'e-mail de outra pessoa');
  assert.ok((await ok('POST', `/rh/funcionarios/${f.id}/acesso`, { grupoId: soPonto.id })).senhaProvisoria.senha, 'do motoboy ela pode refazer');
  token = gestor;

  // Desligamento: o acesso é cortado e o ponto não pode mais ser batido.
  await ok('POST', `/rh/funcionarios/${f.id}/desligar`, { data: hoje, motivo: 'Pedido de demissão' });
  token = '';
  assert.equal((await chamar('POST', '/auth/login', { email: '52998224725', senha: 'MotoboySenha2026' })).status, 401);
  token = gestor;
});

test('limite olha a maleta inteira depois de acerto parcial; indicadores batem entre si', async () => {
  const dia = (n) => new Date(Date.now() - 3 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
  const regras = await ok('GET', '/configuracoes/regras-consignado');
  await ok('PUT', '/configuracoes/regras-consignado', { ...regras, multaAtrasoPb: 0, jurosMesPb: 0, diasParaBloquear: 0 });
  const p = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Parcial Indicadores', telefone1: '27999991234', cidade: 'Serra', uf: 'ES', modeloTrabalho: 'consignado', limiteCredito: 100000 });
  await ok('PATCH', `/pessoas/${p.id}`, { status: 'ativo' });
  const [a, b] = (await ok('GET', '/produtos')).itens.slice(20, 22).sort((x, y) => y.preco - x.preco);
  const m = await ok('POST', '/maletas', { representanteId: p.id, origemId: ctx.deposito.id, dataRetirada: dia(10), itens: [{ codigoBarras: a.codigoBarras, quantidade: 2 }, { codigoBarras: b.codigoBarras, quantidade: 2 }], liberarExcecao: true });
  const base = { forma: 'avista', modalidade: 'presencial', parcelas: 1, formaPagamento: 'pix', pagoAgora: true };
  // 1º acerto (parcial): vendeu as duas peças mais caras. 2º acerto fecha devolvendo o resto.
  await ok('POST', `/maletas/${m.id}/prebaixa`, { itens: [{ produtoId: a.id, vendida: 2, devolvida: 0 }] });
  const r1 = await ok('POST', `/maletas/${m.id}/acerto`, { ...base, parcial: true, itens: [{ produtoId: a.id, vendida: 2, devolvida: 0, perdida: 0 }] });
  assert.equal(r1.fechou, false);
  const depoisParcial = await ok('GET', `/maletas/${m.id}`);
  assert.ok(depoisParcial.itens.every((i) => i.prebaixaVendida == null), 'acerto parcial zera a pré-baixa (já foi acertada)');
  assert.equal(r1.limiteNovo, 100000, 'parcial não mexe no limite');
  const r2 = await ok('POST', `/maletas/${m.id}/acerto`, { ...base, parcial: false, itens: [{ produtoId: b.id, vendida: 0, devolvida: 2, perdida: 0 }] });
  assert.equal(r2.fechou, true);
  assert.equal(r2.resultado.percentualVendidoPb, 0, 'o último pedaço, sozinho, não vendeu nada');
  assert.ok(r2.limiteNovo > 100000, 'mas a maleta inteira bateu a meta: o limite sobe');

  // Indicadores: mesmas fontes, mesmos números.
  const q = `de=${dia(700)}&ate=${dia(0)}`;
  const g = await ok('GET', `/indicadores/geral?${q}`);
  const des = await ok('GET', `/relatorios/desempenho?${q}`);
  assert.equal(g.atual.rede, des.linhas.reduce((s, l) => s + l.vendido, 0), 'rede = soma do desempenho');
  assert.equal(g.atual.lucroBruto, g.atual.faturamento - g.atual.comissaoRede - g.atual.cmv);
  assert.ok(g.atual.devolucoes > 0, 'devolução da loja aparece e já está descontada');
  assert.ok(g.atual.cmv > 0 && g.atual.margemPb > 0 && g.atual.margemPb < 10000);
  assert.equal(g.serie.length, 12);
  assert.ok(Array.isArray(g.alertas));
  const pr = await ok('GET', `/indicadores/produtos?${q}`);
  assert.ok(Math.abs(pr.resumo.faturamento - g.atual.faturamento) < 100, `produtos ${pr.resumo.faturamento} x geral ${g.atual.faturamento}`);
  assert.equal(pr.resumo.cmv, g.atual.cmv);
  assert.equal(typeof pr.maisVendidos[0].codigo_barras, 'string', 'código de barras continua texto');
  const rd = await ok('GET', `/indicadores/rede?${q}`);
  const eu = rd.linhas.find((l) => l.id === p.id);
  assert.equal(eu.acertos, 2);
  assert.equal(eu.vendido, a.preco * 2);
  assert.equal(eu.sell_through_pb, 5000, '2 de 4 peças');
  assert.equal(rd.resumo.vendido, g.atual.rede);
  const fin = await ok('GET', '/indicadores/financeiro');
  assert.equal(fin.meses.length, 6);
  assert.equal(fin.fluxo.length, 8);
  const crm = await ok('GET', `/indicadores/crm?${q}`);
  assert.ok(crm.funis.length >= 3);
  assert.equal((await chamar('GET', '/indicadores/geral?de=2026-02-30&ate=x')).status, 400);
  // Cartão não é inadimplência: a venda no crédito (títulos da maquininha) não entra em "vencido".
  const ini = await ok('GET', '/painel/inicio');
  assert.equal(typeof ini.financeiro.vencido, 'number');
});

test('conciliação de cartão: marca vários, informa o depósito, baixa tudo e lança a taxa como despesa', async () => {
  const loja = (await ok('GET', '/estoque/locais')).find((l) => l.tipo === 'loja');
  const p = (await ok('GET', '/produtos')).itens.find((x) => x.preco >= 1000);
  await ok('POST', '/estoque/entradas', { destinoId: loja.id, itens: [{ codigoBarras: p.codigoBarras, quantidade: 3 }] });
  for (const forma of ['debito', 'credito', 'credito']) await ok('POST', '/vendas', { localId: loja.id, tipo: 'avulsa', itens: [{ codigoBarras: p.codigoBarras, quantidade: 1 }], pagamentos: [{ forma, valor: p.preco, maquininha: 'Stone', parcelas: forma === 'credito' ? 2 : 1 }] });
  const c = await ok('GET', '/financeiro/cartao');
  const deb = c.grupos.find((g) => g.forma === 'debito' && g.maquininha === 'Stone');
  assert.ok(deb && deb.total >= p.preco, 'débito agrupado pela maquininha');
  const cred = c.grupos.filter((g) => g.forma === 'credito' && g.maquininha === 'Stone');
  assert.ok(cred.length >= 2, 'parcelas do crédito em dias diferentes');
  const ids = [...deb.ids, ...cred[0].ids];
  const bruto = c.itens.filter((i) => ids.includes(i.id)).reduce((a, i) => a + i.valor, 0);
  const conta = (await ok('GET', '/financeiro/contas')).find((x) => x.empresa === deb.empresa);
  const outra = (await ok('GET', '/financeiro/contas')).find((x) => x.empresa !== deb.empresa);
  if (outra) assert.equal((await chamar('POST', '/financeiro/cartao/conciliar', { ids, valorRecebido: bruto, recebidoEm: c.hoje, contaId: outra.id })).status, 400, 'conta de outra empresa');
  assert.equal((await chamar('POST', '/financeiro/cartao/conciliar', { ids, valorRecebido: bruto + 1, recebidoEm: c.hoje, contaId: conta.id })).status, 400, 'caiu mais que o marcado');
  const alta = await chamar('POST', '/financeiro/cartao/conciliar', { ids, valorRecebido: Math.round(bruto * 0.5), recebidoEm: c.hoje, contaId: conta.id });
  assert.equal(alta.status, 400);
  assert.match(alta.dados.mensagem, /confirme a diferença/);
  const taxa = Math.round(bruto * 0.025);
  const r = await ok('POST', '/financeiro/cartao/conciliar', { ids, valorRecebido: bruto - taxa, recebidoEm: c.hoje, contaId: conta.id });
  assert.equal(r.quantidade, ids.length);
  assert.equal(r.taxa, taxa);
  const contaDepois = (await ok('GET', '/financeiro/contas')).find((x) => x.id === conta.id);
  assert.equal(contaDepois.saldo - conta.saldo, bruto - taxa, 'saldo da conta bate com o extrato');
  const despesas = await ok('GET', '/financeiro/titulos?tipo=pagar&aba=pagos&busca=Taxa da maquininha');
  assert.ok(despesas.itens.some((t) => t.valor === taxa && t.categoria === 'Taxas de cartão'));
  const depois = await ok('GET', '/financeiro/cartao');
  assert.ok(ids.every((id) => !depois.itens.some((i) => i.id === id)), 'saem da lista de cartão');
  assert.equal((await chamar('POST', '/financeiro/cartao/conciliar', { ids, valorRecebido: bruto, recebidoEm: c.hoje, contaId: conta.id })).status, 400, 'não concilia duas vezes');
});

test('agenda: marca, avisa conflito, gera Meet pelo Google, lembra no WhatsApp e a representante confirma no portal', async () => {
  const pg = createRequire(import.meta.url)('pg');
  const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
  await banco.connect();
  const admin = token;
  try {
    const rep = (await ok('GET', '/pessoas?tipo=representante')).itens.find((p) => p.telefone1 && p.status === 'ativo');
    const daqui = (min) => new Date(Date.now() + min * 60_000).toISOString();
    const textos = async () => (await recebidos()).map((r) => JSON.stringify(r.corpo ?? ''));

    // Sem Google: marca, mas avisa que falta o link.
    let t = await ok('GET', '/agenda/tipos');
    assert.equal(t.google.conectado, false);
    assert.match(t.google.retorno, /\/api\/agenda\/google\/retorno$/);
    const a = await ok('POST', '/agenda', { tipo: 'acerto_video', inicio: daqui(48 * 60), duracaoMin: 45, online: true, pessoaId: rep.id, avisar: true });
    assert.match(a.titulo, /Acerto por vídeo/);
    assert.ok(a.avisos.some((x) => /conecte a conta Google/.test(x)));
    assert.equal(a.link, null);
    assert.ok((await textos()).some((x) => x.includes('Marcamos') && x.includes('Acerto por v')), 'aviso de marcado foi pelo WhatsApp');
    // Mesmo responsável, mesmo horário: avisa; com "marcar mesmo assim", marca.
    const bate = await chamar('POST', '/agenda', { tipo: 'reuniao', titulo: 'Reunião de equipe', inicio: daqui(48 * 60 + 15), duracaoMin: 30, online: false, local: 'Matriz', avisar: false });
    assert.equal(bate.status, 409);
    assert.match(bate.dados.mensagem, /Bate com/);
    await ok('POST', '/agenda', { tipo: 'reuniao', titulo: 'Reunião de equipe', inicio: daqui(48 * 60 + 15), duracaoMin: 30, online: false, local: 'Matriz', avisar: false, forcar: true });
    assert.equal((await chamar('POST', '/agenda', { tipo: 'outro', inicio: daqui(60), duracaoMin: 30, online: true, link: 'javascript:alert(1)', avisar: false })).status, 400, 'link só https');

    // Conecta o Google pelo OAuth (o navegador volta do Google com code e state).
    await ok('PUT', '/integracoes/google', { valores: { GOOGLE_CLIENT_ID: 'cliente.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'segredo-google-teste-123' } });
    assert.match((await ok('POST', '/integracoes/google/testar')).mensagem, /Conectar conta Google/, 'testar antes de conectar explica o próximo passo');
    const { url } = await ok('GET', '/agenda/google/conectar');
    const u = new URL(url);
    assert.equal(u.searchParams.get('client_id'), 'cliente.apps.googleusercontent.com');
    assert.match(u.searchParams.get('scope'), /calendar\.events/);
    assert.equal(u.searchParams.get('access_type'), 'offline');
    const ruim = await fetch(`${API}/agenda/google/retorno?code=codigo-bom&state=inventado`, { redirect: 'manual' });
    assert.match(ruim.headers.get('location'), /google=erro$/, 'state que o sistema não gerou é recusado');
    const volta = await fetch(`${API}/agenda/google/retorno?code=codigo-bom&state=${u.searchParams.get('state')}`, { redirect: 'manual' });
    assert.equal(volta.status, 302);
    assert.match(volta.headers.get('location'), /\/agenda\?google=ok$/);
    assert.equal((await fetch(`${API}/agenda/google/retorno?code=codigo-bom&state=${u.searchParams.get('state')}`, { redirect: 'manual' })).headers.get('location').endsWith('google=erro'), true, 'o mesmo state não serve duas vezes');
    t = await ok('GET', '/agenda/tipos');
    assert.equal(t.google.conectado, true);
    assert.equal(t.google.conta, 'agenda@aritana.com.br');
    assert.match((await ok('POST', '/integracoes/google/testar')).mensagem, /Conectado ao Google Agenda como agenda@aritana\.com\.br/);
    assert.ok(!JSON.stringify(await ok('GET', '/integracoes/status')).includes('refresh-google-1'), 'o token do Google nunca volta para a tela');

    // Online com Google: evento na agenda com Meet.
    const r = await ok('POST', '/agenda', { tipo: 'reuniao', titulo: 'Treinamento de vendas', inicio: daqui(72 * 60), duracaoMin: 60, online: true, pessoaId: rep.id, avisar: false });
    assert.match(r.link, /^https:\/\/meet\.google\.com\//);
    assert.ok(r.googleEventoId);
    let evs = await (await fetch('http://localhost:3199/google/__eventos')).json();
    const ev = evs.find((e) => e.id === r.googleEventoId);
    assert.equal(ev.summary, 'Treinamento de vendas');
    assert.equal(ev.start.timeZone, 'America/Sao_Paulo');
    // Remarcar atualiza o Google e mantém o mesmo Meet.
    const novoInicio = daqui(73 * 60);
    const r2 = await ok('PATCH', `/agenda/${r.id}`, { inicio: novoInicio });
    assert.equal(r2.link, r.link);
    evs = await (await fetch('http://localhost:3199/google/__eventos')).json();
    assert.equal(new Date(evs.find((e) => e.id === r.googleEventoId).start.dateTime).toISOString(), novoInicio);
    // O que já passou não pode ser marcado como feito antes da hora; cancelar apaga do Google.
    assert.equal((await chamar('POST', `/agenda/${r.id}/situacao`, { status: 'realizado' })).status, 400);
    await ok('POST', `/agenda/${r.id}/situacao`, { status: 'cancelado', motivo: 'Mudou a data do treinamento' });
    evs = await (await fetch('http://localhost:3199/google/__eventos')).json();
    assert.ok(!evs.some((e) => e.id === r.googleEventoId), 'evento apagado do Google');
    assert.ok(!(await ok('GET', `/agenda?de=${daqui(0)}&ate=${daqui(5 * 24 * 60)}`)).some((c) => c.id === r.id), 'cancelado sai da agenda');

    // Lembretes: véspera (para o que foi marcado com antecedência) e uma hora antes; cada um sai uma vez.
    const v = await ok('POST', '/agenda', { tipo: 'retirada', inicio: daqui(20 * 60), duracaoMin: 30, online: false, local: 'Matriz, Vila Velha', pessoaId: rep.id, avisar: true, forcar: true });
    const h = await ok('POST', '/agenda', { tipo: 'entrevista', inicio: daqui(40), duracaoMin: 30, online: true, convidadoNome: 'Candidata Agenda', convidadoTelefone: '27991239999', avisar: true, forcar: true });
    assert.match(h.link, /meet\.google\.com/);
    // Marcado em cima da hora (40 min antes): o aviso de "marcado" já saiu, o de "daqui a pouco" não sai em seguida.
    assert.equal((await ok('POST', '/agenda/lembretes')).enviados, 0);
    assert.ok(!(await textos()).some((x) => x.includes('Daqui a pouco')));
    const h2 = await ok('POST', '/agenda', { tipo: 'entrevista', inicio: daqui(50), duracaoMin: 30, online: true, convidadoNome: 'Candidata Lembrete', convidadoTelefone: '27991238888', avisar: true, forcar: true });
    await banco.query(`update agenda_compromissos set criado_em = now() - interval '3 days', lembrete_dia_em = null where id = any($1)`, [[v.id, h2.id]]);
    // Remarcar um compromisso marcado sem aviso não religa o aviso.
    const semAviso = await ok('POST', '/agenda', { tipo: 'outro', titulo: 'Sem aviso', inicio: daqui(30 * 60), duracaoMin: 30, online: false, local: 'Sala 2', observacao: 'levar mostruário', pessoaId: rep.id, avisar: false, forcar: true });
    const remarcado = await ok('PATCH', `/agenda/${semAviso.id}`, { inicio: daqui(31 * 60), forcar: true });
    assert.equal(remarcado.avisar, false);
    assert.equal(remarcado.local, 'Sala 2', 'remarcar mantém o local');
    assert.equal(remarcado.observacao, 'levar mostruário');
    assert.ok(!(await textos()).some((x) => x.includes('Mudamos o horário') && x.includes('Sem aviso')));
    const l1 = await ok('POST', '/agenda/lembretes');
    assert.ok(l1.enviados >= 2);
    assert.equal((await ok('POST', '/agenda/lembretes')).enviados, 0, 'não repete');
    const tx = await textos();
    assert.ok(tx.some((x) => x.includes('Lembrete') && x.includes('Matriz, Vila Velha')));
    assert.ok(tx.some((x) => x.includes('Daqui a pouco') && x.includes('meet.google.com')));

    // Portal: a representante vê e confirma.
    token = admin;
    const link = await ok('POST', `/portal/gerar-link/${rep.id}`);
    token = (await ok('POST', `/portal/link/${link.token}`)).token;
    const meus = await ok('GET', '/portal/agenda');
    assert.ok(meus.some((c) => c.id === v.id));
    assert.ok(!meus.some((c) => c.id === r.id), 'cancelado não aparece');
    await ok('POST', `/portal/agenda/${v.id}/confirmar`);
    assert.equal((await ok('GET', '/portal/agenda')).find((c) => c.id === v.id).status, 'confirmado');
    assert.equal((await chamar('POST', `/portal/agenda/${h.id}/confirmar`)).status, 404, 'só confirma o que é dela');
    token = admin;

    // Desconectar: volta a marcar sem Google.
    await ok('POST', '/agenda/google/desconectar');
    assert.equal((await ok('GET', '/agenda/tipos')).google.conectado, false);
  } finally {
    token = admin;
    await banco.end();
  }
});

test('números de WhatsApp: excluir apaga o que nunca foi usado e arquiva o que tem conversas', async () => {
  const pg = createRequire(import.meta.url)('pg');
  const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
  await banco.connect();
  try {
    const novo = await ok('POST', '/crm/canais', { nome: 'Número para excluir', tipo: 'evolution' });
    const r1 = await ok('DELETE', `/crm/canais/${novo.id}`);
    assert.equal(r1.apagado, true, 'sem conversas: apaga de vez');
    assert.ok(!(await ok('GET', '/crm/canais')).some((c) => c.id === novo.id));
    const inst = await fetch(`http://localhost:3199/evo/instance/connectionState/aritana-${novo.id}`, { headers: { apikey: 'chave-evo-teste' } });
    assert.equal(inst.status, 404, 'a sessão no servidor de WhatsApp também foi apagada');

    const usado = await ok('POST', '/crm/canais', { nome: 'Número com histórico', tipo: 'evolution' });
    const contato = (await banco.query(`insert into crm_contatos (telefone, nome) values ('5527988887777', 'Cliente Histórico') returning id`)).rows[0];
    const cv = (await banco.query(`insert into crm_conversas (contato_id, canal_id, status) values ($1, $2, 'fila') returning id`, [contato.id, usado.id])).rows[0];
    const r2 = await ok('DELETE', `/crm/canais/${usado.id}`);
    assert.equal(r2.apagado, false);
    assert.equal(r2.conversas, 1);
    assert.ok(!(await ok('GET', '/crm/canais')).some((c) => c.id === usado.id), 'some da tela');
    const linha = (await banco.query('select ativo, excluido_em, config from crm_canais where id = $1', [usado.id])).rows[0];
    assert.equal(linha.ativo, false);
    assert.ok(linha.excluido_em);
    assert.deepEqual(linha.config, {}, 'credenciais apagadas');
    assert.equal((await banco.query('select status from crm_conversas where id = $1', [cv.id])).rows[0].status, 'resolvida', 'conversa continua, encerrada');
    assert.equal((await chamar('PATCH', `/crm/canais/${usado.id}`, { ativo: true })).status, 400, 'não reativa um número excluído');
  } finally {
    await banco.end();
  }
});

test('leads por localização: vai para a consultora mais perto, ela aceita no portal, prazo vencido passa para a próxima', async () => {
  const pg = createRequire(import.meta.url)('pg');
  const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
  await banco.connect();
  try {
    const funis = await ok('GET', '/crm/funis');
    const clientes = funis.find((f) => f.tipo === 'clientes');
    const recrut = funis.find((f) => f.tipo === 'recrutamento');
    await ok('PUT', `/crm/distribuicao/${clientes.id}`, { ativo: true, destino: 'consultoras', raioKm: 40, prazoMinutos: 30, maxTentativas: 2, maxAbertos: 5, avisarWhatsapp: false });
    const cfgs = await ok('GET', '/crm/distribuicao');
    assert.ok(cfgs.funis.some((x) => x.funil.id === clientes.id && x.config.raioKm === 40));
    assert.equal(typeof cfgs.semCidade.total, 'number');
    // Anúncio → formulário de cliente → card no funil Clientes → consultora mais perto.
    const form = await ok('POST', '/formularios', {
      titulo: 'Quero comprar semijoias', acao: 'cliente', funilId: clientes.id,
      campos: [
        { id: 'nome', tipo: 'texto', rotulo: 'Seu nome', obrigatorio: true, papel: 'nome' },
        { id: 'tel', tipo: 'telefone', rotulo: 'WhatsApp', obrigatorio: true, papel: 'telefone' },
        { id: 'cidade', tipo: 'texto', rotulo: 'Cidade', obrigatorio: true, papel: 'cidade' },
        { id: 'peca', tipo: 'escolha', rotulo: 'O que procura', obrigatorio: false, opcoes: ['Brincos', 'Colares'] },
      ],
    });
    const responder = (nome, tel, cidade) => ok('POST', `/publico/formularios/${form.slug}`, { respostas: { nome, tel, cidade, peca: 'Brincos' }, origem: { utm_campaign: 'novembro' } });
    await responder('Cliente Perto Vila Velha', '27991110001', 'Vila Velha');
    // A distribuição roda logo depois de criar o card (em segundo plano): espera ela terminar.
    const acha = async (nome, funil = clientes.id) => {
      for (let i = 0; i < 40; i++) {
        const c = (await ok('GET', `/crm/leads?funilId=${funil}&busca=${encodeURIComponent(nome)}`))[0];
        if (c?.distribuicao) return c;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`card de ${nome} não foi distribuído`);
    };
    let card = await acha('Cliente Perto Vila Velha');
    assert.ok(card, 'formulário de cliente abriu card no funil');
    let det = await ok('GET', `/crm/leads/${card.id}`);
    assert.equal(det.distribuicao, 'aguardando');
    const perto = await ok('GET', `/crm/leads/${card.id}/perto`);
    assert.equal(perto.local.cidade, 'Vila Velha');
    assert.equal(det.consultoraId, perto.lista[0].id, 'a mais perto recebe');
    assert.equal(det.distanciaKm, perto.lista[0].distanciaKm);
    assert.ok(perto.lista.every((x, i, a) => i === 0 || a[i - 1].distanciaKm <= x.distanciaKm), 'lista em ordem de distância');
    assert.equal(det.camposExtras['O que procura'], 'Brincos');
    assert.equal(card.consultora, det.consultora.nome, 'nome da consultora aparece no quadro');

    // Portal: antes de aceitar, só o primeiro nome e sem telefone; depois, tudo.
    const admin = token;
    const entrar = async (pessoaId) => { token = admin; const link = await ok('POST', `/portal/gerar-link/${pessoaId}`); token = (await ok('POST', `/portal/link/${link.token}`)).token; };
    await entrar(det.consultoraId);
    let meus = await ok('GET', '/portal/leads');
    let meu = meus.find((x) => x.id === card.id);
    assert.equal(meu.nome, 'Cliente');
    assert.equal(meu.telefone, null);
    assert.ok(meu.aceitarAte);
    await ok('POST', `/portal/leads/${card.id}/aceitar`);
    meu = (await ok('GET', '/portal/leads')).find((x) => x.id === card.id);
    assert.equal(meu.nome, 'Cliente Perto Vila Velha');
    assert.match(meu.telefone, /991110001$/);
    assert.ok(meu.interesse.some(([k, v]) => k === 'O que procura' && v === 'Brincos'));
    // Campo interno posto pela equipe no card não aparece para a consultora.
    token = admin;
    await ok('PATCH', `/crm/leads/${card.id}`, { camposExtras: { ...det.camposExtras, 'CPF da cliente': '111.444.777-35', 'Observação interna': 'cliente difícil' } });
    await entrar(det.consultoraId);
    const visto = (await ok('GET', '/portal/leads')).find((x) => x.id === card.id).interesse.map(([k]) => k);
    assert.ok(visto.includes('O que procura') && !visto.some((k) => /CPF|Observa/.test(k)), 'dado interno não vai para o portal');
    await ok('POST', `/portal/leads/${card.id}/resultado`, { deuCerto: true });
    token = admin;
    det = await ok('GET', `/crm/leads/${card.id}`);
    const comprou = (await ok('GET', '/crm/funis')).find((f) => f.id === clientes.id).etapas.find((e) => e.chave === 'comprou');
    assert.equal(det.etapaId, comprou.id, 'vendeu: card vai para "Comprou" (segue para o pós-venda)');
    assert.equal(det.distribuicao, 'concluido');

    // Prazo vencido sem aceite → próxima mais perto; esgotadas as tentativas → volta para a equipe.
    await responder('Cliente Prazo Vencido', '27991110002', 'Vitória');
    card = await acha('Cliente Prazo Vencido');
    const primeira = (await ok('GET', `/crm/leads/${card.id}`)).consultoraId;
    await banco.query(`update crm_leads set distribuido_em = now() - interval '31 minutes' where id = $1`, [card.id]);
    assert.ok((await ok('POST', '/crm/distribuicao/verificar-prazos')).movidos >= 1);
    det = await ok('GET', `/crm/leads/${card.id}`);
    assert.notEqual(det.consultoraId, primeira, 'passou para outra');
    assert.equal(det.distribuicao, 'aguardando');
    assert.equal(det.jaOferecido.length, 2);
    await entrar(primeira);
    assert.equal((await chamar('POST', `/portal/leads/${card.id}/aceitar`)).status, 404, 'quem perdeu o prazo não aceita mais');
    await entrar(det.consultoraId);
    await ok('POST', `/portal/leads/${card.id}/recusar`, { motivo: 'Estou viajando' });
    token = admin;
    det = await ok('GET', `/crm/leads/${card.id}`);
    assert.equal(det.distribuicao, 'devolvido', 'duas tentativas: volta para a equipe');
    assert.equal(det.consultoraId, null);
    assert.ok(det.etiquetas.includes('Sem consultora'));
    assert.ok(det.eventos.some((e) => /Estou viajando/.test(e.texto)));
    // A equipe escolhe na mão.
    const escolhida = (await ok('GET', `/crm/leads/${card.id}/perto`)).lista[3];
    await ok('POST', `/crm/leads/${card.id}/distribuir`, { pessoaId: escolhida.id });
    assert.equal((await ok('GET', `/crm/leads/${card.id}`)).consultoraId, escolhida.id);
    await ok('POST', `/crm/leads/${card.id}/devolver`);
    assert.equal((await ok('GET', `/crm/leads/${card.id}`)).distribuicao, 'devolvido');

    // Longe de todas (fora do raio): fica com a equipe e o motivo aparece no card.
    await responder('Cliente Manaus Longe', '92991110003', 'Manaus');
    det = await ok('GET', `/crm/leads/${(await acha('Cliente Manaus Longe')).id}`);
    assert.equal(det.distribuicao, 'sem_consultora');
    assert.ok(det.eventos.some((e) => /40 km de Manaus\/AM/.test(e.texto)));

    // Recrutamento: a candidata vai para a líder mais perto; aprovada, essa líder vira a líder dela.
    await ok('PUT', `/crm/distribuicao/${recrut.id}`, { ativo: true, destino: 'lideres', raioKm: 100, prazoMinutos: 60, maxTentativas: 3, maxAbertos: 20, avisarWhatsapp: false });
    await ok('POST', '/crm/candidaturas', { nome: 'Candidata Da Lider Perto', telefone: '27991110004', cidade: 'Vila Velha', uf: 'ES', modeloInteresse: 'consignado', consentimentoLgpd: true });
    const cc = await acha('Candidata Da Lider Perto', recrut.id);
    det = await ok('GET', `/crm/leads/${cc.id}`);
    assert.equal(det.distribuicao, 'aguardando');
    const lider = det.consultoraId;
    assert.ok((await ok('GET', `/pessoas?liderId=${lider}`)).itens.length > 0 || /l[ií]der/i.test(det.consultora.nome), 'foi para uma líder');
    await entrar(lider);
    const minha = (await ok('GET', '/portal/leads')).find((x) => x.id === cc.id);
    assert.equal(minha.tipo, 'candidata');
    await ok('POST', `/portal/leads/${cc.id}/aceitar`);
    await ok('POST', `/portal/leads/${cc.id}/resultado`, { deuCerto: true, motivo: 'Já vende roupas, tem clientela' });
    token = admin;
    det = await ok('GET', `/crm/leads/${cc.id}`);
    assert.ok(det.etiquetas.includes('Líder recomenda'));
    assert.equal(det.status, 'aberto', 'no recrutamento quem aprova é a matriz');
    const nova = await ok('POST', `/crm/candidaturas/${det.candidaturaId}/aprovar`, { modeloTrabalho: 'consignado' });
    const ficha = await ok('GET', `/pessoas/${nova.pessoaId}`);
    assert.equal(ficha.liderId, lider, 'a líder que atendeu vira a líder da nova revendedora');
    await ok('PUT', `/crm/distribuicao/${recrut.id}`, { ativo: false, destino: 'lideres', raioKm: 100, prazoMinutos: 60, maxTentativas: 3, maxAbertos: 20, avisarWhatsapp: false });
    await ok('PUT', `/crm/distribuicao/${clientes.id}`, { ativo: false, destino: 'consultoras', raioKm: 40, prazoMinutos: 30, maxTentativas: 2, maxAbertos: 5, avisarWhatsapp: false });
  } finally {
    await banco.end();
  }
});

test('metas do mês: define, recusa repetida, acompanha venda nova e mostra o ritmo', async () => {
  const comp = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const loja = (await ok('GET', '/estoque/locais')).find((l) => l.tipo === 'loja');
  assert.equal((await chamar('PUT', '/metas', { competencia: comp, metas: [{ tipo: 'lojas', valor: 100 }, { tipo: 'lojas', valor: 200 }] })).status, 400, 'meta repetida');
  assert.equal((await chamar('PUT', '/metas', { competencia: comp, metas: [{ tipo: 'local', valor: 100 }] })).status, 400, 'local sem loja');
  assert.equal((await chamar('PUT', '/metas', { competencia: '2026-13', metas: [] })).status, 400);
  const r = await ok('PUT', '/metas', { competencia: comp, metas: [{ tipo: 'faturamento', valor: 10_000_000 }, { tipo: 'local', localId: loja.id, valor: 5_000_000 }, { tipo: 'novas_revendedoras', valor: 3 }] });
  assert.equal(r.linhas.length, 3);
  const antes = r.linhas.find((l) => l.tipo === 'local');
  assert.equal(antes.nome, loja.nome);
  assert.ok(['no_ritmo', 'perto', 'abaixo', 'batida', 'nao_batida'].includes(antes.situacao));
  assert.equal(r.linhas.find((l) => l.tipo === 'novas_revendedoras').dinheiro, false);
  // uma venda nova na loja entra no realizado da loja e do faturamento
  const p = (await ok('GET', '/produtos')).itens.find((x) => x.preco > 0);
  await ok('POST', '/estoque/entradas', { destinoId: loja.id, itens: [{ codigoBarras: p.codigoBarras, quantidade: 1 }] });
  await ok('POST', '/vendas', { localId: loja.id, tipo: 'avulsa', itens: [{ codigoBarras: p.codigoBarras, quantidade: 1 }], pagamentos: [{ forma: 'pix', valor: p.preco }] });
  const d = await ok('GET', `/metas?competencia=${comp}`);
  const depois = d.linhas.find((l) => l.tipo === 'local');
  assert.equal(depois.realizado - antes.realizado, p.preco);
  assert.equal(d.linhas.find((l) => l.tipo === 'faturamento').realizado - r.linhas.find((l) => l.tipo === 'faturamento').realizado, p.preco);
  assert.equal(depois.falta, Math.max(0, 5_000_000 - depois.realizado));
  // mês sem metas devolve lista vazia; gravar vazio apaga as do mês
  assert.equal((await ok('GET', '/metas?competencia=2020-01')).linhas.length, 0);
  assert.equal((await ok('PUT', '/metas', { competencia: '2020-01', metas: [] })).linhas.length, 0);
});

test('venda pelo link: afiliada vende do estoque da matriz com comissão; consultora vende da maleta e a peça vai para a pré-baixa', async () => {
  const admin = token;
  const mes = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
  try {
    await ok('PUT', '/configuracoes/chave/regras_link', { ativo: true, localId: ctx.deposito.id, comissaoPb: 1000, catalogoMatrizSemMaleta: true, aceitaEntrega: true, mensagemFinal: 'Obrigada! Já já falamos com você.' });
    const prod = (await ok('GET', '/produtos')).itens.find((x) => x.preco >= 1000 && x.codigoBarras);
    await ok('POST', '/estoque/entradas', { destinoId: ctx.deposito.id, itens: [{ codigoBarras: prod.codigoBarras, quantidade: 5 }] });
    const af = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Afiliada Link Teste', modeloTrabalho: 'afiliado', telefone1: '27991230001', cidade: 'Serra', uf: 'ES' });
    token = '';
    // Afiliada: catálogo com o estoque da matriz.
    let cat = await ok('GET', `/publico/catalogo/${af.slug}`);
    assert.equal(cat.origem, 'matriz');
    assert.equal(cat.pedidos.ativo, true);
    const peca = cat.pecas.find((x) => x.id === prod.id);
    assert.ok(peca.disponivel >= 5);
    const antes = peca.disponivel;
    const pedir = (slug, corpo) => chamar('POST', `/publico/catalogo/${slug}/pedido`, { nome: 'Cliente do Link', telefone: '(27) 99888-1001', cidade: 'Serra', entrega: 'combinar', consentimento: true, ...corpo });
    assert.equal((await pedir(af.slug, { itens: [{ produtoId: prod.id, quantidade: antes + 1 }] })).status, 400, 'mais do que tem');
    assert.equal((await pedir(af.slug, { itens: [{ produtoId: prod.id, quantidade: 1 }], consentimento: false })).status, 400, 'sem autorização de contato');
    assert.equal((await pedir(af.slug, { itens: [{ produtoId: prod.id, quantidade: 1 }], entrega: 'entregar' })).status, 400, 'entrega sem endereço');
    const r = await pedir(af.slug, { itens: [{ produtoId: prod.id, quantidade: 2, preco: 1 }] });
    assert.equal(r.status, 201);
    assert.equal(r.dados.total, prod.preco * 2, 'preço do servidor, nunca o que veio do navegador');
    assert.equal(r.dados.origem, 'matriz');
    assert.equal(r.dados.mensagem, 'Obrigada! Já já falamos com você.');
    cat = await ok('GET', `/publico/catalogo/${af.slug}`);
    assert.equal(cat.pecas.find((x) => x.id === prod.id).disponivel, antes - 2, 'o pedido segura as peças');
    token = admin;
    // Equipe: lista, card no CRM, fatura → venda, estoque e comissão.
    const lista = await ok('GET', '/pedidos-link?status=abertos');
    const ped = lista.find((x) => x.numero === r.dados.numero);
    assert.equal(ped.consultora, 'Afiliada Link Teste');
    assert.ok(ped.leadId, 'card no CRM');
    assert.ok((await ok('GET', `/crm/leads/${ped.leadId}`)).etiquetas.includes('Pedido pelo link'));
    const comAntes = await ok('GET', `/comissoes?mes=${mes}`);
    const lojaAntes = comAntes.linhas.filter((l) => l.tipo === 'loja').reduce((a, l) => a + l.base, 0);
    // Dois cliques ao mesmo tempo em "Faturar": uma venda só.
    const corpoFat = { pagamentos: [{ forma: 'pix', valor: prod.preco * 2 }] };
    const [f1, f2] = await Promise.all([chamar('POST', `/pedidos-link/${ped.id}/faturar`, corpoFat), chamar('POST', `/pedidos-link/${ped.id}/faturar`, corpoFat)]);
    assert.deepEqual([f1.status, f2.status].sort(), [201, 400], 'um fatura, o outro é recusado');
    const fat = f1.status === 201 ? f1.dados : f2.dados;
    assert.equal(fat.status, 'entregue');
    assert.ok(fat.venda.numero);
    assert.equal((await ok('GET', '/vendas?aba=concluidas')).itens.filter((v) => v.observacao === `Pedido pelo link nº ${ped.numero}` || v.id === fat.venda.id).length, 1);
    const com = await ok('GET', `/comissoes?mes=${mes}`);
    const linha = com.linhas.find((l) => l.tipo === 'link' && l.pessoaId === af.id);
    assert.equal(linha.base, prod.preco * 2);
    assert.equal(linha.valor, Math.round(prod.preco * 2 * 0.1));
    assert.equal(com.linhas.filter((l) => l.tipo === 'loja').reduce((a, l) => a + l.base, 0), lojaAntes, 'venda do link não vira comissão de loja de quem faturou');
    token = '';
    assert.equal((await ok('GET', `/publico/catalogo/${af.slug}`)).pecas.find((x) => x.id === prod.id).disponivel, antes - 2, 'faturado: saiu do estoque');
    // Pedido novo esquecido há mais de 3 dias para de segurar as peças.
    const pg = createRequire(import.meta.url)('pg');
    const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
    await banco.connect();
    const velho = await pedir(af.slug, { itens: [{ produtoId: prod.id, quantidade: 1 }] });
    assert.equal((await ok('GET', `/publico/catalogo/${af.slug}`)).pecas.find((x) => x.id === prod.id).disponivel, antes - 3);
    await banco.query(`update pedidos_link set criado_em = now() - interval '4 days' where numero = $1`, [velho.dados.numero]);
    assert.equal((await ok('GET', `/publico/catalogo/${af.slug}`)).pecas.find((x) => x.id === prod.id).disponivel, antes - 2, 'pedido novo com mais de 3 dias não segura mais');
    await banco.end();
    // Pedido cancelado libera a reserva.
    const r2 = await pedir(af.slug, { itens: [{ produtoId: prod.id, quantidade: 1 }] });
    token = admin;
    const p2 = (await ok('GET', '/pedidos-link?status=abertos')).find((x) => x.numero === r2.dados.numero);
    await ok('POST', `/pedidos-link/${p2.id}/cancelar`, { motivo: 'Cliente desistiu' });
    token = '';
    assert.equal((await ok('GET', `/publico/catalogo/${af.slug}`)).pecas.find((x) => x.id === prod.id).disponivel, antes - 2);

    // Consultora com maleta: o pedido sai da maleta; entregue, vai para a pré-baixa.
    token = admin;
    const cons = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Consultora Link Maleta', modeloTrabalho: 'consignado', telefone1: '27991230002', cidade: 'Vitória', uf: 'ES', limiteCredito: 500000 });
    const m = await ok('POST', '/maletas', { representanteId: cons.id, origemId: ctx.deposito.id, itens: [{ codigoBarras: prod.codigoBarras, quantidade: 2 }] });
    token = '';
    cat = await ok('GET', `/publico/catalogo/${cons.slug}`);
    assert.equal(cat.origem, 'maleta');
    assert.equal(cat.pecas.find((x) => x.id === prod.id).disponivel, 2);
    const r3 = await pedir(cons.slug, { itens: [{ produtoId: prod.id, quantidade: 1 }], entrega: 'entregar', endereco: 'Rua das Flores, 10' });
    assert.equal(r3.dados.origem, 'maleta');
    token = admin;
    const link = await ok('POST', `/portal/gerar-link/${cons.id}`);
    token = (await ok('POST', `/portal/link/${link.token}`)).token;
    const meus = await ok('GET', '/portal/pedidos-link');
    const meu = meus.find((x) => x.numero === r3.dados.numero);
    assert.equal(meu.endereco, 'Rua das Flores, 10');
    await ok('POST', `/portal/pedidos-link/${meu.id}/confirmar`);
    await ok('POST', `/portal/pedidos-link/${meu.id}/entregue`);
    const mal = await ok('GET', `/portal/maletas/${m.id}`);
    assert.equal(mal.itens.find((i) => i.produtoId === prod.id).prebaixaVendida, 1, 'peça entregue entra como vendida na pré-baixa');
    assert.equal((await chamar('POST', `/portal/pedidos-link/${meu.id}/entregue`)).status, 400, 'não entrega duas vezes');
    // A afiliada não mexe em pedido da matriz pelo portal.
    token = admin;
    const linkAf = await ok('POST', `/portal/gerar-link/${af.id}`);
    token = (await ok('POST', `/portal/link/${linkAf.token}`)).token;
    const doAf = (await ok('GET', '/portal/pedidos-link')).find((x) => x.numero === r.dados.numero);
    assert.equal(doAf.status, 'entregue');
    assert.equal((await chamar('POST', `/portal/pedidos-link/${doAf.id}/cancelar`)).status, 400);
    token = '';
    assert.equal((await ok('GET', `/publico/catalogo/${cons.slug}`)).pecas.find((x) => x.id === prod.id).disponivel, 1, 'a vendida sai do catálogo');
  } finally {
    token = admin;
  }
});

test('app da representante: registra o celular e recebe notificações pelo Firebase (Android) e pela Apple (iPhone)', async () => {
  const admin = token;
  const { readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const chaves = JSON.parse(readFileSync(`${tmpdir()}/aritana-push-teste.json`, 'utf8'));
  const pg = createRequire(import.meta.url)('pg');
  const banco = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
  await banco.connect();
  try {
    // Como alguém cola na tela: o JSON numa linha e a chave .p8 sem as quebras de linha.
    await ok('PUT', '/integracoes/push', { valores: { FIREBASE_CONTA_SERVICO: JSON.stringify(chaves.firebase), APNS_CHAVE_P8: chaves.apns.replace(/\n/g, ' '), APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456' } });
    const rep = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Representante App Celular', telefone1: '27991239876', cidade: 'Vitória', uf: 'ES' });
    const link = await ok('POST', `/portal/gerar-link/${rep.id}`);
    token = (await ok('POST', `/portal/link/${link.token}`)).token;
    const and = 'fcm_token_android_' + 'a'.repeat(40);
    const ios = 'a1b2c3d4'.repeat(8);
    assert.equal((await chamar('POST', '/portal/dispositivos', { token: 'curto', plataforma: 'android' })).status, 400);
    assert.equal((await chamar('POST', '/portal/dispositivos', { token: 'x'.repeat(30) + '<script>', plataforma: 'android' })).status, 400);
    await ok('POST', '/portal/dispositivos', { token: and, plataforma: 'android' });
    await ok('POST', '/portal/dispositivos', { token: ios, plataforma: 'ios' });
    await ok('POST', '/portal/dispositivos', { token: 'morto_android_' + 'b'.repeat(30), plataforma: 'android' });
    await ok('POST', '/portal/dispositivos', { token: 'morto' + 'c'.repeat(59), plataforma: 'ios' });
    await ok('POST', '/portal/dispositivos', { token: and, plataforma: 'android' }); // repetir não duplica
    assert.equal((await banco.query('select count(*)::int as n from portal_dispositivos where pessoa_id = $1', [rep.id])).rows[0].n, 4);
    token = admin;
    // Marcado com "não avisar": também não notifica no app.
    await ok('POST', '/agenda', { tipo: 'acerto_video', inicio: new Date(Date.now() + 5 * 86400e3).toISOString(), duracaoMin: 30, online: true, link: 'https://meet.google.com/aaa-bbbb-ccc', pessoaId: rep.id, avisar: false, forcar: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await (await fetch('http://localhost:3199/__pushes')).json()).filter((p) => p.token === and || p.token === ios).length, 0, 'sem aviso, sem notificação');
    // Compromisso marcado para ela: chega nos dois celulares.
    await ok('POST', '/agenda', { tipo: 'acerto_video', inicio: new Date(Date.now() + 3 * 86400e3).toISOString(), duracaoMin: 30, online: true, link: 'https://meet.google.com/aaa-bbbb-ccc', pessoaId: rep.id, avisar: true, forcar: true });
    let recebidas = [];
    for (let i = 0; i < 40 && recebidas.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      recebidas = (await (await fetch('http://localhost:3199/__pushes')).json()).filter((p) => p.token === and || p.token === ios);
    }
    const viaAndroid = recebidas.find((p) => p.via === 'fcm');
    const viaIphone = recebidas.find((p) => p.via === 'apns');
    assert.equal(viaAndroid?.titulo, 'Compromisso marcado', 'Android pelo Firebase (assinatura RS256 conferida pelo simulador)');
    assert.equal(viaAndroid.projeto, 'aritana-teste');
    assert.equal(viaIphone?.titulo, 'Compromisso marcado', 'iPhone pela Apple (JWT ES256 conferido pelo simulador)');
    assert.equal(viaIphone.topic, 'br.com.aritanaonline.representante');
    assert.equal(viaIphone.link, '/portal');
    // Celulares com o app desinstalado saem da lista sozinhos.
    for (let i = 0; i < 30; i++) {
      if ((await banco.query('select count(*)::int as n from portal_dispositivos where pessoa_id = $1', [rep.id])).rows[0].n === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await banco.query('select count(*)::int as n from portal_dispositivos where pessoa_id = $1', [rep.id])).rows[0].n, 2);
    // Outra representante não consegue desligar o celular dela.
    const outra = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Outra Representante App', telefone1: '27991230001', cidade: 'Vitória', uf: 'ES' });
    const linkOutra = await ok('POST', `/portal/gerar-link/${outra.id}`);
    token = (await ok('POST', `/portal/link/${linkOutra.token}`)).token;
    await ok('POST', '/portal/dispositivos/sair', { token: ios });
    assert.equal((await banco.query('select count(*)::int as n from portal_dispositivos where pessoa_id = $1', [rep.id])).rows[0].n, 2, 'o celular continua com a dona');
    token = admin;
    // Saiu do app: aquele celular para de receber.
    const link2 = await ok('POST', `/portal/gerar-link/${rep.id}`);
    token = (await ok('POST', `/portal/link/${link2.token}`)).token;
    await ok('POST', '/portal/dispositivos/sair', { token: ios });
    assert.equal((await banco.query('select count(*)::int as n from portal_dispositivos where pessoa_id = $1', [rep.id])).rows[0].n, 1);
    token = admin;
    assert.ok(!JSON.stringify(await ok('GET', '/integracoes/status')).includes('PRIVATE KEY'), 'chaves nunca voltam para a tela');
  } finally {
    token = admin;
    await banco.end();
  }
});

test('preenchimento automático: CEP traz o endereço e CNPJ traz os dados da empresa, com segunda fonte', async () => {
  const c = await ok('GET', '/consultas/cep/29101-010');
  assert.deepEqual(c, { cep: '29101010', logradouro: 'Avenida Champagnat', bairro: 'Centro', cidade: 'Vila Velha', uf: 'ES', ibge: '3205200' });
  // Primeira fonte fora do ar: a segunda responde.
  assert.equal((await ok('GET', '/consultas/cep/29000001')).cidade, 'Vitória');
  assert.equal((await chamar('GET', '/consultas/cep/00000000')).status, 404);
  assert.equal((await chamar('GET', '/consultas/cep/123')).status, 400);
  const e = await ok('GET', '/consultas/cnpj/11.222.333000181');
  assert.equal(e.razaoSocial, 'Fornecedora de Semijoias do Brasil Ltda', 'tira o TUDO MAIÚSCULO da Receita');
  assert.equal(e.logradouro, 'Rua das Flores');
  assert.equal(e.cidade, 'Limeira');
  assert.equal(e.telefone, '1933334444');
  assert.equal(e.email, 'contato@brilho.exemplo');
  const e2 = await ok('GET', '/consultas/cnpj/11444777000161');
  assert.equal(e2.inscricaoEstadual, '082123456', 'segunda fonte traz a inscrição estadual');
  assert.equal(e2.situacao, 'Baixada');
  assert.equal((await chamar('GET', '/consultas/cnpj/11222333000199')).status, 400, 'dígito verificador errado nem consulta');
  assert.equal((await chamar('GET', '/consultas/cnpj/19131243000197')).status, 404);
  // Só para a equipe logada.
  const admin = token;
  token = '';
  assert.equal((await chamar('GET', '/consultas/cep/29101010')).status, 401);
  token = admin;
});

test('cobrança: carteira, terceirizada vê só a dela, contato e promessa, 2ª via troca o boleto, acordo com quebra e abatimento, régua', async () => {
  const dia = (n) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const cpf = (base) => {
    const d = String(base).padStart(9, '0').split('').map(Number);
    for (const n of [10, 11]) d.push(((d.reduce((s, x, i) => s + x * (n - i), 0) * 10) % 11) % 10);
    return d.join('');
  };
  const emp = (await ok('GET', '/empresas'))[0];
  const cfg0 = await ok('GET', '/cobranca/config');
  assert.equal(cfg0.regua.passos.length, 5, 'régua padrão: 3 dias antes, no dia, 3, 10 e 30 depois');
  await ok('PUT', '/cobranca/config', { ...cfg0, multaPb: 200, jurosMesPb: 100, diasCarencia: 0, descontoMaxPb: 1000, descontoMaxGestorPb: 5000, parcelasMax: 6, regua: { ...cfg0.regua, ativa: false } });
  assert.equal((await chamar('PUT', '/cobranca/config', { ...cfg0, multaPb: 5000 })).status, 400, 'multa acima de 10% é recusada');
  const endereco = { cep: '29101010', logradouro: 'Avenida Champagnat', numero: '100', bairro: 'Centro', cidade: 'Vila Velha', uf: 'ES' };
  const a = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Ana Devedora Cobrança', documento: cpf(123456781), telefone1: '27991110001', email: 'ana.cobranca@exemplo.com', ...endereco });
  const b = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Bruna Atrasada Cobrança', documento: cpf(223456782), telefone1: '27991110002', ...endereco });
  const [ta1] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: a.id, descricao: 'Parcela antiga Ana', valor: 10000, vencimento: dia(-40) });
  const [ta2] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: a.id, descricao: 'Parcela nova Ana', valor: 6000, vencimento: dia(-10) });
  const [tb] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: b.id, descricao: 'Parcela Bruna', valor: 10000, vencimento: dia(-5) });

  // Carteira: valor atualizado com multa e juros simples por dia.
  const cart = await ok('GET', '/cobranca/carteira?busca=Cobrança');
  const la = cart.itens.find((x) => x.pessoaId === a.id);
  assert.equal(la.titulos, 2);
  assert.equal(Number(la.original), 16000);
  assert.equal(Number(la.atualizado), 16000 + 200 + 133 + 120 + 20, 'multa de 2% + juros de 1% ao mês, por dia');
  assert.equal(la.maiorAtraso, 40);
  assert.ok(cart.itens.some((x) => x.pessoaId === b.id));
  assert.equal((await ok('GET', '/cobranca/carteira?busca=Cobrança&faixa=31_60')).itens.length, 1);
  // Título grande e muito antigo: valor × juros × dias passa do limite do inteiro no banco.
  const antiga = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Dívida Antiga Grande', documento: cpf(523456785), ...endereco });
  await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: antiga.id, descricao: 'Muito antiga', valor: 500000, vencimento: dia(-600) });
  assert.equal(Number((await ok('GET', '/cobranca/carteira?busca=Dívida Antiga')).itens[0].atualizado), 500000 + 10000 + 100000);
  const painel = await ok('GET', '/cobranca/painel');
  assert.ok(painel.vencido.devedores >= 2);

  // Terceirizada: cobrador, acesso com senha provisória, carteira só com quem foi passado para ela.
  const terc = await ok('POST', '/cobranca/cobradores', { nome: 'Recupera Cobranças Ltda', tipo: 'terceirizada', comissaoPb: 1000 });
  const acesso = await ok('POST', `/cobranca/cobradores/${terc.id}/acessos`, { nome: 'Carla da Recupera', email: 'carla@recupera.exemplo' });
  assert.ok(acesso.senhaProvisoria.length >= 10);
  await ok('POST', '/cobranca/carteira/atribuir', { pessoaIds: [a.id], cobradorId: terc.id });
  const admin = token;
  token = (await ok('POST', '/auth/login', { email: 'carla@recupera.exemplo', senha: acesso.senhaProvisoria })).token;
  await ok('POST', '/auth/trocar-senha', { atual: acesso.senhaProvisoria, nova: 'SenhaDaRecupera2026' });
  const eu = await ok('GET', '/cobranca/eu');
  assert.deepEqual([eu.restrito, eu.gestor, eu.cobrador], [true, false, 'Recupera Cobranças Ltda']);
  const minha = await ok('GET', '/cobranca/carteira');
  assert.deepEqual(minha.itens.map((x) => x.pessoaId), [a.id], 'só a carteira dela');
  assert.equal((await ok('GET', '/cobranca/painel')).vencido.devedores, 1, 'o painel dela também só conta a carteira dela');
  assert.equal((await chamar('GET', `/cobranca/devedores/${b.id}`)).status, 403);
  assert.equal((await chamar('GET', '/financeiro/titulos')).status, 403, 'não entra no Financeiro');
  assert.equal((await chamar('GET', '/pessoas')).status, 403, 'nem nos cadastros');
  assert.equal((await chamar('POST', '/cobranca/carteira/atribuir', { pessoaIds: [b.id], cobradorId: terc.id })).status, 403);
  assert.equal((await chamar('POST', '/cobranca/protestos', { tituloIds: [tb.id] })).status, 403);
  const ficha = await ok('GET', `/cobranca/devedores/${a.id}`);
  assert.equal(ficha.titulos.length, 2);
  assert.equal(ficha.regras.descontoMaxPb, 1000, 'limite de desconto de quem não é gestor');
  // Contato com promessa; a promessa nova substitui a anterior.
  assert.equal((await chamar('POST', `/cobranca/devedores/${a.id}/contatos`, { tipo: 'ligacao', texto: 'Prometeu', promessaData: dia(-1) })).status, 400);
  await ok('POST', `/cobranca/devedores/${a.id}/contatos`, { tipo: 'ligacao', texto: 'Disse que paga na sexta', promessaData: dia(3), promessaValor: 16000 });
  await ok('POST', `/cobranca/devedores/${a.id}/contatos`, { tipo: 'whatsapp', texto: 'Pediu mais uns dias', promessaData: dia(7), promessaValor: 16000 });
  const contatos = (await ok('GET', `/cobranca/devedores/${a.id}`)).contatos.filter((c) => c.promessaData);
  assert.deepEqual(contatos.map((c) => c.promessaStatus).sort(), ['aberta', 'substituida']);
  assert.equal(contatos.find((c) => c.promessaStatus === 'aberta').cobrador, 'Recupera Cobranças Ltda');
  // Desconto acima do limite dela é recusado na simulação.
  const sim = await chamar('POST', `/cobranca/devedores/${a.id}/acordos/simular`, { tituloIds: [ta1.id, ta2.id], desconto: 5000, parcelas: 2, primeiroVencimento: dia(30) });
  assert.equal(sim.status, 400);
  assert.match(sim.dados.mensagem ?? sim.dados.message, /limite de 10%/);
  token = admin;

  // 2ª via com encargos: emite boleto novo, apaga o anterior e o título passa a apontar para o novo.
  const v1 = await ok('POST', `/cobranca/titulos/${ta1.id}/segunda-via`, { vencimento: dia(3), tipo: 'BOLETO', comEncargos: true });
  assert.equal(v1.valor, 10000 + 200 + 143, 'encargos calculados até o novo vencimento');
  assert.equal((await recebidos()).filter((r) => r.caminho === '/asaas/payments').pop().corpo.value, v1.valor / 100);
  const v2 = await ok('POST', `/cobranca/titulos/${ta1.id}/segunda-via`, { vencimento: dia(5), tipo: 'BOLETO', comEncargos: false });
  assert.equal(v2.valor, 10000);
  assert.notEqual(v2.id, v1.id);
  assert.ok((await recebidos()).some((r) => r.metodo === 'DELETE' && r.caminho === `/asaas/payments/${v1.id}`), 'o boleto anterior foi apagado no Asaas');
  assert.ok((await recebidos()).some((r) => r.metodo === 'PUT' && r.caminho.startsWith('/asaas/customers/')), 'cadastro do cliente atualizado no Asaas');
  const t1 = (await ok('GET', `/cobranca/devedores/${a.id}`)).titulos.find((t) => t.id === ta1.id);
  assert.deepEqual([t1.cobranca.valor, t1.cobranca.vencimento], [10000, dia(5)]);
  assert.equal((await chamar('POST', `/cobranca/titulos/${ta1.id}/segunda-via`, { vencimento: dia(-2), tipo: 'BOLETO' })).status, 400);

  // Acordo: entrada + 2 parcelas, com desconto (gestor pode até 50%).
  const corpo = { tituloIds: [ta1.id, ta2.id], desconto: 473, entrada: 5000, vencimentoEntrada: dia(0), parcelas: 2, primeiroVencimento: dia(30) };
  const s = await ok('POST', `/cobranca/devedores/${a.id}/acordos/simular`, corpo);
  assert.equal(s.total, 16000, 'atualizado de R$ 164,73 com R$ 4,73 de desconto');
  assert.deepEqual(s.parcelas.map((p) => p.valor), [5500, 5500]);
  assert.equal((await chamar('POST', `/cobranca/devedores/${a.id}/acordos/simular`, { ...corpo, parcelas: 12 })).status, 400, 'passa do máximo de parcelas');
  const ac = await ok('POST', `/cobranca/devedores/${a.id}/acordos`, { ...corpo, cobranca: 'BOLETO' });
  assert.equal(ac.parcelas.length, 3);
  assert.ok(ac.parcelas.every((p) => p.cobrancaExternaId), 'boleto de cada parcela emitido');
  assert.equal(ac.avisos.length, 0);
  const fichaAc = await ok('GET', `/cobranca/devedores/${a.id}`);
  assert.ok(!fichaAc.titulos.some((t) => t.id === ta1.id || t.id === ta2.id), 'os títulos de origem saíram da dívida (renegociados)');
  assert.equal(fichaAc.contatos.filter((c) => c.promessaStatus === 'aberta').length, 0, 'o acordo substitui a promessa');
  assert.equal((await chamar('POST', `/cobranca/devedores/${a.id}/acordos`, { ...corpo, cobranca: 'nenhuma' })).status, 400, 'título renegociado não entra em outro acordo');
  // Paga a entrada e cancela o acordo: o que foi pago abate o título mais antigo e o resto volta a ser cobrado.
  await ok('POST', `/financeiro/titulos/${ac.parcelas[0].id}/baixar`, { valorPago: 5000 });
  const enc = await ok('POST', `/cobranca/acordos/${ac.acordo.id}/cancelar`, { motivo: 'Cliente desistiu do acordo' });
  assert.equal(enc.abatido, 5000);
  const volta = await ok('GET', `/cobranca/devedores/${a.id}`);
  assert.deepEqual(volta.titulos.map((t) => [t.valor, t.vencimento]).sort(), [[5000, dia(-40)], [6000, dia(-10)]].sort());
  assert.equal(volta.acordos[0].status, 'cancelado');
  assert.equal((await ok('GET', `/cobranca/acordos/${ac.acordo.id}`)).parcelas.filter((p) => p.status === 'cancelado').length, 2);

  // Régua: prévia junta por pessoa e preenche o texto; envio pelo WhatsApp, uma vez só por passo.
  const canal = await ok('POST', '/crm/canais', { nome: 'Cobrança', tipo: 'evolution', config: { servidor: `${SIM}/evofora`, instancia: 'loja-centro', token: 'token-da-instancia-fora' } });
  const passos = [{ dias: 5, canal: 'whatsapp', texto: 'Oi {primeiro_nome}, a parcela de {valor} venceu há {dias} dias. Hoje fica {valor_atualizado}. {link}' }];
  assert.equal((await chamar('PUT', '/cobranca/config', { ...cfg0, regua: { ativa: true, canalId: null, passos } })).status, 400, 'régua por WhatsApp sem número');
  await ok('PUT', '/cobranca/config', { ...cfg0, multaPb: 200, jurosMesPb: 100, diasCarencia: 0, regua: { ativa: true, canalId: canal.id, passos } });
  const previa = (await ok('GET', '/cobranca/regua/previa')).previa.find((p) => p.pessoaId === b.id);
  assert.equal(previa.texto.split(' Hoje')[0], 'Oi Bruna, a parcela de R$ 100,00 venceu há 5 dias.');
  assert.match(previa.texto, /R\$ 102,17/);
  await ok('POST', `/cobranca/devedores/${a.id}/pausar`, { pausada: true, motivo: 'Em negociação' });
  const r1 = await ok('POST', '/cobranca/regua/rodar');
  assert.ok(r1.enviados >= 1);
  const msg = (await recebidos()).filter((r) => r.caminho === '/evofora/message/sendText/loja-centro').pop();
  assert.match(JSON.stringify(msg.corpo), /Oi Bruna/);
  assert.match(JSON.stringify(msg.corpo), /asaas\.com/, 'o boleto foi emitido antes e foi junto');
  const r2 = await ok('POST', '/cobranca/regua/rodar');
  assert.ok(!r2.previa.some((p) => p.pessoaId === b.id), 'não manda o mesmo passo duas vezes');
  assert.ok((await ok('GET', `/cobranca/devedores/${b.id}`)).contatos.some((c) => c.tipo === 'regua'));
  await ok('PUT', '/cobranca/config', { ...cfg0, multaPb: 200, jurosMesPb: 100, diasCarencia: 0, regua: { ...cfg0.regua, ativa: false } });
  ctx.cobranca = { a, b, tb, terc };
});

test('protesto pela CRA: confere, envia a remessa, protocolo, protestado, pagamento à Aritana autoriza o cancelamento; desistência', async () => {
  const { a, b, tb } = ctx.cobranca;
  const dia = (n) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const emp = (await ok('GET', '/empresas'))[0];
  const cfg = await ok('GET', '/cobranca/config');
  await ok('PUT', '/cobranca/config', { ...cfg, protesto: { diasMinimos: 30, especie: 'dmi' } });
  // Conferência: a Bruna venceu há 5 dias (mínimo 30) → não pode.
  const c1 = await ok('POST', '/cobranca/protestos/conferir', { tituloIds: [tb.id] });
  assert.equal(c1.prontos, 0);
  assert.match(c1.itens[0].problemas.join(' '), /mínimo configurado é 30/);
  assert.equal((await chamar('POST', '/cobranca/protestos', { tituloIds: [tb.id] })).status, 400);
  const semEnd = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Sem Endereço Cobrança', documento: '32345678321' });
  const [tSem] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: semEnd.id, descricao: 'Sem endereço', valor: 5000, vencimento: dia(-60) });
  assert.match((await ok('POST', '/cobranca/protestos/conferir', { tituloIds: [tSem.id] })).itens[0].problemas.join(' '), /endereço/);
  // Dois títulos vencidos há mais de 30 dias: um da Ana e um novo da Bruna.
  const ta = (await ok('GET', `/cobranca/devedores/${a.id}`)).titulos.find((t) => t.dias >= 30);
  const [tb2] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: b.id, descricao: 'Parcela muito antiga Bruna', valor: 20000, vencimento: dia(-90) });
  const c2 = await ok('POST', '/cobranca/protestos/conferir', { tituloIds: [ta.id, tb2.id] });
  assert.equal(c2.prontos, 2);
  const env = await ok('POST', '/cobranca/protestos', { tituloIds: [ta.id, tb2.id] });
  assert.match(env.arquivo, /^B123\d{4}\.\d{3}$/, 'nome do arquivo no padrão da CRA');
  const cra = await (await fetch(`${SIM}/__cra`)).json();
  const rem = cra.chamadas.find((x) => x.metodo === 'Remessa');
  assert.equal(rem.arquivo, env.arquivo);
  assert.match(rem.dados, /<comarca CodMun="3205200">/, 'praça pelo código IBGE do CEP');
  const trA = cra.titulos.find((t) => t.t23 === 'ANA DEVEDORA COBRANCA');
  assert.deepEqual([trA.t12, trA.t17, trA.t24, trA.t28, trA.t30], ['DMI', '50.00', '002', '29101010', 'ES']);
  assert.equal((await chamar('POST', '/cobranca/protestos', { tituloIds: [ta.id] })).status, 400, 'já está em protesto');
  let lista = (await ok('GET', '/cobranca/protestos')).itens;
  const pa = lista.find((p) => p.tituloId === ta.id);
  const pb = lista.find((p) => p.tituloId === tb2.id);
  assert.equal(pa.status, 'enviado');
  // Título em cartório fica fora da régua e não entra em acordo.
  assert.equal((await chamar('POST', `/cobranca/devedores/${b.id}/acordos/simular`, { tituloIds: [tb2.id], parcelas: 1, primeiroVencimento: dia(10) })).status, 400);

  // Confirmação: os dois protocolados.
  for (const p of [pa, pb]) await fetch(`${SIM}/__cra/confirmar`, { method: 'POST', body: JSON.stringify({ numero: p.numero }) });
  const s1 = await ok('POST', '/cobranca/protestos/sincronizar');
  assert.ok(s1.atualizados >= 2);
  lista = (await ok('GET', '/cobranca/protestos')).itens;
  assert.deepEqual([lista.find((p) => p.id === pa.id).status, lista.find((p) => p.id === pa.id).protocolo], ['em_cartorio', '0000012345']);
  // Ana: protestada. Bruna: segue no cartório.
  await fetch(`${SIM}/__cra/retornar`, { method: 'POST', body: JSON.stringify({ numero: pa.numero, ocorrencia: '2' }) });
  await ok('POST', '/cobranca/protestos/sincronizar');
  lista = (await ok('GET', '/cobranca/protestos')).itens;
  assert.equal(lista.find((p) => p.id === pa.id).status, 'protestado');
  assert.equal(lista.find((p) => p.id === pa.id).tituloStatus, 'protestado');
  assert.equal((await ok('GET', '/cobranca/carteira?busca=Ana Devedora')).itens[0].emProtesto, 1);
  // A Ana paga à Aritana (2ª via do título protestado): o sistema autoriza o cancelamento sozinho.
  const via = await ok('POST', `/cobranca/titulos/${ta.id}/segunda-via`, { vencimento: dia(1), tipo: 'PIX', comEncargos: false });
  const salvo = token;
  token = '';
  const pago = await (await fetch(API + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'token-webhook-teste' }, body: JSON.stringify({ id: 'evt_protesto_1', event: 'PAYMENT_RECEIVED', payment: { id: via.id, value: 50, paymentDate: dia(0), externalReference: ta.id } }) })).json();
  assert.equal(pago.resultado, 'baixado');
  token = salvo;
  const s3 = await ok('POST', '/cobranca/protestos/sincronizar');
  assert.equal(s3.pedidos, 1);
  const ac = (await (await fetch(`${SIM}/__cra`)).json()).chamadas.find((x) => x.metodo === 'Autoriza_Cancelamento');
  assert.match(ac.arquivo, /^AC123/);
  assert.match(ac.dados, /<numero_protocolo>0000012345<\/numero_protocolo>/);
  assert.match(ac.dados, /<CodMun>3205200<\/CodMun>/);
  assert.equal((await ok('GET', '/cobranca/protestos')).itens.find((p) => p.id === pa.id).pedido, 'autoriza_cancelamento');
  assert.equal((await ok('POST', '/cobranca/protestos/sincronizar')).pedidos, 0, 'não pede de novo');
  // Bruna: desistência manual enquanto está no cartório; depois o cartório devolve "retirado" e o título volta a aberto.
  assert.equal((await chamar('POST', `/cobranca/protestos/${pb.id}/pedido`, { tipo: 'autoriza_cancelamento', motivo: 'Teste' })).status, 400, 'não foi protestado ainda');
  await ok('POST', `/cobranca/protestos/${pb.id}/pedido`, { tipo: 'desistencia', motivo: 'Negociando direto com a cliente' });
  assert.ok((await (await fetch(`${SIM}/__cra`)).json()).chamadas.some((x) => x.metodo === 'Desistencia' && /^DP123/.test(x.arquivo)));
  await fetch(`${SIM}/__cra/retornar`, { method: 'POST', body: JSON.stringify({ numero: pb.numero, ocorrencia: '3' }) });
  await ok('POST', '/cobranca/protestos/sincronizar');
  const fb = (await ok('GET', '/cobranca/protestos')).itens.find((p) => p.id === pb.id);
  assert.deepEqual([fb.status, fb.tituloStatus], ['retirado', 'aberto']);
  const arqs = await ok('GET', '/cobranca/protestos/arquivos');
  assert.ok(['remessa', 'confirmacao', 'retorno', 'desistencia', 'autoriza_cancelamento'].every((t) => arqs.some((x) => x.tipo === t)));
  const xml = await ok('GET', `/cobranca/protestos/arquivos/${arqs.find((x) => x.tipo === 'remessa').id}`);
  assert.match(xml.conteudo, /^<\?xml/);
  // Remessa recusada pela CRA: o protesto fica "recusado" com o motivo.
  const ruim = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'RECUSAR Cobrança', documento: '42345678410', ...{ cep: '29101010', logradouro: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'Vila Velha', uf: 'ES' } });
  const [tr] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: ruim.id, descricao: 'Vai ser recusado', valor: 3000, vencimento: dia(-45) });
  const rec = await chamar('POST', '/cobranca/protestos', { tituloIds: [tr.id] });
  assert.equal(rec.status, 400);
  assert.match(rec.dados.mensagem ?? rec.dados.message, /devedor invalido/);
  assert.equal((await ok('GET', '/cobranca/protestos?status=recusado')).itens.length, 1);
});

test('Assistente: consulta inadimplentes, prepara envio em lote, confirma por voz, resume o negócio e respeita permissões', async () => {
  await ok('PUT', '/integracoes/ia', { valores: { ANTHROPIC_API_KEY: 'chave-claude-teste' } });
  const estado = await ok('GET', '/assistente/estado');
  assert.equal(estado.ligado, true);
  assert.ok(estado.ferramentas.some((f) => f.nome === 'resumo_negocio'));
  assert.equal(estado.ferramentas.find((f) => f.nome === 'enviar_whatsapp_em_lote').risco, 'confirmar');
  const sim = async () => (await (await fetch('http://localhost:3199/__recebidos')).json()).filter((r) => !r.caminho.startsWith('/__'));
  const dia = (n) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const emp = (await ok('GET', '/empresas'))[0];
  const p = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Zuleica Assistente', telefone1: '27999990001' });
  await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: p.id, descricao: 'Parcela do assistente', valor: 10000, vencimento: dia(-12) });
  // Um número por QR code ativo para enviar.
  const canais = await ok('GET', '/crm/canais');
  if (!canais.some((c) => c.tipo === 'qrcode' && c.ativo && !c.excluidoEm)) await ok('POST', '/crm/canais', { nome: 'QR do assistente', tipo: 'qrcode', config: { instancia: 'I1', token: 'T1', clientToken: 'CT1' } });
  const esperar = async (id, cond) => {
    for (let i = 0; i < 80; i++) {
      const s = await ok('GET', `/assistente/sessoes/${id}`);
      if (cond(s)) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail('o assistente não terminou a tempo');
  };
  const s = await ok('POST', '/assistente/sessoes');
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'manda whatsapp pros inadimplentes Zuleica', origem: 'voz' });
  assert.equal((await chamar('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'outra coisa' })).status, 409, 'um pedido por vez');
  let v = await esperar(s.id, (x) => !x.ocupada);
  assert.equal(v.titulo, 'Cobrança dos inadimplentes', 'título pelo assunto, gerado depois da primeira resposta');
  const consulta = v.acoes.find((a) => a.ferramenta === 'consultar_inadimplentes');
  assert.equal(consulta.status, 'concluida');
  assert.equal(consulta.resultado.pessoas[0].nome, 'Zuleica Assistente');
  const lote = v.acoes.find((a) => a.ferramenta === 'enviar_whatsapp_em_lote');
  assert.equal(lote.status, 'aguardando', 'não envia sem confirmação');
  assert.equal(lote.previa.length, 1);
  assert.match(lote.previa[0].texto, /^Oi, Zuleica! Sua parcela de R\$\s?1\d\d,\d\d está 12 dias em atraso\.$/);
  assert.equal(v.mensagens.at(-1).texto, 'Preparei o envio. Confirma?');
  const antes = (await sim()).filter((r) => r.caminho.includes('/send-text')).length;
  // "pode mandar" por voz vale como o botão.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode mandar', origem: 'voz' });
  v = await esperar(s.id, (x) => x.acoes.find((a) => a.id === lote.id).status === 'concluida' && /^Terminei/.test(x.mensagens.at(-1).texto));
  const feito = v.acoes.find((a) => a.id === lote.id);
  assert.equal(feito.resultado.enviados, 1);
  assert.deepEqual(feito.progresso, { feitos: 1, total: 1, falhas: 0 });
  const envios = (await sim()).filter((r) => r.caminho.includes('/send-text'));
  assert.equal(envios.length, antes + 1);
  assert.match(envios.at(-1).corpo.message, /Oi, Zuleica!/);
  assert.equal((await chamar('POST', `/assistente/acoes/${lote.id}/confirmar`)).status, 409, 'confirmar de novo não envia duas vezes');
  // Conversa sobre resultados.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'como foi o mês?' });
  v = await esperar(s.id, (x) => !x.ocupada);
  assert.match(v.mensagens.at(-1).texto, /^No período vendemos R\$/);
  // Ferramenta que não existe (ou sem permissão) volta como erro para a IA, sem quebrar.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'use a ferramenta inexistente' });
  v = await esperar(s.id, (x) => !x.ocupada);
  assert.match(v.mensagens.at(-1).texto, /^Resultado: erro .*não está disponível/);
  // Cancelar pelo botão.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'manda whatsapp pros inadimplentes Zuleica' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const outro = v.acoes.filter((a) => a.ferramenta === 'enviar_whatsapp_em_lote').at(-1);
  assert.equal(outro.status, 'aguardando');
  await ok('POST', `/assistente/acoes/${outro.id}/cancelar`);
  v = await ok('GET', `/assistente/sessoes/${s.id}`);
  assert.equal(v.acoes.find((a) => a.id === outro.id).status, 'cancelada');
  // A conversa é só de quem abriu; quem não tem o módulo nem entra.
  // O grupo Financeiro não tem o módulo Assistente: não entra.
  const salvo = token;
  token = ctx.finToken;
  assert.equal((await chamar('GET', '/assistente/sessoes')).status, 403);
  assert.equal((await chamar('GET', `/assistente/sessoes/${s.id}`)).status, 403);
  token = salvo;
  // Configuração pela conversa: muda a multa da cobrança só depois de confirmar.
  const multaAntes = (await ok('GET', '/cobranca/config')).multaPb;
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'muda a multa da cobrança para 5' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const regra = v.acoes.filter((x) => x.ferramenta === 'alterar_regras').at(-1);
  assert.equal(regra.status, 'aguardando');
  assert.match(regra.resumo, /Multa das parcelas vencidas \(cobrança\): .*% → 5%/);
  assert.equal((await ok('GET', '/cobranca/config')).multaPb, multaAntes, 'nada muda antes de confirmar');
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode', origem: 'voz' });
  v = await esperar(s.id, (x) => !x.ocupada && x.acoes.find((y) => y.id === regra.id).status === 'concluida');
  assert.equal((await ok('GET', '/cobranca/config')).multaPb, 500);
  assert.equal(v.mensagens.at(-1).texto, 'Feito!');
  // Acima do limite da tela (10%): não cria cartão, volta o motivo.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'muda a multa da cobrança para 30' });
  v = await esperar(s.id, (x) => !x.ocupada);
  assert.match(v.acoes.at(-1).erro, /máxima aceita na cobrança é de 10%/);
  // Excluir conversa.
  const descartavel = await ok('POST', '/assistente/sessoes');
  await ok('DELETE', `/assistente/sessoes/${descartavel.id}`);
  assert.equal((await chamar('GET', `/assistente/sessoes/${descartavel.id}`)).status, 404);
  // Rotina agendada: "todo dia às 8 me manda e-mail com os inadimplentes".
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'todo dia às 8 me manda email com os inadimplentes para diretoria@aritana.local' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const ag = v.acoes.filter((x) => x.ferramenta === 'agendar_rotina').at(-1);
  assert.equal(ag.status, 'aguardando');
  assert.match(ag.resumo, /todo dia às 08:00/);
  assert.equal((await ok('GET', '/assistente/rotinas')).length, 0, 'só cria depois de confirmar');
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode' });
  v = await esperar(s.id, (x) => !x.ocupada && x.acoes.find((y) => y.id === ag.id).status === 'concluida');
  let [rot] = await ok('GET', '/assistente/rotinas');
  assert.equal(rot.horario, '08:00');
  assert.deepEqual(rot.emails, ['diretoria@aritana.local']);
  assert.ok(new Date(rot.proximaEm) > new Date());
  // "Rodar agora": abre uma conversa da rotina, consulta e manda o e-mail sem pedir confirmação (endereço autorizado).
  await ok('POST', `/assistente/rotinas/${rot.id}/executar`);
  let execucao;
  for (let i = 0; i < 60 && !execucao; i++) {
    [rot] = await ok('GET', '/assistente/rotinas');
    const x = rot.ultimaSessaoId ? await ok('GET', `/assistente/sessoes/${rot.ultimaSessaoId}`) : null;
    if (x && !x.ocupada && x.mensagens.at(-1)?.papel === 'assistant') execucao = x;
    else await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(execucao, 'a rotina rodou');
  assert.match(execucao.titulo, /^⏰ Inadimplentes por e-mail/);
  const mail = execucao.acoes.find((x) => x.ferramenta === 'enviar_email');
  assert.equal(mail.status, 'concluida');
  assert.match(mail.resumo, /autorizado na criação da rotina/);
  assert.match(mail.resultado.anexos[0], /^inadimplentes-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(execucao.mensagens.at(-1).texto, 'Resumo: e-mail enviado.');
  assert.equal(rot.ultimoErro, null);
  await ok('PATCH', `/assistente/rotinas/${rot.id}`, { ativa: false });
  assert.equal((await ok('GET', '/assistente/rotinas'))[0].ativa, false);
  await ok('DELETE', `/assistente/rotinas/${rot.id}`);
  assert.equal((await ok('GET', '/assistente/rotinas')).length, 0);
  // Rotina a cada X tempo, com janela e dias úteis; duplicar.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'de hora em hora das 8 às 18 me avisa das candidatas novas' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const ag2 = v.acoes.filter((x) => x.ferramenta === 'agendar_rotina').at(-1);
  assert.match(ag2.resumo, /a cada 1 h, de segunda a sexta, das 08:00 às 18:00/);
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode' });
  await esperar(s.id, (x) => !x.ocupada && x.acoes.find((y) => y.id === ag2.id).status === 'concluida');
  const [int] = await ok('GET', '/assistente/rotinas');
  assert.equal(int.tipo, 'intervalo');
  assert.equal(int.intervaloMin, 60);
  assert.equal(int.quando, 'a cada 1 h, de segunda a sexta, das 08:00 às 18:00');
  const copia = await ok('POST', `/assistente/rotinas/${int.id}/duplicar`);
  assert.equal(copia.titulo, 'Candidatas novas (cópia)');
  assert.equal(copia.ativa, false);
  assert.equal((await ok('GET', '/assistente/rotinas')).length, 2);
  // O assistente cria um especialista do WhatsApp na conversa (com confirmação); duplicar pela tela.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'cria um especialista de pós-venda' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const novoAg = v.acoes.filter((x) => x.ferramenta === 'alterar_agentes_whatsapp').at(-1);
  assert.equal(novoAg.status, 'aguardando');
  assert.match(novoAg.resumo, /Criar o especialista "Pós-venda" \(chave posvenda\)/);
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode' });
  await esperar(s.id, (x) => !x.ocupada && x.acoes.find((y) => y.id === novoAg.id).status === 'concluida');
  const pos = (await ok('GET', '/crm/ia-agente')).especialistas.find((x) => x.funcao === 'posvenda');
  assert.equal(pos.ativo, true);
  const dup1 = await ok('POST', `/crm/ia-agentes/${pos.id}/duplicar`);
  const dup2 = await ok('POST', `/crm/ia-agentes/${pos.id}/duplicar`);
  assert.equal(dup1.funcao, 'posvenda_copia');
  assert.equal(dup2.funcao, 'posvenda_copia2');
  assert.equal(dup1.ativo, false);
  assert.equal(dup1.instrucoes, pos.instrucoes);
  // Falou por voz → resposta em formato de conversa falada (com marcação de emoção só na voz); escreveu → formato de texto.
  const ultimoSistema = async () => {
    const c = (await sim()).filter((r) => r.caminho === '/claude/v1/messages' && Array.isArray(r.corpo.system) && r.corpo.system[0].text.includes('assistente de operação')).at(-1);
    return c.corpo.system[0].text;
  };
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'como foi o mês?', origem: 'voz' });
  v = await esperar(s.id, (x) => !x.ocupada);
  assert.match(await ultimoSistema(), /FORMATO: CONVERSA FALADA/);
  assert.match(v.mensagens.at(-1).texto, /^No período vendemos/, 'na tela, sem a marcação');
  assert.match(v.mensagens.at(-1).fala, /^\[excited\] No período vendemos/, 'para a voz, com a marcação');
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'como foi o mês?' });
  v = await esperar(s.id, (x) => !x.ocupada);
  assert.match(await ultimoSistema(), /FORMATO: TEXTO/);
  assert.equal(v.mensagens.at(-1).fala, null);
  // Aprovação automática: executa sem cartão (e a empresa pode proibir).
  assert.equal(s.aprovacao, 'perguntar');
  assert.equal((await ok('GET', '/assistente/estado')).podeAutomatico, true);
  await ok('PATCH', `/assistente/sessoes/${s.id}`, { aprovacao: 'automatico' });
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'muda a multa da cobrança para 4' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const auto = v.acoes.filter((x) => x.ferramenta === 'alterar_regras').at(-1);
  assert.equal(auto.status, 'concluida');
  assert.match(auto.resumo, /→ 4%.*\(aprovado automaticamente\)$/);
  assert.equal((await ok('GET', '/cobranca/config')).multaPb, 400);
  assert.match(await ultimoSistema(), /MODO DE APROVAÇÃO: AUTOMÁTICO/);
  // Envio em lote no automático: roda em segundo plano direto.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'manda whatsapp pros inadimplentes Zuleica' });
  v = await esperar(s.id, (x) => !x.ocupada && /^Terminei/.test(x.mensagens.at(-1).texto));
  assert.equal(v.acoes.filter((x) => x.ferramenta === 'enviar_whatsapp_em_lote').at(-1).status, 'concluida');
  assert.equal((await ok('POST', '/assistente/sessoes')).aprovacao, 'automatico', 'conversa nova herda o modo');
  await ok('PUT', '/assistente/config', { nome: 'Assistente', aprovacaoAutomatica: 'ninguem' });
  assert.equal((await ok('GET', '/assistente/estado')).podeAutomatico, false);
  assert.equal((await chamar('PATCH', `/assistente/sessoes/${s.id}`, { aprovacao: 'automatico' })).status, 400);
  // Com a regra "ninguém", a conversa que estava no automático volta a pedir confirmação na prática.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'muda a multa da cobrança para 3' });
  v = await esperar(s.id, (x) => !x.ocupada);
  assert.equal(v.acoes.filter((x) => x.ferramenta === 'alterar_regras').at(-1).status, 'aguardando');
  await ok('PUT', '/assistente/config', { nome: 'Assistente', aprovacaoAutomatica: 'gestao' });
  await ok('PATCH', `/assistente/sessoes/${s.id}`, { aprovacao: 'perguntar' });
  // Anexos: foto, PDF, CSV e Word (lidos pelo assistente); tipo não aceito é recusado.
  const { zipSync, strToU8 } = createRequire(import.meta.url)('fflate');
  const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Contrato da Zuleica &amp; cia</w:t></w:r></w:p></w:body></w:document>') })).toString('base64');
  const anexar = (nome, mime, conteudo) => ok('POST', '/assistente/anexos', { nome, mime, conteudo });
  const png = await anexar('colado.png', 'image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
  const pdf = await anexar('nota.pdf', 'application/pdf', Buffer.from('%PDF-1.4 teste').toString('base64'));
  const planilha = await anexar('vendas.csv', '', Buffer.from('\uFEFFNome;Total\nAna;100').toString('base64'));
  const word = await anexar('contrato.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  assert.equal(png.leitura, 'completa');
  assert.equal(planilha.mime, 'text/csv', 'tipo pelo nome quando o navegador não diz');
  assert.equal(word.leitura, 'texto extraído');
  assert.equal((await chamar('POST', '/assistente/anexos', { nome: 'virus.exe', mime: 'application/x-msdownload', conteudo: 'TVqQ' })).status, 400);
  const sAnexo = await ok('POST', '/assistente/sessoes');
  await ok('POST', `/assistente/sessoes/${sAnexo.id}/mensagens`, { texto: 'o que tem nesses anexos?', anexos: [png.id, pdf.id, planilha.id, word.id] });
  const vAnexo = await esperar(sAnexo.id, (x) => !x.ocupada);
  assert.equal(vAnexo.mensagens.find((m) => m.papel === 'user').anexos.length, 4);
  assert.equal(vAnexo.mensagens.at(-1).texto, 'Recebi: image | document | texto:Nome;Total | texto:Contrato da Zuleica & cia');
  const baixado = await fetch(API + `/assistente/anexos/${png.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(baixado.headers.get('content-type'), 'image/png');
  assert.equal((await chamar('POST', `/assistente/sessoes/${sAnexo.id}/mensagens`, { texto: '', anexos: [] })).status, 400);
  // Aba Agentes: agendados e do WhatsApp numa lista.
  const painelAg = await ok('GET', '/assistente/agentes');
  assert.ok(painelAg.rotinas.length >= 1);
  assert.ok(painelAg.rotinas.every((r) => typeof r.quando === 'string'));
  assert.ok(painelAg.whatsapp.especialistas.some((x) => x.funcao === 'posvenda'));
  assert.equal(painelAg.podeEditarWhatsapp, true);
  // Parcelas que vencem hoje (consulta financeira por período e situação).
  await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: p.id, descricao: 'Vence hoje', valor: 12345, vencimento: dia(0) });
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'quanto vence hoje?' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const fin = v.acoes.filter((x) => x.ferramenta === 'consultar_financeiro').at(-1);
  assert.equal(fin.status, 'concluida');
  assert.ok(fin.resultado.parcelas.some((x) => x.descricao === 'Vence hoje' && x.valor.includes('123,45')));
  assert.match(v.mensagens.at(-1).texto, /^Vence hoje: R\$/);
  // Ler e analisar as conversas do WhatsApp do CRM.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'analisa as conversas do WhatsApp' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const amostra = v.acoes.filter((x) => x.ferramenta === 'amostra_conversas').at(-1);
  assert.equal(amostra.status, 'concluida', amostra.erro ?? '');
  assert.ok(amostra.resultado.totalDeConversas >= 1);
  assert.ok(amostra.resultado.amostra[0].cliente.length >= 1);
  assert.equal(v.acoes.filter((x) => x.ferramenta === 'ler_conversa').at(-1).status, 'concluida');
  assert.match(v.mensagens.at(-1).texto, /^Li \d+ mensagens\.$/);
  // O assistente configura o áudio do agente do WhatsApp (com confirmação).
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'liga o áudio do agente quando o cliente mandar áudio, com a voz nova' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const aud = v.acoes.filter((x) => x.ferramenta === 'alterar_agentes_whatsapp').at(-1);
  assert.equal(aud.status, 'aguardando', aud.erro ?? '');
  assert.match(aud.resumo, /Resposta em áudio: quando o cliente manda áudio, voz Nova/);
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode' });
  await esperar(s.id, (x) => !x.ocupada && x.acoes.find((y) => y.id === aud.id).status === 'concluida');
  const agCfg = await ok('GET', '/crm/ia-agente');
  assert.deepEqual([agCfg.respostaAudio, agCfg.vozProvedor, agCfg.vozOpenai], ['espelhar', 'openai', 'nova']);
  await ok('PUT', '/crm/ia-agente', { ativo: agCfg.ativo, canais: agCfg.canais, instrucoes: agCfg.instrucoes, conhecimento: agCfg.conhecimento, maxRespostas: agCfg.maxRespostas, respostaAudio: 'nunca' });
  // Consulta flexível (motor de conjuntos) e agenda.
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'quais os produtos mais vendidos?' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const dados = v.acoes.filter((x) => x.ferramenta === 'consultar_dados').at(-1);
  assert.equal(dados.status, 'concluida', dados.erro ?? '');
  assert.ok(dados.resultado.linhas.length >= 1);
  assert.match(dados.resultado.linhas[0].faturamento, /^R\$/);
  assert.equal(typeof dados.resultado.linhas[0].pecas, 'number');
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'me mostra o estoque por loja e categoria' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const est = v.acoes.filter((x) => x.ferramenta === 'consultar_dados').at(-1);
  assert.equal(est.status, 'concluida', est.erro ?? '');
  assert.ok('local' in est.resultado.linhas[0] && 'categoria' in est.resultado.linhas[0]);
  // A agenda de amanhã às 10h fica livre: outro teste marca uma retirada "daqui a 20 horas", que cai nesse horário quando os testes rodam no começo da tarde.
  const amanha = new Date(Date.now() - 3 * 3600_000 + 86400_000).toISOString().slice(0, 10);
  for (const c of await ok('GET', `/agenda?de=${amanha}T00:00:00-03:00&ate=${amanha}T23:59:59-03:00`)) {
    if (new Date(c.inicio) < new Date(`${amanha}T11:00:00-03:00`) && new Date(c.fim) > new Date(`${amanha}T10:00:00-03:00`)) await ok('POST', `/agenda/${c.id}/situacao`, { status: 'cancelado', motivo: 'Libera o horário para o teste do assistente' });
  }
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'marca uma reunião amanhã às 10h' });
  v = await esperar(s.id, (x) => !x.ocupada);
  const comp = v.acoes.filter((x) => x.ferramenta === 'criar_compromisso').at(-1);
  assert.equal(comp.status, 'aguardando');
  assert.match(comp.resumo, /Reunião de resultados.*10:00/);
  await ok('POST', `/assistente/sessoes/${s.id}/mensagens`, { texto: 'pode' });
  v = await esperar(s.id, (x) => !x.ocupada && x.acoes.find((y) => y.id === comp.id).status !== 'executando');
  const marcado = v.acoes.find((y) => y.id === comp.id);
  assert.equal(marcado.status, 'concluida', marcado.erro ?? '');
  assert.equal(marcado.resultado.marcado, true);
  // Voz: sem ElevenLabs, fala pela OpenAI; com a chave, pela ElevenLabs. Links e marcadores não são lidos.
  const falarAudio = async (corpo) => {
    const r = await fetch(API + '/assistente/falar', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(corpo) });
    return { status: r.status, tipo: r.headers.get('content-type'), corpo: r.ok ? Buffer.from(await r.arrayBuffer()).toString() : await r.json() };
  };
  await ok('PUT', '/integracoes/ia', { valores: { OPENAI_API_KEY: 'chave-openai-teste' } });
  assert.equal((await ok('GET', '/assistente/estado')).vozResposta, 'openai');
  let a = await falarAudio({ texto: 'Pronto:\n- 2ª via em https://asaas.com/b/123' });
  assert.equal(a.status, 201);
  assert.match(a.tipo, /audio\/mpeg/);
  const pedidoOpenai = (await sim()).filter((r) => r.caminho === '/openai/v1/audio/speech').at(-1);
  assert.equal(pedidoOpenai.corpo.voice, 'ash');
  assert.equal(pedidoOpenai.corpo.input, 'Pronto:, 2ª via em o link');
  await ok('PUT', '/integracoes/ia', { valores: { ELEVENLABS_API_KEY: 'chave-eleven-teste' } });
  assert.equal((await ok('GET', '/assistente/estado')).vozResposta, 'elevenlabs');
  a = await falarAudio({ texto: 'Vendas subiram 12%.' });
  assert.equal(a.status, 201);
  assert.equal(a.corpo, 'ID3fake-mp3-audio');
  assert.ok((await sim()).some((r) => r.caminho.startsWith('/elevenlabs/v1/text-to-speech/ec54d9BmuMSN4IinPrjv') && r.corpo.model_id === 'eleven_v3'));
  // Voz que não aceita o v3: cai para o multilingual, sem as marcações de emoção.
  a = await falarAudio({ texto: '[excited] Deu certo!', provedor: 'elevenlabs', voz: 'semv3voz1234' });
  assert.equal(a.status, 201);
  const tentativas = (await sim()).filter((r) => r.caminho.startsWith('/elevenlabs/v1/text-to-speech/semv3voz1234'));
  assert.deepEqual(tentativas.map((r) => [r.corpo.model_id, r.corpo.text]), [['eleven_v3', '[excited] Deu certo!'], ['eleven_multilingual_v2', 'Deu certo!']]);
  // Ouvir de novo não gera de novo.
  const antesEleven = (await sim()).filter((r) => r.caminho.startsWith('/elevenlabs')).length;
  await falarAudio({ texto: 'Vendas subiram 12%.' });
  assert.equal((await sim()).filter((r) => r.caminho.startsWith('/elevenlabs')).length, antesEleven);
  // Exemplo com voz que não existe na conta: mensagem clara.
  a = await falarAudio({ texto: 'teste', provedor: 'elevenlabs', voz: 'naoexiste12345' });
  assert.equal(a.status, 400);
  assert.match(a.corpo.mensagem ?? a.corpo.message, /não está disponível/);
  // Escolher "navegador" desliga a voz do servidor.
  await ok('PUT', '/assistente/config', { nome: 'Assistente', voz: 'navegador' });
  assert.equal((await ok('GET', '/assistente/estado')).vozResposta, 'navegador');
  assert.equal((await chamar('PUT', '/assistente/config', { nome: 'Assistente', vozElevenlabs: 'x y' })).status, 400);
  // Configuração: nome do assistente.
  await ok('PUT', '/assistente/config', { nome: 'Cláudio', instrucoes: 'Seja direto.' });
  assert.equal((await ok('GET', '/assistente/estado')).nome, 'Cláudio');
});

test('financeiro gerencial: plano de contas, lançamentos classificados, contas bancárias com transferência e extrato, DRE aberta por conta', async () => {
  const dia = (n) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const mes = dia(0).slice(0, 7);
  const mesMais = (n) => { const d = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)) - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const emp = (await ok('GET', '/empresas'))[0];

  // Plano padrão: 9 grupos (as linhas da DRE) e as contas do sistema.
  let plano = await ok('GET', '/financeiro/plano-contas');
  assert.equal(plano.grupos.length, 9);
  const raiz = (g) => plano.contas.find((c) => !c.paiId && c.grupo === g);
  const daChave = (k) => plano.contas.find((c) => c.chave === k);
  assert.deepEqual(plano.contas.filter((c) => !c.paiId).map((c) => c.codigo), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.ok(daChave('cmv').calculada && daChave('vendas_rede').calculada && !daChave('comissoes').calculada);
  // O que o sistema lançou sozinho nos outros testes já caiu na conta certa.
  const autom = await ok('GET', '/financeiro/titulos?tipo=receber&aba=pagos');
  assert.ok(autom.itens.filter((t) => ['venda', 'acerto'].includes(t.origemTipo)).every((t) => t.planoNome === 'Recebimento de vendas e acertos'), 'recebimentos de venda e acerto ficam fora do resultado');

  // Conta nova, subconta, código repetido, conta calculada não aceita subconta.
  const aluguel = await ok('POST', '/financeiro/plano-contas', { nome: 'Aluguel da loja do centro', paiId: raiz('despesas_administrativas').id });
  assert.equal(aluguel.codigo, '6.10');
  assert.equal(aluguel.grupo, 'despesas_administrativas');
  const sub = await ok('POST', '/financeiro/plano-contas', { nome: 'IPTU da loja', paiId: aluguel.id });
  assert.equal(sub.codigo, '6.10.01');
  assert.equal((await chamar('POST', '/financeiro/plano-contas', { nome: 'Repetida', paiId: raiz('despesas_administrativas').id, codigo: '6.01' })).status, 400);
  assert.equal((await chamar('POST', '/financeiro/plano-contas', { nome: 'Dentro do CMV', paiId: daChave('cmv').id })).status, 400);
  // Mover de grupo leva as subcontas junto (grupo e código).
  const movida = await ok('PATCH', `/financeiro/plano-contas/${aluguel.id}`, { paiId: raiz('despesas_vendas').id });
  assert.deepEqual([movida.grupo, movida.codigo], ['despesas_vendas', '4.09']);
  plano = await ok('GET', '/financeiro/plano-contas');
  assert.deepEqual([plano.contas.find((c) => c.id === sub.id).grupo, plano.contas.find((c) => c.id === sub.id).codigo], ['despesas_vendas', '4.09.01']);
  assert.equal((await chamar('PATCH', `/financeiro/plano-contas/${aluguel.id}`, { paiId: sub.id })).status, 400, 'não entra dentro da própria subconta');
  await ok('PATCH', `/financeiro/plano-contas/${aluguel.id}`, { paiId: raiz('despesas_administrativas').id, nome: 'Aluguel loja centro' });
  assert.equal((await chamar('DELETE', `/financeiro/plano-contas/${daChave('comissoes').id}`)).status, 400, 'conta do sistema não é excluída');
  assert.equal((await chamar('PATCH', `/financeiro/plano-contas/${daChave('cmv').id}`, { ativo: false })).status, 400);
  assert.equal((await chamar('DELETE', `/financeiro/plano-contas/${aluguel.id}`)).status, 400, 'tem subconta');

  // Contas bancárias: cadastro, nome repetido, transferência e extrato.
  const banco = await ok('POST', '/financeiro/contas', { empresaId: emp.id, nome: 'Banco do teste DRE', tipo: 'banco', saldoInicial: 1000000, banco: 'Sicoob', agencia: '3008', numero: '12345-6' });
  const caixa = await ok('POST', '/financeiro/contas', { empresaId: emp.id, nome: 'Cofre do teste DRE', tipo: 'caixa' });
  assert.equal((await chamar('POST', '/financeiro/contas', { empresaId: emp.id, nome: 'banco do teste dre' })).status, 400);
  assert.equal((await chamar('POST', '/financeiro/transferencias', { origemId: banco.id, destinoId: banco.id, valor: 100, data: dia(0) })).status, 400);
  assert.equal((await chamar('POST', '/financeiro/transferencias', { origemId: banco.id, destinoId: caixa.id, valor: 100, data: dia(2) })).status, 400, 'data no futuro');
  await ok('POST', '/financeiro/transferencias', { origemId: banco.id, destinoId: caixa.id, valor: 30000, data: dia(0), descricao: 'Troco' });

  // Lançamentos: despesa já paga com conta do plano; parcelada sem classificar; receita de serviço.
  const [pagoAluguel] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'pagar', descricao: 'Aluguel do mês', planoContaId: aluguel.id, valor: 250000, vencimento: dia(0), pagoEm: dia(0), contaId: banco.id });
  assert.deepEqual([pagoAluguel.status, pagoAluguel.categoria, pagoAluguel.planoContaId], ['pago', 'Aluguel loja centro', aluguel.id]);
  assert.equal((await chamar('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'pagar', descricao: 'No CMV', planoContaId: daChave('cmv').id, valor: 100, vencimento: dia(0) })).status, 400, 'conta calculada não recebe lançamento');
  assert.equal((await chamar('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'pagar', descricao: 'No grupo', planoContaId: raiz('custos').id, valor: 100, vencimento: dia(0) })).status, 400, 'grupo não recebe lançamento');
  assert.equal((await chamar('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'pagar', descricao: 'Paga sem conta', valor: 100, vencimento: dia(0), pagoEm: dia(0) })).status, 400);
  const parcelas = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'pagar', descricao: 'Sistema de gestão', valor: 90000, vencimento: `${mes}-10`, parcelas: 3 });
  assert.deepEqual(parcelas.map((p) => p.vencimento), [`${mes}-10`, `${mesMais(1)}-10`, `${mesMais(2)}-10`]);
  const semConta = (await ok('GET', '/financeiro/titulos?tipo=pagar&aba=abertos&semPlano=1&busca=Sistema de gestão')).itens;
  assert.equal(semConta.length, 3);
  const sistemas = plano.contas.find((c) => c.nome === 'Sistemas e assinaturas');
  assert.equal((await ok('POST', '/financeiro/titulos/classificar', { ids: parcelas.map((p) => p.id), planoContaId: sistemas.id })).classificados, 3);
  assert.equal((await ok('GET', '/financeiro/titulos?tipo=pagar&aba=abertos&semPlano=1&busca=Sistema de gestão')).itens.length, 0);
  assert.equal((await ok('GET', `/financeiro/titulos?tipo=pagar&aba=abertos&planoContaId=${sistemas.id}`)).itens.length, 3);
  // Corrige o valor de uma parcela em aberto; depois paga pela conta do banco.
  const corrigida = await ok('PATCH', `/financeiro/titulos/${parcelas[0].id}`, { valor: 32000, descricao: 'Sistema de gestão (1/3) · com reajuste' });
  assert.equal(corrigida.valor, 32000);
  await ok('POST', `/financeiro/titulos/${parcelas[0].id}/baixar`, { contaId: banco.id });
  assert.equal((await chamar('PATCH', `/financeiro/titulos/${parcelas[0].id}`, { valor: 100 })).status, 400, 'pago não muda de valor');
  await ok('PATCH', `/financeiro/titulos/${parcelas[0].id}`, { descricao: 'Sistema de gestão (1/3)' });
  // Uma despesa paga fica sem classificar de propósito.
  const [solta] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'pagar', descricao: 'Despesa solta', valor: 7000, vencimento: dia(0), pagoEm: dia(0), contaId: caixa.id });

  // Extrato do banco: saldo inicial, menos transferência, aluguel e a parcela.
  const ext = await ok('GET', `/financeiro/contas/${banco.id}/extrato?de=${mes}-01&ate=${dia(0)}`);
  assert.deepEqual([ext.saldoAnterior, ext.entradas, ext.saidas, ext.saldoFinal], [1000000, 0, 30000 + 250000 + 32000, 1000000 - 312000]);
  assert.equal(ext.linhas.at(-1).saldo, ext.saldoFinal);
  const cad = await ok('GET', '/financeiro/contas-cadastro');
  assert.equal(cad.find((c) => c.id === caixa.id).saldo, 30000 - 7000);
  assert.equal((await chamar('PATCH', `/financeiro/contas/${banco.id}`, { ativo: false })).status, 400, 'conta com saldo não desativa');

  // DRE no regime de caixa, mês atual.
  const dre = await ok('GET', `/financeiro/dre?de=${mes}&ate=${mes}&regime=caixa`);
  assert.deepEqual(dre.meses, [mes]);
  const grupo = (d, k) => d.grupos.find((g) => g.chave === k);
  const achar = (linhas, id) => { for (const l of linhas) { if (l.id === id) return l; const f = achar(l.filhos, id); if (f) return f; } return null; };
  const adm = grupo(dre, 'despesas_administrativas');
  assert.equal(achar(adm.contas, aluguel.id).total, -250000);
  assert.equal(achar(adm.contas, sistemas.id).total, -32000);
  assert.equal(adm.total, adm.contas.reduce((a, c) => a + c.total, 0), 'o grupo é a soma das contas');
  // Sem classificar entra em "Despesas a classificar" e o aviso conta os títulos.
  assert.ok(dre.semClassificar >= 1);
  assert.ok(achar(grupo(dre, 'outras').contas, daChave('classificar_despesas').id).total <= -7000);
  // Subtotais fecham com os grupos; transferência fica fora e não muda o resultado.
  const t = (k) => grupo(dre, k).total;
  assert.equal(dre.subtotais.receitaLiquida.total, t('receita') + t('deducoes'));
  assert.equal(dre.subtotais.lucroBruto.total, dre.subtotais.receitaLiquida.total + t('custos'));
  assert.equal(dre.subtotais.resultado.total, dre.subtotais.lucroBruto.total + t('despesas_vendas') + t('despesas_pessoal') + t('despesas_administrativas') + t('financeiro') + t('outras'));
  assert.equal(achar(dre.fora.contas, daChave('transferencias').id).total, 0, 'entrada e saída da transferência se anulam');
  assert.ok(!dre.grupos.some((g) => g.chave === 'fora'));
  // Por empresa: a soma das empresas dá o consolidado, em cada grupo e no resultado.
  const porEmpresa = await Promise.all((await ok('GET', '/empresas')).map((e) => ok('GET', `/financeiro/dre?de=${mes}&ate=${mes}&regime=caixa&empresaId=${e.id}`)));
  for (const g of dre.grupos) assert.equal(porEmpresa.reduce((a, d) => a + grupo(d, g.chave).total, 0), g.total, `grupo ${g.chave} fecha por empresa`);
  assert.equal(porEmpresa.reduce((a, d) => a + d.subtotais.resultado.total, 0), dre.subtotais.resultado.total);
  assert.equal((await chamar('GET', `/financeiro/dre?empresaId=x'--`)).status, 400);
  // Receita e custo batem com os indicadores (mesmas fontes).
  const ind = (await ok('GET', '/indicadores/financeiro')).meses.find((m) => m.mes === mes);
  const calcReceita = grupo(dre, 'receita').contas.filter((c) => c.calculada).reduce((a, c) => a + c.total, 0);
  assert.equal(calcReceita, ind.bruta, 'receita das vendas e acertos igual à dos indicadores');
  assert.equal(achar(grupo(dre, 'custos').contas, daChave('cmv').id).total, -ind.cmv);
  assert.equal(achar(grupo(dre, 'deducoes').contas, daChave('devolucoes').id).total, -ind.devolucoes);
  // Transferência não virou despesa nos indicadores antigos.
  assert.ok(!(await ok('GET', '/indicadores/financeiro')).despesas.some((d) => d.categoria === 'Transferência entre contas'));

  // Abrir a linha: lançamentos da conta no mês; a conta-mãe traz os das subcontas.
  const lan = await ok('GET', `/financeiro/dre/lancamentos?contaId=${aluguel.id}&mes=${mes}&regime=caixa`);
  assert.deepEqual(lan.itens.map((x) => x.descricao), ['Aluguel do mês']);
  await ok('PATCH', `/financeiro/titulos/${solta.id}`, { planoContaId: sub.id });
  assert.equal((await ok('GET', `/financeiro/dre/lancamentos?contaId=${aluguel.id}&mes=${mes}&regime=caixa`)).itens.length, 2);
  const dre2 = await ok('GET', `/financeiro/dre?de=${mes}&ate=${mes}&regime=caixa`);
  const linhaAluguel = achar(grupo(dre2, 'despesas_administrativas').contas, aluguel.id);
  assert.deepEqual([linhaAluguel.total, linhaAluguel.filhos[0].total], [-257000, -7000], 'a conta soma as subcontas');
  assert.match((await ok('GET', `/financeiro/dre/lancamentos?contaId=${daChave('cmv').id}&mes=${mes}&regime=caixa`)).calculadas[0].nome, /Custo das peças/);

  // Competência: as parcelas em aberto aparecem nos meses do vencimento.
  const comp = await ok('GET', `/financeiro/dre?de=${mes}&ate=${mesMais(2)}&regime=competencia`);
  assert.deepEqual(achar(grupo(comp, 'despesas_administrativas').contas, sistemas.id).valores, [-32000, -30000, -30000]);
  assert.equal((await chamar('GET', `/financeiro/dre?de=${mesMais(2)}&ate=${mes}`)).status, 400);

  // Com lançamentos, a conta não é excluída; desativada, some das escolhas e continua na DRE.
  assert.equal((await chamar('DELETE', `/financeiro/plano-contas/${sub.id}`)).status, 400);
  await ok('PATCH', `/financeiro/plano-contas/${sub.id}`, { ativo: false });
  assert.equal((await chamar('PATCH', `/financeiro/titulos/${parcelas[1].id}`, { planoContaId: sub.id })).status, 400, 'conta desativada não recebe lançamento novo');
  assert.equal(achar(grupo(await ok('GET', `/financeiro/dre?de=${mes}&ate=${mes}`), 'despesas_administrativas').contas, sub.id).total, -7000);
  // Renomear a conta atualiza a categoria dos títulos.
  await ok('PATCH', `/financeiro/plano-contas/${aluguel.id}`, { nome: 'Aluguel da loja' });
  assert.equal((await ok('GET', `/financeiro/titulos?tipo=pagar&aba=pagos&planoContaId=${aluguel.id}`)).itens[0].categoria, 'Aluguel da loja');
});

test('módulo Asaas: catálogo por permissão, cobranças, estorno que desfaz a baixa do título, transferência só para a gestão, webhook do sistema', async () => {
  const dia = (n) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
  const ex = (operacao, extra = {}) => chamar('POST', '/financeiro/asaas/executar', { operacao, ...extra });
  const emp = (await ok('GET', '/empresas'))[0];

  // Catálogo: o administrador vê tudo; os caminhos do Asaas não saem do servidor.
  const cat = await ok('GET', '/financeiro/asaas/catalogo');
  assert.equal(cat.ligado, true);
  assert.ok(cat.operacoes.length > 120);
  assert.ok(cat.operacoes.every((o) => o.caminho === undefined));
  for (const k of ['cobrancas.criar', 'transferencias.pix', 'contas.pagar', 'pix.pagar', 'antecipacoes.pedir', 'negativacoes.criar', 'assinaturas.criar', 'links.criar', 'webhooks.criar', 'extrato']) assert.ok(cat.operacoes.some((o) => o.chave === k), k);
  assert.equal(new Set(cat.operacoes.map((o) => o.chave)).size, cat.operacoes.length, 'chaves sem repetição');
  const resumo = await ok('GET', '/financeiro/asaas/resumo');
  assert.deepEqual([resumo.saldo, resumo.aReceber.quantity, resumo.situacao.general, resumo.numero.account], [1234.56, 3, 'APPROVED', '1234567']);

  // Cliente do cadastro vira cliente do Asaas; cobrança avulsa com valor em centavos → reais, multa e juros aninhados.
  const pessoa = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Cliente do Módulo Asaas', documento: '39053344705' });
  const cli = await ok('POST', '/financeiro/asaas/cliente', { pessoaId: pessoa.id });
  assert.match(cli.id, /^cus_\d+$/);
  const ruim = await ex('cobrancas.criar', { corpo: { customer: cli.id, billingType: 'CARTAO', value: 12.5, campoInventado: 'x' } });
  assert.equal(ruim.status, 400);
  assert.deepEqual(Object.keys(ruim.dados.campos).sort(), ['billingType', 'dueDate', 'value']);
  const nova = await ex('cobrancas.criar', { corpo: { customer: cli.id, billingType: 'BOLETO', value: 15090, dueDate: dia(5), description: 'Avulsa', 'fine.value': 2, 'interest.value': 1, campoInventado: 'x' } });
  assert.equal(nova.status, 201);
  const enviado = (await recebidos()).filter((r) => r.metodo === 'POST' && r.caminho === '/asaas/payments').pop().corpo;
  assert.deepEqual(enviado, { customer: cli.id, billingType: 'BOLETO', value: 150.9, dueDate: dia(5), description: 'Avulsa', fine: { value: 2 }, interest: { value: 1 } }, 'só os campos do catálogo, no formato do Asaas');
  // Lista com filtro e paginação; operação desconhecida e código malformado são recusados.
  const lista = await ex('cobrancas', { filtros: { status: 'PENDING', inventado: '1' }, porPagina: 5 });
  assert.equal(lista.status, 201);
  assert.ok(lista.dados.data.some((p) => p.id === nova.dados.id));
  const consulta = (await recebidos()).filter((r) => r.metodo === 'GET' && r.caminho.startsWith('/asaas/payments?')).pop();
  assert.deepEqual(Object.fromEntries(new URLSearchParams(consulta.caminho.split('?')[1])), { status: 'PENDING', offset: '0', limit: '5' }, 'filtro inventado não vai para o Asaas');
  assert.equal((await ex('apagar.tudo')).status, 400);
  assert.equal((await ex('cobrancas.ver', { id: '../transfers' })).status, 400);
  assert.equal((await ex('cobrancas.ver')).status, 400);
  // Editar e excluir a avulsa (não é de título): passa direto.
  assert.equal((await ex('cobrancas.editar', { id: nova.dados.id, corpo: { value: 20000 } })).dados.value, 200);
  assert.equal((await ex('cobrancas.excluir', { id: nova.dados.id })).dados.deleted, true);

  // Cobrança de um título do sistema: editar e "recebido em dinheiro" são barrados; estorno total desfaz a baixa.
  const [t] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: pessoa.id, descricao: 'Título com boleto do módulo', valor: 8000, vencimento: dia(3) });
  const cob = await ok('POST', `/financeiro/titulos/${t.id}/cobranca`, { tipo: 'PIX' });
  const idCob = (await recebidos()).filter((r) => r.metodo === 'POST' && r.caminho === '/asaas/payments').pop();
  const lista2 = await ex('cobrancas', {});
  const linha = lista2.dados.data.find((p) => p._titulo?.id === t.id);
  assert.ok(linha, 'a lista mostra a qual título a cobrança pertence');
  const barrado = await ex('cobrancas.editar', { id: linha.id, corpo: { value: 100 } });
  assert.equal(barrado.status, 400);
  assert.match(barrado.dados.mensagem, /2ª via/);
  assert.equal((await ex('cobrancas.dinheiro', { id: linha.id, corpo: { paymentDate: dia(0), value: 8000 } })).status, 400);
  assert.equal((await ex('cobrancas.estornar', { id: linha.id })).status, 400, 'título ainda não pago');
  const salvo = token;
  token = '';
  await fetch(API + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'token-webhook-teste' }, body: JSON.stringify({ id: 'evt_modulo_1', event: 'PAYMENT_RECEIVED', payment: { id: linha.id, value: 80, paymentDate: dia(0), externalReference: t.id } }) });
  token = salvo;
  assert.equal((await ok('GET', `/financeiro/titulos?tipo=receber&aba=pagos&busca=boleto do módulo`)).itens.length, 1);
  assert.equal((await ex('cobrancas.estornar', { id: linha.id, corpo: { value: 3000 } })).status, 400, 'estorno parcial de título não passa por aqui');
  const est = await ex('cobrancas.estornar', { id: linha.id, corpo: { description: 'Cliente desistiu' } });
  assert.equal(est.status, 201);
  assert.match(est.dados._efeito, /voltou para "em aberto"/);
  const voltou = (await ok('GET', `/financeiro/titulos?tipo=receber&aba=abertos&busca=boleto do módulo`)).itens[0];
  assert.deepEqual([voltou.status, voltou.cobrancaUrl, voltou.pagoEm], ['aberto', null, null]);
  void cob; void idCob;

  // Dinheiro saindo: só a gestão (Financeiro com "excluir"). O grupo Financeiro comum cobra, mas não transfere.
  const transf = await ex('transferencias.pix', { corpo: { value: 3000, pixAddressKey: 'financeiro@aritana.exemplo', pixAddressKeyType: 'EMAIL', description: 'Fornecedor' } });
  assert.equal(transf.status, 201);
  assert.deepEqual([transf.dados.value, transf.dados.status], [30, 'PENDING']);
  assert.match((await ex('transferencias.pix', { corpo: { value: 999999900, pixAddressKey: 'x@y.z', pixAddressKeyType: 'EMAIL' } })).dados.mensagem, /Asaas: Saldo insuficiente/);
  const banco = await ex('transferencias.banco', { corpo: { value: 1000, 'bankAccount.ownerName': 'Fornecedor Ltda', 'bankAccount.cpfCnpj': '11222333000181', 'bankAccount.bank.code': '756', 'bankAccount.agency': '3008', 'bankAccount.account': '12345', 'bankAccount.accountDigit': '6', 'bankAccount.bankAccountType': 'CONTA_CORRENTE' } });
  assert.equal(banco.dados.bankAccount.bank.code, '756');
  assert.equal((await ex('contas.simular', { corpo: { identificationField: '83620000000 5 67890123456 7' } })).dados.bankSlipInfo.value, 150.5);
  assert.equal((await ex('extrato', { filtros: { startDate: dia(-30), finishDate: dia(0) } })).dados.data.length, 2);
  const pg = createRequire(import.meta.url)('pg');
  const banco_ = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://aritana:aritana@localhost:5432/aritana_teste' });
  await banco_.connect();
  const auditoria = (await banco_.query(`select dados from auditoria where acao = 'asaas' order by criado_em desc limit 20`)).rows.map((r) => r.dados.operacao);
  await banco_.end();
  assert.ok(['transferencias.banco', 'transferencias.pix', 'cobrancas.estornar', 'cobrancas.criar'].every((o) => auditoria.includes(o)), 'o que muda fica na auditoria');

  const grupos = await ok('GET', '/grupos');
  const fin = grupos.find((g) => g.nome === 'Financeiro');
  const operador = await ok('POST', '/usuarios', { nome: 'Operadora do Asaas', email: 'asaas.operadora@aritana.local', grupoId: fin.id });
  const admin = token;
  token = (await ok('POST', '/auth/login', { email: 'asaas.operadora@aritana.local', senha: operador.senhaProvisoria })).token;
  await ok('POST', '/auth/trocar-senha', { atual: operador.senhaProvisoria, nova: 'SenhaDoAsaas2026' });
  const catOp = await ok('GET', '/financeiro/asaas/catalogo');
  assert.ok(catOp.operacoes.some((o) => o.chave === 'cobrancas.criar') && !catOp.operacoes.some((o) => o.nivel === 'dinheiro' || o.nivel === 'gestao'), 'sem as operações de dinheiro e de gestão');
  assert.equal((await ex('transferencias.pix', { corpo: { value: 100, pixAddressKey: 'a@b.c', pixAddressKeyType: 'EMAIL' } })).status, 403);
  assert.equal((await ex('cobrancas.estornar', { id: 'pay_1' })).status, 403);
  assert.equal((await ex('webhooks')).status, 403);
  assert.equal((await chamar('POST', '/financeiro/asaas/webhook-sistema')).status, 403);
  assert.equal((await ex('saldo')).dados.balance, 1234.56);
  token = admin;

  // Webhook do sistema: cria com token novo (o antigo era curto), guarda o mesmo token e não duplica.
  const w1 = await ok('POST', '/financeiro/asaas/webhook-sistema');
  assert.equal(w1.criado, true);
  const criado = (await recebidos()).filter((r) => r.metodo === 'POST' && r.caminho === '/asaas/webhooks').pop().corpo;
  assert.ok(criado.authToken.length >= 32 && criado.events.includes('PAYMENT_RECEIVED') && criado.url.endsWith('/api/webhooks/asaas'));
  const w2 = await ok('POST', '/financeiro/asaas/webhook-sistema');
  assert.deepEqual([w2.criado, w2.id], [false, w1.id]);
  token = '';
  const aceito = await fetch(API + '/webhooks/asaas', { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': criado.authToken }, body: JSON.stringify({ id: 'evt_modulo_2', event: 'PAYMENT_CREATED', payment: { id: 'pay_x' } }) });
  assert.equal(aceito.status, 200, 'o sistema passou a aceitar o token novo');
  token = admin;
  // Volta o token dos outros testes.
  await ok('PUT', '/integracoes/asaas', { valores: { ASAAS_WEBHOOK_TOKEN: '' } });
});

test('implantação: apagar dados de teste exige APAGAR e mantém o que é configuração', async () => {
  assert.equal((await chamar('POST', '/implantacao/apagar-dados-de-teste', { confirmacao: 'apagar' })).status, 400);
  const bloq = await chamar('POST', '/implantacao/apagar-dados-de-teste', { confirmacao: 'APAGAR', manterProdutos: true });
  assert.equal(bloq.status, 400, 'com dados do Jueri, só apaga marcando a opção');
  assert.match(bloq.dados.mensagem, /importados do Jueri/);
  const r = await ok('POST', '/implantacao/apagar-dados-de-teste', { confirmacao: 'APAGAR', manterProdutos: true, apagarImportados: true });
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

test('precificação: fórmula da planilha (peso × coeficiente + bruto, markup por faixa), aplicar em lote e regras configuráveis', async () => {
  const novo = (ref, descricao, extra = {}) => ok('POST', '/produtos', { referencia: ref, descricao, preco: 9290, ...extra });
  const prata = await novo('PRC-PRATA', 'Choker Aro com Coração Banhado a Prata');
  const ouro = await novo('PRC-OURO', 'Choker Corrente Oval', { cor: 'B. de Ouro' });
  const semMetal = await novo('PRC-NADA', 'Choker 3 esferas');
  const ver = async (ref) => (await ok('GET', `/precificacao?busca=${ref}`)).itens[0];
  // Sem peso não há conta; o metal já sai do cadastro.
  assert.deepEqual([(await ver('PRC-PRATA')).metal, (await ver('PRC-OURO')).metal, (await ver('PRC-NADA')).metal], ['prata', 'ouro', null]);
  assert.equal((await ver('PRC-PRATA')).calculo, null);
  assert.ok((await ok('GET', '/precificacao?situacao=sem_peso&busca=PRC-')).itens.length >= 3);

  const r = await ok('POST', '/precificacao/aplicar', {
    itens: [
      { id: prata.id, peso: 6, bruto: 400, preco: 11990 },
      { id: ouro.id, peso: 20, bruto: 950 },
      { id: semMetal.id, peso: 8.4, bruto: 850, metal: 'ouro', coeficiente: 400, insumos: 0 },
    ],
  });
  assert.deepEqual([r.pecas, r.precosAlterados], [3, 1]);
  const p = await ver('PRC-PRATA');
  assert.deepEqual([p.peso, p.bruto, p.insumos, p.coeficiente, p.custo, p.preco], [6, 400, 500, 150, 1800, 11990]);
  assert.deepEqual([p.calculo.banho, p.calculo.multiplicador, p.calculo.sugerido, p.calculo.arredondado], [900, 1000, 13500, 13590]);
  const o = await ver('PRC-OURO');
  assert.deepEqual([o.calculo.banho, o.calculo.sugerido, o.custo, o.preco], [11000, 84150, 12450, 9290], 'sem preço informado, o preço não muda');
  const n = await ver('PRC-NADA');
  assert.deepEqual([n.metal, n.coeficiente, n.calculo.banho, n.calculo.sugerido], ['ouro', 400, 3360, 29470]);
  const ficha = await ok('GET', `/produtos/${prata.id}`);
  assert.deepEqual([ficha.custos.banhoPrata, ficha.medidas.peso], [900, 6]);

  // Planilha: acha a peça pelo código de barras ou pela referência; o que não existe fica de fora.
  const achados = (await ok('POST', '/precificacao/buscar', { codigos: [prata.codigoBarras, 'PRC-OURO', 'nao-existe'] })).itens;
  assert.deepEqual([achados[prata.codigoBarras].id, achados['PRC-OURO'].id, achados['nao-existe']], [prata.id, ouro.id, undefined]);

  // Mudar a regra muda o sugerido de quem não tem coeficiente gravado; quem já foi precificado mantém o seu.
  const regras = await ok('GET', '/configuracoes/chave/precificacao');
  assert.equal(regras.ouro.coeficiente, 550);
  await ok('PUT', '/configuracoes/chave/precificacao', { ...regras, prata: { ...regras.prata, coeficiente: 200 }, terminacao: null });
  const p2 = await ver('PRC-PRATA');
  assert.deepEqual([p2.coeficiente, p2.calculo.arredondado], [150, 13500]);
  assert.equal((await chamar('PUT', '/configuracoes/chave/precificacao', { ...regras, ouro: { coeficiente: 550, faixas: [] } })).status, 400);
  await ok('PUT', '/configuracoes/chave/precificacao', regras);

  assert.equal((await chamar('POST', '/precificacao/aplicar', { itens: [{ id: prata.id, preco: 0 }] })).status, 400);
  assert.equal((await chamar('POST', '/precificacao/aplicar', { itens: [{ id: prata.id, peso: 1 }, { id: prata.id, peso: 2 }] })).status, 400);
  // Trocar o metal recalcula o banho com o coeficiente do novo metal.
  await ok('POST', '/precificacao/aplicar', { itens: [{ id: prata.id, metal: 'ouro' }] });
  const p3 = await ok('GET', `/produtos/${prata.id}`);
  assert.deepEqual([p3.custos.banhoOuro, p3.custos.banhoPrata, p3.custo], [3300, undefined, 4200]);
});

test('ferramentas do agente de IA: reconhece o número, parcelas, 2ª via, promessa, estoque e candidatura; limites e desligar', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Ferramentas IA', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  let n = 0;
  const chegarDe = (tel) => (texto) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: `FER${tel}${++n}` }, pushName: 'Contato', message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const espera = (ms = 900) => new Promise((r) => setTimeout(r, ms));
  const conversa = async (tel) => (await ok('GET', `/crm/conversas?aba=todas&canalId=${c.id}`)).find((x) => x.telefone === tel);
  const msgs = async (tel) => (await ok('GET', `/crm/conversas/${(await conversa(tel)).id}/mensagens`)).mensagens;
  const dia = (d) => new Date(Date.now() - 3 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
  const emp = (await ok('GET', '/empresas'))[0];

  // Cliente cadastrada com duas parcelas em aberto; o número dela é o do cadastro.
  const dev = await ok('POST', '/pessoas', { tipo: 'cliente', nome: 'Fernanda Ferramenta Teste', documento: '11144477735', telefone1: '(27) 98877-6601', email: 'fernanda.ferramenta@exemplo.com', cep: '29101010', logradouro: 'Avenida Champagnat', numero: '100', bairro: 'Centro', cidade: 'Vila Velha', uf: 'ES' });
  await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: dev.id, descricao: 'Parcela vencida Fernanda', valor: 12000, vencimento: dia(-8) });
  await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: dev.id, descricao: 'Parcela futura Fernanda', valor: 8000, vencimento: dia(20) });
  await ok('PUT', '/integracoes/ia', { valores: { ANTHROPIC_API_KEY: 'chave-claude-teste' } });
  const cfg = await ok('GET', '/crm/ia-agente');
  assert.deepEqual(cfg.ferramentas, { segundaVia: true, promessa: true, promessaMaxDias: 10, estoque: true, candidatura: true });
  const base = { ativo: true, canais: [c.id], instrucoes: '', conhecimento: 'Vendemos semijoias.', maxRespostas: 30, nome: '', maxTransferencias: 2 };
  // Sem especialistas neste teste: o agente geral atende direto.
  const ligados = cfg.especialistas.filter((e) => e.ativo);
  for (const e of ligados) await ok('PATCH', `/crm/ia-agentes/${e.id}`, { ativo: false });
  await ok('PUT', '/crm/ia-agente', base);

  // 1) "Quanto eu devo": reconhece o número pelo cadastro e lista as parcelas dela.
  const tel = '5527988776601';
  const chegar = chegarDe(tel);
  await chegar('Oi, quanto eu devo?');
  await espera();
  let m = await msgs(tel);
  assert.match(m.at(-1).texto, /Parcelas em aberto \(2, total R\$\s200,00\)/);
  assert.match(m.at(-1).texto, /1\. Parcela vencida Fernanda .*\(VENCIDA\) · R\$\s120,00/);
  const sistema = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages' && String(r.corpo.system).includes('FERRAMENTAS:')).pop().corpo.system;
  assert.match(sistema, /Este número é de Fernanda Ferramenta Teste, cliente cadastrada/);
  assert.match(sistema, /contestação de dívida, pedido de desconto ou de parcelamento/);

  // 2) 2ª via: consulta, gera a cobrança no Asaas e manda o link; a equipe vê o recado.
  await chegar('Me manda a segunda via por favor');
  await espera(1300);
  m = await msgs(tel);
  assert.match(m.at(-1).texto, /Link de pagamento da parcela 1 \(Parcela vencida Fernanda.*https:\/\/sandbox\.asaas\.com\/i\/pay_\d+/);
  assert.ok(m.some((x) => x.direcao === 'interna' && x.texto.startsWith('🤖 A IA enviou a 2ª via de "Parcela vencida Fernanda"')));
  const cobrou = (await recebidos()).filter((r) => r.caminho === '/asaas/payments' && r.corpo?.description === 'Parcela vencida Fernanda').pop();
  assert.deepEqual([cobrou.corpo.billingType, cobrou.corpo.value], ['PIX', 120], 'a cobrança saiu no Asaas, pelo valor do título');

  // 3) Promessa dentro do prazo entra na Cobrança; fora do prazo é recusada e vai para a equipe.
  await chegar(`Eu pago dia ${dia(5)}`);
  await espera();
  m = await msgs(tel);
  assert.match(m.at(-1).texto, /Promessa anotada: R\$\s120,00 até/);
  assert.ok(m.some((x) => x.direcao === 'interna' && x.texto.startsWith('🤖 A IA registrou promessa de pagamento: R$')));
  const ficha = await ok('GET', `/cobranca/devedores/${dev.id}`).catch(() => null);
  if (ficha) assert.ok(JSON.stringify(ficha).includes('Promessa registrada pela IA no WhatsApp'));
  await chegar(`Na verdade eu pago dia ${dia(40)}`);
  await espera();
  m = await msgs(tel);
  assert.match(m.filter((x) => x.direcao === 'saida').at(-1).texto, /A promessa pode ser no máximo até/);
  assert.match(m.filter((x) => x.direcao === 'interna').at(-1).texto, /A IA passou esta conversa para a equipe/);

  // 4) Número sem cadastro: estoque e candidatura funcionam; pagamento não é oferecido.
  const tel2 = '5527988776602';
  const chegar2 = chegarDe(tel2);
  const prod = await ok('POST', '/produtos', { referencia: 'FER-ARG', descricao: 'Argola ferramenta dourada', preco: 8990, cor: 'Dourado' });
  await chegar2('Vocês tem argola ferramenta em estoque?');
  await espera();
  m = await msgs(tel2);
  assert.match(m.at(-1).texto, /Argola ferramenta dourada \(Dourado\), ref\. FER-ARG: R\$\s89,90 · sem estoque no momento/);
  const sistema2 = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages' && String(r.corpo.system).includes('FERRAMENTAS:')).pop().corpo.system;
  assert.ok(!sistema2.includes('"segunda_via"') && sistema2.includes('não está ligado a um cadastro: assuntos de pagamento'), 'sem cadastro, não há ferramenta de pagamento');
  await chegar2('Quero me candidatar: meu nome é Carla Candidata Teste, moro em Serra/ES');
  await espera(1200);
  m = await msgs(tel2);
  assert.match(m.at(-1).texto, /Candidatura nº \d+ registrada/);
  const cands = await ok('GET', '/crm/candidaturas');
  const cand = (cands.itens ?? cands).find((x) => x.nome === 'Carla Candidata Teste');
  assert.deepEqual([cand.cidade, cand.uf, cand.telefone, cand.modeloInteresse], ['Serra', 'ES', '27988776602', 'consignado']);
  // De novo: atualiza a mesma, não duplica.
  await chegar2('Quero me candidatar: meu nome é Carla Candidata Teste, moro em Vitória/ES');
  await espera(1200);
  const cands2 = await ok('GET', '/crm/candidaturas');
  assert.equal((cands2.itens ?? cands2).filter((x) => x.nome === 'Carla Candidata Teste').length, 1);

  // 5) Ferramenta em laço: no máximo 3 usos por resposta, depois vai para a equipe.
  const tel3 = '5527988776603';
  await chegarDe(tel3)('teste de ferramenta infinita');
  await espera(1300);
  m = await msgs(tel3);
  assert.match(m.filter((x) => x.direcao === 'interna').at(-1).texto, /A IA usou ferramentas demais/);

  // 6) Desligadas: a IA nem fica sabendo que existem.
  await ok('PUT', '/crm/ia-agente', { ...base, ferramentas: { segundaVia: false, promessa: false, promessaMaxDias: 10, estoque: false, candidatura: false } });
  await chegarDe('5527988776604')('Oi, quanto eu devo?');
  await espera();
  const ultimo = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages').pop().corpo.system;
  assert.ok(!String(ultimo).includes('FERRAMENTAS:'));
  assert.equal((await chamar('PUT', '/crm/ia-agente', { ...base, ferramentas: { segundaVia: true, promessa: true, promessaMaxDias: 400, estoque: true, candidatura: true } })).status, 400);

  await ok('PUT', '/crm/ia-agente', { ativo: false, canais: [], instrucoes: '', conhecimento: '', maxRespostas: 10, ferramentas: cfg.ferramentas });
  for (const e of ligados) await ok('PATCH', `/crm/ia-agentes/${e.id}`, { ativo: true });
  await ok('DELETE', `/produtos/${prod.id}`).catch(() => undefined);
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('minha mesa: conversa direta e em grupo, não lidas e aviso, tarefas com responsável, painel do setor', async () => {
  const admin = token;
  const grupos = await ok('GET', '/grupos');
  const fin = grupos.find((g) => g.nome === 'Financeiro');
  const novo = async (nome, email) => {
    token = admin;
    const u = await ok('POST', '/usuarios', { nome, email, grupoId: fin.id });
    token = (await ok('POST', '/auth/login', { email, senha: u.senhaProvisoria })).token;
    await ok('POST', '/auth/trocar-senha', { atual: u.senhaProvisoria, nova: 'SenhaDaMesa2026x' });
    return { id: u.id, token };
  };
  const ana = await novo('Ana Mesa Teste', 'ana.mesa@aritana.local');
  const bia = await novo('Bia Mesa Teste', 'bia.mesa@aritana.local');
  const eu = (await (token = admin, ok('GET', '/auth/eu'))).id;
  const como = (t) => { token = t; };
  const antes = new Date(Date.now() - 1000).toISOString();

  // Conversa direta: a mesma, de qualquer um dos dois lados.
  como(ana.token);
  assert.ok((await ok('GET', '/mesa/equipe')).some((p) => p.id === bia.id && p.setor === 'Financeiro'));
  const c = await ok('POST', '/mesa/conversas', { usuarioIds: [bia.id] });
  await ok('POST', `/mesa/conversas/${c.id}/mensagens`, { texto: 'Bia, o boleto da Maria já caiu?' });
  como(bia.token);
  assert.equal((await ok('POST', '/mesa/conversas', { usuarioIds: [ana.id] })).id, c.id, 'não abre uma segunda conversa com a mesma pessoa');
  let r = await ok('GET', `/mesa/resumo?desde=${encodeURIComponent(antes)}`);
  assert.equal(r.naoLidas, 1);
  assert.deepEqual([r.novas.mensagens[0].de, r.novas.mensagens[0].texto, r.novas.mensagens[0].conversaId], ['Ana Mesa Teste', 'Bia, o boleto da Maria já caiu?', c.id]);
  const lista = await ok('GET', '/mesa/conversas');
  assert.deepEqual([lista[0].nome, lista[0].naoLidas, lista[0].direta], ['Ana Mesa Teste', 1, true]);
  // Abrir marca como lida; a resposta chega para a Ana.
  assert.equal((await ok('GET', `/mesa/conversas/${c.id}/mensagens`)).mensagens.length, 1);
  assert.equal((await ok('GET', '/mesa/resumo')).naoLidas, 0);
  await ok('POST', `/mesa/conversas/${c.id}/mensagens`, { texto: 'Caiu hoje cedo.' });
  como(ana.token);
  assert.equal((await ok('GET', '/mesa/resumo')).naoLidas, 1);
  // Quem não participa não lê nem escreve.
  como(admin);
  assert.equal((await chamar('GET', `/mesa/conversas/${c.id}/mensagens`)).status, 404);
  assert.equal((await chamar('POST', `/mesa/conversas/${c.id}/mensagens`, { texto: 'intruso' })).status, 404);
  assert.ok(!(await ok('GET', '/mesa/conversas')).some((x) => x.id === c.id));
  // Grupo precisa de nome; todos os participantes recebem.
  assert.equal((await chamar('POST', '/mesa/conversas', { usuarioIds: [ana.id, bia.id] })).status, 400);
  const g = await ok('POST', '/mesa/conversas', { usuarioIds: [ana.id, bia.id], nome: 'Financeiro' });
  await ok('POST', `/mesa/conversas/${g.id}/mensagens`, { texto: 'Fechamento do mês é sexta.' });
  como(bia.token);
  const grupo = (await ok('GET', '/mesa/conversas')).find((x) => x.id === g.id);
  assert.deepEqual([grupo.nome, grupo.direta, grupo.naoLidas, grupo.participantes.length], ['Financeiro', false, 1, 3]);
  assert.equal((await chamar('POST', `/mesa/conversas/${g.id}/mensagens`, { texto: '   ' })).status, 400);

  // Tarefas: a gestão passa uma tarefa; a responsável é avisada, conclui, mas não muda o prazo.
  como(admin);
  const ontem = new Date(Date.now() - 3 * 3600_000 - 86400_000).toISOString().slice(0, 10);
  const t = await ok('POST', '/mesa/tarefas', { titulo: 'Conferir extrato do Asaas', responsavelId: bia.id, venceEm: ontem, prioridade: 'alta' });
  const minha = await ok('POST', '/mesa/tarefas', { titulo: 'Ligar para o contador' });
  assert.equal(minha.responsavelId, eu);
  assert.equal((await chamar('POST', '/mesa/tarefas', { titulo: 'x' })).status, 400);
  como(bia.token);
  r = await ok('GET', `/mesa/resumo?desde=${encodeURIComponent(antes)}`);
  assert.deepEqual([r.tarefasAbertas, r.tarefasAtrasadas, r.novas.tarefas[0].titulo], [1, 1, 'Conferir extrato do Asaas']);
  const dela = await ok('GET', '/mesa/tarefas');
  assert.deepEqual([dela.length, dela[0].atrasada, dela[0].prioridade, dela[0].criadoPorId], [1, true, 'alta', eu]);
  assert.equal((await chamar('PATCH', `/mesa/tarefas/${t.id}`, { venceEm: '2030-01-01' })).status, 403, 'quem recebeu a tarefa não muda o prazo');
  assert.equal((await chamar('PATCH', `/mesa/tarefas/${minha.id}`, { feita: true })).status, 403, 'tarefa de outra pessoa');
  assert.equal((await chamar('GET', '/mesa/tarefas?filtro=equipe')).status, 403);
  await ok('PATCH', `/mesa/tarefas/${t.id}`, { feita: true });
  assert.equal((await ok('GET', '/mesa/tarefas')).length, 0);
  assert.equal((await ok('GET', '/mesa/tarefas?feitas=1')).length, 1);
  como(admin);
  assert.ok((await ok('GET', '/mesa/tarefas?filtro=equipe')).some((x) => x.id === minha.id));
  assert.equal((await ok('GET', '/mesa/tarefas?filtro=criadas')).length, 0, 'a que passei já foi feita');
  await ok('PATCH', `/mesa/tarefas/${t.id}`, { feita: false, venceEm: '2030-01-01', responsavelId: ana.id });
  assert.equal((await ok('GET', '/mesa/tarefas?filtro=criadas'))[0].responsavel, 'Ana Mesa Teste');

  // Painel do setor: padrão pelos módulos da pessoa; a gestão escolhe o do setor.
  como(bia.token);
  let p = await ok('GET', '/mesa/painel');
  assert.equal(p.setor, 'Financeiro');
  assert.equal(p.personalizado, null);
  assert.ok(p.indicadores.some((i) => i.chave === 'receber_vencido') && !p.indicadores.some((i) => i.chave === 'crm_fila'), 'só indicadores dos módulos que ela vê');
  assert.equal(p.catalogo, undefined);
  assert.equal((await chamar('PUT', '/mesa/painel', { grupoId: fin.id, indicadores: ['receber_vencido'] })).status, 403);
  como(admin);
  assert.equal((await chamar('PUT', '/mesa/painel', { grupoId: fin.id, indicadores: ['nao_existe'] })).status, 400);
  await ok('PUT', '/mesa/painel', { grupoId: fin.id, indicadores: ['pagar_semana', 'receber_vencido', 'crm_fila'] });
  assert.ok((await ok('GET', '/mesa/painel')).setores.find((s) => s.id === fin.id).indicadores.includes('pagar_semana'));
  como(bia.token);
  p = await ok('GET', '/mesa/painel');
  assert.deepEqual([p.personalizado, p.indicadores.map((i) => i.chave)], ['setor', ['pagar_semana', 'receber_vencido']], 'o do CRM não aparece: ela não tem o módulo');
  assert.equal(typeof p.indicadores[1].valor, 'number');
  como(admin);
  await ok('PUT', '/mesa/painel', { grupoId: fin.id, indicadores: [] });
  // Todos os indicadores do catálogo rodam sem erro para quem tem acesso total.
  const todos = (await ok('GET', '/mesa/painel')).catalogo.map((x) => x.chave);
  const nomeDoMeuGrupo = (await ok('GET', '/auth/eu')).grupo;
  const meuGrupo = (await ok('GET', '/mesa/painel')).setores.find((s) => s.nome === nomeDoMeuGrupo) ?? null;
  if (meuGrupo) {
    for (let i = 0; i < todos.length; i += 12) {
      await ok('PUT', '/mesa/painel', { grupoId: meuGrupo.id, indicadores: todos.slice(i, i + 12) });
      assert.equal((await ok('GET', '/mesa/painel')).indicadores.length, todos.slice(i, i + 12).length);
    }
    await ok('PUT', '/mesa/painel', { grupoId: meuGrupo.id, indicadores: [] });
  }
});

test('aprendizado da IA: memória do cliente, revisão semanal com aprovação, correção no chat e lições nas instruções', async () => {
  await ok('PUT', '/integracoes/ia', { valores: { ANTHROPIC_API_KEY: 'chave-claude-teste' } });
  const c = await ok('POST', '/crm/canais', { nome: 'Aprendizado IA', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create').pop().corpo.webhook.url.replace('http://localhost:3100', '');
  let n = 0;
  const tel = '5527977665501';
  const chegar = (texto) => fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', instance: c.config.instancia, data: { key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: `APR${++n}` }, pushName: 'Paula Aprendiz', message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const espera = (ms = 900) => new Promise((r) => setTimeout(r, ms));
  const conversa = async () => (await ok('GET', `/crm/conversas?aba=todas&canalId=${c.id}`)).find((x) => x.telefone === tel);
  const dados = async () => ok('GET', `/crm/conversas/${(await conversa()).id}/mensagens`);
  const cfg = await ok('GET', '/crm/ia-agente');
  assert.equal(cfg.memoriaClientes, true);
  const ligados = cfg.especialistas.filter((e) => e.ativo);
  for (const e of ligados) await ok('PATCH', `/crm/ia-agentes/${e.id}`, { ativo: false });
  const base = { ativo: true, canais: [c.id], instrucoes: '', conhecimento: 'Vendemos semijoias.', maxRespostas: 30, nome: '', maxTransferencias: 2 };
  await ok('PUT', '/crm/ia-agente', base);
  const antes = (await ok('GET', '/crm/ia-licoes')).length;

  // A IA atende, não sabe o prazo de troca e passa para a equipe; ao passar, guarda a memória da pessoa.
  await chegar('Oi, boa tarde');
  await espera();
  await chegar('Qual o prazo de troca? Quero falar com atendente');
  await espera(1500);
  let d = await dados();
  assert.match(d.mensagens.filter((x) => x.direcao === 'interna').at(-1).texto, /A IA passou esta conversa para a equipe/);
  assert.equal(d.contato.memoriaIa, 'Perguntou sobre prazo de troca. Prefere falar com atendente.');
  const memoria = (await recebidos()).filter((r) => r.caminho === '/claude/v1/messages' && String(r.corpo.system).includes('ficha de memória')).pop();
  assert.equal(memoria.corpo.model, 'claude-haiku-5-5', 'a memória usa o modelo barato');
  assert.match(memoria.corpo.system, /NÃO guarde: saúde/);

  // Uma pessoa responde. A revisão da semana transforma isso em sugestão, que só vale depois de aprovada.
  const cv = await conversa();
  await ok('POST', `/crm/conversas/${cv.id}/mensagens`, { texto: 'Oi Paula! O prazo de troca é de 30 dias, com a nota.' });
  const rev = await ok('POST', '/crm/ia-licoes/revisar');
  assert.ok(rev.conversas >= 1);
  assert.equal(rev.sugestoes, 1, 'a lição curta demais é descartada');
  assert.equal((await ok('POST', '/crm/ia-licoes/revisar')).sugestoes, 0, 'não repete a mesma sugestão');
  let licoes = await ok('GET', '/crm/ia-licoes?status=pendente');
  const sugerida = licoes.find((l) => l.quando === 'O cliente pergunta qual é o prazo de troca');
  assert.deepEqual([sugerida.origem, sugerida.status], ['semanal', 'pendente']);

  // Correção no chat, por quem é da gestão: já vale. Por quem só atende, fica pendente.
  const daIa = d.mensagens.find((x) => x.direcao === 'saida' && x.ia);
  const p = await ok('GET', `/crm/mensagens/${daIa.id}/pergunta`);
  assert.equal(p.pergunta, 'Oi, boa tarde');
  const corrigida = await ok('POST', '/crm/ia-licoes', { mensagemId: daIa.id, quando: 'O cliente só cumprimenta', resposta: 'Cumprimente de volta e pergunte se procura uma peça ou quer revender.' });
  assert.deepEqual([corrigida.status, corrigida.origem], ['ativa', 'correcao']);
  assert.equal((await chamar('POST', '/crm/ia-licoes', { quando: 'curto', resposta: 'x' })).status, 400);

  // Pendente não entra nas instruções; aprovada entra, junto com a memória da pessoa.
  await ok('POST', `/crm/conversas/${cv.id}/ia`, { ativa: true });
  await chegar('Voltei, pode me ajudar?');
  await espera();
  const sistema = () => recebidos().then((r) => String(r.filter((x) => x.caminho === '/claude/v1/messages' && String(x.corpo.system).includes('"passar"')).pop().corpo.system));
  let s1 = await sistema();
  assert.match(s1, /O QUE A EQUIPE JÁ TE ENSINOU[\s\S]*Quando: O cliente só cumprimenta\n  Faça: Cumprimente de volta/);
  assert.ok(!s1.includes('prazo de troca é de 30 dias'), 'sugestão pendente ainda não vale');
  assert.match(s1, /O QUE VOCÊ LEMBRA DESTA PESSOA[^\n]*Perguntou sobre prazo de troca/);
  await ok('PATCH', `/crm/ia-licoes/${sugerida.id}`, { status: 'ativa', resposta: 'O prazo de troca é de 30 dias, com a nota fiscal.' });
  // A equipe apaga a memória e desliga o recurso: some das instruções.
  await ok('PATCH', `/crm/contatos/${cv.contatoId}`, { memoriaIa: null });
  await ok('PUT', '/crm/ia-agente', { ...base, memoriaClientes: false });
  await chegar('E a troca, como é?');
  await espera();
  s1 = await sistema();
  assert.match(s1, /Faça: O prazo de troca é de 30 dias, com a nota fiscal\./);
  assert.ok(!s1.includes('O QUE VOCÊ LEMBRA DESTA PESSOA'));
  d = await dados();
  assert.equal(d.contato.memoriaIa, null, 'com a memória desligada, nada é guardado');

  // Limpeza.
  licoes = await ok('GET', '/crm/ia-licoes');
  assert.equal(licoes.length, antes + 2);
  for (const l of [sugerida, corrigida]) await ok('DELETE', `/crm/ia-licoes/${l.id}`);
  await ok('PUT', '/crm/ia-agente', { ativo: false, canais: [], instrucoes: '', conhecimento: '', maxRespostas: 10, memoriaClientes: true });
  for (const e of ligados) await ok('PATCH', `/crm/ia-agentes/${e.id}`, { ativo: true });
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('scorecard: indicadores por todos/setor/pessoa, conta automática, acertos e erros, fechar com bônus, ninguém avalia a si mesmo', async () => {
  const admin = token;
  const grupos = await ok('GET', '/grupos');
  const fin = grupos.find((g) => g.nome === 'Financeiro');
  const ger = grupos.find((g) => g.nome.startsWith('Gerência'));
  assert.ok(ger.permissoes.scorecard?.includes('editar'), 'a gerência avalia');
  const novo = async (nome, email, grupoId) => {
    token = admin;
    const u = await ok('POST', '/usuarios', { nome, email, grupoId });
    token = (await ok('POST', '/auth/login', { email, senha: u.senhaProvisoria })).token;
    await ok('POST', '/auth/trocar-senha', { atual: u.senhaProvisoria, nova: 'SenhaDoScore2026x' });
    return { id: u.id, token };
  };
  const rita = await novo('Rita Score Teste', 'rita.score@aritana.local', fin.id);
  const gil = await novo('Gil Gerente Score', 'gil.score@aritana.local', ger.id);
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

  // Funcionária comum não entra no scorecard.
  token = rita.token;
  assert.equal((await chamar('GET', `/scorecard/mes?mes=${mes}`)).status, 403);
  assert.deepEqual((await ok('GET', '/scorecard/minhas')).avaliacoes, []);

  // A gestão monta as regras e os indicadores.
  token = admin;
  const r0 = await ok('GET', '/scorecard/regras');
  assert.ok(r0.fontes.some((f) => f.chave === 'tarefas_no_prazo') && r0.setores.some((s) => s.id === fin.id));
  await ok('PUT', '/scorecard/regras', { ...r0.regras, bonusPadrao: 30000, bonusPorSetor: { [fin.id]: 50000 }, faixas: [{ notaMinima: 90, percentual: 100 }, { notaMinima: 70, percentual: 50 }] });
  assert.equal((await chamar('PUT', '/scorecard/regras', { ...r0.regras, teto: 50 })).status, 400);
  const geral = await ok('POST', '/scorecard/indicadores', { nome: 'Tarefas no prazo (teste score)', perspectiva: 'processos', fonte: 'tarefas_no_prazo', unidade: 'percentual', meta: 100, sentido: 'maior', peso: 1 });
  const setor = await ok('POST', '/scorecard/indicadores', { nome: 'Baixas conferidas (teste score)', perspectiva: 'financeira', meta: 200, peso: 3, grupoId: fin.id });
  const outroSetor = await ok('POST', '/scorecard/indicadores', { nome: 'Indicador da loja (teste score)', meta: 10, peso: 1, grupoId: grupos.find((g) => g.nome === 'Loja').id });
  const dela = await ok('POST', '/scorecard/indicadores', { nome: 'Erros de lançamento (teste score)', perspectiva: 'aprendizado', meta: 2, sentido: 'menor', peso: 1, usuarioId: rita.id });
  assert.equal((await chamar('POST', '/scorecard/indicadores', { nome: 'x', meta: 1, peso: 1 })).status, 400);
  assert.equal((await chamar('POST', '/scorecard/indicadores', { nome: 'Os dois', meta: 1, peso: 1, grupoId: fin.id, usuarioId: rita.id })).status, 400);
  assert.equal((await chamar('POST', '/scorecard/indicadores', { nome: 'Fonte errada', meta: 1, peso: 1, fonte: 'nao_existe' })).status, 400);

  // Conta automática: 2 tarefas com prazo no mês, 1 feita no prazo → 50%.
  const t1 = await ok('POST', '/mesa/tarefas', { titulo: 'Tarefa score 1', responsavelId: rita.id, venceEm: hoje });
  await ok('POST', '/mesa/tarefas', { titulo: 'Tarefa score 2', responsavelId: rita.id, venceEm: hoje });
  token = rita.token;
  await ok('PATCH', `/mesa/tarefas/${t1.id}`, { feita: true });

  token = gil.token;
  let av = await ok('GET', `/scorecard/avaliacao?usuarioId=${rita.id}&mes=${mes}`);
  assert.deepEqual(av.indicadores.map((i) => i.nome).sort(), ['Baixas conferidas (teste score)', 'Erros de lançamento (teste score)', 'Tarefas no prazo (teste score)'], 'o da loja não vale para ela');
  const auto = av.indicadores.find((i) => i.indicadorId === geral.id);
  assert.deepEqual([auto.automatico, auto.resultado, auto.nota], [50, 50, 50]);
  assert.equal(av.bonusCheio, 50000, 'bônus do setor');

  // Acertos e erros (ninguém registra o próprio).
  await ok('POST', '/scorecard/ocorrencias', { usuarioId: rita.id, data: hoje, tipo: 'acerto', pontos: 6, descricao: 'Achou um boleto pago em duplicidade.' });
  const erro = await ok('POST', '/scorecard/ocorrencias', { usuarioId: rita.id, data: hoje, tipo: 'erro', pontos: 2, descricao: 'Baixou um título no cliente errado.' });
  assert.equal((await chamar('POST', '/scorecard/ocorrencias', { usuarioId: gil.id, data: hoje, tipo: 'acerto', pontos: 5, descricao: 'Eu mesmo me elogiando.' })).status, 403);
  assert.equal((await chamar('POST', '/scorecard/ocorrencias', { usuarioId: rita.id, data: '2099-01-01', tipo: 'acerto', pontos: 5, descricao: 'No futuro.' })).status, 400);

  // Lança os resultados: baixas 180 de 200 (90, peso 3); erros 1 com meta até 2 (100); tarefas 50 (automático).
  av = await ok('PUT', '/scorecard/avaliacao', { usuarioId: rita.id, mes, observacao: 'Bom mês.', resultados: [{ indicadorId: setor.id, resultado: 180, comentario: 'Conferido no extrato' }, { indicadorId: dela.id, resultado: 1 }] });
  // (90×3 + 100×1 + 50×1) / 5 = 84; +6 −2 = 88 → faixa de 70 → 50% de R$ 500
  assert.deepEqual([av.conta.notaIndicadores, av.conta.ajuste, av.conta.notaFinal, av.conta.percentualBonus, av.conta.bonus], [84, 4, 88, 50, 25000]);
  assert.equal(av.avaliacao.status, 'aberta');
  const lista = await ok('GET', `/scorecard/mes?mes=${mes}`);
  const linha = lista.itens.find((i) => i.usuarioId === rita.id);
  assert.deepEqual([linha.status, linha.nota, linha.bonus], ['aberta', 88, 25000]);
  assert.equal((await chamar('PUT', '/scorecard/avaliacao', { usuarioId: gil.id, mes, resultados: [] })).status, 403, 'ninguém avalia a si mesmo');
  assert.equal((await chamar('POST', '/scorecard/avaliacao/fechar', { usuarioId: gil.id, mes })).status, 403);

  // Fecha: a nota fica gravada; mudar o indicador ou as regras depois não altera a fechada.
  av = await ok('POST', '/scorecard/avaliacao/fechar', { usuarioId: rita.id, mes });
  assert.deepEqual([av.avaliacao.status, av.conta.notaFinal, av.conta.bonus], ['fechada', 88, 25000]);
  token = admin;
  await ok('PATCH', `/scorecard/indicadores/${setor.id}`, { meta: 1000 });
  await ok('PUT', '/scorecard/regras', { ...r0.regras, bonusPadrao: 0, bonusPorSetor: {} });
  token = gil.token;
  av = await ok('GET', `/scorecard/avaliacao?usuarioId=${rita.id}&mes=${mes}`);
  assert.deepEqual([av.conta.notaFinal, av.conta.bonus, av.indicadores.find((i) => i.indicadorId === setor.id).meta], [88, 25000, 200]);
  assert.equal((await chamar('PUT', '/scorecard/avaliacao', { usuarioId: rita.id, mes, resultados: [] })).status, 400, 'fechada não muda');
  assert.equal((await chamar('DELETE', `/scorecard/ocorrencias/${erro.id}`)).status, 400);
  assert.equal((await ok('GET', `/scorecard/mes?mes=${mes}`)).totalBonus >= 25000, true);

  // Ela vê a própria avaliação fechada na Minha mesa.
  token = rita.token;
  const minhas = await ok('GET', '/scorecard/minhas');
  assert.equal(minhas.avaliacoes[0].nota, 88);
  assert.equal(minhas.avaliacoes[0].indicadores.length, 3);
  assert.equal(minhas.avaliacoes[0].ocorrencias.length, 2);
  assert.equal(minhas.avaliacoes[0].observacao, 'Bom mês.');

  // Reabrir recalcula com as regras atuais.
  token = gil.token;
  av = await ok('POST', '/scorecard/avaliacao/reabrir', { usuarioId: rita.id, mes });
  assert.equal(av.avaliacao.status, 'aberta');
  assert.equal(av.conta.bonus, 0, 'sem bônus configurado agora');
  await ok('DELETE', `/scorecard/ocorrencias/${erro.id}`);

  // Limpeza.
  token = admin;
  for (const i of [geral, setor, outroSetor, dela]) await ok('DELETE', `/scorecard/indicadores/${i.id}`);
  await ok('PUT', '/scorecard/regras', r0.regras);
});

test('minha mesa: anexos só para quem participa, painel por pessoa; modelo do aditivo de cobrança instalado', async () => {
  const admin = token;
  const fin = (await ok('GET', '/grupos')).find((g) => g.nome === 'Financeiro');
  const u = await ok('POST', '/usuarios', { nome: 'Caio Anexo Teste', email: 'caio.anexo@aritana.local', grupoId: fin.id });
  token = (await ok('POST', '/auth/login', { email: 'caio.anexo@aritana.local', senha: u.senhaProvisoria })).token;
  await ok('POST', '/auth/trocar-senha', { atual: u.senhaProvisoria, nova: 'SenhaDoAnexo2026x' });
  const caio = token;
  token = admin;
  const eu = (await ok('GET', '/auth/eu')).id;
  const c = await ok('POST', '/mesa/conversas', { usuarioIds: [u.id] });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const m = await ok('POST', `/mesa/conversas/${c.id}/mensagens`, { anexo: { nome: 'comprovante.png', mime: 'image/png', base64: `data:image/png;base64,${png}` } });
  assert.deepEqual([m.texto, m.anexoNome, m.anexoMime, m.anexoTamanho], ['', 'comprovante.png', 'image/png', 70]);
  assert.equal((await chamar('POST', `/mesa/conversas/${c.id}/mensagens`, {})).status, 400);
  assert.equal((await chamar('POST', `/mesa/conversas/${c.id}/mensagens`, { anexo: { nome: 'pagina.html', mime: 'text/html', base64: Buffer.from('<script>alert(1)</script>').toString('base64') } })).status, 400, 'html não entra');
  token = caio;
  assert.equal((await ok('GET', '/mesa/conversas'))[0].ultima, '📎 comprovante.png');
  const r = await fetch(`${API}/mesa/anexos/${m.id}`, { headers: { authorization: `Bearer ${caio}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('base64'), png);
  // Quem não participa não baixa.
  const outro = await ok('POST', '/mesa/conversas', { usuarioIds: [eu] });
  assert.ok(outro.id);
  token = admin;
  const g = await ok('POST', '/mesa/conversas', { usuarioIds: [u.id], nome: 'Só eu e Caio' });
  const m2 = await ok('POST', `/mesa/conversas/${g.id}/mensagens`, { texto: 'segue', anexo: { nome: 'lista.csv', mime: 'text/csv', base64: Buffer.from('a;b\n1;2').toString('base64') } });
  const intruso = await ok('POST', '/usuarios', { nome: 'Intruso Anexo', email: 'intruso.anexo@aritana.local', grupoId: fin.id });
  const tokIntruso = (await ok('POST', '/auth/login', { email: 'intruso.anexo@aritana.local', senha: intruso.senhaProvisoria })).token;
  const r2 = await fetch(`${API}/mesa/anexos/${m2.id}`, { headers: { authorization: `Bearer ${tokIntruso}` } });
  assert.ok([403, 404].includes(r2.status), `intruso recebeu ${r2.status}`);
  const r3 = await fetch(`${API}/mesa/anexos/${m2.id}`, { headers: { authorization: `Bearer ${caio}` } });
  assert.equal(r3.headers.get('content-type'), 'application/octet-stream', 'o que não abre na tela vem como download');
  assert.match(r3.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''lista\.csv/);

  // Painel por pessoa vale mais que o do setor; vazio volta ao do setor.
  await ok('PUT', '/mesa/painel', { grupoId: fin.id, indicadores: ['receber_vencido'] });
  await ok('PUT', '/mesa/painel', { usuarioId: u.id, indicadores: ['pagar_semana', 'recebido_mes'] });
  assert.equal((await chamar('PUT', '/mesa/painel', { grupoId: fin.id, usuarioId: u.id, indicadores: [] })).status, 400);
  assert.ok((await ok('GET', '/mesa/painel')).pessoas.find((p) => p.id === u.id).indicadores.includes('pagar_semana'));
  token = caio;
  let p = await ok('GET', '/mesa/painel');
  assert.deepEqual([p.personalizado, p.indicadores.map((i) => i.chave)], ['pessoa', ['pagar_semana', 'recebido_mes']]);
  token = admin;
  await ok('PUT', '/mesa/painel', { usuarioId: u.id, indicadores: [] });
  token = caio;
  p = await ok('GET', '/mesa/painel');
  assert.deepEqual([p.personalizado, p.indicadores.map((i) => i.chave)], ['setor', ['receber_vencido']]);
  token = admin;
  await ok('PUT', '/mesa/painel', { grupoId: fin.id, indicadores: [] });

  // O modelo do aditivo de cobrança veio instalado (provisório) e abre exceção na cláusula 10ª.
  const modelos = await ok('GET', '/documentos/modelos');
  const aditivo = (modelos.itens ?? modelos).find((x) => x.tipo === 'aditivo' && x.titulo.startsWith('Aditivo: serviço de cobrança'));
  assert.ok(aditivo, 'aditivo instalado');
  assert.match(aditivo.conteudo, /^MODELO PROVISÓRIO/);
  assert.match(aditivo.conteudo, /A Cláusula 10ª do contrato passa a vigorar acrescida/);
  assert.match(aditivo.conteudo, /\{\{nome\}\}/);
});

test('indique e ganhe: link de cada um (equipe e consultora), convite, aprovação, prêmio no 1º pagamento, equipe com outro valor, cancelar e ligar à mão', async () => {
  const admin = token;
  const cpfDe = (base) => { const d = String(base).padStart(9, '0').slice(0, 9).split('').map(Number); for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += d[i] * (n + 1 - i); const r = (s * 10) % 11; d.push(r === 10 ? 0 : r); } return d.join(''); };
  let ip = 0;
  const candidatar = async (corpo) => {
    const r = await fetch(`${API}/publico/candidaturas`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.77.0.${++ip}` }, body: JSON.stringify({ cidade: 'Serra', uf: 'ES', modeloInteresse: 'consignado', consentimentoLgpd: true, ...corpo }) });
    assert.equal(r.status, 201, JSON.stringify(await r.clone().json().catch(() => ({}))));
  };
  const candidataPor = async (nome) => { const c = (await ok('GET', '/crm/candidaturas')).find((x) => x.nome === nome); return ok('GET', `/crm/candidaturas/${c.id}`); };
  const regras0 = await ok('GET', '/indicacoes/regras');
  assert.deepEqual([regras0.ativo, regras0.valor, regras0.valorEquipe], [true, 5000, null]);

  // Equipe: link na Minha mesa, sempre o mesmo código.
  const meu = await ok('GET', '/indicacoes/meu');
  assert.match(meu.link, new RegExp(`/i/${meu.codigo}$`));
  assert.equal((await ok('GET', '/indicacoes/meu')).codigo, meu.codigo);
  assert.equal(meu.premio, 5000);

  // Consultora: link no portal.
  const rosa = await ok('POST', '/pessoas', { tipo: 'representante', nome: 'Rosa Indicadora Teste', documento: cpfDe(771000099), telefone1: '27997710099', email: 'rosa.indicadora@exemplo.com', cidade: 'Serra', uf: 'ES', modeloTrabalho: 'consignado', limiteCredito: 100000 });
  const acesso = await ok('POST', `/portal/gerar-link/${rosa.id}`, {});
  token = '';
  const portal = (await ok('POST', `/portal/link/${acesso.token}`, {})).token;
  token = portal;
  const daRep = await ok('GET', '/portal/indicacoes');
  assert.notEqual(daRep.codigo, meu.codigo);
  assert.equal((await chamar('GET', '/indicacoes/meu')).status, 401, 'token do portal não abre a área da equipe');

  // Convite público mostra só o primeiro nome.
  token = '';
  assert.deepEqual(await ok('GET', `/publico/indicacao/${daRep.codigo.toLowerCase()}`), { nome: 'Rosa' });
  assert.equal((await chamar('GET', '/publico/indicacao/NAOEXISTE')).status, 404);

  // Candidata pelo link da consultora; a própria consultora tentando se indicar não conta.
  await candidatar({ nome: 'Ivone Indicada Teste', telefone: '(27) 99771-0001', cpf: cpfDe(771000011), origem: { ref: daRep.codigo, utm_source: 'indicacao' } });
  await candidatar({ nome: 'Ela Mesma Teste', telefone: '(27) 99771-0099', origem: { ref: daRep.codigo } });
  token = admin;
  let lista = await ok('GET', '/indicacoes');
  const iv = lista.itens.find((i) => i.indicada === 'Ivone Indicada Teste');
  assert.deepEqual([iv.status, iv.indicador, iv.indicadorTipo], ['candidata', 'Rosa Indicadora Teste', 'consultora']);
  assert.ok(!lista.itens.some((i) => i.indicada === 'Ela Mesma Teste'), 'ninguém indica a si mesmo');
  const cand = await candidataPor('Ivone Indicada Teste');
  assert.match(cand.indicadaPor, /Rosa Indicadora Teste \(link de indicação\)/);
  // Mandou o formulário de novo por outro link: continua a primeira indicação.
  token = '';
  await candidatar({ nome: 'Ivone Indicada Teste', telefone: '(27) 99771-0001', cpf: cpfDe(771000011), origem: { ref: meu.codigo } });
  token = admin;
  assert.equal((await ok('GET', '/indicacoes')).itens.filter((i) => i.indicada === 'Ivone Indicada Teste').length, 1);

  // Aprovada: espera o 1º pedido pago. Nada pago ainda, nada liberado.
  const { pessoaId: ivone } = await ok('POST', `/crm/candidaturas/${cand.id}/aprovar`, { modeloTrabalho: 'revenda' });
  assert.equal((await ok('GET', '/indicacoes?status=aprovada')).itens.find((i) => i.indicada === 'Ivone Indicada Teste').indicadaPessoaId, ivone);
  assert.equal((await ok('POST', '/indicacoes/verificar')).liberadas, 0);
  // Primeiro pagamento dela: o prêmio é liberado e vira conta a pagar para a consultora que indicou.
  const emp = (await ok('GET', '/empresas'))[0];
  const [t] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: ivone, descricao: 'Primeira compra Ivone', valor: 30000, vencimento: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10) });
  await ok('POST', `/financeiro/titulos/${t.id}/baixar`, {});
  assert.equal((await ok('POST', '/indicacoes/verificar')).liberadas, 1);
  assert.equal((await ok('POST', '/indicacoes/verificar')).liberadas, 0, 'não libera duas vezes');
  lista = await ok('GET', '/indicacoes');
  const liberada = lista.itens.find((i) => i.indicada === 'Ivone Indicada Teste');
  assert.deepEqual([liberada.status, liberada.valor], ['liberada', 5000]);
  assert.match(liberada.motivoLiberacao, /Primeira compra Ivone/);
  const premios = await ok('GET', `/financeiro/titulos?tipo=pagar&pessoaId=${rosa.id}`);
  const premio = (premios.itens ?? premios).find((x) => x.id === liberada.tituloId);
  assert.deepEqual([premio.valor, premio.status, premio.descricao], [5000, 'aberto', 'Prêmio por indicação · Rosa Indicadora Teste indicou Ivone Indicada Teste']);
  // A consultora vê no portal: só o primeiro nome e a cidade.
  token = portal;
  const vis = await ok('GET', '/portal/indicacoes');
  assert.deepEqual([vis.itens[0].nome, vis.itens[0].cidade, vis.itens[0].status, vis.totais.aReceber], ['Ivone', 'Serra/ES', 'liberada', 5000]);
  assert.ok(!JSON.stringify(vis).includes('Indicada Teste'), 'sem o nome completo da indicada');
  // Pago o prêmio, aparece como pago.
  token = admin;
  await ok('POST', `/financeiro/titulos/${premio.id}/baixar`, {});
  token = portal;
  assert.equal((await ok('GET', '/portal/indicacoes')).totais.recebido, 5000);

  // Equipe com outro valor (afiliada: vale o primeiro pedido pelo link faturado, ou um pagamento).
  token = admin;
  await ok('PUT', '/indicacoes/regras', { ...regras0, valorEquipe: 3000 });
  assert.equal((await chamar('PUT', '/indicacoes/regras', { ...regras0, validadeDias: 1 })).status, 400);
  token = '';
  await candidatar({ nome: 'Joana Da Equipe Teste', telefone: '(27) 99771-0002', cpf: cpfDe(771000022), origem: { ref: meu.codigo } });
  token = admin;
  const c2 = await candidataPor('Joana Da Equipe Teste');
  const { pessoaId: joana } = await ok('POST', `/crm/candidaturas/${c2.id}/aprovar`, { modeloTrabalho: 'consignado' });
  const [t2] = await ok('POST', '/financeiro/titulos', { empresaId: emp.id, tipo: 'receber', pessoaId: joana, descricao: 'Acerto Joana', valor: 10000, vencimento: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10) });
  await ok('POST', `/financeiro/titulos/${t2.id}/baixar`, {});
  await ok('POST', '/indicacoes/verificar');
  const daEquipe = (await ok('GET', '/indicacoes')).itens.find((i) => i.indicada === 'Joana Da Equipe Teste');
  assert.deepEqual([daEquipe.status, daEquipe.valor, daEquipe.indicadorTipo], ['liberada', 3000, 'equipe']);
  assert.equal((await ok('GET', '/indicacoes/meu')).totais.aReceber, 3000);

  // Cancelar: o prêmio em aberto é cancelado no Financeiro.
  await ok('POST', `/indicacoes/${daEquipe.id}/cancelar`, { motivo: 'Cadastro duplicado de teste' });
  const todos = await ok('GET', `/financeiro/titulos?tipo=pagar&aba=todos&busca=${encodeURIComponent('Prêmio por indicação')}`);
  assert.equal((todos.itens ?? todos).find((x) => x.id === daEquipe.tituloId).status, 'cancelado');
  assert.equal((await chamar('POST', `/indicacoes/${liberada.id}/cancelar`, { motivo: 'Tentando cancelar pago' })).status, 400, 'prêmio já pago não cancela');

  // Ligar à mão (indicação feita de boca) e recusa.
  const solta = await ok('POST', '/crm/candidaturas', { nome: 'Kátia Sem Link Teste', telefone: '(27) 99771-0003', cidade: 'Vitória', uf: 'ES', modeloInteresse: 'afiliado' });
  await ok('POST', '/indicacoes/ligar', { candidaturaId: solta.id, codigo: daRep.codigo });
  assert.equal((await chamar('POST', '/indicacoes/ligar', { candidaturaId: solta.id, codigo: meu.codigo })).status, 400);
  await ok('PATCH', `/crm/candidaturas/${solta.id}`, { etapa: 'recusada', motivoRecusa: 'Sem perfil' });
  assert.equal((await ok('GET', '/indicacoes')).itens.find((i) => i.indicada === 'Kátia Sem Link Teste').status, 'recusada');
  // Desligado: o link para de registrar.
  await ok('PUT', '/indicacoes/regras', { ...regras0, ativo: false });
  token = '';
  assert.equal((await chamar('GET', `/publico/indicacao/${meu.codigo}`)).status, 404);
  await candidatar({ nome: 'Luana Desligado Teste', telefone: '(27) 99771-0004', origem: { ref: meu.codigo } });
  token = admin;
  assert.ok(!(await ok('GET', '/indicacoes')).itens.some((i) => i.indicada === 'Luana Desligado Teste'));
  await ok('PUT', '/indicacoes/regras', regras0);
});

test('importar histórico do WhatsApp: servidor próprio pede o QR uma vez, grava só o período, sem fila; servidor de fora busca direto', async () => {
  const seg = (dias) => Math.floor(Date.now() / 1000) - dias * 86400 - 60;
  const dia = (dias) => new Date(Date.now() - 3 * 3600_000 - dias * 86400_000).toISOString().slice(0, 10);
  const reg = (id, tel, texto, dias, fromMe = false, extra = {}) => ({ key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe, id }, pushName: fromMe ? 'Loja' : 'Cliente Antiga Hist', message: { conversation: texto }, messageTimestamp: seg(dias), ...extra });
  const c = await ok('POST', '/crm/canais', { nome: 'Número do histórico', tipo: 'evolution' });
  const inst = c.config.instancia;
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(inst)}`);
  // Oficial e Z-API não importam; período inválido é recusado.
  assert.equal((await chamar('POST', `/crm/canais/${c.id}/historico`, { de: dia(5), ate: dia(10) })).status, 400);
  assert.equal((await chamar('POST', `/crm/canais/${c.id}/historico`, { de: dia(5), ate: dia(-2) })).status, 400);
  // Primeira vez no servidor próprio: liga o pedido de histórico, desconecta e espera o QR.
  const imp = await ok('POST', `/crm/canais/${c.id}/historico`, { de: dia(15), ate: dia(0) });
  assert.equal(imp.status, 'aguardando_qr');
  const ver = await (await fetch(`${SIM}/__evo/ver?i=${encodeURIComponent(inst)}`)).json();
  assert.deepEqual([ver.settings?.syncFullHistory, ver.estado], [true, 'close']);
  assert.equal((await chamar('POST', `/crm/canais/${c.id}/historico`, { de: dia(3), ate: dia(0) })).status, 400, 'uma importação por vez');
  await ok('POST', '/crm/importacoes/conferir');
  assert.equal((await ok('GET', `/crm/canais/${c.id}/historico`))[0].status, 'aguardando_qr', 'sem ler o QR, continua esperando');
  // Leu o QR: o celular manda o histórico (2 fora do período, 1 grupo, 4 dentro).
  await fetch(`${SIM}/__evo/historico?i=${encodeURIComponent(inst)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([
    reg('H1', '5527966610001', 'Oi, tem anel de prata?', 10),
    reg('H2', '5527966610001', 'Temos sim! Te mando fotos.', 10, true, { messageTimestamp: seg(10) + 30 }),
    reg('H3', '5527966610002', 'Quero ser revendedora', 4, false, { pushName: 'Outra Antiga Hist' }),
    reg('H4', '5527966610002', '', 4, false, { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'olha essa' } } }),
    reg('H5', '5527966610003', 'Mensagem velha demais', 40),
    reg('H6', '120363000000@g', 'grupo', 3, false, { key: { remoteJid: '120363000000@g.us', fromMe: false, id: 'H6' } }),
  ]) });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(inst)}`);
  // Uma mensagem velha chegando pelo webhook durante a sincronização não vai para a fila.
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create' && r.corpo.instanceName === inst).pop().corpo.webhook.url.replace('http://localhost:3100', '');
  await ok('POST', '/crm/importacoes/conferir'); // conectou → recebendo
  assert.equal((await ok('GET', `/crm/canais/${c.id}/historico`))[0].status, 'recebendo');
  await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', data: reg('H7', '5527966610004', 'mensagem antiga pelo webhook', 2) }) });
  await ok('POST', '/crm/importacoes/conferir'); // rodada 1
  await ok('POST', '/crm/importacoes/conferir'); // rodada 2 (última)
  const [fim] = await ok('GET', `/crm/canais/${c.id}/historico`);
  assert.equal(fim.status, 'concluida', JSON.stringify(fim));
  assert.equal(fim.mensagens, 4, 'só as 4 do período, sem grupo e sem repetir nas rodadas');
  const conversas = [...await ok('GET', '/crm/conversas?aba=resolvidas'), ...await ok('GET', '/crm/conversas?aba=fila')].filter((x) => x.canal === 'Número do histórico');
  const a = conversas.find((x) => x.telefone === '5527966610001');
  assert.ok(a, 'conversa importada');
  assert.ok(!(await ok('GET', '/crm/conversas?aba=fila')).some((x) => ['5527966610001', '5527966610002', '5527966610004'].includes(x.telefone)), 'nada do histórico foi para a fila');
  assert.ok(!conversas.some((x) => x.telefone === '5527966610003'), 'fora do período não entrou');
  const msgs = await ok('GET', `/crm/conversas/${a.id}/mensagens`);
  const lista = msgs.mensagens ?? msgs;
  assert.deepEqual(lista.map((m) => [m.direcao, m.texto]), [['entrada', 'Oi, tem anel de prata?'], ['saida', 'Temos sim! Te mando fotos.']]);
  const b = conversas.find((x) => x.telefone === '5527966610002');
  const fotos = (await ok('GET', `/crm/conversas/${b.id}/mensagens`));
  assert.ok((fotos.mensagens ?? fotos).some((m) => /olha essa \[foto do histórico\]/.test(m.texto ?? '')), 'mídia sem baixar vira aviso no texto');
  assert.ok(conversas.some((x) => x.telefone === '5527966610004'), 'a do webhook ficou no histórico');
  // Segunda vez: já tem o histórico guardado, busca direto, sem QR; não repete o que já entrou.
  const d2 = await ok('POST', `/crm/canais/${c.id}/historico`, { de: dia(45), ate: dia(0) });
  assert.equal(d2.status, 'importando');
  let r2;
  for (let i = 0; i < 20 && (r2 = (await ok('GET', `/crm/canais/${c.id}/historico`))[0]).status === 'importando'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([r2.status, r2.mensagens], ['concluida', 1], 'só a de 40 dias era nova');
  assert.equal((await (await fetch(`${SIM}/__evo/ver?i=${encodeURIComponent(inst)}`)).json()).estado, 'open', 'não desconectou de novo');
  // Cancelar uma que espera o QR (outro número).
  const c2 = await ok('POST', '/crm/canais', { nome: 'Número cancela hist', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c2.config.instancia)}`);
  const i2 = await ok('POST', `/crm/canais/${c2.id}/historico`, { de: dia(5), ate: dia(0) });
  assert.equal((await ok('POST', `/crm/importacoes/${i2.id}/cancelar`)).status, 'erro');
  await ok('DELETE', `/crm/canais/${c2.id}`);
});

test('transferir conversa: lista todos os usuários, dizendo quem não pode receber e por quê', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Número transferência', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const hook = (await recebidos()).filter((r) => r.caminho === '/evo/instance/create' && r.corpo.instanceName === c.config.instancia).pop().corpo.webhook.url.replace('http://localhost:3100', '');
  await fetch(API.replace(/\/api$/, '') + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', data: { key: { remoteJid: '5527966620001@s.whatsapp.net', fromMe: false, id: 'TRF1' }, pushName: 'Cliente Transfere', message: { conversation: 'oi' }, messageTimestamp: Math.floor(Date.now() / 1000) } }) });
  const cv = (await ok('GET', '/crm/conversas?aba=fila')).find((x) => x.telefone === '5527966620001');
  const lista = await ok('GET', `/crm/conversas/${cv.id}/transferir-para`);
  const ativos = (await ok('GET', '/usuarios')).filter((u) => u.ativo);
  assert.equal(lista.length, ativos.length, 'todo usuário ativo aparece');
  const semCrm = lista.find((x) => !x.pode);
  assert.ok(semCrm, 'há quem não pode receber');
  assert.equal(semCrm.motivo, 'Sem acesso ao CRM');
  assert.equal((await chamar('POST', `/crm/conversas/${cv.id}/transferir`, { usuarioId: semCrm.id })).status, 400);
  const pode = lista.find((x) => x.pode);
  await ok('POST', `/crm/conversas/${cv.id}/transferir`, { usuarioId: pode.id });
  await ok('DELETE', `/crm/canais/${c.id}`);
});

test('respostas rápidas com foto, vídeo ou áudio', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const r = await ok('POST', '/crm/respostas', { atalho: 'catalogo-foto', texto: 'Olha o catálogo novo!', midia: { nome: 'catalogo.png', mime: 'image/png', base64: png } });
  assert.deepEqual([r.midiaMime, r.midiaNome], ['image/png', 'catalogo.png']);
  const so = await ok('POST', '/crm/respostas', { atalho: 'audio-boasvindas', midia: { nome: 'oi.ogg', mime: 'audio/ogg; codecs=opus', base64: Buffer.from('OggS-audio-de-teste').toString('base64') } });
  assert.deepEqual([so.texto, so.midiaMime], ['', 'audio/ogg']);
  const arq = await fetch(`${API}/crm/midia/${r.midia}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(arq.status, 200);
  assert.equal((await fetch(`${API}/crm/midia/${r.midia}`)).status, 401, 'a mídia só sai com login');
  assert.equal((await chamar('POST', '/crm/respostas', { atalho: 'vazia' })).status, 400, 'sem texto e sem mídia');
  assert.equal((await chamar('POST', '/crm/respostas', { atalho: 'pdf-nao', midia: { nome: 'a.pdf', mime: 'application/pdf', base64: png } })).status, 400, 'só foto, vídeo ou áudio');
  assert.equal((await chamar('POST', '/crm/respostas', { atalho: 'catalogo-foto', texto: 'de novo' })).status, 400, 'atalho repetido');
  const lista = await ok('GET', '/crm/respostas');
  assert.ok(lista.some((x) => x.atalho === 'catalogo-foto' && x.midia === r.midia));
  await ok('DELETE', `/crm/respostas/${r.id}`);
  await ok('DELETE', `/crm/respostas/${so.id}`);
});

test('tarefa com mensagem de WhatsApp: texto automático no horário, resposta rápida com foto por um clique, template', async () => {
  const c = await ok('POST', '/crm/canais', { nome: 'Número das tarefas', tipo: 'evolution' });
  await fetch(`${SIM}/__evo/conectar?i=${encodeURIComponent(c.config.instancia)}`);
  const funil = (await ok('GET', '/crm/funis'))[0];
  const card = await ok('POST', '/crm/leads', { funilId: funil.id, nome: 'Marta Tarefa Zap', telefone: '27966630001' });
  const envios = async (tipo) => (await recebidos()).filter((r) => r.caminho === `/evo/message/${tipo}/${c.config.instancia}`);
  // Sem texto, resposta ou template: recusa.
  assert.equal((await chamar('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Sem mensagem', venceEm: new Date().toISOString(), mensagem: { tipo: 'texto', texto: '', canalId: c.id, envio: 'automatico' } })).status, 400);
  assert.equal((await chamar('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Sem resposta', venceEm: new Date().toISOString(), mensagem: { tipo: 'resposta', canalId: c.id, envio: 'lembrete' } })).status, 400);
  // 1) Texto automático: ainda não venceu → não manda; venceu → o motor manda sozinho e conclui a tarefa.
  const futura = await ok('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Lembrar do acerto', venceEm: new Date(Date.now() + 3600_000).toISOString(), mensagem: { tipo: 'texto', texto: 'Oi {{primeiro_nome}}, seu acerto é amanhã!', canalId: c.id, envio: 'automatico' } });
  const agora = await ok('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Avisar agora', venceEm: new Date(Date.now() - 60_000).toISOString(), mensagem: { tipo: 'texto', texto: 'Oi {{primeiro_nome}}, chegou peça nova!', canalId: c.id, envio: 'automatico' } });
  const antes = (await envios('sendText')).length;
  await ok('POST', '/crm/processar');
  const txt = (await envios('sendText')).slice(antes);
  assert.deepEqual(txt.map((e) => e.corpo.text), ['Oi Marta, chegou peça nova!'], 'só a que venceu, com o nome preenchido');
  let lead = await ok('GET', `/crm/leads/${card.id}`);
  const t1 = lead.tarefas.find((t) => t.id === agora.id);
  assert.deepEqual([t1.mensagemStatus, !!t1.feitaEm], ['enviada', true]);
  assert.equal(lead.tarefas.find((t) => t.id === futura.id).mensagemStatus, 'pendente');
  await ok('POST', '/crm/processar');
  assert.equal((await envios('sendText')).length, antes + 1, 'não manda duas vezes');
  // A conversa não foi para ninguém nem para a fila (envio automático).
  // 2) Resposta rápida com foto, "só lembrar": nada sai sozinho; "Enviar agora" manda a foto com a legenda.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const r = await ok('POST', '/crm/respostas', { atalho: 'tarefa-foto', texto: 'Olha a novidade, {{primeiro_nome}}!', midia: { nome: 'novidade.png', mime: 'image/png', base64: png } });
  const lembrete = await ok('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Mandar foto', venceEm: new Date(Date.now() - 60_000).toISOString(), mensagem: { tipo: 'resposta', respostaId: r.id, envio: 'lembrete' } });
  const antesMidia = (await envios('sendMedia')).length;
  await ok('POST', '/crm/processar');
  assert.equal((await envios('sendMedia')).length, antesMidia, 'lembrete não sai sozinho');
  await ok('POST', `/crm/tarefas/${lembrete.id}/enviar`);
  const foto = (await envios('sendMedia')).pop();
  assert.deepEqual([foto.corpo.mediatype, foto.corpo.caption, foto.corpo.fileName], ['image', 'Olha a novidade, Marta!', 'novidade.png']);
  assert.equal((await chamar('POST', `/crm/tarefas/${lembrete.id}/enviar`)).status, 400, 'já enviada');
  // Sem número escolhido: sai pelo da última conversa (este).
  // 3) Template livre automático.
  const tpl = await ok('POST', '/crm/templates', { nome: 'Tarefa template', texto: 'Oi {{primeiro_nome}}, tudo certo para hoje?' });
  await ok('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Template', venceEm: new Date(Date.now() - 60_000).toISOString(), mensagem: { tipo: 'template', templateId: tpl.id, envio: 'automatico' } });
  await ok('POST', '/crm/processar');
  assert.equal((await envios('sendText')).pop().corpo.text, 'Oi Marta, tudo certo para hoje?');
  // Falha (número desconectado): fica registrada e dá para tentar de novo.
  await ok('POST', `/crm/canais/${c.id}/desconectar`);
  const falha = await ok('POST', `/crm/leads/${card.id}/tarefas`, { titulo: 'Vai falhar', venceEm: new Date(Date.now() - 60_000).toISOString(), mensagem: { tipo: 'texto', texto: 'teste', canalId: c.id, envio: 'automatico' } });
  await ok('POST', '/crm/processar');
  lead = await ok('GET', `/crm/leads/${card.id}`);
  const tf = lead.tarefas.find((t) => t.id === falha.id);
  assert.equal(tf.mensagemStatus, 'falhou');
  assert.ok(tf.mensagemErro);
  assert.equal(tf.feitaEm, null, 'tarefa continua aberta');
  await ok('DELETE', `/crm/respostas/${r.id}`);
  await ok('DELETE', `/crm/canais/${c.id}`);
});
