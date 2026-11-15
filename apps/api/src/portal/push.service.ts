import { Inject, Injectable, Logger } from '@nestjs/common';
import { createSign, createPrivateKey } from 'node:crypto';
import { connect } from 'node:http2';
import { and, eq, inArray } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { portalDispositivos } from '../db/schema';
import { SegredosService } from '../segredos/segredos.service';

export interface Notificacao {
  titulo: string;
  texto: string;
  /** Caminho dentro do portal para abrir ao tocar (ex.: /portal/leads). */
  link?: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const APP_ID = 'br.com.aritanaonline.representante';

/** PEM colado num campo de uma linha só perde as quebras: monta de novo. */
function pem(bruto: string, tipo = 'PRIVATE KEY') {
  const corpo = bruto.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  return `-----BEGIN ${tipo}-----\n${corpo.match(/.{1,64}/g)?.join('\n')}\n-----END ${tipo}-----\n`;
}

/**
 * Notificações no app da representante.
 * Android pelo Firebase (FCM v1, com a conta de serviço); iPhone direto na Apple (APNs, com a chave .p8),
 * assim o app de iOS não precisa da biblioteca do Firebase.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('Notificações');
  private fcm: { token: string; ate: number; projeto: string; chave: string } | null = null;
  private apns: { jwt: string; ate: number; chave: string } | null = null;

  constructor(@Inject(DB) private readonly db: Db, private readonly segredos: SegredosService) {}

  get android() {
    return !!this.segredos.v('FIREBASE_CONTA_SERVICO');
  }
  get ios() {
    return !!(this.segredos.v('APNS_CHAVE_P8') && this.segredos.v('APNS_KEY_ID') && this.segredos.v('APNS_TEAM_ID'));
  }

  async registrar(pessoaId: string, token: string, plataforma: 'android' | 'ios') {
    await this.db
      .insert(portalDispositivos)
      .values({ pessoaId, token, plataforma })
      // O mesmo celular pode trocar de dona (outra representante entrou nele): fica com a última.
      .onConflictDoUpdate({ target: portalDispositivos.token, set: { pessoaId, plataforma, ultimoUsoEm: new Date() } });
  }

  /** Só a dona do registro tira o celular da lista (uma representante não desliga o aviso de outra). */
  async remover(token: string, pessoaId: string) {
    await this.db.delete(portalDispositivos).where(and(eq(portalDispositivos.token, token), eq(portalDispositivos.pessoaId, pessoaId)));
  }

  /** Manda para todos os celulares da representante. Nunca derruba quem chamou. */
  async paraPessoa(pessoaId: string, n: Notificacao) {
    try {
      const ds = await this.db.select().from(portalDispositivos).where(eq(portalDispositivos.pessoaId, pessoaId));
      const mortos: string[] = [];
      let enviados = 0;
      for (const d of ds) {
        const r = d.plataforma === 'ios' ? await this.enviarApns(d.token, n) : await this.enviarFcm(d.token, n);
        if (r === 'ok') enviados++;
        if (r === 'invalido') mortos.push(d.token);
      }
      // App desinstalado ou token trocado: tira da lista.
      if (mortos.length) await this.db.delete(portalDispositivos).where(inArray(portalDispositivos.token, mortos));
      return { enviados, removidos: mortos.length };
    } catch (e) {
      this.log.warn(`Notificação não enviada: ${(e as Error).message}`);
      return { enviados: 0, removidos: 0 };
    }
  }

  // ───── Android: Firebase Cloud Messaging (HTTP v1) ─────

  private async tokenFcm() {
    const bruto = this.segredos.v('FIREBASE_CONTA_SERVICO')!;
    // Trocar a conta de serviço na tela de integrações vale na hora (não espera o token antigo vencer).
    if (this.fcm && this.fcm.ate > Date.now() && this.fcm.chave === bruto) return this.fcm;
    const conta = JSON.parse(bruto) as { client_email: string; private_key: string; project_id: string; token_uri?: string };
    const agora = Math.floor(Date.now() / 1000);
    const uri = process.env.FCM_TOKEN_URL ?? conta.token_uri ?? 'https://oauth2.googleapis.com/token';
    const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const corpo = b64url(JSON.stringify({ iss: conta.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: uri, iat: agora, exp: agora + 3600 }));
    const assinatura = createSign('RSA-SHA256').update(`${cab}.${corpo}`).sign(createPrivateKey(pem(conta.private_key)));
    const res = await fetch(uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${corpo}.${b64url(assinatura)}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`Firebase recusou a conta de serviço: ${j.error_description ?? res.status}`);
    this.fcm = { token: j.access_token, ate: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000, projeto: conta.project_id, chave: bruto };
    return this.fcm;
  }

