/**
 * Log hygiene for the Phase 2 team routes (AC-VERIFY-3, AC-VERIFY-5 partial): the invite code, emails, names and
 * session tokens appear in no log line on the lookup, join, regenerate and not-found paths, and each action
 * emits one structured `team.*` event carrying teamId, actorId and the request's traceId.
 */
import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/lib/telemetry/telemetry.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { insertAuthSession, insertTeamMember, insertUser } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let database: TestDatabase;
let h: AuthTestApp;
let telemetry: Telemetry;
beforeAll(async () => {
  telemetry = startTelemetry(
    {
      serviceName: 'sgm-test',
      serviceVersion: 'test',
      disabled: false,
      tracesExporter: 'none',
      otlpEndpoint: undefined,
      sampler: 'parentbased_traceidratio',
      samplerArg: 1,
    },
    { spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] },
  );
  database = await createTestDatabase();
  h = await buildAuthTestApp(database.pool);
});
afterAll(async () => {
  await h.close();
  await database.close();
  await telemetry.shutdown();
});

interface Person {
  readonly id: string;
  readonly token: string;
  readonly email: string;
  readonly fullName: string;
}

async function person(fullName: string): Promise<Person> {
  const email = `${fullName.toLowerCase().replace(/\s+/g, '.')}@logs.example.test`;
  const id = await insertUser(database.pool, 'FEMALE', { email });
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [id, fullName]);
  const { token } = await insertAuthSession(database.pool, id, { createdAt: h.clock.now() });
  return { id, token, email, fullName };
}

const call = (
  method: 'GET' | 'POST',
  url: string,
  who: Person,
  payload?: Record<string, unknown>,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...bearer(who.token), traceparent: TRACEPARENT },
    ...(payload === undefined ? {} : { payload }),
  });

describe('team routes leave no secret or PII in the logs', () => {
  it('logs team.* events with teamId, actorId and traceId, and never the invite code, an email, a name or a token', async () => {
    const owner = await person('Zelda Quillfeather');
    const joiner = await person('Barnaby Fernhill');
    const banned = await person('Cordelia Mossgrove');
    const teamName = 'Quillfeather Secret Smashers';

    const created = await call('POST', '/teams', owner, {
      name: teamName,
      description: 'A very private description',
      visibility: 'PRIVATE',
      skillLevel: 'ADVANCED',
      idempotencyKey: randomUUID(),
    });
    expect(created.statusCode).toBe(201);
    const teamId = created.json<{ team: { id: string } }>().team.id;
    const firstCode = (await call('GET', `/teams/${teamId}/invite-code`, owner)).json<{
      inviteCode: string;
    }>().inviteCode;
    await insertTeamMember(database.pool, {
      teamId,
      userId: banned.id,
      status: 'BANNED',
      actorId: owner.id,
    });

    expect(
      (await call('POST', '/teams/invite/lookup', joiner, { code: firstCode })).statusCode,
    ).toBe(200);
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, joiner, {
          skillLevel: 'BEGINNER',
          inviteCode: firstCode,
        })
      ).statusCode,
    ).toBe(201);
    // Refusals: duplicate request, private team by id without a code, banned caller, then a stale code after rotation.
    expect(
      (
        await call('POST', `/teams/${teamId}/join-requests`, joiner, {
          skillLevel: 'BEGINNER',
          inviteCode: firstCode,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `/teams/${teamId}/join-requests`, banned, { skillLevel: 'BEGINNER' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('POST', '/teams/invite/lookup', banned, { code: firstCode })).statusCode,
    ).toBe(403);
    const rotated = await call('POST', `/teams/${teamId}/invite-code/regenerate`, owner);
    expect(rotated.statusCode).toBe(200);
    const secondCode = rotated.json<{ inviteCode: string }>().inviteCode;
    expect(
      (await call('POST', '/teams/invite/lookup', joiner, { code: firstCode })).statusCode,
    ).toBe(404);
    const other = await person('Ignatius Wattlebird');
    expect(
      (await call('POST', `/teams/${teamId}/join-requests`, other, { skillLevel: 'BEGINNER' }))
        .statusCode,
    ).toBe(404);

    const lines = h.logs.lines();
    const serialised = JSON.stringify(lines);
    for (const secret of [
      firstCode,
      secondCode,
      teamName,
      'A very private description',
      ...[owner, joiner, banned, other].flatMap((p) => [p.email, p.fullName, p.token]),
    ]) {
      expect(serialised, secret.slice(0, 12)).not.toContain(secret);
    }

    const events = lines.filter(
      (line) => typeof line.event === 'string' && line.event.startsWith('team.'),
    );
    const only = (name: string) => events.filter((line) => line.event === name);
    expect(only('team.created')).toHaveLength(1);
    expect(only('team.created')[0]).toMatchObject({
      teamId,
      actorId: owner.id,
      visibility: 'PRIVATE',
      traceId: TRACE_ID,
    });
    expect(only('team.join.requested')).toHaveLength(1);
    expect(only('team.join.requested')[0]).toMatchObject({
      teamId,
      actorId: joiner.id,
      visibility: 'PRIVATE',
      viaInvite: true,
      rerequest: false,
      traceId: TRACE_ID,
    });
    expect(only('team.invite.regenerated')).toHaveLength(1);
    expect(only('team.invite.regenerated')[0]).toMatchObject({
      teamId,
      actorId: owner.id,
      traceId: TRACE_ID,
    });

    const refused = only('team.action.refused');
    expect(refused.map((line) => line.reason).sort()).toEqual(
      [
        'already_requested',
        'banned_from_team',
        'banned_from_team',
        'invite_invalid',
        'not_found',
      ].sort(),
    );
    for (const line of refused) {
      expect(line.actorId, JSON.stringify(line)).toEqual(expect.any(String));
      expect(line.traceId).toBe(TRACE_ID);
      expect(line.action).toEqual(expect.any(String));
    }
    for (const line of events) {
      expect(
        Object.keys(line).filter(
          (key) => /email|name|code|token|reason_text|banReason/i.test(key) && key !== 'reason',
        ),
      ).toEqual([]);
    }
  });
});

