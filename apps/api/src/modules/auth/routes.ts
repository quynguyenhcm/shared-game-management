import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AuthSuccessResponse,
  ErrorResponse,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  MeResponse,
  ProvidersResponse,
  RegisterRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from '@sgm/shared';
import { authenticated, optionalSession, publicRoute } from '../../lib/auth/policy.ts';
import { presentedToken, requireAuth } from '../../lib/auth/request-auth.ts';
import type { ResetService } from './reset-service.ts';
import type { AuthService, RequestContext } from './service.ts';
import { storedUserAgent } from './sessions.ts';

export interface AuthRoutesOptions {
  readonly service: AuthService;
  readonly resetService: ResetService;
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
  const { service, resetService } = options;
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
        response: {
          201: AuthSuccessResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          429: ErrorResponse,
          503: ErrorResponse,
        },
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

  typed.post(
    '/password/forgot',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Request a password reset link',
        description:
          'Always 202 with the same body, whether or not an account exists for the email, so it cannot be used to discover accounts. The email is sent by the worker, not inline. At most one new link per user per 60 seconds; more requests from one client address per hour than the configured limit (default 10) are a 429.',
        operationId: 'forgotPassword',
        body: ForgotPasswordRequest,
        response: {
          202: ForgotPasswordResponse,
          422: ErrorResponse,
          429: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      await resetService.forgot(request.body, contextOf(request));
      return reply.code(202).send({ accepted: true });
    },
  );

  typed.post(
    '/password/reset',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Set a new password with a reset link token',
        description:
          'Single use. In one transaction: consumes the token, sets the PASSWORD identity, deletes every Google and Facebook identity of the user (reported in `removedProviders`), revokes all sessions, invalidates other reset tokens and records the inbox proof. An expired, used or unknown token is 400 and never hashes; a password that breaks the rules is 422 and leaves the token usable.',
        operationId: 'resetPassword',
        body: ResetPasswordRequest,
        response: {
          200: ResetPasswordResponse,
          400: ErrorResponse,
          422: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => resetService.reset(request.body, contextOf(request)),
  );

  return Promise.resolve();
};
