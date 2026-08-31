import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger } from 'nestjs-pino';
import type { ConfigType } from '@nestjs/config';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { join } from 'path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appConfig } from './config/config';
import { setupSwaggerDocs } from './swagger';
import { ABS_BASE_PATH } from './modules/audiobookshelf/audiobookshelf.constants';
import {
  parseBooleanEnv,
  parseTrustProxy,
  buildHelmetOptions,
  buildEmptyJsonBodyStream,
  registerConditionalHsts,
  registerEmptyBodyContentTypeParser,
  shouldInjectEmptyJsonBody,
  shouldServeSpaFallback,
} from './common/utils/bootstrap.utils';

const MAX_COVER_BYTES = 20 * 1024 * 1024;

async function bootstrap() {
  const allowCloudflareInsights = parseBooleanEnv(process.env.CSP_ALLOW_CLOUDFLARE_INSIGHTS, false);

  const adapter = new FastifyAdapter({ logger: false, trustProxy: parseTrustProxy(process.env.TRUST_PROXY), maxParamLength: 1000 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const fastify = adapter.getInstance();
  // Nest adds originalUrl to the raw request, but these helpers only use standard Fastify APIs.
  const standardFastify = fastify as unknown as FastifyInstance;

  // Fastify's default JSON parser rejects empty bodies, so we inject '{}' before parsing.
  fastify.addHook('preParsing', (request, _reply, payload, done) => {
    if (shouldInjectEmptyJsonBody(request.method, request.headers)) {
      done(null, buildEmptyJsonBodyStream(request.headers));
      return;
    }
    done(null, payload);
  });

  // Reverse proxies can forward empty mutating requests with chunked transfer or an unsupported content type.
  registerEmptyBodyContentTypeParser(standardFastify);

  // Echo pino-http's request ID so clients can correlate errors with server logs.
  fastify.addHook('onSend', (_request, reply, _payload, done) => {
    const id = reply.request.id;
    if (id !== undefined && id !== null) {
      void reply.header('X-Request-Id', String(id));
    }
    done();
  });

  app.useWebSocketAdapter(new IoAdapter(app));

  app.setGlobalPrefix('api/v1', {
    exclude: [
      'api/kobo/:deviceToken/(.*)',
      'api/v3/(.*)',
      'api/UserStorage/(.*)',
      'abs/login',
      'abs/status',
      'abs/ping',
      'abs/api/(.*)',
      'abs/auth/openid',
      'abs/auth/openid/(.*)',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  const appConfiguration = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  if (appConfiguration.swaggerEnabled) {
    await setupSwaggerDocs(app, appConfiguration);
  }

  await app.register(fastifyHelmet as never, buildHelmetOptions({ allowCloudflareInsights }));
  registerConditionalHsts(standardFastify);

  await app.register(fastifyCompress as never, { encodings: ['gzip', 'br'] });

  await app.register(fastifyCookie as never);
  await app.register(fastifyMultipart as never, { limits: { fileSize: MAX_COVER_BYTES } });

  if (process.env.NODE_ENV !== 'production') {
    app.enableCors({
      origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
      credentials: true,
    });
  }

  // TEMP DIAGNOSTIC: strip Helmet/CORS headers on ABS-compat routes to test whether Prologue's
  // client is sensitive to them. Real Audiobookshelf servers don't send these on these routes.
  const ABS_DIAG_PREFIXES = ['/abs/login', '/abs/status', '/abs/ping', '/abs/api/'];
  fastify.addHook('onSend', (request, reply, payload, done) => {
    if (ABS_DIAG_PREFIXES.some((p) => request.url.startsWith(p))) {
      for (const h of [
        'content-security-policy',
        'cross-origin-resource-policy',
        'origin-agent-cluster',
        'referrer-policy',
        'x-content-type-options',
        'x-dns-prefetch-control',
        'x-download-options',
        'x-frame-options',
        'x-permitted-cross-domain-policies',
        'x-xss-protection',
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'x-request-id',
      ]) {
        reply.removeHeader(h);
      }
    }
    done(null, payload);
  });

  // NestJS calls setNotFoundHandler during init - intercept it so non-API 404s fall back to a
  // web page instead of returning a JSON 404 (SPA routing support for BookOrbit's own client).
  const adapterAny = adapter as any;
  adapterAny.setNotFoundHandler = (nestHandler: (req: unknown, res: unknown) => void) => {
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api')) {
        return nestHandler(request, reply);
      }
      if (!shouldServeSpaFallback(request.url)) {
        return reply.status(404).send({ statusCode: 404, message: 'Not Found', path: request.url });
      }
      if (request.url.startsWith(ABS_BASE_PATH)) {
        // A real Audiobookshelf server answers its own web app at its root, and ABS clients
        // (Prologue) probe the configured server address for these markers before starting the
        // OAuth flow - so an otherwise-unmatched path under /abs gets the same marker page,
        // in every environment, regardless of BookOrbit's own SPA fallback below.
        reply.type('text/html').header('Cache-Control', 'no-store');
        return reply.send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<meta name="og:title" property="og:title" content="Audiobookshelf"><meta name="og:site_name" property="og:site_name" content="Audiobookshelf">' +
            '<title>Audiobookshelf</title></head><body><div id="__nuxt"></div><script>window.__NUXT__={}</script></body></html>',
        );
      }
      if (process.env.NODE_ENV === 'production') {
        // @fastify/static augments FastifyReply with sendFile, but the augmentation is not
        // visible to this file's typecheck under TS 6 + nodenext in some environments. The cast
        // preserves the runtime behavior (sendFile is registered below via app.register(fastifyStatic)).
        return (reply as FastifyReply & { sendFile: (filename: string) => FastifyReply }).sendFile('index.html');
      }
      return reply.status(404).send({ statusCode: 404, message: 'Not Found', path: request.url });
    });
  };

  if (process.env.NODE_ENV === 'production') {
    await app.register(fastifyStatic as never, {
      root: join(__dirname, '..', 'public'),
      prefix: '/',
    });
  }

  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`BookOrbit startup failed:\n${message}\n`);
  process.exit(1);
});
