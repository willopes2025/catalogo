import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { SegredosService } from '../segredos/segredos.service';
import { urlPublica } from '../comum/url';

/**
 * Google Agenda + Meet da Aritana, por OAuth: alguém da Aritana clica em "Conectar conta Google",
 * autoriza no Google e o sistema guarda (cifrado) o token que deixa criar eventos com link do Meet.
 * O sistema nunca vê a senha do Google.
 */
const OAUTH = () => process.env.GOOGLE_OAUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = () => process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const CALENDAR = () => process.env.GOOGLE_CALENDAR_URL ?? 'https://www.googleapis.com/calendar/v3';
const ESCOPOS = 'openid email https://www.googleapis.com/auth/calendar.events';
const FUSO = 'America/Sao_Paulo';

export interface EventoGoogle {
  titulo: string;
  descricao?: string | null;
  inicio: Date;
  fim: Date;
  local?: string | null;
  comMeet: boolean;
}

@Injectable()
export class GoogleService {
  private readonly log = new Logger('Google');
  private acesso: { token: string; ate: number } | null = null;
  /** Pedidos de conexão em andamento (state do OAuth → quem pediu), valem 15 minutos. */
  private readonly pedidos = new Map<string, { usuarioId: string; ate: number }>();

  constructor(private readonly segredos: SegredosService) {}

  get configurado() {
    return !!(this.segredos.v('GOOGLE_CLIENT_ID') && this.segredos.v('GOOGLE_CLIENT_SECRET'));
  }
  get conectado() {
    return this.configurado && !!this.segredos.v('GOOGLE_REFRESH_TOKEN');
  }
  get conta() {
    return this.segredos.v('GOOGLE_CONTA') ?? null;
  }
  get retorno() {
    return `${urlPublica()}/api/agenda/google/retorno`;
  }
  private get agenda() {
    return encodeURIComponent(this.segredos.v('GOOGLE_AGENDA_ID') || 'primary');
  }

  /** Endereço do Google para a pessoa autorizar. */
  urlConectar(usuarioId: string) {
    if (!this.configurado) throw new BadRequestException('Preencha o Client ID e o Client secret do Google em Configurações › Integrações.');
    const agora = Date.now();
    for (const [k, v] of this.pedidos) if (v.ate < agora) this.pedidos.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.pedidos.set(state, { usuarioId, ate: agora + 15 * 60_000 });
    const q = new URLSearchParams({ client_id: this.segredos.v('GOOGLE_CLIENT_ID')!, redirect_uri: this.retorno, response_type: 'code', scope: ESCOPOS, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `${OAUTH()}?${q}`;
  }

  /** Volta do Google: troca o código pelo token de longa duração e guarda cifrado. */
  async concluir(code: string, state: string) {
    const p = this.pedidos.get(state);
    this.pedidos.delete(state);
    if (!p || p.ate < Date.now()) throw new BadRequestException('O pedido de conexão expirou. Clique em "Conectar conta Google" de novo.');
    const r = await this.postToken({ code, grant_type: 'authorization_code', redirect_uri: this.retorno });
    if (!r.refresh_token) throw new BadRequestException('O Google não devolveu a autorização permanente. Remova o acesso do sistema em myaccount.google.com › Segurança e conecte de novo.');
    const email = r.id_token ? emailDoIdToken(r.id_token) : null;
    await this.segredos.salvar('GOOGLE_REFRESH_TOKEN', r.refresh_token, p.usuarioId);
    if (email) await this.segredos.salvar('GOOGLE_CONTA', email, p.usuarioId);
    this.acesso = r.access_token ? { token: r.access_token, ate: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000 } : null;
    return { usuarioId: p.usuarioId, conta: email };
  }

  async desconectar(usuarioId: string) {
    const rt = this.segredos.v('GOOGLE_REFRESH_TOKEN');
    if (rt) await fetch(`${TOKEN().replace(/\/token$/, '')}/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => undefined);
    await this.segredos.salvar('GOOGLE_REFRESH_TOKEN', null, usuarioId);
    await this.segredos.salvar('GOOGLE_CONTA', null, usuarioId);
    this.acesso = null;
  }

  private async postToken(campos: Record<string, string>) {
    const res = await fetch(TOKEN(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.segredos.v('GOOGLE_CLIENT_ID') ?? '', client_secret: this.segredos.v('GOOGLE_CLIENT_SECRET') ?? '', ...campos }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };
    if (!res.ok) throw new BadRequestException(`Google recusou: ${j.error_description ?? j.error ?? res.status}`);
    return j;
  }

  private async token() {
    if (this.acesso && this.acesso.ate > Date.now()) return this.acesso.token;
    const rt = this.segredos.v('GOOGLE_REFRESH_TOKEN');
    if (!rt) throw new BadRequestException('Conta Google não conectada.');
    try {
      const r = await this.postToken({ refresh_token: rt, grant_type: 'refresh_token' });
      this.acesso = { token: r.access_token!, ate: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000 };
      return this.acesso.token;
    } catch (e) {
      // invalid_grant: a autorização foi removida no Google ou a senha da conta mudou.
      if (/invalid_grant/i.test((e as Error).message)) throw new BadRequestException('A conexão com o Google caiu (autorização removida ou senha trocada). Conecte a conta Google de novo em Agenda.');
      throw e;
    }
  }

  private async chamar<T>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
    const res = await fetch(`${CALENDAR()}${rota}`, {
      method: metodo,
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 204 || res.status === 410) return {} as T; // apagado (410: já não existia)
    const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new BadRequestException(`Google Agenda: ${j.error?.message ?? res.status}`);
    return j;
  }

  private corpo(e: EventoGoogle) {
    return {
      summary: e.titulo,
      description: e.descricao ?? undefined,
      location: e.local ?? undefined,
      start: { dateTime: e.inicio.toISOString(), timeZone: FUSO },
      end: { dateTime: e.fim.toISOString(), timeZone: FUSO },
      ...(e.comMeet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
    };
  }

  /** Cria o evento (com Meet, se online). Devolve o id e o link da chamada. */
  async criar(e: EventoGoogle) {
    const r = await this.chamar<{ id: string; hangoutLink?: string; htmlLink?: string }>('POST', `/calendars/${this.agenda}/events?conferenceDataVersion=1&sendUpdates=none`, this.corpo(e));
    return { id: r.id, link: r.hangoutLink ?? null };
  }

  async atualizar(id: string, e: EventoGoogle, jaTemMeet: boolean) {
    const corpo = this.corpo({ ...e, comMeet: e.comMeet && !jaTemMeet });
    const r = await this.chamar<{ id: string; hangoutLink?: string }>('PATCH', `/calendars/${this.agenda}/events/${encodeURIComponent(id)}?conferenceDataVersion=1&sendUpdates=none`, corpo);
    return { id: r.id ?? id, link: r.hangoutLink ?? null };
  }

  async apagar(id: string) {
    await this.chamar('DELETE', `/calendars/${this.agenda}/events/${encodeURIComponent(id)}?sendUpdates=none`).catch((e) => this.log.warn(`Evento ${id}: ${(e as Error).message}`));
  }
}

/** E-mail da conta que autorizou (do id_token do Google; só leitura do campo, a assinatura já foi checada pelo próprio Google no fluxo). */
function emailDoIdToken(t: string) {
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')) as { email?: string };
    return p.email ?? null;
  } catch {
    return null;
  }
}
