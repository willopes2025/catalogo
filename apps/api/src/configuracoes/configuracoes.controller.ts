import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { CONFIGS, type ChaveConfig } from './outras-configuracoes';
import { z } from 'zod';
import { Permissao, Usuario, type UsuarioLogado } from '../comum/auth';
import { validar } from '../comum/validacao';
import { AuditoriaService } from '../comum/auditoria.service';
import { ConfiguracoesService } from './configuracoes.service';

const pb = z.number().int().min(0).max(10000);
const regrasSchema = z.object({
  prazoAcertoDias: z.number().int().min(1).max(120),
  comissaoAvistaPb: pb,
  comissaoPrazoPb: pb,
  multaAtrasoPb: pb,
  jurosMesPb: pb,
  carenciaDias: z.number().int().min(0).max(60),
  diasParaBloquear: z.number().int().min(0).max(120),
  perdidaPeloCusto: z.boolean(),
  limiteInicial: z.number().int().min(0),
  limiteMaximo: z.number().int().min(0),
  aumentoLimitePb: pb,
  metaMinimaVendidaPb: pb,
  maletasSimultaneas: z.number().int().min(1).max(10),
  parcelasMaximas: z.number().int().min(1).max(12),
});

@Controller('configuracoes')
export class ConfiguracoesController {
  constructor(private readonly config: ConfiguracoesService, private readonly auditoria: AuditoriaService) {}

  @Get('regras-consignado')
  regras() {
    return this.config.regras();
  }

  @Put('regras-consignado')
  @Permissao('configuracoes', 'editar')
  async salvar(@Usuario() u: UsuarioLogado, @Body() body: unknown) {
    const antes = await this.config.regras();
    const d = validar(regrasSchema, body);
    const r = await this.config.salvarRegras(d);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: 'regras_consignado', dados: { antes, depois: d } });
    return r;
  }

  @Get('chave/:chave')
  lerChave(@Param('chave') chave: string) {
    if (!(chave in CONFIGS)) throw new BadRequestException('Configuração desconhecida.');
    return this.config.ler(chave as ChaveConfig);
  }

  @Put('chave/:chave')
  @Permissao('configuracoes', 'editar')
  async salvarChave(@Usuario() u: UsuarioLogado, @Param('chave') chave: string, @Body() body: unknown) {
    if (!(chave in CONFIGS)) throw new BadRequestException('Configuração desconhecida.');
    const k = chave as ChaveConfig;
    const d = validar(CONFIGS[k].schema, body);
    await this.config.salvar(k, d as never);
    await this.auditoria.registrar({ usuarioId: u.id, acao: 'editar', entidade: `config:${k}`, dados: d });
    return d;
  }
}
