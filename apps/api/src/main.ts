import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'], rawBody: true });
  // rawBody: a Meta assina o webhook do WhatsApp sobre o corpo exato recebido.
  // Planilhas de importação podem ser grandes.
  app.useBodyParser('json', { limit: '25mb' });
  app.set('trust proxy', ['loopback', 'uniquelocal']);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  app.enableShutdownHooks();
  const porta = Number(process.env.PORT ?? 3000);
  await app.listen(porta);
  console.log(`API da Plataforma Aritana em http://localhost:${porta}/api`);
}
bootstrap();
