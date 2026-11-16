import { BadRequestException, Controller, Get, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import { Usuario, type UsuarioLogado } from '../comum/auth';
import { Limitador } from '../comum/limitador';

export interface EnderecoCep { cep: string; logradouro: string | null; bairro: string | null; cidade: string | null; uf: string | null }
export interface DadosCnpj extends EnderecoCep {
  cnpj: string; razaoSocial: string | null; nomeFantasia: string | null; inscricaoEstadual: string | null;
  numero: string | null; complemento: string | null; telefone: string | null; email: string | null; situacao: string | null;
}

const so = (s: string) => s.replace(/\D/g, '');
const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** "RUA DAS FLORES" → "Rua das Flores" (a Receita devolve tudo em maiúsculas). */
const titulo = (v: unknown) => {
  const t = txt(v);
  if (!t || t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-/(])([\p{L}])/gu, (_, a: string, b: string) => a + b.toUpperCase()).replace(/\b(D[aeo]s?|E)\b/g, (m) => m.toLowerCase());
};

function cnpjValido(c: string) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base: string) => {
    let peso = base.length - 7;
    let soma = 0;
    for (const d of base) { soma += Number(d) * peso; peso = peso === 2 ? 9 : peso - 1; }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(c.slice(0, 12)) === Number(c[12]) && dv(c.slice(0, 13)) === Number(c[13]);
}

async function buscar(url: string): Promise<{ status: number; corpo: any }> {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6_000) });
  return { status: r.status, corpo: await r.json().catch(() => null) };
}

/**
 * Preenchimento automático dos cadastros: endereço pelo CEP e dados da empresa pelo CNPJ.
 * Passa pelo servidor para ter uma segunda fonte quando a primeira está fora do ar, e para guardar
 * o resultado (o mesmo CEP é digitado muitas vezes). São bases públicas e gratuitas, sem chave.
 */
@Controller('consultas')
export class ConsultasController {
  private readonly limite = new Limitador(120, 60 * 60_000, 'Muitas consultas seguidas.');
  private readonly guardado = new Map<string, { ate: number; dados: unknown }>();

  private lembrar<T>(chave: string, dados: T, horas: number): T {
    if (this.guardado.size > 5_000) this.guardado.clear();
    this.guardado.set(chave, { ate: Date.now() + horas * 3600_000, dados });
    return dados;
  }
  private lembrado<T>(chave: string): T | null {
    const g = this.guardado.get(chave);
    return g && g.ate > Date.now() ? (g.dados as T) : null;
  }

  @Get('cep/:cep')
  async cep(@Param('cep') bruto: string, @Usuario() u: UsuarioLogado): Promise<EnderecoCep> {
    const cep = so(bruto);
    if (cep.length !== 8) throw new BadRequestException({ mensagem: 'O CEP tem 8 números.' });
    const ja = this.lembrado<EnderecoCep>(`cep:${cep}`);
    if (ja) return ja;
    this.limite.usar(u.id);
    let fora = 0;
    // 1ª fonte: ViaCEP.
    try {
      const r = await buscar(`${process.env.VIACEP_URL ?? 'https://viacep.com.br'}/ws/${cep}/json/`);
      if (r.status === 200 && r.corpo && !r.corpo.erro) return this.lembrar(`cep:${cep}`, { cep, logradouro: txt(r.corpo.logradouro), bairro: txt(r.corpo.bairro), cidade: txt(r.corpo.localidade), uf: txt(r.corpo.uf) }, 24 * 30);
      if (r.status >= 500) fora++;
    } catch { fora++; }
    // 2ª fonte: BrasilAPI (também acha CEPs novos que a primeira ainda não tem).
    try {
      const r = await buscar(`${process.env.BRASILAPI_URL ?? 'https://brasilapi.com.br'}/api/cep/v1/${cep}`);
      if (r.status === 200 && r.corpo?.city) return this.lembrar(`cep:${cep}`, { cep, logradouro: txt(r.corpo.street), bairro: txt(r.corpo.neighborhood), cidade: txt(r.corpo.city), uf: txt(r.corpo.state) }, 24 * 30);
      if (r.status >= 500) fora++;
    } catch { fora++; }
    if (fora === 2) throw new ServiceUnavailableException({ mensagem: 'A consulta de CEP está fora do ar agora. Preencha o endereço à mão.' });
    throw new NotFoundException({ mensagem: 'CEP não encontrado. Confira os números ou preencha o endereço à mão.' });
  }

