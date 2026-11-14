import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { existsSync } from 'node:fs';
import type { Response } from 'express';
import { Publico } from '../comum/auth';
import { ArquivosService } from './arquivos.service';

/** Fotos dos produtos: públicas (aparecem no catálogo) e imutáveis (o nome muda se a foto mudar). */
@Controller('fotos')
export class ArquivosController {
  constructor(private readonly arquivos: ArquivosService) {}

  @Get(':nome')
  @Publico()
  foto(@Param('nome') nome: string, @Res() res: Response) {
    const caminho = this.arquivos.caminhoFoto(nome);
    if (!caminho || !existsSync(caminho)) throw new NotFoundException('Foto não encontrada.');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(caminho);
  }
}
