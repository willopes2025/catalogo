import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';

export const TIPOS_FOTO: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export const NOME_FOTO = /^[a-f0-9]{40}\.(jpg|png|webp|gif)$/;

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

  caminhoFoto(nome: string) {
    return NOME_FOTO.test(nome) ? join(this.dirFotos, nome) : null;
  }
}
