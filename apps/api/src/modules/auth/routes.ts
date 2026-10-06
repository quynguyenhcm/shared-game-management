import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AuthSuccessResponse,
  ErrorResponse,
  LoginRequest,
  MeResponse,
  ProvidersResponse,
  RegisterRequest,
} from '@sgm/shared';
import { authenticated, optionalSession, publicRoute } from '../../lib/auth/policy.ts';
import { presentedToken, requireAuth } from '../../lib/auth/request-auth.ts';
import type { AuthService, RequestContext } from './service.ts';
import { storedUserAgent } from './sessions.ts';

export interface AuthRoutesOptions {
  readonly service: AuthService;
}

function contextOf(request: FastifyRequest): RequestContext {
  return {
    log: request.log,
    userAgent: storedUserAgent(request.headers['user-agent']),
    clientAddress: request.clientAddress,
  };
}

/** `/auth/*` password endpoints. The API sets no cookies: the web owns them and sends the bearer token. */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/register',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Register with email and password',
        description:
          'Creates the player account and signs it in. The body is strict: an unknown field such as `role` is a 422.',
        operationId: 'registerWithPassword',
        body: RegisterRequest,
        response: { 201: AuthSuccessResponse, 409: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.register(request.body, contextOf(request))),
  );

  typed.post(
    '/login',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Sign in with email and password',
        description:
          'Every failure (unknown email, wrong password, account without a password) is the same 401. After 5 failures per email or 20 per client address in 15 minutes the answer is 429 with Retry-After, even for the right password.',
        operationId: 'loginWithPassword',
        body: LoginRequest,
        response: {
          200: AuthSuccessResponse,
          401: ErrorResponse,
          422: ErrorResponse,
          429: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => {
      const presented = presentedToken(request);
      return service.login(request.body, {
        ...contextOf(request),
        presentedToken: presented.kind === 'bearer' ? presented.token : null,
      });
    },
  );

  typed.post(
    '/logout',
    {
      config: { policy: optionalSession() },
      schema: {
        summary: 'Sign out',
        description:
          'Revokes the presented session. Answers 204 for an already dead or absent session too.',
        operationId: 'logout',
        response: { 204: z.null().describe('Signed out') },
      },
    },
    async (request, reply) => {
      await service.logout(request.auth, contextOf(request));
      return reply.code(204).send(null);
    },
  );

  typed.get(
    '/me',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'The signed-in user',
        operationId: 'getMe',
        response: { 200: MeResponse, 401: ErrorResponse },
      },
    },
    async (request) => service.me(requireAuth(request)),
  );

  typed.get(
    '/providers',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Which OAuth providers are enabled',
        operationId: 'getAuthProviders',
        response: { 200: ProvidersResponse },
      },
    },
    () => service.providers(),
  );

  return Promise.resolve();
};
