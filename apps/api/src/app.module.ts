import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DbModule } from './comum/db.module';
import { AuthGuard } from './comum/auth';
import { ErrosFilter } from './comum/erros.filter';
import { AuditoriaService } from './comum/auditoria.service';
import { AuthController } from './auth/auth.controller';
import { PessoasController } from './pessoas/pessoas.controller';
import { GruposController, NiveisController, UsuariosController } from './usuarios/usuarios.controller';
import { AssertivaService } from './integracoes/assertiva.service';
import { EmailService } from './integracoes/email.service';
import { IntegracoesController } from './integracoes/integracoes.controller';
import { DocumentoPublicoController, DocumentosController } from './documentos/documentos.controller';
import { DocumentosService } from './documentos/documentos.service';
import { CatalogoController } from './catalogo/catalogo.controller';
import { EmpresasController } from './empresas/empresas.controller';
import { ProdutosController } from './produtos/produtos.controller';
import { EstoqueController } from './estoque/estoque.controller';
import { EstoqueService } from './estoque/estoque.service';
import { MaletaPublicaController, MaletasController } from './maletas/maletas.controller';
import { MaletasService } from './maletas/maletas.service';
import { ConfiguracoesController } from './configuracoes/configuracoes.controller';
import { ConfiguracoesService } from './configuracoes/configuracoes.service';
import { FinanceiroController } from './financeiro/financeiro.controller';
import { PainelController } from './painel/painel.controller';
import { SaudeController } from './saude.controller';

const segredo = process.env.JWT_SECRET;
if (!segredo || (process.env.NODE_ENV === 'production' && segredo.length < 32)) {
  throw new Error('Defina JWT_SECRET no .env (mínimo de 32 caracteres em produção).');
}

@Module({
  imports: [DbModule, JwtModule.register({ secret: segredo, signOptions: { expiresIn: '12h' } })],
  controllers: [
    SaudeController,
    AuthController,
    PessoasController,
    NiveisController,
    ProdutosController,
    EstoqueController,
    MaletasController,
    MaletaPublicaController,
    ConfiguracoesController,
    FinanceiroController,
    PainelController,
    UsuariosController,
    GruposController,
    IntegracoesController,
    DocumentosController,
    DocumentoPublicoController,
    CatalogoController,
    EmpresasController,
  ],
  providers: [
    AuditoriaService,
    EstoqueService,
    MaletasService,
    ConfiguracoesService,
    AssertivaService,
    EmailService,
    DocumentosService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrosFilter },
  ],
})
export class AppModule {}
