import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { environment } from './environment.js';

async function bootstrap(): Promise<void> {
  const env = environment();
  process.env.TZ = env.APP_TIMEZONE;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  // Lotes de webhook da Meta podem passar de 100 KB; o serviço aplica o limite de 1 MB.
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: true, credentials: true });
  app.use(
    (
      request: {
        method: string;
        path: string;
        headers: Record<string, string | string[] | undefined>;
      },
      response: {
        status: (code: number) => { json: (body: unknown) => void };
        setHeader: (name: string, value: string) => void;
      },
      next: () => void,
    ) => {
      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
      const exempt = request.path === '/api/auth/login' || request.path === '/api/webhooks/meta';
      if (!mutating || exempt) return next();
      const cookies = String(request.headers.cookie ?? '');
      const csrfCookie = cookies
        .split(';')
        .map((part) => part.trim().split('='))
        .find(([key]) => key === 'confirma_csrf_token')?.[1];
      const csrfHeader = request.headers['x-csrf-token'];
      if (!csrfCookie || csrfHeader !== csrfCookie) {
        response.status(403).json({ message: 'Token CSRF inválido' });
        return;
      }
      next();
    },
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  // O web encaminha /api por proxy com conexões keep-alive (e o inbox mantém SSE);
  // manter o socket ocioso por mais tempo que o proxy evita ECONNRESET intermitente.
  const server = app.getHttpServer() as { keepAliveTimeout: number; headersTimeout: number };
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await app.listen(env.API_PORT, '0.0.0.0');
}

void bootstrap();
