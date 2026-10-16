/**
 * Log hygiene for the skill-levels admin routes (AC-VERIFY-6): `team.member.skill_overridden` and
 * `team.member.auto_enroll_changed` carry exactly their documented fields (ids, levels, booleans), every request
 * line carries the traceId, refusals are `team.action.refused` with ids only, no-op saves log nothing, and no name,
 * email, token or `until` date appears anywhere. No field is named exactly `code` (it is globally redacted).
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/lib/telemetry/telemetry.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`;

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
  const email = `${fullName.toLowerCase().replace(/\s+/g, '.')}@skill-logs.example.test`;
  const id = await insertUser(database.pool, 'FEMALE', { email });
  await database.pool.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [id, fullName]);
  const { token } = await insertAuthSession(database.pool, id, { createdAt: h.clock.now() });
  return { id, token, email, fullName };
}

/** The keys the logger adds to every line; what remains is the event's own field set. */
const ENVELOPE = new Set([
  'level',
  'time',
  'timestamp',
  'msg',
  'message',
  'service',
  'version',
  'environment',
  'pid',
  'hostname',
  'traceId',
  'spanId',
  'requestId',
  'reqId',
  'event',
]);
const ownFields = (line: Record<string, unknown>): string[] =>
  Object.keys(line)
    .filter((key) => !ENVELOPE.has(key))
    .sort();

describe('skill-levels events log ids, levels and booleans only (AC-VERIFY-6)', () => {
  it('emits the exact field sets with the traceId, logs refusals by id, logs nothing for no-ops, and no PII', async () => {
    const aroha = await person('Wikitoria Overridewell');
    const priya = await person('Henrietta Autoenrolsen');
    const plain = await person('Montgomery Plainmember');
    const teamId = await insertTeam(database.pool, { name: 'Overridewell Secret Club' });
    await insertTeamMember(database.pool, { teamId, userId: aroha.id, role: 'TEAM_ADMIN' });
    await insertTeamMember(database.pool, { teamId, userId: priya.id });
    await insertTeamMember(database.pool, { teamId, userId: plain.id });
    const put = (who: Person, path: string, payload: Record<string, unknown>) =>
      h.app.inject({
        method: 'PUT',
        url: `/teams/${teamId}/members/${priya.id}/${path}`,
        headers: { ...bearer(who.token), traceparent: TRACEPARENT },
        payload,
      });
    const level = (skillLevel: string, expectedSkillLevel: string) =>
      put(aroha, 'skill-level', { skillLevel, expectedSkillLevel, expectedChangedAt: null });

    expect((await level('ADVANCED', 'BEGINNER')).statusCode).toBe(200);
    // No-ops: same level, and Auto Enroll off -> off.
    expect(
      (
        await put(aroha, 'skill-level', {
          skillLevel: 'ADVANCED',
          expectedSkillLevel: 'ADVANCED',
          expectedChangedAt: null,
        })
      ).statusCode,
    ).toBe(200);
    expect((await put(aroha, 'auto-enroll', { enabled: false, until: null })).statusCode).toBe(200);
    expect(
      (await put(aroha, 'auto-enroll', { enabled: true, until: '2026-11-30' })).statusCode,
    ).toBe(200);
    expect((await put(aroha, 'auto-enroll', { enabled: true, until: null })).statusCode).toBe(200);
    // Refusals: stale, a past date, and a plain member (guard 403).
    expect((await level('INTERMEDIATE', 'BEGINNER')).statusCode).toBe(409);
    expect(
      (await put(aroha, 'auto-enroll', { enabled: true, until: '2026-10-01' })).statusCode,
    ).toBe(422);
    expect((await put(plain, 'auto-enroll', { enabled: true, until: null })).statusCode).toBe(403);

    const lines = h.logs.lines();
    const mine = lines.filter((line) => line.teamId === teamId);
    const only = (name: string) => mine.filter((line) => line.event === name);

    const overridden = only('team.member.skill_overridden');
    expect(overridden).toHaveLength(1);
    expect(ownFields(overridden[0] ?? {})).toEqual(['actorId', 'from', 'teamId', 'to', 'userId']);
    expect(overridden[0]).toMatchObject({
      actorId: aroha.id,
      userId: priya.id,
      from: 'BEGINNER',
      to: 'ADVANCED',
      traceId: TRACE_ID,
    });

    const toggled = only('team.member.auto_enroll_changed');
    expect(toggled.map((line) => line.hasUntil)).toEqual([true, false]);
    for (const line of toggled) {
      expect(ownFields(line)).toEqual(['actorId', 'enabled', 'hasUntil', 'teamId', 'userId']);
      expect(line).toMatchObject({
        actorId: aroha.id,
        userId: priya.id,
        enabled: true,
        traceId: TRACE_ID,
      });
    }

    const refused = only('team.action.refused');
    expect(refused.map((line) => line.reason).sort()).toEqual(
      ['forbidden', 'skill_level_stale', 'validation_failed'].sort(),
    );
    for (const line of refused) {
      expect(line.traceId).toBe(TRACE_ID);
      expect(ownFields(line)).toEqual(['action', 'actorId', 'reason', 'teamId']);
    }
    expect(
      refused
        .filter((line) => line.reason !== 'forbidden')
        .map((line) => line.action)
        .sort(),
    ).toEqual(['auto_enroll', 'skill_override']);

    // Every line of these requests carries the trace (request lines included).
    const traced = lines.filter((line) => line.traceId === TRACE_ID);
    expect(traced.length).toBeGreaterThanOrEqual(8);
    for (const line of lines.filter((l) => 'req' in l || 'res' in l)) {
      expect(line.traceId, JSON.stringify(line).slice(0, 120)).toBe(TRACE_ID);
    }

    const serialised = JSON.stringify(lines);
    for (const secret of [
      'Overridewell Secret Club',
      '2026-11-30',
      ...[aroha, priya, plain].flatMap((p) => [p.email, p.fullName, p.token]),
    ]) {
      expect(serialised, secret.slice(0, 14)).not.toContain(secret);
    }
    for (const line of mine) {
      expect(Object.keys(line)).not.toContain('code');
      expect(Object.keys(line).filter((key) => /email|name|token|^until$/i.test(key))).toEqual([]);
    }
  });
});
