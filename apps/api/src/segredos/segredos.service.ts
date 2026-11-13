import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { segredos } from '../db/schema';

/**
 * Credenciais das integrações.
 * Ordem de leitura: o que foi salvo pela tela; se a tela estiver vazia, o .env do servidor.
 * O valor fica cifrado no banco (AES-256-GCM) com a CHAVE_CRIPTOGRAFIA do .env; sem ela, a chave sai do JWT_SECRET.
 * Os valores ficam em memória (um processo só) e são relidos a cada gravação.
 */
@Injectable()
export class SegredosService implements OnModuleInit {
  private readonly log = new Logger('Segredos');
  private valores = new Map<string, string>();
  private ilegiveis = new Set<string>();
  /** Muda a cada gravação: quem monta conexão com base nos valores (e-mail) sabe quando refazer. */
  versao = 0;

  constructor(@Inject(DB) private readonly db: Db) {}

  private chave() {
    const base = process.env.CHAVE_CRIPTOGRAFIA || `${process.env.JWT_SECRET ?? ''}:segredos`;
    return createHash('sha256').update(base).digest();
  }

  private cifrar(texto: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.chave(), iv);
    const dados = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${dados.toString('base64')}`;
  }

  private decifrar(v: string) {
    const [ver, iv, tag, dados] = v.split(':');
    if (ver !== 'v1') throw new Error('formato desconhecido');
    const d = createDecipheriv('aes-256-gcm', this.chave(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
  }

  async onModuleInit() {
    await this.recarregar();
  }

  async recarregar() {
    const linhas = await this.db.select().from(segredos);
    const novo = new Map<string, string>();
    const ruins = new Set<string>();
    for (const l of linhas) {
      try {
        novo.set(l.chave, this.decifrar(l.valorCifrado));
      } catch {
        ruins.add(l.chave);
      }
    }
    if (ruins.size) this.log.error(`Não foi possível ler: ${[...ruins].join(', ')}. A CHAVE_CRIPTOGRAFIA mudou? Salve esses campos de novo pela tela.`);
    this.valores = novo;
    this.ilegiveis = ruins;
    this.versao++;
  }

  /** Valor salvo pela tela ou, na falta, o do .env. */
  v(nome: string): string | undefined {
    const daTela = this.valores.get(nome);
    if (daTela) return daTela;
    const doEnv = process.env[nome];
    return doEnv ? doEnv : undefined;
  }

  origem(nome: string): 'tela' | 'servidor' | null {
    if (this.valores.get(nome)) return 'tela';
    if (process.env[nome]) return 'servidor';
    return null;
  }

  ilegivel(nome: string) {
    return this.ilegiveis.has(nome);
  }

  async salvar(nome: string, valor: string | null, usuarioId: string) {
    if (!valor) await this.db.delete(segredos).where(eq(segredos.chave, nome));
    else {
      const linha = { valorCifrado: this.cifrar(valor), final: valor.length > 8 ? valor.slice(-4) : null, usuarioId, atualizadoEm: new Date() };
      await this.db.insert(segredos).values({ chave: nome, ...linha }).onConflictDoUpdate({ target: segredos.chave, set: linha });
    }
    await this.recarregar();
  }
}
