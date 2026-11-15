/**
 * Simuladores do Asaas e da Focus NFe para os testes automáticos.
 * Respondem no formato das APIs reais e guardam o que receberam, para o teste conferir.
 * Uso: node test/simuladores.mjs (porta 3199)
 */
import http from 'node:http';

const recebidos = [];

/** Dados fictícios do Jueri (CPFs gerados, válidos só no dígito). */
const jueri = {
  limitou: false,
  categorias: [{ id: 1, nome: 'Anel API' }, { id: 2, nome: 'Solitário API' }],
  niveis: [{ id: 1, nome: 'Ouro API', meta_mensal: '1000.00', multiplicar_pontos: 2, comissao_personalizada: [{ comissao_minimo: 0, comissao_maximo: null, comissao_porcentagem: 35 }] }],
  fornecedores: [{ id: 1, nome_fantasia: 'Fornecedor API', razao_social: 'Fornecedor API LTDA', cnpj: '11.222.333/0001-81', fk_status_id: 1 }],
  produtos: [
    { id: 9001, fk_fornecedor_id: 1, codigo_barras_fornecedor: '7890000000017', descricao: 'Anel API Jueri', referencia: 'API-01', fk_categoria_id: 1, fk_subcategoria_id: 2, custo_compra_bruto: 10, custo_banho_ouro: 5, quantidade: 7, numero_ncm: '71179000', cfop: '5102', fk_status_id: 1, cor: 'Dourado', fcp: 2, numero_peca: 'P-77', largura: 2.5, peso: 3.1, codigo_barras: '7899990090010', tipo_preco: [{ id: 1, nome: 'Varejo', pivot: { preco: 59.9 } }, { id: 2, nome: 'Atacado', pivot: { preco: 39.9 } }], numero_ean: '7891112223334', custo_total_insumos: 1.5, status_catalogo: 1, imagem: 'http://localhost:3199/jueri-img/a.png', fotos_adicionais: ['http://localhost:3199/jueri-img/b.jpg', 'http://localhost:3199/jueri-img/falsa.jpg'] },
    { id: 9002, imagem: 'https://jueri.com.br/sis/images/foto-padrao.jpg', fk_fornecedor_id: null, descricao: 'Brinco API Jueri', referencia: 'API-02', fk_categoria_id: 1, quantidade: 3, fk_status_id: 1, codigo_barras: '7899990090027', tipo_preco: [{ id: 1, nome: 'Varejo', pivot: { preco: 30 } }] },
    { id: 9003, descricao: 'Sem preço API', referencia: 'API-03', quantidade: 1, fk_status_id: 1, codigo_barras: '7899990090034', tipo_preco: [] },
  ],
  revendedores: [
    { id: 501, nome: 'Líder API Jueri', cpf: '291.417.776-38', fk_tipo_revendedor_id: 1, fk_status_id: 1, telefone_1: '(27) 99999-1111', local: 'Escola Estadual', referencia_nome: 'Maria Referência', referencia_telefone: '(27) 98888-0000', supervisor_nome: 'Supervisora X', comissao_lider: '[]' },
    { id: 502, nome: 'Revendedora API Jueri', cpf: '011.524.493-03', fk_tipo_revendedor_id: 2, gerente: 501, fk_status_id: 1, telefone_3: '(27) 3333-4444', fk_genero_id: 2, fk_estado_civil_id: 2 },
  ],
  representantes: [{ id: 77, fisico: { nome: 'Representante API Jueri', cpf: '398.259.791-94' }, meta_mensal: '2500.00', fk_status_id: 1 }],
  clientes: [{ id: 801, fisico: { nome: 'Cliente API Jueri', cpf: null }, telefone_1: '(27) 97777-0000', fk_revendedor_id: 502, fk_status_id: 1 }],
  pedidos: [
    { id: 3001, codigo_pedido: 45, status: 'Aberto', fk_revendedor_id: 502, comissao_porcentagem: 30, data_criacao: '2026-11-01 10:00', data_acerto: '2026-12-01 00:00', observacao_interna: 'Obs interna', itens: [{ id: 1, fk_produto_id: 9001, quantidade: 2, valor_unitario: 59.9 }, { id: 2, fk_produto_id: 9002, quantidade: 1 }, { id: 3, fk_produto_id: 9001, quantidade: 1, quantidade_vendida: 1 }] },
    { id: 3002, codigo_pedido: 46, status: 'Aberto', fk_representante_id: 77, comissao_porcentagem: 10, data_criacao: '2026-11-05 10:00', itens: [{ id: 4, fk_produto_id: 9999, quantidade: 1 }] },
  ],
  contas: [
    { id: 1, descricao: 'Parcela acerto 1/2', valor: '150.00', data_vencimento: '2026-12-10', fk_revendedor_id: 502, numero_parcela: 1 },
    { id: 2, descricao: 'Já paga', valor: 80, data_vencimento: '2026-10-01', data_pagamento: '2026-10-01' },
    { id: 3, descricao: 'Nomes fora da documentação', valor_pago: 0, vl_parcela: '45,00', dt_venc: '2026-12-20', fk_revendedor_id: 501 },
    // Formato real do Jueri: pessoa no "contato", valor em valor_cobrado, mesmo id em cada parcela.
    { id: 10, contato: { id: 502, nome: 'Revendedora API Jueri', tipo: 'revendedor' }, valor_cobrado: '100.00', valor_pago: '40.00', data_vencimento: '2026-12-05', numero_parcela: '10', parcela: '1/2', data_pagamento: null, status_protestado: false },
    { id: 10, contato: 'Líder API Jueri', valor_cobrado: '100.00', valor_pago: '0.00', data_vencimento: '2027-01-05', numero_parcela: '10', parcela: '2/2', data_pagamento: null, status_protestado: false },
    { id: 10, contato: 'Líder API Jueri', valor_cobrado: '100.00', valor_pago: '0.00', data_vencimento: '2027-01-05', numero_parcela: '10', parcela: '2/2', data_pagamento: null, status_protestado: false },
    { id: 11, contato: 'Ninguém Conhecido', valor_cobrado: '0.00', valor_pago: '0.00', data_vencimento: '2027-01-05', data_pagamento: null },
  ],
};
let seq = 0;
const notas = new Map();

