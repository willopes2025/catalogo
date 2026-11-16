/**
 * Simuladores do Asaas e da Focus NFe para os testes automáticos.
 * Respondem no formato das APIs reais e guardam o que receberam, para o teste conferir.
 * Uso: node test/simuladores.mjs (porta 3199)
 */
import http from 'node:http';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const recebidos = [];
const wa = { n: 0, zapiConectado: true, webhookZapi: null };
/** Evolution API (servidor próprio de WhatsApp por QR code): instâncias por nome. */
const evo = new Map();
// Notificações recebidas pelos simuladores do Firebase e da Apple
const pushes = [];
const fcmChaves = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const apnsChaves = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
// O e2e lê as chaves privadas de teste daqui, para colar na tela de integrações.
writeFileSync(join(tmpdir(), 'aritana-push-teste.json'), JSON.stringify({
  firebase: { type: 'service_account', project_id: 'aritana-teste', client_email: 'push@aritana-teste.iam.gserviceaccount.com', private_key: fcmChaves.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'http://localhost:3199/fcm/token' },
  apns: apnsChaves.privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));
// Google: eventos criados na agenda simulada
const googleEventos = new Map();
let googleSeq = 0;

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
  // Acertos já baixados no Jueri (histórico): a listagem vem resumida, o detalhe traz os itens.
  baixados: [
    { id: 2001, codigo_pedido: 30, status: 'Baixado', fk_revendedor_id: 502, data_criacao: '2026-08-01 10:00', data_baixa: '2026-09-02 15:00', valor_comissao: '35.94', itens: [{ id: 21, fk_produto_id: 9001, quantidade: 3, quantidade_vendida: 2, quantidade_devolvida: 1, valor_unitario: 59.9 }, { id: 22, fk_produto_id: 9002, quantidade: 2, quantidade_vendida: 0, quantidade_devolvida: 2, valor_unitario: 30 }] },
    { id: 2002, codigo_pedido: 31, status: 'Baixado', fk_revendedor_id: 502, data_criacao: '2026-09-03 10:00', data_baixa: '2026-10-05 11:00', itens: [{ id: 23, fk_produto_id: 9002, quantidade: 4, quantidade_vendida: 3, quantidade_devolvida: 1, valor_unitario: 30 }] },
    { id: 2003, codigo_pedido: 12, status: 'Baixado', fk_revendedor_id: 99999, data_baixa: '2026-10-10', itens: [{ id: 24, fk_produto_id: 8888, quantidade: 1, quantidade_vendida: 1, valor_unitario: 10 }] },
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

// Estado do simulador do Meta (campanhas mudam de status e orçamento; guarda o que o sistema enviou).
const metaSim = {
  campanhas: [
    { id: '120000001', name: 'Revendedoras novembro', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '5000', objective: 'OUTCOME_LEADS' },
    { id: '120000002', name: 'Clientes Black Friday', status: 'PAUSED', effective_status: 'PAUSED', lifetime_budget: '90000', objective: 'OUTCOME_SALES' },
  ],
  publicos: [{ id: '600000', name: 'Visitantes do site', description: '', subtype: 'WEBSITE', approximate_count_lower_bound: 1000, approximate_count_upper_bound: 2000 }],
  enviados: {},
  catalogo: null,
  semLeadsRetrieval: false,
  ultimoPeriodo: null,
};

function responder(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

http
  .createServer(async (req, res) => {
    let txt = '';
    for await (const c of req) txt += c;
    let corpo = null;
    try {
      corpo = txt ? JSON.parse(txt) : null;
    } catch {
      corpo = { bruto: txt.slice(0, 200) }; // multipart (upload de mídia)
    }
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

    // ── WhatsApp oficial (API Cloud da Meta) ──
    if (url.pathname.startsWith('/meta-wa/')) {
      const r = url.pathname.replace('/meta-wa/', '');
      if (req.headers.authorization !== 'Bearer token-meta-wa' && !r.startsWith('arquivo/')) return responder(res, 401, { error: { message: 'Invalid OAuth access token', code: 190 } });
      if (req.method === 'POST' && r === 'PN1/messages') {
        if (corpo?.to === '5599999999999') return responder(res, 400, { error: { message: 'Re-engagement message', code: 131047 } });
        return responder(res, 200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.${++wa.n}` }] });
      }
      if (req.method === 'POST' && r === 'PN1/media') return responder(res, 200, { id: 'midia-enviada-1' });
      if (r === 'PN1') return responder(res, 200, { display_phone_number: '+55 27 3333-0000', verified_name: 'Aritana Semijoias', quality_rating: 'GREEN' });
      if (r === 'WABA1/message_templates') return responder(res, 200, { data: [
        { name: 'boas_vindas', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Olá {{1}}, bem-vinda à Aritana! Sua etapa: {{2}}.' }] },
        { name: 'em_analise', language: 'pt_BR', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Aguarde.' }] },
      ] });
      if (r === 'midia-recebida-1') return responder(res, 200, { url: 'http://localhost:3199/meta-wa/arquivo/1', mime_type: 'image/png' });
      if (r === 'arquivo/1') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')); }
      return responder(res, 404, { error: { message: 'not found' } });
    }

    // ── WhatsApp por QR code no servidor próprio (Evolution API v2) ──
    if (url.pathname === '/__evo/conectar') {
      const i = evo.get(url.searchParams.get('i'));
      if (i) i.estado = 'open';
      return responder(res, 200, { ok: !!i });
    }
    if (url.pathname === '/__evo/apagar') { evo.delete(url.searchParams.get('i')); return responder(res, 200, { ok: true }); }
    // ───── Firebase (FCM v1): token da conta de serviço e envio ─────
    if (url.pathname === '/fcm/token' && req.method === 'POST') {
      const f = new URLSearchParams(txt);
      const partes = (f.get('assertion') ?? '').split('.');
      if (f.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || partes.length !== 3) return responder(res, 400, { error: 'invalid_grant' });
      // Confere a assinatura RS256 com a chave pública de teste (o sistema tem que assinar certo).
      const ok = crypto.createVerify('RSA-SHA256').update(`${partes[0]}.${partes[1]}`).verify(fcmChaves.publicKey, Buffer.from(partes[2], 'base64url'));
      if (!ok) return responder(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      return responder(res, 200, { access_token: 'fcm-acesso', expires_in: 3600 });
    }
    const fcm = url.pathname.match(/^\/fcm\/v1\/projects\/([^/]+)\/messages:send$/);
    if (fcm) {
      if (req.headers.authorization !== 'Bearer fcm-acesso') return responder(res, 401, { error: { status: 'UNAUTHENTICATED' } });
      const token = corpo?.message?.token;
      if (String(token).startsWith('morto')) return responder(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } });
      pushes.push({ via: 'fcm', projeto: fcm[1], token, titulo: corpo.message.notification.title, texto: corpo.message.notification.body, link: corpo.message.data?.link });
      return responder(res, 200, { name: `projects/${fcm[1]}/messages/1` });
    }
    if (url.pathname === '/__pushes') return responder(res, 200, pushes);

    // ───── Google (OAuth + Agenda + Meet) ─────
    if (url.pathname === '/google/token' && req.method === 'POST') {
      const f = new URLSearchParams(txt);
      if (f.get('client_secret') !== 'segredo-google-teste-123') return responder(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        if (f.get('code') !== 'codigo-bom') return responder(res, 400, { error: 'invalid_grant', error_description: 'Bad code' });
        const idToken = `x.${Buffer.from(JSON.stringify({ email: 'agenda@aritana.com.br' })).toString('base64url')}.y`;
        return responder(res, 200, { access_token: 'acesso-1', refresh_token: 'refresh-google-1', expires_in: 3600, id_token: idToken });
      }
      if (f.get('grant_type') === 'refresh_token') return f.get('refresh_token') === 'refresh-google-1' ? responder(res, 200, { access_token: 'acesso-2', expires_in: 3600 }) : responder(res, 400, { error: 'invalid_grant' });
      return responder(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/google/revoke') return responder(res, 200, {});
    const gev = url.pathname.match(/^\/google\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (gev) {
      if (!/^Bearer acesso-/.test(req.headers.authorization ?? '')) return responder(res, 401, { error: { message: 'Invalid Credentials' } });
      if (req.method === 'POST') {
        const id = `ev${++googleSeq}`;
        const comMeet = !!corpo?.conferenceData?.createRequest && url.searchParams.get('conferenceDataVersion') === '1';
        const ev = { id, ...corpo, agenda: decodeURIComponent(gev[1]), hangoutLink: comMeet ? `https://meet.google.com/abc-defg-${String(googleSeq).padStart(3, '0')}` : undefined };
        googleEventos.set(id, ev);
        return responder(res, 200, ev);
      }
      const ev = googleEventos.get(gev[2]);
      if (!ev) return responder(res, 404, { error: { message: 'Not Found' } });
      if (req.method === 'PATCH') {
        Object.assign(ev, corpo);
        if (corpo?.conferenceData?.createRequest && !ev.hangoutLink) ev.hangoutLink = `https://meet.google.com/abc-defg-${ev.id}`;
        return responder(res, 200, ev);
      }
      if (req.method === 'DELETE') { googleEventos.delete(gev[2]); res.writeHead(204); return res.end(); }
    }
    if (url.pathname === '/google/__eventos') return responder(res, 200, [...googleEventos.values()]);

    // Servidor Evolution de fora (ligado pelo token da instância): mesma API, outra chave, instância "loja-centro" já existente.
    let evoFora = false;
    if (url.pathname.startsWith('/evofora/')) {
      if (!evo.has('loja-centro')) evo.set('loja-centro', { estado: 'open', webhook: null });
      if (req.headers.apikey !== 'token-da-instancia-fora') return responder(res, 401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });
      url.pathname = url.pathname.replace('/evofora/', '/evo/');
      evoFora = true;
    }
    if (url.pathname === '/__evo/ver') return responder(res, 200, evo.get(url.searchParams.get('i')) ?? null);
    if (url.pathname.startsWith('/evo/')) {
      if (!evoFora && req.headers.apikey !== 'chave-evo-teste') return responder(res, 401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });
      const partes = url.pathname.slice(5).split('/').map(decodeURIComponent);
      const qr = { base64: `data:image/png;base64,iVBORw0KGgoQR${++wa.n}`, code: `2@qr${wa.n}`, count: 1 };
      if (partes[0] === 'instance' && partes[1] === 'create') {
        if (evo.has(corpo.instanceName)) return responder(res, 403, { status: 403, error: 'Forbidden', response: { message: [`This name "${corpo.instanceName}" is already in use.`] } });
        evo.set(corpo.instanceName, { estado: 'connecting', webhook: corpo.webhook });
        return responder(res, 201, { instance: { instanceName: corpo.instanceName, status: 'connecting' }, hash: 'h', qrcode: qr });
      }
      if (partes[0] === 'instance' && partes[1] === 'fetchInstances') {
        const n = url.searchParams.get('instanceName');
        return responder(res, 200, evo.has(n) ? [{ name: n, connectionStatus: evo.get(n).estado, ownerJid: '5527977776666@s.whatsapp.net', profileName: 'Aritana Loja' }] : []);
      }
      const inst = evo.get(partes[2] ?? partes[1]);
      if (!inst) return responder(res, 404, { status: 404, error: 'Not Found', response: { message: [`The "${partes[2]}" instance does not exist`] } });
      const r = `${partes[0]}/${partes[1]}`;
      if (r === 'instance/connectionState') return responder(res, 200, { instance: { instanceName: partes[2], state: inst.estado } });
      if (r === 'instance/connect') return responder(res, 200, inst.estado === 'open' ? { instance: { state: 'open' } } : qr);
      if (r === 'instance/logout') { inst.estado = 'close'; return responder(res, 200, { status: 'SUCCESS' }); }
      if (r === 'instance/delete') { evo.delete(partes[2]); return responder(res, 200, { status: 'SUCCESS' }); }
      if (url.pathname === '/evo/__existe') return responder(res, 200, { existe: evo.has(url.searchParams.get('i')) });
      if (r === 'webhook/set') { inst.webhook = corpo.webhook; return responder(res, 201, { webhook: corpo.webhook }); }
      if (r === 'message/sendReaction') return responder(res, 201, { key: corpo.key, status: 'PENDING' });
      if (r === 'chat/deleteMessageForEveryone') return responder(res, 201, { key: { id: corpo.id }, status: 'PENDING' });
      if (r === 'message/sendText' || r === 'message/sendMedia' || r === 'message/sendWhatsAppAudio') {
        if (inst.estado !== 'open') return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: ['Connection Closed'] } });
        if (String(corpo.number).endsWith('0000')) return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: [{ exists: false, jid: `${corpo.number}@s.whatsapp.net`, number: corpo.number }] } });
        return responder(res, 201, { key: { remoteJid: `${corpo.number}@s.whatsapp.net`, fromMe: true, id: `EVO${++wa.n}` }, status: 'PENDING' });
      }
      if (r === 'chat/getBase64FromMediaMessage') {
        // Como o servidor real com o banco de mensagens desligado: só acha a mídia se receber a mensagem inteira.
        if (!corpo?.message?.message) return responder(res, 400, { status: 400, error: 'Bad Request', response: { message: ['Message not found'] } });
        return responder(res, 201, { mediaType: 'imageMessage', mimetype: 'image/jpeg', base64: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64') });
      }
      return responder(res, 404, { status: 404, error: 'Not Found', response: { message: ['rota'] } });
    }

    // ── WhatsApp por QR code (Z-API) ──
    if (url.pathname.startsWith('/zapi/instances/I1/token/T1/')) {
      if (req.headers['client-token'] !== 'CT1') return responder(res, 400, { error: 'unauthorized', message: 'client-token inválido' });
      const r = url.pathname.replace('/zapi/instances/I1/token/T1/', '');
      if (r.startsWith('send-')) return responder(res, 200, { zaapId: `z${++wa.n}`, messageId: `ZMSG${wa.n}`, id: `ZMSG${wa.n}` });
      if (r === 'status') return responder(res, 200, { connected: wa.zapiConectado, smartphoneConnected: true });
      if (r === 'device') return responder(res, 200, { phone: '5527988887777' });
      if (r === 'qr-code/image') return responder(res, 200, { value: 'data:image/png;base64,iVBORw0KGgo=' });
      if (r === 'update-every-webhooks') { wa.webhookZapi = corpo?.value; return responder(res, 200, { value: true }); }
      if (r === 'disconnect') { wa.zapiConectado = false; return responder(res, 200, { value: true }); }
      return responder(res, 404, { error: 'not found' });
    }
    // ── CEP e CNPJ (ViaCEP, BrasilAPI, CNPJ.ws) ──
    if (url.pathname.startsWith('/viacep/ws/')) {
      const cep = url.pathname.split('/')[3];
      if (cep === '29101010') return responder(res, 200, { cep: '29101-010', logradouro: 'Avenida Champagnat', bairro: 'Centro', localidade: 'Vila Velha', uf: 'ES' });
      if (cep === '29000001') return responder(res, 500, {}); // fora do ar: cai na segunda fonte
      return responder(res, 200, { erro: 'true' });
    }
    if (url.pathname.startsWith('/brasilapi/api/cep/v1/')) {
      const cep = url.pathname.split('/').pop();
      if (cep === '29000001') return responder(res, 200, { cep, state: 'ES', city: 'Vitória', neighborhood: 'Centro', street: 'Rua Sete de Setembro' });
      return responder(res, 404, { message: 'CEP não encontrado' });
    }
    if (url.pathname.startsWith('/brasilapi/api/cnpj/v1/')) {
      const c = url.pathname.split('/').pop();
      if (c === '11222333000181') return responder(res, 200, { cnpj: c, razao_social: 'FORNECEDORA DE SEMIJOIAS DO BRASIL LTDA', nome_fantasia: 'BRILHO FORNECEDORA', descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '120', complemento: 'SALA 3', bairro: 'CENTRO', municipio: 'LIMEIRA', uf: 'SP', cep: '13480000', ddd_telefone_1: '1933334444', email: 'CONTATO@BRILHO.EXEMPLO', descricao_situacao_cadastral: 'ATIVA' });
      if (c === '11444777000161') return responder(res, 429, {}); // limite estourado: cai na segunda fonte
      return responder(res, 404, { message: 'CNPJ não encontrado' });
    }
    if (url.pathname.startsWith('/cnpjws/cnpj/')) {
      const c = url.pathname.split('/').pop();
      if (c === '11444777000161') return responder(res, 200, { razao_social: 'OUTRA EMPRESA LTDA', estabelecimento: { nome_fantasia: null, tipo_logradouro: 'AVENIDA', logradouro: 'BRASIL', numero: '10', complemento: null, bairro: 'CENTRO', cep: '29100000', ddd1: '27', telefone1: '33221100', email: null, situacao_cadastral: 'Baixada', cidade: { nome: 'Vila Velha' }, estado: { sigla: 'ES' }, inscricoes_estaduais: [{ inscricao_estadual: '082123456', ativo: true }] } });
      return responder(res, 404, {});
    }
    if (url.pathname === '/zapi-arquivo/foto.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')); }

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
      if (rota === 'pedido' && url.searchParams.get('status') === '2') return responder(res, 200, { ...lista(J.baixados.map((p) => ({ id: p.id, codigo_pedido: p.codigo_pedido, status: 'Baixado' }))), total: J.baixados.length });
      if (rota === 'pedido') return responder(res, 200, lista(J.pedidos.map((p) => ({ id: p.id, codigo_pedido: p.codigo_pedido, status: 'Aberto', itens: [{ id: 1, '...': '...' }] }))));
      const ped = rota.match(/^pedido\/(\d+)$/);
      if (ped) return responder(res, 200, { data: [...J.pedidos, ...J.baixados].find((p) => String(p.id) === ped[1]) });
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
    if (url.pathname.startsWith('/meta/') && !(req.method === 'GET' && (url.pathname === '/meta/act_999' || (url.pathname === '/meta/act_999/insights' && !url.searchParams.has('time_range'))))) {
      // ── Meta: área Marketing › Meta (campanhas, catálogo, públicos, leads, página) ──
      const auth = req.headers.authorization;
      if (auth !== 'Bearer token-meta-teste' && auth !== 'Bearer token-da-pagina') return responder(res, 401, { error: { message: 'Invalid OAuth access token', code: 190 } });
      const r = url.pathname.replace('/meta/', '');
      const f = new URLSearchParams(req.method === 'POST' ? txt : url.search);
      const m = metaSim;
      if (req.method === 'GET') {
        if (r === 'me/permissions') return responder(res, 200, { data: ['ads_management', 'ads_read', 'business_management', 'catalog_management', 'pages_manage_ads', 'pages_read_engagement', 'pages_show_list'].map((permission) => ({ permission, status: 'granted' })) });
        if (r === 'me/adaccounts') return responder(res, 200, { data: [{ account_id: '999', name: 'Aritana Semijoias', currency: 'BRL', account_status: 1, business: { id: '5550001', name: 'Aritana' } }] });
        if (r === 'me/accounts') return responder(res, 200, { data: [{ id: '700001', name: 'Aritana Semijoias' }] });
        if (r === 'me/businesses') return responder(res, 400, { error: { message: '(#100) Tried accessing nonexisting field (businesses)', code: 100 } });
        if (r === '5550001/owned_product_catalogs') return responder(res, 200, { data: [{ id: '880001', name: 'Catálogo Aritana' }] });
        if (r === 'act_999/campaigns') return responder(res, 200, { data: m.campanhas });
        if (r === '120000001/adsets') return responder(res, 200, { data: [{ id: '130000001', name: 'Mulheres 25-45 ES', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '3000', campaign_id: '120000001' }] });
        if (r === 'act_999/insights') {
          const nivel = f.get('level');
          m.ultimoPeriodo = f.get('time_range');
          if (nivel === 'campaign') return responder(res, 200, { data: [{ campaign_id: '120000001', campaign_name: 'Revendedoras novembro', spend: '150.00', impressions: '10000', reach: '8000', clicks: '260', inline_link_clicks: '200', actions: [{ action_type: 'lead', value: '10' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }] }, { campaign_id: '120000009', campaign_name: 'Campanha antiga apagada', spend: '20.00', impressions: '1000', clicks: '10' }] });
          return responder(res, 200, { data: [{ adset_id: '130000001', adset_name: 'Mulheres 25-45 ES', spend: '150.00', impressions: '10000', inline_link_clicks: '200' }] });
        }
        if (r === 'act_999/customaudiences') return responder(res, 200, { data: m.publicos });
        if (r === '700001' && f.get('fields') === 'access_token') return responder(res, 200, { access_token: 'token-da-pagina', id: '700001' });
        if (r === '700001') return responder(res, 200, { name: 'Aritana Semijoias', fan_count: 5200, followers_count: 5400, link: 'https://facebook.com/aritana' });
        if (r === '700001/posts') return responder(res, 200, { data: [{ id: '700001_1', message: 'Coleção nova chegou!', created_time: '2026-11-10T12:00:00+0000', permalink_url: 'https://facebook.com/aritana/posts/1', likes: { summary: { total_count: 42 } }, comments: { summary: { total_count: 7 } }, shares: { count: 3 } }] });
        if (r === '700001/leadgen_forms') return auth === 'Bearer token-da-pagina' ? responder(res, 200, { data: [{ id: '900001', name: 'Quero revender', status: 'ACTIVE', leads_count: 3, created_time: '2026-11-01T10:00:00+0000' }] }) : responder(res, 403, { error: { message: '(#200) Requires page token', code: 200 } });
        if (r === '900001/leads') {
          if (m.semLeadsRetrieval) return responder(res, 403, { error: { message: '(#200) Requires leads_retrieval permission to manage the object', code: 200 } });
          return responder(res, 200, { data: [
            { id: '9100001', created_time: '2026-11-15T10:00:00+0000', platform: 'ig', campaign_name: 'Revendedoras novembro', ad_name: 'Vídeo 1', field_data: [{ name: 'full_name', values: ['Lead Do Instagram'] }, { name: 'phone_number', values: ['+5527991112222'] }, { name: 'email', values: ['lead@exemplo.com'] }, { name: 'city', values: ['Vila Velha'] }] },
            { id: '9100002', created_time: '2026-11-15T11:00:00+0000', platform: 'fb', field_data: [{ name: 'full_name', values: ['Lead Sem Telefone'] }, { name: 'email', values: ['sem@exemplo.com'] }] },
            { id: '9100003', created_time: '2026-11-15T12:00:00+0000', platform: 'fb', field_data: [{ name: 'full_name', values: ['Lead Do Facebook'] }, { name: 'phone_number', values: ['27 99333-4444'] }] },
          ] });
        }
        const camp = m.campanhas.find((c) => c.id === r);
        if (camp) return responder(res, 200, { ...camp, account_id: '999' });
        if (r === '120000777') return responder(res, 200, { id: r, name: 'De outra conta', account_id: '111', status: 'ACTIVE', daily_budget: '1000' });
        const pub = m.publicos.find((x) => x.id === r);
        if (pub) return responder(res, 200, { ...pub, account_id: '999' });
        return responder(res, 404, { error: { message: `Unsupported get request: ${r}`, code: 100 } });
      }
      const camp = m.campanhas.find((c) => c.id === r);
      if (camp) {
        if (f.get('status')) camp.status = camp.effective_status = f.get('status');
        if (f.get('daily_budget')) camp.daily_budget = f.get('daily_budget');
        return responder(res, 200, { success: true });
      }
      if (r === '880001/items_batch') {
        m.catalogo = JSON.parse(f.get('requests'));
        return responder(res, 200, { handles: ['h1'], validation_status: m.catalogo.filter((x) => x.method === 'UPDATE' && !x.data.image_link).map((x) => ({ retailer_id: x.data.id, errors: [{ message: 'image_link is required' }] })) });
      }
      if (r === 'act_999/customaudiences') {
        const novo = { id: String(600001 + m.publicos.length), name: f.get('name'), description: f.get('description') ?? '', subtype: f.get('subtype'), origem: f.get('origin_audience_id'), spec: f.get('lookalike_spec') };
        m.publicos.push(novo);
        return responder(res, 200, { id: novo.id });
      }
      const usuarios = r.match(/^(\d+)\/users$/);
      if (usuarios) {
        const carga = JSON.parse(f.get('payload'));
        m.enviados[usuarios[1]] = carga;
        return responder(res, 200, { audience_id: usuarios[1], num_received: carga.data.length, num_invalid_entries: 0 });
      }
      return responder(res, 404, { error: { message: 'not found', code: 100 } });
    }
    if (url.pathname === '/__meta') { if (req.method === 'POST') Object.assign(metaSim, corpo); return responder(res, 200, metaSim); }
    if (req.method === 'GET' && url.pathname.startsWith('/meta/')) {
      if (req.headers.authorization !== 'Bearer token-meta-teste') return responder(res, 401, { error: { message: 'Invalid OAuth access token' } });
      if (url.pathname === '/meta/act_999') return responder(res, 200, { name: 'Aritana Semijoias', currency: 'BRL' });
      if (url.pathname === '/meta/act_999/insights' && !url.searchParams.get('after'))
        return responder(res, 200, { data: [{ campaign_id: '120000001', campaign_name: 'Revendedoras novembro', spend: '100.00', date_start: '2026-10-01' }], paging: { next: 'http://localhost:3199/meta/act_999/insights?after=2' } });
      if (url.pathname === '/meta/act_999/insights') return responder(res, 200, { data: [{ campaign_id: '120000001', campaign_name: 'Revendedoras novembro', spend: '23.45', date_start: '2026-11-01' }, { campaign_id: '777', spend: '9.99', date_start: '2026-11-01' }] });
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

// Apple (APNs): HTTP/2 sem TLS na porta 3198, conferindo o JWT ES256 como a Apple faz.
http2
  .createServer((req, res) => {
    let txt = '';
    req.on('data', (c) => (txt += c));
    req.on('end', () => {
      const tok = String(req.headers.authorization ?? '').replace(/^bearer /, '');
      const [h, c, a] = tok.split('.');
      const valido = h && c && a && crypto.createVerify('SHA256').update(`${h}.${c}`).verify({ key: apnsChaves.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(a, 'base64url'));
      if (!valido) { res.writeHead(403); return res.end(JSON.stringify({ reason: 'InvalidProviderToken' })); }
      const token = req.url.replace('/3/device/', '');
      if (token.startsWith('morto')) { res.writeHead(410); return res.end(JSON.stringify({ reason: 'Unregistered' })); }
      const j = JSON.parse(txt || '{}');
      pushes.push({ via: 'apns', token, topic: req.headers['apns-topic'], titulo: j.aps?.alert?.title, texto: j.aps?.alert?.body, link: j.link });
      res.writeHead(200);
      res.end();
    });
  })
  .listen(3198);