  @Get('cnpj/:cnpj')
  async cnpj(@Param('cnpj') bruto: string, @Usuario() u: UsuarioLogado): Promise<DadosCnpj> {
    const cnpj = so(bruto);
    if (!cnpjValido(cnpj)) throw new BadRequestException({ mensagem: 'CNPJ inválido. Confira os números.' });
    const ja = this.lembrado<DadosCnpj>(`cnpj:${cnpj}`);
    if (ja) return ja;
    this.limite.usar(u.id);
    let fora = 0;
    // 1ª fonte: BrasilAPI (dados da Receita Federal).
    try {
      const r = await buscar(`${process.env.BRASILAPI_URL ?? 'https://brasilapi.com.br'}/api/cnpj/v1/${cnpj}`);
      const c = r.corpo;
      if (r.status === 200 && c?.razao_social) {
        const tel = so(String(c.ddd_telefone_1 ?? ''));
        return this.lembrar(`cnpj:${cnpj}`, {
          cnpj, razaoSocial: titulo(c.razao_social), nomeFantasia: titulo(c.nome_fantasia), inscricaoEstadual: null,
          cep: so(String(c.cep ?? '')) || '', logradouro: titulo([c.descricao_tipo_de_logradouro, c.logradouro].filter(Boolean).join(' ')), numero: txt(String(c.numero ?? '')), complemento: titulo(c.complemento),
          bairro: titulo(c.bairro), cidade: titulo(c.municipio), uf: txt(c.uf), telefone: tel.length >= 10 ? tel : null, email: txt(c.email)?.toLowerCase() ?? null, situacao: titulo(c.descricao_situacao_cadastral),
        }, 24);
      }
      if (r.status >= 500 || r.status === 429) fora++;
    } catch { fora++; }
    // 2ª fonte: CNPJ.ws (traz também a inscrição estadual).
    try {
      const r = await buscar(`${process.env.CNPJWS_URL ?? 'https://publica.cnpj.ws'}/cnpj/${cnpj}`);
      const c = r.corpo;
      const e = c?.estabelecimento;
      if (r.status === 200 && c?.razao_social && e) {
        const tel = so(`${e.ddd1 ?? ''}${e.telefone1 ?? ''}`);
        const ie = Array.isArray(e.inscricoes_estaduais) ? e.inscricoes_estaduais.find((i: any) => i?.ativo)?.inscricao_estadual : null;
        return this.lembrar(`cnpj:${cnpj}`, {
          cnpj, razaoSocial: titulo(c.razao_social), nomeFantasia: titulo(e.nome_fantasia), inscricaoEstadual: txt(ie),
          cep: so(String(e.cep ?? '')) || '', logradouro: titulo([e.tipo_logradouro, e.logradouro].filter(Boolean).join(' ')), numero: txt(String(e.numero ?? '')), complemento: titulo(e.complemento),
          bairro: titulo(e.bairro), cidade: titulo(e.cidade?.nome), uf: txt(e.estado?.sigla), telefone: tel.length >= 10 ? tel : null, email: txt(e.email)?.toLowerCase() ?? null, situacao: titulo(e.situacao_cadastral),
        }, 24);
      }
      if (r.status >= 500 || r.status === 429) fora++;
    } catch { fora++; }
    if (fora === 2) throw new ServiceUnavailableException({ mensagem: 'A consulta de CNPJ está fora do ar agora. Preencha os dados à mão.' });
    throw new NotFoundException({ mensagem: 'CNPJ não encontrado na Receita. Confira os números ou preencha à mão.' });
  }
}
