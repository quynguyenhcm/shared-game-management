import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, ErrorResponse, SessionErrorResponse, type SessionResponse } from '@sgm/shared';
import {
  AppError,
  ERROR_DEFAULTS,
  isDatabaseUnavailable,
  registerErrorHandling,
} from './errors.ts';

/** The authoritative list from memory-bank/creative/auth-and-user-roles-architecture.md ("Shared HTTP error shape"). */
const AUTHORITATIVE_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'session_expired',
  'forbidden',
  'cross_origin_request',
  'not_found',
  'conflict',
  'internal_error',
  'service_unavailable',
  'email_taken',
  'invalid_credentials',
  'too_many_attempts',
  'too_many_requests',
  'invalid_or_expired_token',
  'provider_not_enabled',
  'provider_unavailable',
  'oauth_state_invalid',
  'oauth_cancelled',
  'oauth_email_missing',
  'oauth_email_unverified',
  'oauth_account_exists',
  'signup_expired',
  'identity_in_use',
  'provider_already_connected',
  'link_session_mismatch',
  'last_sign_in_method',
  // team-management (memory-bank/creative/team-management-membership-architecture.md, section 4)
  'invite_invalid',
  'already_requested',
  'already_member',
  'banned_from_team',
  'team_admin_cannot_be_banned',
  'last_team_admin',
  'membership_state_conflict',
  // team-banking-and-gst (architecture doc Q4: publish gate and removal guard)
  'payout_not_configured',
  'banking_in_use',
  // skill-levels-and-auto-enroll (Binding Reconciliation decision 4: optimistic concurrency on overrides)
  'skill_level_stale',
  // ...and on Auto Enroll saves (final review: a stale panel must not re-enrol a member)
  'auto_enroll_stale',
  // session-scheduling-engine (Binding Reconciliation T-7, T-11, T-12)
  'session_stale',
  'series_stale',
  'session_started',
  'session_not_editable',
  'session_state_conflict',
  'session_fee_locked',
] as const;

const TEAM_ERROR_STATUSES = [
  ['invite_invalid', 404],
  ['already_requested', 409],
  ['already_member', 409],
  ['banned_from_team', 403],
  ['team_admin_cannot_be_banned', 409],
  ['last_team_admin', 409],
  ['membership_state_conflict', 409],
  ['payout_not_configured', 409],
  ['banking_in_use', 409],
  ['skill_level_stale', 409],
  ['auto_enroll_stale', 409],
  ['session_stale', 409],
  ['series_stale', 409],
  ['session_started', 409],
  ['session_not_editable', 409],
  ['session_state_conflict', 409],
  ['session_fee_locked', 409],
] as const;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/strict',
    { schema: { body: z.strictObject({ email: z.string('Enter your email address.') }) } },
    () => ({ ok: true }),
  );
  app.get('/app-error', () => {
    throw new AppError('forbidden');
  });
  app.get('/retry', () => {
    throw new AppError('too_many_attempts', { retryAfterSeconds: 90, message: 'Slow down.' });
  });
  app.get('/with-email', () => {
    throw new AppError('oauth_account_exists', { email: 'a@b.co' });
  });
  app.get('/duplicate', () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code: '23505',
    });
  });
  app.get('/last-method', () => {
    throw Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      constraint: 'auth_identities_last_method',
    });
  });
  app.get('/other-check', () => {
    throw Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      constraint: 'something_else',
    });
  });
  app.get('/db-down', () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  });
  app.get('/boom', () => {
    throw new Error('secret internal detail');
  });
  return app;
}