function responder(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

http
  .createServer(async (req, res) => {
    let txt = '';
    for await (const c of req) txt += c;
    const corpo = txt ? JSON.parse(txt) : null;
    const url = new URL(req.url, 'http://x');
    recebidos.push({ metodo: req.method, caminho: url.pathname + url.search, headers: req.headers, corpo });

    if (url.pathname === '/__recebidos') return responder(res, 200, recebidos);
    // Simula o Jueri sendo usado até a virada.
    if (url.pathname === '/__jueri/virada') {
      const passo = url.searchParams.get('passo');
      if (passo === '1') {
        jueri.pedidos[0].itens.push({ id: 9, fk_produto_id: 9002, quantidade: 1 }); // troca: mais uma peça na maleta 45
        jueri.pedidos.push({ id: 3004, codigo_pedido: 47, status: 'Aberto', fk_revendedor_id: 501, data_criacao: '2026-11-20 10:00', itens: [{ id: 10, fk_produto_id: 9001, quantidade: 1 }] });
        jueri.contas = jueri.contas.filter((c) => c.id !== 1); // parcela paga no Jueri
      }
      if (passo === '2') jueri.pedidos = jueri.pedidos.filter((p) => p.id !== 3001); // maleta 45 acertada no Jueri
      return responder(res, 200, { ok: true });
    }
    // Fotos do Jueri: PNG e JPEG mínimos de verdade; "quebrada" responde 404.
    if (url.pathname === '/jueri-img/a.png') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from('89504e470d0a1a0a0000000d49484452000000030000000308060000005628b5bf0000000970485973000003e8000003e801b57b526b0000000e49444154789c63f88f0418707200bb8723dd93f9e43c0000000049454e44ae426082', 'hex')); }
    if (url.pathname === '/jueri-img/b.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from('ffd8ffdb00430006040506050406060506070706080a100a0a09090a140e0f0c1017141818171416161a1d251f1a1b231c1616202c20232627292a29191f2d302d283025282928ffdb0043010707070a080a130a0a13281a161a2828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828ffc00011080004000403012200021101031101ffc4001500010100000000000000000000000000000006ffc40014100100000000000000000000000000000000ffc4001501010100000000000000000000000000000005ffc40014110100000000000000000000000000000000ffda000c03010002110311003f00b8005b7fffd9', 'hex')); }
    if (url.pathname === '/jueri-img/falsa.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end('<html>não é foto</html>'); }

    // ── Jueri (API v1, cliente 11566) ──
    if (url.pathname === '/__jueri/lento') {
      jueri.atraso = Number(url.searchParams.get('ms') ?? 0);
      return responder(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/jueri/') && jueri.atraso) await new Promise((r) => setTimeout(r, jueri.atraso));
    if (req.method === 'GET' && url.pathname.startsWith('/jueri/')) {
      if (req.headers.authorization !== 'Bearer token-jueri-teste') return responder(res, 401, { message: 'Unauthenticated.' });
      const rota = url.pathname.replace(/^\/jueri\/api\/v1\/11566\//, '');
      const pagina = Number(url.searchParams.get('page') ?? 1);
      const lista = (dados, ultima = true) => ({ current_page: pagina, data: dados, next_page_url: ultima ? null : `http://localhost:3199${url.pathname}?page=${pagina + 1}`, per_page: 100 });
      const J = jueri;
      if (rota === 'produto/categoria') return responder(res, 200, lista(J.categorias)); // na prática vem paginada, não lista simples
      if (rota === 'revendedor/nivel') return responder(res, 200, { data: J.niveis });
      if (rota === 'fornecedor') return responder(res, 200, lista(J.fornecedores));
      if (rota === 'produto') return responder(res, 200, pagina === 1 ? lista([J.produtos[0]], false) : lista([{ id: 9002, fk_fornecedor_id: null }, J.produtos[2]]));
      const prod = rota.match(/^produto\/(\d+)$/);
      if (prod) return responder(res, 200, J.produtos.find((p) => String(p.id) === prod[1]));
      if (rota === 'revendedor') return responder(res, 200, lista(J.revendedores));
      if (rota === 'representante') return responder(res, 200, lista(J.representantes));
      if (rota === 'cliente') return responder(res, 200, lista(J.clientes));
      if (rota === 'pedido') return responder(res, 200, lista(J.pedidos.map((p) => ({ id: p.id, codigo_pedido: p.codigo_pedido, status: 'Aberto', itens: [{ id: 1, '...': '...' }] }))));
      const ped = rota.match(/^pedido\/(\d+)$/);
      if (ped) return responder(res, 200, { data: J.pedidos.find((p) => String(p.id) === ped[1]) });
      if (rota === 'financeiro/contas_receber') {
        // A primeira chamada recebe "muitas requisições": o importador deve esperar e tentar de novo.
        if (!J.limitou) {
          J.limitou = true;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          return res.end('{"message":"Too Many Attempts."}');
        }
        return responder(res, 200, lista(J.contas));
      }
      return responder(res, 404, { message: 'not found' });
    }

    // ── Asaas ──
    // Meta Ads (Graph API): conta e gasto por campanha, em duas páginas
    if (req.method === 'GET' && url.pathname.startsWith('/meta/')) {
      if (req.headers.authorization !== 'Bearer token-meta-teste') return responder(res, 401, { error: { message: 'Invalid OAuth access token' } });
      if (url.pathname === '/meta/act_999') return responder(res, 200, { name: 'Aritana Semijoias', currency: 'BRL' });
      if (url.pathname === '/meta/act_999/insights' && !url.searchParams.get('after'))
        return responder(res, 200, { data: [{ campaign_id: '120000001', campaign_name: 'Revendedoras novembro', spend: '100.00' }], paging: { next: 'http://localhost:3199/meta/act_999/insights?after=2' } });
      if (url.pathname === '/meta/act_999/insights') return responder(res, 200, { data: [{ campaign_id: '120000001', campaign_name: 'Revendedoras novembro', spend: '23.45' }, { campaign_id: '777', spend: '9.99' }] });
      return responder(res, 404, { error: { message: 'not found' } });
    }
    if (url.pathname.startsWith('/asaas/')) {
      if (req.headers.access_token !== 'chave-teste') return responder(res, 401, { errors: [{ description: 'Chave inválida' }] });
      if (req.method === 'POST' && url.pathname === '/asaas/customers') {
        if (!corpo?.cpfCnpj) return responder(res, 400, { errors: [{ description: 'cpfCnpj obrigatório' }] });
        return responder(res, 200, { id: `cus_${++seq}`, name: corpo.name });
      }
      if (req.method === 'POST' && url.pathname === '/asaas/payments') {
        if (!corpo?.customer || !corpo?.value || !corpo?.dueDate || !corpo?.billingType) return responder(res, 400, { errors: [{ description: 'Campos obrigatórios' }] });
        const id = `pay_${++seq}`;
        return responder(res, 200, { id, status: 'PENDING', value: corpo.value, invoiceUrl: `https://sandbox.asaas.com/i/${id}`, bankSlipUrl: corpo.billingType === 'BOLETO' ? `https://sandbox.asaas.com/b/pdf/${id}` : null, externalReference: corpo.externalReference });
      }
      const pix = url.pathname.match(/^\/asaas\/payments\/(pay_\d+)\/pixQrCode$/);
      const del = url.pathname.match(/^\/asaas\/payments\/(pay_\d+)$/);
      if (req.method === 'DELETE' && del) return responder(res, 200, { deleted: true, id: del[1] });
      const cash = url.pathname.match(/^\/asaas\/payments\/(pay_\d+)\/receiveInCash$/);
      if (req.method === 'POST' && cash) return responder(res, 200, { id: cash[1], status: 'RECEIVED_IN_CASH' });
      if (req.method === 'GET' && url.pathname === '/asaas/customers') return responder(res, 200, { totalCount: 0, data: [] });
      if (req.method === 'GET' && pix) return responder(res, 200, { encodedImage: 'iVBOR', payload: `00020126580014br.gov.bcb.pix-${pix[1]}`, expirationDate: '2027-01-01 23:59:59' });
    }

    // ── Focus NFe ──
    if (url.pathname.startsWith('/focus/')) {
      const esperado = 'Basic ' + Buffer.from('token-teste:').toString('base64');
      if (req.headers.authorization !== esperado) return responder(res, 403, { codigo: 'permissao_negada', mensagem: 'Token inválido' });
      const m = url.pathname.match(/^\/focus\/v2\/(nfce|nfe)(?:\/(.+))?$/);
      if (!m) return responder(res, 404, { mensagem: 'não encontrado' });
      const [, modelo, refPath] = m;
      if (req.method === 'POST') {
        const ref = url.searchParams.get('ref');
        const faltando = ['cnpj_emitente', 'natureza_operacao', 'items'].filter((k) => !corpo?.[k]);
        if (faltando.length || corpo.items.some((i) => !i.codigo_ncm || !i.cfop)) return responder(res, 422, { status: 'erro_autorizacao', mensagem_sefaz: `Campos obrigatórios: ${faltando.join(', ') || 'items'}` });
        if (modelo === 'nfce') {
          const nota = { status: 'autorizado', numero: String(++seq), serie: '1', chave_nfe: `3226110000000000000065001${String(seq).padStart(9, '0')}`, caminho_danfe: `/notas_fiscais_consumidor/${ref}.html`, caminho_xml_nota_fiscal: `/arquivos/${ref}.xml` };
          notas.set(ref, nota);
          return responder(res, 201, nota);
        }
        notas.set(ref, { status: 'processando_autorizacao' });
        return responder(res, 202, { status: 'processando_autorizacao', ref });
      }
      if (req.method === 'GET' && refPath) {
        const n = notas.get(refPath);
        if (!n) return responder(res, 404, { codigo: 'nao_encontrado' });
        if (n.status === 'processando_autorizacao') Object.assign(n, { status: 'autorizado', numero: String(++seq), serie: '1', chave_nfe: `32261100000000000000550010000000${seq}`, caminho_danfe: `/arquivos/${refPath}.pdf`, caminho_xml_nota_fiscal: `/arquivos/${refPath}.xml` });
        return responder(res, 200, n);
      }
      if (req.method === 'DELETE' && refPath) {
        const n = notas.get(refPath);
        if (!n) return responder(res, 404, {});
        n.status = 'cancelado';
        return responder(res, 200, { status: 'cancelado' });
      }
    }
    responder(res, 404, { mensagem: 'rota do simulador não existe' });
  })
  .listen(3199, () => console.log('simuladores na porta 3199'));
