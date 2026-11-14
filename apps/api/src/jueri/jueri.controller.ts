import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { ETAPAS, JueriService } from './jueri.service';

const opcoes = z.object({
  simular: z.boolean().default(true),
  etapas: z.array(z.enum(ETAPAS)).min(1, 'Escolha ao menos uma parte para importar'),
  localId: z.string().uuid('Escolha o local do estoque'),
  atualizarEstoque: z.boolean().default(true),
  comissaoRepresentantePb: z.number().int().min(0).max(10000).default(1000),
});

/** Migração pela API do Jueri (Configurações › Importar). */
@Controller('jueri')
export class JueriController {
  constructor(private readonly svc: JueriService) {}

  @Get()
  @Permissao('configuracoes', 'ver')
  situacao() {
    return { configurado: this.svc.configurado, execucao: this.svc.situacao() };
  }

  @Post('importar')
  @Permissao('configuracoes', 'editar')
  importar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const d = validar(opcoes, body);
    // A ordem das etapas importa (produtos antes das maletas etc.): segue sempre a ordem fixa.
    const etapas = ETAPAS.filter((e) => d.etapas.includes(e));
    return this.svc.iniciar({ ...d, etapas }, u.id);
  }
}
