import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  app.enableShutdownHooks();
  const porta = Number(process.env.PORT ?? 3000);
  await app.listen(porta);
  console.log(`API da Plataforma Aritana em http://localhost:${porta}/api`);
}
bootstrap();