  private async enviarFcm(token: string, n: Notificacao): Promise<'ok' | 'invalido' | 'erro'> {
    if (!this.android) return 'erro';
    try {
      const t = await this.tokenFcm();
      const base = process.env.FCM_URL ?? 'https://fcm.googleapis.com';
      const res = await fetch(`${base}/v1/projects/${t.projeto}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title: n.titulo, body: n.texto }, data: { link: n.link ?? '/portal' }, android: { priority: 'high', notification: { color: '#4e3f34' } } } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return 'ok';
      const j = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
      // Só apaga o celular quando o Firebase diz que ESTE token morreu (app desinstalado) ou não é um token.
      // Um 404 qualquer (projeto errado, por exemplo) não pode limpar a lista de celulares.
      const codigo = j.error?.details?.find((d) => d.errorCode)?.errorCode;
      if (codigo === 'UNREGISTERED' || (j.error?.status === 'INVALID_ARGUMENT' && /registration token/i.test(j.error?.message ?? ''))) return 'invalido';
      if (res.status === 401) this.fcm = null;
      this.log.warn(`Firebase: ${j.error?.message ?? res.status}`);
      return 'erro';
    } catch (e) {
      this.log.warn(`Firebase: ${(e as Error).message}`);
      return 'erro';
    }
  }

  // ───── iPhone: Apple Push Notification service ─────

  private jwtApns() {
    const chave = `${this.segredos.v('APNS_KEY_ID')}|${this.segredos.v('APNS_TEAM_ID')}|${this.segredos.v('APNS_CHAVE_P8')}`;
    if (this.apns && this.apns.ate > Date.now() && this.apns.chave === chave) return this.apns.jwt;
    const cab = b64url(JSON.stringify({ alg: 'ES256', kid: this.segredos.v('APNS_KEY_ID') }));
    const corpo = b64url(JSON.stringify({ iss: this.segredos.v('APNS_TEAM_ID'), iat: Math.floor(Date.now() / 1000) }));
    // A Apple pede a assinatura no formato "cru" (r||s), não DER.
    const assinatura = createSign('SHA256').update(`${cab}.${corpo}`).sign({ key: createPrivateKey(pem(this.segredos.v('APNS_CHAVE_P8')!)), dsaEncoding: 'ieee-p1363' });
    const jwt = `${cab}.${corpo}.${b64url(assinatura)}`;
    // A Apple aceita o mesmo token por até 1 hora; troca com folga.
    this.apns = { jwt, ate: Date.now() + 40 * 60_000, chave };
    return jwt;
  }

  private enviarApns(token: string, n: Notificacao): Promise<'ok' | 'invalido' | 'erro'> {
    if (!this.ios) return Promise.resolve('erro');
    const host = process.env.APNS_URL ?? (this.segredos.v('APNS_AMBIENTE') === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    return new Promise((resolve) => {
      let cliente: ReturnType<typeof connect> | null = null;
      let acabou = false;
      const fim = (r: 'ok' | 'invalido' | 'erro', motivo?: string) => {
        if (acabou) return;
        acabou = true;
        if (motivo) this.log.warn(`Apple: ${motivo}`);
        cliente?.close();
        resolve(r);
      };
      try {
        cliente = connect(host);
        cliente.on('error', (e) => fim('erro', e.message));
        const req = cliente.request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${this.jwtApns()}`,
          'apns-topic': APP_ID,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        });
        req.setTimeout(15_000, () => { req.close(); fim('erro', 'tempo esgotado'); });
        let status = 0;
        let corpo = '';
        req.on('response', (h) => { status = Number(h[':status']); });
        req.on('data', (c) => { corpo += c; });
        req.on('end', () => {
          if (status === 200) return fim('ok');
          const motivo = (() => { try { return (JSON.parse(corpo) as { reason?: string }).reason ?? String(status); } catch { return String(status); } })();
          // "BadDeviceToken" também aparece quando o ambiente (produção/testes) está trocado na tela de
          // integrações: nesse caso não apaga, senão um ajuste errado limparia todos os iPhones.
          if (status === 410 || ['Unregistered', 'DeviceTokenNotForTopic'].includes(motivo)) return fim('invalido');
          if (status === 403) this.apns = null;
          fim('erro', motivo);
        });
        req.on('error', (e) => fim('erro', e.message));
        req.end(JSON.stringify({ aps: { alert: { title: n.titulo, body: n.texto }, sound: 'default' }, link: n.link ?? '/portal' }));
      } catch (e) {
        fim('erro', (e as Error).message);
      }
    });
  }
}