describe('moderation leaves one structured event per action and no PII in the logs (AC-VERIFY-5)', () => {
  it('logs team.member.approved|promoted|demoted|banned and team.action.refused (guard 403 included) with ids and traceId only', async () => {
    const owner = await person('Octavia Ironbark');
    const joiner = await person('Percival Tidewater');
    const victim = await person('Rosalind Harbourlight');
    const intruder = await person('Sebastian Outsider');
    const banReason = 'sensitive reason: shouted at the coach';

    const created = await call('POST', '/teams', owner, {
      name: 'Ironbark Moderation Club',
      visibility: 'PUBLIC',
      skillLevel: 'ADVANCED',
      idempotencyKey: randomUUID(),
    });
    const teamId = created.json<{ team: { id: string } }>().team.id;
    for (const who of [joiner, victim]) {
      expect(
        (await call('POST', `/teams/${teamId}/join-requests`, who, { skillLevel: 'BEGINNER' }))
          .statusCode,
      ).toBe(201);
    }
    const act = (who: Person, user: Person, action: string, body?: Record<string, unknown>) =>
      call('POST', `/teams/${teamId}/members/${user.id}/${action}`, who, body);

    expect((await act(owner, joiner, 'approve')).statusCode).toBe(200);
    expect((await act(owner, victim, 'approve')).statusCode).toBe(200);
    expect((await act(owner, joiner, 'promote')).statusCode).toBe(200);
    expect((await act(owner, joiner, 'demote')).statusCode).toBe(200);
    // Refusals: a stale approve, a ban of an admin, an unknown target, and a guard 403 (and a 401, which has no actor).
    expect((await act(owner, joiner, 'approve')).statusCode).toBe(409);
    expect((await act(owner, owner, 'ban')).statusCode).toBe(409);
    expect((await act(owner, intruder, 'reject')).statusCode).toBe(404);
    expect((await act(intruder, victim, 'ban', { reason: 'x'.repeat(900) })).statusCode).toBe(403);
    expect((await act(joiner, victim, 'ban')).statusCode).toBe(403);
    const anonymous = await h.app.inject({
      method: 'POST',
      url: `/teams/${teamId}/members/${victim.id}/ban`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await act(owner, victim, 'ban', { reason: banReason })).statusCode).toBe(200);

    const lines = h.logs.lines();
    const mine = lines.filter(
      (line) =>
        typeof line.event === 'string' && line.event.startsWith('team.') && line.teamId === teamId,
    );
    const only = (name: string) => mine.filter((line) => line.event === name);
    expect(only('team.member.approved').map((l) => l.userId)).toEqual([joiner.id, victim.id]);
    expect(only('team.member.promoted').map((l) => l.userId)).toEqual([joiner.id]);
    expect(only('team.member.demoted').map((l) => l.userId)).toEqual([joiner.id]);
    expect(only('team.member.banned').map((l) => l.userId)).toEqual([victim.id]);
    for (const name of [
      'team.member.approved',
      'team.member.promoted',
      'team.member.demoted',
      'team.member.banned',
    ]) {
      for (const line of only(name)) {
        expect(line, name).toMatchObject({ actorId: owner.id, teamId, traceId: TRACE_ID });
      }
    }

    const refused = only('team.action.refused');
    expect(refused.map((line) => line.reason).sort()).toEqual(
      [
        'forbidden',
        'forbidden',
        'membership_state_conflict',
        'not_found',
        'team_admin_cannot_be_banned',
      ].sort(),
    );
    for (const line of refused) {
      expect(line.traceId).toBe(TRACE_ID);
      expect(line.actorId, JSON.stringify(line)).toEqual(expect.any(String));
      expect(line.action).toEqual(expect.any(String));
    }
    expect(
      refused
        .filter((l) => l.reason === 'forbidden')
        .map((l) => l.actorId)
        .sort(),
    ).toEqual([intruder.id, joiner.id].sort());

    const serialised = JSON.stringify(lines);
    for (const secret of [
      banReason,
      'shouted at the coach',
      'Ironbark Moderation Club',
      ...[owner, joiner, victim, intruder].flatMap((p) => [p.email, p.fullName, p.token]),
    ]) {
      expect(serialised, secret.slice(0, 14)).not.toContain(secret);
    }
    for (const line of mine) {
      expect(
        Object.keys(line).filter(
          (key) => /email|name|code|token|banReason/i.test(key) && key !== 'reason',
        ),
      ).toEqual([]);
    }
  });
});
