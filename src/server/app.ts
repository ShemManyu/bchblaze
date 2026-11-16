import { randomBytes } from 'node:crypto';
import express, { type Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../shared/errors.js';
import { Coordinator } from './coordinator.js';
import { digest } from './store.js';

const networkSchema = z.enum(['chipnet', 'mainnet']);
const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
const outpointSchema = z
  .object({
    txid: hex32,
    vout: z.number().int().min(0).max(0xfffffffe),
  })
  .strict();
const addressSchema = z.string().trim().min(42).max(120);
const pathsSchema = z
  .array(
    z
      .object({
        address: addressSchema,
        path: z.enum(['receive', 'change', 'defi']),
        index: z.number().int().min(0).max(10_000),
      })
      .strict(),
  )
  .min(1)
  .max(40);
const wantedSchema = z
  .object({
    category: hex32,
    commitment: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{2}){0,40}$/)
      .transform((value) => value.toLowerCase()),
    outpoint: outpointSchema.optional(),
  })
  .strict();
const createOfferSchema = z
  .object({
    network: networkSchema,
    receiveAddress: addressSchema,
    addressPaths: pathsSchema,
    offered: outpointSchema,
    wanted: wantedSchema,
    label: z.string().trim().min(1).max(40),
  })
  .strict();
const idSchema = z.uuid();
const acknowledged = (request: Request) =>
  request.get('x-swapcircle-mainnet') === 'approved';

export interface AppOptions {
  publicOrigin?: string;
  development?: boolean;
  relayUrls?: string[];
  prizeAddress?: string;
  localDemo?: boolean;
}

