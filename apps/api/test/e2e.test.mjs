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
