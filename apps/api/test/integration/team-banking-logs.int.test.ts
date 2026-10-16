/**
 * Log hygiene for the banking and GST routes (AC-VERIFY-4, learned rule `logging-redaction-global`): across a
 * success, every validation failure, a removal refusal, a decrypt failure and the guard refusals, no value (account
 * name, number digits, GST number) appears anywhere in the captured lines, and each event carries exactly its
 * documented fields. Error codes are logged as `errorCode`/`reason`, never `code`; the update event carries
 * `changedFields`, never a `replaced*` field.
 */
import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/lib/telemetry/telemetry.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import { ACCOUNT_A, ACCOUNT_B, GST_A, createBankingScene } from '../helpers/banking-scene.ts';
import { insertSession, insertTeamMember } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let database: TestDatabase;
let h: AuthTestApp;
let telemetry: Telemetry;
let scene: ReturnType<typeof createBankingScene>;
beforeAll(async () => {
  // A live (in-memory) tracer so the request's `traceparent` reaches the request logger as `traceId`.
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
  scene = createBankingScene(h, database);
});
afterAll(async () => {
  await h.close();
  await database.close();
  await telemetry.shutdown();
});

describe('banking and GST routes leave no value in the logs', () => {
  it('logs ids, flags and codes only, field by field, and never an account name, number digit run or GST number', async () => {
    const actor = await scene.person('Logan Logbook');
    const intruder = await scene.person('Ivy Intruder');
    const member = await scene.person('Moana Member');
    const teamId = await scene.team([actor]);
    await insertTeamMember(database.pool, { teamId, userId: member.id });
    const accountName = 'Hidden Holder Badminton Society';
    const traced = { traceparent: TRACEPARENT };
    const withTrace = (who: { token: string }) => ({
      authorization: `Bearer ${who.token}`,
      ...traced,
    });
    const put = (who: typeof actor, payload: unknown) =>
      h.app.inject({
        method: 'PUT',
        url: `/teams/${teamId}/banking`,
        headers: withTrace(who),
        payload: payload as Record<string, unknown>,
      });

    // Success (first setup), a name-only change, a validation failure, a service refusal, a guard refusal.
    expect((await put(actor, scene.body(accountName, ACCOUNT_A))).statusCode).toBe(200);
    expect((await put(actor, scene.body(`${accountName} 2`, undefined))).statusCode).toBe(200);
    expect((await put(actor, scene.body(accountName, ACCOUNT_B))).statusCode).toBe(200);
    expect(
      (
        await put(actor, {
          ...scene.body(accountName, ACCOUNT_A),
          accountNumber: '01-0902-0068388-00',
        })
      ).statusCode,
    ).toBe(422);
    expect((await put(intruder, scene.body(accountName, ACCOUNT_A))).statusCode).toBe(403);
    expect((await put(member, scene.body(accountName, ACCOUNT_A))).statusCode).toBe(403);
    const secondTeam = await scene.team([actor]);
    expect(
      (
        await h.app.inject({
          method: 'PUT',
          url: `/teams/${secondTeam}/banking`,
          headers: withTrace(actor),
          payload: scene.body('No Number Yet', undefined),
        })
      ).statusCode,
    ).toBe(422);

    // GST success.
    expect(
      (
        await h.app.inject({
          method: 'PUT',
          url: `/teams/${teamId}/gst`,
          headers: withTrace(actor),
          payload: { gstRegistered: true, gstNumber: GST_A.input, changeKey: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);

    // A removal refusal (published paid session), then a real removal.
    const sessionId = await insertSession(database.pool, teamId);
    await database.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [
      sessionId,
    ]);
    const deleteRequest = () =>
      h.app.inject({
        method: 'DELETE',
        url: `/teams/${teamId}/banking`,
        headers: withTrace(actor),
      });
    expect((await deleteRequest()).statusCode).toBe(409);
    await database.pool.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [
      sessionId,
    ]);
    expect((await deleteRequest()).statusCode).toBe(200);

    // A decrypt failure on read.
    expect((await put(actor, scene.body('Readable Again', ACCOUNT_A))).statusCode).toBe(200);
    await database.pool.query(`UPDATE teams SET bank_account_name = $2 WHERE id = $1`, [
      teamId,
      scene.crypto.encrypt('Sealed Elsewhere', {
        table: 'teams',
        column: 'bank_account_name',
        rowId: randomUUID(),
      }),
    ]);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: `/teams/${teamId}/banking`,
          headers: withTrace(actor),
        })
      ).statusCode,
    ).toBe(200);

    const lines = h.logs.lines();
    const serialised = JSON.stringify(lines);
    const digits = [ACCOUNT_A, ACCOUNT_B].flatMap((a) => [
      a.input,
      a.canonical,
      a.canonical.replaceAll('-', ''),
      a.input.replaceAll('-', ''),
    ]);
    for (const secret of [
      accountName,
      'Readable Again',
      'Sealed Elsewhere',
      'No Number Yet',
      ...digits,
      '0068389',
      '0123455',
      GST_A.canonical,
      GST_A.input,
      ...[actor, intruder, member].flatMap((p) => [p.email, p.token]),
    ]) {
      expect(serialised, secret.slice(0, 14)).not.toContain(secret);
    }

    const mine = lines.filter(
      (line) => typeof line.event === 'string' && /^team\.(banking|gst|action)\./.test(line.event),
    );
    const only = (name: string, id = teamId) =>
      mine.filter((line) => line.event === name && line.teamId === id);

    const updated = only('team.banking.updated');
    expect(updated.map((l) => l.changedFields)).toEqual([
      ['accountName', 'accountNumber'],
      ['accountName'],
      ['accountName', 'accountNumber'],
      ['accountName', 'accountNumber'],
    ]);
    // The fourth save follows a removal, so it is a first setup again.
    expect(updated.map((l) => l.firstSetup)).toEqual([true, false, false, true]);
    for (const line of updated) {
      expect(line).toMatchObject({ teamId, actorId: actor.id, traceId: TRACE_ID });
      expect(Object.keys(line).filter((k) => /^replaced/i.test(k))).toEqual([]);
    }
    expect(only('team.banking.removed')).toHaveLength(1);
    expect(only('team.banking.removed')[0]).toMatchObject({
      teamId,
      actorId: actor.id,
      traceId: TRACE_ID,
    });
    expect(only('team.gst.updated')).toHaveLength(1);
    expect(only('team.gst.updated')[0]).toMatchObject({
      teamId,
      actorId: actor.id,
      gstRegistered: true,
      traceId: TRACE_ID,
    });
    const failed = only('team.banking.decrypt_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ teamId, reason: 'auth_failed', traceId: TRACE_ID });

    // Refusals: the guard 403s (two actors), the removal refusal and the missing-number 422; ids and reason only.
    const refused = mine.filter((line) => line.event === 'team.action.refused');
    expect(refused.map((l) => l.reason).sort()).toEqual(
      ['banking_in_use', 'forbidden', 'forbidden', 'validation_failed'].sort(),
    );
    for (const line of refused) {
      expect(line.actorId, JSON.stringify(line)).toEqual(expect.any(String));
      expect(line.action).toEqual(expect.any(String));
      expect(line.traceId).toBe(TRACE_ID);
    }
    expect(
      refused
        .filter((l) => l.reason === 'forbidden')
        .map((l) => l.actorId)
        .sort(),
    ).toEqual([intruder.id, member.id].sort());

    // No event field is named for a value, and none carries a bare `code`.
    for (const line of mine) {
      expect(
        Object.keys(line).filter((key) =>
          /^(code|accountName|accountNumber|gstNumber)$/i.test(key),
        ),
      ).toEqual([]);
    }
  });
});
