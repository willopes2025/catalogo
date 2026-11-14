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
import { VendasController } from './vendas/vendas.controller';
import { VendasService } from './vendas/vendas.service';
import { AsaasService } from './integracoes/asaas.service';
import { WebhooksController } from './integracoes/webhooks.controller';
import { FiscalController } from './fiscal/fiscal.controller';
import { FiscalService } from './fiscal/fiscal.service';
import { RelatoriosController } from './relatorios/relatorios.controller';
import { SuporteController } from './suporte/suporte.controller';
import { ImportacaoController } from './importacao/importacao.controller';
import { ImportacaoService } from './importacao/importacao.service';
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
import { GarantiaController, LotesController } from './garantia/garantia.controller';
import { GarantiaService } from './garantia/garantia.service';
import { ComissoesController } from './comissoes/comissoes.controller';
import { ComissoesService } from './comissoes/comissoes.service';
import { AvisosController } from './avisos/avisos.controller';
import { AvisosService } from './avisos/avisos.service';
import { AuditoriaController } from './auditoria/auditoria.controller';
import { SegredosService } from './segredos/segredos.service';
import { ImplantacaoController } from './implantacao/implantacao.controller';
import { PortalController } from './portal/portal.controller';
import { CrmController } from './crm/crm.controller';
import { PontosController } from './pontos/pontos.controller';
import { FormulariosController } from './formularios/formularios.controller';
import { MarketingController } from './marketing/marketing.controller';
import { PontosService } from './pontos/pontos.service';

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
    VendasController,
    WebhooksController,
    FiscalController,
    RelatoriosController,
    SuporteController,
    ImportacaoController,
    GarantiaController,
    LotesController,
    ComissoesController,
    AvisosController,
    AuditoriaController,
    ImplantacaoController,
    PortalController,
    CrmController,
    PontosController,
    FormulariosController,
    MarketingController,
  ],
  providers: [
    SegredosService,
    PontosService,
    AuditoriaService,
    EstoqueService,
    MaletasService,
    ConfiguracoesService,
    AssertivaService,
    EmailService,
    DocumentosService,
    VendasService,
    AsaasService,
    FiscalService,
    ImportacaoService,
    GarantiaService,
    ComissoesService,
    AvisosService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrosFilter },
  ],
})
export class AppModule {}
