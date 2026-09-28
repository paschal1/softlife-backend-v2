import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Offline sync batches and delivery signatures exceed Express's 100 KB default.
  app.useBodyParser('json', { limit: '2mb' });
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('SoftLife API')
        .setDescription(
          'Business operating system for African SMEs.\n\n' +
            '**Auth:** sign up or log in, then click *Authorize* and paste the `accessToken`.\n\n' +
            '**Money:** every amount is an integer in **kobo** (₦1 = 100 kobo). ₦5,000 is `500000`.\n\n' +
            '**Retries:** endpoints that accept a client-generated id are safe to retry on a bad connection.',
        )
        .setVersion('0.2.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: 'api/docs-json',
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha', operationsSorter: 'method' },
    });
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`SoftLife API on http://localhost:${port}/api/v1`, 'Bootstrap');
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    Logger.log(`API docs on  http://localhost:${port}/api/docs`, 'Bootstrap');
  }
}

void bootstrap();
