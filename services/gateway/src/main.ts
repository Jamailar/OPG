import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { json, text, urlencoded } from 'express';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './app.module';
import configuration from './config/configuration';
import { PRISMA_CLIENT } from './config/database.module';
import { createAppSlugAliasMiddleware } from './common/middleware/app-slug-alias.middleware';
import { RuntimeSettingsService } from './modules/runtime-settings/runtime-settings.service';

function resolvePackageVersion(): string {
  const candidatePaths = [resolve(process.cwd(), 'package.json'), resolve(__dirname, '..', 'package.json')];

  for (const packageJsonPath of candidatePaths) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch {
      continue;
    }
  }

  return 'unknown';
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const appVersion = resolvePackageVersion();
  app.enableShutdownHooks();
  const appConfig = app.get<ConfigType<typeof configuration>>(configuration.KEY);
  const runtimeSettings = app.get(RuntimeSettingsService, { strict: false });
  const dbCorsOrigins = await runtimeSettings.getConfiguredCorsOrigins().catch((error: any) => {
    console.warn(`[RuntimeSettings] failed to load DB CORS settings, using env fallback: ${error?.message || error}`);
    return [];
  });
  const configuredOrigins = (dbCorsOrigins.length > 0 ? dbCorsOrigins : appConfig.cors.origins)
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowAllOrigins = configuredOrigins.includes('*');
  const allowedOriginSet = new Set(configuredOrigins.filter((origin) => origin !== '*'));
  const trustedOriginPattern =
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|.*\.local|.*\.sslip\.io)(:\d+)?$/i;

  // Register CORS before body parsers and business middleware so OPTIONS
  // preflight requests never fall through to route matching.
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalized = origin.trim();
      if (allowAllOrigins || allowedOriginSet.has(normalized) || trustedOriginPattern.test(normalized)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Admin-Key', 'X-Feedback-Admin-Key'],
    credentials: true,
    optionsSuccessStatus: 204,
  });

  const jsonBodyLimit = process.env.HTTP_JSON_LIMIT || '20mb';
  const mediaJsonBodyLimit = process.env.HTTP_MEDIA_JSON_LIMIT || process.env.HTTP_JSON_LIMIT || '45mb';
  const captureRawBody = (req: any, _res: any, buf: Buffer) => {
    if (buf?.length) {
      req.rawBody = Buffer.from(buf);
    }
  };
  const mediaJsonParser = json({ limit: mediaJsonBodyLimit, verify: captureRawBody });
  app.use((req: any, res: any, next: any) => {
    const requestPath = String(req.path || req.url || '').split('?')[0];
    if (req.method === 'POST' && requestPath.includes('/videos/generations')) {
      return mediaJsonParser(req, res, next);
    }
    return next();
  });
  app.use(json({ limit: jsonBodyLimit, verify: captureRawBody }));
  app.use(urlencoded({ extended: true, limit: jsonBodyLimit, verify: captureRawBody }));
  app.use(text({ type: ['application/xml', 'text/xml'], limit: jsonBodyLimit }));
  app.use(createAppSlugAliasMiddleware(app.get<PrismaClient>(PRISMA_CLIENT)));

  app.getHttpAdapter().get('/', (_request, response) => {
    response.type('text/plain').send(appVersion);
  });
  const healthHandler = (_request: any, response: any) => {
    response.type('text/plain').send('OK');
  };
  app.getHttpAdapter().get('/health', healthHandler);
  app.getHttpAdapter().get('/healthz', healthHandler);
  app.getHttpAdapter().get('/api/v1/health', healthHandler);

  // Enable validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Setup Swagger
  const config = new DocumentBuilder()
    .setTitle('OPG Gateway API')
    .setDescription('Gateway API for OPG System')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Listen on port 3000
  const port = appConfig.port || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger docs available at: http://localhost:${port}/api/docs`);
  const configSources = await runtimeSettings.getConfigSourceSummary().catch(() => null);
  if (configSources) {
    console.log(`Config sources: ${JSON.stringify(configSources)}`);
  }
}

bootstrap();
