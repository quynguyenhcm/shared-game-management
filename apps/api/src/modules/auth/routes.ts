import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AuthSuccessResponse,
  ErrorResponse,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  IdentitiesResponse,
  LoginRequest,
  MeResponse,
  OAuthAuthorizeRequest,
  OAuthAuthorizeResponse,
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthCompleteRequest,
  OAuthCompleteResponse,
  OAuthPendingHeaders,
  OAuthPendingResponse,
  OAuthProviderParams,
  ProvidersResponse,
  RegisterRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from '@sgm/shared';
import { authenticated, optionalSession, publicRoute } from '../../lib/auth/policy.ts';
import { presentedToken, requireAuth } from '../../lib/auth/request-auth.ts';
import type { OAuthService } from './oauth-service.ts';
import type { ResetService } from './reset-service.ts';
import type { AuthService, RequestContext } from './service.ts';
import { storedUserAgent } from './sessions.ts';

export interface AuthRoutesOptions {
  readonly service: AuthService;
  readonly resetService: ResetService;
  readonly oauthService: OAuthService;
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
  const { service, resetService, oauthService } = options;
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

  typed.post(
    '/oauth/:provider/authorize',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Start a Google or Facebook sign-in',
        description:
          'Stores a single-use state (10 minutes) and returns the provider URL and the raw state, which the web keeps in its `sgm_oauth` binding cookie. `rerequest` is honoured for Facebook only (`auth_type=rerequest`). 404 `provider_not_enabled` when the provider has no credentials.',
        operationId: 'oauthAuthorize',
        params: OAuthProviderParams,
        body: OAuthAuthorizeRequest,
        response: { 200: OAuthAuthorizeResponse, 404: ErrorResponse, 422: ErrorResponse },
      },
    },
    (request) => oauthService.authorize(request.params.provider, request.body, contextOf(request)),
  );

  typed.post(
    '/oauth/:provider/callback',
    {
      config: { policy: optionalSession() },
      schema: {
        summary: 'Finish a Google or Facebook sign-in or connect',
        description:
          "Consumes the state exactly once. Outcomes: `signed_in` (a session), `pending_signup` (first-time user; nothing is created until `/auth/oauth/complete`), `linked` and `already_linked` (connect flow, needs the same user's bearer token). An email that matches an existing account is never signed in or linked: 409 `oauth_account_exists`.",
        operationId: 'oauthCallback',
        params: OAuthProviderParams,
        body: OAuthCallbackRequest,
        response: {
          200: OAuthCallbackResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          502: ErrorResponse,
        },
      },
    },
    (request) =>
      oauthService.callback(request.params.provider, request.body, {
        ...contextOf(request),
        auth: request.auth,
      }),
  );

  typed.get(
    '/oauth/pending',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'The pending first-time sign-up',
        description:
          'Prefills `/register/complete`. The handle travels in `X-Pending-Signup`, never in the URL.',
        operationId: 'oauthPending',
        headers: OAuthPendingHeaders,
        response: { 200: OAuthPendingResponse, 400: ErrorResponse, 422: ErrorResponse },
      },
    },
    (request) => oauthService.pending(request.headers['x-pending-signup'], contextOf(request)),
  );

  typed.post(
    '/oauth/complete',
    {
      config: { policy: publicRoute() },
      schema: {
        summary: 'Finish a first-time Google or Facebook sign-up',
        description:
          'Requires the sex choice (422 keeps the pending sign-up valid). In one transaction consumes the pending sign-up and creates the user and identity. 201 for a new account, 200 when the identity already existed (finished in another tab).',
        operationId: 'oauthComplete',
        body: OAuthCompleteRequest,
        response: {
          200: OAuthCompleteResponse,
          201: OAuthCompleteResponse,
          400: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await oauthService.complete(request.body, contextOf(request));
      return reply.code(result.status).send(result.body);
    },
  );

  typed.get(
    '/identities',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Sign-in methods of the signed-in user',
        operationId: 'listIdentities',
        response: { 200: IdentitiesResponse },
      },
    },
    (request) => oauthService.identities(requireAuth(request)),
  );

  typed.post(
    '/identities/:provider/link',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Start connecting Google or Facebook',
        operationId: 'startLinkIdentity',
        params: OAuthProviderParams,
        response: { 200: OAuthAuthorizeResponse, 404: ErrorResponse, 422: ErrorResponse },
      },
    },
    (request) =>
      oauthService.startLink(request.params.provider, requireAuth(request), contextOf(request)),
  );

  typed.delete(
    '/identities/:provider',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Disconnect Google or Facebook',
        description:
          'Never the last sign-in method: 409 `last_sign_in_method` (also enforced by a deferred database trigger).',
        operationId: 'unlinkIdentity',
        params: OAuthProviderParams,
        response: {
          204: z.null().describe('Disconnected'),
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      await oauthService.unlink(request.params.provider, requireAuth(request), contextOf(request));
      return reply.code(204).send(null);
    },
  );

  return Promise.resolve();
};
