import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SegredosService } from '../segredos/segredos.service';

/**
 * Consulta de CPF na Assertiva (já usada hoje pela Aritana no Jueri).
 *
 * Os endereços abaixo seguem o padrão da API da Assertiva (OAuth2 client_credentials + consulta Localize),
 * mas a documentação exata é entregue a cada cliente junto com as credenciais.
 * Por isso tudo é configurável pelo .env e deve ser conferido quando a Aritana enviar o acesso:
 *   ASSERTIVA_CLIENT_ID, ASSERTIVA_CLIENT_SECRET
 *   ASSERTIVA_URL          (padrão https://api.assertivasolucoes.com.br)
 *   ASSERTIVA_TOKEN_PATH   (padrão /oauth2/v3/token)
 *   ASSERTIVA_CPF_PATH     (padrão /localize/v3/cpf?cpf={cpf}&idFinalidade={finalidade})
 *   ASSERTIVA_FINALIDADE   (padrão 1; finalidade de uso exigida pela LGPD)
 */
export interface DadosCpf {
  nome: string | null;
  nascimento: string | null;
  genero: string | null;
  nomeMae: string | null;
  situacaoCpf: string | null;
  telefones: string[];
  emails: string[];
  endereco: { cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null } | null;
}

@Injectable()
export class AssertivaService {
  private readonly log = new Logger('Assertiva');
  private token: { valor: string; expira: number; versao: number } | null = null;
  constructor(private readonly segredos: SegredosService) {}

  get configurada() {
    return !!(this.segredos.v('ASSERTIVA_CLIENT_ID') && this.segredos.v('ASSERTIVA_CLIENT_SECRET'));
  }

  async testar() {
    if (!this.configurada) throw new ServiceUnavailableException('Preencha o Client ID e o Client secret.');
    this.token = null;
    await this.obterToken();
    return { ok: true, mensagem: 'Credenciais aceitas pela Assertiva.' };
  }

  private get url() {
    return (process.env.ASSERTIVA_URL ?? 'https://api.assertivasolucoes.com.br').replace(/\/$/, '');
  }

  private async obterToken(): Promise<string> {
    if (this.token && this.token.versao === this.segredos.versao && this.token.expira > Date.now() + 30_000) return this.token.valor;
    const basic = Buffer.from(`${this.segredos.v('ASSERTIVA_CLIENT_ID')}:${this.segredos.v('ASSERTIVA_CLIENT_SECRET')}`).toString('base64');
    const r = await fetch(this.url + (process.env.ASSERTIVA_TOKEN_PATH ?? '/oauth2/v3/token'), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      this.log.error(`Token recusado: ${r.status}`);
      throw new ServiceUnavailableException('A Assertiva recusou as credenciais. Confira a chave em Configurações › Integrações.');
    }
    const j = (await r.json()) as { access_token: string; expires_in?: number };
    this.token = { valor: j.access_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000, versao: this.segredos.versao };
    return j.access_token;
  }

  async consultarCpf(cpf: string): Promise<DadosCpf> {
    if (!this.configurada) throw new ServiceUnavailableException('A consulta pela Assertiva ainda não foi ligada: faltam as credenciais da Aritana.');
    const caminho = (process.env.ASSERTIVA_CPF_PATH ?? '/localize/v3/cpf?cpf={cpf}&idFinalidade={finalidade}')
      .replace('{cpf}', cpf)
      .replace('{finalidade}', process.env.ASSERTIVA_FINALIDADE ?? '1');
    const r = await fetch(this.url + caminho, { headers: { authorization: `Bearer ${await this.obterToken()}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404) throw new HttpException({ mensagem: 'CPF não encontrado na Assertiva.' }, 404);
    if (!r.ok) {
      this.log.error(`Consulta falhou: ${r.status}`);
      throw new ServiceUnavailableException('A Assertiva não respondeu. Preencha à mão ou tente de novo em instantes.');
    }
    return normalizarResposta(await r.json());
  }
}

/** Lê a resposta procurando os campos pelos nomes usuais, sem depender de uma estrutura exata. */
export function normalizarResposta(j: unknown): DadosCpf {
  const raiz = (j as { resposta?: unknown })?.resposta ?? j;
  const cad = (pick(raiz, 'dadosCadastrais') ?? raiz) as Record<string, unknown>;
  const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const lista = (v: unknown) => (Array.isArray(v) ? v : []);
  const telefones = [...lista(pick(raiz, 'telefones', 'moveis')), ...lista(pick(raiz, 'telefones', 'fixos')), ...lista(pick(raiz, 'telefones'))]
    .map((t) => (typeof t === 'string' ? t : texto((t as Record<string, unknown>)?.numero) ?? ''))
    .map((t) => t.replace(/\D/g, ''))
    .filter((t) => t.length >= 10);
  const emails = lista(pick(raiz, 'emails'))
    .map((e) => (typeof e === 'string' ? e : texto((e as Record<string, unknown>)?.email) ?? ''))
    .filter((e) => e.includes('@'));
  const end = (lista(pick(raiz, 'enderecos'))[0] ?? null) as Record<string, unknown> | null;
  const nasc = texto(cad.dataNascimento ?? cad.nascimento);
  return {
    nome: texto(cad.nome),
    nascimento: nasc ? paraISO(nasc) : null,
    genero: texto(cad.sexo ?? cad.genero),
    nomeMae: texto(cad.maeNome ?? cad.nomeMae),
    situacaoCpf: texto(cad.situacaoCadastral ?? cad.situacao),
    telefones: [...new Set(telefones)],
    emails: [...new Set(emails)],
    endereco: end
      ? {
          cep: texto(end.cep)?.replace(/\D/g, '') ?? null,
          logradouro: [texto(end.tipoLogradouro), texto(end.logradouro)].filter(Boolean).join(' ') || null,
          numero: texto(String(end.numero ?? '')),
          complemento: texto(end.complemento),
          bairro: texto(end.bairro),
          cidade: texto(end.cidade),
          uf: texto(end.uf),
        }
      : null,
  };
}

function pick(o: unknown, ...caminho: string[]): unknown {
  return caminho.reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
}
function paraISO(d: string) {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d.slice(0, 10);
}
