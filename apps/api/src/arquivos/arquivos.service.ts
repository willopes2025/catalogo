import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';

export const TIPOS_FOTO: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export const NOME_FOTO = /^[a-f0-9]{40}\.(jpg|png|webp|gif)$/;
/** Mídias das conversas do CRM: o que o WhatsApp aceita. */
export const TIPOS_MIDIA: Record<string, string> = {
  ...TIPOS_FOTO,
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls', 'text/plain': 'txt',
  'text/csv': 'csv', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a',
};
export const NOME_MIDIA = /^[a-f0-9]{40}\.[a-z0-9]{2,5}$/;

/**
 * Fotos guardadas no disco do servidor (na VPS: /opt/aritana-arquivos, com cópia diária).
 * O nome do arquivo é o hash da origem: baixar de novo a mesma foto não duplica.
 */
@Injectable()
export class ArquivosService {
  readonly dir = resolve(process.env.ARQUIVOS_DIR ?? 'dados');
  private get dirFotos() {
    return join(this.dir, 'fotos');
  }

  nomeDe(origem: string, ext: string) {
    return `${createHash('sha1').update(origem).digest('hex')}.${ext}`;
  }

  /** Já baixada antes? Devolve o endereço público. */
  existente(origem: string): string | null {
    for (const ext of Object.values(TIPOS_FOTO)) {
      const nome = this.nomeDe(origem, ext);
      if (existsSync(join(this.dirFotos, nome))) return `/api/fotos/${nome}`;
    }
    return null;
  }

  async salvarFoto(origem: string, conteudo: Buffer, tipo: string) {
    const ext = TIPOS_FOTO[tipo];
    if (!ext) throw new Error(`formato ${tipo || 'desconhecido'} não é imagem aceita`);
    await mkdir(this.dirFotos, { recursive: true });
    const nome = this.nomeDe(origem, ext);
    // Nome temporário único: dois produtos com a mesma foto podem baixá-la ao mesmo tempo.
    const tmp = join(this.dirFotos, `.${nome}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, conteudo);
    await rename(tmp, join(this.dirFotos, nome));
    return `/api/fotos/${nome}`;
  }

  /** Mídia de conversa (pessoal: só sai pelo sistema, com login). */
  async salvarMidia(conteudo: Buffer, mime: string) {
    const tipo = mime.split(';')[0].trim().toLowerCase();
    const ext = TIPOS_MIDIA[tipo] ?? 'bin';
    const dir = join(this.dir, 'midia');
    await mkdir(dir, { recursive: true });
    const nome = `${createHash('sha1').update(conteudo).digest('hex')}.${ext}`;
    const tmp = join(dir, `.${nome}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, conteudo);
    await rename(tmp, join(dir, nome));
    return nome;
  }

  /** Documentos de RH (contratos, exames, fotos do ponto): pasta separada, só saem pelo sistema com permissão. */
  async salvarPrivado(conteudo: Buffer, mime: string, pasta: 'rh') {
    const ext = TIPOS_MIDIA[mime.split(';')[0].trim().toLowerCase()] ?? 'bin';
    const dir = join(this.dir, pasta);
    await mkdir(dir, { recursive: true });
    const nome = `${createHash('sha1').update(conteudo).update(randomBytes(8)).digest('hex')}.${ext}`;
    const tmp = join(dir, `.${nome}.tmp`);
    await writeFile(tmp, conteudo);
    await rename(tmp, join(dir, nome));
    return nome;
  }

  caminhoPrivado(nome: string, pasta: 'rh') {
    return NOME_MIDIA.test(nome) ? join(this.dir, pasta, nome) : null;
  }

  caminhoMidia(nome: string) {
    return NOME_MIDIA.test(nome) ? join(this.dir, 'midia', nome) : null;
  }

  caminhoFoto(nome: string) {
    return NOME_FOTO.test(nome) ? join(this.dirFotos, nome) : null;
  }
}