describe('ErrorCode list', () => {
  it('equals the authoritative list in the architecture document, in order', () => {
    expect([...ErrorCode]).toEqual([...AUTHORITATIVE_ERROR_CODES]);
  });

  it('has a status and a safe default message for every code', () => {
    expect(Object.keys(ERROR_DEFAULTS).sort()).toEqual([...AUTHORITATIVE_ERROR_CODES].sort());
    expect(ERROR_DEFAULTS.validation_failed.status).toBe(422);
    expect(ERROR_DEFAULTS.unauthenticated.status).toBe(401);
    expect(ERROR_DEFAULTS.session_expired.status).toBe(401);
    expect(ERROR_DEFAULTS.forbidden.status).toBe(403);
    expect(ERROR_DEFAULTS.cross_origin_request.status).toBe(403);
    expect(ERROR_DEFAULTS.too_many_attempts.status).toBe(429);
    expect(ERROR_DEFAULTS.provider_unavailable.status).toBe(502);
    expect(ERROR_DEFAULTS.service_unavailable.status).toBe(503);
    for (const { message } of Object.values(ERROR_DEFAULTS))
      expect(message.length).toBeGreaterThan(0);
  });

  it('banking codes carry the copy deck text (AC-ERROR-8, AC-ERROR-10 as amended by R1 and R12)', () => {
    expect(ERROR_DEFAULTS.payout_not_configured.message).toBe(
      "Add your team's bank account details before publishing a paid session.",
    );
    expect(ERROR_DEFAULTS.banking_in_use.message).toMatch(/published paid sessions/);
    expect(ERROR_DEFAULTS.banking_in_use.message).toMatch(/unpaid payments/);
    expect(ERROR_DEFAULTS.payout_not_configured.message).not.toMatch(/akahu/i);
  });

  it.each(TEAM_ERROR_STATUSES)(
    'team code %s answers %i with a safe message and the shared body shape',
    async (code, status) => {
      expect(ERROR_DEFAULTS[code].status).toBe(status);
      expect(ERROR_DEFAULTS[code].message).not.toMatch(/[{}<>]|undefined/);
      const app = await build();
      app.get(`/team-error/${code}`, () => {
        throw new AppError(code);
      });
      const response = await app.inject({ method: 'GET', url: `/team-error/${code}` });
      expect(response.statusCode).toBe(status);
      expect(ErrorResponse.parse(response.json())).toEqual({
        error: { code, message: ERROR_DEFAULTS[code].message },
      });
    },
  );
});

describe('registerErrorHandling', () => {
  it('maps an AppError to its status and the shared { error: { code, message } } shape', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/app-error' });
    expect(response.statusCode).toBe(403);
    expect(ErrorResponse.parse(response.json())).toEqual({
      error: { code: 'forbidden', message: ERROR_DEFAULTS.forbidden.message },
    });
  });

  it('sets Retry-After from retryAfterSeconds and carries email only where given', async () => {
    const app = await build();
    const retry = await app.inject({ method: 'GET', url: '/retry' });
    expect(retry.statusCode).toBe(429);
    expect(retry.headers['retry-after']).toBe('90');
    expect(retry.json()).toEqual({ error: { code: 'too_many_attempts', message: 'Slow down.' } });
    const withEmail = await app.inject({ method: 'GET', url: '/with-email' });
    expect(withEmail.statusCode).toBe(409);
    expect(ErrorResponse.parse(withEmail.json()).error).toMatchObject({
      code: 'oauth_account_exists',
      email: 'a@b.co',
    });
  });

  it('turns a schema failure into 422 validation_failed with fieldErrors, never echoing input', async () => {
    const app = await build();
    const missing = await app.inject({ method: 'POST', url: '/strict', payload: {} });
    expect(missing.statusCode).toBe(422);
    expect(ErrorResponse.parse(missing.json()).error).toMatchObject({
      code: 'validation_failed',
      fieldErrors: { email: ['Enter your email address.'] },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/strict',
      payload: { email: 'a@b.co', role: 'GLOBAL_ADMIN' },
    });
    expect(unknown.statusCode).toBe(422);
    expect(ErrorResponse.parse(unknown.json()).error.code).toBe('validation_failed');
    expect(unknown.body).not.toContain('GLOBAL_ADMIN');
  });

  it('maps malformed JSON to 422 validation_failed instead of Fastify default 400', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/strict',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(422);
    expect(ErrorResponse.parse(response.json()).error.code).toBe('validation_failed');
  });

  it('maps an untranslated 23505 to 409 conflict and database outages to 503 service_unavailable', async () => {
    const app = await build();
    const duplicate = await app.inject({ method: 'GET', url: '/duplicate' });
    expect(duplicate.statusCode).toBe(409);
    expect(ErrorResponse.parse(duplicate.json()).error.code).toBe('conflict');
    expect(duplicate.body).not.toContain('duplicate key');
    const down = await app.inject({ method: 'GET', url: '/db-down' });
    expect(down.statusCode).toBe(503);
    expect(ErrorResponse.parse(down.json()).error.code).toBe('service_unavailable');
  });

  it('maps the last-sign-in-method check violation (23514) to 409 last_sign_in_method; other checks stay 500', async () => {
    const app = await build();
    const last = await app.inject({ method: 'GET', url: '/last-method' });
    expect(last.statusCode).toBe(409);
    expect(ErrorResponse.parse(last.json()).error.code).toBe('last_sign_in_method');
    expect(last.body).not.toContain('check constraint');
    const other = await app.inject({ method: 'GET', url: '/other-check' });
    expect(other.statusCode).toBe(500);
  });

  it('answers 404 not_found for unknown routes and hides unexpected error detail behind 500', async () => {
    const app = await build();
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(ErrorResponse.parse(missing.json()).error.code).toBe('not_found');
    const boom = await app.inject({ method: 'GET', url: '/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({
      error: { code: 'internal_error', message: ERROR_DEFAULTS.internal_error.message },
    });
    expect(boom.body).not.toContain('secret internal detail');
  });
});

