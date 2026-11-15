import { Controller, Get, Inject } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DB, type Db } from '../comum/db.module';
import { Publico } from '../comum/auth';
import { empresas } from '../db/schema';
import { SegredosService } from '../segredos/segredos.service';

/** Dados da empresa para a página pública de privacidade (pedida pela Play Store e pela App Store). */
@Controller('publico/privacidade')
export class PrivacidadeController {
  constructor(@Inject(DB) private readonly db: Db, private readonly segredos: SegredosService) {}

  @Publico()
  @Get()
  async dados() {
    const [m] = await this.db.select().from(empresas).where(eq(empresas.tipo, 'matriz')).orderBy(asc(empresas.criadoEm)).limit(1);
    return {
      empresa: m?.razaoSocial || m?.nome || 'Aritana Semijoias',
      cnpj: m?.cnpj ?? null,
      cidade: m?.cidade ? `${m.cidade}${m.uf ? `/${m.uf}` : ''}` : null,
      email: this.segredos.v('EMAIL_SUPORTE') ?? null,
    };
  }
}
