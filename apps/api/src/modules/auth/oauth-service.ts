/**
 * OAuth sign-in, first-time sign-up completion and identity linking (architecture Q6, algorithm Q3/Q4).
 * Orchestration only: the decisions are the pure rows in `oauth-decision.ts`; this file gathers the facts,
 * runs the guarded single-use consumption, and does the writes. Never auto-links and never signs in on an
 * email match. Provider tokens, `code`, `state`, pending tokens and emails never reach a log field.
 */
import { randomUUID } from 'node:crypto';
import type {
  IdentitiesResponse,
  OAuthAuthorizeRequest,
  OAuthAuthorizeResponse,
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthCompleteRequest,
  OAuthCompleteResponse,
  OAuthPendingResponse,
  SessionInfo,
} from '@sgm/shared';
import { normaliseEmail, safeReturnTo } from '@sgm/shared';
import { enqueueEmail } from '../../jobs/send-email.ts';
import type { Clock } from '../../lib/clock.ts';
import type { AuthConfig } from '../../lib/config/config.ts';
import type { FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { buildIdentityLinkedEmail } from './emails.ts';
import { decideComplete, decideLink, decideSignIn } from './oauth-decision.ts';
import { requireLinkUserId, requireProviderEmail } from './oauth-invariants.ts';
import {
  ProviderError,
  type OAuthProvider,
  type OAuthProviderName,
  type OAuthProviderRegistry,
  type ProviderProfile,
} from './providers/provider.ts';
import { codeChallengeS256, newCodeVerifier, newNonce } from './providers/pkce.ts';
import {
  consumeOAuthState,
  consumePendingSignup,
  deleteIdentity,
  findIdentityOwner,
  findLivePendingSignup,
  findUserByEmail,
  getUserById,
  insertIdentity,
  insertOAuthState,
  insertOAuthUser,
  insertPendingSignup,
  listIdentities,
  lockUserRow,
  recordOAuthLogin,
  setEmailVerifiedIfUnset,
  toPublicUser,
  userHasIdentity,
  type PendingSignup,
  type UserRow,
} from './repo.ts';
import type { RequestContext } from './service.ts';
import type { IssuedSession, RequestAuth, SessionService } from './sessions.ts';
import { hashToken, newToken } from './tokens.ts';

/** Constants, not env (architecture Q6). */
const STATE_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;

/** The lower-case `:provider` path segment. */
export type ProviderSlug = 'google' | 'facebook';
const NAME_OF: Record<ProviderSlug, OAuthProviderName> = { google: 'GOOGLE', facebook: 'FACEBOOK' };

export interface CallbackContext extends RequestContext {
  /** The session resolved from the presented bearer token (`optionalSession`), or `null`. */
  readonly auth: RequestAuth | null;
}

export interface CompleteResult {
  readonly status: 200 | 201;
  readonly body: OAuthCompleteResponse;
}

export interface OAuthService {
  authorize(
    slug: ProviderSlug,
    input: OAuthAuthorizeRequest,
    ctx: RequestContext,
  ): Promise<OAuthAuthorizeResponse>;
  startLink(
    slug: ProviderSlug,
    auth: RequestAuth,
    ctx: RequestContext,
  ): Promise<OAuthAuthorizeResponse>;
  callback(
    slug: ProviderSlug,
    input: OAuthCallbackRequest,
    ctx: CallbackContext,
  ): Promise<OAuthCallbackResponse>;
  pending(rawToken: string, ctx: RequestContext): Promise<OAuthPendingResponse>;
  complete(input: OAuthCompleteRequest, ctx: RequestContext): Promise<CompleteResult>;
  identities(auth: RequestAuth): Promise<IdentitiesResponse>;
  unlink(slug: ProviderSlug, auth: RequestAuth, ctx: RequestContext): Promise<void>;
}

export interface OAuthServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly config: Pick<AuthConfig, 'webBaseUrl'>;
  readonly sessions: SessionService;
  readonly crypto: FieldCrypto;
  /** Producer used to enqueue the identity-linked notice inside the link transaction (P5). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly providers: OAuthProviderRegistry;
}

const isUniqueViolation = (error: unknown): error is Error & { constraint?: string } =>
  error instanceof Error && (error as Error & { code?: unknown }).code === '23505';

function toSessionInfo(session: IssuedSession): SessionInfo {
  return { token: session.token, expiresAt: session.expiresAt.toISOString() };
}

export function createOAuthService(deps: OAuthServiceDeps): OAuthService {
  const { db, clock, config, sessions, crypto, jobs } = deps;

  function providerOf(slug: ProviderSlug): OAuthProvider {
    const provider = deps.providers.get(NAME_OF[slug]);
    if (provider === undefined) throw new AppError('provider_not_enabled');
    return provider;
  }
  const redirectUri = (slug: ProviderSlug): string => `${config.webBaseUrl}/auth/callback/${slug}`;

  async function createState(
    slug: ProviderSlug,
    intent: 'signin' | 'link',
    linkUserId: string | null,
    returnTo: string,
    rerequest: boolean,
    ctx: RequestContext,
  ): Promise<OAuthAuthorizeResponse> {
    const provider = providerOf(slug);
    const state = newToken();
    const id = randomUUID();
    const now = clock.now();
    const verifier = provider.usesPkce ? newCodeVerifier() : null;
    const nonce = provider.usesPkce ? newNonce() : null;
    await insertOAuthState(db, {
      id,
      stateHash: state.hash,
      provider: provider.name,
      intent,
      linkUserId,
      nonce,
      codeVerifierEnc:
        verifier === null
          ? null
          : crypto.encrypt(verifier, { table: 'oauth_states', column: 'code_verifier', rowId: id }),
      returnTo,
      createdAt: now,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    });
    const url = provider.authorizationUrl({
      state: state.raw,
      redirectUri: redirectUri(slug),
      ...(verifier === null ? {} : { codeChallenge: codeChallengeS256(verifier) }),
      ...(nonce === null ? {} : { nonce }),
      rerequest: rerequest && provider.name === 'FACEBOOK',
    });
    ctx.log.info(
      {
        event: 'auth.oauth.started',
        provider: provider.name,
        intent,
        ...(rerequest ? { rerequest } : {}),
      },
      'oauth flow started',
    );
    return { authorizationUrl: url.toString(), state: state.raw };
  }

  function fail(ctx: RequestContext, provider: OAuthProviderName | null, reason: string): void {
    ctx.log.warn(
      { event: 'auth.oauth.failed', ...(provider === null ? {} : { provider }), reason },
      'oauth callback failed',
    );
  }

  async function exchange(
    provider: OAuthProvider,
    slug: ProviderSlug,
    code: string,
    state: { id: string; nonce: string | null; codeVerifierEnc: string | null },
    ctx: RequestContext,
  ): Promise<ProviderProfile> {
    try {
      const codeVerifier =
        state.codeVerifierEnc === null
          ? undefined
          : crypto.decrypt(state.codeVerifierEnc, {
              table: 'oauth_states',
              column: 'code_verifier',
              rowId: state.id,
            });
      return await provider.exchange({
        code,
        redirectUri: redirectUri(slug),
        ...(codeVerifier === undefined ? {} : { codeVerifier }),
        ...(state.nonce === null ? {} : { nonce: state.nonce }),
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        fail(ctx, provider.name, error.kind);
        // A refused code or an unverifiable token reads like a bad state to the user; only an outage differs.
        throw new AppError(
          error.kind === 'unavailable' ? 'provider_unavailable' : 'oauth_state_invalid',
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /** Revokes the presented session when this sign-in replaces it; returns its id for the log. */
  async function replacePresented(trx: Database, auth: RequestAuth | null): Promise<string | null> {
    if (auth === null) return null;
    return (await sessions.revoke(trx, auth.sessionId, 'replaced')) ? auth.sessionId : null;
  }

  async function signInAs(
    userId: string,
    identityId: string,
    auth: RequestAuth | null,
    ctx: RequestContext,
  ): Promise<{ user: UserRow; session: IssuedSession }> {
    const now = clock.now();
    const { session, replaced } = await db.transaction().execute(async (trx) => {
      const replacedId = await replacePresented(trx, auth);
      await recordOAuthLogin(trx, identityId, now);
      return { session: await sessions.issue(trx, userId, ctx.userAgent), replaced: replacedId };
    });
    const user = await getUserById(db, userId);
    if (user === undefined) throw new AppError('session_expired');
    if (replaced !== null) {
      ctx.log.info(
        { event: 'auth.session.revoked', reason: 'replaced', userId },
        'session replaced',
      );
    }
    return { user, session };
  }

  async function finishSignIn(
    profile: ProviderProfile,
    state: { returnTo: string },
    auth: RequestAuth | null,
    ctx: RequestContext,
  ): Promise<OAuthCallbackResponse> {
    const email = profile.email === null ? null : normaliseEmail(profile.email);
    const owner = await findIdentityOwner(db, profile.provider, profile.subject);
    const emailOwner =
      owner === undefined && email !== null ? await findUserByEmail(db, email) : undefined;
    const decision = decideSignIn({
      provider: profile.provider,
      identityOwnerId: owner?.userId ?? null,
      email,
      emailVerified: profile.emailVerified,
      emailOwnerId: emailOwner?.id ?? null,
    });
    switch (decision.row) {
      case 'S1': {
        if (owner === undefined) throw new Error('S1 decided without an identity owner');
        const { user, session } = await signInAs(decision.userId, owner.identityId, auth, ctx);
        ctx.log.info(
          { event: 'auth.login.succeeded', provider: profile.provider, userId: user.id },
          'sign-in succeeded',
        );
        return {
          outcome: 'signed_in',
          user: toPublicUser(user),
          session: toSessionInfo(session),
          returnTo: safeReturnTo(state.returnTo),
        };
      }
      case 'S2':
        ctx.log.warn(
          { event: 'auth.oauth.email_missing', provider: profile.provider },
          'provider shared no email',
        );
        throw new AppError(decision.code);
      case 'S3':
        fail(ctx, profile.provider, 'email_unverified');
        throw new AppError(decision.code);
      case 'S4':
        ctx.log.warn(
          { event: 'auth.oauth.conflict', provider: profile.provider, userId: emailOwner?.id },
          'oauth email belongs to an existing account',
        );
        // `email` is non-null here (S2 ruled out null); the web server shows it, never a URL.
        throw new AppError(decision.code, { email: requireProviderEmail(email, 'S4') });
      case 'S5': {
        const token = newToken();
        const now = clock.now();
        await insertPendingSignup(db, {
          tokenHash: token.hash,
          provider: profile.provider,
          subject: profile.subject,
          email: requireProviderEmail(email, 'S5'),
          emailVerified: profile.provider === 'GOOGLE' && profile.emailVerified,
          fullName: profile.fullName,
          returnTo: safeReturnTo(state.returnTo),
          createdAt: now,
          expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
        });
        ctx.log.info(
          { event: 'auth.oauth.pending.created', provider: profile.provider },
          'pending sign-up created',
        );
        return {
          outcome: 'pending_signup',
          pendingToken: token.raw,
          returnTo: safeReturnTo(state.returnTo),
        };
      }
    }
  }

  async function finishLink(
    profile: ProviderProfile,
    state: { linkUserId: string },
    auth: RequestAuth | null,
    ctx: RequestContext,
  ): Promise<OAuthCallbackResponse> {
    const owner = await findIdentityOwner(db, profile.provider, profile.subject);
    const decision = decideLink({
      linkUserId: state.linkUserId,
      currentUserId: auth?.userId ?? null,
      identityOwnerId: owner?.userId ?? null,
      userHasProvider: await userHasIdentity(db, state.linkUserId, profile.provider),
    });
    switch (decision.row) {
      case 'L0':
        fail(ctx, profile.provider, decision.code);
        throw new AppError(decision.code);
      case 'L1':
        return { outcome: 'already_linked', returnTo: '/account' };
      case 'L2':
      case 'L3':
        ctx.log.warn(
          {
            event: 'auth.oauth.link_conflict',
            provider: profile.provider,
            userId: state.linkUserId,
            code: decision.code,
          },
          'oauth link refused',
        );
        throw new AppError(decision.code);
      case 'L4':
        break;
    }
    try {
      const identityId = await db.transaction().execute(async (trx) => {
        await lockUserRow(trx, state.linkUserId);
        const user = await getUserById(trx, state.linkUserId);
        if (user === undefined) throw new AppError('session_expired');
        const now = clock.now();
        const id = await insertIdentity(trx, {
          userId: user.id,
          provider: profile.provider,
          subject: profile.subject,
          now,
        });
        const email = profile.email === null ? null : normaliseEmail(profile.email);
        if (profile.provider === 'GOOGLE' && profile.emailVerified && email === user.email) {
          await setEmailVerifiedIfUnset(trx, user.id, now);
        }
        // Same transaction: if the enqueue fails the identity is rolled back (P5, AC-ASYNC-5).
        await enqueueEmail(
          jobs,
          buildIdentityLinkedEmail({
            to: user.email,
            fullName: user.fullName,
            provider: profile.provider,
            identityId: id,
          }),
          { trx },
        );
        return id;
      });
      ctx.log.info(
        {
          event: 'auth.identity.linked',
          provider: profile.provider,
          userId: state.linkUserId,
          identityId,
        },
        'sign-in method connected',
      );
      return { outcome: 'linked', returnTo: '/account' };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent link took the subject or the provider slot between the check and the insert.
        const code =
          error.constraint === 'uq_auth_identities_user_provider'
            ? 'provider_already_connected'
            : 'identity_in_use';
        ctx.log.warn(
          {
            event: 'auth.oauth.link_conflict',
            provider: profile.provider,
            userId: state.linkUserId,
            code,
          },
          'oauth link refused',
        );
        throw new AppError(code, { cause: error });
      }
      throw error;
    }
  }

  type CompleteTxn =
    | { kind: 'expired' }
    | { kind: 'conflict'; pending: PendingSignup }
    | {
        kind: 'ok';
        status: 200 | 201;
        user: UserRow;
        session: IssuedSession;
        pending: PendingSignup;
      };

  async function completeOnce(
    input: OAuthCompleteRequest,
    tokenHash: Buffer,
    ctx: RequestContext,
  ): Promise<CompleteTxn> {
    return db.transaction().execute(async (trx): Promise<CompleteTxn> => {
      const now = clock.now();
      const pending = await consumePendingSignup(trx, tokenHash, now);
      if (pending === undefined) return { kind: 'expired' };
      const owner = await findIdentityOwner(trx, pending.provider, pending.subject);
      const emailOwner =
        owner === undefined ? await findUserByEmail(trx, pending.email) : undefined;
      const decision = decideComplete({
        identityOwnerId: owner?.userId ?? null,
        emailOwnerId: emailOwner?.id ?? null,
      });
      if (decision.row === 'C4') return { kind: 'conflict', pending }; // only the consume is committed
      if (decision.row === 'C3') {
        if (owner === undefined) throw new Error('C3 decided without an identity owner');
        await recordOAuthLogin(trx, owner.identityId, now);
        const user = await getUserById(trx, decision.userId);
        if (user === undefined) return { kind: 'expired' };
        return {
          kind: 'ok',
          status: 200,
          user,
          session: await sessions.issue(trx, user.id, ctx.userAgent),
          pending,
        };
      }
      const user = await insertOAuthUser(trx, {
        email: pending.email,
        fullName: input.fullName,
        sex: input.sex,
        provider: pending.provider,
        subject: pending.subject,
        // Informational only (R1/D1): Google asserted the address was verified at sign-up.
        emailVerifiedAt: pending.provider === 'GOOGLE' && pending.emailVerified ? now : null,
        now,
      });
      return {
        kind: 'ok',
        status: 201,
        user,
        session: await sessions.issue(trx, user.id, ctx.userAgent),
        pending,
      };
    });
  }

  return {
    authorize: (slug, input, ctx) =>
      createState(
        slug,
        'signin',
        null,
        safeReturnTo(input.returnTo),
        input.rerequest === true,
        ctx,
      ),

    startLink: (slug, auth, ctx) => createState(slug, 'link', auth.userId, '/account', false, ctx),

    async callback(slug, input, ctx) {
      const provider = providerOf(slug);
      const state = await consumeOAuthState(db, {
        stateHash: hashToken(input.state),
        provider: provider.name,
        now: clock.now(),
      });
      if (state === undefined) {
        fail(ctx, provider.name, 'state_invalid');
        throw new AppError('oauth_state_invalid');
      }
      if ('error' in input) {
        const outage = input.error === 'server_error' || input.error === 'temporarily_unavailable';
        ctx.log.info(
          { event: 'auth.oauth.cancelled', provider: provider.name, intent: state.intent },
          'oauth flow cancelled',
        );
        throw new AppError(outage ? 'provider_unavailable' : 'oauth_cancelled');
      }
      const profile = await exchange(provider, slug, input.code, state, ctx);
      if (state.intent === 'link') {
        return finishLink(profile, { linkUserId: requireLinkUserId(state) }, ctx.auth, ctx);
      }
      return finishSignIn(profile, state, ctx.auth, ctx);
    },

    async pending(rawToken) {
      const pending = await findLivePendingSignup(db, hashToken(rawToken), clock.now());
      if (pending === undefined) throw new AppError('signup_expired');
      return {
        provider: pending.provider,
        email: pending.email,
        fullName: pending.fullName,
        expiresAt: pending.expiresAt.toISOString(),
        returnTo: safeReturnTo(pending.returnTo),
      };
    },

    async complete(input, ctx) {
      const tokenHash = hashToken(input.pendingToken);
      let result: CompleteTxn;
      try {
        result = await completeOnce(input, tokenHash, ctx);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent sign-up won a unique constraint: re-decide once (it resolves to C3 or C4).
        result = await completeOnce(input, tokenHash, ctx).catch(async (second: unknown) => {
          if (!isUniqueViolation(second)) throw second;
          // Still racing on the email: spend the pending row in its own statement and report the conflict.
          const pending = await consumePendingSignup(db, tokenHash, clock.now());
          return pending === undefined
            ? ({ kind: 'expired' } as const)
            : ({ kind: 'conflict', pending } as const);
        });
      }
      if (result.kind === 'expired') {
        fail(ctx, null, 'signup_expired');
        throw new AppError('signup_expired');
      }
      if (result.kind === 'conflict') {
        ctx.log.warn(
          { event: 'auth.oauth.conflict', provider: result.pending.provider, stage: 'complete' },
          'oauth email belongs to an existing account',
        );
        throw new AppError('oauth_account_exists', { email: result.pending.email });
      }
      const { user, session, pending, status } = result;
      ctx.log.info(
        status === 201
          ? { event: 'auth.register', provider: pending.provider, userId: user.id }
          : { event: 'auth.login.succeeded', provider: pending.provider, userId: user.id },
        status === 201 ? 'account registered' : 'sign-in succeeded',
      );
      return {
        status,
        body: {
          user: toPublicUser(user),
          session: toSessionInfo(session),
          returnTo: safeReturnTo(pending.returnTo),
        },
      };
    },

    async identities(auth) {
      const rows = await listIdentities(db, auth.userId);
      return {
        identities: rows.map((row) => ({
          provider: row.provider,
          connectedAt: row.connectedAt.toISOString(),
          lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
        })),
        enabledProviders: deps.providers.enabled(),
      };
    },

    async unlink(slug, auth, ctx) {
      const name = NAME_OF[slug];
      await db.transaction().execute(async (trx) => {
        await lockUserRow(trx, auth.userId);
        const identities = await listIdentities(trx, auth.userId);
        const target = identities.find((identity) => identity.provider === name);
        if (target === undefined) throw new AppError('not_found');
        // The deferred trigger `auth_identities_last_method` backs this up under concurrency (23514).
        if (identities.length <= 1) throw new AppError('last_sign_in_method');
        await deleteIdentity(trx, target.identityId);
      });
      ctx.log.info(
        { event: 'auth.identity.unlinked', provider: name, userId: auth.userId, reason: 'user' },
        'sign-in method disconnected',
      );
    },
  };
}