describe('session error extras (SessionErrorResponse)', () => {
  const dstOptions = [
    {
      field: 'courts.0.startTime',
      date: '2026-09-27',
      time: '02:30',
      kind: 'nonexistent' as const,
      options: [
        {
          choice: 'shiftedForward' as const,
          localTime: '03:30',
          instant: '2026-09-26T14:30:00.000Z',
        },
        {
          choice: 'shiftedBackward' as const,
          localTime: '01:30',
          instant: '2026-09-26T13:30:00.000Z',
        },
      ],
    },
  ];

  it('carries dstOptions beside fieldErrors on a 422', async () => {
    const app = await build();
    app.get('/dst', () => {
      throw new AppError('validation_failed', {
        fieldErrors: { 'courts.0.startTime': ['local_time_nonexistent'] },
        dstOptions,
      });
    });
    const response = await app.inject({ method: 'GET', url: '/dst' });
    expect(response.statusCode).toBe(422);
    const body = SessionErrorResponse.parse(response.json());
    expect(body.error.dstOptions).toEqual(dstOptions);
    expect(body.error.fieldErrors).toEqual({ 'courts.0.startTime': ['local_time_nonexistent'] });
  });

  it('carries raisedFields on session_fee_locked', async () => {
    const app = await build();
    app.get('/locked', () => {
      throw new AppError('session_fee_locked', { raisedFields: ['feeMale', 'feeOther'] });
    });
    const response = await app.inject({ method: 'GET', url: '/locked' });
    expect(response.statusCode).toBe(409);
    expect(SessionErrorResponse.parse(response.json()).error).toMatchObject({
      code: 'session_fee_locked',
      raisedFields: ['feeMale', 'feeOther'],
    });
  });

  it('carries the current row on a stale save (409), without touching other errors', async () => {
    const app = await build();
    const current = { id: 'abc', version: 4 } as unknown as SessionResponse;
    app.get('/stale', () => {
      throw new AppError('session_stale', { current });
    });
    const stale = await app.inject({ method: 'GET', url: '/stale' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: { code: 'session_stale', message: ERROR_DEFAULTS.session_stale.message, current },
    });
    // A plain AppError still has exactly the shared shape.
    const plain = await app.inject({ method: 'GET', url: '/app-error' });
    expect(Object.keys(plain.json<{ error: object }>().error)).toEqual(['code', 'message']);
  });
});

describe('isDatabaseUnavailable', () => {
  it('recognises connection-class SQLSTATEs, socket errors and pool timeouts only', () => {
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: '08006' }))).toBe(true);
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isDatabaseUnavailable(new Error('boom'))).toBe(false);
    expect(isDatabaseUnavailable('string')).toBe(false);
  });
});