export function createApplication(
  coordinator: Coordinator,
  options: AppOptions = {},
) {
  const app = express();
  app.disable('x-powered-by');
  const origin = options.publicOrigin
    ? new URL(options.publicOrigin).origin
    : undefined;
  const windows = new Map<string, { start: number; count: number }>();

  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    if (!options.development) {
      const relayOrigins = [
        'wss://relay.riften.net',
        'wss://relay.cauldron.quest',
        ...(options.relayUrls ?? []).map((url) => new URL(url).origin),
      ].join(' ');
      response.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${relayOrigins}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
      );
    }
    next();
  });
  app.get('/api/health', (_request, response) => {
    response.json({ name: 'SwapCircle', version: '0.1.0', status: 'ok' });
  });
  app.get('/api/config', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      relayUrls: options.relayUrls ?? [],
      prizeAddress: options.prizeAddress ?? '',
      mode: options.localDemo ? 'local-demo' : 'live',
    });
  });

  app.use('/api', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      const expectedOrigin =
        origin ?? `${request.protocol}://${request.get('host')}`;
      if (
        (request.get('origin') && request.get('origin') !== expectedOrigin) ||
        request.get('sec-fetch-site') === 'cross-site' ||
        !request.is('application/json')
      ) {
        return next(
          new DomainError(
            'FORBIDDEN_ORIGIN',
            'Use the application on its own origin.',
            403,
          ),
        );
      }
    }
    const now = coordinator.store.now();
    for (const [key, window] of windows)
      if (now - window.start >= 60_000) windows.delete(key);
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const window = windows.get(key) ?? { start: now, count: 0 };
    window.count += 1;
    windows.set(key, window);
    if (window.count > 240 || windows.size > 10_000) {
      response.setHeader('Retry-After', '60');
      return next(
        new DomainError(
          'RATE_LIMITED',
          'Too many requests. Wait a minute before trying again.',
          429,
        ),
      );
    }
    const cookie = request.headers.cookie
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('sc_session='))
      ?.slice(11);
    let sessionId =
      cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie) ? digest(cookie) : undefined;
    if (!sessionId || !coordinator.store.hasSession(sessionId)) {
      const token = randomBytes(32).toString('base64url');
      sessionId = digest(token);
      coordinator.store.ensureSession(sessionId);
      response.cookie('sc_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: request.secure || Boolean(origin?.startsWith('https://')),
        maxAge: 7 * 86_400_000,
        path: '/',
      });
    }
    response.locals.sessionId = sessionId;
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/api/market', (request, response) => {
    response.json(
      coordinator.market(
        networkSchema.parse(request.query.network ?? 'chipnet'),
        response.locals.sessionId as string,
      ),
    );
  });
  app.get('/api/network/:network', async (request, response) => {
    response.json(
      await coordinator.chain.health(
        networkSchema.parse(request.params.network),
      ),
    );
  });
  app.post('/api/wallet/inventory', async (request, response) => {
    const body = z
      .object({ network: networkSchema, addressPaths: pathsSchema })
      .strict()
      .parse(request.body);
    response.json(await coordinator.inventory(body.network, body.addressPaths));
  });
  app.post('/api/offers', async (request, response) => {
    response
      .status(201)
      .json(
        await coordinator.createOffer(
          response.locals.sessionId as string,
          createOfferSchema.parse(request.body),
          acknowledged(request),
        ),
      );
  });
  app.delete('/api/offers/:id', (request, response) => {
    coordinator.store.cancelOffer(
      idSchema.parse(request.params.id),
      response.locals.sessionId as string,
    );
    response.status(204).end();
  });
  app.post('/api/circles', async (request, response) => {
    const body = z
      .object({ offerIds: z.tuple([idSchema, idSchema, idSchema]) })
      .strict()
      .parse(request.body);
    response
      .status(201)
      .json(
        await coordinator.prepare(
          body.offerIds,
          response.locals.sessionId as string,
          acknowledged(request),
        ),
      );
  });
  app.get('/api/circles/:id', (request, response) => {
    response.json(
      coordinator.circle(
        idSchema.parse(request.params.id),
        response.locals.sessionId as string,
      ),
    );
  });
  app.post('/api/circles/:id/approve', async (request, response) => {
    const body = z
      .object({
        offerId: idSchema,
        fingerprint: hex32,
        signedTransaction: z
          .string()
          .min(2)
          .max(20_000)
          .regex(/^(?:[0-9a-fA-F]{2})+$/)
          .transform((value) => value.toLowerCase()),
      })
      .strict()
      .parse(request.body);
    response.json(
      await coordinator.approve(
        idSchema.parse(request.params.id),
        response.locals.sessionId as string,
        body.offerId,
        body.fingerprint,
        body.signedTransaction,
        acknowledged(request),
      ),
    );
  });
  app.post('/api/circles/:id/cancel', (request, response) => {
    response.json(
      coordinator.cancelCircle(
        idSchema.parse(request.params.id),
        response.locals.sessionId as string,
      ),
    );
  });
  app.get('/api/circles/:id/transaction', (request, response) => {
    response.json(
      coordinator.signedTransaction(
        idSchema.parse(request.params.id),
        response.locals.sessionId as string,
      ),
    );
  });
  app.post('/api/circles/:id/settle', async (request, response) => {
    response.json(
      await coordinator.settle(
        idSchema.parse(request.params.id),
        response.locals.sessionId as string,
        acknowledged(request),
      ),
    );
  });
  app.post('/api/circles/:id/refresh', async (request, response) => {
    response.json(
      await coordinator.refresh(
        idSchema.parse(request.params.id),
        response.locals.sessionId as string,
      ),
    );
  });
  app.use('/api', (_request, _response, next) =>
    next(new DomainError('NOT_FOUND', 'That API endpoint was not found.', 404)),
  );
  app.use(
    (
      error: unknown,
      _request: Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof DomainError) {
        response
          .status(error.status)
          .json({ error: { code: error.code, message: error.message } });
      } else if (error instanceof z.ZodError) {
        response.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Check the request fields and try again.',
          },
        });
      } else if (
        typeof error === 'object' &&
        error &&
        'type' in error &&
        error.type === 'entity.too.large'
      ) {
        response.status(413).json({
          error: {
            code: 'BODY_TOO_LARGE',
            message: 'The request exceeds the supported size.',
          },
        });
      } else if (
        typeof error === 'object' &&
        error &&
        'type' in error &&
        error.type === 'entity.parse.failed'
      ) {
        response.status(400).json({
          error: {
            code: 'INVALID_JSON',
            message: 'Send a valid JSON object.',
          },
        });
      } else {
        console.error('SwapCircle request failed: INTERNAL_ERROR');
        response.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The request could not be completed.',
          },
        });
      }
    },
  );
  return app;
}
