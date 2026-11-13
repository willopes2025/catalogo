/**
 * Simuladores do Asaas e da Focus NFe para os testes automáticos.
 * Respondem no formato das APIs reais e guardam o que receberam, para o teste conferir.
 * Uso: node test/simuladores.mjs (porta 3199)
 */
import http from 'node:http';

const recebidos = [];
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

    // ── Asaas ──
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
